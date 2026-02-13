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
