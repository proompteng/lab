#!/usr/bin/env python3
"""Dry-run or explicitly publish one broker-economic ledger replay."""

from __future__ import annotations

import argparse
import json
import sys
import time

from app.alpaca_client import TorghutAlpacaClient
from app.api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST
from app.config import settings
from app.db import SessionLocal
from app.trading.broker_mutation_receipts import fingerprint_broker_endpoint
from app.trading.economic_ledger import (
    DEFAULT_SOURCE_MAX_AGE_SECONDS,
    BrokerEconomicLedgerReplay,
    BrokerEconomicReconciliationBuild,
    EconomicLedgerError,
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


_SOURCE_CONSISTENCY_RETRY_REASONS = frozenset(
    {
        "economic_ledger_option_contract_sizes_changed",
        "economic_ledger_source_cursor_incomplete",
        "economic_ledger_source_rows_changed",
        "economic_ledger_source_watermark_changed",
    }
)
_SOURCE_CONSISTENCY_RETRY_DELAY_SECONDS = 5.0


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
    parser.add_argument(
        "--source-consistency-timeout-seconds",
        type=int,
        default=0,
        help=(
            "With --observe, retry the complete observation when a concurrent "
            "source scan changes or temporarily opens the source snapshot."
        ),
    )
    args = parser.parse_args(argv)
    if args.tigerbeetle_parity and not args.observe:
        parser.error("--tigerbeetle-parity requires --observe")
    if args.source_consistency_timeout_seconds < 0:
        parser.error("--source-consistency-timeout-seconds must be non-negative")
    if args.source_consistency_timeout_seconds > 0 and not args.observe:
        parser.error("--source-consistency-timeout-seconds requires --observe")
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


def _execute_attempt(
    args: argparse.Namespace,
    *,
    broker_client: TorghutAlpacaClient,
    scope: LedgerScope,
) -> tuple[dict[str, object], int]:
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
    exit_code = (
        1 if tigerbeetle_parity is not None and not tigerbeetle_parity.parity else 0
    )
    return payload, exit_code


def _execute_with_source_consistency_retry(
    args: argparse.Namespace,
    *,
    broker_client: TorghutAlpacaClient,
    scope: LedgerScope,
) -> tuple[dict[str, object], int]:
    deadline = time.monotonic() + args.source_consistency_timeout_seconds
    attempt = 1
    while True:
        try:
            return _execute_attempt(args, broker_client=broker_client, scope=scope)
        except EconomicLedgerError as exc:
            reason = str(exc)
            remaining_seconds = deadline - time.monotonic()
            if (
                reason not in _SOURCE_CONSISTENCY_RETRY_REASONS
                or remaining_seconds <= 0
            ):
                raise
            delay_seconds = min(
                _SOURCE_CONSISTENCY_RETRY_DELAY_SECONDS,
                remaining_seconds,
            )
            print(
                json.dumps(
                    {
                        "attempt": attempt,
                        "delay_seconds": delay_seconds,
                        "reason": reason,
                        "schema_version": (
                            "torghut.broker-economic-source-retry-log.v1"
                        ),
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                file=sys.stderr,
                flush=True,
            )
            time.sleep(delay_seconds)
            attempt += 1


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
    payload, exit_code = _execute_with_source_consistency_retry(
        args,
        broker_client=broker_client,
        scope=scope,
    )
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
