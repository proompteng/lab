# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field
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

# ruff: noqa: F401,F403,F405,F811,F821


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


# Public aliases used by split-module consumers.
ClickHouseSignalIngestorFields = _ClickHouseSignalIngestorFields
coerce_count = _coerce_count
simulation_fetch_window = _simulation_fetch_window

__all__ = [name for name in globals() if not name.startswith("__")]
