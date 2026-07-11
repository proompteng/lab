"""Prometheus-formatted metrics for Torghut trading counters."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal


def _escape_label_value(value: str | int | float) -> str:
    text = str(value)
    return text.replace("\\", "\\\\").replace('"', '\\"')


def render_labeled_metric(
    metric_name: str,
    labels: Mapping[str, str],
    value: int | float,
) -> list[str]:
    if not labels:
        return [f"{metric_name} {value}"]
    label_text = ",".join(
        [f'{key}="{_escape_label_value(val)}"' for key, val in labels.items()]
    )
    return [f"{metric_name}{{{label_text}}} {value}"]


def coerce_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    return 0


SIMPLE_MAP_METRICS: dict[str, tuple[str, str, str, str, str]] = {
    "execution_requests_total": (
        "torghut_trading_execution_requests_total",
        "Count of execution requests by adapter.",
        "counter",
        "adapter",
        "int",
    ),
    "execution_fallback_reason_total": (
        "torghut_trading_execution_fallback_reason_total",
        "Count of execution fallbacks by reason.",
        "counter",
        "reason",
        "int",
    ),
    "execution_advisor_usage_total": (
        "torghut_trading_execution_advisor_usage_total",
        "Count of execution advisor usage outcomes by status.",
        "counter",
        "status",
        "int",
    ),
    "execution_advisor_fallback_total": (
        "torghut_trading_execution_advisor_fallback_total",
        "Count of execution advisor fallback outcomes by reason.",
        "counter",
        "reason",
        "int",
    ),
    "decision_reject_reason_total": (
        "torghut_trading_decision_reject_reason_total",
        "Count of rejected decision reason codes.",
        "counter",
        "reason",
        "int",
    ),
    "rejected_signal_reason_total": (
        "torghut_trading_rejected_signal_reason_total",
        "Count of rejected signal events awaiting counterfactual outcome labels by reason.",
        "counter",
        "reason",
        "int",
    ),
    "submission_block_total": (
        "torghut_trading_submission_block_total",
        "Count of blocked submissions by reason.",
        "counter",
        "reason",
        "int",
    ),
    "decision_state_total": (
        "torghut_trading_decision_state_total",
        "Count of observed decision lifecycle states by status.",
        "counter",
        "status",
        "int",
    ),
    "feature_quality_reject_reason_total": (
        "torghut_trading_feature_quality_reject_reason_total",
        "Count of feature-quality rejection reasons.",
        "counter",
        "reason",
        "int",
    ),
    "feature_quality_cursor_commit_blocked_total": (
        "torghut_trading_feature_quality_cursor_commit_blocked_total",
        "Count of prevented cursor commits on rejected feature-quality batches.",
        "counter",
        "reason",
        "int",
    ),
    "domain_telemetry_event_total": (
        "torghut_trading_domain_telemetry_event_total",
        "Count of attempted domain telemetry events by event name.",
        "counter",
        "event",
        "int",
    ),
    "domain_telemetry_dropped_total": (
        "torghut_trading_domain_telemetry_dropped_total",
        "Count of dropped domain telemetry events by drop reason.",
        "counter",
        "reason",
        "int",
    ),
    "lean_request_total": (
        "torghut_trading_lean_request_total",
        "Count of LEAN runner requests by operation.",
        "counter",
        "operation",
        "int",
    ),
    "lean_latency_ms": (
        "torghut_trading_lean_latency_ms",
        "Average LEAN request latency by operation.",
        "gauge",
        "operation",
        "number",
    ),
    "lean_shadow_parity_total": (
        "torghut_trading_lean_shadow_parity_total",
        "Count of LEAN shadow execution parity outcomes.",
        "counter",
        "status",
        "int",
    ),
    "lean_shadow_failure_total": (
        "torghut_trading_lean_shadow_failure_total",
        "Count of LEAN shadow execution failures by taxonomy.",
        "counter",
        "taxonomy",
        "int",
    ),
    "lean_strategy_shadow_total": (
        "torghut_trading_lean_strategy_shadow_total",
        "Count of LEAN strategy shadow evaluations by parity status.",
        "counter",
        "status",
        "int",
    ),
    "lean_canary_breach_total": (
        "torghut_trading_lean_canary_breach_total",
        "Count of LEAN canary gate breaches by type.",
        "counter",
        "breach_type",
        "int",
    ),
    "no_signal_reason_total": (
        "torghut_trading_no_signal_reason_total",
        "Count of autonomy cycles skipped by no-signal reason.",
        "counter",
        "reason",
        "int",
    ),
    "no_signal_reason_streak": (
        "torghut_trading_no_signal_reason_streak",
        "Consecutive no-signal streak by reason.",
        "gauge",
        "reason",
        "int",
    ),
    "signal_staleness_alert_total": (
        "torghut_trading_signal_staleness_alert_total",
        "Count of source freshness alerts by reason.",
        "counter",
        "reason",
        "int",
    ),
    "signal_expected_staleness_total": (
        "torghut_trading_signal_expected_staleness_total",
        "Count of expected no-signal staleness observations while market session is closed.",
        "counter",
        "reason",
        "int",
    ),
    "signal_actionable_staleness_total": (
        "torghut_trading_signal_actionable_staleness_total",
        "Count of actionable source continuity faults by reason.",
        "counter",
        "reason",
        "int",
    ),
    "universe_fail_safe_reason_total": (
        "torghut_trading_universe_fail_safe_reason_total",
        "Count of fail-safe universe execution blocks by reason.",
        "counter",
        "reason",
        "int",
    ),
    "forecast_router_inference_latency_ms": (
        "torghut_forecast_router_inference_latency_ms",
        "Deterministic forecast inference latency by model family.",
        "gauge",
        "model_family",
        "int",
    ),
    "forecast_router_fallback_total": (
        "torghut_forecast_router_fallback_total",
        "Count of forecast router fallbacks by reason.",
        "counter",
        "reason",
        "int",
    ),
    "llm_market_context_reason_total": (
        "torghut_trading_llm_market_context_reason_total",
        "Count of LLM market-context fallbacks by reason.",
        "counter",
        "reason",
        "int",
    ),
    "llm_unavailable_reason_total": (
        "torghut_trading_llm_unavailable_reason_total",
        "Count of LLM unavailable events by source reason.",
        "counter",
        "reason",
        "int",
    ),
    "llm_unavailable_reject_reason_total": (
        "torghut_trading_llm_unavailable_reject_reason_total",
        "Count of vetoed LLM unavailable events by reject reason.",
        "counter",
        "reason",
        "int",
    ),
    "llm_market_context_shadow_total": (
        "torghut_trading_llm_market_context_shadow_total",
        "Count of LLM market-context fallbacks by reason.",
        "counter",
        "reason",
        "int",
    ),
    "llm_policy_resolution_total": (
        "torghut_trading_llm_policy_resolution_total",
        "Count of LLM policy-resolution classifications.",
        "counter",
        "classification",
        "int",
    ),
    "llm_committee_requests_total": (
        "torghut_trading_llm_committee_requests_total",
        "Count of LLM committee role requests.",
        "counter",
        "role",
        "int",
    ),
    "uncertainty_gate_action_total": (
        "torghut_trading_uncertainty_gate_action_total",
        "Count of uncertainty gate actions by action.",
        "counter",
        "action",
        "int",
    ),
    "runtime_uncertainty_gate_action_total": (
        "torghut_trading_runtime_uncertainty_gate_action_total",
        "Count of runtime uncertainty gate actions by action.",
        "counter",
        "action",
        "int",
    ),
    "runtime_uncertainty_gate_blocked_total": (
        "torghut_trading_runtime_uncertainty_gate_blocked_total",
        "Count of runtime uncertainty gate entry blocks by action.",
        "counter",
        "action",
        "int",
    ),
    "runtime_regime_gate_action_total": (
        "torghut_trading_runtime_regime_gate_action_total",
        "Count of runtime regime gate actions by action.",
        "counter",
        "action",
        "int",
    ),
    "runtime_regime_gate_blocked_total": (
        "torghut_trading_runtime_regime_gate_blocked_total",
        "Count of runtime regime gate entry blocks by action.",
        "counter",
        "action",
        "int",
    ),
    "llm_committee_latency_ms": (
        "torghut_trading_llm_committee_latency_ms",
        "Last observed LLM committee role latency in milliseconds.",
        "gauge",
        "role",
        "int",
    ),
    "recalibration_runs_total": (
        "torghut_trading_recalibration_runs_total",
        "Count of recalibration runs by status.",
        "counter",
        "status",
        "int",
    ),
    "feature_null_rate": (
        "torghut_trading_feature_null_rate",
        "Required feature null-rate by field.",
        "gauge",
        "field",
        "number",
    ),
    "fragility_score": (
        "torghut_trading_fragility_score",
        "Latest fragility score by symbol.",
        "gauge",
        "symbol",
        "number",
    ),
    "allocator_fragility_state_total": (
        "torghut_trading_allocator_fragility_state_total",
        "Allocator outcomes by fragility state.",
        "counter",
        "fragility_state",
        "int",
    ),
    "decision_regime_resolution_source_total": (
        "torghut_trading_decision_regime_resolution_source_total",
        "Decision regime source resolution by signal source.",
        "counter",
        "source",
        "int",
    ),
    "decision_regime_resolution_fallback_total": (
        "torghut_trading_decision_regime_resolution_fallback_total",
        "Decision regime fallback reason counts.",
        "counter",
        "reason",
        "int",
    ),
    "hypothesis_state_total": (
        "torghut_trading_hypothesis_state_total",
        "Current hypothesis readiness states by state.",
        "gauge",
        "state",
        "int",
    ),
    "hypothesis_capital_stage_total": (
        "torghut_trading_hypothesis_capital_stage_total",
        "Current hypothesis capital stages by stage.",
        "gauge",
        "stage",
        "int",
    ),
    "simulation_position_state_total": (
        "torghut_trading_simulation_position_state_total",
        "Count of simulation position state observations.",
        "counter",
        "state",
        "int",
    ),
    "simulation_preflight_failure_total": (
        "torghut_trading_simulation_preflight_failure_total",
        "Count of simulation preflight failures by reason.",
        "counter",
        "reason",
        "int",
    ),
}

STRATEGY_RUNTIME_METRICS: dict[str, tuple[str, str]] = {
    "strategy_events_total": ("torghut_trading_strategy_events_total", "counter"),
    "strategy_intents_total": ("torghut_trading_strategy_intents_total", "counter"),
    "strategy_errors_total": ("torghut_trading_strategy_errors_total", "counter"),
    "strategy_latency_ms": ("torghut_trading_strategy_latency_ms", "gauge"),
}

SERVICE_LABEL_GAUGES: dict[str, tuple[str, str]] = {
    "signal_lag_seconds": (
        "torghut_trading_signal_lag_seconds",
        "Latest signal ingestion lag in seconds.",
    ),
    "trading_shorts_enabled": (
        "torghut_trading_shorts_enabled",
        "Whether shorting is currently enabled in runtime configuration.",
    ),
    "no_signal_streak": (
        "torghut_trading_no_signal_streak",
        "Consecutive no-signal autonomy cycles.",
    ),
    "market_session_open": (
        "torghut_trading_market_session_open",
        "Trading market session status (1=open, 0=closed).",
    ),
    "signal_continuity_actionable": (
        "torghut_trading_signal_continuity_actionable",
        "Whether last observed continuity state is actionable (1=yes, 0=no).",
    ),
    "signal_continuity_alert_active": (
        "torghut_trading_signal_continuity_alert_active",
        "Whether a signal continuity alert is currently latched (1=yes, 0=no).",
    ),
    "signal_continuity_alert_recovery_streak": (
        "torghut_trading_signal_continuity_alert_recovery_streak",
        "Healthy-cycle streak towards clearing a latched continuity alert.",
    ),
    "universe_symbols_count": (
        "torghut_trading_universe_symbols_count",
        "Resolved authoritative universe symbol count.",
    ),
    "universe_cache_age_seconds": (
        "torghut_trading_universe_cache_age_seconds",
        "Age of cached authoritative universe symbols in seconds.",
    ),
    "planned_decision_age_seconds": (
        "torghut_trading_planned_decision_age_seconds",
        "Age in seconds of the most recently observed planned decision.",
    ),
}

DIRECT_GAUGES: dict[str, tuple[str, str]] = {
    "scheduler_leadership_acquired": (
        "torghut_scheduler_leadership_acquired",
        "Whether this process currently owns the PostgreSQL scheduler writer fence.",
    ),
    "scheduler_leadership_healthy": (
        "torghut_scheduler_leadership_healthy",
        "Whether the scheduler writer fence is currently healthy.",
    ),
    "feature_staleness_ms_p95": (
        "torghut_trading_feature_staleness_ms_p95",
        "Feature staleness p95 for the latest ingest batch.",
    ),
    "feature_duplicate_ratio": (
        "torghut_trading_feature_duplicate_ratio",
        "Duplicate event ratio in the latest ingest batch.",
    ),
    "market_context_alert_active": (
        "torghut_trading_market_context_alert_active",
        "Whether a market-context alert is currently active (1=yes, 0=no).",
    ),
    "market_context_last_freshness_seconds": (
        "torghut_trading_market_context_last_freshness_seconds",
        "Freshness in seconds of the last observed market-context bundle.",
    ),
    "market_context_last_quality_score": (
        "torghut_trading_market_context_last_quality_score",
        "Quality score of the last observed market-context bundle.",
    ),
    "llm_runtime_fallback_ratio": (
        "torghut_trading_llm_runtime_fallback_ratio",
        "Ratio of LLM runtime fallbacks to total LLM requests.",
    ),
    "llm_runtime_fallback_alert_active": (
        "torghut_trading_llm_runtime_fallback_alert_active",
        "Whether the LLM runtime fallback alert threshold is currently breached (1=yes, 0=no).",
    ),
    "shorting_metadata_account_ready": (
        "torghut_trading_shorting_metadata_account_ready",
        "Whether cached account shorting metadata is currently ready (1=yes, 0=no).",
    ),
    "shorting_metadata_alert_active": (
        "torghut_trading_shorting_metadata_alert_active",
        "Whether shorting metadata readiness is currently alerting during market hours (1=yes, 0=no).",
    ),
    "alpha_readiness_hypotheses_total": (
        "torghut_trading_alpha_readiness_hypotheses_total",
        "Total hypotheses loaded into the runtime readiness compiler.",
    ),
    "alpha_readiness_promotion_eligible_total": (
        "torghut_trading_alpha_readiness_promotion_eligible_total",
        "Current hypotheses eligible for promotion based on runtime readiness.",
    ),
    "alpha_readiness_rollback_required_total": (
        "torghut_trading_alpha_readiness_rollback_required_total",
        "Current hypotheses requiring rollback or demotion review.",
    ),
}

AUTONOMY_WINDOW_GAUGES: dict[str, tuple[str, str]] = {
    "calibration_coverage_error": (
        "torghut_trading_calibration_coverage_error",
        "Absolute conformal coverage error for the latest autonomy window.",
    ),
    "conformal_interval_width": (
        "torghut_trading_conformal_interval_width",
        "Average conformal interval width for the latest autonomy window.",
    ),
    "regime_shift_score": (
        "torghut_trading_regime_shift_score",
        "Regime shift score for the latest autonomy window.",
    ),
}

EVIDENCE_CONTINUITY_KEYS = {
    "evidence_continuity_last_checked_ts_seconds",
    "evidence_continuity_last_success_ts_seconds",
    "evidence_continuity_last_failed_runs",
}


def metric_headers(metric_name: str, help_text: str, metric_type: str) -> list[str]:
    return [f"# HELP {metric_name} {help_text}", f"# TYPE {metric_name} {metric_type}"]


def _parse_metric_value(value: object, numeric_kind: str) -> int | float | None:
    if numeric_kind == "int":
        if isinstance(value, int):
            return int(value)
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    return None


def sorted_metric_items(
    values: Mapping[str, object],
    *,
    numeric_kind: str,
) -> list[tuple[str, int | float]]:
    items: list[tuple[str, int | float]] = []
    for label, raw_value in values.items():
        numeric_value = _parse_metric_value(raw_value, numeric_kind)
        if numeric_value is None:
            continue
        items.append((str(label), numeric_value))
    return sorted(items)


def render_simple_map_metric(key: str, values: Mapping[str, object]) -> list[str]:
    metric_name, help_text, metric_type, label_name, numeric_kind = SIMPLE_MAP_METRICS[
        key
    ]
    lines = metric_headers(metric_name, help_text, metric_type)
    for label, numeric_value in sorted_metric_items(
        values,
        numeric_kind=numeric_kind,
    ):
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={label_name: label},
                value=numeric_value,
            )
        )
    return lines


def render_execution_fallback_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_execution_fallback_total"
    lines = metric_headers(
        metric_name,
        "Count of execution fallbacks by adapter transition.",
        "counter",
    )
    for transition, count in sorted_metric_items(values, numeric_kind="int"):
        expected_adapter = "unknown"
        actual_adapter = "unknown"
        if "->" in transition:
            expected_adapter, actual_adapter = transition.split("->", 1)
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"from": expected_adapter, "to": actual_adapter},
                value=count,
            )
        )
    return lines


def render_lean_failure_taxonomy_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_lean_failure_taxonomy_total"
    lines = metric_headers(
        metric_name,
        "Count of LEAN failures by operation and taxonomy.",
        "counter",
    )
    for label, count in sorted_metric_items(values, numeric_kind="int"):
        operation = "unknown"
        taxonomy = "unknown"
        if ":" in label:
            operation, taxonomy = label.split(":", 1)
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"operation": operation, "taxonomy": taxonomy},
                value=count,
            )
        )
    return lines


def render_route_provenance_map(values: Mapping[str, object]) -> list[str]:
    total = coerce_int(values.get("total"))
    missing = coerce_int(values.get("missing"))
    unknown = coerce_int(values.get("unknown"))
    mismatch = coerce_int(values.get("mismatch"))
    lines: list[str] = []
    ratio_metrics: list[tuple[str, str]] = [
        ("coverage_ratio", "torghut_trading_route_provenance_coverage_ratio"),
        ("unknown_ratio", "torghut_trading_route_provenance_unknown_ratio"),
        ("mismatch_ratio", "torghut_trading_route_provenance_mismatch_ratio"),
    ]
    for source_key, metric_name in ratio_metrics:
        lines.extend(
            metric_headers(
                metric_name,
                "Route provenance continuity ratio for recent executions.",
                "gauge",
            )
        )
        ratio = values.get(source_key)
        if isinstance(ratio, (int, float, Decimal)):
            lines.extend(
                render_labeled_metric(
                    metric_name=metric_name,
                    labels={},
                    value=float(ratio),
                )
            )
    count_metrics: list[tuple[str, int, str]] = [
        (
            "torghut_trading_route_provenance_total",
            total,
            "Total recent executions considered for route provenance.",
        ),
        (
            "torghut_trading_route_provenance_missing_total",
            missing,
            "Recent executions missing expected/actual route metadata.",
        ),
        (
            "torghut_trading_route_provenance_unknown_total",
            unknown,
            "Recent executions with unknown expected/actual route metadata.",
        ),
        (
            "torghut_trading_route_provenance_mismatch_total",
            mismatch,
            "Recent executions where expected and actual routes diverged.",
        ),
    ]
    for metric_name, metric_value, help_text in count_metrics:
        lines.extend(metric_headers(metric_name, help_text, "gauge"))
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={},
                value=metric_value,
            )
        )
    return lines


def render_universe_resolution_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_universe_resolution_total"
    lines = metric_headers(
        metric_name,
        "Count of universe resolution outcomes by status and reason.",
        "counter",
    )
    for key, count in sorted_metric_items(values, numeric_kind="int"):
        status = "unknown"
        reason = "unknown"
        if "|" in key:
            status, reason = key.split("|", 1)
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"status": status, "reason": reason},
                value=count,
            )
        )
    return lines


def render_forecast_calibration_error_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_forecast_calibration_error"
    lines = metric_headers(
        metric_name,
        "Forecast calibration error by model family, symbol, and horizon.",
        "gauge",
    )
    sorted_items = sorted(
        [
            (str(route_key), str(error_value))
            for route_key, error_value in values.items()
        ]
    )
    for route_key, error_value in sorted_items:
        parts = route_key.split("|", 2)
        if len(parts) != 3:
            continue
        family, symbol, horizon = parts
        try:
            parsed_error = float(error_value)
        except (ValueError, TypeError):
            continue
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={
                    "model_family": family,
                    "symbol": symbol,
                    "horizon": horizon,
                },
                value=parsed_error,
            )
        )
    return lines
