import hmac, hashlib, os, time, base64
from datetime import datetime, timezone
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/turn", tags=["turn"])

TURN_SECRET = os.environ.get("TURN_SECRET", "").strip()
TURN_REALM = os.environ.get("TURN_REALM", "").strip()


class TurnCredentials(BaseModel):
    url: str
    username: str
    credential: str
    ttl: int
    expires_at: str


def _load_env() -> None:
    """Load TURN secret from .env if not already in environment."""
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


@router.get("/credentials", response_model=TurnCredentials)
def get_turn_credentials():
    """Mint short-lived TURN credentials for both logged-in users and guests."""
    _load_env()
    if not TURN_SECRET:
        return {
            "url": "",
            "username": "",
            "credential": "",
            "ttl": 0,
            "expires_at": "",
        }

    ttl = 3600  # 1 hour
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
