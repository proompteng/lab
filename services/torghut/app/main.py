"""torghut FastAPI application entrypoint."""

import logging
import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .alpaca_client import TorghutAlpacaClient
from .config import settings
from .db import ensure_schema, get_session, ping
from .models import Execution, LLMDecisionReview, TradeDecision
from .trading import TradingScheduler

logger = logging.getLogger(__name__)

BUILD_VERSION = os.getenv("TORGHUT_VERSION", "dev")
BUILD_COMMIT = os.getenv("TORGHUT_COMMIT", "unknown")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup/shutdown tasks using FastAPI lifespan hooks."""

    scheduler = TradingScheduler()
    app.state.trading_scheduler = scheduler

    try:
        ensure_schema()
    except SQLAlchemyError as exc:  # pragma: no cover - defensive for startup only
        logger.warning("Database not reachable during startup: %s", exc)

    if settings.trading_enabled:
        await scheduler.start()

    yield

    await scheduler.stop()


app = FastAPI(title="torghut", lifespan=lifespan)
app.state.settings = settings


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
def db_check(session: Session = Depends(get_session)) -> dict[str, bool]:
    """Verify basic database connectivity using the configured DSN."""

    try:
        ping(session)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc

    return {"ok": True}


@app.get("/trading/status")
def trading_status() -> dict[str, object]:
    """Return trading loop status and metrics."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    state = scheduler.state
    return {
        "enabled": settings.trading_enabled,
        "mode": settings.trading_mode,
        "kill_switch_enabled": settings.trading_kill_switch_enabled,
        "running": state.running,
        "last_run_at": state.last_run_at,
        "last_reconcile_at": state.last_reconcile_at,
        "last_error": state.last_error,
        "metrics": state.metrics.__dict__,
        "llm": scheduler.llm_status(),
    }


@app.get("/trading/metrics")
def trading_metrics() -> dict[str, object]:
    """Expose trading metrics counters."""

    scheduler: TradingScheduler | None = getattr(app.state, "trading_scheduler", None)
    if scheduler is None:
        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
    metrics = scheduler.state.metrics
    return {"metrics": metrics.__dict__}


@app.get("/trading/llm-evaluation/today")
def llm_evaluation_today(session: Session = Depends(get_session)) -> dict[str, object]:
    """Return today's LLM evaluation metrics in America/New_York."""

    payload = _llm_evaluation_metrics(session)
    return jsonable_encoder(payload)


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
            "status": execution.status,
            "created_at": execution.created_at,
            "last_update_at": execution.last_update_at,
            "alpaca_order_id": execution.alpaca_order_id,
        }
        for execution in executions
    ]
    return jsonable_encoder(payload)


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


def _llm_evaluation_metrics(session: Session) -> dict[str, object]:
    timezone_name = "America/New_York"
    tz = ZoneInfo(timezone_name)
    now_local = datetime.now(tz=tz)
    start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)

    base_stmt = (
        select(
            func.count(LLMDecisionReview.id),
            func.avg(LLMDecisionReview.confidence),
            func.coalesce(func.sum(LLMDecisionReview.tokens_prompt), 0),
            func.coalesce(func.sum(LLMDecisionReview.tokens_completion), 0),
        )
        .select_from(LLMDecisionReview)
        .join(TradeDecision, LLMDecisionReview.trade_decision_id == TradeDecision.id)
        .where(LLMDecisionReview.created_at >= start_utc)
        .where(LLMDecisionReview.created_at < end_utc)
    )
    total_reviews, avg_confidence, tokens_prompt, tokens_completion = session.execute(base_stmt).one()

    verdict_stmt = (
        select(LLMDecisionReview.verdict, func.count(LLMDecisionReview.id))
        .select_from(LLMDecisionReview)
        .join(TradeDecision, LLMDecisionReview.trade_decision_id == TradeDecision.id)
        .where(LLMDecisionReview.created_at >= start_utc)
        .where(LLMDecisionReview.created_at < end_utc)
        .group_by(LLMDecisionReview.verdict)
    )
    verdict_counts: dict[str, int] = {key: 0 for key in ["approve", "veto", "adjust", "error"]}
    for verdict, count in session.execute(verdict_stmt):
        verdict_counts[str(verdict)] = int(count or 0)

    total_reviews_int = int(total_reviews or 0)
    error_count = verdict_counts.get("error", 0)
    error_rate = (error_count / total_reviews_int) if total_reviews_int else 0.0

    risk_stmt = text(
        """
        SELECT flag, count(*) AS count
        FROM llm_decision_reviews AS review
        JOIN trade_decisions AS decision ON decision.id = review.trade_decision_id
        JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(review.risk_flags) = 'array' THEN review.risk_flags
            ELSE '[]'::jsonb
          END
        ) AS flag ON TRUE
        WHERE review.created_at >= :start_at
          AND review.created_at < :end_at
        GROUP BY flag
        ORDER BY count DESC, flag ASC
        LIMIT :limit
        """
    )
    risk_rows = session.execute(
        risk_stmt,
        {"start_at": start_utc, "end_at": end_utc, "limit": 5},
    ).all()
    top_risk_flags = [{"flag": str(flag), "count": int(count or 0)} for flag, count in risk_rows]

    payload = {
        "date": start_local.date().isoformat(),
        "timezone": timezone_name,
        "window_start": start_local.isoformat(),
        "window_end": end_local.isoformat(),
        "total_reviews": total_reviews_int,
        "verdict_counts": verdict_counts,
        "error_rate": round(error_rate, 6),
        "avg_confidence": float(avg_confidence) if avg_confidence is not None else None,
        "tokens_prompt_total": int(tokens_prompt or 0),
        "tokens_completion_total": int(tokens_completion or 0),
        "top_risk_flags": top_risk_flags,
    }
    return payload


def _check_clickhouse() -> dict[str, object]:
    if not settings.trading_clickhouse_url:
        return {"ok": False, "detail": "clickhouse url missing"}
    query = "SELECT 1 FORMAT JSONEachRow"
    params = {"query": query}
    request = Request(
        f"{settings.trading_clickhouse_url.rstrip('/')}/?{urlencode(params)}",
        headers={"Content-Type": "text/plain"},
    )
    if settings.trading_clickhouse_username:
        request.add_header("X-ClickHouse-User", settings.trading_clickhouse_username)
    if settings.trading_clickhouse_password:
        request.add_header("X-ClickHouse-Key", settings.trading_clickhouse_password)
    try:
        with urlopen(request, timeout=settings.trading_clickhouse_timeout_seconds) as response:
            payload = response.read().decode("utf-8")
    except Exception as exc:  # pragma: no cover - depends on network
        return {"ok": False, "detail": f"clickhouse error: {exc}"}
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
