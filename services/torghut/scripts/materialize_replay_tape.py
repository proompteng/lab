#!/usr/bin/env python3
"""Materialize a manifest-verified replay tape from ClickHouse PT1S signals."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.trading.discovery.replay_tape import (
    ReplayTapeCoverageError,
    build_source_query_digest,
    default_manifest_path,
    materialize_signal_tape,
)
import scripts.local_intraday_tsmom_replay as replay_mod

logger = logging.getLogger(__name__)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch Torghut ClickHouse PT1S signal rows once and write a replay tape "
            "that exact scheduler-v3 replays can reuse without repeated ClickHouse reads."
        ),
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=replay_mod.default_strategy_configmap_path(),
        help="Accepted for parity with replay CLIs; signal materialization does not inspect strategy contents.",
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default=os.environ.get(
            "TA_CLICKHOUSE_URL",
            "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        ),
    )
    parser.add_argument(
        "--clickhouse-username",
        default=os.environ.get(
            "TA_CLICKHOUSE_USERNAME",
            os.environ.get("CLICKHOUSE_USERNAME", "torghut"),
        ),
    )
    parser.add_argument(
        "--clickhouse-password",
        default=os.environ.get(
            "TA_CLICKHOUSE_PASSWORD",
            os.environ.get("CLICKHOUSE_PASSWORD", ""),
        ),
    )
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument(
        "--chunk-minutes", type=int, default=replay_mod.DEFAULT_CHUNK_MINUTES
    )
    parser.add_argument(
        "--clickhouse-query-timeout-seconds",
        type=int,
        default=int(
            os.environ.get(
                "TA_CLICKHOUSE_QUERY_TIMEOUT_SECONDS",
                str(replay_mod.DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS),
            )
        ),
        help="Per ClickHouse HTTP or kubectl query timeout. Keeps replay-tape materialization bounded.",
    )
    parser.add_argument("--start-equity", default=str(replay_mod.DEFAULT_START_EQUITY))
    parser.add_argument(
        "--symbols",
        default="",
        help="Optional comma-separated symbol filter applied in the ClickHouse query.",
    )
    parser.add_argument(
        "--dataset-snapshot-ref",
        required=True,
        help="Dataset snapshot or research run ref this tape is bound to.",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--manifest-output",
        type=Path,
        help="Manifest output path. Defaults to <output>.manifest.json.",
    )
    parser.add_argument(
        "--source-table-version",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="Optional source table/version metadata, repeatable.",
    )
    parser.add_argument(
        "--allow-incomplete-coverage",
        action="store_true",
        help=(
            "Write the tape even when the requested business-day window has missing "
            "signal rows. By default materialization fails closed."
        ),
    )
    parser.add_argument(
        "--coverage-diagnostic-output",
        type=Path,
        help=(
            "Optional JSON path for day-level source coverage diagnostics. When strict "
            "materialization fails closed, this records raw TA signal, executable "
            "quote-backed signal, and microbar row counts without relaxing the failure."
        ),
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("TORGHUT_REPLAY_LOG_LEVEL", "INFO"),
    )
    return parser.parse_args()


def _parse_symbols(value: str) -> tuple[str, ...]:
    return tuple(
        symbol.strip().upper()
        for symbol in str(value or "").split(",")
        if symbol.strip()
    )


def _parse_source_table_versions(values: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values:
        key, sep, item = str(value).partition("=")
        if not sep or not key.strip():
            raise ValueError(f"source_table_version_invalid:{value}")
        parsed[key.strip()] = item.strip()
    return parsed


def _source_query_payload(
    args: argparse.Namespace, symbols: tuple[str, ...]
) -> dict[str, Any]:
    return {
        "query_family": "torghut.ta_signals_pt1s_with_microbars",
        "clickhouse_http_url": str(args.clickhouse_http_url),
        "start_date": str(args.start_date),
        "end_date": str(args.end_date),
        "chunk_minutes": max(1, int(args.chunk_minutes)),
        "symbols": list(symbols),
        "source": "ta",
        "window_size": "PT1S",
        "join": "torghut.ta_microbars",
    }


def _business_days(start_day: date, end_day: date) -> tuple[date, ...]:
    if start_day > end_day:
        return ()
    days: list[date] = []
    current = start_day
    while current <= end_day:
        if current.weekday() < 5:
            days.append(current)
        current += timedelta(days=1)
    return tuple(days)


def _coverage_diagnostics_query(
    *,
    start_date: date,
    end_date: date,
    symbols: tuple[str, ...],
) -> str:
    start_ts = datetime.combine(start_date, time.min, tzinfo=timezone.utc)
    end_ts = datetime.combine(
        end_date + timedelta(days=1), time.min, tzinfo=timezone.utc
    )
    symbol_filter = ""
    if symbols:
        rendered_symbols = ", ".join(f"'{symbol}'" for symbol in symbols)
        symbol_filter = f"\n  AND symbol IN ({rendered_symbols})"
    start_literal = start_ts.strftime("%Y-%m-%d %H:%M:%S")
    end_literal = end_ts.strftime("%Y-%m-%d %H:%M:%S")
    shared_where = f"""
WHERE source = 'ta'
  AND window_size = 'PT1S'
  AND event_ts >= toDateTime64('{start_literal}', 3, 'UTC')
  AND event_ts < toDateTime64('{end_literal}', 3, 'UTC')
  {symbol_filter}
""".rstrip()
    executable_where = f"""
{shared_where}
  AND isNotNull(imbalance_bid_px)
  AND isNotNull(imbalance_ask_px)
""".rstrip()
    return f"""
SELECT
  toString(trading_day) AS trading_day,
  toString(sum(raw_signal_rows)) AS raw_signal_rows,
  toString(sum(executable_signal_rows)) AS executable_signal_rows,
  toString(sum(microbar_rows)) AS microbar_rows,
  toString(uniqExactIf(symbol, source_kind = 'raw_signal')) AS raw_signal_symbol_count,
  toString(uniqExactIf(symbol, source_kind = 'executable_signal')) AS executable_signal_symbol_count,
  toString(uniqExactIf(symbol, source_kind = 'microbar')) AS microbar_symbol_count
FROM
(
  SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    'raw_signal' AS source_kind,
    count() AS raw_signal_rows,
    0 AS executable_signal_rows,
    0 AS microbar_rows
  FROM torghut.ta_signals
  {shared_where}
  GROUP BY trading_day, symbol
  UNION ALL
  SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    'executable_signal' AS source_kind,
    0 AS raw_signal_rows,
    count() AS executable_signal_rows,
    0 AS microbar_rows
  FROM torghut.ta_signals
  {executable_where}
  GROUP BY trading_day, symbol
  UNION ALL
  SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    'microbar' AS source_kind,
    0 AS raw_signal_rows,
    0 AS executable_signal_rows,
    count() AS microbar_rows
  FROM torghut.ta_microbars
  {shared_where}
  GROUP BY trading_day, symbol
)
GROUP BY trading_day
ORDER BY trading_day
FORMAT TSVRaw
""".strip()


def _parse_coverage_diagnostics(
    raw: str,
) -> dict[str, dict[str, int]]:
    diagnostics: dict[str, dict[str, int]] = {}
    reader = csv.reader(raw.splitlines(), delimiter="\t")
    for parts in reader:
        if len(parts) != 7:
            continue
        (
            trading_day,
            raw_signal_rows,
            executable_signal_rows,
            microbar_rows,
            raw_signal_symbol_count,
            executable_signal_symbol_count,
            microbar_symbol_count,
        ) = parts
        diagnostics[str(trading_day)] = {
            "raw_signal_rows": int(raw_signal_rows or 0),
            "executable_signal_rows": int(executable_signal_rows or 0),
            "microbar_rows": int(microbar_rows or 0),
            "raw_signal_symbol_count": int(raw_signal_symbol_count or 0),
            "executable_signal_symbol_count": int(executable_signal_symbol_count or 0),
            "microbar_symbol_count": int(microbar_symbol_count or 0),
        }
    return diagnostics


def _fetch_coverage_diagnostics(
    *,
    args: argparse.Namespace,
    symbols: tuple[str, ...],
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    requested_days = tuple(
        day.isoformat() for day in _business_days(start_date, end_date)
    )
    query = _coverage_diagnostics_query(
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
    )
    raw = replay_mod._http_query(
        url=str(args.clickhouse_http_url),
        username=(str(args.clickhouse_username).strip() or None),
        password=(str(args.clickhouse_password).strip() or None),
        timeout_seconds=max(
            1,
            int(
                getattr(
                    args,
                    "clickhouse_query_timeout_seconds",
                    replay_mod.DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
                )
            ),
        ),
        query=query,
    )
    rows = _parse_coverage_diagnostics(raw)
    missing_raw_signal_days = tuple(
        day
        for day in requested_days
        if rows.get(day, {}).get("raw_signal_rows", 0) <= 0
    )
    missing_executable_signal_days = tuple(
        day
        for day in requested_days
        if rows.get(day, {}).get("executable_signal_rows", 0) <= 0
    )
    missing_microbar_days = tuple(
        day for day in requested_days if rows.get(day, {}).get("microbar_rows", 0) <= 0
    )
    return {
        "schema_version": "torghut.replay-coverage-diagnostic.v1",
        "query_family": "torghut.ta_replay_source_coverage",
        "requested_trading_days": list(requested_days),
        "symbols": list(symbols),
        "rows_by_trading_day": rows,
        "missing_raw_signal_days": list(missing_raw_signal_days),
        "missing_executable_signal_days": list(missing_executable_signal_days),
        "missing_microbar_days": list(missing_microbar_days),
        "source_query_digest": build_source_query_digest(
            {
                "query_family": "torghut.ta_replay_source_coverage",
                "start_date": start_date,
                "end_date": end_date,
                "symbols": list(symbols),
            }
        ),
    }


def _write_coverage_diagnostics(
    *,
    output_path: Path,
    args: argparse.Namespace,
    symbols: tuple[str, ...],
    start_date: date,
    end_date: date,
    failure_reason: str | None = None,
    materialization_diagnostics: dict[str, Any] | None = None,
) -> None:
    diagnostics = _fetch_coverage_diagnostics(
        args=args,
        symbols=symbols,
        start_date=start_date,
        end_date=end_date,
    )
    if failure_reason:
        diagnostics["materialization_failure_reason"] = failure_reason
    if materialization_diagnostics is not None:
        diagnostics["materialization_diagnostics"] = dict(materialization_diagnostics)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(diagnostics, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    symbols = _parse_symbols(str(args.symbols or ""))
    start_date = date.fromisoformat(str(args.start_date))
    end_date = date.fromisoformat(str(args.end_date))
    source_query_digest = build_source_query_digest(
        _source_query_payload(args=args, symbols=symbols)
    )
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=Path(args.strategy_configmap).resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=max(1, int(args.chunk_minutes)),
        clickhouse_query_timeout_seconds=max(
            1,
            int(
                getattr(
                    args,
                    "clickhouse_query_timeout_seconds",
                    replay_mod.DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
                )
            ),
        ),
        flatten_eod=True,
        start_equity=Decimal(str(args.start_equity)),
        symbols=symbols,
    )
    rows = tuple(replay_mod._iter_signal_rows(config))
    manifest_path = args.manifest_output or default_manifest_path(args.output)
    try:
        manifest = materialize_signal_tape(
            rows=rows,
            tape_path=Path(args.output).resolve(),
            manifest_path=Path(manifest_path).resolve(),
            dataset_snapshot_ref=str(args.dataset_snapshot_ref),
            symbols=symbols,
            start_date=start_date,
            end_date=end_date,
            source_query_digest=source_query_digest,
            source_table_versions=_parse_source_table_versions(
                args.source_table_version
            ),
            require_complete_coverage=not bool(args.allow_incomplete_coverage),
        )
    except ReplayTapeCoverageError as exc:
        diagnostic_output = getattr(args, "coverage_diagnostic_output", None)
        if diagnostic_output:
            _write_coverage_diagnostics(
                output_path=Path(diagnostic_output).resolve(),
                args=args,
                symbols=symbols,
                start_date=start_date,
                end_date=end_date,
                failure_reason=str(exc),
                materialization_diagnostics=exc.diagnostics,
            )
        raise
    diagnostic_output = getattr(args, "coverage_diagnostic_output", None)
    if diagnostic_output:
        _write_coverage_diagnostics(
            output_path=Path(diagnostic_output).resolve(),
            args=args,
            symbols=symbols,
            start_date=start_date,
            end_date=end_date,
        )
    logger.info(
        "replay_tape_materialized output=%s manifest=%s rows=%s digest=%s",
        args.output,
        manifest_path,
        manifest.row_count,
        manifest.content_sha256,
    )
    print(json.dumps(manifest.to_payload(), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
