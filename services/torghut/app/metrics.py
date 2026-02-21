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


def render_trading_metrics(metrics: Mapping[str, object]) -> str:
    lines: list[str] = []
    for key, value in metrics.items():
        if isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            if isinstance(value, Mapping):
                if key == "execution_requests_total":
                    metric_name = "torghut_trading_execution_requests_total"
                    lines.append(
                        f"# HELP {metric_name} Count of execution requests by adapter."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(adapter), int(count))
                            for adapter, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for adapter, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"adapter": adapter},
                                value=count,
                            )
                        )
                    continue
                if key == "execution_fallback_total":
                    metric_name = "torghut_trading_execution_fallback_total"
                    lines.append(
                        f"# HELP {metric_name} Count of execution fallbacks by adapter transition."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(transition), int(count))
                            for transition, count in cast(
                                dict[str, object], value
                            ).items()
                            if isinstance(count, int)
                        ]
                    )
                    for transition, count in sorted_items:
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
                    continue
                if key == "execution_fallback_reason_total":
                    metric_name = "torghut_trading_execution_fallback_reason_total"
                    lines.append(
                        f"# HELP {metric_name} Count of execution fallbacks by reason."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(reason), int(count))
                            for reason, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for reason, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"reason": reason},
                                value=count,
                            )
                        )
                    continue
                if key == "no_signal_reason_total":
                    metric_name = "torghut_trading_no_signal_reason_total"
                    lines.append(
                        f"# HELP {metric_name} Count of autonomy cycles skipped by no-signal reason."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(reason), int(count))
                            for reason, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for reason, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"reason": reason},
                                value=count,
                            )
                        )
                    continue
                if key == "no_signal_reason_streak":
                    metric_name = "torghut_trading_no_signal_reason_streak"
                    lines.append(
                        f"# HELP {metric_name} Consecutive no-signal streak by reason."
                    )
                    lines.append(f"# TYPE {metric_name} gauge")
                    sorted_items = sorted(
                        [
                            (str(reason), int(count))
                            for reason, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for reason, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"reason": reason},
                                value=count,
                            )
                        )
                    continue
                if key == "signal_staleness_alert_total":
                    metric_name = "torghut_trading_signal_staleness_alert_total"
                    lines.append(
                        f"# HELP {metric_name} Count of source freshness alerts by reason."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(reason), int(count))
                            for reason, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for reason, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"reason": reason},
                                value=count,
                            )
                        )
                    continue
                if key == "route_provenance":
                    summary = cast(dict[str, object], value)
                    total = _coerce_int(summary.get("total"))
                    missing = _coerce_int(summary.get("missing"))
                    unknown = _coerce_int(summary.get("unknown"))
                    mismatch = _coerce_int(summary.get("mismatch"))

                    ratio_metrics: list[tuple[str, str]] = [
                        (
                            "coverage_ratio",
                            "torghut_trading_route_provenance_coverage_ratio",
                        ),
                        (
                            "unknown_ratio",
                            "torghut_trading_route_provenance_unknown_ratio",
                        ),
                        (
                            "mismatch_ratio",
                            "torghut_trading_route_provenance_mismatch_ratio",
                        ),
                    ]
                    for source_key, metric_name in ratio_metrics:
                        lines.append(
                            f"# HELP {metric_name} Route provenance continuity ratio for recent executions."
                        )
                        lines.append(f"# TYPE {metric_name} gauge")
                        ratio = summary.get(source_key)
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
                        lines.append(f"# HELP {metric_name} {help_text}")
                        lines.append(f"# TYPE {metric_name} gauge")
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={},
                                value=metric_value,
                            )
                        )
                    continue
                if key == "forecast_router_inference_latency_ms":
                    metric_name = "torghut_forecast_router_inference_latency_ms"
                    lines.append(
                        f"# HELP {metric_name} Deterministic forecast inference latency by model family."
                    )
                    lines.append(f"# TYPE {metric_name} gauge")
                    sorted_items = sorted(
                        [
                            (str(family), int(latency))
                            for family, latency in cast(dict[str, object], value).items()
                            if isinstance(latency, int)
                        ]
                    )
                    for family, latency in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"model_family": family},
                                value=latency,
                            )
                        )
                    continue
                if key == "forecast_router_fallback_total":
                    metric_name = "torghut_forecast_router_fallback_total"
                    lines.append(
                        f"# HELP {metric_name} Count of forecast router fallbacks by reason."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(reason), int(count))
                            for reason, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for reason, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"reason": reason},
                                value=count,
                            )
                        )
                    continue
                if key == "forecast_calibration_error":
                    metric_name = "torghut_forecast_calibration_error"
                    lines.append(
                        f"# HELP {metric_name} Forecast calibration error by model family, symbol, and horizon."
                    )
                    lines.append(f"# TYPE {metric_name} gauge")
                    sorted_items = sorted(
                        [
                            (str(route_key), str(error_value))
                            for route_key, error_value in cast(dict[str, object], value).items()
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
                    continue
                if key == "forecast_route_selection_total":
                    metric_name = "torghut_forecast_route_selection_total"
                    lines.append(
                        f"# HELP {metric_name} Count of forecast route selections by model family and route key."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(route_key), int(count))
                            for route_key, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for route_key, count in sorted_items:
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
                    continue
                if key in {"llm_market_context_reason_total", "llm_market_context_shadow_total"}:
                    metric_name = (
                        "torghut_trading_llm_market_context_reason_total"
                        if key == "llm_market_context_reason_total"
                        else "torghut_trading_llm_market_context_shadow_total"
                    )
                    lines.append(f"# HELP {metric_name} Count of LLM market-context fallbacks by reason.")
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(reason), int(count))
                            for reason, count in cast(dict[str, object], value).items()
                            if isinstance(count, int)
                        ]
                    )
                    for reason, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"reason": reason},
                                value=count,
                            )
                        )
                    continue
                if key == "llm_policy_resolution_total":
                    metric_name = "torghut_trading_llm_policy_resolution_total"
                    lines.append(
                        f"# HELP {metric_name} Count of LLM policy-resolution classifications."
                    )
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(classification), int(count))
                            for classification, count in cast(
                                dict[str, object], value
                            ).items()
                            if isinstance(count, int)
                        ]
                    )
                    for classification, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"classification": classification},
                                value=count,
                            )
                        )
                    continue
                if key in {
                    "strategy_events_total",
                    "strategy_intents_total",
                    "strategy_errors_total",
                    "strategy_latency_ms",
                }:
                    metric_name_map = {
                        "strategy_events_total": "torghut_trading_strategy_events_total",
                        "strategy_intents_total": "torghut_trading_strategy_intents_total",
                        "strategy_errors_total": "torghut_trading_strategy_errors_total",
                        "strategy_latency_ms": "torghut_trading_strategy_latency_ms",
                    }
                    metric_name = metric_name_map[key]
                    metric_type = "gauge" if key == "strategy_latency_ms" else "counter"
                    lines.append(f"# HELP {metric_name} Strategy runtime metric {key}.")
                    lines.append(f"# TYPE {metric_name} {metric_type}")
                    sorted_items = sorted(
                        [
                            (str(strategy_id), int(count))
                            for strategy_id, count in cast(
                                dict[str, object], value
                            ).items()
                            if isinstance(count, int)
                        ]
                    )
                    for strategy_id, count in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"strategy_id": strategy_id},
                                value=count,
                            )
                        )
                    continue
                if key == "feature_null_rate":
                    metric_name = "torghut_trading_feature_null_rate"
                    lines.append(f"# HELP {metric_name} Required feature null-rate by field.")
                    lines.append(f"# TYPE {metric_name} gauge")
                    sorted_items = sorted(
                        [
                            (str(field), float(null_rate))
                            for field, null_rate in cast(dict[str, object], value).items()
                            if isinstance(null_rate, (int, float, Decimal))
                        ]
                    )
                    for field, null_rate in sorted_items:
                        lines.extend(
                            _render_labeled_metric(
                                metric_name=metric_name,
                                labels={"field": field},
                                value=null_rate,
                            )
                        )
                    continue
                if key == "tca_summary":
                    summary = cast(dict[str, object], value)
                    scalar_metrics: list[tuple[str, str]] = [
                        ("order_count", "torghut_trading_tca_order_count"),
                        ("avg_slippage_bps", "torghut_trading_tca_avg_slippage_bps"),
                        (
                            "avg_shortfall_notional",
                            "torghut_trading_tca_avg_shortfall_notional",
                        ),
                        ("avg_churn_ratio", "torghut_trading_tca_avg_churn_ratio"),
                    ]
                    for summary_key, metric_name in scalar_metrics:
                        metric_value = summary.get(summary_key)
                        if not isinstance(metric_value, (int, float, Decimal)):
                            continue
                        numeric_value = float(metric_value)
                        metric_type = (
                            "counter" if summary_key == "order_count" else "gauge"
                        )
                        lines.append(
                            f"# HELP {metric_name} Torghut TCA summary metric {summary_key}."
                        )
                        lines.append(f"# TYPE {metric_name} {metric_type}")
                        lines.append(f"{metric_name} {numeric_value}")
                    continue
            continue
        if key == "signal_lag_seconds":
            metric_name = "torghut_trading_signal_lag_seconds"
            lines.append(
                f"# HELP {metric_name} Latest signal ingestion lag in seconds."
            )
            lines.append(f"# TYPE {metric_name} gauge")
            lines.extend(
                _render_labeled_metric(
                    metric_name=metric_name, labels={"service": "torghut"}, value=value
                )
            )
            continue
        if key == "no_signal_streak":
            metric_name = "torghut_trading_no_signal_streak"
            lines.append(f"# HELP {metric_name} Consecutive no-signal autonomy cycles.")
            lines.append(f"# TYPE {metric_name} gauge")
            lines.extend(
                _render_labeled_metric(
                    metric_name=metric_name, labels={"service": "torghut"}, value=value
                )
            )
            continue
        if key == "feature_staleness_ms_p95":
            metric_name = "torghut_trading_feature_staleness_ms_p95"
            lines.append(f"# HELP {metric_name} Feature staleness p95 for the latest ingest batch.")
            lines.append(f"# TYPE {metric_name} gauge")
            lines.append(f"{metric_name} {value}")
            continue
        if key == "feature_duplicate_ratio":
            metric_name = "torghut_trading_feature_duplicate_ratio"
            lines.append(f"# HELP {metric_name} Duplicate event ratio in the latest ingest batch.")
            lines.append(f"# TYPE {metric_name} gauge")
            lines.append(f"{metric_name} {value}")
            continue
        if key in {
            "evidence_continuity_last_checked_ts_seconds",
            "evidence_continuity_last_success_ts_seconds",
            "evidence_continuity_last_failed_runs",
        }:
            metric_name = f"torghut_trading_{key}"
            lines.append(f"# HELP {metric_name} Torghut trading metric {key.replace('_', ' ')}.")
            lines.append(f"# TYPE {metric_name} gauge")
            lines.append(f"{metric_name} {value}")
            continue
        metric_name = f"torghut_trading_{key}"
        help_text = f"Torghut trading metric {key.replace('_', ' ')}."
        lines.append(f"# HELP {metric_name} {help_text}")
        lines.append(f"# TYPE {metric_name} counter")
        lines.append(f"{metric_name} {value}")
    return "\n".join(lines) + "\n"


__all__ = ["render_trading_metrics"]
