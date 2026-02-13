"""Prometheus-formatted metrics for Torghut trading counters."""

from __future__ import annotations

from collections.abc import Mapping


def _escape_label_value(value: str | int | float) -> str:
    text = str(value)
    return text.replace("\\", "\\\\").replace('"', '\\"')


def _render_labeled_counter(
    metric_name: str,
    labels: Mapping[str, str],
    value: int | float,
) -> list[str]:
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
                    for adapter, count in sorted(value.items()):
                        if not isinstance(adapter, str) or not isinstance(count, (int, float)):
                            continue
                        metric_name = "torghut_trading_execution_requests_total"
                        lines.append(f"# HELP {metric_name} Count of execution requests by adapter.")
                        lines.append(f"# TYPE {metric_name} counter")
                        lines.extend(
                            _render_labeled_counter(
                                metric_name=metric_name,
                                labels={"adapter": adapter},
                                value=count,
                            )
                        )
                    continue
                if key == "execution_fallback_total":
                    for transition, count in sorted(value.items()):
                        if not isinstance(transition, str) or not isinstance(count, (int, float)):
                            continue
                        expected_adapter = "unknown"
                        actual_adapter = "unknown"
                        if "->" in transition:
                            expected_adapter, actual_adapter = transition.split("->", 1)
                        metric_name = "torghut_trading_execution_fallback_total"
                        lines.append(f"# HELP {metric_name} Count of execution fallbacks by adapter transition.")
                        lines.append(f"# TYPE {metric_name} counter")
                        lines.extend(
                            _render_labeled_counter(
                                metric_name=metric_name,
                                labels={"from": expected_adapter, "to": actual_adapter},
                                value=count,
                            )
                        )
                    continue
                if key == "execution_fallback_reason_total":
                    for reason, count in sorted(value.items()):
                        if not isinstance(reason, str) or not isinstance(count, (int, float)):
                            continue
                        metric_name = "torghut_trading_execution_fallback_reason_total"
                        lines.append(f"# HELP {metric_name} Count of execution fallbacks by reason.")
                        lines.append(f"# TYPE {metric_name} counter")
                        lines.extend(
                            _render_labeled_counter(
                                metric_name=metric_name,
                                labels={"reason": reason},
                                value=count,
                            )
                        )
                    continue
            continue
        metric_name = f"torghut_trading_{key}"
        help_text = f"Torghut trading metric {key.replace('_', ' ')}."
        lines.append(f"# HELP {metric_name} {help_text}")
        lines.append(f"# TYPE {metric_name} counter")
        lines.append(f"{metric_name} {value}")
    return "\n".join(lines) + "\n"


__all__ = ["render_trading_metrics"]
