"""Runtime context for the Torghut trading health surface."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from app.trading.scheduler import TradingScheduler


@dataclass(frozen=True)
class TradingHealthContextDependencies:
    get_trading_scheduler: Callable[[], TradingScheduler]
    evaluate_scheduler_status: Callable[
        [TradingScheduler], tuple[bool, dict[str, object]]
    ]


@dataclass(frozen=True)
class TradingHealthContext:
    scheduler: TradingScheduler
    scheduler_ok: bool
    scheduler_payload: dict[str, object]
    observed_at: datetime


def load_trading_health_context(
    deps: TradingHealthContextDependencies,
) -> TradingHealthContext:
    scheduler = deps.get_trading_scheduler()
    scheduler_ok, scheduler_payload = deps.evaluate_scheduler_status(scheduler)
    return TradingHealthContext(
        scheduler=scheduler,
        scheduler_ok=scheduler_ok,
        scheduler_payload=scheduler_payload,
        observed_at=datetime.now(timezone.utc),
    )


__all__ = [
    "TradingHealthContext",
    "TradingHealthContextDependencies",
    "load_trading_health_context",
]
