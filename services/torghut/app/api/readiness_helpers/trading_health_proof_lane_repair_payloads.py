"""Repair payload assembly for the Torghut trading health proof lane."""

from __future__ import annotations

from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST, BUILD_VERSION

from .trading_health_proof_lane_model import TradingHealthProofLane, payload


def add_repair_payloads(proof_lane: TradingHealthProofLane) -> None:
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


def _capital_reentry_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    return proof_lane.deps.build_capital_reentry_cohort_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        consumer_evidence_receipt=payload(
            proof_lane.payloads, "consumer_evidence_receipt"
        ),
        proof_floor=payload(proof_lane.payloads, "proof_floor"),
        route_reacquisition_board=payload(
            proof_lane.payloads, "route_reacquisition_board"
        ),
    )


def _profit_repair_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_profit_repair_settlement_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        consumer_evidence_receipt=payload(payloads, "consumer_evidence_receipt"),
        proof_floor=payload(payloads, "proof_floor"),
        capital_reentry_cohort_ledger=payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        quality_adjusted_profit_frontier=payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
        quant_evidence=payload(payloads, "quant_evidence"),
    )


def _routeability_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_routeability_repair_acceptance_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
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
        live_submission_gate=payload(payloads, "live_submission_gate"),
        quant_evidence=payload(payloads, "quant_evidence"),
        market_context_status=payload(payloads, "market_context_status"),
    )


def _profit_freshness_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_profit_freshness_frontier_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        proof_floor=payload(payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        quality_adjusted_profit_frontier=payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
        quant_evidence=payload(payloads, "quant_evidence"),
        market_context_status=payload(payloads, "market_context_status"),
        empirical_jobs_status=payload(payloads, "empirical_jobs"),
        hypothesis_payload=payload(payloads, "hypothesis_payload"),
    )


def _evidence_clock_payloads(
    proof_lane: TradingHealthProofLane,
) -> tuple[dict[str, object], dict[str, object]]:
    payloads = proof_lane.payloads
    payloads["build_payload"] = _build_payload(proof_lane)
    if "clickhouse_ta_status" not in payloads:
        payloads["clickhouse_ta_status"] = proof_lane.deps.load_clickhouse_ta_status(
            proof_lane.context.scheduler
        )
    return proof_lane.deps.build_evidence_clock_payloads(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        hypothesis_payload=payload(payloads, "hypothesis_payload"),
        quant_evidence=payload(payloads, "quant_evidence"),
        market_context_status=payload(payloads, "market_context_status"),
        tca_summary=payload(payloads, "tca_summary"),
        empirical_jobs_status=payload(payloads, "empirical_jobs"),
        proof_floor=payload(payloads, "proof_floor"),
        routeability_repair_acceptance_ledger=payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_signal_quorum=payload(payloads, "profit_signal_quorum"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
        build=payload(payloads, "build_payload"),
        clickhouse_ta_status=payload(payloads, "clickhouse_ta_status"),
    )


def _clock_settlement_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_clock_settlement_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        build=payload(payloads, "build_payload"),
        evidence_clock_arbiter=payload(payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=payload(
            payloads, "routeable_profit_candidate_exchange"
        ),
        clickhouse_ta_status=payload(payloads, "clickhouse_ta_status"),
        quant_evidence=payload(payloads, "quant_evidence"),
        tca_summary=payload(payloads, "tca_summary"),
        empirical_jobs_status=payload(payloads, "empirical_jobs"),
        profit_signal_quorum=payload(payloads, "profit_signal_quorum"),
        rollout_status=proof_lane.deps.build_route_image_proof_summary(
            build=payload(payloads, "build_payload"),
            dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        ),
    )


def _route_evidence_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_route_evidence_clearinghouse_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        build=payload(payloads, "build_payload"),
        proof_floor=payload(payloads, "proof_floor"),
        profit_signal_quorum=payload(payloads, "profit_signal_quorum"),
        profit_repair_settlement_ledger=payload(
            payloads, "profit_repair_settlement_ledger"
        ),
        route_reacquisition_board=payload(payloads, "route_reacquisition_board"),
        routeability_repair_acceptance_ledger=payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        live_submission_gate=payload(payloads, "live_submission_gate"),
        tca_summary=payload(payloads, "tca_summary"),
        options_catalog_freshness=payload(payloads, "options_catalog_freshness"),
    )


def _repair_bid_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_repair_bid_settlement_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        dependency_quorum=proof_lane.dependency_quorum.as_payload(),
        build=payload(payloads, "build_payload"),
        route_evidence_clearinghouse_packet=payload(
            payloads, "route_evidence_clearinghouse_packet"
        ),
        routeability_repair_acceptance_ledger=payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        quant_evidence=payload(payloads, "quant_evidence"),
        profit_freshness_frontier=payload(payloads, "profit_freshness_frontier"),
    )


def _route_warrant_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_route_warrant_exchange_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        build=payload(payloads, "build_payload"),
        consumer_evidence_receipt=payload(payloads, "consumer_evidence_receipt"),
        evidence_clock_arbiter=payload(payloads, "evidence_clock_arbiter"),
        routeable_profit_candidate_exchange=payload(
            payloads, "routeable_profit_candidate_exchange"
        ),
        routeability_repair_acceptance_ledger=payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        profit_freshness_frontier=payload(payloads, "profit_freshness_frontier"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
        quant_evidence=payload(payloads, "quant_evidence"),
        tca_summary=payload(payloads, "tca_summary"),
        empirical_jobs_status=payload(payloads, "empirical_jobs"),
        market_context_status=payload(payloads, "market_context_status"),
    )


def _source_serving_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=payload(payloads, "build_payload"),
        consumer_evidence_receipt=payload(payloads, "consumer_evidence_receipt"),
        route_evidence_clearinghouse_packet=payload(
            payloads, "route_evidence_clearinghouse_packet"
        ),
        repair_bid_settlement_ledger=payload(payloads, "repair_bid_settlement_ledger"),
        route_warrant_exchange=payload(payloads, "route_warrant_exchange"),
    )


def _freshness_carry_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=payload(
            payloads, "source_serving_repair_receipt_ledger"
        ),
        route_warrant_exchange=payload(payloads, "route_warrant_exchange"),
        clickhouse_ta_status=payload(payloads, "clickhouse_ta_status"),
        tca_summary=payload(payloads, "tca_summary"),
        empirical_jobs_status=payload(payloads, "empirical_jobs"),
        market_context_status=payload(payloads, "market_context_status"),
        quant_evidence=payload(payloads, "quant_evidence"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
    )


def _repair_receipt_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_repair_receipt_frontier_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=payload(
            payloads, "source_serving_repair_receipt_ledger"
        ),
        freshness_carry_ledger=payload(payloads, "freshness_carry_ledger"),
        repair_bid_settlement_ledger=payload(payloads, "repair_bid_settlement_ledger"),
        profit_freshness_frontier=payload(payloads, "profit_freshness_frontier"),
        route_warrant_exchange=payload(payloads, "route_warrant_exchange"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
        proof_floor=payload(payloads, "proof_floor"),
    )


def _repair_outcome_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    payloads = proof_lane.payloads
    return proof_lane.deps.build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=payload(payloads, "repair_bid_settlement_ledger"),
        repair_receipt_frontier=payload(payloads, "repair_receipt_frontier"),
        freshness_carry_ledger=payload(payloads, "freshness_carry_ledger"),
        route_warrant_exchange=payload(payloads, "route_warrant_exchange"),
        live_submission_gate=payload(payloads, "live_submission_gate"),
    )


def _build_payload(proof_lane: TradingHealthProofLane) -> dict[str, object]:
    return {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": proof_lane.deps.active_runtime_revision() or BUILD_COMMIT,
    }


__all__ = ["add_repair_payloads"]
