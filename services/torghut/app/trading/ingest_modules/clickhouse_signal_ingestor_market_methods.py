# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Mapping, Optional, cast
from urllib.parse import urlencode, urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...models import TradeCursor
from ..clickhouse import normalize_symbol, to_datetime64
from ..models import SignalEnvelope
from ..simulation import (
    resolve_simulation_context,
    signal_ingest_runtime,
    simulation_context_enabled,
)
from ..simulation_progress import active_simulation_runtime_context
from ..simulation_window import normalize_simulation_cursor, simulation_window_bounds
from ..time_source import trading_now

# ruff: noqa: F401,F811,F821

from .shared_context import (
    ENVELOPE_SIGNAL_COLUMNS,
    FLAT_CURSOR_OVERLAP,
    FLAT_SIGNAL_COLUMNS,
    LATEST_SIGNAL_TS_CACHE_TTL,
    LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN,
    SIMULATION_CURSOR_BASELINE,
    SignalBatch,
    ClickHouseSignalIngestorFields as _ClickHouseSignalIngestorFields,
    coerce_count as _coerce_count,
    simulation_fetch_window as _simulation_fetch_window,
)
from .clickhouse_signal_ingestor_core_methods import (
    ClickHouseSignalIngestorCoreMethods as _ClickHouseSignalIngestorCoreMethods,
)
from .clickhouse_signal_ingestor_market_support import (
    ClickHouseRequest as _ClickHouseRequest,
    LatestSignalCacheLookup as _LatestSignalCacheLookup,
    column_names_from_rows as _column_names_from_rows,
    dedupe_columns as _dedupe_columns,
    latest_signal_timestamp_from_rows as _latest_signal_timestamp_from_rows,
    normalized_signal_sources as _normalized_signal_sources,
    parse_ts as _parse_ts,
    qualified_table_name as _qualified_table_name,
    quote_literal as _quote_literal,
    safe_identifier as _safe_identifier,
    select_columns as _select_columns,
    signal_scope_key as _signal_scope_key,
    split_table as _split_table,
)

logger = logging.getLogger("app.trading.ingest")


class _ClickHouseSignalIngestorMarketMethods:
    def _latest_signal_timestamp(
        self,
        time_column: str,
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> Optional[datetime]:
        now = datetime.now(timezone.utc)
        scope_key = _signal_scope_key(symbols, timeframes)
        cached = self._latest_signal_timestamp_cache_lookup(scope_key, now)
        if cached.hit:
            return cached.value

        rows, last_error = self._latest_signal_timestamp_rows(
            time_column,
            symbols=symbols,
            timeframes=timeframes,
        )
        if last_error is not None:
            return self._latest_signal_timestamp_query_failed(
                scope_key,
                now,
                last_error,
            )

        self._latest_signal_ts_last_error_at = None
        self._mark_latest_signal_timestamp_checked(scope_key, now)
        latest = _latest_signal_timestamp_from_rows(rows)
        self._store_latest_signal_timestamp(scope_key, latest)
        return latest

    def _latest_signal_timestamp_cache_lookup(
        self,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
        now: datetime,
    ) -> _LatestSignalCacheLookup:
        checked_at = self._latest_signal_timestamp_checked_at(scope_key)
        if checked_at is None or now - checked_at >= LATEST_SIGNAL_TS_CACHE_TTL:
            return _LatestSignalCacheLookup(hit=False, value=None)
        return _LatestSignalCacheLookup(
            hit=True,
            value=self._latest_signal_timestamp_cache_value(scope_key),
        )

    def _latest_signal_timestamp_checked_at(
        self,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
    ) -> Optional[datetime]:
        if scope_key == ((), ()):
            return self._latest_signal_ts_checked_at
        return self._latest_signal_ts_scoped_checked_at.get(scope_key)

    def _latest_signal_timestamp_cache_value(
        self,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
    ) -> Optional[datetime]:
        if scope_key == ((), ()):
            return self._latest_signal_ts_cache
        return self._latest_signal_ts_scoped_cache.get(scope_key)

    def _latest_signal_timestamp_rows(
        self,
        time_column: str,
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> tuple[list[dict[str, Any]], Exception | None]:
        last_error: Exception | None = None
        for query in self._latest_signal_timestamp_queries(
            time_column,
            symbols=symbols,
            timeframes=timeframes,
        ):
            try:
                return self._query_clickhouse(query), None
            except Exception as exc:
                last_error = exc
        return [], last_error

    def _latest_signal_timestamp_query_failed(
        self,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
        now: datetime,
        last_error: Exception,
    ) -> Optional[datetime]:
        if self._should_log_latest_signal_timestamp_error(now):
            logger.warning(
                "Failed to query latest signal timestamp from ClickHouse; using cached value. error=%s",
                last_error,
            )
            self._latest_signal_ts_last_error_at = now
        self._mark_latest_signal_timestamp_checked(scope_key, now)
        return self._latest_signal_timestamp_cache_value(scope_key)

    def _should_log_latest_signal_timestamp_error(self, now: datetime) -> bool:
        return (
            self._latest_signal_ts_last_error_at is None
            or now - self._latest_signal_ts_last_error_at
            >= LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN
        )

    def _mark_latest_signal_timestamp_checked(
        self,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
        checked_at: datetime,
    ) -> None:
        if scope_key == ((), ()):
            self._latest_signal_ts_checked_at = checked_at
            return
        self._latest_signal_ts_scoped_checked_at[scope_key] = checked_at

    def _store_latest_signal_timestamp(
        self,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
        latest: Optional[datetime],
    ) -> None:
        if scope_key == ((), ()):
            self._latest_signal_ts_cache = latest
            return
        self._latest_signal_ts_scoped_cache[scope_key] = latest

    def latest_signal_status(self) -> dict[str, Any]:
        if not self.url:
            return {
                "state": "missing",
                "reason_codes": ["clickhouse_url_missing"],
                "source_ref": self.table,
            }
        try:
            time_column = self._resolve_time_column()
            latest_signal_at = self._latest_signal_timestamp(time_column)
        except Exception as exc:
            logger.warning("Failed to load ClickHouse TA freshness status: %s", exc)
            return {
                "state": "missing",
                "reason_codes": ["clickhouse_ta_status_query_failed"],
                "source_ref": self.table,
                "detail": str(exc)[:200],
            }
        if latest_signal_at is None:
            return {
                "state": "missing",
                "reason_codes": ["clickhouse_ta_latest_signal_missing"],
                "source_ref": self.table,
                "time_column": time_column,
            }
        status: dict[str, Any] = {
            "state": "current",
            "latest_signal_at": latest_signal_at,
            "source_ref": self.table,
            "time_column": time_column,
        }
        try:
            status.update(
                self._latest_signal_readiness_counts(
                    time_column=time_column,
                    latest_signal_at=latest_signal_at,
                )
            )
        except Exception as exc:
            logger.warning("Failed to load ClickHouse TA readiness counts: %s", exc)
            status["readiness_reason_codes"] = ["clickhouse_ta_readiness_query_failed"]
            status["readiness_detail"] = str(exc)[:200]
        return status

    def _latest_signal_readiness_counts(
        self,
        *,
        time_column: str,
        latest_signal_at: datetime,
    ) -> dict[str, Any]:
        safe_time_column = _safe_identifier(time_column, kind="column")
        lookback_minutes = max(int(self.initial_lookback_minutes or 1), 1)
        window_start = latest_signal_at - timedelta(minutes=lookback_minutes)
        where_parts = [
            f"{safe_time_column} >= {to_datetime64(window_start)}",
            f"{safe_time_column} <= {to_datetime64(latest_signal_at)}",
        ]
        source_clause = self._source_where_clause()
        if source_clause is not None:
            where_parts.append(source_clause)
        query = " ".join(
            [
                "SELECT",
                "count() AS signal_rows, uniqExact(symbol) AS symbol_count",
                "FROM",
                self.table,
                "WHERE",
                " AND ".join(where_parts),
                "FORMAT JSONEachRow",
            ]
        )
        rows = self._query_clickhouse(query)
        row = rows[0] if rows else {}
        return {
            "signal_rows": _coerce_count(row.get("signal_rows")),
            "symbol_count": _coerce_count(row.get("symbol_count")),
            "readiness_window_start": window_start,
            "readiness_window_end": latest_signal_at,
        }

    def _latest_signal_timestamp_queries(
        self,
        time_column: str,
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> list[str]:
        queries: list[str] = []
        safe_time_column = _safe_identifier(time_column, kind="column")
        order_clause = f"{safe_time_column} DESC"
        if self._supports_seq_for_time_column(time_column):
            order_clause = f"{safe_time_column} DESC, symbol DESC, seq DESC"
        elif time_column == "ts":
            order_clause = f"{safe_time_column} DESC, symbol DESC"
        query_parts = [
            "SELECT",
            f"{safe_time_column} AS latest_signal_ts",
            "FROM",
            self.table,
        ]
        where_parts: list[str] = []
        source_clause = self._source_where_clause()
        if source_clause is not None:
            where_parts.append(source_clause)
        where_parts.extend(
            self._scope_where_clauses(
                symbols=symbols,
                timeframes=timeframes,
            )
        )
        if self.simulation_mode:
            window_start, window_end = simulation_window_bounds()
            if window_start is not None:
                where_parts.append(
                    f"{safe_time_column} >= {to_datetime64(window_start)}"
                )
            if window_end is not None:
                where_parts.append(f"{safe_time_column} <= {to_datetime64(window_end)}")
        if where_parts:
            query_parts.extend(["WHERE", " AND ".join(where_parts)])
        query_parts.extend(
            [
                "ORDER BY",
                order_clause,
                "LIMIT",
                "1",
                "FORMAT JSONEachRow",
            ]
        )
        queries.append(" ".join(query_parts))
        return queries

    def commit_cursor(self, session: Session, batch: "SignalBatch") -> None:
        if batch.cursor_at is None:
            return
        self._set_cursor(
            session, batch.cursor_at, batch.cursor_seq, batch.cursor_symbol
        )

    def parse_row(self, row: dict[str, Any]) -> Optional[SignalEnvelope]:
        from .attach_simulation_context import (
            attach_simulation_context_payload,
        )
        from .clickhouse_signal_ingestor_persistence_methods import (
            coerce_timeframe,
            merge_flat_row_fallbacks,
            normalize_payload,
            payload_from_flat_row,
        )

        event_ts = (
            _parse_ts(row.get("event_ts"))
            or _parse_ts(row.get("ts"))
            or _parse_ts(row.get("timestamp"))
        )
        symbol = row.get("symbol")
        if event_ts is None or not isinstance(symbol, str):
            return None
        try:
            payload = normalize_payload(row.get("payload"))
            if not payload:
                payload = payload_from_flat_row(row)
            else:
                merge_flat_row_fallbacks(payload, row)
            payload = attach_simulation_context_payload(
                payload=payload, row=row, event_ts=event_ts
            )
            return SignalEnvelope(
                event_ts=event_ts,
                ingest_ts=_parse_ts(row.get("ingest_ts")),
                symbol=symbol,
                payload=payload,
                timeframe=coerce_timeframe(row, payload),
                seq=row.get("seq"),
                source=row.get("source"),
            )
        except Exception as exc:
            logger.warning("Skipping invalid signal row: %s", exc)
            return None

    def _build_query(
        self,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> str:
        cursor_expr = to_datetime64(cursor_at)
        time_column = _safe_identifier(self._resolve_time_column(), kind="column")
        selected_columns, select_expr = self._select_columns_and_expression(time_column)
        where_clause, order_clause = self._cursor_query_boundary(
            time_column=time_column,
            cursor_at=cursor_at,
            cursor_expr=cursor_expr,
            cursor_seq=cursor_seq,
            cursor_symbol=cursor_symbol,
        )
        where_clause = self._with_source_and_scope_where_clauses(
            where_clause,
            symbols=symbols,
            timeframes=timeframes,
        )
        query = " ".join(
            [
                "SELECT",
                select_expr,
                "FROM",
                self.table,
                "WHERE",
                where_clause,
                "ORDER BY",
                order_clause,
                "LIMIT",
                str(max(int(self.batch_size), 1)),
            ]
        )
        query = self._maybe_join_microbar_volume(
            query,
            time_column=time_column,
            selected_columns=selected_columns,
        )
        return f"{query} FORMAT JSONEachRow"

    def _cursor_query_boundary(
        self,
        *,
        time_column: str,
        cursor_at: datetime,
        cursor_expr: str,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> tuple[str, str]:
        if self._supports_seq_for_time_column(time_column):
            return self._seq_cursor_query_boundary(
                time_column=time_column,
                cursor_expr=cursor_expr,
                cursor_seq=cursor_seq,
                cursor_symbol=cursor_symbol,
            )
        if time_column == "ts":
            overlap_cursor = cursor_at - FLAT_CURSOR_OVERLAP
            return (
                f"{time_column} >= {to_datetime64(overlap_cursor)}",
                f"{time_column} ASC, symbol ASC",
            )
        return f"{time_column} > {cursor_expr}", f"{time_column} ASC"

    def _seq_cursor_query_boundary(
        self,
        *,
        time_column: str,
        cursor_expr: str,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> tuple[str, str]:
        order_clause = f"{time_column} ASC, symbol ASC, seq ASC"
        if cursor_seq is None and cursor_symbol is None:
            return f"{time_column} > {cursor_expr}", order_clause
        symbol_clause = self._seq_cursor_symbol_clause(cursor_seq, cursor_symbol)
        return (
            f"({time_column} > {cursor_expr} OR "
            f"({time_column} = {cursor_expr} AND {symbol_clause}))",
            order_clause,
        )

    def _seq_cursor_symbol_clause(
        self,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> str:
        if cursor_symbol is None:
            return f"seq > {cursor_seq}"
        symbol_literal = _quote_literal(cursor_symbol)
        if cursor_seq is None:
            return f"symbol > {symbol_literal}"
        return (
            f"(symbol > {symbol_literal} OR "
            f"(symbol = {symbol_literal} AND seq > {cursor_seq}))"
        )

    def _with_source_and_scope_where_clauses(
        self,
        where_clause: str,
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> str:
        source_clause = self._source_where_clause()
        if source_clause is not None:
            where_clause = f"({where_clause}) AND {source_clause}"
        scope_clauses = self._scope_where_clauses(
            symbols=symbols,
            timeframes=timeframes,
        )
        if scope_clauses:
            return " AND ".join([f"({where_clause})", *scope_clauses])
        return where_clause

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
        normalized_symbol = self._normalized_replay_symbol(symbol)
        if symbol and normalized_symbol is None:
            return []
        time_column = _safe_identifier(self._resolve_time_column(), kind="column")
        selected_columns, select_expr = self._select_columns_and_expression(time_column)
        query = self._fetch_signals_between_query(
            start=start,
            end=end,
            normalized_symbol=normalized_symbol,
            time_column=time_column,
            selected_columns=selected_columns,
            select_expr=select_expr,
            limit=limit,
        )
        return self._sorted_signals(
            self._filter_signals(self._dedupe_signals(self._signals_from_query(query)))
        )

    def _normalized_replay_symbol(self, symbol: Optional[str]) -> Optional[str]:
        if not symbol:
            return None
        normalized_symbol = normalize_symbol(symbol)
        if normalized_symbol is None:
            logger.warning("Invalid symbol for signal replay: %s", symbol)
        return normalized_symbol

    def _fetch_signals_between_query(
        self,
        *,
        start: datetime,
        end: datetime,
        normalized_symbol: Optional[str],
        time_column: str,
        selected_columns: list[str],
        select_expr: str,
        limit: Optional[int],
    ) -> str:
        query_parts = self._fetch_signals_between_query_parts(
            select_expr=select_expr,
            where_parts=self._fetch_signals_between_where_parts(
                start=start,
                end=end,
                normalized_symbol=normalized_symbol,
                time_column=time_column,
            ),
            time_column=time_column,
            limit=limit,
        )
        query = self._maybe_join_microbar_volume(
            " ".join(query_parts),
            time_column=time_column,
            selected_columns=selected_columns,
        )
        return f"{query} FORMAT JSONEachRow"

    def _fetch_signals_between_where_parts(
        self,
        *,
        start: datetime,
        end: datetime,
        normalized_symbol: Optional[str],
        time_column: str,
    ) -> list[str]:
        where_parts = [
            f"{time_column} >= {to_datetime64(start)}",
            f"{time_column} <= {to_datetime64(end)}",
        ]
        source_clause = self._source_where_clause()
        if source_clause is not None:
            where_parts.append(source_clause)
        if normalized_symbol:
            where_parts.append(f"symbol = {_quote_literal(normalized_symbol)}")
        return where_parts

    def _fetch_signals_between_query_parts(
        self,
        *,
        select_expr: str,
        where_parts: list[str],
        time_column: str,
        limit: Optional[int],
    ) -> list[str]:
        query_parts = [
            "SELECT",
            select_expr,
            "FROM",
            self.table,
            "WHERE",
            " AND ".join(where_parts),
            "ORDER BY",
            self._fetch_signals_between_order_clause(time_column),
        ]
        if limit:
            query_parts.extend(["LIMIT", str(max(int(limit), 1))])
        return query_parts

    def _fetch_signals_between_order_clause(self, time_column: str) -> str:
        if self._supports_seq_for_time_column(time_column):
            return f"{time_column} ASC, seq ASC"
        return f"{time_column} ASC"

    def _signals_from_query(self, query: str) -> list[SignalEnvelope]:
        signals: list[SignalEnvelope] = []
        for row in self._query_clickhouse(query):
            signal = self.parse_row(row)
            if signal is not None:
                signals.append(signal)
        return signals

    def _dedupe_signals(self, signals: list[SignalEnvelope]) -> list[SignalEnvelope]:
        from .clickhouse_signal_ingestor_persistence_methods import (
            prefer_preferred_signal,
            signal_identity,
            signal_sort_key,
        )

        if len(signals) < 2:
            return signals

        deduped_by_key: dict[
            tuple[datetime, str, str | None, tuple[Any, ...], str], SignalEnvelope
        ] = {}
        for signal in signals:
            key = signal_identity(signal)
            current = deduped_by_key.get(key)
            if current is None or prefer_preferred_signal(
                candidate=signal, current=current
            ):
                deduped_by_key[key] = signal
        if len(deduped_by_key) == len(signals):
            return signals
        deduped = list(deduped_by_key.values())
        deduped.sort(key=signal_sort_key)
        return deduped

    def _filter_signals(self, signals: list[SignalEnvelope]) -> list[SignalEnvelope]:
        allowed_sources = _normalized_signal_sources(
            settings.trading_signal_allowed_sources_raw
        )
        if not allowed_sources or not signals:
            return signals
        return [
            signal
            for signal in signals
            if (signal.source or "").strip().lower() in allowed_sources
        ]

    def _sorted_signals(self, signals: list[SignalEnvelope]) -> list[SignalEnvelope]:
        from .clickhouse_signal_ingestor_persistence_methods import signal_sort_key

        if len(signals) < 2:
            return signals
        return sorted(signals, key=signal_sort_key)

    def _query_clickhouse(self, query: str) -> list[dict[str, Any]]:
        params = {"query": query}
        request_url = f"{self.url}/?{urlencode(params)}"
        parsed = urlsplit(request_url)
        scheme = parsed.scheme.lower()
        self._validate_clickhouse_url(scheme, parsed.hostname)
        request = _ClickHouseRequest(
            scheme=scheme,
            hostname=cast(str, parsed.hostname),
            port=parsed.port,
            path=self._clickhouse_request_path(parsed.path, parsed.query),
            headers=self._clickhouse_headers(),
        )
        return self._decode_clickhouse_rows(self._read_clickhouse_payload(request))

    def _validate_clickhouse_url(
        self,
        scheme: str,
        hostname: str | None,
    ) -> None:
        if scheme not in {"http", "https"}:
            raise RuntimeError(
                f"unsupported_clickhouse_url_scheme:{scheme or 'missing'}"
            )
        if not hostname:
            raise RuntimeError("invalid_clickhouse_url_host")

    def _clickhouse_request_path(self, path: str, query: str) -> str:
        request_path = path or "/"
        if query:
            return f"{request_path}?{query}"
        return request_path

    def _clickhouse_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "text/plain"}
        if self.username:
            headers["X-ClickHouse-User"] = self.username
        if self.password:
            headers["X-ClickHouse-Key"] = self.password
        return headers

    def _read_clickhouse_payload(self, request: _ClickHouseRequest) -> str:
        connection_class = (
            HTTPSConnection if request.scheme == "https" else HTTPConnection
        )
        connection = connection_class(
            request.hostname,
            request.port,
            timeout=settings.trading_clickhouse_timeout_seconds,
        )
        try:
            connection.request("GET", request.path, headers=request.headers)
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                detail = response.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"clickhouse_http_{response.status}:{detail[:200]}")
            return response.read().decode("utf-8")
        finally:
            connection.close()

    def _decode_clickhouse_rows(self, payload: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
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
        from .clickhouse_signal_ingestor_persistence_methods import coerce_seq

        filtered: list[SignalEnvelope] = []
        for signal in signals:
            if signal.event_ts < cursor_at:
                continue
            if signal.event_ts > cursor_at:
                filtered.append(signal)
                continue
            candidate_seq = coerce_seq(signal.seq)
            if cursor_seq is not None and candidate_seq is not None:
                if cursor_symbol is not None:
                    if signal.symbol < cursor_symbol:
                        continue
                    if signal.symbol == cursor_symbol and candidate_seq <= cursor_seq:
                        continue
                elif candidate_seq <= cursor_seq:
                    continue
                filtered.append(signal)
                continue
            if cursor_symbol is not None and signal.symbol <= cursor_symbol:
                continue
            filtered.append(signal)
        return filtered

    def _select_columns_and_expression(self, time_column: str) -> tuple[list[str], str]:
        select_columns = self._select_columns_for_schema(time_column)
        return (
            select_columns,
            ", ".join(
                _safe_identifier(column, kind="column") for column in select_columns
            ),
        )

    def _select_expression(self, time_column: str) -> str:
        return self._select_columns_and_expression(time_column)[1]

    def _maybe_join_microbar_volume(
        self,
        query: str,
        *,
        time_column: str,
        selected_columns: list[str],
    ) -> str:
        if not self._should_join_microbar_volume(selected_columns):
            return query
        join_conditions = [
            "s.symbol = m.symbol",
            f"s.{_safe_identifier(time_column, kind='column')} = m.event_ts",
        ]
        if "source" in selected_columns:
            join_conditions.append("s.source = m.source")
        if "window_size" in selected_columns:
            join_conditions.append("s.window_size = m.window_size")
        return " ".join(
            [
                "SELECT",
                "s.*, if(m.symbol = '', NULL, m.v) AS microbar_volume",
                "FROM",
                f"({query}) AS s",
                "ANY LEFT JOIN",
                f"{_qualified_table_name(settings.trading_price_table)} AS m",
                "ON",
                " AND ".join(join_conditions),
            ]
        )

    def _should_join_microbar_volume(self, selected_columns: list[str]) -> bool:
        if "microbar_volume" in selected_columns:
            return False
        price_table = (settings.trading_price_table or "").strip()
        if not price_table:
            return False
        try:
            qualified_price_table = _qualified_table_name(price_table)
        except ValueError:
            logger.warning(
                "Invalid ClickHouse price table for microbar volume join: %s",
                price_table,
            )
            return False
        return qualified_price_table != self.table

    def _source_where_clause(self) -> str | None:
        allowed_sources = _normalized_signal_sources(
            settings.trading_signal_allowed_sources_raw
        )
        if not allowed_sources:
            return None
        columns = self._resolve_columns()
        if columns is not None and "source" not in columns:
            return None
        rendered = ", ".join(
            _quote_literal(source) for source in sorted(allowed_sources)
        )
        return f"lower(source) IN ({rendered})"

    def _scope_where_clauses(
        self,
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> list[str]:
        clauses: list[str] = []
        if symbols:
            rendered_symbols = ", ".join(_quote_literal(symbol) for symbol in symbols)
            clauses.append(f"symbol IN ({rendered_symbols})")
        timeframe_clause = self._timeframe_where_clause(timeframes)
        if timeframe_clause is not None:
            clauses.append(timeframe_clause)
        return clauses

    def _timeframe_where_clause(self, timeframes: tuple[str, ...]) -> str | None:
        if not timeframes:
            return None
        columns = self._resolve_columns()
        timeframe_column = self._timeframe_filter_column(columns)
        if timeframe_column is None:
            return None
        rendered = self._render_timeframe_filter_values(timeframe_column, timeframes)
        return f"{timeframe_column} IN ({rendered})"

    def _timeframe_filter_column(self, columns: Optional[set[str]]) -> str | None:
        if columns is not None:
            return self._timeframe_filter_column_from_schema(columns)
        if self.schema == "flat":
            return "timeframe"
        if self.schema == "envelope":
            return "window_size"
        return None

    def _timeframe_filter_column_from_schema(
        self,
        columns: set[str],
    ) -> str | None:
        for candidate in ("timeframe", "window_size", "window_step"):
            if candidate in columns:
                return candidate
        return None

    def _render_timeframe_filter_values(
        self,
        timeframe_column: str,
        timeframes: tuple[str, ...],
    ) -> str:
        if timeframe_column == "timeframe":
            return ", ".join(_quote_literal(item) for item in timeframes)
        from .clickhouse_signal_ingestor_persistence_methods import (
            timeframes_to_iso_durations,
        )

        return ", ".join(
            _quote_literal(item) for item in timeframes_to_iso_durations(timeframes)
        )

    def _resolve_columns(self, force: bool = False) -> Optional[set[str]]:
        if not self._should_resolve_columns(force):
            return None
        if self._columns is not None:
            return self._columns
        self._columns = self._load_clickhouse_columns()
        return self._columns

    def _should_resolve_columns(self, force: bool) -> bool:
        return (self.schema == "auto" or force) and bool(self.url)

    def _load_clickhouse_columns(self) -> Optional[set[str]]:
        try:
            rows = self._query_clickhouse(self._columns_query())
        except Exception as exc:
            logger.warning("Failed to detect ClickHouse schema: %s", exc)
            return None
        return _column_names_from_rows(rows)

    def _columns_query(self) -> str:
        database, table = _split_table(self.table)
        return " ".join(
            [
                "SELECT name FROM system.columns WHERE",
                f"database = {_quote_literal(database)}",
                "AND",
                f"table = {_quote_literal(table)}",
                "FORMAT JSONEachRow",
            ]
        )

    def _remember_last_good_signals(
        self,
        *,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
        signals: list[SignalEnvelope],
        query_start: Optional[datetime],
        query_end: Optional[datetime],
        observed_at: datetime,
    ) -> None:
        self._last_good_signal_batches[scope_key] = (
            observed_at,
            list(signals),
            query_start,
            query_end,
        )

    def _timeout_degraded_batch(
        self,
        *,
        reason: str,
        query_start: Optional[datetime],
        query_end: Optional[datetime],
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
    ) -> SignalBatch:
        cached = self._last_good_signal_batches.get(scope_key)
        fallback_signals: list[SignalEnvelope] = []
        degraded_source: str | None = None
        if cached is not None:
            cached_at, cached_signals, _cached_start, _cached_end = cached
            max_age = timedelta(
                seconds=max(1, int(settings.trading_signal_stale_lag_alert_seconds))
            )
            if query_end is not None and query_end - cached_at <= max_age:
                from .clickhouse_signal_ingestor_persistence_methods import (
                    mark_non_authority_stale_fallback_signal,
                )

                fallback_signals = [
                    mark_non_authority_stale_fallback_signal(
                        signal,
                        reason=reason,
                        cached_at=cached_at,
                    )
                    for signal in cached_signals
                ]
                degraded_source = "last_good_non_authority_stale_bounded"
        return SignalBatch(
            signals=[],
            cursor_at=None,
            cursor_seq=None,
            cursor_symbol=None,
            query_start=query_start,
            query_end=query_end,
            no_signal_reason=reason,
            signals_authoritative=False,
            fallback_signals=fallback_signals,
            degraded_signal_source=degraded_source,
        )

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


# Public aliases used by split-module consumers.
ClickHouseRequest = _ClickHouseRequest
ClickHouseSignalIngestorMarketMethods = _ClickHouseSignalIngestorMarketMethods
LatestSignalCacheLookup = _LatestSignalCacheLookup
column_names_from_rows = _column_names_from_rows
latest_signal_timestamp_from_rows = _latest_signal_timestamp_from_rows

__all__ = (
    "logger",
    "ClickHouseRequest",
    "ClickHouseSignalIngestorMarketMethods",
    "LatestSignalCacheLookup",
    "column_names_from_rows",
    "latest_signal_timestamp_from_rows",
)
