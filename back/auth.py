import os
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    credentials_obj: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> dict:
    """
    FastAPI dependency that verifies our own session JWT (issued by POST /auth/login).

    - Skips verification for ``/health``, ``/auth/*`` and all ``OPTIONS`` requests.
    - Raises HTTP 401 if no token is provided on protected routes.
    - Raises HTTP 403 if the token is invalid or expired.

    Returns the decoded token payload (dict) on success.
    """
    path = request.url.path

    # Skip auth for health-check, auth endpoints, and CORS pre-flight
    if path == "/health" or path.startswith("/auth") or request.method == "OPTIONS":
        return {}

    if credentials_obj is None or not credentials_obj.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    secret_key = os.getenv("SECRET_KEY")
    if not secret_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="SECRET_KEY is not configured on the server.",
        )

    try:
        decoded = jwt.decode(
            credentials_obj.credentials,
            secret_key,
            algorithms=["HS256"],
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Session has expired. Please sign in again.",
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Invalid session token: {exc}",
        )

    return decoded


def owner_id_of(user: dict) -> str:
    """
    Return the stable owner key for the signed-in user: the Google ``sub``.

    Every document the app writes carries ``owner_id`` set from this, and every
    read is scoped to it.  Keyed on ``sub`` rather than ``email`` because a
    Google account's email can change while its ``sub`` never does.

    Raises HTTP 401 when the payload carries no ``sub`` — a token without one
    cannot be scoped to anybody, so it must not be allowed to read anything.
    """
    sub = (user or {}).get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session token has no user id. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return sub
