"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Mapping, Optional, cast
from urllib.parse import urlencode, urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import TradeCursor
from .clickhouse import normalize_symbol, to_datetime64
from .models import SignalEnvelope
from .simulation import resolve_simulation_context, signal_ingest_runtime, simulation_context_enabled
from .simulation_window import normalize_simulation_cursor, simulation_window_bounds
from .time_source import trading_now

logger = logging.getLogger(__name__)

FLAT_CURSOR_OVERLAP = timedelta(seconds=2)
LATEST_SIGNAL_TS_CACHE_TTL = timedelta(seconds=30)
LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN = timedelta(minutes=5)
SIMULATION_CURSOR_BASELINE = datetime(1970, 1, 1, tzinfo=timezone.utc)
def _simulation_fetch_window() -> timedelta:
    return timedelta(seconds=max(1, settings.trading_simulation_fetch_window_seconds))

FLAT_SIGNAL_COLUMNS = [
    "ts",
    "symbol",
    "macd",
    "macd_signal",
    "macd_hist",
    "signal",
    "rsi",
    "rsi14",
    "ema",
    "ema12",
    "ema26",
    "vwap",
    "vwap_session",
    "vwap_w5m",
    "boll_mid",
    "boll_upper",
    "boll_lower",
    "imbalance_spread",
    "vol_realized_w60s",
    "signal_json",
    "timeframe",
    "price",
    "close",
    "spread",
    "imbalance_bid_px",
    "imbalance_ask_px",
    "microstructure_signal_v1",
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
    query_start: Optional[datetime] = None
    query_end: Optional[datetime] = None
    signal_lag_seconds: float | None = None
    no_signal_reason: Optional[str] = None


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
        account_label: Optional[str] = None,
    ) -> None:
        self.url = (url or settings.trading_clickhouse_url or "").rstrip("/")
        self.username = username or settings.trading_clickhouse_username
        self.password = password or settings.trading_clickhouse_password
        self.table = _qualified_table_name(table or settings.trading_signal_table)
        self.batch_size = batch_size or settings.trading_signal_batch_size
        self.initial_lookback_minutes = initial_lookback_minutes or settings.trading_signal_lookback_minutes
        self.schema = schema or settings.trading_signal_schema
        self.account_label = account_label or settings.trading_account_label
        self.simulation_mode = simulation_context_enabled()
        (
            self.fast_forward_stale_cursor,
            self.empty_batch_advance_seconds,
        ) = signal_ingest_runtime(
            fast_forward_stale_cursor=fast_forward_stale_cursor,
            empty_batch_advance_seconds=settings.trading_signal_empty_batch_advance_seconds,
        )
        self._columns: Optional[set[str]] = None
        self._time_column: Optional[str] = None
        self._latest_signal_ts_cache: Optional[datetime] = None
        self._latest_signal_ts_checked_at: Optional[datetime] = None
        self._latest_signal_ts_last_error_at: Optional[datetime] = None

    def fetch_signals(self, session: Session) -> "SignalBatch":
        if not self.url:
            logger.warning("ClickHouse URL missing; skipping signal ingestion")
            return SignalBatch(
                signals=[],
                cursor_at=None,
                cursor_seq=None,
                cursor_symbol=None,
                query_start=None,
                query_end=None,
                no_signal_reason="clickhouse_url_missing",
            )

        poll_started_at = trading_now(account_label=self.account_label)
        time_column = self._resolve_time_column()
        latest_signal_at = self._latest_signal_timestamp(time_column)
        cursor_at, cursor_seq, cursor_symbol, fast_forwarded = self._prepare_fetch_cursor(
            session=session,
            poll_started_at=poll_started_at,
            latest_signal_at=latest_signal_at,
        )
        if self.simulation_mode:
            return self._fetch_simulation_signals(
                cursor_at=cursor_at,
                cursor_seq=cursor_seq,
                cursor_symbol=cursor_symbol,
                latest_signal_at=latest_signal_at,
                poll_started_at=poll_started_at,
                fast_forwarded=fast_forwarded,
            )
        query_window_start = cursor_at
        overlap_cutoff = self._overlap_cutoff(time_column, cursor_at)
        query = self._build_query(cursor_at, cursor_seq, cursor_symbol)
        rows = self._query_clickhouse(query)
        signals, max_event_ts, max_seq, max_symbol = self._collect_batch_signals(
            rows,
            overlap_cutoff,
        )
        query_window_end = poll_started_at

        if not rows:
            return self._empty_fetch_batch(
                cursor_at=cursor_at,
                cursor_seq=cursor_seq,
                cursor_symbol=cursor_symbol,
                fast_forwarded=fast_forwarded,
                latest_signal_at=latest_signal_at,
                time_column=time_column,
                query_start=query_window_start,
                query_end=query_window_end,
                poll_started_at=poll_started_at,
            )

        return SignalBatch(
            signals=signals,
            cursor_at=max_event_ts,
            cursor_seq=max_seq,
            cursor_symbol=max_symbol,
            query_start=query_window_start,
            query_end=query_window_end,
            no_signal_reason=None,
        )

    def _fetch_simulation_signals(
        self,
        *,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
        latest_signal_at: Optional[datetime],
        poll_started_at: datetime,
        fast_forwarded: bool,
    ) -> "SignalBatch":
        query_window_start = cursor_at
        _window_start, simulation_window_end = simulation_window_bounds()
        effective_latest_signal_at = latest_signal_at
        if (
            simulation_window_end is not None
            and effective_latest_signal_at is not None
            and effective_latest_signal_at > simulation_window_end
        ):
            effective_latest_signal_at = simulation_window_end

        if effective_latest_signal_at is None:
            query_window_end = query_window_start + _simulation_fetch_window()
            if simulation_window_end is not None:
                query_window_end = min(query_window_end, simulation_window_end)
        else:
            effective_end = effective_latest_signal_at
            query_window_end = min(
                max(query_window_start, effective_end),
                query_window_start + _simulation_fetch_window(),
            )
            if simulation_window_end is not None:
                query_window_end = min(query_window_end, simulation_window_end)
        if query_window_end <= query_window_start:
            lag = (
                max(0.0, (poll_started_at - effective_latest_signal_at).total_seconds())
                if effective_latest_signal_at is not None
                else None
            )
            return SignalBatch(
                signals=[],
                cursor_at=cursor_at,
                cursor_seq=cursor_seq if fast_forwarded else None,
                cursor_symbol=cursor_symbol if fast_forwarded else None,
                query_start=query_window_start,
                query_end=query_window_end,
                signal_lag_seconds=lag,
                no_signal_reason="cursor_tail_stable" if effective_latest_signal_at is not None else "no_signals_in_window",
            )

        time_column = _safe_identifier(self._resolve_time_column(), kind='column')
        query = self._build_replay_query(
            start=query_window_start,
            end=query_window_end,
            normalized_symbol=None,
            limit=None,
            time_column=time_column,
            ordered=False,
        )
        rows = self._query_clickhouse(query)
        signals = self._signals_from_rows(rows)
        signals = self._filter_cursor_boundary(
            signals,
            cursor_at=cursor_at,
            cursor_seq=cursor_seq,
            cursor_symbol=cursor_symbol,
        )
        signals = self._sorted_signals(
            self._filter_signals(self._dedupe_signals(signals))
        )
        max_event_ts: Optional[datetime] = None
        max_seq: Optional[int] = None
        max_symbol: Optional[str] = None
        for signal in signals:
            max_event_ts, max_seq, max_symbol = _next_signal_cursor_state(
                signal=signal,
                max_event_ts=max_event_ts,
                max_seq=max_seq,
                max_symbol=max_symbol,
            )

        if signals:
            return SignalBatch(
                signals=signals,
                cursor_at=max_event_ts,
                cursor_seq=max_seq,
                cursor_symbol=max_symbol,
                query_start=query_window_start,
                query_end=query_window_end,
                no_signal_reason=None,
            )

        if effective_latest_signal_at is None:
            return SignalBatch(
                signals=[],
                cursor_at=query_window_start,
                cursor_seq=cursor_seq if fast_forwarded else None,
                cursor_symbol=cursor_symbol if fast_forwarded else None,
                query_start=query_window_start,
                query_end=query_window_end,
                signal_lag_seconds=None,
                no_signal_reason="no_signals_in_window",
            )

        if query_window_end >= effective_latest_signal_at:
            lag = max(0.0, (poll_started_at - effective_latest_signal_at).total_seconds())
            return SignalBatch(
                signals=[],
                cursor_at=query_window_end,
                cursor_seq=None,
                cursor_symbol=None,
                query_start=query_window_start,
                query_end=query_window_end,
                signal_lag_seconds=lag,
                no_signal_reason="cursor_tail_stable",
            )

        return SignalBatch(
            signals=[],
            cursor_at=query_window_end,
            cursor_seq=None,
            cursor_symbol=None,
            query_start=query_window_start,
            query_end=query_window_end,
            signal_lag_seconds=None,
            no_signal_reason="empty_batch_advanced",
        )

    def fetch_signals_with_reason(
        self,
        *,
        start: datetime,
        end: datetime,
        symbol: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> "SignalBatch":
        """Fetch signals in a bounded window and return no-signal telemetry."""
        if not self.url:
            logger.warning("ClickHouse URL missing; skipping signal replay")
            return SignalBatch(
                signals=[],
                cursor_at=None,
                cursor_seq=None,
                cursor_symbol=None,
                query_start=start,
                query_end=end,
                no_signal_reason="clickhouse_url_missing",
            )

        normalized_symbol: Optional[str] = None
        if symbol:
            normalized_symbol = normalize_symbol(symbol)
            if normalized_symbol is None:
                logger.warning("Invalid symbol for signal replay: %s", symbol)
                return SignalBatch(
                    signals=[],
                    cursor_at=None,
                    cursor_seq=None,
                    cursor_symbol=None,
                    query_start=start,
                    query_end=end,
                    no_signal_reason="invalid_symbol",
                )

        time_column = _safe_identifier(self._resolve_time_column(), kind='column')
        query = self._build_replay_query(
            start=start,
            end=end,
            normalized_symbol=normalized_symbol,
            limit=limit,
            time_column=time_column,
        )
        rows = self._query_clickhouse(query)
        signals = self._signals_from_rows(rows)
        no_signal_reason, signal_lag_seconds = self._resolve_replay_no_signal_reason(
            signals=signals,
            start=start,
            end=end,
            time_column=time_column,
        )

        return SignalBatch(
            signals=signals,
            cursor_at=None,
            cursor_seq=None,
            cursor_symbol=None,
            query_start=start,
            query_end=end,
            signal_lag_seconds=signal_lag_seconds,
            no_signal_reason=no_signal_reason,
        )

    def _prepare_fetch_cursor(
        self,
        *,
        session: Session,
        poll_started_at: datetime,
        latest_signal_at: Optional[datetime],
    ) -> tuple[datetime, Optional[int], Optional[str], bool]:
        cursor_at, cursor_seq, cursor_symbol = self._get_cursor(session)
        if cursor_at.tzinfo is None:
            cursor_at = cursor_at.replace(tzinfo=timezone.utc)
        if not self.fast_forward_stale_cursor:
            return cursor_at, cursor_seq, cursor_symbol, False

        cursor_at_tail = latest_signal_at is not None and cursor_at >= latest_signal_at
        min_cursor = poll_started_at - timedelta(minutes=self.initial_lookback_minutes)
        if cursor_at >= min_cursor or cursor_at_tail:
            return cursor_at, cursor_seq, cursor_symbol, False

        logger.warning(
            "Trade cursor is stale; fast-forwarding cursor_at=%s -> %s",
            cursor_at.isoformat(),
            min_cursor.isoformat(),
        )
        cursor_at = min_cursor
        cursor_seq = None
        cursor_symbol = None
        self._set_cursor(session, cursor_at, cursor_seq, cursor_symbol)
        return cursor_at, cursor_seq, cursor_symbol, True

    def _overlap_cutoff(self, time_column: str, cursor_at: datetime) -> Optional[datetime]:
        if time_column == "ts" and not self._supports_seq_for_time_column(time_column):
            return cursor_at
        return None

    def _collect_batch_signals(
        self,
        rows: list[dict[str, Any]],
        overlap_cutoff: Optional[datetime],
    ) -> tuple[list[SignalEnvelope], Optional[datetime], Optional[int], Optional[str]]:
        parsed_signals: list[SignalEnvelope] = []
        for row in rows:
            signal = self.parse_row(row)
            if signal is None:
                logger.warning("Skipping signal with missing event_ts or symbol")
                continue
            if overlap_cutoff is not None and signal.event_ts < overlap_cutoff:
                continue
            parsed_signals.append(signal)
        signals = self._sorted_signals(
            self._filter_signals(self._dedupe_signals(parsed_signals))
        )
        max_event_ts: Optional[datetime] = None
        max_seq: Optional[int] = None
        max_symbol: Optional[str] = None
        for signal in signals:
            max_event_ts, max_seq, max_symbol = _next_signal_cursor_state(
                signal=signal,
                max_event_ts=max_event_ts,
                max_seq=max_seq,
                max_symbol=max_symbol,
            )
        return signals, max_event_ts, max_seq, max_symbol

    def _empty_fetch_batch(
        self,
        *,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
        fast_forwarded: bool,
        latest_signal_at: Optional[datetime],
        time_column: str,
        query_start: datetime,
        query_end: datetime,
        poll_started_at: datetime,
    ) -> SignalBatch:
        no_signal_reason, signal_lag_seconds, cursor_at, cursor_seq, cursor_symbol = self._empty_fetch_reason(
            cursor_at=cursor_at,
            cursor_seq=cursor_seq,
            cursor_symbol=cursor_symbol,
            latest_signal_at=latest_signal_at,
            time_column=time_column,
            query_window_end=query_end,
        )
        cursor_at, cursor_seq, cursor_symbol, no_signal_reason, signal_lag_seconds = self._maybe_advance_empty_cursor(
            cursor_at=cursor_at,
            cursor_seq=cursor_seq,
            cursor_symbol=cursor_symbol,
            latest_signal_at=latest_signal_at,
            poll_started_at=poll_started_at,
            query_window_end=query_end,
            no_signal_reason=no_signal_reason,
            signal_lag_seconds=signal_lag_seconds,
        )
        return SignalBatch(
            signals=[],
            cursor_at=cursor_at,
            cursor_seq=cursor_seq if fast_forwarded else None,
            cursor_symbol=cursor_symbol if fast_forwarded else None,
            query_start=query_start,
            query_end=query_end,
            signal_lag_seconds=signal_lag_seconds,
            no_signal_reason=no_signal_reason,
        )

    def _empty_fetch_reason(
        self,
        *,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
        latest_signal_at: Optional[datetime],
        time_column: str,
        query_window_end: datetime,
    ) -> tuple[str, float | None, datetime, Optional[int], Optional[str]]:
        if latest_signal_at is None:
            return "no_signals_in_window", None, cursor_at, cursor_seq, cursor_symbol

        lookback_window = max(1, self.initial_lookback_minutes)
        if cursor_at > latest_signal_at + timedelta(minutes=lookback_window):
            rewind_at = latest_signal_at
            if time_column == "ts":
                rewind_at -= FLAT_CURSOR_OVERLAP
            logger.warning(
                "Cursor is ahead of stream latest timestamp; rewinding cursor from=%s to=%s",
                cursor_at.isoformat(),
                rewind_at.isoformat(),
            )
            lag = max(0.0, (query_window_end - latest_signal_at).total_seconds())
            return "cursor_ahead_of_stream", lag, rewind_at, None, None

        if cursor_at >= latest_signal_at:
            lag = max(0.0, (query_window_end - latest_signal_at).total_seconds())
            return "cursor_tail_stable", lag, cursor_at, cursor_seq, cursor_symbol

        return "no_signals_in_window", None, cursor_at, cursor_seq, cursor_symbol

    def _maybe_advance_empty_cursor(
        self,
        *,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
        latest_signal_at: Optional[datetime],
        poll_started_at: datetime,
        query_window_end: datetime,
        no_signal_reason: str,
        signal_lag_seconds: float | None,
    ) -> tuple[datetime, Optional[int], Optional[str], str, float | None]:
        if self.empty_batch_advance_seconds <= 0:
            return cursor_at, cursor_seq, cursor_symbol, no_signal_reason, signal_lag_seconds
        if no_signal_reason in {"cursor_ahead_of_stream", "cursor_tail_stable"}:
            return cursor_at, cursor_seq, cursor_symbol, no_signal_reason, signal_lag_seconds

        cursor_advance = poll_started_at - timedelta(seconds=self.empty_batch_advance_seconds)
        if cursor_at >= cursor_advance:
            return cursor_at, cursor_seq, cursor_symbol, no_signal_reason, signal_lag_seconds

        logger.debug(
            "No signals fetched; advancing cursor forward from=%s to=%s (empty_batch_advance_seconds=%s)",
            cursor_at.isoformat(),
            cursor_advance.isoformat(),
            self.empty_batch_advance_seconds,
        )
        lag = signal_lag_seconds
        if latest_signal_at is not None:
            lag = max(0.0, (query_window_end - latest_signal_at).total_seconds())
        return cursor_advance, None, None, "empty_batch_advanced", lag

    def _build_replay_query(
        self,
        *,
        start: datetime,
        end: datetime,
        normalized_symbol: Optional[str],
        limit: Optional[int],
        time_column: str,
        ordered: bool = True,
    ) -> str:
        where_parts = [
            f"{time_column} >= {to_datetime64(start)}",
            f"{time_column} <= {to_datetime64(end)}",
        ]
        if normalized_symbol:
            where_parts.append(f"symbol = {_quote_literal(normalized_symbol)}")

        query_parts = [
            'SELECT',
            self._select_expression(time_column),
            'FROM',
            self.table,
            'WHERE',
            ' AND '.join(where_parts),
        ]
        if ordered:
            order_clause = f"{time_column} ASC"
            if self._supports_seq_for_time_column(time_column):
                order_clause = f"{time_column} ASC, symbol ASC, seq ASC"
            query_parts.extend(['ORDER BY', order_clause])
        if limit:
            query_parts.extend(['LIMIT', str(max(int(limit), 1))])
        query_parts.append('FORMAT JSONEachRow')
        return ' '.join(query_parts)

    def _signals_from_rows(self, rows: list[dict[str, Any]]) -> list[SignalEnvelope]:
        signals: list[SignalEnvelope] = []
        for row in rows:
            signal = self.parse_row(row)
            if signal is not None:
                signals.append(signal)
        return self._sorted_signals(self._filter_signals(self._dedupe_signals(signals)))

    def _resolve_replay_no_signal_reason(
        self,
        *,
        signals: list[SignalEnvelope],
        start: datetime,
        end: datetime,
        time_column: str,
    ) -> tuple[str | None, float | None]:
        if signals:
            return None, None

        no_signal_reason = "no_signals_in_window"
        signal_lag_seconds: float | None = None
        latest_signal_at = self._latest_signal_timestamp(time_column)
        if latest_signal_at is not None and start > latest_signal_at:
            no_signal_reason = "cursor_ahead_of_stream"
            signal_lag_seconds = max(0.0, (end - latest_signal_at).total_seconds())
        elif self.empty_batch_advance_seconds > 0:
            no_signal_reason = "empty_batch_advanced"
            signal_lag_seconds = (
                max(0.0, (end - latest_signal_at).total_seconds())
                if latest_signal_at is not None
                else None
            )
        return no_signal_reason, signal_lag_seconds

    def _latest_signal_timestamp(self, time_column: str) -> Optional[datetime]:
        now = datetime.now(timezone.utc)
        if (
            self._latest_signal_ts_checked_at is not None
            and now - self._latest_signal_ts_checked_at < LATEST_SIGNAL_TS_CACHE_TTL
        ):
            return self._latest_signal_ts_cache

        rows: list[dict[str, Any]] = []
        last_error: Exception | None = None
        for query in self._latest_signal_timestamp_queries(time_column):
            try:
                rows = self._query_clickhouse(query)
                break
            except Exception as exc:
                last_error = exc
                rows = []
                continue
        else:
            if (
                self._latest_signal_ts_last_error_at is None
                or now - self._latest_signal_ts_last_error_at >= LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN
            ):
                logger.warning(
                    "Failed to query latest signal timestamp from ClickHouse; using cached value. error=%s",
                    last_error,
                )
                self._latest_signal_ts_last_error_at = now
            self._latest_signal_ts_checked_at = now
            return self._latest_signal_ts_cache

        self._latest_signal_ts_last_error_at = None
        self._latest_signal_ts_checked_at = now
        if not rows:
            self._latest_signal_ts_cache = None
            return None
        raw = rows[0].get("latest_signal_ts")
        self._latest_signal_ts_cache = _parse_ts(raw) if raw is not None else None
        return self._latest_signal_ts_cache

    def _latest_signal_timestamp_queries(self, time_column: str) -> list[str]:
        queries: list[str] = []
        safe_time_column = _safe_identifier(time_column, kind='column')
        order_clause = f'{safe_time_column} DESC'
        if self._supports_seq_for_time_column(time_column):
            order_clause = f'{safe_time_column} DESC, symbol DESC, seq DESC'
        elif time_column == 'ts':
            order_clause = f'{safe_time_column} DESC, symbol DESC'
        query_parts = [
            'SELECT',
            f'{safe_time_column} AS latest_signal_ts',
            'FROM',
            self.table,
        ]
        if self.simulation_mode:
            window_start, window_end = simulation_window_bounds()
            where_parts: list[str] = []
            if window_start is not None:
                where_parts.append(f'{safe_time_column} >= {to_datetime64(window_start)}')
            if window_end is not None:
                where_parts.append(f'{safe_time_column} <= {to_datetime64(window_end)}')
            if where_parts:
                query_parts.extend(['WHERE', ' AND '.join(where_parts)])
        query_parts.extend(
            [
                'ORDER BY',
                order_clause,
                'LIMIT',
                '1',
                'FORMAT JSONEachRow',
            ]
        )
        queries.append(' '.join(query_parts))
        return queries

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
            payload = _attach_simulation_context(payload=payload, row=row, event_ts=event_ts)
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
        time_column = _safe_identifier(self._resolve_time_column(), kind='column')
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
        return ' '.join(
            [
                'SELECT',
                select_expr,
                'FROM',
                self.table,
                'WHERE',
                where_clause,
                'ORDER BY',
                order_clause,
                'LIMIT',
                str(max(int(limit), 1)),
                'FORMAT JSONEachRow',
            ]
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
        time_column = _safe_identifier(self._resolve_time_column(), kind='column')
        select_expr = self._select_expression(time_column)
        where_parts = [
            f"{time_column} >= {to_datetime64(start)}",
            f"{time_column} <= {to_datetime64(end)}",
        ]
        if normalized_symbol:
            where_parts.append(f"symbol = {_quote_literal(normalized_symbol)}")
        order_clause = f"{time_column} ASC"
        if self._supports_seq_for_time_column(time_column):
            order_clause = f"{time_column} ASC, seq ASC"
        query_parts = [
            'SELECT',
            select_expr,
            'FROM',
            self.table,
            'WHERE',
            ' AND '.join(where_parts),
            'ORDER BY',
            order_clause,
        ]
        if limit:
            query_parts.extend(['LIMIT', str(max(int(limit), 1))])
        query_parts.append('FORMAT JSONEachRow')
        query = ' '.join(query_parts)
        rows = self._query_clickhouse(query)
        signals: list[SignalEnvelope] = []
        for row in rows:
            signal = self.parse_row(row)
            if signal is None:
                continue
            signals.append(signal)
        return self._sorted_signals(self._filter_signals(self._dedupe_signals(signals)))

    def _dedupe_signals(self, signals: list[SignalEnvelope]) -> list[SignalEnvelope]:
        if self.schema == "flat" or len(signals) < 2:
            return signals

        deduped_by_key: dict[tuple[datetime, str, str | None], SignalEnvelope] = {}
        for signal in signals:
            key = _signal_identity(signal)
            current = deduped_by_key.get(key)
            if current is None or _prefer_earlier_ingest_signal(candidate=signal, current=current):
                deduped_by_key[key] = signal
        if len(deduped_by_key) == len(signals):
            return signals
        deduped = list(deduped_by_key.values())
        deduped.sort(key=_signal_sort_key)
        return deduped

    def _filter_signals(self, signals: list[SignalEnvelope]) -> list[SignalEnvelope]:
        allowed_sources = _normalized_signal_sources(settings.trading_signal_allowed_sources_raw)
        if not allowed_sources or not signals:
            return signals
        return [
            signal
            for signal in signals
            if (signal.source or "").strip().lower() in allowed_sources
        ]

    def _sorted_signals(self, signals: list[SignalEnvelope]) -> list[SignalEnvelope]:
        if len(signals) < 2:
            return signals
        return sorted(signals, key=_signal_sort_key)

    def _query_clickhouse(self, query: str) -> list[dict[str, Any]]:
        params = {"query": query}
        request_url = f"{self.url}/?{urlencode(params)}"
        parsed = urlsplit(request_url)
        scheme = parsed.scheme.lower()
        if scheme not in {'http', 'https'}:
            raise RuntimeError(f'unsupported_clickhouse_url_scheme:{scheme or "missing"}')
        if not parsed.hostname:
            raise RuntimeError('invalid_clickhouse_url_host')

        headers = {"Content-Type": "text/plain"}
        if self.username:
            headers["X-ClickHouse-User"] = self.username
        if self.password:
            headers["X-ClickHouse-Key"] = self.password

        path = parsed.path or '/'
        if parsed.query:
            path = f'{path}?{parsed.query}'
        connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
        connection = connection_class(
            parsed.hostname,
            parsed.port,
            timeout=settings.trading_clickhouse_timeout_seconds,
        )

        rows: list[dict[str, Any]] = []
        try:
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                detail = response.read().decode('utf-8', errors='replace')
                raise RuntimeError(f'clickhouse_http_{response.status}:{detail[:200]}')
            payload = response.read().decode("utf-8")
        finally:
            connection.close()

        for line in payload.splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                logger.warning("Failed to decode ClickHouse row: %s", exc)
        return rows

    def _filter_cursor_boundary(
        self,
        signals: list[SignalEnvelope],
        *,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> list[SignalEnvelope]:
        filtered: list[SignalEnvelope] = []
        for signal in signals:
            if signal.event_ts < cursor_at:
                continue
            if signal.event_ts > cursor_at:
                filtered.append(signal)
                continue
            candidate_seq = _coerce_seq(signal.seq)
            if cursor_seq is not None and candidate_seq is not None:
                if candidate_seq < cursor_seq:
                    continue
                if candidate_seq == cursor_seq and cursor_symbol is not None and signal.symbol <= cursor_symbol:
                    continue
                filtered.append(signal)
                continue
            if cursor_symbol is not None and signal.symbol <= cursor_symbol:
                continue
            filtered.append(signal)
        return filtered

    def _select_expression(self, time_column: str) -> str:
        select_columns = self._select_columns_for_schema(time_column)
        return ', '.join(_safe_identifier(column, kind='column') for column in select_columns)

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
        query = ' '.join(
            [
                'SELECT name FROM system.columns WHERE',
                f"database = {_quote_literal(database)}",
                'AND',
                f"table = {_quote_literal(table)}",
                'FORMAT JSONEachRow',
            ]
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
            columns = self._resolve_columns(force=True)
            if columns and "event_ts" in columns:
                self._time_column = "event_ts"
            elif columns and "ts" in columns:
                self._time_column = "ts"
            else:
                self._time_column = "event_ts"
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
        stmt = select(TradeCursor).where(
            TradeCursor.source == "clickhouse",
            TradeCursor.account_label == self.account_label,
        )
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            cursor_at = cursor_row.cursor_at
            if cursor_at.tzinfo is None:
                cursor_at = cursor_at.replace(tzinfo=timezone.utc)
            if self.simulation_mode and cursor_at <= SIMULATION_CURSOR_BASELINE:
                return trading_now(account_label=self.account_label), None, None
            if self.simulation_mode:
                normalized_cursor = normalize_simulation_cursor(cursor_at)
                if normalized_cursor is not None and normalized_cursor != cursor_at:
                    return normalized_cursor, None, None
            return cursor_at, cursor_row.cursor_seq, cursor_row.cursor_symbol

        if self.simulation_mode:
            return trading_now(account_label=self.account_label), None, None

        lookback = timedelta(minutes=self.initial_lookback_minutes)
        return datetime.now(timezone.utc) - lookback, None, None

    def _set_cursor(
        self,
        session: Session,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> None:
        stmt = select(TradeCursor).where(
            TradeCursor.source == "clickhouse",
            TradeCursor.account_label == self.account_label,
        )
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            cursor_row.cursor_at = cursor_at
            cursor_row.cursor_seq = cursor_seq
            cursor_row.cursor_symbol = cursor_symbol
            session.add(cursor_row)
        else:
            cursor_row = TradeCursor(
                source="clickhouse",
                account_label=self.account_label,
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
    if match is not None:
        amount = int(match.group(1))
        unit = match.group(2)
        if unit == "S":
            return f"{amount}Sec"
        if unit == "M":
            return f"{amount}Min"
        if unit == "H":
            return f"{amount}Hour"

    legacy_match = re.fullmatch(
        r"(?i)\s*(\d+)\s*(sec|secs|s|min|minute|minutes|m|hour|hours|h)\s*",
        value,
    )
    if not legacy_match:
        return None
    amount = int(legacy_match.group(1))
    unit = legacy_match.group(2).lower()
    if unit in {"sec", "secs", "s"}:
        return f"{amount}Sec"
    if unit in {"min", "minute", "minutes", "m"}:
        return f"{amount}Min"
    if unit in {"hour", "hours", "h"}:
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
    _merge_signal_json_payload(payload, row)
    _merge_macd_payload(payload, row)
    _merge_microstructure_signal_payload(payload, row)
    _copy_row_values_if_missing(payload, row, ("rsi", "rsi14"))
    _copy_row_value_if_missing(payload, row, "ema")
    _copy_row_value_if_missing(payload, row, "vwap")
    _copy_row_values_if_missing(payload, row, ("price", "close"))
    _ensure_price_value(payload, row)
    _merge_imbalance_payload(payload, row)
    _copy_extended_ta_fields(payload, row)
    return payload


def _merge_signal_json_payload(payload: dict[str, Any], row: dict[str, Any]) -> None:
    signal_json = row.get("signal_json")
    if not isinstance(signal_json, str):
        return
    try:
        decoded = json.loads(signal_json)
    except json.JSONDecodeError:
        return
    if isinstance(decoded, dict):
        payload.update(cast(dict[str, Any], decoded))


def _merge_macd_payload(payload: dict[str, Any], row: dict[str, Any]) -> None:
    macd_val = row.get("macd")
    signal_val = row.get("macd_signal") or row.get("signal")
    if macd_val is None and signal_val is None:
        return
    existing_macd = payload.get("macd")
    if isinstance(existing_macd, dict):
        if macd_val is not None:
            existing_macd["macd"] = macd_val
        if signal_val is not None:
            existing_macd["signal"] = signal_val
        return
    payload["macd"] = {"macd": macd_val, "signal": signal_val}


def _copy_row_values_if_missing(
    payload: dict[str, Any],
    row: dict[str, Any],
    keys: tuple[str, ...],
) -> None:
    for key in keys:
        _copy_row_value_if_missing(payload, row, key)


def _copy_row_value_if_missing(payload: dict[str, Any], row: dict[str, Any], key: str) -> None:
    value = row.get(key)
    if value is not None and key not in payload:
        payload[key] = value


def _ensure_price_value(payload: dict[str, Any], row: dict[str, Any]) -> None:
    if "price" in payload:
        return
    for key in ("vwap_session", "vwap_w5m", "vwap"):
        candidate = row.get(key)
        if candidate is not None:
            payload["price"] = candidate
            return

    bid_px = row.get("imbalance_bid_px")
    ask_px = row.get("imbalance_ask_px")
    if bid_px is None or ask_px is None:
        return
    try:
        payload["price"] = (float(bid_px) + float(ask_px)) / 2
    except (TypeError, ValueError):
        logger.debug(
            'Unable to derive midpoint price from imbalance fields bid=%r ask=%r',
            bid_px,
            ask_px,
        )


def _merge_imbalance_payload(payload: dict[str, Any], row: dict[str, Any]) -> None:
    spread_value = row.get("spread")
    if spread_value is not None and "imbalance" not in payload:
        payload["imbalance"] = {"spread": spread_value}

    imbalance = payload.get("imbalance")
    if not isinstance(imbalance, dict):
        return

    bid_px = row.get("imbalance_bid_px")
    ask_px = row.get("imbalance_ask_px")
    spread = row.get("spread")
    if bid_px is not None and "bid_px" not in imbalance:
        imbalance["bid_px"] = bid_px
    if ask_px is not None and "ask_px" not in imbalance:
        imbalance["ask_px"] = ask_px
    if spread is not None and "spread" not in imbalance:
        imbalance["spread"] = spread


def _merge_microstructure_signal_payload(payload: dict[str, Any], row: dict[str, Any]) -> None:
    signal_value = row.get("microstructure_signal_v1")
    if signal_value is None:
        return
    if isinstance(signal_value, str):
        try:
            signal_value = json.loads(signal_value)
        except json.JSONDecodeError:
            return
    if isinstance(signal_value, dict):
        payload.setdefault("microstructure_signal", {})
        payload["microstructure_signal"] = _merge_dict_payload(
            payload.get("microstructure_signal"), cast(dict[str, Any], signal_value)
        )


def _copy_extended_ta_fields(payload: dict[str, Any], row: dict[str, Any]) -> None:
    # Preserve extended TA fields required by plugin_v3 strategy runtime.
    for key in (
        "macd_hist",
        "ema12",
        "ema26",
        "vwap_session",
        "vwap_w5m",
        "boll_mid",
        "boll_upper",
        "boll_lower",
        "imbalance_spread",
        "vol_realized_w60s",
    ):
        _copy_row_value_if_missing(payload, row, key)


def _merge_dict_payload(base: Any, updates: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    if isinstance(base, dict):
        merged.update(cast(dict[str, Any], base))
    merged.update(updates)
    return merged


def _next_signal_cursor_state(
    *,
    signal: SignalEnvelope,
    max_event_ts: Optional[datetime],
    max_seq: Optional[int],
    max_symbol: Optional[str],
) -> tuple[Optional[datetime], Optional[int], Optional[str]]:
    if max_event_ts is None or signal.event_ts > max_event_ts:
        return signal.event_ts, _coerce_seq(signal.seq), signal.symbol
    if signal.event_ts < max_event_ts:
        return max_event_ts, max_seq, max_symbol

    candidate_seq = _coerce_seq(signal.seq)
    normalized_candidate_seq = candidate_seq if candidate_seq is not None else max_seq
    if max_seq is None or (
        normalized_candidate_seq is not None and normalized_candidate_seq > max_seq
    ):
        return max_event_ts, normalized_candidate_seq, signal.symbol
    if normalized_candidate_seq == max_seq and (
        max_symbol is None or signal.symbol > max_symbol
    ):
        return max_event_ts, max_seq, signal.symbol
    return max_event_ts, max_seq, max_symbol


def _signal_identity(signal: SignalEnvelope) -> tuple[datetime, str, str | None]:
    return (
        signal.event_ts.astimezone(timezone.utc),
        signal.symbol,
        signal.timeframe,
    )


def _signal_sort_key(signal: SignalEnvelope) -> tuple[datetime, str, str, int, str]:
    return (
        signal.event_ts.astimezone(timezone.utc),
        signal.symbol,
        signal.timeframe or "",
        _coerce_seq(signal.seq) or -1,
        signal.source or "",
    )


def _prefer_earlier_ingest_signal(*, candidate: SignalEnvelope, current: SignalEnvelope) -> bool:
    current_ingest = current.ingest_ts.astimezone(timezone.utc) if current.ingest_ts is not None else None
    candidate_ingest = candidate.ingest_ts.astimezone(timezone.utc) if candidate.ingest_ts is not None else None
    if current_ingest is None:
        return candidate_ingest is not None
    if candidate_ingest is None:
        return False
    return candidate_ingest < current_ingest


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


def _normalized_signal_sources(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return {
        item.strip().lower()
        for item in raw.split(",")
        if item.strip()
    }


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
        "macd_hist",
        "signal",
        "rsi",
        "rsi14",
        "ema",
        "ema12",
        "ema26",
        "vwap",
        "vwap_session",
        "vwap_w5m",
        "boll_mid",
        "boll_upper",
        "boll_lower",
        "imbalance_spread",
        "vol_realized_w60s",
        "signal_json",
        "close",
        "price",
        "spread",
        "imbalance_bid_px",
        "imbalance_ask_px",
        "microstructure_signal_v1",
        "simulation_context",
        "dataset_event_id",
        "source_topic",
        "source_partition",
        "source_offset",
        "replay_topic",
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


def _attach_simulation_context(
    *,
    payload: dict[str, Any],
    row: Mapping[str, Any],
    event_ts: datetime,
) -> dict[str, Any]:
    source_context: Mapping[str, Any] | None = None
    existing = payload.get("simulation_context")
    if isinstance(existing, Mapping):
        source_context = cast(Mapping[str, Any], existing)

    row_context: dict[str, Any] = {}
    for field_name in (
        "dataset_event_id",
        "source_topic",
        "source_partition",
        "source_offset",
        "replay_topic",
    ):
        value = row.get(field_name)
        if value is None:
            continue
        row_context[field_name] = value
    if row_context:
        combined = dict(source_context or {})
        combined.update(row_context)
        source_context = combined

    context = resolve_simulation_context(
        source=source_context,
    )
    if context is None:
        return payload
    if context.get("signal_event_ts") in (None, ""):
        context["signal_event_ts"] = event_ts.isoformat()
    seq_value = row.get("seq")
    if seq_value is not None and context.get("signal_seq") in (None, ""):
        context["signal_seq"] = _coerce_seq(seq_value)

    updated = dict(payload)
    updated["simulation_context"] = context
    return updated


def _split_table(table: str) -> tuple[str, str]:
    if "." in table:
        database, raw_table = table.split(".", 1)
        return database, raw_table
    return "default", table


_IDENTIFIER_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


def _safe_identifier(value: str, *, kind: str) -> str:
    cleaned = value.strip()
    if not cleaned or not _IDENTIFIER_RE.fullmatch(cleaned):
        raise ValueError(f'invalid_{kind}_identifier:{value}')
    return cleaned


def _qualified_table_name(table: str) -> str:
    database, raw_table = _split_table(table)
    safe_database = _safe_identifier(database, kind='database')
    safe_table = _safe_identifier(raw_table, kind='table')
    return f'{safe_database}.{safe_table}'


__all__ = ["ClickHouseSignalIngestor", "SignalBatch"]
