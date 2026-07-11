"""Dedicated Torghut trading scheduler process entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import cast

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.types import ExceptionHandler

from .api.application import build_registered_app
from .bootstrap import assert_dspy_cutover_migration_guard, sqlalchemy_exception_handler
from .config import settings
from .db import SessionLocal, ensure_schema
from .observability import shutdown_posthog_telemetry
from .trading.autonomy import assert_runtime_gate_policy_contract
from .trading.scheduler import TradingScheduler
from .whitepapers import WhitepaperKafkaWorker, whitepaper_workflow_enabled

logger = logging.getLogger(__name__)


def _scheduler_success_age_seconds(last_run_at: object) -> float | None:
    if not isinstance(last_run_at, datetime):
        return None
    normalized = last_run_at
    if normalized.tzinfo is None:
        normalized = normalized.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - normalized).total_seconds()


def _scheduler_readiness_detail(
    *,
    running: bool,
    last_run_at: object,
    trading_success_is_fresh: bool,
    last_reconcile_at: object,
    reconcile_success_is_fresh: bool,
    cycle_failed: bool,
    leadership_ok: bool,
) -> str:
    if not running:
        return "scheduler_not_running"
    if cycle_failed:
        return "scheduler_cycle_failed"
    if last_run_at is None:
        return "scheduler_success_missing"
    if not trading_success_is_fresh:
        return "scheduler_success_stale"
    if last_reconcile_at is None:
        return "scheduler_reconcile_success_missing"
    if not reconcile_success_is_fresh:
        return "scheduler_reconcile_success_stale"
    if not leadership_ok:
        return "scheduler_leadership_unhealthy"
    return "ok"


def scheduler_readiness_payload(scheduler: TradingScheduler) -> dict[str, object]:
    """Require fresh trading and reconciliation success plus healthy leadership."""

    state = scheduler.state
    running = bool(getattr(state, "running", False))
    last_run_at = getattr(state, "last_run_at", None)
    last_reconcile_at = getattr(state, "last_reconcile_at", None)
    loop_errors = {
        "last_error": getattr(state, "last_error", None),
        "last_trading_error": getattr(state, "last_trading_error", None),
        "last_reconcile_error": getattr(state, "last_reconcile_error", None),
        "last_autonomy_error": getattr(state, "last_autonomy_error", None),
        "last_evidence_error": getattr(state, "last_evidence_error", None),
    }
    trading_success_age_seconds = _scheduler_success_age_seconds(last_run_at)
    trading_success_is_fresh = (
        trading_success_age_seconds is not None
        and 0
        <= trading_success_age_seconds
        <= settings.trading_scheduler_success_max_age_seconds
    )
    reconcile_success_age_seconds = _scheduler_success_age_seconds(last_reconcile_at)
    reconcile_success_is_fresh = (
        reconcile_success_age_seconds is not None
        and 0
        <= reconcile_success_age_seconds
        <= settings.trading_scheduler_success_max_age_seconds
    )
    leadership = scheduler_liveness_payload(scheduler)
    leadership_ok = bool(leadership["ok"])
    cycle_failed = any(error is not None for error in loop_errors.values())
    ready = (
        running
        and trading_success_is_fresh
        and reconcile_success_is_fresh
        and not cycle_failed
        and leadership_ok
    )
    payload: dict[str, object] = {
        "ok": ready,
        "process_role": settings.process_role,
        "running": running,
        "detail": _scheduler_readiness_detail(
            running=running,
            last_run_at=last_run_at,
            trading_success_is_fresh=trading_success_is_fresh,
            last_reconcile_at=last_reconcile_at,
            reconcile_success_is_fresh=reconcile_success_is_fresh,
            cycle_failed=cycle_failed,
            leadership_ok=leadership_ok,
        ),
        "success_max_age_seconds": settings.trading_scheduler_success_max_age_seconds,
        "trading_success_is_fresh": trading_success_is_fresh,
        "reconcile_success_is_fresh": reconcile_success_is_fresh,
        "leadership": leadership.get("leadership"),
    }
    if isinstance(last_run_at, datetime):
        payload["last_run_at"] = last_run_at.isoformat()
    if trading_success_age_seconds is not None:
        payload["success_age_seconds"] = trading_success_age_seconds
        payload["trading_success_age_seconds"] = trading_success_age_seconds
    if isinstance(last_reconcile_at, datetime):
        payload["last_reconcile_at"] = last_reconcile_at.isoformat()
    if reconcile_success_age_seconds is not None:
        payload["reconcile_success_age_seconds"] = reconcile_success_age_seconds
    for key, error in loop_errors.items():
        if error is not None:
            payload[key] = str(error)
    return payload


def scheduler_liveness_payload(scheduler: TradingScheduler) -> dict[str, object]:
    """Fail closed when durable scheduler leadership is missing or unhealthy."""

    leadership_status = getattr(scheduler, "leadership_status", None)
    if callable(leadership_status):
        leadership_status = leadership_status()
    if leadership_status is None:
        return {
            "ok": False,
            "process_role": settings.process_role,
            "detail": "leadership_status_unavailable",
        }

    required = bool(getattr(leadership_status, "required", True))
    acquired = bool(getattr(leadership_status, "acquired", False))
    healthy = bool(getattr(leadership_status, "healthy", False))
    ok = healthy and (acquired or not required)
    return {
        "ok": ok,
        "process_role": settings.process_role,
        "detail": "ok" if ok else "scheduler_leadership_unhealthy",
        "leadership": {
            "required": required,
            "acquired": acquired,
            "healthy": healthy,
            "failure_reason": getattr(leadership_status, "failure_reason", None),
        },
    }


async def scheduler_healthz(request: Request) -> JSONResponse:
    """Return scheduler liveness, including durable-leadership health."""

    scheduler = cast(TradingScheduler, request.app.state.trading_scheduler)
    payload = scheduler_liveness_payload(scheduler)
    return JSONResponse(status_code=200 if payload["ok"] else 503, content=payload)


async def scheduler_readyz(request: Request) -> JSONResponse:
    """Fail closed until fresh trading and reconciliation cycles have succeeded."""

    scheduler = cast(TradingScheduler, request.app.state.trading_scheduler)
    payload = scheduler_readiness_payload(scheduler)
    return JSONResponse(status_code=200 if payload["ok"] else 503, content=payload)


@asynccontextmanager
async def scheduler_lifespan(app: FastAPI):
    """Own exactly one scheduler lifecycle in the dedicated process."""

    if settings.process_role != "scheduler":
        raise RuntimeError(
            "torghut_scheduler_process_role_mismatch:expected=scheduler:"
            f"actual={settings.process_role}"
        )

    scheduler = TradingScheduler()
    whitepaper_worker = WhitepaperKafkaWorker(session_factory=SessionLocal)
    app.state.trading_scheduler = scheduler
    app.state.whitepaper_worker = whitepaper_worker
    logger.info(
        "Torghut scheduler startup initiated app_env=%s process_role=%s trading_enabled=%s",
        settings.app_env,
        settings.process_role,
        settings.trading_enabled,
    )

    try:
        ensure_schema()
        if settings.trading_autonomy_enabled:
            assert_runtime_gate_policy_contract(
                settings.trading_autonomy_gate_policy_path
            )
        if settings.trading_enabled:
            assert_dspy_cutover_migration_guard()
            await scheduler.start()
        if whitepaper_workflow_enabled():
            await whitepaper_worker.start()

        logger.info(
            "Torghut scheduler startup complete trading_scheduler_started=%s whitepaper_worker_started=%s",
            bool(getattr(scheduler, "_task", None)),
            bool(getattr(whitepaper_worker, "_task", None)),
        )
        yield
    finally:
        logger.info("Torghut scheduler shutdown initiated")
        await whitepaper_worker.stop()
        await scheduler.stop()
        shutdown_posthog_telemetry()
        logger.info("Torghut scheduler shutdown complete")


def create_scheduler_app() -> FastAPI:
    app = FastAPI(title="torghut-scheduler", lifespan=scheduler_lifespan)
    app.state.settings = settings
    app.add_exception_handler(
        SQLAlchemyError,
        cast(ExceptionHandler, sqlalchemy_exception_handler),
    )
    app.add_api_route("/healthz", scheduler_healthz, methods=["GET"])
    app.add_api_route("/scheduler/readyz", scheduler_readyz, methods=["GET"])
    return app


app = build_registered_app(create_scheduler_app(), runtime_role="scheduler")

__all__ = (
    "app",
    "create_scheduler_app",
    "scheduler_lifespan",
    "scheduler_healthz",
    "scheduler_liveness_payload",
    "scheduler_readiness_payload",
    "scheduler_readyz",
)
