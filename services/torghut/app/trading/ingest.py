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
    ) -> None:
        self.url = (url or settings.trading_clickhouse_url or "").rstrip("/")
        self.username = username or settings.trading_clickhouse_username
        self.password = password or settings.trading_clickhouse_password
        self.table = table or settings.trading_signal_table
        self.batch_size = batch_size or settings.trading_signal_batch_size
        self.initial_lookback_minutes = initial_lookback_minutes or settings.trading_signal_lookback_minutes

    def fetch_signals(self, session: Session) -> list[SignalEnvelope]:
        if not self.url:
            logger.warning("ClickHouse URL missing; skipping signal ingestion")
            return []

        cursor_ts, cursor_seq = self._get_cursor(session)
        query = self._build_query(cursor_ts, cursor_seq)
        rows = self._query_clickhouse(query)
        signals: list[SignalEnvelope] = []

        max_event_ts: Optional[datetime] = None
        max_seq: int = 0
        for row in rows:
            event_ts = _parse_ts(row.get("event_ts"))
            symbol = row.get("symbol")
            if event_ts is None or not isinstance(symbol, str):
                logger.warning("Skipping signal with missing event_ts or symbol")
                continue
            seq = _coerce_seq(row.get("seq"))
            try:
                signal = SignalEnvelope(
                    event_ts=event_ts,
                    ingest_ts=_parse_ts(row.get("ingest_ts")),
                    symbol=symbol,
                    payload=_normalize_payload(row.get("payload")),
                    timeframe=_coerce_timeframe(row),
                    seq=seq,
                    source=row.get("source"),
                )
            except Exception as exc:
                logger.warning("Skipping invalid signal row: %s", exc)
                continue
            signals.append(signal)
            if max_event_ts is None or (signal.event_ts, seq) > (max_event_ts, max_seq):
                max_event_ts = signal.event_ts
                max_seq = seq

        if max_event_ts is not None:
            self._set_cursor(session, max_event_ts, max_seq)

        return signals

    def _build_query(self, cursor_ts: datetime, cursor_seq: int) -> str:
        cursor_str = cursor_ts.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        limit = self.batch_size
        return (
            "SELECT event_ts, ingest_ts, symbol, payload, window, ifNull(seq, 0) AS seq, source "
            f"FROM {self.table} "
            f"WHERE (event_ts > toDateTime('{cursor_str}', 'UTC')) "
            f"OR (event_ts = toDateTime('{cursor_str}', 'UTC') AND ifNull(seq, 0) > {cursor_seq}) "
            "ORDER BY event_ts ASC, seq ASC "
            f"LIMIT {limit} "
            "FORMAT JSONEachRow"
        )

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

    def _get_cursor(self, session: Session) -> tuple[datetime, int]:
        stmt = select(TradeCursor).where(TradeCursor.source == "clickhouse")
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            return cursor_row.cursor_at, cursor_row.cursor_seq

        lookback = timedelta(minutes=self.initial_lookback_minutes)
        return datetime.now(timezone.utc) - lookback, -1

    def _set_cursor(self, session: Session, cursor_at: datetime, cursor_seq: int) -> None:
        stmt = select(TradeCursor).where(TradeCursor.source == "clickhouse")
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            cursor_row.cursor_at = cursor_at
            cursor_row.cursor_seq = cursor_seq
            session.add(cursor_row)
        else:
            cursor_row = TradeCursor(source="clickhouse", cursor_at=cursor_at, cursor_seq=cursor_seq)
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


def _coerce_timeframe(row: dict[str, Any]) -> Optional[str]:
    window = row.get("window")
    size: Optional[str] = None
    if isinstance(window, dict):
        window_dict = cast(dict[str, Any], window)
        raw_size = window_dict.get("size")
        if isinstance(raw_size, str):
            size = raw_size
    payload = row.get("payload")
    if isinstance(payload, dict):
        payload_dict = cast(dict[str, Any], payload)
        timeframe = payload_dict.get("timeframe")
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


def _coerce_seq(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, int):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


__all__ = ["ClickHouseSignalIngestor"]
