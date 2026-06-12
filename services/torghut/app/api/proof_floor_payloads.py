"""Extracted Torghut API route and support functions."""

# pyright: reportUnusedImport=false
# ruff: noqa: F401,F403,F405
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .compat_typing import *

from .common import *
from .common import main_runtime_value
from .proxy import capture_module_exports


def _build_profitability_proof_floor_payload(
    *,
    state: object,
    torghut_revision: str | None,
    live_submission_gate: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_profitability_proof_floor_receipt(
        account_label=settings.trading_account_label,
        torghut_revision=torghut_revision,
        trading_mode=settings.trading_mode,
        market_session_open=cast(
            bool | None,
            getattr(state, "market_session_open", None),
        ),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        simple_lane_status=simple_lane_status or _build_simple_lane_status_payload(),
        tca_max_age_seconds=PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


def _build_renewal_bond_profit_escrow_payload(
    *,
    state: object,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
) -> dict[str, object]:
    return build_renewal_bond_profit_escrow(
        account_label=settings.trading_account_label,
        torghut_revision=torghut_revision,
        trading_mode=settings.trading_mode,
        market_session_open=cast(
            bool | None,
            getattr(state, "market_session_open", None),
        ),
        jangar_dependency_quorum=dependency_quorum,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        tca_max_age_seconds=PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


def _build_route_reacquisition_board_payload(
    *,
    proof_floor: Mapping[str, Any],
    active_revision: str | None,
) -> dict[str, object]:
    return build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        route_reacquisition_book=cast(
            Mapping[str, Any] | None,
            proof_floor.get("route_reacquisition_book"),
        ),
        active_revision=active_revision,
        jangar_continuity=_route_continuity_packet_for_proof_floor(proof_floor),
    )


def _build_jangar_contract_graduation_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    reasons = [
        str(item).strip()
        for item in cast(Sequence[object], dependency_quorum.get("reasons") or [])
        if str(item).strip()
    ]
    return {
        "contract_ref": "docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md",
        "state": "current" if decision == "allow" else "missing",
        "decision": decision,
        "reasons": reasons,
        "generated_at": dependency_quorum.get("generated_at"),
    }


def _build_jangar_material_verdict_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    raw_reasons: object = dependency_quorum.get("reasons")
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "verdict_ref": f"jangar-material-verdict:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "action_classes": ["paper_canary", "live_micro_canary", "live_scale"],
        "generated_at": dependency_quorum.get("generated_at"),
    }


def _build_jangar_execution_trust_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_execution_trust = dependency_quorum.get("execution_trust")
    empty_execution_trust: Mapping[str, Any] = {}
    execution_trust: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_execution_trust)
        if isinstance(raw_execution_trust, Mapping)
        else empty_execution_trust
    )
    decision = (
        str(
            execution_trust.get("decision")
            or execution_trust.get("state")
            or dependency_quorum.get("decision")
            or "unknown"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            execution_trust.get("state")
            or execution_trust.get("status")
            or ("current" if decision == "allow" else "degraded")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        execution_trust.get("reason_codes")
        or execution_trust.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "admission_ref": f"jangar-execution-trust:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "generated_at": execution_trust.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": execution_trust.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _consumer_evidence_jangar_continuity_packet(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    material_ref = _build_jangar_material_verdict_ref(dependency_quorum)
    decision = str(material_ref.get("decision") or "unknown")
    allow = decision == "allow"
    return {
        "epoch_id": material_ref["verdict_ref"],
        "state": "present" if allow else "missing",
        "decision": "allow" if allow else "hold",
        "fresh_until": dependency_quorum.get("fresh_until"),
        "blocking_reasons": [] if allow else [f"jangar_material_verdict_{decision}"],
        "action_class": "paper_canary",
    }


def _build_capital_replay_projection_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_replay_projection(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        jangar_contract_graduation_ref=_build_jangar_contract_graduation_ref(
            dependency_quorum
        ),
    )


def _build_profit_carry_passport_ledger_payload(
    *,
    torghut_revision: str | None,
    capital_replay_board: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    repair_outcome_dividend_ledger: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_carry_passport_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        capital_replay_board=capital_replay_board,
        route_reacquisition_board=route_reacquisition_board,
        proof_floor=proof_floor,
        market_context_status=market_context_status,
        hypothesis_payload=hypothesis_payload,
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
    )


def _build_capital_reentry_cohort_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_reentry_cohort_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        jangar_material_verdict_ref=_build_jangar_material_verdict_ref(
            dependency_quorum
        ),
    )


def _build_profit_repair_settlement_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_repair_settlement_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        jangar_execution_trust_admission_ref=_build_jangar_execution_trust_admission_ref(
            dependency_quorum
        ),
    )


def _build_profit_freshness_frontier_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_freshness_frontier(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        proof_window=settings.trading_jangar_quant_window,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs_status,
        hypothesis_payload=hypothesis_payload,
        jangar_reliability_settlement_ref=_build_jangar_reliability_settlement_ref(
            dependency_quorum
        ),
    )


def _build_routeability_repair_acceptance_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    profit_repair_settlement_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_routeability_repair_acceptance_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        revenue_repair_digest_ref="/trading/revenue-repair",
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        torghut_routeability_admission_ref=_build_torghut_routeability_admission_ref(
            dependency_quorum
        ),
    )


def _build_evidence_clock_payloads(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    build: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
) -> tuple[dict[str, object], dict[str, object]]:
    return build_evidence_clock_arbiter_and_exchange(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        build=build,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor_receipt=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_signal_quorum=profit_signal_quorum,
        live_submission_gate=live_submission_gate,
        torghut_custody_ref=_build_torghut_stage_clearance_packet_ref(
            dependency_quorum
        ),
        clickhouse_ta_status=clickhouse_ta_status,
    )


def _build_clock_settlement_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    rollout_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_clock_settlement_receipt(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=rollout_status,
    )


def _build_route_image_proof_summary(
    *, build: Mapping[str, Any], dependency_quorum: Mapping[str, Any]
) -> dict[str, object]:
    # fmt: on
    raw_proof = (
        dependency_quorum.get("rollout_image_book")
        or dependency_quorum.get("image_proof_summary")
        or dependency_quorum.get("rollout_image_proof")
    )
    empty_proof: Mapping[str, Any] = {}
    # fmt: off
    image_proof: Mapping[str, Any] = cast(Mapping[str, Any], raw_proof) if isinstance(raw_proof, Mapping) else empty_proof
    raw_reasons: object = image_proof.get("reason_codes") or image_proof.get("blocking_reasons") or []
    # fmt: on
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


def _build_route_evidence_clearinghouse_payload(
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
    # fmt: on
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
        image_proof_summary=_build_route_image_proof_summary(
            build=build,
            dependency_quorum=dependency_quorum,
        ),
        routeability_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
    )


def _build_repair_bid_settlement_payload(
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
    # fmt: on
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
        rollout_image_summary=_build_route_image_proof_summary(
            build=build,
            dependency_quorum=dependency_quorum,
        ),
    )


def _build_route_warrant_exchange_payload(
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
    # fmt: on
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


def _build_source_serving_repair_receipt_payload(
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


def _build_freshness_carry_ledger_payload(
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


def _build_repair_receipt_frontier_payload(
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


def _build_repair_outcome_dividend_ledger_payload(
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


def _build_jangar_reliability_settlement_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_settlement = (
        dependency_quorum.get("reliability_settlement_ledger")
        or dependency_quorum.get("reliability_settlement")
        or dependency_quorum.get("rollout_slo_escrow")
    )
    settlement: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_settlement)
        if isinstance(raw_settlement, Mapping)
        else {}
    )
    decision = (
        str(
            settlement.get("decision")
            or settlement.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            settlement.get("state")
            or settlement.get("status")
            or ("current" if decision == "allow" else "missing")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        settlement.get("reason_codes")
        or settlement.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "settlement_ref": settlement.get("ledger_id")
        or settlement.get("settlement_ref")
        or f"jangar-reliability-settlement:dependency-quorum:{ref_suffix}",
        "ledger_id": settlement.get("ledger_id"),
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "reliability_settlement_ledger"
        if settlement.get("ledger_id") or settlement.get("settlement_ref")
        else "dependency_quorum_proxy",
        "generated_at": settlement.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": settlement.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
        "action_classes": ["torghut_observe", "paper_canary"],
    }


def _build_torghut_routeability_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_admission = dependency_quorum.get("routeability_admission")
    empty_admission: Mapping[str, Any] = {}
    admission: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_admission)
        if isinstance(raw_admission, Mapping)
        else empty_admission
    )
    decision = (
        str(
            admission.get("decision")
            or admission.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            admission.get("state")
            or admission.get("status")
            or ("current" if decision == "allow" else "missing")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        admission.get("reason_codes")
        or admission.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "admission_ref": f"jangar-routeability-admission:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "routeability_admission"
        if admission.get("admission_ref") or admission.get("id")
        else "dependency_quorum_proxy",
        "action_classes": ["torghut_observe", "paper_canary"],
        "generated_at": admission.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": admission.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _build_torghut_stage_clearance_packet_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_packet = dependency_quorum.get("stage_clearance_packet")
    packet: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_packet) if isinstance(raw_packet, Mapping) else {}
    )
    decision = (
        str(
            packet.get("decision")
            or packet.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        packet.get("reason_codes")
        or packet.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    return {
        "packet_id": packet.get("packet_id") or packet.get("id"),
        "decision": decision,
        "state": packet.get("state")
        or ("current" if decision == "allow" else "missing"),
        "action_class": packet.get("action_class") or "torghut_capital",
        "reason_codes": [
            str(item).strip() for item in reason_items if str(item).strip()
        ],
        "source": "stage_clearance_packet"
        if packet.get("packet_id") or packet.get("id")
        else "dependency_quorum_proxy",
        "generated_at": packet.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": packet.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _build_profit_signal_quorum_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_signal_quorum(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        torghut_stage_clearance_packet=_build_torghut_stage_clearance_packet_ref(
            dependency_quorum
        ),
    )


def _simulation_cache_status_payload(
    active_simulation_context: Mapping[str, Any] | None,
) -> dict[str, object]:
    context = active_simulation_context or {}
    return {
        "enabled": settings.trading_simulation_enabled,
        "run_id": context.get("run_id") or settings.trading_simulation_run_id,
        "dataset_id": context.get("dataset_id")
        or settings.trading_simulation_dataset_id,
        "window_start": context.get("window_start")
        or settings.trading_simulation_window_start,
        "window_end": context.get("window_end")
        or settings.trading_simulation_window_end,
        "last_updated_at": context.get("last_updated_at") or context.get("updated_at"),
    }


def _build_quality_adjusted_profit_frontier_payload(
    *,
    torghut_revision: str | None,
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    active_simulation_context: Mapping[str, Any] | None,
) -> dict[str, object]:
    return build_quality_adjusted_profit_frontier(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        simulation_cache_status=_simulation_cache_status_payload(
            active_simulation_context
        ),
        jangar_evidence_quality=_route_continuity_packet_for_proof_floor(proof_floor),
    )


def _build_autonomy_capital_replay_projection(
    scheduler: TradingScheduler,
) -> dict[str, object]:
    dependency_quorum = resolve_hypothesis_dependency_quorum(load_hypothesis_registry())
    try:
        empirical_jobs = _empirical_jobs_status()
        quant_evidence = load_quant_evidence_status(
            account_label=settings.trading_account_label,
        )
        market_context_status = scheduler.market_context_status()
        with SessionLocal() as session:
            tca_summary = _load_tca_summary(session, scheduler=scheduler)
        hypothesis_payload, _hypothesis_summary, dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
                dependency_quorum=dependency_quorum,
            )
        )
        with SessionLocal() as session:
            live_submission_gate = _build_live_submission_gate_payload(
                scheduler.state,
                session=session,
                hypothesis_summary=hypothesis_payload,
                empirical_jobs_status=empirical_jobs,
                dspy_runtime_status=cast(
                    dict[str, object],
                    scheduler.llm_status().get("dspy_runtime", {}),
                ),
                quant_health_status=quant_evidence,
            )
        proof_floor = _build_profitability_proof_floor_payload(
            state=scheduler.state,
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            live_submission_gate=live_submission_gate,
            hypothesis_payload=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
        )
        route_reacquisition_board = _build_route_reacquisition_board_payload(
            proof_floor=proof_floor,
            active_revision=main_runtime_value("BUILD_COMMIT"),
        )
        return _build_capital_replay_projection_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=dependency_quorum.as_payload(),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    except Exception as exc:  # pragma: no cover - additive autonomy surface only
        return build_capital_replay_projection(
            account_label=settings.trading_account_label,
            trading_mode=settings.trading_mode,
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            proof_floor_receipt={
                "route_state": "unavailable",
                "capital_state": "zero_notional",
                "blocking_reasons": [
                    f"capital_replay_projection_unavailable:{type(exc).__name__}"
                ],
            },
            route_reacquisition_board={"rows": []},
            live_submission_gate={
                "blocked_reasons": ["capital_replay_projection_unavailable"]
            },
            empirical_jobs_status={},
            quant_evidence={},
            market_context_status={},
            jangar_contract_graduation_ref=_build_jangar_contract_graduation_ref(
                dependency_quorum.as_payload()
            ),
        )


def _route_continuity_packet_for_proof_floor(
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    registry = load_hypothesis_registry()
    if hypothesis_registry_requires_dependency_capability(
        registry,
        "jangar_dependency_quorum",
    ):
        return load_jangar_route_continuity_packet(action_class="paper_canary")

    continuity_ref = (
        str(proof_floor.get("generated_at") or "").strip()
        or str(proof_floor.get("torghut_revision") or "").strip()
        or "unknown"
    )
    return {
        "epoch_id": f"torghut-self-continuity:{continuity_ref}",
        "state": "present",
        "decision": "allow",
        "fresh_until": proof_floor.get("fresh_until"),
        "blocking_reasons": [],
        "source": "torghut_hypothesis_registry",
        "action_class": "paper_canary",
    }


def _simple_lane_reject_reason_totals(state: object) -> dict[str, int]:
    metrics = getattr(state, "metrics", None)
    totals = getattr(metrics, "decision_reject_reason_total", {})
    if not isinstance(totals, Mapping):
        return {}
    payload: dict[str, int] = {}
    for key, value in cast(Mapping[object, Any], totals).items():
        normalized = str(key)
        if normalized not in _SIMPLE_LANE_ALLOWED_REJECT_REASONS:
            continue
        payload[normalized] = int(value)
    return payload


def _build_rejected_signal_outcome_learning_payload(
    state: object,
    *,
    persisted_summary: Mapping[str, object] | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    total = max(0, int(getattr(metrics, "rejected_signal_events_total", 0) or 0))
    pending = max(
        0,
        int(getattr(metrics, "rejected_signal_outcome_label_pending_total", 0) or 0),
    )
    raw_reasons = getattr(metrics, "rejected_signal_reason_total", {})
    reasons: dict[str, int] = {}
    if isinstance(raw_reasons, Mapping):
        for key, value in cast(Mapping[object, Any], raw_reasons).items():
            reasons[str(key)] = max(0, int(value))
    latest_event = getattr(state, "last_rejected_signal_outcome_event", None)
    latest_payload: dict[str, object] | None = None
    if isinstance(latest_event, Mapping):
        latest_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], latest_event).items()
        }
    labeled_count = 0
    incomplete_count = 0
    outcome_label_status_total: dict[str, int] = {}
    persistence_state = "not_configured"
    if persisted_summary is not None:
        persistence_state = str(persisted_summary.get("persistence_state") or "ok")
        persisted_total = cast(Any, persisted_summary.get("events_total"))
        total = max(total, int(persisted_total or 0))
        persisted_pending = cast(
            Any, persisted_summary.get("outcome_label_pending_total")
        )
        pending = max(
            pending,
            int(persisted_pending or 0),
        )
        persisted_labeled = cast(Any, persisted_summary.get("labeled_count"))
        labeled_count = max(0, int(persisted_labeled or 0))
        persisted_incomplete = cast(Any, persisted_summary.get("incomplete_count"))
        incomplete_count = max(0, int(persisted_incomplete or 0))
        persisted_status_total = persisted_summary.get("outcome_label_status_total")
        if isinstance(persisted_status_total, Mapping):
            outcome_label_status_total = {
                str(key): max(0, int(value))
                for key, value in cast(
                    Mapping[object, Any], persisted_status_total
                ).items()
            }
        persisted_reasons = persisted_summary.get("reason_total")
        if isinstance(persisted_reasons, Mapping):
            for key, value in cast(Mapping[object, Any], persisted_reasons).items():
                reasons[str(key)] = max(reasons.get(str(key), 0), int(value))
        persisted_latest = persisted_summary.get("latest_event")
        if isinstance(persisted_latest, Mapping):
            latest_payload = {
                str(key): value
                for key, value in cast(
                    Mapping[object, object], persisted_latest
                ).items()
            }
    blockers = ["counterfactual_outcome_labels_pending"] if pending > 0 else []
    state_label = "pending_outcome_labels"
    if pending <= 0:
        state_label = "labeled_outcomes_available" if labeled_count > 0 else "empty"
    return {
        "schema_version": "torghut.rejected-signal-outcome-learning.v1",
        "source": "runtime_quote_quality_gate",
        "paper_source": "paper-arxiv-2605.12151",
        "paper_claim_id": "rejection-event-outcome-labels",
        "state": state_label,
        "events_total": total,
        "outcome_label_pending_total": pending,
        "labeled_count": labeled_count,
        "incomplete_count": incomplete_count,
        "outcome_label_status_total": outcome_label_status_total,
        "reason_total": reasons,
        "latest_event": latest_payload,
        "persistence_state": persistence_state,
        "required_outcome_fields": [
            "counterfactual_return",
            "route_tca",
            "post_cost_net_pnl",
            "executable_quote",
        ],
        "promotion_impact": "repair_only_until_labeled",
        "blocking_reasons": blockers,
    }


def _load_rejected_signal_outcome_learning_summary(
    session: Session,
) -> dict[str, object] | None:
    try:
        total = int(
            session.execute(
                select(func.count(RejectedSignalOutcomeEvent.id))
            ).scalar_one()
            or 0
        )
        pending = int(
            session.execute(
                select(func.count(RejectedSignalOutcomeEvent.id)).where(
                    RejectedSignalOutcomeEvent.outcome_label_status == "pending"
                )
            ).scalar_one()
            or 0
        )
        status_rows = session.execute(
            select(
                RejectedSignalOutcomeEvent.outcome_label_status,
                func.count(RejectedSignalOutcomeEvent.id),
            ).group_by(RejectedSignalOutcomeEvent.outcome_label_status)
        ).all()
        outcome_label_status_total = {
            str(status or "unknown"): int(count or 0) for status, count in status_rows
        }
        reason_rows = session.execute(
            select(
                RejectedSignalOutcomeEvent.reject_reason,
                func.count(RejectedSignalOutcomeEvent.id),
            ).group_by(RejectedSignalOutcomeEvent.reject_reason)
        ).all()
        reason_total = {
            str(reason or "unknown"): int(count or 0) for reason, count in reason_rows
        }
        latest = session.execute(
            select(RejectedSignalOutcomeEvent)
            .order_by(
                RejectedSignalOutcomeEvent.event_ts.desc(),
                RejectedSignalOutcomeEvent.created_at.desc(),
            )
            .limit(1)
        ).scalar_one_or_none()
        latest_payload: dict[str, object] | None = None
        if latest is not None:
            latest_payload = {
                "event_id": latest.event_id,
                "schema_version": "torghut.rejected-signal-outcome-event.v1",
                "source": latest.source,
                "paper_source": latest.paper_source,
                "paper_claim_id": latest.paper_claim_id,
                "account_label": latest.account_label,
                "symbol": latest.symbol,
                "event_ts": latest.event_ts.isoformat(),
                "timeframe": latest.timeframe,
                "seq": latest.seq,
                "reject_reason": latest.reject_reason,
                "spread_bps": str(latest.spread_bps)
                if latest.spread_bps is not None
                else None,
                "jump_bps": str(latest.jump_bps)
                if latest.jump_bps is not None
                else None,
                "outcome_label_status": latest.outcome_label_status,
                "counterfactual_required": latest.counterfactual_required,
                "required_outcome_fields": latest.required_outcome_fields_json,
            }
        return {
            "persistence_state": "ok",
            "events_total": total,
            "outcome_label_pending_total": pending,
            "labeled_count": outcome_label_status_total.get("labeled", 0),
            "incomplete_count": outcome_label_status_total.get("incomplete", 0),
            "outcome_label_status_total": outcome_label_status_total,
            "reason_total": reason_total,
            "latest_event": latest_payload,
        }
    except SQLAlchemyError:
        logger.exception("Failed to load rejected signal outcome learning summary")
        return {"persistence_state": "unavailable"}


def _load_route_provenance_summary(session: Session) -> dict[str, object]:
    window_start = datetime.now(timezone.utc) - timedelta(hours=24)
    row = session.execute(
        select(
            func.count(Execution.id),
            func.count(Execution.id).filter(
                (Execution.execution_expected_adapter.is_(None))
                | (func.btrim(Execution.execution_expected_adapter) == "")
                | (Execution.execution_actual_adapter.is_(None))
                | (func.btrim(Execution.execution_actual_adapter) == "")
            ),
            func.count(Execution.id).filter(
                (func.lower(Execution.execution_expected_adapter) == "unknown")
                | (func.lower(Execution.execution_actual_adapter) == "unknown")
            ),
            func.count(Execution.id).filter(
                func.lower(Execution.execution_expected_adapter)
                != func.lower(Execution.execution_actual_adapter)
            ),
        ).where(Execution.created_at >= window_start)
    ).one()
    total = int(row[0] or 0)
    missing = int(row[1] or 0)
    unknown = int(row[2] or 0)
    mismatch = int(row[3] or 0)
    if total <= 0:
        return {
            "total": 0,
            "missing": 0,
            "unknown": 0,
            "mismatch": 0,
            "coverage_ratio": 0.0,
            "unknown_ratio": 0.0,
            "mismatch_ratio": 0.0,
        }
    safe_total = float(total)
    coverage = max(0.0, (total - missing) / safe_total)
    return {
        "total": total,
        "missing": missing,
        "unknown": unknown,
        "mismatch": mismatch,
        "coverage_ratio": coverage,
        "unknown_ratio": unknown / safe_total,
        "mismatch_ratio": mismatch / safe_total,
    }


__all__ = [
    "_build_profitability_proof_floor_payload",
    "_build_renewal_bond_profit_escrow_payload",
    "_build_route_reacquisition_board_payload",
    "_build_jangar_contract_graduation_ref",
    "_build_jangar_material_verdict_ref",
    "_build_jangar_execution_trust_admission_ref",
    "_consumer_evidence_jangar_continuity_packet",
    "_build_capital_replay_projection_payload",
    "_build_profit_carry_passport_ledger_payload",
    "_build_capital_reentry_cohort_ledger_payload",
    "_build_profit_repair_settlement_ledger_payload",
    "_build_profit_freshness_frontier_payload",
    "_build_routeability_repair_acceptance_ledger_payload",
    "_build_evidence_clock_payloads",
    "_build_clock_settlement_payload",
    "_build_route_image_proof_summary",
    "_build_route_evidence_clearinghouse_payload",
    "_build_repair_bid_settlement_payload",
    "_build_route_warrant_exchange_payload",
    "_build_source_serving_repair_receipt_payload",
    "_build_freshness_carry_ledger_payload",
    "_build_repair_receipt_frontier_payload",
    "_build_repair_outcome_dividend_ledger_payload",
    "_build_jangar_reliability_settlement_ref",
    "_build_torghut_routeability_admission_ref",
    "_build_torghut_stage_clearance_packet_ref",
    "_build_profit_signal_quorum_payload",
    "_simulation_cache_status_payload",
    "_build_quality_adjusted_profit_frontier_payload",
    "_build_autonomy_capital_replay_projection",
    "_route_continuity_packet_for_proof_floor",
    "_simple_lane_reject_reason_totals",
    "_build_rejected_signal_outcome_learning_payload",
    "_load_rejected_signal_outcome_learning_summary",
    "_load_route_provenance_summary",
]
capture_module_exports(globals(), __all__)
