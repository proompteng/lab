from __future__ import annotations

import argparse
import os
from pathlib import Path

from app.trading.economic_policy import DEFAULT_ECONOMIC_POLICY_PATH

from .replay_types import (
    DEFAULT_CHUNK_MINUTES,
    DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
    DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS,
    DEFAULT_START_EQUITY,
    default_strategy_configmap_path,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay intraday TSMOM over a week of ClickHouse `ta_signals`.",
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=default_strategy_configmap_path(),
    )
    parser.add_argument(
        "--economic-policy",
        type=Path,
        default=Path(
            os.environ.get(
                "TRADING_ECONOMIC_POLICY_PATH", str(DEFAULT_ECONOMIC_POLICY_PATH)
            )
        ),
        help="Immutable economic policy shared with shadow, paper, and live execution.",
    )
    parser.add_argument(
        "--economic-policy-expected-digest",
        default=os.environ.get("TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST"),
        help="Expected sha256 digest for the immutable economic policy.",
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
    parser.add_argument("--start-date", default="2026-03-23")
    parser.add_argument("--end-date", default="2026-03-27")
    parser.add_argument("--chunk-minutes", type=int, default=DEFAULT_CHUNK_MINUTES)
    parser.add_argument(
        "--clickhouse-query-timeout-seconds",
        type=int,
        default=int(
            os.environ.get(
                "TA_CLICKHOUSE_QUERY_TIMEOUT_SECONDS",
                str(DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS),
            )
        ),
        help="Per ClickHouse HTTP or kubectl query timeout. Keeps bounded refreshes from hanging.",
    )
    parser.add_argument("--start-equity", default=str(DEFAULT_START_EQUITY))
    parser.add_argument(
        "--symbols",
        default="",
        help="Optional comma-separated symbol filter applied in the ClickHouse query.",
    )
    parser.add_argument(
        "--replay-tape-path",
        type=Path,
        help="Optional manifest-verified replay tape JSONL/JSONL.GZ to use instead of ClickHouse reads.",
    )
    parser.add_argument(
        "--replay-tape-manifest",
        type=Path,
        help="Optional replay tape manifest path. Defaults to <replay-tape-path>.manifest.json.",
    )
    parser.add_argument(
        "--allow-stale-tape",
        action="store_true",
        help="Allow a replay tape whose manifest does not fully cover the requested date/symbol window.",
    )
    parser.add_argument(
        "--progress-log-seconds",
        type=int,
        default=DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS,
        help="Emit replay heartbeat logs at most once per this many seconds.",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("TORGHUT_REPLAY_LOG_LEVEL", "INFO"),
        help="Python logging level for replay progress logs.",
    )
    parser.add_argument(
        "--trace-output",
        type=Path,
        help="Optional path to write replay trace JSONL.",
    )
    parser.add_argument(
        "--funnel-output",
        type=Path,
        help="Optional path to write replay funnel JSON.",
    )
    parser.add_argument(
        "--near-misses-output",
        type=Path,
        help="Optional path to write replay near-miss JSON.",
    )
    parser.add_argument(
        "--exact-replay-ledger-output",
        type=Path,
        help="Optional path to write exact replay decision/order/fill ledger JSON.",
    )
    parser.add_argument(
        "--collect-traces",
        action="store_true",
        help="Capture per-strategy runtime traces and emit them in payload trace output.",
    )
    parser.add_argument(
        "--collect-trace-funnel",
        action="store_true",
        help="Capture aggregate runtime gate funnel diagnostics without emitting per-row trace records.",
    )
    parser.add_argument("--no-flatten-eod", action="store_true")
    parser.add_argument(
        "--force-position-isolation",
        action="store_true",
        help="Own replay positions by strategy id even when runtime metadata omits isolation.",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()
