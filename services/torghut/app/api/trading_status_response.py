"""Response projection for the Torghut trading status route."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import cast

from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST, BUILD_VERSION
from app.config import settings
from app.trading.time_source import trading_time_status

from .status_helpers import TradingStatusReadBudget
from .trading_status_context import TradingStatusContext
from .trading_status_sections import (
    TradingStatusCoreSections,
    TradingStatusLateReadSections,
    TradingStatusSectionDependencies,
    load_trading_status_options_catalog_freshness,
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
    simple_lane_reject_reason_totals: PayloadBuilder


@dataclass
class TradingStatusResponseBuild:
    status_read_budget: TradingStatusReadBudget
    context: TradingStatusContext
    core: TradingStatusCoreSections
    late: TradingStatusLateReadSections
    section_dependencies: TradingStatusSectionDependencies
    deps: TradingStatusResponseDependencies
    payloads: dict[str, object] = field(default_factory=lambda: {})


def build_trading_status_response(
    build: TradingStatusResponseBuild,
) -> dict[str, object]:
    _add_runtime_payloads(build)
    _add_primary_proof_payloads(build)
    _add_repair_payloads(build)
    return _project_response(build)


def _add_runtime_payloads(build: TradingStatusResponseBuild) -> None:
    deps = build.deps
    context = build.context
    core = build.core
    payloads = build.payloads
    payloads["shadow_first_runtime"] = deps.build_shadow_first_runtime_payload(
        state=context.state,
        hypothesis_summary=core.hypothesis_summary,
    )
    payloads["control_plane_contract"] = deps.build_control_plane_contract(
        context.state,
        hypothesis_summary=core.hypothesis_summary,
        dependency_quorum=core.hypothesis_dependency_quorum,
    )
    payloads["shorting_metadata_status"] = context.scheduler.shorting_metadata_status()
    payloads["rejection_alert_status"] = context.scheduler.rejection_alert_status()
    payloads["simple_lane_reject_reason_totals"] = (
        deps.simple_lane_reject_reason_totals(context.state)
    )
    payloads["simple_lane_status"] = deps.build_simple_lane_status_payload()
    payloads["submission_authority"] = deps.build_submission_authority_status(
        core.live_submission_gate,
        simple_lane_status=_payload(payloads, "simple_lane_status"),
    )
    payloads["build_payload"] = {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": _payload(payloads, "shadow_first_runtime")[
            "active_revision"
        ],
    }


def _add_primary_proof_payloads(build: TradingStatusResponseBuild) -> None:
    deps = build.deps
    context = build.context
    core = build.core
    payloads = build.payloads
    payloads["proof_floor"] = deps.build_profitability_proof_floor_payload(
        state=context.state,
        torghut_revision=str(_active_revision(build)),
        live_submission_gate=core.live_submission_gate,
        hypothesis_payload=core.hypothesis_payload,
        empirical_jobs_status=context.empirical_jobs,
        quant_evidence=context.quant_evidence,
        market_context_status=context.market_context_status,
        tca_summary=core.tca_summary,
        simple_lane_status=_payload(payloads, "simple_lane_status"),
    )
    payloads["renewal_bond_profit_escrow"] = (
        deps.build_renewal_bond_profit_escrow_payload(
            state=context.state,
            torghut_revision=str(_active_revision(build)),
            dependency_quorum=_dependency_quorum_payload(build),
            live_submission_gate=core.live_submission_gate,
            proof_floor=_payload(payloads, "proof_floor"),
            hypothesis_payload=core.hypothesis_payload,
            empirical_jobs_status=context.empirical_jobs,
            quant_evidence=context.quant_evidence,
            market_context_status=context.market_context_status,
            tca_summary=core.tca_summary,
        )
    )
    payloads["route_reacquisition_board"] = (
        deps.build_route_reacquisition_board_payload(
            proof_floor=_payload(payloads, "proof_floor"),
            active_revision=str(_active_revision(build)),
        )
    )
    payloads["profit_signal_quorum"] = deps.build_profit_signal_quorum_payload(
        torghut_revision=str(_active_revision(build)),
        dependency_quorum=_dependency_quorum_payload(build),
        hypothesis_payload=core.hypothesis_payload,
        quant_evidence=context.quant_evidence,
        market_context_status=context.market_context_status,
        proof_floor=_payload(payloads, "proof_floor"),
        route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        live_submission_gate=core.live_submission_gate,
    )
    payloads["route_claim_symbols"] = deps.route_claim_symbols(
        _payload(payloads, "profit_signal_quorum")
    )
    payloads["options_catalog_freshness"] = (
        load_trading_status_options_catalog_freshness(
            build.status_read_budget,
            payloads["route_claim_symbols"],
            deps=build.section_dependencies,
        )
    )
    _add_capital_replay_payloads(build)


def _add_capital_replay_payloads(build: TradingStatusResponseBuild) -> None:
    deps = build.deps
    context = build.context
    core = build.core
    payloads = build.payloads
    payloads["capital_replay_projection"] = (
        deps.build_capital_replay_projection_payload(
            torghut_revision=str(_active_revision(build)),
            dependency_quorum=_dependency_quorum_payload(build),
            live_submission_gate=core.live_submission_gate,
            proof_floor=_payload(payloads, "proof_floor"),
            route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
            empirical_jobs_status=context.empirical_jobs,
            quant_evidence=context.quant_evidence,
            market_context_status=context.market_context_status,
        )
    )
    payloads["quality_adjusted_profit_frontier"] = (
        deps.build_quality_adjusted_profit_frontier_payload(
            torghut_revision=str(_active_revision(build)),
            live_submission_gate=core.live_submission_gate,
            proof_floor=_payload(payloads, "proof_floor"),
            route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
            hypothesis_payload=core.hypothesis_payload,
            quant_evidence=context.quant_evidence,
            market_context_status=context.market_context_status,
            active_simulation_context=context.active_simulation_context,
        )
    )
    consumer_receipt, route_receipt = deps.build_consumer_evidence_receipt_projection(
        forecast_service_status=context.forecast_service_status,
        empirical_jobs_status=context.empirical_jobs,
        proof_floor=_payload(payloads, "proof_floor"),
        live_submission_gate=core.live_submission_gate,
        serving_revision=_active_revision(build),
    )
    payloads["consumer_evidence_receipt"] = consumer_receipt
    payloads["route_proven_profit_receipt"] = route_receipt


def _add_repair_payloads(build: TradingStatusResponseBuild) -> None:
    deps = build.deps
    payloads = build.payloads
    payloads["capital_reentry_cohort_ledger"] = (
        deps.build_capital_reentry_cohort_ledger_payload(
            torghut_revision=_active_revision(build),
            dependency_quorum=_dependency_quorum_payload(build),
            consumer_evidence_receipt=_payload(payloads, "consumer_evidence_receipt"),
            proof_floor=_payload(payloads, "proof_floor"),
            route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        )
    )
    payloads["profit_repair_settlement_ledger"] = _profit_repair_payload(build)
    payloads["routeability_repair_acceptance_ledger"] = _routeability_payload(build)
    payloads["profit_freshness_frontier"] = _profit_freshness_payload(build)
    evidence_clock, candidate_exchange = _evidence_clock_payloads(build)
    payloads["evidence_clock_arbiter"] = evidence_clock
    payloads["routeable_profit_candidate_exchange"] = candidate_exchange
    _add_repair_settlement_payloads(build)


def _add_repair_settlement_payloads(build: TradingStatusResponseBuild) -> None:
    payloads = build.payloads
    payloads["clock_settlement_receipt"] = _clock_settlement_payload(build)
    payloads["route_evidence_clearinghouse_packet"] = _route_evidence_packet(build)
    payloads["repair_bid_settlement_ledger"] = _repair_bid_payload(build)
    payloads["route_warrant_exchange"] = _route_warrant_payload(build)
    payloads["source_serving_repair_receipt_ledger"] = _source_serving_payload(build)
    payloads["freshness_carry_ledger"] = _freshness_carry_payload(build)
    payloads["repair_receipt_frontier"] = _repair_receipt_payload(build)
    payloads["repair_outcome_dividend_ledger"] = _repair_outcome_payload(build)
    payloads["rejected_signal_outcome_learning"] = (
        build.deps.build_rejected_signal_outcome_learning_payload(
            build.context.state,
            persisted_summary=build.late.persisted_rejected_signal_outcome_learning,
        )
    )


def _profit_repair_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    payloads = build.payloads
    return build.deps.build_profit_repair_settlement_ledger_payload(
        torghut_revision=_active_revision(build),
        dependency_quorum=_dependency_quorum_payload(build),
        consumer_evidence_receipt=_payload(payloads, "consumer_evidence_receipt"),
        proof_floor=_payload(payloads, "proof_floor"),
        capital_reentry_cohort_ledger=_payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        quality_adjusted_profit_frontier=_payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        live_submission_gate=build.core.live_submission_gate,
        quant_evidence=build.context.quant_evidence,
    )


def _routeability_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    payloads = build.payloads
    return build.deps.build_routeability_repair_acceptance_ledger_payload(
        torghut_revision=_active_revision(build),
        dependency_quorum=_dependency_quorum_payload(build),
        consumer_evidence_receipt=_payload(payloads, "consumer_evidence_receipt"),
        proof_floor=_payload(payloads, "proof_floor"),
        capital_reentry_cohort_ledger=_payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        quality_adjusted_profit_frontier=_payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        profit_repair_settlement_ledger=_payload(
            payloads, "profit_repair_settlement_ledger"
        ),
        route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        live_submission_gate=build.core.live_submission_gate,
        quant_evidence=build.context.quant_evidence,
        market_context_status=build.context.market_context_status,
    )


def _profit_freshness_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_profit_freshness_frontier_payload(
        torghut_revision=_active_revision(build),
        dependency_quorum=_dependency_quorum_payload(build),
        proof_floor=_payload(build.payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=_payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        quality_adjusted_profit_frontier=_payload(
            build.payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=_payload(build.payloads, "route_reacquisition_board"),
        live_submission_gate=build.core.live_submission_gate,
        quant_evidence=build.context.quant_evidence,
        market_context_status=build.context.market_context_status,
        empirical_jobs_status=build.context.empirical_jobs,
        hypothesis_payload=build.core.hypothesis_payload,
    )


def _evidence_clock_payloads(
    build: TradingStatusResponseBuild,
) -> tuple[dict[str, object], dict[str, object]]:
    return build.deps.build_evidence_clock_payloads(
        torghut_revision=_active_revision(build),
        dependency_quorum=_dependency_quorum_payload(build),
        hypothesis_payload=build.core.hypothesis_payload,
        quant_evidence=build.context.quant_evidence,
        market_context_status=build.context.market_context_status,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        proof_floor=_payload(build.payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=_payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_signal_quorum=_payload(build.payloads, "profit_signal_quorum"),
        live_submission_gate=build.core.live_submission_gate,
        build=_payload(build.payloads, "build_payload"),
        clickhouse_ta_status=build.core.clickhouse_ta_status,
    )


def _clock_settlement_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_clock_settlement_payload(
        torghut_revision=_active_revision(build),
        source_commit=BUILD_COMMIT,
        build=_payload(build.payloads, "build_payload"),
        evidence_clock_arbiter=_payload(build.payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=_payload(
            build.payloads, "routeable_profit_candidate_exchange"
        ),
        clickhouse_ta_status=build.core.clickhouse_ta_status,
        quant_evidence=build.context.quant_evidence,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        profit_signal_quorum=_payload(build.payloads, "profit_signal_quorum"),
        rollout_status=build.deps.build_route_image_proof_summary(
            build=_payload(build.payloads, "build_payload"),
            dependency_quorum=_dependency_quorum_payload(build),
        ),
    )


def _route_evidence_packet(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_route_evidence_clearinghouse_payload(
        torghut_revision=_active_revision(build),
        source_commit=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum_payload(build),
        build=_payload(build.payloads, "build_payload"),
        proof_floor=_payload(build.payloads, "proof_floor"),
        profit_signal_quorum=_payload(build.payloads, "profit_signal_quorum"),
        profit_repair_settlement_ledger=_payload(
            build.payloads, "profit_repair_settlement_ledger"
        ),
        route_reacquisition_board=_payload(build.payloads, "route_reacquisition_board"),
        routeability_repair_acceptance_ledger=_payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        live_submission_gate=build.core.live_submission_gate,
        tca_summary=build.core.tca_summary,
        options_catalog_freshness=_payload(build.payloads, "options_catalog_freshness"),
    )


def _repair_bid_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_repair_bid_settlement_payload(
        torghut_revision=_active_revision(build),
        source_commit=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum_payload(build),
        build=_payload(build.payloads, "build_payload"),
        route_evidence_clearinghouse_packet=_payload(
            build.payloads, "route_evidence_clearinghouse_packet"
        ),
        routeability_repair_acceptance_ledger=_payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        quant_evidence=build.context.quant_evidence,
        profit_freshness_frontier=_payload(build.payloads, "profit_freshness_frontier"),
    )


def _route_warrant_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_route_warrant_exchange_payload(
        torghut_revision=_active_revision(build),
        source_commit=BUILD_COMMIT,
        build=_payload(build.payloads, "build_payload"),
        consumer_evidence_receipt=_payload(build.payloads, "consumer_evidence_receipt"),
        evidence_clock_arbiter=_payload(build.payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=_payload(
            build.payloads, "routeable_profit_candidate_exchange"
        ),
        routeability_repair_acceptance_ledger=_payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_freshness_frontier=_payload(build.payloads, "profit_freshness_frontier"),
        live_submission_gate=build.core.live_submission_gate,
        quant_evidence=build.context.quant_evidence,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        market_context_status=build.context.market_context_status,
    )


def _source_serving_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=_payload(build.payloads, "build_payload"),
        consumer_evidence_receipt=_payload(build.payloads, "consumer_evidence_receipt"),
        route_evidence_clearinghouse_packet=_payload(
            build.payloads, "route_evidence_clearinghouse_packet"
        ),
        repair_bid_settlement_ledger=_payload(
            build.payloads, "repair_bid_settlement_ledger"
        ),
        route_warrant_exchange=_payload(build.payloads, "route_warrant_exchange"),
    )


def _freshness_carry_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=_payload(
            build.payloads, "source_serving_repair_receipt_ledger"
        ),
        route_warrant_exchange=_payload(build.payloads, "route_warrant_exchange"),
        clickhouse_ta_status=build.core.clickhouse_ta_status,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        market_context_status=build.context.market_context_status,
        quant_evidence=build.context.quant_evidence,
        live_submission_gate=build.core.live_submission_gate,
    )


def _repair_receipt_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_repair_receipt_frontier_payload(
        torghut_revision=_active_revision(build),
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=_payload(
            build.payloads, "source_serving_repair_receipt_ledger"
        ),
        freshness_carry_ledger=_payload(build.payloads, "freshness_carry_ledger"),
        repair_bid_settlement_ledger=_payload(
            build.payloads, "repair_bid_settlement_ledger"
        ),
        profit_freshness_frontier=_payload(build.payloads, "profit_freshness_frontier"),
        route_warrant_exchange=_payload(build.payloads, "route_warrant_exchange"),
        live_submission_gate=build.core.live_submission_gate,
        proof_floor=_payload(build.payloads, "proof_floor"),
    )


def _repair_outcome_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=_payload(
            build.payloads, "repair_bid_settlement_ledger"
        ),
        repair_receipt_frontier=_payload(build.payloads, "repair_receipt_frontier"),
        freshness_carry_ledger=_payload(build.payloads, "freshness_carry_ledger"),
        route_warrant_exchange=_payload(build.payloads, "route_warrant_exchange"),
        live_submission_gate=build.core.live_submission_gate,
    )


def _project_response(build: TradingStatusResponseBuild) -> dict[str, object]:
    state = build.context.state
    payloads = build.payloads
    rejection_alert_status = _payload(payloads, "rejection_alert_status")
    capital_replay_projection = _payload(payloads, "capital_replay_projection")
    return {
        "enabled": settings.trading_enabled,
        "autonomy_enabled": settings.trading_autonomy_enabled,
        "mode": settings.trading_mode,
        "pipeline_mode": settings.trading_pipeline_mode,
        "execution_lane": settings.trading_pipeline_mode,
        "kill_switch_enabled": settings.trading_kill_switch_enabled,
        "build": _payload(payloads, "build_payload"),
        "status_read_budget": build.status_read_budget.as_payload(),
        "shadow_first": _payload(payloads, "shadow_first_runtime"),
        "execution_advisor": _execution_advisor_payload(state),
        "running": state.running,
        "live_submission_gate": build.core.live_submission_gate,
        "submission_authority": _payload(payloads, "submission_authority"),
        "tigerbeetle_ledger": build.late.tigerbeetle_ledger,
        "portfolio_runtime_ledger_summary": build.late.runtime_ledger_portfolio_summary,
        "runtime_ledger_profit_distance_readback": build.late.runtime_ledger_portfolio_summary.get(
            "runtime_ledger_profit_distance_readback"
        ),
        "profit_lease_projection": build.core.live_submission_gate.get(
            "profit_lease_projection"
        ),
        "proof_floor": _payload(payloads, "proof_floor"),
        "renewal_bond_profit_escrow": _payload(payloads, "renewal_bond_profit_escrow"),
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": _payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        "torghut_consumer_evidence_receipt": _payload(
            payloads, "consumer_evidence_receipt"
        ),
        "route_proven_profit_receipt": _payload(
            payloads, "route_proven_profit_receipt"
        ),
        "consumer_evidence_canary": _payload(
            payloads, "route_proven_profit_receipt"
        ).get("route_canary"),
        "capital_reentry_cohort_ledger": _payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        "profit_repair_settlement_ledger": _payload(
            payloads, "profit_repair_settlement_ledger"
        ),
        "routeability_repair_acceptance_ledger": _payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        "profit_freshness_frontier": _payload(payloads, "profit_freshness_frontier"),
        "profit_signal_quorum": _payload(payloads, "profit_signal_quorum"),
        "evidence_clock_arbiter": _payload(payloads, "evidence_clock_arbiter"),
        "routeable_profit_candidate_exchange": _payload(
            payloads, "routeable_profit_candidate_exchange"
        ),
        "clock_settlement_receipt": _payload(payloads, "clock_settlement_receipt"),
        "route_evidence_clearinghouse_packet": _payload(
            payloads, "route_evidence_clearinghouse_packet"
        ),
        "repair_bid_settlement_ledger": _payload(
            payloads, "repair_bid_settlement_ledger"
        ),
        "route_warrant_exchange": _payload(payloads, "route_warrant_exchange"),
        "source_serving_repair_receipt_ledger": _payload(
            payloads, "source_serving_repair_receipt_ledger"
        ),
        "freshness_carry_ledger": _payload(payloads, "freshness_carry_ledger"),
        "repair_receipt_frontier": _payload(payloads, "repair_receipt_frontier"),
        "repair_outcome_dividend_ledger": _payload(
            payloads, "repair_outcome_dividend_ledger"
        ),
        "rejected_signal_outcome_learning": _payload(
            payloads, "rejected_signal_outcome_learning"
        ),
        "route_reacquisition_book": _payload(payloads, "proof_floor").get(
            "route_reacquisition_book"
        ),
        "route_reacquisition_board": _payload(payloads, "route_reacquisition_board"),
        "quant_evidence": build.context.quant_evidence,
        "last_decision_at": build.late.last_decision_at,
        "simple_lane_status": _payload(payloads, "simple_lane_status"),
        "simple_lane_reject_reason_totals": _payload(
            payloads, "simple_lane_reject_reason_totals"
        ),
        "simple_lane_orders_submitted_total": state.metrics.orders_submitted_total,
        "last_run_at": state.last_run_at,
        "last_reconcile_at": state.last_reconcile_at,
        "last_error": state.last_error,
        "autonomy": _autonomy_payload(build),
        "signal_continuity": _signal_continuity_payload(state),
        "market_context": build.context.market_context_status,
        "shorting_metadata": _payload(payloads, "shorting_metadata_status"),
        "rejections": _rejections_payload(state, rejection_alert_status),
        "alerts": _alerts_payload(
            build.context.market_context_status, rejection_alert_status
        ),
        "rollback": _rollback_payload(state),
        "posthog": _posthog_payload(state),
        "metrics": state.metrics.to_payload(),
        "llm": build.context.scheduler.llm_status(),
        "llm_evaluation": build.core.llm_evaluation,
        "tca": build.core.tca_summary,
        "hypotheses": build.core.hypothesis_payload,
        "forecast_service": build.context.forecast_service_status,
        "lean_authority": build.context.lean_authority_status,
        "empirical_jobs": build.context.empirical_jobs,
        "simulation": _simulation_payload(build),
        "control_plane_contract": _payload(payloads, "control_plane_contract"),
        "evidence_continuity": state.last_evidence_continuity_report,
    }


def _execution_advisor_payload(state: object) -> dict[str, object]:
    metrics = getattr(state, "metrics")
    return {
        "enabled": settings.trading_execution_advisor_enabled,
        "live_apply_enabled": settings.trading_execution_advisor_live_apply_enabled,
        "usage_total": dict(metrics.execution_advisor_usage_total),
        "fallback_total": dict(metrics.execution_advisor_fallback_total),
    }


def _autonomy_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    state = build.context.state
    return {
        "runs_total": state.autonomy_runs_total,
        "signals_total": state.autonomy_signals_total,
        "patches_total": state.autonomy_patches_total,
        "no_signal_streak": state.autonomy_no_signal_streak,
        "last_run_at": state.last_autonomy_run_at,
        "last_run_id": state.last_autonomy_run_id,
        "last_gates": state.last_autonomy_gates,
        "last_actuation_intent": state.last_autonomy_actuation_intent,
        "last_patch": state.last_autonomy_patch,
        "last_recommendation": state.last_autonomy_recommendation,
        "last_recommendation_trace_id": state.last_autonomy_recommendation_trace_id,
        "last_error": state.last_autonomy_error,
        "last_reason": state.last_autonomy_reason,
        "last_ingest_signal_count": state.last_ingest_signals_total,
        "last_ingest_reason": state.last_ingest_reason,
        "last_ingest_window_start": state.last_ingest_window_start,
        "last_ingest_window_end": state.last_ingest_window_end,
        "failure_streak": state.autonomy_failure_streak,
        "bridge_status": build.deps.build_autonomy_bridge_status(
            build.context.scheduler
        ),
    }


def _signal_continuity_payload(state: object) -> dict[str, object]:
    metrics = getattr(state, "metrics")
    return {
        "universe_source": settings.trading_universe_source,
        "universe_status": getattr(state, "universe_source_status"),
        "universe_reason": getattr(state, "universe_source_reason"),
        "universe_symbols_count": getattr(state, "universe_symbols_count"),
        "universe_cache_age_seconds": getattr(state, "universe_cache_age_seconds"),
        "universe_fail_safe_blocked": getattr(state, "universe_fail_safe_blocked"),
        "universe_fail_safe_block_reason": getattr(
            state, "universe_fail_safe_block_reason"
        ),
        "market_session_open": getattr(state, "market_session_open"),
        "last_state": getattr(state, "last_signal_continuity_state"),
        "last_reason": getattr(state, "last_signal_continuity_reason"),
        "last_actionable": getattr(state, "last_signal_continuity_actionable"),
        "alert_active": getattr(state, "signal_continuity_alert_active"),
        "alert_reason": getattr(state, "signal_continuity_alert_reason"),
        "alert_started_at": getattr(state, "signal_continuity_alert_started_at"),
        "alert_last_seen_at": getattr(state, "signal_continuity_alert_last_seen_at"),
        "alert_recovery_streak": getattr(state, "signal_continuity_recovery_streak"),
        "no_signal_reason_streak": dict(metrics.no_signal_reason_streak),
        "signal_staleness_alert_total": dict(metrics.signal_staleness_alert_total),
        "signal_continuity_promotion_block_total": (
            metrics.signal_continuity_promotion_block_total
        ),
        "no_signal_streak_alert_threshold": (
            settings.trading_signal_no_signal_streak_alert_threshold
        ),
        "signal_lag_alert_threshold_seconds": (
            settings.trading_signal_stale_lag_alert_seconds
        ),
        "signal_continuity_recovery_cycles": (
            settings.trading_signal_continuity_recovery_cycles
        ),
    }


def _rejections_payload(
    state: object,
    rejection_alert_status: dict[str, object],
) -> dict[str, object]:
    metrics = getattr(state, "metrics")
    return {
        "policy_veto_total": metrics.llm_policy_veto_total,
        "runtime_fallback_total": metrics.llm_runtime_fallback_total,
        "rejected_signal_events_total": metrics.rejected_signal_events_total,
        "rejected_signal_outcome_label_pending_total": (
            metrics.rejected_signal_outcome_label_pending_total
        ),
        "rejected_signal_reason_total": dict(metrics.rejected_signal_reason_total),
        "strategy_intent_suppression_total": dict(
            metrics.strategy_intent_suppression_total
        ),
        "market_context_block_total": metrics.llm_market_context_block_total,
        "pre_llm_capacity_reject_total": metrics.pre_llm_capacity_reject_total,
        "pre_llm_qty_below_min_total": metrics.pre_llm_qty_below_min_total,
        "runtime_fallback_ratio": rejection_alert_status["runtime_fallback_ratio"],
        "runtime_fallback_alert_ratio_threshold": rejection_alert_status[
            "runtime_fallback_alert_ratio_threshold"
        ],
        "runtime_fallback_alert_active": rejection_alert_status[
            "runtime_fallback_alert_active"
        ],
    }


def _alerts_payload(
    market_context_status: dict[str, object],
    rejection_alert_status: dict[str, object],
) -> dict[str, object]:
    return {
        "market_context_alert_active": market_context_status["alert_active"],
        "market_context_alert_reason": market_context_status["alert_reason"],
        "runtime_fallback_alert_active": rejection_alert_status[
            "runtime_fallback_alert_active"
        ],
        "shorting_metadata_alert_active": rejection_alert_status[
            "shorting_metadata_alert_active"
        ],
    }


def _rollback_payload(state: object) -> dict[str, object]:
    return {
        "emergency_stop_active": getattr(state, "emergency_stop_active"),
        "emergency_stop_reason": getattr(state, "emergency_stop_reason"),
        "emergency_stop_triggered_at": getattr(state, "emergency_stop_triggered_at"),
        "emergency_stop_resolved_at": getattr(state, "emergency_stop_resolved_at"),
        "emergency_stop_recovery_streak": getattr(
            state, "emergency_stop_recovery_streak"
        ),
        "incidents_total": getattr(state, "rollback_incidents_total"),
        "incident_evidence_path": getattr(state, "rollback_incident_evidence_path"),
    }


def _posthog_payload(state: object) -> dict[str, object]:
    metrics = getattr(state, "metrics")
    return {
        "enabled": settings.posthog_enabled,
        "host": settings.posthog_host,
        "project_id": settings.posthog_project_id,
        "event_total": dict(metrics.domain_telemetry_event_total),
        "dropped_total": dict(metrics.domain_telemetry_dropped_total),
    }


def _simulation_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    simulation_context = build.context.active_simulation_context or {}
    return {
        "enabled": settings.trading_simulation_enabled,
        "run_id": simulation_context.get("run_id")
        or settings.trading_simulation_run_id,
        "dataset_id": simulation_context.get("dataset_id")
        or settings.trading_simulation_dataset_id,
        "window_start": simulation_context.get("window_start")
        or settings.trading_simulation_window_start,
        "window_end": simulation_context.get("window_end")
        or settings.trading_simulation_window_end,
        "time_source": trading_time_status(
            account_label=settings.trading_account_label
        ),
    }


def _active_revision(build: TradingStatusResponseBuild) -> str | None:
    return cast(
        str | None, _payload(build.payloads, "shadow_first_runtime")["active_revision"]
    )


def _dependency_quorum_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.core.hypothesis_dependency_quorum.as_payload()


def _payload(payloads: dict[str, object], key: str) -> dict[str, object]:
    return cast(dict[str, object], payloads[key])


__all__ = [
    "TradingStatusResponseBuild",
    "TradingStatusResponseDependencies",
    "build_trading_status_response",
]
