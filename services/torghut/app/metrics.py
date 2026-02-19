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
        metric_name = f"torghut_trading_{key}"
        help_text = f"Torghut trading metric {key.replace('_', ' ')}."
        lines.append(f"# HELP {metric_name} {help_text}")
        lines.append(f"# TYPE {metric_name} counter")
        lines.append(f"{metric_name} {value}")
    return "\n".join(lines) + "\n"


__all__ = ["render_trading_metrics"]
