# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

from .shared_context import (
    ENVELOPE_SIGNAL_COLUMNS,
    FLAT_CURSOR_OVERLAP,
    FLAT_SIGNAL_COLUMNS,
    LATEST_SIGNAL_TS_CACHE_TTL,
    LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN,
    SIMULATION_CURSOR_BASELINE,
    SignalBatch,
    _ClickHouseSignalIngestorFields,
    _coerce_count,
    _simulation_fetch_window,
    logger,
)
from .clickhouse_signal_ingestor_core_methods import (
    _ClickHouseSignalIngestorCoreMethods,
)
from .clickhouse_signal_ingestor_market_methods import (
    _ClickHouseRequest,
    _ClickHouseSignalIngestorMarketMethods,
    _LatestSignalCacheLookup,
    _column_names_from_rows,
    _latest_signal_timestamp_from_rows,
)
from .clickhouse_signal_ingestor_persistence_methods import (
    ClickHouseSignalIngestor,
    _ClickHouseSignalIngestorPersistenceMethods,
    _coerce_seq,
    _coerce_timeframe,
    _copy_extended_ta_fields,
    _copy_row_value_if_missing,
    _copy_row_values_if_missing,
    _dedupe_columns,
    _ensure_price_value,
    _mark_non_authority_stale_fallback_signal,
    _merge_dict_payload,
    _merge_flat_row_fallbacks,
    _merge_imbalance_payload,
    _merge_macd_payload,
    _merge_microstructure_signal_payload,
    _merge_signal_json_payload,
    _next_signal_cursor_state,
    _normalize_payload,
    _normalized_signal_sources,
    _normalized_signal_symbols,
    _normalized_signal_timeframes,
    _parse_ts,
    _payload_from_flat_row,
    _prefer_preferred_signal,
    _quote_literal,
    _select_columns,
    _signal_identity,
    _signal_matches_active_simulation_run,
    _signal_payload_context_fingerprint,
    _signal_payload_fingerprint,
    _signal_preference_key,
    _signal_provenance_completeness,
    _signal_provenance_key,
    _signal_scope_key,
    _signal_simulation_context,
    _signal_sort_key,
    _timeframe_from_iso_duration,
    _timeframes_to_iso_durations,
)


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


_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_identifier(value: str, *, kind: str) -> str:
    cleaned = value.strip()
    if not cleaned or not _IDENTIFIER_RE.fullmatch(cleaned):
        raise ValueError(f"invalid_{kind}_identifier:{value}")
    return cleaned


def _qualified_table_name(table: str) -> str:
    database, raw_table = _split_table(table)
    safe_database = _safe_identifier(database, kind="database")
    safe_table = _safe_identifier(raw_table, kind="table")
    return f"{safe_database}.{safe_table}"


__all__ = ["ClickHouseSignalIngestor", "SignalBatch"]


__all__ = [name for name in globals() if not name.startswith("__")]
