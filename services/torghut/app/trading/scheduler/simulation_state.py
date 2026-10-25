"""Reset scheduler state when an in-process simulation run changes."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from ..simulation_progress import active_simulation_runtime_context
from .state import TradingState

logger = logging.getLogger(__name__)


def sync_simulation_run_state(
    state: TradingState,
    active_run_id: str | None,
) -> str | None:
    runtime_context = active_simulation_runtime_context()
    next_run_id = str((runtime_context or {}).get("run_id") or "").strip() or None
    if next_run_id == active_run_id:
        return active_run_id
    if next_run_id is None:
        return None

    _reset_simulation_run_state(state)
    logger.info(
        "Trading scheduler reset simulation run state previous_run_id=%s active_run_id=%s",
        active_run_id or "none",
        next_run_id,
    )
    return next_run_id


def _reset_simulation_run_state(state: TradingState) -> None:
    state.last_error = None
    state.last_trading_error = None
    state.last_reconcile_error = None
    state.last_autonomy_error = None
    state.last_evidence_error = None
    state.last_ingest_signals_total = 0
    state.last_ingest_window_start = None
    state.last_ingest_window_end = None
    state.last_ingest_reason = None
    state.last_signal_continuity_state = None
    state.last_signal_continuity_reason = None
    state.last_signal_continuity_actionable = None
    state.signal_continuity_alert_active = False
    state.signal_continuity_alert_reason = None
    state.signal_continuity_alert_started_at = None
    state.signal_continuity_alert_last_seen_at = None
    state.signal_continuity_recovery_streak = 0
    state.signal_bootstrap_started_at = datetime.now(timezone.utc)
    state.signal_bootstrap_completed_at = None
    state.autonomy_no_signal_streak = 0
    state.last_evidence_continuity_report = None
    state.autonomy_failure_streak = 0
    state.universe_fail_safe_blocked = False
    state.universe_fail_safe_block_reason = None
    state.emergency_stop_active = False
    state.emergency_stop_reason = None
    state.emergency_stop_triggered_at = None
    state.emergency_stop_resolved_at = None
    state.emergency_stop_recovery_streak = 0
    state.rollback_incident_evidence_path = None
    state.metrics.no_signal_streak = 0
    state.metrics.no_signal_reason_streak = {}
    state.metrics.signal_lag_seconds = None
    state.metrics.signal_continuity_actionable = 0
    state.metrics.record_signal_continuity_alert_state(
        active=False,
        recovery_streak=0,
    )


__all__ = ("sync_simulation_run_state",)
