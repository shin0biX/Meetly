import time
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field
from typing import Annotated, Optional
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from datetime import timedelta, datetime, timezone
from jose import JWTError, jwt

from database import get_db
from models import User, RefreshToken
from config import SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS, MAX_SESSION_LIFETIME_DAYS
import secrets
import hashlib

router = APIRouter(prefix="/auth", tags=["auth"])

bcrypt_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_bearer = OAuth2PasswordBearer(tokenUrl="auth/token")
oauth2_bearer_optional = OAuth2PasswordBearer(tokenUrl="auth/token", auto_error=False)


# ---------- In-memory rate limiter (IP-based sliding window) ----------
_rate_store: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX_REQUESTS = 15  # max attempts per window


def _rate_limit_check(request: Request) -> None:
    """Raise 429 if the client IP has exceeded the rate limit."""
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW

    # Prune old entries
    timestamps = _rate_store[client_ip]
    _rate_store[client_ip] = [t for t in timestamps if t > window_start]

    if len(_rate_store[client_ip]) >= RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later.",
        )
    _rate_store[client_ip].append(now)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=2, max_length=30)
    email: EmailStr
    full_name: str = Field(default="", max_length=100)
    password: str = Field(min_length=6, max_length=128)


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    full_name: str

    class Config:
        from_attributes = True


def create_access_token(username: str, user_id: int, token_version: int) -> str:
    encode = {"sub": username, "id": user_id, "ver": token_version}
    expires = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    encode.update({"exp": expires})
    return jwt.encode(encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: Annotated[str, Depends(oauth2_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    credentials_exception = HTTPException(
        status_code=401, detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: int | None = payload.get("id")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    user = db.query(User).filter(User.id == user_id).first()
    if user is None or payload.get("ver") != user.token_version:
        raise credentials_exception
    return user


def get_optional_user(
    token: Annotated[Optional[str], Depends(oauth2_bearer_optional)],
    db: Annotated[Session, Depends(get_db)],
) -> Optional[User]:
    """Return user if valid token provided, else None without raising 401."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: int | None = payload.get("id")
        if user_id is None:
            return None
        user = db.query(User).filter(User.id == user_id).first()
        if user is None or payload.get("ver") != user.token_version:
            return None
        return user
    except Exception:
        return None


def authenticate_user(db: Session, username: str, password: str) -> User | None:
    user = db.query(User).filter(User.username == username).first()
    if not user or not bcrypt_context.verify(password, user.hashed_password):
        return None
    return user


@router.post("/register", response_model=UserOut, status_code=201)
def register(
    request: RegisterRequest,
    db: Annotated[Session, Depends(get_db)],
    http_request: Request,
):
    _rate_limit_check(http_request)

    if db.query(User).filter(User.username == request.username).first():
        raise HTTPException(status_code=400, detail="Username already taken")
    if db.query(User).filter(User.email == request.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        username=request.username.strip(),
        email=request.email,
        full_name=request.full_name.strip(),
        hashed_password=bcrypt_context.hash(request.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_refresh_token_for_user(user: User, db: Session, *, original_session_start=None, request: Request | None = None) -> str:
    now = datetime.now(timezone.utc)
    original = original_session_start or now
    if original.tzinfo is None:
        original = original.replace(tzinfo=timezone.utc)
    raw_token = secrets.token_urlsafe(64)
    refresh = RefreshToken(
        user_id=user.id,
        token_hash=_hash_refresh_token(raw_token),
        created_at=now,
        expires_at=now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        original_session_start=original,
        revoked=False,
        user_agent=(request.headers.get("user-agent")[:500] if request and request.headers.get("user-agent") else None),
        ip_address=(request.client.host if request and request.client else None),
    )
    db.add(refresh)
    db.commit()
    return raw_token


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=512)


@router.post("/token")
def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
):
    _rate_limit_check(request)
    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    access_token = create_access_token(user.username, user.id, user.token_version)
    refresh_token = create_refresh_token_for_user(user, db, request=request)
    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer", "username": user.username}


@router.get("/me", response_model=UserOut)
def me(current_user: Annotated[User, Depends(get_current_user)]):
    return current_user


@router.post("/refresh")
def refresh(payload: RefreshRequest, db: Annotated[Session, Depends(get_db)], request: Request):
    now = datetime.now(timezone.utc)
    stored = db.query(RefreshToken).filter(RefreshToken.token_hash == _hash_refresh_token(payload.refresh_token)).first()
    if not stored or stored.revoked:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    expires_at = stored.expires_at.replace(tzinfo=timezone.utc) if stored.expires_at.tzinfo is None else stored.expires_at
    session_start = stored.original_session_start.replace(tzinfo=timezone.utc) if stored.original_session_start.tzinfo is None else stored.original_session_start
    if expires_at <= now:
        stored.revoked = True; db.commit()
        raise HTTPException(status_code=401, detail="Refresh token expired")
    if now >= session_start + timedelta(days=MAX_SESSION_LIFETIME_DAYS):
        db.query(RefreshToken).filter(RefreshToken.user_id == stored.user_id, RefreshToken.revoked == False).update({RefreshToken.revoked: True}, synchronize_session=False)
        db.commit()
        raise HTTPException(status_code=401, detail="Session has exceeded maximum lifetime")
    user = db.query(User).filter(User.id == stored.user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    stored.revoked = True
    db.commit()
    new_refresh = create_refresh_token_for_user(user, db, original_session_start=session_start, request=request)
    access_token = create_access_token(user.username, user.id, user.token_version)
    return {"access_token": access_token, "refresh_token": new_refresh, "token_type": "bearer", "username": user.username}


@router.post("/logout")
def logout(payload: RefreshRequest, db: Annotated[Session, Depends(get_db)]):
    stored = db.query(RefreshToken).filter(RefreshToken.token_hash == _hash_refresh_token(payload.refresh_token)).first()
    if not stored or stored.revoked:
        raise HTTPException(status_code=400, detail="Invalid refresh token")
    stored.revoked = True
    db.commit()
    return {"detail": "Logged out"}


@router.post("/logout-all")
def logout_all(current_user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)]):
    current_user.token_version += 1
    db.query(RefreshToken).filter(RefreshToken.user_id == current_user.id, RefreshToken.revoked == False).update({RefreshToken.revoked: True}, synchronize_session=False)
    db.commit()
    return {"detail": "All sessions have been invalidated"}

