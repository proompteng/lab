"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import Any, Optional, cast
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import TradeCursor
from .clickhouse import normalize_symbol, to_datetime64
from .models import SignalEnvelope

logger = logging.getLogger(__name__)

FLAT_CURSOR_OVERLAP = timedelta(seconds=2)

FLAT_SIGNAL_COLUMNS = [
    "ts",
    "symbol",
    "macd",
    "macd_signal",
    "signal",
    "rsi",
    "rsi14",
    "ema",
    "vwap",
    "signal_json",
    "timeframe",
    "price",
    "close",
    "spread",
]

ENVELOPE_SIGNAL_COLUMNS = [
    "event_ts",
    "ingest_ts",
    "symbol",
    "payload",
    "window_size",
    "window_step",
    "seq",
    "source",
]


@dataclass(frozen=True)
class SignalBatch:
    signals: list[SignalEnvelope]
    cursor_at: Optional[datetime]
    cursor_seq: Optional[int]
    cursor_symbol: Optional[str]


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
        fast_forward_stale_cursor: bool = True,
    ) -> None:
        self.url = (url or settings.trading_clickhouse_url or "").rstrip("/")
        self.username = username or settings.trading_clickhouse_username
        self.password = password or settings.trading_clickhouse_password
        self.table = table or settings.trading_signal_table
        self.batch_size = batch_size or settings.trading_signal_batch_size
        self.initial_lookback_minutes = initial_lookback_minutes or settings.trading_signal_lookback_minutes
        self.schema = schema or settings.trading_signal_schema
        self.fast_forward_stale_cursor = fast_forward_stale_cursor
        self._columns: Optional[set[str]] = None
        self._time_column: Optional[str] = None

    def fetch_signals(self, session: Session) -> "SignalBatch":
        if not self.url:
            logger.warning("ClickHouse URL missing; skipping signal ingestion")
            return SignalBatch(signals=[], cursor_at=None, cursor_seq=None, cursor_symbol=None)

        cursor_at, cursor_seq, cursor_symbol = self._get_cursor(session)
        if self.fast_forward_stale_cursor:
            min_cursor = datetime.now(timezone.utc) - timedelta(minutes=self.initial_lookback_minutes)
            if cursor_at < min_cursor:
                logger.warning(
                    "Trade cursor is stale; fast-forwarding cursor_at=%s -> %s",
                    cursor_at.isoformat(),
                    min_cursor.isoformat(),
                )
                cursor_at = min_cursor
                cursor_seq = None
                cursor_symbol = None
                self._set_cursor(session, cursor_at, cursor_seq, cursor_symbol)
        time_column = self._resolve_time_column()
        supports_seq = self._supports_seq_for_time_column(time_column)
        overlap_cutoff = cursor_at if time_column == "ts" and not supports_seq else None
        query = self._build_query(cursor_at, cursor_seq, cursor_symbol)
        rows = self._query_clickhouse(query)
        signals: list[SignalEnvelope] = []

        max_event_ts: Optional[datetime] = None
        max_seq: Optional[int] = None
        max_symbol: Optional[str] = None
        for row in rows:
            signal = self.parse_row(row)
            if signal is None:
                logger.warning("Skipping signal with missing event_ts or symbol")
                continue
            if overlap_cutoff is not None and signal.event_ts < overlap_cutoff:
                continue
            signals.append(signal)
            if max_event_ts is None or signal.event_ts > max_event_ts:
                max_event_ts = signal.event_ts
                max_seq = _coerce_seq(signal.seq)
                max_symbol = signal.symbol
            elif signal.event_ts == max_event_ts:
                candidate_seq = _coerce_seq(signal.seq)
                if candidate_seq is None:
                    candidate_seq = max_seq
                if max_seq is None or (candidate_seq is not None and candidate_seq > max_seq):
                    max_seq = candidate_seq
                    max_symbol = signal.symbol
                elif candidate_seq == max_seq:
                    if max_symbol is None or signal.symbol > max_symbol:
                        max_symbol = signal.symbol

        return SignalBatch(
            signals=signals,
            cursor_at=max_event_ts,
            cursor_seq=max_seq,
            cursor_symbol=max_symbol,
        )

    def commit_cursor(self, session: Session, batch: "SignalBatch") -> None:
        if batch.cursor_at is None:
            return
        self._set_cursor(session, batch.cursor_at, batch.cursor_seq, batch.cursor_symbol)

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

    def _build_query(
        self, cursor_at: datetime, cursor_seq: Optional[int], cursor_symbol: Optional[str]
    ) -> str:
        cursor_expr = to_datetime64(cursor_at)
        limit = self.batch_size
        time_column = self._resolve_time_column()
        supports_seq = self._supports_seq_for_time_column(time_column)
        select_expr = self._select_expression(time_column)
        where_clause = f"{time_column} > {cursor_expr}"
        order_clause = f"{time_column} ASC"
        if supports_seq:
            order_clause = f"{time_column} ASC, symbol ASC, seq ASC"
            if cursor_seq is not None or cursor_symbol is not None:
                symbol_clause = ""
                if cursor_symbol is not None:
                    symbol_literal = _quote_literal(cursor_symbol)
                    if cursor_seq is not None:
                        symbol_clause = (
                            f"(symbol > {symbol_literal} OR "
                            f"(symbol = {symbol_literal} AND seq > {cursor_seq}))"
                        )
                    else:
                        symbol_clause = f"symbol > {symbol_literal}"
                else:
                    symbol_clause = f"seq > {cursor_seq}"
                where_clause = (
                    f"({time_column} > {cursor_expr} OR "
                    f"({time_column} = {cursor_expr} AND {symbol_clause}))"
                )
        elif time_column == "ts":
            overlap_cursor = cursor_at - FLAT_CURSOR_OVERLAP
            where_clause = f"{time_column} >= {to_datetime64(overlap_cursor)}"
            order_clause = f"{time_column} ASC, symbol ASC"
        return (
            f"SELECT {select_expr} "
            f"FROM {self.table} "
            f"WHERE {where_clause} "
            f"ORDER BY {order_clause} "
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
        normalized_symbol: Optional[str] = None
        if symbol:
            normalized_symbol = normalize_symbol(symbol)
            if normalized_symbol is None:
                logger.warning("Invalid symbol for signal replay: %s", symbol)
                return []
        time_column = self._resolve_time_column()
        select_expr = self._select_expression(time_column)
        where_parts = [
            f"{time_column} >= {to_datetime64(start)}",
            f"{time_column} <= {to_datetime64(end)}",
        ]
        if normalized_symbol:
            where_parts.append(f"symbol = '{normalized_symbol}'")
        limit_clause = f"LIMIT {limit}" if limit else ""
        order_clause = f"{time_column} ASC"
        if self._supports_seq_for_time_column(time_column):
            order_clause = f"{time_column} ASC, seq ASC"
        query = (
            f"SELECT {select_expr} FROM {self.table} WHERE {' AND '.join(where_parts)} "
            f"ORDER BY {order_clause} {limit_clause} FORMAT JSONEachRow"
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

    def _select_expression(self, time_column: str) -> str:
        select_columns = self._select_columns_for_schema(time_column)
        return ", ".join(select_columns)

    def _select_columns_for_schema(self, time_column: str) -> list[str]:
        if self.schema == "flat":
            columns = self._resolve_columns(force=True)
            if columns:
                return _select_columns(columns, time_column)
            return _dedupe_columns([time_column, *FLAT_SIGNAL_COLUMNS])
        if self.schema == "envelope":
            columns = self._resolve_columns(force=True)
            if columns:
                return _select_columns(columns, time_column)
            return _dedupe_columns([time_column, *ENVELOPE_SIGNAL_COLUMNS])
        columns = self._resolve_columns()
        if columns:
            return _select_columns(columns, time_column)
        return _dedupe_columns([time_column, *ENVELOPE_SIGNAL_COLUMNS])

    def _resolve_columns(self, force: bool = False) -> Optional[set[str]]:
        if self.schema != "auto" and not force:
            return None
        if not self.url:
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
        if not rows:
            self._columns = None
            return None
        self._columns = {str(row.get("name")) for row in rows if row.get("name")}
        if not self._columns:
            self._columns = None
            return None
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

    def _get_cursor(self, session: Session) -> tuple[datetime, Optional[int], Optional[str]]:
        stmt = select(TradeCursor).where(TradeCursor.source == "clickhouse")
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            return cursor_row.cursor_at, cursor_row.cursor_seq, cursor_row.cursor_symbol

        lookback = timedelta(minutes=self.initial_lookback_minutes)
        return datetime.now(timezone.utc) - lookback, None, None

    def _set_cursor(
        self,
        session: Session,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> None:
        stmt = select(TradeCursor).where(TradeCursor.source == "clickhouse")
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            cursor_row.cursor_at = cursor_at
            cursor_row.cursor_seq = cursor_seq
            cursor_row.cursor_symbol = cursor_symbol
            session.add(cursor_row)
        else:
            cursor_row = TradeCursor(
                source="clickhouse",
                cursor_at=cursor_at,
                cursor_seq=cursor_seq,
                cursor_symbol=cursor_symbol,
            )
            session.add(cursor_row)
        session.commit()

    def _supports_seq(self) -> bool:
        if self.schema == "flat":
            return False
        columns = self._resolve_columns(force=True)
        if columns is None:
            return True
        return "seq" in columns

    def _supports_seq_for_time_column(self, time_column: str) -> bool:
        if time_column == "event_ts":
            return self._supports_seq()
        if time_column == "ts":
            columns = self._resolve_columns(force=True)
            if columns is None:
                return False
            return "seq" in columns
        return False


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
    if size is None:
        raw_size = row.get("window_size")
        if isinstance(raw_size, str):
            size = raw_size
    if size is None:
        raw_step = row.get("window_step")
        if isinstance(raw_step, str):
            size = raw_step
    if payload:
        timeframe = payload.get("timeframe")
        if isinstance(timeframe, str):
            return timeframe
    timeframe = row.get("timeframe")
    if isinstance(timeframe, str):
        return timeframe
    return _timeframe_from_iso_duration(size)


def _timeframe_from_iso_duration(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    match = re.fullmatch(r"PT(\d+)([SMH])", value)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2)
    if unit == "S":
        return f"{amount}Sec"
    if unit == "M":
        return f"{amount}Min"
    if unit == "H":
        return f"{amount}Hour"
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


def _coerce_seq(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _quote_literal(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _select_columns(columns: set[str], time_column: str) -> list[str]:
    desired = [
        time_column,
        "event_ts",
        "ts",
        "ingest_ts",
        "symbol",
        "payload",
        "window",
        "window_size",
        "window_step",
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


def _dedupe_columns(columns: list[str]) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for col in columns:
        if col in seen:
            continue
        selected.append(col)
        seen.add(col)
    return selected


def _split_table(table: str) -> tuple[str, str]:
    if "." in table:
        database, raw_table = table.split(".", 1)
        return database, raw_table
    return "default", table


__all__ = ["ClickHouseSignalIngestor", "SignalBatch"]
