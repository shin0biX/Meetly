import secrets
import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from typing import Annotated, Optional
from sqlalchemy.orm import Session

from database import get_db
from models import User, Room, ChatMessage
from routes.auth import get_current_user, get_optional_user
from routes.realtime import verify_guest_token

router = APIRouter(prefix="/rooms", tags=["rooms"])


class RoomCreate(BaseModel):
    name: str = Field(default="", max_length=60)
    code: Optional[str] = Field(default=None, max_length=64)  # if omitted, generate one


class RoomOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    name: str
    owner_id: int
    is_owner: Optional[bool] = None


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    text: str
    username: str
    created_at: Optional[datetime] = None
    is_private: bool = False
    to_name: Optional[str] = None
    is_self: bool = False # recipient display name, only set for DMs


def generate_room_code() -> str:
    """Generate a high-entropy, URL-safe room access code (128 bits)."""
    return secrets.token_urlsafe(16)


ROOM_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


# Creating a room REQUIRES being logged in
@router.post("/", response_model=RoomOut, status_code=201)
def create_room(
    request: RoomCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    name = (request.name or "").strip() or f"{user.username}'s room"
    code = (request.code or "").strip().lower()
    if not code:
        code = generate_room_code()
    if not ROOM_CODE_PATTERN.fullmatch(code):
        raise HTTPException(status_code=400, detail="Room code may contain only letters, numbers, hyphens, and underscores")
    if db.query(Room).filter(Room.code == code).first():
        raise HTTPException(status_code=400, detail="Room code already in use")

    # Rooms are private by default
    room = Room(code=code, name=name[:60], owner_id=user.id, is_public=False)
    db.add(room)
    db.commit()
    db.refresh(room)
    return RoomOut(
        id=room.id,
        code=room.code,
        name=room.name,
        owner_id=room.owner_id,
        is_owner=True
    )


# Listing personal rooms REQUIRES being logged in
@router.get("/", response_model=list[RoomOut])
def list_rooms(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    # Only return rooms owned by the logged-in user
    rooms = (
        db.query(Room)
        .filter(Room.owner_id == user.id)
        .order_by(Room.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [
        RoomOut(
            id=r.id,
            code=r.code,
            name=r.name,
            owner_id=r.owner_id,
            is_owner=True
        )
        for r in rooms
    ]


# Getting room details to join allows BOTH logged-in users and guests
@router.get("/{code}", response_model=RoomOut)
def get_room(
    code: str,
    user: Annotated[Optional[User], Depends(get_optional_user)],
    db: Annotated[Session, Depends(get_db)],
):
    room = db.query(Room).filter(Room.code == code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    is_owner = bool(user and user.id == room.owner_id)
    return RoomOut(
        id=room.id,
        code=room.code,
        name=room.name,
        owner_id=room.owner_id,
        is_owner=is_owner
    )


# Fetching chat messages in a room allows BOTH logged-in users and guests.
# guest_name identifies a guest's own DMs across reconnects (their client_id
# changes every time, but the display name is the only stable handle they have).
@router.get("/{code}/messages", response_model=list[MessageOut])
def room_messages(
    code: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[Optional[User], Depends(get_optional_user)],
    authorization: Optional[str] = Header(default=None),
    limit: int = 50,
):
    room = db.query(Room).filter(Room.code == code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # Guests must prove identity with a signed room-bound credential. A raw
    # guest ID is never accepted as authorization.
    verified_guest_id = None
    if user is None and authorization:
        scheme, _, guest_token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not guest_token:
            raise HTTPException(status_code=401, detail="Invalid guest authentication")
        claims = verify_guest_token(guest_token, code)
        if claims is None:
            raise HTTPException(status_code=401, detail="Invalid guest token")
        verified_guest_id = claims["gid"]

    # Over-fetch a bit since private messages the viewer can't see get
    # dropped below, and we still want up to `limit` visible messages.
    fetch_limit = min(limit, 200) * 3
    messages = (
        db.query(ChatMessage)
        .outerjoin(User, ChatMessage.user_id == User.id)
        .filter(ChatMessage.room_id == room.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(fetch_limit)
        .all()
    )
    # Walk newest-first so an early stop keeps the most recent visible
    # messages (not the oldest ones in the fetched batch); reverse at the end
    # for chronological display order.
    result = []
    for m in messages:
        if m.is_private:
            visible = False
            if user is not None:
                if m.user_id == user.id or m.recipient_user_id == user.id:
                    visible = True
            if not visible and verified_guest_id:
                if verified_guest_id in (m.sender_guest_id, m.recipient_guest_id):
                    visible = True
            if not visible:
                continue

        # created_at is stored as naive UTC in SQLite; mark it timezone-aware so
        # the frontend's new Date(...) converts it to the viewer's local time
        # instead of misreading UTC as local time (the old chat-time bug).
        ts = m.created_at
        if ts is not None and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        result.append(
            MessageOut(
                id=m.id,
                text=m.text,
                username=m.sender_name or (m.user.username if m.user else "Guest"),
                created_at=ts,
                is_private=bool(m.is_private),
                to_name=m.recipient_name if m.is_private else None,
                is_self=(
                    (user is not None and m.user_id == user.id)
                    or (user is None and verified_guest_id is not None and m.sender_guest_id == verified_guest_id)
                ),
            )
        )
        if len(result) >= min(limit, 200):
            break
    return list(reversed(result))
