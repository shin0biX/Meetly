from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from database import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, nullable=False, index=True)
    email = Column(String, unique=True, nullable=False)
    full_name = Column(String, nullable=True)
    hashed_password = Column(String, nullable=False)
    created_at = Column(DateTime, default=utcnow)

    owned_rooms = relationship("Room", back_populates="owner")
    messages = relationship("ChatMessage", back_populates="user", foreign_keys="ChatMessage.user_id")


class Room(Base):
    __tablename__ = "rooms"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, nullable=False, index=True)
    name = Column(String, nullable=False)
    is_public = Column(Boolean, default=False)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=utcnow)

    owner = relationship("User", back_populates="owned_rooms")
    messages = relationship("ChatMessage", back_populates="room",
                            cascade="all, delete-orphan")


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # Nullable for guests
    sender_name = Column(String, nullable=True)  # Stores display name for guests/users
    text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=utcnow)

    # Direct-message fields. NULL/False recipient means a normal room-wide message.
    is_private = Column(Boolean, default=False, nullable=True)
    recipient_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    # Guests have no user_id, so DMs to/from a guest are matched by display
    # name instead. Weak (names aren't unique) but there's no other stable
    # guest identity across reconnects.
    recipient_name = Column(String, nullable=True)

    room = relationship("Room", back_populates="messages")
    user = relationship("User", back_populates="messages", foreign_keys=[user_id])
