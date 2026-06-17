"""Extracted Torghut API route and support functions."""

# pyright: reportUnusedImport=false
# ruff: noqa: F401,F403,F405
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import (
    JSONResponse,
    jsonable_encoder,
)
from .proxy import MainAttrProxy, capture_module_exports

_evaluate_trading_health_payload_bounded = MainAttrProxy(
    "_evaluate_trading_health_payload_bounded"
)
router = APIRouter()


@router.get("/trading/health")
def trading_health() -> JSONResponse:
    """Trading loop health including dependency readiness."""

    payload, status_code = _evaluate_trading_health_payload_bounded(
        surface="trading_health",
    )
    return JSONResponse(status_code=status_code, content=jsonable_encoder(payload))


__all__ = ["trading_health"]
capture_module_exports(globals(), __all__)
