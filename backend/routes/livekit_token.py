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

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session
from livekit.api import AccessToken, VideoGrants
from pydantic import BaseModel

from rate_limit import rate_limit_check
from database import get_db
from models import Room
from config import SECRET_KEY, ALGORITHM

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


security = HTTPBearer(auto_error=False)


@router.get("/token", response_model=LiveKitConnectionInfo)
def get_livekit_token(
    room: str,
    http_request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
):
    """Issue a media token only to a participant authenticated by Meetly.

    The client-supplied identity is deliberately not accepted: identity and room
    membership are derived from a short-lived, server-signed meeting ticket
    issued after the WebSocket join succeeds.
    """
    rate_limit_check(http_request, "livekit_token", window=60, max_requests=30)
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Meeting authentication required")
    room_code = room.lower().strip()
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("typ") != "meetly_meeting_ticket":
            raise HTTPException(status_code=401, detail="Invalid meeting credentials")
        if payload.get("room") != room_code:
            raise HTTPException(status_code=403, detail="Meeting ticket is not valid for this room")
        identity = payload.get("cid")
        if not isinstance(identity, str) or not _IDENTITY_RE.match(identity):
            raise HTTPException(status_code=401, detail="Invalid meeting credentials")
    except HTTPException:
        raise
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired meeting credentials")

    if db.query(Room).filter(Room.code == room_code).first() is None:
        raise HTTPException(status_code=404, detail="Room not found")

    _load_env()
    if not (LIVEKIT_API_KEY and LIVEKIT_API_SECRET and LIVEKIT_URL):
        raise HTTPException(status_code=503, detail="LiveKit is not configured on this server (missing LIVEKIT_API_KEY/SECRET/URL).")

    display_name = payload.get("name") if isinstance(payload.get("name"), str) else identity
    grants = VideoGrants(room_join=True, room=room_code, can_publish=True, can_subscribe=True, can_publish_data=True)
    token = (AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(display_name.strip()[:60] or identity)
        .with_grants(grants)
        .with_ttl(datetime.timedelta(hours=6))
        .to_jwt())
    return LiveKitConnectionInfo(url=LIVEKIT_URL, token=token)

