"""Prometheus metrics for the live trading runtime."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import Response

from app.metrics import render_trading_metrics

from .trading_scheduler_state import get_trading_scheduler

router = APIRouter()


@router.get("/metrics")
def prometheus_metrics() -> Response:
    scheduler = get_trading_scheduler()
    state = scheduler.state
    leadership = scheduler.leadership_status
    payload = {
        **state.metrics.to_payload(),
        "scheduler_leadership_acquired": int(leadership.acquired),
        "scheduler_leadership_healthy": int(leadership.healthy),
        "capital_new_exposure_allowed": int(state.capital_new_exposure_allowed),
        "capital_daily_loss_ratio": state.capital_daily_loss_ratio,
        "capital_drawdown_ratio": state.capital_drawdown_ratio,
        "capital_closeout_attempts": state.capital_closeout_attempts,
        "capital_flat_confirmed": int(state.capital_flat_confirmed_at is not None),
    }
    return Response(
        content=render_trading_metrics(payload),
        media_type="text/plain; version=0.0.4",
    )


__all__ = ["prometheus_metrics", "router"]
