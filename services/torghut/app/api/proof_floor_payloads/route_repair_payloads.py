"""Route repair proof-floor payload builders."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

from app.api.build_metadata import (
    BUILD_ARGO_HEALTH,
    BUILD_ARGO_SYNC_REVISION,
    BUILD_MANIFEST_COMMIT,
    BUILD_MANIFEST_IMAGE_DIGEST,
    BUILD_SOURCE_CI_REF,
)
from app.config import settings
from app.trading.freshness_carry import build_freshness_carry_ledger
from app.trading.repair_bid_settlement import build_repair_bid_settlement_ledger
from app.trading.repair_outcome_dividend import build_repair_outcome_dividend_ledger
from app.trading.repair_receipt_frontier import build_repair_receipt_frontier
from app.trading.route_evidence_clearinghouse import (
    build_route_evidence_clearinghouse_packet,
)
from app.trading.route_warrant_exchange import build_route_warrant_exchange
from app.trading.source_serving_repair_receipt import (
    build_source_serving_repair_receipt_ledger,
)


def build_route_image_proof_summary(
    *, build: Mapping[str, Any], dependency_quorum: Mapping[str, Any]
) -> dict[str, object]:
    raw_proof = (
        dependency_quorum.get("rollout_image_book")
        or dependency_quorum.get("image_proof_summary")
        or dependency_quorum.get("rollout_image_proof")
    )
    empty_proof: Mapping[str, Any] = {}
    image_proof: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_proof)
        if isinstance(raw_proof, Mapping)
        else empty_proof
    )
    raw_reasons: object = (
        image_proof.get("reason_codes") or image_proof.get("blocking_reasons") or []
    )
    payload: dict[str, object] = {
        "image_digest": image_proof.get("image_digest") or build.get("image_digest"),
        "active_revision": image_proof.get("active_revision")
        or build.get("active_revision"),
        "rollback_digest": image_proof.get("rollback_digest"),
        "state": image_proof.get("state") or image_proof.get("status") or "unknown",
        "reason_codes": [
            str(item).strip()
            for item in cast(Sequence[object], raw_reasons)
            if str(item).strip()
        ],
    }
    if "route_workloads_ok" in image_proof:
        payload["route_workloads_ok"] = image_proof.get("route_workloads_ok")
    return payload


def build_route_evidence_clearinghouse_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    dependency_quorum: Mapping[str, Any],
    build: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    profit_repair_settlement_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    options_catalog_freshness: Mapping[str, Any],
) -> dict[str, object]:
    return build_route_evidence_clearinghouse_packet(
        account_label=settings.trading_account_label,
        session_id=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        proof_floor_receipt=proof_floor,
        profit_signal_quorum=profit_signal_quorum,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        profit_window_custody={
            "profit_window_contract": live_submission_gate.get(
                "profit_window_contract"
            ),
            "profit_lease_projection": live_submission_gate.get(
                "profit_lease_projection"
            ),
        },
        tca_summary=tca_summary,
        options_catalog_freshness=options_catalog_freshness,
        image_proof_summary=build_route_image_proof_summary(
            build=build,
            dependency_quorum=dependency_quorum,
        ),
        routeability_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
    )


def build_repair_bid_settlement_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    dependency_quorum: Mapping[str, Any],
    build: Mapping[str, Any],
    route_evidence_clearinghouse_packet: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_repair_bid_settlement_ledger(
        account_label=settings.trading_account_label,
        session_id=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_acceptance_ledger=routeability_repair_acceptance_ledger,
        active_run_dedupe_state={},
        jangar_scoped_quant_status=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
        rollout_image_summary=build_route_image_proof_summary(
            build=build,
            dependency_quorum=dependency_quorum,
        ),
    )


def build_route_warrant_exchange_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_route_warrant_exchange(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        market_context_status=market_context_status,
    )


def build_source_serving_repair_receipt_payload(
    *,
    source_commit: str | None,
    build: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    route_evidence_clearinghouse_packet: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
) -> dict[str, object]:
    return build_source_serving_repair_receipt_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        source_commit=source_commit,
        source_ci_ref=BUILD_SOURCE_CI_REF,
        manifest_commit=BUILD_MANIFEST_COMMIT,
        manifest_image_digest=BUILD_MANIFEST_IMAGE_DIGEST,
        argo_sync_revision=BUILD_ARGO_SYNC_REVISION,
        argo_health=BUILD_ARGO_HEALTH,
        build=build,
        observed_contract_payloads={
            "consumer_evidence_status": {
                "schema_version": "torghut.consumer-evidence-status.v1",
            },
            "consumer_evidence_receipt": consumer_evidence_receipt,
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
            "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
            "route_warrant_exchange": route_warrant_exchange,
        },
        route_warrant_exchange=route_warrant_exchange,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
    )


def build_freshness_carry_ledger_payload(
    *,
    source_serving_repair_receipt_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    return build_freshness_carry_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )


def build_repair_receipt_frontier_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    source_serving_repair_receipt_ledger: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    return build_repair_receipt_frontier(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
        proof_floor_receipt=proof_floor,
    )


def build_repair_outcome_dividend_ledger_payload(
    *,
    repair_bid_settlement_ledger: Mapping[str, Any],
    repair_receipt_frontier: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    return build_repair_outcome_dividend_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        repair_receipt_frontier=repair_receipt_frontier,
        freshness_carry_ledger=freshness_carry_ledger,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )


__all__ = (
    "build_freshness_carry_ledger_payload",
    "build_repair_bid_settlement_payload",
    "build_repair_outcome_dividend_ledger_payload",
    "build_repair_receipt_frontier_payload",
    "build_route_evidence_clearinghouse_payload",
    "build_route_image_proof_summary",
    "build_route_warrant_exchange_payload",
    "build_source_serving_repair_receipt_payload",
)
