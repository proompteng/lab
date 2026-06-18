"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import (
    BUILD_IMAGE_DIGEST,
    BUILD_VERSION,
    SessionLocal,
    TradingScheduler,
    active_simulation_runtime_context,
    cast,
    datetime,
    load_quant_evidence_status,
    settings,
    timezone,
    trading_time_status,
)
from .common import main_runtime_value
from .application import get_app
from .health_checks import (
    budget_exhausted_live_submission_gate_payload,
    budget_exhausted_options_catalog_freshness_payload,
    build_api_live_submission_gate_payload,
    build_control_plane_contract,
    build_shadow_first_runtime_payload,
    build_simple_lane_status_payload,
    empirical_jobs_status,
    forecast_service_status,
    lean_authority_status,
    load_clickhouse_ta_status,
    load_last_decision_at,
    load_options_catalog_freshness_summary,
    route_claim_symbols,
)
from .proof_floor_payloads import (
    build_capital_reentry_cohort_ledger_payload as _build_capital_reentry_cohort_ledger_payload,
    build_capital_replay_projection_payload as _build_capital_replay_projection_payload,
    build_clock_settlement_payload as _build_clock_settlement_payload,
    build_evidence_clock_payloads as _build_evidence_clock_payloads,
    build_freshness_carry_ledger_payload as _build_freshness_carry_ledger_payload,
    build_profit_freshness_frontier_payload as _build_profit_freshness_frontier_payload,
    build_profit_repair_settlement_ledger_payload as _build_profit_repair_settlement_ledger_payload,
    build_profit_signal_quorum_payload as _build_profit_signal_quorum_payload,
    build_profitability_proof_floor_payload as _build_profitability_proof_floor_payload,
    build_quality_adjusted_profit_frontier_payload as _build_quality_adjusted_profit_frontier_payload,
    build_rejected_signal_outcome_learning_payload as _build_rejected_signal_outcome_learning_payload,
    build_renewal_bond_profit_escrow_payload as _build_renewal_bond_profit_escrow_payload,
    build_repair_bid_settlement_payload as _build_repair_bid_settlement_payload,
    build_repair_outcome_dividend_ledger_payload as _build_repair_outcome_dividend_ledger_payload,
    build_repair_receipt_frontier_payload as _build_repair_receipt_frontier_payload,
    build_route_evidence_clearinghouse_payload as _build_route_evidence_clearinghouse_payload,
    build_route_image_proof_summary as _build_route_image_proof_summary,
    build_route_reacquisition_board_payload as _build_route_reacquisition_board_payload,
    build_route_warrant_exchange_payload as _build_route_warrant_exchange_payload,
    build_routeability_repair_acceptance_ledger_payload as _build_routeability_repair_acceptance_ledger_payload,
    build_source_serving_repair_receipt_payload as _build_source_serving_repair_receipt_payload,
    load_rejected_signal_outcome_learning_summary,
    simple_lane_reject_reason_totals as _simple_lane_reject_reason_totals,
)
from .status_helpers import (
    TradingStatusReadBudget,
    budget_unavailable_hypothesis_runtime_payload,
    budget_unavailable_llm_evaluation_payload,
    budget_unavailable_tca_summary_payload,
    deferred_hypothesis_payload_for_live_submission_gate,
    hypothesis_payload_read_model_unavailable,
    load_trading_status_hypothesis_runtime,
    load_trading_status_llm_evaluation,
    load_trading_status_runtime_ledger_portfolio_summary,
    load_trading_status_tca_summary,
    load_trading_status_tigerbeetle_ledger,
)
from .trading_misc import (
    build_consumer_evidence_receipt_projection as _build_consumer_evidence_receipt_projection,
)
from app.trading.submission_authority import (
    build_submission_authority_status as _build_submission_authority_status,
)
from .vnext_helpers import build_autonomy_bridge_status as _build_autonomy_bridge_status

_TradingStatusReadBudget = TradingStatusReadBudget
_budget_exhausted_live_submission_gate_payload = (
    budget_exhausted_live_submission_gate_payload
)
_budget_exhausted_options_catalog_freshness_payload = (
    budget_exhausted_options_catalog_freshness_payload
)
_budget_unavailable_hypothesis_runtime_payload = (
    budget_unavailable_hypothesis_runtime_payload
)
_budget_unavailable_llm_evaluation_payload = budget_unavailable_llm_evaluation_payload
_budget_unavailable_tca_summary_payload = budget_unavailable_tca_summary_payload
_build_control_plane_contract = build_control_plane_contract
_build_live_submission_gate_payload = build_api_live_submission_gate_payload
_build_shadow_first_runtime_payload = build_shadow_first_runtime_payload
_build_simple_lane_status_payload = build_simple_lane_status_payload
_empirical_jobs_status = empirical_jobs_status
_forecast_service_status = forecast_service_status
_lean_authority_status = lean_authority_status
_load_clickhouse_ta_status = load_clickhouse_ta_status
_load_last_decision_at = load_last_decision_at
_load_options_catalog_freshness_summary = load_options_catalog_freshness_summary
_route_claim_symbols = route_claim_symbols
_deferred_hypothesis_payload_for_live_submission_gate = (
    deferred_hypothesis_payload_for_live_submission_gate
)
_hypothesis_payload_read_model_unavailable = hypothesis_payload_read_model_unavailable
_load_trading_status_hypothesis_runtime = load_trading_status_hypothesis_runtime
_load_trading_status_llm_evaluation = load_trading_status_llm_evaluation
_load_trading_status_runtime_ledger_portfolio_summary = (
    load_trading_status_runtime_ledger_portfolio_summary
)
_load_trading_status_tca_summary = load_trading_status_tca_summary
_load_trading_status_tigerbeetle_ledger = load_trading_status_tigerbeetle_ledger
_load_rejected_signal_outcome_learning_summary = (
    load_rejected_signal_outcome_learning_summary
)
router = APIRouter()

_FAST_STATUS_GATE_REASONS = {
    "emergency_stop_active",
    "kill_switch_enabled",
    "live_submit_activation_expired",
    "live_submit_activation_expiry_invalid",
    "live_submit_activation_missing",
    "simple_submit_disabled",
    "trading_disabled",
}


def _fast_status_gate_reason(live_submission_gate: dict[str, object]) -> str | None:
    raw_reasons: list[object] = [
        live_submission_gate.get("reason"),
        live_submission_gate.get("blocked_reason"),
    ]
    blocked_reasons = live_submission_gate.get("blocked_reasons")
    if isinstance(blocked_reasons, list):
        raw_reasons.extend(cast(list[object], blocked_reasons))
    for raw_reason in raw_reasons:
        reason = str(raw_reason or "").strip()
        if reason in _FAST_STATUS_GATE_REASONS:
            return reason
    return None


def _skip_expensive_status_reads_after_closed_gate(
    status_read_budget: TradingStatusReadBudget,
    *,
    reason: str,
) -> tuple[
    dict[str, object],
    dict[str, object],
    dict[str, object],
    dict[str, object],
    Any,
]:
    llm_reason = status_read_budget.skip_reason(
        "llm_evaluation",
        reason_code=reason,
    )
    tca_reason = status_read_budget.skip_reason(
        "tca_summary",
        reason_code=reason,
    )
    hypothesis_reason = status_read_budget.skip_reason(
        "hypothesis_runtime",
        reason_code=reason,
    )
    hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
        _budget_unavailable_hypothesis_runtime_payload(reason=hypothesis_reason)
    )
    return (
        _budget_unavailable_llm_evaluation_payload(llm_reason),
        _budget_unavailable_tca_summary_payload(tca_reason),
        hypothesis_payload,
        hypothesis_summary,
        hypothesis_dependency_quorum,
    )


@router.get("/trading/status")
def trading_status() -> dict[str, object]:
    """Return trading loop status and metrics."""

    status_read_budget = _TradingStatusReadBudget()
    current_app = get_app()
    scheduler: TradingScheduler | None = getattr(
        current_app.state, "trading_scheduler", None
    )
    if scheduler is None:
        scheduler = TradingScheduler()
        current_app.state.trading_scheduler = scheduler
    state = scheduler.state
    active_simulation_context = active_simulation_runtime_context()
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    forecast_service_status = _forecast_service_status(empirical_jobs)
    lean_authority_status = _lean_authority_status()
    clickhouse_ta_status = _load_clickhouse_ta_status(scheduler)
    status_observed_at = datetime.now(timezone.utc)
    status_stage_scope = "live" if settings.trading_mode == "live" else "paper"
    market_context_status = scheduler.market_context_status()
    gate_hypothesis_payload = _deferred_hypothesis_payload_for_live_submission_gate()
    live_submission_gate_skip_reason = status_read_budget.skip_reason_if_unavailable(
        "live_submission_gate",
        min_remaining_seconds=2.0,
    )
    if live_submission_gate_skip_reason is not None:
        live_submission_gate = _budget_exhausted_live_submission_gate_payload(
            reason=live_submission_gate_skip_reason,
            empirical_jobs_status=empirical_jobs,
            quant_health_status=quant_evidence,
        )
    else:
        with SessionLocal() as session:
            live_submission_gate = _build_live_submission_gate_payload(
                state,
                session=session,
                hypothesis_summary=gate_hypothesis_payload,
                empirical_jobs_status=empirical_jobs,
                dspy_runtime_status=cast(
                    dict[str, object],
                    scheduler.llm_status().get("dspy_runtime", {}),
                ),
                quant_health_status=quant_evidence,
                clickhouse_ta_status=clickhouse_ta_status,
            )
        if not bool(live_submission_gate.get("read_model_unavailable")):
            setattr(scheduler, "_last_live_submission_gate", dict(live_submission_gate))
    fast_status_gate_reason = (
        None
        if live_submission_gate_skip_reason is not None
        else _fast_status_gate_reason(live_submission_gate)
    )
    if fast_status_gate_reason is not None:
        (
            llm_evaluation,
            tca_summary,
            hypothesis_payload,
            hypothesis_summary,
            hypothesis_dependency_quorum,
        ) = _skip_expensive_status_reads_after_closed_gate(
            status_read_budget,
            reason=fast_status_gate_reason,
        )
    else:
        llm_evaluation = _load_trading_status_llm_evaluation(status_read_budget)
        tca_summary = _load_trading_status_tca_summary(
            status_read_budget,
            scheduler=scheduler,
        )
        hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
            _load_trading_status_hypothesis_runtime(
                status_read_budget,
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
                feature_readiness=clickhouse_ta_status,
            )
        )
    if (
        live_submission_gate_skip_reason is None
        and fast_status_gate_reason is None
        and not _hypothesis_payload_read_model_unavailable(hypothesis_payload)
        and status_read_budget.remaining_seconds() >= 2.0
    ):
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
                clickhouse_ta_status=clickhouse_ta_status,
            )
        if not bool(live_submission_gate.get("read_model_unavailable")):
            setattr(scheduler, "_last_live_submission_gate", dict(live_submission_gate))
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=state,
        hypothesis_summary=hypothesis_summary,
    )
    control_plane_contract = _build_control_plane_contract(
        state,
        hypothesis_summary=hypothesis_summary,
        dependency_quorum=hypothesis_dependency_quorum,
    )
    shorting_metadata_status = scheduler.shorting_metadata_status()
    rejection_alert_status = scheduler.rejection_alert_status()
    tigerbeetle_ledger = _load_trading_status_tigerbeetle_ledger(status_read_budget)
    runtime_ledger_portfolio_summary = (
        _load_trading_status_runtime_ledger_portfolio_summary(
            status_read_budget,
            account_label=settings.trading_account_label,
            stage_scope=status_stage_scope,
            observed_at=status_observed_at,
        )
    )
    last_decision_at = None
    last_decision_skip_reason = status_read_budget.skip_reason_if_unavailable(
        "last_decision",
        min_remaining_seconds=0.25,
    )
    if last_decision_skip_reason is None:
        with SessionLocal() as session:
            last_decision_at = _load_last_decision_at(session)
    persisted_rejected_signal_outcome_learning = None
    rejected_signal_outcome_learning_skip_reason = (
        status_read_budget.skip_reason_if_unavailable(
            "rejected_signal_outcome_learning",
            min_remaining_seconds=0.5,
        )
    )
    if rejected_signal_outcome_learning_skip_reason is None:
        with SessionLocal() as session:
            persisted_rejected_signal_outcome_learning = (
                _load_rejected_signal_outcome_learning_summary(session)
            )
    simple_lane_reject_reason_totals = _simple_lane_reject_reason_totals(state)
    simple_lane_status = _build_simple_lane_status_payload()
    submission_authority = _build_submission_authority_status(
        live_submission_gate,
        simple_lane_status=simple_lane_status,
    )
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
    renewal_bond_profit_escrow = _build_renewal_bond_profit_escrow_payload(
        state=state,
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    route_reacquisition_board = _build_route_reacquisition_board_payload(
        proof_floor=proof_floor,
        active_revision=str(shadow_first_runtime["active_revision"]),
    )
    profit_signal_quorum = _build_profit_signal_quorum_payload(
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
    )
    route_claim_symbols = _route_claim_symbols(profit_signal_quorum)
    options_catalog_freshness_skip_reason = (
        status_read_budget.skip_reason_if_unavailable(
            "options_catalog_freshness",
            min_remaining_seconds=2.0,
        )
    )
    if options_catalog_freshness_skip_reason is not None:
        options_catalog_freshness = _budget_exhausted_options_catalog_freshness_payload(
            reason=options_catalog_freshness_skip_reason,
            route_symbols=route_claim_symbols,
        )
    else:
        with SessionLocal() as session:
            options_catalog_freshness = _load_options_catalog_freshness_summary(
                session,
                route_symbols=route_claim_symbols,
            )
    capital_replay_projection = _build_capital_replay_projection_payload(
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
    )
    quality_adjusted_profit_frontier = _build_quality_adjusted_profit_frontier_payload(
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        active_simulation_context=active_simulation_context,
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _build_consumer_evidence_receipt_projection(
            forecast_service_status=forecast_service_status,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        )
    )
    capital_reentry_cohort_ledger = _build_capital_reentry_cohort_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
    )
    profit_repair_settlement_ledger = _build_profit_repair_settlement_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
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
            dependency_quorum=hypothesis_dependency_quorum.as_payload(),
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
    build_payload = {
        "version": BUILD_VERSION,
        "commit": main_runtime_value("BUILD_COMMIT"),
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": shadow_first_runtime["active_revision"],
    }
    profit_freshness_frontier = _build_profit_freshness_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
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
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _build_evidence_clock_payloads(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=hypothesis_dependency_quorum.as_payload(),
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
        source_commit=main_runtime_value("BUILD_COMMIT"),
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
            dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        ),
    )
    route_evidence_clearinghouse_packet = _build_route_evidence_clearinghouse_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
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
    repair_bid_settlement_ledger = _build_repair_bid_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        build=build_payload,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quant_evidence=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
    )
    route_warrant_exchange = _build_route_warrant_exchange_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=main_runtime_value("BUILD_COMMIT"),
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
        source_commit=main_runtime_value("BUILD_COMMIT"),
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
        source_commit=main_runtime_value("BUILD_COMMIT"),
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
    rejected_signal_outcome_learning = _build_rejected_signal_outcome_learning_payload(
        state,
        persisted_summary=persisted_rejected_signal_outcome_learning,
    )
    return {
        "enabled": settings.trading_enabled,
        "autonomy_enabled": settings.trading_autonomy_enabled,
        "mode": settings.trading_mode,
        "pipeline_mode": settings.trading_pipeline_mode,
        "execution_lane": settings.trading_pipeline_mode,
        "kill_switch_enabled": settings.trading_kill_switch_enabled,
        "build": build_payload,
        "status_read_budget": status_read_budget.as_payload(),
        "shadow_first": shadow_first_runtime,
        "execution_advisor": {
            "enabled": settings.trading_execution_advisor_enabled,
            "live_apply_enabled": settings.trading_execution_advisor_live_apply_enabled,
            "usage_total": dict(state.metrics.execution_advisor_usage_total),
            "fallback_total": dict(state.metrics.execution_advisor_fallback_total),
        },
        "running": state.running,
        "live_submission_gate": live_submission_gate,
        "submission_authority": submission_authority,
        "tigerbeetle_ledger": tigerbeetle_ledger,
        "portfolio_runtime_ledger_summary": runtime_ledger_portfolio_summary,
        "runtime_ledger_profit_distance_readback": (
            runtime_ledger_portfolio_summary.get(
                "runtime_ledger_profit_distance_readback"
            )
        ),
        "profit_lease_projection": live_submission_gate.get("profit_lease_projection"),
        "proof_floor": proof_floor,
        "renewal_bond_profit_escrow": renewal_bond_profit_escrow,
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": quality_adjusted_profit_frontier,
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
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "rejected_signal_outcome_learning": rejected_signal_outcome_learning,
        "route_reacquisition_book": proof_floor.get("route_reacquisition_book"),
        "route_reacquisition_board": route_reacquisition_board,
        "quant_evidence": quant_evidence,
        "last_decision_at": last_decision_at,
        "simple_lane_status": simple_lane_status,
        "simple_lane_reject_reason_totals": simple_lane_reject_reason_totals,
        "simple_lane_orders_submitted_total": (
            state.metrics.orders_submitted_total
            if settings.trading_pipeline_mode == "simple"
            else 0
        ),
        "last_run_at": state.last_run_at,
        "last_reconcile_at": state.last_reconcile_at,
        "last_error": state.last_error,
        "autonomy": {
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
            "bridge_status": _build_autonomy_bridge_status(scheduler),
        },
        "signal_continuity": {
            "universe_source": settings.trading_universe_source,
            "universe_status": state.universe_source_status,
            "universe_reason": state.universe_source_reason,
            "universe_symbols_count": state.universe_symbols_count,
            "universe_cache_age_seconds": state.universe_cache_age_seconds,
            "universe_fail_safe_blocked": state.universe_fail_safe_blocked,
            "universe_fail_safe_block_reason": state.universe_fail_safe_block_reason,
            "market_session_open": state.market_session_open,
            "last_state": state.last_signal_continuity_state,
            "last_reason": state.last_signal_continuity_reason,
            "last_actionable": state.last_signal_continuity_actionable,
            "alert_active": state.signal_continuity_alert_active,
            "alert_reason": state.signal_continuity_alert_reason,
            "alert_started_at": state.signal_continuity_alert_started_at,
            "alert_last_seen_at": state.signal_continuity_alert_last_seen_at,
            "alert_recovery_streak": state.signal_continuity_recovery_streak,
            "no_signal_reason_streak": dict(state.metrics.no_signal_reason_streak),
            "signal_staleness_alert_total": dict(
                state.metrics.signal_staleness_alert_total
            ),
            "signal_continuity_promotion_block_total": state.metrics.signal_continuity_promotion_block_total,
            "no_signal_streak_alert_threshold": settings.trading_signal_no_signal_streak_alert_threshold,
            "signal_lag_alert_threshold_seconds": settings.trading_signal_stale_lag_alert_seconds,
            "signal_continuity_recovery_cycles": settings.trading_signal_continuity_recovery_cycles,
        },
        "market_context": market_context_status,
        "shorting_metadata": shorting_metadata_status,
        "rejections": {
            "policy_veto_total": state.metrics.llm_policy_veto_total,
            "runtime_fallback_total": state.metrics.llm_runtime_fallback_total,
            "rejected_signal_events_total": state.metrics.rejected_signal_events_total,
            "rejected_signal_outcome_label_pending_total": (
                state.metrics.rejected_signal_outcome_label_pending_total
            ),
            "rejected_signal_reason_total": dict(
                state.metrics.rejected_signal_reason_total
            ),
            "strategy_intent_suppression_total": dict(
                state.metrics.strategy_intent_suppression_total
            ),
            "market_context_block_total": state.metrics.llm_market_context_block_total,
            "pre_llm_capacity_reject_total": state.metrics.pre_llm_capacity_reject_total,
            "pre_llm_qty_below_min_total": state.metrics.pre_llm_qty_below_min_total,
            "runtime_fallback_ratio": rejection_alert_status["runtime_fallback_ratio"],
            "runtime_fallback_alert_ratio_threshold": rejection_alert_status[
                "runtime_fallback_alert_ratio_threshold"
            ],
            "runtime_fallback_alert_active": rejection_alert_status[
                "runtime_fallback_alert_active"
            ],
        },
        "alerts": {
            "market_context_alert_active": market_context_status["alert_active"],
            "market_context_alert_reason": market_context_status["alert_reason"],
            "runtime_fallback_alert_active": rejection_alert_status[
                "runtime_fallback_alert_active"
            ],
            "shorting_metadata_alert_active": rejection_alert_status[
                "shorting_metadata_alert_active"
            ],
        },
        "rollback": {
            "emergency_stop_active": state.emergency_stop_active,
            "emergency_stop_reason": state.emergency_stop_reason,
            "emergency_stop_triggered_at": state.emergency_stop_triggered_at,
            "emergency_stop_resolved_at": state.emergency_stop_resolved_at,
            "emergency_stop_recovery_streak": state.emergency_stop_recovery_streak,
            "incidents_total": state.rollback_incidents_total,
            "incident_evidence_path": state.rollback_incident_evidence_path,
        },
        "posthog": {
            "enabled": settings.posthog_enabled,
            "host": settings.posthog_host,
            "project_id": settings.posthog_project_id,
            "event_total": dict(state.metrics.domain_telemetry_event_total),
            "dropped_total": dict(state.metrics.domain_telemetry_dropped_total),
        },
        "metrics": state.metrics.__dict__,
        "llm": scheduler.llm_status(),
        "llm_evaluation": llm_evaluation,
        "tca": tca_summary,
        "hypotheses": hypothesis_payload,
        "forecast_service": forecast_service_status,
        "lean_authority": lean_authority_status,
        "empirical_jobs": empirical_jobs,
        "simulation": {
            "enabled": settings.trading_simulation_enabled,
            "run_id": (active_simulation_context or {}).get("run_id")
            or settings.trading_simulation_run_id,
            "dataset_id": (active_simulation_context or {}).get("dataset_id")
            or settings.trading_simulation_dataset_id,
            "window_start": (active_simulation_context or {}).get("window_start")
            or settings.trading_simulation_window_start,
            "window_end": (active_simulation_context or {}).get("window_end")
            or settings.trading_simulation_window_end,
            "time_source": trading_time_status(
                account_label=settings.trading_account_label
            ),
        },
        "control_plane_contract": control_plane_contract,
        "evidence_continuity": state.last_evidence_continuity_report,
    }


__all__ = ["trading_status"]
