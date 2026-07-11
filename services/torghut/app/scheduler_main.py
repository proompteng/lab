"""Dedicated Torghut trading scheduler process entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
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


def scheduler_readiness_payload(scheduler: TradingScheduler) -> dict[str, object]:
    """Return a process-local scheduler readiness snapshot."""

    state = scheduler.state
    running = bool(getattr(state, "running", False))
    last_run_at = getattr(state, "last_run_at", None)
    last_error = getattr(state, "last_error", None)
    ready = running and last_run_at is not None and last_error is None
    payload: dict[str, object] = {
        "ok": ready,
        "process_role": settings.process_role,
        "running": running,
        "detail": "ok" if ready else "scheduler_not_ready",
    }
    if last_run_at is not None:
        payload["last_run_at"] = last_run_at.isoformat()
    if last_error is not None:
        payload["last_error"] = str(last_error)
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
    """Fail closed until the scheduler is running and has completed one cycle."""

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
