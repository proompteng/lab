"""Proof-lane read-model assembly for the Torghut trading health surface."""

from __future__ import annotations

from typing import cast

from sqlalchemy.exc import SQLAlchemyError

from app.api.build_metadata import BUILD_COMMIT
from app.config import settings
from app.trading.hypotheses import JangarDependencyQuorumStatus

from .trading_health_context import TradingHealthContext
from .trading_health_dependencies import TradingHealthDependencySnapshot
from .trading_health_proof_lane_dependency_status import add_dependency_statuses
from .trading_health_proof_lane_model import (
    TradingHealthProofLane,
    TradingHealthProofLaneDependencies,
    payload,
)
from .trading_health_proof_lane_repair_payloads import add_repair_payloads


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
    _add_clickhouse_ta_status(proof_lane)
    _add_alpha_readiness(proof_lane)
    _add_live_gate_and_proof_floor(proof_lane)
    _add_primary_payloads(proof_lane)
    add_repair_payloads(proof_lane)
    add_dependency_statuses(proof_lane)
    return proof_lane


def _add_clickhouse_ta_status(proof_lane: TradingHealthProofLane) -> None:
    proof_lane.payloads["clickhouse_ta_status"] = (
        proof_lane.deps.load_clickhouse_ta_status(proof_lane.context.scheduler)
    )


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
                tca_summary=payload(payloads, "tca_summary"),
                market_context_status=market_context_status,
                feature_readiness=payload(payloads, "clickhouse_ta_status"),
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
            hypothesis_summary=payload(payloads, "hypothesis_payload"),
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=dspy_runtime,
            quant_health_status=quant_evidence,
            clickhouse_ta_status=payload(payloads, "clickhouse_ta_status"),
        )
    payloads["proof_floor"] = deps.build_profitability_proof_floor_payload(
        state=scheduler.state,
        torghut_revision=BUILD_COMMIT,
        live_submission_gate=payload(payloads, "live_submission_gate"),
        hypothesis_payload=payload(payloads, "hypothesis_payload"),
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=payload(payloads, "market_context_status"),
        tca_summary=payload(payloads, "tca_summary"),
    )


def _add_primary_payloads(proof_lane: TradingHealthProofLane) -> None:
    deps = proof_lane.deps
    payloads = proof_lane.payloads
    payloads["renewal_bond_profit_escrow"] = (
        deps.build_renewal_bond_profit_escrow_payload(
            state=proof_lane.context.scheduler.state,
            torghut_revision=BUILD_COMMIT,
            dependency_quorum=proof_lane.dependency_quorum.as_payload(),
            live_submission_gate=payload(payloads, "live_submission_gate"),
            proof_floor=payload(payloads, "proof_floor"),
            hypothesis_payload=payload(payloads, "hypothesis_payload"),
            empirical_jobs_status=payload(payloads, "empirical_jobs"),
            quant_evidence=payload(payloads, "quant_evidence"),
            market_context_status=payload(payloads, "market_context_status"),
            tca_summary=payload(payloads, "tca_summary"),
        )
    )
    payloads["route_reacquisition_board"] = (
        deps.build_route_reacquisition_board_payload(
            proof_floor=payload(payloads, "proof_floor"),
            active_revision=BUILD_COMMIT,
        )
    )
    payloads["profit_signal_quorum"] = deps.build_profit_signal_quorum_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        hypothesis_payload=payload(payloads, "hypothesis_payload"),
        quant_evidence=payload(payloads, "quant_evidence"),
        market_context_status=payload(payloads, "market_context_status"),
        proof_floor=payload(payloads, "proof_floor"),
        route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
    )
    route_symbols = deps.route_claim_symbols(payload(payloads, "profit_signal_quorum"))
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
            live_submission_gate=payload(payloads, "live_submission_gate"),
            proof_floor=payload(payloads, "proof_floor"),
            route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
            empirical_jobs_status=payload(payloads, "empirical_jobs"),
            quant_evidence=payload(payloads, "quant_evidence"),
            market_context_status=payload(payloads, "market_context_status"),
        )
    )
    payloads["quality_adjusted_profit_frontier"] = (
        deps.build_quality_adjusted_profit_frontier_payload(
            torghut_revision=BUILD_COMMIT,
            live_submission_gate=payload(payloads, "live_submission_gate"),
            proof_floor=payload(payloads, "proof_floor"),
            route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
            hypothesis_payload=payload(payloads, "hypothesis_payload"),
            quant_evidence=payload(payloads, "quant_evidence"),
            market_context_status=payload(payloads, "market_context_status"),
            active_simulation_context=deps.active_simulation_runtime_context(),
        )
    )
    consumer_receipt, route_receipt = deps.build_consumer_evidence_receipt_projection(
        forecast_service_status=deps.forecast_service_status(
            payload(payloads, "empirical_jobs")
        ),
        empirical_jobs_status=payload(payloads, "empirical_jobs"),
        proof_floor=payload(payloads, "proof_floor"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
        serving_revision=deps.active_runtime_revision() or BUILD_COMMIT,
    )
    payloads["consumer_evidence_receipt"] = consumer_receipt
    payloads["route_proven_profit_receipt"] = route_receipt


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


__all__ = [
    "TradingHealthProofLane",
    "TradingHealthProofLaneDependencies",
    "build_trading_health_proof_lane",
]
