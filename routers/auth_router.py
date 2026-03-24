import os
from datetime import datetime, timedelta

import jwt
import pytz
import requests as http_requests
from fastapi import APIRouter, HTTPException, status
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["auth"])

_google_request = google_requests.Request(session=http_requests.Session())
_SGT = pytz.timezone("Asia/Singapore")
_SESSION_DAYS = int(os.getenv("SESSION_EXPIRY_DAYS", "7"))


class LoginRequest(BaseModel):
    id_token: str


class UserInfo(BaseModel):
    sub: str
    email: str
    name: str
    picture: str


class LoginResponse(BaseModel):
    session_token: str
    user: UserInfo


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest):
    """
    Exchange a fresh Google ID token for a 7-day session token.
    Called once after Google Sign-In on the frontend.
    """
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    secret_key = os.getenv("SECRET_KEY")

    if not client_id or not secret_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server auth is not configured (GOOGLE_CLIENT_ID or SECRET_KEY missing).",
        )

    # Verify the fresh Google ID token — this is the only time we hit Google
    try:
        decoded = id_token.verify_oauth2_token(
            body.id_token,
            _google_request,
            audience=client_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid Google ID token: {exc}",
        )

    now = datetime.now(tz=_SGT)
    payload = {
        "sub": decoded["sub"],
        "email": decoded["email"],
        "name": decoded.get("name", ""),
        "picture": decoded.get("picture", ""),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=_SESSION_DAYS)).timestamp()),
    }

    session_token = jwt.encode(payload, secret_key, algorithm="HS256")

    return LoginResponse(
        session_token=session_token,
        user=UserInfo(
            sub=decoded["sub"],
            email=decoded["email"],
            name=decoded.get("name", ""),
            picture=decoded.get("picture", ""),
        ),
    )
