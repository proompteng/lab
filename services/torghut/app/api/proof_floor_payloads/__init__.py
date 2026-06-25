"""Explicit exports for Torghut proof floor payload helpers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from app.api.common import PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS
from app.api.proof_floor_payloads.route_repair_payloads import (
    build_freshness_carry_ledger_payload,
    build_repair_bid_settlement_payload,
    build_repair_outcome_dividend_ledger_payload,
    build_repair_receipt_frontier_payload,
    build_route_evidence_clearinghouse_payload,
    build_route_image_proof_summary,
    build_route_warrant_exchange_payload,
    build_source_serving_repair_receipt_payload,
)
from app.api.proof_floor_payloads.shared_context import (
    build_capital_reentry_cohort_ledger_payload,
    build_clock_settlement_payload,
    build_evidence_clock_payloads,
    build_profitability_proof_floor_receipt,
    build_profit_carry_passport_ledger_payload,
    build_profit_freshness_frontier_payload,
    build_profit_repair_settlement_ledger_payload,
    build_renewal_bond_profit_escrow_payload,
    build_route_reacquisition_board_payload,
    build_routeability_repair_acceptance_ledger_payload,
    consumer_evidence_jangar_continuity_packet,
)
from app.config import settings

from .build_jangar_reliability_settlement_ref import (
    build_autonomy_capital_replay_projection,
    build_capital_replay_projection_payload,
    build_profit_signal_quorum_payload,
    build_quality_adjusted_profit_frontier_payload,
    build_rejected_signal_outcome_learning_payload,
    load_rejected_signal_outcome_learning_summary,
    load_route_provenance_summary,
    route_continuity_packet_for_proof_floor,
    simple_lane_reject_reason_totals,
)
from .paper_route_probe_targets import bounded_paper_route_probe_target_symbols
from .status_refs import build_simple_lane_status_payload


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
        simple_lane_status=simple_lane_status or build_simple_lane_status_payload(),
        paper_route_probe_target_symbols=bounded_paper_route_probe_target_symbols(
            live_submission_gate
        ),
        tca_max_age_seconds=PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


__all__ = (
    "load_rejected_signal_outcome_learning_summary",
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
