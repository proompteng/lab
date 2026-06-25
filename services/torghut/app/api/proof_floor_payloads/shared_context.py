"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from typing import Any

from ..common import (
    Execution,
    Mapping,
    PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    RejectedSignalOutcomeEvent,
    SQLAlchemyError,
    Sequence,
    Session,
    SessionLocal,
    TradingScheduler,
    SIMPLE_LANE_ALLOWED_REJECT_REASONS,
    build_capital_reentry_cohort_ledger,
    build_capital_replay_projection,
    build_clock_settlement_receipt,
    build_evidence_clock_arbiter_and_exchange,
    build_profit_carry_passport_ledger,
    build_profit_freshness_frontier,
    build_profit_repair_settlement_ledger,
    build_profit_signal_quorum,
    build_profitability_proof_floor_receipt,
    build_quality_adjusted_profit_frontier,
    build_renewal_bond_profit_escrow,
    build_route_reacquisition_board,
    build_routeability_repair_acceptance_ledger,
    cast,
    datetime,
    func,
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
    load_jangar_route_continuity_packet,
    load_quant_evidence_status,
    logger,
    resolve_hypothesis_dependency_quorum,
    select,
    settings,
    timedelta,
    timezone,
)

from ..common import main_runtime_value

from .status_refs import (
    build_jangar_reliability_settlement_ref_payload as _build_jangar_reliability_settlement_ref,
    build_simple_lane_status_payload as _build_simple_lane_status_payload,
    build_torghut_routeability_admission_ref as _build_torghut_routeability_admission_ref,
    build_torghut_stage_clearance_packet_ref_payload as _build_torghut_stage_clearance_packet_ref,
    route_continuity_packet_for_proof_floor as _route_continuity_packet_for_proof_floor,
)
from .route_repair_payloads import (
    build_freshness_carry_ledger_payload,
    build_repair_bid_settlement_payload,
    build_repair_outcome_dividend_ledger_payload,
    build_repair_receipt_frontier_payload,
    build_route_evidence_clearinghouse_payload,
    build_route_image_proof_summary,
    build_route_warrant_exchange_payload,
    build_source_serving_repair_receipt_payload,
)


def build_profitability_proof_floor_payload(
    *,
    state: object,
    torghut_revision: str | None,
    live_submission_gate: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_profitability_proof_floor_receipt(
        account_label=settings.trading_account_label,
        torghut_revision=torghut_revision,
        trading_mode=settings.trading_mode,
        market_session_open=cast(
            bool | None,
            getattr(state, "market_session_open", None),
        ),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        simple_lane_status=simple_lane_status or _build_simple_lane_status_payload(),
        tca_max_age_seconds=PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


def build_renewal_bond_profit_escrow_payload(
    *,
    state: object,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
) -> dict[str, object]:
    return build_renewal_bond_profit_escrow(
        account_label=settings.trading_account_label,
        torghut_revision=torghut_revision,
        trading_mode=settings.trading_mode,
        market_session_open=cast(
            bool | None,
            getattr(state, "market_session_open", None),
        ),
        jangar_dependency_quorum=dependency_quorum,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        tca_max_age_seconds=PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


def build_route_reacquisition_board_payload(
    *,
    proof_floor: Mapping[str, Any],
    active_revision: str | None,
) -> dict[str, object]:
    return build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        route_reacquisition_book=cast(
            Mapping[str, Any] | None,
            proof_floor.get("route_reacquisition_book"),
        ),
        active_revision=active_revision,
        jangar_continuity=_route_continuity_packet_for_proof_floor(proof_floor),
    )


def build_jangar_contract_graduation_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    reasons = [
        str(item).strip()
        for item in cast(Sequence[object], dependency_quorum.get("reasons") or [])
        if str(item).strip()
    ]
    return {
        "contract_ref": "docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md",
        "state": "current" if decision == "allow" else "missing",
        "decision": decision,
        "reasons": reasons,
        "generated_at": dependency_quorum.get("generated_at"),
    }


def build_jangar_material_verdict_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    raw_reasons: object = dependency_quorum.get("reasons")
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "verdict_ref": f"jangar-material-verdict:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "action_classes": ["paper_canary", "live_micro_canary", "live_scale"],
        "generated_at": dependency_quorum.get("generated_at"),
    }


def build_jangar_execution_trust_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_execution_trust = dependency_quorum.get("execution_trust")
    empty_execution_trust: Mapping[str, Any] = {}
    execution_trust: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_execution_trust)
        if isinstance(raw_execution_trust, Mapping)
        else empty_execution_trust
    )
    decision = (
        str(
            execution_trust.get("decision")
            or execution_trust.get("state")
            or dependency_quorum.get("decision")
            or "unknown"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            execution_trust.get("state")
            or execution_trust.get("status")
            or ("current" if decision == "allow" else "degraded")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        execution_trust.get("reason_codes")
        or execution_trust.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "admission_ref": f"jangar-execution-trust:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "generated_at": execution_trust.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": execution_trust.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def consumer_evidence_jangar_continuity_packet(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    material_ref = build_jangar_material_verdict_ref(dependency_quorum)
    decision = str(material_ref.get("decision") or "unknown")
    allow = decision == "allow"
    return {
        "epoch_id": material_ref["verdict_ref"],
        "state": "present" if allow else "missing",
        "decision": "allow" if allow else "hold",
        "fresh_until": dependency_quorum.get("fresh_until"),
        "blocking_reasons": [] if allow else [f"jangar_material_verdict_{decision}"],
        "action_class": "paper_canary",
    }


def build_capital_replay_projection_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_replay_projection(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        jangar_contract_graduation_ref=build_jangar_contract_graduation_ref(
            dependency_quorum
        ),
    )


def build_profit_carry_passport_ledger_payload(
    *,
    torghut_revision: str | None,
    capital_replay_board: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    repair_outcome_dividend_ledger: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_carry_passport_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        capital_replay_board=capital_replay_board,
        route_reacquisition_board=route_reacquisition_board,
        proof_floor=proof_floor,
        market_context_status=market_context_status,
        hypothesis_payload=hypothesis_payload,
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
    )


def build_capital_reentry_cohort_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_reentry_cohort_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        jangar_material_verdict_ref=build_jangar_material_verdict_ref(
            dependency_quorum
        ),
    )


def build_profit_repair_settlement_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_repair_settlement_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        jangar_execution_trust_admission_ref=build_jangar_execution_trust_admission_ref(
            dependency_quorum
        ),
    )


def build_profit_freshness_frontier_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_freshness_frontier(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        proof_window=settings.trading_jangar_quant_window,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs_status,
        hypothesis_payload=hypothesis_payload,
        jangar_reliability_settlement_ref=_build_jangar_reliability_settlement_ref(
            dependency_quorum
        ),
    )


def build_routeability_repair_acceptance_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    profit_repair_settlement_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_routeability_repair_acceptance_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        revenue_repair_digest_ref="/trading/revenue-repair",
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        torghut_routeability_admission_ref=_build_torghut_routeability_admission_ref(
            dependency_quorum
        ),
    )


def build_evidence_clock_payloads(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    build: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
) -> tuple[dict[str, object], dict[str, object]]:
    return build_evidence_clock_arbiter_and_exchange(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        build=build,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor_receipt=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_signal_quorum=profit_signal_quorum,
        live_submission_gate=live_submission_gate,
        torghut_custody_ref=_build_torghut_stage_clearance_packet_ref(
            dependency_quorum
        ),
        clickhouse_ta_status=clickhouse_ta_status,
    )


def build_clock_settlement_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    rollout_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_clock_settlement_receipt(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=rollout_status,
    )


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Execution",
    "Mapping",
    "RejectedSignalOutcomeEvent",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "SQLAlchemyError",
    "Sequence",
    "Session",
    "SessionLocal",
    "TradingScheduler",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "build_capital_reentry_cohort_ledger_payload",
    "build_capital_replay_projection_payload",
    "build_clock_settlement_payload",
    "build_evidence_clock_payloads",
    "build_freshness_carry_ledger_payload",
    "build_jangar_contract_graduation_ref",
    "build_profit_carry_passport_ledger_payload",
    "build_profit_freshness_frontier_payload",
    "build_profit_repair_settlement_ledger_payload",
    "build_profitability_proof_floor_payload",
    "build_renewal_bond_profit_escrow_payload",
    "build_repair_bid_settlement_payload",
    "build_repair_outcome_dividend_ledger_payload",
    "build_repair_receipt_frontier_payload",
    "build_route_evidence_clearinghouse_payload",
    "build_route_image_proof_summary",
    "build_route_reacquisition_board_payload",
    "build_route_warrant_exchange_payload",
    "build_routeability_repair_acceptance_ledger_payload",
    "build_source_serving_repair_receipt_payload",
    "consumer_evidence_jangar_continuity_packet",
    "build_capital_reentry_cohort_ledger_payload",
    "build_capital_replay_projection",
    "build_capital_replay_projection_payload",
    "build_clock_settlement_payload",
    "build_evidence_clock_payloads",
    "build_freshness_carry_ledger_payload",
    "build_jangar_contract_graduation_ref",
    "build_profit_carry_passport_ledger_payload",
    "build_profit_freshness_frontier_payload",
    "build_profit_repair_settlement_ledger_payload",
    "build_profit_signal_quorum",
    "build_profitability_proof_floor_payload",
    "build_quality_adjusted_profit_frontier",
    "build_renewal_bond_profit_escrow_payload",
    "build_repair_bid_settlement_payload",
    "build_repair_outcome_dividend_ledger_payload",
    "build_repair_receipt_frontier_payload",
    "build_route_evidence_clearinghouse_payload",
    "build_route_image_proof_summary",
    "build_route_reacquisition_board_payload",
    "build_route_warrant_exchange_payload",
    "build_routeability_repair_acceptance_ledger_payload",
    "build_source_serving_repair_receipt_payload",
    "cast",
    "consumer_evidence_jangar_continuity_packet",
    "datetime",
    "func",
    "hypothesis_registry_requires_dependency_capability",
    "load_hypothesis_registry",
    "load_jangar_route_continuity_packet",
    "load_quant_evidence_status",
    "logger",
    "main_runtime_value",
    "resolve_hypothesis_dependency_quorum",
    "select",
    "settings",
    "timedelta",
    "timezone",
)
