# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401,F403,F405,F811,F821
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

# ruff: noqa: F401,F403,F405,F821,F821,F821


if TYPE_CHECKING:
    from ..compat_typing import *

from ..common import *

from ..common import main_runtime_value

from ..proxy import capture_module_exports


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


__all__ = [name for name in globals() if not name.startswith("__")]
