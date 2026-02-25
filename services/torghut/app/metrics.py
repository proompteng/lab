"""Prometheus-formatted metrics for Torghut trading counters."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import cast


def _escape_label_value(value: str | int | float) -> str:
    text = str(value)
    return text.replace("\\", "\\\\").replace('"', '\\"')


def _render_labeled_metric(
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


def _coerce_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    return 0


_SIMPLE_MAP_METRICS: dict[str, tuple[str, str, str, str, str]] = {
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
}

_STRATEGY_RUNTIME_METRICS: dict[str, tuple[str, str]] = {
    "strategy_events_total": ("torghut_trading_strategy_events_total", "counter"),
    "strategy_intents_total": ("torghut_trading_strategy_intents_total", "counter"),
    "strategy_errors_total": ("torghut_trading_strategy_errors_total", "counter"),
    "strategy_latency_ms": ("torghut_trading_strategy_latency_ms", "gauge"),
}

_SERVICE_LABEL_GAUGES: dict[str, tuple[str, str]] = {
    "signal_lag_seconds": (
        "torghut_trading_signal_lag_seconds",
        "Latest signal ingestion lag in seconds.",
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
}

_DIRECT_GAUGES: dict[str, tuple[str, str]] = {
    "feature_staleness_ms_p95": (
        "torghut_trading_feature_staleness_ms_p95",
        "Feature staleness p95 for the latest ingest batch.",
    ),
    "feature_duplicate_ratio": (
        "torghut_trading_feature_duplicate_ratio",
        "Duplicate event ratio in the latest ingest batch.",
    ),
}

_AUTONOMY_WINDOW_GAUGES: dict[str, tuple[str, str]] = {
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

_EVIDENCE_CONTINUITY_KEYS = {
    "evidence_continuity_last_checked_ts_seconds",
    "evidence_continuity_last_success_ts_seconds",
    "evidence_continuity_last_failed_runs",
}


def _metric_headers(metric_name: str, help_text: str, metric_type: str) -> list[str]:
    return [f"# HELP {metric_name} {help_text}", f"# TYPE {metric_name} {metric_type}"]


def _parse_metric_value(value: object, numeric_kind: str) -> int | float | None:
    if numeric_kind == "int":
        if isinstance(value, int):
            return int(value)
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    return None


def _sorted_metric_items(
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


def _render_simple_map_metric(key: str, values: Mapping[str, object]) -> list[str]:
    metric_name, help_text, metric_type, label_name, numeric_kind = _SIMPLE_MAP_METRICS[
        key
    ]
    lines = _metric_headers(metric_name, help_text, metric_type)
    for label, numeric_value in _sorted_metric_items(
        values,
        numeric_kind=numeric_kind,
    ):
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={label_name: label},
                value=numeric_value,
            )
        )
    return lines


def _render_execution_fallback_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_execution_fallback_total"
    lines = _metric_headers(
        metric_name,
        "Count of execution fallbacks by adapter transition.",
        "counter",
    )
    for transition, count in _sorted_metric_items(values, numeric_kind="int"):
        expected_adapter = "unknown"
        actual_adapter = "unknown"
        if "->" in transition:
            expected_adapter, actual_adapter = transition.split("->", 1)
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={"from": expected_adapter, "to": actual_adapter},
                value=count,
            )
        )
    return lines


def _render_lean_failure_taxonomy_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_lean_failure_taxonomy_total"
    lines = _metric_headers(
        metric_name,
        "Count of LEAN failures by operation and taxonomy.",
        "counter",
    )
    for label, count in _sorted_metric_items(values, numeric_kind="int"):
        operation = "unknown"
        taxonomy = "unknown"
        if ":" in label:
            operation, taxonomy = label.split(":", 1)
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={"operation": operation, "taxonomy": taxonomy},
                value=count,
            )
        )
    return lines


def _render_route_provenance_map(values: Mapping[str, object]) -> list[str]:
    total = _coerce_int(values.get("total"))
    missing = _coerce_int(values.get("missing"))
    unknown = _coerce_int(values.get("unknown"))
    mismatch = _coerce_int(values.get("mismatch"))
    lines: list[str] = []
    ratio_metrics: list[tuple[str, str]] = [
        ("coverage_ratio", "torghut_trading_route_provenance_coverage_ratio"),
        ("unknown_ratio", "torghut_trading_route_provenance_unknown_ratio"),
        ("mismatch_ratio", "torghut_trading_route_provenance_mismatch_ratio"),
    ]
    for source_key, metric_name in ratio_metrics:
        lines.extend(
            _metric_headers(
                metric_name,
                "Route provenance continuity ratio for recent executions.",
                "gauge",
            )
        )
        ratio = values.get(source_key)
        if isinstance(ratio, (int, float, Decimal)):
            lines.extend(
                _render_labeled_metric(
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
        lines.extend(_metric_headers(metric_name, help_text, "gauge"))
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={},
                value=metric_value,
            )
        )
    return lines


def _render_universe_resolution_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_universe_resolution_total"
    lines = _metric_headers(
        metric_name,
        "Count of universe resolution outcomes by status and reason.",
        "counter",
    )
    for key, count in _sorted_metric_items(values, numeric_kind="int"):
        status = "unknown"
        reason = "unknown"
        if "|" in key:
            status, reason = key.split("|", 1)
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={"status": status, "reason": reason},
                value=count,
            )
        )
    return lines


def _render_forecast_calibration_error_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_forecast_calibration_error"
    lines = _metric_headers(
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
            _render_labeled_metric(
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


def _render_forecast_route_selection_total_map(
    values: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_forecast_route_selection_total"
    lines = _metric_headers(
        metric_name,
        "Count of forecast route selections by model family and route key.",
        "counter",
    )
    for route_key, count in _sorted_metric_items(values, numeric_kind="int"):
        parts = route_key.split("|", 1)
        if len(parts) != 2:
            continue
        family, route_label = parts
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={
                    "model_family": family,
                    "route_key": route_label,
                },
                value=count,
            )
        )
    return lines


def _render_llm_committee_verdict_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_llm_committee_verdict_total"
    lines = _metric_headers(metric_name, "Count of committee role verdicts.", "counter")
    for label, count in _sorted_metric_items(values, numeric_kind="int"):
        role, verdict = (label.split(":", 1) + ["unknown"])[:2]
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={"role": role, "verdict": verdict},
                value=count,
            )
        )
    return lines


def _render_allocator_multiplier_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_allocation_multiplier_total"
    lines = _metric_headers(
        metric_name,
        "Allocator multiplier applications by regime and fragility state.",
        "counter",
    )
    for label, count in _sorted_metric_items(values, numeric_kind="int"):
        parts = label.rsplit("|", 2)
        if len(parts) == 3:
            regime, fragility_state, multiplier = parts
        elif len(parts) == 2:
            regime, fragility_state = parts
            multiplier = "unknown"
        else:
            regime = parts[0] if parts else "unknown"
            fragility_state = "elevated"
            multiplier = "unknown"
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={
                    "regime": regime,
                    "fragility_state": fragility_state,
                    "multiplier": multiplier,
                },
                value=count,
            )
        )
    return lines


def _render_tca_summary_map(values: Mapping[str, object]) -> list[str]:
    lines: list[str] = []
    scalar_metrics: list[tuple[str, str]] = [
        ("order_count", "torghut_trading_tca_order_count"),
        ("avg_slippage_bps", "torghut_trading_tca_avg_slippage_bps"),
        ("avg_shortfall_notional", "torghut_trading_tca_avg_shortfall_notional"),
        ("avg_churn_ratio", "torghut_trading_tca_avg_churn_ratio"),
        ("avg_divergence_bps", "torghut_trading_tca_avg_divergence_bps"),
    ]
    for summary_key, metric_name in scalar_metrics:
        metric_value = values.get(summary_key)
        if not isinstance(metric_value, (int, float, Decimal)):
            continue
        numeric_value = float(metric_value)
        metric_type = "counter" if summary_key == "order_count" else "gauge"
        lines.extend(
            _metric_headers(
                metric_name,
                f"Torghut TCA summary metric {summary_key}.",
                metric_type,
            )
        )
        lines.append(f"{metric_name} {numeric_value}")
    return lines


def _render_strategy_runtime_map(key: str, values: Mapping[str, object]) -> list[str]:
    metric_name, metric_type = _STRATEGY_RUNTIME_METRICS[key]
    lines = _metric_headers(metric_name, f"Strategy runtime metric {key}.", metric_type)
    for strategy_id, count in _sorted_metric_items(values, numeric_kind="int"):
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={"strategy_id": strategy_id},
                value=count,
            )
        )
    return lines


_SPECIAL_MAP_RENDERERS = {
    "execution_fallback_total": _render_execution_fallback_total_map,
    "lean_failure_taxonomy_total": _render_lean_failure_taxonomy_total_map,
    "route_provenance": _render_route_provenance_map,
    "forecast_calibration_error": _render_forecast_calibration_error_map,
    "forecast_route_selection_total": _render_forecast_route_selection_total_map,
    "llm_committee_verdict_total": _render_llm_committee_verdict_total_map,
    "allocator_multiplier_total": _render_allocator_multiplier_total_map,
    "universe_resolution_total": _render_universe_resolution_total_map,
    "tca_summary": _render_tca_summary_map,
}


def _render_mapping_metric(key: str, values: Mapping[str, object]) -> list[str]:
    if key in _SIMPLE_MAP_METRICS:
        return _render_simple_map_metric(key, values)
    if key in _STRATEGY_RUNTIME_METRICS:
        return _render_strategy_runtime_map(key, values)
    renderer = _SPECIAL_MAP_RENDERERS.get(key)
    if renderer is None:
        return []
    return renderer(values)


def _render_scalar_metric(
    key: str,
    value: int | float,
    metrics: Mapping[str, object],
) -> list[str]:
    service_spec = _SERVICE_LABEL_GAUGES.get(key)
    if service_spec is not None:
        metric_name, help_text = service_spec
        lines = _metric_headers(metric_name, help_text, "gauge")
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={"service": "torghut"},
                value=value,
            )
        )
        return lines

    direct_spec = _DIRECT_GAUGES.get(key)
    if direct_spec is not None:
        metric_name, help_text = direct_spec
        lines = _metric_headers(metric_name, help_text, "gauge")
        lines.append(f"{metric_name} {value}")
        return lines

    if key in _EVIDENCE_CONTINUITY_KEYS:
        metric_name = f"torghut_trading_{key}"
        lines = _metric_headers(
            metric_name,
            f"Torghut trading metric {key.replace('_', ' ')}.",
            "gauge",
        )
        lines.append(f"{metric_name} {value}")
        return lines

    autonomy_spec = _AUTONOMY_WINDOW_GAUGES.get(key)
    if autonomy_spec is not None:
        metric_name, help_text = autonomy_spec
        lines = _metric_headers(metric_name, help_text, "gauge")
        lines.extend(
            _render_labeled_metric(
                metric_name=metric_name,
                labels={"symbol": "all", "horizon": "autonomy"},
                value=value,
            )
        )
        return lines

    if key == "llm_committee_veto_alignment_total":
        metric_name = "torghut_trading_llm_committee_veto_alignment_total"
        rate_name = "torghut_trading_llm_committee_veto_alignment_rate"
        veto_total = _coerce_int(metrics.get("llm_committee_veto_total"))
        lines = _metric_headers(
            metric_name,
            "Count of committee vetoes aligned with deterministic veto outcomes.",
            "counter",
        )
        lines.append(f"{metric_name} {value}")
        lines.extend(
            _metric_headers(
                rate_name,
                "Ratio of committee vetoes aligned with deterministic veto outcomes.",
                "gauge",
            )
        )
        rate = float(value) / veto_total if veto_total > 0 else 1.0
        lines.append(f"{rate_name} {rate}")
        return lines

    metric_name = f"torghut_trading_{key}"
    lines = _metric_headers(
        metric_name,
        f"Torghut trading metric {key.replace('_', ' ')}.",
        "counter",
    )
    lines.append(f"{metric_name} {value}")
    return lines


def render_trading_metrics(metrics: Mapping[str, object]) -> str:
    lines: list[str] = []
    for key, value in metrics.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, Mapping):
            lines.extend(_render_mapping_metric(key, cast(Mapping[str, object], value)))
            continue
        if not isinstance(value, (int, float)):
            continue
        lines.extend(_render_scalar_metric(key, value, metrics))
    return "\n".join(lines) + "\n"


__all__ = ["render_trading_metrics"]
