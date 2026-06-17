from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional


@dataclass(frozen=True)
class LatestSignalCacheLookup:
    hit: bool
    value: Optional[datetime]


@dataclass(frozen=True)
class ClickHouseRequest:
    scheme: str
    hostname: str
    port: int | None
    path: str
    headers: dict[str, str]


def signal_scope_key(
    symbols: tuple[str, ...], timeframes: tuple[str, ...]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    return symbols, timeframes


def qualified_table_name(table: str) -> str:
    from .attach_simulation_context import (
        qualified_table_name as attach_qualified_table_name,
    )

    return attach_qualified_table_name(table)


def safe_identifier(value: str, *, kind: str) -> str:
    from .attach_simulation_context import (
        safe_identifier as attach_safe_identifier,
    )

    return attach_safe_identifier(value, kind=kind)


def normalized_signal_sources(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def split_table(table: str) -> tuple[str, str]:
    if "." in table:
        database, raw_table = table.split(".", 1)
        return database, raw_table
    return "default", table


def quote_literal(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def dedupe_columns(columns: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for column in columns:
        if column in seen:
            continue
        seen.add(column)
        deduped.append(column)
    return deduped


def select_columns(columns: set[str], time_column: str) -> list[str]:
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
    for column in desired:
        if column in seen or column not in columns:
            continue
        selected.append(column)
        seen.add(column)
    return selected


def column_names_from_rows(rows: list[dict[str, Any]]) -> Optional[set[str]]:
    columns = {str(row.get("name")) for row in rows if row.get("name")}
    return columns or None


def latest_signal_timestamp_from_rows(
    rows: list[dict[str, Any]],
) -> Optional[datetime]:
    if not rows:
        return None
    raw = rows[0].get("latest_signal_ts")
    return parse_ts(raw) if raw is not None else None


def parse_ts(value: Any) -> Optional[datetime]:
    parsed: datetime | None = None
    if value is None:
        pass
    elif isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        parsed = datetime.fromtimestamp(float(value), tz=timezone.utc)
    elif isinstance(value, str):
        cleaned = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(cleaned)
        except ValueError:
            parsed = None
        else:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


__all__ = [
    "ClickHouseRequest",
    "LatestSignalCacheLookup",
    "column_names_from_rows",
    "dedupe_columns",
    "latest_signal_timestamp_from_rows",
    "normalized_signal_sources",
    "parse_ts",
    "qualified_table_name",
    "quote_literal",
    "safe_identifier",
    "select_columns",
    "signal_scope_key",
    "split_table",
]
