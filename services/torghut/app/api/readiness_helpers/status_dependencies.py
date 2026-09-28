"""Operational dependencies shared by readiness and trading status."""

from __future__ import annotations

from app.trading.scheduler import TradingScheduler
from app.trading.submission_council import build_live_submission_gate_payload

from ..health_checks import load_clickhouse_ta_status


def refresh_universe_state_for_readiness(
    *,
    scheduler: TradingScheduler,
    state: object,
) -> None:
    from .refresh_universe_state_for_readiness import (
        refresh_universe_state_for_readiness as refresh,
    )

    refresh(scheduler=scheduler, state=state)


__all__ = (
    "build_live_submission_gate_payload",
    "load_clickhouse_ta_status",
    "refresh_universe_state_for_readiness",
)
