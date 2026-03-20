"""torghut FastAPI application entrypoint."""

import json
import logging
import os
import time
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from threading import Lock
from typing import Any, cast
from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
import inngest
from inngest.fast_api import serve as inngest_fastapi_serve
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from urllib.parse import urlencode, urlsplit

from .alpaca_client import TorghutAlpacaClient
from .config import settings
from .db import SessionLocal, check_schema_current, ensure_schema, get_session, ping
from .db import check_account_scope_invariants
from .metrics import render_trading_metrics
from .models import (
    Execution,
    ExecutionTCAMetric,
    Strategy,
    TradeDecision,
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
    WhitepaperEngineeringTrigger,
    WhitepaperRolloutTransition,
)
from .observability import capture_posthog_event, shutdown_posthog_telemetry
from .trading import TradingScheduler
from .trading.autonomy import (
    assert_runtime_gate_policy_contract,
    evaluate_evidence_continuity,
)
from .trading.completion import build_doc29_completion_status
from .trading.empirical_jobs import build_empirical_jobs_status
from .trading.hypotheses import (
    JangarDependencyQuorumStatus,
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
    validate_hypothesis_registry_from_settings,
)
from .trading.lean_lanes import LeanLaneManager
from .trading.llm.evaluation import build_llm_evaluation_metrics
from .trading.submission_council import (
    build_live_submission_gate_payload,
    build_shadow_first_toggle_parity,
    load_quant_evidence_status,
    resolve_active_capital_stage,
)
from .trading.tca import build_tca_gate_inputs
from .trading.simulation_progress import active_simulation_runtime_context, simulation_progress_snapshot
from .trading.time_source import trading_time_status
from .whitepapers import (
    WhitepaperKafkaWorker,
    WhitepaperWorkflowService,
    whitepaper_inngest_enabled,
    whitepaper_kafka_enabled,
    whitepaper_semantic_indexing_enabled,
    whitepaper_workflow_enabled,
)

logger = logging.getLogger(__name__)

BUILD_VERSION = os.getenv("TORGHUT_VERSION", "dev")
BUILD_COMMIT = os.getenv("TORGHUT_COMMIT", "unknown")
BUILD_IMAGE_DIGEST = os.getenv("TORGHUT_IMAGE_DIGEST", "").strip() or None
RUNTIME_PROFITABILITY_LOOKBACK_HOURS = 72
RUNTIME_PROFITABILITY_SCHEMA_VERSION = "torghut.runtime-profitability.v1"
LEAN_LANE_MANAGER = LeanLaneManager()
WHITEPAPER_WORKFLOW = WhitepaperWorkflowService()
_TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = Lock()
_TRADING_DEPENDENCY_HEALTH_CACHE: dict[str, dict[str, object]] = {}
_ALPACA_HEALTH_CACHE_LOCK = Lock()
_ALPACA_HEALTH_STATE: dict[str, object] = {}


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


app = FastAPI(title="torghut", lifespan=lifespan)
app.state.settings = settings
app.state.whitepaper_inngest_registered = False
_register_whitepaper_inngest_routes(app)


@app.exception_handler(SQLAlchemyError)
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


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness endpoint for Kubernetes/Knative probes."""

    return {"status": "ok", "service": "torghut"}


def _readiness_dependency_cache_key(include_database_contract: bool) -> str:
    trading_mode = int(settings.trading_enabled)
    cache_mode = int(settings.trading_readiness_dependency_cache_enabled)
    return f"readyz:{trading_mode}:{cache_mode}:{int(include_database_contract)}"


def _readiness_dependency_checks(
    session: Session,
    *,
    include_database_contract: bool,
) -> tuple[dict[str, object], datetime]:
    postgres_status = _check_postgres(session)
    if settings.trading_enabled:
        clickhouse_status = _check_clickhouse()
        alpaca_status = _check_alpaca()
    else:
        clickhouse_status = {"ok": True, "detail": "skipped (trading disabled)"}
        alpaca_status = {"ok": True, "detail": "skipped (trading disabled)"}

    dependencies: dict[str, object] = {
        "postgres": postgres_status,
        "clickhouse": clickhouse_status,
        "alpaca": alpaca_status,
    }

    if include_database_contract:
        database_contract = _evaluate_database_contract(session)
        lineage_errors = cast(
            list[str],
            database_contract.get("schema_graph_lineage_errors", []),
        )
        detail = "ok" if bool(database_contract.get("ok")) else "database contract failed"
        if lineage_errors:
            detail = lineage_errors[0]
        dependencies["database"] = {
            "ok": bool(database_contract.get("ok")),
            "detail": detail,
            "schema_current": bool(database_contract.get("schema_current")),
            "schema_current_heads": database_contract.get("schema_current_heads"),
            "expected_heads": database_contract.get("expected_heads"),
            "schema_missing_heads": database_contract.get(
                "schema_missing_heads",
                [],
            ),
            "schema_unexpected_heads": database_contract.get(
                "schema_unexpected_heads",
                [],
            ),
            "schema_head_count_expected": database_contract.get(
                "schema_head_count_expected",
            ),
            "schema_head_count_current": database_contract.get(
                "schema_head_count_current",
            ),
            "schema_head_delta_count": database_contract.get(
                "schema_head_delta_count",
            ),
            "schema_head_signature": database_contract.get("schema_head_signature"),
            "schema_graph_signature": database_contract.get("schema_graph_signature"),
            "schema_graph_roots": database_contract.get("schema_graph_roots", []),
            "schema_graph_branch_count": database_contract.get(
                "schema_graph_branch_count",
            ),
            "schema_graph_branch_tolerance": database_contract.get(
                "schema_graph_branch_tolerance",
            ),
            "schema_graph_allow_divergence_roots": database_contract.get(
                "schema_graph_allow_divergence_roots",
            ),
            "schema_graph_parent_forks": database_contract.get(
                "schema_graph_parent_forks",
                {},
            ),
            "schema_graph_duplicate_revisions": database_contract.get(
                "schema_graph_duplicate_revisions",
                {},
            ),
            "schema_graph_orphan_parents": database_contract.get(
                "schema_graph_orphan_parents",
                [],
            ),
            "schema_graph_lineage_ready": database_contract.get(
                "schema_graph_lineage_ready",
            ),
            "schema_graph_lineage_errors": lineage_errors,
            "schema_graph_lineage_warnings": database_contract.get(
                "schema_graph_lineage_warnings",
                [],
            ),
            "checked_at": database_contract.get("checked_at"),
            "account_scope_ready": bool(database_contract.get("account_scope_ready")),
            "account_scope_errors": database_contract.get("account_scope_errors", []),
            "account_scope_warnings": database_contract.get(
                "account_scope_warnings",
                [],
            ),
        }

    return dependencies, datetime.now(timezone.utc)


def _readiness_dependency_snapshot(
    session: Session,
    *,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], datetime, bool]:
    if (
        not settings.trading_readiness_dependency_cache_enabled
        or settings.trading_readiness_dependency_cache_ttl_seconds <= 0
    ):
        dependencies, checked_at = _readiness_dependency_checks(
            session,
            include_database_contract=include_database_contract,
        )
        return dependencies, checked_at, False

    cache_ttl = timedelta(
        seconds=settings.trading_readiness_dependency_cache_ttl_seconds
    )
    stale_tolerance = max(
        0,
        int(settings.trading_readiness_dependency_cache_stale_tolerance_seconds),
    )
    now = datetime.now(timezone.utc)
    cache_key = _readiness_dependency_cache_key(include_database_contract)

    with _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK:
        cache_entry = _TRADING_DEPENDENCY_HEALTH_CACHE.get(cache_key)
        if cache_entry:
            cache_checked_at = cast(datetime, cache_entry["checked_at"])
            cache_age = now - cache_checked_at
            if cache_age < cache_ttl:
                return (
                    cast(dict[str, object], cache_entry["dependencies"]),
                    cache_checked_at,
                    True,
                )
            if (
                allow_stale_dependency_cache
                and stale_tolerance > 0
                and cache_age <= cache_ttl + timedelta(seconds=stale_tolerance)
            ):
                return (
                    cast(dict[str, object], cache_entry["dependencies"]),
                    cache_checked_at,
                    True,
                )

    dependencies, checked_at = _readiness_dependency_checks(
        session,
        include_database_contract=include_database_contract,
    )
    with _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK:
        _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key] = {
            "checked_at": checked_at,
            "dependencies": dependencies,
        }
    return dependencies, checked_at, False


def _evaluate_trading_health_payload(
    session: Session,
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    """Build shared trading health payload and status code."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler

    scheduler_ok = True
    scheduler_detail = "ok"

    startup_grace_seconds = max(0, settings.trading_startup_readiness_grace_seconds)
    in_startup_grace = False
    startup_started_at = scheduler.state.startup_started_at
    if settings.trading_enabled and not scheduler.state.running:
        if (
            startup_started_at is not None
            and startup_grace_seconds > 0
            and datetime.now(timezone.utc) - startup_started_at
            <= timedelta(seconds=startup_grace_seconds)
        ):
            in_startup_grace = True
            scheduler_ok = True
            scheduler_detail = (
                f"trading loop starting (within {startup_grace_seconds}s readiness grace)"
            )
        else:
            scheduler_ok = False
            scheduler_detail = (
                "trading loop not started"
                if scheduler.state.last_run_at is None
                else "trading loop not running"
            )

    scheduler_payload: dict[str, object] = {
        "ok": scheduler_ok,
        "detail": scheduler_detail,
        "running": scheduler.state.running,
    }
    if startup_started_at is not None:
        scheduler_payload["startup_started_at"] = startup_started_at.isoformat()
        scheduler_payload["startup_readiness_grace_seconds"] = startup_grace_seconds
        scheduler_payload["startup_readiness_grace_active"] = in_startup_grace

    now = datetime.now(timezone.utc)
    dependencies, checked_at, cache_used = _readiness_dependency_snapshot(
        session,
        include_database_contract=include_database_contract,
        allow_stale_dependency_cache=allow_stale_dependency_cache,
    )
    dependencies = dict(dependencies)
    dependencies["universe"] = _evaluate_universe_dependency(scheduler)
    cache_age_seconds = (
        (now - checked_at).total_seconds() if checked_at else 0.0
    )
    cache_age_seconds = (
        0.0 if cache_age_seconds < 0 else round(cache_age_seconds, 3)
    )
    cache_stale = (
        cache_used
        and cache_age_seconds
        > settings.trading_readiness_dependency_cache_ttl_seconds
    )
    dependencies["readiness_cache"] = {
        "checked_at": checked_at.isoformat(),
        "cache_ttl_seconds": settings.trading_readiness_dependency_cache_ttl_seconds,
        "cache_stale_tolerance_seconds": settings.trading_readiness_dependency_cache_stale_tolerance_seconds,
        "cache_used": cache_used,
        "cache_age_seconds": cache_age_seconds,
        "cache_stale": cache_stale,
    }

    alpha_readiness: dict[str, object]
    _hypothesis_payload: Mapping[str, object] = {}
    try:
        _hypothesis_payload, hypothesis_summary, _dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=_load_tca_summary(session),
                market_context_status=scheduler.market_context_status(),
            )
        )
        alpha_readiness = {
            "hypotheses_total": hypothesis_summary.get("hypotheses_total", 0),
            "state_totals": hypothesis_summary.get("state_totals", {}),
            "promotion_eligible_total": hypothesis_summary.get(
                "promotion_eligible_total", 0
            ),
            "rollback_required_total": hypothesis_summary.get(
                "rollback_required_total", 0
            ),
            "dependency_quorum": hypothesis_summary.get("dependency_quorum", {}),
        }
    except Exception as exc:  # pragma: no cover - additive status surface only
        alpha_readiness = {
            "hypotheses_total": 0,
            "state_totals": {},
            "promotion_eligible_total": 0,
            "rollback_required_total": 0,
            "dependency_quorum": {
                "decision": "unknown",
                "reasons": ["alpha_readiness_unavailable"],
                "message": str(exc),
            },
        }
        hypothesis_summary = {}

    llm_status = scheduler.llm_status()
    dspy_runtime = (
        cast(dict[str, object], llm_status.get("dspy_runtime"))
        if isinstance(llm_status.get("dspy_runtime"), dict)
        else {}
    )
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    live_submission_gate = _build_live_submission_gate_payload(
        scheduler.state,
        session=session,
        hypothesis_summary=_hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        dspy_runtime_status=dspy_runtime,
        quant_health_status=quant_evidence,
    )
    live_mode = settings.trading_mode == "live"
    dependencies["empirical_jobs"] = {
        "ok": bool(empirical_jobs.get("ready")) if live_mode else True,
        "detail": (
            str(empirical_jobs.get("status") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "authority": empirical_jobs.get("authority"),
    }
    dependencies["dspy_runtime"] = {
        "ok": bool(dspy_runtime.get("live_ready", False))
        if str(dspy_runtime.get("mode") or "").strip().lower() == "active"
        else True,
        "detail": (
            "ready"
            if bool(dspy_runtime.get("live_ready", False))
            else ", ".join(
                [
                    str(item).strip()
                    for item in cast(list[object], dspy_runtime.get("readiness_reasons") or [])
                    if str(item).strip()
                ]
            )
            or "not_ready"
        ),
        "artifact_hash": dspy_runtime.get("artifact_hash"),
    }
    dependencies["live_submission_gate"] = {
        "ok": bool(live_submission_gate.get("allowed", False)),
        "detail": str(live_submission_gate.get("reason") or "unknown"),
        "capital_stage": live_submission_gate.get("capital_stage"),
    }
    dependencies["quant_evidence"] = {
        "ok": (
            bool(quant_evidence.get("ok", True))
            if live_mode and bool(quant_evidence.get("required", False))
            else True
        ),
        "detail": (
            str(quant_evidence.get("reason") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "required": bool(quant_evidence.get("required", False)),
        "window": quant_evidence.get("window"),
    }
    dependency_statuses = [
        cast(dict[str, object], checks).get("ok", True)
        for name, checks in dependencies.items()
        if name != "readiness_cache"
    ]

    overall_ok = scheduler_ok and all(bool(dep) for dep in dependency_statuses)
    status = "ok" if overall_ok else "degraded"
    status_code = 200 if overall_ok else 503

    return (
        {
            "status": status,
            "scheduler": scheduler_payload,
            "dependencies": dependencies,
            "alpha_readiness": alpha_readiness,
            "live_submission_gate": live_submission_gate,
            "quant_evidence": quant_evidence,
        },
        status_code,
    )


def _evaluate_universe_dependency(
    scheduler: TradingScheduler | None,
) -> dict[str, object]:
    if scheduler is None or settings.trading_universe_source != "jangar":
        return {
            "ok": True,
            "detail": "skipped",
            "source": settings.trading_universe_source,
            "status": None,
            "reason": None,
            "symbols_count": None,
            "cache_age_seconds": None,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    state = getattr(scheduler, "state", None)
    if state is None:
        return {
            "ok": True,
            "detail": "universe state unavailable",
            "source": settings.trading_universe_source,
            "status": None,
            "reason": None,
            "symbols_count": None,
            "cache_age_seconds": None,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    universe_status = getattr(state, "universe_source_status", None)
    universe_reason = getattr(state, "universe_source_reason", None)
    universe_symbols_count = getattr(state, "universe_symbols_count", None)
    universe_cache_age_seconds = getattr(state, "universe_cache_age_seconds", None)
    universe_fail_safe_blocked = bool(
        getattr(state, "universe_fail_safe_blocked", False)
    )
    max_stale_seconds = max(1, settings.trading_universe_max_stale_seconds)

    if universe_status == "error":
        return {
            "ok": False,
            "detail": "jangar universe unavailable",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    if universe_status == "empty" and universe_fail_safe_blocked:
        return {
            "ok": False,
            "detail": "jangar universe empty",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    if universe_status == "degraded":
        degraded_detail = "jangar stale cache in use"
        if isinstance(universe_reason, str) and "static_fallback" in universe_reason:
            degraded_detail = "jangar static fallback in use"
        return {
            "ok": not universe_fail_safe_blocked,
            "detail": degraded_detail,
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    if universe_status == "ok":
        return {
            "ok": True,
            "detail": "jangar universe fresh",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    if universe_status in {"unknown", "not_evaluated", None}:
        return {
            "ok": True,
            "detail": "universe not yet evaluated",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    if universe_fail_safe_blocked:
        return {
            "ok": False,
            "detail": f"jangar universe blocked: {universe_reason}",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": settings.trading_universe_require_non_empty_jangar,
        }

    return {
        "ok": True,
        "detail": "jangar universe ok",
        "source": settings.trading_universe_source,
        "status": universe_status,
        "reason": universe_reason,
        "symbols_count": universe_symbols_count,
        "cache_age_seconds": universe_cache_age_seconds,
        "max_stale_seconds": max_stale_seconds,
        "require_non_empty": settings.trading_universe_require_non_empty_jangar,
    }


def _evaluate_database_contract(session: Session) -> dict[str, object]:
    """Collect schema and account-scope readiness checks used by /readyz and /db-check."""
    checked_at = datetime.now(timezone.utc).isoformat()

    try:
        schema_status = check_schema_current(session)
        account_scope_status = check_account_scope_invariants(session)
    except SQLAlchemyError as exc:
        return {
            "ok": False,
            "error": f"database unavailable: {exc}",
            "schema_current": False,
            "schema_current_heads": [],
            "expected_heads": [],
            "schema_head_signature": None,
            "checked_at": checked_at,
            "account_scope_ready": False,
            "account_scope_errors": [str(exc)],
        }
    except RuntimeError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "schema_current": False,
            "schema_current_heads": [],
            "expected_heads": [],
            "schema_head_signature": None,
            "checked_at": checked_at,
            "account_scope_ready": False,
            "account_scope_errors": [str(exc)],
        }

    account_scope_checks = dict(account_scope_status)
    account_scope_warnings: list[str] = []
    if not settings.trading_multi_account_enabled:
        account_scope_checks["account_scope_ready"] = True
        account_scope_checks["account_scope_errors"] = []
        account_scope_warnings.append(
            "account scope checks are bypassed when trading_multi_account_enabled is false"
        )

    schema_current = bool(schema_status.get("schema_current"))
    account_scope_ready = bool(account_scope_checks.get("account_scope_ready"))
    schema_graph_roots = [
        str(root)
        for root in cast(list[object], schema_status.get("schema_graph_roots", []))
    ]
    schema_graph_parent_forks = {
        str(parent): sorted(str(child) for child in cast(list[object], children))
        for parent, children in cast(
            Mapping[object, object],
            schema_status.get("schema_graph_parent_forks", {}),
        ).items()
        if isinstance(children, list)
    }
    schema_graph_duplicate_revisions = {
        str(revision): sorted(str(path) for path in cast(list[object], files))
        for revision, files in cast(
            Mapping[object, object],
            schema_status.get("schema_graph_duplicate_revisions", {}),
        ).items()
        if isinstance(files, list)
    }
    schema_graph_orphan_parents = [
        str(parent)
        for parent in cast(
            list[object],
            schema_status.get("schema_graph_orphan_parents", []),
        )
    ]
    schema_graph_branch_tolerance = max(
        0,
        int(settings.trading_db_schema_graph_branch_tolerance),
    )
    schema_graph_allow_divergence_roots = bool(
        settings.trading_db_schema_graph_allow_divergence_roots,
    )

    raw_branch_count = schema_status.get("schema_graph_branch_count")
    schema_graph_branch_count: int
    if isinstance(raw_branch_count, bool):
        schema_graph_branch_count = int(raw_branch_count)
    elif isinstance(raw_branch_count, int):
        schema_graph_branch_count = raw_branch_count
    elif isinstance(raw_branch_count, str):
        try:
            schema_graph_branch_count = int(raw_branch_count)
        except ValueError:
            schema_graph_branch_count = 0
    else:
        schema_graph_branch_count = 0

    schema_graph_lineage_errors: list[str] = []
    schema_graph_lineage_warnings: list[str] = []

    if schema_graph_duplicate_revisions:
        duplicate_summary = ", ".join(sorted(schema_graph_duplicate_revisions))
        schema_graph_lineage_errors.append(
            f"duplicate migration revision identifiers detected: {duplicate_summary}"
        )

    if schema_graph_orphan_parents:
        schema_graph_lineage_errors.append(
            "orphan migration parents detected: "
            + ", ".join(schema_graph_orphan_parents)
        )

    if schema_graph_parent_forks:
        parent_summary = ", ".join(
            f"{parent} -> [{', '.join(children)}]"
            for parent, children in sorted(schema_graph_parent_forks.items())
        )
        schema_graph_lineage_warnings.append(
            f"migration parent forks detected: {parent_summary}"
        )

    if schema_graph_branch_count > schema_graph_branch_tolerance:
        divergence_message = (
            "migration graph branch count "
            f"{schema_graph_branch_count} exceeds tolerance {schema_graph_branch_tolerance}"
        )
        if schema_graph_allow_divergence_roots:
            schema_graph_lineage_warnings.append(
                divergence_message
                + "; allowed by TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true"
            )
        else:
            schema_graph_lineage_errors.append(
                divergence_message
                + "; set TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true for temporary override"
            )

    schema_graph_lineage_ready = len(schema_graph_lineage_errors) == 0
    return {
        "ok": schema_current and account_scope_ready and schema_graph_lineage_ready,
        "schema_current": schema_current,
        "schema_current_heads": schema_status.get("current_heads", []),
        "expected_heads": schema_status.get("expected_heads", []),
        "schema_missing_heads": schema_status.get("schema_missing_heads", []),
        "schema_unexpected_heads": schema_status.get("schema_unexpected_heads", []),
        "schema_head_count_expected": schema_status.get("schema_head_count_expected"),
        "schema_head_count_current": schema_status.get("schema_head_count_current"),
        "schema_head_delta_count": schema_status.get("schema_head_delta_count"),
        "schema_head_signature": schema_status.get(
            "expected_heads_signature",
            schema_status.get("schema_head_signature"),
        ),
        "schema_graph_signature": schema_status.get("schema_graph_signature"),
        "schema_graph_roots": schema_graph_roots,
        "schema_graph_branch_count": schema_graph_branch_count,
        "schema_graph_parent_forks": schema_graph_parent_forks,
        "schema_graph_duplicate_revisions": schema_graph_duplicate_revisions,
        "schema_graph_orphan_parents": schema_graph_orphan_parents,
        "schema_graph_branch_tolerance": schema_graph_branch_tolerance,
        "schema_graph_allow_divergence_roots": schema_graph_allow_divergence_roots,
        "schema_graph_lineage_ready": schema_graph_lineage_ready,
        "schema_graph_lineage_errors": schema_graph_lineage_errors,
        "schema_graph_lineage_warnings": schema_graph_lineage_warnings,
        "checked_at": checked_at,
        "account_scope_ready": account_scope_ready,
        "account_scope_errors": account_scope_checks.get("account_scope_errors", []),
        "account_scope_warnings": account_scope_warnings,
    }


@app.get("/readyz")
def readyz(session: Session = Depends(get_session)) -> JSONResponse:
    """Readiness endpoint with dependency-aware status for rollout safety."""

    payload, status_code = _evaluate_trading_health_payload(
        session,
        include_database_contract=True,
        allow_stale_dependency_cache=True,
    )
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder(payload),
    )


@app.get("/")
def root() -> dict[str, str]:
    """Surface service identity and build metadata."""

    return {
        "service": "torghut",
        "status": "ok",
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
    }


@app.get("/db-check")
def db_check(session: Session = Depends(get_session)) -> dict[str, object]:
    """Verify database connectivity and Alembic schema head alignment."""

    try:
        database_contract = _evaluate_database_contract(session)
        schema_status = {
            "schema_current": bool(database_contract.get("schema_current")),
            "current_heads": database_contract.get("schema_current_heads"),
            "expected_heads": database_contract.get("expected_heads"),
            "schema_head_signature": database_contract.get("schema_head_signature"),
            "schema_graph_signature": database_contract.get("schema_graph_signature"),
            "schema_graph_roots": database_contract.get("schema_graph_roots", []),
            "schema_graph_branch_count": database_contract.get(
                "schema_graph_branch_count",
            ),
            "schema_graph_branch_tolerance": database_contract.get(
                "schema_graph_branch_tolerance",
            ),
            "schema_graph_allow_divergence_roots": database_contract.get(
                "schema_graph_allow_divergence_roots",
            ),
            "schema_graph_parent_forks": database_contract.get(
                "schema_graph_parent_forks",
                {},
            ),
            "schema_graph_duplicate_revisions": database_contract.get(
                "schema_graph_duplicate_revisions",
                {},
            ),
            "schema_graph_orphan_parents": database_contract.get(
                "schema_graph_orphan_parents",
                [],
            ),
            "schema_graph_lineage_ready": database_contract.get(
                "schema_graph_lineage_ready",
            ),
            "schema_graph_lineage_errors": database_contract.get(
                "schema_graph_lineage_errors",
                [],
            ),
            "schema_graph_lineage_warnings": database_contract.get(
                "schema_graph_lineage_warnings",
                [],
            ),
            "schema_missing_heads": database_contract.get("schema_missing_heads", []),
            "schema_unexpected_heads": database_contract.get("schema_unexpected_heads", []),
            "schema_head_count_expected": database_contract.get(
                "schema_head_count_expected",
            ),
            "schema_head_count_current": database_contract.get(
                "schema_head_count_current",
            ),
            "schema_head_delta_count": database_contract.get(
                "schema_head_delta_count",
            ),
        }
        account_scope_status = {
            "account_scope_ready": bool(database_contract.get("account_scope_ready")),
            "account_scope_errors": database_contract.get("account_scope_errors", []),
            "account_scope_warnings": database_contract.get(
                "account_scope_warnings",
                [],
            ),
        }
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if database_contract.get("error"):
        raise HTTPException(
            status_code=503,
            detail={
                "error": database_contract.get("error"),
                "schema_current": False,
                "schema_missing_heads": database_contract.get("schema_missing_heads", []),
                "schema_unexpected_heads": database_contract.get("schema_unexpected_heads", []),
                "schema_graph_lineage_ready": database_contract.get(
                    "schema_graph_lineage_ready",
                ),
                "schema_graph_lineage_errors": database_contract.get(
                    "schema_graph_lineage_errors",
                    [],
                ),
                "schema_graph_lineage_warnings": database_contract.get(
                    "schema_graph_lineage_warnings",
                    [],
                ),
                "checked_at": database_contract.get("checked_at"),
                "account_scope_ready": account_scope_status.get("account_scope_ready"),
                "account_scope_warnings": account_scope_status.get(
                    "account_scope_warnings",
                    [],
                ),
            },
        )

    if not bool(schema_status.get("schema_current")):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "database schema mismatch",
                "checked_at": database_contract.get("checked_at"),
                "schema_missing_heads": database_contract.get("schema_missing_heads", []),
                "schema_unexpected_heads": database_contract.get("schema_unexpected_heads", []),
                "schema_head_count_expected": database_contract.get(
                    "schema_head_count_expected",
                ),
                "schema_head_count_current": database_contract.get(
                    "schema_head_count_current",
                ),
                "schema_head_delta_count": database_contract.get(
                    "schema_head_delta_count",
                ),
                **schema_status,
            },
        )
    if not bool(database_contract.get("schema_graph_lineage_ready", True)):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "database schema lineage divergence",
                "checked_at": database_contract.get("checked_at"),
                "schema_graph_lineage_errors": database_contract.get(
                    "schema_graph_lineage_errors",
                    [],
                ),
                "schema_graph_lineage_warnings": database_contract.get(
                    "schema_graph_lineage_warnings",
                    [],
                ),
                **schema_status,
            },
        )
    if settings.trading_multi_account_enabled and not bool(
        account_scope_status.get("account_scope_ready")
    ):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "database account scope schema mismatch",
                "checked_at": database_contract.get("checked_at"),
                "schema_head_signature": database_contract.get("schema_head_signature"),
                "schema_graph_signature": database_contract.get("schema_graph_signature"),
                "schema_graph_branch_count": database_contract.get(
                    "schema_graph_branch_count",
                ),
                "schema_graph_lineage_warnings": database_contract.get(
                    "schema_graph_lineage_warnings",
                    [],
                ),
                "account_scope_warnings": database_contract.get(
                    "account_scope_warnings",
                    [],
                ),
                **account_scope_status,
            },
        )
    if not settings.trading_multi_account_enabled:
        account_scope_status = dict(account_scope_status)
        account_scope_status["account_scope_ready"] = True
        account_scope_status["account_scope_errors"] = []

    return {
        "ok": True,
        "checked_at": database_contract.get("checked_at"),
        **schema_status,
        "account_scope_ready": bool(account_scope_status.get("account_scope_ready")),
        "account_scope_checks": account_scope_status,
    }


@app.get("/whitepapers/status")
def whitepaper_status() -> dict[str, object]:
    """Return whitepaper workflow enablement and runtime status."""

    worker: WhitepaperKafkaWorker | None = getattr(app.state, "whitepaper_worker", None)
    task = getattr(worker, "_task", None) if worker is not None else None
    worker_running = bool(task is not None and not task.done())
    control_token = (
        os.getenv("WHITEPAPER_WORKFLOW_API_TOKEN", "").strip()
        or os.getenv("JANGAR_API_KEY", "").strip()
    )
    return {
        "workflow_enabled": whitepaper_workflow_enabled(),
        "kafka_enabled": whitepaper_kafka_enabled(),
        "inngest_enabled": whitepaper_inngest_enabled(),
        "inngest_registered": bool(
            getattr(app.state, "whitepaper_inngest_registered", False)
        ),
        "inngest_event_name": os.getenv(
            "WHITEPAPER_INNGEST_EVENT_NAME",
            "torghut/whitepaper.analysis.requested",
        ),
        "inngest_function_id": os.getenv(
            "WHITEPAPER_INNGEST_FUNCTION_ID",
            "torghut-whitepaper-analysis-v1",
        ),
        "inngest_finalized_event_name": os.getenv(
            "WHITEPAPER_INNGEST_FINALIZED_EVENT_NAME",
            "torghut/whitepaper.analysis.finalized",
        ),
        "inngest_finalize_function_id": os.getenv(
            "WHITEPAPER_INNGEST_FINALIZE_FUNCTION_ID",
            "torghut-whitepaper-synthesis-index-v1",
        ),
        "semantic_indexing_enabled": whitepaper_semantic_indexing_enabled(),
        "worker_running": worker_running,
        "requeue_comment_keyword": os.getenv(
            "WHITEPAPER_REQUEUE_COMMENT_KEYWORD",
            "research whitepaper",
        ),
        "control_auth_enabled": bool(control_token),
    }


@app.post("/whitepapers/events/github-issue")
def ingest_whitepaper_github_issue(
    request: Request,
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> JSONResponse:
    """Ingest a GitHub issue webhook payload and create/update whitepaper workflow state."""

    _require_whitepaper_control_token(request)

    try:
        result = WHITEPAPER_WORKFLOW.ingest_github_issue_event(
            session=session,
            payload=cast(dict[str, Any], payload),
            source="api",
        )
        if result.accepted:
            session.commit()
            return JSONResponse(
                status_code=202,
                content={
                    "accepted": True,
                    "reason": result.reason,
                    "run_id": result.run_id,
                    "document_key": result.document_key,
                    "agentrun_name": result.agentrun_name,
                },
            )
        session.rollback()
        return JSONResponse(
            status_code=200,
            content={
                "accepted": False,
                "reason": result.reason,
            },
        )
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper issue intake failed")
        raise HTTPException(
            status_code=500, detail=f"whitepaper_issue_intake_failed:{exc}"
        ) from exc


@app.post("/whitepapers/runs/{run_id}/dispatch-agentrun")
def dispatch_whitepaper_agentrun(
    run_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Dispatch Codex AgentRun for an existing whitepaper analysis run."""

    _require_whitepaper_control_token(request)

    try:
        result = WHITEPAPER_WORKFLOW.dispatch_codex_agentrun(session, run_id)
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper AgentRun dispatch failed for run_id=%s", run_id)
        raise HTTPException(
            status_code=502, detail=f"whitepaper_agentrun_dispatch_failed:{exc}"
        ) from exc
    session.commit()
    return cast(dict[str, object], result)


@app.post("/whitepapers/runs/{run_id}/finalize")
def finalize_whitepaper_run(
    run_id: str,
    request: Request,
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Finalize run outputs from Inngest/AgentRun synthesis and verdict payloads."""

    _require_whitepaper_control_token(request)

    try:
        result = WHITEPAPER_WORKFLOW.finalize_run(
            session,
            run_id=run_id,
            payload=cast(dict[str, Any], payload),
        )
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper finalize failed for run_id=%s", run_id)
        raise HTTPException(
            status_code=500, detail=f"whitepaper_finalize_failed:{exc}"
        ) from exc
    session.commit()
    return cast(dict[str, object], result)


@app.post("/whitepapers/runs/{run_id}/approve-implementation")
def approve_whitepaper_for_engineering(
    run_id: str,
    request: Request,
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Manually approve a completed whitepaper for B1 engineering dispatch."""

    _require_whitepaper_control_token(request)

    approved_by = str(
        payload.get("approved_by") or payload.get("approvedBy") or ""
    ).strip()
    approval_reason = str(
        payload.get("approval_reason") or payload.get("approvalReason") or ""
    ).strip()
    approval_source = str(
        payload.get("approval_source") or payload.get("approvalSource") or "jangar_ui"
    ).strip()
    target_scope = (
        str(payload.get("target_scope") or payload.get("targetScope") or "").strip()
        or None
    )
    repository = str(payload.get("repository") or "").strip() or None
    base = str(payload.get("base") or "").strip() or None
    head = str(payload.get("head") or "").strip() or None
    rollout_profile = (
        str(
            payload.get("rollout_profile") or payload.get("rolloutProfile") or ""
        ).strip()
        or None
    )

    try:
        result = WHITEPAPER_WORKFLOW.approve_for_engineering(
            session,
            run_id=run_id,
            approved_by=approved_by,
            approval_reason=approval_reason,
            approval_source=approval_source or "jangar_ui",
            target_scope=target_scope,
            repository=repository,
            base=base,
            head=head,
            rollout_profile=rollout_profile,
        )
    except ValueError as exc:
        session.rollback()
        detail = str(exc)
        status = 404 if detail == "whitepaper_run_not_found" else 400
        raise HTTPException(status_code=status, detail=detail) from exc
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper manual approval failed for run_id=%s", run_id)
        raise HTTPException(
            status_code=500, detail=f"whitepaper_manual_approval_failed:{exc}"
        ) from exc
    session.commit()
    return cast(dict[str, object], result)


@app.get("/whitepapers/runs/{run_id}")
def get_whitepaper_run(
    run_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return whitepaper run state, linked AgentRun status, and design PR metadata."""

    row = session.execute(
        select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="whitepaper_run_not_found")

    agentrun = (
        session.execute(
            select(WhitepaperCodexAgentRun)
            .where(WhitepaperCodexAgentRun.analysis_run_id == row.id)
            .order_by(WhitepaperCodexAgentRun.created_at.desc())
        )
        .scalars()
        .first()
    )

    pr_rows = (
        session.execute(
            select(WhitepaperDesignPullRequest)
            .where(WhitepaperDesignPullRequest.analysis_run_id == row.id)
            .order_by(WhitepaperDesignPullRequest.attempt.asc())
        )
        .scalars()
        .all()
    )
    trigger_row = session.execute(
        select(WhitepaperEngineeringTrigger).where(
            WhitepaperEngineeringTrigger.analysis_run_id == row.id
        )
    ).scalar_one_or_none()
    rollout_rows: Sequence[WhitepaperRolloutTransition] = []
    if trigger_row is not None:
        rollout_rows = (
            session.execute(
                select(WhitepaperRolloutTransition)
                .where(WhitepaperRolloutTransition.trigger_id == trigger_row.id)
                .order_by(WhitepaperRolloutTransition.created_at.asc())
            )
            .scalars()
            .all()
        )

    return jsonable_encoder(
        {
            "run_id": row.run_id,
            "status": row.status,
            "trigger_source": row.trigger_source,
            "trigger_actor": row.trigger_actor,
            "failure_reason": row.failure_reason,
            "created_at": row.created_at,
            "started_at": row.started_at,
            "completed_at": row.completed_at,
            "document": {
                "document_key": row.document.document_key if row.document else None,
                "source_identifier": row.document.source_identifier
                if row.document
                else None,
                "title": row.document.title if row.document else None,
                "status": row.document.status if row.document else None,
            },
            "document_version": {
                "version_number": row.document_version.version_number
                if row.document_version
                else None,
                "checksum_sha256": row.document_version.checksum_sha256
                if row.document_version
                else None,
                "ceph_bucket": row.document_version.ceph_bucket
                if row.document_version
                else None,
                "ceph_object_key": row.document_version.ceph_object_key
                if row.document_version
                else None,
                "parse_status": row.document_version.parse_status
                if row.document_version
                else None,
                "parse_error": row.document_version.parse_error
                if row.document_version
                else None,
            },
            "agentrun": {
                "name": agentrun.agentrun_name if agentrun else None,
                "namespace": agentrun.agentrun_namespace if agentrun else None,
                "status": agentrun.status if agentrun else None,
                "head_branch": agentrun.vcs_head_branch if agentrun else None,
                "started_at": agentrun.started_at if agentrun else None,
                "completed_at": agentrun.completed_at if agentrun else None,
            },
            "design_pull_requests": [
                {
                    "attempt": pr.attempt,
                    "status": pr.status,
                    "pr_number": pr.pr_number,
                    "pr_url": pr.pr_url,
                    "head_branch": pr.head_branch,
                    "base_branch": pr.base_branch,
                    "is_merged": pr.is_merged,
                    "merged_at": pr.merged_at,
                    "ci_status": pr.ci_status,
                }
                for pr in pr_rows
            ],
            "engineering_trigger": (
                {
                    "trigger_id": trigger_row.trigger_id,
                    "implementation_grade": trigger_row.implementation_grade,
                    "decision": trigger_row.decision,
                    "reason_codes": trigger_row.reason_codes_json,
                    "approval_token": trigger_row.approval_token,
                    "dispatched_agentrun_name": trigger_row.dispatched_agentrun_name,
                    "rollout_profile": trigger_row.rollout_profile,
                    "approval_source": trigger_row.approval_source,
                    "approved_by": trigger_row.approved_by,
                    "approved_at": trigger_row.approved_at,
                    "approval_reason": trigger_row.approval_reason,
                    "policy_ref": trigger_row.policy_ref,
                    "gate_snapshot_hash": trigger_row.gate_snapshot_hash,
                    "created_at": trigger_row.created_at,
                    "updated_at": trigger_row.updated_at,
                }
                if trigger_row is not None
                else None
            ),
            "rollout_transitions": [
                {
                    "transition_id": transition.transition_id,
                    "from_stage": transition.from_stage,
                    "to_stage": transition.to_stage,
                    "transition_type": transition.transition_type,
                    "status": transition.status,
                    "gate_results": transition.gate_results_json,
                    "reason_codes": transition.reason_codes_json,
                    "blocking_gate": transition.blocking_gate,
                    "evidence_hash": transition.evidence_hash,
                    "created_at": transition.created_at,
                }
                for transition in rollout_rows
            ],
        }
    )


@app.get("/whitepapers/search")
def search_whitepapers(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=15, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    status: str = Query(default="completed"),
    scope: str = Query(default="all"),
    subject: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Hybrid semantic + lexical whitepaper search over indexed chunks."""

    if not whitepaper_semantic_indexing_enabled():
        raise HTTPException(
            status_code=409, detail="whitepaper_semantic_search_disabled"
        )

    normalized_scope = scope.strip().lower()
    if normalized_scope not in {"all", "full_text", "synthesis"}:
        raise HTTPException(status_code=400, detail="whitepaper_search_invalid_scope")

    try:
        result = WHITEPAPER_WORKFLOW.search_semantic(
            session,
            query=q,
            limit=limit,
            offset=offset,
            status=status,
            scope=normalized_scope,
            subject=subject,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Whitepaper search failed")
        raise HTTPException(
            status_code=500, detail=f"whitepaper_search_failed:{exc}"
        ) from exc

    return cast(dict[str, object], jsonable_encoder(result))


@app.get("/trading/status")
def trading_status(session: Session = Depends(get_session)) -> dict[str, object]:
    """Return trading loop status and metrics."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    state = scheduler.state
    llm_evaluation = _load_llm_evaluation(session)
    tca_summary = _load_tca_summary(session)
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=state,
        hypothesis_summary=hypothesis_summary,
    )
    control_plane_contract = _build_control_plane_contract(
        state,
        hypothesis_summary=hypothesis_summary,
        dependency_quorum=hypothesis_dependency_quorum,
    )
    shorting_metadata_status = scheduler.shorting_metadata_status()
    rejection_alert_status = scheduler.rejection_alert_status()
    active_simulation_context = active_simulation_runtime_context()
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    live_submission_gate = _build_live_submission_gate_payload(
        state,
        session=session,
        hypothesis_summary=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        dspy_runtime_status=cast(
            dict[str, object],
            scheduler.llm_status().get("dspy_runtime", {}),
        ),
        quant_health_status=quant_evidence,
    )
    return {
        "enabled": settings.trading_enabled,
        "autonomy_enabled": settings.trading_autonomy_enabled,
        "mode": settings.trading_mode,
        "kill_switch_enabled": settings.trading_kill_switch_enabled,
        "build": {
            "version": BUILD_VERSION,
            "commit": BUILD_COMMIT,
            "image_digest": BUILD_IMAGE_DIGEST,
            "active_revision": shadow_first_runtime["active_revision"],
        },
        "shadow_first": shadow_first_runtime,
        "execution_advisor": {
            "enabled": settings.trading_execution_advisor_enabled,
            "live_apply_enabled": settings.trading_execution_advisor_live_apply_enabled,
            "usage_total": dict(state.metrics.execution_advisor_usage_total),
            "fallback_total": dict(state.metrics.execution_advisor_fallback_total),
        },
        "running": state.running,
        "live_submission_gate": live_submission_gate,
        "quant_evidence": quant_evidence,
        "last_run_at": state.last_run_at,
        "last_reconcile_at": state.last_reconcile_at,
        "last_error": state.last_error,
        "autonomy": {
            "runs_total": state.autonomy_runs_total,
            "signals_total": state.autonomy_signals_total,
            "patches_total": state.autonomy_patches_total,
            "no_signal_streak": state.autonomy_no_signal_streak,
            "last_run_at": state.last_autonomy_run_at,
            "last_run_id": state.last_autonomy_run_id,
            "last_gates": state.last_autonomy_gates,
            "last_actuation_intent": state.last_autonomy_actuation_intent,
            "last_patch": state.last_autonomy_patch,
            "last_recommendation": state.last_autonomy_recommendation,
            "last_recommendation_trace_id": state.last_autonomy_recommendation_trace_id,
            "last_error": state.last_autonomy_error,
            "last_reason": state.last_autonomy_reason,
            "last_ingest_signal_count": state.last_ingest_signals_total,
            "last_ingest_reason": state.last_ingest_reason,
            "last_ingest_window_start": state.last_ingest_window_start,
            "last_ingest_window_end": state.last_ingest_window_end,
            "failure_streak": state.autonomy_failure_streak,
            "bridge_status": _build_autonomy_bridge_status(scheduler),
        },
        "signal_continuity": {
            "universe_source": settings.trading_universe_source,
            "universe_status": state.universe_source_status,
            "universe_reason": state.universe_source_reason,
            "universe_symbols_count": state.universe_symbols_count,
            "universe_cache_age_seconds": state.universe_cache_age_seconds,
            "universe_fail_safe_blocked": state.universe_fail_safe_blocked,
            "universe_fail_safe_block_reason": state.universe_fail_safe_block_reason,
            "market_session_open": state.market_session_open,
            "last_state": state.last_signal_continuity_state,
            "last_reason": state.last_signal_continuity_reason,
            "last_actionable": state.last_signal_continuity_actionable,
            "alert_active": state.signal_continuity_alert_active,
            "alert_reason": state.signal_continuity_alert_reason,
            "alert_started_at": state.signal_continuity_alert_started_at,
            "alert_last_seen_at": state.signal_continuity_alert_last_seen_at,
            "alert_recovery_streak": state.signal_continuity_recovery_streak,
            "no_signal_reason_streak": dict(state.metrics.no_signal_reason_streak),
            "signal_staleness_alert_total": dict(
                state.metrics.signal_staleness_alert_total
            ),
            "signal_continuity_promotion_block_total": state.metrics.signal_continuity_promotion_block_total,
            "no_signal_streak_alert_threshold": settings.trading_signal_no_signal_streak_alert_threshold,
            "signal_lag_alert_threshold_seconds": settings.trading_signal_stale_lag_alert_seconds,
            "signal_continuity_recovery_cycles": settings.trading_signal_continuity_recovery_cycles,
        },
        "market_context": market_context_status,
        "shorting_metadata": shorting_metadata_status,
        "rejections": {
            "policy_veto_total": state.metrics.llm_policy_veto_total,
            "runtime_fallback_total": state.metrics.llm_runtime_fallback_total,
            "market_context_block_total": state.metrics.llm_market_context_block_total,
            "pre_llm_capacity_reject_total": state.metrics.pre_llm_capacity_reject_total,
            "pre_llm_qty_below_min_total": state.metrics.pre_llm_qty_below_min_total,
            "runtime_fallback_ratio": rejection_alert_status[
                "runtime_fallback_ratio"
            ],
            "runtime_fallback_alert_ratio_threshold": rejection_alert_status[
                "runtime_fallback_alert_ratio_threshold"
            ],
            "runtime_fallback_alert_active": rejection_alert_status[
                "runtime_fallback_alert_active"
            ],
        },
        "alerts": {
            "market_context_alert_active": market_context_status["alert_active"],
            "market_context_alert_reason": market_context_status["alert_reason"],
            "runtime_fallback_alert_active": rejection_alert_status[
                "runtime_fallback_alert_active"
            ],
            "shorting_metadata_alert_active": rejection_alert_status[
                "shorting_metadata_alert_active"
            ],
        },
        "rollback": {
            "emergency_stop_active": state.emergency_stop_active,
            "emergency_stop_reason": state.emergency_stop_reason,
            "emergency_stop_triggered_at": state.emergency_stop_triggered_at,
            "emergency_stop_resolved_at": state.emergency_stop_resolved_at,
            "emergency_stop_recovery_streak": state.emergency_stop_recovery_streak,
            "incidents_total": state.rollback_incidents_total,
            "incident_evidence_path": state.rollback_incident_evidence_path,
        },
        "posthog": {
            "enabled": settings.posthog_enabled,
            "host": settings.posthog_host,
            "project_id": settings.posthog_project_id,
            "event_total": dict(state.metrics.domain_telemetry_event_total),
            "dropped_total": dict(state.metrics.domain_telemetry_dropped_total),
        },
        "metrics": state.metrics.__dict__,
        "llm": scheduler.llm_status(),
        "llm_evaluation": llm_evaluation,
        "tca": tca_summary,
        "hypotheses": hypothesis_payload,
        "forecast_service": _forecast_service_status(),
        "lean_authority": _lean_authority_status(),
        "empirical_jobs": empirical_jobs,
        "simulation": {
            "enabled": settings.trading_simulation_enabled,
            "run_id": (active_simulation_context or {}).get("run_id") or settings.trading_simulation_run_id,
            "dataset_id": (active_simulation_context or {}).get("dataset_id")
            or settings.trading_simulation_dataset_id,
            "window_start": (active_simulation_context or {}).get("window_start")
            or settings.trading_simulation_window_start,
            "window_end": (active_simulation_context or {}).get("window_end")
            or settings.trading_simulation_window_end,
            "time_source": trading_time_status(account_label=settings.trading_account_label),
        },
        "control_plane_contract": control_plane_contract,
        "evidence_continuity": state.last_evidence_continuity_report,
    }


@app.get("/trading/metrics")
def trading_metrics(session: Session = Depends(get_session)) -> dict[str, object]:
    """Expose trading metrics counters."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    metrics = scheduler.state.metrics
    market_context_status = scheduler.market_context_status()
    tca_summary = _load_tca_summary(session)
    _hypothesis_payload, hypothesis_summary, hypothesis_dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=scheduler.state,
        hypothesis_summary=hypothesis_summary,
    )
    return {
        "metrics": metrics.__dict__,
        "build": {
            "version": BUILD_VERSION,
            "commit": BUILD_COMMIT,
            "image_digest": BUILD_IMAGE_DIGEST,
            "active_revision": shadow_first_runtime["active_revision"],
        },
        "shadow_first": shadow_first_runtime,
        "tca": tca_summary,
        "control_plane_contract": _build_control_plane_contract(
            scheduler.state,
            hypothesis_summary=hypothesis_summary,
            dependency_quorum=hypothesis_dependency_quorum,
        ),
    }


@app.get("/trading/simulation/progress")
def trading_simulation_progress(
    run_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Expose durable simulation progress for the current or requested run."""

    snapshot = simulation_progress_snapshot(session, run_id=run_id)
    active_runtime_context = active_simulation_runtime_context(session)
    snapshot["requested_run_id"] = run_id
    snapshot["active_run_id"] = (active_runtime_context or {}).get("run_id") or settings.trading_simulation_run_id
    snapshot["simulation_enabled"] = settings.trading_simulation_enabled
    return cast(dict[str, object], snapshot)


@app.post("/trading/lean/backtests")
def submit_lean_backtest(
    payload: dict[str, object] = Body(default={}),
    requested_by: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Submit an asynchronous LEAN backtest and persist metadata for governance."""

    if settings.trading_lean_lane_disable_switch:
        raise HTTPException(status_code=409, detail="lean_lane_disabled")
    if not settings.trading_lean_backtest_enabled:
        raise HTTPException(status_code=409, detail="lean_backtest_lane_disabled")
    lane = str(payload.get("lane") or "research").strip() or "research"
    config_payload = payload.get("config")
    if not isinstance(config_payload, dict):
        raise HTTPException(status_code=400, detail="config_must_be_object")
    config = {
        str(key): value
        for key, value in cast(dict[object, Any], config_payload).items()
    }
    try:
        row = LEAN_LANE_MANAGER.submit_backtest(
            session,
            config=config,
            lane=lane,
            requested_by=requested_by,
            correlation_id=f"torghut-backtest-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "backtest_id": row.backtest_id,
        "status": row.status,
        "lane": row.lane,
        "reproducibility_hash": row.reproducibility_hash,
        "requested_by": row.requested_by,
        "created_at": row.created_at,
    }


@app.get("/trading/lean/backtests/{backtest_id}")
def get_lean_backtest(
    backtest_id: str, session: Session = Depends(get_session)
) -> dict[str, object]:
    """Refresh and return LEAN backtest lifecycle state and reproducibility evidence."""

    try:
        row = LEAN_LANE_MANAGER.refresh_backtest(session, backtest_id=backtest_id)
    except RuntimeError as exc:
        detail = str(exc)
        status = 404 if detail == "lean_backtest_not_found" else 502
        raise HTTPException(status_code=status, detail=detail) from exc
    return {
        "backtest_id": row.backtest_id,
        "status": row.status,
        "lane": row.lane,
        "result": row.result_json,
        "artifacts": row.artifacts_json,
        "reproducibility_hash": row.reproducibility_hash,
        "replay_hash": row.replay_hash,
        "deterministic_replay_passed": row.deterministic_replay_passed,
        "failure_taxonomy": row.failure_taxonomy,
        "completed_at": row.completed_at,
    }


@app.get("/trading/lean/shadow/parity")
def get_lean_shadow_parity(
    lookback_hours: int = Query(default=24, ge=1, le=168),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return LEAN shadow execution parity summary for drift detection and governance."""

    summary = LEAN_LANE_MANAGER.parity_summary(
        session,
        lookback_hours=lookback_hours,
    )
    return summary


@app.get("/trading/autonomy")
def trading_autonomy() -> dict[str, object]:
    """Return autonomous control-plane status and last lane artifacts."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    state = scheduler.state
    active_simulation_context = active_simulation_runtime_context()
    return {
        "enabled": settings.trading_autonomy_enabled,
        "gate_policy_path": settings.trading_autonomy_gate_policy_path,
        "artifact_dir": settings.trading_autonomy_artifact_dir,
        "poll_interval_seconds": settings.trading_autonomy_interval_seconds,
        "signal_lookback_minutes": settings.trading_autonomy_signal_lookback_minutes,
        "runs_total": state.autonomy_runs_total,
        "signals_total": state.autonomy_signals_total,
        "patches_total": state.autonomy_patches_total,
        "no_signal_streak": state.autonomy_no_signal_streak,
        "last_run_at": state.last_autonomy_run_at,
        "last_run_id": state.last_autonomy_run_id,
        "last_gates": state.last_autonomy_gates,
        "last_actuation_intent": state.last_autonomy_actuation_intent,
        "last_patch": state.last_autonomy_patch,
        "last_recommendation": state.last_autonomy_recommendation,
        "last_recommendation_trace_id": state.last_autonomy_recommendation_trace_id,
        "last_error": state.last_autonomy_error,
        "last_reason": state.last_autonomy_reason,
        "last_ingest_signal_count": state.last_ingest_signals_total,
        "last_ingest_reason": state.last_ingest_reason,
        "last_ingest_window_start": state.last_ingest_window_start,
        "last_ingest_window_end": state.last_ingest_window_end,
        "failure_streak": state.autonomy_failure_streak,
        "forecast_service": _forecast_service_status(),
        "lean_authority": _lean_authority_status(),
        "empirical_jobs": _empirical_jobs_status(),
        "simulation": {
            "enabled": settings.trading_simulation_enabled,
            "run_id": (active_simulation_context or {}).get("run_id") or settings.trading_simulation_run_id,
            "dataset_id": (active_simulation_context or {}).get("dataset_id")
            or settings.trading_simulation_dataset_id,
            "window_start": (active_simulation_context or {}).get("window_start")
            or settings.trading_simulation_window_start,
            "window_end": (active_simulation_context or {}).get("window_end")
            or settings.trading_simulation_window_end,
            "time_source": trading_time_status(account_label=settings.trading_account_label),
        },
        "bridge_status": _build_autonomy_bridge_status(scheduler),
        "signal_continuity": {
            "universe_source": settings.trading_universe_source,
            "universe_status": state.universe_source_status,
            "universe_reason": state.universe_source_reason,
            "universe_symbols_count": state.universe_symbols_count,
            "universe_cache_age_seconds": state.universe_cache_age_seconds,
            "universe_fail_safe_blocked": state.universe_fail_safe_blocked,
            "universe_fail_safe_block_reason": state.universe_fail_safe_block_reason,
            "market_session_open": state.market_session_open,
            "last_state": state.last_signal_continuity_state,
            "last_reason": state.last_signal_continuity_reason,
            "last_actionable": state.last_signal_continuity_actionable,
            "alert_active": state.signal_continuity_alert_active,
            "alert_reason": state.signal_continuity_alert_reason,
            "alert_started_at": state.signal_continuity_alert_started_at,
            "alert_last_seen_at": state.signal_continuity_alert_last_seen_at,
            "alert_recovery_streak": state.signal_continuity_recovery_streak,
            "no_signal_reason_streak": dict(state.metrics.no_signal_reason_streak),
            "signal_staleness_alert_total": dict(
                state.metrics.signal_staleness_alert_total
            ),
            "signal_continuity_promotion_block_total": state.metrics.signal_continuity_promotion_block_total,
            "no_signal_streak_alert_threshold": settings.trading_signal_no_signal_streak_alert_threshold,
            "signal_lag_alert_threshold_seconds": settings.trading_signal_stale_lag_alert_seconds,
            "signal_continuity_recovery_cycles": settings.trading_signal_continuity_recovery_cycles,
        },
        "rollback": {
            "emergency_stop_active": state.emergency_stop_active,
            "emergency_stop_reason": state.emergency_stop_reason,
            "emergency_stop_triggered_at": state.emergency_stop_triggered_at,
            "emergency_stop_resolved_at": state.emergency_stop_resolved_at,
            "emergency_stop_recovery_streak": state.emergency_stop_recovery_streak,
            "incidents_total": state.rollback_incidents_total,
            "incident_evidence_path": state.rollback_incident_evidence_path,
        },
        "evidence_continuity": state.last_evidence_continuity_report,
    }


@app.get("/trading/empirical-jobs")
def trading_empirical_jobs() -> dict[str, object]:
    """Return freshness and authority status for empirical parity and Janus workflows."""

    return _empirical_jobs_status()


@app.get("/trading/completion/doc29")
def trading_completion_doc29(
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return traceable completion status for doc 29 gates."""

    return build_doc29_completion_status(
        session=session,
        stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
        current_git_revision=BUILD_COMMIT,
        current_image_digest=BUILD_IMAGE_DIGEST,
    )


@app.get("/trading/completion/doc29/{gate_id}")
def trading_completion_doc29_gate(
    gate_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return traceable completion status for one doc 29 gate."""

    payload = build_doc29_completion_status(
        session=session,
        stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
        current_git_revision=BUILD_COMMIT,
        current_image_digest=BUILD_IMAGE_DIGEST,
    )
    for gate in cast(list[dict[str, object]], payload.get("gates", [])):
        if str(gate.get("gate_id")) == gate_id:
            return gate
    raise HTTPException(status_code=404, detail=f"unknown_doc29_gate:{gate_id}")


@app.get("/trading/autonomy/evidence-continuity")
def trading_autonomy_evidence_continuity(
    refresh: bool = Query(default=False),
    run_limit: int | None = Query(default=None, ge=1, le=50),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return latest evidence continuity check and optionally force a refresh."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler

    if refresh:
        report = evaluate_evidence_continuity(
            session,
            run_limit=run_limit or settings.trading_evidence_continuity_run_limit,
        )
        payload = report.to_payload()
        scheduler.state.last_evidence_continuity_report = payload
        return {
            "enabled": settings.trading_evidence_continuity_enabled,
            "interval_seconds": settings.trading_evidence_continuity_interval_seconds,
            "default_run_limit": settings.trading_evidence_continuity_run_limit,
            "report": payload,
        }

    return {
        "enabled": settings.trading_evidence_continuity_enabled,
        "interval_seconds": settings.trading_evidence_continuity_interval_seconds,
        "default_run_limit": settings.trading_evidence_continuity_run_limit,
        "report": scheduler.state.last_evidence_continuity_report,
    }


@app.get("/trading/llm-evaluation")
def trading_llm_evaluation(session: Session = Depends(get_session)) -> JSONResponse:
    """Return today's LLM evaluation metrics in America/New_York time."""

    try:
        payload = build_llm_evaluation_metrics(session)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


@app.get("/metrics")
def prometheus_metrics(session: Session = Depends(get_session)) -> Response:
    """Expose Prometheus-formatted trading metrics counters."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    metrics = scheduler.state.metrics
    market_context_status = scheduler.market_context_status()
    shorting_metadata_status = scheduler.shorting_metadata_status()
    rejection_alert_status = scheduler.rejection_alert_status()
    tca_summary = _load_tca_summary(session)
    _hypothesis_payload, hypothesis_summary, _hypothesis_dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    payload = render_trading_metrics(
        {
            **metrics.__dict__,
            "tca_summary": tca_summary,
            "route_provenance": _load_route_provenance_summary(session),
            "hypothesis_state_total": hypothesis_summary.get("state_totals", {}),
            "hypothesis_capital_stage_total": hypothesis_summary.get(
                "capital_stage_totals", {}
            ),
            "alpha_readiness_hypotheses_total": _safe_int(
                hypothesis_summary.get("hypotheses_total")
            ),
            "alpha_readiness_promotion_eligible_total": _safe_int(
                hypothesis_summary.get("promotion_eligible_total")
            ),
            "alpha_readiness_rollback_required_total": _safe_int(
                hypothesis_summary.get("rollback_required_total")
            ),
            "market_context_alert_active": int(
                bool(market_context_status.get("alert_active"))
            ),
            "market_context_last_freshness_seconds": _safe_int(
                market_context_status.get("last_freshness_seconds")
            ),
            "market_context_last_quality_score": _safe_float(
                market_context_status.get("last_quality_score")
            ),
            "llm_runtime_fallback_ratio": _safe_float(
                rejection_alert_status.get("runtime_fallback_ratio")
            ),
            "llm_runtime_fallback_alert_active": int(
                bool(rejection_alert_status.get("runtime_fallback_alert_active"))
            ),
            "shorting_metadata_account_ready": int(
                shorting_metadata_status.get("account_ready") is True
            ),
            "shorting_metadata_alert_active": int(
                bool(rejection_alert_status.get("shorting_metadata_alert_active"))
            ),
        }
    )
    return Response(content=payload, media_type="text/plain; version=0.0.4")


@app.get("/trading/decisions")
def trading_decisions(
    symbol: str | None = None,
    since: datetime | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[dict[str, object]]:
    """Return recent trade decisions."""

    stmt = select(TradeDecision).order_by(TradeDecision.created_at.desc())
    if symbol:
        stmt = stmt.where(TradeDecision.symbol == symbol)
    if since:
        stmt = stmt.where(TradeDecision.created_at >= since)
    stmt = stmt.limit(limit)
    decisions = session.execute(stmt).scalars().all()
    payload = [
        {
            "id": str(decision.id),
            "strategy_id": str(decision.strategy_id),
            "symbol": decision.symbol,
            "timeframe": decision.timeframe,
            "status": decision.status,
            "rationale": decision.rationale,
            "decision": decision.decision_json,
            "created_at": decision.created_at,
            "executed_at": decision.executed_at,
            "alpaca_account_label": decision.alpaca_account_label,
        }
        for decision in decisions
    ]
    return jsonable_encoder(payload)


@app.get("/trading/executions")
def trading_executions(
    symbol: str | None = None,
    since: datetime | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[dict[str, object]]:
    """Return recent trade executions."""

    stmt = select(Execution).order_by(Execution.created_at.desc())
    if symbol:
        stmt = stmt.where(Execution.symbol == symbol)
    if since:
        stmt = stmt.where(Execution.created_at >= since)
    stmt = stmt.limit(limit)
    executions = session.execute(stmt).scalars().all()
    execution_ids = [execution.id for execution in executions]
    tca_by_execution: dict[str, ExecutionTCAMetric] = {}
    if execution_ids:
        tca_stmt = select(ExecutionTCAMetric).where(
            ExecutionTCAMetric.execution_id.in_(execution_ids)
        )
        tca_rows = session.execute(tca_stmt).scalars().all()
        tca_by_execution = {str(row.execution_id): row for row in tca_rows}
    payload = [
        {
            "id": str(execution.id),
            "trade_decision_id": str(execution.trade_decision_id)
            if execution.trade_decision_id
            else None,
            "symbol": execution.symbol,
            "side": execution.side,
            "order_type": execution.order_type,
            "time_in_force": execution.time_in_force,
            "submitted_qty": execution.submitted_qty,
            "filled_qty": execution.filled_qty,
            "avg_fill_price": execution.avg_fill_price,
            "execution_expected_adapter": execution.execution_expected_adapter,
            "execution_actual_adapter": execution.execution_actual_adapter,
            "execution_fallback_reason": execution.execution_fallback_reason,
            "execution_fallback_count": execution.execution_fallback_count,
            "execution_correlation_id": execution.execution_correlation_id,
            "execution_idempotency_key": execution.execution_idempotency_key,
            "status": execution.status,
            "created_at": execution.created_at,
            "last_update_at": execution.last_update_at,
            "alpaca_order_id": execution.alpaca_order_id,
            "tca": _tca_row_payload(tca_by_execution.get(str(execution.id))),
        }
        for execution in executions
    ]
    return jsonable_encoder(payload)


@app.get("/trading/profitability/runtime")
def trading_runtime_profitability(
    session: Session = Depends(get_session),
) -> JSONResponse:
    """Return bounded runtime profitability evidence for operator dashboards."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler

    window_end = datetime.now(timezone.utc)
    window_start = window_end - timedelta(hours=RUNTIME_PROFITABILITY_LOOKBACK_HOURS)
    decisions, decision_total = _load_runtime_profitability_decisions(
        session, window_start
    )
    executions, execution_total, fallback_reason_totals = (
        _load_runtime_profitability_executions(session, window_start)
    )
    realized_pnl_summary = _load_runtime_profitability_realized_pnl_summary(
        session, window_start
    )
    gate_rollback_attribution = _load_runtime_profitability_gate_rollback_attribution(
        scheduler.state
    )
    tca_summary = _load_tca_summary(session)
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, _hypothesis_summary, _dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    live_submission_gate = _build_live_submission_gate_payload(
        scheduler.state,
        session=session,
        hypothesis_summary=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        dspy_runtime_status=cast(
            dict[str, object],
            scheduler.llm_status().get('dspy_runtime', {}),
        ),
        quant_health_status=quant_evidence,
    )

    caveats = [
        {
            "code": "evidence_only_no_profitability_certainty",
            "message": (
                "Runtime profitability is observational evidence only and does not establish future or guaranteed profitability."
            ),
        },
        {
            "code": "realized_pnl_proxy_from_tca_shortfall",
            "message": (
                "realized_pnl_proxy_notional is derived from TCA shortfall notional and excludes full portfolio mark-to-market effects."
            ),
        },
    ]
    tca_samples = _safe_int(realized_pnl_summary.get("tca_sample_count", 0))
    if decision_total == 0 and execution_total == 0 and tca_samples == 0:
        caveats.append(
            {
                "code": "empty_window_no_runtime_evidence",
                "message": (
                    "No decisions, executions, or TCA samples were recorded in the fixed lookback window."
                ),
            }
        )

    payload = {
        "schema_version": RUNTIME_PROFITABILITY_SCHEMA_VERSION,
        "generated_at": window_end,
        "window": {
            "lookback_hours": RUNTIME_PROFITABILITY_LOOKBACK_HOURS,
            "start": window_start,
            "end": window_end,
            "decision_count": decision_total,
            "execution_count": execution_total,
            "tca_sample_count": tca_samples,
            "empty": decision_total == 0 and execution_total == 0 and tca_samples == 0,
        },
        "decisions_by_symbol_strategy": decisions,
        "executions": {
            "by_adapter": executions,
            "fallback_reason_totals": fallback_reason_totals,
        },
        "realized_pnl_summary": realized_pnl_summary,
        "gate_rollback_attribution": gate_rollback_attribution,
        "live_submission_gate": live_submission_gate,
        "caveats": caveats,
    }
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


@app.get("/trading/tca")
def trading_tca(
    symbol: str | None = None,
    strategy_id: str | None = None,
    since: datetime | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return per-order and aggregated transaction cost analytics metrics."""

    stmt = select(ExecutionTCAMetric).order_by(ExecutionTCAMetric.computed_at.desc())
    if symbol:
        stmt = stmt.where(ExecutionTCAMetric.symbol == symbol)
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    if since:
        stmt = stmt.where(ExecutionTCAMetric.computed_at >= since)
    rows = session.execute(stmt.limit(limit)).scalars().all()

    grouped = _aggregate_tca_rows(rows)
    payload_rows = [
        {
            "execution_id": str(row.execution_id),
            "trade_decision_id": str(row.trade_decision_id)
            if row.trade_decision_id
            else None,
            "strategy_id": str(row.strategy_id) if row.strategy_id else None,
            "alpaca_account_label": row.alpaca_account_label,
            "symbol": row.symbol,
            "side": row.side,
            "arrival_price": row.arrival_price,
            "avg_fill_price": row.avg_fill_price,
            "filled_qty": row.filled_qty,
            "signed_qty": row.signed_qty,
            "slippage_bps": row.slippage_bps,
            "shortfall_notional": row.shortfall_notional,
            "churn_qty": row.churn_qty,
            "churn_ratio": row.churn_ratio,
            "computed_at": row.computed_at,
        }
        for row in rows
    ]
    return jsonable_encoder(
        {
            "summary": _load_tca_summary(session),
            "aggregates": grouped,
            "rows": payload_rows,
        }
    )


@app.get("/trading/health")
def trading_health(session: Session = Depends(get_session)) -> JSONResponse:
    """Trading loop health including dependency readiness."""

    payload, status_code = _evaluate_trading_health_payload(session)
    return JSONResponse(status_code=status_code, content=jsonable_encoder(payload))


def _check_postgres(session: Session) -> dict[str, object]:
    try:
        ping(session)
    except SQLAlchemyError as exc:
        return {"ok": False, "detail": f"postgres error: {exc}"}
    return {"ok": True, "detail": "ok"}


def _build_control_plane_contract(
    state: object,
    *,
    hypothesis_summary: Mapping[str, Any] | None = None,
    dependency_quorum: JangarDependencyQuorumStatus | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    signal_lag_seconds = getattr(metrics, "signal_lag_seconds", None)
    no_signal_reason_streak = getattr(metrics, "no_signal_reason_streak", None)
    signal_staleness_alert_total = getattr(
        metrics, "signal_staleness_alert_total", None
    )
    signal_continuity_actionable = getattr(
        metrics, "signal_continuity_actionable", None
    )
    market_session_open = getattr(state, "market_session_open", None)
    last_run_at = getattr(state, "last_run_at", None)
    last_reconcile_at = getattr(state, "last_reconcile_at", None)
    summary: dict[str, Any] = dict(hypothesis_summary) if hypothesis_summary is not None else {}
    raw_state_totals = summary.get("state_totals")
    state_totals: dict[str, Any] = (
        dict(cast(Mapping[str, Any], raw_state_totals))
        if isinstance(raw_state_totals, Mapping)
        else {}
    )
    capital_stage_totals = (
        dict(cast(Mapping[str, Any], summary.get("capital_stage_totals", {})))
        if isinstance(summary.get("capital_stage_totals"), Mapping)
        else {}
    )
    return {
        "contract_version": "torghut.quant-producer.v1",
        "active_revision": _active_runtime_revision(),
        "signal_lag_seconds": signal_lag_seconds,
        "signal_continuity_state": getattr(state, "last_signal_continuity_state", None),
        "signal_continuity_reason": getattr(
            state, "last_signal_continuity_reason", None
        ),
        "signal_continuity_actionable": signal_continuity_actionable,
        "signal_continuity_alert_active": getattr(
            state, "signal_continuity_alert_active", None
        ),
        "signal_continuity_alert_reason": getattr(
            state, "signal_continuity_alert_reason", None
        ),
        "signal_continuity_alert_started_at": getattr(
            state, "signal_continuity_alert_started_at", None
        ),
        "signal_continuity_recovery_streak": getattr(
            state, "signal_continuity_recovery_streak", None
        ),
        "signal_continuity_promotion_block_total": getattr(
            metrics, "signal_continuity_promotion_block_total", None
        ),
        "market_session_open": market_session_open,
        "no_signal_reason_streak": no_signal_reason_streak,
        "signal_staleness_alert_total": signal_staleness_alert_total,
        "signal_expected_staleness_total": getattr(
            metrics, "signal_expected_staleness_total", None
        ),
        "signal_actionable_staleness_total": getattr(
            metrics, "signal_actionable_staleness_total", None
        ),
        "universe_status": getattr(state, "universe_source_status", None),
        "universe_reason": getattr(state, "universe_source_reason", None),
        "universe_symbols_count": getattr(state, "universe_symbols_count", None),
        "universe_cache_age_seconds": getattr(
            state, "universe_cache_age_seconds", None
        ),
        "universe_resolution_total": getattr(
            metrics, "universe_resolution_total", None
        ),
        "universe_fail_safe_blocked": getattr(
            state, "universe_fail_safe_blocked", None
        ),
        "universe_fail_safe_block_reason": getattr(
            state, "universe_fail_safe_block_reason", None
        ),
        "running": bool(getattr(state, "running", False)),
        "last_run_at": last_run_at,
        "last_reconcile_at": last_reconcile_at,
        "submission_block_total": getattr(metrics, "submission_block_total", None),
        "decision_state_total": getattr(metrics, "decision_state_total", None),
        "planned_decision_age_seconds": getattr(
            metrics, "planned_decision_age_seconds", None
        ),
        "last_autonomy_recommendation_trace_id": getattr(
            state, "last_autonomy_recommendation_trace_id", None
        ),
        "domain_telemetry_event_total": getattr(
            metrics, "domain_telemetry_event_total", None
        ),
        "domain_telemetry_dropped_total": getattr(
            metrics, "domain_telemetry_dropped_total", None
        ),
        "alpha_readiness_hypotheses_total": summary.get("hypotheses_total", 0),
        "alpha_readiness_blocked_total": state_totals.get("blocked", 0),
        "alpha_readiness_shadow_total": state_totals.get("shadow", 0),
        "alpha_readiness_canary_live_total": state_totals.get("canary_live", 0),
        "alpha_readiness_scaled_live_total": state_totals.get("scaled_live", 0),
        "capital_stage_totals": capital_stage_totals,
        "active_capital_stage": _resolve_active_capital_stage(summary),
        "alpha_readiness_promotion_eligible_total": summary.get(
            "promotion_eligible_total", 0
        ),
        "alpha_readiness_rollback_required_total": summary.get(
            "rollback_required_total", 0
        ),
        "alpha_readiness_dependency_quorum_decision": (
            dependency_quorum.decision if dependency_quorum is not None else "unknown"
        ),
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
        "market_context_required": settings.trading_market_context_required,
        "market_context_max_staleness_seconds": settings.trading_market_context_max_staleness_seconds,
    }


def _active_runtime_revision() -> str | None:
    revision = os.getenv("K_REVISION", "").strip()
    return revision or None


def _build_shadow_first_toggle_parity() -> dict[str, object]:
    return build_shadow_first_toggle_parity()


def _resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    return resolve_active_capital_stage(hypothesis_summary)


def _build_shadow_first_runtime_payload(
    *,
    state: object,
    hypothesis_summary: Mapping[str, Any] | None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    return {
        "active_revision": _active_runtime_revision(),
        "capital_stage": _resolve_active_capital_stage(hypothesis_summary),
        "capital_stage_totals": (
            dict(cast(Mapping[str, Any], hypothesis_summary.get("capital_stage_totals", {})))
            if isinstance(hypothesis_summary, Mapping)
            and isinstance(hypothesis_summary.get("capital_stage_totals"), Mapping)
            else {}
        ),
        "submission_block_total": dict(
            cast(
                Mapping[str, int],
                getattr(metrics, "submission_block_total", {}) or {},
            )
        ),
        "decision_state_total": dict(
            cast(Mapping[str, int], getattr(metrics, "decision_state_total", {}) or {})
        ),
        "planned_decision_age_seconds": getattr(
            metrics, "planned_decision_age_seconds", 0
        ),
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
    }


def _check_clickhouse() -> dict[str, object]:
    if not settings.trading_clickhouse_url:
        return {"ok": False, "detail": "clickhouse url missing"}
    query = "SELECT 1 FORMAT JSONEachRow"
    params = {"query": query}
    url = f"{settings.trading_clickhouse_url.rstrip('/')}/?{urlencode(params)}"
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return {
            "ok": False,
            "detail": f"clickhouse invalid url scheme: {scheme or 'missing'}",
        }
    if not parsed.hostname:
        return {"ok": False, "detail": "clickhouse invalid url host"}

    headers: dict[str, str] = {"Content-Type": "text/plain"}
    if settings.trading_clickhouse_username:
        headers["X-ClickHouse-User"] = settings.trading_clickhouse_username
    if settings.trading_clickhouse_password:
        headers["X-ClickHouse-Key"] = settings.trading_clickhouse_password

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    connection = connection_class(
        parsed.hostname,
        parsed.port,
        timeout=settings.trading_clickhouse_timeout_seconds,
    )

    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return {"ok": False, "detail": f"clickhouse http status {response.status}"}
        payload = response.read().decode("utf-8")
    except Exception as exc:  # pragma: no cover - depends on network
        return {"ok": False, "detail": f"clickhouse error: {exc}"}
    finally:
        connection.close()

    if not payload.strip():
        return {"ok": False, "detail": "clickhouse empty response"}
    return {"ok": True, "detail": "ok"}


def _http_json_request(
    *,
    url: str,
    timeout_seconds: int,
    method: str = "GET",
    body: dict[str, object] | None = None,
) -> dict[str, object]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return {"ok": False, "detail": f"invalid url scheme: {scheme or 'missing'}"}
    if not parsed.hostname:
        return {"ok": False, "detail": "invalid url host"}
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    payload_bytes = (
        json.dumps(body, separators=(",", ":")).encode("utf-8")
        if body is not None
        else None
    )
    headers = {"accept": "application/json"}
    if payload_bytes is not None:
        headers["content-type"] = "application/json"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port, timeout=max(timeout_seconds, 1))
    response: Any | None = None
    raw = ""
    try:
        connection.request(method, path, body=payload_bytes, headers=headers)
        response = connection.getresponse()
        raw = response.read().decode("utf-8")
    except Exception as exc:  # pragma: no cover - depends on network
        return {"ok": False, "detail": f"http error: {exc}"}
    finally:
        connection.close()
    if response is None:
        return {"ok": False, "detail": "missing response"}
    if response.status < 200 or response.status >= 300:
        return {
            "ok": False,
            "detail": f"http status {response.status}",
            "status_code": response.status,
            "body": raw[:200],
        }
    if not raw.strip():
        return {"ok": True, "payload": {}}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "detail": "invalid json response"}
    if not isinstance(payload, dict):
        return {"ok": False, "detail": "invalid payload shape"}
    return {"ok": True, "payload": cast(dict[str, object], payload)}


def _forecast_service_status() -> dict[str, object]:
    endpoint = settings.trading_forecast_service_url or ""
    if not endpoint:
        return {
            "configured": False,
            "endpoint": None,
            "status": "disabled",
            "authority": "blocked",
            "message": "forecast service not configured",
            "calibration_status": "unknown",
            "promotion_authority_eligible_models": [],
            "allowed_model_families": sorted(
                settings.trading_forecast_service_allowed_model_families
            ),
        }
    ready = _http_json_request(
        url=f"{endpoint.rstrip('/')}/readyz",
        timeout_seconds=settings.trading_forecast_service_timeout_seconds,
    )
    calibration = _http_json_request(
        url=f"{endpoint.rstrip('/')}/v1/calibration/report",
        timeout_seconds=settings.trading_forecast_service_timeout_seconds,
        method="POST",
        body={},
    )
    calibration_payload = (
        cast(dict[str, object], calibration.get("payload"))
        if calibration.get("ok") and isinstance(calibration.get("payload"), dict)
        else {}
    )
    models = (
        cast(list[object], calibration_payload.get("models"))
        if isinstance(calibration_payload.get("models"), list)
        else []
    )
    eligible_models = sorted(
        str(cast(dict[str, object], item).get("model_family") or "").strip()
        for item in models
        if isinstance(item, dict)
        and bool(cast(dict[str, object], item).get("promotion_authority_eligible"))
        and str(cast(dict[str, object], item).get("model_family") or "").strip()
    )
    healthy = bool(ready.get("ok"))
    authority = "empirical" if healthy and eligible_models else "blocked"
    return {
        "configured": True,
        "endpoint": endpoint,
        "status": "healthy" if healthy else "degraded",
        "authority": authority,
        "message": (
            "ok"
            if healthy
            else str(ready.get("detail") or "forecast service readiness failed")
        ),
        "calibration_status": str(calibration_payload.get("status") or "unknown"),
        "registry_ref": calibration_payload.get("registry_ref"),
        "promotion_authority_eligible_models": eligible_models,
        "allowed_model_families": sorted(
            settings.trading_forecast_service_allowed_model_families
        ),
        "require_healthy": settings.trading_forecast_service_require_healthy,
        "fail_mode": settings.trading_forecast_service_fail_mode,
    }


def _lean_authority_status() -> dict[str, object]:
    endpoint = settings.trading_lean_runner_url or ""
    if not endpoint:
        return {
            "configured": False,
            "endpoint": None,
            "status": "disabled",
            "authority": "blocked",
            "message": "LEAN runner not configured",
            "authoritative_modes": [],
        }
    ready = _http_json_request(
        url=f"{endpoint.rstrip('/')}/readyz",
        timeout_seconds=settings.trading_lean_runner_timeout_seconds,
    )
    observability = _http_json_request(
        url=f"{endpoint.rstrip('/')}/v1/observability",
        timeout_seconds=settings.trading_lean_runner_timeout_seconds,
    )
    observability_payload = (
        cast(dict[str, object], observability.get("payload"))
        if observability.get("ok") and isinstance(observability.get("payload"), dict)
        else {}
    )
    authority_payload = (
        cast(dict[str, object], observability_payload.get("authority"))
        if isinstance(observability_payload.get("authority"), dict)
        else {}
    )
    authoritative_modes = (
        [
            str(item).strip()
            for item in cast(list[object], authority_payload.get("authoritative_modes"))
            if str(item).strip()
        ]
        if isinstance(authority_payload.get("authoritative_modes"), list)
        else []
    )
    healthy = bool(ready.get("ok"))
    ready_payload = (
        cast(dict[str, object], ready.get("payload"))
        if isinstance(ready.get("payload"), dict)
        else {}
    )
    return {
        "configured": True,
        "endpoint": endpoint,
        "status": "healthy" if healthy else "degraded",
        "authority": "empirical" if healthy and authoritative_modes else "blocked",
        "message": "ok" if healthy else str(ready.get("detail") or "LEAN readiness failed"),
        "authoritative_modes": authoritative_modes,
        "deterministic_scaffold_enabled": bool(
            ready_payload.get("deterministic_scaffold_enabled", True)
        ),
    }


def _empirical_jobs_status() -> dict[str, object]:
    try:
        with SessionLocal() as session:
            return build_empirical_jobs_status(
                session=session,
                stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
            )
    except Exception as exc:
        return {
            "status": "degraded",
            "authority": "blocked",
            "stale_after_seconds": settings.trading_empirical_job_stale_after_seconds,
            "jobs": {},
            "message": f"empirical job status unavailable: {type(exc).__name__}",
        }


def _alpaca_endpoint_class(*, paper: bool | None = None) -> str:
    use_paper = settings.trading_mode != "live" if paper is None else paper
    return "paper" if use_paper else "live"


def _alpaca_failure_status(detail: str) -> str:
    message = detail.strip().lower()
    if "keys missing" in message:
        return "credentials_missing"
    if any(
        token in message
        for token in (
            "unauthorized",
            "forbidden",
            "invalid api",
            "authentication",
            "not authorized",
            "insufficient scope",
            "access key",
            "secret key",
            "credentials",
        )
    ):
        return "credentials_invalid"
    if any(
        token in message
        for token in (
            "timeout",
            "timed out",
            "deadline exceeded",
            "read timed out",
        )
    ):
        return "broker_slow"
    if any(
        token in message
        for token in (
            "connection refused",
            "connection reset",
            "name or service not known",
            "temporary failure in name resolution",
            "nodename nor servname",
            "network is unreachable",
            "no route to host",
            "failed to establish a new connection",
            "max retries exceeded",
            "dns",
        )
    ):
        return "network_unreachable"
    return "broker_error"


def _alpaca_probe_account(
    client: TorghutAlpacaClient,
    *,
    timeout_seconds: float,
) -> dict[str, object]:
    executor = ThreadPoolExecutor(max_workers=1)
    future = None
    try:
        future = executor.submit(client.get_account)
        account = future.result(timeout=timeout_seconds)
    except TimeoutError:
        if future is not None:
            future.cancel()
        return {
            "ok": False,
            "status": "broker_slow",
            "detail": f"alpaca account probe timed out after {timeout_seconds:.2f}s",
        }
    except Exception as exc:  # pragma: no cover - depends on network
        detail = str(exc).strip() or type(exc).__name__
        return {
            "ok": False,
            "status": _alpaca_failure_status(detail),
            "detail": detail,
        }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return {
        "ok": True,
        "status": "broker_ok",
        "detail": "ok",
        "account": account,
    }


def _remember_alpaca_success(
    *,
    account: Mapping[str, Any],
    endpoint_class: str,
) -> None:
    with _ALPACA_HEALTH_CACHE_LOCK:
        _ALPACA_HEALTH_STATE.clear()
        _ALPACA_HEALTH_STATE.update(
            {
                "last_ok_at": datetime.now(timezone.utc),
                "account_label": str(
                    account.get("account_number")
                    or settings.trading_account_label
                    or ""
                ).strip()
                or None,
                "account_status": str(account.get("status") or "").strip() or None,
                "endpoint_class": endpoint_class,
            }
        )


def _alpaca_cached_last_good(
    *,
    failure_status: str,
    failure_detail: str,
    endpoint_class: str,
) -> dict[str, object] | None:
    if failure_status not in {"broker_slow", "network_unreachable"}:
        return None
    ttl_seconds = max(0, settings.trading_alpaca_healthcheck_last_good_ttl_seconds)
    if ttl_seconds <= 0:
        return None
    with _ALPACA_HEALTH_CACHE_LOCK:
        last_ok_at = cast(datetime | None, _ALPACA_HEALTH_STATE.get("last_ok_at"))
        account_label = cast(str | None, _ALPACA_HEALTH_STATE.get("account_label"))
        account_status = cast(str | None, _ALPACA_HEALTH_STATE.get("account_status"))
        cached_endpoint_class = cast(
            str | None,
            _ALPACA_HEALTH_STATE.get("endpoint_class"),
        )
    if last_ok_at is None:
        return None
    age_seconds = max(
        0.0,
        round((datetime.now(timezone.utc) - last_ok_at).total_seconds(), 3),
    )
    if age_seconds > ttl_seconds:
        return None
    return {
        "ok": True,
        "detail": (
            f"{failure_detail}; using cached last known good Alpaca probe from "
            f"{last_ok_at.isoformat()}"
        ),
        "broker_status": failure_status,
        "endpoint_class": cached_endpoint_class or endpoint_class,
        "cache_used": True,
        "last_ok_at": last_ok_at.isoformat(),
        "cache_age_seconds": age_seconds,
        "account_label": account_label,
        "account_status": account_status,
    }


def _check_alpaca() -> dict[str, object]:
    if not settings.apca_api_key_id or not settings.apca_api_secret_key:
        return {
            "ok": False,
            "detail": "alpaca keys missing",
            "broker_status": "credentials_missing",
            "endpoint_class": _alpaca_endpoint_class(),
            "cache_used": False,
        }
    client = TorghutAlpacaClient()
    timeout_seconds = max(0.1, settings.trading_alpaca_healthcheck_timeout_seconds)
    retries = max(1, settings.trading_alpaca_healthcheck_retries)
    backoff_seconds = max(0.0, settings.trading_alpaca_healthcheck_backoff_seconds)
    endpoint_class = str(
        getattr(client, "endpoint_class", _alpaca_endpoint_class())
    ).strip() or _alpaca_endpoint_class()

    last_failure: dict[str, object] | None = None
    for attempt in range(retries):
        probe = _alpaca_probe_account(client, timeout_seconds=timeout_seconds)
        if bool(probe.get("ok")):
            account = cast(Mapping[str, Any], probe.get("account") or {})
            _remember_alpaca_success(
                account=account,
                endpoint_class=endpoint_class,
            )
            return {
                "ok": True,
                "detail": "ok",
                "broker_status": "broker_ok",
                "endpoint_class": endpoint_class,
                "cache_used": False,
                "account_label": str(
                    account.get("account_number")
                    or settings.trading_account_label
                    or ""
                ).strip()
                or None,
                "account_status": str(account.get("status") or "").strip() or None,
            }
        last_failure = probe
        if probe.get("status") == "credentials_invalid":
            break
        if attempt < retries - 1 and backoff_seconds > 0:
            time.sleep(backoff_seconds * float(attempt + 1))

    failure_status = str(last_failure.get("status") if last_failure else "broker_error")
    failure_detail = str(last_failure.get("detail") if last_failure else "alpaca probe failed")
    cached = _alpaca_cached_last_good(
        failure_status=failure_status,
        failure_detail=failure_detail,
        endpoint_class=endpoint_class,
    )
    if cached is not None:
        return cached
    return {
        "ok": False,
        "detail": failure_detail,
        "broker_status": failure_status,
        "endpoint_class": endpoint_class,
        "cache_used": False,
    }


def _tca_row_payload(row: ExecutionTCAMetric | None) -> dict[str, object] | None:
    if row is None:
        return None
    return {
        "arrival_price": row.arrival_price,
        "avg_fill_price": row.avg_fill_price,
        "slippage_bps": row.slippage_bps,
        "shortfall_notional": row.shortfall_notional,
        "expected_shortfall_bps_p50": row.expected_shortfall_bps_p50,
        "expected_shortfall_bps_p95": row.expected_shortfall_bps_p95,
        "realized_shortfall_bps": row.realized_shortfall_bps,
        "divergence_bps": row.divergence_bps,
        "simulator_version": row.simulator_version,
        "churn_qty": row.churn_qty,
        "churn_ratio": row.churn_ratio,
        "computed_at": row.computed_at,
    }


def _load_tca_summary(session: Session) -> dict[str, object]:
    return build_tca_gate_inputs(session=session)


def _build_hypothesis_runtime_payload(
    scheduler: TradingScheduler,
    *,
    tca_summary: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    registry = load_hypothesis_registry()
    dependency_quorum = load_jangar_dependency_quorum()
    items = compile_hypothesis_runtime_statuses(
        registry=registry,
        state=scheduler.state,
        tca_summary=tca_summary,
        market_context_status=market_context_status,
        jangar_dependency_quorum=dependency_quorum,
    )
    summary = summarize_hypothesis_runtime_statuses(
        items,
        registry=registry,
        dependency_quorum=dependency_quorum,
    )
    return (
        {
            "registry_loaded": registry.loaded,
            "registry_path": registry.path,
            "registry_errors": list(registry.errors),
            "dependency_quorum": dependency_quorum.as_payload(),
            "summary": summary,
            "items": items,
        },
        summary,
        dependency_quorum,
    )


def _build_live_submission_gate_payload(
    state: object,
    *,
    session: Session | None = None,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
    quant_health_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_live_submission_gate_payload(
        state,
        session=session,
        hypothesis_summary=hypothesis_summary,
        empirical_jobs_status=empirical_jobs_status,
        dspy_runtime_status=dspy_runtime_status,
        quant_health_status=quant_health_status,
    )


def _load_route_provenance_summary(session: Session) -> dict[str, object]:
    window_start = datetime.now(timezone.utc) - timedelta(hours=24)
    row = session.execute(
        select(
            func.count(Execution.id),
            func.count(Execution.id).filter(
                (Execution.execution_expected_adapter.is_(None))
                | (func.btrim(Execution.execution_expected_adapter) == "")
                | (Execution.execution_actual_adapter.is_(None))
                | (func.btrim(Execution.execution_actual_adapter) == "")
            ),
            func.count(Execution.id).filter(
                (func.lower(Execution.execution_expected_adapter) == "unknown")
                | (func.lower(Execution.execution_actual_adapter) == "unknown")
            ),
            func.count(Execution.id).filter(
                func.lower(Execution.execution_expected_adapter)
                != func.lower(Execution.execution_actual_adapter)
            ),
        ).where(Execution.created_at >= window_start)
    ).one()
    total = int(row[0] or 0)
    missing = int(row[1] or 0)
    unknown = int(row[2] or 0)
    mismatch = int(row[3] or 0)
    if total <= 0:
        return {
            "total": 0,
            "missing": 0,
            "unknown": 0,
            "mismatch": 0,
            "coverage_ratio": 0.0,
            "unknown_ratio": 0.0,
            "mismatch_ratio": 0.0,
        }
    safe_total = float(total)
    coverage = max(0.0, (total - missing) / safe_total)
    return {
        "total": total,
        "missing": missing,
        "unknown": unknown,
        "mismatch": mismatch,
        "coverage_ratio": coverage,
        "unknown_ratio": unknown / safe_total,
        "mismatch_ratio": mismatch / safe_total,
    }


def _aggregate_tca_rows(
    rows: Sequence[ExecutionTCAMetric],
) -> dict[str, list[dict[str, object]]]:
    by_strategy: dict[tuple[str, str], dict[str, object]] = {}
    by_symbol: dict[tuple[str, str, str], dict[str, object]] = {}
    for row in rows:
        strategy_key = str(row.strategy_id) if row.strategy_id else "unknown"
        account_key = row.alpaca_account_label or "unknown"
        symbol_key = row.symbol

        strategy_agg = by_strategy.setdefault(
            (strategy_key, account_key),
            _new_tca_aggregate(strategy_key, account_key),
        )
        symbol_agg = by_symbol.setdefault(
            (strategy_key, account_key, symbol_key),
            _new_tca_aggregate(strategy_key, account_key, symbol=symbol_key),
        )
        _update_tca_aggregate(strategy_agg, row)
        _update_tca_aggregate(symbol_agg, row)

    return {
        "strategy": _finalize_tca_aggregates(list(by_strategy.values())),
        "symbol": _finalize_tca_aggregates(list(by_symbol.values())),
    }


def _new_tca_aggregate(
    strategy_key: str,
    account_key: str,
    *,
    symbol: str | None = None,
) -> dict[str, object]:
    aggregate: dict[str, object] = {
        "strategy_id": strategy_key,
        "alpaca_account_label": account_key,
        "order_count": 0,
        "_slippage_sum": 0.0,
        "_slippage_count": 0,
        "_shortfall_sum": 0.0,
        "_shortfall_count": 0,
        "_churn_sum": 0.0,
        "_churn_count": 0,
    }
    if symbol is not None:
        aggregate["symbol"] = symbol
    return aggregate


def _update_tca_aggregate(
    aggregate: dict[str, object],
    row: ExecutionTCAMetric,
) -> None:
    aggregate["order_count"] = _tca_as_int(aggregate["order_count"]) + 1
    metric_updates = (
        ("slippage", row.slippage_bps),
        ("shortfall", row.shortfall_notional),
        ("churn", row.churn_ratio),
    )
    for prefix, metric_value in metric_updates:
        if metric_value is None:
            continue
        aggregate[f"_{prefix}_sum"] = _tca_as_float(
            aggregate[f"_{prefix}_sum"]
        ) + float(metric_value)
        aggregate[f"_{prefix}_count"] = _tca_as_int(aggregate[f"_{prefix}_count"]) + 1


def _finalize_tca_aggregates(
    aggregates: list[dict[str, object]],
) -> list[dict[str, object]]:
    payload: list[dict[str, object]] = []
    for aggregate in aggregates:
        slippage_count = _tca_as_int(aggregate.pop("_slippage_count"))
        slippage_sum = _tca_as_float(aggregate.pop("_slippage_sum"))
        shortfall_count = _tca_as_int(aggregate.pop("_shortfall_count"))
        shortfall_sum = _tca_as_float(aggregate.pop("_shortfall_sum"))
        churn_count = _tca_as_int(aggregate.pop("_churn_count"))
        churn_sum = _tca_as_float(aggregate.pop("_churn_sum"))
        aggregate["avg_slippage_bps"] = (
            (slippage_sum / slippage_count) if slippage_count else None
        )
        aggregate["avg_shortfall_notional"] = (
            (shortfall_sum / shortfall_count) if shortfall_count else None
        )
        aggregate["avg_churn_ratio"] = (
            (churn_sum / churn_count) if churn_count else None
        )
        payload.append(aggregate)
    return payload


def _tca_as_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _tca_as_float(value: object) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _load_runtime_profitability_decisions(
    session: Session,
    window_start: datetime,
) -> tuple[list[dict[str, object]], int]:
    stmt = (
        select(TradeDecision, Strategy.name)
        .join(Strategy, TradeDecision.strategy_id == Strategy.id, isouter=True)
        .where(TradeDecision.created_at >= window_start)
    )
    rows = session.execute(stmt).all()
    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for decision, strategy_name in rows:
        strategy_id = str(decision.strategy_id)
        symbol = decision.symbol
        status = str(decision.status or "unknown").strip() or "unknown"
        bucket = grouped.setdefault(
            (strategy_id, symbol),
            {
                "strategy_id": strategy_id,
                "strategy_name": strategy_name,
                "symbol": symbol,
                "decision_count": 0,
                "executed_count": 0,
                "status_counts": {},
                "last_decision_at": None,
                "last_executed_at": None,
            },
        )
        bucket["decision_count"] = _safe_int(bucket.get("decision_count")) + 1
        status_counts = cast(dict[str, int], bucket["status_counts"])
        status_counts[status] = status_counts.get(status, 0) + 1
        if decision.executed_at is not None:
            bucket["executed_count"] = _safe_int(bucket.get("executed_count")) + 1
            previous_executed_at = cast(datetime | None, bucket.get("last_executed_at"))
            if (
                previous_executed_at is None
                or decision.executed_at > previous_executed_at
            ):
                bucket["last_executed_at"] = decision.executed_at
        previous_created_at = cast(datetime | None, bucket.get("last_decision_at"))
        if previous_created_at is None or decision.created_at > previous_created_at:
            bucket["last_decision_at"] = decision.created_at

    payload = sorted(
        grouped.values(),
        key=lambda item: (
            str(item.get("strategy_id") or ""),
            str(item.get("symbol") or ""),
        ),
    )
    return payload, len(rows)


def _load_runtime_profitability_executions(
    session: Session,
    window_start: datetime,
) -> tuple[list[dict[str, object]], int, dict[str, int]]:
    executions = (
        session.execute(select(Execution).where(Execution.created_at >= window_start))
        .scalars()
        .all()
    )
    grouped: dict[tuple[str, str], dict[str, object]] = {}
    fallback_reason_totals: dict[str, int] = {}
    for execution in executions:
        expected_adapter = _normalized_adapter_name(
            execution.execution_expected_adapter
        )
        actual_adapter = _normalized_adapter_name(execution.execution_actual_adapter)
        fallback_reason = (
            str(execution.execution_fallback_reason).strip()
            if execution.execution_fallback_reason is not None
            else ""
        )
        fallback_count = max(0, int(execution.execution_fallback_count or 0))
        fallback_applied = bool(
            fallback_reason or fallback_count > 0 or expected_adapter != actual_adapter
        )
        status = str(execution.status or "unknown").strip() or "unknown"

        bucket = grouped.setdefault(
            (expected_adapter, actual_adapter),
            {
                "expected_adapter": expected_adapter,
                "actual_adapter": actual_adapter,
                "execution_count": 0,
                "fallback_execution_count": 0,
                "fallback_count_total": 0,
                "fallback_reason_counts": {},
                "status_counts": {},
                "last_execution_at": None,
            },
        )
        bucket["execution_count"] = _safe_int(bucket.get("execution_count")) + 1
        if fallback_applied:
            bucket["fallback_execution_count"] = (
                _safe_int(bucket.get("fallback_execution_count")) + 1
            )
        bucket["fallback_count_total"] = (
            _safe_int(bucket.get("fallback_count_total")) + fallback_count
        )
        status_counts = cast(dict[str, int], bucket["status_counts"])
        status_counts[status] = status_counts.get(status, 0) + 1
        previous_created_at = cast(datetime | None, bucket.get("last_execution_at"))
        if previous_created_at is None or execution.created_at > previous_created_at:
            bucket["last_execution_at"] = execution.created_at

        if fallback_reason:
            reason_counts = cast(dict[str, int], bucket["fallback_reason_counts"])
            reason_counts[fallback_reason] = reason_counts.get(fallback_reason, 0) + 1
            fallback_reason_totals[fallback_reason] = (
                fallback_reason_totals.get(fallback_reason, 0) + 1
            )

    payload = sorted(
        grouped.values(),
        key=lambda item: (
            str(item.get("expected_adapter") or ""),
            str(item.get("actual_adapter") or ""),
        ),
    )
    return payload, len(executions), dict(sorted(fallback_reason_totals.items()))


def _load_runtime_profitability_realized_pnl_summary(
    session: Session,
    window_start: datetime,
) -> dict[str, object]:
    rows = (
        session.execute(
            select(ExecutionTCAMetric).where(
                ExecutionTCAMetric.computed_at >= window_start
            )
        )
        .scalars()
        .all()
    )
    shortfall_total = Decimal("0")
    realized_shortfall_values: list[Decimal] = []
    adverse_proxy_values: list[Decimal] = []
    by_symbol: dict[str, dict[str, object]] = {}
    for row in rows:
        shortfall = row.shortfall_notional
        if shortfall is not None:
            shortfall_total += shortfall
            symbol_bucket = by_symbol.setdefault(
                row.symbol,
                {
                    "symbol": row.symbol,
                    "samples": 0,
                    "shortfall_notional_total": Decimal("0"),
                },
            )
            symbol_bucket["samples"] = _safe_int(symbol_bucket.get("samples")) + 1
            symbol_bucket["shortfall_notional_total"] = (
                cast(Decimal, symbol_bucket["shortfall_notional_total"]) + shortfall
            )

        realized_shortfall = row.realized_shortfall_bps
        if realized_shortfall is not None:
            realized_shortfall_values.append(realized_shortfall)
            adverse_proxy_values.append(abs(realized_shortfall))
        elif row.slippage_bps is not None:
            adverse_proxy_values.append(abs(row.slippage_bps))

    by_symbol_payload: list[dict[str, object]] = []
    for symbol_key in sorted(by_symbol):
        symbol_row = by_symbol[symbol_key]
        by_symbol_payload.append(
            {
                "symbol": symbol_row["symbol"],
                "samples": symbol_row["samples"],
                "shortfall_notional_total": _decimal_to_string(
                    cast(Decimal, symbol_row["shortfall_notional_total"])
                ),
            }
        )

    return {
        "tca_sample_count": len(rows),
        "realized_pnl_proxy_notional": _decimal_to_string(-shortfall_total),
        "shortfall_notional_total": _decimal_to_string(shortfall_total),
        "avg_realized_shortfall_bps": _decimal_to_string(
            _decimal_average(realized_shortfall_values)
        ),
        "adverse_excursion_proxy_bps_p95": _decimal_to_string(
            _decimal_percentile(adverse_proxy_values, 95)
        ),
        "adverse_excursion_proxy_bps_max": _decimal_to_string(
            max(adverse_proxy_values) if adverse_proxy_values else None
        ),
        "by_symbol": by_symbol_payload,
    }


def _load_runtime_profitability_gate_rollback_attribution(
    state: object,
) -> dict[str, object]:
    gate_artifact_path = str(getattr(state, "last_autonomy_gates", "") or "").strip()
    gate_payload = _load_json_artifact_payload(gate_artifact_path)
    actuation_artifact_path = str(
        getattr(state, "last_autonomy_actuation_intent", "") or ""
    ).strip()
    actuation_payload = _load_json_artifact_payload(actuation_artifact_path)
    gate6 = _extract_gate_result(
        cast(list[object], gate_payload.get("gates") or []),
        gate_id="gate6_profitability_evidence",
    )

    promotion_decision = _to_str_map(gate_payload.get("promotion_decision"))
    promotion_recommendation = _to_str_map(gate_payload.get("promotion_recommendation"))
    provenance = _to_str_map(gate_payload.get("provenance"))
    actuation_gates = _to_str_map(actuation_payload.get("gates"))
    actuation_root = _to_str_map(actuation_payload)
    actuation_audit = _to_str_map(actuation_payload.get("audit"))
    actuation_readiness = _to_str_map(actuation_audit.get("rollback_readiness_readout"))

    def _optional_trace_id(value: object) -> str | None:
        if value is None:
            return None
        trace_id = str(value).strip()
        return trace_id or None

    actuation_trace = _optional_trace_id(
        actuation_gates.get("gate_report_trace_id")
        or provenance.get("gate_report_trace_id")
    )
    actuation_recommendation_trace = _optional_trace_id(
        actuation_gates.get("recommendation_trace_id")
        or provenance.get("recommendation_trace_id")
    )

    actuation_artifact_refs_raw = actuation_payload.get("artifact_refs")
    actuation_artifact_refs = (
        [str(item) for item in cast(list[object], actuation_artifact_refs_raw)]
        if isinstance(actuation_artifact_refs_raw, list)
        else []
    )
    actuation_artifact_refs = [item for item in actuation_artifact_refs if item.strip()]

    rollback_evidence_path = str(
        getattr(state, "rollback_incident_evidence_path", "") or ""
    ).strip()
    rollback_payload = _load_json_artifact_payload(rollback_evidence_path)
    rollback_reasons_raw = rollback_payload.get("reasons")
    rollback_reasons = (
        [
            str(item)
            for item in cast(list[object], rollback_reasons_raw)
            if str(item).strip()
        ]
        if isinstance(rollback_reasons_raw, list)
        else []
    )
    rollback_verification = _to_str_map(rollback_payload.get("verification"))
    metrics = getattr(state, "metrics", None)
    return {
        "gate_report_artifact": gate_artifact_path or None,
        "gate_report_run_id": (
            str(
                actuation_payload.get("run_id") or gate_payload.get("run_id") or ""
            ).strip()
            or None
        ),
        "gate_report_trace_id": (
            actuation_trace
            if actuation_trace
            else _optional_trace_id(provenance.get("gate_report_trace_id"))
        ),
        "recommendation_trace_id": (
            actuation_recommendation_trace
            if actuation_recommendation_trace
            else _optional_trace_id(provenance.get("recommendation_trace_id"))
        ),
        "gate6_profitability_evidence": gate6,
        "promotion_decision": {
            "promotion_target": promotion_decision.get("promotion_target"),
            "recommended_mode": promotion_decision.get("recommended_mode"),
            "promotion_allowed": promotion_decision.get("promotion_allowed"),
            "reason_codes": promotion_decision.get("reason_codes"),
            "promotion_gate_artifact": promotion_decision.get(
                "promotion_gate_artifact"
            ),
            "recommendation_action": promotion_recommendation.get("action"),
        },
        "profitability_artifacts": {
            "benchmark": provenance.get("profitability_benchmark_artifact"),
            "evidence": provenance.get("profitability_evidence_artifact"),
            "validation": provenance.get("profitability_validation_artifact"),
        },
        "actuation_intent": {
            "artifact_path": actuation_artifact_path or None,
            "actuation_allowed": bool(actuation_root.get("actuation_allowed")),
            "recommendation_trace_id": (
                str(actuation_gates.get("recommendation_trace_id") or "").strip()
                or None
            ),
            "gate_report_trace_id": (
                str(actuation_gates.get("gate_report_trace_id") or "").strip() or None
            ),
            "promotion_target": actuation_root.get("promotion_target"),
            "recommended_mode": actuation_root.get("recommended_mode"),
            "confirmation_phrase_required": bool(
                actuation_root.get("confirmation_phrase_required")
            ),
            "rollback_readiness": {
                "kill_switch_dry_run_passed": bool(
                    actuation_readiness.get("kill_switch_dry_run_passed")
                ),
                "gitops_revert_dry_run_passed": bool(
                    actuation_readiness.get("gitops_revert_dry_run_passed")
                ),
                "strategy_disable_dry_run_passed": bool(
                    actuation_readiness.get("strategy_disable_dry_run_passed")
                ),
                "human_approved": bool(actuation_readiness.get("human_approved")),
                "rollback_target": actuation_readiness.get("rollback_target"),
                "dry_run_completed_at": actuation_readiness.get("dry_run_completed_at"),
                "missing_checks": actuation_audit.get(
                    "rollback_evidence_missing_checks"
                ),
                "evidence_links": sorted(set(actuation_artifact_refs)),
            },
        },
        "rollback": {
            "emergency_stop_active": bool(
                getattr(state, "emergency_stop_active", False)
            ),
            "emergency_stop_reason": getattr(state, "emergency_stop_reason", None),
            "incidents_total": _safe_int(getattr(state, "rollback_incidents_total", 0)),
            "incident_evidence_path": rollback_evidence_path or None,
            "incident_reason_codes": rollback_reasons,
            "incident_evidence_complete": rollback_verification.get(
                "incident_evidence_complete"
            ),
            "signal_continuity_promotion_block_total": _safe_int(
                getattr(metrics, "signal_continuity_promotion_block_total", 0)
            ),
        },
    }


def _build_autonomy_bridge_status(
    scheduler: TradingScheduler,
) -> dict[str, object]:
    gate_artifact_path = str(getattr(scheduler.state, "last_autonomy_gates", "") or "").strip()
    gate_payload = _load_json_artifact_payload(gate_artifact_path)
    actuation_artifact_path = str(
        getattr(scheduler.state, "last_autonomy_actuation_intent", "") or ""
    ).strip()
    actuation_payload = _load_json_artifact_payload(actuation_artifact_path)
    actuation_gates = _to_str_map(actuation_payload.get("gates"))
    provenance_payload = _to_str_map(gate_payload.get("provenance"))
    drift_path = str(getattr(scheduler.state, "drift_last_outcome_path", "") or "").strip()
    drift_payload = _load_json_artifact_payload(drift_path)
    drift_reasons_raw = drift_payload.get("reasons")
    drift_reason_codes_raw = drift_payload.get("reason_codes")
    drift_eligible = drift_payload.get("eligible_for_live_promotion")
    metrics_payload = _to_str_map(gate_payload.get("metrics"))
    drawdown = None
    max_drawdown_raw = metrics_payload.get("max_drawdown")
    if max_drawdown_raw is not None:
        try:
            drawdown = abs(float(str(max_drawdown_raw)))
        except (TypeError, ValueError):
            drawdown = None

    if not gate_payload:
        return {
            "source": "unavailable",
            "run_id": str(gate_payload.get("run_id") or "").strip() or None,
            "strategy_compilation": {
                "total": 0,
                "spec_compiled": 0,
                "compiler_sources": [],
            },
            "simulation_calibration": None,
            "shadow_live_deviation": None,
        "evidence_authority": {
            "gate_report_trace_id": None,
            "recommendation_trace_id": None,
            "authoritative_count": 0,
            "total_count": 0,
            "missing": [],
        },
        "persisted_vnext_objects": None,
    }

    source = "gate_report"
    if (
        str(gate_payload.get("status") or "").strip() == "skipped"
        and str(gate_payload.get("dataset_snapshot_ref") or "").strip()
        == "no_signal_window"
    ):
        source = "no_signal"

    promotion_evidence_raw = gate_payload.get("promotion_evidence")
    promotion_evidence = (
        cast(dict[str, object], promotion_evidence_raw)
        if isinstance(promotion_evidence_raw, dict)
        else {}
    )
    dependency_quorum_payload = (
        cast(dict[str, object], gate_payload.get("dependency_quorum"))
        if isinstance(gate_payload.get("dependency_quorum"), dict)
        else {}
    )
    alpha_readiness_payload = (
        cast(dict[str, object], gate_payload.get("alpha_readiness"))
        if isinstance(gate_payload.get("alpha_readiness"), dict)
        else {}
    )
    authority_raw = provenance_payload.get("promotion_evidence_authority")
    authority_payload = (
        cast(dict[str, object], authority_raw)
        if isinstance(authority_raw, dict)
        else {}
    )
    vnext_raw = gate_payload.get("vnext")
    vnext_payload = cast(dict[str, object], vnext_raw) if isinstance(vnext_raw, dict) else {}
    strategy_compilation_raw = vnext_payload.get("strategy_compilation")
    portfolio_promotion_raw = vnext_payload.get("portfolio_promotion")
    strategy_compilation_items = (
        [
            cast(dict[str, object], item)
            for item in cast(list[object], strategy_compilation_raw)
            if isinstance(item, dict)
        ]
        if isinstance(strategy_compilation_raw, list)
        else []
    )
    spec_compiled = sum(
        1 for item in strategy_compilation_items if bool(item.get("spec_compiled"))
    )
    compiler_sources = sorted(
        {
            str(item.get("compiler_source") or "").strip()
            for item in strategy_compilation_items
            if str(item.get("compiler_source") or "").strip()
        }
    )

    authoritative_count = 0
    missing_authority: list[str] = []
    for evidence_name in promotion_evidence:
        authority_value = authority_payload.get(evidence_name)
        if not isinstance(authority_value, Mapping):
            missing_authority.append(str(evidence_name))
            continue
        if bool(cast(Mapping[object, object], authority_value).get("authoritative")):
            authoritative_count += 1

    return {
        "source": source,
        "run_id": str(gate_payload.get("run_id") or "").strip()
        or None,
        "strategy_compilation": {
            "total": len(strategy_compilation_items),
            "spec_compiled": spec_compiled,
            "compiler_sources": compiler_sources,
        },
        "dependency_quorum": (
            dependency_quorum_payload if dependency_quorum_payload else None
        ),
        "alpha_readiness": (
            alpha_readiness_payload if alpha_readiness_payload else None
        ),
        "portfolio_promotion": (
            cast(dict[str, object], portfolio_promotion_raw)
            if isinstance(portfolio_promotion_raw, dict)
            else None
        ),
        "simulation_calibration": (
            promotion_evidence.get("simulation_calibration")
            if isinstance(promotion_evidence.get("simulation_calibration"), dict)
            else None
        ),
        "shadow_live_deviation": {
            **(
                cast(dict[str, object], promotion_evidence.get("shadow_live_deviation"))
                if isinstance(promotion_evidence.get("shadow_live_deviation"), dict)
                else {}
            ),
            "drift_status": getattr(scheduler.state, "drift_status", None),
            "eligible_for_live_promotion": (
                bool(drift_eligible) if drift_eligible is not None else None
            ),
            "reason_codes": (
                [
                    str(item)
                    for item in cast(list[object], drift_reason_codes_raw)
                    if str(item).strip()
                ]
                if isinstance(drift_reason_codes_raw, list)
                else []
            ),
            "reasons": (
                [
                    str(item)
                    for item in cast(list[object], drift_reasons_raw)
                    if str(item).strip()
                ]
                if isinstance(drift_reasons_raw, list)
                else []
            ),
            "max_drawdown": drawdown,
        }
        if source == "gate_report"
        else None,
        "evidence_authority": {
            "gate_report_trace_id": str(
                provenance_payload.get("gate_report_trace_id")
                or actuation_gates.get("gate_report_trace_id")
                or ""
            ).strip()
            or None,
            "recommendation_trace_id": str(
                provenance_payload.get("recommendation_trace_id")
                or actuation_gates.get("recommendation_trace_id")
                or ""
            ).strip()
            or None,
            "authoritative_count": authoritative_count,
            "total_count": len(promotion_evidence),
            "missing": sorted(set(missing_authority)),
        },
        "persisted_vnext_objects": _build_persisted_vnext_status(
            str(gate_payload.get("run_id") or "").strip() or None
        ),
    }


def _build_persisted_vnext_status(run_id: str | None) -> dict[str, object] | None:
    if not run_id:
        return None
    try:
        with SessionLocal() as session:
            dataset_snapshots = session.execute(
                select(func.count(VNextDatasetSnapshot.id)).where(
                    VNextDatasetSnapshot.run_id == run_id
                )
            ).scalar_one()
            feature_view_specs = session.execute(
                select(func.count(VNextFeatureViewSpec.id)).where(
                    VNextFeatureViewSpec.run_id == run_id
                )
            ).scalar_one()
            model_artifacts = session.execute(
                select(func.count(VNextModelArtifact.id)).where(
                    VNextModelArtifact.run_id == run_id
                )
            ).scalar_one()
            experiment_specs = session.execute(
                select(func.count(VNextExperimentSpec.id)).where(
                    VNextExperimentSpec.run_id == run_id
                )
            ).scalar_one()
            experiment_runs = session.execute(
                select(func.count(VNextExperimentRun.id)).where(
                    VNextExperimentRun.run_id == run_id
                )
            ).scalar_one()
            simulation_calibrations = session.execute(
                select(func.count(VNextSimulationCalibration.id)).where(
                    VNextSimulationCalibration.run_id == run_id
                )
            ).scalar_one()
            shadow_live_deviations = session.execute(
                select(func.count(VNextShadowLiveDeviation.id)).where(
                    VNextShadowLiveDeviation.run_id == run_id
                )
            ).scalar_one()
            promotion_decisions = session.execute(
                select(func.count(VNextPromotionDecision.id)).where(
                    VNextPromotionDecision.run_id == run_id
                )
            ).scalar_one()
    except Exception:
        return None

    return {
        "dataset_snapshots": int(dataset_snapshots),
        "feature_view_specs": int(feature_view_specs),
        "model_artifacts": int(model_artifacts),
        "experiment_specs": int(experiment_specs),
        "experiment_runs": int(experiment_runs),
        "simulation_calibrations": int(simulation_calibrations),
        "shadow_live_deviations": int(shadow_live_deviations),
        "promotion_decisions_v2": int(promotion_decisions),
    }


def _load_json_artifact_payload(path: str) -> dict[str, object]:
    if not path:
        return {}
    if "://" in path and not path.startswith("file://"):
        return {}
    resolved = Path(path.replace("file://", "", 1))
    if not resolved.exists() or not resolved.is_file():
        return {}
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(payload, dict):
        return cast(dict[str, object], payload)
    return {}


def _extract_gate_result(gates: list[object], *, gate_id: str) -> dict[str, object]:
    for raw_gate in gates:
        if not isinstance(raw_gate, Mapping):
            continue
        gate = cast(Mapping[object, object], raw_gate)
        gate_name = str(gate.get("gate_id") or "").strip()
        if gate_name != gate_id:
            continue
        reasons_raw = gate.get("reasons")
        artifact_refs_raw = gate.get("artifact_refs")
        return {
            "gate_id": gate_name,
            "status": str(gate.get("status") or "unknown").strip() or "unknown",
            "reasons": (
                [
                    str(item)
                    for item in cast(list[object], reasons_raw)
                    if str(item).strip()
                ]
                if isinstance(reasons_raw, list)
                else []
            ),
            "artifact_refs": (
                [
                    str(item)
                    for item in cast(list[object], artifact_refs_raw)
                    if str(item).strip()
                ]
                if isinstance(artifact_refs_raw, list)
                else []
            ),
        }
    return {
        "gate_id": gate_id,
        "status": "unknown",
        "reasons": [],
        "artifact_refs": [],
    }


def _to_str_map(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    source = cast(Mapping[object, object], value)
    return {str(key): item for key, item in source.items()}


def _normalized_adapter_name(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized or "unknown"


def _decimal_average(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _decimal_percentile(values: list[Decimal], percentile: int) -> Decimal | None:
    if not values:
        return None
    bounded = max(1, min(100, percentile))
    ordered = sorted(values)
    index = ((len(ordered) * bounded) + 99) // 100 - 1
    if index < 0:
        index = 0
    return ordered[index]


def _decimal_to_string(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    if "." not in text:
        return text
    normalized = text.rstrip("0").rstrip(".")
    return normalized or "0"


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _safe_float(value: object) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _load_llm_evaluation(session: Session) -> dict[str, object]:
    try:
        return build_llm_evaluation_metrics(session)
    except SQLAlchemyError:
        return {"ok": False, "error": "database_unavailable"}
