"""torghut FastAPI application entrypoint."""

import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .clickhouse import ClickHouseClient, get_clickhouse_client
from .config import settings
from .db import ensure_schema, get_session, ping

logger = logging.getLogger(__name__)

BUILD_VERSION = os.getenv("TORGHUT_VERSION", "dev")
BUILD_COMMIT = os.getenv("TORGHUT_COMMIT", "unknown")
SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
DEFAULT_TA_WINDOW_MINUTES = 15
MAX_TA_LIMIT = 10_000


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Run startup/shutdown tasks using FastAPI lifespan hooks."""

    try:
        ensure_schema()
    except SQLAlchemyError as exc:  # pragma: no cover - defensive for startup only
        logger.warning("Database not reachable during startup: %s", exc)
    yield


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


def _normalize_symbol(symbol: str) -> str:
    if not SYMBOL_PATTERN.match(symbol):
        raise HTTPException(status_code=400, detail="invalid symbol")
    return symbol.upper()


def _normalize_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _resolve_window(from_ts: datetime | None, to_ts: datetime | None) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    resolved_to = _normalize_datetime(to_ts) if to_ts else now
    resolved_from = (
        _normalize_datetime(from_ts)
        if from_ts
        else resolved_to - timedelta(minutes=DEFAULT_TA_WINDOW_MINUTES)
    )
    if resolved_from > resolved_to:
        raise HTTPException(status_code=400, detail="'from' must be before 'to'")
    return resolved_from, resolved_to


def _format_ts(value: datetime) -> str:
    return _normalize_datetime(value).isoformat().replace("+00:00", "Z")


def _execute_clickhouse(clickhouse: ClickHouseClient, sql: str) -> list[dict]:
    try:
        return clickhouse.query(sql)
    except Exception as exc:  # pragma: no cover - surfaced via HTTP
        logger.exception("ClickHouse query failed")
        raise HTTPException(status_code=503, detail="clickhouse unavailable") from exc


@app.get("/api/ta/bars")
def ta_bars(
    symbol: str = Query(..., min_length=1),
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
    interval: int = Query(1, ge=1, le=3600),
    limit: int = Query(5_000, ge=1, le=MAX_TA_LIMIT),
    clickhouse: ClickHouseClient = Depends(get_clickhouse_client),
) -> dict[str, object]:
    """Return microbars with optional downsampling for charting."""

    normalized_symbol = _normalize_symbol(symbol)
    resolved_from, resolved_to = _resolve_window(from_ts, to_ts)
    from_value = _format_ts(resolved_from)
    to_value = _format_ts(resolved_to)

    if interval <= 1:
        sql = f"""
          SELECT
            symbol,
            event_ts,
            seq,
            o,
            h,
            l,
            c,
            v,
            vwap,
            count
          FROM ta_microbars
          WHERE symbol = '{normalized_symbol}'
            AND event_ts >= parseDateTime64BestEffort('{from_value}')
            AND event_ts <= parseDateTime64BestEffort('{to_value}')
          ORDER BY event_ts ASC, seq ASC
          LIMIT {limit}
        """.strip()
    else:
        sql = f"""
          SELECT
            symbol,
            toStartOfInterval(event_ts, INTERVAL {interval} SECOND) AS event_ts,
            argMin(o, event_ts) AS o,
            max(h) AS h,
            min(l) AS l,
            argMax(c, event_ts) AS c,
            sum(v) AS v,
            if(sum(v) = 0, NULL, sum(ifNull(vwap, c) * v) / sum(v)) AS vwap,
            sum(count) AS count
          FROM ta_microbars
          WHERE symbol = '{normalized_symbol}'
            AND event_ts >= parseDateTime64BestEffort('{from_value}')
            AND event_ts <= parseDateTime64BestEffort('{to_value}')
          GROUP BY symbol, event_ts
          ORDER BY event_ts ASC
          LIMIT {limit}
        """.strip()

    rows = _execute_clickhouse(clickhouse, sql)
    return {
        "symbol": normalized_symbol,
        "from": from_value,
        "to": to_value,
        "interval": interval,
        "data": rows,
    }


@app.get("/api/ta/signals")
def ta_signals(
    symbol: str = Query(..., min_length=1),
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
    limit: int = Query(5_000, ge=1, le=MAX_TA_LIMIT),
    clickhouse: ClickHouseClient = Depends(get_clickhouse_client),
) -> dict[str, object]:
    """Return TA signals over a window for charting."""

    normalized_symbol = _normalize_symbol(symbol)
    resolved_from, resolved_to = _resolve_window(from_ts, to_ts)
    from_value = _format_ts(resolved_from)
    to_value = _format_ts(resolved_to)

    sql = f"""
      SELECT
        symbol,
        event_ts,
        seq,
        macd,
        macd_signal,
        macd_hist,
        ema12,
        ema26,
        rsi14,
        boll_mid,
        boll_upper,
        boll_lower,
        vwap_session,
        vwap_w5m,
        imbalance_spread,
        imbalance_bid_px,
        imbalance_ask_px,
        imbalance_bid_sz,
        imbalance_ask_sz,
        vol_realized_w60s
      FROM ta_signals
      WHERE symbol = '{normalized_symbol}'
        AND event_ts >= parseDateTime64BestEffort('{from_value}')
        AND event_ts <= parseDateTime64BestEffort('{to_value}')
      ORDER BY event_ts ASC, seq ASC
      LIMIT {limit}
    """.strip()

    rows = _execute_clickhouse(clickhouse, sql)
    return {
        "symbol": normalized_symbol,
        "from": from_value,
        "to": to_value,
        "data": rows,
    }


@app.get("/api/ta/latest")
def ta_latest(
    symbol: str = Query(..., min_length=1),
    clickhouse: ClickHouseClient = Depends(get_clickhouse_client),
) -> dict[str, object]:
    """Return the latest microbar and signal for a symbol."""

    normalized_symbol = _normalize_symbol(symbol)

    bar_sql = f"""
      SELECT
        symbol,
        event_ts,
        seq,
        o,
        h,
        l,
        c,
        v,
        vwap,
        count
      FROM ta_microbars
      WHERE symbol = '{normalized_symbol}'
      ORDER BY event_ts DESC, seq DESC
      LIMIT 1
    """.strip()

    signal_sql = f"""
      SELECT
        symbol,
        event_ts,
        seq,
        macd,
        macd_signal,
        macd_hist,
        ema12,
        ema26,
        rsi14,
        boll_mid,
        boll_upper,
        boll_lower,
        vwap_session,
        vwap_w5m,
        imbalance_spread,
        imbalance_bid_px,
        imbalance_ask_px,
        imbalance_bid_sz,
        imbalance_ask_sz,
        vol_realized_w60s
      FROM ta_signals
      WHERE symbol = '{normalized_symbol}'
      ORDER BY event_ts DESC, seq DESC
      LIMIT 1
    """.strip()

    bar_rows = _execute_clickhouse(clickhouse, bar_sql)
    signal_rows = _execute_clickhouse(clickhouse, signal_sql)

    bar = bar_rows[0] if bar_rows else None
    signal = signal_rows[0] if signal_rows else None
    if bar is None and signal is None:
        raise HTTPException(status_code=404, detail="no ta data found")

    return {"symbol": normalized_symbol, "bar": bar, "signal": signal}
