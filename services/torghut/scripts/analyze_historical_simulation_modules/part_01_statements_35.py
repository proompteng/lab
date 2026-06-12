# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python3
"""Generate a production-ready statistical report for a historical simulation run."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

import psycopg
from psycopg import rows

from scripts.start_historical_simulation import (
    ClickHouseRuntimeConfig,
    _as_mapping,
    _as_text,
    _build_clickhouse_runtime_config,
    _build_postgres_runtime_config,
    _build_resources,
    _default_simulation_postgres_db,
    _http_clickhouse_query,
    _load_manifest,
    _parse_rfc3339_timestamp,
    _resolve_window_bounds,
    _safe_float,
    _safe_int,
    _validate_window_policy,
)

# ruff: noqa: F401,F403,F405,F811,F821


REPORT_SCHEMA_VERSION = "torghut.simulation-report.v1"


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
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return Decimal(int(value))
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return Decimal(stripped)
        except Exception:
            return None
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


def _query_rows(conn: psycopg.Connection[Any], query: str) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=rows.dict_row) as cursor:
        cursor.execute(query)  # pyright: ignore[reportCallIssue]
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


def _build_last_price_map(
    *,
    clickhouse_config: ClickHouseRuntimeConfig | None,
    price_table: str,
    tca_rows: list[dict[str, Any]],
    execution_rows: list[dict[str, Any]],
) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    if clickhouse_config is not None and clickhouse_config.http_url and price_table:
        for close_field in ("close", "c"):
            query = (
                f"SELECT symbol, toString(argMax({close_field}, event_ts)) "
                f"FROM {price_table} "
                f"GROUP BY symbol FORMAT TabSeparated"
            )
            try:
                status, body = _http_clickhouse_query(
                    config=clickhouse_config, query=query
                )
            except Exception:
                status = 0
                body = ""
            if not (200 <= status < 300 and body):
                continue
            for line in body.splitlines():
                parts = line.split("\t")
                if len(parts) != 2:
                    continue
                symbol = parts[0].strip()
                price = _as_decimal(parts[1])
                if symbol and price is not None:
                    prices[symbol] = price
            if prices:
                break

    if not prices:
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

    if not prices:
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
    long_lots: dict[str, deque[dict[str, Decimal]]] = defaultdict(deque)
    short_lots: dict[str, deque[dict[str, Decimal]]] = defaultdict(deque)
    open_lot_count = 0
    realized_total = Decimal("0")
    execution_notional_total = Decimal("0")
    realized_by_symbol: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    trade_rows: list[dict[str, Any]] = []

    for row in executions:
        symbol = _as_text(row.get("symbol"))
        side = (_as_text(row.get("side")) or "").lower()
        qty = _as_decimal(row.get("filled_qty"))
        price = _as_decimal(row.get("avg_fill_price"))
        if (
            symbol is None
            or side not in {"buy", "sell"}
            or qty is None
            or price is None
        ):
            continue
        if qty <= 0:
            continue

        remaining = qty
        realized_for_execution = Decimal("0")
        execution_notional_total += qty * price

        if side == "buy":
            shorts = short_lots[symbol]
            while remaining > 0 and shorts:
                lot = shorts[0]
                close_qty = min(remaining, lot["qty"])
                realized = (lot["price"] - price) * close_qty
                realized_total += realized
                realized_by_symbol[symbol] += realized
                realized_for_execution += realized
                lot["qty"] -= close_qty
                remaining -= close_qty
                if lot["qty"] <= 0:
                    shorts.popleft()
            if remaining > 0:
                long_lots[symbol].append({"qty": remaining, "price": price})
        else:
            longs = long_lots[symbol]
            while remaining > 0 and longs:
                lot = longs[0]
                close_qty = min(remaining, lot["qty"])
                realized = (price - lot["price"]) * close_qty
                realized_total += realized
                realized_by_symbol[symbol] += realized
                realized_for_execution += realized
                lot["qty"] -= close_qty
                remaining -= close_qty
                if lot["qty"] <= 0:
                    longs.popleft()
            if remaining > 0:
                short_lots[symbol].append({"qty": remaining, "price": price})

        trade_rows.append(
            {
                "execution_id": str(row.get("id") or ""),
                "trade_decision_id": str(row.get("trade_decision_id") or ""),
                "symbol": symbol,
                "side": side,
                "filled_qty": _decimal_to_str(qty),
                "avg_fill_price": _decimal_to_str(price),
                "realized_pnl_contribution": _decimal_to_str(realized_for_execution),
                "created_at": str(row.get("created_at") or ""),
            }
        )

    unrealized_total = Decimal("0")
    for symbol, lots in long_lots.items():
        last = last_prices.get(symbol)
        if last is None:
            continue
        for lot in lots:
            unrealized_total += (last - lot["price"]) * lot["qty"]
            open_lot_count += 1
    for symbol, lots in short_lots.items():
        last = last_prices.get(symbol)
        if last is None:
            continue
        for lot in lots:
            unrealized_total += (lot["price"] - last) * lot["qty"]
            open_lot_count += 1

    gross_total = realized_total + unrealized_total
    by_symbol_payload = [
        {
            "symbol": symbol,
            "realized_pnl": _decimal_to_str(value),
        }
        for symbol, value in sorted(realized_by_symbol.items())
    ]
    return (
        {
            "realized_pnl": realized_total,
            "unrealized_pnl": unrealized_total,
            "gross_pnl": gross_total,
            "execution_notional_total": execution_notional_total,
            "open_lot_count": open_lot_count,
            "realized_by_symbol": by_symbol_payload,
        },
        trade_rows,
    )


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


__all__ = [name for name in globals() if not name.startswith("__")]
