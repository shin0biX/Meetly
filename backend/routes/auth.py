import time
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field
from typing import Annotated, Optional
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from datetime import timedelta, datetime, timezone
from jose import JWTError, jwt

from database import get_db
from models import User
from config import SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES
from rate_limit import rate_limit_check

router = APIRouter(prefix="/auth", tags=["auth"])

bcrypt_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_bearer = OAuth2PasswordBearer(tokenUrl="auth/token")
oauth2_bearer_optional = OAuth2PasswordBearer(tokenUrl="auth/token", auto_error=False)


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


def create_access_token(username: str, user_id: int) -> str:
    encode = {"sub": username, "id": user_id}
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
    if user is None:
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
        return db.query(User).filter(User.id == user_id).first()
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
    rate_limit_check(http_request, "register", window=60, max_requests=15)

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


@router.post("/token")
def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
):
    rate_limit_check(request, "token", window=60, max_requests=15)

    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = create_access_token(user.username, user.id)
    return {"access_token": token, "token_type": "bearer", "username": user.username}


@router.get("/me", response_model=UserOut)
def me(current_user: Annotated[User, Depends(get_current_user)]):
    return current_user


@router.post("/refresh")
def refresh(current_user: Annotated[User, Depends(get_current_user)]):
    """Mint a fresh token for a still-valid session (sliding expiration).

    The frontend calls this on load so an active user's session window keeps
    rolling forward and they don't have to log in again between visits. A
    fully expired token fails get_current_user -> 401, which triggers the
    normal logout flow on the client.
    """
    token = create_access_token(current_user.username, current_user.id)
    return {"access_token": token, "token_type": "bearer", "username": current_user.username}
