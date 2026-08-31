"""WebSocket signaling + chat + host controls for Meetly.

Supports authenticated users and guests. Guest identity is bound to a server-signed token; display names are presentation-only.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Optional, Tuple
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from jose import JWTError, jwt

from database import SessionLocal, get_db
from models import User, Room, ChatMessage
from routes.auth import get_current_user
from config import SECRET_KEY, ALGORITHM, ALLOWED_ORIGINS, GUEST_TOKEN_EXPIRE_HOURS
from routes.turn import issue_turn_ticket, revoke_turn_ticket

router = APIRouter(tags=["realtime"])


# WebSocket abuse limits. These are intentionally generous for WebRTC signaling
# while keeping chat/reaction spam from overwhelming a room or the server.
MAX_WS_MESSAGE_BYTES = 64 * 1024
# Clients must authenticate promptly after the WebSocket is accepted. This prevents
# idle unauthenticated connections from consuming server resources indefinitely.
WS_AUTH_TIMEOUT_SECONDS = 10
RATE_LIMITS: Dict[str, Tuple[int, float]] = {
    "chat": (8, 10.0),
    "reaction": (15, 5.0),
    "signaling": (120, 10.0),
    "default": (60, 10.0),
}


def _allow_event(
    buckets: Dict[str, Deque[float]], event: str, now: Optional[float] = None
) -> bool:
    """Simple per-connection sliding-window rate limiter."""
    limit, window = RATE_LIMITS[event]
    now = time.monotonic() if now is None else now
    bucket = buckets[event]
    cutoff = now - window
    while bucket and bucket[0] <= cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        return False
    bucket.append(now)
    return True


def _event_bucket(message_type: object) -> str:
    if message_type in {"offer", "answer", "ice-candidate"}:
        return "signaling"
    if message_type == "chat":
        return "chat"
    if message_type == "reaction":
        return "reaction"
    return "default"


def create_guest_token(guest_id: str, room_code: str, display_name: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": "guest", "typ": "guest_access", "gid": guest_id,
        "room": room_code, "display": display_name,
        "iat": now, "exp": now + timedelta(hours=GUEST_TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_guest_token(token: str, room_code: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if (payload.get("sub") != "guest" or payload.get("typ") != "guest_access"
                or payload.get("room") != room_code or not payload.get("gid")):
            return None
        from uuid import UUID
        payload["gid"] = str(UUID(str(payload["gid"])))
        return payload
    except (JWTError, ValueError, TypeError):
        return None


class RoomMember:
    def __init__(self, client_id: str, name: str, websocket: WebSocket, user_id: Optional[int] = None, guest_id: Optional[str] = None, is_owner: bool = False, is_original_owner: bool = False):
        self.client_id = client_id
        self.name = name
        self.websocket = websocket
        self.user_id = user_id
        self.guest_id = guest_id
        self.turn_ticket: Optional[str] = None
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
    sender_guest_id: Optional[str] = None,
    is_private: bool = False,
    recipient_user_id: Optional[int] = None,
    recipient_guest_id: Optional[str] = None,
    recipient_name: Optional[str] = None,
) -> None:
    """Persist a chat message. Never raises: a storage failure must NOT take
    down the WebSocket connection (chat still broadcasts even if saving fails)."""
    try:
        msg = ChatMessage(
            room_id=room_id, user_id=user_id, sender_name=sender_name, text=text,
            sender_guest_id=sender_guest_id,
            is_private=is_private,
            recipient_user_id=recipient_user_id,
            recipient_guest_id=recipient_guest_id,
            recipient_name=recipient_name,
        )
        db.add(msg)
        db.commit()
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        print(f"[meetly] chat persist failed (non-fatal): {e}")


@router.get("/rooms/{room_code}/peers", tags=["rooms"])
def get_peers(
    room_code: str,
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Return peer count only to the room owner to prevent room enumeration."""
    room = db.query(Room).filter(Room.code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to view this room")
    return {"room_code": room.code, "count": get_room_member_count(room.code)}


@router.websocket("/ws/{room_code}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_code: str,
):
    # Validate the browser Origin *before* accepting the WebSocket. This prevents
    # arbitrary websites from opening a WebSocket to Meetly from a victim's browser.
    origin = (websocket.headers.get("origin") or "").rstrip("/")
    if origin not in ALLOWED_ORIGINS:
        await websocket.close(code=1008, reason="Origin not allowed")
        return

    await websocket.accept()

    # 1) Wait briefly for the required authentication message. Do not allow
    # unauthenticated clients to keep an accepted WebSocket open indefinitely.
    try:
        raw = await asyncio.wait_for(
            websocket.receive_text(), timeout=WS_AUTH_TIMEOUT_SECONDS
        )
        if len(raw.encode("utf-8")) > MAX_WS_MESSAGE_BYTES:
            await websocket.close(code=1009, reason="Message too large")
            return
        data = json.loads(raw)
    except asyncio.TimeoutError:
        await websocket.close(code=4408, reason="Authentication timeout")
        return
    except WebSocketDisconnect:
        return
    except (json.JSONDecodeError, ValueError, TypeError):
        await websocket.close(code=4401, reason="Expected auth message")
        return

    if data.get("type") != "auth":
        await websocket.close(code=4401, reason="Invalid handshake")
        return

    token = data.get("token")
    guest_name = (data.get("guest_name") or "").strip()
    guest_token = (data.get("guest_token") or "").strip()

    user_id: Optional[int] = None
    stable_guest_id: Optional[str] = None
    display_name: str = ""
    is_owner: bool = False

    # Validate room existence first
    db = SessionLocal()
    try:
        room = db.query(Room).filter(Room.code == room_code).first()
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
                    # JWTs are only valid while their embedded token version
                    # matches the user's current version.
                    if user and payload.get("ver") == user.token_version:
                        user_id = user.id
                        display_name = user.username
                        is_owner = (user.id == room_owner_id)
            except JWTError:
                pass  # Fall back to guest if token is invalid or expired

        # If not authenticated via token, authenticate a returning guest with a
        # signed credential or issue a new server-bound identity on first join.
        if not user_id:
            guest_claims = verify_guest_token(guest_token, room_code) if guest_token else None
            if guest_token and guest_claims is None:
                await websocket.close(code=4401, reason="Invalid guest token")
                return
            if guest_claims:
                stable_guest_id = guest_claims["gid"]
                display_name = str(guest_claims.get("display") or "Guest")[:30]
            else:
                from uuid import uuid4
                stable_guest_id = str(uuid4())
                display_name = guest_name[:30] if guest_name else f"Guest_{secrets.token_hex(2)}"
                guest_token = create_guest_token(stable_guest_id, room_code, display_name)
            is_owner = False

    finally:
        db.close()

    room_members = _room(room_code)

    # A browser can reconnect before its previous WebSocket has fully closed.
    # Treat the authenticated user ID / stable guest ID as the connection
    # identity and replace an older connection from the same identity. Without
    # this, a refresh or reconnect can temporarily create duplicate participants.
    stale_ids = []
    for existing_id, existing_member in list(room_members.items()):
        same_user = user_id is not None and existing_member.user_id == user_id
        same_guest = stable_guest_id is not None and existing_member.guest_id == stable_guest_id
        if same_user or same_guest:
            stale_ids.append(existing_id)

    for stale_id in stale_ids:
        stale_member = room_members.pop(stale_id, None)
        if stale_member is not None:
            if SPOTLIGHTS.get(room_code) == stale_id:
                SPOTLIGHTS[room_code] = None
                await broadcast(room_code, {"type": "spotlight-update", "id": None})
            await broadcast(room_code, {"type": "peer-left", "id": stale_id}, exclude=stale_id)
            revoke_turn_ticket(stale_member.turn_ticket)
            try:
                await stale_member.websocket.close(code=4000, reason="Replaced by a newer connection")
            except Exception:
                pass

    client_id = secrets.token_hex(8)
    member = RoomMember(
        client_id=client_id,
        name=display_name,
        websocket=websocket,
        user_id=user_id,
        guest_id=stable_guest_id,
        is_owner=is_owner,
        is_original_owner=is_owner,
    )
    # TURN authorization is issued only after the participant has passed the
    # WebSocket room authentication. The ticket is short-lived and revoked when
    # the participant disconnects.
    member.turn_ticket = issue_turn_ticket(room_code)
    room_members[client_id] = member

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
        await member.send({
            "type": "joined",
            "id": client_id,
            "name": display_name,
            "is_owner": is_owner,
            "peers": peers,
            "spotlight": SPOTLIGHTS.get(room_code),
            "turn_ticket": member.turn_ticket,
            **({"guest_token": guest_token} if stable_guest_id is not None else {}),
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

        event_buckets: Dict[str, Deque[float]] = defaultdict(deque)
        malformed_messages = 0

        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_WS_MESSAGE_BYTES:
                await websocket.close(code=1009, reason="Message too large")
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                malformed_messages += 1
                if malformed_messages >= 10:
                    await websocket.close(code=1008, reason="Too many malformed messages")
                    break
                continue

            malformed_messages = 0
            if not isinstance(data, dict):
                continue
            mtype = data.get("type")
            bucket = _event_bucket(mtype)
            if not _allow_event(event_buckets, bucket):
                # Drop excess events instead of disconnecting legitimate users
                # because browsers can briefly burst ICE candidates.
                continue

            if mtype == "offer":
                target = data.get("to")
                await relay(room_code, target, {
                    "type": "offer", "from": client_id,
                    "from_name": member.name, "sdp": data.get("sdp"),
                })
            elif mtype == "answer":
                target = data.get("to")
                await relay(room_code, target, {
                    "type": "answer", "from": client_id, "sdp": data.get("sdp"),
                })
            elif mtype == "ice-candidate":
                target = data.get("to")
                await relay(room_code, target, {
                    "type": "ice-candidate", "from": client_id,
                    "candidate": data.get("candidate"),
                })
            elif mtype == "chat":
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
                    db2 = SessionLocal()
                    try:
                        persist_chat(
                            db2, room_id, member.user_id, member.name, text,
                            is_private=True,
                            sender_guest_id=member.guest_id,
                            recipient_user_id=target_member.user_id,
                            recipient_guest_id=target_member.guest_id,
                            recipient_name=target_member.name,
                        )
                    finally:
                        db2.close()
                    await target_member.send({
                        "type": "chat", "from": client_id, "name": member.name,
                        "text": text, "private": True,
                        "to": dm_target_id, "to_name": target_member.name,
                    })
                else:
                    db2 = SessionLocal()
                    try:
                        persist_chat(db2, room_id, member.user_id, member.name, text, sender_guest_id=member.guest_id)
                    finally:
                        db2.close()
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
        # If this connection was already replaced by a newer connection from the
        # same user/guest, it was removed above. Do not remove or notify peers
        # about anything again.
        is_current_connection = room_members.get(client_id) is member
        if is_current_connection:
            was_original_owner = member.is_original_owner
            room_members.pop(client_id, None)
            revoke_turn_ticket(member.turn_ticket)

        if is_current_connection and not room_members:
            ROOMS.pop(room_code, None)
            SPOTLIGHTS.pop(room_code, None)
        elif is_current_connection:
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
