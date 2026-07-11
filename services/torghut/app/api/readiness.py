"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import settings

from . import readiness_helpers

router = APIRouter()


@router.get("/readyz")
def readyz() -> JSONResponse:
    """Return process-local readiness, with dependency checks on the scheduler."""

    if settings.process_role == "api":
        return JSONResponse(
            status_code=200,
            content={
                "status": "ok",
                "reason_codes": [],
                "process_role": "api",
                "runtime_owner": "torghut-scheduler",
                "scheduler": {
                    "ownership": "external",
                    "owner": "torghut-scheduler",
                    "availability": "not_evaluated",
                },
            },
        )

    payload, status_code = readiness_helpers.evaluate_core_readiness_payload(
        include_database_contract=True,
        allow_stale_dependency_cache=True,
    )
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder(payload),
    )


__all__ = ["readyz"]
