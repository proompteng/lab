"""FastAPI application bootstrap for Torghut."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from .api.build_metadata import BUILD_COMMIT, BUILD_VERSION
from .config import settings
from .db import SessionLocal, ensure_schema
from .observability import capture_posthog_event, shutdown_posthog_telemetry
from .trading.autonomy import assert_runtime_gate_policy_contract
from .trading.scheduler import TradingScheduler
from .whitepapers import (
    WhitepaperKafkaWorker,
    whitepaper_workflow_enabled,
)

logger = logging.getLogger(__name__)


def _evaluate_scheduler_status(
    scheduler: TradingScheduler,
) -> tuple[bool, dict[str, object]]:
    scheduler_ok = True
    scheduler_detail = "ok"

    startup_grace_seconds = max(0, settings.trading_startup_readiness_grace_seconds)
    in_startup_grace = False
    scheduler_state = scheduler.state
    startup_started_at = getattr(scheduler_state, "startup_started_at", None)
    scheduler_running = bool(getattr(scheduler_state, "running", False))
    scheduler_last_run_at = getattr(scheduler_state, "last_run_at", None)
    if settings.trading_enabled and not scheduler_running:
        if (
            startup_started_at is not None
            and startup_grace_seconds > 0
            and datetime.now(timezone.utc) - startup_started_at
            <= timedelta(seconds=startup_grace_seconds)
        ):
            in_startup_grace = True
            scheduler_ok = True
            scheduler_detail = f"trading loop starting (within {startup_grace_seconds}s readiness grace)"
        else:
            scheduler_ok = False
            scheduler_detail = (
                "trading loop not started"
                if scheduler_last_run_at is None
                else "trading loop not running"
            )

    scheduler_payload: dict[str, object] = {
        "ok": scheduler_ok,
        "detail": scheduler_detail,
        "running": scheduler_running,
    }
    if startup_started_at is not None:
        scheduler_payload["startup_started_at"] = startup_started_at.isoformat()
        scheduler_payload["startup_readiness_grace_seconds"] = startup_grace_seconds
        scheduler_payload["startup_readiness_grace_active"] = in_startup_grace

    return scheduler_ok, scheduler_payload


def _assert_dspy_cutover_migration_guard() -> None:
    allowed, reasons = settings.llm_dspy_cutover_migration_guard()
    if allowed:
        return
    reason_summary = "|".join(reasons) if reasons else "unknown"
    raise RuntimeError(f"dspy_cutover_migration_guard_failed:{reason_summary}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup/shutdown tasks using FastAPI lifespan hooks."""

    scheduler = TradingScheduler()
    whitepaper_worker = WhitepaperKafkaWorker(session_factory=SessionLocal)
    app.state.trading_scheduler = scheduler
    app.state.whitepaper_worker = whitepaper_worker
    logger.info(
        "Torghut startup initiated build_version=%s build_commit=%s app_env=%s log_level=%s log_format=%s trading_enabled=%s whitepaper_workflow_enabled=%s",
        BUILD_VERSION,
        BUILD_COMMIT,
        settings.app_env,
        settings.log_level,
        settings.log_format,
        settings.trading_enabled,
        whitepaper_workflow_enabled(),
    )

    try:
        ensure_schema()
    except SQLAlchemyError as exc:  # pragma: no cover - defensive for startup only
        logger.warning("Database not reachable during startup: %s", exc)

    if settings.trading_autonomy_enabled:
        assert_runtime_gate_policy_contract(settings.trading_autonomy_gate_policy_path)

    if settings.trading_enabled:
        _assert_dspy_cutover_migration_guard()
        await scheduler.start()
    if whitepaper_workflow_enabled():
        await whitepaper_worker.start()

    logger.info(
        "Torghut startup complete trading_scheduler_started=%s whitepaper_worker_started=%s",
        bool(getattr(scheduler, "_task", None)),
        bool(getattr(whitepaper_worker, "_task", None)),
    )

    yield

    logger.info("Torghut shutdown initiated")
    await whitepaper_worker.stop()
    await scheduler.stop()
    shutdown_posthog_telemetry()
    logger.info("Torghut shutdown complete")


def sqlalchemy_exception_handler(
    _request: Request,
    exc: SQLAlchemyError,
) -> JSONResponse:
    """Convert unhandled DB exceptions into explicit service-unavailable responses."""

    message = str(getattr(exc, "orig", exc)).lower()
    if "undefinedcolumn" in message or (
        "column" in message and "does not exist" in message
    ):
        detail = "database schema mismatch; migrations pending"
    else:
        detail = "database unavailable"
    capture_posthog_event(
        "torghut.runtime.db_exception",
        severity="error",
        properties={
            "loop": "http",
            "error_class": type(exc).__name__,
            "detail": detail,
        },
    )
    logger.error("Unhandled database exception: %s", exc)
    return JSONResponse(status_code=503, content={"detail": detail})


async def healthz() -> dict[str, str]:
    """Liveness endpoint for Kubernetes/Knative probes."""

    return {"status": "ok", "service": "torghut"}


def create_app() -> FastAPI:
    app = FastAPI(title="torghut", lifespan=lifespan)
    app.state.settings = settings
    app.add_exception_handler(SQLAlchemyError, cast(Any, sqlalchemy_exception_handler))
    app.add_api_route("/healthz", healthz, methods=["GET"])
    return app


assert_dspy_cutover_migration_guard = _assert_dspy_cutover_migration_guard
evaluate_scheduler_status = _evaluate_scheduler_status


__all__ = [
    "_assert_dspy_cutover_migration_guard",
    "_evaluate_scheduler_status",
    "assert_dspy_cutover_migration_guard",
    "create_app",
    "evaluate_scheduler_status",
    "healthz",
    "lifespan",
    "sqlalchemy_exception_handler",
]
