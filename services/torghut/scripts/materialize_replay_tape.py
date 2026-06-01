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
from typing import Any, Mapping

from app.trading.session_context import iter_regular_equities_session_dates
from app.trading.discovery.replay_tape import (
    ReplayTapeCoverageError,
    build_source_query_digest,
    default_manifest_path,
    materialize_signal_tape,
)
import scripts.local_intraday_tsmom_replay as replay_mod

logger = logging.getLogger(__name__)

_REGULAR_SESSION_SECONDS = 23_400
_DEFAULT_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY = 18_000
_DEFAULT_MIN_QUOTE_VALID_RATIO = Decimal("0.90")
_DEFAULT_MAX_COVERAGE_SPREAD_BPS = Decimal("50")
_DEFAULT_MAX_EXECUTABLE_GAP_SECONDS = 120


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
        "--latest-complete-window-min-days",
        type=int,
        default=0,
        help=(
            "When greater than zero, first inspect source coverage and materialize the "
            "latest consecutive sub-window with at least this many complete executable "
            "trading days. The manifest is bound to the selected sub-window; incomplete "
            "requested days are recorded only in diagnostics/receipt output."
        ),
    )
    parser.add_argument(
        "--latest-complete-window-receipt-output",
        type=Path,
        help="Optional JSON receipt path for --latest-complete-window-min-days.",
    )
    parser.add_argument(
        "--min-executable-rows-per-symbol-day",
        type=int,
        default=int(
            os.environ.get(
                "TORGHUT_REPLAY_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY",
                str(_DEFAULT_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY),
            )
        ),
        help=(
            "Minimum executable quote-backed PT1S rows required for every present "
            "symbol/day before a day can be selected as complete."
        ),
    )
    parser.add_argument(
        "--min-quote-valid-ratio",
        default=os.environ.get(
            "TORGHUT_REPLAY_MIN_QUOTE_VALID_RATIO",
            str(_DEFAULT_MIN_QUOTE_VALID_RATIO),
        ),
        help=(
            "Minimum spread-sane/executable quote ratio required by the latest "
            "complete replay-window selector."
        ),
    )
    parser.add_argument(
        "--max-coverage-spread-bps",
        default=os.environ.get(
            "TORGHUT_REPLAY_MAX_COVERAGE_SPREAD_BPS",
            str(_DEFAULT_MAX_COVERAGE_SPREAD_BPS),
        ),
        help="Maximum bid/ask spread in bps for a coverage row to count as quote-valid.",
    )
    parser.add_argument(
        "--max-executable-gap-seconds",
        type=int,
        default=int(
            os.environ.get(
                "TORGHUT_REPLAY_MAX_EXECUTABLE_GAP_SECONDS",
                str(_DEFAULT_MAX_EXECUTABLE_GAP_SECONDS),
            )
        ),
        help=(
            "Maximum gap between executable quote-backed rows for a symbol/day. "
            "Larger gaps are treated as stale coverage."
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


def _executable_day_policy(args: argparse.Namespace) -> dict[str, Any]:
    min_rows = max(
        0,
        int(
            getattr(
                args,
                "min_executable_rows_per_symbol_day",
                _DEFAULT_MIN_EXECUTABLE_ROWS_PER_SYMBOL_DAY,
            )
            or 0
        ),
    )
    return {
        "schema_version": "torghut.replay-executable-day-policy.v1",
        "regular_session_seconds": _REGULAR_SESSION_SECONDS,
        "min_executable_rows_per_symbol_day": min_rows,
        "min_regular_session_density_ratio": str(
            Decimal(min_rows) / Decimal(_REGULAR_SESSION_SECONDS)
        ),
        "min_quote_valid_ratio": str(
            Decimal(
                str(
                    getattr(
                        args,
                        "min_quote_valid_ratio",
                        str(_DEFAULT_MIN_QUOTE_VALID_RATIO),
                    )
                    or "0"
                )
            )
        ),
        "max_coverage_spread_bps": str(
            Decimal(
                str(
                    getattr(
                        args,
                        "max_coverage_spread_bps",
                        str(_DEFAULT_MAX_COVERAGE_SPREAD_BPS),
                    )
                    or "0"
                )
            )
        ),
        "max_executable_gap_seconds": max(
            0,
            int(
                getattr(
                    args,
                    "max_executable_gap_seconds",
                    _DEFAULT_MAX_EXECUTABLE_GAP_SECONDS,
                )
                or 0
            ),
        ),
    }


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
    return iter_regular_equities_session_dates(start_day, end_day)


def _coverage_diagnostics_query(
    *,
    start_date: date,
    end_date: date,
    symbols: tuple[str, ...],
    max_spread_bps: Decimal,
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
    sane_quote_where = f"""
{executable_where}
  AND imbalance_bid_px > 0
  AND imbalance_ask_px > 0
  AND imbalance_ask_px >= imbalance_bid_px
""".rstrip()
    spread_sane_where = f"""
{sane_quote_where}
  AND if(
    (imbalance_bid_px + imbalance_ask_px) <= 0,
    1000000000,
    abs(imbalance_ask_px - imbalance_bid_px) / ((imbalance_bid_px + imbalance_ask_px) / 2) * 10000
  ) <= {str(max_spread_bps)}
""".rstrip()
    return f"""
SELECT
  toString(trading_day) AS trading_day,
  toString(sum(raw_signal_rows_by_symbol)) AS raw_signal_rows,
  toString(sum(executable_signal_rows_by_symbol)) AS executable_signal_rows,
  toString(sum(quote_sane_signal_rows_by_symbol)) AS quote_sane_signal_rows,
  toString(sum(spread_sane_signal_rows_by_symbol)) AS spread_sane_signal_rows,
  toString(sum(microbar_rows_by_symbol)) AS microbar_rows,
  toString(countIf(raw_signal_rows_by_symbol > 0)) AS raw_signal_symbol_count,
  toString(countIf(executable_signal_rows_by_symbol > 0)) AS executable_signal_symbol_count,
  toString(countIf(microbar_rows_by_symbol > 0)) AS microbar_symbol_count,
  toString(minIf(executable_signal_rows_by_symbol, raw_signal_rows_by_symbol > 0)) AS min_executable_rows_per_symbol_day,
  toString(minIf(spread_sane_signal_rows_by_symbol, raw_signal_rows_by_symbol > 0)) AS min_spread_sane_rows_per_symbol_day,
  toString(if(
    sum(executable_signal_rows_by_symbol) = 0,
    0,
    sum(spread_sane_signal_rows_by_symbol) / sum(executable_signal_rows_by_symbol)
  )) AS quote_valid_ratio,
  toString(minIf(
    if(
      executable_signal_rows_by_symbol = 0,
      0,
      spread_sane_signal_rows_by_symbol / executable_signal_rows_by_symbol
    ),
    raw_signal_rows_by_symbol > 0
  )) AS min_quote_valid_ratio_by_symbol_day,
  toString(max(max_executable_gap_seconds_by_symbol)) AS max_executable_gap_seconds
FROM
(
  SELECT
    trading_day,
    symbol,
    sum(toUInt64OrZero(toString(raw_signal_rows))) AS raw_signal_rows_by_symbol,
    sum(toUInt64OrZero(toString(executable_signal_rows))) AS executable_signal_rows_by_symbol,
    sum(toUInt64OrZero(toString(quote_sane_signal_rows))) AS quote_sane_signal_rows_by_symbol,
    sum(toUInt64OrZero(toString(spread_sane_signal_rows))) AS spread_sane_signal_rows_by_symbol,
    sum(toUInt64OrZero(toString(microbar_rows))) AS microbar_rows_by_symbol,
    max(toUInt64OrZero(toString(max_executable_gap_seconds))) AS max_executable_gap_seconds_by_symbol
  FROM
  (
    SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    count() AS raw_signal_rows,
    0 AS executable_signal_rows,
    0 AS quote_sane_signal_rows,
    0 AS spread_sane_signal_rows,
    0 AS microbar_rows,
    0 AS max_executable_gap_seconds
  FROM torghut.ta_signals
  {shared_where}
  GROUP BY trading_day, symbol
  UNION ALL
  SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    0 AS raw_signal_rows,
    count() AS executable_signal_rows,
    0 AS quote_sane_signal_rows,
    0 AS spread_sane_signal_rows,
    0 AS microbar_rows,
    0 AS max_executable_gap_seconds
  FROM torghut.ta_signals
  {executable_where}
  GROUP BY trading_day, symbol
  UNION ALL
  SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    0 AS raw_signal_rows,
    0 AS executable_signal_rows,
    count() AS quote_sane_signal_rows,
    0 AS spread_sane_signal_rows,
    0 AS microbar_rows,
    0 AS max_executable_gap_seconds
  FROM torghut.ta_signals
  {sane_quote_where}
  GROUP BY trading_day, symbol
  UNION ALL
  SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    0 AS raw_signal_rows,
    0 AS executable_signal_rows,
    0 AS quote_sane_signal_rows,
    count() AS spread_sane_signal_rows,
    0 AS microbar_rows,
    0 AS max_executable_gap_seconds
  FROM torghut.ta_signals
  {spread_sane_where}
  GROUP BY trading_day, symbol
  UNION ALL
  SELECT
    trading_day,
    symbol,
    0 AS raw_signal_rows,
    0 AS executable_signal_rows,
    0 AS quote_sane_signal_rows,
    0 AS spread_sane_signal_rows,
    0 AS microbar_rows,
    max(gap_seconds) AS max_executable_gap_seconds
  FROM
  (
    SELECT
      toDate(event_ts, 'UTC') AS trading_day,
      symbol,
      greatest(
        0,
        dateDiff(
          'second',
          lagInFrame(event_ts, 1, event_ts) OVER (
            PARTITION BY symbol, toDate(event_ts, 'UTC')
            ORDER BY event_ts
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ),
          event_ts
        )
      ) AS gap_seconds
    FROM torghut.ta_signals
    {spread_sane_where}
  )
  GROUP BY trading_day, symbol
  UNION ALL
  SELECT
    toDate(event_ts, 'UTC') AS trading_day,
    symbol,
    0 AS raw_signal_rows,
    0 AS executable_signal_rows,
    0 AS quote_sane_signal_rows,
    0 AS spread_sane_signal_rows,
    count() AS microbar_rows,
    0 AS max_executable_gap_seconds
  FROM torghut.ta_microbars
  {shared_where}
  GROUP BY trading_day, symbol
  )
  GROUP BY trading_day, symbol
)
GROUP BY trading_day
ORDER BY trading_day
FORMAT TSVRaw
""".strip()


def _parse_coverage_diagnostics(
    raw: str,
) -> dict[str, dict[str, Any]]:
    diagnostics: dict[str, dict[str, Any]] = {}
    reader = csv.reader(raw.splitlines(), delimiter="\t")
    for parts in reader:
        if len(parts) == 7:
            (
                trading_day,
                raw_signal_rows,
                executable_signal_rows,
                microbar_rows,
                raw_signal_symbol_count,
                executable_signal_symbol_count,
                microbar_symbol_count,
            ) = parts
            quote_sane_signal_rows = executable_signal_rows
            spread_sane_signal_rows = executable_signal_rows
            min_executable_rows_per_symbol_day = executable_signal_rows
            min_spread_sane_rows_per_symbol_day = executable_signal_rows
            quote_valid_ratio = "1"
            min_quote_valid_ratio_by_symbol_day = "1"
            max_executable_gap_seconds = "0"
        elif len(parts) == 14:
            (
                trading_day,
                raw_signal_rows,
                executable_signal_rows,
                quote_sane_signal_rows,
                spread_sane_signal_rows,
                microbar_rows,
                raw_signal_symbol_count,
                executable_signal_symbol_count,
                microbar_symbol_count,
                min_executable_rows_per_symbol_day,
                min_spread_sane_rows_per_symbol_day,
                quote_valid_ratio,
                min_quote_valid_ratio_by_symbol_day,
                max_executable_gap_seconds,
            ) = parts
        else:
            continue
        diagnostics[str(trading_day)] = {
            "raw_signal_rows": int(raw_signal_rows or 0),
            "executable_signal_rows": int(executable_signal_rows or 0),
            "quote_sane_signal_rows": int(quote_sane_signal_rows or 0),
            "spread_sane_signal_rows": int(spread_sane_signal_rows or 0),
            "microbar_rows": int(microbar_rows or 0),
            "raw_signal_symbol_count": int(raw_signal_symbol_count or 0),
            "executable_signal_symbol_count": int(executable_signal_symbol_count or 0),
            "microbar_symbol_count": int(microbar_symbol_count or 0),
            "min_executable_rows_per_symbol_day": int(
                min_executable_rows_per_symbol_day or 0
            ),
            "min_spread_sane_rows_per_symbol_day": int(
                min_spread_sane_rows_per_symbol_day or 0
            ),
            "quote_valid_ratio": str(quote_valid_ratio or "0"),
            "min_quote_valid_ratio_by_symbol_day": str(
                min_quote_valid_ratio_by_symbol_day or "0"
            ),
            "max_executable_gap_seconds": int(max_executable_gap_seconds or 0),
        }
    return diagnostics


def _is_complete_coverage_day(
    row: Mapping[str, Any],
    *,
    expected_symbol_count: int,
    min_executable_rows_per_symbol_day: int,
    min_quote_valid_ratio: Decimal,
    max_executable_gap_seconds: int,
) -> bool:
    if int(row.get("raw_signal_rows") or 0) <= 0:
        return False
    if int(row.get("executable_signal_rows") or 0) <= 0:
        return False
    if int(row.get("microbar_rows") or 0) <= 0:
        return False
    if int(row.get("quote_sane_signal_rows") or 0) <= 0:
        return False
    if int(row.get("spread_sane_signal_rows") or 0) <= 0:
        return False
    if (
        int(row.get("min_executable_rows_per_symbol_day") or 0)
        < min_executable_rows_per_symbol_day
    ):
        return False
    if (
        int(row.get("min_spread_sane_rows_per_symbol_day") or 0)
        < min_executable_rows_per_symbol_day
    ):
        return False
    if (
        Decimal(str(row.get("min_quote_valid_ratio_by_symbol_day") or "0"))
        < min_quote_valid_ratio
    ):
        return False
    if int(row.get("max_executable_gap_seconds") or 0) > max_executable_gap_seconds:
        return False
    if expected_symbol_count <= 0:
        return True
    return (
        int(row.get("raw_signal_symbol_count") or 0) >= expected_symbol_count
        and int(row.get("executable_signal_symbol_count") or 0) >= expected_symbol_count
        and int(row.get("microbar_symbol_count") or 0) >= expected_symbol_count
    )


def _latest_complete_window(
    diagnostics: Mapping[str, Any],
    *,
    min_days: int,
    expected_symbol_count: int,
    min_executable_rows_per_symbol_day: int,
    min_quote_valid_ratio: Decimal,
    max_executable_gap_seconds: int,
) -> tuple[date, date, tuple[str, ...]]:
    requested_days = tuple(
        str(day) for day in diagnostics.get("requested_trading_days") or ()
    )
    rows_by_day = (
        diagnostics.get("rows_by_trading_day")
        if isinstance(diagnostics.get("rows_by_trading_day"), Mapping)
        else {}
    )
    latest_run: list[str] = []
    runs: list[tuple[str, ...]] = []
    for day in requested_days:
        row = rows_by_day.get(day) if isinstance(rows_by_day, Mapping) else None
        if isinstance(row, Mapping) and _is_complete_coverage_day(
            row,
            expected_symbol_count=expected_symbol_count,
            min_executable_rows_per_symbol_day=min_executable_rows_per_symbol_day,
            min_quote_valid_ratio=min_quote_valid_ratio,
            max_executable_gap_seconds=max_executable_gap_seconds,
        ):
            latest_run.append(day)
            continue
        if latest_run:
            runs.append(tuple(latest_run))
            latest_run = []
    if latest_run:
        runs.append(tuple(latest_run))
    eligible = tuple(run for run in runs if len(run) >= max(1, min_days))
    if not eligible:
        raise ValueError(f"latest_complete_replay_window_missing:min_days={min_days}")
    selected = eligible[-1]
    return date.fromisoformat(selected[0]), date.fromisoformat(selected[-1]), selected


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
        max_spread_bps=Decimal(
            str(
                getattr(
                    args,
                    "max_coverage_spread_bps",
                    str(_DEFAULT_MAX_COVERAGE_SPREAD_BPS),
                )
            )
        ),
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
        "executable_day_policy": _executable_day_policy(args=args),
        "source_query_digest": build_source_query_digest(
            {
                "query_family": "torghut.ta_replay_source_coverage",
                "start_date": start_date,
                "end_date": end_date,
                "symbols": list(symbols),
                "executable_day_policy": _executable_day_policy(args=args),
            }
        ),
    }


def _write_diagnostics_payload(output_path: Path, payload: Mapping[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(dict(payload), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_coverage_diagnostics(
    *,
    output_path: Path,
    args: argparse.Namespace,
    symbols: tuple[str, ...],
    start_date: date,
    end_date: date,
    failure_reason: str | None = None,
    materialization_diagnostics: dict[str, Any] | None = None,
    precomputed_diagnostics: Mapping[str, Any] | None = None,
) -> None:
    diagnostics = dict(
        precomputed_diagnostics
        or _fetch_coverage_diagnostics(
            args=args,
            symbols=symbols,
            start_date=start_date,
            end_date=end_date,
        )
    )
    if failure_reason:
        diagnostics["materialization_failure_reason"] = failure_reason
    if materialization_diagnostics is not None:
        diagnostics["materialization_diagnostics"] = dict(materialization_diagnostics)
    _write_diagnostics_payload(output_path, diagnostics)


def _select_effective_window(
    *,
    args: argparse.Namespace,
    symbols: tuple[str, ...],
    requested_start_date: date,
    requested_end_date: date,
) -> tuple[date, date, dict[str, Any] | None]:
    min_days = max(0, int(getattr(args, "latest_complete_window_min_days", 0) or 0))
    if min_days <= 0:
        return requested_start_date, requested_end_date, None
    diagnostics = _fetch_coverage_diagnostics(
        args=args,
        symbols=symbols,
        start_date=requested_start_date,
        end_date=requested_end_date,
    )
    policy = _executable_day_policy(args=args)
    try:
        selected_start, selected_end, selected_days = _latest_complete_window(
            diagnostics,
            min_days=min_days,
            expected_symbol_count=len(symbols),
            min_executable_rows_per_symbol_day=int(
                policy["min_executable_rows_per_symbol_day"]
            ),
            min_quote_valid_ratio=Decimal(str(policy["min_quote_valid_ratio"])),
            max_executable_gap_seconds=int(policy["max_executable_gap_seconds"]),
        )
    except ValueError as exc:
        receipt = {
            "schema_version": "torghut.replay-latest-complete-window.v1",
            "status": "missing",
            "failure_reason": str(exc),
            "requested_start_date": requested_start_date.isoformat(),
            "requested_end_date": requested_end_date.isoformat(),
            "selected_trading_days": [],
            "min_days": min_days,
            "symbols": list(symbols),
            "source_coverage": diagnostics,
            "executable_day_policy": policy,
        }
        receipt_output = getattr(args, "latest_complete_window_receipt_output", None)
        if receipt_output:
            _write_diagnostics_payload(Path(receipt_output).resolve(), receipt)
        diagnostic_output = getattr(args, "coverage_diagnostic_output", None)
        if diagnostic_output:
            enriched = dict(diagnostics)
            enriched["latest_complete_window"] = {
                "schema_version": "torghut.replay-latest-complete-window-selection.v1",
                "status": "missing",
                "failure_reason": str(exc),
                "selected_trading_days": [],
                "min_days": min_days,
            }
            _write_diagnostics_payload(Path(diagnostic_output).resolve(), enriched)
        raise
    receipt = {
        "schema_version": "torghut.replay-latest-complete-window.v1",
        "status": "selected",
        "requested_start_date": requested_start_date.isoformat(),
        "requested_end_date": requested_end_date.isoformat(),
        "effective_start_date": selected_start.isoformat(),
        "effective_end_date": selected_end.isoformat(),
        "selected_trading_days": list(selected_days),
        "min_days": min_days,
        "symbols": list(symbols),
        "source_coverage": diagnostics,
        "executable_day_policy": policy,
    }
    receipt_output = getattr(args, "latest_complete_window_receipt_output", None)
    if receipt_output:
        _write_diagnostics_payload(Path(receipt_output).resolve(), receipt)
    diagnostic_output = getattr(args, "coverage_diagnostic_output", None)
    if diagnostic_output:
        enriched = dict(diagnostics)
        enriched["latest_complete_window"] = {
            "schema_version": "torghut.replay-latest-complete-window-selection.v1",
            "effective_start_date": selected_start.isoformat(),
            "effective_end_date": selected_end.isoformat(),
            "selected_trading_days": list(selected_days),
            "min_days": min_days,
        }
        _write_diagnostics_payload(Path(diagnostic_output).resolve(), enriched)
    return selected_start, selected_end, receipt


def main() -> int:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    symbols = _parse_symbols(str(args.symbols or ""))
    requested_start_date = date.fromisoformat(str(args.start_date))
    requested_end_date = date.fromisoformat(str(args.end_date))
    start_date, end_date, window_receipt = _select_effective_window(
        args=args,
        symbols=symbols,
        requested_start_date=requested_start_date,
        requested_end_date=requested_end_date,
    )
    source_query_digest = build_source_query_digest(
        _source_query_payload(args=args, symbols=symbols)
        | {
            "effective_start_date": start_date,
            "effective_end_date": end_date,
        }
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
                start_date=requested_start_date,
                end_date=requested_end_date,
                failure_reason=str(exc),
                materialization_diagnostics=exc.diagnostics,
            )
        raise
    diagnostic_output = getattr(args, "coverage_diagnostic_output", None)
    if diagnostic_output and window_receipt is None:
        _write_coverage_diagnostics(
            output_path=Path(diagnostic_output).resolve(),
            args=args,
            symbols=symbols,
            start_date=start_date,
            end_date=end_date,
        )
    if window_receipt is not None:
        manifest_payload = {
            "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
            "row_count": manifest.row_count,
            "content_sha256": manifest.content_sha256,
            "manifest_path": str(Path(manifest_path).resolve()),
            "tape_path": str(Path(args.output).resolve()),
        }
        window_receipt["materialized_manifest"] = manifest_payload
        receipt_output = getattr(args, "latest_complete_window_receipt_output", None)
        if receipt_output:
            _write_diagnostics_payload(Path(receipt_output).resolve(), window_receipt)
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
