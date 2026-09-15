"""Private price parsing and quote utility helpers."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from ..config import settings


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _parse_ts(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        return _parse_iso_ts(value)
    return None


def _parse_iso_ts(value: str) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _snapshot_as_of(row: Mapping[str, Any], fallback: datetime) -> datetime:
    return _parse_ts(row.get("event_ts")) or _parse_ts(row.get("ts")) or fallback


def _select_price(row: dict[str, Any]) -> Optional[Decimal]:
    return (
        _optional_decimal(row.get("c"))
        or _optional_decimal(row.get("vwap"))
        or _optional_decimal(row.get("close"))
        or _optional_decimal(row.get("price"))
    )


def _select_quote_spread(
    row: Mapping[str, Any],
    *,
    bid: Decimal | None,
    ask: Decimal | None,
) -> Optional[Decimal]:
    spread = _optional_decimal(row.get("spread"))
    if spread is not None:
        return spread
    spread = _optional_decimal(row.get("imbalance_spread"))
    if spread is not None:
        return spread
    if bid is None or ask is None:
        return None
    return ask - bid


def _quote_row_reject_reason(row: Mapping[str, Any]) -> str | None:
    bid = _optional_decimal(row.get("imbalance_bid_px"))
    ask = _optional_decimal(row.get("imbalance_ask_px"))
    for failed, reason in (
        (bid is None and ask is None, "missing_executable_quote"),
        (bid is None, "missing_bid"),
        (ask is None, "missing_ask"),
        (bid is not None and bid <= 0, "non_positive_bid"),
        (ask is not None and ask <= 0, "non_positive_ask"),
        (bid is not None and ask is not None and ask < bid, "crossed_quote"),
    ):
        if failed:
            return reason
    if bid is None or ask is None:
        return "missing_executable_quote"
    spread_bps = _quote_spread_bps(bid=bid, ask=ask)
    return _quote_spread_reject_reason(spread_bps)


def _quote_spread_reject_reason(spread_bps: Decimal | None) -> str | None:
    if spread_bps is None:
        return "invalid_spread"
    if spread_bps > settings.trading_signal_max_executable_spread_bps:
        return "spread_bps_exceeded"
    return None


def _midpoint(*, bid: Decimal | None, ask: Decimal | None) -> Optional[Decimal]:
    if bid is None or ask is None:
        return None
    return (bid + ask) / Decimal("2")


def _quote_spread_bps(*, bid: Decimal, ask: Decimal) -> Optional[Decimal]:
    midpoint = _midpoint(bid=bid, ask=ask)
    if midpoint is None or midpoint <= 0:
        return None
    return ((ask - bid) / midpoint) * Decimal("10000")


def _quote_spread_bps_sql() -> str:
    return (
        "((imbalance_ask_px - imbalance_bid_px) / "
        "nullIf(((imbalance_ask_px + imbalance_bid_px) / 2), 0)) * 10000"
    )


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


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


midpoint = _midpoint
optional_decimal = _optional_decimal
parse_ts = _parse_ts
qualified_table_name = _qualified_table_name
quote_literal = _quote_literal
quote_spread_bps = _quote_spread_bps
quote_spread_bps_sql = _quote_spread_bps_sql
quote_spread_reject_reason = _quote_spread_reject_reason
select_price = _select_price
select_quote_spread = _select_quote_spread
snapshot_as_of = _snapshot_as_of
split_table = _split_table


__all__ = [
    "_optional_decimal",
    "_parse_ts",
    "_parse_iso_ts",
    "_snapshot_as_of",
    "_select_price",
    "_select_quote_spread",
    "_quote_row_reject_reason",
    "_quote_spread_reject_reason",
    "_midpoint",
    "_quote_spread_bps",
    "_quote_spread_bps_sql",
    "_split_table",
    "_safe_identifier",
    "_qualified_table_name",
    "_quote_literal",
    "_IDENTIFIER_RE",
    "midpoint",
    "optional_decimal",
    "parse_ts",
    "qualified_table_name",
    "quote_literal",
    "quote_spread_bps",
    "quote_spread_bps_sql",
    "quote_spread_reject_reason",
    "select_price",
    "select_quote_spread",
    "snapshot_as_of",
    "split_table",
]
