"""FastAPI application bootstrap for Torghut."""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, cast

import inngest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from inngest.fast_api import serve as inngest_fastapi_serve
from sqlalchemy.exc import SQLAlchemyError

from .api.build_metadata import BUILD_COMMIT, BUILD_VERSION
from .api.runtime_services import WHITEPAPER_WORKFLOW
from .config import settings
from .db import SessionLocal, ensure_schema
from .observability import capture_posthog_event, shutdown_posthog_telemetry
from .trading.autonomy import assert_runtime_gate_policy_contract
from .trading.autoresearch_routes import router as autoresearch_router
from .trading.hypotheses import validate_hypothesis_registry_from_settings
from .trading.scheduler import TradingScheduler
from .whitepapers import (
    WhitepaperKafkaWorker,
    whitepaper_inngest_enabled,
    whitepaper_semantic_indexing_enabled,
    whitepaper_workflow_enabled,
)

logger = logging.getLogger(__name__)


def _extract_bearer_token(authorization_header: str | None) -> str | None:
    if not authorization_header:
        return None
    prefix = "bearer "
    if not authorization_header.lower().startswith(prefix):
        return None
    token = authorization_header[len(prefix) :].strip()
    return token or None


def _require_whitepaper_control_token(request: Request) -> None:
    expected_token = (
        os.getenv("WHITEPAPER_WORKFLOW_API_TOKEN", "").strip()
        or os.getenv("WHITEPAPER_AGENTRUN_API_TOKEN", "").strip()
        or os.getenv("AGENTS_API_KEY", "").strip()
        or os.getenv("JANGAR_API_KEY", "").strip()
    )
    if not expected_token:
        return

    provided_token = _extract_bearer_token(request.headers.get("authorization")) or (
        request.headers.get("x-whitepaper-token", "").strip() or None
    )
    if provided_token != expected_token:
        raise HTTPException(status_code=401, detail="whitepaper_control_auth_required")


def _env_or_none(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def _env_csv(name: str) -> tuple[str, ...]:
    raw_value = os.getenv(name, "")
    return tuple(item.strip() for item in raw_value.split(",") if item.strip())


def _env_json_string_list(name: str) -> tuple[str, ...]:
    raw_value = os.getenv(name, "").strip()
    if not raw_value:
        return ()
    try:
        decoded = json.loads(raw_value)
    except json.JSONDecodeError:
        return (raw_value,)
    if not isinstance(decoded, list):
        return ()
    decoded_items = cast(list[object], decoded)
    return tuple(item for raw_item in decoded_items if (item := str(raw_item).strip()))


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


def _register_whitepaper_inngest_routes(app: FastAPI) -> inngest.Inngest | None:
    if not whitepaper_workflow_enabled() or not whitepaper_inngest_enabled():
        app.state.whitepaper_inngest_registered = False
        WHITEPAPER_WORKFLOW.set_inngest_client(None)
        return None

    app_id = _env_or_none("INNGEST_APP_ID") or "torghut"
    try:
        client = inngest.Inngest(
            app_id=app_id,
            api_base_url=_env_or_none("INNGEST_BASE_URL"),
            event_api_base_url=_env_or_none("INNGEST_EVENT_API_BASE_URL"),
            event_key=_env_or_none("INNGEST_EVENT_KEY"),
            signing_key=_env_or_none("INNGEST_SIGNING_KEY"),
        )
    except Exception as exc:  # pragma: no cover - configuration/runtime dependent
        logger.warning(
            "Failed to initialize Inngest client for whitepaper workflow: %s", exc
        )
        app.state.whitepaper_inngest_registered = False
        WHITEPAPER_WORKFLOW.set_inngest_client(None)
        return None

    requested_event_name = (
        _env_or_none("WHITEPAPER_INNGEST_EVENT_NAME")
        or "torghut/whitepaper.analysis.requested"
    )
    requested_fn_id = (
        _env_or_none("WHITEPAPER_INNGEST_FUNCTION_ID")
        or "torghut-whitepaper-analysis-v1"
    )
    finalized_event_name = (
        _env_or_none("WHITEPAPER_INNGEST_FINALIZED_EVENT_NAME")
        or "torghut/whitepaper.analysis.finalized"
    )
    finalized_fn_id = (
        _env_or_none("WHITEPAPER_INNGEST_FINALIZE_FUNCTION_ID")
        or "torghut-whitepaper-synthesis-index-v1"
    )

    @client.create_function(
        fn_id=requested_fn_id,
        idempotency="event.data.enqueue_key",
        trigger=inngest.TriggerEvent(event=requested_event_name),
    )
    def _whitepaper_requested_fn(ctx: inngest.ContextSync) -> dict[str, Any]:
        run_id = str(ctx.event.data.get("run_id") or "").strip()
        if not run_id:
            raise ValueError("run_id_required")
        with SessionLocal() as session:
            try:
                result = WHITEPAPER_WORKFLOW.process_requested_run(
                    session,
                    run_id=run_id,
                    inngest_function_id=requested_fn_id,
                    inngest_run_id=ctx.run_id,
                )
                session.commit()
                return result
            except Exception:
                session.rollback()
                logger.exception(
                    "Inngest requested whitepaper run failed for run_id=%s", run_id
                )
                raise

    @client.create_function(
        fn_id=finalized_fn_id,
        idempotency="event.data.run_id",
        trigger=inngest.TriggerEvent(event=finalized_event_name),
    )
    def _whitepaper_finalized_fn(ctx: inngest.ContextSync) -> dict[str, Any]:
        run_id = str(ctx.event.data.get("run_id") or "").strip()
        if not run_id:
            raise ValueError("run_id_required")
        if not whitepaper_semantic_indexing_enabled():
            return {
                "run_id": run_id,
                "skipped": True,
                "reason": "semantic_indexing_disabled",
            }
        with SessionLocal() as session:
            try:
                result = WHITEPAPER_WORKFLOW.index_synthesis_semantic_content(
                    session,
                    run_id=run_id,
                )
                session.commit()
                return result
            except Exception:
                session.rollback()
                logger.exception(
                    "Inngest finalized whitepaper indexing failed for run_id=%s", run_id
                )
                raise

    try:
        inngest_fastapi_serve(
            app,
            client,
            [_whitepaper_requested_fn, _whitepaper_finalized_fn],
            serve_path="/api/inngest",
        )
    except Exception as exc:  # pragma: no cover - registration/runtime dependent
        logger.warning("Failed to register whitepaper Inngest FastAPI routes: %s", exc)
        app.state.whitepaper_inngest_registered = False
        WHITEPAPER_WORKFLOW.set_inngest_client(None)
        return None

    app.state.whitepaper_inngest_registered = True
    WHITEPAPER_WORKFLOW.set_inngest_client(client)
    logger.info(
        "Registered whitepaper Inngest routes app_id=%s requested_fn_id=%s finalized_fn_id=%s",
        app_id,
        requested_fn_id,
        finalized_fn_id,
    )
    return client


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
        validate_hypothesis_registry_from_settings()
        await scheduler.start()
    if whitepaper_workflow_enabled():
        await whitepaper_worker.start()

    logger.info(
        "Torghut startup complete trading_scheduler_started=%s whitepaper_worker_started=%s inngest_registered=%s",
        bool(getattr(scheduler, "_task", None)),
        bool(getattr(whitepaper_worker, "_task", None)),
        bool(getattr(app.state, "whitepaper_inngest_registered", False)),
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
    app.state.whitepaper_inngest_registered = False
    app.include_router(autoresearch_router)
    app.add_exception_handler(SQLAlchemyError, cast(Any, sqlalchemy_exception_handler))
    app.add_api_route("/healthz", healthz, methods=["GET"])
    return app


assert_dspy_cutover_migration_guard = _assert_dspy_cutover_migration_guard
env_csv = _env_csv
env_json_string_list = _env_json_string_list
evaluate_scheduler_status = _evaluate_scheduler_status
register_whitepaper_inngest_routes = _register_whitepaper_inngest_routes
require_whitepaper_control_token = _require_whitepaper_control_token


__all__ = [
    "_assert_dspy_cutover_migration_guard",
    "_env_csv",
    "_env_json_string_list",
    "_env_or_none",
    "_evaluate_scheduler_status",
    "_extract_bearer_token",
    "_register_whitepaper_inngest_routes",
    "_require_whitepaper_control_token",
    "assert_dspy_cutover_migration_guard",
    "create_app",
    "env_csv",
    "env_json_string_list",
    "evaluate_scheduler_status",
    "healthz",
    "lifespan",
    "register_whitepaper_inngest_routes",
    "require_whitepaper_control_token",
    "sqlalchemy_exception_handler",
]
