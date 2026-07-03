"""Trading health payload coordinator."""

from __future__ import annotations

from app.db import SessionLocal
from app.trading.simulation_progress import active_simulation_runtime_context
from app.trading.submission_council import load_quant_evidence_status

from ...bootstrap import evaluate_scheduler_status as _evaluate_scheduler_status
from ..trading_scheduler_state import get_trading_scheduler
from . import status_dependencies as _status_dependencies
from .readiness_surface import (
    readiness_dependency_snapshot as _readiness_dependency_snapshot,
)
from .trading_health_context import (
    TradingHealthContextDependencies,
    load_trading_health_context,
)
from .trading_health_dependencies import (
    TradingHealthDependencyDependencies,
    load_trading_health_dependency_snapshot,
    runtime_dependencies_for_health_surface,
    split_runtime_and_proof_lane_dependencies,
)
from .trading_health_proof_lane import (
    TradingHealthProofLaneDependencies,
    build_trading_health_proof_lane,
)
from .trading_health_response import build_trading_health_response
from .universe_dependency import evaluate_universe_dependency


def _trading_health_context_dependencies() -> TradingHealthContextDependencies:
    return TradingHealthContextDependencies(
        get_trading_scheduler=get_trading_scheduler,
        evaluate_scheduler_status=_evaluate_scheduler_status,
    )


def _trading_health_dependency_dependencies() -> TradingHealthDependencyDependencies:
    return TradingHealthDependencyDependencies(
        session_factory=SessionLocal,
        readiness_dependency_snapshot=_readiness_dependency_snapshot,
        evaluate_universe_dependency=evaluate_universe_dependency,
    )


def _trading_health_proof_lane_dependencies() -> TradingHealthProofLaneDependencies:
    return TradingHealthProofLaneDependencies(
        session_factory=SessionLocal,
        active_runtime_revision=_status_dependencies.active_runtime_revision,
        active_simulation_runtime_context=active_simulation_runtime_context,
        build_api_live_submission_gate_payload=(
            _status_dependencies.build_api_live_submission_gate_payload
        ),
        build_capital_reentry_cohort_ledger_payload=(
            _status_dependencies.build_capital_reentry_cohort_ledger_payload
        ),
        build_capital_replay_projection_payload=(
            _status_dependencies.build_capital_replay_projection_payload
        ),
        build_clock_settlement_payload=_status_dependencies.build_clock_settlement_payload,
        build_consumer_evidence_receipt_projection=(
            _status_dependencies.build_consumer_evidence_receipt_projection
        ),
        build_evidence_clock_payloads=_status_dependencies.build_evidence_clock_payloads,
        build_freshness_carry_ledger_payload=(
            _status_dependencies.build_freshness_carry_ledger_payload
        ),
        build_hypothesis_runtime_payload=(
            _status_dependencies.build_hypothesis_runtime_payload
        ),
        build_profit_freshness_frontier_payload=(
            _status_dependencies.build_profit_freshness_frontier_payload
        ),
        build_profit_repair_settlement_ledger_payload=(
            _status_dependencies.build_profit_repair_settlement_ledger_payload
        ),
        build_profit_signal_quorum_payload=(
            _status_dependencies.build_profit_signal_quorum_payload
        ),
        build_profitability_proof_floor_payload=(
            _status_dependencies.build_profitability_proof_floor_payload
        ),
        build_quality_adjusted_profit_frontier_payload=(
            _status_dependencies.build_quality_adjusted_profit_frontier_payload
        ),
        build_renewal_bond_profit_escrow_payload=(
            _status_dependencies.build_renewal_bond_profit_escrow_payload
        ),
        build_repair_bid_settlement_payload=(
            _status_dependencies.build_repair_bid_settlement_payload
        ),
        build_repair_outcome_dividend_ledger_payload=(
            _status_dependencies.build_repair_outcome_dividend_ledger_payload
        ),
        build_repair_receipt_frontier_payload=(
            _status_dependencies.build_repair_receipt_frontier_payload
        ),
        build_route_evidence_clearinghouse_payload=(
            _status_dependencies.build_route_evidence_clearinghouse_payload
        ),
        build_route_image_proof_summary=(
            _status_dependencies.build_route_image_proof_summary
        ),
        build_route_reacquisition_board_payload=(
            _status_dependencies.build_route_reacquisition_board_payload
        ),
        build_route_warrant_exchange_payload=(
            _status_dependencies.build_route_warrant_exchange_payload
        ),
        build_routeability_repair_acceptance_ledger_payload=(
            _status_dependencies.build_routeability_repair_acceptance_ledger_payload
        ),
        build_source_serving_repair_receipt_payload=(
            _status_dependencies.build_source_serving_repair_receipt_payload
        ),
        empirical_jobs_status=_status_dependencies.empirical_jobs_status,
        forecast_service_status=_status_dependencies.forecast_service_status,
        load_clickhouse_ta_status=_status_dependencies.load_clickhouse_ta_status,
        load_options_catalog_freshness_summary=(
            _status_dependencies.load_options_catalog_freshness_summary
        ),
        load_quant_evidence_status=load_quant_evidence_status,
        load_tca_summary=_status_dependencies.load_tca_summary,
        revenue_repair_topline_fields=(
            _status_dependencies.revenue_repair_topline_fields
        ),
        route_claim_symbols=_status_dependencies.route_claim_symbols,
    )


def evaluate_trading_health_payload(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    """Build shared trading health payload and status code."""

    context = load_trading_health_context(_trading_health_context_dependencies())
    dependency_snapshot = load_trading_health_dependency_snapshot(
        context,
        include_database_contract=include_database_contract,
        allow_stale_dependency_cache=allow_stale_dependency_cache,
        deps=_trading_health_dependency_dependencies(),
    )
    proof_lane = build_trading_health_proof_lane(
        context,
        dependency_snapshot,
        deps=_trading_health_proof_lane_dependencies(),
    )
    return build_trading_health_response(context, proof_lane)


__all__: tuple[str, ...] = (
    "evaluate_trading_health_payload",
    "runtime_dependencies_for_health_surface",
    "split_runtime_and_proof_lane_dependencies",
)
