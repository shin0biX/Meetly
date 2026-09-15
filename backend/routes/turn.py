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

# Optional external TURN configuration (set in .env). Use this when the Meetly
# server itself is behind NAT / a Cloudflare tunnel and its local coturn is not
# reachable from the internet:
#   TURN_URLS=turn:host.example.com:3478?transport=udp,turns:host.example.com:443?transport=tcp
#   TURN_STATIC_AUTH_SECRET=<shared secret>   # coturn "use-auth-secret" or Cloudflare Calls TURN
# or a provider that issues static credentials:
#   TURN_URLS=...
#   TURN_USERNAME=...
#   TURN_PASSWORD=...
TURN_URLS = [u.strip() for u in os.environ.get("TURN_URLS", "").split(",") if u.strip()]
TURN_STATIC_AUTH_SECRET = os.environ.get("TURN_STATIC_AUTH_SECRET", "").strip()
TURN_USERNAME = os.environ.get("TURN_USERNAME", "").strip()
TURN_PASSWORD = os.environ.get("TURN_PASSWORD", "").strip()

# Cloudflare Realtime (Calls) TURN mode. From the Cloudflare dashboard you get
# a TURN Token ID and an API token; short-lived ICE servers are generated via
#   POST https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers
# Credentials are cached in-process and regenerated before they expire.
CF_TURN_KEY_ID = os.environ.get("CF_TURN_KEY_ID", "").strip()
CF_TURN_API_TOKEN = os.environ.get("CF_TURN_API_TOKEN", "").strip()
CF_TURN_ENDPOINT = os.environ.get("CF_TURN_ENDPOINT", "").strip() or \
    "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
CF_TURN_TTL = int(os.environ.get("CF_TURN_TTL", "86400"))


class TurnCredentials(BaseModel):
    url: str
    urls: list[str] = []
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
    global TURN_SECRET, TURN_REALM, TURN_URLS, TURN_STATIC_AUTH_SECRET, TURN_USERNAME, TURN_PASSWORD
    global CF_TURN_KEY_ID, CF_TURN_API_TOKEN
    if TURN_SECRET or TURN_URLS or TURN_STATIC_AUTH_SECRET or TURN_USERNAME or CF_TURN_KEY_ID:
        return
    try:
        from dotenv import load_dotenv
        load_dotenv()
        TURN_SECRET = os.environ.get("TURN_SECRET", "").strip()
        TURN_REALM = os.environ.get("TURN_REALM", "").strip()
        TURN_URLS = [u.strip() for u in os.environ.get("TURN_URLS", "").split(",") if u.strip()]
        TURN_STATIC_AUTH_SECRET = os.environ.get("TURN_STATIC_AUTH_SECRET", "").strip()
        TURN_USERNAME = os.environ.get("TURN_USERNAME", "").strip()
        TURN_PASSWORD = os.environ.get("TURN_PASSWORD", "").strip()
        CF_TURN_KEY_ID = os.environ.get("CF_TURN_KEY_ID", "").strip()
        CF_TURN_API_TOKEN = os.environ.get("CF_TURN_API_TOKEN", "").strip()
    except Exception:
        pass


# Cloudflare credential cache: one set of ICE servers shared by all clients
# until shortly before expiry (regenerating per participant would be wasteful).
_cf_cache: dict = {"expires": 0.0, "ice": None}
_cf_lock = Lock()


def _cf_generate_credentials() -> dict | None:
    """Call Cloudflare's generate-ice-servers API and normalize the response.

    Returns {"urls": [...], "username": ..., "credential": ...} or None on failure.
    Port 53 is filtered out — Cloudflare's docs warn browsers block it.
    """
    import httpx
    url = CF_TURN_ENDPOINT.format(key_id=CF_TURN_KEY_ID)
    try:
        resp = httpx.post(
            url,
            headers={"Authorization": f"Bearer {CF_TURN_API_TOKEN}",
                     "Content-Type": "application/json"},
            json={"ttl": CF_TURN_TTL},
            timeout=10,
        )
        resp.raise_for_status()
        ice_servers = resp.json().get("iceServers") or []
    except Exception as e:
        print(f"[meetly] Cloudflare TURN credential generation failed: {e}")
        return None
    urls: list[str] = []
    username = credential = ""
    for server in ice_servers:
        username = username or server.get("username", "")
        credential = credential or server.get("credential", "")
        for u in server.get("urls", []):
            # Cloudflare docs: port 53 "is known to be blocked by web browsers".
            host_part = u.split("?")[0]
            if host_part.endswith(":53"):
                continue
            if u not in urls:
                urls.append(u)
    if not urls or not username or not credential:
        print("[meetly] Cloudflare TURN response missing fields")
        return None
    return {"urls": urls, "username": username, "credential": credential}


def issue_turn_ticket(room_code: str) -> str:
    """Create an unguessable, short-lived ticket after WebSocket authentication."""
    room_code = room_code.strip().lower()
    ticket = secrets.token_urlsafe(32)
    expires_at = time.time() + TURN_TICKET_TTL
    with _ticket_lock:
        # Opportunistically prune expired tickets to keep the in-memory store bounded.
        now = time.time()
        for key, (_, expiry) in list(_turn_tickets.items()):
            if expiry <= now:
                _turn_tickets.pop(key, None)
        _turn_tickets[ticket] = (room_code, expires_at)
    return ticket


def revoke_turn_ticket(ticket: str | None) -> None:
    if not ticket:
        return
    with _ticket_lock:
        _turn_tickets.pop(ticket, None)


def _validate_ticket(ticket: str, room_code: str) -> bool:
    room_code = room_code.strip().lower()
    with _ticket_lock:
        entry = _turn_tickets.get(ticket)
        if not entry:
            return False
        ticket_room, expiry = entry
        if expiry <= time.time():
            _turn_tickets.pop(ticket, None)
            return False
        return secrets.compare_digest(ticket_room, room_code)


@router.get("/credentials", response_model=TurnCredentials)
def get_turn_credentials(
    room: str,
    x_meetly_turn_ticket: str | None = Header(default=None),
):
    """Mint TURN credentials only for a recently authenticated room participant."""
    _load_env()
    if not x_meetly_turn_ticket or not _validate_ticket(x_meetly_turn_ticket, room):
        raise HTTPException(status_code=403, detail="Valid meeting TURN authorization required")

    ttl = TURN_CREDENTIAL_TTL

    # Cloudflare Realtime (Calls) TURN mode.
    if CF_TURN_KEY_ID and CF_TURN_API_TOKEN:
        now = time.time()
        with _cf_lock:
            ice = _cf_cache["ice"]
            if ice is None or _cf_cache["expires"] <= now:
                ice = _cf_generate_credentials()
                if ice is not None:
                    _cf_cache["ice"] = ice
                    # Regenerate 5 minutes before Cloudflare's TTL ends.
                    _cf_cache["expires"] = now + CF_TURN_TTL - 300
        if ice is None:
            raise HTTPException(status_code=502, detail="TURN provider unavailable")
        expires = datetime.now(timezone.utc).timestamp() + ttl
        return TurnCredentials(
            url=ice["urls"][0],
            urls=ice["urls"],
            username=ice["username"],
            credential=ice["credential"],
            ttl=ttl,
            expires_at=str(expires),
        )

    # External/static-credential mode: no local coturn required.
    if TURN_URLS and (TURN_STATIC_AUTH_SECRET or (TURN_USERNAME and TURN_PASSWORD)):
        if TURN_STATIC_AUTH_SECRET:
            username = str(int(time.time()) + ttl)
            credential = base64.b64encode(
                hmac.new(TURN_STATIC_AUTH_SECRET.encode(), username.encode(), hashlib.sha1).digest()
            ).decode()
        else:
            username, credential = TURN_USERNAME, TURN_PASSWORD
        expires = datetime.now(timezone.utc).timestamp() + ttl
        return TurnCredentials(
            url=TURN_URLS[0],
            urls=TURN_URLS,
            username=username,
            credential=credential,
            ttl=ttl,
            expires_at=str(expires),
        )

    # Local coturn mode.
    if not TURN_SECRET:
        return TurnCredentials(url="", urls=[], username="", credential="", ttl=0, expires_at="")

    username = str(int(time.time()) + ttl)
    credential = base64.b64encode(
        hmac.new(TURN_SECRET.encode(), username.encode(), hashlib.sha1).digest()
    ).decode()

    host = TURN_REALM or "localhost"
    urls = [f"turn:{host}:3478?transport=udp", f"turn:{host}:3478?transport=tcp"]
    expires = datetime.now(timezone.utc).timestamp() + ttl
    return TurnCredentials(
        url=urls[0],
        urls=urls,
        username=username,
        credential=credential,
        ttl=ttl,
        expires_at=str(expires),
    )
