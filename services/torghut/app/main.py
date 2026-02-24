"""torghut FastAPI application entrypoint."""

import logging
import os
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
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
    TradeDecision,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
)
from .trading import TradingScheduler
from .trading.autonomy import evaluate_evidence_continuity
from .trading.lean_lanes import LeanLaneManager
from .trading.llm.evaluation import build_llm_evaluation_metrics
from .whitepapers import (
    WhitepaperKafkaWorker,
    WhitepaperWorkflowService,
    whitepaper_workflow_enabled,
)

logger = logging.getLogger(__name__)

BUILD_VERSION = os.getenv("TORGHUT_VERSION", "dev")
BUILD_COMMIT = os.getenv("TORGHUT_COMMIT", "unknown")
LEAN_LANE_MANAGER = LeanLaneManager()
WHITEPAPER_WORKFLOW = WhitepaperWorkflowService()


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
    if "undefinedcolumn" in message or ("column" in message and "does not exist" in message):
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
    return {
        "workflow_enabled": whitepaper_workflow_enabled(),
        "kafka_enabled": True,
        "inngest_enabled": False,
        "inngest_registered": False,
        "worker_running": worker_running,
    }


@app.post("/whitepapers/events/github-issue")
def ingest_whitepaper_github_issue(
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> JSONResponse:
    """Ingest a GitHub issue webhook payload and create/update whitepaper workflow state."""

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
        raise HTTPException(status_code=500, detail=f"whitepaper_issue_intake_failed:{exc}") from exc


@app.post("/whitepapers/runs/{run_id}/dispatch-agentrun")
def dispatch_whitepaper_agentrun(
    run_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Dispatch Codex AgentRun for an existing whitepaper analysis run."""

    try:
        result = WHITEPAPER_WORKFLOW.dispatch_codex_agentrun(session, run_id)
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        session.rollback()
        logger.exception("Whitepaper AgentRun dispatch failed for run_id=%s", run_id)
        raise HTTPException(status_code=502, detail=f"whitepaper_agentrun_dispatch_failed:{exc}") from exc
    session.commit()
    return cast(dict[str, object], result)


@app.post("/whitepapers/runs/{run_id}/finalize")
def finalize_whitepaper_run(
    run_id: str,
    payload: dict[str, object] = Body(default={}),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Finalize run outputs from Inngest/AgentRun synthesis and verdict payloads."""

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
        raise HTTPException(status_code=500, detail=f"whitepaper_finalize_failed:{exc}") from exc
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

    agentrun = session.execute(
        select(WhitepaperCodexAgentRun)
        .where(WhitepaperCodexAgentRun.analysis_run_id == row.id)
        .order_by(WhitepaperCodexAgentRun.created_at.desc())
    ).scalar_one_or_none()

    pr_rows = session.execute(
        select(WhitepaperDesignPullRequest)
        .where(WhitepaperDesignPullRequest.analysis_run_id == row.id)
        .order_by(WhitepaperDesignPullRequest.attempt.asc())
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
                "source_identifier": row.document.source_identifier if row.document else None,
                "title": row.document.title if row.document else None,
                "status": row.document.status if row.document else None,
            },
            "document_version": {
                "version_number": row.document_version.version_number if row.document_version else None,
                "checksum_sha256": row.document_version.checksum_sha256 if row.document_version else None,
                "ceph_bucket": row.document_version.ceph_bucket if row.document_version else None,
                "ceph_object_key": row.document_version.ceph_object_key if row.document_version else None,
                "parse_status": row.document_version.parse_status if row.document_version else None,
                "parse_error": row.document_version.parse_error if row.document_version else None,
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
def get_lean_backtest(backtest_id: str, session: Session = Depends(get_session)) -> dict[str, object]:
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
    signal_lag_seconds = getattr(
        getattr(state, "metrics", None), "signal_lag_seconds", None
    )
    last_run_at = getattr(state, "last_run_at", None)
    last_reconcile_at = getattr(state, "last_reconcile_at", None)
    return {
        "contract_version": "torghut.quant-producer.v1",
        "signal_lag_seconds": signal_lag_seconds,
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
    if scheme not in {'http', 'https'}:
        return {'ok': False, 'detail': f'clickhouse invalid url scheme: {scheme or "missing"}'}
    if not parsed.hostname:
        return {'ok': False, 'detail': 'clickhouse invalid url host'}

    headers: dict[str, str] = {"Content-Type": "text/plain"}
    if settings.trading_clickhouse_username:
        headers["X-ClickHouse-User"] = settings.trading_clickhouse_username
    if settings.trading_clickhouse_password:
        headers["X-ClickHouse-Key"] = settings.trading_clickhouse_password

    path = parsed.path or '/'
    if parsed.query:
        path = f'{path}?{parsed.query}'
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    connection = connection_class(
        parsed.hostname,
        parsed.port,
        timeout=settings.trading_clickhouse_timeout_seconds,
    )

    try:
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return {'ok': False, 'detail': f'clickhouse http status {response.status}'}
        payload = response.read().decode('utf-8')
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
        aggregate[f"_{prefix}_sum"] = _tca_as_float(aggregate[f"_{prefix}_sum"]) + float(
            metric_value
        )
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
        aggregate["avg_churn_ratio"] = (churn_sum / churn_count) if churn_count else None
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


def _load_llm_evaluation(session: Session) -> dict[str, object]:
    try:
        return build_llm_evaluation_metrics(session)
    except SQLAlchemyError:
        return {"ok": False, "error": "database_unavailable"}
