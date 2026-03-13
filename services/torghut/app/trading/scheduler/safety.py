"""Scheduler safety and market-session helpers."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Any

from ..market_session import market_session_is_open

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
    return market_session_is_open(trading_client, now=now)


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
