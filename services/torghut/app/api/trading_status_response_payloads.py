"""Payload assembly for the Torghut trading status response."""

from __future__ import annotations

from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST, BUILD_VERSION

from .trading_status_response_model import (
    TradingStatusResponseBuild,
    active_revision,
    dependency_quorum_payload,
    payload,
)
from .trading_status_sections import load_trading_status_options_catalog_freshness


def add_trading_status_payloads(build: TradingStatusResponseBuild) -> None:
    _add_runtime_payloads(build)
    _add_primary_proof_payloads(build)
    _add_repair_payloads(build)


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
        simple_lane_status=payload(payloads, "simple_lane_status"),
    )
    payloads["build_payload"] = {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": payload(payloads, "shadow_first_runtime")["active_revision"],
    }


def _add_primary_proof_payloads(build: TradingStatusResponseBuild) -> None:
    deps = build.deps
    context = build.context
    core = build.core
    payloads = build.payloads
    payloads["proof_floor"] = deps.build_profitability_proof_floor_payload(
        state=context.state,
        torghut_revision=str(active_revision(build)),
        live_submission_gate=core.live_submission_gate,
        hypothesis_payload=core.hypothesis_payload,
        empirical_jobs_status=context.empirical_jobs,
        quant_evidence=context.quant_evidence,
        market_context_status=context.market_context_status,
        tca_summary=core.tca_summary,
        simple_lane_status=payload(payloads, "simple_lane_status"),
    )
    payloads["renewal_bond_profit_escrow"] = (
        deps.build_renewal_bond_profit_escrow_payload(
            state=context.state,
            torghut_revision=str(active_revision(build)),
            dependency_quorum=dependency_quorum_payload(build),
            live_submission_gate=core.live_submission_gate,
            proof_floor=payload(payloads, "proof_floor"),
            hypothesis_payload=core.hypothesis_payload,
            empirical_jobs_status=context.empirical_jobs,
            quant_evidence=context.quant_evidence,
            market_context_status=context.market_context_status,
            tca_summary=core.tca_summary,
        )
    )
    payloads["route_reacquisition_board"] = (
        deps.build_route_reacquisition_board_payload(
            proof_floor=payload(payloads, "proof_floor"),
            active_revision=str(active_revision(build)),
        )
    )
    payloads["profit_signal_quorum"] = deps.build_profit_signal_quorum_payload(
        torghut_revision=str(active_revision(build)),
        dependency_quorum=dependency_quorum_payload(build),
        hypothesis_payload=core.hypothesis_payload,
        quant_evidence=context.quant_evidence,
        market_context_status=context.market_context_status,
        proof_floor=payload(payloads, "proof_floor"),
        route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
        live_submission_gate=core.live_submission_gate,
    )
    payloads["route_claim_symbols"] = deps.route_claim_symbols(
        payload(payloads, "profit_signal_quorum")
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
            torghut_revision=str(active_revision(build)),
            dependency_quorum=dependency_quorum_payload(build),
            live_submission_gate=core.live_submission_gate,
            proof_floor=payload(payloads, "proof_floor"),
            route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
            empirical_jobs_status=context.empirical_jobs,
            quant_evidence=context.quant_evidence,
            market_context_status=context.market_context_status,
        )
    )
    payloads["quality_adjusted_profit_frontier"] = (
        deps.build_quality_adjusted_profit_frontier_payload(
            torghut_revision=str(active_revision(build)),
            live_submission_gate=core.live_submission_gate,
            proof_floor=payload(payloads, "proof_floor"),
            route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
            hypothesis_payload=core.hypothesis_payload,
            quant_evidence=context.quant_evidence,
            market_context_status=context.market_context_status,
            active_simulation_context=context.active_simulation_context,
        )
    )
    consumer_receipt, route_receipt = deps.build_consumer_evidence_receipt_projection(
        forecast_service_status=context.forecast_service_status,
        empirical_jobs_status=context.empirical_jobs,
        proof_floor=payload(payloads, "proof_floor"),
        live_submission_gate=core.live_submission_gate,
        serving_revision=active_revision(build),
    )
    payloads["consumer_evidence_receipt"] = consumer_receipt
    payloads["route_proven_profit_receipt"] = route_receipt


def _add_repair_payloads(build: TradingStatusResponseBuild) -> None:
    deps = build.deps
    payloads = build.payloads
    payloads["capital_reentry_cohort_ledger"] = (
        deps.build_capital_reentry_cohort_ledger_payload(
            torghut_revision=active_revision(build),
            dependency_quorum=dependency_quorum_payload(build),
            consumer_evidence_receipt=payload(payloads, "consumer_evidence_receipt"),
            proof_floor=payload(payloads, "proof_floor"),
            route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
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
        torghut_revision=active_revision(build),
        dependency_quorum=dependency_quorum_payload(build),
        consumer_evidence_receipt=payload(payloads, "consumer_evidence_receipt"),
        proof_floor=payload(payloads, "proof_floor"),
        capital_reentry_cohort_ledger=payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        quality_adjusted_profit_frontier=payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
        live_submission_gate=build.core.live_submission_gate,
        quant_evidence=build.context.quant_evidence,
    )


def _routeability_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    payloads = build.payloads
    return build.deps.build_routeability_repair_acceptance_ledger_payload(
        torghut_revision=active_revision(build),
        dependency_quorum=dependency_quorum_payload(build),
        consumer_evidence_receipt=payload(payloads, "consumer_evidence_receipt"),
        proof_floor=payload(payloads, "proof_floor"),
        capital_reentry_cohort_ledger=payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        quality_adjusted_profit_frontier=payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        profit_repair_settlement_ledger=payload(
            payloads, "profit_repair_settlement_ledger"
        ),
        route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
        live_submission_gate=build.core.live_submission_gate,
        quant_evidence=build.context.quant_evidence,
        market_context_status=build.context.market_context_status,
    )


def _profit_freshness_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_profit_freshness_frontier_payload(
        torghut_revision=active_revision(build),
        dependency_quorum=dependency_quorum_payload(build),
        proof_floor=payload(build.payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        quality_adjusted_profit_frontier=payload(
            build.payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=payload(build.payloads, "route_reacquisition_board"),
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
        torghut_revision=active_revision(build),
        dependency_quorum=dependency_quorum_payload(build),
        hypothesis_payload=build.core.hypothesis_payload,
        quant_evidence=build.context.quant_evidence,
        market_context_status=build.context.market_context_status,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        proof_floor=payload(build.payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_signal_quorum=payload(build.payloads, "profit_signal_quorum"),
        live_submission_gate=build.core.live_submission_gate,
        build=payload(build.payloads, "build_payload"),
        clickhouse_ta_status=build.core.clickhouse_ta_status,
    )


def _clock_settlement_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_clock_settlement_payload(
        torghut_revision=active_revision(build),
        source_commit=BUILD_COMMIT,
        build=payload(build.payloads, "build_payload"),
        evidence_clock_arbiter=payload(build.payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=payload(
            build.payloads, "routeable_profit_candidate_exchange"
        ),
        clickhouse_ta_status=build.core.clickhouse_ta_status,
        quant_evidence=build.context.quant_evidence,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        profit_signal_quorum=payload(build.payloads, "profit_signal_quorum"),
        rollout_status=build.deps.build_route_image_proof_summary(
            build=payload(build.payloads, "build_payload"),
            dependency_quorum=dependency_quorum_payload(build),
        ),
    )


def _route_evidence_packet(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_route_evidence_clearinghouse_payload(
        torghut_revision=active_revision(build),
        source_commit=BUILD_COMMIT,
        dependency_quorum=dependency_quorum_payload(build),
        build=payload(build.payloads, "build_payload"),
        proof_floor=payload(build.payloads, "proof_floor"),
        profit_signal_quorum=payload(build.payloads, "profit_signal_quorum"),
        profit_repair_settlement_ledger=payload(
            build.payloads, "profit_repair_settlement_ledger"
        ),
        route_reacquisition_board=payload(build.payloads, "route_reacquisition_board"),
        routeability_repair_acceptance_ledger=payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        live_submission_gate=build.core.live_submission_gate,
        tca_summary=build.core.tca_summary,
        options_catalog_freshness=payload(build.payloads, "options_catalog_freshness"),
    )


def _repair_bid_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_repair_bid_settlement_payload(
        torghut_revision=active_revision(build),
        source_commit=BUILD_COMMIT,
        dependency_quorum=dependency_quorum_payload(build),
        build=payload(build.payloads, "build_payload"),
        route_evidence_clearinghouse_packet=payload(
            build.payloads, "route_evidence_clearinghouse_packet"
        ),
        routeability_repair_acceptance_ledger=payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        quant_evidence=build.context.quant_evidence,
        profit_freshness_frontier=payload(build.payloads, "profit_freshness_frontier"),
    )


def _route_warrant_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_route_warrant_exchange_payload(
        torghut_revision=active_revision(build),
        source_commit=BUILD_COMMIT,
        build=payload(build.payloads, "build_payload"),
        consumer_evidence_receipt=payload(build.payloads, "consumer_evidence_receipt"),
        evidence_clock_arbiter=payload(build.payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=payload(
            build.payloads, "routeable_profit_candidate_exchange"
        ),
        routeability_repair_acceptance_ledger=payload(
            build.payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_freshness_frontier=payload(build.payloads, "profit_freshness_frontier"),
        live_submission_gate=build.core.live_submission_gate,
        quant_evidence=build.context.quant_evidence,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        market_context_status=build.context.market_context_status,
    )


def _source_serving_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=payload(build.payloads, "build_payload"),
        consumer_evidence_receipt=payload(build.payloads, "consumer_evidence_receipt"),
        route_evidence_clearinghouse_packet=payload(
            build.payloads, "route_evidence_clearinghouse_packet"
        ),
        repair_bid_settlement_ledger=payload(
            build.payloads, "repair_bid_settlement_ledger"
        ),
        route_warrant_exchange=payload(build.payloads, "route_warrant_exchange"),
    )


def _freshness_carry_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=payload(
            build.payloads, "source_serving_repair_receipt_ledger"
        ),
        route_warrant_exchange=payload(build.payloads, "route_warrant_exchange"),
        clickhouse_ta_status=build.core.clickhouse_ta_status,
        tca_summary=build.core.tca_summary,
        empirical_jobs_status=build.context.empirical_jobs,
        market_context_status=build.context.market_context_status,
        quant_evidence=build.context.quant_evidence,
        live_submission_gate=build.core.live_submission_gate,
    )


def _repair_receipt_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_repair_receipt_frontier_payload(
        torghut_revision=active_revision(build),
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=payload(
            build.payloads, "source_serving_repair_receipt_ledger"
        ),
        freshness_carry_ledger=payload(build.payloads, "freshness_carry_ledger"),
        repair_bid_settlement_ledger=payload(
            build.payloads, "repair_bid_settlement_ledger"
        ),
        profit_freshness_frontier=payload(build.payloads, "profit_freshness_frontier"),
        route_warrant_exchange=payload(build.payloads, "route_warrant_exchange"),
        live_submission_gate=build.core.live_submission_gate,
        proof_floor=payload(build.payloads, "proof_floor"),
    )


def _repair_outcome_payload(build: TradingStatusResponseBuild) -> dict[str, object]:
    return build.deps.build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=payload(
            build.payloads, "repair_bid_settlement_ledger"
        ),
        repair_receipt_frontier=payload(build.payloads, "repair_receipt_frontier"),
        freshness_carry_ledger=payload(build.payloads, "freshness_carry_ledger"),
        route_warrant_exchange=payload(build.payloads, "route_warrant_exchange"),
        live_submission_gate=build.core.live_submission_gate,
    )
