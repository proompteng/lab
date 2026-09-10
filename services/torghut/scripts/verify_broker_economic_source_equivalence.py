#!/usr/bin/env python3
"""Compare immutable broker stream and REST fill evidence over one window."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.trading.broker_account_activities import compare_broker_fill_sources


SessionFactory = Callable[[], Session]


def _aware_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Prove that broker trade-update streaming and paginated account-"
            "activity backfill yield the same immutable fill multiset."
        )
    )
    parser.add_argument("--account-label", default=settings.trading_account_label)
    parser.add_argument("--environment", default=settings.trading_mode)
    parser.add_argument("--window-start", required=True, type=_aware_datetime)
    parser.add_argument("--window-end", required=True, type=_aware_datetime)
    parser.add_argument(
        "--require-proof",
        action="store_true",
        help="Exit non-zero unless both sources contain matching nonempty evidence.",
    )
    return parser.parse_args()


def run_proof(
    args: argparse.Namespace,
    *,
    session_factory: SessionFactory = SessionLocal,
) -> dict[str, object]:
    with session_factory() as session:
        return compare_broker_fill_sources(
            session,
            account_label=str(args.account_label),
            environment=str(args.environment),
            window_start=args.window_start,
            window_end=args.window_end,
        )


def main() -> int:
    args = _parse_args()
    payload = run_proof(args)
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    if args.require_proof and not payload["proof_complete"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
