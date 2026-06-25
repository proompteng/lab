"""Simulation progress API route."""

from __future__ import annotations

from typing import cast

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session
from app.trading.simulation_progress import (
    active_simulation_runtime_context,
    simulation_progress_snapshot,
)

from .router import router


@router.get("/trading/simulation/progress")
def trading_simulation_progress(
    run_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Expose durable simulation progress for the current or requested run."""

    snapshot = simulation_progress_snapshot(session, run_id=run_id)
    active_runtime_context = active_simulation_runtime_context(session)
    snapshot["requested_run_id"] = run_id
    snapshot["active_run_id"] = (active_runtime_context or {}).get(
        "run_id"
    ) or settings.trading_simulation_run_id
    snapshot["simulation_enabled"] = settings.trading_simulation_enabled
    return cast(dict[str, object], snapshot)


__all__ = ("trading_simulation_progress",)
