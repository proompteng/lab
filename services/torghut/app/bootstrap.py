"""FastAPI application bootstrap for Torghut."""

from __future__ import annotations

import asyncio
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
from .trading.scheduler.leadership import (
    DEFAULT_SCHEDULER_ADVISORY_LOCK_NAME,
    SchedulerLeadershipError,
)
from .whitepapers import WhitepaperKafkaWorker, whitepaper_workflow_enabled

logger = logging.getLogger(__name__)

_MAIN_PROCESS_ROLES = frozenset({"api", "simulation"})


def _assert_main_process_role_contract() -> bool:
    """Return whether this main process owns an isolated embedded scheduler."""

    process_role = settings.process_role
    if process_role not in _MAIN_PROCESS_ROLES:
        raise RuntimeError(
            "torghut_api_process_role_mismatch:expected=api|simulation:"
            f"actual={process_role}"
        )
    if process_role != "simulation":
        return False
    if settings.trading_mode != "paper":
        raise RuntimeError(
            "torghut_simulation_process_mode_mismatch:expected=paper:"
            f"actual={settings.trading_mode}"
        )
    if settings.trading_enabled and not settings.trading_scheduler_leadership_required:
        raise RuntimeError("torghut_simulation_scheduler_leadership_required")
    if (
        settings.trading_enabled
        and settings.trading_scheduler_leadership_lock_name
        == DEFAULT_SCHEDULER_ADVISORY_LOCK_NAME
    ):
        raise RuntimeError("torghut_simulation_scheduler_lock_must_be_isolated")
    return True


async def _supervise_embedded_scheduler(scheduler: TradingScheduler) -> None:
    """Retry only expected leadership contention during a Knative handoff."""

    retry_seconds = settings.trading_scheduler_leadership_check_seconds
    while True:
        try:
            await scheduler.start()
            return
        except SchedulerLeadershipError as exc:
            logger.info(
                "Simulation scheduler standing by for writer leadership retry_seconds=%s error=%s",
                retry_seconds,
                exc,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive supervisor boundary
            scheduler.state.last_error = (
                f"scheduler_startup_supervisor_failed:{type(exc).__name__}"
            )
            logger.exception(
                "Simulation scheduler supervisor stopped after non-retryable startup failure"
            )
            return
        await asyncio.sleep(retry_seconds)


async def _stop_embedded_scheduler_supervisor(
    supervisor: asyncio.Task[None] | None,
) -> None:
    if supervisor is None:
        return
    if not supervisor.done():
        supervisor.cancel()
    try:
        await supervisor
    except asyncio.CancelledError:
        pass


def _evaluate_scheduler_status(
    scheduler: TradingScheduler,
) -> tuple[bool, dict[str, object]]:
    if settings.process_role == "api":
        return True, {
            "ok": True,
            "detail": "external_scheduler",
            "running": False,
            "owner": "torghut-scheduler",
        }

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

    owns_embedded_scheduler = _assert_main_process_role_contract()

    scheduler = TradingScheduler()
    whitepaper_worker = (
        WhitepaperKafkaWorker(session_factory=SessionLocal)
        if owns_embedded_scheduler
        else None
    )
    app.state.trading_scheduler = scheduler
    if whitepaper_worker is not None:
        app.state.whitepaper_worker = whitepaper_worker
    scheduler_supervisor: asyncio.Task[None] | None = None
    logger.info(
        "Torghut startup initiated build_version=%s build_commit=%s app_env=%s process_role=%s log_level=%s log_format=%s trading_enabled=%s background_worker_owner=%s",
        BUILD_VERSION,
        BUILD_COMMIT,
        settings.app_env,
        settings.process_role,
        settings.log_level,
        settings.log_format,
        settings.trading_enabled,
        "local" if owns_embedded_scheduler else "external",
    )

    try:
        if owns_embedded_scheduler:
            ensure_schema()
            if settings.trading_autonomy_enabled:
                assert_runtime_gate_policy_contract(
                    settings.trading_autonomy_gate_policy_path
                )
            if settings.trading_enabled:
                _assert_dspy_cutover_migration_guard()
                scheduler_supervisor = asyncio.create_task(
                    _supervise_embedded_scheduler(scheduler),
                    name="torghut-simulation-scheduler-supervisor",
                )
                app.state.trading_scheduler_supervisor = scheduler_supervisor
            if whitepaper_worker is not None and whitepaper_workflow_enabled():
                await whitepaper_worker.start()
        else:
            try:
                ensure_schema()
            except SQLAlchemyError as exc:  # pragma: no cover - startup defense only
                logger.warning("Database not reachable during startup: %s", exc)

        logger.info(
            "Torghut startup complete trading_scheduler_started=%s whitepaper_worker_started=%s background_worker_owner=%s",
            bool(getattr(scheduler, "_task", None)),
            bool(
                whitepaper_worker is not None
                and getattr(whitepaper_worker, "_task", None)
            ),
            "local" if owns_embedded_scheduler else "external",
        )
        yield
    finally:
        logger.info("Torghut shutdown initiated")
        await _stop_embedded_scheduler_supervisor(scheduler_supervisor)
        if whitepaper_worker is not None:
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
    "_assert_main_process_role_contract",
    "_stop_embedded_scheduler_supervisor",
    "_supervise_embedded_scheduler",
    "_evaluate_scheduler_status",
    "assert_dspy_cutover_migration_guard",
    "create_app",
    "evaluate_scheduler_status",
    "healthz",
    "lifespan",
    "sqlalchemy_exception_handler",
]
