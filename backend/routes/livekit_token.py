"""Mints short-lived LiveKit access tokens so the frontend can join the SFU
room for media, while chat/reactions/host-controls/etc keep going over our
own FastAPI WebSocket (see realtime.py) exactly as before -- LiveKit only
replaces the raw audio/video transport, nothing else in the app changes.

IMPORTANT: `identity` here must be the SAME id the FastAPI WebSocket already
assigned this participant (the "id" field from its `joined` message). The
frontend connects to the WS first, then requests this token using that id
as `identity`, so a LiveKit participant and a Meetly room member are always
the same entity -- tiles, host-controls, hand-raise, and pin all key off one
shared id instead of two disconnected ones.

Trust model: knowing a room's code is already sufficient to join it as a
guest over the WebSocket (see realtime.py) -- this endpoint doesn't add a
new trust boundary beyond that existing one; `identity` is a session
pseudonym here, not a security principal.
"""
import datetime
import os
import re

from fastapi import APIRouter, HTTPException, Query
from livekit.api import AccessToken, VideoGrants
from pydantic import BaseModel

router = APIRouter(prefix="/livekit", tags=["livekit"])

LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "").strip()
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "").strip()
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "").strip()  # wss://... given to the client

_IDENTITY_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class LiveKitConnectionInfo(BaseModel):
    url: str
    token: str


def _load_env() -> None:
    global LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL
    if LIVEKIT_API_KEY:
        return
    try:
        from dotenv import load_dotenv
        load_dotenv()
        LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "").strip()
        LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "").strip()
        LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "").strip()
    except Exception:
        pass


@router.get("/token", response_model=LiveKitConnectionInfo)
def get_livekit_token(
    room: str,
    identity: str = Query(..., description="Must equal the FastAPI WS 'joined' id for this session"),
    name: str = Query(..., description="Display name to show in LiveKit (cosmetic only)"),
):
    _load_env()
    if not (LIVEKIT_API_KEY and LIVEKIT_API_SECRET and LIVEKIT_URL):
        raise HTTPException(
            status_code=503,
            detail="LiveKit is not configured on this server (missing LIVEKIT_API_KEY/SECRET/URL).",
        )
    if not _IDENTITY_RE.match(identity):
        raise HTTPException(status_code=400, detail="Invalid identity")

    grants = VideoGrants(
        room_join=True,
        room=room.lower().strip(),
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    token = (
        AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(name.strip()[:60] or identity)
        .with_grants(grants)
        .with_ttl(datetime.timedelta(hours=6))
        .to_jwt()
    )
    return LiveKitConnectionInfo(url=LIVEKIT_URL, token=token)
