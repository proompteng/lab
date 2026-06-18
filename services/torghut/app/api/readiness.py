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


@router.get("/readyz")
def readyz() -> JSONResponse:
    """Readiness endpoint with dependency-aware status for rollout safety."""

    payload, status_code = readiness_helpers.evaluate_core_readiness_payload(
        include_database_contract=True,
        allow_stale_dependency_cache=True,
    )
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder(payload),
    )


__all__ = ["readyz"]
