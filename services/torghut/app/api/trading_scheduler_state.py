"""Access to the process-local trading scheduler stored on the FastAPI app."""

from __future__ import annotations

from app.trading.scheduler import TradingScheduler

from .application import get_app

__all__ = ("get_trading_scheduler",)


def get_trading_scheduler() -> TradingScheduler:
    app = get_app()
    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    return scheduler
