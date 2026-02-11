"""Prometheus-formatted metrics for Torghut trading counters."""

from __future__ import annotations

from typing import Mapping


def render_trading_metrics(metrics: Mapping[str, object]) -> str:
    lines: list[str] = []
    for key, value in metrics.items():
        if isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            continue
        metric_name = f"torghut_trading_{key}"
        help_text = f"Torghut trading metric {key.replace('_', ' ')}."
        lines.append(f"# HELP {metric_name} {help_text}")
        lines.append(f"# TYPE {metric_name} counter")
        lines.append(f"{metric_name} {value}")
    return "\n".join(lines) + "\n"


__all__ = ["render_trading_metrics"]
