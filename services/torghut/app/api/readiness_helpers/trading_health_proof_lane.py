"""Proof-lane read-model assembly for the Torghut trading health surface."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import cast

from sqlalchemy.exc import SQLAlchemyError

from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST, BUILD_VERSION
from app.config import settings
from app.trading.hypotheses import JangarDependencyQuorumStatus

from .trading_health_context import TradingHealthContext
from .trading_health_dependencies import TradingHealthDependencySnapshot

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


def build_trading_health_proof_lane(
    context: TradingHealthContext,
    dependency_snapshot: TradingHealthDependencySnapshot,
    *,
    deps: TradingHealthProofLaneDependencies,
) -> TradingHealthProofLane:
    proof_lane = TradingHealthProofLane(
        context=context,
        dependencies=dict(dependency_snapshot.dependencies),
        deps=deps,
    )
    _add_alpha_readiness(proof_lane)
    _add_live_gate_and_proof_floor(proof_lane)
    _add_primary_payloads(proof_lane)
    _add_repair_payloads(proof_lane)
    _add_dependency_statuses(proof_lane)
    return proof_lane


def _add_alpha_readiness(proof_lane: TradingHealthProofLane) -> None:
    deps = proof_lane.deps
    scheduler = proof_lane.context.scheduler
    market_context_status = scheduler.market_context_status()
    payloads = proof_lane.payloads
    payloads["market_context_status"] = market_context_status
    payloads["tca_summary"] = {}
    payloads["hypothesis_payload"] = {}
    try:
        with deps.session_factory() as session:
            payloads["tca_summary"] = deps.load_tca_summary(
                session,
                scheduler=scheduler,
            )
        hypothesis_payload, hypothesis_summary, dependency_quorum = (
            deps.build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=_payload(payloads, "tca_summary"),
                market_context_status=market_context_status,
            )
        )
    except (SQLAlchemyError, RuntimeError, ValueError, KeyError, TypeError) as exc:
        proof_lane.alpha_readiness = _unavailable_alpha_readiness(str(exc))
        proof_lane.dependency_quorum = JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["alpha_readiness_unavailable"],
            message=str(exc),
        )
        payloads["hypothesis_summary"] = {}
        return

    payloads["hypothesis_payload"] = hypothesis_payload
    payloads["hypothesis_summary"] = hypothesis_summary
    proof_lane.dependency_quorum = dependency_quorum
    proof_lane.alpha_readiness = {
        "hypotheses_total": hypothesis_summary.get("hypotheses_total", 0),
        "state_totals": hypothesis_summary.get("state_totals", {}),
        "promotion_eligible_total": hypothesis_summary.get(
            "promotion_eligible_total", 0
        ),
        "rollback_required_total": hypothesis_summary.get("rollback_required_total", 0),
        "dependency_quorum": hypothesis_summary.get("dependency_quorum", {}),
    }


def _add_live_gate_and_proof_floor(proof_lane: TradingHealthProofLane) -> None:
    deps = proof_lane.deps
    scheduler = proof_lane.context.scheduler
    payloads = proof_lane.payloads
    llm_status = scheduler.llm_status()
    raw_dspy_runtime = llm_status.get("dspy_runtime")
    dspy_runtime = (
        cast(dict[str, object], raw_dspy_runtime)
        if isinstance(raw_dspy_runtime, dict)
        else {}
    )
    payloads["dspy_runtime"] = dspy_runtime
    empirical_jobs = deps.empirical_jobs_status()
    quant_evidence = deps.load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    payloads["empirical_jobs"] = empirical_jobs
    payloads["quant_evidence"] = quant_evidence
    with deps.session_factory() as session:
        payloads["live_submission_gate"] = deps.build_api_live_submission_gate_payload(
            scheduler.state,
            session=session,
            hypothesis_summary=_payload(payloads, "hypothesis_payload"),
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=dspy_runtime,
            quant_health_status=quant_evidence,
        )
    payloads["proof_floor"] = deps.build_profitability_proof_floor_payload(
        state=scheduler.state,
        torghut_revision=BUILD_COMMIT,
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        hypothesis_payload=_payload(payloads, "hypothesis_payload"),
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=_payload(payloads, "market_context_status"),
        tca_summary=_payload(payloads, "tca_summary"),
    )


def _add_primary_payloads(proof_lane: TradingHealthProofLane) -> None:
    deps = proof_lane.deps
    payloads = proof_lane.payloads
    payloads["renewal_bond_profit_escrow"] = (
        deps.build_renewal_bond_profit_escrow_payload(
            state=proof_lane.context.scheduler.state,
            torghut_revision=BUILD_COMMIT,
            dependency_quorum=proof_lane.dependency_quorum.as_payload(),
            live_submission_gate=_payload(payloads, "live_submission_gate"),
            proof_floor=_payload(payloads, "proof_floor"),
            hypothesis_payload=_payload(payloads, "hypothesis_payload"),
            empirical_jobs_status=_payload(payloads, "empirical_jobs"),
            quant_evidence=_payload(payloads, "quant_evidence"),
            market_context_status=_payload(payloads, "market_context_status"),
            tca_summary=_payload(payloads, "tca_summary"),
        )
    )
    payloads["route_reacquisition_board"] = (
        deps.build_route_reacquisition_board_payload(
            proof_floor=_payload(payloads, "proof_floor"),
            active_revision=BUILD_COMMIT,
        )
    )
    payloads["profit_signal_quorum"] = deps.build_profit_signal_quorum_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        hypothesis_payload=_payload(payloads, "hypothesis_payload"),
        quant_evidence=_payload(payloads, "quant_evidence"),
        market_context_status=_payload(payloads, "market_context_status"),
        proof_floor=_payload(payloads, "proof_floor"),
        route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
    )
    route_symbols = deps.route_claim_symbols(_payload(payloads, "profit_signal_quorum"))
    with deps.session_factory() as session:
        payloads["options_catalog_freshness"] = (
            deps.load_options_catalog_freshness_summary(
                session,
                route_symbols=route_symbols,
            )
        )
    _add_capital_and_consumer_payloads(proof_lane)


def _add_capital_and_consumer_payloads(proof_lane: TradingHealthProofLane) -> None:
    deps = proof_lane.deps
    payloads = proof_lane.payloads
    payloads["capital_replay_projection"] = (
        deps.build_capital_replay_projection_payload(
            torghut_revision=BUILD_COMMIT,
            dependency_quorum=proof_lane.dependency_quorum.as_payload(),
            live_submission_gate=_payload(payloads, "live_submission_gate"),
            proof_floor=_payload(payloads, "proof_floor"),
            route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
            empirical_jobs_status=_payload(payloads, "empirical_jobs"),
            quant_evidence=_payload(payloads, "quant_evidence"),
            market_context_status=_payload(payloads, "market_context_status"),
        )
    )
    payloads["quality_adjusted_profit_frontier"] = (
        deps.build_quality_adjusted_profit_frontier_payload(
            torghut_revision=BUILD_COMMIT,
            live_submission_gate=_payload(payloads, "live_submission_gate"),
            proof_floor=_payload(payloads, "proof_floor"),
            route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
            hypothesis_payload=_payload(payloads, "hypothesis_payload"),
            quant_evidence=_payload(payloads, "quant_evidence"),
            market_context_status=_payload(payloads, "market_context_status"),
            active_simulation_context=deps.active_simulation_runtime_context(),
        )
    )
    consumer_receipt, route_receipt = deps.build_consumer_evidence_receipt_projection(
        forecast_service_status=deps.forecast_service_status(
            _payload(payloads, "empirical_jobs")
        ),
        empirical_jobs_status=_payload(payloads, "empirical_jobs"),
        proof_floor=_payload(payloads, "proof_floor"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        serving_revision=deps.active_runtime_revision() or BUILD_COMMIT,
    )
    payloads["consumer_evidence_receipt"] = consumer_receipt
    payloads["route_proven_profit_receipt"] = route_receipt


def _add_repair_payloads(proof_lane: TradingHealthProofLane) -> None:
    payloads = proof_lane.payloads
    payloads["capital_reentry_cohort_ledger"] = _capital_reentry_payload(proof_lane)
    payloads["profit_repair_settlement_ledger"] = _profit_repair_payload(proof_lane)
    payloads["routeability_repair_acceptance_ledger"] = _routeability_payload(
        proof_lane
    )
    payloads["profit_freshness_frontier"] = _profit_freshness_payload(proof_lane)
    evidence_clock, candidate_exchange = _evidence_clock_payloads(proof_lane)
    payloads["evidence_clock_arbiter"] = evidence_clock
    payloads["routeable_profit_candidate_exchange"] = candidate_exchange
    payloads["clock_settlement_receipt"] = _clock_settlement_payload(proof_lane)
    payloads["route_evidence_clearinghouse_packet"] = _route_evidence_payload(
        proof_lane
    )
    payloads["repair_bid_settlement_ledger"] = _repair_bid_payload(proof_lane)
    payloads["route_warrant_exchange"] = _route_warrant_payload(proof_lane)
    payloads["source_serving_repair_receipt_ledger"] = _source_serving_payload(
        proof_lane
    )
    payloads["freshness_carry_ledger"] = _freshness_carry_payload(proof_lane)
    payloads["repair_receipt_frontier"] = _repair_receipt_payload(proof_lane)
    payloads["repair_outcome_dividend_ledger"] = _repair_outcome_payload(proof_lane)


def _add_dependency_statuses(proof_lane: TradingHealthProofLane) -> None:
    payloads = proof_lane.payloads
    live_mode = settings.trading_mode == "live"
    empirical_jobs_required = (
        live_mode and settings.trading_empirical_jobs_health_required
    )
    empirical_jobs = _payload(payloads, "empirical_jobs")
    dspy_runtime = _payload(payloads, "dspy_runtime")
    live_submission_gate = _payload(payloads, "live_submission_gate")
    proof_floor = _payload(payloads, "proof_floor")
    quant_evidence = _payload(payloads, "quant_evidence")
    proof_lane.dependencies["empirical_jobs"] = {
        "ok": bool(empirical_jobs.get("ready")) if empirical_jobs_required else True,
        "detail": (
            str(empirical_jobs.get("status") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "authority": empirical_jobs.get("authority"),
        "required": empirical_jobs_required,
    }
    proof_lane.dependencies["dspy_runtime"] = _dspy_runtime_dependency(dspy_runtime)
    proof_lane.dependencies["live_submission_gate"] = {
        "ok": bool(live_submission_gate.get("allowed", False)),
        "detail": str(live_submission_gate.get("reason") or "unknown"),
        "capital_stage": live_submission_gate.get("capital_stage"),
    }
    proof_lane.dependencies["profitability_proof_floor"] = {
        "ok": str(proof_floor.get("route_state") or "") != "repair_only"
        if live_mode
        else True,
        "detail": str(proof_floor.get("route_state") or "unknown"),
        "capital_state": proof_floor.get("capital_state"),
        "required": live_mode,
    }
    proof_lane.dependencies["quant_evidence"] = {
        "ok": bool(quant_evidence.get("ok", True))
        if live_mode and bool(quant_evidence.get("required", False))
        else True,
        "detail": (
            str(quant_evidence.get("reason") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "required": bool(quant_evidence.get("required", False)),
        "window": quant_evidence.get("window"),
    }


def _capital_reentry_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    return proof_lane.deps.build_capital_reentry_cohort_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        consumer_evidence_receipt=_payload(
            proof_lane.payloads, "consumer_evidence_receipt"
        ),
        proof_floor=_payload(proof_lane.payloads, "proof_floor"),
        route_reacquisition_board=_payload(
            proof_lane.payloads, "route_reacquisition_board"
        ),
    )


def _profit_repair_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_profit_repair_settlement_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        consumer_evidence_receipt=_payload(payloads, "consumer_evidence_receipt"),
        proof_floor=_payload(payloads, "proof_floor"),
        capital_reentry_cohort_ledger=_payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        quality_adjusted_profit_frontier=_payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        quant_evidence=_payload(payloads, "quant_evidence"),
    )


def _routeability_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_routeability_repair_acceptance_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
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
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        quant_evidence=_payload(payloads, "quant_evidence"),
        market_context_status=_payload(payloads, "market_context_status"),
    )


def _profit_freshness_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_profit_freshness_frontier_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        proof_floor=_payload(payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=_payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        quality_adjusted_profit_frontier=_payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        quant_evidence=_payload(payloads, "quant_evidence"),
        market_context_status=_payload(payloads, "market_context_status"),
        empirical_jobs_status=_payload(payloads, "empirical_jobs"),
        hypothesis_payload=_payload(payloads, "hypothesis_payload"),
    )


def _evidence_clock_payloads(
    proof_lane: TradingHealthProofLane,
) -> tuple[dict[str, object], dict[str, object]]:
    payloads = proof_lane.payloads
    payloads["build_payload"] = _build_payload(proof_lane)
    payloads["clickhouse_ta_status"] = proof_lane.deps.load_clickhouse_ta_status(
        proof_lane.context.scheduler
    )
    return proof_lane.deps.build_evidence_clock_payloads(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        hypothesis_payload=_payload(payloads, "hypothesis_payload"),
        quant_evidence=_payload(payloads, "quant_evidence"),
        market_context_status=_payload(payloads, "market_context_status"),
        tca_summary=_payload(payloads, "tca_summary"),
        empirical_jobs_status=_payload(payloads, "empirical_jobs"),
        proof_floor=_payload(payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=_payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_signal_quorum=_payload(payloads, "profit_signal_quorum"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        build=_payload(payloads, "build_payload"),
        clickhouse_ta_status=_payload(payloads, "clickhouse_ta_status"),
    )


def _clock_settlement_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_clock_settlement_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        build=_payload(payloads, "build_payload"),
        evidence_clock_arbiter=_payload(payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=_payload(
            payloads, "routeable_profit_candidate_exchange"
        ),
        clickhouse_ta_status=_payload(payloads, "clickhouse_ta_status"),
        quant_evidence=_payload(payloads, "quant_evidence"),
        tca_summary=_payload(payloads, "tca_summary"),
        empirical_jobs_status=_payload(payloads, "empirical_jobs"),
        profit_signal_quorum=_payload(payloads, "profit_signal_quorum"),
        rollout_status=proof_lane.deps.build_route_image_proof_summary(
            build=_payload(payloads, "build_payload"),
            dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        ),
    )


def _route_evidence_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_route_evidence_clearinghouse_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        build=_payload(payloads, "build_payload"),
        proof_floor=_payload(payloads, "proof_floor"),
        profit_signal_quorum=_payload(payloads, "profit_signal_quorum"),
        profit_repair_settlement_ledger=_payload(
            payloads, "profit_repair_settlement_ledger"
        ),
        route_reacquisition_board=_payload(payloads, "route_reacquisition_board"),
        routeability_repair_acceptance_ledger=_payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        tca_summary=_payload(payloads, "tca_summary"),
        options_catalog_freshness=_payload(payloads, "options_catalog_freshness"),
    )


def _repair_bid_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_repair_bid_settlement_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        build=_payload(payloads, "build_payload"),
        route_evidence_clearinghouse_packet=_payload(
            payloads, "route_evidence_clearinghouse_packet"
        ),
        routeability_repair_acceptance_ledger=_payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        quant_evidence=_payload(payloads, "quant_evidence"),
        profit_freshness_frontier=_payload(payloads, "profit_freshness_frontier"),
    )


def _route_warrant_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_route_warrant_exchange_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        build=_payload(payloads, "build_payload"),
        consumer_evidence_receipt=_payload(payloads, "consumer_evidence_receipt"),
        evidence_clock_arbiter=_payload(payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=_payload(
            payloads, "routeable_profit_candidate_exchange"
        ),
        routeability_repair_acceptance_ledger=_payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_freshness_frontier=_payload(payloads, "profit_freshness_frontier"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        quant_evidence=_payload(payloads, "quant_evidence"),
        tca_summary=_payload(payloads, "tca_summary"),
        empirical_jobs_status=_payload(payloads, "empirical_jobs"),
        market_context_status=_payload(payloads, "market_context_status"),
    )


def _source_serving_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=_payload(payloads, "build_payload"),
        consumer_evidence_receipt=_payload(payloads, "consumer_evidence_receipt"),
        route_evidence_clearinghouse_packet=_payload(
            payloads, "route_evidence_clearinghouse_packet"
        ),
        repair_bid_settlement_ledger=_payload(payloads, "repair_bid_settlement_ledger"),
        route_warrant_exchange=_payload(payloads, "route_warrant_exchange"),
    )


def _freshness_carry_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=_payload(
            payloads, "source_serving_repair_receipt_ledger"
        ),
        route_warrant_exchange=_payload(payloads, "route_warrant_exchange"),
        clickhouse_ta_status=_payload(payloads, "clickhouse_ta_status"),
        tca_summary=_payload(payloads, "tca_summary"),
        empirical_jobs_status=_payload(payloads, "empirical_jobs"),
        market_context_status=_payload(payloads, "market_context_status"),
        quant_evidence=_payload(payloads, "quant_evidence"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
    )


def _repair_receipt_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_repair_receipt_frontier_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=_payload(
            payloads, "source_serving_repair_receipt_ledger"
        ),
        freshness_carry_ledger=_payload(payloads, "freshness_carry_ledger"),
        repair_bid_settlement_ledger=_payload(payloads, "repair_bid_settlement_ledger"),
        profit_freshness_frontier=_payload(payloads, "profit_freshness_frontier"),
        route_warrant_exchange=_payload(payloads, "route_warrant_exchange"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
        proof_floor=_payload(payloads, "proof_floor"),
    )


def _repair_outcome_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=_payload(payloads, "repair_bid_settlement_ledger"),
        repair_receipt_frontier=_payload(payloads, "repair_receipt_frontier"),
        freshness_carry_ledger=_payload(payloads, "freshness_carry_ledger"),
        route_warrant_exchange=_payload(payloads, "route_warrant_exchange"),
        live_submission_gate=_payload(payloads, "live_submission_gate"),
    )


def _dspy_runtime_dependency(dspy_runtime: Mapping[str, object]) -> dict[str, object]:
    live_ready = bool(dspy_runtime.get("live_ready", False))
    active_mode = str(dspy_runtime.get("mode") or "").strip().lower() == "active"
    reasons = [
        str(item).strip()
        for item in cast(list[object], dspy_runtime.get("readiness_reasons") or [])
        if str(item).strip()
    ]
    return {
        "ok": live_ready if active_mode else True,
        "detail": "ready" if live_ready else ", ".join(reasons) or "not_ready",
        "artifact_hash": dspy_runtime.get("artifact_hash"),
    }


def _unavailable_alpha_readiness(message: str) -> dict[str, object]:
    return {
        "hypotheses_total": 0,
        "state_totals": {},
        "promotion_eligible_total": 0,
        "rollback_required_total": 0,
        "dependency_quorum": {
            "decision": "unknown",
            "reasons": ["alpha_readiness_unavailable"],
            "message": message,
        },
    }


def _build_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    return {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": proof_lane.deps.active_runtime_revision() or BUILD_COMMIT,
    }


def _payload(payloads: dict[str, object], key: str) -> dict[str, object]:
    return cast(dict[str, object], payloads[key])


__all__ = [
    "TradingHealthProofLane",
    "TradingHealthProofLaneDependencies",
    "build_trading_health_proof_lane",
]
