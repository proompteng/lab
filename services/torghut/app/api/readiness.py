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

_evaluate_core_readiness_payload = MainAttrProxy("_evaluate_core_readiness_payload")
router = APIRouter()


@router.get("/readyz")
def readyz() -> JSONResponse:
    """Readiness endpoint with dependency-aware status for rollout safety."""

    payload, status_code = _evaluate_core_readiness_payload(
        include_database_contract=True,
        allow_stale_dependency_cache=True,
    )
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder(payload),
    )


__all__ = ["readyz"]
capture_module_exports(globals(), __all__)
