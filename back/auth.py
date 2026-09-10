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
