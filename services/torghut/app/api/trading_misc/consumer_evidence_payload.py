"""Consumer-evidence payload assembly for Torghut trading routes."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from sqlalchemy.orm import Session

from app.api.build_metadata import (
    BUILD_COMMIT,
    BUILD_IMAGE_DIGEST,
    BUILD_VERSION,
)
from app.api.proof_contracts import (
    CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE,
)
from app.config import settings
from app.db import SessionLocal
from app.trading.alpha_closure_dividend_slo import build_alpha_closure_dividend_slo
from app.trading.alpha_evidence_foundry import compact_alpha_evidence_foundry
from app.trading.alpha_readiness_settlement_conveyor import (
    compact_alpha_readiness_settlement_conveyor,
)
from app.trading.alpha_repair_closure_board import compact_alpha_repair_closure_board
from app.trading.alpha_repair_dividend_ledger import (
    compact_alpha_repair_dividend_ledger,
)
from app.trading.consumer_evidence import (
    build_route_proven_profit_receipt,
    build_torghut_consumer_evidence_receipt,
)
from app.trading.executable_alpha_receipts import (
    compact_executable_alpha_settlement_slots,
)
from app.trading.hypotheses import (
    JangarDependencyQuorumStatus,
    load_jangar_dependency_quorum,
)
from app.trading.jangar_controller_ingestion_carry import (
    compact_jangar_controller_ingestion_carry,
)
from app.trading.no_delta_repair_reentry_auction import (
    compact_no_delta_repair_reentry_auction,
)
from app.trading.revenue_repair import build_revenue_repair_digest
from app.trading.route_reacquisition_board import build_route_reacquisition_board
from app.trading.simulation_progress import active_simulation_runtime_context
from app.trading.submission_council import load_quant_evidence_status

from ..health_checks import (
    build_api_live_submission_gate_payload as _build_live_submission_gate_payload,
)
from ..health_checks import (
    build_hypothesis_runtime_payload as _build_hypothesis_runtime_payload,
)
from ..health_checks import (
    build_shadow_first_runtime_payload as _build_shadow_first_runtime_payload,
)
from ..health_checks import (
    build_simple_lane_status_payload as _build_simple_lane_status_payload,
)
from ..health_checks import (
    empirical_jobs_status as _empirical_jobs_status,
)
from ..health_checks import (
    forecast_service_status as _forecast_service_status,
)
from ..health_checks import (
    lean_authority_status as _lean_authority_status,
)
from ..health_checks import (
    load_clickhouse_ta_status as _load_clickhouse_ta_status,
)
from ..health_checks import (
    load_options_catalog_freshness_summary as _load_options_catalog_freshness_summary,
)
from ..health_checks import (
    load_tca_summary as _load_tca_summary,
)
from ..health_checks import (
    route_claim_symbols as _route_claim_symbols,
)
from ..proof_floor_payloads import (
    build_capital_reentry_cohort_ledger_payload as _build_capital_reentry_cohort_ledger_payload,
)
from ..proof_floor_payloads import (
    build_capital_replay_projection_payload as _build_capital_replay_projection_payload,
)
from ..proof_floor_payloads import (
    build_clock_settlement_payload as _build_clock_settlement_payload,
)
from ..proof_floor_payloads import (
    build_evidence_clock_payloads as _build_evidence_clock_payloads,
)
from ..proof_floor_payloads import (
    build_freshness_carry_ledger_payload as _build_freshness_carry_ledger_payload,
)
from ..proof_floor_payloads import (
    build_profit_carry_passport_ledger_payload as _build_profit_carry_passport_ledger_payload,
)
from ..proof_floor_payloads import (
    build_profit_freshness_frontier_payload as _build_profit_freshness_frontier_payload,
)
from ..proof_floor_payloads import (
    build_profit_repair_settlement_ledger_payload as _build_profit_repair_settlement_ledger_payload,
)
from ..proof_floor_payloads import (
    build_profit_signal_quorum_payload as _build_profit_signal_quorum_payload,
)
from ..proof_floor_payloads import (
    build_profitability_proof_floor_payload as _build_profitability_proof_floor_payload,
)
from ..proof_floor_payloads import (
    build_quality_adjusted_profit_frontier_payload as _build_quality_adjusted_profit_frontier_payload,
)
from ..proof_floor_payloads import (
    build_repair_bid_settlement_payload as _build_repair_bid_settlement_payload,
)
from ..proof_floor_payloads import (
    build_repair_outcome_dividend_ledger_payload as _build_repair_outcome_dividend_ledger_payload,
)
from ..proof_floor_payloads import (
    build_repair_receipt_frontier_payload as _build_repair_receipt_frontier_payload,
)
from ..proof_floor_payloads import (
    build_route_evidence_clearinghouse_payload as _build_route_evidence_clearinghouse_payload,
)
from ..proof_floor_payloads import (
    build_route_image_proof_summary as _build_route_image_proof_summary,
)
from ..proof_floor_payloads import (
    build_route_warrant_exchange_payload as _build_route_warrant_exchange_payload,
)
from ..proof_floor_payloads import (
    build_routeability_repair_acceptance_ledger_payload as _build_routeability_repair_acceptance_ledger_payload,
)
from ..proof_floor_payloads import (
    build_source_serving_repair_receipt_payload as _build_source_serving_repair_receipt_payload,
)
from ..proof_floor_payloads import (
    consumer_evidence_jangar_continuity_packet as _consumer_evidence_jangar_continuity_packet,
)
from ..trading_scheduler_state import get_trading_scheduler


def readiness_dependency_snapshot(
    session: Session,
    *,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], datetime, bool]:
    from .. import readiness_helpers

    return readiness_helpers.readiness_dependency_snapshot(
        session,
        include_database_contract=include_database_contract,
        allow_stale_dependency_cache=allow_stale_dependency_cache,
    )


def consumer_evidence_dependency_quorum() -> JangarDependencyQuorumStatus:
    dependency_quorum = load_jangar_dependency_quorum(
        omit_torghut_consumer_evidence=True,
    )
    if dependency_quorum.reasons != ["jangar_control_plane_status_url_missing"]:
        return dependency_quorum

    return JangarDependencyQuorumStatus(
        decision="allow",
        reasons=[],
        message=CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE,
    )


def build_consumer_evidence_receipt_projection(
    *,
    forecast_service_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    serving_revision: str | None,
) -> tuple[dict[str, object], dict[str, object]]:
    consumer_evidence_receipt = build_torghut_consumer_evidence_receipt(
        forecast_service_status=forecast_service_status,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
    )
    route_proven_profit_receipt = build_route_proven_profit_receipt(
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        source_commit=BUILD_COMMIT,
        serving_revision=serving_revision,
        image_digest=BUILD_IMAGE_DIGEST,
    )
    return consumer_evidence_receipt, route_proven_profit_receipt


def consumer_evidence_summary_view(view: str | None) -> bool:
    return (view or "").strip().lower() in {"compact", "summary", "jangar"}


def revenue_repair_topline_fields(
    revenue_repair_digest: Mapping[str, Any],
) -> dict[str, object]:
    keys = (
        "business_state",
        "revenue_ready",
        "capital_state",
        "capital_stage",
        "live_submission_allowed",
        "max_notional",
        "top_repair_queue_item",
        "selected_value_gate",
        "required_output_receipt",
        "required_receipts",
        "routeable_candidate_count_before",
        "routeable_candidate_count_after",
        "accepted_routeable_candidate_count",
        "routeable_candidate_delta",
        "alpha_no_delta_release_key",
        "no_delta_reentry_decision",
        "no_delta_reentry_reason_codes",
        "field_unavailable_reason_codes",
        "validation_commands",
        "rollback_target",
    )
    return {
        "revenue_repair_digest_ref": "/trading/revenue-repair",
        **{key: revenue_repair_digest.get(key) for key in keys},
    }


def build_trading_consumer_evidence_payload(
    *, summary: bool = False
) -> dict[str, object]:
    scheduler = get_trading_scheduler()
    state = scheduler.state
    dependency_quorum = consumer_evidence_dependency_quorum()
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    forecast_service_status = _forecast_service_status(empirical_jobs)
    lean_authority_status = _lean_authority_status()
    with SessionLocal() as session:
        tca_summary = _load_tca_summary(session, scheduler=scheduler)
        readiness_dependencies, _readiness_checked_at, _readiness_cache_used = (
            readiness_dependency_snapshot(
                session,
                include_database_contract=True,
                allow_stale_dependency_cache=True,
            )
        )
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, hypothesis_summary, _dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
            dependency_quorum=dependency_quorum,
        )
    )
    with SessionLocal() as session:
        live_submission_gate = _build_live_submission_gate_payload(
            state,
            session=session,
            hypothesis_summary=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=cast(
                dict[str, object],
                scheduler.llm_status().get("dspy_runtime", {}),
            ),
            quant_health_status=quant_evidence,
        )
    simple_lane_status = _build_simple_lane_status_payload()
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=state,
        hypothesis_summary=hypothesis_summary,
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": shadow_first_runtime["active_revision"],
    }
    proof_floor = _build_profitability_proof_floor_payload(
        state=state,
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        simple_lane_status=simple_lane_status,
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        build_consumer_evidence_receipt_projection(
            forecast_service_status=forecast_service_status,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        )
    )
    control_plane_dependency_mode = (
        "caller_evaluated"
        if dependency_quorum.message
        == CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE
        else "jangar_status_non_recursive"
    )
    if summary:
        return {
            "schema_version": "torghut.consumer-evidence-status.v1",
            "view": "summary",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "enabled": settings.trading_enabled,
            "mode": settings.trading_mode,
            "running": state.running,
            "build": build_payload,
            "control_plane_dependency_mode": control_plane_dependency_mode,
            "dependency_quorum": dependency_quorum.as_payload(),
            "forecast_service": forecast_service_status,
            "lean_authority": lean_authority_status,
            "empirical_jobs": empirical_jobs,
            "market_context": market_context_status,
            "quant_evidence": quant_evidence,
            "live_submission_gate": live_submission_gate,
            "proof_floor": proof_floor,
            "simple_lane_status": simple_lane_status,
            "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
            "route_proven_profit_receipt": route_proven_profit_receipt,
            "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        }
    route_reacquisition_board = build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        route_reacquisition_book=cast(
            Mapping[str, Any] | None,
            proof_floor.get("route_reacquisition_book"),
        ),
        active_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        jangar_continuity=_consumer_evidence_jangar_continuity_packet(
            dependency_quorum.as_payload()
        ),
    )
    capital_replay_projection = _build_capital_replay_projection_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
    )
    profit_signal_quorum = _build_profit_signal_quorum_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
    )
    with SessionLocal() as session:
        options_catalog_freshness = _load_options_catalog_freshness_summary(
            session,
            route_symbols=_route_claim_symbols(profit_signal_quorum),
        )
    capital_reentry_cohort_ledger = _build_capital_reentry_cohort_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
    )
    quality_adjusted_profit_frontier = _build_quality_adjusted_profit_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        active_simulation_context=active_simulation_runtime_context(),
    )
    profit_repair_settlement_ledger = _build_profit_repair_settlement_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
    )
    routeability_repair_acceptance_ledger = (
        _build_routeability_repair_acceptance_ledger_payload(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            profit_repair_settlement_ledger=profit_repair_settlement_ledger,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    clickhouse_ta_status = _load_clickhouse_ta_status(scheduler)
    route_evidence_clearinghouse_packet = _build_route_evidence_clearinghouse_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        dependency_quorum=dependency_quorum.as_payload(),
        build=build_payload,
        proof_floor=proof_floor,
        profit_signal_quorum=profit_signal_quorum,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
        tca_summary=tca_summary,
        options_catalog_freshness=options_catalog_freshness,
    )
    profit_freshness_frontier = _build_profit_freshness_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        proof_floor=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs,
        hypothesis_payload=hypothesis_payload,
    )
    repair_bid_settlement_ledger = _build_repair_bid_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        dependency_quorum=dependency_quorum.as_payload(),
        build=build_payload,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quant_evidence=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
    )
    revenue_repair_digest = build_revenue_repair_digest(
        readyz_payload={
            "status": "degraded"
            if live_submission_gate.get("allowed") is not True
            else "ok",
            "proof_floor": proof_floor,
            "live_submission_gate": live_submission_gate,
            "quant_evidence": quant_evidence,
            "dependencies": readiness_dependencies,
        },
        status_payload={
            "mode": settings.trading_mode,
            "pipeline_mode": "simple",
            "build": build_payload,
            "dependency_quorum": dependency_quorum.as_payload(),
            "live_submission_gate": live_submission_gate,
            "proof_floor": proof_floor,
            "quant_evidence": quant_evidence,
            "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
            "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
            "capital_replay_board": capital_replay_projection.get(
                "capital_replay_board"
            ),
            "executable_alpha_receipts": capital_replay_projection.get(
                "executable_alpha_receipts"
            ),
            "controller_ingestion_settlement": dependency_quorum.as_payload().get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": dependency_quorum.as_payload().get(
                "verify_trust_foreclosure_board"
            ),
            "repair_slot_escrow": dependency_quorum.as_payload().get(
                "repair_slot_escrow"
            ),
            "stage_debt_repair_admission": dependency_quorum.as_payload().get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": dependency_quorum.as_payload().get(
                "foreclosure_carry_rollout_witness"
            ),
        },
        generated_at=datetime.now(timezone.utc),
    )
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _build_evidence_clock_payloads(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=dependency_quorum.as_payload(),
            hypothesis_payload=hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            profit_signal_quorum=profit_signal_quorum,
            live_submission_gate=live_submission_gate,
            build=build_payload,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    )
    clock_settlement_receipt = _build_clock_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        build=build_payload,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=_build_route_image_proof_summary(
            build=build_payload,
            dependency_quorum=dependency_quorum.as_payload(),
        ),
    )
    route_warrant_exchange = _build_route_warrant_exchange_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
    )
    source_serving_repair_receipt_ledger = _build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        route_warrant_exchange=route_warrant_exchange,
    )
    freshness_carry_ledger = _build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )
    repair_receipt_frontier = _build_repair_receipt_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
    )
    repair_outcome_dividend_ledger = _build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        repair_receipt_frontier=repair_receipt_frontier,
        freshness_carry_ledger=freshness_carry_ledger,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )
    profit_carry_passport_ledger = _build_profit_carry_passport_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        capital_replay_board=cast(
            Mapping[str, Any],
            capital_replay_projection["capital_replay_board"],
        ),
        route_reacquisition_board=route_reacquisition_board,
        proof_floor=proof_floor,
        market_context_status=market_context_status,
        hypothesis_payload=hypothesis_payload,
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
    )
    return {
        "schema_version": "torghut.consumer-evidence-status.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "enabled": settings.trading_enabled,
        "mode": settings.trading_mode,
        "running": state.running,
        "build": build_payload,
        "control_plane_dependency_mode": control_plane_dependency_mode,
        "dependency_quorum": dependency_quorum.as_payload(),
        "forecast_service": forecast_service_status,
        "lean_authority": lean_authority_status,
        "empirical_jobs": empirical_jobs,
        "market_context": market_context_status,
        "quant_evidence": quant_evidence,
        "live_submission_gate": live_submission_gate,
        "proof_floor": proof_floor,
        "simple_lane_status": simple_lane_status,
        "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
        "route_proven_profit_receipt": route_proven_profit_receipt,
        "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        "capital_reentry_cohort_ledger": capital_reentry_cohort_ledger,
        "profit_repair_settlement_ledger": profit_repair_settlement_ledger,
        "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
        "profit_freshness_frontier": profit_freshness_frontier,
        "profit_signal_quorum": profit_signal_quorum,
        "evidence_clock_arbiter": evidence_clock_arbiter,
        "routeable_profit_candidate_exchange": routeable_profit_candidate_exchange,
        "clock_settlement_receipt": clock_settlement_receipt,
        "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
        "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
        **revenue_repair_topline_fields(revenue_repair_digest),
        "alpha_readiness_strike_ledger": revenue_repair_digest.get(
            "alpha_readiness_strike_ledger"
        ),
        "executable_alpha_repair_receipts": revenue_repair_digest.get(
            "executable_alpha_repair_receipts"
        ),
        "executable_alpha_settlement_slots": compact_executable_alpha_settlement_slots(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("executable_alpha_settlement_slots"),
            )
        ),
        "alpha_repair_closure_board": compact_alpha_repair_closure_board(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_closure_board"),
            )
        ),
        "alpha_evidence_foundry": compact_alpha_evidence_foundry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_evidence_foundry"),
            )
        ),
        "alpha_readiness_settlement_conveyor": compact_alpha_readiness_settlement_conveyor(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_readiness_settlement_conveyor"),
            )
        ),
        "alpha_repair_dividend_ledger": compact_alpha_repair_dividend_ledger(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            )
        ),
        "alpha_closure_dividend_slo": build_alpha_closure_dividend_slo(
            generated_at=datetime.now(timezone.utc),
            alpha_repair_closure_board=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_closure_board"),
            ),
            alpha_repair_dividend_ledger=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            ),
        ),
        "jangar_controller_ingestion_carry": compact_jangar_controller_ingestion_carry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("jangar_controller_ingestion_carry"),
            )
        ),
        "no_delta_repair_reentry_auction": compact_no_delta_repair_reentry_auction(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("no_delta_repair_reentry_auction"),
            )
        ),
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "profit_carry_passport_ledger": profit_carry_passport_ledger,
    }


__all__ = (
    "SessionLocal",
    "build_consumer_evidence_receipt_projection",
    "build_trading_consumer_evidence_payload",
    "consumer_evidence_dependency_quorum",
    "consumer_evidence_summary_view",
    "load_jangar_dependency_quorum",
    "readiness_dependency_snapshot",
    "revenue_repair_topline_fields",
)
