"""Operational authority for live order submission.

Research promotion and paper-route evidence are intentionally outside this gate.
The runtime may submit only when its immediate safety dependencies are healthy.
"""

from __future__ import annotations

from collections.abc import Mapping
from urllib.request import urlopen

from ...config import settings
from ..hypotheses import (
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    resolve_hypothesis_dependency_quorum,
)
from ..tca import build_tca_gate_inputs
from .quant_health import (
    build_shadow_first_toggle_parity,
    critical_trading_toggle_snapshot,
    load_quant_evidence_status,
    resolve_active_capital_stage,
    resolve_quant_health_url,
)
from .repair_candidates import build_submission_gate_market_context_status
from .runtime_summary import build_hypothesis_runtime_summary

_ACCEPTED_SOURCE_FIELDS = (
    "state",
    "read_model_unavailable",
    "accepted_source_diagnostic_only",
    "accepted_sources",
    "latest_accepted_event_at",
    "accepted_lag_seconds",
    "accepted_max_lag_seconds",
    "accepted_source_state",
    "blocking_reason",
    "fresh_until",
    "freshness_reason_codes",
    "excluded_fresher_sources",
    "per_symbol_coverage",
    "stale_symbol_coverage",
    "market_session_state",
    "regular_session_open",
    "regular_session_open_at",
    "regular_session_close_at",
)


def build_live_submission_gate_payload(
    state: object,
    *,
    clickhouse_ta_status: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Return the single operational gate used by status, readiness, and execution."""
    freshness = _accepted_source_freshness(clickhouse_ta_status)
    execution_route = _execution_route_payload(state)
    blocked_reasons = _operational_blocked_reasons(
        state,
        execution_route=execution_route,
        freshness=freshness,
    )
    non_live = settings.trading_mode != "live"
    allowed = non_live or not blocked_reasons
    reason = (
        "non_live_mode"
        if non_live
        else (blocked_reasons[0] if blocked_reasons else "operational_submission_ready")
    )
    reason_codes = [reason] if non_live or not blocked_reasons else blocked_reasons
    capital_state = (
        settings.trading_mode if non_live else ("live" if allowed else "blocked")
    )
    payload: dict[str, object] = {
        "schema_version": "torghut.operational-submission-gate.v2",
        "allowed": allowed,
        "reason": reason,
        "blocked_reasons": [] if non_live else blocked_reasons,
        "reason_codes": reason_codes,
        "capital_stage": capital_state,
        "capital_state": capital_state,
        "authority_scope": "operational_submission",
        "configured_live_submit": settings.trading_live_submit_enabled,
        "simple_submit_enabled": settings.trading_simple_submit_enabled,
        "new_exposure_allowed": bool(
            getattr(state, "capital_new_exposure_allowed", True)
        ),
        "execution_route": execution_route,
        "clickhouse_ta_freshness": freshness,
        **freshness,
    }
    payload["operational_submission_gate"] = {
        "allowed": allowed,
        "reason": reason,
        "blocked_reasons": [] if non_live else blocked_reasons,
        "execution_route": execution_route,
    }
    return payload


def _operational_blocked_reasons(
    state: object,
    *,
    execution_route: Mapping[str, object],
    freshness: Mapping[str, object],
) -> list[str]:
    reasons: list[str] = []
    if not settings.trading_enabled:
        reasons.append("trading_disabled")
    if settings.trading_kill_switch_enabled:
        reasons.append("kill_switch_enabled")
    if not settings.trading_simple_submit_enabled:
        reasons.append("submit_disabled")
    if not settings.trading_live_submit_enabled:
        reasons.append("live_submit_disabled")
    if settings.trading_emergency_stop_enabled and bool(
        getattr(state, "emergency_stop_active", False)
    ):
        reasons.append(
            str(getattr(state, "emergency_stop_reason", "") or "emergency_stop_active")
        )
    if bool(getattr(state, "signal_continuity_alert_active", False)):
        reasons.append("signal_continuity_alert_active")
    if bool(getattr(state, "market_context_alert_active", False)):
        reasons.append("market_context_alert_active")
    if bool(getattr(state, "universe_fail_safe_blocked", False)):
        reasons.append(
            str(
                getattr(state, "universe_fail_safe_block_reason", "")
                or "universe_fail_safe_blocked"
            )
        )
    if execution_route.get("route") != "alpaca":
        reasons.append("mainnet_route_unavailable")
    elif not _alpaca_broker_available():
        reasons.append("broker_unavailable")
    if blocker := _accepted_ta_submission_blocker(freshness):
        reasons.append(blocker)
    return list(dict.fromkeys(reason for reason in reasons if reason))


def _accepted_ta_submission_blocker(status: Mapping[str, object]) -> str | None:
    blocking_reason = str(status.get("blocking_reason") or "").strip()
    if blocking_reason:
        return blocking_reason
    if bool(status.get("accepted_source_diagnostic_only")):
        return None
    if bool(status.get("read_model_unavailable")):
        return "accepted_ta_signal_unavailable"

    source_state = str(status.get("accepted_source_state") or "").strip()
    source_blocker = {
        "": "accepted_ta_signal_unavailable",
        "stale": "accepted_ta_signal_stale",
        "missing": "accepted_ta_signal_missing",
        "unavailable": "accepted_ta_signal_unavailable",
    }.get(source_state)
    if source_blocker is not None:
        return source_blocker

    read_model_state = str(status.get("state") or "").strip()
    if read_model_state in {
        "missing",
        "unavailable",
        "deferred",
    }:
        return "accepted_ta_signal_unavailable"
    return None


def _accepted_source_freshness(
    status: Mapping[str, object] | None,
) -> dict[str, object]:
    source = status or {}
    return {field: source.get(field) for field in _ACCEPTED_SOURCE_FIELDS}


def _execution_route_payload(state: object) -> dict[str, object]:
    session_open = getattr(state, "market_session_open", None) is True
    return {
        "route": "alpaca" if session_open else "closed",
        "reason": (
            "alpaca_regular_session_open"
            if session_open
            else "alpaca_regular_session_closed"
        ),
        "alpaca_regular_session_open": session_open,
    }


def _alpaca_broker_available() -> bool:
    return any(
        str(getattr(account, "api_key", "") or "").strip()
        and str(getattr(account, "secret_key", "") or "").strip()
        for account in settings.trading_accounts
    )


__all__ = [
    "build_hypothesis_runtime_summary",
    "build_live_submission_gate_payload",
    "build_shadow_first_toggle_parity",
    "build_submission_gate_market_context_status",
    "build_tca_gate_inputs",
    "compile_hypothesis_runtime_statuses",
    "critical_trading_toggle_snapshot",
    "load_hypothesis_registry",
    "load_quant_evidence_status",
    "resolve_active_capital_stage",
    "resolve_hypothesis_dependency_quorum",
    "resolve_quant_health_url",
    "urlopen",
]
