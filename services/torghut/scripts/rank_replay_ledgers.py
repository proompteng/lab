#!/usr/bin/env python3
"""Rank exact replay ledger artifacts without granting promotion authority."""

from __future__ import annotations

import argparse
import glob
import json
from decimal import Decimal
from pathlib import Path

from app.trading.discovery.replay_ledger_ranker import (
    build_replay_ledger_ranking_report,
    default_replay_ledger_ranking_policy,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Rank exact replay ledger artifacts using runtime-ledger PnL semantics. "
            "This is evidence triage only and does not promote candidates."
        ),
    )
    parser.add_argument("ledger_paths", nargs="*", type=Path)
    parser.add_argument(
        "--ledger-glob",
        action="append",
        default=[],
        help="Glob for exact replay ledger JSON artifacts; can be repeated.",
    )
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--target-net-pnl-per-day", default="500")
    parser.add_argument("--start-equity", default="")
    return parser.parse_args()


def _paths(args: argparse.Namespace) -> list[Path]:
    paths = list(args.ledger_paths)
    for pattern in args.ledger_glob:
        paths.extend(Path(item) for item in glob.glob(str(pattern), recursive=True))
    return paths


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
    report = build_replay_ledger_ranking_report(
        paths,
        policy=policy,
        limit=args.limit,
    )
    payload = json.dumps(report, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
