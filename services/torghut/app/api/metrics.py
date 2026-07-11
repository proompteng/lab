"""Prometheus metrics for the live trading runtime."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import Response

from app.config import settings
from app.metrics import render_trading_metrics

from .trading_scheduler_state import get_trading_scheduler

router = APIRouter()


def _process_owner_metrics(*, role: str) -> str:
    return "\n".join(
        (
            "# HELP torghut_process_role_info Process-local Torghut runtime role.",
            "# TYPE torghut_process_role_info gauge",
            f'torghut_process_role_info{{role="{role}"}} 1',
            "# HELP torghut_trading_runtime_owner_info Declared owner of the trading runtime.",
            "# TYPE torghut_trading_runtime_owner_info gauge",
            'torghut_trading_runtime_owner_info{owner="torghut-scheduler"} 1',
            "",
        )
    )


@router.get("/metrics")
def prometheus_metrics() -> Response:
    if settings.process_role == "api":
        return Response(
            content="\n".join(
                (
                    "# HELP torghut_api_process_ready Whether the stateless API process is serving.",
                    "# TYPE torghut_api_process_ready gauge",
                    "torghut_api_process_ready 1",
                    _process_owner_metrics(role="api"),
                )
            ),
            media_type="text/plain; version=0.0.4",
        )

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
        content=render_trading_metrics(payload)
        + _process_owner_metrics(role="scheduler"),
        media_type="text/plain; version=0.0.4",
    )


__all__ = ["prometheus_metrics", "router"]
