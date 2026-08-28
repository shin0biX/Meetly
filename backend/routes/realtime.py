"""WebSocket signaling + chat + host controls for Meetly.

Supports both authenticated users and guests:
- Authenticated user connects with: {"type": "auth", "token": "<JWT>"}
- Guest connects with: {"type": "auth", "guest_name": "Alice"}
"""
from __future__ import annotations

import asyncio
import json
import secrets
from typing import Dict, Optional
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError, jwt

from database import SessionLocal
from models import User, Room, ChatMessage
from config import SECRET_KEY, ALGORITHM

GUEST_TOKEN_TYPE = "guest_access"
GUEST_TOKEN_HOURS = 24
from rate_limit import ConnectionRateLimiter

router = APIRouter(tags=["realtime"])

# Bounds that exist purely to make the room unable to take the whole server
# down: without these, one connection flooding messages (or a script opening
# many connections) can pin the event loop and make the server unresponsive
# to everyone, not just that room -- reproduced and confirmed in testing.
MAX_ROOM_SIZE = 50          # participants per room
MAX_TOTAL_CONNECTIONS = 300  # concurrent WS connections, server-wide
MAX_WS_MESSAGE_BYTES = 4096  # a legitimate message (chat/reaction/etc) never needs more
MSG_RATE_PER_SEC = 15        # sustained messages/sec a single connection may send
MSG_BURST = 30               # short burst allowance on top of the sustained rate
MAX_VIOLATIONS_BEFORE_KICK = 50  # disconnect a connection that keeps ignoring its limit

_total_connections = 0


class RoomMember:
    def __init__(self, client_id: str, name: str, websocket: WebSocket, user_id: Optional[int] = None, guest_id: Optional[str] = None, is_owner: bool = False, is_original_owner: bool = False):
        self.client_id = client_id
        self.name = name
        self.websocket = websocket
        self.user_id = user_id
        self.guest_id = guest_id
        # is_owner: currently has host rights (owner OR promoted). Can be toggled at runtime.
        self.is_owner = is_owner
        # is_original_owner: the room creator (room.owner_id). Never demotable; sole host-manager.
        self.is_original_owner = is_original_owner
        # Live mic/cam state so late-joiners and every peer render tiles correctly.
        self.mic_on = True
        self.cam_on = True
        # Raised-hand is sticky (persists until lowered or the member leaves),
        # unlike one-off emoji reactions which are never stored server-side.
        self.hand_raised = False

    async def send(self, message: dict) -> None:
        try:
            await self.websocket.send_text(json.dumps(message))
        except Exception:
            pass


# room_code -> {client_id: RoomMember}
ROOMS: Dict[str, Dict[str, RoomMember]] = {}

# room_code -> client_id currently spotlighted by a host for everyone (or None)
SPOTLIGHTS: Dict[str, Optional[str]] = {}


def _room(room_code: str) -> Dict[str, RoomMember]:
    return ROOMS.setdefault(room_code, {})


def get_room_member_count(room_code: str) -> int:
    """Return the number of connected members in a room."""
    return len(_room(room_code))


async def broadcast(room_code: str, message: dict, exclude: Optional[str] = None) -> None:
    for member in list(_room(room_code).values()):
        if member.client_id == exclude:
            continue
        await member.send(message)


async def broadcast_peer_count(room_code: str) -> None:
    """Notify all members of the current peer count."""
    count = get_room_member_count(room_code)
    await broadcast(room_code, {"type": "peer-count", "count": count})


async def relay(room_code: str, target_id: str, message: dict) -> bool:
    member = _room(room_code).get(target_id)
    if member is None:
        return False
    await member.send(message)
    return True


def persist_chat(
    db, room_id: int, user_id: Optional[int], sender_name: str, text: str,
    is_private: bool = False,
    recipient_user_id: Optional[int] = None,
    recipient_name: Optional[str] = None,
    sender_guest_id: Optional[str] = None, recipient_guest_id: Optional[str] = None,
) -> None:
    """Persist a chat message. Never raises: a storage failure must NOT take
    down the WebSocket connection (chat still broadcasts even if saving fails)."""
    try:
        msg = ChatMessage(
            room_id=room_id, user_id=user_id, sender_name=sender_name, text=text,
            is_private=is_private,
            recipient_user_id=recipient_user_id,
            recipient_name=recipient_name, sender_guest_id=sender_guest_id, recipient_guest_id=recipient_guest_id,
        )
        db.add(msg)
        db.commit()
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        print(f"[meetly] chat persist failed (non-fatal): {e}")


def _persist_chat_sync(room_id, user_id, sender_name, text, is_private, recipient_user_id, recipient_name, sender_guest_id=None, recipient_guest_id=None) -> None:
    """Opens its own session and persists -- runs in a worker thread via
    asyncio.to_thread so the blocking sqlite3 commit() call never blocks the
    event loop that every other connection/room depends on. Under a message
    flood this was the single biggest factor in the whole server (not just
    one room) becoming unresponsive -- see the audit."""
    db = SessionLocal()
    try:
        persist_chat(db, room_id, user_id, sender_name, text, is_private, recipient_user_id, recipient_name, sender_guest_id, recipient_guest_id)
    finally:
        db.close()


@router.get("/rooms/{room_code}/peers", tags=["rooms"])
def get_peers(room_code: str):
    """Return the current number of connected peers in a room."""
    return {"room_code": room_code, "count": get_room_member_count(room_code)}


@router.websocket("/ws/{room_code}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_code: str,
):
    await websocket.accept()

    # 1) Wait for auth/join message
    try:
        raw = await websocket.receive_text()
        if len(raw) > MAX_WS_MESSAGE_BYTES:
            await websocket.close(code=4413, reason="Message too large")
            return
        data = json.loads(raw)
    except Exception:
        await websocket.close(code=4401, reason="Expected auth message")
        return

    if data.get("type") != "auth":
        await websocket.close(code=4401, reason="Invalid handshake")
        return

    token = data.get("token")
    guest_name = (data.get("guest_name") or "").strip()
    guest_token = data.get("guest_token")

    user_id: Optional[int] = None
    guest_id: Optional[str] = None
    issued_guest_token: Optional[str] = None
    display_name: str = ""
    is_owner: bool = False

    # Validate room existence first
    db = SessionLocal()
    try:
        room = db.query(Room).filter(Room.code == room_code.lower()).first()
        if room is None:
            await websocket.close(code=4404, reason="Room not found")
            return

        room_id: int = room.id
        room_owner_id: int = room.owner_id

        # If token provided, authenticate user
        if token:
            try:
                payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
                token_user_id = payload.get("id")
                if token_user_id:
                    user = db.query(User).filter(User.id == token_user_id).first()
                    if user:
                        user_id = user.id
                        display_name = user.username
                        is_owner = (user.id == room_owner_id)
            except JWTError:
                pass  # Fall back to guest if token is invalid or expired

        # If not authenticated as a user, verify an existing guest credential or
        # create a new server-assigned guest identity. Display names are never identity.
        if not user_id:
            if guest_token:
                try:
                    gp = jwt.decode(guest_token, SECRET_KEY, algorithms=[ALGORITHM])
                    if gp.get("typ") == GUEST_TOKEN_TYPE and gp.get("sub") == "guest" and gp.get("room") == room_code.lower() and gp.get("gid"):
                        guest_id = str(gp["gid"])
                        display_name = str(gp.get("display") or "Guest")[:30]
                    else:
                        raise JWTError("invalid guest token")
                except JWTError:
                    await websocket.close(code=4401, reason="Invalid guest token")
                    return
            else:
                guest_id = secrets.token_hex(16)
                display_name = guest_name[:30] if guest_name else f"Guest_{secrets.token_hex(2)}"
                issued_guest_token = jwt.encode({"sub":"guest","typ":GUEST_TOKEN_TYPE,"gid":guest_id,"room":room_code.lower(),"display":display_name,"exp":datetime.now(timezone.utc)+timedelta(hours=GUEST_TOKEN_HOURS)}, SECRET_KEY, algorithm=ALGORITHM)
            is_owner = False

    finally:
        db.close()

    room_members = _room(room_code)

    # A guest credential represents a single anonymous participant. Reject a
    # second simultaneous connection using the same credential; this prevents
    # a copied/stolen browser credential from silently becoming the same guest
    # while the original participant is still connected.
    if guest_id and any(m.guest_id == guest_id for m in room_members.values()):
        await websocket.close(code=4409, reason="Guest identity already connected")
        return

    global _total_connections
    if _total_connections >= MAX_TOTAL_CONNECTIONS:
        await websocket.close(code=4429, reason="Server is at capacity, please try again shortly")
        return
    if len(room_members) >= MAX_ROOM_SIZE:
        await websocket.close(code=4429, reason="This room is full")
        return

    client_id = secrets.token_hex(8)
    member = RoomMember(
        client_id=client_id,
        name=display_name,
        websocket=websocket,
        user_id=user_id,
        guest_id=guest_id,
        is_owner=is_owner,
        is_original_owner=is_owner,
    )
    room_members[client_id] = member
    _total_connections += 1
    limiter = ConnectionRateLimiter(rate_per_sec=MSG_RATE_PER_SEC, burst=MSG_BURST)

    try:
        # Notify newcomer with self info & peer roster
        peers = [
            {
                "id": pid, "name": m.name, "is_owner": m.is_owner,
                "mic_on": m.mic_on, "cam_on": m.cam_on, "hand_raised": m.hand_raised,
            }
            for pid, m in room_members.items()
            if pid != client_id
        ]
        meeting_ticket = jwt.encode({
            "typ": "meetly_meeting_ticket",
            "room": room_code.lower(),
            "cid": client_id,
            "name": display_name[:60],
            "exp": datetime.now(timezone.utc) + timedelta(hours=6),
        }, SECRET_KEY, algorithm=ALGORITHM)
        await member.send({
            "type": "joined",
            "id": client_id,
            "name": display_name,
            "is_owner": is_owner,
            "peers": peers,
            "spotlight": SPOTLIGHTS.get(room_code),
            "meeting_ticket": meeting_ticket,
            "guest_token": issued_guest_token,
        })

        # Broadcast newcomer to existing peers
        await broadcast(room_code, {
            "type": "peer-joined",
            "id": client_id,
            "name": member.name,
            "is_owner": is_owner,
            "mic_on": member.mic_on,
            "cam_on": member.cam_on,
        }, exclude=client_id)
        
        await broadcast_peer_count(room_code)

        while True:
            raw = await websocket.receive_text()

            if len(raw) > MAX_WS_MESSAGE_BYTES:
                limiter.violations += 1
                if limiter.violations > MAX_VIOLATIONS_BEFORE_KICK:
                    await websocket.close(code=4413, reason="Too many oversized messages")
                    return
                continue

            if not limiter.allow():
                # Silently drop -- an occasional burst is normal (fast
                # typing, a flurry of reactions); this only bites someone
                # sending far faster than any real UI could. If they keep
                # hammering past all reasonable doubt, disconnect them.
                if limiter.violations > MAX_VIOLATIONS_BEFORE_KICK:
                    await websocket.close(code=4429, reason="Too many messages, disconnected")
                    return
                continue

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = data.get("type")

            if mtype == "chat":
                text = str(data.get("text") or "")[:1000]
                text = text.strip()
                if not text:
                    continue

                dm_target_id = data.get("to")
                if dm_target_id:
                    # Direct message: only the sender and the target ever see it.
                    target_member = room_members.get(dm_target_id)
                    if not target_member or dm_target_id == client_id:
                        continue
                    await asyncio.to_thread(
                        _persist_chat_sync, room_id, member.user_id, member.name, text,
                        True, target_member.user_id, target_member.name, member.guest_id, target_member.guest_id,
                    )
                    await target_member.send({
                        "type": "chat", "from": client_id, "name": member.name,
                        "text": text, "private": True,
                        "to": dm_target_id, "to_name": target_member.name,
                    })
                else:
                    await asyncio.to_thread(
                        _persist_chat_sync, room_id, member.user_id, member.name, text,
                        False, None, None, member.guest_id, None,
                    )
                    await broadcast(room_code, {
                        "type": "chat", "from": client_id,
                        "name": member.name, "text": text, "private": False,
                    }, exclude=client_id)
            elif mtype == "kick":
                if not member.is_owner:
                    continue
                target_id = data.get("target_id")
                if target_id and target_id in room_members:
                    target_member = room_members.get(target_id)
                    if target_member:
                        await target_member.send({
                            "type": "kicked",
                            "reason": "You were removed from the call by the room creator."
                        })
                        try:
                            await target_member.websocket.close(code=4403, reason="Removed by host")
                        except Exception:
                            pass
                        room_members.pop(target_id, None)
                        await broadcast(room_code, {"type": "peer-left", "id": target_id})
                        if SPOTLIGHTS.get(room_code) == target_id:
                            SPOTLIGHTS[room_code] = None
                            await broadcast(room_code, {"type": "spotlight-update", "id": None})
                        await broadcast_peer_count(room_code)

            elif mtype == "make-host":
                # Only the original room owner manages host roles
                if not member.is_original_owner:
                    continue
                target_id = data.get("target_id")
                target_member = room_members.get(target_id)
                if target_member and not target_member.is_owner:
                    target_member.is_owner = True
                    await target_member.send({"type": "role-granted", "is_owner": True})
                    # Tell everyone so host badges update
                    await broadcast(room_code, {
                        "type": "role-update", "id": target_id, "is_owner": True
                    })

            elif mtype == "demote-host":
                # Only the original room owner can revoke host access; the owner is protected
                if not member.is_original_owner:
                    continue
                target_id = data.get("target_id")
                target_member = room_members.get(target_id)
                if target_member and target_member.is_owner and not target_member.is_original_owner:
                    target_member.is_owner = False
                    await target_member.send({"type": "role-revoked", "is_owner": False})
                    await broadcast(room_code, {
                        "type": "role-update", "id": target_id, "is_owner": False
                    })

            elif mtype == "mute-mic":
                # Host can force-disable another participant's microphone
                if not member.is_owner:
                    continue
                target_id = data.get("target_id")
                target_member = room_members.get(target_id)
                if target_member and target_id != client_id:
                    target_member.mic_on = False
                    await target_member.send({"type": "mic-force-off"})
                    # Sync every other tile's muted state (target updates its own UI)
                    await broadcast(room_code, {
                        "type": "peer-mic-state", "id": target_id, "on": False
                    }, exclude=target_id)

            elif mtype == "disable-cam":
                # Host can force-turn-off another participant's camera
                if not member.is_owner:
                    continue
                target_id = data.get("target_id")
                target_member = room_members.get(target_id)
                if target_member and target_id != client_id:
                    target_member.cam_on = False
                    await target_member.send({"type": "cam-force-off"})
                    await broadcast(room_code, {
                        "type": "peer-cam-state", "id": target_id, "on": False
                    }, exclude=target_id)

            elif mtype == "mic-state":
                # A participant toggled their own mic; sync the icon on everyone's tile
                member.mic_on = bool(data.get("on"))
                await broadcast(room_code, {
                    "type": "peer-mic-state", "id": client_id, "on": member.mic_on
                }, exclude=client_id)

            elif mtype == "cam-state":
                # A participant toggled their own camera; sync video/avatar on everyone's tile
                member.cam_on = bool(data.get("on"))
                await broadcast(room_code, {
                    "type": "peer-cam-state", "id": client_id, "on": member.cam_on
                }, exclude=client_id)

            elif mtype == "spotlight":
                # Host spotlights a participant as the main tile for EVERYONE (target_id=None clears)
                if not member.is_owner:
                    continue
                target_id = data.get("target_id")
                if target_id is not None and target_id not in room_members:
                    target_id = None
                SPOTLIGHTS[room_code] = target_id
                await broadcast(room_code, {"type": "spotlight-update", "id": target_id})

            elif mtype == "hand-raise":
                # Sticky until lowered or the member leaves; included in the
                # roster so late joiners see who already has a hand up.
                member.hand_raised = bool(data.get("on"))
                await broadcast(room_code, {
                    "type": "peer-hand-state", "id": client_id, "on": member.hand_raised
                }, exclude=client_id)

            elif mtype == "reaction":
                # One-off emoji reaction (thumbs up, clap, etc). Never stored;
                # purely a live, ephemeral broadcast.
                emoji = str(data.get("emoji") or "").strip()[:8]
                if not emoji:
                    continue
                await broadcast(room_code, {
                    "type": "reaction", "from": client_id, "name": member.name, "emoji": emoji,
                }, exclude=client_id)

            elif mtype == "leave":
                break

    except WebSocketDisconnect:
        pass
    finally:
        _total_connections -= 1
        was_original_owner = member.is_original_owner
        room_members.pop(client_id, None)

        if not room_members:
            ROOMS.pop(room_code, None)
            SPOTLIGHTS.pop(room_code, None)
        else:
            # If the room's spotlighted member just left, clear it for everyone
            # rather than leaving a stale reference (this previously only
            # happened on kick, not on a normal leave/disconnect).
            if SPOTLIGHTS.get(room_code) == client_id:
                SPOTLIGHTS[room_code] = None
                await broadcast(room_code, {"type": "spotlight-update", "id": None})

            # If the room creator just left, hand host rights to someone still
            # here so the room isn't left without anyone able to moderate.
            # Prefer an already-promoted host; otherwise the longest-present
            # remaining member (dict preserves join order).
            if was_original_owner:
                new_owner = next((m for m in room_members.values() if m.is_owner), None) \
                    or next(iter(room_members.values()))
                new_owner.is_owner = True
                new_owner.is_original_owner = True
                await new_owner.send({
                    "type": "role-granted", "is_owner": True,
                    "reason": "The room creator left. You are now the host.",
                })
                await broadcast(room_code, {
                    "type": "role-update", "id": new_owner.client_id, "is_owner": True
                }, exclude=new_owner.client_id)

            await broadcast(room_code, {"type": "peer-left", "id": client_id}, exclude=client_id)
            await broadcast_peer_count(room_code)
        try:
            await websocket.close()
        except Exception:
            pass
