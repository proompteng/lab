"""Final projection for the Torghut trading status response."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from app.config import settings
from app.trading.execution_runtime import build_execution_status_payload
from app.trading.time_source import trading_time_status

from .trading_status_response_model import (
    TradingStatusResponseBuild,
    payload,
)


def project_trading_status_response(
    build: TradingStatusResponseBuild,
) -> dict[str, object]:
    state = build.context.state
    payloads = build.payloads
    rejection_alert_status = payload(payloads, "rejection_alert_status")
    capital_replay_projection = payload(payloads, "capital_replay_projection")
    execution_route, execution_route_details = _execution_route_status(
        build.core.live_submission_gate.get("execution_route")
    )
    return {
        "enabled": settings.trading_enabled,
        "autonomy_enabled": settings.trading_autonomy_enabled,
        "mode": settings.trading_mode,
        "pipeline_mode": settings.trading_pipeline_mode,
        "execution_lane": settings.trading_pipeline_mode,
        "kill_switch_enabled": settings.trading_kill_switch_enabled,
        "build": payload(payloads, "build_payload"),
        "status_read_budget": build.status_read_budget.as_payload(),
        "shadow_first": payload(payloads, "shadow_first_runtime"),
        "execution_advisor": _execution_advisor_payload(state),
        "running": state.running,
        "execution_route": execution_route,
        "execution_route_details": execution_route_details,
        "execution": build_execution_status_payload(
            state=state,
            live_submission_gate=build.core.live_submission_gate,
        ),
        "operational_submission_gate": build.core.live_submission_gate.get(
            "operational_submission_gate", build.core.live_submission_gate
        ),
        "live_submission_gate": build.core.live_submission_gate,
        "submission_authority": payload(payloads, "submission_authority"),
        "tigerbeetle_ledger": build.late.tigerbeetle_ledger,
        "portfolio_runtime_ledger_summary": build.late.runtime_ledger_portfolio_summary,
        "runtime_ledger_profit_distance_readback": build.late.runtime_ledger_portfolio_summary.get(
            "runtime_ledger_profit_distance_readback"
        ),
        "profit_lease_projection": build.core.live_submission_gate.get(
            "profit_lease_projection"
        ),
        "proof_floor": payload(payloads, "proof_floor"),
        "renewal_bond_profit_escrow": payload(payloads, "renewal_bond_profit_escrow"),
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": payload(
            payloads, "quality_adjusted_profit_frontier"
        ),
        "torghut_consumer_evidence_receipt": payload(
            payloads, "consumer_evidence_receipt"
        ),
        "route_proven_profit_receipt": payload(payloads, "route_proven_profit_receipt"),
        "consumer_evidence_canary": payload(
            payloads, "route_proven_profit_receipt"
        ).get("route_canary"),
        "capital_reentry_cohort_ledger": payload(
            payloads, "capital_reentry_cohort_ledger"
        ),
        "profit_repair_settlement_ledger": payload(
            payloads, "profit_repair_settlement_ledger"
        ),
        "routeability_repair_acceptance_ledger": payload(
            payloads, "routeability_repair_acceptance_ledger"
        ),
        "profit_freshness_frontier": payload(payloads, "profit_freshness_frontier"),
        "profit_signal_quorum": payload(payloads, "profit_signal_quorum"),
        "evidence_clock_arbiter": payload(payloads, "evidence_clock_arbiter"),
        "routeable_profit_candidate_exchange": payload(
            payloads, "routeable_profit_candidate_exchange"
        ),
        "clock_settlement_receipt": payload(payloads, "clock_settlement_receipt"),
        "route_evidence_clearinghouse_packet": payload(
            payloads, "route_evidence_clearinghouse_packet"
        ),
        "repair_bid_settlement_ledger": payload(
            payloads, "repair_bid_settlement_ledger"
        ),
        "route_warrant_exchange": payload(payloads, "route_warrant_exchange"),
        "source_serving_repair_receipt_ledger": payload(
            payloads, "source_serving_repair_receipt_ledger"
        ),
        "freshness_carry_ledger": payload(payloads, "freshness_carry_ledger"),
        "repair_receipt_frontier": payload(payloads, "repair_receipt_frontier"),
        "repair_outcome_dividend_ledger": payload(
            payloads, "repair_outcome_dividend_ledger"
        ),
        "rejected_signal_outcome_learning": payload(
            payloads, "rejected_signal_outcome_learning"
        ),
        "route_reacquisition_book": payload(payloads, "proof_floor").get(
            "route_reacquisition_book"
        ),
        "route_reacquisition_board": payload(payloads, "route_reacquisition_board"),
        "quant_evidence": build.context.quant_evidence,
        "last_decision_at": build.late.last_decision_at,
        "last_run_at": state.last_run_at,
        "last_reconcile_at": state.last_reconcile_at,
        "last_error": state.last_error,
        "autonomy": _autonomy_payload(build),
        "signal_continuity": _signal_continuity_payload(state),
        "market_context": build.context.market_context_status,
        "shorting_metadata": payload(payloads, "shorting_metadata_status"),
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
        "control_plane_contract": payload(payloads, "control_plane_contract"),
        "evidence_continuity": state.last_evidence_continuity_report,
    }


def _execution_route_status(value: object) -> tuple[str | None, dict[str, object]]:
    if isinstance(value, Mapping):
        route_payload = cast(Mapping[str, object], value)
        route = str(route_payload.get("route") or "").strip() or None
        return route, dict(route_payload)
    route = str(value or "").strip() or None
    return route, {}


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
