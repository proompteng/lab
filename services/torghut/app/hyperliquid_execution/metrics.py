"""Prometheus metrics for Hyperliquid execution v2."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from typing import cast

from .models import CycleResult


class HyperliquidExecutionMetrics:
    """Small in-process metrics collector."""

    def __init__(self) -> None:
        self._cycles = 0
        self._errors: Counter[str] = Counter()
        self._signals = 0
        self._orders = 0
        self._cancels = 0
        self._latest_ready_dependencies = 0
        self._latest_total_dependencies = 0
        self._recovery: Counter[str] = Counter()
        self._latest_recovery_run_sequence = 0

    def record_cycle(self, result: CycleResult) -> None:
        self._cycles += 1
        self._signals += result.signals_written
        self._orders += result.orders_submitted
        self._cancels += result.orders_cancelled
        self._latest_total_dependencies = len(result.dependencies)
        self._latest_ready_dependencies = sum(
            1 for dependency in result.dependencies if dependency.ready
        )
        for dependency in result.dependencies:
            if dependency.name != "broker_mutation_recovery":
                continue
            run_sequence = dependency.details.get("run_sequence")
            if (
                not isinstance(run_sequence, int)
                or isinstance(run_sequence, bool)
                or run_sequence <= self._latest_recovery_run_sequence
            ):
                continue
            self._latest_recovery_run_sequence = run_sequence
            outcomes = dependency.details.get("outcomes")
            if not isinstance(outcomes, dict):
                continue
            typed_outcomes = cast(Mapping[object, object], outcomes)
            for outcome, count in typed_outcomes.items():
                if isinstance(outcome, str) and isinstance(count, int):
                    self._recovery[outcome] += max(0, count)

    def record_error(self, exc: Exception) -> None:
        self._errors[type(exc).__name__] += 1

    def render(self, namespace: str) -> str:
        lines = [
            "# TYPE {0}_cycles_total counter".format(namespace),
            f"{namespace}_cycles_total {self._cycles}",
            "# TYPE {0}_signals_total counter".format(namespace),
            f"{namespace}_signals_total {self._signals}",
            "# TYPE {0}_orders_submitted_total counter".format(namespace),
            f"{namespace}_orders_submitted_total {self._orders}",
            "# TYPE {0}_orders_cancelled_total counter".format(namespace),
            f"{namespace}_orders_cancelled_total {self._cancels}",
            "# TYPE {0}_ready_dependencies gauge".format(namespace),
            f"{namespace}_ready_dependencies {self._latest_ready_dependencies}",
            "# TYPE {0}_total_dependencies gauge".format(namespace),
            f"{namespace}_total_dependencies {self._latest_total_dependencies}",
            "# TYPE {0}_errors_total counter".format(namespace),
        ]
        for name, count in sorted(self._errors.items()):
            lines.append(f'{namespace}_errors_total{{error="{name}"}} {count}')
        lines.append(
            "# TYPE {0}_broker_mutation_recovery_total counter".format(namespace)
        )
        for outcome, count in sorted(self._recovery.items()):
            lines.append(
                f'{namespace}_broker_mutation_recovery_total{{outcome="{outcome}"}} {count}'
            )
        return "\n".join(lines) + "\n"
