from __future__ import annotations

import json
import logging
from datetime import date
from decimal import Decimal
from pathlib import Path

from app.trading.economic_policy import DEFAULT_ECONOMIC_POLICY_PATH

from .cli_args import _parse_args
from .replay_loop import run_replay
from .replay_types import (
    DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
    ReplayConfig,
)


def main() -> None:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logging.getLogger("alembic").setLevel(logging.WARNING)
    config = ReplayConfig(
        strategy_configmap_path=Path(args.strategy_configmap).resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        start_date=date.fromisoformat(args.start_date),
        end_date=date.fromisoformat(args.end_date),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        flatten_eod=not args.no_flatten_eod,
        start_equity=Decimal(str(args.start_equity)),
        economic_policy_path=Path(
            getattr(args, "economic_policy", DEFAULT_ECONOMIC_POLICY_PATH)
        ).resolve(),
        economic_policy_expected_digest=(
            str(getattr(args, "economic_policy_expected_digest", "") or "").strip()
            or None
        ),
        symbols=tuple(
            symbol.strip().upper()
            for symbol in str(args.symbols or "").split(",")
            if symbol.strip()
        ),
        replay_tape_path=(
            Path(replay_tape_path).resolve()
            if (replay_tape_path := getattr(args, "replay_tape_path", None)) is not None
            else None
        ),
        replay_tape_manifest_path=(
            Path(replay_tape_manifest).resolve()
            if (replay_tape_manifest := getattr(args, "replay_tape_manifest", None))
            is not None
            else None
        ),
        allow_stale_tape=bool(getattr(args, "allow_stale_tape", False)),
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
        capture_traces=(
            bool(getattr(args, "collect_traces", False))
            or args.trace_output is not None
            or args.funnel_output is not None
            or args.near_misses_output is not None
        ),
        capture_trace_funnel=bool(getattr(args, "collect_trace_funnel", False)),
        capture_exact_replay_ledger=(
            getattr(args, "exact_replay_ledger_output", None) is not None
        ),
        force_position_isolation=bool(getattr(args, "force_position_isolation", False)),
        clickhouse_query_timeout_seconds=max(
            1,
            int(
                getattr(
                    args,
                    "clickhouse_query_timeout_seconds",
                    DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
                )
            ),
        ),
    )
    payload = run_replay(config)
    if args.trace_output:
        args.trace_output.write_text(
            "".join(
                json.dumps(item, sort_keys=True) + "\n" for item in payload["trace"]
            ),
            encoding="utf-8",
        )
    if args.funnel_output:
        args.funnel_output.write_text(
            json.dumps(payload["funnel"], indent=2, sort_keys=True),
            encoding="utf-8",
        )
    if args.near_misses_output:
        args.near_misses_output.write_text(
            json.dumps(payload["near_misses"], indent=2, sort_keys=True),
            encoding="utf-8",
        )
    exact_replay_ledger_output = getattr(args, "exact_replay_ledger_output", None)
    if exact_replay_ledger_output is not None:
        exact_replay_ledger_output.write_text(
            json.dumps(payload["exact_replay_ledger"], indent=2, sort_keys=True),
            encoding="utf-8",
        )
    if args.json:
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        return
    print(json.dumps(payload, indent=2, sort_keys=True))
