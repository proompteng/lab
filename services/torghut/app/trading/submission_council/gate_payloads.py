"""Payload assembly helpers for live submission gates."""

from __future__ import annotations

from typing import Any

from ..live_submit_activation import live_submit_activation_status


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
    "common_submission_payload",
]
