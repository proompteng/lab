"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from fastapi import APIRouter

from app.db import SessionLocal
from app.trading.scheduler import TradingScheduler
from app.trading.simulation_progress import active_simulation_runtime_context
from app.trading.submission_authority import (
    build_submission_authority_status as _build_submission_authority_status,
)
from app.trading.submission_council import load_quant_evidence_status

from .application import get_app
from .health_checks import (
    budget_exhausted_live_submission_gate_payload,
    budget_exhausted_options_catalog_freshness_payload,
    build_api_live_submission_gate_payload,
    build_control_plane_contract,
    build_shadow_first_runtime_payload,
    build_simple_lane_status_payload,
    empirical_jobs_status,
    forecast_service_status,
    lean_authority_status,
    load_clickhouse_ta_status,
    load_last_decision_at,
    load_options_catalog_freshness_summary,
    route_claim_symbols,
)
from .proof_floor_payloads import (
    build_capital_reentry_cohort_ledger_payload as _build_capital_reentry_cohort_ledger_payload,
)
from .proof_floor_payloads import (
    build_capital_replay_projection_payload as _build_capital_replay_projection_payload,
)
from .proof_floor_payloads import (
    build_clock_settlement_payload as _build_clock_settlement_payload,
)
from .proof_floor_payloads import (
    build_evidence_clock_payloads as _build_evidence_clock_payloads,
)
from .proof_floor_payloads import (
    build_freshness_carry_ledger_payload as _build_freshness_carry_ledger_payload,
)
from .proof_floor_payloads import (
    build_profit_freshness_frontier_payload as _build_profit_freshness_frontier_payload,
)
from .proof_floor_payloads import (
    build_profit_repair_settlement_ledger_payload as _build_profit_repair_settlement_ledger_payload,
)
from .proof_floor_payloads import (
    build_profit_signal_quorum_payload as _build_profit_signal_quorum_payload,
)
from .proof_floor_payloads import (
    build_profitability_proof_floor_payload as _build_profitability_proof_floor_payload,
)
from .proof_floor_payloads import (
    build_quality_adjusted_profit_frontier_payload as _build_quality_adjusted_profit_frontier_payload,
)
from .proof_floor_payloads import (
    build_rejected_signal_outcome_learning_payload as _build_rejected_signal_outcome_learning_payload,
)
from .proof_floor_payloads import (
    build_renewal_bond_profit_escrow_payload as _build_renewal_bond_profit_escrow_payload,
)
from .proof_floor_payloads import (
    build_repair_bid_settlement_payload as _build_repair_bid_settlement_payload,
)
from .proof_floor_payloads import (
    build_repair_outcome_dividend_ledger_payload as _build_repair_outcome_dividend_ledger_payload,
)
from .proof_floor_payloads import (
    build_repair_receipt_frontier_payload as _build_repair_receipt_frontier_payload,
)
from .proof_floor_payloads import (
    build_route_evidence_clearinghouse_payload as _build_route_evidence_clearinghouse_payload,
)
from .proof_floor_payloads import (
    build_route_image_proof_summary as _build_route_image_proof_summary,
)
from .proof_floor_payloads import (
    build_route_reacquisition_board_payload as _build_route_reacquisition_board_payload,
)
from .proof_floor_payloads import (
    build_route_warrant_exchange_payload as _build_route_warrant_exchange_payload,
)
from .proof_floor_payloads import (
    build_routeability_repair_acceptance_ledger_payload as _build_routeability_repair_acceptance_ledger_payload,
)
from .proof_floor_payloads import (
    build_source_serving_repair_receipt_payload as _build_source_serving_repair_receipt_payload,
)
from .proof_floor_payloads import (
    load_rejected_signal_outcome_learning_summary,
)
from .status_helpers import (
    TradingStatusReadBudget,
    budget_unavailable_hypothesis_runtime_payload,
    budget_unavailable_llm_evaluation_payload,
    budget_unavailable_tca_summary_payload,
    deferred_hypothesis_payload_for_live_submission_gate,
    hypothesis_payload_read_model_unavailable,
    load_trading_status_hypothesis_runtime,
    load_trading_status_llm_evaluation,
    load_trading_status_runtime_ledger_portfolio_summary,
    load_trading_status_tca_summary,
    load_trading_status_tigerbeetle_ledger,
)
from .trading_misc import (
    build_consumer_evidence_receipt_projection as _build_consumer_evidence_receipt_projection,
)
from .trading_status_context import (
    TradingStatusContextDependencies,
    load_trading_status_context,
)
from .trading_status_sections import (
    TradingStatusSectionDependencies,
    load_trading_status_core_sections,
    load_trading_status_late_read_sections,
)
from .trading_status_response import (
    TradingStatusResponseBuild,
    TradingStatusResponseDependencies,
    build_trading_status_response,
)
from .vnext_helpers import build_autonomy_bridge_status as _build_autonomy_bridge_status

_TradingStatusReadBudget = TradingStatusReadBudget
_budget_exhausted_live_submission_gate_payload = (
    budget_exhausted_live_submission_gate_payload
)
_budget_exhausted_options_catalog_freshness_payload = (
    budget_exhausted_options_catalog_freshness_payload
)
_budget_unavailable_hypothesis_runtime_payload = (
    budget_unavailable_hypothesis_runtime_payload
)
_budget_unavailable_llm_evaluation_payload = budget_unavailable_llm_evaluation_payload
_budget_unavailable_tca_summary_payload = budget_unavailable_tca_summary_payload
_build_control_plane_contract = build_control_plane_contract
_build_live_submission_gate_payload = build_api_live_submission_gate_payload
_build_shadow_first_runtime_payload = build_shadow_first_runtime_payload
_build_simple_lane_status_payload = build_simple_lane_status_payload
_empirical_jobs_status = empirical_jobs_status
_forecast_service_status = forecast_service_status
_lean_authority_status = lean_authority_status
_load_clickhouse_ta_status = load_clickhouse_ta_status
_load_last_decision_at = load_last_decision_at
_load_options_catalog_freshness_summary = load_options_catalog_freshness_summary
_route_claim_symbols = route_claim_symbols
_deferred_hypothesis_payload_for_live_submission_gate = (
    deferred_hypothesis_payload_for_live_submission_gate
)
_hypothesis_payload_read_model_unavailable = hypothesis_payload_read_model_unavailable
_load_trading_status_hypothesis_runtime = load_trading_status_hypothesis_runtime
_load_trading_status_llm_evaluation = load_trading_status_llm_evaluation
_load_trading_status_runtime_ledger_portfolio_summary = (
    load_trading_status_runtime_ledger_portfolio_summary
)


_load_trading_status_tca_summary = load_trading_status_tca_summary
_load_trading_status_tigerbeetle_ledger = load_trading_status_tigerbeetle_ledger
_load_rejected_signal_outcome_learning_summary = (
    load_rejected_signal_outcome_learning_summary
)
router = APIRouter()


def _trading_status_context_dependencies() -> TradingStatusContextDependencies:
    return TradingStatusContextDependencies(
        get_app=get_app,
        scheduler_factory=TradingScheduler,
        active_simulation_runtime_context=active_simulation_runtime_context,
        empirical_jobs_status=_empirical_jobs_status,
        load_quant_evidence_status=load_quant_evidence_status,
        forecast_service_status=_forecast_service_status,
        lean_authority_status=_lean_authority_status,
    )


def _trading_status_section_dependencies() -> TradingStatusSectionDependencies:
    return TradingStatusSectionDependencies(
        session_factory=SessionLocal,
        budget_exhausted_live_submission_gate_payload=(
            _budget_exhausted_live_submission_gate_payload
        ),
        budget_exhausted_options_catalog_freshness_payload=(
            _budget_exhausted_options_catalog_freshness_payload
        ),
        budget_unavailable_hypothesis_runtime_payload=(
            _budget_unavailable_hypothesis_runtime_payload
        ),
        budget_unavailable_llm_evaluation_payload=(
            _budget_unavailable_llm_evaluation_payload
        ),
        budget_unavailable_tca_summary_payload=(
            _budget_unavailable_tca_summary_payload
        ),
        build_live_submission_gate_payload=_build_live_submission_gate_payload,
        deferred_hypothesis_payload_for_live_submission_gate=(
            _deferred_hypothesis_payload_for_live_submission_gate
        ),
        hypothesis_payload_read_model_unavailable=(
            _hypothesis_payload_read_model_unavailable
        ),
        load_clickhouse_ta_status=_load_clickhouse_ta_status,
        load_last_decision_at=_load_last_decision_at,
        load_options_catalog_freshness_summary=(
            _load_options_catalog_freshness_summary
        ),
        load_rejected_signal_outcome_learning_summary=(
            _load_rejected_signal_outcome_learning_summary
        ),
        load_trading_status_hypothesis_runtime=(
            _load_trading_status_hypothesis_runtime
        ),
        load_trading_status_llm_evaluation=_load_trading_status_llm_evaluation,
        load_trading_status_runtime_ledger_portfolio_summary=(
            _load_trading_status_runtime_ledger_portfolio_summary
        ),
        load_trading_status_tca_summary=_load_trading_status_tca_summary,
        load_trading_status_tigerbeetle_ledger=(
            _load_trading_status_tigerbeetle_ledger
        ),
    )


def _trading_status_response_dependencies() -> TradingStatusResponseDependencies:
    return TradingStatusResponseDependencies(
        build_autonomy_bridge_status=_build_autonomy_bridge_status,
        build_capital_reentry_cohort_ledger_payload=(
            _build_capital_reentry_cohort_ledger_payload
        ),
        build_capital_replay_projection_payload=(
            _build_capital_replay_projection_payload
        ),
        build_clock_settlement_payload=_build_clock_settlement_payload,
        build_consumer_evidence_receipt_projection=(
            _build_consumer_evidence_receipt_projection
        ),
        build_control_plane_contract=_build_control_plane_contract,
        build_evidence_clock_payloads=_build_evidence_clock_payloads,
        build_freshness_carry_ledger_payload=_build_freshness_carry_ledger_payload,
        build_profit_freshness_frontier_payload=(
            _build_profit_freshness_frontier_payload
        ),
        build_profit_repair_settlement_ledger_payload=(
            _build_profit_repair_settlement_ledger_payload
        ),
        build_profit_signal_quorum_payload=_build_profit_signal_quorum_payload,
        build_profitability_proof_floor_payload=(
            _build_profitability_proof_floor_payload
        ),
        build_quality_adjusted_profit_frontier_payload=(
            _build_quality_adjusted_profit_frontier_payload
        ),
        build_rejected_signal_outcome_learning_payload=(
            _build_rejected_signal_outcome_learning_payload
        ),
        build_renewal_bond_profit_escrow_payload=(
            _build_renewal_bond_profit_escrow_payload
        ),
        build_repair_bid_settlement_payload=_build_repair_bid_settlement_payload,
        build_repair_outcome_dividend_ledger_payload=(
            _build_repair_outcome_dividend_ledger_payload
        ),
        build_repair_receipt_frontier_payload=_build_repair_receipt_frontier_payload,
        build_route_evidence_clearinghouse_payload=(
            _build_route_evidence_clearinghouse_payload
        ),
        build_route_image_proof_summary=_build_route_image_proof_summary,
        build_route_reacquisition_board_payload=(
            _build_route_reacquisition_board_payload
        ),
        build_route_warrant_exchange_payload=_build_route_warrant_exchange_payload,
        build_routeability_repair_acceptance_ledger_payload=(
            _build_routeability_repair_acceptance_ledger_payload
        ),
        build_shadow_first_runtime_payload=_build_shadow_first_runtime_payload,
        build_simple_lane_status_payload=_build_simple_lane_status_payload,
        build_source_serving_repair_receipt_payload=(
            _build_source_serving_repair_receipt_payload
        ),
        build_submission_authority_status=_build_submission_authority_status,
        route_claim_symbols=_route_claim_symbols,
    )


@router.get("/trading/status")
def trading_status() -> dict[str, object]:
    """Return trading loop status and metrics."""

    status_read_budget = _TradingStatusReadBudget()
    context = load_trading_status_context(_trading_status_context_dependencies())
    section_dependencies = _trading_status_section_dependencies()
    core_sections = load_trading_status_core_sections(
        status_read_budget,
        context,
        deps=section_dependencies,
    )
    late_read_sections = load_trading_status_late_read_sections(
        status_read_budget,
        context,
        deps=section_dependencies,
    )
    return build_trading_status_response(
        TradingStatusResponseBuild(
            status_read_budget=status_read_budget,
            context=context,
            core=core_sections,
            late=late_read_sections,
            section_dependencies=section_dependencies,
            deps=_trading_status_response_dependencies(),
        )
    )


__all__ = ["trading_status"]
