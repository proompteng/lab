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
    BrokerEconomicLedgerReplay,
    BrokerEconomicReconciliationBuild,
    LedgerScope,
    PersistedBrokerEconomicReconciliation,
    TigerBeetleEconomicParityObservation,
    audit_broker_economic_tigerbeetle_parity,
    capture_broker_economic_snapshot,
    load_broker_economic_ledger_source_rows,
    persist_broker_economic_ledger_reconciliation,
    prepare_broker_economic_ledger_snapshot,
    publish_broker_economic_ledger,
    require_published_broker_economic_ledger_runs,
    replay_broker_economic_ledger_snapshot,
)
from app.trading.tigerbeetle_client import create_tigerbeetle_client


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
    parser.add_argument(
        "--tigerbeetle-parity",
        action="store_true",
        help=(
            "With --observe, materialize missing immutable journal chains and "
            "require exact full TigerBeetle parity."
        ),
    )
    args = parser.parse_args(argv)
    if args.tigerbeetle_parity and not args.observe:
        parser.error("--tigerbeetle-parity requires --observe")
    return args


def _observation_output(
    replay: BrokerEconomicLedgerReplay,
    observation: PersistedBrokerEconomicReconciliation,
) -> dict[str, object]:
    result_payload = observation.result.payload
    journal = replay.reduction.journal
    runs = observation.runs
    return {
        "schema_version": "torghut.broker-economic-observation-log.v1",
        "input": {
            "count": replay.snapshot.prepared.input_count,
            "manifest_sha256": replay.snapshot.prepared.manifest_digest,
            "watermark": replay.snapshot.source_watermark.isoformat(),
        },
        "journal": {
            "entry_count": sum(len(item.lines) for item in journal.transactions),
            "journal_sha256": journal.journal_digest,
            "reducer_version": journal.projection.reducer_version,
            "transaction_count": len(journal.transactions),
        },
        "publication": {
            "input_id": str(runs.input_id),
            "journal_run_id": str(runs.journal_run_id),
            "reused_existing": runs.reused_existing,
            "state_run_id": str(runs.state_run_id),
        },
        "reconciliation": {
            "observation_id": str(observation.observation_id),
            "open_order_count": observation.result.open_order_count,
            "reason_codes": result_payload["reason_codes"],
            "reconciled": observation.result.reconciled,
            "residual_count": observation.result.residual_count,
            "result_sha256": observation.result.result_sha256,
            "source_age_seconds": observation.result.source_age_seconds,
            "tigerbeetle_economic_parity": result_payload.get(
                "tigerbeetle_economic_parity"
            ),
        },
    }


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    broker_client = TorghutAlpacaClient()
    if broker_client.endpoint_class != "paper":
        raise RuntimeError("economic_ledger_replay_requires_paper_endpoint")
    if args.observe and (BUILD_COMMIT == "unknown" or BUILD_IMAGE_DIGEST is None):
        raise RuntimeError("economic_ledger_observation_build_identity_missing")
    scope = LedgerScope(
        provider="alpaca",
        environment=broker_client.endpoint_class,
        account_label=str(args.account_label),
        endpoint_fingerprint=fingerprint_broker_endpoint(broker_client.endpoint_url),
    )
    with SessionLocal() as session, session.begin():
        source_rows = load_broker_economic_ledger_source_rows(session, scope=scope)
    ledger_snapshot = prepare_broker_economic_ledger_snapshot(source_rows)
    replay = replay_broker_economic_ledger_snapshot(ledger_snapshot)
    snapshot = capture_broker_economic_snapshot(broker_client) if args.observe else None
    tigerbeetle_parity = None
    if args.tigerbeetle_parity:
        if not settings.tigerbeetle_enabled:
            raise RuntimeError("economic_ledger_tigerbeetle_parity_requires_enabled")
        assert snapshot is not None
        with SessionLocal() as session, session.begin():
            runs = require_published_broker_economic_ledger_runs(session, replay)
        tigerbeetle_client = create_tigerbeetle_client(settings)
        try:
            tigerbeetle_parity = audit_broker_economic_tigerbeetle_parity(
                tigerbeetle_client,
                replay,
                runs=runs,
                observation=TigerBeetleEconomicParityObservation(
                    cluster_id=settings.tigerbeetle_cluster_id,
                    observed_at=snapshot.observed_at,
                    max_source_age_seconds=args.max_source_age_seconds,
                ),
            )
        finally:
            tigerbeetle_client.close()
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
                    tigerbeetle_parity=tigerbeetle_parity,
                )
                if snapshot is not None
                else None
            )
    if observation is not None:
        payload = _observation_output(replay, observation)
    else:
        payload = replay.to_payload(published=published)
        payload["reconciliation"] = None
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 1 if tigerbeetle_parity is not None and not tigerbeetle_parity.parity else 0


if __name__ == "__main__":
    raise SystemExit(main())
