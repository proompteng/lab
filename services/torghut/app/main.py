"""torghut FastAPI application entrypoint."""

import logging
import os
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from datetime import datetime
from decimal import Decimal
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .alpaca_client import TorghutAlpacaClient
from .config import settings
from .db import ensure_schema, get_session, ping
from .metrics import render_trading_metrics
from .models import Execution, ExecutionTCAMetric, TradeDecision
from .trading import TradingScheduler
from .trading.llm.evaluation import build_llm_evaluation_metrics

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
        },
        "metrics": state.metrics.__dict__,
        "llm": scheduler.llm_status(),
        "llm_evaluation": llm_evaluation,
        "tca": tca_summary,
        "control_plane_contract": control_plane_contract,
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
        {**metrics.__dict__, "tca_summary": _load_tca_summary(session)}
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
    request = Request(
        f"{settings.trading_clickhouse_url.rstrip('/')}/?{urlencode(params)}",
        headers={"Content-Type": "text/plain"},
    )
    if settings.trading_clickhouse_username:
        request.add_header("X-ClickHouse-User", settings.trading_clickhouse_username)
    if settings.trading_clickhouse_password:
        request.add_header("X-ClickHouse-Key", settings.trading_clickhouse_password)
    try:
        with urlopen(
            request, timeout=settings.trading_clickhouse_timeout_seconds
        ) as response:
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


def _tca_row_payload(row: ExecutionTCAMetric | None) -> dict[str, object] | None:
    if row is None:
        return None
    return {
        "arrival_price": row.arrival_price,
        "avg_fill_price": row.avg_fill_price,
        "slippage_bps": row.slippage_bps,
        "shortfall_notional": row.shortfall_notional,
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
        "last_computed_at": row[4],
    }


def _aggregate_tca_rows(
    rows: Sequence[ExecutionTCAMetric],
) -> dict[str, list[dict[str, object]]]:
    def _as_int(value: object) -> int:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        return 0

    def _as_float(value: object) -> float:
        if isinstance(value, bool):
            return float(value)
        if isinstance(value, (int, float)):
            return float(value)
        return 0.0

    by_strategy: dict[tuple[str, str], dict[str, object]] = {}
    by_symbol: dict[tuple[str, str, str], dict[str, object]] = {}
    for row in rows:
        strategy_key = str(row.strategy_id) if row.strategy_id else "unknown"
        account_key = row.alpaca_account_label or "unknown"
        symbol_key = row.symbol

        strategy_agg = by_strategy.setdefault(
            (strategy_key, account_key),
            {
                "strategy_id": strategy_key,
                "alpaca_account_label": account_key,
                "order_count": 0,
                "_slippage_sum": 0.0,
                "_slippage_count": 0,
                "_shortfall_sum": 0.0,
                "_shortfall_count": 0,
                "_churn_sum": 0.0,
                "_churn_count": 0,
            },
        )
        symbol_agg = by_symbol.setdefault(
            (strategy_key, account_key, symbol_key),
            {
                "strategy_id": strategy_key,
                "alpaca_account_label": account_key,
                "symbol": symbol_key,
                "order_count": 0,
                "_slippage_sum": 0.0,
                "_slippage_count": 0,
                "_shortfall_sum": 0.0,
                "_shortfall_count": 0,
                "_churn_sum": 0.0,
                "_churn_count": 0,
            },
        )
        for agg in (strategy_agg, symbol_agg):
            agg["order_count"] = _as_int(agg["order_count"]) + 1
            if row.slippage_bps is not None:
                agg["_slippage_sum"] = _as_float(agg["_slippage_sum"]) + float(
                    row.slippage_bps
                )
                agg["_slippage_count"] = _as_int(agg["_slippage_count"]) + 1
            if row.shortfall_notional is not None:
                agg["_shortfall_sum"] = _as_float(agg["_shortfall_sum"]) + float(
                    row.shortfall_notional
                )
                agg["_shortfall_count"] = _as_int(agg["_shortfall_count"]) + 1
            if row.churn_ratio is not None:
                agg["_churn_sum"] = _as_float(agg["_churn_sum"]) + float(
                    row.churn_ratio
                )
                agg["_churn_count"] = _as_int(agg["_churn_count"]) + 1

    def _finalize(aggregates: list[dict[str, object]]) -> list[dict[str, object]]:
        payload: list[dict[str, object]] = []
        for aggregate in aggregates:
            slippage_count = _as_int(aggregate.pop("_slippage_count"))
            slippage_sum = _as_float(aggregate.pop("_slippage_sum"))
            shortfall_count = _as_int(aggregate.pop("_shortfall_count"))
            shortfall_sum = _as_float(aggregate.pop("_shortfall_sum"))
            churn_count = _as_int(aggregate.pop("_churn_count"))
            churn_sum = _as_float(aggregate.pop("_churn_sum"))
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

    return {
        "strategy": _finalize(list(by_strategy.values())),
        "symbol": _finalize(list(by_symbol.values())),
    }


def _load_llm_evaluation(session: Session) -> dict[str, object]:
    try:
        return build_llm_evaluation_metrics(session)
    except SQLAlchemyError:
        return {"ok": False, "error": "database_unavailable"}
