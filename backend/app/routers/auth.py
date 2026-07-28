from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.plex_client import (
    PlexAuthExpired,
    PlexAuthPending,
    auth_url,
    create_pin,
    fetch_account,
    fetch_servers,
    poll_pin,
)
from app.security import create_session_token, get_current_user, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    user_id: int
    is_admin: bool


@router.get("/status")
def auth_status(db: Session = Depends(get_db)):
    """Whether any account exists yet — the frontend uses this to decide first-run setup vs. login."""
    return {"has_users": db.query(User).first() is not None}


@router.post("/register", response_model=TokenResponse)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(User).filter_by(email=body.email).first() is not None:
        raise HTTPException(status_code=409, detail="An account with that email already exists")

    is_first_user = db.query(User).first() is None
    user = User(email=body.email, password_hash=hash_password(body.password), is_admin=is_first_user)
    db.add(user)
    db.commit()
    db.refresh(user)

    return TokenResponse(access_token=create_session_token(user.id), user_id=user.id, is_admin=user.is_admin)


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter_by(email=body.email).first()
    if user is None or user.password_hash is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    return TokenResponse(access_token=create_session_token(user.id), user_id=user.id, is_admin=user.is_admin)


@router.get("/me")
def me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "email": current_user.email,
        "is_admin": current_user.is_admin,
        "plex_username": current_user.plex_username,
        "has_password": current_user.password_hash is not None,
    }


class ChangeEmailRequest(BaseModel):
    email: EmailStr


@router.patch("/email")
def change_email(body: ChangeEmailRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    existing = db.query(User).filter_by(email=body.email).first()
    if existing is not None and existing.id != current_user.id:
        raise HTTPException(status_code=409, detail="An account with that email already exists")
    current_user.email = body.email
    db.commit()
    return {"status": "updated"}


class ChangePasswordRequest(BaseModel):
    # Not required if the account doesn't have a local password yet (Plex-only login) — this lets
    # that account set one for the first time rather than "changing" a password that never existed.
    current_password: str | None = None
    new_password: str


@router.patch("/password")
def change_password(body: ChangePasswordRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.password_hash is not None:
        if not body.current_password or not verify_password(body.current_password, current_user.password_hash):
            raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    current_user.password_hash = hash_password(body.new_password)
    db.commit()
    return {"status": "updated"}


# --- Plex account SSO: authenticates + discovers servers, doesn't touch a specific server yet. ---


@router.post("/plex/pin")
def start_plex_pin():
    pin = create_pin()
    return {"pin_id": pin["id"], "auth_url": auth_url(pin["code"])}


@router.get("/plex/pin/{pin_id}", response_model=TokenResponse)
def check_plex_pin(pin_id: int, db: Session = Depends(get_db)):
    """Poll until the user approves in their browser. On approval, creates or logs into the matching
    CreditEngine account (matched by Plex account id) and returns a normal session token — same shape
    as /auth/login, so the frontend doesn't need to branch on how the user signed in."""
    try:
        account_token = poll_pin(pin_id)
    except PlexAuthPending:
        raise HTTPException(status_code=202, detail="pending")
    except PlexAuthExpired:
        raise HTTPException(status_code=410, detail="PIN expired, request a new one")

    account = fetch_account(account_token)

    user = db.query(User).filter_by(plex_id=account["id"]).first()
    if user is None:
        is_first_user = db.query(User).first() is None
        user = User(
            email=f"plex-{account['id']}@placeholder.local",
            plex_id=account["id"],
            plex_username=account["username"],
            plex_account_token=account_token,
            is_admin=is_first_user,
        )
        db.add(user)
    else:
        user.plex_account_token = account_token
        user.plex_username = account["username"]
    db.commit()
    db.refresh(user)

    return TokenResponse(access_token=create_session_token(user.id), user_id=user.id, is_admin=user.is_admin)


@router.get("/plex/servers")
def list_plex_servers(current_user: User = Depends(get_current_user)):
    """Servers the linked Plex account can see, for the user to pick which one(s) to connect."""
    if not current_user.plex_account_token:
        raise HTTPException(status_code=400, detail="No Plex account linked — sign in with Plex first")
    return fetch_servers(current_user.plex_account_token)
