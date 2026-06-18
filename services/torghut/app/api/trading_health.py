"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from fastapi import APIRouter
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import (
    JSONResponse,
    jsonable_encoder,
)
from . import readiness_helpers

router = APIRouter()


@router.get("/trading/health")
def trading_health() -> JSONResponse:
    """Trading loop health including dependency readiness."""

    payload, status_code = readiness_helpers.evaluate_trading_health_payload_bounded(
        surface="trading_health",
    )
    return JSONResponse(status_code=status_code, content=jsonable_encoder(payload))


__all__ = ["trading_health"]
