"""Extracted Torghut API route and support functions."""

from __future__ import annotations

import time
from concurrent.futures import (
    CancelledError as FutureCancelledError,
    Future,
    ThreadPoolExecutor,
    TimeoutError as FutureTimeout,
)
from datetime import datetime, timezone
from threading import Lock

from fastapi import APIRouter, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from app.bootstrap import evaluate_scheduler_status
from app.config import settings
from app.db import SessionLocal, check_schema_current

from . import readiness_helpers

router = APIRouter()

_RUNTIME_READINESS_EXECUTOR = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="torghut-runtime-readiness",
)
_RUNTIME_READINESS_LOCK = Lock()
_runtime_readiness_future: Future[dict[str, object]] | None = None
_runtime_readiness_cache: dict[str, object] | None = None
_runtime_readiness_cache_monotonic = 0.0


def _evaluate_runtime_database_readiness() -> dict[str, object]:
    """Read only the PostgreSQL/Alembic contract needed by the runtime probe."""

    with SessionLocal() as session:
        schema_status = check_schema_current(session)
    schema_current = bool(schema_status.get("schema_current"))
    return {
        "ok": schema_current,
        "detail": "ok" if schema_current else "database schema mismatch",
        "schema_current": schema_current,
        "current_heads": schema_status.get("current_heads", []),
        "expected_heads": schema_status.get("expected_heads", []),
        "schema_missing_heads": schema_status.get("schema_missing_heads", []),
        "schema_unexpected_heads": schema_status.get("schema_unexpected_heads", []),
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


def _runtime_database_readiness_bounded() -> dict[str, object]:
    """Return one bounded, cached, non-overlapping database readiness result."""

    global _runtime_readiness_cache
    global _runtime_readiness_cache_monotonic
    global _runtime_readiness_future

    now = time.monotonic()
    cache_ttl = max(0.0, settings.trading_runtime_readiness_cache_ttl_seconds)
    with _RUNTIME_READINESS_LOCK:
        if (
            _runtime_readiness_cache is not None
            and now - _runtime_readiness_cache_monotonic <= cache_ttl
        ):
            return {**_runtime_readiness_cache, "cache_used": True}
        future = _runtime_readiness_future
        if future is None:
            future = _RUNTIME_READINESS_EXECUTOR.submit(
                _evaluate_runtime_database_readiness
            )
            _runtime_readiness_future = future

    try:
        result = future.result(
            timeout=max(0.001, settings.trading_runtime_readiness_timeout_seconds)
        )
    except FutureTimeout:
        return {
            "ok": False,
            "detail": "database readiness check timed out",
            "reason": "database_readiness_timeout",
            "cache_used": False,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
    except (
        FutureCancelledError,
        RuntimeError,
        SQLAlchemyError,
        OSError,
        ValueError,
        TypeError,
    ) as exc:
        with _RUNTIME_READINESS_LOCK:
            if _runtime_readiness_future is future:
                _runtime_readiness_future = None
        return {
            "ok": False,
            "detail": "database unavailable",
            "reason": type(exc).__name__,
            "cache_used": False,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    with _RUNTIME_READINESS_LOCK:
        if _runtime_readiness_future is future:
            _runtime_readiness_future = None
        _runtime_readiness_cache = dict(result)
        _runtime_readiness_cache_monotonic = time.monotonic()
    return {**result, "cache_used": False}


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


@router.get("/runtime-readyz")
def runtime_readyz(request: Request) -> JSONResponse:
    """Serve the bounded DB/schema/scheduler contract used by Kubernetes."""

    scheduler = getattr(request.app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler_ok = False
        scheduler_payload: dict[str, object] = {
            "ok": False,
            "detail": "trading scheduler not initialized",
            "running": False,
        }
    else:
        scheduler_ok, scheduler_payload = evaluate_scheduler_status(scheduler)
        scheduler_errors = tuple(
            str(error).strip()
            for error in (
                getattr(scheduler.state, "last_trading_error", None),
                getattr(scheduler.state, "last_reconcile_error", None),
                getattr(scheduler.state, "last_autonomy_error", None),
                getattr(scheduler.state, "last_evidence_error", None),
            )
            if str(error or "").strip()
        )
        if settings.trading_enabled and scheduler_errors:
            scheduler_ok = False
            scheduler_payload = {
                **scheduler_payload,
                "ok": False,
                "detail": "trading scheduler has an active runtime failure",
                "last_error": ";".join(scheduler_errors),
            }

    database_payload = _runtime_database_readiness_bounded()
    overall_ok = scheduler_ok and bool(database_payload.get("ok"))
    payload = {
        "status": "ok" if overall_ok else "degraded",
        "readiness_surface": "bounded_runtime_dependencies",
        "trading_enabled": settings.trading_enabled,
        "scheduler": scheduler_payload,
        "dependencies": {"database": database_payload},
    }
    return JSONResponse(
        status_code=200 if overall_ok else 503,
        content=jsonable_encoder(payload),
    )


__all__ = ["readyz", "runtime_readyz"]
