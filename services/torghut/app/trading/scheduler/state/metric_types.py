"""Scheduler runtime state and metrics types."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal, Optional, cast


def normalize_reason_metric(reason: str | None) -> str:
    normalized = reason.strip() if isinstance(reason, str) else ""
    return normalized or "unknown"


def split_reason_codes(reason: str | None) -> list[str]:
    if not isinstance(reason, str):
        return []
    return [part.strip() for part in reason.split(";") if part.strip()]


def optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


RuntimeUncertaintyGateAction = Literal["pass", "degrade", "abstain", "fail"]


@dataclass(frozen=True)
class RuntimeUncertaintyGate:
    action: RuntimeUncertaintyGateAction
    source: str
    coverage_error: Decimal | None = None
    shift_score: Decimal | None = None
    conformal_interval_width: Decimal | None = None
    regime_action_source: str | None = None
    regime_label: str | None = None
    regime_stale: bool | None = None
    reason: str | None = None

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "action": self.action,
            "source": self.source,
        }
        if self.coverage_error is not None:
            payload["coverage_error"] = str(self.coverage_error)
        if self.shift_score is not None:
            payload["shift_score"] = str(self.shift_score)
        if self.conformal_interval_width is not None:
            payload["conformal_interval_width"] = str(self.conformal_interval_width)
        if self.regime_action_source is not None:
            payload["regime_action_source"] = self.regime_action_source
        if self.regime_label is not None:
            payload["regime_label"] = self.regime_label
        if self.regime_stale is not None:
            payload["regime_stale"] = self.regime_stale
        if self.reason is not None:
            payload["reason"] = self.reason
        return payload


@dataclass(frozen=True)
class AutonomyPromotionOutcomeMetrics:
    signal_count: int
    decision_count: int
    trade_count: int
    recommendation: str | None
    promotion_allowed: bool
    outcome: str


@dataclass
class TradingMetricsFields:
    decisions_total: int = 0

    orders_submitted_total: int = 0

    orders_rejected_total: int = 0

    planned_decisions_with_execution_total: int = 0

    planned_decisions_stale_total: int = 0

    planned_decisions_timeout_rejected_total: int = 0

    planned_decision_age_seconds: int = 0

    reconcile_updates_total: int = 0

    llm_requests_total: int = 0

    llm_approve_total: int = 0

    llm_veto_total: int = 0

    llm_policy_veto_total: int = 0

    llm_runtime_fallback_total: int = 0

    llm_adjust_total: int = 0

    llm_abstain_total: int = 0

    llm_escalate_total: int = 0

    llm_error_total: int = 0

    llm_parse_error_total: int = 0

    llm_validation_error_total: int = 0

    llm_circuit_open_total: int = 0

    llm_fail_mode_override_total: int = 0

    llm_fail_mode_exception_total: int = 0

    llm_stage_policy_violation_total: int = 0

    llm_policy_resolution_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    llm_shadow_total: int = 0

    llm_guardrail_block_total: int = 0

    llm_guardrail_shadow_total: int = 0

    llm_policy_fallback_total: int = 0

    llm_market_context_block_total: int = 0

    llm_market_context_error_total: int = 0

    llm_market_context_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    llm_unavailable_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    llm_unavailable_reject_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    llm_market_context_shadow_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    pre_llm_capacity_reject_total: int = 0

    pre_llm_qty_below_min_total: int = 0

    llm_tokens_prompt_total: int = 0

    llm_tokens_completion_total: int = 0

    llm_committee_requests_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    llm_committee_latency_ms: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    llm_committee_verdict_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    llm_committee_schema_error_total: int = 0

    llm_committee_veto_alignment_total: int = 0

    llm_committee_veto_total: int = 0

    execution_requests_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_fallback_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_advisor_usage_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_advisor_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    lean_strategy_shadow_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    no_signal_windows_total: int = 0

    no_signal_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    no_signal_reason_streak: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    no_signal_streak: int = 0

    market_session_open: int = 0

    trading_shorts_enabled: int = 0

    signal_continuity_actionable: int = 0

    signal_continuity_alert_active: int = 0

    signal_continuity_alert_recovery_streak: int = 0

    signal_continuity_promotion_block_total: int = 0

    signal_lag_seconds: int | None = None

    signal_staleness_alert_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    signal_expected_staleness_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    signal_actionable_staleness_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    universe_fail_safe_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    universe_resolution_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    universe_symbols_count: int = 0

    universe_cache_age_seconds: int = 0

    signal_continuity_breach_total: int = 0

    order_feed_messages_total: int = 0

    order_feed_events_persisted_total: int = 0

    order_feed_duplicates_total: int = 0

    order_feed_out_of_order_total: int = 0

    order_feed_missing_fields_total: int = 0

    order_feed_apply_updates_total: int = 0

    order_feed_consumer_errors_total: int = 0

    broker_account_activity_seen_total: int = 0

    broker_account_activity_inserted_total: int = 0

    broker_account_activity_duplicates_total: int = 0

    broker_account_activity_errors_total: int = 0

    broker_stream_source_events_total: int = 0

    broker_stream_source_duplicates_total: int = 0

    strategy_events_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    strategy_intents_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    strategy_intent_suppression_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    strategy_errors_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    strategy_latency_ms: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    intent_conflict_total: int = 0

    strategy_runtime_isolated_failures_total: int = 0

    strategy_runtime_fallback_total: int = 0

    strategy_runtime_legacy_path_total: int = 0

    forecast_router_inference_latency_ms: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    forecast_router_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    forecast_calibration_error: dict[str, str] = field(
        default_factory=lambda: cast(dict[str, str], {})
    )

    forecast_route_selection_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    feature_batch_rows_total: int = 0

    feature_null_rate: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )

    feature_staleness_ms_p95: int = 0

    feature_duplicate_ratio: float = 0

    feature_schema_mismatch_total: int = 0

    feature_quality_rejections_total: int = 0

    feature_quality_reject_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    feature_quality_cursor_commit_blocked_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    signal_batch_order_violation_total: int = 0

    feature_parity_drift_total: int = 0

    drift_detection_checks_total: int = 0

    drift_incidents_total: int = 0

    drift_incident_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    drift_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    drift_action_cooldown_skip_total: int = 0

    drift_promotion_block_total: int = 0

    drift_rollback_trigger_total: int = 0

    evidence_continuity_checks_total: int = 0

    evidence_continuity_failures_total: int = 0

    evidence_continuity_last_checked_ts_seconds: float = 0

    evidence_continuity_last_success_ts_seconds: float = 0

    evidence_continuity_last_failed_runs: int = 0

    autonomy_promotions_total: int = 0

    autonomy_denials_total: int = 0

    autonomy_demotions_total: int = 0

    autonomy_promotion_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    autonomy_last_signal_count: int = 0

    autonomy_last_decision_count: int = 0

    autonomy_last_trade_count: int = 0

    autonomy_last_fold_metrics_count: int = 0

    autonomy_last_stress_metrics_count: int = 0

    allocator_requests_total: int = 0

    allocator_approved_total: int = 0

    allocator_rejected_total: int = 0

    allocator_clipped_total: int = 0

    allocator_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    allocator_regime_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    decision_regime_resolution_source_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    decision_regime_resolution_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    allocator_fragility_state_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    allocator_multiplier_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    fragility_score: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )

    stability_mode_active_total: int = 0

    adaptive_policy_decisions_total: int = 0

    adaptive_policy_applied_total: int = 0

    adaptive_policy_fallback_total: int = 0

    adaptive_policy_key_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    adaptive_policy_effect_size_bps: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )

    adaptive_policy_degradation_bps: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )

    autonomy_signal_throughput_total: int = 0

    autonomy_decision_throughput_total: int = 0

    autonomy_trade_throughput_total: int = 0

    autonomy_promotion_allowed_total: int = 0

    autonomy_promotion_blocked_total: int = 0

    autonomy_recommendation_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    autonomy_outcome_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    domain_telemetry_event_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    domain_telemetry_dropped_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    calibration_coverage_error: float = 0

    conformal_interval_width: float = 0

    regime_shift_score: float = 0

    uncertainty_gate_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    runtime_uncertainty_gate_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    runtime_uncertainty_gate_blocked_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    runtime_regime_gate_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    runtime_regime_gate_blocked_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    recalibration_runs_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    decision_reject_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    submission_block_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    broker_mutation_recovery_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    decision_state_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    qty_resolution_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    sell_inventory_context_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_local_reject_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_submit_attempt_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_submit_result_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    execution_validation_mismatch_total: int = 0

    simulation_position_state_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    simulation_preflight_failure_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    rejected_signal_events_total: int = 0

    rejected_signal_outcome_label_pending_total: int = 0

    rejected_signal_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )


__all__ = [
    "AutonomyPromotionOutcomeMetrics",
    "RuntimeUncertaintyGate",
    "RuntimeUncertaintyGateAction",
    "TradingMetricsFields",
    "normalize_reason_metric",
    "optional_decimal",
    "split_reason_codes",
]
