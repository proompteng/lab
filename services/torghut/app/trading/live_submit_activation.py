"""Live-submit activation window helpers."""

from __future__ import annotations

from datetime import datetime, timezone

from ..config import settings


def _coerce_utc_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def live_submit_activation_status(
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    raw_expires_at = settings.trading_live_submit_activation_expires_at
    if raw_expires_at is None or not str(raw_expires_at).strip():
        return {
            "configured": False,
            "valid": True,
            "expired": False,
            "expires_at": None,
            "reason": None,
        }

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    expires_at = _coerce_utc_datetime(raw_expires_at)
    if expires_at is None:
        return {
            "configured": True,
            "valid": False,
            "expired": True,
            "expires_at": str(raw_expires_at),
            "observed_at": observed_at.isoformat(),
            "reason": "live_submit_activation_expiry_invalid",
        }

    expired = observed_at >= expires_at
    return {
        "configured": True,
        "valid": True,
        "expired": expired,
        "expires_at": expires_at.isoformat(),
        "observed_at": observed_at.isoformat(),
        "reason": "live_submit_activation_expired" if expired else None,
    }


def live_submit_activation_blocker(
    *,
    now: datetime | None = None,
) -> str | None:
    reason = live_submit_activation_status(now=now).get("reason")
    return str(reason) if reason else None


__all__ = ["live_submit_activation_blocker", "live_submit_activation_status"]
