"""Payload assembly helpers for live submission gates."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .common import (
    normalize_reason_codes,
    safe_decimal,
    safe_int,
    settings,
)
from ..live_submit_activation import live_submit_activation_status


_BOUNDED_LIVE_PAPER_COLLECTION_COMPATIBLE_BLOCKERS = frozenset(
    {
        "alpha_hypothesis_not_promotion_eligible",
        "alpha_hypothesis_shadow_only",
        "alpha_readiness_not_promotion_eligible",
        "bounded_paper_route_evidence_collection_only",
        "hypothesis_window_evidence_missing",
        "live_runtime_ledger_required",
        "paper_probation_evidence_collection_only",
        "paper_route_runtime_ledger_import_pending",
        "promotion_certificate_missing",
        "runtime_ledger_profit_target_source_collection_pending",
        "runtime_ledger_source_collection_only",
        "runtime_ledger_source_collection_pending",
        "runtime_ledger_source_window_evidence_pending",
    }
)


def common_submission_payload(context: Any) -> dict[str, object]:
    return {
        "configured_live_promotion": context.toggles.configured_live_promotion,
        "autonomy_promotion_eligible": context.toggles.autonomy_promotion_eligible,
        "autonomy_promotion_action": context.toggles.autonomy_promotion_action,
        "drift_live_promotion_eligible": context.toggles.drift_live_promotion_eligible,
        "promotion_eligible_total": context.totals.promotion_eligible_total,
        "paper_probation_eligible_total": context.totals.paper_probation_eligible_total,
        "dependency_quorum_decision": context.dependencies.decision,
        **context.dependencies.runtime_window_import_health_gate,
        "empirical_jobs_ready": context.dependencies.empirical_ready,
        "dspy_live_ready": context.dependencies.dspy_live_ready,
        "critical_toggle_parity": context.toggles.critical_toggle_parity,
        "critical_toggle_parity_blocking_mismatches": (
            context.toggles.blocking_toggle_mismatches
        ),
        "active_capital_stage": context.totals.active_capital_stage,
        "quant_evidence": context.quant.evidence,
        "quant_health_ref": _quant_health_ref(context),
        "market_context_ref": context.market_context_ref,
        "live_submit_activation": live_submit_activation_status(now=context.now),
        **_runtime_ledger_payload(context.runtime_inputs.runtime_ledger),
        "profit_lease_projection": context.profit_lease_projection,
    }


def bounded_live_paper_collection_gate_payload(
    context: Any,
    *,
    blocked_reasons: Sequence[str],
) -> dict[str, object]:
    runtime_ledger = context.runtime_inputs.runtime_ledger
    import_plan = runtime_ledger.paper_probation_import_plan
    source_collection_target_count = max(
        len(runtime_ledger.source_collection_candidates),
        safe_int(import_plan.get("source_collection_target_count")),
        safe_int(import_plan.get("manifest_bounded_collection_target_count")),
        safe_int(import_plan.get("configured_bounded_collection_target_count")),
    )
    profit_target_count = max(
        len(runtime_ledger.source_collection_profit_target_candidates),
        safe_int(import_plan.get("source_collection_profit_target_count")),
    )
    max_notional = safe_decimal(settings.trading_simple_paper_route_probe_max_notional)
    activation = live_submit_activation_status(now=context.now)
    hard_blockers = [
        reason
        for reason in blocked_reasons
        if reason not in _BOUNDED_LIVE_PAPER_COLLECTION_COMPATIBLE_BLOCKERS
    ]
    blockers: list[str] = []
    if not settings.trading_simple_paper_route_probe_enabled:
        blockers.append("paper_route_probe_disabled")
    if not settings.trading_simple_paper_route_probe_allow_live_mode:
        blockers.append("live_paper_route_probe_collection_disabled")
    if not settings.trading_simple_submit_enabled:
        blockers.append("simple_submit_disabled")
    if activation.get("configured") is True:
        if activation.get("valid") is not True:
            blockers.append(
                str(activation.get("reason") or "live_submit_activation_invalid")
            )
        elif activation.get("expired") is True:
            blockers.append(
                str(activation.get("reason") or "live_submit_activation_expired")
            )
    if max_notional is None or max_notional <= 0:
        blockers.append("paper_route_probe_notional_not_configured")
    if source_collection_target_count <= 0:
        blockers.append("source_collection_target_missing")
    blockers.extend(hard_blockers)
    normalized_blockers = normalize_reason_codes(blockers)
    allowed = not normalized_blockers
    market_session_open = getattr(context.state, "market_session_open", None)
    active = allowed and market_session_open is True
    if normalized_blockers:
        reason = normalized_blockers[0]
    elif active:
        reason = "bounded_live_paper_collection_ready"
    else:
        reason = "bounded_live_paper_collection_waiting_for_session"
    return {
        "schema_version": "torghut.bounded-live-paper-collection-gate.v1",
        "allowed": allowed,
        "active": active,
        "reason": reason,
        "blocked_reasons": normalized_blockers,
        "authority_scope": "bounded_evidence_collection_only",
        "capital_promotion_allowed": False,
        "final_authority_ok": False,
        "capital_gate_allowed": False,
        "capital_gate_blocked_reasons": list(blocked_reasons),
        "collection_only_blockers": [
            reason
            for reason in blocked_reasons
            if reason in _BOUNDED_LIVE_PAPER_COLLECTION_COMPATIBLE_BLOCKERS
        ],
        "hard_blockers": hard_blockers,
        "source_collection_target_count": source_collection_target_count,
        "source_collection_profit_target_count": profit_target_count,
        "paper_route_probe_enabled": settings.trading_simple_paper_route_probe_enabled,
        "paper_route_probe_allow_live_mode": (
            settings.trading_simple_paper_route_probe_allow_live_mode
        ),
        "simple_submit_enabled": settings.trading_simple_submit_enabled,
        "paper_route_probe_max_notional": str(max_notional or 0),
        "live_submit_activation": activation,
        "market_session_open": market_session_open,
    }


def _quant_health_ref(context: Any) -> dict[str, object]:
    return {
        "account": context.quant.evidence.get("account"),
        "window": context.quant.evidence.get("window"),
        "status": context.quant.evidence.get("status"),
        "source_url": context.quant.evidence.get("source_url"),
        "latest_metrics_updated_at": context.quant.evidence.get(
            "latest_metrics_updated_at"
        ),
    }


def _runtime_ledger_payload(runtime_ledger: Any) -> dict[str, object]:
    return {
        "runtime_ledger_repair_candidates": runtime_ledger.repair_candidates,
        "runtime_ledger_paper_probation_candidates": (
            runtime_ledger.paper_probation_candidates
        ),
        "runtime_ledger_source_collection_candidates": (
            runtime_ledger.source_collection_candidates
        ),
        "runtime_ledger_source_collection_candidate_total": len(
            runtime_ledger.source_collection_candidates
        ),
        "runtime_ledger_source_collection_profit_target_candidate_total": len(
            runtime_ledger.source_collection_profit_target_candidates
        ),
        "runtime_ledger_paper_probation_eligible_total": len(
            runtime_ledger.paper_probation_candidates
        ),
        "runtime_ledger_paper_probation_import_plan": (
            runtime_ledger.paper_probation_import_plan
        ),
    }


__all__ = [
    "bounded_live_paper_collection_gate_payload",
    "common_submission_payload",
]
