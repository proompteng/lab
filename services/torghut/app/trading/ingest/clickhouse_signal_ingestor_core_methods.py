"""Signal ingestion from ClickHouse."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy.orm import Session

from ...config import settings
from ..clickhouse import normalize_symbol, to_datetime64
from ..models import SignalEnvelope
from ..simulation import (
    signal_ingest_runtime,
    simulation_context_enabled,
)
from ..simulation_window import simulation_window_bounds
from ..time_source import trading_now


from .shared_context import (
    FLAT_CURSOR_OVERLAP,
    ClickHouseSignalIngestorContract as _ClickHouseSignalIngestorContract,
    SignalBatch,
    simulation_fetch_window as _simulation_fetch_window,
    logger,
)


def _qualified_table_name(table: str) -> str:
    from .attach_simulation_context import (
        qualified_table_name,
    )

    return qualified_table_name(table)


def _safe_identifier(value: str, *, kind: str) -> str:
    from .attach_simulation_context import (
        safe_identifier,
    )

    return safe_identifier(value, kind=kind)


def _normalized_signal_symbols(symbols: set[str] | None) -> tuple[str, ...]:
    from .clickhouse_signal_ingestor_persistence_methods import (
        normalized_signal_symbols,
    )

    return normalized_signal_symbols(symbols)


def _normalized_signal_timeframes(timeframes: set[str] | None) -> tuple[str, ...]:
    from .clickhouse_signal_ingestor_persistence_methods import (
        normalized_signal_timeframes,
    )

    return normalized_signal_timeframes(timeframes)


def _signal_scope_key(
    symbols: tuple[str, ...], timeframes: tuple[str, ...]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    from .clickhouse_signal_ingestor_persistence_methods import (
        signal_scope_key,
    )

    return signal_scope_key(symbols, timeframes)


def _next_signal_cursor_state(
    *,
    signal: SignalEnvelope,
    max_event_ts: Optional[datetime],
    max_seq: Optional[int],
    max_symbol: Optional[str],
) -> tuple[Optional[datetime], Optional[int], Optional[str]]:
    from .clickhouse_signal_ingestor_persistence_methods import (
        next_signal_cursor_state,
    )

    return next_signal_cursor_state(
        signal=signal,
        max_event_ts=max_event_ts,
        max_seq=max_seq,
        max_symbol=max_symbol,
    )


def _quote_literal(value: str) -> str:
    from .clickhouse_signal_ingestor_persistence_methods import (
        quote_literal,
    )

    return quote_literal(value)


if TYPE_CHECKING:
    _ClickHouseSignalIngestorCoreBase = _ClickHouseSignalIngestorContract
else:
    _ClickHouseSignalIngestorCoreBase = object


class _ClickHouseSignalIngestorCoreMethods(_ClickHouseSignalIngestorCoreBase):
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
        self.initial_lookback_minutes = (
            initial_lookback_minutes or settings.trading_signal_lookback_minutes
        )
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
        self._latest_signal_ts_scoped_cache: dict[
            tuple[tuple[str, ...], tuple[str, ...]], Optional[datetime]
        ] = {}
        self._latest_signal_ts_scoped_checked_at: dict[
            tuple[tuple[str, ...], tuple[str, ...]], datetime
        ] = {}
        self._last_good_signal_batches: dict[
            tuple[tuple[str, ...], tuple[str, ...]],
            tuple[
                datetime, list[SignalEnvelope], Optional[datetime], Optional[datetime]
            ],
        ] = {}

    def fetch_signals(
        self,
        session: Session,
        *,
        symbols: Optional[set[str]] = None,
        timeframes: Optional[set[str]] = None,
    ) -> "SignalBatch":
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
        query_window_start: datetime | None = None
        scoped_symbols = _normalized_signal_symbols(symbols)
        scoped_timeframes = _normalized_signal_timeframes(timeframes)
        scope_key = _signal_scope_key(scoped_symbols, scoped_timeframes)
        try:
            time_column = self._resolve_time_column()
            latest_signal_at = self._latest_signal_timestamp(
                time_column,
                symbols=scoped_symbols,
                timeframes=scoped_timeframes,
            )
            cursor_at, cursor_seq, cursor_symbol, fast_forwarded = (
                self._prepare_fetch_cursor(
                    session=session,
                    poll_started_at=poll_started_at,
                    latest_signal_at=latest_signal_at,
                )
            )
            query_window_start = cursor_at
            if self.simulation_mode:
                return self._fetch_simulation_signals(
                    cursor_at=cursor_at,
                    cursor_seq=cursor_seq,
                    cursor_symbol=cursor_symbol,
                    latest_signal_at=latest_signal_at,
                    poll_started_at=poll_started_at,
                    fast_forwarded=fast_forwarded,
                    symbols=scoped_symbols,
                    timeframes=scoped_timeframes,
                    scope_key=scope_key,
                )
            overlap_cutoff = self._overlap_cutoff(time_column, cursor_at)
            query = self._build_query(
                cursor_at,
                cursor_seq,
                cursor_symbol,
                symbols=scoped_symbols,
                timeframes=scoped_timeframes,
            )
            rows = self._query_clickhouse(query)
        except TimeoutError as exc:
            logger.warning(
                "ClickHouse signal ingestion timed out; blocking authoritative decisions account_label=%s symbols=%s timeframes=%s error=%s",
                self.account_label,
                ",".join(scoped_symbols) or "*",
                ",".join(scoped_timeframes) or "*",
                exc,
            )
            return self._timeout_degraded_batch(
                reason="clickhouse_signal_query_timeout",
                query_start=query_window_start,
                query_end=poll_started_at,
                scope_key=scope_key,
            )
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
                latest_signal_at=latest_signal_at,
                time_column=time_column,
                query_start=query_window_start,
                query_end=query_window_end,
                poll_started_at=poll_started_at,
            )

        if signals:
            self._remember_last_good_signals(
                scope_key=scope_key,
                signals=signals,
                query_start=query_window_start,
                query_end=query_window_end,
                observed_at=poll_started_at,
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
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
        scope_key: tuple[tuple[str, ...], tuple[str, ...]] = ((), ()),
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
                no_signal_reason="cursor_tail_stable"
                if effective_latest_signal_at is not None
                else "no_signals_in_window",
            )

        time_column = _safe_identifier(self._resolve_time_column(), kind="column")
        query = self._build_simulation_query(
            start=query_window_start,
            end=query_window_end,
            cursor_at=cursor_at,
            cursor_seq=cursor_seq,
            cursor_symbol=cursor_symbol,
            time_column=time_column,
            symbols=symbols,
            timeframes=timeframes,
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
            self._remember_last_good_signals(
                scope_key=scope_key,
                signals=signals,
                query_start=query_window_start,
                query_end=query_window_end,
                observed_at=poll_started_at,
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
            lag = max(
                0.0, (poll_started_at - effective_latest_signal_at).total_seconds()
            )
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

        time_column = _safe_identifier(self._resolve_time_column(), kind="column")
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
        if session.in_transaction():
            session.commit()
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

    def _overlap_cutoff(
        self, time_column: str, cursor_at: datetime
    ) -> Optional[datetime]:
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
        latest_signal_at: Optional[datetime],
        time_column: str,
        query_start: datetime,
        query_end: datetime,
        poll_started_at: datetime,
    ) -> SignalBatch:
        no_signal_reason, signal_lag_seconds, cursor_at, cursor_seq, cursor_symbol = (
            self._empty_fetch_reason(
                cursor_at=cursor_at,
                cursor_seq=cursor_seq,
                cursor_symbol=cursor_symbol,
                latest_signal_at=latest_signal_at,
                time_column=time_column,
                query_window_end=query_end,
            )
        )
        cursor_at, cursor_seq, cursor_symbol, no_signal_reason, signal_lag_seconds = (
            self._maybe_advance_empty_cursor(
                cursor_at=cursor_at,
                cursor_seq=cursor_seq,
                cursor_symbol=cursor_symbol,
                latest_signal_at=latest_signal_at,
                poll_started_at=poll_started_at,
                query_window_end=query_end,
                no_signal_reason=no_signal_reason,
                signal_lag_seconds=signal_lag_seconds,
            )
        )
        return SignalBatch(
            signals=[],
            cursor_at=cursor_at,
            cursor_seq=cursor_seq,
            cursor_symbol=cursor_symbol,
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
            return (
                cursor_at,
                cursor_seq,
                cursor_symbol,
                no_signal_reason,
                signal_lag_seconds,
            )
        if no_signal_reason in {"cursor_ahead_of_stream", "cursor_tail_stable"}:
            return (
                cursor_at,
                cursor_seq,
                cursor_symbol,
                no_signal_reason,
                signal_lag_seconds,
            )
        if cursor_seq is not None or cursor_symbol is not None:
            return (
                cursor_at,
                cursor_seq,
                cursor_symbol,
                no_signal_reason,
                signal_lag_seconds,
            )

        cursor_advance = poll_started_at - timedelta(
            seconds=self.empty_batch_advance_seconds
        )
        if cursor_at >= cursor_advance:
            return (
                cursor_at,
                cursor_seq,
                cursor_symbol,
                no_signal_reason,
                signal_lag_seconds,
            )

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
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
        ordered: bool = True,
    ) -> str:
        where_parts = [
            f"{time_column} >= {to_datetime64(start)}",
            f"{time_column} <= {to_datetime64(end)}",
        ]
        source_clause = self._source_where_clause()
        if source_clause is not None:
            where_parts.append(source_clause)
        if normalized_symbol:
            where_parts.append(f"symbol = {_quote_literal(normalized_symbol)}")
        where_parts.extend(
            self._scope_where_clauses(
                symbols=symbols,
                timeframes=timeframes,
            )
        )

        selected_columns, select_expr = self._select_columns_and_expression(time_column)
        query_parts = [
            "SELECT",
            select_expr,
            "FROM",
            self.table,
            "WHERE",
            " AND ".join(where_parts),
        ]
        if ordered:
            order_clause = f"{time_column} ASC"
            if self._supports_seq_for_time_column(time_column):
                order_clause = f"{time_column} ASC, symbol ASC, seq ASC"
            query_parts.extend(["ORDER BY", order_clause])
        if limit:
            query_parts.extend(["LIMIT", str(max(int(limit), 1))])
        query = self._maybe_join_microbar_volume(
            " ".join(query_parts),
            time_column=time_column,
            selected_columns=selected_columns,
        )
        return f"{query} FORMAT JSONEachRow"

    def _build_simulation_query(
        self,
        *,
        start: datetime,
        end: datetime,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
        time_column: str,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> str:
        cursor_expr = to_datetime64(cursor_at)
        where_parts = [
            f"{time_column} >= {to_datetime64(start)}",
            f"{time_column} <= {to_datetime64(end)}",
        ]
        source_clause = self._source_where_clause()
        if source_clause is not None:
            where_parts.append(source_clause)
        where_parts.extend(
            self._scope_where_clauses(
                symbols=symbols,
                timeframes=timeframes,
            )
        )
        supports_seq = self._supports_seq_for_time_column(time_column)
        if supports_seq:
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
                where_parts.append(
                    f"({time_column} > {cursor_expr} OR "
                    f"({time_column} = {cursor_expr} AND {symbol_clause}))"
                )
            else:
                where_parts.append(f"{time_column} >= {cursor_expr}")
        elif cursor_symbol is not None:
            symbol_literal = _quote_literal(cursor_symbol)
            where_parts.append(
                f"({time_column} > {cursor_expr} OR "
                f"({time_column} = {cursor_expr} AND symbol > {symbol_literal}))"
            )
        else:
            where_parts.append(f"{time_column} >= {cursor_expr}")

        order_clause = f"{time_column} ASC"
        if supports_seq:
            order_clause = f"{time_column} ASC, symbol ASC, seq ASC"
        elif time_column == "ts":
            order_clause = f"{time_column} ASC, symbol ASC"

        selected_columns, select_expr = self._select_columns_and_expression(time_column)
        query = " ".join(
            [
                "SELECT",
                select_expr,
                "FROM",
                self.table,
                "WHERE",
                " AND ".join(where_parts),
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


# Public aliases used by split-module consumers.
ClickHouseSignalIngestorCoreMethods = _ClickHouseSignalIngestorCoreMethods

__all__ = ("ClickHouseSignalIngestorCoreMethods",)
