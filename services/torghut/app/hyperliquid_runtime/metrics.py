"""Prometheus text rendering for the Hyperliquid runtime."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from .models import CycleResult


@dataclass
class HyperliquidRuntimeMetrics:
    """In-memory counters exported by the isolated runtime app."""

    cycles_total: int = 0
    cycle_errors_total: int = 0
    orders_submitted_total: int = 0
    blocked_decisions_total: int = 0
    signals_written_total: int = 0
    last_cycle_at: datetime | None = None
    last_error: str | None = None

    def record_cycle(self, result: CycleResult) -> None:
        self.cycles_total += 1
        self.orders_submitted_total += result.orders_submitted
        self.blocked_decisions_total += result.blocked_decisions
        self.signals_written_total += result.signals_written
        self.last_cycle_at = result.observed_at
        self.last_error = None

    def record_error(self, error: BaseException) -> None:
        self.cycle_errors_total += 1
        self.last_error = f"{type(error).__name__}:{error}"

    def render(self, namespace: str) -> str:
        last_cycle_seconds = 0.0
        if self.last_cycle_at is not None:
            last_cycle_seconds = self.last_cycle_at.astimezone(timezone.utc).timestamp()
        lines = [
            f"# HELP {namespace}_cycles_total Runtime cycles completed.",
            f"# TYPE {namespace}_cycles_total counter",
            f"{namespace}_cycles_total {self.cycles_total}",
            f"# HELP {namespace}_cycle_errors_total Runtime cycle errors.",
            f"# TYPE {namespace}_cycle_errors_total counter",
            f"{namespace}_cycle_errors_total {self.cycle_errors_total}",
            f"# HELP {namespace}_orders_submitted_total Testnet orders submitted.",
            f"# TYPE {namespace}_orders_submitted_total counter",
            f"{namespace}_orders_submitted_total {self.orders_submitted_total}",
            f"# HELP {namespace}_blocked_decisions_total Decisions blocked by risk gates.",
            f"# TYPE {namespace}_blocked_decisions_total counter",
            f"{namespace}_blocked_decisions_total {self.blocked_decisions_total}",
            f"# HELP {namespace}_signals_written_total Signals persisted.",
            f"# TYPE {namespace}_signals_written_total counter",
            f"{namespace}_signals_written_total {self.signals_written_total}",
            f"# HELP {namespace}_last_cycle_ts_seconds Last completed cycle Unix timestamp.",
            f"# TYPE {namespace}_last_cycle_ts_seconds gauge",
            f"{namespace}_last_cycle_ts_seconds {last_cycle_seconds}",
        ]
        return "\n".join(lines) + "\n"
