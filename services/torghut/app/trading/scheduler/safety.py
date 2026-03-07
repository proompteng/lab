"""Scheduler safety and market-session helpers."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from typing import Any, cast
from zoneinfo import ZoneInfo

from ...config import settings
from ..time_source import trading_now

logger = logging.getLogger(__name__)
_RECOVERABLE_EMERGENCY_STOP_PREFIXES: tuple[str, ...] = (
    "signal_lag_exceeded:",
    "signal_staleness_streak_exceeded:",
)

def _normalize_emergency_stop_reason_entry(raw: str) -> str:
    normalized = raw.strip()
    return normalized or "unknown"


def _split_emergency_stop_reasons(raw: str | None) -> list[str]:
    if not raw:
        return []
    return _merge_emergency_stop_reasons(raw.split(";"))


def _merge_emergency_stop_reasons(raw_reasons: Sequence[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for raw_reason in raw_reasons:
        reason = _normalize_emergency_stop_reason_entry(raw_reason)
        if reason == "unknown":
            continue
        if reason in seen:
            continue
        seen.add(reason)
        deduped.append(reason)
    return deduped


def _is_recoverable_emergency_stop_reason(reason: str) -> bool:
    return any(
        reason.startswith(prefix) for prefix in _RECOVERABLE_EMERGENCY_STOP_PREFIXES
    )


def _coerce_recovery_reason_sequence(raw_reasons: Sequence[str] | None) -> list[str]:
    if not raw_reasons:
        return []
    return _merge_emergency_stop_reasons(raw_reasons)

def _is_market_session_open(
    trading_client: Any | None,
    *,
    now: datetime | None = None,
) -> bool:
    if settings.trading_simulation_enabled:
        current = (now or trading_now()).astimezone(ZoneInfo("America/New_York"))
        if current.weekday() >= 5:
            return False
        session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
        session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
        return session_open <= current < session_close
    get_clock = cast(
        Callable[[], Any] | None, getattr(trading_client, "get_clock", None)
    )
    if callable(get_clock):
        try:
            clock = get_clock()
            is_open = getattr(clock, "is_open", None)
            if isinstance(is_open, bool):
                return is_open
            if is_open is not None:
                return bool(is_open)
        except Exception:
            logger.exception("Failed to resolve Alpaca market clock state")

    current = (now or datetime.now(timezone.utc)).astimezone(
        ZoneInfo("America/New_York")
    )
    if current.weekday() >= 5:
        return False
    session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
    session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
    return session_open <= current < session_close


def _latch_signal_continuity_alert_state(state: Any, reason: str) -> None:
    now = datetime.now(timezone.utc)
    if not state.signal_continuity_alert_active:
        state.signal_continuity_alert_started_at = now
    state.signal_continuity_alert_active = True
    state.signal_continuity_alert_reason = reason
    state.signal_continuity_alert_last_seen_at = now
    state.signal_continuity_recovery_streak = 0
    state.metrics.record_signal_continuity_alert_state(
        active=True,
        recovery_streak=0,
    )


def _record_signal_continuity_recovery_cycle(
    state: Any, *, required_recovery_cycles: int
) -> None:
    if not state.signal_continuity_alert_active:
        state.metrics.record_signal_continuity_alert_state(
            active=False,
            recovery_streak=0,
        )
        return

    state.signal_continuity_recovery_streak += 1
    state.metrics.record_signal_continuity_alert_state(
        active=True,
        recovery_streak=state.signal_continuity_recovery_streak,
    )
    if state.signal_continuity_recovery_streak < required_recovery_cycles:
        return

    logger.info(
        "Signal continuity alert cleared after healthy cycles=%s reason=%s",
        state.signal_continuity_recovery_streak,
        state.signal_continuity_alert_reason,
    )
    state.signal_continuity_alert_active = False
    state.signal_continuity_alert_reason = None
    state.signal_continuity_alert_started_at = None
    state.signal_continuity_alert_last_seen_at = None
    state.signal_continuity_recovery_streak = 0
    state.metrics.record_signal_continuity_alert_state(
        active=False,
        recovery_streak=0,
    )


__all__ = [
    "_coerce_recovery_reason_sequence",
    "_is_market_session_open",
    "_is_recoverable_emergency_stop_reason",
    "_latch_signal_continuity_alert_state",
    "_merge_emergency_stop_reasons",
    "_record_signal_continuity_recovery_cycle",
    "_split_emergency_stop_reasons",
]
