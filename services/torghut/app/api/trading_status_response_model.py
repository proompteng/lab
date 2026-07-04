"""Shared model objects for the Torghut trading status response."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import cast

from .status_helpers import TradingStatusReadBudget
from .trading_status_context import TradingStatusContext
from .trading_status_sections import (
    TradingStatusCoreSections,
    TradingStatusLateReadSections,
    TradingStatusSectionDependencies,
)

PayloadBuilder = Callable[..., dict[str, object]]
PayloadPairBuilder = Callable[..., tuple[dict[str, object], dict[str, object]]]


@dataclass(frozen=True)
class TradingStatusResponseDependencies:
    build_autonomy_bridge_status: PayloadBuilder
    build_capital_reentry_cohort_ledger_payload: PayloadBuilder
    build_capital_replay_projection_payload: PayloadBuilder
    build_clock_settlement_payload: PayloadBuilder
    build_consumer_evidence_receipt_projection: PayloadPairBuilder
    build_control_plane_contract: PayloadBuilder
    build_evidence_clock_payloads: PayloadPairBuilder
    build_freshness_carry_ledger_payload: PayloadBuilder
    build_profit_freshness_frontier_payload: PayloadBuilder
    build_profit_repair_settlement_ledger_payload: PayloadBuilder
    build_profit_signal_quorum_payload: PayloadBuilder
    build_profitability_proof_floor_payload: PayloadBuilder
    build_quality_adjusted_profit_frontier_payload: PayloadBuilder
    build_rejected_signal_outcome_learning_payload: PayloadBuilder
    build_renewal_bond_profit_escrow_payload: PayloadBuilder
    build_repair_bid_settlement_payload: PayloadBuilder
    build_repair_outcome_dividend_ledger_payload: PayloadBuilder
    build_repair_receipt_frontier_payload: PayloadBuilder
    build_route_evidence_clearinghouse_payload: PayloadBuilder
    build_route_image_proof_summary: PayloadBuilder
    build_route_reacquisition_board_payload: PayloadBuilder
    build_route_warrant_exchange_payload: PayloadBuilder
    build_routeability_repair_acceptance_ledger_payload: PayloadBuilder
    build_shadow_first_runtime_payload: PayloadBuilder
    build_simple_lane_status_payload: PayloadBuilder
    build_source_serving_repair_receipt_payload: PayloadBuilder
    build_submission_authority_status: PayloadBuilder
    route_claim_symbols: Callable[..., Sequence[object]]


@dataclass
class TradingStatusResponseBuild:
    status_read_budget: TradingStatusReadBudget
    context: TradingStatusContext
    core: TradingStatusCoreSections
    late: TradingStatusLateReadSections
    section_dependencies: TradingStatusSectionDependencies
    deps: TradingStatusResponseDependencies
    payloads: dict[str, object] = field(default_factory=lambda: {})


def active_revision(build: TradingStatusResponseBuild) -> str | None:
    return cast(
        str | None, payload(build.payloads, "shadow_first_runtime")["active_revision"]
    )


def dependency_quorum_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.core.hypothesis_dependency_quorum.as_payload()


def payload(payloads: dict[str, object], key: str) -> dict[str, object]:
    return cast(dict[str, object], payloads[key])
