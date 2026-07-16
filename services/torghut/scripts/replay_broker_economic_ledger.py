#!/usr/bin/env python3
"""Dry-run or explicitly publish one broker-economic ledger replay."""

from __future__ import annotations

import argparse
import json

from app.alpaca_client import TorghutAlpacaClient
from app.config import settings
from app.db import SessionLocal
from app.trading.broker_mutation_receipts import fingerprint_broker_endpoint
from app.trading.economic_ledger import (
    LedgerScope,
    publish_broker_economic_ledger,
    replay_broker_economic_ledger,
)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Replay immutable Alpaca REST economics with two independent reducers; "
            "publication requires the exact token emitted by a dry run."
        )
    )
    parser.add_argument(
        "--account-label",
        default=settings.trading_account_label,
        help="Exact configured broker account label.",
    )
    parser.add_argument(
        "--publish-token",
        help="Exact publish:<sha256> token from a prior dry run.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    client = TorghutAlpacaClient()
    if client.endpoint_class != "paper":
        raise RuntimeError("economic_ledger_replay_requires_paper_endpoint")
    scope = LedgerScope(
        provider="alpaca",
        environment=client.endpoint_class,
        account_label=str(args.account_label),
        endpoint_fingerprint=fingerprint_broker_endpoint(client.endpoint_url),
    )
    with SessionLocal() as session, session.begin():
        replay = replay_broker_economic_ledger(session, scope=scope)
        published = (
            publish_broker_economic_ledger(
                session,
                replay,
                confirmation_token=str(args.publish_token),
            )
            if args.publish_token is not None
            else None
        )
        payload = replay.to_payload(published=published)
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
