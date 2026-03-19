"""Shared live-submission gate helpers for status and runtime paths."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from sqlalchemy.orm import Session

from ..config import settings
from .hypotheses import (
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)
from .tca import build_tca_gate_inputs

_CAPITAL_STAGE_ORDER = (
    "shadow",
    "0.10x canary",
    "0.25x canary",
    "0.50x live",
    "1.00x live",
)
_LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES = frozenset(
    {
        "TRADING_ENABLED",
        "TRADING_KILL_SWITCH_ENABLED",
        "TRADING_MODE",
    }
)


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def critical_trading_toggle_snapshot() -> dict[str, object]:
    return {
        "TRADING_ENABLED": settings.trading_enabled,
        "TRADING_AUTONOMY_ENABLED": settings.trading_autonomy_enabled,
        "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION": settings.trading_autonomy_allow_live_promotion,
        "TRADING_KILL_SWITCH_ENABLED": settings.trading_kill_switch_enabled,
        "TRADING_MODE": settings.trading_mode,
        "TRADING_EXECUTION_ADAPTER_POLICY": settings.trading_execution_adapter_policy,
    }


def build_shadow_first_toggle_parity() -> dict[str, object]:
    expected = {
        "TRADING_ENABLED": True,
        "TRADING_AUTONOMY_ENABLED": False,
        "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION": False,
        "TRADING_KILL_SWITCH_ENABLED": False,
        "TRADING_MODE": "live",
    }
    effective = critical_trading_toggle_snapshot()
    mismatches = [
        key
        for key, expected_value in expected.items()
        if effective.get(key) != expected_value
    ]
    return {
        "status": "aligned" if not mismatches else "diverged",
        "mismatches": mismatches,
        "expected": expected,
        "effective": effective,
    }


def resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    if not isinstance(hypothesis_summary, Mapping):
        return None
    totals_raw = hypothesis_summary.get("capital_stage_totals")
    if not isinstance(totals_raw, Mapping):
        return None
    totals = cast(Mapping[str, Any], totals_raw)
    for stage in reversed(_CAPITAL_STAGE_ORDER):
        count = totals.get(stage)
        if isinstance(count, int) and count > 0:
            return stage
    return "shadow" if totals else None


def build_hypothesis_runtime_summary(
    session: Session,
    *,
    state: object,
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    registry = load_hypothesis_registry()
    dependency_quorum = load_jangar_dependency_quorum()
    items = compile_hypothesis_runtime_statuses(
        registry=registry,
        state=state,
        tca_summary=build_tca_gate_inputs(session=session),
        market_context_status=market_context_status,
        jangar_dependency_quorum=dependency_quorum,
    )
    return summarize_hypothesis_runtime_statuses(
        items,
        registry=registry,
        dependency_quorum=dependency_quorum,
    )


def build_submission_gate_market_context_status(state: object) -> dict[str, object]:
    return {
        "last_freshness_seconds": getattr(
            state, "last_market_context_freshness_seconds", None
        ),
    }


def build_live_submission_gate_payload(
    state: object,
    *,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    summary: Mapping[str, Any] = hypothesis_summary or {}
    dependency_quorum_payload: dict[str, Any] = (
        dict(cast(Mapping[str, Any], summary.get("dependency_quorum")))
        if isinstance(summary.get("dependency_quorum"), Mapping)
        else {}
    )
    dependency_decision = (
        str(dependency_quorum_payload.get("decision") or "").strip().lower() or "unknown"
    )
    promotion_eligible_total = _safe_int(summary.get("promotion_eligible_total"))
    empirical_ready = (
        bool(empirical_jobs_status.get("ready"))
        if isinstance(empirical_jobs_status, Mapping)
        else None
    )
    dspy_mode = (
        str(dspy_runtime_status.get("mode") or "").strip().lower()
        if isinstance(dspy_runtime_status, Mapping)
        else ""
    )
    dspy_live_ready = (
        bool(dspy_runtime_status.get("live_ready"))
        if isinstance(dspy_runtime_status, Mapping) and dspy_mode == "active"
        else None
    )
    configured_live_promotion = bool(settings.trading_autonomy_allow_live_promotion)
    autonomy_promotion_eligible = bool(
        getattr(state, "last_autonomy_promotion_eligible", False)
    )
    autonomy_promotion_action = getattr(state, "last_autonomy_promotion_action", None)
    drift_live_promotion_eligible = bool(
        getattr(state, "drift_live_promotion_eligible", False)
    )
    active_capital_stage = resolve_active_capital_stage(summary)
    critical_toggle_parity = build_shadow_first_toggle_parity()
    critical_toggle_mismatches = list(
        cast(list[str], critical_toggle_parity.get("mismatches") or [])
    )
    blocking_toggle_mismatches = [
        mismatch
        for mismatch in critical_toggle_mismatches
        if mismatch in _LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES
    ]
    if settings.trading_mode != "live":
        return {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": settings.trading_mode,
            "configured_live_promotion": configured_live_promotion,
            "autonomy_promotion_eligible": autonomy_promotion_eligible,
            "autonomy_promotion_action": autonomy_promotion_action,
            "drift_live_promotion_eligible": drift_live_promotion_eligible,
            "promotion_eligible_total": promotion_eligible_total,
            "dependency_quorum_decision": dependency_decision,
            "empirical_jobs_ready": empirical_ready,
            "dspy_live_ready": dspy_live_ready,
            "critical_toggle_parity": critical_toggle_parity,
            "critical_toggle_parity_blocking_mismatches": blocking_toggle_mismatches,
            "active_capital_stage": active_capital_stage,
        }

    blocked_reasons: list[str] = []
    if blocking_toggle_mismatches:
        blocked_reasons.append("critical_toggle_parity_diverged")
    if promotion_eligible_total <= 0:
        blocked_reasons.append("alpha_readiness_not_promotion_eligible")
    if empirical_ready is False:
        blocked_reasons.append("empirical_jobs_not_ready")
    if dspy_live_ready is False:
        blocked_reasons.append("dspy_live_runtime_not_ready")
    if dependency_decision != "allow":
        blocked_reasons.append(f"dependency_quorum_{dependency_decision}")
    if (
        not configured_live_promotion
        and not autonomy_promotion_eligible
        and not drift_live_promotion_eligible
    ):
        blocked_reasons.append("live_promotion_disabled")

    allowed = len(blocked_reasons) == 0
    if allowed and active_capital_stage == "shadow":
        active_capital_stage = "0.10x canary"
    allowed_reason = "ready"
    if configured_live_promotion:
        allowed_reason = "configured_live_promotion"
    elif autonomy_promotion_eligible:
        allowed_reason = "autonomy_promotion_eligible"
    elif drift_live_promotion_eligible:
        allowed_reason = "drift_live_promotion_eligible"

    return {
        "allowed": allowed,
        "reason": allowed_reason if allowed else blocked_reasons[0],
        "blocked_reasons": blocked_reasons,
        "capital_stage": active_capital_stage,
        "configured_live_promotion": configured_live_promotion,
        "autonomy_promotion_eligible": autonomy_promotion_eligible,
        "autonomy_promotion_action": autonomy_promotion_action,
        "drift_live_promotion_eligible": drift_live_promotion_eligible,
        "promotion_eligible_total": promotion_eligible_total,
        "dependency_quorum_decision": dependency_decision,
        "empirical_jobs_ready": empirical_ready,
        "dspy_live_ready": dspy_live_ready,
        "critical_toggle_parity": critical_toggle_parity,
        "critical_toggle_parity_blocking_mismatches": blocking_toggle_mismatches,
        "active_capital_stage": active_capital_stage,
    }
