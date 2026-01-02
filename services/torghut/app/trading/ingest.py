"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, cast
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import TradeCursor
from .models import SignalEnvelope

logger = logging.getLogger(__name__)


class ClickHouseSignalIngestor:
    """Poll ClickHouse for new TA signals using an event_ts cursor."""

    def __init__(
        self,
        url: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        table: Optional[str] = None,
        batch_size: Optional[int] = None,
        initial_lookback_minutes: Optional[int] = None,
        schema: Optional[str] = None,
    ) -> None:
        self.url = (url or settings.trading_clickhouse_url or "").rstrip("/")
        self.username = username or settings.trading_clickhouse_username
        self.password = password or settings.trading_clickhouse_password
        self.table = table or settings.trading_signal_table
        self.batch_size = batch_size or settings.trading_signal_batch_size
        self.initial_lookback_minutes = initial_lookback_minutes or settings.trading_signal_lookback_minutes
        self.schema = schema or settings.trading_signal_schema
        self._columns: Optional[set[str]] = None
        self._time_column: Optional[str] = None

    def fetch_signals(self, session: Session) -> list[SignalEnvelope]:
        if not self.url:
            logger.warning("ClickHouse URL missing; skipping signal ingestion")
            return []

        cursor = self._get_cursor(session)
        query = self._build_query(cursor)
        rows = self._query_clickhouse(query)
        signals: list[SignalEnvelope] = []

        max_event_ts: Optional[datetime] = None
        for row in rows:
            signal = self.parse_row(row)
            if signal is None:
                logger.warning("Skipping signal with missing event_ts or symbol")
                continue
            signals.append(signal)
            if max_event_ts is None or signal.event_ts > max_event_ts:
                max_event_ts = signal.event_ts

        if max_event_ts is not None:
            self._set_cursor(session, max_event_ts)

        return signals

    def parse_row(self, row: dict[str, Any]) -> Optional[SignalEnvelope]:
        event_ts = _parse_ts(row.get("event_ts")) or _parse_ts(row.get("ts")) or _parse_ts(row.get("timestamp"))
        symbol = row.get("symbol")
        if event_ts is None or not isinstance(symbol, str):
            return None
        try:
            payload = _normalize_payload(row.get("payload"))
            if not payload:
                payload = _payload_from_flat_row(row)
            return SignalEnvelope(
                event_ts=event_ts,
                ingest_ts=_parse_ts(row.get("ingest_ts")),
                symbol=symbol,
                payload=payload,
                timeframe=_coerce_timeframe(row, payload),
                seq=row.get("seq"),
                source=row.get("source"),
            )
        except Exception as exc:
            logger.warning("Skipping invalid signal row: %s", exc)
            return None

    def _build_query(self, cursor: datetime) -> str:
        cursor_str = cursor.strftime("%Y-%m-%d %H:%M:%S")
        limit = self.batch_size
        time_column = self._resolve_time_column()
        columns = self._resolve_columns()
        if columns:
            select_columns = _select_columns(columns, time_column)
            select_expr = ", ".join(select_columns)
        else:
            select_expr = "event_ts, ingest_ts, symbol, payload, window, seq, source"
        return (
            f"SELECT {select_expr} "
            f"FROM {self.table} "
            f"WHERE {time_column} > toDateTime('{cursor_str}') "
            f"ORDER BY {time_column} ASC "
            f"LIMIT {limit} "
            "FORMAT JSONEachRow"
        )

    def fetch_signals_between(
        self,
        start: datetime,
        end: datetime,
        symbol: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[SignalEnvelope]:
        if not self.url:
            logger.warning("ClickHouse URL missing; skipping signal replay")
            return []
        start_str = start.strftime("%Y-%m-%d %H:%M:%S")
        end_str = end.strftime("%Y-%m-%d %H:%M:%S")
        time_column = self._resolve_time_column()
        columns = self._resolve_columns()
        if columns:
            select_columns = _select_columns(columns, time_column)
            select_expr = ", ".join(select_columns)
        else:
            select_expr = "event_ts, ingest_ts, symbol, payload, window, seq, source"
        where_parts = [
            f"{time_column} >= toDateTime('{start_str}')",
            f"{time_column} <= toDateTime('{end_str}')",
        ]
        if symbol:
            where_parts.append(f"symbol = '{symbol}'")
        limit_clause = f"LIMIT {limit}" if limit else ""
        query = (
            f"SELECT {select_expr} FROM {self.table} WHERE {' AND '.join(where_parts)} "
            f"ORDER BY {time_column} ASC {limit_clause} FORMAT JSONEachRow"
        )
        rows = self._query_clickhouse(query)
        signals: list[SignalEnvelope] = []
        for row in rows:
            signal = self.parse_row(row)
            if signal is None:
                continue
            signals.append(signal)
        return signals

    def _query_clickhouse(self, query: str) -> list[dict[str, Any]]:
        params = {"query": query}
        request = Request(
            f"{self.url}/?{urlencode(params)}",
            headers={"Content-Type": "text/plain"},
        )
        if self.username:
            request.add_header("X-ClickHouse-User", self.username)
        if self.password:
            request.add_header("X-ClickHouse-Key", self.password)

        rows: list[dict[str, Any]] = []
        with urlopen(request, timeout=settings.trading_clickhouse_timeout_seconds) as response:
            payload = response.read().decode("utf-8")
        for line in payload.splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                logger.warning("Failed to decode ClickHouse row: %s", exc)
        return rows

    def _resolve_columns(self) -> Optional[set[str]]:
        if self.schema != "auto":
            return None
        if self._columns is not None:
            return self._columns
        database, table = _split_table(self.table)
        query = (
            "SELECT name FROM system.columns "
            f"WHERE database = '{database}' AND table = '{table}' "
            "FORMAT JSONEachRow"
        )
        try:
            rows = self._query_clickhouse(query)
        except Exception as exc:
            logger.warning("Failed to detect ClickHouse schema: %s", exc)
            self._columns = None
            return None
        self._columns = {str(row.get("name")) for row in rows if row.get("name")}
        return self._columns

    def _resolve_time_column(self) -> str:
        if self._time_column:
            return self._time_column
        if self.schema == "flat":
            self._time_column = "ts"
            return self._time_column
        if self.schema == "envelope":
            self._time_column = "event_ts"
            return self._time_column
        columns = self._resolve_columns()
        if columns:
            if "event_ts" in columns:
                self._time_column = "event_ts"
            elif "ts" in columns:
                self._time_column = "ts"
            else:
                self._time_column = "event_ts"
        else:
            self._time_column = "event_ts"
        return self._time_column

    def _get_cursor(self, session: Session) -> datetime:
        stmt = select(TradeCursor).where(TradeCursor.source == "clickhouse")
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            return cursor_row.cursor_at

        lookback = timedelta(minutes=self.initial_lookback_minutes)
        return datetime.now(timezone.utc) - lookback

    def _set_cursor(self, session: Session, cursor_at: datetime) -> None:
        stmt = select(TradeCursor).where(TradeCursor.source == "clickhouse")
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            cursor_row.cursor_at = cursor_at
            session.add(cursor_row)
        else:
            cursor_row = TradeCursor(source="clickhouse", cursor_at=cursor_at)
            session.add(cursor_row)
        session.commit()


def _parse_ts(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        cleaned = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(cleaned)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    return None


def _coerce_timeframe(row: dict[str, Any], payload: dict[str, Any]) -> Optional[str]:
    window = row.get("window")
    size: Optional[str] = None
    if isinstance(window, dict):
        window_dict = cast(dict[str, Any], window)
        raw_size = window_dict.get("size")
        if isinstance(raw_size, str):
            size = raw_size
    if payload:
        timeframe = payload.get("timeframe")
        if isinstance(timeframe, str):
            return timeframe
    timeframe = row.get("timeframe")
    if isinstance(timeframe, str):
        return timeframe
    if size == "PT1S":
        return "1Sec"
    if size == "PT1M":
        return "1Min"
    return None


def _normalize_payload(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return cast(dict[str, Any], payload)
    if isinstance(payload, str):
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        if isinstance(decoded, dict):
            return cast(dict[str, Any], decoded)
    return {}


def _payload_from_flat_row(row: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    signal_json = row.get("signal_json")
    if isinstance(signal_json, str):
        try:
            decoded = json.loads(signal_json)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, dict):
            payload.update(cast(dict[str, Any], decoded))

    macd_val = row.get("macd")
    signal_val = row.get("macd_signal") or row.get("signal")
    if macd_val is not None or signal_val is not None:
        payload.setdefault("macd", {})
        if isinstance(payload["macd"], dict):
            if macd_val is not None:
                payload["macd"]["macd"] = macd_val
            if signal_val is not None:
                payload["macd"]["signal"] = signal_val
        else:
            payload["macd"] = {"macd": macd_val, "signal": signal_val}

    for key in ("rsi", "rsi14"):
        if row.get(key) is not None and key not in payload:
            payload[key] = row.get(key)

    ema_val = row.get("ema")
    if ema_val is not None and "ema" not in payload:
        payload["ema"] = ema_val

    vwap_val = row.get("vwap")
    if vwap_val is not None and "vwap" not in payload:
        payload["vwap"] = vwap_val

    for key in ("price", "close"):
        if row.get(key) is not None and key not in payload:
            payload[key] = row.get(key)

    imbalance_spread = row.get("spread")
    if imbalance_spread is not None and "imbalance" not in payload:
        payload["imbalance"] = {"spread": imbalance_spread}

    return payload


def _select_columns(columns: set[str], time_column: str) -> list[str]:
    desired = [
        time_column,
        "event_ts",
        "ts",
        "ingest_ts",
        "symbol",
        "payload",
        "window",
        "seq",
        "source",
        "timeframe",
        "macd",
        "macd_signal",
        "signal",
        "rsi",
        "rsi14",
        "ema",
        "vwap",
        "signal_json",
        "close",
        "price",
        "spread",
    ]
    selected: list[str] = []
    seen: set[str] = set()
    for col in desired:
        if col in seen or col not in columns:
            continue
        selected.append(col)
        seen.add(col)
    return selected


def _split_table(table: str) -> tuple[str, str]:
    if "." in table:
        database, raw_table = table.split(".", 1)
        return database, raw_table
    return "default", table


__all__ = ["ClickHouseSignalIngestor"]
