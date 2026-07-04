"""Shared model objects for the Torghut trading health proof lane."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import cast

from app.trading.hypotheses import JangarDependencyQuorumStatus

from .trading_health_context import TradingHealthContext

PayloadBuilder = Callable[..., dict[str, object]]
PayloadPairBuilder = Callable[..., tuple[dict[str, object], dict[str, object]]]


@dataclass(frozen=True)
class TradingHealthProofLaneDependencies:
    session_factory: Callable[[], AbstractContextManager[object]]
    active_runtime_revision: Callable[[], str | None]
    active_simulation_runtime_context: Callable[[], Mapping[str, object] | None]
    build_api_live_submission_gate_payload: PayloadBuilder
    build_capital_reentry_cohort_ledger_payload: PayloadBuilder
    build_capital_replay_projection_payload: PayloadBuilder
    build_clock_settlement_payload: PayloadBuilder
    build_consumer_evidence_receipt_projection: PayloadPairBuilder
    build_evidence_clock_payloads: PayloadPairBuilder
    build_freshness_carry_ledger_payload: PayloadBuilder
    build_hypothesis_runtime_payload: Callable[
        ..., tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]
    ]
    build_profit_freshness_frontier_payload: PayloadBuilder
    build_profit_repair_settlement_ledger_payload: PayloadBuilder
    build_profit_signal_quorum_payload: PayloadBuilder
    build_profitability_proof_floor_payload: PayloadBuilder
    build_quality_adjusted_profit_frontier_payload: PayloadBuilder
    build_renewal_bond_profit_escrow_payload: PayloadBuilder
    build_repair_bid_settlement_payload: PayloadBuilder
    build_repair_outcome_dividend_ledger_payload: PayloadBuilder
    build_repair_receipt_frontier_payload: PayloadBuilder
    build_route_evidence_clearinghouse_payload: PayloadBuilder
    build_route_image_proof_summary: PayloadBuilder
    build_route_reacquisition_board_payload: PayloadBuilder
    build_route_warrant_exchange_payload: PayloadBuilder
    build_routeability_repair_acceptance_ledger_payload: PayloadBuilder
    build_source_serving_repair_receipt_payload: PayloadBuilder
    empirical_jobs_status: PayloadBuilder
    forecast_service_status: PayloadBuilder
    load_clickhouse_ta_status: PayloadBuilder
    load_options_catalog_freshness_summary: PayloadBuilder
    load_quant_evidence_status: PayloadBuilder
    load_tca_summary: PayloadBuilder
    revenue_repair_topline_fields: PayloadBuilder
    route_claim_symbols: Callable[..., Sequence[object]]


@dataclass
class TradingHealthProofLane:
    context: TradingHealthContext
    dependencies: dict[str, object]
    deps: TradingHealthProofLaneDependencies
    alpha_readiness: dict[str, object] = field(default_factory=lambda: {})
    dependency_quorum: JangarDependencyQuorumStatus = field(
        default_factory=lambda: JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["alpha_readiness_not_evaluated"],
            message="alpha readiness not evaluated",
        )
    )
    payloads: dict[str, object] = field(default_factory=lambda: {})


def payload(payloads: dict[str, object], key: str) -> dict[str, object]:
    return cast(dict[str, object], payloads[key])
