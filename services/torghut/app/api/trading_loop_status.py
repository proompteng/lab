"""Lightweight operator proof endpoint for the canonical trading loop."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import cast

from fastapi import APIRouter

from app.trading.loop_status import (
    LoopStatusOptions,
    QuerySession,
    build_trading_loop_status,
)

from .common import JSONResponse, SessionLocal, jsonable_encoder, settings

router = APIRouter()


@router.get("/trading/loop/status")
def trading_loop_status() -> JSONResponse:
    """Return hard proof that the trading loop is or is not restored."""

    with SessionLocal() as session:
        payload = build_trading_loop_status(
            cast(QuerySession, session),
            options=LoopStatusOptions(
                generated_at=datetime.now(timezone.utc),
                trading_mode=settings.trading_mode,
                trading_enabled=settings.trading_enabled,
            ),
        )
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


__all__ = ["trading_loop_status"]
