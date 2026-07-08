"""Accepted-source ClickHouse signal freshness diagnostics."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TypeAlias
from zoneinfo import ZoneInfo

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
_EASTERN_TZ = ZoneInfo("America/New_York")

logger = logging.getLogger("app.trading.ingest")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


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
    now: Callable[[], datetime] = _utc_now


@dataclass(frozen=True)
class _AcceptedSourceFreshnessGate:
    state: str
    blocking_reason: str | None
    reason_codes: tuple[str, ...] = ()


def build_accepted_source_freshness_contract(
    *,
    context: ClickHouseSignalFreshnessContext,
    time_column: str,
    latest_signal_at: datetime,
) -> dict[str, object]:
    now = context.now().astimezone(timezone.utc)
    max_age_seconds = max(1, int(context.max_staleness_ms) // 1000)
    accepted_lag_seconds = max(0, int((now - latest_signal_at).total_seconds()))
    accepted_sources = accepted_signal_sources(context.allowed_sources_raw)
    market_session = regular_market_session_state(now)
    freshness_gate = _accepted_source_freshness_gate(
        lag_seconds=accepted_lag_seconds,
        max_age_seconds=max_age_seconds,
        regular_session_open=market_session["regular_session_open"] is True,
        simulation_mode=context.simulation_mode,
    )
    reason_codes = list(freshness_gate.reason_codes)
    excluded_fresher_sources: list[dict[str, object]] = []
    per_symbol_coverage: list[dict[str, object]] = []
    stale_symbol_coverage: list[dict[str, object]] = []
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
            now=now,
            max_age_seconds=max_age_seconds,
        )
        stale_symbol_coverage = [
            row for row in per_symbol_coverage if row.get("state") == "stale"
        ]
        symbol_gate = _accepted_symbol_coverage_gate(
            stale_symbol_coverage=stale_symbol_coverage,
            regular_session_open=market_session["regular_session_open"] is True,
            simulation_mode=context.simulation_mode,
        )
        reason_codes.extend(symbol_gate.reason_codes)
        if freshness_gate.blocking_reason is None and symbol_gate.blocking_reason:
            freshness_gate = symbol_gate
    except _DIAGNOSTIC_EXCEPTIONS as exc:
        logger.warning("Failed to load accepted ClickHouse TA symbol coverage: %s", exc)
        reason_codes.append("clickhouse_ta_symbol_coverage_query_failed")
    return {
        "accepted_sources": list(accepted_sources) if accepted_sources else ["*"],
        "latest_accepted_event_at": latest_signal_at,
        "accepted_lag_seconds": accepted_lag_seconds,
        "accepted_max_lag_seconds": max_age_seconds,
        "accepted_source_state": freshness_gate.state,
        "blocking_reason": freshness_gate.blocking_reason,
        "fresh_until": latest_signal_at + timedelta(seconds=max_age_seconds),
        "excluded_fresher_sources": excluded_fresher_sources,
        "per_symbol_coverage": per_symbol_coverage,
        "stale_symbol_coverage": stale_symbol_coverage,
        **market_session,
        "freshness_reason_codes": list(dict.fromkeys(reason_codes)),
    }


def _accepted_source_freshness_gate(
    *,
    lag_seconds: int,
    max_age_seconds: int,
    regular_session_open: bool,
    simulation_mode: bool,
) -> _AcceptedSourceFreshnessGate:
    if lag_seconds <= max_age_seconds or simulation_mode:
        return _AcceptedSourceFreshnessGate(state="current", blocking_reason=None)
    if regular_session_open:
        return _AcceptedSourceFreshnessGate(
            state="stale",
            blocking_reason="accepted_ta_signal_stale",
        )
    return _AcceptedSourceFreshnessGate(
        state="outside_regular_session",
        blocking_reason=None,
        reason_codes=("accepted_ta_signal_outside_regular_session",),
    )


def _accepted_symbol_coverage_gate(
    *,
    stale_symbol_coverage: Sequence[Mapping[str, object]],
    regular_session_open: bool,
    simulation_mode: bool,
) -> _AcceptedSourceFreshnessGate:
    if not stale_symbol_coverage or simulation_mode:
        return _AcceptedSourceFreshnessGate(state="current", blocking_reason=None)
    if regular_session_open:
        return _AcceptedSourceFreshnessGate(
            state="stale",
            blocking_reason="accepted_ta_signal_stale",
            reason_codes=("accepted_ta_symbol_stale",),
        )
    return _AcceptedSourceFreshnessGate(
        state="current",
        blocking_reason=None,
        reason_codes=("accepted_ta_symbol_outside_regular_session",),
    )


def regular_market_session_state(now: datetime) -> dict[str, object]:
    current = now.astimezone(_EASTERN_TZ)
    session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
    session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
    if current.weekday() >= 5:
        state = "weekend_closed"
    elif current < session_open:
        state = "pre_market"
    elif current < session_close:
        state = "regular_open"
    else:
        state = "after_market_close"
    return {
        "market_session_state": state,
        "regular_session_open": state == "regular_open",
        "regular_session_open_at": session_open.astimezone(timezone.utc),
        "regular_session_close_at": session_close.astimezone(timezone.utc),
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
    now: datetime,
    max_age_seconds: int,
) -> list[dict[str, object]]:
    query = _accepted_per_symbol_coverage_query(
        context=context,
        time_column=time_column,
        latest_signal_at=latest_signal_at,
    )
    return [
        coverage_row
        for row in context.query_clickhouse(query)
        if (
            coverage_row := _accepted_symbol_coverage_row(
                row=row,
                latest_signal_at=latest_signal_at,
                now=now,
                max_age_seconds=max_age_seconds,
            )
        )
        is not None
    ]


def _accepted_per_symbol_coverage_query(
    *,
    context: ClickHouseSignalFreshnessContext,
    time_column: str,
    latest_signal_at: datetime,
) -> str:
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
    return " ".join(
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


def _accepted_symbol_coverage_row(
    *,
    row: Mapping[str, object],
    latest_signal_at: datetime,
    now: datetime,
    max_age_seconds: int,
) -> dict[str, object] | None:
    symbol = str(row.get("symbol") or "").strip().upper()
    latest = parse_ts(row.get("latest_signal_ts"))
    if not symbol or latest is None:
        return None
    lag_seconds = max(0, int((now - latest).total_seconds()))
    return {
        "symbol": symbol,
        "latest_signal_at": latest,
        "lag_seconds": lag_seconds,
        "lag_vs_latest_accepted_seconds": max(
            0,
            int((latest_signal_at - latest).total_seconds()),
        ),
        "max_lag_seconds": max_age_seconds,
        "state": "stale" if lag_seconds > max_age_seconds else "current",
        "signal_rows": coerce_count(row.get("signal_rows")),
    }


__all__ = [
    "accepted_per_symbol_coverage",
    "accepted_signal_sources",
    "build_accepted_source_freshness_contract",
    "ClickHouseSignalFreshnessContext",
    "excluded_fresher_sources_after_accepted_latest",
    "latest_signal_readiness_counts",
    "regular_market_session_state",
]
