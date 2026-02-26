"""torghut FastAPI application entrypoint."""

import json
import logging
import os
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, cast
from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from urllib.parse import urlencode, urlsplit

from .alpaca_client import TorghutAlpacaClient
from .config import settings
from .db import SessionLocal, check_schema_current, ensure_schema, get_session, ping
from .metrics import render_trading_metrics
from .models import (
    Execution,
    ExecutionTCAMetric,
    Strategy,
    TradeDecision,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
    WhitepaperEngineeringTrigger,
    WhitepaperRolloutTransition,
)
from .trading import TradingScheduler
from .trading.autonomy import evaluate_evidence_continuity
from .trading.lean_lanes import LeanLaneManager
from .trading.llm.evaluation import build_llm_evaluation_metrics
from .whitepapers import (
    WhitepaperKafkaWorker,
    WhitepaperWorkflowService,
    whitepaper_kafka_enabled,
    whitepaper_workflow_enabled,
)

logger = logging.getLogger(__name__)

BUILD_VERSION = os.getenv("TORGHUT_VERSION", "dev")
BUILD_COMMIT = os.getenv("TORGHUT_COMMIT", "unknown")
RUNTIME_PROFITABILITY_LOOKBACK_HOURS = 72
RUNTIME_PROFITABILITY_SCHEMA_VERSION = "torghut.runtime-profitability.v1"
LEAN_LANE_MANAGER = LeanLaneManager()
WHITEPAPER_WORKFLOW = WhitepaperWorkflowService()


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup/shutdown tasks using FastAPI lifespan hooks."""

    scheduler = TradingScheduler()
    whitepaper_worker = WhitepaperKafkaWorker(session_factory=SessionLocal)
    app.state.trading_scheduler = scheduler
    app.state.whitepaper_worker = whitepaper_worker

    try:
        ensure_schema()
    except SQLAlchemyError as exc:  # pragma: no cover - defensive for startup only
        logger.warning("Database not reachable during startup: %s", exc)

    if settings.trading_enabled:
        await scheduler.start()
    if whitepaper_workflow_enabled():
        await whitepaper_worker.start()

    yield

    await whitepaper_worker.stop()
    await scheduler.stop()


app = FastAPI(title="torghut", lifespan=lifespan)
app.state.settings = settings
app.state.whitepaper_inngest_registered = False


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
    logger.error("Unhandled database exception: %s", exc)
    return JSONResponse(status_code=503, content={"detail": detail})


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness endpoint for Kubernetes/Knative probes."""

    return {"status": "ok", "service": "torghut"}


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
        schema_status = check_schema_current(session)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not bool(schema_status.get("schema_current")):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "database schema mismatch",
                **schema_status,
            },
        )

    return {
        "ok": True,
        **schema_status,
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
        "inngest_enabled": False,
        "inngest_registered": False,
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

    approved_by = str(payload.get("approved_by") or payload.get("approvedBy") or "").strip()
    approval_reason = str(payload.get("approval_reason") or payload.get("approvalReason") or "").strip()
    approval_source = str(payload.get("approval_source") or payload.get("approvalSource") or "jangar_ui").strip()
    target_scope = str(payload.get("target_scope") or payload.get("targetScope") or "").strip() or None
    repository = str(payload.get("repository") or "").strip() or None
    base = str(payload.get("base") or "").strip() or None
    head = str(payload.get("head") or "").strip() or None
    rollout_profile = str(payload.get("rollout_profile") or payload.get("rolloutProfile") or "").strip() or None

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
        raise HTTPException(status_code=500, detail=f"whitepaper_manual_approval_failed:{exc}") from exc
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

    pr_rows = session.execute(
        select(WhitepaperDesignPullRequest)
        .where(WhitepaperDesignPullRequest.analysis_run_id == row.id)
        .order_by(WhitepaperDesignPullRequest.attempt.asc())
    ).scalars().all()
    trigger_row = session.execute(
        select(WhitepaperEngineeringTrigger).where(
            WhitepaperEngineeringTrigger.analysis_run_id == row.id
        )
    ).scalar_one_or_none()
    rollout_rows: Sequence[WhitepaperRolloutTransition] = []
    if trigger_row is not None:
        rollout_rows = session.execute(
            select(WhitepaperRolloutTransition)
            .where(WhitepaperRolloutTransition.trigger_id == trigger_row.id)
            .order_by(WhitepaperRolloutTransition.created_at.asc())
        ).scalars().all()

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
    control_plane_contract = _build_control_plane_contract(state)
    return {
        "enabled": settings.trading_enabled,
        "autonomy_enabled": settings.trading_autonomy_enabled,
        "mode": settings.trading_mode,
        "kill_switch_enabled": settings.trading_kill_switch_enabled,
        "running": state.running,
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
            "last_patch": state.last_autonomy_patch,
            "last_recommendation": state.last_autonomy_recommendation,
            "last_error": state.last_autonomy_error,
            "last_reason": state.last_autonomy_reason,
            "last_ingest_signal_count": state.last_ingest_signals_total,
            "last_ingest_reason": state.last_ingest_reason,
            "last_ingest_window_start": state.last_ingest_window_start,
            "last_ingest_window_end": state.last_ingest_window_end,
            "failure_streak": state.autonomy_failure_streak,
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
        "rollback": {
            "emergency_stop_active": state.emergency_stop_active,
            "emergency_stop_reason": state.emergency_stop_reason,
            "emergency_stop_triggered_at": state.emergency_stop_triggered_at,
            "emergency_stop_resolved_at": state.emergency_stop_resolved_at,
            "emergency_stop_recovery_streak": state.emergency_stop_recovery_streak,
            "incidents_total": state.rollback_incidents_total,
            "incident_evidence_path": state.rollback_incident_evidence_path,
        },
        "metrics": state.metrics.__dict__,
        "llm": scheduler.llm_status(),
        "llm_evaluation": llm_evaluation,
        "tca": tca_summary,
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
    return {
        "metrics": metrics.__dict__,
        "tca": _load_tca_summary(session),
        "control_plane_contract": _build_control_plane_contract(scheduler.state),
    }


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
        "last_patch": state.last_autonomy_patch,
        "last_recommendation": state.last_autonomy_recommendation,
        "last_error": state.last_autonomy_error,
        "last_reason": state.last_autonomy_reason,
        "last_ingest_signal_count": state.last_ingest_signals_total,
        "last_ingest_reason": state.last_ingest_reason,
        "last_ingest_window_start": state.last_ingest_window_start,
        "last_ingest_window_end": state.last_ingest_window_end,
        "failure_streak": state.autonomy_failure_streak,
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
    payload = render_trading_metrics(
        {
            **metrics.__dict__,
            "tca_summary": _load_tca_summary(session),
            "route_provenance": _load_route_provenance_summary(session),
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

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    scheduler_ok = True
    scheduler_detail = "ok"
    if settings.trading_enabled and not scheduler.state.running:
        scheduler_ok = False
        if scheduler.state.last_run_at is None:
            scheduler_detail = "trading loop not started"
        else:
            scheduler_detail = "trading loop not running"

    postgres_status = _check_postgres(session)
    if settings.trading_enabled:
        clickhouse_status = _check_clickhouse()
        alpaca_status = _check_alpaca()
    else:
        clickhouse_status = {"ok": True, "detail": "skipped (trading disabled)"}
        alpaca_status = {"ok": True, "detail": "skipped (trading disabled)"}

    dependencies = {
        "postgres": postgres_status,
        "clickhouse": clickhouse_status,
        "alpaca": alpaca_status,
    }

    overall_ok = scheduler_ok and all(dep["ok"] for dep in dependencies.values())
    status = "ok" if overall_ok else "degraded"

    payload = {
        "status": status,
        "scheduler": {"ok": scheduler_ok, "detail": scheduler_detail},
        "dependencies": dependencies,
    }

    status_code = 200 if overall_ok else 503
    return JSONResponse(status_code=status_code, content=jsonable_encoder(payload))


def _check_postgres(session: Session) -> dict[str, object]:
    try:
        ping(session)
    except SQLAlchemyError as exc:
        return {"ok": False, "detail": f"postgres error: {exc}"}
    return {"ok": True, "detail": "ok"}


def _build_control_plane_contract(state: object) -> dict[str, object]:
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
    return {
        "contract_version": "torghut.quant-producer.v1",
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
        "market_context_required": settings.trading_market_context_required,
        "market_context_max_staleness_seconds": settings.trading_market_context_max_staleness_seconds,
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


def _check_alpaca() -> dict[str, object]:
    if not settings.apca_api_key_id or not settings.apca_api_secret_key:
        return {"ok": False, "detail": "alpaca keys missing"}
    client = TorghutAlpacaClient()
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(client.get_account)
            future.result(timeout=2)
    except TimeoutError:
        return {"ok": False, "detail": "alpaca timeout"}
    except Exception as exc:  # pragma: no cover - depends on network
        return {"ok": False, "detail": f"alpaca error: {exc}"}
    return {"ok": True, "detail": "ok"}


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
    row = session.execute(
        select(
            func.count(ExecutionTCAMetric.id),
            func.avg(ExecutionTCAMetric.slippage_bps),
            func.avg(ExecutionTCAMetric.shortfall_notional),
            func.avg(ExecutionTCAMetric.churn_ratio),
            func.avg(ExecutionTCAMetric.divergence_bps),
            func.max(ExecutionTCAMetric.computed_at),
        )
    ).one()
    order_count_raw = row[0]
    order_count = (
        int(order_count_raw)
        if isinstance(order_count_raw, (int, float, Decimal))
        else 0
    )
    return {
        "order_count": order_count,
        "avg_slippage_bps": row[1],
        "avg_shortfall_notional": row[2],
        "avg_churn_ratio": row[3],
        "avg_divergence_bps": row[4],
        "last_computed_at": row[5],
    }


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
    gate6 = _extract_gate_result(
        cast(list[object], gate_payload.get("gates") or []),
        gate_id="gate6_profitability_evidence",
    )

    promotion_decision = _to_str_map(gate_payload.get("promotion_decision"))
    promotion_recommendation = _to_str_map(gate_payload.get("promotion_recommendation"))
    provenance = _to_str_map(gate_payload.get("provenance"))

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
        "gate_report_run_id": str(gate_payload.get("run_id") or "").strip() or None,
        "gate_report_trace_id": str(
            provenance.get("gate_report_trace_id") or ""
        ).strip()
        or None,
        "recommendation_trace_id": str(
            provenance.get("recommendation_trace_id") or ""
        ).strip()
        or None,
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


def _load_llm_evaluation(session: Session) -> dict[str, object]:
    try:
        return build_llm_evaluation_metrics(session)
    except SQLAlchemyError:
        return {"ok": False, "error": "database_unavailable"}
