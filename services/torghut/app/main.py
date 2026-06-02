"""torghut FastAPI application entrypoint."""

import json
import logging
import os
import time
from collections.abc import Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from copy import deepcopy
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
from sqlalchemy import bindparam, func, select, text
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
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyRuntimeLedgerBucket,
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
from .trading.alpha_closure_dividend_slo import build_alpha_closure_dividend_slo
from .trading.alpha_evidence_foundry import compact_alpha_evidence_foundry
from .trading.alpha_readiness_settlement_conveyor import (
    compact_alpha_readiness_settlement_conveyor,
)
from .trading.alpha_repair_dividend_ledger import (
    compact_alpha_repair_dividend_ledger,
)
from .trading.alpha_repair_closure_board import compact_alpha_repair_closure_board
from .trading.autonomy import (
    assert_runtime_gate_policy_contract,
    evaluate_evidence_continuity,
)
from .trading.autoresearch_routes import router as autoresearch_router
from .trading.capital_reentry_cohorts import build_capital_reentry_cohort_ledger
from .trading.completion import build_doc29_completion_status
from .trading.consumer_evidence import (
    build_route_proven_profit_receipt,
    build_torghut_consumer_evidence_receipt,
)
from .trading.clock_settlement import build_clock_settlement_receipt
from .trading.empirical_jobs import build_empirical_jobs_status
from .trading.evidence_clock_arbiter import (
    build_evidence_clock_arbiter_and_exchange,
)
from .trading.evidence_epochs import (
    EvidenceEpoch,
    compile_evidence_epoch,
    load_evidence_epoch_payload,
    load_latest_evidence_epoch_payload,
    persist_evidence_epoch,
)
from .trading.evidence_receipts import (
    EvidenceReceipt,
    build_artifact_parity_receipt,
    build_data_freshness_receipt,
    build_empirical_jobs_receipt,
    build_jangar_authority_receipt,
    build_portfolio_proof_receipt,
    build_schema_receipt,
    build_service_health_receipt,
)
from .trading.executable_alpha_receipts import (
    build_capital_replay_projection,
    compact_executable_alpha_settlement_slots,
)
from .trading.feature_quality import (
    FeatureQualityThresholds,
    evaluate_feature_batch_quality,
)
from .trading.forecast_runtime import forecast_status_from_empirical_jobs
from .trading.freshness_carry import build_freshness_carry_ledger
from .trading.hypotheses import (
    JangarDependencyQuorumStatus,
    hypothesis_registry_requires_dependency_capability,
    load_jangar_dependency_quorum,
    load_hypothesis_registry,
    resolve_hypothesis_dependency_quorum,
    validate_hypothesis_registry_from_settings,
)
from .trading.jangar_continuity import load_jangar_route_continuity_packet
from .trading.jangar_controller_ingestion_carry import (
    compact_jangar_controller_ingestion_carry,
)
from .trading.lean_lanes import LeanLaneManager
from .trading.lean_runtime import lean_authority_status
from .trading.llm.evaluation import build_llm_evaluation_metrics
from .trading.no_delta_repair_reentry_auction import (
    compact_no_delta_repair_reentry_auction,
)
from .trading.profit_carry_passports import build_profit_carry_passport_ledger
from .trading.profit_freshness_frontier import build_profit_freshness_frontier
from .trading.profit_repair_settlement import build_profit_repair_settlement_ledger
from .trading.profit_signal_quorum import build_profit_signal_quorum
from .trading.paper_route_target_plan import (
    mapping_items as _shared_mapping_items,
    paper_route_target_plan_from_payload as _shared_paper_route_target_plan_from_payload,
)
from .trading.paper_route_evidence import (
    DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    build_paper_route_evidence_audit,
    build_paper_route_target_plan_payload,
)
from .trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
)
from .trading.runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
    runtime_ledger_promotion_source_authority_blockers,
)
from .trading.proof_floor import build_profitability_proof_floor_receipt
from .trading.quality_adjusted_profit_frontier import (
    build_quality_adjusted_profit_frontier,
)
from .trading.renewal_bond_profit_escrow import build_renewal_bond_profit_escrow
from .trading.revenue_repair import build_revenue_repair_digest
from .trading.repair_bid_settlement import build_repair_bid_settlement_ledger
from .trading.repair_outcome_dividend import (
    build_repair_outcome_dividend_ledger,
)
from .trading.repair_receipt_frontier import build_repair_receipt_frontier
from .trading.route_evidence_clearinghouse import (
    build_route_evidence_clearinghouse_packet,
)
from .trading.route_warrant_exchange import build_route_warrant_exchange
from .trading.routeability_repair_acceptance import (
    build_routeability_repair_acceptance_ledger,
)
from .trading.route_reacquisition_board import build_route_reacquisition_board
from .trading.source_serving_repair_receipt import (
    build_source_serving_repair_receipt_ledger,
)
from .trading.submission_council import (
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    build_shadow_first_toggle_parity,
    load_quant_evidence_status,
    resolve_active_capital_stage,
)
from .trading.ingest import ClickHouseSignalIngestor
from .trading.models import SignalEnvelope
from .trading.tca import build_tca_gate_inputs, refresh_execution_tca_metrics
from .trading.simulation_progress import (
    active_simulation_runtime_context,
    simulation_progress_snapshot,
)
from .trading.time_source import trading_time_status
from .trading.tigerbeetle_client import check_tigerbeetle_health
from .trading.tigerbeetle_reconcile import (
    BLOCKER_RECONCILIATION_STALE,
    latest_tigerbeetle_reconciliation_payload,
    tigerbeetle_ref_counts,
)
from .trading.zero_notional_repair_executor import run_zero_notional_repair
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
BUILD_SOURCE_CI_REF = os.getenv("TORGHUT_SOURCE_CI_REF", "").strip() or None
BUILD_MANIFEST_COMMIT = os.getenv("TORGHUT_MANIFEST_COMMIT", "").strip() or None
BUILD_MANIFEST_IMAGE_DIGEST = (
    os.getenv("TORGHUT_MANIFEST_IMAGE_DIGEST", "").strip() or BUILD_IMAGE_DIGEST
)
BUILD_ARGO_SYNC_REVISION = os.getenv("TORGHUT_ARGO_SYNC_REVISION", "").strip() or None
BUILD_ARGO_HEALTH = os.getenv("TORGHUT_ARGO_HEALTH", "").strip() or None
RUNTIME_PROFITABILITY_LOOKBACK_HOURS = 72
RUNTIME_PROFITABILITY_SCHEMA_VERSION = "torghut.runtime-profitability.v1"
PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS = 86_400
CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE = (
    "Jangar dependency quorum is evaluated by the calling control plane; "
    "Torghut omits the recursive control-plane status fetch for consumer evidence."
)
LEAN_LANE_MANAGER = LeanLaneManager()
WHITEPAPER_WORKFLOW = WhitepaperWorkflowService()
_TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = Lock()
_TRADING_DEPENDENCY_HEALTH_CACHE: dict[str, dict[str, object]] = {}
_TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 3.0
_TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="torghut-health-surface",
)
_TRADING_HEALTH_SURFACE_EVALUATION_LOCK = Lock()
_TRADING_HEALTH_SURFACE_EVALUATIONS: dict[
    str,
    Future[tuple[dict[str, object], int]],
] = {}
_TRADING_HEALTH_SURFACE_PAYLOAD_CACHE: dict[str, dict[str, object]] = {}
_OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK = Lock()
_OPTIONS_CATALOG_FRESHNESS_CACHE: dict[
    tuple[str, ...], tuple[datetime, dict[str, object]]
] = {}
_ALPACA_HEALTH_CACHE_LOCK = Lock()
_ALPACA_HEALTH_STATE: dict[str, object] = {}
_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = 600
_PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = Lock()
_PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = "TORGHUT_SIM"
_paper_route_target_plan_success_cache: tuple[dict[str, Any], float] | None = None


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
            scheduler_detail = f"trading loop starting (within {startup_grace_seconds}s readiness grace)"
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


app = FastAPI(title="torghut", lifespan=lifespan)
app.state.settings = settings
app.state.whitepaper_inngest_registered = False
app.include_router(autoresearch_router)
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
async def healthz() -> dict[str, str]:
    """Liveness endpoint for Kubernetes/Knative probes."""

    return {"status": "ok", "service": "torghut"}


def _readiness_dependency_cache_key(include_database_contract: bool) -> str:
    trading_mode = int(settings.trading_enabled)
    cache_mode = int(settings.trading_readiness_dependency_cache_enabled)
    tigerbeetle_mode = ":".join(
        str(int(value))
        for value in (
            settings.tigerbeetle_enabled,
            settings.tigerbeetle_required,
            settings.tigerbeetle_reconcile_required,
            settings.tigerbeetle_reconcile_max_age_seconds,
        )
    )
    return f"readyz:{trading_mode}:{cache_mode}:{int(include_database_contract)}:{tigerbeetle_mode}"


def _readiness_dependency_checks(
    session: Session,
    *,
    include_database_contract: bool,
) -> tuple[dict[str, object], datetime]:
    if settings.trading_enabled:
        clickhouse_status = _check_clickhouse()
        alpaca_status = _check_alpaca()
    else:
        clickhouse_status = {"ok": True, "detail": "skipped (trading disabled)"}
        alpaca_status = {"ok": True, "detail": "skipped (trading disabled)"}
    postgres_status = _check_postgres(session)

    dependencies: dict[str, object] = {
        "postgres": postgres_status,
        "clickhouse": clickhouse_status,
        "alpaca": alpaca_status,
        "tigerbeetle": _build_tigerbeetle_ledger_status(session),
    }

    if include_database_contract:
        database_contract = _evaluate_database_contract(session)
        lineage_errors = cast(
            list[str],
            database_contract.get("schema_graph_lineage_errors", []),
        )
        detail = (
            "ok" if bool(database_contract.get("ok")) else "database contract failed"
        )
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


def _readiness_authority_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _append_unique_reason(target: list[object], reason: str) -> list[object]:
    if reason not in {str(item) for item in target}:
        target.append(reason)
    return target


def _readiness_dependency_degradation_reason_codes(
    dependencies: Mapping[str, object],
    *,
    scheduler_ok: bool,
) -> list[str]:
    reason_codes: list[str] = []
    if not scheduler_ok:
        reason_codes.append("scheduler_degraded")
    for name, checks in dependencies.items():
        if name in {"readiness_cache", "live_submission_gate"}:
            continue
        if not isinstance(checks, Mapping):
            continue
        dependency_checks = cast(Mapping[str, object], checks)
        if bool(dependency_checks.get("ok", True)):
            continue
        reason_codes.append(f"{name}_degraded")
    return sorted(set(reason_codes))


def _guard_live_submission_gate_for_readiness(
    live_submission_gate: Mapping[str, object],
    *,
    readiness_dependency_reasons: Sequence[str],
) -> dict[str, object]:
    gate = deepcopy(dict(live_submission_gate))
    if not readiness_dependency_reasons:
        return gate

    authority_keys = (
        "allowed",
        "promotion_authority",
        "promotion_authority_ok",
        "final_authority_ok",
        "final_promotion_allowed",
        "final_promotion_authorized",
    )
    claims_authority = any(
        _readiness_authority_truthy(gate.get(key)) for key in authority_keys
    )
    if not claims_authority:
        return gate

    guard_reason = "readiness_dependency_degraded"
    gate["allowed"] = False
    gate["promotion_authority"] = False
    gate["promotion_authority_ok"] = False
    gate["final_authority_ok"] = False
    gate["final_promotion_allowed"] = False
    gate["final_promotion_authorized"] = False
    gate["readiness_dependency_guard_active"] = True
    gate["readiness_dependency_guard_original_allowed"] = bool(
        live_submission_gate.get("allowed")
    )
    gate["readiness_dependency_guard_reasons"] = list(readiness_dependency_reasons)
    gate["reason"] = guard_reason

    blocked_reasons = list(cast(Sequence[object], gate.get("blocked_reasons") or []))
    gate["blocked_reasons"] = _append_unique_reason(blocked_reasons, guard_reason)
    reason_codes = list(cast(Sequence[object], gate.get("reason_codes") or []))
    gate["reason_codes"] = _append_unique_reason(reason_codes, guard_reason)

    plan = gate.get("runtime_ledger_paper_probation_import_plan")
    if isinstance(plan, Mapping):
        guarded_plan = deepcopy(dict(cast(Mapping[str, object], plan)))
        guarded_plan["promotion_allowed"] = False
        guarded_plan["final_promotion_allowed"] = False
        guarded_plan["final_promotion_authorized"] = False
        raw_targets = guarded_plan.get("targets")
        if isinstance(raw_targets, Sequence) and not isinstance(
            raw_targets,
            (str, bytes, bytearray),
        ):
            targets: list[object] = []
            for raw_target in cast(Sequence[object], raw_targets):
                if isinstance(raw_target, Mapping):
                    target = deepcopy(dict(cast(Mapping[str, object], raw_target)))
                    target["promotion_allowed"] = False
                    target["final_promotion_allowed"] = False
                    target["final_promotion_authorized"] = False
                    targets.append(target)
                else:
                    targets.append(raw_target)
            guarded_plan["targets"] = targets
        gate["runtime_ledger_paper_probation_import_plan"] = guarded_plan

    return gate


_READINESS_PROMOTION_AUTHORITY_KEYS = frozenset(
    {
        "promotion_authority",
        "promotion_authority_ok",
        "promotion_allowed",
        "final_authority_ok",
        "final_promotion_allowed",
        "final_promotion_authorized",
    }
)


def _strip_promotion_authority_claims_for_readiness(value: object) -> object:
    if isinstance(value, Mapping):
        payload: dict[str, object] = {}
        mapping_value = cast(Mapping[object, object], value)
        for raw_key, raw_child in mapping_value.items():
            key = str(raw_key)
            if key in _READINESS_PROMOTION_AUTHORITY_KEYS and raw_child is True:
                payload[key] = False
            else:
                payload[key] = _strip_promotion_authority_claims_for_readiness(
                    raw_child
                )
        return payload
    if isinstance(value, list):
        list_value = cast(list[object], value)
        return [
            _strip_promotion_authority_claims_for_readiness(item) for item in list_value
        ]
    return value


def _trading_health_surface_cache_key(
    *,
    include_database_contract: bool,
    allow_stale_dependency_cache: bool,
) -> str:
    return (
        f"health-surface:{int(include_database_contract)}:"
        f"{int(allow_stale_dependency_cache)}"
    )


def _cache_completed_trading_health_surface_payload(
    cache_key: str,
    payload: dict[str, object],
    status_code: int,
) -> None:
    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE[cache_key] = {
            "payload": deepcopy(payload),
            "status_code": status_code,
            "checked_at": datetime.now(timezone.utc),
        }


def _record_trading_health_surface_completion(
    cache_key: str,
    future: Future[tuple[dict[str, object], int]],
) -> None:
    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        current = _TRADING_HEALTH_SURFACE_EVALUATIONS.get(cache_key)
        if current is future:
            _TRADING_HEALTH_SURFACE_EVALUATIONS.pop(cache_key, None)

    try:
        payload, status_code = future.result()
    except Exception as exc:  # pragma: no cover - defensive callback surface
        logger.warning(
            "Trading health surface evaluation failed asynchronously: %s", exc
        )
        return

    _cache_completed_trading_health_surface_payload(cache_key, payload, status_code)


def _cached_trading_health_surface_payload(
    cache_key: str,
) -> tuple[dict[str, object], datetime] | None:
    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        cache_entry = _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.get(cache_key)
        if cache_entry is None:
            return None
        payload = deepcopy(cast(dict[str, object], cache_entry["payload"]))
        checked_at = cast(datetime, cache_entry["checked_at"])
    return payload, checked_at


def _fail_closed_health_evaluation_gate(
    *,
    reason_code: str,
    detail: str,
) -> dict[str, object]:
    return {
        "allowed": False,
        "promotion_authority": False,
        "promotion_authority_ok": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "reason": reason_code,
        "reason_codes": [reason_code],
        "blocked_reasons": [reason_code],
        "detail": detail,
    }


def _health_surface_timeout_fallback_payload(
    *,
    cache_key: str,
    reason_code: str,
    detail: str,
) -> dict[str, object]:
    cached = _cached_trading_health_surface_payload(cache_key)
    if cached is None:
        return {
            "status": "degraded",
            "reason": reason_code,
            "reason_codes": [reason_code],
            "dependencies": {
                "health_evaluation": {
                    "ok": False,
                    "detail": detail,
                    "reason_codes": [reason_code],
                }
            },
            "live_submission_gate": _fail_closed_health_evaluation_gate(
                reason_code=reason_code,
                detail=detail,
            ),
        }

    payload, checked_at = cached
    payload["status"] = "degraded"
    payload["reason"] = reason_code
    reason_codes = list(cast(Sequence[object], payload.get("reason_codes") or []))
    payload["reason_codes"] = _append_unique_reason(reason_codes, reason_code)
    payload["health_evaluation_timeout"] = {
        "ok": False,
        "detail": detail,
        "reason_codes": [reason_code],
        "cached_payload_checked_at": checked_at.isoformat(),
    }
    dependencies = payload.get("dependencies")
    if isinstance(dependencies, Mapping):
        dependencies_payload = deepcopy(dict(cast(Mapping[str, object], dependencies)))
    else:
        dependencies_payload = {}
    dependencies_payload["health_evaluation"] = {
        "ok": False,
        "detail": detail,
        "reason_codes": [reason_code],
        "cached_payload_checked_at": checked_at.isoformat(),
    }
    payload["dependencies"] = dependencies_payload
    live_submission_gate = payload.get("live_submission_gate")
    if isinstance(live_submission_gate, Mapping):
        payload["live_submission_gate"] = _guard_live_submission_gate_for_readiness(
            cast(Mapping[str, object], live_submission_gate),
            readiness_dependency_reasons=[reason_code],
        )
    else:
        payload["live_submission_gate"] = _fail_closed_health_evaluation_gate(
            reason_code=reason_code,
            detail=detail,
        )
    return cast(
        dict[str, object],
        _strip_promotion_authority_claims_for_readiness(payload),
    )


def _evaluate_trading_health_payload_bounded(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
    surface: str,
) -> tuple[dict[str, object], int]:
    cache_key = _trading_health_surface_cache_key(
        include_database_contract=include_database_contract,
        allow_stale_dependency_cache=allow_stale_dependency_cache,
    )
    with _TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
        future = _TRADING_HEALTH_SURFACE_EVALUATIONS.get(cache_key)
        if future is None or future.done():
            future = _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR.submit(
                _evaluate_trading_health_payload,
                include_database_contract=include_database_contract,
                allow_stale_dependency_cache=allow_stale_dependency_cache,
            )
            _TRADING_HEALTH_SURFACE_EVALUATIONS[cache_key] = future
            future.add_done_callback(
                lambda completed, key=cache_key: (
                    _record_trading_health_surface_completion(
                        key,
                        completed,
                    )
                )
            )

    timeout_seconds = max(0.1, _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS)
    try:
        payload, status_code = future.result(timeout=timeout_seconds)
    except TimeoutError:
        reason_code = f"{surface}_evaluation_timeout"
        detail = (
            f"{surface} evaluation exceeded {timeout_seconds:.1f}s; "
            "returning fail-closed cached/degraded health"
        )
        return (
            _health_surface_timeout_fallback_payload(
                cache_key=cache_key,
                reason_code=reason_code,
                detail=detail,
            ),
            503,
        )
    except Exception as exc:
        logger.warning("Trading health surface evaluation failed: %s", exc)
        reason_code = f"{surface}_evaluation_unavailable"
        return (
            _health_surface_timeout_fallback_payload(
                cache_key=cache_key,
                reason_code=reason_code,
                detail=str(exc),
            ),
            503,
        )

    _cache_completed_trading_health_surface_payload(cache_key, payload, status_code)
    return payload, status_code


def _evaluate_trading_health_payload(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    """Build shared trading health payload and status code."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    scheduler_ok, scheduler_payload = _evaluate_scheduler_status(scheduler)

    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        dependencies, checked_at, cache_used = _readiness_dependency_snapshot(
            session,
            include_database_contract=include_database_contract,
            allow_stale_dependency_cache=allow_stale_dependency_cache,
        )
    dependencies = dict(dependencies)
    dependencies["universe"] = _evaluate_universe_dependency(scheduler)
    cache_age_seconds = (now - checked_at).total_seconds() if checked_at else 0.0
    cache_age_seconds = 0.0 if cache_age_seconds < 0 else round(cache_age_seconds, 3)
    cache_stale = (
        cache_used
        and cache_age_seconds > settings.trading_readiness_dependency_cache_ttl_seconds
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
    tca_summary: dict[str, object] = {}
    market_context_status = scheduler.market_context_status()
    _hypothesis_payload: Mapping[str, object] = {}
    _dependency_quorum = JangarDependencyQuorumStatus(
        decision="unknown",
        reasons=["alpha_readiness_not_evaluated"],
        message="alpha readiness not evaluated",
    )
    try:
        with SessionLocal() as session:
            tca_summary = _load_tca_summary(session, scheduler=scheduler)
        _hypothesis_payload, hypothesis_summary, _dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
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
        _dependency_quorum = JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["alpha_readiness_unavailable"],
            message=str(exc),
        )
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
    with SessionLocal() as session:
        live_submission_gate = _build_live_submission_gate_payload(
            scheduler.state,
            session=session,
            hypothesis_summary=_hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=dspy_runtime,
            quant_health_status=quant_evidence,
        )
    proof_floor = _build_profitability_proof_floor_payload(
        state=scheduler.state,
        torghut_revision=BUILD_COMMIT,
        live_submission_gate=live_submission_gate,
        hypothesis_payload=_hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    renewal_bond_profit_escrow = _build_renewal_bond_profit_escrow_payload(
        state=scheduler.state,
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        hypothesis_payload=_hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    route_reacquisition_board = _build_route_reacquisition_board_payload(
        proof_floor=proof_floor,
        active_revision=BUILD_COMMIT,
    )
    profit_signal_quorum = _build_profit_signal_quorum_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        hypothesis_payload=_hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
    )
    with SessionLocal() as session:
        options_catalog_freshness = _load_options_catalog_freshness_summary(
            session,
            route_symbols=_route_claim_symbols(profit_signal_quorum),
        )
    capital_replay_projection = _build_capital_replay_projection_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
    )
    quality_adjusted_profit_frontier = _build_quality_adjusted_profit_frontier_payload(
        torghut_revision=BUILD_COMMIT,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        hypothesis_payload=_hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        active_simulation_context=active_simulation_runtime_context(),
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _build_consumer_evidence_receipt_projection(
            forecast_service_status=_forecast_service_status(empirical_jobs),
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=_active_runtime_revision() or BUILD_COMMIT,
        )
    )
    capital_reentry_cohort_ledger = _build_capital_reentry_cohort_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
    )
    profit_repair_settlement_ledger = _build_profit_repair_settlement_ledger_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
    )
    routeability_repair_acceptance_ledger = (
        _build_routeability_repair_acceptance_ledger_payload(
            torghut_revision=BUILD_COMMIT,
            dependency_quorum=_dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            profit_repair_settlement_ledger=profit_repair_settlement_ledger,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    profit_freshness_frontier = _build_profit_freshness_frontier_payload(
        torghut_revision=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        proof_floor=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs,
        hypothesis_payload=_hypothesis_payload,
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": _active_runtime_revision() or BUILD_COMMIT,
    }
    clickhouse_ta_status = _load_clickhouse_ta_status(scheduler)
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _build_evidence_clock_payloads(
            torghut_revision=BUILD_COMMIT,
            dependency_quorum=_dependency_quorum.as_payload(),
            hypothesis_payload=_hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            profit_signal_quorum=profit_signal_quorum,
            live_submission_gate=live_submission_gate,
            build=build_payload,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    )
    clock_settlement_receipt = _build_clock_settlement_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        build=build_payload,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=_build_route_image_proof_summary(
            build=build_payload,
            dependency_quorum=_dependency_quorum.as_payload(),
        ),
    )
    route_evidence_clearinghouse_packet = _build_route_evidence_clearinghouse_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        build=build_payload,
        proof_floor=proof_floor,
        profit_signal_quorum=profit_signal_quorum,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
        tca_summary=tca_summary,
        options_catalog_freshness=options_catalog_freshness,
    )
    repair_bid_settlement_ledger = _build_repair_bid_settlement_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        dependency_quorum=_dependency_quorum.as_payload(),
        build=build_payload,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quant_evidence=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
    )
    route_warrant_exchange = _build_route_warrant_exchange_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
    )
    source_serving_repair_receipt_ledger = _build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        route_warrant_exchange=route_warrant_exchange,
    )
    freshness_carry_ledger = _build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )
    repair_receipt_frontier = _build_repair_receipt_frontier_payload(
        torghut_revision=BUILD_COMMIT,
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
    )
    repair_outcome_dividend_ledger = _build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        repair_receipt_frontier=repair_receipt_frontier,
        freshness_carry_ledger=freshness_carry_ledger,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )
    live_mode = settings.trading_mode == "live"
    empirical_jobs_required = (
        live_mode and settings.trading_empirical_jobs_health_required
    )
    dependencies["empirical_jobs"] = {
        "ok": bool(empirical_jobs.get("ready")) if empirical_jobs_required else True,
        "detail": (
            str(empirical_jobs.get("status") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "authority": empirical_jobs.get("authority"),
        "required": empirical_jobs_required,
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
                    for item in cast(
                        list[object], dspy_runtime.get("readiness_reasons") or []
                    )
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
    dependencies["profitability_proof_floor"] = {
        "ok": (
            str(proof_floor.get("route_state") or "") != "repair_only"
            if live_mode
            else True
        ),
        "detail": str(proof_floor.get("route_state") or "unknown"),
        "capital_state": proof_floor.get("capital_state"),
        "required": live_mode,
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
    readiness_dependency_reasons = _readiness_dependency_degradation_reason_codes(
        dependencies,
        scheduler_ok=scheduler_ok,
    )
    live_submission_gate_for_readiness = _guard_live_submission_gate_for_readiness(
        live_submission_gate,
        readiness_dependency_reasons=readiness_dependency_reasons,
    )
    if bool(
        live_submission_gate_for_readiness.get("readiness_dependency_guard_active")
    ):
        dependencies["live_submission_gate"] = {
            "ok": False,
            "detail": str(
                live_submission_gate_for_readiness.get("reason")
                or "readiness_dependency_degraded"
            ),
            "capital_stage": live_submission_gate_for_readiness.get("capital_stage"),
            "readiness_dependency_guard_active": True,
            "readiness_dependency_guard_reasons": readiness_dependency_reasons,
        }
    revenue_repair_digest = build_revenue_repair_digest(
        readyz_payload={
            "status": (
                "degraded"
                if live_submission_gate_for_readiness.get("allowed") is not True
                else "ok"
            ),
            "proof_floor": proof_floor,
            "live_submission_gate": live_submission_gate_for_readiness,
            "quant_evidence": quant_evidence,
            "dependencies": dependencies,
        },
        status_payload={
            "mode": settings.trading_mode,
            "pipeline_mode": settings.trading_pipeline_mode,
            "build": build_payload,
            "dependency_quorum": _dependency_quorum.as_payload(),
            "live_submission_gate": live_submission_gate_for_readiness,
            "proof_floor": proof_floor,
            "quant_evidence": quant_evidence,
            "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
            "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
            "capital_replay_board": capital_replay_projection.get(
                "capital_replay_board"
            ),
            "executable_alpha_receipts": capital_replay_projection.get(
                "executable_alpha_receipts"
            ),
            "controller_ingestion_settlement": _dependency_quorum.as_payload().get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": _dependency_quorum.as_payload().get(
                "verify_trust_foreclosure_board"
            ),
            "repair_slot_escrow": _dependency_quorum.as_payload().get(
                "repair_slot_escrow"
            ),
            "stage_debt_repair_admission": _dependency_quorum.as_payload().get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": _dependency_quorum.as_payload().get(
                "foreclosure_carry_rollout_witness"
            ),
            "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        },
        generated_at=now,
    )
    dependency_statuses = [
        cast(dict[str, object], checks).get("ok", True)
        for name, checks in dependencies.items()
        if name != "readiness_cache"
    ]

    overall_ok = scheduler_ok and all(bool(dep) for dep in dependency_statuses)
    status = "ok" if overall_ok else "degraded"
    status_code = 200 if overall_ok else 503

    response_payload = {
        "status": status,
        "scheduler": scheduler_payload,
        "dependencies": dependencies,
        "alpha_readiness": alpha_readiness,
        "live_submission_gate": live_submission_gate_for_readiness,
        "proof_floor": proof_floor,
        "renewal_bond_profit_escrow": renewal_bond_profit_escrow,
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": quality_adjusted_profit_frontier,
        "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
        "route_proven_profit_receipt": route_proven_profit_receipt,
        "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        "capital_reentry_cohort_ledger": capital_reentry_cohort_ledger,
        "profit_repair_settlement_ledger": profit_repair_settlement_ledger,
        "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
        "profit_freshness_frontier": profit_freshness_frontier,
        "profit_signal_quorum": profit_signal_quorum,
        "evidence_clock_arbiter": evidence_clock_arbiter,
        "routeable_profit_candidate_exchange": routeable_profit_candidate_exchange,
        "clock_settlement_receipt": clock_settlement_receipt,
        "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
        "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
        **_revenue_repair_topline_fields(revenue_repair_digest),
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "executable_alpha_settlement_slots": compact_executable_alpha_settlement_slots(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("executable_alpha_settlement_slots"),
            )
        ),
        "alpha_repair_closure_board": compact_alpha_repair_closure_board(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_closure_board"),
            )
        ),
        "alpha_evidence_foundry": compact_alpha_evidence_foundry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_evidence_foundry"),
            )
        ),
        "alpha_readiness_settlement_conveyor": compact_alpha_readiness_settlement_conveyor(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_readiness_settlement_conveyor"),
            )
        ),
        "alpha_repair_dividend_ledger": compact_alpha_repair_dividend_ledger(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            )
        ),
        "alpha_closure_dividend_slo": build_alpha_closure_dividend_slo(
            generated_at=datetime.now(timezone.utc),
            alpha_repair_closure_board=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_closure_board"),
            ),
            alpha_repair_dividend_ledger=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            ),
        ),
        "jangar_controller_ingestion_carry": compact_jangar_controller_ingestion_carry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("jangar_controller_ingestion_carry"),
            )
        ),
        "no_delta_repair_reentry_auction": compact_no_delta_repair_reentry_auction(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("no_delta_repair_reentry_auction"),
            )
        ),
        "route_reacquisition_book": proof_floor.get("route_reacquisition_book"),
        "route_reacquisition_board": route_reacquisition_board,
        "quant_evidence": quant_evidence,
        "profit_lease_projection": live_submission_gate_for_readiness.get(
            "profit_lease_projection"
        ),
    }
    if readiness_dependency_reasons:
        response_payload = cast(
            dict[str, object],
            _strip_promotion_authority_claims_for_readiness(response_payload),
        )

    return response_payload, status_code


def _evaluate_universe_dependency(
    scheduler: TradingScheduler | None,
) -> dict[str, object]:
    require_non_empty = (
        settings.trading_universe_source == "static"
        or settings.trading_universe_require_non_empty_jangar
    )
    if scheduler is None:
        return {
            "ok": not require_non_empty,
            "detail": "universe state unavailable",
            "source": settings.trading_universe_source,
            "status": None,
            "reason": None,
            "symbols_count": None,
            "cache_age_seconds": None,
            "require_non_empty": require_non_empty,
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
            "require_non_empty": require_non_empty,
        }

    universe_status = getattr(state, "universe_source_status", None)
    universe_symbols_count = getattr(state, "universe_symbols_count", None)
    if universe_status in {"unknown", "not_evaluated", None} or (
        require_non_empty and not universe_symbols_count
    ):
        _refresh_universe_state_for_readiness(scheduler=scheduler, state=state)

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
            "detail": f"{settings.trading_universe_source} universe unavailable",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    if universe_status == "empty" and (universe_fail_safe_blocked or require_non_empty):
        return {
            "ok": False,
            "detail": f"{settings.trading_universe_source} universe empty",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
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
            "require_non_empty": require_non_empty,
        }

    if universe_status == "ok":
        detail = f"{settings.trading_universe_source} universe fresh"
        if settings.trading_universe_source == "static":
            detail = "static universe loaded"
        return {
            "ok": True,
            "detail": detail,
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
        }

    if universe_status in {"unknown", "not_evaluated", None}:
        return {
            "ok": not require_non_empty,
            "detail": "universe not yet evaluated",
            "source": settings.trading_universe_source,
            "status": universe_status,
            "reason": universe_reason,
            "symbols_count": universe_symbols_count,
            "cache_age_seconds": universe_cache_age_seconds,
            "max_stale_seconds": max_stale_seconds,
            "require_non_empty": require_non_empty,
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
            "require_non_empty": require_non_empty,
        }

    return {
        "ok": True,
        "detail": f"{settings.trading_universe_source} universe ok",
        "source": settings.trading_universe_source,
        "status": universe_status,
        "reason": universe_reason,
        "symbols_count": universe_symbols_count,
        "cache_age_seconds": universe_cache_age_seconds,
        "max_stale_seconds": max_stale_seconds,
        "require_non_empty": require_non_empty,
    }


def _refresh_universe_state_for_readiness(
    *,
    scheduler: TradingScheduler,
    state: object,
) -> None:
    resolver = _resolve_universe_resolver_for_readiness(scheduler)
    if resolver is None:
        return
    try:
        resolution = resolver.get_resolution()
    except Exception as exc:  # pragma: no cover - defensive readiness surface
        setattr(state, "universe_source_status", "error")
        setattr(
            state,
            "universe_source_reason",
            f"jangar_readiness_probe_failed:{type(exc).__name__}",
        )
        setattr(state, "universe_symbols_count", 0)
        setattr(state, "universe_cache_age_seconds", None)
        setattr(state, "universe_fail_safe_blocked", True)
        setattr(
            state,
            "universe_fail_safe_block_reason",
            f"jangar_readiness_probe_failed:{type(exc).__name__}",
        )
        return

    symbols_count = len(resolution.symbols)
    setattr(state, "universe_source_status", resolution.status)
    setattr(state, "universe_source_reason", resolution.reason)
    setattr(state, "universe_symbols_count", symbols_count)
    setattr(state, "universe_cache_age_seconds", resolution.cache_age_seconds)
    fail_safe_blocked = symbols_count == 0 and (
        settings.trading_universe_source == "static"
        or (
            settings.trading_universe_source == "jangar"
            and settings.trading_universe_require_non_empty_jangar
        )
    )
    setattr(state, "universe_fail_safe_blocked", fail_safe_blocked)
    setattr(
        state,
        "universe_fail_safe_block_reason",
        resolution.reason if fail_safe_blocked else None,
    )
    metrics = getattr(state, "metrics", None)
    if metrics is not None:
        metrics.record_universe_resolution(
            status=resolution.status,
            reason=resolution.reason,
            symbols_count=symbols_count,
            cache_age_seconds=resolution.cache_age_seconds,
        )


def _resolve_universe_resolver_for_readiness(scheduler: TradingScheduler) -> Any | None:
    pipeline = getattr(scheduler, "_pipeline", None)
    pipeline_resolver = getattr(pipeline, "universe_resolver", None)
    if callable(getattr(pipeline_resolver, "get_resolution", None)):
        return pipeline_resolver

    return None


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
def readyz() -> JSONResponse:
    """Readiness endpoint with dependency-aware status for rollout safety."""

    payload, status_code = _evaluate_trading_health_payload_bounded(
        include_database_contract=True,
        allow_stale_dependency_cache=True,
        surface="readyz",
    )
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder(payload),
    )


def _load_jangar_dependency_quorum_payload() -> dict[str, object]:
    """Fetch cached Jangar dependency carry for revenue-repair reentry only."""

    dependency_quorum = load_jangar_dependency_quorum()
    return dependency_quorum.as_payload()


def _load_jangar_verify_trust_foreclosure_board(
    dependency_quorum_payload: Mapping[str, object] | None = None,
) -> dict[str, object] | None:
    """Fetch cached Jangar verify-trust board for legacy revenue-repair callers."""

    payload = dependency_quorum_payload or _load_jangar_dependency_quorum_payload()
    board = payload.get("verify_trust_foreclosure_board")
    if not isinstance(board, Mapping):
        return None
    return dict(cast(Mapping[str, object], board))


@app.get("/trading/revenue-repair")
def trading_revenue_repair() -> dict[str, object]:
    """Return business-state and repair-priority evidence for revenue readiness."""

    readyz_payload, _status_code = _evaluate_trading_health_payload(
        include_database_contract=True,
        allow_stale_dependency_cache=True,
    )
    status_payload = trading_status()
    dependency_quorum_payload = _load_jangar_dependency_quorum_payload()
    verify_trust_foreclosure_board = _load_jangar_verify_trust_foreclosure_board(
        dependency_quorum_payload
    )
    if dependency_quorum_payload:
        status_payload = {
            **status_payload,
            "dependency_quorum": dependency_quorum_payload,
            "controller_ingestion_settlement": dependency_quorum_payload.get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": verify_trust_foreclosure_board
            or dependency_quorum_payload.get("verify_trust_foreclosure_board"),
            "repair_slot_escrow": dependency_quorum_payload.get("repair_slot_escrow"),
            "stage_debt_repair_admission": dependency_quorum_payload.get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": dependency_quorum_payload.get(
                "foreclosure_carry_rollout_witness"
            ),
        }
    elif verify_trust_foreclosure_board is not None:
        status_payload = {
            **status_payload,
            "verify_trust_foreclosure_board": verify_trust_foreclosure_board,
        }
    return cast(
        dict[str, object],
        jsonable_encoder(
            build_revenue_repair_digest(
                readyz_payload=readyz_payload,
                status_payload=status_payload,
            )
        ),
    )


@app.post("/trading/profit-freshness/zero-notional-repair")
def trading_profit_freshness_zero_notional_repair(
    execute: bool = Query(default=False),
    action: str | None = Query(
        default=None,
        description="Optional zero-notional action to select from queued repair lots.",
    ),
    tca_limit: int = Query(default=250, ge=1, le=5000),
    drift_limit: int = Query(default=500, ge=1, le=5000),
    feature_limit: int = Query(default=500, ge=1, le=5000),
    repair_lot_dispatch_ticket: dict[str, Any] | None = Body(
        default=None,
        description=(
            "Jangar repair_lot_dispatch_ticket authorizing runner-required "
            "zero-notional repair execution."
        ),
    ),
) -> dict[str, object]:
    """Plan or run an allowlisted zero-notional repair from the freshness frontier."""

    status_payload = trading_status()
    frontier = cast(
        Mapping[str, Any],
        status_payload.get("profit_freshness_frontier") or {},
    )

    def run_tca_recompute(_repair: Mapping[str, Any]) -> Mapping[str, object]:
        try:
            with SessionLocal() as session:
                result = refresh_execution_tca_metrics(
                    session,
                    account_label=settings.trading_account_label,
                    limit=tca_limit,
                    dry_run=False,
                )
                session.commit()
        except Exception as exc:  # pragma: no cover - fail-closed receipt path
            logger.exception("Zero-notional route/TCA repair failed")
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 1,
                "blocked_reasons": [f"route_tca_recompute_failed:{type(exc).__name__}"],
                "after_refs": [],
            }
        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": ["execution_tca_metrics"],
            "result": result,
        }

    def run_drift_check_replay(repair: Mapping[str, Any]) -> Mapping[str, object]:
        scheduler: TradingScheduler | None = getattr(
            app.state, "trading_scheduler", None
        )
        pipeline = getattr(scheduler, "_pipeline", None) if scheduler else None
        ingestor = getattr(pipeline, "ingestor", None)
        fetch_with_reason = getattr(ingestor, "fetch_signals_with_reason", None)
        run_simple_drift_check = getattr(pipeline, "_run_simple_drift_check", None)
        if not callable(fetch_with_reason) or not callable(run_simple_drift_check):
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 78,
                "blocked_reasons": ["drift_check_runner_unavailable"],
                "after_refs": [],
            }

        assert scheduler is not None
        now = datetime.now(timezone.utc)
        lookback_minutes = max(
            1, int(settings.trading_autonomy_signal_lookback_minutes)
        )
        symbol_set = {
            str(symbol).strip().upper()
            for symbol in cast(Sequence[object], repair.get("symbol_set") or [])
            if str(symbol).strip()
        }

        def select_signals(batch: Any) -> list[Any]:
            return [
                signal
                for signal in cast(Sequence[Any], getattr(batch, "signals", []))
                if not symbol_set
                or str(getattr(signal, "symbol", "")).strip().upper() in symbol_set
            ]

        def replay_window_from_latest_signal() -> tuple[Any | None, list[Any]]:
            latest_status_fn = getattr(ingestor, "latest_signal_status", None)
            if not callable(latest_status_fn):
                return None, []
            latest_status = latest_status_fn()
            if not isinstance(latest_status, Mapping):
                return None, []
            latest_status_mapping = cast(Mapping[str, object], latest_status)
            latest_signal_at = latest_status_mapping.get("latest_signal_at")
            if not isinstance(latest_signal_at, datetime):
                return None, []
            if latest_signal_at.tzinfo is None:
                latest_signal_at = latest_signal_at.replace(tzinfo=timezone.utc)
            else:
                latest_signal_at = latest_signal_at.astimezone(timezone.utc)
            fallback_batch = fetch_with_reason(
                start=latest_signal_at - timedelta(minutes=lookback_minutes),
                end=latest_signal_at,
                limit=drift_limit,
            )
            return fallback_batch, select_signals(fallback_batch)

        try:
            batch = fetch_with_reason(
                start=now - timedelta(minutes=lookback_minutes),
                end=now,
                limit=drift_limit,
            )
            signals = select_signals(batch)
            replay_window = "current"
            if not signals:
                fallback_batch, fallback_signals = replay_window_from_latest_signal()
                if fallback_signals:
                    batch = fallback_batch
                    signals = fallback_signals
                    replay_window = "latest_signal"
            if not signals:
                no_signal_reason = str(
                    getattr(batch, "no_signal_reason", None) or "no_signals"
                )
                return {
                    "execution_state": "runner_blocked",
                    "command_exit_code": 78,
                    "blocked_reasons": [f"drift_check_no_signals:{no_signal_reason}"],
                    "after_refs": [],
                    "result": {
                        "query_start": getattr(batch, "query_start", None),
                        "query_end": getattr(batch, "query_end", None),
                        "symbol_set": sorted(symbol_set),
                        "replay_window": replay_window,
                    },
                }
            run_simple_drift_check(signals)
        except Exception as exc:  # pragma: no cover - fail-closed receipt path
            logger.exception("Zero-notional drift-check repair failed")
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 1,
                "blocked_reasons": [f"drift_check_replay_failed:{type(exc).__name__}"],
                "after_refs": [],
            }

        drift_path = str(
            getattr(scheduler.state, "drift_last_detection_path", "") or ""
        )
        after_refs = ["drift_detection_checks"]
        if drift_path:
            after_refs.append(drift_path)
        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": after_refs,
            "result": {
                "signals_evaluated": len(signals),
                "symbol_set": sorted(symbol_set),
                "replay_window": replay_window,
                "query_start": getattr(batch, "query_start", None),
                "query_end": getattr(batch, "query_end", None),
                "drift_status": getattr(scheduler.state, "drift_status", None),
                "drift_active_reason_codes": list(
                    getattr(scheduler.state, "drift_active_reason_codes", [])
                ),
            },
        }

    def run_feature_coverage_replay(repair: Mapping[str, Any]) -> Mapping[str, object]:
        scheduler: TradingScheduler | None = getattr(
            app.state, "trading_scheduler", None
        )
        pipeline = getattr(scheduler, "_pipeline", None) if scheduler else None
        ingestor = getattr(pipeline, "ingestor", None)
        fetch_with_reason = getattr(ingestor, "fetch_signals_with_reason", None)
        if not callable(fetch_with_reason) or scheduler is None:
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 78,
                "blocked_reasons": ["feature_coverage_runner_unavailable"],
                "after_refs": [],
            }

        now = datetime.now(timezone.utc)
        lookback_minutes = max(1, int(settings.trading_signal_lookback_minutes))
        symbol_set = {
            str(symbol).strip().upper()
            for symbol in cast(Sequence[object], repair.get("symbol_set") or [])
            if str(symbol).strip()
        }

        def select_signals(batch: Any) -> list[Any]:
            return [
                signal
                for signal in cast(Sequence[Any], getattr(batch, "signals", []))
                if not symbol_set
                or str(getattr(signal, "symbol", "")).strip().upper() in symbol_set
            ]

        def replay_window_from_latest_signal() -> tuple[Any | None, list[Any]]:
            latest_status_fn = getattr(ingestor, "latest_signal_status", None)
            if not callable(latest_status_fn):
                return None, []
            latest_status = latest_status_fn()
            if not isinstance(latest_status, Mapping):
                return None, []
            latest_status_mapping = cast(Mapping[str, object], latest_status)
            latest_signal_at = latest_status_mapping.get("latest_signal_at")
            if not isinstance(latest_signal_at, datetime):
                return None, []
            if latest_signal_at.tzinfo is None:
                latest_signal_at = latest_signal_at.replace(tzinfo=timezone.utc)
            else:
                latest_signal_at = latest_signal_at.astimezone(timezone.utc)
            fallback_batch = fetch_with_reason(
                start=latest_signal_at - timedelta(minutes=lookback_minutes),
                end=latest_signal_at,
                limit=feature_limit,
            )
            return fallback_batch, select_signals(fallback_batch)

        try:
            batch = fetch_with_reason(
                start=now - timedelta(minutes=lookback_minutes),
                end=now,
                limit=feature_limit,
            )
            signals = select_signals(batch)
            replay_window = "current"
            if not signals:
                fallback_batch, fallback_signals = replay_window_from_latest_signal()
                if fallback_signals:
                    batch = fallback_batch
                    signals = fallback_signals
                    replay_window = "latest_signal"
            if not signals:
                no_signal_reason = str(
                    getattr(batch, "no_signal_reason", None) or "no_signals"
                )
                return {
                    "execution_state": "runner_blocked",
                    "command_exit_code": 78,
                    "blocked_reasons": [
                        f"feature_coverage_no_signals:{no_signal_reason}"
                    ],
                    "after_refs": [],
                    "result": {
                        "query_start": getattr(batch, "query_start", None),
                        "query_end": getattr(batch, "query_end", None),
                        "symbol_set": sorted(symbol_set),
                        "replay_window": replay_window,
                    },
                }

            quality_report = evaluate_feature_batch_quality(
                cast(list[SignalEnvelope], signals),
                thresholds=FeatureQualityThresholds(
                    max_required_null_rate=settings.trading_feature_max_required_null_rate,
                    max_staleness_ms=settings.trading_feature_max_staleness_ms,
                    max_duplicate_ratio=settings.trading_feature_max_duplicate_ratio,
                ),
            )
            metrics = scheduler.state.metrics
            metrics.feature_batch_rows_total = max(
                int(getattr(metrics, "feature_batch_rows_total", 0) or 0),
                quality_report.rows_total,
            )
            metrics.feature_null_rate = dict(quality_report.null_rate_by_field)
            metrics.feature_staleness_ms_p95 = quality_report.staleness_ms_p95
            metrics.feature_duplicate_ratio = quality_report.duplicate_ratio
            metrics.feature_schema_mismatch_total += (
                quality_report.schema_mismatch_total
            )
            if not quality_report.accepted:
                metrics.feature_quality_rejections_total += 1
                metrics.record_feature_quality_rejection(quality_report.reasons)
        except Exception as exc:  # pragma: no cover - fail-closed receipt path
            logger.exception("Zero-notional feature-coverage repair failed")
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 1,
                "blocked_reasons": [
                    f"feature_coverage_replay_failed:{type(exc).__name__}"
                ],
                "after_refs": [],
            }

        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": ["feature_coverage_rows"],
            "result": {
                "signals_evaluated": len(signals),
                "rows_total": quality_report.rows_total,
                "accepted": quality_report.accepted,
                "reason_codes": list(quality_report.reasons),
                "symbol_set": sorted(symbol_set),
                "replay_window": replay_window,
                "query_start": getattr(batch, "query_start", None),
                "query_end": getattr(batch, "query_end", None),
                "feature_batch_rows_total": metrics.feature_batch_rows_total,
            },
        }

    receipt = run_zero_notional_repair(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=cast(str | None, status_payload.get("active_revision")),
        source_commit=BUILD_COMMIT,
        profit_freshness_frontier=frontier,
        execute=execute,
        preferred_action=action,
        repair_lot_dispatch_ticket=repair_lot_dispatch_ticket,
        freshness_carry_ledger=cast(
            Mapping[str, Any],
            status_payload.get("freshness_carry_ledger") or {},
        ),
        runners={
            "recompute_route_tca_and_fill_quality": run_tca_recompute,
            "rerun_drift_checks_for_blocked_hypotheses": run_drift_check_replay,
            "rebuild_required_feature_rows": run_feature_coverage_replay,
        },
    )
    return cast(dict[str, object], jsonable_encoder(receipt))


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
            "schema_unexpected_heads": database_contract.get(
                "schema_unexpected_heads", []
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
                "schema_missing_heads": database_contract.get(
                    "schema_missing_heads", []
                ),
                "schema_unexpected_heads": database_contract.get(
                    "schema_unexpected_heads", []
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
                "schema_missing_heads": database_contract.get(
                    "schema_missing_heads", []
                ),
                "schema_unexpected_heads": database_contract.get(
                    "schema_unexpected_heads", []
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
                "schema_graph_signature": database_contract.get(
                    "schema_graph_signature"
                ),
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
        or os.getenv("WHITEPAPER_AGENTRUN_API_TOKEN", "").strip()
        or os.getenv("AGENTS_API_KEY", "").strip()
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
def trading_status() -> dict[str, object]:
    """Return trading loop status and metrics."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    state = scheduler.state
    active_simulation_context = active_simulation_runtime_context()
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    forecast_service_status = _forecast_service_status(empirical_jobs)
    lean_authority_status = _lean_authority_status()
    with SessionLocal() as session:
        llm_evaluation = _load_llm_evaluation(session)
        tca_summary = _load_tca_summary(session, scheduler=scheduler)
        tigerbeetle_ledger = _build_tigerbeetle_ledger_status(session)
        runtime_ledger_portfolio_summary = _daily_runtime_ledger_portfolio_summary(
            session=session,
            account_label=settings.trading_account_label,
            stage_scope="live" if settings.trading_mode == "live" else "paper",
            observed_at=datetime.now(timezone.utc),
        )
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
    with SessionLocal() as session:
        last_decision_at = _load_last_decision_at(session)
    with SessionLocal() as session:
        persisted_rejected_signal_outcome_learning = (
            _load_rejected_signal_outcome_learning_summary(session)
        )
    with SessionLocal() as session:
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
    simple_lane_reject_reason_totals = _simple_lane_reject_reason_totals(state)
    simple_lane_status = _build_simple_lane_status_payload()
    proof_floor = _build_profitability_proof_floor_payload(
        state=state,
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        simple_lane_status=simple_lane_status,
    )
    renewal_bond_profit_escrow = _build_renewal_bond_profit_escrow_payload(
        state=state,
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    route_reacquisition_board = _build_route_reacquisition_board_payload(
        proof_floor=proof_floor,
        active_revision=str(shadow_first_runtime["active_revision"]),
    )
    profit_signal_quorum = _build_profit_signal_quorum_payload(
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
    )
    with SessionLocal() as session:
        options_catalog_freshness = _load_options_catalog_freshness_summary(
            session,
            route_symbols=_route_claim_symbols(profit_signal_quorum),
        )
    capital_replay_projection = _build_capital_replay_projection_payload(
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
    )
    quality_adjusted_profit_frontier = _build_quality_adjusted_profit_frontier_payload(
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        active_simulation_context=active_simulation_context,
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _build_consumer_evidence_receipt_projection(
            forecast_service_status=forecast_service_status,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        )
    )
    capital_reentry_cohort_ledger = _build_capital_reentry_cohort_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
    )
    profit_repair_settlement_ledger = _build_profit_repair_settlement_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
    )
    routeability_repair_acceptance_ledger = (
        _build_routeability_repair_acceptance_ledger_payload(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=hypothesis_dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            profit_repair_settlement_ledger=profit_repair_settlement_ledger,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": shadow_first_runtime["active_revision"],
    }
    clickhouse_ta_status = _load_clickhouse_ta_status(scheduler)
    profit_freshness_frontier = _build_profit_freshness_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        proof_floor=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs,
        hypothesis_payload=hypothesis_payload,
    )
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _build_evidence_clock_payloads(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=hypothesis_dependency_quorum.as_payload(),
            hypothesis_payload=hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            profit_signal_quorum=profit_signal_quorum,
            live_submission_gate=live_submission_gate,
            build=build_payload,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    )
    clock_settlement_receipt = _build_clock_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        build=build_payload,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=_build_route_image_proof_summary(
            build=build_payload,
            dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        ),
    )
    route_evidence_clearinghouse_packet = _build_route_evidence_clearinghouse_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        build=build_payload,
        proof_floor=proof_floor,
        profit_signal_quorum=profit_signal_quorum,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
        tca_summary=tca_summary,
        options_catalog_freshness=options_catalog_freshness,
    )
    repair_bid_settlement_ledger = _build_repair_bid_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        dependency_quorum=hypothesis_dependency_quorum.as_payload(),
        build=build_payload,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quant_evidence=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
    )
    route_warrant_exchange = _build_route_warrant_exchange_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
    )
    source_serving_repair_receipt_ledger = _build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        route_warrant_exchange=route_warrant_exchange,
    )
    freshness_carry_ledger = _build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )
    repair_receipt_frontier = _build_repair_receipt_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
    )
    repair_outcome_dividend_ledger = _build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        repair_receipt_frontier=repair_receipt_frontier,
        freshness_carry_ledger=freshness_carry_ledger,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )
    rejected_signal_outcome_learning = _build_rejected_signal_outcome_learning_payload(
        state,
        persisted_summary=persisted_rejected_signal_outcome_learning,
    )
    return {
        "enabled": settings.trading_enabled,
        "autonomy_enabled": settings.trading_autonomy_enabled,
        "mode": settings.trading_mode,
        "pipeline_mode": settings.trading_pipeline_mode,
        "execution_lane": settings.trading_pipeline_mode,
        "kill_switch_enabled": settings.trading_kill_switch_enabled,
        "build": build_payload,
        "shadow_first": shadow_first_runtime,
        "execution_advisor": {
            "enabled": settings.trading_execution_advisor_enabled,
            "live_apply_enabled": settings.trading_execution_advisor_live_apply_enabled,
            "usage_total": dict(state.metrics.execution_advisor_usage_total),
            "fallback_total": dict(state.metrics.execution_advisor_fallback_total),
        },
        "running": state.running,
        "live_submission_gate": live_submission_gate,
        "tigerbeetle_ledger": tigerbeetle_ledger,
        "portfolio_runtime_ledger_summary": runtime_ledger_portfolio_summary,
        "runtime_ledger_profit_distance_readback": (
            runtime_ledger_portfolio_summary.get(
                "runtime_ledger_profit_distance_readback"
            )
        ),
        "profit_lease_projection": live_submission_gate.get("profit_lease_projection"),
        "proof_floor": proof_floor,
        "renewal_bond_profit_escrow": renewal_bond_profit_escrow,
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": quality_adjusted_profit_frontier,
        "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
        "route_proven_profit_receipt": route_proven_profit_receipt,
        "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        "capital_reentry_cohort_ledger": capital_reentry_cohort_ledger,
        "profit_repair_settlement_ledger": profit_repair_settlement_ledger,
        "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
        "profit_freshness_frontier": profit_freshness_frontier,
        "profit_signal_quorum": profit_signal_quorum,
        "evidence_clock_arbiter": evidence_clock_arbiter,
        "routeable_profit_candidate_exchange": routeable_profit_candidate_exchange,
        "clock_settlement_receipt": clock_settlement_receipt,
        "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
        "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "rejected_signal_outcome_learning": rejected_signal_outcome_learning,
        "route_reacquisition_book": proof_floor.get("route_reacquisition_book"),
        "route_reacquisition_board": route_reacquisition_board,
        "quant_evidence": quant_evidence,
        "last_decision_at": last_decision_at,
        "simple_lane_status": simple_lane_status,
        "simple_lane_reject_reason_totals": simple_lane_reject_reason_totals,
        "simple_lane_orders_submitted_total": (
            state.metrics.orders_submitted_total
            if settings.trading_pipeline_mode == "simple"
            else 0
        ),
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
            "rejected_signal_events_total": state.metrics.rejected_signal_events_total,
            "rejected_signal_outcome_label_pending_total": (
                state.metrics.rejected_signal_outcome_label_pending_total
            ),
            "rejected_signal_reason_total": dict(
                state.metrics.rejected_signal_reason_total
            ),
            "strategy_intent_suppression_total": dict(
                state.metrics.strategy_intent_suppression_total
            ),
            "market_context_block_total": state.metrics.llm_market_context_block_total,
            "pre_llm_capacity_reject_total": state.metrics.pre_llm_capacity_reject_total,
            "pre_llm_qty_below_min_total": state.metrics.pre_llm_qty_below_min_total,
            "runtime_fallback_ratio": rejection_alert_status["runtime_fallback_ratio"],
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
        "forecast_service": forecast_service_status,
        "lean_authority": lean_authority_status,
        "empirical_jobs": empirical_jobs,
        "simulation": {
            "enabled": settings.trading_simulation_enabled,
            "run_id": (active_simulation_context or {}).get("run_id")
            or settings.trading_simulation_run_id,
            "dataset_id": (active_simulation_context or {}).get("dataset_id")
            or settings.trading_simulation_dataset_id,
            "window_start": (active_simulation_context or {}).get("window_start")
            or settings.trading_simulation_window_start,
            "window_end": (active_simulation_context or {}).get("window_end")
            or settings.trading_simulation_window_end,
            "time_source": trading_time_status(
                account_label=settings.trading_account_label
            ),
        },
        "control_plane_contract": control_plane_contract,
        "evidence_continuity": state.last_evidence_continuity_report,
    }


def _consumer_evidence_dependency_quorum() -> JangarDependencyQuorumStatus:
    dependency_quorum = load_jangar_dependency_quorum(
        omit_torghut_consumer_evidence=True,
    )
    if dependency_quorum.reasons != ["jangar_control_plane_status_url_missing"]:
        return dependency_quorum

    return JangarDependencyQuorumStatus(
        decision="allow",
        reasons=[],
        message=CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE,
    )


def _build_consumer_evidence_receipt_projection(
    *,
    forecast_service_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    serving_revision: str | None,
) -> tuple[dict[str, object], dict[str, object]]:
    consumer_evidence_receipt = build_torghut_consumer_evidence_receipt(
        forecast_service_status=forecast_service_status,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
    )
    route_proven_profit_receipt = build_route_proven_profit_receipt(
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        source_commit=BUILD_COMMIT,
        serving_revision=serving_revision,
        image_digest=BUILD_IMAGE_DIGEST,
    )
    return consumer_evidence_receipt, route_proven_profit_receipt


def _consumer_evidence_summary_view(view: str | None) -> bool:
    return (view or "").strip().lower() in {"compact", "summary", "jangar"}


def _revenue_repair_topline_fields(
    revenue_repair_digest: Mapping[str, Any],
) -> dict[str, object]:
    keys = (
        "business_state",
        "revenue_ready",
        "capital_state",
        "capital_stage",
        "live_submission_allowed",
        "max_notional",
        "top_repair_queue_item",
        "selected_value_gate",
        "required_output_receipt",
        "required_receipts",
        "routeable_candidate_count_before",
        "routeable_candidate_count_after",
        "accepted_routeable_candidate_count",
        "routeable_candidate_delta",
        "alpha_no_delta_release_key",
        "no_delta_reentry_decision",
        "no_delta_reentry_reason_codes",
        "field_unavailable_reason_codes",
        "validation_commands",
        "rollback_target",
    )
    return {
        "revenue_repair_digest_ref": "/trading/revenue-repair",
        **{key: revenue_repair_digest.get(key) for key in keys},
    }


def _build_trading_consumer_evidence_payload(
    *, summary: bool = False
) -> dict[str, object]:
    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    state = scheduler.state
    dependency_quorum = _consumer_evidence_dependency_quorum()
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    forecast_service_status = _forecast_service_status(empirical_jobs)
    lean_authority_status = _lean_authority_status()
    with SessionLocal() as session:
        tca_summary = _load_tca_summary(session, scheduler=scheduler)
        readiness_dependencies, _readiness_checked_at, _readiness_cache_used = (
            _readiness_dependency_snapshot(
                session,
                include_database_contract=True,
                allow_stale_dependency_cache=True,
            )
        )
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, hypothesis_summary, _dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
            dependency_quorum=dependency_quorum,
        )
    )
    with SessionLocal() as session:
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
    simple_lane_status = _build_simple_lane_status_payload()
    shadow_first_runtime = _build_shadow_first_runtime_payload(
        state=state,
        hypothesis_summary=hypothesis_summary,
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": shadow_first_runtime["active_revision"],
    }
    proof_floor = _build_profitability_proof_floor_payload(
        state=state,
        torghut_revision=str(shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        simple_lane_status=simple_lane_status,
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _build_consumer_evidence_receipt_projection(
            forecast_service_status=forecast_service_status,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        )
    )
    control_plane_dependency_mode = (
        "caller_evaluated"
        if dependency_quorum.message
        == CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE
        else "jangar_status_non_recursive"
    )
    if summary:
        return {
            "schema_version": "torghut.consumer-evidence-status.v1",
            "view": "summary",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "enabled": settings.trading_enabled,
            "mode": settings.trading_mode,
            "running": state.running,
            "build": build_payload,
            "control_plane_dependency_mode": control_plane_dependency_mode,
            "dependency_quorum": dependency_quorum.as_payload(),
            "forecast_service": forecast_service_status,
            "lean_authority": lean_authority_status,
            "empirical_jobs": empirical_jobs,
            "market_context": market_context_status,
            "quant_evidence": quant_evidence,
            "live_submission_gate": live_submission_gate,
            "proof_floor": proof_floor,
            "simple_lane_status": simple_lane_status,
            "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
            "route_proven_profit_receipt": route_proven_profit_receipt,
            "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        }
    route_reacquisition_board = build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        route_reacquisition_book=cast(
            Mapping[str, Any] | None,
            proof_floor.get("route_reacquisition_book"),
        ),
        active_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        jangar_continuity=_consumer_evidence_jangar_continuity_packet(
            dependency_quorum.as_payload()
        ),
    )
    capital_replay_projection = _build_capital_replay_projection_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
    )
    profit_signal_quorum = _build_profit_signal_quorum_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
    )
    with SessionLocal() as session:
        options_catalog_freshness = _load_options_catalog_freshness_summary(
            session,
            route_symbols=_route_claim_symbols(profit_signal_quorum),
        )
    capital_reentry_cohort_ledger = _build_capital_reentry_cohort_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
    )
    quality_adjusted_profit_frontier = _build_quality_adjusted_profit_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        active_simulation_context=active_simulation_runtime_context(),
    )
    profit_repair_settlement_ledger = _build_profit_repair_settlement_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
    )
    routeability_repair_acceptance_ledger = (
        _build_routeability_repair_acceptance_ledger_payload(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            profit_repair_settlement_ledger=profit_repair_settlement_ledger,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    clickhouse_ta_status = _load_clickhouse_ta_status(scheduler)
    route_evidence_clearinghouse_packet = _build_route_evidence_clearinghouse_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        dependency_quorum=dependency_quorum.as_payload(),
        build=build_payload,
        proof_floor=proof_floor,
        profit_signal_quorum=profit_signal_quorum,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
        tca_summary=tca_summary,
        options_catalog_freshness=options_catalog_freshness,
    )
    profit_freshness_frontier = _build_profit_freshness_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        dependency_quorum=dependency_quorum.as_payload(),
        proof_floor=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs,
        hypothesis_payload=hypothesis_payload,
    )
    repair_bid_settlement_ledger = _build_repair_bid_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        dependency_quorum=dependency_quorum.as_payload(),
        build=build_payload,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quant_evidence=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
    )
    revenue_repair_digest = build_revenue_repair_digest(
        readyz_payload={
            "status": "degraded"
            if live_submission_gate.get("allowed") is not True
            else "ok",
            "proof_floor": proof_floor,
            "live_submission_gate": live_submission_gate,
            "quant_evidence": quant_evidence,
            "dependencies": readiness_dependencies,
        },
        status_payload={
            "mode": settings.trading_mode,
            "pipeline_mode": "simple",
            "build": build_payload,
            "dependency_quorum": dependency_quorum.as_payload(),
            "live_submission_gate": live_submission_gate,
            "proof_floor": proof_floor,
            "quant_evidence": quant_evidence,
            "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
            "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
            "capital_replay_board": capital_replay_projection.get(
                "capital_replay_board"
            ),
            "executable_alpha_receipts": capital_replay_projection.get(
                "executable_alpha_receipts"
            ),
            "controller_ingestion_settlement": dependency_quorum.as_payload().get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": dependency_quorum.as_payload().get(
                "verify_trust_foreclosure_board"
            ),
            "repair_slot_escrow": dependency_quorum.as_payload().get(
                "repair_slot_escrow"
            ),
            "stage_debt_repair_admission": dependency_quorum.as_payload().get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": dependency_quorum.as_payload().get(
                "foreclosure_carry_rollout_witness"
            ),
        },
        generated_at=datetime.now(timezone.utc),
    )
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _build_evidence_clock_payloads(
            torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
            dependency_quorum=dependency_quorum.as_payload(),
            hypothesis_payload=hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            profit_signal_quorum=profit_signal_quorum,
            live_submission_gate=live_submission_gate,
            build=build_payload,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    )
    clock_settlement_receipt = _build_clock_settlement_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        build=build_payload,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=_build_route_image_proof_summary(
            build=build_payload,
            dependency_quorum=dependency_quorum.as_payload(),
        ),
    )
    route_warrant_exchange = _build_route_warrant_exchange_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
    )
    source_serving_repair_receipt_ledger = _build_source_serving_repair_receipt_payload(
        source_commit=BUILD_COMMIT,
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        route_warrant_exchange=route_warrant_exchange,
    )
    freshness_carry_ledger = _build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )
    repair_receipt_frontier = _build_repair_receipt_frontier_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        source_commit=BUILD_COMMIT,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
    )
    repair_outcome_dividend_ledger = _build_repair_outcome_dividend_ledger_payload(
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        repair_receipt_frontier=repair_receipt_frontier,
        freshness_carry_ledger=freshness_carry_ledger,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )
    profit_carry_passport_ledger = _build_profit_carry_passport_ledger_payload(
        torghut_revision=cast(str | None, shadow_first_runtime["active_revision"]),
        capital_replay_board=cast(
            Mapping[str, Any],
            capital_replay_projection["capital_replay_board"],
        ),
        route_reacquisition_board=route_reacquisition_board,
        proof_floor=proof_floor,
        market_context_status=market_context_status,
        hypothesis_payload=hypothesis_payload,
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
    )
    return {
        "schema_version": "torghut.consumer-evidence-status.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "enabled": settings.trading_enabled,
        "mode": settings.trading_mode,
        "running": state.running,
        "build": build_payload,
        "control_plane_dependency_mode": control_plane_dependency_mode,
        "dependency_quorum": dependency_quorum.as_payload(),
        "forecast_service": forecast_service_status,
        "lean_authority": lean_authority_status,
        "empirical_jobs": empirical_jobs,
        "market_context": market_context_status,
        "quant_evidence": quant_evidence,
        "live_submission_gate": live_submission_gate,
        "proof_floor": proof_floor,
        "simple_lane_status": simple_lane_status,
        "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
        "route_proven_profit_receipt": route_proven_profit_receipt,
        "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        "capital_reentry_cohort_ledger": capital_reentry_cohort_ledger,
        "profit_repair_settlement_ledger": profit_repair_settlement_ledger,
        "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
        "profit_freshness_frontier": profit_freshness_frontier,
        "profit_signal_quorum": profit_signal_quorum,
        "evidence_clock_arbiter": evidence_clock_arbiter,
        "routeable_profit_candidate_exchange": routeable_profit_candidate_exchange,
        "clock_settlement_receipt": clock_settlement_receipt,
        "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
        "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
        **_revenue_repair_topline_fields(revenue_repair_digest),
        "alpha_readiness_strike_ledger": revenue_repair_digest.get(
            "alpha_readiness_strike_ledger"
        ),
        "executable_alpha_repair_receipts": revenue_repair_digest.get(
            "executable_alpha_repair_receipts"
        ),
        "executable_alpha_settlement_slots": compact_executable_alpha_settlement_slots(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("executable_alpha_settlement_slots"),
            )
        ),
        "alpha_repair_closure_board": compact_alpha_repair_closure_board(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_closure_board"),
            )
        ),
        "alpha_evidence_foundry": compact_alpha_evidence_foundry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_evidence_foundry"),
            )
        ),
        "alpha_readiness_settlement_conveyor": compact_alpha_readiness_settlement_conveyor(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_readiness_settlement_conveyor"),
            )
        ),
        "alpha_repair_dividend_ledger": compact_alpha_repair_dividend_ledger(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            )
        ),
        "alpha_closure_dividend_slo": build_alpha_closure_dividend_slo(
            generated_at=datetime.now(timezone.utc),
            alpha_repair_closure_board=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_closure_board"),
            ),
            alpha_repair_dividend_ledger=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            ),
        ),
        "jangar_controller_ingestion_carry": compact_jangar_controller_ingestion_carry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("jangar_controller_ingestion_carry"),
            )
        ),
        "no_delta_repair_reentry_auction": compact_no_delta_repair_reentry_auction(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("no_delta_repair_reentry_auction"),
            )
        ),
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "profit_carry_passport_ledger": profit_carry_passport_ledger,
    }


@app.get("/trading/consumer-evidence")
def trading_consumer_evidence(
    view: str | None = Query(default=None),
) -> dict[str, object]:
    """Return Jangar-facing Torghut evidence without recursive Jangar status fetches."""

    return _build_trading_consumer_evidence_payload(
        summary=_consumer_evidence_summary_view(view)
    )


@app.get("/trading/metrics")
def trading_metrics(session: Session = Depends(get_session)) -> dict[str, object]:
    """Expose trading metrics counters."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    metrics = scheduler.state.metrics
    market_context_status = scheduler.market_context_status()
    tca_summary = _load_tca_summary(session, scheduler=scheduler)
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
    snapshot["active_run_id"] = (active_runtime_context or {}).get(
        "run_id"
    ) or settings.trading_simulation_run_id
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
    capital_replay_projection = _build_autonomy_capital_replay_projection(scheduler)
    empirical_jobs = _empirical_jobs_status()
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
        "forecast_service": _forecast_service_status(empirical_jobs),
        "lean_authority": _lean_authority_status(),
        "empirical_jobs": empirical_jobs,
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "simulation": {
            "enabled": settings.trading_simulation_enabled,
            "run_id": (active_simulation_context or {}).get("run_id")
            or settings.trading_simulation_run_id,
            "dataset_id": (active_simulation_context or {}).get("dataset_id")
            or settings.trading_simulation_dataset_id,
            "window_start": (active_simulation_context or {}).get("window_start")
            or settings.trading_simulation_window_start,
            "window_end": (active_simulation_context or {}).get("window_end")
            or settings.trading_simulation_window_end,
            "time_source": trading_time_status(
                account_label=settings.trading_account_label
            ),
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


def _runtime_ledger_bucket_evidence_grade(row: StrategyRuntimeLedgerBucket) -> bool:
    raw_blockers = cast(Sequence[object], row.blockers_json or [])
    blockers = [str(item).strip() for item in raw_blockers if str(item).strip()]
    raw_payload_json = cast(object, row.payload_json)
    payload_json = (
        {
            str(key): item
            for key, item in cast(Mapping[object, object], raw_payload_json).items()
        }
        if isinstance(raw_payload_json, Mapping)
        else {}
    )
    return (
        row.pnl_basis == "realized_strategy_pnl_after_explicit_costs"
        and int(row.fill_count or 0) > 0
        and int(row.submitted_order_count or 0) > 0
        and int(row.closed_trade_count or 0) > 0
        and int(row.open_position_count or 0) == 0
        and row.filled_notional > 0
        and bool(row.execution_policy_hash_counts)
        and bool(row.cost_model_hash_counts)
        and bool(row.lineage_hash_counts)
        and not cost_basis_counts_have_non_promotion_grade_costs(
            payload_json.get("cost_basis_counts")
        )
        and not runtime_ledger_promotion_source_authority_blockers(payload_json)
        and not blockers
    )


def _daily_runtime_ledger_portfolio_summary(
    *,
    session: Session,
    account_label: str,
    stage_scope: str,
    observed_at: datetime,
) -> dict[str, object]:
    observed = (
        observed_at.astimezone(timezone.utc)
        if observed_at.tzinfo
        else observed_at.replace(tzinfo=timezone.utc)
    )
    day_start = observed.replace(hour=0, minute=0, second=0, microsecond=0)
    stage = stage_scope.strip()
    account = account_label.strip()
    stmt = (
        select(StrategyRuntimeLedgerBucket)
        .where(StrategyRuntimeLedgerBucket.bucket_ended_at >= day_start)
        .where(StrategyRuntimeLedgerBucket.bucket_ended_at <= observed)
        .where(StrategyRuntimeLedgerBucket.account_label == account)
        .order_by(
            StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
            StrategyRuntimeLedgerBucket.created_at.desc(),
        )
    )
    if stage in {"paper", "live"}:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.observed_stage == stage)
    else:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.observed_stage == "__missing__")
    try:
        get_bind = getattr(session, "get_bind", None)
        if callable(get_bind):
            try:
                bind = get_bind()
                dialect = getattr(getattr(bind, "dialect", None), "name", "")
                if dialect == "postgresql":
                    session.execute(text("SET LOCAL statement_timeout = 500"))
            except SQLAlchemyError:
                raise
            except Exception:
                pass
        rows = list(session.execute(stmt.limit(200)).scalars())
    except SQLAlchemyError as exc:
        logger.warning("Portfolio runtime-ledger daily summary unavailable: %s", exc)
        rollback = getattr(session, "rollback", None)
        if callable(rollback):
            try:
                rollback()
            except SQLAlchemyError:
                logger.warning(
                    "Failed to roll back portfolio runtime-ledger summary session"
                )
        reason_code = (
            "portfolio_runtime_ledger_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "portfolio_runtime_ledger_summary_unavailable"
        )
        return {
            "summary_basis": "runtime_ledger_daily_stage_account_scope",
            "day_start": day_start.isoformat(),
            "observed_at": observed.isoformat(),
            "filters": {
                "account_label": account,
                "stage_scope": stage,
                "observed_stage": stage
                if stage in {"paper", "live"}
                else "__missing__",
            },
            "bucket_count": 0,
            "evidence_grade_bucket_count": 0,
            "post_cost_net_pnl_per_day": "0",
            "filled_notional": "0",
            "candidate_ids": [],
            "db_row_refs": [],
            "blockers": [reason_code],
            "read_model_unavailable": True,
            "query_limit": 200,
        }
    evidence_rows = [row for row in rows if _runtime_ledger_bucket_evidence_grade(row)]
    net_pnl = sum(
        (row.net_strategy_pnl_after_costs for row in evidence_rows),
        Decimal("0"),
    )
    filled_notional = sum(
        (row.filled_notional for row in evidence_rows),
        Decimal("0"),
    )
    closed_trade_count = sum(
        max(0, int(row.closed_trade_count or 0)) for row in evidence_rows
    )
    open_position_count = sum(
        max(0, int(row.open_position_count or 0)) for row in evidence_rows
    )
    source_authority_blockers: list[str] = []
    source_authority_bucket_count = 0
    for row in rows:
        raw_payload = cast(object, row.payload_json)
        payload = (
            {
                str(key): item
                for key, item in cast(Mapping[object, object], raw_payload).items()
            }
            if isinstance(raw_payload, Mapping)
            else {}
        )
        row_source_blockers = runtime_ledger_promotion_source_authority_blockers(
            payload
        )
        if row_source_blockers:
            for blocker in row_source_blockers:
                if blocker not in source_authority_blockers:
                    source_authority_blockers.append(blocker)
        else:
            source_authority_bucket_count += 1
    net_pnl_by_day = {
        day_start.date().isoformat(): str(net_pnl),
    }
    filled_notional_by_day = {
        day_start.date().isoformat(): str(filled_notional),
    }
    daily_summary = {
        "runtime_ledger_observed_trading_day_count": 1 if rows else 0,
        "runtime_ledger_net_pnl_by_trading_day": net_pnl_by_day if rows else {},
        "runtime_ledger_mean_daily_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_median_daily_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_p10_daily_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_worst_day_net_pnl_after_costs": str(net_pnl),
        "runtime_ledger_max_intraday_drawdown": "0",
        "runtime_ledger_avg_daily_filled_notional": str(filled_notional),
        "runtime_ledger_filled_notional_by_trading_day": filled_notional_by_day
        if rows
        else {},
        "runtime_ledger_closed_trade_count_by_day": {
            day_start.date().isoformat(): closed_trade_count,
        }
        if rows
        else {},
        "runtime_ledger_filled_notional": str(filled_notional),
    }
    candidate_ids = sorted(
        {
            str(row.candidate_id).strip()
            for row in evidence_rows
            if str(row.candidate_id or "").strip()
        }
    )
    blockers: list[str] = []
    if not rows:
        blockers.append("portfolio_runtime_ledger_summary_missing")
    elif not evidence_rows:
        blockers.append("portfolio_runtime_ledger_summary_not_evidence_grade")
    for blocker in source_authority_blockers:
        if blocker not in blockers:
            blockers.append(blocker)
    profit_distance_readback = build_runtime_ledger_profit_distance_readback(
        summary=daily_summary,
        candidate_id=",".join(candidate_ids) if candidate_ids else None,
        observed_stage=stage if stage in {"paper", "live"} else None,
        runtime_ledger_bucket_count=len(rows),
        evidence_grade_runtime_ledger_bucket_count=len(evidence_rows),
        source_authority_bucket_count=source_authority_bucket_count,
        source_authority_blockers=source_authority_blockers,
        blockers=blockers,
        total_filled_notional=filled_notional,
        total_closed_trade_count=closed_trade_count,
        open_position_count=open_position_count,
    )
    return {
        "summary_basis": "runtime_ledger_daily_stage_account_scope",
        "day_start": day_start.isoformat(),
        "observed_at": observed.isoformat(),
        "filters": {
            "account_label": account,
            "stage_scope": stage,
            "observed_stage": stage if stage in {"paper", "live"} else "__missing__",
        },
        "bucket_count": len(rows),
        "evidence_grade_bucket_count": len(evidence_rows),
        "post_cost_net_pnl_per_day": str(net_pnl),
        "filled_notional": str(filled_notional),
        "closed_trade_count": closed_trade_count,
        "open_position_count": open_position_count,
        "source_authority_bucket_count": source_authority_bucket_count,
        "source_authority_blockers": source_authority_blockers,
        "runtime_ledger_profit_distance_readback": profit_distance_readback,
        "candidate_ids": candidate_ids,
        "db_row_refs": [str(row.id) for row in evidence_rows],
        "blockers": blockers,
        "query_limit": 200,
    }


def _build_current_evidence_epoch(
    *,
    session: Session,
    account_label: str,
    stage_scope: str,
) -> EvidenceEpoch:
    observed_at = datetime.now(timezone.utc)
    receipts: list[EvidenceReceipt] = []
    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    trading_status_ok, _scheduler_payload = _evaluate_scheduler_status(scheduler)

    try:
        database_contract = _evaluate_database_contract(session)
        database_ok = bool(database_contract.get("ok"))
        schema_current = bool(database_contract.get("schema_current"))
        schema_lineage_ready = bool(database_contract.get("schema_graph_lineage_ready"))
        schema_reasons = [
            str(item)
            for item in cast(
                Sequence[object],
                database_contract.get("schema_graph_lineage_errors") or [],
            )
            if str(item).strip()
        ]
        schema_head_signature = (
            str(database_contract.get("schema_head_signature"))
            if database_contract.get("schema_head_signature") is not None
            else None
        )
    except Exception as exc:
        database_ok = False
        schema_current = False
        schema_lineage_ready = False
        schema_reasons = [f"database_contract_unavailable:{type(exc).__name__}"]
        schema_head_signature = None

    receipts.append(
        build_jangar_authority_receipt(
            quorum_payload=resolve_hypothesis_dependency_quorum(
                load_hypothesis_registry()
            ).as_payload(),
            observed_at=observed_at,
        )
    )
    receipts.append(
        build_service_health_receipt(
            role="torghut-live",
            liveness_ok=True,
            readiness_ok=database_ok,
            db_check_ok=database_ok,
            trading_status_ok=trading_status_ok,
            image_digest=BUILD_IMAGE_DIGEST,
            revision=BUILD_COMMIT,
            observed_at=observed_at,
        )
    )
    receipts.append(
        build_schema_receipt(
            schema_current=schema_current,
            lineage_ready=schema_lineage_ready,
            schema_head_signature=schema_head_signature,
            reason_codes=schema_reasons,
            observed_at=observed_at,
        )
    )
    receipts.append(
        build_data_freshness_receipt(
            source="database_contract",
            fresh=database_ok,
            as_of=observed_at,
            observed_at=observed_at,
            max_age_seconds=settings.trading_empirical_job_stale_after_seconds,
            reason_codes=[] if database_ok else ["database_contract_not_ready"],
        )
    )

    empirical_status: dict[str, object]
    try:
        empirical_status = build_empirical_jobs_status(
            session=session,
            stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
        )
    except Exception as exc:
        empirical_status = {
            "ready": False,
            "status": "unknown",
            "authority": "blocked",
            "stale_after_seconds": settings.trading_empirical_job_stale_after_seconds,
            "message": "empirical jobs status unavailable",
            "eligible_jobs": [],
            "missing_jobs": [],
            "stale_jobs": [],
            "ineligible_jobs": [],
            "candidate_ids": [],
            "dataset_snapshot_refs": [],
            "blocked_reasons": [
                f"empirical_jobs_status_unavailable:{type(exc).__name__}"
            ],
            "jobs": {},
        }
    receipts.append(
        build_empirical_jobs_receipt(
            empirical_status=empirical_status,
            observed_at=observed_at,
            ttl_seconds=settings.trading_empirical_job_stale_after_seconds,
        )
    )
    receipts.append(
        build_artifact_parity_receipt(
            consumer_ref="torghut-live",
            image_ref=BUILD_IMAGE_DIGEST,
            required_platforms=_env_csv("TORGHUT_REQUIRED_IMAGE_PLATFORMS"),
            observed_platforms=_env_csv("TORGHUT_OBSERVED_IMAGE_PLATFORMS"),
            runtime_pull_failures=_env_json_string_list(
                "TORGHUT_RUNTIME_PULL_FAILURES_JSON"
            ),
            observed_at=observed_at,
        )
    )
    portfolio_runtime_ledger_summary = _daily_runtime_ledger_portfolio_summary(
        session=session,
        account_label=account_label,
        stage_scope=stage_scope,
        observed_at=observed_at,
    )
    candidate_ids_raw = portfolio_runtime_ledger_summary.get("candidate_ids")
    candidate_id_items: Sequence[object]
    if isinstance(candidate_ids_raw, Sequence) and not isinstance(
        candidate_ids_raw, (str, bytes, bytearray)
    ):
        candidate_id_items = cast(Sequence[object], candidate_ids_raw)
    else:
        candidate_id_items = ()
    portfolio_candidate_ids = [
        str(item).strip() for item in candidate_id_items if str(item).strip()
    ]
    portfolio_runtime_ledger_bucket_count = int(
        Decimal(str(portfolio_runtime_ledger_summary.get("bucket_count") or "0"))
    )
    receipts.append(
        build_portfolio_proof_receipt(
            portfolio_candidate_id=(
                ",".join(portfolio_candidate_ids) if portfolio_candidate_ids else ""
            ),
            target_net_pnl_per_day=Decimal("500"),
            post_cost_net_pnl_per_day=Decimal(
                str(
                    portfolio_runtime_ledger_summary.get("post_cost_net_pnl_per_day")
                    or "0"
                )
            ),
            holdout_result=None,
            runtime_closure_artifact_refs=(),
            runtime_ledger_summary=portfolio_runtime_ledger_summary
            if portfolio_runtime_ledger_bucket_count > 0
            else None,
            require_runtime_ledger_summary=True,
            observed_at=observed_at,
        )
    )
    return compile_evidence_epoch(
        account_label=account_label,
        stage_scope=stage_scope,
        receipts=receipts,
        created_at=observed_at,
    )


@app.get("/trading/evidence-epochs/latest")
def trading_evidence_epoch_latest(
    stage_scope: str = Query("shadow", min_length=1, max_length=32),
    account_label: str = Query(
        settings.trading_account_label, min_length=1, max_length=64
    ),
    refresh: bool = Query(True),
    persist: bool = Query(True),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Compile or return the latest cross-plane evidence epoch for operators."""

    if not refresh:
        persisted_payload = load_latest_evidence_epoch_payload(
            session,
            account_label=account_label,
            stage_scope=stage_scope,
        )
        if persisted_payload is not None:
            return persisted_payload

    epoch = _build_current_evidence_epoch(
        session=session,
        account_label=account_label,
        stage_scope=stage_scope,
    )
    payload = epoch.to_payload()
    if persist:
        try:
            persist_evidence_epoch(session, epoch)
            session.commit()
            payload["persisted"] = True
        except SQLAlchemyError as exc:
            session.rollback()
            logger.warning("Failed to persist evidence epoch: %s", exc)
            payload["persisted"] = False
            payload["persist_error"] = type(exc).__name__
    else:
        payload["persisted"] = False
    return payload


@app.get("/trading/evidence-epochs/{evidence_epoch_id}")
def trading_evidence_epoch_detail(
    evidence_epoch_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return one persisted cross-plane evidence epoch."""

    payload = load_evidence_epoch_payload(session, evidence_epoch_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="evidence_epoch_not_found")
    return payload


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
    tca_summary = _load_tca_summary(session, scheduler=scheduler)
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

    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
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
    tca_summary = _load_tca_summary(session, scheduler=scheduler)
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, _hypothesis_summary, _dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    live_submission_gate = _build_live_submission_gate_payload(
        scheduler.state,
        session=session,
        hypothesis_summary=hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        dspy_runtime_status=cast(
            dict[str, object],
            scheduler.llm_status().get("dspy_runtime", {}),
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


@app.get("/trading/paper-route-evidence")
def trading_paper_route_evidence(
    lookback_hours: int = Query(
        DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
        ge=1,
        le=MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
        description="Bounded fallback lookback window for targets without explicit windows.",
    ),
    target_limit: int = Query(
        DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        ge=1,
        le=MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        description="Maximum number of paper-route targets to audit.",
    ),
) -> JSONResponse:
    """Return target-by-target paper-route evidence collection status."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler

    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    with SessionLocal() as session:
        tca_summary = _load_tca_summary(session, scheduler=scheduler)
    market_context_status = scheduler.market_context_status()
    hypothesis_payload, _hypothesis_summary, _dependency_quorum = (
        _build_hypothesis_runtime_payload(
            scheduler,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
        )
    )
    with SessionLocal() as session:
        live_submission_gate = _build_live_submission_gate_payload(
            scheduler.state,
            session=session,
            hypothesis_summary=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=cast(
                dict[str, object],
                scheduler.llm_status().get("dspy_runtime", {}),
            ),
            quant_health_status=quant_evidence,
        )
    live_submission_gate = _merge_external_paper_route_target_plan(
        cast(Mapping[str, Any], live_submission_gate)
    )
    simple_lane_status = _build_simple_lane_status_payload()
    with SessionLocal() as session:
        route_reacquisition_book = _paper_route_probe_book_from_target_plan(
            live_submission_gate,
            simple_lane_status=simple_lane_status,
            state=scheduler.state,
            session=session,
        )
    if route_reacquisition_book is None:
        proof_floor = _build_profitability_proof_floor_payload(
            state=scheduler.state,
            torghut_revision=BUILD_VERSION,
            live_submission_gate=live_submission_gate,
            hypothesis_payload=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            simple_lane_status=simple_lane_status,
        )
        route_reacquisition_book = cast(
            Mapping[str, Any],
            proof_floor.get("route_reacquisition_book") or {},
        )
    with SessionLocal() as session:
        payload = build_paper_route_evidence_audit(
            session,
            live_submission_gate=cast(Mapping[str, Any], live_submission_gate),
            route_reacquisition_book=route_reacquisition_book,
            lookback_hours=lookback_hours,
            target_limit=target_limit,
            target_account_audit_available=settings.trading_mode == "paper",
        )
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


@app.get("/trading/paper-route-target-plan")
def trading_paper_route_target_plan() -> JSONResponse:
    """Return the lightweight next-window paper-route target plan."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler

    empirical_jobs: dict[str, object] | None = None
    quant_evidence: Mapping[str, Any] | None = None
    tca_summary: Mapping[str, Any] | None = None
    market_context_status: Mapping[str, Any] | None = None
    hypothesis_payload: Mapping[str, Any] | None = None

    live_submission_gate = _paper_route_cached_live_submission_gate(
        scheduler,
        require_bounded_sim_targets=settings.trading_mode == "live",
    )
    loaded_full_live_gate = False
    if live_submission_gate is None:
        empirical_jobs = _empirical_jobs_status()
        quant_evidence = load_quant_evidence_status(
            account_label=settings.trading_account_label,
        )
        with SessionLocal() as session:
            tca_summary = _load_tca_summary(session, scheduler=scheduler)
        market_context_status = scheduler.market_context_status()
        hypothesis_payload, _hypothesis_summary, _dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
            )
        )
        with SessionLocal() as session:
            live_submission_gate = _build_live_submission_gate_payload(
                scheduler.state,
                session=session,
                hypothesis_summary=hypothesis_payload,
                empirical_jobs_status=empirical_jobs,
                dspy_runtime_status=cast(
                    dict[str, object],
                    scheduler.llm_status().get("dspy_runtime", {}),
                ),
                quant_health_status=quant_evidence,
            )
        loaded_full_live_gate = True
    live_submission_gate = _merge_external_paper_route_target_plan(
        cast(Mapping[str, Any], live_submission_gate)
    )
    simple_lane_status = _build_simple_lane_status_payload()
    with SessionLocal() as session:
        route_reacquisition_book = _paper_route_probe_book_from_target_plan(
            live_submission_gate,
            simple_lane_status=simple_lane_status,
            state=scheduler.state,
            session=session,
        )
    if settings.trading_mode == "live" and loaded_full_live_gate:
        assert empirical_jobs is not None
        assert quant_evidence is not None
        assert tca_summary is not None
        assert market_context_status is not None
        assert hypothesis_payload is not None
        proof_floor = _build_profitability_proof_floor_payload(
            state=scheduler.state,
            torghut_revision=BUILD_VERSION,
            live_submission_gate=live_submission_gate,
            hypothesis_payload=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            simple_lane_status=simple_lane_status,
        )
        proof_floor_route_book = cast(
            Mapping[str, Any],
            proof_floor.get("route_reacquisition_book") or {},
        )
        if proof_floor_route_book:
            if route_reacquisition_book is None:
                route_reacquisition_book = proof_floor_route_book
            else:
                route_reacquisition_book = _merge_paper_route_probe_blocking_reasons(
                    route_reacquisition_book,
                    fallback_route_reacquisition_book=proof_floor_route_book,
                )
    if route_reacquisition_book is None:
        route_reacquisition_book = cast(Mapping[str, Any], {})
    with SessionLocal() as session:
        payload = build_paper_route_target_plan_payload(
            session,
            live_submission_gate=cast(Mapping[str, Any], live_submission_gate),
            route_reacquisition_book=route_reacquisition_book,
            # Keep this provider endpoint bounded; proof-grade runtime import
            # audits run from /trading/paper-route-evidence.
            include_runtime_window_import_audit=False,
            target_account_audit_available=settings.trading_mode == "paper",
        )
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


def _mapping_items(value: object) -> list[dict[str, Any]]:
    return _shared_mapping_items(value)


def _paper_route_target_plan_probe_symbols(plan: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for target in _paper_route_target_plan_targets(plan):
        raw_symbols = target.get("paper_route_probe_symbols")
        if isinstance(raw_symbols, str):
            values: Sequence[object] = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols,
            (bytes, bytearray),
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for item in values:
            symbol = str(item).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def _paper_route_target_plan_probe_notional(
    plan: Mapping[str, Any],
    *,
    simple_lane_status: Mapping[str, Any],
) -> str | None:
    candidate_values: list[object] = []
    for target in _paper_route_target_plan_targets(plan):
        candidate_values.extend(
            [
                target.get("paper_route_probe_next_session_max_notional"),
                target.get("bounded_evidence_collection_max_notional"),
                target.get("paper_route_probe_effective_max_notional"),
            ]
        )
    candidate_values.append(simple_lane_status.get("paper_route_probe_max_notional"))
    positive_values = [
        amount
        for value in candidate_values
        if (amount := _decimal_or_none(value)) is not None and amount > 0
    ]
    if not positive_values:
        return None
    return _decimal_to_string(max(positive_values))


def _paper_route_target_plan_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _paper_route_target_plan_cache_safe_for_live(
    plan: Mapping[str, Any],
) -> bool:
    targets = _paper_route_target_plan_targets(plan)
    if not targets:
        return False
    for key in (
        "promotion_allowed",
        "final_promotion_allowed",
        "final_promotion_authorized",
    ):
        if _paper_route_target_plan_truthy(plan.get(key)):
            return False
    for target in targets:
        target_account = str(
            target.get("account_label") or target.get("source_account_label") or ""
        ).strip()
        if target_account != _PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL:
            return False
        for key in (
            "promotion_allowed",
            "final_promotion_allowed",
            "final_promotion_authorized",
        ):
            if _paper_route_target_plan_truthy(target.get(key)):
                return False
    return True


def _paper_route_cached_live_submission_gate(
    scheduler: object,
    *,
    require_bounded_sim_targets: bool = False,
) -> dict[str, object] | None:
    cached_gate = getattr(scheduler, "_last_live_submission_gate", None)
    if not isinstance(cached_gate, Mapping):
        return None
    gate = dict(cast(Mapping[str, object], cached_gate))
    plan = _paper_route_target_plan_from_payload(gate)
    if not _paper_route_target_plan_targets(plan):
        return None
    if require_bounded_sim_targets and not _paper_route_target_plan_cache_safe_for_live(
        plan
    ):
        return None
    gate.setdefault("paper_route_target_plan_source", "cached_live_submission_gate")
    return gate


def _paper_route_target_strategy_lookup_names(
    target: Mapping[str, Any],
) -> list[str]:
    names: list[str] = []
    for raw_value in (
        target.get("strategy_lookup_names"),
        target.get("runtime_strategy_name"),
        target.get("strategy_name"),
    ):
        values: Sequence[object]
        if isinstance(raw_value, Sequence) and not isinstance(
            raw_value,
            (str, bytes, bytearray),
        ):
            values = cast(Sequence[object], raw_value)
        else:
            values = (raw_value,)
        for value in values:
            if value is None:
                continue
            name = str(value).strip()
            if name and name not in names:
                names.append(name)
    return names


def _paper_route_probe_symbols_from_target_plan_strategies(
    session: Session,
    targets: Sequence[Mapping[str, Any]],
) -> list[str]:
    lookup_names: list[str] = []
    for target in targets:
        for name in _paper_route_target_strategy_lookup_names(target):
            if name not in lookup_names:
                lookup_names.append(name)
    if not lookup_names:
        return []

    rows = session.execute(
        select(Strategy.name, Strategy.universe_symbols).where(
            Strategy.name.in_(lookup_names)
        )
    ).all()
    universe_by_name = {
        str(name): universe_symbols for name, universe_symbols in rows if name
    }
    symbols: list[str] = []
    for name in lookup_names:
        raw_symbols = universe_by_name.get(name)
        if isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols,
            (str, bytes, bytearray),
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for raw_symbol in values:
            symbol = str(raw_symbol).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def _paper_route_probe_book_from_target_plan(
    live_submission_gate: Mapping[str, Any],
    *,
    simple_lane_status: Mapping[str, Any],
    state: object,
    session: Session | None = None,
) -> Mapping[str, Any] | None:
    plan = _paper_route_target_plan_from_payload(live_submission_gate)
    targets = _paper_route_target_plan_targets(plan)
    if not targets:
        return None
    eligible_symbols = _paper_route_target_plan_probe_symbols(plan)
    if not eligible_symbols and session is not None:
        eligible_symbols = _paper_route_probe_symbols_from_target_plan_strategies(
            session,
            targets,
        )
    if not eligible_symbols:
        return None
    next_session_max_notional = _paper_route_target_plan_probe_notional(
        plan,
        simple_lane_status=simple_lane_status,
    )
    if next_session_max_notional is None:
        return None

    configured_enabled = bool(simple_lane_status.get("paper_route_probe_enabled"))
    if not configured_enabled:
        return None
    market_session_open = cast(bool | None, getattr(state, "market_session_open", None))
    blocking_reasons: list[str] = []
    if settings.trading_mode != "paper":
        blocking_reasons.append("not_paper_mode")
    if market_session_open is not True:
        blocking_reasons.append("market_session_closed")
    active = configured_enabled and market_session_open is True and not blocking_reasons
    effective_max_notional = next_session_max_notional if active else "0"
    active_symbols = eligible_symbols if active else []
    return {
        "schema_version": "torghut.route-reacquisition-book.v1",
        "source": "paper_route_target_plan",
        "state": "repair_only",
        "account_label": settings.trading_account_label,
        "trading_mode": settings.trading_mode,
        "market_session_open": market_session_open,
        "summary": {
            "paper_route_probe_eligible_symbols": eligible_symbols,
            "paper_route_probe_active_symbols": active_symbols,
        },
        "paper_route_probe": {
            "configured_enabled": configured_enabled,
            "active": active,
            "effective_max_notional": effective_max_notional,
            "next_session_max_notional": next_session_max_notional,
            "eligible_symbol_count": len(eligible_symbols),
            "eligible_symbols": eligible_symbols,
            "active_symbols": active_symbols,
            "blocking_reasons": blocking_reasons,
            "capital_authority": "none",
        },
        "source_refs": {
            "target_plan_source": live_submission_gate.get(
                "paper_route_target_plan_source"
            ),
            "target_plan_target_count": len(targets),
        },
        "rollback_target": {
            "paper_probe_notional_limit": "0",
            "live_submit_enabled": False,
        },
    }


def _paper_route_probe_blocking_reasons_from_book(
    route_reacquisition_book: Mapping[str, Any],
) -> list[str]:
    raw_probe = route_reacquisition_book.get("paper_route_probe")
    if not isinstance(raw_probe, Mapping):
        return []
    probe = cast(Mapping[str, Any], raw_probe)
    raw_reasons = probe.get("blocking_reasons")
    if not isinstance(raw_reasons, Sequence) or isinstance(
        raw_reasons,
        (str, bytes, bytearray),
    ):
        return []
    reason_values = cast(Sequence[object], raw_reasons)
    reasons: list[str] = []
    for raw_reason in reason_values:
        reason = str(raw_reason).strip()
        if reason and reason not in reasons:
            reasons.append(reason)
    return reasons


def _merge_paper_route_probe_blocking_reasons(
    route_reacquisition_book: Mapping[str, Any],
    *,
    fallback_route_reacquisition_book: Mapping[str, Any],
) -> Mapping[str, Any]:
    fallback_reasons = _paper_route_probe_blocking_reasons_from_book(
        fallback_route_reacquisition_book
    )
    if not fallback_reasons:
        return route_reacquisition_book

    merged = deepcopy(dict(route_reacquisition_book))
    raw_probe = merged.get("paper_route_probe")
    probe: dict[str, Any] = (
        dict(cast(Mapping[str, Any], raw_probe))
        if isinstance(raw_probe, Mapping)
        else {}
    )
    reasons = _paper_route_probe_blocking_reasons_from_book(route_reacquisition_book)
    for reason in fallback_reasons:
        if reason not in reasons:
            reasons.append(reason)
    probe["blocking_reasons"] = reasons
    merged["paper_route_probe"] = probe
    return merged


def _paper_route_target_plan_targets(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    return _mapping_items(plan.get("targets"))


def _paper_route_target_plan_from_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    return _shared_paper_route_target_plan_from_payload(payload)


def _fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    max_attempts = max(int(attempts), 1)
    result: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        parsed = urlsplit(url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"}:
            return {
                "load_error": f"paper_route_target_plan_invalid_scheme:{scheme or 'missing'}"
            }
        if not parsed.hostname:
            return {"load_error": "paper_route_target_plan_invalid_host"}

        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
        connection = connection_class(
            parsed.hostname,
            parsed.port,
            timeout=max(float(timeout_seconds), 0.1),
        )
        try:
            host_header = parsed.netloc or parsed.hostname
            connection.request(
                "GET",
                path,
                headers={
                    "Accept": "application/json",
                    "Connection": "close",
                    "Host": host_header,
                },
            )
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                result = {
                    "load_error": f"paper_route_target_plan_http_status:{response.status}"
                }
            else:
                raw = response.read(5_000_001)
                if len(raw) > 5_000_000:
                    result = {
                        "load_error": "paper_route_target_plan_response_too_large"
                    }
                else:
                    try:
                        payload = json.loads(raw.decode("utf-8"))
                    except Exception as exc:
                        result = {
                            "load_error": f"paper_route_target_plan_invalid_json:{exc}"
                        }
                    else:
                        if not isinstance(payload, Mapping):
                            result = {
                                "load_error": "paper_route_target_plan_invalid_payload"
                            }
                        else:
                            plan = _paper_route_target_plan_from_payload(
                                cast(Mapping[str, Any], payload)
                            )
                            if not plan:
                                result = {
                                    "load_error": "paper_route_target_plan_missing"
                                }
                            else:
                                result = dict(plan)
                                result.setdefault(
                                    "source", "external_paper_route_target_plan"
                                )
        except Exception as exc:  # pragma: no cover - depends on network
            result = {"load_error": f"paper_route_target_plan_fetch_failed:{exc}"}
        finally:
            connection.close()

        if not str(result.get("load_error") or "").strip():
            if attempt > 1:
                result = dict(result)
                result["fetch_attempts"] = attempt
            return result
        if attempt < max_attempts:
            time.sleep(max(float(retry_backoff_seconds), 0.0))

    if max_attempts > 1:
        result = dict(result)
        result["fetch_attempts"] = max_attempts
    return result


def _load_external_paper_route_target_plan() -> dict[str, Any]:
    url = str(settings.trading_paper_route_target_plan_url or "").strip()
    if not url:
        return {}
    plan = _fetch_paper_route_target_plan_url(
        url,
        timeout_seconds=settings.trading_paper_route_target_plan_timeout_seconds,
        attempts=3,
        retry_backoff_seconds=0.25,
    )
    load_error = str(plan.get("load_error") or "").strip()
    if load_error:
        cached_plan = _cached_external_paper_route_target_plan_success(load_error)
        if cached_plan:
            logger.warning(
                "Using stale successful paper-route target plan after fetch failure url=%s error=%s",
                url,
                load_error,
            )
            return cached_plan
        return plan
    if _paper_route_target_plan_targets(plan):
        _remember_external_paper_route_target_plan_success(plan)
    return plan


def _remember_external_paper_route_target_plan_success(
    plan: Mapping[str, Any],
) -> None:
    global _paper_route_target_plan_success_cache

    if not _paper_route_target_plan_targets(plan):
        return
    with _PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK:
        _paper_route_target_plan_success_cache = (deepcopy(dict(plan)), time.time())


def _cached_external_paper_route_target_plan_success(
    load_error: str,
) -> dict[str, Any]:
    with _PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK:
        cached = _paper_route_target_plan_success_cache
    if cached is None:
        return {}
    plan, cached_at = cached
    age_seconds = max(time.time() - cached_at, 0.0)
    if age_seconds > _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS:
        return {}
    cached_plan = deepcopy(plan)
    cached_plan["paper_route_target_plan_cache_status"] = "stale_success"
    cached_plan["paper_route_target_plan_last_load_error"] = load_error
    cached_plan["paper_route_target_plan_stale_success_age_seconds"] = int(age_seconds)
    return cached_plan


def _merge_external_paper_route_target_plan(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    gate = dict(live_submission_gate)
    local_plan = _to_str_map(gate.get("runtime_ledger_paper_probation_import_plan"))
    if (
        _paper_route_target_plan_targets(local_plan)
        and not settings.trading_paper_route_target_plan_url
    ):
        return gate

    external_plan = _load_external_paper_route_target_plan()
    if not external_plan:
        if _paper_route_target_plan_targets(local_plan):
            return gate
        return gate

    load_error = str(external_plan.get("load_error") or "").strip()
    if load_error:
        gate["paper_route_target_plan_error"] = load_error
        if settings.trading_paper_route_target_plan_url:
            if _paper_route_target_plan_cache_safe_for_live(local_plan):
                gate.setdefault(
                    "paper_route_target_plan_source",
                    "local_runtime_ledger_paper_probation_import_plan",
                )
                gate["paper_route_target_plan_external_source"] = (
                    "external_target_plan_url"
                )
                return gate
            gate["runtime_ledger_paper_probation_import_plan"] = {
                "schema_version": local_plan.get("schema_version")
                or "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 0,
                "skipped_target_count": len(
                    _paper_route_target_plan_targets(local_plan)
                ),
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
                "targets": [],
                "skipped_targets": [
                    {
                        "reason": "external_paper_route_target_plan_unavailable",
                        "missing_or_blocking_fields": [load_error],
                    }
                ],
            }
            gate["paper_route_target_plan_source"] = "external_target_plan_url"
        return gate

    if _paper_route_target_plan_targets(
        local_plan
    ) and not _paper_route_target_plan_targets(external_plan):
        return gate

    if _paper_route_target_plan_targets(external_plan):
        merged_plan = dict(external_plan)
        cache_status = str(
            merged_plan.get("paper_route_target_plan_cache_status") or ""
        ).strip()
        last_load_error = str(
            merged_plan.get("paper_route_target_plan_last_load_error") or ""
        ).strip()
        merged_targets: list[dict[str, Any]] = []
        for raw_target in _paper_route_target_plan_targets(external_plan):
            target = dict(raw_target)
            target["paper_route_target_plan_source"] = "external_target_plan_url"
            if target.get("paper_route_probe_symbols"):
                target["paper_route_probe_scope_authority"] = "external_target_plan"
            merged_targets.append(target)
        merged_plan["targets"] = merged_targets
        merged_plan["target_count"] = len(merged_targets)
        merged_plan["skipped_target_count"] = int(
            merged_plan.get("skipped_target_count") or 0
        )
        merged_plan["promotion_allowed"] = False
        merged_plan["final_promotion_allowed"] = False
        merged_plan["final_promotion_authorized"] = False
        gate["runtime_ledger_paper_probation_import_plan"] = merged_plan
        gate["paper_route_target_plan_source"] = "external_target_plan_url"
        if cache_status:
            gate["paper_route_target_plan_cache_status"] = cache_status
        if last_load_error:
            gate["paper_route_target_plan_error"] = last_load_error
        return gate

    return gate


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
    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler

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
            "summary": _load_tca_summary(session, scheduler=scheduler),
            "aggregates": grouped,
            "rows": payload_rows,
        }
    )


@app.get("/trading/health")
def trading_health() -> JSONResponse:
    """Trading loop health including dependency readiness."""

    payload, status_code = _evaluate_trading_health_payload_bounded(
        surface="trading_health",
    )
    return JSONResponse(status_code=status_code, content=jsonable_encoder(payload))


def _check_postgres(session: Session) -> dict[str, object]:
    try:
        ping(session)
    except SQLAlchemyError as exc:
        return {"ok": False, "detail": f"postgres error: {exc}"}
    return {"ok": True, "detail": "ok"}


def _check_tigerbeetle_protocol_health() -> dict[str, object]:
    if not settings.tigerbeetle_enabled:
        health = check_tigerbeetle_health(settings)
        payload = health.as_dict()
        payload["protocol_ok"] = True
        payload["protocol_probe_skipped"] = False
        return payload

    replica_addresses = [
        item.strip()
        for item in settings.tigerbeetle_replica_addresses.split(",")
        if item.strip()
    ]
    if not (settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required):
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": True,
            "protocol_ok": False,
            "protocol_probe_skipped": True,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": None,
        }

    timeout_seconds = max(0.1, float(settings.tigerbeetle_health_timeout_seconds))
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(check_tigerbeetle_health, settings)
    try:
        health = future.result(timeout=timeout_seconds)
    except TimeoutError:
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": not settings.tigerbeetle_required,
            "protocol_ok": False,
            "protocol_probe_skipped": False,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": (
                f"TimeoutError: tigerbeetle protocol health timed out after "
                f"{timeout_seconds:.2f}s"
            ),
        }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    payload = health.as_dict()
    protocol_ok = bool(payload.get("ok"))
    payload["protocol_ok"] = protocol_ok
    payload["protocol_probe_skipped"] = False
    payload["ok"] = protocol_ok or not settings.tigerbeetle_required
    return payload


def _tigerbeetle_status_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _empty_tigerbeetle_ref_counts(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": settings.tigerbeetle_cluster_id,
        "ref_counts_unavailable": True,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "account_ref_count": 0,
        "transfer_ref_count": 0,
        "by_source_type": {},
        "order_event_ref_count": 0,
        "execution_ref_count": 0,
        "cost_ref_count": 0,
        "runtime_ledger_ref_count": 0,
        "stable_ref_count": 0,
        "stable_ref_missing_count": 0,
        "stable_ref_mismatch_count": 0,
        "stable_ref_diagnostic_bounded": True,
        "stable_ref_sample_size": 0,
        "runtime_ledger_required_bucket_count": 0,
        "runtime_ledger_signed_ref_count": 0,
        "runtime_ledger_missing_signed_ref_count": 0,
        "runtime_ledger_account_ref_count": 0,
        "runtime_ledger_missing_account_ref_count": 0,
        "runtime_ledger_missing_account_ids": [],
        "runtime_ledger_source_ids": [],
        "runtime_ledger_transfer_ids": [],
        "runtime_ledger_signed_bucket_ids": [],
        "runtime_ledger_ref_coverage_bounded": True,
        "runtime_ledger_ref_sample_size": 0,
        "source_materialization": {
            "account_ref_table": "tigerbeetle_account_refs",
            "transfer_ref_table": "tigerbeetle_transfer_refs",
            "reconciliation_run_table": "tigerbeetle_reconciliation_runs",
            "runtime_ledger_source_table": "strategy_runtime_ledger_buckets",
            "runtime_ledger_source_type": "strategy_runtime_ledger_bucket",
            "runtime_ledger_transfer_kind": "runtime_net_pnl",
        },
    }


def _unavailable_tigerbeetle_reconciliation_payload(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-reconciliation-status.v1",
        "ok": False,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "status": "unavailable",
        "age_seconds": None,
        "reconciliation_freshness": {
            "observed_at": None,
            "age_seconds": None,
            "max_age_seconds": max(
                1,
                int(settings.tigerbeetle_reconcile_max_age_seconds),
            ),
            "stale": True,
        },
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "blockers": list(reason_codes),
        "ref_counts": {},
    }


def _build_tigerbeetle_ledger_status(session: Session) -> dict[str, object]:
    protocol = _check_tigerbeetle_protocol_health()
    blockers: list[str] = []
    latest_reconciliation: dict[str, object] | None
    reconciliation_status_available = True
    try:
        bind = session.get_bind()
        if bind.dialect.name == "postgresql":
            session.execute(text("SET LOCAL statement_timeout = 750"))
        latest_reconciliation = latest_tigerbeetle_reconciliation_payload(
            session,
            cluster_id=settings.tigerbeetle_cluster_id,
        )
    except SQLAlchemyError as exc:
        logger.warning("TigerBeetle reconciliation status unavailable: %s", exc)
        session.rollback()
        reconciliation_status_available = False
        reason_codes = ["tigerbeetle_reconciliation_status_unavailable"]
        if _sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("tigerbeetle_reconciliation_status_query_timeout")
        blockers.extend(reason_codes)
        latest_reconciliation = _unavailable_tigerbeetle_reconciliation_payload(
            reason_codes=reason_codes,
            last_error=str(exc),
        )

    ref_counts: dict[str, object]
    ref_counts_available = True
    try:
        bind = session.get_bind()
        if bind.dialect.name == "postgresql":
            session.execute(text("SET LOCAL statement_timeout = 750"))
        ref_counts = tigerbeetle_ref_counts(
            session,
            cluster_id=settings.tigerbeetle_cluster_id,
            full_ref_scan=False,
        )
    except SQLAlchemyError as exc:
        logger.warning("TigerBeetle ref-count status unavailable: %s", exc)
        session.rollback()
        ref_counts_available = False
        reason_codes = ["tigerbeetle_ref_counts_unavailable"]
        if _sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("tigerbeetle_ref_counts_query_timeout")
        blockers.extend(reason_codes)
        ref_counts = _empty_tigerbeetle_ref_counts(
            reason_codes=reason_codes,
            last_error=str(exc),
        )
    runtime_ledger_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_ref_count")
    )
    runtime_ledger_signed_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_signed_ref_count")
    )
    runtime_ledger_missing_signed_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_signed_ref_count")
    )
    runtime_ledger_missing_account_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_account_ref_count")
    )
    claimed_by_runtime_evidence = runtime_ledger_ref_count > 0
    if (
        settings.tigerbeetle_enabled
        and not bool(protocol.get("protocol_ok"))
        and not bool(protocol.get("protocol_probe_skipped"))
    ):
        blockers.append("tigerbeetle_protocol_unhealthy")
    reconciliation_ok = True
    reconciliation_required = bool(
        settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required
    )
    if latest_reconciliation is None:
        if reconciliation_required:
            reconciliation_ok = False
            blockers.append("tigerbeetle_reconciliation_missing")
    else:
        reconciliation_ok = bool(latest_reconciliation.get("ok"))
        reconciliation_age_seconds = _tigerbeetle_status_int(
            latest_reconciliation.get("age_seconds")
        )
        reconciliation_max_age_seconds = max(
            1,
            int(settings.tigerbeetle_reconcile_max_age_seconds),
        )
        if reconciliation_age_seconds > reconciliation_max_age_seconds:
            reconciliation_ok = False
            blockers.append(BLOCKER_RECONCILIATION_STALE)
        raw_blockers = latest_reconciliation.get("blockers")
        if isinstance(raw_blockers, Sequence) and not isinstance(
            raw_blockers, (str, bytes, bytearray)
        ):
            blocker_items = cast(Sequence[object], raw_blockers)
            blockers.extend(str(item) for item in blocker_items)
    if not reconciliation_status_available:
        reconciliation_ok = False
    if not ref_counts_available:
        reconciliation_ok = False
    reconciliation_age_seconds = (
        _tigerbeetle_status_int(latest_reconciliation.get("age_seconds"))
        if latest_reconciliation is not None
        else None
    )
    reconciliation_max_age_seconds = max(
        1,
        int(settings.tigerbeetle_reconcile_max_age_seconds),
    )
    reconciliation_stale = (
        reconciliation_age_seconds is not None
        and reconciliation_age_seconds > reconciliation_max_age_seconds
    )
    if runtime_ledger_missing_signed_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_ref_count and runtime_ledger_signed_ref_count <= 0:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_missing_account_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_account_refs_missing")

    protocol_gate_ok = bool(protocol.get("ok"))
    reconcile_gate_ok = reconciliation_ok or not reconciliation_required
    return {
        "schema_version": "torghut.tigerbeetle-ledger-status.v1",
        "enabled": settings.tigerbeetle_enabled,
        "journal_enabled": settings.tigerbeetle_journal_enabled,
        "required": settings.tigerbeetle_required,
        "reconcile_required": settings.tigerbeetle_reconcile_required,
        "claimed_by_runtime_evidence": claimed_by_runtime_evidence,
        "reconciliation_required": reconciliation_required,
        "ok": protocol_gate_ok and reconcile_gate_ok,
        "protocol_ok": bool(protocol.get("protocol_ok")),
        "protocol_probe_skipped": bool(protocol.get("protocol_probe_skipped")),
        "reconciliation_ok": reconciliation_ok,
        "reconciliation_age_seconds": reconciliation_age_seconds,
        "reconciliation_max_age_seconds": reconciliation_max_age_seconds,
        "reconciliation_stale": reconciliation_stale,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "replica_addresses": protocol.get("replica_addresses", []),
        "last_error": protocol.get("last_error"),
        "ref_counts": ref_counts,
        "account_ref_count": ref_counts.get("account_ref_count", 0),
        "transfer_ref_count": ref_counts.get("transfer_ref_count", 0),
        "runtime_ledger_ref_count": runtime_ledger_ref_count,
        "runtime_ledger_signed_ref_count": runtime_ledger_signed_ref_count,
        "runtime_ledger_missing_signed_ref_count": (
            runtime_ledger_missing_signed_ref_count
        ),
        "runtime_ledger_missing_account_ref_count": (
            runtime_ledger_missing_account_ref_count
        ),
        "source_materialization": ref_counts.get("source_materialization", {}),
        "latest_reconciliation": latest_reconciliation,
        "blockers": sorted(set(blockers)),
    }


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
    summary: dict[str, Any] = (
        dict(hypothesis_summary) if hypothesis_summary is not None else {}
    )
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
            dict(
                cast(
                    Mapping[str, Any],
                    hypothesis_summary.get("capital_stage_totals", {}),
                )
            )
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


def _forecast_service_status(
    empirical_jobs_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return cast(
        dict[str, object],
        forecast_status_from_empirical_jobs(empirical_jobs_status),
    )


def _lean_authority_status() -> dict[str, object]:
    return cast(dict[str, object], lean_authority_status())


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
    endpoint_class = (
        str(getattr(client, "endpoint_class", _alpaca_endpoint_class())).strip()
        or _alpaca_endpoint_class()
    )

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
    failure_detail = str(
        last_failure.get("detail") if last_failure else "alpaca probe failed"
    )
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


def _load_tca_summary(
    session: Session,
    *,
    scheduler: TradingScheduler | None = None,
) -> dict[str, object]:
    return build_tca_gate_inputs(
        session=session,
        account_label=settings.trading_account_label,
        symbols=_resolve_tca_scope_symbols(scheduler),
    )


def _load_clickhouse_ta_status(
    scheduler: TradingScheduler | None = None,
) -> dict[str, object]:
    pipeline = getattr(scheduler, "_pipeline", None) if scheduler is not None else None
    ingestor = getattr(pipeline, "ingestor", None)
    if isinstance(ingestor, ClickHouseSignalIngestor):
        return ingestor.latest_signal_status()
    return ClickHouseSignalIngestor(
        account_label=settings.trading_account_label
    ).latest_signal_status()


def _route_claim_symbols(profit_signal_quorum: Mapping[str, Any]) -> tuple[str, ...]:
    raw_quorums = profit_signal_quorum.get("quorums")
    if not isinstance(raw_quorums, Sequence) or isinstance(
        raw_quorums, (str, bytes, bytearray)
    ):
        return ()
    symbols: set[str] = set()

    def add_symbols(raw_symbols: object) -> None:
        if not isinstance(raw_symbols, Sequence) or isinstance(
            raw_symbols, (str, bytes, bytearray)
        ):
            return
        for raw_symbol in cast(Sequence[object], raw_symbols):
            symbol = str(raw_symbol or "").strip().upper()
            if symbol:
                symbols.add(symbol)

    for raw_quorum_item in cast(Sequence[object], raw_quorums):
        if not isinstance(raw_quorum_item, Mapping):
            continue
        raw_quorum = cast(Mapping[str, Any], raw_quorum_item)
        add_symbols(raw_quorum.get("symbols"))
        raw_signal = raw_quorum.get("route_tca_signal")
        if not isinstance(raw_signal, Mapping):
            continue
        route_tca_signal = cast(Mapping[str, Any], raw_signal)
        raw_details = route_tca_signal.get("details")
        if not isinstance(raw_details, Mapping):
            continue
        details = cast(Mapping[str, Any], raw_details)
        add_symbols(details.get("symbols"))
        raw_nested_details = details.get("details")
        if isinstance(raw_nested_details, Mapping):
            add_symbols(cast(Mapping[str, Any], raw_nested_details).get("symbols"))
    return tuple(sorted(symbols))


def _load_cached_options_catalog_freshness_summary(
    cache_key: tuple[str, ...],
) -> dict[str, object] | None:
    ttl_seconds = max(0, settings.trading_options_catalog_freshness_cache_seconds)
    if ttl_seconds <= 0:
        return None
    now = datetime.now(timezone.utc)
    with _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK:
        cache_entry = _OPTIONS_CATALOG_FRESHNESS_CACHE.get(cache_key)
        if cache_entry is None:
            return None
        cached_at, cached_payload = cache_entry
        age_seconds = (now - cached_at).total_seconds()
        if age_seconds >= ttl_seconds:
            _OPTIONS_CATALOG_FRESHNESS_CACHE.pop(cache_key, None)
            return None
    payload = deepcopy(cached_payload)
    payload["cache"] = {
        "hit": True,
        "cached_at": cached_at,
        "age_seconds": age_seconds,
        "ttl_seconds": ttl_seconds,
    }
    return payload


def _store_options_catalog_freshness_summary(
    cache_key: tuple[str, ...],
    payload: dict[str, object],
) -> dict[str, object]:
    ttl_seconds = max(0, settings.trading_options_catalog_freshness_cache_seconds)
    if ttl_seconds <= 0:
        return payload
    cached_at = datetime.now(timezone.utc)
    cache_payload = deepcopy(payload)
    cache_payload.pop("cache", None)
    with _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK:
        _OPTIONS_CATALOG_FRESHNESS_CACHE[cache_key] = (cached_at, cache_payload)
    payload = deepcopy(cache_payload)
    payload["cache"] = {
        "hit": False,
        "cached_at": cached_at,
        "age_seconds": 0.0,
        "ttl_seconds": ttl_seconds,
    }
    return payload


def _decimal_or_none(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def _load_bounded_options_catalog_freshness_summary(
    session: Session,
    scoped_symbols: tuple[str, ...],
    *,
    reason: str,
    reason_codes: list[str] | None = None,
) -> dict[str, object] | None:
    if not scoped_symbols:
        return None
    fallback_reason_codes = reason_codes if reason_codes is not None else [reason]
    if reason not in fallback_reason_codes:
        fallback_reason_codes.append(reason)
    rows: list[Mapping[str, object]] = []
    bounded_query = text(
        """
SELECT
  underlying_symbol,
  last_seen_ts,
  provider_updated_ts,
  close_price,
  open_interest
FROM torghut_options_contract_catalog
WHERE underlying_symbol = :route_symbol
  AND status = 'active'
LIMIT 1
"""
    )
    try:
        session.execute(text("SET LOCAL statement_timeout = 500"))
        for symbol in scoped_symbols:
            row = (
                session.execute(
                    bounded_query,
                    {"route_symbol": symbol},
                )
                .mappings()
                .first()
            )
            if row is not None:
                rows.append(cast(Mapping[str, object], row))
    except SQLAlchemyError as bounded_exc:
        logger.warning(
            "Options catalog bounded freshness fallback unavailable: %s",
            bounded_exc,
        )
        fallback_reason_codes.append(
            "options_catalog_freshness_bounded_route_scope_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(bounded_exc)
            else "options_catalog_freshness_bounded_route_scope_unavailable"
        )
        return None

    route_symbol_freshness: dict[str, dict[str, object]] = {}
    for row in rows:
        symbol = str(row.get("underlying_symbol") or "").strip().upper()
        if not symbol:
            continue
        route_symbol_freshness[symbol] = {
            "status": "current",
            "active_contracts": 1,
            "active_contracts_exact": False,
            "coverage_exact": False,
            "bounded": True,
            "newest_last_seen_ts": _ensure_utc_datetime(
                cast(datetime | None, row.get("last_seen_ts"))
            ),
            "missing_provider_updated_ts_count": 1,
            "provider_updated_ts_present": False,
            "newest_provider_updated_ts": _ensure_utc_datetime(
                cast(datetime | None, row.get("provider_updated_ts"))
            ),
            "missing_close_price_count": 1 if row.get("close_price") is None else 0,
            "zero_open_interest_count": 1
            if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
            else 0,
            "reason_codes": [
                "options_catalog_freshness_bounded_route_scope",
                *fallback_reason_codes,
            ],
        }

    newest_last_seen_values = [
        value
        for value in (
            _ensure_utc_datetime(cast(datetime | None, row.get("last_seen_ts")))
            for row in rows
        )
        if value is not None
    ]
    newest_provider_updated_values = [
        value
        for value in (
            _ensure_utc_datetime(cast(datetime | None, row.get("provider_updated_ts")))
            for row in rows
        )
        if value is not None
    ]
    active_contracts = len(rows)
    return {
        "status": "current" if active_contracts > 0 else "missing",
        "scope": "route_symbols",
        "bounded": True,
        "coverage_exact": False,
        "active_contracts_exact": False,
        "active_contracts": active_contracts,
        "newest_last_seen_ts": max(newest_last_seen_values)
        if newest_last_seen_values
        else None,
        "missing_provider_updated_ts_count": active_contracts,
        "provider_updated_ts_present": False,
        "newest_provider_updated_ts": max(newest_provider_updated_values)
        if newest_provider_updated_values
        else None,
        "missing_close_price_count": sum(
            1 for row in rows if row.get("close_price") is None
        ),
        "zero_open_interest_count": sum(
            1
            for row in rows
            if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
        ),
        "route_symbols": list(scoped_symbols),
        "route_symbol_freshness": route_symbol_freshness,
        "reason_codes": [
            "options_catalog_freshness_bounded_route_scope",
            *fallback_reason_codes,
        ],
    }


def _load_options_catalog_freshness_summary(
    session: Session, *, route_symbols: Sequence[str] | None = None
) -> dict[str, object]:
    scoped_symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in route_symbols or ()
                if str(symbol).strip()
            }
        )
    )
    cached_payload = _load_cached_options_catalog_freshness_summary(scoped_symbols)
    if cached_payload is not None:
        return cached_payload
    if (
        scoped_symbols
        and not settings.trading_options_catalog_freshness_exact_route_scope_enabled
    ):
        reason_codes = [
            "options_catalog_freshness_exact_route_scope_disabled",
        ]
        bounded_payload = _load_bounded_options_catalog_freshness_summary(
            session,
            scoped_symbols,
            reason=reason_codes[-1],
            reason_codes=reason_codes,
        )
        if bounded_payload is not None:
            return _store_options_catalog_freshness_summary(
                scoped_symbols,
                bounded_payload,
            )
        if (
            "options_catalog_freshness_bounded_route_scope_unavailable"
            not in reason_codes
        ):
            reason_codes.append(
                "options_catalog_freshness_bounded_route_scope_unavailable"
            )
        return _store_options_catalog_freshness_summary(
            scoped_symbols,
            {
                "status": "unavailable",
                "scope": "route_symbols",
                "route_symbols": list(scoped_symbols),
                "reason_codes": reason_codes,
            },
        )
    try:
        session.execute(text("SET LOCAL statement_timeout = 500"))
        if scoped_symbols:
            scoped_query = text(
                """
SELECT
  underlying_symbol,
  COUNT(*) AS active_contracts,
  MAX(last_seen_ts) AS newest_last_seen_ts,
  COUNT(*) FILTER (WHERE provider_updated_ts IS NULL) AS missing_provider_updated_ts_count,
  MAX(provider_updated_ts) AS newest_provider_updated_ts,
  COUNT(*) FILTER (WHERE close_price IS NULL) AS missing_close_price_count,
  COUNT(*) FILTER (WHERE COALESCE(open_interest, 0) <= 0) AS zero_open_interest_count
FROM torghut_options_contract_catalog
WHERE underlying_symbol IN :route_symbols
  AND status = 'active'
GROUP BY underlying_symbol
"""
            ).bindparams(bindparam("route_symbols", expanding=True))
            scoped_rows = list(
                session.execute(
                    scoped_query,
                    {"route_symbols": scoped_symbols},
                ).mappings()
            )
            active_contracts = sum(
                int(row["active_contracts"] or 0) for row in scoped_rows
            )
            newest_last_seen_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row["newest_last_seen_ts"])
                    )
                    for row in scoped_rows
                )
                if value is not None
            ]
            newest_last_seen_ts = (
                max(newest_last_seen_values) if newest_last_seen_values else None
            )
            missing_provider_updated_ts_count = sum(
                int(row["missing_provider_updated_ts_count"] or 0)
                for row in scoped_rows
            )
            newest_provider_updated_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row["newest_provider_updated_ts"])
                    )
                    for row in scoped_rows
                )
                if value is not None
            ]
            newest_provider_updated_ts = (
                max(newest_provider_updated_values)
                if newest_provider_updated_values
                else None
            )
            missing_close_price_count = sum(
                int(row["missing_close_price_count"] or 0) for row in scoped_rows
            )
            zero_open_interest_count = sum(
                int(row["zero_open_interest_count"] or 0) for row in scoped_rows
            )
        else:
            global_rows = list(
                session.execute(
                    text(
                        """
SELECT
  underlying_symbol,
  last_seen_ts,
  provider_updated_ts,
  close_price,
  open_interest
FROM torghut_options_contract_catalog
WHERE status = 'active'
ORDER BY last_seen_ts DESC NULLS LAST
LIMIT 200
"""
                    )
                ).mappings()
            )
            scoped_rows = []
            active_contracts = len(global_rows)
            newest_last_seen_values = [
                value
                for value in (
                    _ensure_utc_datetime(cast(datetime | None, row.get("last_seen_ts")))
                    for row in global_rows
                )
                if value is not None
            ]
            newest_last_seen_ts = (
                max(newest_last_seen_values) if newest_last_seen_values else None
            )
            missing_provider_updated_ts_count = sum(
                1 for row in global_rows if row.get("provider_updated_ts") is None
            )
            newest_provider_updated_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row.get("provider_updated_ts"))
                    )
                    for row in global_rows
                )
                if value is not None
            ]
            newest_provider_updated_ts = (
                max(newest_provider_updated_values)
                if newest_provider_updated_values
                else None
            )
            missing_close_price_count = sum(
                1 for row in global_rows if row.get("close_price") is None
            )
            zero_open_interest_count = sum(
                1
                for row in global_rows
                if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
            )
    except SQLAlchemyError as exc:
        logger.warning("Options catalog freshness summary unavailable: %s", exc)
        rollback = getattr(session, "rollback", None)
        if callable(rollback):
            try:
                rollback()
            except SQLAlchemyError:
                logger.warning("Failed to roll back options catalog freshness session")
        reason_codes = ["options_catalog_freshness_summary_unavailable"]
        if _sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("options_catalog_freshness_query_timeout")
        bounded_payload = _load_bounded_options_catalog_freshness_summary(
            session,
            scoped_symbols,
            reason=reason_codes[-1],
            reason_codes=reason_codes,
        )
        if bounded_payload is not None:
            return _store_options_catalog_freshness_summary(
                scoped_symbols,
                bounded_payload,
            )
        return _store_options_catalog_freshness_summary(
            scoped_symbols,
            {
                "status": "unavailable",
                "scope": "route_symbols" if scoped_symbols else "global",
                "route_symbols": list(scoped_symbols),
                "reason_codes": reason_codes,
            },
        )

    route_symbol_freshness = {
        str(scoped_row["underlying_symbol"]).strip().upper(): {
            "status": "current"
            if int(scoped_row["active_contracts"] or 0) > 0
            else "missing",
            "active_contracts": int(scoped_row["active_contracts"] or 0),
            "newest_last_seen_ts": _ensure_utc_datetime(
                cast(datetime | None, scoped_row["newest_last_seen_ts"])
            ),
            "missing_provider_updated_ts_count": int(
                scoped_row["missing_provider_updated_ts_count"] or 0
            ),
            "provider_updated_ts_present": int(
                scoped_row["missing_provider_updated_ts_count"] or 0
            )
            == 0
            and scoped_row["newest_provider_updated_ts"] is not None,
            "newest_provider_updated_ts": _ensure_utc_datetime(
                cast(datetime | None, scoped_row["newest_provider_updated_ts"])
            ),
            "missing_close_price_count": int(
                scoped_row["missing_close_price_count"] or 0
            ),
            "zero_open_interest_count": int(
                scoped_row["zero_open_interest_count"] or 0
            ),
        }
        for scoped_row in scoped_rows
    }
    return _store_options_catalog_freshness_summary(
        scoped_symbols,
        {
            "status": "current" if active_contracts > 0 else "missing",
            "scope": "route_symbols" if scoped_symbols else "global",
            "active_contracts": active_contracts,
            "active_contracts_exact": bool(scoped_symbols),
            "coverage_exact": bool(scoped_symbols),
            "query_limit": None if scoped_symbols else 200,
            "newest_last_seen_ts": newest_last_seen_ts,
            "missing_provider_updated_ts_count": missing_provider_updated_ts_count,
            "provider_updated_ts_present": missing_provider_updated_ts_count == 0
            and newest_provider_updated_ts is not None,
            "newest_provider_updated_ts": newest_provider_updated_ts,
            "missing_close_price_count": missing_close_price_count,
            "zero_open_interest_count": zero_open_interest_count,
            "route_symbols": list(scoped_symbols),
            "route_symbol_freshness": route_symbol_freshness,
        },
    )


def _resolve_tca_scope_symbols(
    scheduler: TradingScheduler | None,
) -> tuple[str, ...] | None:
    if scheduler is None:
        return None
    resolver = _resolve_universe_resolver_for_readiness(scheduler)
    if resolver is None:
        return None
    try:
        resolution = resolver.get_resolution()
    except Exception:  # pragma: no cover - diagnostic scope should not break routes
        logger.exception("Failed to resolve universe symbols for TCA scope")
        return None
    raw_symbols = getattr(resolution, "symbols", None)
    if not isinstance(raw_symbols, set):
        return None
    raw_symbol_set = cast(set[object], raw_symbols)
    symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in raw_symbol_set
                if str(symbol).strip()
            }
        )
    )
    return symbols or None


def _ensure_utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _load_last_decision_at(session: Session) -> datetime | None:
    return _ensure_utc_datetime(
        session.execute(select(func.max(TradeDecision.created_at))).scalar_one()
    )


def _build_hypothesis_runtime_payload(
    scheduler: TradingScheduler,
    *,
    tca_summary: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    dependency_quorum: JangarDependencyQuorumStatus | None = None,
    feature_readiness: Mapping[str, Any] | None = None,
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    registry = load_hypothesis_registry()
    if dependency_quorum is None:
        dependency_quorum = resolve_hypothesis_dependency_quorum(registry)
    resolved_feature_readiness = feature_readiness or _load_clickhouse_ta_status(
        scheduler
    )
    with SessionLocal() as session:
        summary_with_items = build_hypothesis_runtime_summary(
            session,
            state=scheduler.state,
            tca_summary=tca_summary,
            market_context_status=market_context_status,
            dependency_quorum=dependency_quorum,
            feature_readiness=resolved_feature_readiness,
        )
    items = list(
        cast(Sequence[Mapping[str, Any]], summary_with_items.get("items") or [])
    )
    summary = dict(summary_with_items)
    summary.pop("items", None)
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
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    resolved_clickhouse_ta_status = clickhouse_ta_status
    if resolved_clickhouse_ta_status is None:
        resolved_clickhouse_ta_status = _load_clickhouse_ta_status(
            cast(TradingScheduler | None, getattr(app.state, "trading_scheduler", None))
        )
    if settings.trading_pipeline_mode == "simple":
        gate = build_live_submission_gate_payload(
            state,
            session=session,
            hypothesis_summary=hypothesis_summary,
            empirical_jobs_status=empirical_jobs_status,
            dspy_runtime_status=dspy_runtime_status,
            quant_health_status=quant_health_status,
            clickhouse_ta_status=resolved_clickhouse_ta_status,
        )
        if settings.trading_mode != "live":
            gate["pipeline_mode"] = "simple"
            gate["configured_live_promotion"] = settings.trading_simple_submit_enabled
            gate["simple_lane"] = {
                "submit_enabled": settings.trading_simple_submit_enabled,
                "shared_gate_enforced": True,
                "blocked_reasons": [],
            }
            return gate
        blocked_reasons: list[str] = []
        if not settings.trading_enabled:
            blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            blocked_reasons.append("kill_switch_enabled")
        if not settings.trading_simple_submit_enabled:
            blocked_reasons.append("simple_submit_disabled")
        if settings.trading_emergency_stop_enabled and bool(
            getattr(state, "emergency_stop_active", False)
        ):
            blocked_reasons.append(
                str(
                    getattr(state, "emergency_stop_reason", "")
                    or "emergency_stop_active"
                )
            )
        merged_blocked_reasons = list(
            dict.fromkeys(
                [
                    *[
                        str(item).strip()
                        for item in cast(
                            Sequence[object],
                            gate.get("blocked_reasons") or [],
                        )
                        if str(item).strip()
                    ],
                    *blocked_reasons,
                ]
            )
        )
        gate["allowed"] = bool(gate.get("allowed", False)) and not blocked_reasons
        gate["blocked_reasons"] = merged_blocked_reasons
        if blocked_reasons:
            gate["reason"] = blocked_reasons[0]
            gate["capital_stage"] = "shadow"
            gate["capital_state"] = "observe"
        gate["pipeline_mode"] = "simple"
        gate["simple_lane"] = {
            "submit_enabled": settings.trading_simple_submit_enabled,
            "shared_gate_enforced": True,
            "blocked_reasons": blocked_reasons,
        }
        return gate
    return build_live_submission_gate_payload(
        state,
        session=session,
        hypothesis_summary=hypothesis_summary,
        empirical_jobs_status=empirical_jobs_status,
        dspy_runtime_status=dspy_runtime_status,
        quant_health_status=quant_health_status,
        clickhouse_ta_status=resolved_clickhouse_ta_status,
    )


_SIMPLE_LANE_ALLOWED_REJECT_REASONS = {
    "kill_switch_enabled",
    "invalid_qty_increment",
    "qty_below_min_after_clamp",
    "insufficient_buying_power",
    "max_notional_exceeded",
    "max_symbol_exposure_exceeded",
    "shorting_not_allowed_for_asset",
    "broker_precheck_failed",
    "broker_submit_failed",
}


def _build_simple_lane_status_payload() -> dict[str, object]:
    return {
        "enabled": settings.trading_pipeline_mode == "simple",
        "submit_enabled": settings.trading_simple_submit_enabled,
        "order_feed_telemetry_enabled": (
            settings.trading_simple_order_feed_telemetry_enabled
        ),
        "order_feed_ingestion_enabled": settings.trading_order_feed_enabled,
        "order_feed_bootstrap_configured": bool(
            settings.trading_order_feed_bootstrap_server_list
        ),
        "order_feed_topic_count": len(settings.trading_order_feed_topics),
        "order_feed_assignment_mode": settings.trading_order_feed_assignment_mode,
        "order_feed_auto_offset_reset": settings.trading_order_feed_auto_offset_reset,
        "order_feed_lifecycle_required": (
            settings.trading_pipeline_mode == "simple"
            and settings.trading_mode in {"paper", "live"}
        ),
        "order_feed_lifecycle_status": (
            "enabled"
            if settings.trading_simple_order_feed_telemetry_enabled
            else "disabled"
        ),
        "paper_route_probe_enabled": (
            settings.trading_simple_paper_route_probe_enabled
        ),
        "paper_route_probe_max_notional": (
            settings.trading_simple_paper_route_probe_max_notional
        ),
        "route_symbol_filter_enabled": settings.trading_pipeline_mode == "simple",
        "max_notional_per_order": settings.trading_simple_max_notional_per_order,
        "max_notional_per_symbol": settings.trading_simple_max_notional_per_symbol,
        "allowed_reject_reasons": sorted(_SIMPLE_LANE_ALLOWED_REJECT_REASONS),
    }


def _build_profitability_proof_floor_payload(
    *,
    state: object,
    torghut_revision: str | None,
    live_submission_gate: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_profitability_proof_floor_receipt(
        account_label=settings.trading_account_label,
        torghut_revision=torghut_revision,
        trading_mode=settings.trading_mode,
        market_session_open=cast(
            bool | None,
            getattr(state, "market_session_open", None),
        ),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        simple_lane_status=simple_lane_status or _build_simple_lane_status_payload(),
        tca_max_age_seconds=PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


def _build_renewal_bond_profit_escrow_payload(
    *,
    state: object,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
) -> dict[str, object]:
    return build_renewal_bond_profit_escrow(
        account_label=settings.trading_account_label,
        torghut_revision=torghut_revision,
        trading_mode=settings.trading_mode,
        market_session_open=cast(
            bool | None,
            getattr(state, "market_session_open", None),
        ),
        jangar_dependency_quorum=dependency_quorum,
        live_submission_gate=live_submission_gate,
        proof_floor=proof_floor,
        hypothesis_payload=hypothesis_payload,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        tca_max_age_seconds=PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    )


def _build_route_reacquisition_board_payload(
    *,
    proof_floor: Mapping[str, Any],
    active_revision: str | None,
) -> dict[str, object]:
    return build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        route_reacquisition_book=cast(
            Mapping[str, Any] | None,
            proof_floor.get("route_reacquisition_book"),
        ),
        active_revision=active_revision,
        jangar_continuity=_route_continuity_packet_for_proof_floor(proof_floor),
    )


def _build_jangar_contract_graduation_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    reasons = [
        str(item).strip()
        for item in cast(Sequence[object], dependency_quorum.get("reasons") or [])
        if str(item).strip()
    ]
    return {
        "contract_ref": "docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md",
        "state": "current" if decision == "allow" else "missing",
        "decision": decision,
        "reasons": reasons,
        "generated_at": dependency_quorum.get("generated_at"),
    }


def _build_jangar_material_verdict_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    raw_reasons: object = dependency_quorum.get("reasons")
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "verdict_ref": f"jangar-material-verdict:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "action_classes": ["paper_canary", "live_micro_canary", "live_scale"],
        "generated_at": dependency_quorum.get("generated_at"),
    }


def _build_jangar_execution_trust_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_execution_trust = dependency_quorum.get("execution_trust")
    empty_execution_trust: Mapping[str, Any] = {}
    execution_trust: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_execution_trust)
        if isinstance(raw_execution_trust, Mapping)
        else empty_execution_trust
    )
    decision = (
        str(
            execution_trust.get("decision")
            or execution_trust.get("state")
            or dependency_quorum.get("decision")
            or "unknown"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            execution_trust.get("state")
            or execution_trust.get("status")
            or ("current" if decision == "allow" else "degraded")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        execution_trust.get("reason_codes")
        or execution_trust.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "admission_ref": f"jangar-execution-trust:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "generated_at": execution_trust.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": execution_trust.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _consumer_evidence_jangar_continuity_packet(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    material_ref = _build_jangar_material_verdict_ref(dependency_quorum)
    decision = str(material_ref.get("decision") or "unknown")
    allow = decision == "allow"
    return {
        "epoch_id": material_ref["verdict_ref"],
        "state": "present" if allow else "missing",
        "decision": "allow" if allow else "hold",
        "fresh_until": dependency_quorum.get("fresh_until"),
        "blocking_reasons": [] if allow else [f"jangar_material_verdict_{decision}"],
        "action_class": "paper_canary",
    }


def _build_capital_replay_projection_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_replay_projection(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        jangar_contract_graduation_ref=_build_jangar_contract_graduation_ref(
            dependency_quorum
        ),
    )


def _build_profit_carry_passport_ledger_payload(
    *,
    torghut_revision: str | None,
    capital_replay_board: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    repair_outcome_dividend_ledger: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_carry_passport_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        capital_replay_board=capital_replay_board,
        route_reacquisition_board=route_reacquisition_board,
        proof_floor=proof_floor,
        market_context_status=market_context_status,
        hypothesis_payload=hypothesis_payload,
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
    )


def _build_capital_reentry_cohort_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_reentry_cohort_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        jangar_material_verdict_ref=_build_jangar_material_verdict_ref(
            dependency_quorum
        ),
    )


def _build_profit_repair_settlement_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_repair_settlement_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        jangar_execution_trust_admission_ref=_build_jangar_execution_trust_admission_ref(
            dependency_quorum
        ),
    )


def _build_profit_freshness_frontier_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_freshness_frontier(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        proof_window=settings.trading_jangar_quant_window,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs_status,
        hypothesis_payload=hypothesis_payload,
        jangar_reliability_settlement_ref=_build_jangar_reliability_settlement_ref(
            dependency_quorum
        ),
    )


def _build_routeability_repair_acceptance_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    profit_repair_settlement_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_routeability_repair_acceptance_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        revenue_repair_digest_ref="/trading/revenue-repair",
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        torghut_routeability_admission_ref=_build_torghut_routeability_admission_ref(
            dependency_quorum
        ),
    )


def _build_evidence_clock_payloads(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    build: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
) -> tuple[dict[str, object], dict[str, object]]:
    return build_evidence_clock_arbiter_and_exchange(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        build=build,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor_receipt=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_signal_quorum=profit_signal_quorum,
        live_submission_gate=live_submission_gate,
        torghut_custody_ref=_build_torghut_stage_clearance_packet_ref(
            dependency_quorum
        ),
        clickhouse_ta_status=clickhouse_ta_status,
    )


def _build_clock_settlement_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    rollout_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_clock_settlement_receipt(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=rollout_status,
    )


# fmt: off
def _build_route_image_proof_summary(*, build: Mapping[str, Any], dependency_quorum: Mapping[str, Any]) -> dict[str, object]:
# fmt: on
    raw_proof = (
        dependency_quorum.get("rollout_image_book")
        or dependency_quorum.get("image_proof_summary")
        or dependency_quorum.get("rollout_image_proof")
    )
    empty_proof: Mapping[str, Any] = {}
    # fmt: off
    image_proof: Mapping[str, Any] = cast(Mapping[str, Any], raw_proof) if isinstance(raw_proof, Mapping) else empty_proof
    raw_reasons: object = image_proof.get("reason_codes") or image_proof.get("blocking_reasons") or []
    # fmt: on
    payload: dict[str, object] = {
        "image_digest": image_proof.get("image_digest") or build.get("image_digest"),
        "active_revision": image_proof.get("active_revision")
        or build.get("active_revision"),
        "rollback_digest": image_proof.get("rollback_digest"),
        "state": image_proof.get("state") or image_proof.get("status") or "unknown",
        "reason_codes": [
            str(item).strip()
            for item in cast(Sequence[object], raw_reasons)
            if str(item).strip()
        ],
    }
    if "route_workloads_ok" in image_proof:
        payload["route_workloads_ok"] = image_proof.get("route_workloads_ok")
    return payload


# fmt: off
def _build_route_evidence_clearinghouse_payload(*, torghut_revision: str | None, source_commit: str | None, dependency_quorum: Mapping[str, Any], build: Mapping[str, Any], proof_floor: Mapping[str, Any], profit_signal_quorum: Mapping[str, Any], profit_repair_settlement_ledger: Mapping[str, Any], route_reacquisition_board: Mapping[str, Any], routeability_repair_acceptance_ledger: Mapping[str, Any], live_submission_gate: Mapping[str, Any], tca_summary: Mapping[str, Any], options_catalog_freshness: Mapping[str, Any]) -> dict[str, object]:
# fmt: on
    return build_route_evidence_clearinghouse_packet(
        account_label=settings.trading_account_label,
        session_id=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        proof_floor_receipt=proof_floor,
        profit_signal_quorum=profit_signal_quorum,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        profit_window_custody={
            "profit_window_contract": live_submission_gate.get(
                "profit_window_contract"
            ),
            "profit_lease_projection": live_submission_gate.get(
                "profit_lease_projection"
            ),
        },
        tca_summary=tca_summary,
        options_catalog_freshness=options_catalog_freshness,
        image_proof_summary=_build_route_image_proof_summary(
            build=build,
            dependency_quorum=dependency_quorum,
        ),
        routeability_acceptance_ledger=routeability_repair_acceptance_ledger,
        live_submission_gate=live_submission_gate,
    )


# fmt: off
def _build_repair_bid_settlement_payload(*, torghut_revision: str | None, source_commit: str | None, dependency_quorum: Mapping[str, Any], build: Mapping[str, Any], route_evidence_clearinghouse_packet: Mapping[str, Any], routeability_repair_acceptance_ledger: Mapping[str, Any], quant_evidence: Mapping[str, Any], profit_freshness_frontier: Mapping[str, Any] | None = None) -> dict[str, object]:
# fmt: on
    return build_repair_bid_settlement_ledger(
        account_label=settings.trading_account_label,
        session_id=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
        routeability_acceptance_ledger=routeability_repair_acceptance_ledger,
        active_run_dedupe_state={},
        jangar_scoped_quant_status=quant_evidence,
        profit_freshness_frontier=profit_freshness_frontier,
        rollout_image_summary=_build_route_image_proof_summary(
            build=build,
            dependency_quorum=dependency_quorum,
        ),
    )


# fmt: off
def _build_route_warrant_exchange_payload(*, torghut_revision: str | None, source_commit: str | None, build: Mapping[str, Any], consumer_evidence_receipt: Mapping[str, Any], evidence_clock_arbiter: Mapping[str, Any], routeable_profit_candidate_exchange: Mapping[str, Any], routeability_repair_acceptance_ledger: Mapping[str, Any], profit_freshness_frontier: Mapping[str, Any], live_submission_gate: Mapping[str, Any], quant_evidence: Mapping[str, Any], tca_summary: Mapping[str, Any], empirical_jobs_status: Mapping[str, Any], market_context_status: Mapping[str, Any]) -> dict[str, object]:
# fmt: on
    return build_route_warrant_exchange(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        market_context_status=market_context_status,
    )


def _build_source_serving_repair_receipt_payload(
    *,
    source_commit: str | None,
    build: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    route_evidence_clearinghouse_packet: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
) -> dict[str, object]:
    return build_source_serving_repair_receipt_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        source_commit=source_commit,
        source_ci_ref=BUILD_SOURCE_CI_REF,
        manifest_commit=BUILD_MANIFEST_COMMIT,
        manifest_image_digest=BUILD_MANIFEST_IMAGE_DIGEST,
        argo_sync_revision=BUILD_ARGO_SYNC_REVISION,
        argo_health=BUILD_ARGO_HEALTH,
        build=build,
        observed_contract_payloads={
            "consumer_evidence_status": {
                "schema_version": "torghut.consumer-evidence-status.v1",
            },
            "consumer_evidence_receipt": consumer_evidence_receipt,
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
            "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
            "route_warrant_exchange": route_warrant_exchange,
        },
        route_warrant_exchange=route_warrant_exchange,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
    )


def _build_freshness_carry_ledger_payload(
    *,
    source_serving_repair_receipt_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    return build_freshness_carry_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )


def _build_repair_receipt_frontier_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    source_serving_repair_receipt_ledger: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    return build_repair_receipt_frontier(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
        proof_floor_receipt=proof_floor,
    )


def _build_repair_outcome_dividend_ledger_payload(
    *,
    repair_bid_settlement_ledger: Mapping[str, Any],
    repair_receipt_frontier: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    return build_repair_outcome_dividend_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        repair_bid_settlement_ledger=repair_bid_settlement_ledger,
        repair_receipt_frontier=repair_receipt_frontier,
        freshness_carry_ledger=freshness_carry_ledger,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )


def _build_jangar_reliability_settlement_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_settlement = (
        dependency_quorum.get("reliability_settlement_ledger")
        or dependency_quorum.get("reliability_settlement")
        or dependency_quorum.get("rollout_slo_escrow")
    )
    settlement: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_settlement)
        if isinstance(raw_settlement, Mapping)
        else {}
    )
    decision = (
        str(
            settlement.get("decision")
            or settlement.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            settlement.get("state")
            or settlement.get("status")
            or ("current" if decision == "allow" else "missing")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        settlement.get("reason_codes")
        or settlement.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "settlement_ref": settlement.get("ledger_id")
        or settlement.get("settlement_ref")
        or f"jangar-reliability-settlement:dependency-quorum:{ref_suffix}",
        "ledger_id": settlement.get("ledger_id"),
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "reliability_settlement_ledger"
        if settlement.get("ledger_id") or settlement.get("settlement_ref")
        else "dependency_quorum_proxy",
        "generated_at": settlement.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": settlement.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
        "action_classes": ["torghut_observe", "paper_canary"],
    }


def _build_torghut_routeability_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_admission = dependency_quorum.get("routeability_admission")
    empty_admission: Mapping[str, Any] = {}
    admission: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_admission)
        if isinstance(raw_admission, Mapping)
        else empty_admission
    )
    decision = (
        str(
            admission.get("decision")
            or admission.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            admission.get("state")
            or admission.get("status")
            or ("current" if decision == "allow" else "missing")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        admission.get("reason_codes")
        or admission.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "admission_ref": f"jangar-routeability-admission:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "routeability_admission"
        if admission.get("admission_ref") or admission.get("id")
        else "dependency_quorum_proxy",
        "action_classes": ["torghut_observe", "paper_canary"],
        "generated_at": admission.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": admission.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _build_torghut_stage_clearance_packet_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_packet = dependency_quorum.get("stage_clearance_packet")
    packet: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_packet) if isinstance(raw_packet, Mapping) else {}
    )
    decision = (
        str(
            packet.get("decision")
            or packet.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        packet.get("reason_codes")
        or packet.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    return {
        "packet_id": packet.get("packet_id") or packet.get("id"),
        "decision": decision,
        "state": packet.get("state")
        or ("current" if decision == "allow" else "missing"),
        "action_class": packet.get("action_class") or "torghut_capital",
        "reason_codes": [
            str(item).strip() for item in reason_items if str(item).strip()
        ],
        "source": "stage_clearance_packet"
        if packet.get("packet_id") or packet.get("id")
        else "dependency_quorum_proxy",
        "generated_at": packet.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": packet.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def _build_profit_signal_quorum_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_signal_quorum(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        torghut_stage_clearance_packet=_build_torghut_stage_clearance_packet_ref(
            dependency_quorum
        ),
    )


def _simulation_cache_status_payload(
    active_simulation_context: Mapping[str, Any] | None,
) -> dict[str, object]:
    context = active_simulation_context or {}
    return {
        "enabled": settings.trading_simulation_enabled,
        "run_id": context.get("run_id") or settings.trading_simulation_run_id,
        "dataset_id": context.get("dataset_id")
        or settings.trading_simulation_dataset_id,
        "window_start": context.get("window_start")
        or settings.trading_simulation_window_start,
        "window_end": context.get("window_end")
        or settings.trading_simulation_window_end,
        "last_updated_at": context.get("last_updated_at") or context.get("updated_at"),
    }


def _build_quality_adjusted_profit_frontier_payload(
    *,
    torghut_revision: str | None,
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    active_simulation_context: Mapping[str, Any] | None,
) -> dict[str, object]:
    return build_quality_adjusted_profit_frontier(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        hypothesis_payload=hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        simulation_cache_status=_simulation_cache_status_payload(
            active_simulation_context
        ),
        jangar_evidence_quality=_route_continuity_packet_for_proof_floor(proof_floor),
    )


def _build_autonomy_capital_replay_projection(
    scheduler: TradingScheduler,
) -> dict[str, object]:
    dependency_quorum = resolve_hypothesis_dependency_quorum(load_hypothesis_registry())
    try:
        empirical_jobs = _empirical_jobs_status()
        quant_evidence = load_quant_evidence_status(
            account_label=settings.trading_account_label,
        )
        market_context_status = scheduler.market_context_status()
        with SessionLocal() as session:
            tca_summary = _load_tca_summary(session, scheduler=scheduler)
        hypothesis_payload, _hypothesis_summary, dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
                dependency_quorum=dependency_quorum,
            )
        )
        with SessionLocal() as session:
            live_submission_gate = _build_live_submission_gate_payload(
                scheduler.state,
                session=session,
                hypothesis_summary=hypothesis_payload,
                empirical_jobs_status=empirical_jobs,
                dspy_runtime_status=cast(
                    dict[str, object],
                    scheduler.llm_status().get("dspy_runtime", {}),
                ),
                quant_health_status=quant_evidence,
            )
        proof_floor = _build_profitability_proof_floor_payload(
            state=scheduler.state,
            torghut_revision=BUILD_COMMIT,
            live_submission_gate=live_submission_gate,
            hypothesis_payload=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
        )
        route_reacquisition_board = _build_route_reacquisition_board_payload(
            proof_floor=proof_floor,
            active_revision=BUILD_COMMIT,
        )
        return _build_capital_replay_projection_payload(
            torghut_revision=BUILD_COMMIT,
            dependency_quorum=dependency_quorum.as_payload(),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    except Exception as exc:  # pragma: no cover - additive autonomy surface only
        return build_capital_replay_projection(
            account_label=settings.trading_account_label,
            trading_mode=settings.trading_mode,
            torghut_revision=BUILD_COMMIT,
            proof_floor_receipt={
                "route_state": "unavailable",
                "capital_state": "zero_notional",
                "blocking_reasons": [
                    f"capital_replay_projection_unavailable:{type(exc).__name__}"
                ],
            },
            route_reacquisition_board={"rows": []},
            live_submission_gate={
                "blocked_reasons": ["capital_replay_projection_unavailable"]
            },
            empirical_jobs_status={},
            quant_evidence={},
            market_context_status={},
            jangar_contract_graduation_ref=_build_jangar_contract_graduation_ref(
                dependency_quorum.as_payload()
            ),
        )


def _route_continuity_packet_for_proof_floor(
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    registry = load_hypothesis_registry()
    if hypothesis_registry_requires_dependency_capability(
        registry,
        "jangar_dependency_quorum",
    ):
        return load_jangar_route_continuity_packet(action_class="paper_canary")

    continuity_ref = (
        str(proof_floor.get("generated_at") or "").strip()
        or str(proof_floor.get("torghut_revision") or "").strip()
        or "unknown"
    )
    return {
        "epoch_id": f"torghut-self-continuity:{continuity_ref}",
        "state": "present",
        "decision": "allow",
        "fresh_until": proof_floor.get("fresh_until"),
        "blocking_reasons": [],
        "source": "torghut_hypothesis_registry",
        "action_class": "paper_canary",
    }


def _simple_lane_reject_reason_totals(state: object) -> dict[str, int]:
    metrics = getattr(state, "metrics", None)
    totals = getattr(metrics, "decision_reject_reason_total", {})
    if not isinstance(totals, Mapping):
        return {}
    payload: dict[str, int] = {}
    for key, value in cast(Mapping[object, Any], totals).items():
        normalized = str(key)
        if normalized not in _SIMPLE_LANE_ALLOWED_REJECT_REASONS:
            continue
        payload[normalized] = int(value)
    return payload


def _build_rejected_signal_outcome_learning_payload(
    state: object,
    *,
    persisted_summary: Mapping[str, object] | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    total = max(0, int(getattr(metrics, "rejected_signal_events_total", 0) or 0))
    pending = max(
        0,
        int(
            getattr(metrics, "rejected_signal_outcome_label_pending_total", 0) or 0
        ),
    )
    raw_reasons = getattr(metrics, "rejected_signal_reason_total", {})
    reasons: dict[str, int] = {}
    if isinstance(raw_reasons, Mapping):
        for key, value in cast(Mapping[object, Any], raw_reasons).items():
            reasons[str(key)] = max(0, int(value))
    latest_event = getattr(state, "last_rejected_signal_outcome_event", None)
    latest_payload: dict[str, object] | None = None
    if isinstance(latest_event, Mapping):
        latest_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], latest_event).items()
        }
    labeled_count = 0
    incomplete_count = 0
    outcome_label_status_total: dict[str, int] = {}
    persistence_state = "not_configured"
    if persisted_summary is not None:
        persistence_state = str(persisted_summary.get("persistence_state") or "ok")
        persisted_total = cast(Any, persisted_summary.get("events_total"))
        total = max(total, int(persisted_total or 0))
        persisted_pending = cast(
            Any, persisted_summary.get("outcome_label_pending_total")
        )
        pending = max(
            pending,
            int(persisted_pending or 0),
        )
        persisted_labeled = cast(Any, persisted_summary.get("labeled_count"))
        labeled_count = max(0, int(persisted_labeled or 0))
        persisted_incomplete = cast(Any, persisted_summary.get("incomplete_count"))
        incomplete_count = max(
            0, int(persisted_incomplete or 0)
        )
        persisted_status_total = persisted_summary.get("outcome_label_status_total")
        if isinstance(persisted_status_total, Mapping):
            outcome_label_status_total = {
                str(key): max(0, int(value))
                for key, value in cast(
                    Mapping[object, Any], persisted_status_total
                ).items()
            }
        persisted_reasons = persisted_summary.get("reason_total")
        if isinstance(persisted_reasons, Mapping):
            for key, value in cast(Mapping[object, Any], persisted_reasons).items():
                reasons[str(key)] = max(reasons.get(str(key), 0), int(value))
        persisted_latest = persisted_summary.get("latest_event")
        if isinstance(persisted_latest, Mapping):
            latest_payload = {
                str(key): value
                for key, value in cast(Mapping[object, object], persisted_latest).items()
            }
    blockers = ["counterfactual_outcome_labels_pending"] if pending > 0 else []
    state_label = "pending_outcome_labels"
    if pending <= 0:
        state_label = "labeled_outcomes_available" if labeled_count > 0 else "empty"
    return {
        "schema_version": "torghut.rejected-signal-outcome-learning.v1",
        "source": "runtime_quote_quality_gate",
        "paper_source": "paper-arxiv-2605.12151",
        "paper_claim_id": "rejection-event-outcome-labels",
        "state": state_label,
        "events_total": total,
        "outcome_label_pending_total": pending,
        "labeled_count": labeled_count,
        "incomplete_count": incomplete_count,
        "outcome_label_status_total": outcome_label_status_total,
        "reason_total": reasons,
        "latest_event": latest_payload,
        "persistence_state": persistence_state,
        "required_outcome_fields": [
            "counterfactual_return",
            "route_tca",
            "post_cost_net_pnl",
            "executable_quote",
        ],
        "promotion_impact": "repair_only_until_labeled",
        "blocking_reasons": blockers,
    }


def _load_rejected_signal_outcome_learning_summary(
    session: Session,
) -> dict[str, object] | None:
    try:
        total = int(
            session.execute(
                select(func.count(RejectedSignalOutcomeEvent.id))
            ).scalar_one()
            or 0
        )
        pending = int(
            session.execute(
                select(func.count(RejectedSignalOutcomeEvent.id)).where(
                    RejectedSignalOutcomeEvent.outcome_label_status == "pending"
                )
            ).scalar_one()
            or 0
        )
        status_rows = session.execute(
            select(
                RejectedSignalOutcomeEvent.outcome_label_status,
                func.count(RejectedSignalOutcomeEvent.id),
            ).group_by(RejectedSignalOutcomeEvent.outcome_label_status)
        ).all()
        outcome_label_status_total = {
            str(status or "unknown"): int(count or 0)
            for status, count in status_rows
        }
        reason_rows = session.execute(
            select(
                RejectedSignalOutcomeEvent.reject_reason,
                func.count(RejectedSignalOutcomeEvent.id),
            ).group_by(RejectedSignalOutcomeEvent.reject_reason)
        ).all()
        reason_total = {
            str(reason or "unknown"): int(count or 0)
            for reason, count in reason_rows
        }
        latest = session.execute(
            select(RejectedSignalOutcomeEvent).order_by(
                RejectedSignalOutcomeEvent.event_ts.desc(),
                RejectedSignalOutcomeEvent.created_at.desc(),
            ).limit(1)
        ).scalar_one_or_none()
        latest_payload: dict[str, object] | None = None
        if latest is not None:
            latest_payload = {
                "event_id": latest.event_id,
                "schema_version": "torghut.rejected-signal-outcome-event.v1",
                "source": latest.source,
                "paper_source": latest.paper_source,
                "paper_claim_id": latest.paper_claim_id,
                "account_label": latest.account_label,
                "symbol": latest.symbol,
                "event_ts": latest.event_ts.isoformat(),
                "timeframe": latest.timeframe,
                "seq": latest.seq,
                "reject_reason": latest.reject_reason,
                "spread_bps": str(latest.spread_bps)
                if latest.spread_bps is not None
                else None,
                "jump_bps": str(latest.jump_bps)
                if latest.jump_bps is not None
                else None,
                "outcome_label_status": latest.outcome_label_status,
                "counterfactual_required": latest.counterfactual_required,
                "required_outcome_fields": latest.required_outcome_fields_json,
            }
        return {
            "persistence_state": "ok",
            "events_total": total,
            "outcome_label_pending_total": pending,
            "labeled_count": outcome_label_status_total.get("labeled", 0),
            "incomplete_count": outcome_label_status_total.get("incomplete", 0),
            "outcome_label_status_total": outcome_label_status_total,
            "reason_total": reason_total,
            "latest_event": latest_payload,
        }
    except SQLAlchemyError:
        logger.exception("Failed to load rejected signal outcome learning summary")
        return {"persistence_state": "unavailable"}


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
    gate_artifact_path = str(
        getattr(scheduler.state, "last_autonomy_gates", "") or ""
    ).strip()
    gate_payload = _load_json_artifact_payload(gate_artifact_path)
    actuation_artifact_path = str(
        getattr(scheduler.state, "last_autonomy_actuation_intent", "") or ""
    ).strip()
    actuation_payload = _load_json_artifact_payload(actuation_artifact_path)
    actuation_gates = _to_str_map(actuation_payload.get("gates"))
    provenance_payload = _to_str_map(gate_payload.get("provenance"))
    drift_path = str(
        getattr(scheduler.state, "drift_last_outcome_path", "") or ""
    ).strip()
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
    vnext_payload = (
        cast(dict[str, object], vnext_raw) if isinstance(vnext_raw, dict) else {}
    )
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
        "run_id": str(gate_payload.get("run_id") or "").strip() or None,
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
