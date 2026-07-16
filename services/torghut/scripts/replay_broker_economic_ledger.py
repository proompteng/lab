#!/usr/bin/env python3
"""Dry-run or explicitly publish one broker-economic ledger replay."""

from __future__ import annotations

import argparse
import json

from app.alpaca_client import TorghutAlpacaClient
from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST
from app.config import settings
from app.db import SessionLocal
from app.trading.broker_mutation_receipts import fingerprint_broker_endpoint
from app.trading.economic_ledger import (
    DEFAULT_SOURCE_MAX_AGE_SECONDS,
    BrokerEconomicReconciliationBuild,
    LedgerScope,
    capture_broker_economic_snapshot,
    load_broker_economic_ledger_source_rows,
    persist_broker_economic_ledger_reconciliation,
    prepare_broker_economic_ledger_snapshot,
    publish_broker_economic_ledger,
    replay_broker_economic_ledger_snapshot,
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
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--publish-token",
        help="Exact publish:<sha256> token from a prior dry run.",
    )
    mode.add_argument(
        "--observe",
        action="store_true",
        help=(
            "Append one fresh read-only broker reconciliation for an already "
            "published exact run pair; never publishes a new pair implicitly."
        ),
    )
    parser.add_argument(
        "--max-source-age-seconds",
        type=int,
        default=DEFAULT_SOURCE_MAX_AGE_SECONDS,
        help="Maximum closed-source age accepted by the reconciliation result.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    client = TorghutAlpacaClient()
    if client.endpoint_class != "paper":
        raise RuntimeError("economic_ledger_replay_requires_paper_endpoint")
    if args.observe and (BUILD_COMMIT == "unknown" or BUILD_IMAGE_DIGEST is None):
        raise RuntimeError("economic_ledger_observation_build_identity_missing")
    scope = LedgerScope(
        provider="alpaca",
        environment=client.endpoint_class,
        account_label=str(args.account_label),
        endpoint_fingerprint=fingerprint_broker_endpoint(client.endpoint_url),
    )
    snapshot = capture_broker_economic_snapshot(client) if args.observe else None
    with SessionLocal() as session, session.begin():
        source_rows = load_broker_economic_ledger_source_rows(session, scope=scope)
    ledger_snapshot = prepare_broker_economic_ledger_snapshot(source_rows)
    replay = replay_broker_economic_ledger_snapshot(ledger_snapshot)
    published = None
    observation = None
    if args.publish_token is not None or snapshot is not None:
        with SessionLocal() as session, session.begin():
            published = (
                publish_broker_economic_ledger(
                    session,
                    replay,
                    confirmation_token=str(args.publish_token),
                )
                if args.publish_token is not None
                else None
            )
            observation = (
                persist_broker_economic_ledger_reconciliation(
                    session,
                    replay,
                    snapshot,
                    build=BrokerEconomicReconciliationBuild(
                        source_commit=BUILD_COMMIT,
                        image_digest=BUILD_IMAGE_DIGEST or "",
                    ),
                    max_source_age_seconds=args.max_source_age_seconds,
                )
                if snapshot is not None
                else None
            )
    payload = replay.to_payload(
        published=published or (observation.runs if observation is not None else None)
    )
    payload["reconciliation"] = (
        {
            "observation_id": str(observation.observation_id),
            **observation.result.payload,
        }
        if observation is not None
        else None
    )
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
