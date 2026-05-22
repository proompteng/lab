#!/usr/bin/env python3
"""Materialize a manifest-verified replay tape from ClickHouse PT1S signals."""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.trading.discovery.replay_tape import (
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
        flatten_eod=True,
        start_equity=Decimal(str(args.start_equity)),
        symbols=symbols,
    )
    rows = tuple(replay_mod._iter_signal_rows(config))
    manifest_path = args.manifest_output or default_manifest_path(args.output)
    manifest = materialize_signal_tape(
        rows=rows,
        tape_path=Path(args.output).resolve(),
        manifest_path=Path(manifest_path).resolve(),
        dataset_snapshot_ref=str(args.dataset_snapshot_ref),
        symbols=symbols,
        start_date=start_date,
        end_date=end_date,
        source_query_digest=source_query_digest,
        source_table_versions=_parse_source_table_versions(args.source_table_version),
        require_complete_coverage=not bool(args.allow_incomplete_coverage),
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
