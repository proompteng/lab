from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Optional, cast
from ..decisions import DecisionRuntimeTelemetry
from ..portfolio import AllocationResult
from ..route_metadata import coerce_route_text
from ..tca import AdaptiveExecutionPolicyDecision

def _normalize_reason_metric(*args: Any, **kwargs: Any) -> Any: ...
def _split_reason_codes(*args: Any, **kwargs: Any) -> Any: ...
def _optional_decimal(*args: Any, **kwargs: Any) -> Any: ...

RuntimeUncertaintyGateAction: Any

class RuntimeUncertaintyGate:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    action: RuntimeUncertaintyGateAction
    source: str
    coverage_error: Decimal | None
    shift_score: Decimal | None
    conformal_interval_width: Decimal | None
    regime_action_source: str | None
    regime_label: str | None
    regime_stale: bool | None
    reason: str | None
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class TradingMetrics:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    decisions_total: int
    orders_submitted_total: int
    orders_rejected_total: int
    planned_decisions_with_execution_total: int
    planned_decisions_stale_total: int
    planned_decisions_timeout_rejected_total: int
    planned_decision_age_seconds: int
    reconcile_updates_total: int
    llm_requests_total: int
    llm_approve_total: int
    llm_veto_total: int
    llm_policy_veto_total: int
    llm_runtime_fallback_total: int
    llm_adjust_total: int
    llm_abstain_total: int
    llm_escalate_total: int
    llm_error_total: int
    llm_parse_error_total: int
    llm_validation_error_total: int
    llm_circuit_open_total: int
    llm_fail_mode_override_total: int
    llm_fail_mode_exception_total: int
    llm_stage_policy_violation_total: int
    llm_policy_resolution_total: dict[str, int]
    llm_shadow_total: int
    llm_guardrail_block_total: int
    llm_guardrail_shadow_total: int
    llm_policy_fallback_total: int
    llm_market_context_block_total: int
    llm_market_context_error_total: int
    llm_market_context_reason_total: dict[str, int]
    llm_unavailable_reason_total: dict[str, int]
    llm_unavailable_reject_reason_total: dict[str, int]
    llm_market_context_shadow_total: dict[str, int]
    pre_llm_capacity_reject_total: int
    pre_llm_qty_below_min_total: int
    llm_tokens_prompt_total: int
    llm_tokens_completion_total: int
    llm_committee_requests_total: dict[str, int]
    llm_committee_latency_ms: dict[str, int]
    llm_committee_verdict_total: dict[str, int]
    llm_committee_schema_error_total: int
    llm_committee_veto_alignment_total: int
    llm_committee_veto_total: int
    execution_requests_total: dict[str, int]
    execution_fallback_total: dict[str, int]
    execution_fallback_reason_total: dict[str, int]
    execution_advisor_usage_total: dict[str, int]
    execution_advisor_fallback_total: dict[str, int]
    lean_request_total: dict[str, int]
    lean_failure_taxonomy_total: dict[str, int]
    lean_latency_ms: dict[str, float]
    lean_shadow_parity_total: dict[str, int]
    lean_shadow_failure_total: dict[str, int]
    lean_strategy_shadow_total: dict[str, int]
    lean_canary_breach_total: dict[str, int]
    no_signal_windows_total: int
    no_signal_reason_total: dict[str, int]
    no_signal_reason_streak: dict[str, int]
    no_signal_streak: int
    market_session_open: int
    trading_shorts_enabled: int
    signal_continuity_actionable: int
    signal_continuity_alert_active: int
    signal_continuity_alert_recovery_streak: int
    signal_continuity_promotion_block_total: int
    signal_lag_seconds: int | None
    signal_staleness_alert_total: dict[str, int]
    signal_expected_staleness_total: dict[str, int]
    signal_actionable_staleness_total: dict[str, int]
    universe_fail_safe_reason_total: dict[str, int]
    universe_resolution_total: dict[str, int]
    universe_symbols_count: int
    universe_cache_age_seconds: int
    signal_continuity_breach_total: int
    order_feed_messages_total: int
    order_feed_events_persisted_total: int
    order_feed_duplicates_total: int
    order_feed_out_of_order_total: int
    order_feed_missing_fields_total: int
    order_feed_apply_updates_total: int
    order_feed_consumer_errors_total: int
    strategy_events_total: dict[str, int]
    strategy_intents_total: dict[str, int]
    strategy_intent_suppression_total: dict[str, int]
    strategy_errors_total: dict[str, int]
    strategy_latency_ms: dict[str, int]
    intent_conflict_total: int
    strategy_runtime_isolated_failures_total: int
    strategy_runtime_fallback_total: int
    strategy_runtime_legacy_path_total: int
    forecast_router_inference_latency_ms: dict[str, int]
    forecast_router_fallback_total: dict[str, int]
    forecast_calibration_error: dict[str, str]
    forecast_route_selection_total: dict[str, int]
    feature_batch_rows_total: int
    feature_null_rate: dict[str, float]
    feature_staleness_ms_p95: int
    feature_duplicate_ratio: float
    feature_schema_mismatch_total: int
    feature_quality_rejections_total: int
    feature_quality_reject_reason_total: dict[str, int]
    feature_quality_cursor_commit_blocked_total: dict[str, int]
    signal_batch_order_violation_total: int
    feature_parity_drift_total: int
    drift_detection_checks_total: int
    drift_incidents_total: int
    drift_incident_reason_total: dict[str, int]
    drift_action_total: dict[str, int]
    drift_action_cooldown_skip_total: int
    drift_promotion_block_total: int
    drift_rollback_trigger_total: int
    evidence_continuity_checks_total: int
    evidence_continuity_failures_total: int
    evidence_continuity_last_checked_ts_seconds: float
    evidence_continuity_last_success_ts_seconds: float
    evidence_continuity_last_failed_runs: int
    autonomy_promotions_total: int
    autonomy_denials_total: int
    autonomy_demotions_total: int
    autonomy_promotion_action_total: dict[str, int]
    autonomy_last_signal_count: int
    autonomy_last_decision_count: int
    autonomy_last_trade_count: int
    autonomy_last_fold_metrics_count: int
    autonomy_last_stress_metrics_count: int
    allocator_requests_total: int
    allocator_approved_total: int
    allocator_rejected_total: int
    allocator_clipped_total: int
    allocator_reason_total: dict[str, int]
    allocator_regime_total: dict[str, int]
    decision_regime_resolution_source_total: dict[str, int]
    decision_regime_resolution_fallback_total: dict[str, int]
    allocator_fragility_state_total: dict[str, int]
    allocator_multiplier_total: dict[str, int]
    fragility_score: dict[str, float]
    stability_mode_active_total: int
    adaptive_policy_decisions_total: int
    adaptive_policy_applied_total: int
    adaptive_policy_fallback_total: int
    adaptive_policy_key_total: dict[str, int]
    adaptive_policy_effect_size_bps: dict[str, float]
    adaptive_policy_degradation_bps: dict[str, float]
    autonomy_signal_throughput_total: int
    autonomy_decision_throughput_total: int
    autonomy_trade_throughput_total: int
    autonomy_promotion_allowed_total: int
    autonomy_promotion_blocked_total: int
    autonomy_recommendation_total: dict[str, int]
    autonomy_outcome_total: dict[str, int]
    domain_telemetry_event_total: dict[str, int]
    domain_telemetry_dropped_total: dict[str, int]
    calibration_coverage_error: float
    conformal_interval_width: float
    regime_shift_score: float
    uncertainty_gate_action_total: dict[str, int]
    runtime_uncertainty_gate_action_total: dict[str, int]
    runtime_uncertainty_gate_blocked_total: dict[str, int]
    runtime_regime_gate_action_total: dict[str, int]
    runtime_regime_gate_blocked_total: dict[str, int]
    recalibration_runs_total: dict[str, int]
    decision_reject_reason_total: dict[str, int]
    submission_block_total: dict[str, int]
    decision_state_total: dict[str, int]
    qty_resolution_total: dict[str, int]
    sell_inventory_context_total: dict[str, int]
    execution_local_reject_total: dict[str, int]
    execution_submit_attempt_total: dict[str, int]
    execution_submit_result_total: dict[str, int]
    execution_validation_mismatch_total: int
    simulation_position_state_total: dict[str, int]
    simulation_preflight_failure_total: dict[str, int]
    rejected_signal_events_total: int
    rejected_signal_outcome_label_pending_total: int
    rejected_signal_reason_total: dict[str, int]
    def record_execution_request(*args: Any, **kwargs: Any) -> Any: ...
    def record_execution_fallback(*args: Any, **kwargs: Any) -> Any: ...
    def record_execution_advisor_result(*args: Any, **kwargs: Any) -> Any: ...
    def record_no_signal(*args: Any, **kwargs: Any) -> Any: ...
    def record_lean_observability(*args: Any, **kwargs: Any) -> Any: ...
    def record_lean_shadow(*args: Any, **kwargs: Any) -> Any: ...
    def record_lean_strategy_shadow(*args: Any, **kwargs: Any) -> Any: ...
    def record_lean_canary_breach(*args: Any, **kwargs: Any) -> Any: ...
    def record_signal_staleness_alert(*args: Any, **kwargs: Any) -> Any: ...
    def record_signal_expected_staleness(*args: Any, **kwargs: Any) -> Any: ...
    def record_signal_actionable_staleness(*args: Any, **kwargs: Any) -> Any: ...
    def record_universe_fail_safe_block(*args: Any, **kwargs: Any) -> Any: ...
    def record_signal_continuity_alert_state(*args: Any, **kwargs: Any) -> Any: ...
    def record_universe_resolution(*args: Any, **kwargs: Any) -> Any: ...
    def record_market_context_result(*args: Any, **kwargs: Any) -> Any: ...
    def record_llm_unavailable(*args: Any, **kwargs: Any) -> Any: ...
    def record_decision_rejection_reasons(*args: Any, **kwargs: Any) -> Any: ...
    def record_submission_block(*args: Any, **kwargs: Any) -> Any: ...
    def record_decision_state(*args: Any, **kwargs: Any) -> Any: ...
    def observe_planned_decision_age(*args: Any, **kwargs: Any) -> Any: ...
    def record_feature_quality_rejection(*args: Any, **kwargs: Any) -> Any: ...
    def record_feature_quality_cursor_commit_blocked(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def record_qty_resolution(*args: Any, **kwargs: Any) -> Any: ...
    def record_sell_inventory_context(*args: Any, **kwargs: Any) -> Any: ...
    def record_execution_local_reject(*args: Any, **kwargs: Any) -> Any: ...
    def record_execution_submit_attempt(*args: Any, **kwargs: Any) -> Any: ...
    def record_execution_submit_result(*args: Any, **kwargs: Any) -> Any: ...
    def record_simulation_position_state(*args: Any, **kwargs: Any) -> Any: ...
    def record_simulation_preflight_failure(*args: Any, **kwargs: Any) -> Any: ...
    def record_rejected_signal_event(*args: Any, **kwargs: Any) -> Any: ...
    def record_llm_policy_resolution(*args: Any, **kwargs: Any) -> Any: ...
    def record_llm_committee_member(*args: Any, **kwargs: Any) -> Any: ...
    def record_llm_committee_veto_alignment(*args: Any, **kwargs: Any) -> Any: ...
    def record_strategy_runtime(*args: Any, **kwargs: Any) -> Any: ...
    def record_allocator_result(*args: Any, **kwargs: Any) -> Any: ...
    def record_forecast_telemetry(*args: Any, **kwargs: Any) -> Any: ...
    def record_decision_regime_resolution(*args: Any, **kwargs: Any) -> Any: ...
    def record_adaptive_policy_result(*args: Any, **kwargs: Any) -> Any: ...
    def record_autonomy_promotion_outcome(*args: Any, **kwargs: Any) -> Any: ...
    def record_domain_telemetry(*args: Any, **kwargs: Any) -> Any: ...
    def record_uncertainty_gate(*args: Any, **kwargs: Any) -> Any: ...
    def record_runtime_uncertainty_gate(*args: Any, **kwargs: Any) -> Any: ...
    def record_runtime_regime_gate(*args: Any, **kwargs: Any) -> Any: ...

class TradingState:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    running: bool
    startup_started_at: Optional[datetime]
    last_run_at: Optional[datetime]
    last_reconcile_at: Optional[datetime]
    last_error: Optional[str]
    autonomy_runs_total: int
    autonomy_signals_total: int
    autonomy_patches_total: int
    last_autonomy_run_at: Optional[datetime]
    last_autonomy_error: Optional[str]
    last_autonomy_reason: Optional[str]
    last_autonomy_run_id: Optional[str]
    last_autonomy_candidate_id: Optional[str]
    last_autonomy_gates: Optional[str]
    last_autonomy_actuation_intent: Optional[str]
    last_autonomy_phase_manifest: Optional[str]
    last_autonomy_patch: Optional[str]
    last_autonomy_recommendation: Optional[str]
    last_autonomy_promotion_action: Optional[str]
    last_autonomy_promotion_eligible: Optional[bool]
    last_autonomy_recommendation_trace_id: Optional[str]
    last_autonomy_iteration: Optional[int]
    last_autonomy_iteration_notes_path: Optional[str]
    last_autonomy_throughput: Optional[dict[str, int | bool | str | None]]
    last_ingest_signals_total: int
    last_ingest_window_start: Optional[datetime]
    last_ingest_window_end: Optional[datetime]
    last_ingest_reason: Optional[str]
    market_session_open: Optional[bool]
    last_signal_continuity_state: Optional[str]
    last_signal_continuity_reason: Optional[str]
    last_signal_continuity_actionable: Optional[bool]
    signal_continuity_alert_active: bool
    signal_continuity_alert_reason: Optional[str]
    signal_continuity_alert_started_at: Optional[datetime]
    signal_continuity_alert_last_seen_at: Optional[datetime]
    signal_continuity_recovery_streak: int
    signal_bootstrap_started_at: Optional[datetime]
    signal_bootstrap_completed_at: Optional[datetime]
    last_market_context_symbol: Optional[str]
    last_market_context_checked_at: Optional[datetime]
    last_market_context_as_of: Optional[datetime]
    last_market_context_freshness_seconds: Optional[int]
    last_market_context_quality_score: Optional[float]
    last_market_context_domain_states: dict[str, str]
    last_market_context_risk_flags: list[str]
    last_market_context_allow_llm: Optional[bool]
    last_market_context_reason: Optional[str]
    last_market_context_fetch_error: Optional[str]
    market_context_alert_active: bool
    market_context_alert_reason: Optional[str]
    autonomy_no_signal_streak: int
    last_evidence_continuity_report: Optional[dict[str, Any]]
    autonomy_failure_streak: int
    universe_source_status: Optional[str]
    universe_source_reason: Optional[str]
    universe_symbols_count: int
    universe_cache_age_seconds: Optional[int]
    universe_fail_safe_blocked: bool
    universe_fail_safe_block_reason: Optional[str]
    emergency_stop_active: bool
    emergency_stop_reason: Optional[str]
    emergency_stop_triggered_at: Optional[datetime]
    emergency_stop_resolved_at: Optional[datetime]
    emergency_stop_recovery_streak: int
    rollback_incidents_total: int
    rollback_incident_evidence_path: Optional[str]
    drift_status: str
    drift_active_incident_id: Optional[str]
    drift_active_reason_codes: list[str]
    drift_last_detection_at: Optional[datetime]
    drift_last_detection_path: Optional[str]
    drift_last_action_type: Optional[str]
    drift_last_action_at: Optional[datetime]
    drift_last_action_path: Optional[str]
    drift_last_outcome_path: Optional[str]
    drift_live_promotion_eligible: bool
    drift_live_promotion_reasons: list[str]
    last_runtime_uncertainty_gate_action: str | None
    last_runtime_uncertainty_gate_source: str | None
    last_runtime_uncertainty_gate_reason: str | None
    last_runtime_regime_gate_action: str | None
    last_runtime_regime_gate_source: str | None
    last_runtime_regime_gate_reason: str | None
    last_rejected_signal_outcome_event: Optional[dict[str, Any]]
    metrics: TradingMetrics

__all__: Any
