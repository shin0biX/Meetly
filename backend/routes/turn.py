"""Short-lived, meeting-authorized TURN credentials."""
import base64
import hashlib
import hmac
import os
import secrets
import time
from datetime import datetime, timezone
from threading import Lock

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/turn", tags=["turn"])

TURN_SECRET = os.environ.get("TURN_SECRET", "").strip()
TURN_REALM = os.environ.get("TURN_REALM", "").strip()
TURN_TICKET_TTL = 5 * 60  # ticket is valid only while a recent room session exists
TURN_CREDENTIAL_TTL = 15 * 60  # relay credentials expire quickly


class TurnCredentials(BaseModel):
    url: str
    username: str
    credential: str
    ttl: int
    expires_at: str


# Ephemeral tickets are deliberately kept in memory: they are only proof that
# this process has authenticated a currently connected meeting participant.
_turn_tickets: dict[str, tuple[str, float]] = {}
_ticket_lock = Lock()


def _load_env() -> None:
    """Load TURN configuration from .env if not already in the environment."""
    global TURN_SECRET, TURN_REALM
    if TURN_SECRET:
        return
    try:
        from dotenv import load_dotenv
        load_dotenv()
        TURN_SECRET = os.environ.get("TURN_SECRET", "").strip()
        TURN_REALM = os.environ.get("TURN_REALM", "").strip()
    except Exception:
        pass


def issue_turn_ticket(room_code: str) -> str:
    """Create an unguessable, short-lived ticket after WebSocket authentication."""
    ticket = secrets.token_urlsafe(32)
    expires_at = time.time() + TURN_TICKET_TTL
    with _ticket_lock:
        # Opportunistically prune expired tickets to keep the in-memory store bounded.
        now = time.time()
        for key, (_, expiry) in list(_turn_tickets.items()):
            if expiry <= now:
                _turn_tickets.pop(key, None)
        _turn_tickets[ticket] = (room_code.lower(), expires_at)
    return ticket


def revoke_turn_ticket(ticket: str | None) -> None:
    if not ticket:
        return
    with _ticket_lock:
        _turn_tickets.pop(ticket, None)


def _validate_ticket(ticket: str, room_code: str) -> bool:
    with _ticket_lock:
        entry = _turn_tickets.get(ticket)
        if not entry:
            return False
        ticket_room, expiry = entry
        if expiry <= time.time():
            _turn_tickets.pop(ticket, None)
            return False
        return secrets.compare_digest(ticket_room, room_code.lower())


@router.get("/credentials", response_model=TurnCredentials)
def get_turn_credentials(
    room: str,
    x_meetly_turn_ticket: str | None = Header(default=None),
):
    """Mint TURN credentials only for a recently authenticated room participant."""
    _load_env()
    if not x_meetly_turn_ticket or not _validate_ticket(x_meetly_turn_ticket, room):
        raise HTTPException(status_code=403, detail="Valid meeting TURN authorization required")

    if not TURN_SECRET:
        return TurnCredentials(url="", username="", credential="", ttl=0, expires_at="")

    ttl = TURN_CREDENTIAL_TTL
    username = str(int(time.time()) + ttl)
    credential = base64.b64encode(
        hmac.new(TURN_SECRET.encode(), username.encode(), hashlib.sha1).digest()
    ).decode()

    host = TURN_REALM or "localhost"
    url = f"turn:{host}:3478?transport=udp"
    expires = datetime.now(timezone.utc).timestamp() + ttl
    return TurnCredentials(
        url=url,
        username=username,
        credential=credential,
        ttl=ttl,
        expires_at=str(expires),
    )
