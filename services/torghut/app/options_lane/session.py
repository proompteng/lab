"""Session-state helpers for the options lane."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

_MARKET_TZ = ZoneInfo("America/New_York")


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp."""

    return datetime.now(timezone.utc)


def session_state(now: datetime | None = None, holidays: set[str] | None = None) -> str:
    """Classify the current US options session into the contract states from doc 34."""

    effective_now = now.astimezone(timezone.utc) if now is not None else utc_now()
    market_now = effective_now.astimezone(_MARKET_TZ)
    iso_date = market_now.date().isoformat()

    if holidays and iso_date in holidays:
        return "holiday"
    if market_now.weekday() >= 5:
        return "weekend"

    minute_of_day = (market_now.hour * 60) + market_now.minute
    if 4 * 60 <= minute_of_day < 9 * 60 + 30:
        return "pre"
    if 9 * 60 + 30 <= minute_of_day < 16 * 60:
        return "regular"
    if 16 * 60 <= minute_of_day < 20 * 60:
        return "post"
    return "closed"


def is_regular_session(now: datetime | None = None, holidays: set[str] | None = None) -> bool:
    """Return true when the current market session is the regular trading session."""

    return session_state(now=now, holidays=holidays) == "regular"
