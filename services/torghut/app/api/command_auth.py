"""Fail-closed authentication for state-changing Torghut API commands."""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Request

from app.config import settings

_COMMAND_TOKEN_HEADER = "x-torghut-command-token"


def _bearer_token(authorization: str | None) -> str | None:
    if authorization is None:
        return None
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer":
        return None
    normalized = token.strip()
    return normalized or None


def _tokens_match(provided: str, expected: str) -> bool:
    try:
        return secrets.compare_digest(
            provided.encode("utf-8"),
            expected.encode("utf-8"),
        )
    except UnicodeError:
        return False


def require_command_auth(request: Request) -> None:
    """Authorize a mutation using Torghut's dedicated command token."""

    expected = str(settings.torghut_command_api_token or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="command_auth_not_configured")

    provided = request.headers.get(_COMMAND_TOKEN_HEADER, "").strip() or None
    if provided is None:
        provided = _bearer_token(request.headers.get("authorization"))
    if provided is None or not _tokens_match(provided, expected):
        raise HTTPException(status_code=401, detail="command_auth_required")


__all__ = ("require_command_auth",)
