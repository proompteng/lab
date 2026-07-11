"""Scheduler runtime state and metrics types."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Optional, cast

from ...decisions import DecisionRuntimeTelemetry
from ...portfolio import AllocationResult
from ...route_metadata import coerce_route_text
from ...tca import AdaptiveExecutionPolicyDecision

from .metric_types import (
    AutonomyPromotionOutcomeMetrics,
    RuntimeUncertaintyGateAction,
    TradingMetricsFields,
)
from .metric_types import normalize_reason_metric, optional_decimal, split_reason_codes


class _TradingMetricsMethods(TradingMetricsFields):
    def record_execution_request(self, adapter: str | None) -> None:
        adapter_name = coerce_route_text(adapter)
        if adapter_name is None:
            return
        current = self.execution_requests_total.get(adapter_name, 0)
        self.execution_requests_total[adapter_name] = current + 1

    def record_execution_fallback(
        self,
        expected_adapter: str | None,
        actual_adapter: str | None,
        fallback_reason: str | None,
    ) -> None:
        expected_name = coerce_route_text(expected_adapter) or "unknown"
        actual_name = coerce_route_text(actual_adapter) or "unknown"
        transition = f"{expected_name}->{actual_name}"
        current = self.execution_fallback_total.get(transition, 0)
        self.execution_fallback_total[transition] = current + 1
        if fallback_reason:
            current_reason = self.execution_fallback_reason_total.get(
                fallback_reason, 0
            )
            self.execution_fallback_reason_total[fallback_reason] = current_reason + 1

    def record_execution_advisor_result(
        self,
        metadata: Mapping[str, Any] | None,
    ) -> None:
        if not isinstance(metadata, Mapping):
            return
        enabled = bool(metadata.get("enabled", False))
        applied = bool(metadata.get("applied", False))
        fallback_reason_raw = metadata.get("fallback_reason")
        fallback_reason = (
            str(fallback_reason_raw).strip()
            if isinstance(fallback_reason_raw, str)
            else ""
        )
        if applied:
            usage_status = "applied"
        elif fallback_reason == "advisor_live_apply_disabled":
            usage_status = "advisory_only"
        elif not enabled:
            usage_status = "disabled"
        elif fallback_reason:
            usage_status = "fallback"
        else:
            usage_status = "not_applied"
        self.execution_advisor_usage_total[usage_status] = (
            self.execution_advisor_usage_total.get(usage_status, 0) + 1
        )
        if fallback_reason:
            self.execution_advisor_fallback_total[fallback_reason] = (
                self.execution_advisor_fallback_total.get(fallback_reason, 0) + 1
            )

    def record_no_signal(self, reason: str | None) -> None:
        normalized = normalize_reason_metric(reason)
        self.no_signal_windows_total += 1
        current = self.no_signal_reason_total.get(normalized, 0)
        self.no_signal_reason_total[normalized] = current + 1
        for existing_reason in list(self.no_signal_reason_streak):
            if existing_reason != normalized:
                del self.no_signal_reason_streak[existing_reason]
        self.no_signal_reason_streak[normalized] = (
            self.no_signal_reason_streak.get(normalized, 0) + 1
        )

    def record_lean_observability(self, snapshot: Mapping[str, Any]) -> None:
        requests = snapshot.get("requests_total")
        if isinstance(requests, Mapping):
            for key, value in cast(Mapping[object, Any], requests).items():
                if isinstance(value, int):
                    self.lean_request_total[str(key)] = value
        failures = snapshot.get("failures_total")
        if isinstance(failures, Mapping):
            for key, value in cast(Mapping[object, Any], failures).items():
                if isinstance(value, int):
                    self.lean_failure_taxonomy_total[str(key)] = value
        latency = snapshot.get("latency_ms_avg")
        if isinstance(latency, Mapping):
            for key, value in cast(Mapping[object, Any], latency).items():
                if isinstance(value, (int, float)):
                    self.lean_latency_ms[str(key)] = float(value)

    def record_lean_shadow(
        self, *, parity_status: str | None, failure_taxonomy: str | None
    ) -> None:
        status = parity_status.strip() if isinstance(parity_status, str) else ""
        if not status:
            status = "unknown"
        self.lean_shadow_parity_total[status] = (
            self.lean_shadow_parity_total.get(status, 0) + 1
        )
        if failure_taxonomy:
            self.lean_shadow_failure_total[failure_taxonomy] = (
                self.lean_shadow_failure_total.get(failure_taxonomy, 0) + 1
            )

    def record_lean_strategy_shadow(self, parity_status: str | None) -> None:
        status = parity_status.strip() if isinstance(parity_status, str) else ""
        if not status:
            status = "unknown"
        self.lean_strategy_shadow_total[status] = (
            self.lean_strategy_shadow_total.get(status, 0) + 1
        )

    def record_lean_canary_breach(self, breach_type: str) -> None:
        self.lean_canary_breach_total[breach_type] = (
            self.lean_canary_breach_total.get(breach_type, 0) + 1
        )

    def record_signal_staleness_alert(self, reason: str | None) -> None:
        normalized = normalize_reason_metric(reason)
        current = self.signal_staleness_alert_total.get(normalized, 0)
        self.signal_staleness_alert_total[normalized] = current + 1

    def record_signal_expected_staleness(self, reason: str | None) -> None:
        normalized = normalize_reason_metric(reason)
        current = self.signal_expected_staleness_total.get(normalized, 0)
        self.signal_expected_staleness_total[normalized] = current + 1

    def record_signal_actionable_staleness(self, reason: str | None) -> None:
        normalized = normalize_reason_metric(reason)
        current = self.signal_actionable_staleness_total.get(normalized, 0)
        self.signal_actionable_staleness_total[normalized] = current + 1

    def record_universe_fail_safe_block(self, reason: str | None) -> None:
        normalized = normalize_reason_metric(reason)
        current = self.universe_fail_safe_reason_total.get(normalized, 0)
        self.universe_fail_safe_reason_total[normalized] = current + 1

    def record_signal_continuity_alert_state(
        self, *, active: bool, recovery_streak: int
    ) -> None:
        self.signal_continuity_alert_active = 1 if active else 0
        self.signal_continuity_alert_recovery_streak = max(0, int(recovery_streak))

    def record_universe_resolution(
        self,
        *,
        status: str | None,
        reason: str | None,
        symbols_count: int,
        cache_age_seconds: int | None,
    ) -> None:
        normalized_status = (status or "unknown").strip() or "unknown"
        normalized_reason = normalize_reason_metric(reason)
        metric_key = f"{normalized_status}|{normalized_reason}"
        self.universe_resolution_total[metric_key] = (
            self.universe_resolution_total.get(metric_key, 0) + 1
        )
        self.universe_symbols_count = max(0, int(symbols_count))
        self.universe_cache_age_seconds = max(0, int(cache_age_seconds or 0))

    def record_market_context_result(
        self, reason: str | None, *, shadow_mode: bool
    ) -> None:
        normalized = reason.strip() if isinstance(reason, str) else ""
        if not normalized:
            normalized = "unknown"
        current_reason = self.llm_market_context_reason_total.get(normalized, 0)
        self.llm_market_context_reason_total[normalized] = current_reason + 1
        if shadow_mode:
            current_shadow = self.llm_market_context_shadow_total.get(normalized, 0)
            self.llm_market_context_shadow_total[normalized] = current_shadow + 1

    def record_llm_unavailable(
        self,
        *,
        reason: str | None,
        reject_reason: str | None,
    ) -> None:
        normalized_reason = normalize_reason_metric(reason)
        self.llm_unavailable_reason_total[normalized_reason] = (
            self.llm_unavailable_reason_total.get(normalized_reason, 0) + 1
        )
        if reject_reason:
            normalized_reject = normalize_reason_metric(reject_reason)
            self.llm_unavailable_reject_reason_total[normalized_reject] = (
                self.llm_unavailable_reject_reason_total.get(normalized_reject, 0) + 1
            )

    def record_decision_rejection_reasons(self, reasons: Sequence[str]) -> None:
        for reason in reasons:
            reason_parts = split_reason_codes(reason)
            if not reason_parts:
                reason_parts = [normalize_reason_metric(reason)]
            for reason_part in reason_parts:
                normalized = normalize_reason_metric(reason_part)
                self.decision_reject_reason_total[normalized] = (
                    self.decision_reject_reason_total.get(normalized, 0) + 1
                )

    def record_submission_block(self, reasons: Sequence[str] | str) -> None:
        raw_reasons = [reasons] if isinstance(reasons, str) else list(reasons)
        for reason in raw_reasons:
            reason_parts = split_reason_codes(reason)
            if not reason_parts:
                reason_parts = [normalize_reason_metric(reason)]
            for reason_part in reason_parts:
                normalized = normalize_reason_metric(reason_part)
                self.submission_block_total[normalized] = (
                    self.submission_block_total.get(normalized, 0) + 1
                )

    def record_decision_state(self, status: str | None) -> None:
        normalized = normalize_reason_metric(status)
        self.decision_state_total[normalized] = (
            self.decision_state_total.get(normalized, 0) + 1
        )

    def observe_planned_decision_age(self, age_seconds: int | float) -> None:
        self.planned_decision_age_seconds = max(0, int(age_seconds))

    def record_feature_quality_rejection(self, reasons: Sequence[str]) -> None:
        for reason in reasons:
            normalized = normalize_reason_metric(reason)
            self.feature_quality_reject_reason_total[normalized] = (
                self.feature_quality_reject_reason_total.get(normalized, 0) + 1
            )
            if normalized == "non_monotonic_progression":
                self.signal_batch_order_violation_total += 1

    def record_feature_quality_cursor_commit_blocked(
        self, reasons: Sequence[str]
    ) -> None:
        for reason in reasons:
            normalized = normalize_reason_metric(reason)
            self.feature_quality_cursor_commit_blocked_total[normalized] = (
                self.feature_quality_cursor_commit_blocked_total.get(normalized, 0) + 1
            )

    def record_qty_resolution(
        self,
        *,
        stage: str,
        outcome: str,
        reason: str | None,
    ) -> None:
        normalized_stage = normalize_reason_metric(stage)
        normalized_outcome = normalize_reason_metric(outcome)
        normalized_reason = normalize_reason_metric(reason)
        key = f"{normalized_stage}|{normalized_outcome}|{normalized_reason}"
        self.qty_resolution_total[key] = self.qty_resolution_total.get(key, 0) + 1

    def record_sell_inventory_context(self, *, stage: str, context: str) -> None:
        normalized_stage = normalize_reason_metric(stage)
        normalized_context = normalize_reason_metric(context)
        key = f"{normalized_stage}|{normalized_context}"
        self.sell_inventory_context_total[key] = (
            self.sell_inventory_context_total.get(key, 0) + 1
        )

    def record_execution_local_reject(
        self, *, code: str | None, reason: str | None
    ) -> None:
        normalized_code = normalize_reason_metric(code)
        normalized_reason = normalize_reason_metric(reason)
        key = f"{normalized_code}|{normalized_reason}"
        self.execution_local_reject_total[key] = (
            self.execution_local_reject_total.get(key, 0) + 1
        )

    def record_execution_submit_attempt(
        self,
        *,
        adapter: str | None,
        side: str | None,
        asset_class: str | None,
    ) -> None:
        normalized_adapter = normalize_reason_metric(adapter)
        normalized_side = normalize_reason_metric(side)
        normalized_asset_class = normalize_reason_metric(asset_class)
        key = f"{normalized_adapter}|{normalized_side}|{normalized_asset_class}"
        self.execution_submit_attempt_total[key] = (
            self.execution_submit_attempt_total.get(key, 0) + 1
        )

    def record_execution_submit_result(
        self,
        *,
        status: str | None,
        adapter: str | None,
    ) -> None:
        normalized_status = normalize_reason_metric(status)
        normalized_adapter = normalize_reason_metric(adapter)
        key = f"{normalized_status}|{normalized_adapter}"
        self.execution_submit_result_total[key] = (
            self.execution_submit_result_total.get(key, 0) + 1
        )

    def record_simulation_position_state(self, state: str | None) -> None:
        normalized = normalize_reason_metric(state)
        self.simulation_position_state_total[normalized] = (
            self.simulation_position_state_total.get(normalized, 0) + 1
        )

    def record_simulation_preflight_failure(self, reason: str | None) -> None:
        normalized = normalize_reason_metric(reason)
        self.simulation_preflight_failure_total[normalized] = (
            self.simulation_preflight_failure_total.get(normalized, 0) + 1
        )

    def record_rejected_signal_event(self, reason: str | None) -> None:
        normalized = normalize_reason_metric(reason)
        self.rejected_signal_events_total += 1
        self.rejected_signal_outcome_label_pending_total += 1
        self.rejected_signal_reason_total[normalized] = (
            self.rejected_signal_reason_total.get(normalized, 0) + 1
        )

    def record_llm_policy_resolution(self, classification: str | None) -> None:
        normalized = classification.strip() if isinstance(classification, str) else ""
        if not normalized:
            normalized = "unknown"
        current = self.llm_policy_resolution_total.get(normalized, 0)
        self.llm_policy_resolution_total[normalized] = current + 1

    def record_llm_committee_member(
        self,
        *,
        role: str,
        verdict: str,
        latency_ms: int | None,
        schema_error: bool,
    ) -> None:
        self.llm_committee_requests_total[role] = (
            self.llm_committee_requests_total.get(role, 0) + 1
        )
        if latency_ms is not None:
            self.llm_committee_latency_ms[role] = latency_ms
        verdict_key = f"{role}:{verdict}"
        self.llm_committee_verdict_total[verdict_key] = (
            self.llm_committee_verdict_total.get(verdict_key, 0) + 1
        )
        if schema_error:
            self.llm_committee_schema_error_total += 1

    def record_llm_committee_veto_alignment(
        self,
        *,
        committee_veto: bool,
        deterministic_veto: bool,
    ) -> None:
        if not committee_veto:
            return
        self.llm_committee_veto_total += 1
        if deterministic_veto:
            self.llm_committee_veto_alignment_total += 1

    def record_strategy_runtime(self, telemetry: DecisionRuntimeTelemetry) -> None:
        if not telemetry.runtime_enabled:
            self.strategy_runtime_legacy_path_total += 1
            return
        if telemetry.fallback_to_legacy:
            self.strategy_runtime_fallback_total += 1
        observation = telemetry.observation
        if observation is None:
            return
        for strategy_id, count in observation.strategy_events_total.items():
            self.strategy_events_total[strategy_id] = (
                self.strategy_events_total.get(strategy_id, 0) + count
            )
        for strategy_id, count in observation.strategy_intents_total.items():
            self.strategy_intents_total[strategy_id] = (
                self.strategy_intents_total.get(strategy_id, 0) + count
            )
        for key, count in observation.strategy_intent_suppression_total.items():
            self.strategy_intent_suppression_total[key] = (
                self.strategy_intent_suppression_total.get(key, 0) + count
            )
        for strategy_id, count in observation.strategy_errors_total.items():
            self.strategy_errors_total[strategy_id] = (
                self.strategy_errors_total.get(strategy_id, 0) + count
            )
        for strategy_id, latency_ms in observation.strategy_latency_ms.items():
            self.strategy_latency_ms[strategy_id] = latency_ms
        self.intent_conflict_total += observation.intent_conflicts_total
        self.strategy_runtime_isolated_failures_total += (
            observation.isolated_failures_total
        )

    def record_allocator_result(self, result: AllocationResult) -> None:
        self.allocator_requests_total += 1
        self.allocator_regime_total[result.regime_label] = (
            self.allocator_regime_total.get(result.regime_label, 0) + 1
        )
        self.allocator_fragility_state_total[result.fragility_state] = (
            self.allocator_fragility_state_total.get(result.fragility_state, 0) + 1
        )
        multiplier_key = (
            f"{result.regime_label}|{result.fragility_state}|"
            f"{result.budget_multiplier}:{result.capacity_multiplier}"
        )
        self.allocator_multiplier_total[multiplier_key] = (
            self.allocator_multiplier_total.get(multiplier_key, 0) + 1
        )
        self.fragility_score[result.decision.symbol] = float(result.fragility_score)
        if result.approved:
            self.allocator_approved_total += 1
        else:
            self.allocator_rejected_total += 1
        if result.clipped:
            self.allocator_clipped_total += 1
        if result.stability_mode_active:
            self.stability_mode_active_total += 1
        for reason_code in result.reason_codes:
            self.allocator_reason_total[reason_code] = (
                self.allocator_reason_total.get(reason_code, 0) + 1
            )

    def record_forecast_telemetry(self, payload: Mapping[str, Any]) -> None:
        family = str(payload.get("model_family") or "unknown").strip() or "unknown"
        route_key = str(payload.get("route_key") or "unknown").strip() or "unknown"
        symbol = str(payload.get("symbol") or "unknown").strip() or "unknown"
        horizon = str(payload.get("horizon") or "unknown").strip() or "unknown"
        latency = payload.get("inference_latency_ms")
        calibration_error = payload.get("calibration_error")
        fallback_reason = payload.get("fallback_reason")

        if isinstance(latency, int):
            self.forecast_router_inference_latency_ms[family] = latency

        if isinstance(fallback_reason, str) and fallback_reason.strip():
            normalized_reason = fallback_reason.strip()
            self.forecast_router_fallback_total[normalized_reason] = (
                self.forecast_router_fallback_total.get(normalized_reason, 0) + 1
            )

        route_counter_key = f"{family}|{route_key}"
        self.forecast_route_selection_total[route_counter_key] = (
            self.forecast_route_selection_total.get(route_counter_key, 0) + 1
        )

        if calibration_error is not None:
            key = f"{family}|{symbol}|{horizon}"
            self.forecast_calibration_error[key] = str(calibration_error)

    def record_decision_regime_resolution(
        self, *, source: str, fallback_reason: str | None
    ) -> None:
        normalized_source = source.strip() or "unknown"
        self.decision_regime_resolution_source_total[normalized_source] = (
            self.decision_regime_resolution_source_total.get(normalized_source, 0) + 1
        )
        if fallback_reason is None:
            return
        normalized_reason = fallback_reason.strip() or "unknown"
        self.decision_regime_resolution_fallback_total[normalized_reason] = (
            self.decision_regime_resolution_fallback_total.get(normalized_reason, 0) + 1
        )

    def record_adaptive_policy_result(
        self,
        decision: AdaptiveExecutionPolicyDecision,
        *,
        applied: bool,
    ) -> None:
        self.adaptive_policy_decisions_total += 1
        self.adaptive_policy_key_total[decision.key] = (
            self.adaptive_policy_key_total.get(decision.key, 0) + 1
        )
        if applied:
            self.adaptive_policy_applied_total += 1
        if decision.fallback_active:
            self.adaptive_policy_fallback_total += 1
        if decision.effect_size_bps is not None:
            self.adaptive_policy_effect_size_bps[decision.key] = float(
                decision.effect_size_bps
            )
        if decision.degradation_bps is not None:
            self.adaptive_policy_degradation_bps[decision.key] = float(
                decision.degradation_bps
            )

    def record_autonomy_promotion_outcome(
        self,
        metrics: AutonomyPromotionOutcomeMetrics,
    ) -> None:
        resolved = metrics
        self.autonomy_signal_throughput_total += max(0, resolved.signal_count)
        self.autonomy_decision_throughput_total += max(0, resolved.decision_count)
        self.autonomy_trade_throughput_total += max(0, resolved.trade_count)
        if resolved.promotion_allowed:
            self.autonomy_promotion_allowed_total += 1
        else:
            self.autonomy_promotion_blocked_total += 1
        normalized_recommendation = (
            resolved.recommendation.strip() if resolved.recommendation else ""
        )
        if not normalized_recommendation:
            normalized_recommendation = "unknown"
        self.autonomy_recommendation_total[normalized_recommendation] = (
            self.autonomy_recommendation_total.get(normalized_recommendation, 0) + 1
        )
        normalized_outcome = resolved.outcome.strip()
        if not normalized_outcome:
            normalized_outcome = "unknown"
        self.autonomy_outcome_total[normalized_outcome] = (
            self.autonomy_outcome_total.get(normalized_outcome, 0) + 1
        )

    def record_domain_telemetry(
        self, *, event_name: str, emitted: bool, drop_reason: str | None
    ) -> None:
        normalized_event = event_name.strip() if event_name else ""
        if not normalized_event:
            normalized_event = "unknown"
        self.domain_telemetry_event_total[normalized_event] = (
            self.domain_telemetry_event_total.get(normalized_event, 0) + 1
        )
        if emitted:
            return
        normalized_reason = normalize_reason_metric(drop_reason)
        self.domain_telemetry_dropped_total[normalized_reason] = (
            self.domain_telemetry_dropped_total.get(normalized_reason, 0) + 1
        )

    def record_uncertainty_gate(self, gate_report_payload: Mapping[str, Any]) -> None:
        action = str(gate_report_payload.get("uncertainty_gate_action", "")).strip()
        if action:
            self.uncertainty_gate_action_total[action] = (
                self.uncertainty_gate_action_total.get(action, 0) + 1
            )
        coverage_error = optional_decimal(gate_report_payload.get("coverage_error"))
        if coverage_error is not None:
            self.calibration_coverage_error = float(coverage_error)
        interval_width = optional_decimal(
            gate_report_payload.get("conformal_interval_width")
        )
        if interval_width is not None:
            self.conformal_interval_width = float(interval_width)
        shift_score = optional_decimal(gate_report_payload.get("shift_score"))
        if shift_score is not None:
            self.regime_shift_score = float(shift_score)
        gates = gate_report_payload.get("gates")
        if isinstance(gates, list):
            for raw_gate in cast(list[object], gates):
                if not isinstance(raw_gate, Mapping):
                    continue
                gate = cast(Mapping[str, Any], raw_gate)
                if (
                    str(gate.get("gate_id", "")).strip()
                    != "gate7_uncertainty_calibration"
                ):
                    continue
                status = str(gate.get("status", "")).strip()
                recalibration_status = "not_required" if status == "pass" else "queued"
                self.recalibration_runs_total[recalibration_status] = (
                    self.recalibration_runs_total.get(recalibration_status, 0) + 1
                )
                break

    def record_runtime_uncertainty_gate(
        self, action: RuntimeUncertaintyGateAction, *, blocked: bool
    ) -> None:
        self.runtime_uncertainty_gate_action_total[action] = (
            self.runtime_uncertainty_gate_action_total.get(action, 0) + 1
        )
        if blocked:
            self.runtime_uncertainty_gate_blocked_total[action] = (
                self.runtime_uncertainty_gate_blocked_total.get(action, 0) + 1
            )

    def record_runtime_regime_gate(
        self, action: RuntimeUncertaintyGateAction, *, blocked: bool
    ) -> None:
        self.runtime_regime_gate_action_total[action] = (
            self.runtime_regime_gate_action_total.get(action, 0) + 1
        )
        if blocked:
            self.runtime_regime_gate_blocked_total[action] = (
                self.runtime_regime_gate_blocked_total.get(action, 0) + 1
            )


@dataclass
class TradingMetrics(_TradingMetricsMethods):
    def to_payload(self) -> dict[str, object]:
        return cast(dict[str, object], asdict(self))


@dataclass
class TradingState:
    running: bool = False
    startup_started_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    last_reconcile_at: Optional[datetime] = None
    last_trading_error: Optional[str] = None
    last_reconcile_error: Optional[str] = None
    last_error: Optional[str] = None
    autonomy_runs_total: int = 0
    autonomy_signals_total: int = 0
    autonomy_patches_total: int = 0
    last_autonomy_run_at: Optional[datetime] = None
    last_autonomy_error: Optional[str] = None
    last_autonomy_reason: Optional[str] = None
    last_autonomy_run_id: Optional[str] = None
    last_autonomy_candidate_id: Optional[str] = None
    last_autonomy_gates: Optional[str] = None
    last_autonomy_actuation_intent: Optional[str] = None
    last_autonomy_phase_manifest: Optional[str] = None
    last_autonomy_patch: Optional[str] = None
    last_autonomy_recommendation: Optional[str] = None
    last_autonomy_promotion_action: Optional[str] = None
    last_autonomy_promotion_eligible: Optional[bool] = None
    last_autonomy_recommendation_trace_id: Optional[str] = None
    last_autonomy_iteration: Optional[int] = None
    last_autonomy_iteration_notes_path: Optional[str] = None
    last_autonomy_throughput: Optional[dict[str, int | bool | str | None]] = None
    last_ingest_signals_total: int = 0
    last_ingest_window_start: Optional[datetime] = None
    last_ingest_window_end: Optional[datetime] = None
    last_ingest_reason: Optional[str] = None
    last_execution_order: Optional[dict[str, object]] = None
    market_session_open: Optional[bool] = None
    last_signal_continuity_state: Optional[str] = None
    last_signal_continuity_reason: Optional[str] = None
    last_signal_continuity_actionable: Optional[bool] = None
    signal_continuity_alert_active: bool = False
    signal_continuity_alert_reason: Optional[str] = None
    signal_continuity_alert_started_at: Optional[datetime] = None
    signal_continuity_alert_last_seen_at: Optional[datetime] = None
    signal_continuity_recovery_streak: int = 0
    signal_bootstrap_started_at: Optional[datetime] = None
    signal_bootstrap_completed_at: Optional[datetime] = None
    last_market_context_symbol: Optional[str] = None
    last_market_context_checked_at: Optional[datetime] = None
    last_market_context_as_of: Optional[datetime] = None
    last_market_context_freshness_seconds: Optional[int] = None
    last_market_context_quality_score: Optional[float] = None
    last_market_context_domain_states: dict[str, str] = field(
        default_factory=lambda: cast(dict[str, str], {})
    )
    last_market_context_risk_flags: list[str] = field(
        default_factory=lambda: cast(list[str], [])
    )
    last_market_context_allow_llm: Optional[bool] = None
    last_market_context_reason: Optional[str] = None
    last_market_context_fetch_error: Optional[str] = None
    market_context_alert_active: bool = False
    market_context_alert_reason: Optional[str] = None
    autonomy_no_signal_streak: int = 0
    last_evidence_continuity_report: Optional[dict[str, Any]] = None
    autonomy_failure_streak: int = 0
    universe_source_status: Optional[str] = None
    universe_source_reason: Optional[str] = None
    universe_symbols_count: int = 0
    universe_cache_age_seconds: Optional[int] = None
    universe_fail_safe_blocked: bool = False
    universe_fail_safe_block_reason: Optional[str] = None
    emergency_stop_active: bool = False
    emergency_stop_reason: Optional[str] = None
    emergency_stop_triggered_at: Optional[datetime] = None
    emergency_stop_resolved_at: Optional[datetime] = None
    emergency_stop_recovery_streak: int = 0
    capital_new_exposure_allowed: bool = True
    capital_current_equity: Optional[str] = None
    capital_daily_start_equity: Optional[str] = None
    capital_high_water_equity: Optional[str] = None
    capital_daily_loss_ratio: Optional[str] = None
    capital_drawdown_ratio: Optional[str] = None
    capital_last_evaluated_at: Optional[datetime] = None
    capital_ledger_state: Optional[str] = None
    capital_ledger_reason: Optional[str] = None
    capital_ledger_checked_at: Optional[datetime] = None
    capital_closeout_in_progress: bool = False
    capital_closeout_reason: Optional[str] = None
    capital_closeout_attempts: int = 0
    capital_flat_confirmed_at: Optional[datetime] = None
    rollback_incidents_total: int = 0
    rollback_incident_evidence_path: Optional[str] = None
    drift_status: str = "unknown"
    drift_active_incident_id: Optional[str] = None
    drift_active_reason_codes: list[str] = field(
        default_factory=lambda: cast(list[str], [])
    )
    drift_last_detection_at: Optional[datetime] = None
    drift_last_detection_path: Optional[str] = None
    drift_last_action_type: Optional[str] = None
    drift_last_action_at: Optional[datetime] = None
    drift_last_action_path: Optional[str] = None
    drift_last_outcome_path: Optional[str] = None
    drift_live_promotion_eligible: bool = False
    drift_live_promotion_reasons: list[str] = field(
        default_factory=lambda: cast(list[str], [])
    )
    last_runtime_uncertainty_gate_action: str | None = None
    last_runtime_uncertainty_gate_source: str | None = None
    last_runtime_uncertainty_gate_reason: str | None = None
    last_runtime_regime_gate_action: str | None = None
    last_runtime_regime_gate_source: str | None = None
    last_runtime_regime_gate_reason: str | None = None
    last_rejected_signal_outcome_event: Optional[dict[str, Any]] = None
    metrics: TradingMetrics = field(default_factory=TradingMetrics)


__all__ = [
    "RuntimeUncertaintyGateAction",
    "TradingMetrics",
    "TradingState",
]
