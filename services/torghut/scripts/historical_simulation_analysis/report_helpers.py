#!/usr/bin/env python3
"""Generate a production-ready statistical report for a historical simulation run."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, LiteralString, Mapping

import psycopg
from psycopg import rows

from scripts.historical_simulation_startup import (
    ClickHouseRuntimeConfig,
    _as_mapping,
    _as_text,
    _http_clickhouse_query,
    _parse_rfc3339_timestamp,
    _safe_int,
)

REPORT_SCHEMA_VERSION = "torghut.simulation-report.v1"


@dataclass(frozen=True)
class _ExecutionFill:
    symbol: str
    side: str
    qty: Decimal
    price: Decimal


@dataclass
class _FifoPnlState:
    long_lots: dict[str, deque[dict[str, Decimal]]] = field(
        default_factory=lambda: defaultdict(deque)
    )
    short_lots: dict[str, deque[dict[str, Decimal]]] = field(
        default_factory=lambda: defaultdict(deque)
    )
    realized_total: Decimal = Decimal("0")
    execution_notional_total: Decimal = Decimal("0")
    open_lot_count: int = 0
    realized_by_symbol: dict[str, Decimal] = field(
        default_factory=lambda: defaultdict(lambda: Decimal("0"))
    )
    trade_rows: list[dict[str, Any]] = field(default_factory=list)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze one historical simulation run and export metrics artifacts.",
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--dataset-manifest", required=True)
    parser.add_argument("--simulation-dsn", default="")
    parser.add_argument("--clickhouse-http-url", default="")
    parser.add_argument("--clickhouse-username", default="")
    parser.add_argument("--clickhouse-password", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument(
        "--json", action="store_true", help="Emit compact JSON to stdout."
    )
    return parser.parse_args()


def _to_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return {str(k): item for k, item in value.items()}
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return {}
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return {}
        return _to_mapping(decoded)
    return {}


def _to_list_of_strings(value: Any) -> list[str]:
    if isinstance(value, list):
        values: list[str] = []
        for item in value:
            text = _as_text(item)
            if text:
                values.append(text)
        return values
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        return [stripped]
    return []


def _as_decimal(value: Any) -> Decimal | None:
    if isinstance(value, Decimal):
        return value
    text = _decimal_input_text(value)
    if text is None:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def _decimal_input_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        return stripped
    return None


def _decimal_to_str(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, "f")


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc).isoformat()
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    if percentile <= 0:
        return min(values)
    if percentile >= 100:
        return max(values)
    ordered = sorted(values)
    rank = (len(ordered) - 1) * (percentile / 100.0)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    if low == high:
        return ordered[low]
    fraction = rank - low
    return ordered[low] + (ordered[high] - ordered[low]) * fraction


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, Mapping):
        return None
    return {str(k): value for k, value in payload.items()}


def _parse_optional_ts(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return _parse_rfc3339_timestamp(value, label="timestamp")
    except SystemExit:
        return None


def _query_rows(
    conn: psycopg.Connection[Any],
    query: LiteralString,
) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=rows.dict_row) as cursor:
        cursor.execute(query)
        payload = cursor.fetchall()
    return [{str(k): v for k, v in item.items()} for item in payload]


def _extract_simulation_context(decision_json: Mapping[str, Any]) -> dict[str, Any]:
    params = _to_mapping(decision_json.get("params"))
    return _to_mapping(params.get("simulation_context"))


def _extract_signal_event_ts(decision_json: Mapping[str, Any]) -> datetime | None:
    context = _extract_simulation_context(decision_json)
    signal_event_ts = _parse_optional_ts(_as_text(context.get("signal_event_ts")))
    if signal_event_ts is not None:
        return signal_event_ts
    return _parse_optional_ts(_as_text(decision_json.get("event_ts")))


def _extract_run_scope_decisions(
    decisions: list[dict[str, Any]],
    *,
    run_id: str,
) -> list[dict[str, Any]]:
    with_context = [
        row
        for row in decisions
        if _as_text(
            _extract_simulation_context(_to_mapping(row.get("decision_json"))).get(
                "simulation_run_id"
            )
        )
    ]
    if not with_context:
        return decisions
    scoped = [
        row
        for row in with_context
        if _as_text(
            _extract_simulation_context(_to_mapping(row.get("decision_json"))).get(
                "simulation_run_id"
            )
        )
        == run_id
    ]
    return scoped


def _filter_rows_by_scope_ids(
    rows: list[dict[str, Any]],
    *,
    foreign_key: str,
    scope_ids: set[str],
) -> list[dict[str, Any]]:
    """Keep only rows linked to the explicitly scoped parent records."""
    return [row for row in rows if str(row.get(foreign_key) or "") in scope_ids]


def _build_last_price_map(
    *,
    clickhouse_config: ClickHouseRuntimeConfig | None,
    price_table: str,
    tca_rows: list[dict[str, Any]],
    execution_rows: list[dict[str, Any]],
) -> dict[str, Decimal]:
    prices = _last_prices_from_clickhouse(
        clickhouse_config=clickhouse_config,
        price_table=price_table,
    )
    if prices:
        return prices
    prices = _last_prices_from_tca_rows(tca_rows)
    if prices:
        return prices
    return _last_prices_from_execution_rows(execution_rows)


def _last_prices_from_clickhouse(
    *,
    clickhouse_config: ClickHouseRuntimeConfig | None,
    price_table: str,
) -> dict[str, Decimal]:
    if clickhouse_config is None or not clickhouse_config.http_url or not price_table:
        return {}
    for close_field in ("close", "c"):
        prices = _last_prices_from_clickhouse_field(
            clickhouse_config=clickhouse_config,
            price_table=price_table,
            close_field=close_field,
        )
        if prices:
            return prices
    return {}


def _last_prices_from_clickhouse_field(
    *,
    clickhouse_config: ClickHouseRuntimeConfig,
    price_table: str,
    close_field: str,
) -> dict[str, Decimal]:
    query = (
        f"SELECT symbol, toString(argMax({close_field}, event_ts)) "
        f"FROM {price_table} "
        f"GROUP BY symbol FORMAT TabSeparated"
    )
    try:
        status, body = _http_clickhouse_query(config=clickhouse_config, query=query)
    except Exception:
        return {}
    if not (200 <= status < 300 and body):
        return {}
    return _last_prices_from_tab_separated_body(body)


def _last_prices_from_tab_separated_body(body: str) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    for line in body.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        symbol = parts[0].strip()
        price = _as_decimal(parts[1])
        if symbol and price is not None:
            prices[symbol] = price
    return prices


def _last_prices_from_tca_rows(tca_rows: list[dict[str, Any]]) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    for row in reversed(tca_rows):
        symbol = _as_text(row.get("symbol"))
        if not symbol or symbol in prices:
            continue
        avg_fill_price = _as_decimal(row.get("avg_fill_price"))
        arrival_price = _as_decimal(row.get("arrival_price"))
        if avg_fill_price is not None:
            prices[symbol] = avg_fill_price
        elif arrival_price is not None:
            prices[symbol] = arrival_price
    return prices


def _last_prices_from_execution_rows(
    execution_rows: list[dict[str, Any]],
) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    for row in reversed(execution_rows):
        symbol = _as_text(row.get("symbol"))
        if not symbol or symbol in prices:
            continue
        avg_fill_price = _as_decimal(row.get("avg_fill_price"))
        if avg_fill_price is not None:
            prices[symbol] = avg_fill_price
    return prices


def _fifo_trade_pnl(
    executions: list[dict[str, Any]],
    *,
    last_prices: Mapping[str, Decimal],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    state = _FifoPnlState()
    for row in executions:
        fill = _execution_fill_from_row(row)
        if fill is None:
            continue
        _apply_fifo_fill(state=state, fill=fill, source_row=row)

    unrealized_total = _fifo_unrealized_total(state=state, last_prices=last_prices)
    return _fifo_pnl_payload(state, unrealized_total), state.trade_rows


def _execution_fill_from_row(row: dict[str, Any]) -> _ExecutionFill | None:
    symbol = _as_text(row.get("symbol"))
    side = (_as_text(row.get("side")) or "").lower()
    qty = _as_decimal(row.get("filled_qty"))
    price = _as_decimal(row.get("avg_fill_price"))
    if symbol is None or side not in {"buy", "sell"}:
        return None
    if qty is None or price is None or qty <= 0:
        return None
    return _ExecutionFill(symbol=symbol, side=side, qty=qty, price=price)


def _apply_fifo_fill(
    *,
    state: _FifoPnlState,
    fill: _ExecutionFill,
    source_row: dict[str, Any],
) -> None:
    state.execution_notional_total += fill.qty * fill.price
    if fill.side == "buy":
        remaining, realized_for_execution = _close_fifo_lots(
            state=state,
            fill=fill,
            lots=state.short_lots[fill.symbol],
            closes_short=True,
        )
        if remaining > 0:
            state.long_lots[fill.symbol].append({"qty": remaining, "price": fill.price})
    else:
        remaining, realized_for_execution = _close_fifo_lots(
            state=state,
            fill=fill,
            lots=state.long_lots[fill.symbol],
            closes_short=False,
        )
        if remaining > 0:
            state.short_lots[fill.symbol].append(
                {"qty": remaining, "price": fill.price}
            )
    state.trade_rows.append(_fifo_trade_row(source_row, fill, realized_for_execution))


def _close_fifo_lots(
    *,
    state: _FifoPnlState,
    fill: _ExecutionFill,
    lots: deque[dict[str, Decimal]],
    closes_short: bool,
) -> tuple[Decimal, Decimal]:
    remaining = fill.qty
    realized_for_execution = Decimal("0")
    while remaining > 0 and lots:
        lot = lots[0]
        close_qty = min(remaining, lot["qty"])
        realized = _realized_fifo_delta(fill=fill, lot=lot, closes_short=closes_short)
        realized *= close_qty
        state.realized_total += realized
        state.realized_by_symbol[fill.symbol] += realized
        realized_for_execution += realized
        lot["qty"] -= close_qty
        remaining -= close_qty
        if lot["qty"] <= 0:
            lots.popleft()
    return remaining, realized_for_execution


def _realized_fifo_delta(
    *,
    fill: _ExecutionFill,
    lot: dict[str, Decimal],
    closes_short: bool,
) -> Decimal:
    if closes_short:
        return lot["price"] - fill.price
    return fill.price - lot["price"]


def _fifo_trade_row(
    source_row: dict[str, Any],
    fill: _ExecutionFill,
    realized_for_execution: Decimal,
) -> dict[str, Any]:
    return {
        "execution_id": str(source_row.get("id") or ""),
        "trade_decision_id": str(source_row.get("trade_decision_id") or ""),
        "symbol": fill.symbol,
        "side": fill.side,
        "filled_qty": _decimal_to_str(fill.qty),
        "avg_fill_price": _decimal_to_str(fill.price),
        "realized_pnl_contribution": _decimal_to_str(realized_for_execution),
        "created_at": str(source_row.get("created_at") or ""),
    }


def _fifo_unrealized_total(
    *,
    state: _FifoPnlState,
    last_prices: Mapping[str, Decimal],
) -> Decimal:
    long_total, long_count = _fifo_unrealized_lots(
        lots_by_symbol=state.long_lots,
        last_prices=last_prices,
        short=False,
    )
    short_total, short_count = _fifo_unrealized_lots(
        lots_by_symbol=state.short_lots,
        last_prices=last_prices,
        short=True,
    )
    state.open_lot_count = long_count + short_count
    return long_total + short_total


def _fifo_unrealized_lots(
    *,
    lots_by_symbol: Mapping[str, deque[dict[str, Decimal]]],
    last_prices: Mapping[str, Decimal],
    short: bool,
) -> tuple[Decimal, int]:
    total = Decimal("0")
    count = 0
    for symbol, lots in lots_by_symbol.items():
        last = last_prices.get(symbol)
        if last is None:
            continue
        for lot in lots:
            total += _unrealized_lot_delta(lot=lot, last=last, short=short)
            count += 1
    return total, count


def _unrealized_lot_delta(
    *,
    lot: dict[str, Decimal],
    last: Decimal,
    short: bool,
) -> Decimal:
    if short:
        return (lot["price"] - last) * lot["qty"]
    return (last - lot["price"]) * lot["qty"]


def _fifo_pnl_payload(
    state: _FifoPnlState,
    unrealized_total: Decimal,
) -> dict[str, Any]:
    gross_total = state.realized_total + unrealized_total
    return {
        "realized_pnl": state.realized_total,
        "unrealized_pnl": unrealized_total,
        "gross_pnl": gross_total,
        "execution_notional_total": state.execution_notional_total,
        "open_lot_count": state.open_lot_count,
        "realized_by_symbol": _realized_by_symbol_payload(state),
    }


def _realized_by_symbol_payload(state: _FifoPnlState) -> list[dict[str, Any]]:
    return [
        {
            "symbol": symbol,
            "realized_pnl": _decimal_to_str(value),
        }
        for symbol, value in sorted(state.realized_by_symbol.items())
    ]


def _filter_rows_by_any_scope_id(
    rows: list[dict[str, Any]],
    *,
    scope_ids_by_foreign_key: Mapping[str, set[str]],
) -> list[dict[str, Any]]:
    """Keep rows linked through any explicitly scoped parent reference."""
    return [
        row
        for row in rows
        if any(
            str(row.get(foreign_key) or "") in scope_ids
            for foreign_key, scope_ids in scope_ids_by_foreign_key.items()
        )
    ]


def _resolve_scoped_execution_id(
    event: dict[str, Any],
    *,
    execution_ids: set[str],
    execution_ids_by_decision: Mapping[str, list[str]],
) -> str | None:
    """Resolve an order event to one scoped execution without guessing."""
    execution_id = str(event.get("execution_id") or "")
    if execution_id:
        return execution_id if execution_id in execution_ids else None

    decision_id = str(event.get("trade_decision_id") or "")
    candidates = execution_ids_by_decision.get(decision_id, [])
    return candidates[0] if len(candidates) == 1 else None


def _csv_write(path: Path, rows_payload: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows_payload:
        path.write_text("", encoding="utf-8")
        return
    headers = sorted({key for row in rows_payload for key in row.keys()})
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for row in rows_payload:
            writer.writerow({key: row.get(key) for key in headers})


def _collect_clickhouse_stats(
    *,
    clickhouse_config: ClickHouseRuntimeConfig | None,
    clickhouse_db: str,
) -> dict[str, Any]:
    if clickhouse_config is None or not clickhouse_config.http_url:
        return {
            "enabled": False,
            "error": None,
            "tables": {},
        }
    query = (
        "SELECT table, toString(sum(rows)) "
        "FROM system.parts "
        f"WHERE active=1 AND database='{clickhouse_db}' "
        "GROUP BY table ORDER BY table FORMAT TabSeparated"
    )
    try:
        status, body = _http_clickhouse_query(config=clickhouse_config, query=query)
    except Exception as exc:
        return {
            "enabled": True,
            "error": f"clickhouse_query_failed:exception:{exc}",
            "tables": {},
        }
    if status < 200 or status >= 300:
        return {
            "enabled": True,
            "error": f"clickhouse_query_failed:{status}:{body[:160]}",
            "tables": {},
        }
    table_rows: dict[str, int] = {}
    for line in body.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        table = parts[0].strip()
        row_count = _safe_int(parts[1], default=0)
        if table:
            table_rows[table] = row_count
    return {
        "enabled": True,
        "error": None,
        "tables": table_rows,
    }


def _render_markdown(report: Mapping[str, Any]) -> str:
    verdict = (
        _as_text(report.get("verdict", {}).get("status"))
        if isinstance(report.get("verdict"), Mapping)
        else None
    )
    pnl = _as_mapping(report.get("pnl"))
    funnel = _as_mapping(report.get("funnel"))
    llm = _as_mapping(report.get("llm"))
    execution_quality = _as_mapping(report.get("execution_quality"))
    coverage = _as_mapping(report.get("coverage"))

    return "\n".join(
        [
            "# Simulation Report",
            "",
            f"- Schema: `{_as_text(report.get('schema_version'))}`",
            f"- Run ID: `{_as_text(_as_mapping(report.get('run_metadata')).get('run_id'))}`",
            f"- Lane: `{_as_text(_as_mapping(report.get('run_metadata')).get('lane')) or 'equity'}`",
            f"- Verdict: `{verdict or 'unknown'}`",
            "",
            "## Coverage",
            "",
            f"- Target window minutes: `{coverage.get('target_window_minutes')}`",
            f"- Decision span minutes: `{coverage.get('decision_span_minutes')}`",
            f"- Dump span minutes: `{coverage.get('dump_span_minutes')}`",
            "",
            "## Funnel",
            "",
            f"- Decisions: `{funnel.get('trade_decisions')}`",
            f"- Executions: `{funnel.get('executions')}`",
            f"- Execution TCA samples: `{funnel.get('execution_tca_metrics')}`",
            f"- LLM reviews: `{funnel.get('llm_reviews')}`",
            "",
            "## PnL",
            "",
            f"- Gross PnL: `{pnl.get('gross_pnl')}`",
            f"- Net PnL (estimated): `{pnl.get('net_pnl_estimated')}`",
            f"- Realized PnL (FIFO): `{pnl.get('realized_pnl')}`",
            f"- Unrealized PnL: `{pnl.get('unrealized_pnl')}`",
            f"- TCA realized proxy: `{pnl.get('tca_realized_pnl_proxy_notional')}`",
            "",
            "## Execution Quality",
            "",
            f"- Fallback ratio: `{execution_quality.get('fallback_ratio')}`",
            f"- Adapter mismatch ratio: `{execution_quality.get('adapter_mismatch_ratio')}`",
            f"- Order event coverage ratio: `{execution_quality.get('order_event_coverage_ratio')}`",
            "",
            "## LLM",
            "",
            f"- Error rate: `{llm.get('error_rate')}`",
            f"- Avg confidence: `{llm.get('avg_confidence')}`",
            f"- Contribution rate: `{_as_mapping(llm.get('decision_contribution')).get('contribution_rate')}`",
        ]
    )


__all__ = [
    "REPORT_SCHEMA_VERSION",
    "_ExecutionFill",
    "_FifoPnlState",
    "_parse_args",
    "_to_mapping",
    "_to_list_of_strings",
    "_as_decimal",
    "_decimal_input_text",
    "_decimal_to_str",
    "_json_default",
    "_percentile",
    "_mean",
    "_load_json",
    "_parse_optional_ts",
    "_query_rows",
    "_extract_simulation_context",
    "_extract_signal_event_ts",
    "_extract_run_scope_decisions",
    "_filter_rows_by_scope_ids",
    "_filter_rows_by_any_scope_id",
    "_resolve_scoped_execution_id",
    "_build_last_price_map",
    "_last_prices_from_clickhouse",
    "_last_prices_from_clickhouse_field",
    "_last_prices_from_tab_separated_body",
    "_last_prices_from_tca_rows",
    "_last_prices_from_execution_rows",
    "_fifo_trade_pnl",
    "_execution_fill_from_row",
    "_apply_fifo_fill",
    "_close_fifo_lots",
    "_realized_fifo_delta",
    "_fifo_trade_row",
    "_fifo_unrealized_total",
    "_fifo_unrealized_lots",
    "_unrealized_lot_delta",
    "_fifo_pnl_payload",
    "_realized_by_symbol_payload",
    "_csv_write",
    "_collect_clickhouse_stats",
    "_render_markdown",
]
