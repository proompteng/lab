"""Explicit exports for Torghut proof floor payloads helpers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from . import shared_context as _proof_floor
from . import build_jangar_reliability_settlement_ref as _proof_refs
from .paper_route_probe_targets import bounded_paper_route_probe_target_symbols

_IMPLEMENTATION_MODULES: tuple[object, ...] = (
    _proof_floor,
    _proof_refs,
)
_build_simple_lane_status_payload: Any = getattr(
    _proof_floor, "_build_simple_lane_status_payload"
)


def _build_profitability_proof_floor_payload(
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
    return _proof_floor.build_profitability_proof_floor_receipt(
        account_label=_proof_floor.settings.trading_account_label,
        torghut_revision=torghut_revision,
        trading_mode=_proof_floor.settings.trading_mode,
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
        paper_route_probe_target_symbols=bounded_paper_route_probe_target_symbols(
            live_submission_gate
        ),
        tca_max_age_seconds=_proof_floor.PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


_build_renewal_bond_profit_escrow_payload: Any = getattr(
    _proof_floor, "_build_renewal_bond_profit_escrow_payload"
)
_build_route_reacquisition_board_payload: Any = getattr(
    _proof_floor, "_build_route_reacquisition_board_payload"
)
_build_jangar_contract_graduation_ref: Any = getattr(
    _proof_floor, "_build_jangar_contract_graduation_ref"
)
_build_jangar_material_verdict_ref: Any = getattr(
    _proof_floor, "_build_jangar_material_verdict_ref"
)
_build_jangar_execution_trust_admission_ref: Any = getattr(
    _proof_floor, "_build_jangar_execution_trust_admission_ref"
)
_consumer_evidence_jangar_continuity_packet: Any = getattr(
    _proof_floor, "_consumer_evidence_jangar_continuity_packet"
)
_build_capital_replay_projection_payload: Any = getattr(
    _proof_refs, "_build_capital_replay_projection_payload"
)
_build_profit_carry_passport_ledger_payload: Any = getattr(
    _proof_floor, "_build_profit_carry_passport_ledger_payload"
)
_build_capital_reentry_cohort_ledger_payload: Any = getattr(
    _proof_floor, "_build_capital_reentry_cohort_ledger_payload"
)
_build_profit_repair_settlement_ledger_payload: Any = getattr(
    _proof_floor, "_build_profit_repair_settlement_ledger_payload"
)
_build_profit_freshness_frontier_payload: Any = getattr(
    _proof_floor, "_build_profit_freshness_frontier_payload"
)
_build_routeability_repair_acceptance_ledger_payload: Any = getattr(
    _proof_floor, "_build_routeability_repair_acceptance_ledger_payload"
)
_build_evidence_clock_payloads: Any = getattr(
    _proof_floor, "_build_evidence_clock_payloads"
)
_build_clock_settlement_payload: Any = getattr(
    _proof_floor, "_build_clock_settlement_payload"
)
_build_route_image_proof_summary: Any = getattr(
    _proof_floor, "_build_route_image_proof_summary"
)
_build_route_evidence_clearinghouse_payload: Any = getattr(
    _proof_floor, "_build_route_evidence_clearinghouse_payload"
)
_build_repair_bid_settlement_payload: Any = getattr(
    _proof_floor, "_build_repair_bid_settlement_payload"
)
_build_route_warrant_exchange_payload: Any = getattr(
    _proof_floor, "_build_route_warrant_exchange_payload"
)
_build_source_serving_repair_receipt_payload: Any = getattr(
    _proof_floor, "_build_source_serving_repair_receipt_payload"
)
_build_freshness_carry_ledger_payload: Any = getattr(
    _proof_floor, "_build_freshness_carry_ledger_payload"
)
_build_repair_receipt_frontier_payload: Any = getattr(
    _proof_floor, "_build_repair_receipt_frontier_payload"
)
_build_repair_outcome_dividend_ledger_payload: Any = getattr(
    _proof_floor, "_build_repair_outcome_dividend_ledger_payload"
)
_build_jangar_reliability_settlement_ref: Any = getattr(
    _proof_refs, "_build_jangar_reliability_settlement_ref"
)
_build_torghut_routeability_admission_ref: Any = getattr(
    _proof_refs, "_build_torghut_routeability_admission_ref"
)
_build_torghut_stage_clearance_packet_ref: Any = getattr(
    _proof_refs, "_build_torghut_stage_clearance_packet_ref"
)
_build_profit_signal_quorum_payload: Any = getattr(
    _proof_refs, "_build_profit_signal_quorum_payload"
)
_simulation_cache_status_payload: Any = getattr(
    _proof_refs, "_simulation_cache_status_payload"
)
_build_quality_adjusted_profit_frontier_payload: Any = getattr(
    _proof_refs, "_build_quality_adjusted_profit_frontier_payload"
)
_build_autonomy_capital_replay_projection: Any = getattr(
    _proof_refs, "_build_autonomy_capital_replay_projection"
)
_route_continuity_packet_for_proof_floor: Any = getattr(
    _proof_refs, "_route_continuity_packet_for_proof_floor"
)
_simple_lane_reject_reason_totals: Any = getattr(
    _proof_refs, "_simple_lane_reject_reason_totals"
)
_build_rejected_signal_outcome_learning_payload: Any = getattr(
    _proof_refs, "_build_rejected_signal_outcome_learning_payload"
)
_load_rejected_signal_outcome_learning_summary: Any = getattr(
    _proof_refs, "_load_rejected_signal_outcome_learning_summary"
)
_load_route_provenance_summary: Any = getattr(
    _proof_refs, "_load_route_provenance_summary"
)
load_rejected_signal_outcome_learning_summary = (
    _load_rejected_signal_outcome_learning_summary
)
build_profitability_proof_floor_payload = _build_profitability_proof_floor_payload
build_renewal_bond_profit_escrow_payload = _build_renewal_bond_profit_escrow_payload
build_route_reacquisition_board_payload = _build_route_reacquisition_board_payload
consumer_evidence_jangar_continuity_packet = _consumer_evidence_jangar_continuity_packet
build_capital_replay_projection_payload = _build_capital_replay_projection_payload
build_profit_carry_passport_ledger_payload = _build_profit_carry_passport_ledger_payload
build_capital_reentry_cohort_ledger_payload = (
    _build_capital_reentry_cohort_ledger_payload
)
build_profit_repair_settlement_ledger_payload = (
    _build_profit_repair_settlement_ledger_payload
)
build_profit_freshness_frontier_payload = _build_profit_freshness_frontier_payload
build_routeability_repair_acceptance_ledger_payload = (
    _build_routeability_repair_acceptance_ledger_payload
)
build_evidence_clock_payloads = _build_evidence_clock_payloads
build_clock_settlement_payload = _build_clock_settlement_payload
build_route_image_proof_summary = _build_route_image_proof_summary
build_route_evidence_clearinghouse_payload = _build_route_evidence_clearinghouse_payload
build_repair_bid_settlement_payload = _build_repair_bid_settlement_payload
build_route_warrant_exchange_payload = _build_route_warrant_exchange_payload
build_source_serving_repair_receipt_payload = (
    _build_source_serving_repair_receipt_payload
)
build_freshness_carry_ledger_payload = _build_freshness_carry_ledger_payload
build_repair_receipt_frontier_payload = _build_repair_receipt_frontier_payload
build_repair_outcome_dividend_ledger_payload = (
    _build_repair_outcome_dividend_ledger_payload
)
build_profit_signal_quorum_payload = _build_profit_signal_quorum_payload
build_quality_adjusted_profit_frontier_payload = (
    _build_quality_adjusted_profit_frontier_payload
)
build_autonomy_capital_replay_projection = _build_autonomy_capital_replay_projection
route_continuity_packet_for_proof_floor = _route_continuity_packet_for_proof_floor
simple_lane_reject_reason_totals = _simple_lane_reject_reason_totals
build_rejected_signal_outcome_learning_payload = (
    _build_rejected_signal_outcome_learning_payload
)
load_route_provenance_summary = _load_route_provenance_summary

__all__ = (
    "_build_profitability_proof_floor_payload",
    "_build_renewal_bond_profit_escrow_payload",
    "_build_route_reacquisition_board_payload",
    "_build_jangar_contract_graduation_ref",
    "_build_jangar_material_verdict_ref",
    "_build_jangar_execution_trust_admission_ref",
    "_consumer_evidence_jangar_continuity_packet",
    "_build_capital_replay_projection_payload",
    "_build_profit_carry_passport_ledger_payload",
    "_build_capital_reentry_cohort_ledger_payload",
    "_build_profit_repair_settlement_ledger_payload",
    "_build_profit_freshness_frontier_payload",
    "_build_routeability_repair_acceptance_ledger_payload",
    "_build_evidence_clock_payloads",
    "_build_clock_settlement_payload",
    "_build_route_image_proof_summary",
    "_build_route_evidence_clearinghouse_payload",
    "_build_repair_bid_settlement_payload",
    "_build_route_warrant_exchange_payload",
    "_build_source_serving_repair_receipt_payload",
    "_build_freshness_carry_ledger_payload",
    "_build_repair_receipt_frontier_payload",
    "_build_repair_outcome_dividend_ledger_payload",
    "_build_jangar_reliability_settlement_ref",
    "_build_torghut_routeability_admission_ref",
    "_build_torghut_stage_clearance_packet_ref",
    "_build_profit_signal_quorum_payload",
    "_simulation_cache_status_payload",
    "_build_quality_adjusted_profit_frontier_payload",
    "_build_autonomy_capital_replay_projection",
    "_route_continuity_packet_for_proof_floor",
    "_simple_lane_reject_reason_totals",
    "_build_rejected_signal_outcome_learning_payload",
    "_load_rejected_signal_outcome_learning_summary",
    "load_rejected_signal_outcome_learning_summary",
    "_load_route_provenance_summary",
    "build_profitability_proof_floor_payload",
    "build_renewal_bond_profit_escrow_payload",
    "build_route_reacquisition_board_payload",
    "consumer_evidence_jangar_continuity_packet",
    "build_capital_replay_projection_payload",
    "build_profit_carry_passport_ledger_payload",
    "build_capital_reentry_cohort_ledger_payload",
    "build_profit_repair_settlement_ledger_payload",
    "build_profit_freshness_frontier_payload",
    "build_routeability_repair_acceptance_ledger_payload",
    "build_evidence_clock_payloads",
    "build_clock_settlement_payload",
    "build_route_image_proof_summary",
    "build_route_evidence_clearinghouse_payload",
    "build_repair_bid_settlement_payload",
    "build_route_warrant_exchange_payload",
    "build_source_serving_repair_receipt_payload",
    "build_freshness_carry_ledger_payload",
    "build_repair_receipt_frontier_payload",
    "build_repair_outcome_dividend_ledger_payload",
    "build_profit_signal_quorum_payload",
    "build_quality_adjusted_profit_frontier_payload",
    "build_autonomy_capital_replay_projection",
    "route_continuity_packet_for_proof_floor",
    "simple_lane_reject_reason_totals",
    "build_rejected_signal_outcome_learning_payload",
    "load_route_provenance_summary",
)
