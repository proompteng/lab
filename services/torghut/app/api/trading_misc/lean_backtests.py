"""LEAN backtest API routes."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, cast

from fastapi import Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.runtime_services import LEAN_LANE_MANAGER
from app.config import settings
from app.db import get_session

from ..command_auth import require_command_auth
from .router import router


@router.post("/trading/lean/backtests")
def submit_lean_backtest(
    payload: dict[str, object] = Body(default={}),
    requested_by: str | None = Query(default=None),
    session: Session = Depends(get_session),
    _command_auth: None = Depends(require_command_auth),
) -> dict[str, object]:
    """Submit an asynchronous LEAN backtest and persist metadata for governance."""

    if settings.trading_lean_lane_disable_switch:
        raise HTTPException(status_code=409, detail="lean_lane_disabled")
    if not settings.trading_lean_backtest_enabled:
        raise HTTPException(status_code=409, detail="lean_backtest_lane_disabled")
    lane = str(payload.get("lane") or "research").strip() or "research"
    config_payload = payload.get("config")
    if not isinstance(config_payload, dict):
        raise HTTPException(status_code=400, detail="config_must_be_object")
    config = {
        str(key): value
        for key, value in cast(dict[object, Any], config_payload).items()
    }
    try:
        row = LEAN_LANE_MANAGER.submit_backtest(
            session,
            config=config,
            lane=lane,
            requested_by=requested_by,
            correlation_id=f"torghut-backtest-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "backtest_id": row.backtest_id,
        "status": row.status,
        "lane": row.lane,
        "reproducibility_hash": row.reproducibility_hash,
        "requested_by": row.requested_by,
        "created_at": row.created_at,
    }


@router.get("/trading/lean/backtests/{backtest_id}")
def get_lean_backtest(
    backtest_id: str, session: Session = Depends(get_session)
) -> dict[str, object]:
    """Refresh and return LEAN backtest lifecycle state and reproducibility evidence."""

    try:
        row = LEAN_LANE_MANAGER.refresh_backtest(session, backtest_id=backtest_id)
    except RuntimeError as exc:
        detail = str(exc)
        status = 404 if detail == "lean_backtest_not_found" else 502
        raise HTTPException(status_code=status, detail=detail) from exc
    return {
        "backtest_id": row.backtest_id,
        "status": row.status,
        "lane": row.lane,
        "result": row.result_json,
        "artifacts": row.artifacts_json,
        "reproducibility_hash": row.reproducibility_hash,
        "replay_hash": row.replay_hash,
        "deterministic_replay_passed": row.deterministic_replay_passed,
        "failure_taxonomy": row.failure_taxonomy,
        "completed_at": row.completed_at,
    }


@router.get("/trading/lean/shadow/parity")
def get_lean_shadow_parity(
    lookback_hours: int = Query(default=24, ge=1, le=168),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return LEAN shadow execution parity summary for drift detection and governance."""

    return LEAN_LANE_MANAGER.parity_summary(
        session,
        lookback_hours=lookback_hours,
    )


__all__ = (
    "get_lean_backtest",
    "get_lean_shadow_parity",
    "submit_lean_backtest",
)
