"""Shared market-session helpers for live and simulation trading runtimes."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, cast
from zoneinfo import ZoneInfo

from ..config import settings
from .time_source import trading_now

logger = logging.getLogger(__name__)


def market_session_is_open(
    trading_client: Any | None,
    *,
    now: datetime | None = None,
) -> bool:
    if settings.trading_simulation_enabled:
        current = (now or trading_now()).astimezone(ZoneInfo('America/New_York'))
        if current.weekday() >= 5:
            return False
        session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
        session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
        return session_open <= current < session_close

    get_clock = cast(Callable[[], Any] | None, getattr(trading_client, 'get_clock', None))
    if callable(get_clock):
        try:
            clock = get_clock()
            is_open = getattr(clock, 'is_open', None)
            if isinstance(is_open, bool):
                return is_open
            if is_open is not None:
                return bool(is_open)
        except Exception:
            logger.exception('Failed to resolve Alpaca market clock state')

    current = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo('America/New_York'))
    if current.weekday() >= 5:
        return False
    session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
    session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
    return session_open <= current < session_close


__all__ = ['market_session_is_open']
