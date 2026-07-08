"""Payload assembly helpers for live submission gates."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Protocol, cast

from ..live_submit_activation import live_submit_activation_status


class _TogglePayloadContext(Protocol):
    configured_live_promotion: object
    autonomy_promotion_eligible: object
    autonomy_promotion_action: object
    drift_live_promotion_eligible: object
    critical_toggle_parity: object
    blocking_toggle_mismatches: object


class _TotalsPayloadContext(Protocol):
    promotion_eligible_total: object
    paper_probation_eligible_total: object
    active_capital_stage: object


class _DependencyPayloadContext(Protocol):
    decision: object
    runtime_window_import_health_gate: Mapping[str, object]
    empirical_ready: object
    dspy_live_ready: object
    clickhouse_ta_status: Mapping[str, object]


class _QuantPayloadContext(Protocol):
    evidence: Mapping[str, object]


class _RuntimeLedgerPayloadContext(Protocol):
    repair_candidates: Sequence[object]
    paper_probation_candidates: Sequence[object]
    source_collection_candidates: Sequence[object]
    source_collection_profit_target_candidates: Sequence[object]
    paper_probation_import_plan: object


class _RuntimeInputsPayloadContext(Protocol):
    runtime_ledger: _RuntimeLedgerPayloadContext


class _SubmissionPayloadContext(Protocol):
    toggles: _TogglePayloadContext
    totals: _TotalsPayloadContext
    dependencies: _DependencyPayloadContext
    quant: _QuantPayloadContext
    market_context_ref: object
    now: datetime | None
    runtime_inputs: _RuntimeInputsPayloadContext
    profit_lease_projection: object


def common_submission_payload(context: object) -> dict[str, object]:
    payload_context = cast(_SubmissionPayloadContext, context)
    return {
        "configured_live_promotion": payload_context.toggles.configured_live_promotion,
        "autonomy_promotion_eligible": (
            payload_context.toggles.autonomy_promotion_eligible
        ),
        "autonomy_promotion_action": payload_context.toggles.autonomy_promotion_action,
        "drift_live_promotion_eligible": (
            payload_context.toggles.drift_live_promotion_eligible
        ),
        "promotion_eligible_total": payload_context.totals.promotion_eligible_total,
        "paper_probation_eligible_total": (
            payload_context.totals.paper_probation_eligible_total
        ),
        "dependency_quorum_decision": payload_context.dependencies.decision,
        **payload_context.dependencies.runtime_window_import_health_gate,
        "empirical_jobs_ready": payload_context.dependencies.empirical_ready,
        "dspy_live_ready": payload_context.dependencies.dspy_live_ready,
        "critical_toggle_parity": payload_context.toggles.critical_toggle_parity,
        "critical_toggle_parity_blocking_mismatches": (
            payload_context.toggles.blocking_toggle_mismatches
        ),
        "active_capital_stage": payload_context.totals.active_capital_stage,
        "quant_evidence": payload_context.quant.evidence,
        "quant_health_ref": _quant_health_ref(payload_context),
        "market_context_ref": payload_context.market_context_ref,
        "clickhouse_ta_freshness": _clickhouse_ta_freshness_ref(payload_context),
        "live_submit_activation": live_submit_activation_status(
            now=payload_context.now
        ),
        **_runtime_ledger_payload(payload_context.runtime_inputs.runtime_ledger),
        "profit_lease_projection": payload_context.profit_lease_projection,
    }


def _quant_health_ref(context: _SubmissionPayloadContext) -> dict[str, object]:
    return {
        "account": context.quant.evidence.get("account"),
        "window": context.quant.evidence.get("window"),
        "status": context.quant.evidence.get("status"),
        "source_url": context.quant.evidence.get("source_url"),
        "latest_metrics_updated_at": context.quant.evidence.get(
            "latest_metrics_updated_at"
        ),
    }


def _clickhouse_ta_freshness_ref(
    context: _SubmissionPayloadContext,
) -> dict[str, object]:
    status = context.dependencies.clickhouse_ta_status
    return {
        "accepted_sources": status.get("accepted_sources"),
        "latest_accepted_event_at": status.get("latest_accepted_event_at"),
        "accepted_lag_seconds": status.get("accepted_lag_seconds"),
        "accepted_max_lag_seconds": status.get("accepted_max_lag_seconds"),
        "accepted_source_state": status.get("accepted_source_state"),
        "blocking_reason": status.get("blocking_reason"),
        "fresh_until": status.get("fresh_until"),
        "freshness_reason_codes": status.get("freshness_reason_codes") or [],
        "excluded_fresher_sources": status.get("excluded_fresher_sources") or [],
        "per_symbol_coverage": status.get("per_symbol_coverage") or [],
        "stale_symbol_coverage": status.get("stale_symbol_coverage") or [],
        "market_session_state": status.get("market_session_state"),
        "regular_session_open": status.get("regular_session_open"),
        "regular_session_open_at": status.get("regular_session_open_at"),
        "regular_session_close_at": status.get("regular_session_close_at"),
    }


def _runtime_ledger_payload(
    runtime_ledger: _RuntimeLedgerPayloadContext,
) -> dict[str, object]:
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
