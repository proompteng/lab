#!/usr/bin/env python3
"""Build a non-promotional runtime-window plan from exact replay ledgers."""

from __future__ import annotations

import argparse
import glob
import json
from decimal import Decimal
from pathlib import Path

from app.trading.discovery.replay_ledger_ranker import (
    default_replay_ledger_ranking_policy,
)
from app.trading.discovery.replay_runtime_window_plan import (
    build_replay_runtime_window_handoff,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Rank exact replay ledgers and emit a candidate-board/runtime-window "
            "handoff plan. The output is evidence collection only and never "
            "authorizes promotion."
        ),
    )
    parser.add_argument("ledger_paths", nargs="*", type=Path)
    parser.add_argument("--ledger-glob", action="append", default=[])
    parser.add_argument("--frontier-result", type=Path, default=None)
    parser.add_argument("--hypothesis-id", required=True)
    parser.add_argument("--source-manifest-ref", required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--strategy-family", default="")
    parser.add_argument("--strategy-name", default="")
    parser.add_argument("--account-label", default="TORGHUT_REPLAY")
    parser.add_argument("--observed-stage", choices=("paper", "live"), default="paper")
    parser.add_argument(
        "--source-kind", default="simulation_exact_replay_runtime_ledger"
    )
    parser.add_argument("--dataset-snapshot-ref", default="")
    parser.add_argument("--target-net-pnl-per-day", default="500")
    parser.add_argument("--start-equity", default="")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--output", type=Path, default=None)
    return parser.parse_args()


def _paths(args: argparse.Namespace) -> list[Path]:
    paths = list(args.ledger_paths)
    for pattern in args.ledger_glob:
        paths.extend(Path(item) for item in glob.glob(str(pattern), recursive=True))
    return paths


def _frontier_payload(path: Path | None) -> dict[str, object]:
    if path is None:
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"frontier_result_invalid:{path}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"frontier_result_invalid:{path}")
    return {str(key): value for key, value in payload.items()}


def main() -> int:
    args = _parse_args()
    paths = _paths(args)
    if not paths:
        raise SystemExit("provide at least one ledger path or --ledger-glob")
    start_equity = (
        Decimal(args.start_equity) if str(args.start_equity).strip() else None
    )
    policy = default_replay_ledger_ranking_policy(
        target_net_pnl_per_day=Decimal(str(args.target_net_pnl_per_day)),
        start_equity=start_equity,
    )
    report = build_replay_runtime_window_handoff(
        ledger_paths=paths,
        policy=policy,
        hypothesis_id=args.hypothesis_id,
        source_manifest_ref=args.source_manifest_ref,
        run_id=args.run_id,
        frontier_payload=_frontier_payload(args.frontier_result),
        strategy_family=args.strategy_family,
        strategy_name=args.strategy_name,
        account_label=args.account_label,
        observed_stage=args.observed_stage,
        source_kind=args.source_kind,
        dataset_snapshot_ref=args.dataset_snapshot_ref,
        limit=args.limit,
    )
    payload = json.dumps(report, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
