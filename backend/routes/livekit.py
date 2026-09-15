"""LiveKit Cloud media tokens.

When LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are configured, media
(audio/video) flows through LiveKit's managed SFU instead of the peer-to-peer
mesh. This matters for larger calls (no per-peer upload fan-out) and for
cross-network calls (LiveKit's edge includes relay infrastructure, so no
self-hosted TURN is needed).

Everything else — chat, roles, presence, host controls — stays on our own
FastAPI WebSocket (routes/realtime.py). LiveKit replaces ONLY the raw
audio/video transport.

Trust model: the identity in the LiveKit token is NOT client-supplied. It is
taken from a short-lived, server-signed "meeting ticket" that realtime.py
issues in the WebSocket `joined` message, so a LiveKit participant and a
Meetly room member are provably the same entity.
"""
import datetime
import os
import re
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import get_db
from models import Room
from config import SECRET_KEY, ALGORITHM

router = APIRouter(prefix="/livekit", tags=["livekit"])

LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "").strip()
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "").strip()
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "").strip()  # wss://... given to the client

_TICKET_EXP_HOURS = 6
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


def is_livekit_configured() -> bool:
    """True when media should be routed through LiveKit (server decision)."""
    _load_env()
    return bool(LIVEKIT_API_KEY and LIVEKIT_API_SECRET and LIVEKIT_URL)


# Lightweight per-IP limiter for the token endpoint.
_rate_store: dict[str, deque] = defaultdict(deque)


def _rate_limit(request: Request, max_requests: int = 30, window: float = 60.0) -> None:
    now = time.monotonic()
    ip = request.client.host if request.client else "unknown"
    q = _rate_store[ip]
    cutoff = now - window
    while q and q[0] <= cutoff:
        q.popleft()
    if len(q) >= max_requests:
        raise HTTPException(status_code=429, detail="Too many requests. Please try again later.")
    q.append(now)
    if len(_rate_store) > 4096:
        for k in [k for k, v in _rate_store.items() if not v or v[-1] <= cutoff]:
            _rate_store.pop(k, None)


security = HTTPBearer(auto_error=False)


@router.get("/token", response_model=LiveKitConnectionInfo)
def get_livekit_token(
    room: str,
    http_request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
):
    """Issue a media token only to a participant authenticated by Meetly.

    The client-supplied identity is deliberately not accepted: identity and
    room membership are derived from a short-lived, server-signed meeting
    ticket issued after the WebSocket join succeeds.
    """
    _rate_limit(http_request)
    if credentials is None or credentials.scheme.lower() != "bearer":
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

    # A meeting ticket is intentionally short-lived, but it is also scoped to
    # the currently connected Meetly participant. This prevents a kicked or
    # replaced WebSocket participant from reusing an old ticket to obtain a
    # fresh LiveKit credential after leaving the room.
    from routes.realtime import ROOMS
    member = ROOMS.get(room_code, {}).get(identity)
    if member is None:
        raise HTTPException(status_code=403, detail="Active meeting membership required")

    _load_env()
    if not is_livekit_configured():
        raise HTTPException(
            status_code=503,
            detail="LiveKit is not configured on this server (missing LIVEKIT_API_KEY/SECRET/URL).",
        )

    display_name = payload.get("name") if isinstance(payload.get("name"), str) else identity
    from livekit.api import AccessToken, VideoGrants
    grants = VideoGrants(room_join=True, room=room_code, can_publish=True, can_subscribe=True, can_publish_data=True)
    token = (AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
             .with_identity(identity)
             .with_name(display_name.strip()[:60] or identity)
             .with_grants(grants)
             .with_ttl(datetime.timedelta(hours=_TICKET_EXP_HOURS))
             .to_jwt())
    return LiveKitConnectionInfo(url=LIVEKIT_URL, token=token)


async def remove_livekit_participant(room_code: str, identity: str) -> None:
    """Disconnect and revoke a participant's current LiveKit session."""
    _load_env()
    if not is_livekit_configured():
        return

    from livekit import api

    # The browser-facing LIVEKIT_URL is commonly wss://; the server API accepts
    # the corresponding HTTPS host. The Python SDK also performs this conversion
    # for current releases, but doing it explicitly keeps older deployments sane.
    service_url = LIVEKIT_URL
    if service_url.startswith("wss://"):
        service_url = "https://" + service_url[len("wss://"):]
    elif service_url.startswith("ws://"):
        service_url = "http://" + service_url[len("ws://"):]

    async with api.LiveKitAPI(
        url=service_url,
        api_key=LIVEKIT_API_KEY,
        api_secret=LIVEKIT_API_SECRET,
    ) as lkapi:
        await lkapi.room.remove_participant(
            api.proto_room.RoomParticipantIdentity(room=room_code, identity=identity)
        )


def create_meeting_ticket(room_code: str, client_id: str, display_name: str) -> str:
    """Short-lived, server-signed proof that this WebSocket participant joined
    the room. Consumed by /livekit/token to derive the media identity."""
    now = datetime.datetime.now(datetime.timezone.utc)
    return jwt.encode({
        "typ": "meetly_meeting_ticket",
        "room": room_code.lower(),
        "cid": client_id,
        "name": display_name[:60],
        "iat": now,
        "exp": now + datetime.timedelta(hours=_TICKET_EXP_HOURS),
    }, SECRET_KEY, algorithm=ALGORITHM)
