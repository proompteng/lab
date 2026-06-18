"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Mapping, Optional, Protocol, cast
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


logger = logging.getLogger(__name__)

FLAT_CURSOR_OVERLAP = timedelta(seconds=2)

LATEST_SIGNAL_TS_CACHE_TTL = timedelta(seconds=30)

LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN = timedelta(minutes=5)

SIMULATION_CURSOR_BASELINE = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _coerce_count(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


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
    signals_authoritative: bool = True
    fallback_signals: list[SignalEnvelope] = field(
        default_factory=lambda: cast(list[SignalEnvelope], [])
    )
    degraded_signal_source: Optional[str] = None


class _ClickHouseSignalIngestorFields:
    """Poll ClickHouse for new TA signals using an event_ts cursor."""

    url: str
    username: Optional[str]
    password: Optional[str]
    table: str
    batch_size: int
    initial_lookback_minutes: int
    schema: str
    account_label: str
    simulation_mode: bool
    fast_forward_stale_cursor: bool
    empty_batch_advance_seconds: int
    _columns: Optional[set[str]]
    _time_column: Optional[str]
    _latest_signal_ts_cache: Optional[datetime]
    _latest_signal_ts_checked_at: Optional[datetime]
    _latest_signal_ts_last_error_at: Optional[datetime]
    _latest_signal_ts_scoped_cache: dict[
        tuple[tuple[str, ...], tuple[str, ...]], Optional[datetime]
    ]
    _latest_signal_ts_scoped_checked_at: dict[
        tuple[tuple[str, ...], tuple[str, ...]], datetime
    ]
    _last_good_signal_batches: dict[
        tuple[tuple[str, ...], tuple[str, ...]],
        tuple[
            datetime,
            list[SignalEnvelope],
            Optional[datetime],
            Optional[datetime],
        ],
    ]


class _ClickHouseSignalIngestorContract(Protocol):
    url: str
    username: Optional[str]
    password: Optional[str]
    table: str
    batch_size: int
    initial_lookback_minutes: int
    schema: str
    account_label: str
    simulation_mode: bool
    fast_forward_stale_cursor: bool
    empty_batch_advance_seconds: int
    _columns: Optional[set[str]]
    _time_column: Optional[str]
    _latest_signal_ts_cache: Optional[datetime]
    _latest_signal_ts_checked_at: Optional[datetime]
    _latest_signal_ts_last_error_at: Optional[datetime]
    _latest_signal_ts_scoped_cache: dict[
        tuple[tuple[str, ...], tuple[str, ...]], Optional[datetime]
    ]
    _latest_signal_ts_scoped_checked_at: dict[
        tuple[tuple[str, ...], tuple[str, ...]], datetime
    ]
    _last_good_signal_batches: dict[
        tuple[tuple[str, ...], tuple[str, ...]],
        tuple[
            datetime,
            list[SignalEnvelope],
            Optional[datetime],
            Optional[datetime],
        ],
    ]

    def _latest_signal_timestamp(
        self,
        time_column: str,
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> Optional[datetime]: ...

    def parse_row(self, row: dict[str, Any]) -> Optional[SignalEnvelope]: ...

    def _build_query(
        self,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> str: ...

    def _dedupe_signals(
        self, signals: list[SignalEnvelope]
    ) -> list[SignalEnvelope]: ...

    def _filter_signals(
        self, signals: list[SignalEnvelope]
    ) -> list[SignalEnvelope]: ...

    def _sorted_signals(
        self, signals: list[SignalEnvelope]
    ) -> list[SignalEnvelope]: ...

    def _query_clickhouse(self, query: str) -> list[dict[str, Any]]: ...

    def _filter_cursor_boundary(
        self,
        signals: list[SignalEnvelope],
        *,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> list[SignalEnvelope]: ...

    def _select_columns_and_expression(
        self, time_column: str
    ) -> tuple[list[str], str]: ...

    def _maybe_join_microbar_volume(
        self,
        query: str,
        *,
        time_column: str,
        selected_columns: list[str],
    ) -> str: ...

    def _source_where_clause(self) -> str | None: ...

    def _scope_where_clauses(
        self,
        *,
        symbols: tuple[str, ...] = (),
        timeframes: tuple[str, ...] = (),
    ) -> list[str]: ...

    def _resolve_columns(self, force: bool = False) -> Optional[set[str]]: ...

    def _remember_last_good_signals(
        self,
        *,
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
        signals: list[SignalEnvelope],
        query_start: Optional[datetime],
        query_end: Optional[datetime],
        observed_at: datetime,
    ) -> None: ...

    def _timeout_degraded_batch(
        self,
        *,
        reason: str,
        query_start: Optional[datetime],
        query_end: Optional[datetime],
        scope_key: tuple[tuple[str, ...], tuple[str, ...]],
    ) -> SignalBatch: ...

    def _resolve_time_column(self) -> str: ...

    def _get_cursor(
        self, session: Session
    ) -> tuple[datetime, Optional[int], Optional[str]]: ...

    def _set_cursor(
        self,
        session: Session,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> None: ...

    def _supports_seq_for_time_column(self, time_column: str) -> bool: ...


# Public aliases used by split-module consumers.
ClickHouseSignalIngestorContract = _ClickHouseSignalIngestorContract
ClickHouseSignalIngestorFields = _ClickHouseSignalIngestorFields
coerce_count = _coerce_count
simulation_fetch_window = _simulation_fetch_window

__all__ = (
    "logger",
    "FLAT_CURSOR_OVERLAP",
    "LATEST_SIGNAL_TS_CACHE_TTL",
    "LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN",
    "SIMULATION_CURSOR_BASELINE",
    "FLAT_SIGNAL_COLUMNS",
    "ENVELOPE_SIGNAL_COLUMNS",
    "SignalBatch",
    "ClickHouseSignalIngestorContract",
    "ClickHouseSignalIngestorFields",
    "coerce_count",
    "simulation_fetch_window",
)


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "ClickHouseSignalIngestorContract",
    "ClickHouseSignalIngestorFields",
    "ENVELOPE_SIGNAL_COLUMNS",
    "FLAT_CURSOR_OVERLAP",
    "FLAT_SIGNAL_COLUMNS",
    "HTTPConnection",
    "HTTPSConnection",
    "LATEST_SIGNAL_TS_CACHE_TTL",
    "LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN",
    "Mapping",
    "Optional",
    "SIMULATION_CURSOR_BASELINE",
    "Session",
    "SignalBatch",
    "SignalEnvelope",
    "TradeCursor",
    "_ClickHouseSignalIngestorFields",
    "_coerce_count",
    "_simulation_fetch_window",
    "active_simulation_runtime_context",
    "annotations",
    "cast",
    "coerce_count",
    "dataclass",
    "datetime",
    "field",
    "json",
    "logger",
    "logging",
    "normalize_simulation_cursor",
    "normalize_symbol",
    "re",
    "resolve_simulation_context",
    "select",
    "settings",
    "signal_ingest_runtime",
    "simulation_context_enabled",
    "simulation_fetch_window",
    "simulation_window_bounds",
    "timedelta",
    "timezone",
    "to_datetime64",
    "trading_now",
    "urlencode",
    "urlsplit",
)
