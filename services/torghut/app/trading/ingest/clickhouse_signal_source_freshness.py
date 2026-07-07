"""Accepted-source ClickHouse signal freshness diagnostics."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TypeAlias

from ..clickhouse import to_datetime64
from .clickhouse_signal_ingestor_market_support import (
    normalized_signal_sources,
    parse_ts,
    safe_identifier,
)
from .shared_context import coerce_count

ClickHouseQuery: TypeAlias = Callable[[str], Sequence[Mapping[str, object]]]
ColumnResolver: TypeAlias = Callable[[], set[str] | None]
SourceWhereClause: TypeAlias = Callable[[], str | None]

_DIAGNOSTIC_EXCEPTIONS = (RuntimeError, OSError, ValueError, TypeError)

logger = logging.getLogger("app.trading.ingest")


@dataclass(frozen=True)
class ClickHouseSignalFreshnessContext:
    table: str
    simulation_mode: bool
    initial_lookback_minutes: int | None
    max_staleness_ms: int
    allowed_sources_raw: str | None
    query_clickhouse: ClickHouseQuery
    resolve_columns: ColumnResolver
    source_where_clause: SourceWhereClause


def build_accepted_source_freshness_contract(
    *,
    context: ClickHouseSignalFreshnessContext,
    time_column: str,
    latest_signal_at: datetime,
) -> dict[str, object]:
    now = datetime.now(timezone.utc)
    max_age_seconds = max(1, int(context.max_staleness_ms) // 1000)
    accepted_lag_seconds = max(0, int((now - latest_signal_at).total_seconds()))
    accepted_sources = accepted_signal_sources(context.allowed_sources_raw)
    stale = accepted_lag_seconds > max_age_seconds and not context.simulation_mode
    reason_codes: list[str] = []
    excluded_fresher_sources: list[dict[str, object]] = []
    per_symbol_coverage: list[dict[str, object]] = []
    try:
        excluded_fresher_sources = excluded_fresher_sources_after_accepted_latest(
            context=context,
            time_column=time_column,
            latest_accepted_signal_at=latest_signal_at,
            accepted_sources=accepted_sources,
        )
    except _DIAGNOSTIC_EXCEPTIONS as exc:
        logger.warning(
            "Failed to load excluded ClickHouse TA source freshness: %s", exc
        )
        reason_codes.append("clickhouse_ta_excluded_source_query_failed")
    try:
        per_symbol_coverage = accepted_per_symbol_coverage(
            context=context,
            time_column=time_column,
            latest_signal_at=latest_signal_at,
        )
    except _DIAGNOSTIC_EXCEPTIONS as exc:
        logger.warning("Failed to load accepted ClickHouse TA symbol coverage: %s", exc)
        reason_codes.append("clickhouse_ta_symbol_coverage_query_failed")
    return {
        "accepted_sources": list(accepted_sources) if accepted_sources else ["*"],
        "latest_accepted_event_at": latest_signal_at,
        "accepted_lag_seconds": accepted_lag_seconds,
        "accepted_max_lag_seconds": max_age_seconds,
        "accepted_source_state": "stale" if stale else "current",
        "blocking_reason": "accepted_ta_signal_stale" if stale else None,
        "fresh_until": latest_signal_at + timedelta(seconds=max_age_seconds),
        "excluded_fresher_sources": excluded_fresher_sources,
        "per_symbol_coverage": per_symbol_coverage,
        "market_session_state": "not_evaluated",
        "freshness_reason_codes": reason_codes,
    }


def accepted_signal_sources(raw: str | None) -> tuple[str, ...]:
    return tuple(sorted(normalized_signal_sources(raw)))


def latest_signal_readiness_counts(
    *,
    context: ClickHouseSignalFreshnessContext,
    time_column: str,
    latest_signal_at: datetime,
) -> dict[str, object]:
    safe_time_column = safe_identifier(time_column, kind="column")
    lookback_minutes = max(int(context.initial_lookback_minutes or 1), 1)
    window_start = latest_signal_at - timedelta(minutes=lookback_minutes)
    where_parts = [
        f"{safe_time_column} >= {to_datetime64(window_start)}",
        f"{safe_time_column} <= {to_datetime64(latest_signal_at)}",
    ]
    source_clause = context.source_where_clause()
    if source_clause is not None:
        where_parts.append(source_clause)
    query = " ".join(
        [
            "SELECT",
            "count() AS signal_rows, uniqExact(symbol) AS symbol_count",
            "FROM",
            context.table,
            "WHERE",
            " AND ".join(where_parts),
            "FORMAT JSONEachRow",
        ]
    )
    rows = context.query_clickhouse(query)
    row: Mapping[str, object] = rows[0] if rows else {}
    return {
        "signal_rows": coerce_count(row.get("signal_rows")),
        "symbol_count": coerce_count(row.get("symbol_count")),
        "readiness_window_start": window_start,
        "readiness_window_end": latest_signal_at,
    }


def excluded_fresher_sources_after_accepted_latest(
    *,
    context: ClickHouseSignalFreshnessContext,
    time_column: str,
    latest_accepted_signal_at: datetime,
    accepted_sources: tuple[str, ...],
) -> list[dict[str, object]]:
    if not accepted_sources:
        return []
    columns = context.resolve_columns()
    if columns is not None and "source" not in columns:
        return []
    safe_time_column = safe_identifier(time_column, kind="column")
    query = " ".join(
        [
            "SELECT",
            "lower(source) AS source,",
            f"max({safe_time_column}) AS latest_signal_ts,",
            "count() AS signal_rows, uniqExact(symbol) AS symbol_count",
            "FROM",
            context.table,
            "WHERE source != ''",
            "GROUP BY source",
            "ORDER BY latest_signal_ts DESC",
            "FORMAT JSONEachRow",
        ]
    )
    rows = context.query_clickhouse(query)
    excluded: list[dict[str, object]] = []
    accepted = set(accepted_sources)
    for row in rows:
        source = str(row.get("source") or "").strip().lower()
        latest = parse_ts(row.get("latest_signal_ts"))
        if not source or source in accepted or latest is None:
            continue
        if latest <= latest_accepted_signal_at:
            continue
        excluded.append(
            {
                "source": source,
                "latest_signal_at": latest,
                "lag_vs_accepted_seconds": max(
                    0,
                    int((latest - latest_accepted_signal_at).total_seconds()),
                ),
                "signal_rows": coerce_count(row.get("signal_rows")),
                "symbol_count": coerce_count(row.get("symbol_count")),
                "excluded_reason": "source_not_allowed_for_live_runtime",
            }
        )
    return excluded


def accepted_per_symbol_coverage(
    *,
    context: ClickHouseSignalFreshnessContext,
    time_column: str,
    latest_signal_at: datetime,
) -> list[dict[str, object]]:
    safe_time_column = safe_identifier(time_column, kind="column")
    lookback_minutes = max(int(context.initial_lookback_minutes or 1), 1)
    window_start = latest_signal_at - timedelta(minutes=lookback_minutes)
    where_parts = [
        f"{safe_time_column} >= {to_datetime64(window_start)}",
        f"{safe_time_column} <= {to_datetime64(latest_signal_at)}",
    ]
    source_clause = context.source_where_clause()
    if source_clause is not None:
        where_parts.append(source_clause)
    query = " ".join(
        [
            "SELECT",
            "symbol,",
            f"max({safe_time_column}) AS latest_signal_ts,",
            "count() AS signal_rows",
            "FROM",
            context.table,
            "WHERE",
            " AND ".join(where_parts),
            "GROUP BY symbol",
            "ORDER BY symbol ASC",
            "FORMAT JSONEachRow",
        ]
    )
    rows = context.query_clickhouse(query)
    coverage: list[dict[str, object]] = []
    for row in rows:
        symbol = str(row.get("symbol") or "").strip().upper()
        latest = parse_ts(row.get("latest_signal_ts"))
        if not symbol or latest is None:
            continue
        coverage.append(
            {
                "symbol": symbol,
                "latest_signal_at": latest,
                "lag_seconds": max(
                    0,
                    int((latest_signal_at - latest).total_seconds()),
                ),
                "signal_rows": coerce_count(row.get("signal_rows")),
            }
        )
    return coverage


__all__ = [
    "accepted_per_symbol_coverage",
    "accepted_signal_sources",
    "build_accepted_source_freshness_contract",
    "ClickHouseSignalFreshnessContext",
    "excluded_fresher_sources_after_accepted_latest",
    "latest_signal_readiness_counts",
]
