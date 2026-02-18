"""Prometheus-formatted metrics for Torghut trading counters."""

from __future__ import annotations

from collections.abc import Mapping
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
    label_text = ",".join([f'{key}="{_escape_label_value(val)}"' for key, val in labels.items()])
    return [f'{metric_name}{{{label_text}}} {value}']


def render_trading_metrics(metrics: Mapping[str, object]) -> str:
    lines: list[str] = []
    for key, value in metrics.items():
        if isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            if isinstance(value, Mapping):
                if key == "execution_requests_total":
                    metric_name = "torghut_trading_execution_requests_total"
                    lines.append(f"# HELP {metric_name} Count of execution requests by adapter.")
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
                    lines.append(f"# HELP {metric_name} Count of execution fallbacks by adapter transition.")
                    lines.append(f"# TYPE {metric_name} counter")
                    sorted_items = sorted(
                        [
                            (str(transition), int(count))
                            for transition, count in cast(dict[str, object], value).items()
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
                    lines.append(f"# HELP {metric_name} Count of execution fallbacks by reason.")
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
                    lines.append(f"# HELP {metric_name} Count of autonomy cycles skipped by no-signal reason.")
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
                    lines.append(f"# HELP {metric_name} Consecutive no-signal streak by reason.")
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
                    lines.append(f"# HELP {metric_name} Count of source freshness alerts by reason.")
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
                if key == "tca_summary":
                    summary = cast(dict[str, object], value)
                    scalar_metrics: list[tuple[str, str]] = [
                        ("order_count", "torghut_trading_tca_order_count"),
                        ("avg_slippage_bps", "torghut_trading_tca_avg_slippage_bps"),
                        ("avg_shortfall_notional", "torghut_trading_tca_avg_shortfall_notional"),
                        ("avg_churn_ratio", "torghut_trading_tca_avg_churn_ratio"),
                    ]
                    for summary_key, metric_name in scalar_metrics:
                        metric_value = summary.get(summary_key)
                        try:
                            numeric_value = float(metric_value)
                        except (TypeError, ValueError):
                            continue
                        metric_type = "counter" if summary_key == "order_count" else "gauge"
                        lines.append(f"# HELP {metric_name} Torghut TCA summary metric {summary_key}.")
                        lines.append(f"# TYPE {metric_name} {metric_type}")
                        lines.append(f"{metric_name} {numeric_value}")
                    continue
            continue
        if key == "signal_lag_seconds":
            metric_name = "torghut_trading_signal_lag_seconds"
            lines.append(f"# HELP {metric_name} Latest signal ingestion lag in seconds.")
            lines.append(f"# TYPE {metric_name} gauge")
            lines.extend(_render_labeled_metric(metric_name=metric_name, labels={"service": "torghut"}, value=value))
            continue
        if key == "no_signal_streak":
            metric_name = "torghut_trading_no_signal_streak"
            lines.append(f"# HELP {metric_name} Consecutive no-signal autonomy cycles.")
            lines.append(f"# TYPE {metric_name} gauge")
            lines.extend(_render_labeled_metric(metric_name=metric_name, labels={"service": "torghut"}, value=value))
            continue
        metric_name = f"torghut_trading_{key}"
        help_text = f"Torghut trading metric {key.replace('_', ' ')}."
        lines.append(f"# HELP {metric_name} {help_text}")
        lines.append(f"# TYPE {metric_name} counter")
        lines.append(f"{metric_name} {value}")
    return "\n".join(lines) + "\n"


__all__ = ["render_trading_metrics"]
