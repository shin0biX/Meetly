import secrets
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from typing import Annotated, Optional
from sqlalchemy.orm import Session

from database import get_db
from models import User, Room, ChatMessage
from routes.auth import get_current_user, get_optional_user

router = APIRouter(prefix="/rooms", tags=["rooms"])


class RoomCreate(BaseModel):
    name: str = Field(default="", max_length=60)
    code: Optional[str] = Field(default=None, max_length=20)  # if omitted, generate one


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
    to_name: Optional[str] = None  # recipient display name, only set for DMs


def generate_room_code() -> str:
    return secrets.token_hex(3)  # 6-char hex code


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
    if not code.isalnum():
        raise HTTPException(status_code=400, detail="Room code must be letters/numbers only")
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
    room = db.query(Room).filter(Room.code == code.lower()).first()
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
    guest_name: Optional[str] = None,
    limit: int = 50,
):
    room = db.query(Room).filter(Room.code == code.lower()).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

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
            if not visible and guest_name:
                sender_label = m.sender_name or ""
                recipient_label = m.recipient_name or ""
                if guest_name in (sender_label, recipient_label):
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
            )
        )
        if len(result) >= min(limit, 200):
            break
    return list(reversed(result))
