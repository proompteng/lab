#!/usr/bin/env python3
"""Backfill deterministic TigerBeetle stable refs in bounded PostgreSQL batches."""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.trading.tigerbeetle_journal import TigerBeetleLedgerJournal
from app.trading.tigerbeetle_reconcile import tigerbeetle_ref_counts


SCHEMA_VERSION = "torghut.tigerbeetle-stable-ref-backfill.v1"
MAX_BATCH_SIZE = 5_000


@dataclass(frozen=True)
class _BatchSummary:
    results: tuple[dict[str, int], ...]
    selected_count: int
    updated_count: int


@dataclass(frozen=True)
class _VerificationSummary:
    missing_count: int
    mismatch_count: int
    stable_ref_count: int
    transfer_ref_count: int


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill deterministic stable-ref payloads without writing to "
            "TigerBeetle or changing source rows."
        )
    )
    parser.add_argument("--dsn-env", default="DB_DSN")
    parser.add_argument("--batch-size", type=int, default=1_000)
    parser.add_argument("--max-batches", type=int, default=25)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit each bounded PostgreSQL batch; the default is a rolled-back preview.",
    )
    parser.add_argument(
        "--require-complete",
        action="store_true",
        help="Exit nonzero unless the full stable-ref scan has zero missing or mismatched refs.",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= int(args.batch_size) <= MAX_BATCH_SIZE:
        parser.error(f"--batch-size must be between 1 and {MAX_BATCH_SIZE}")
    if not 1 <= int(args.max_batches) <= 1_000:
        parser.error("--max-batches must be between 1 and 1000")
    if bool(args.require_complete) and not bool(args.apply):
        parser.error("--require-complete requires --apply")
    return args


def _result_int(result: Mapping[str, object], key: str) -> int:
    value = result.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RuntimeError(f"tigerbeetle_stable_ref_backfill_{key}_invalid")
    return value


def _run_batches(
    session: Session,
    journal: TigerBeetleLedgerJournal,
    *,
    batch_size: int,
    max_batches: int,
    apply: bool,
) -> _BatchSummary:
    batch_results: list[dict[str, int]] = []
    selected_total = 0
    updated_total = 0
    for batch_index in range(max_batches):
        raw_result = journal.backfill_stable_ref_payloads(session, limit=batch_size)
        selected = _result_int(raw_result, "selected")
        updated = _result_int(raw_result, "updated")
        skipped = _result_int(raw_result, "skipped")
        if skipped or selected != updated:
            raise RuntimeError("tigerbeetle_stable_ref_backfill_batch_incomplete")
        batch_results.append(
            {
                "batch": batch_index + 1,
                "selected": selected,
                "updated": updated,
            }
        )
        selected_total += selected
        updated_total += updated

        if not apply:
            session.rollback()
            session.expire_all()
            break
        session.commit()
        if selected < batch_size:
            break
    return _BatchSummary(
        results=tuple(batch_results),
        selected_count=selected_total,
        updated_count=updated_total,
    )


def _verify_full_scan(
    session: Session,
    journal: TigerBeetleLedgerJournal,
) -> _VerificationSummary:
    verification = tigerbeetle_ref_counts(
        session,
        cluster_id=journal.cluster_id,
        full_ref_scan=True,
    )
    return _VerificationSummary(
        missing_count=_result_int(verification, "stable_ref_missing_count"),
        mismatch_count=_result_int(verification, "stable_ref_mismatch_count"),
        stable_ref_count=_result_int(verification, "stable_ref_count"),
        transfer_ref_count=_result_int(verification, "transfer_ref_count"),
    )


def run_stable_ref_backfill(
    session: Session,
    journal: TigerBeetleLedgerJournal,
    *,
    batch_size: int,
    max_batches: int,
    apply: bool,
) -> dict[str, object]:
    """Preview or persist a bounded stable-ref repair and verify the full result."""

    missing_before = journal.count_missing_stable_ref_payloads(session)
    batch_summary = _run_batches(
        session,
        journal,
        batch_size=batch_size,
        max_batches=max_batches,
        apply=apply,
    )
    verification = _verify_full_scan(session, journal)
    complete = (
        apply and verification.missing_count == 0 and verification.mismatch_count == 0
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "cluster_id": journal.cluster_id,
        "apply": apply,
        "complete": complete,
        "missing_before": missing_before,
        "missing_after": verification.missing_count,
        "stable_ref_mismatch_count": verification.mismatch_count,
        "stable_ref_count": verification.stable_ref_count,
        "transfer_ref_count": verification.transfer_ref_count,
        "selected_count": batch_summary.selected_count,
        "postgres_rows_updated": batch_summary.updated_count if apply else 0,
        "postgres_rows_would_update": batch_summary.updated_count if not apply else 0,
        "tigerbeetle_writes": 0,
        "capital_authority": False,
        "promotion_authority": False,
        "batches": list(batch_summary.results),
    }


def _print_payload(payload: Mapping[str, object], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        return
    print(
        "TigerBeetle stable-ref backfill "
        f"apply={payload['apply']} complete={payload['complete']} "
        f"missing_before={payload['missing_before']} "
        f"missing_after={payload['missing_after']} "
        f"updated={payload['postgres_rows_updated']}"
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    dsn_env = str(args.dsn_env).strip()
    dsn = os.environ.get(dsn_env)
    if not dsn:
        raise SystemExit(f"missing DSN env var: {dsn_env}")

    settings_obj = Settings(
        DB_DSN=dsn,
        TORGHUT_TIGERBEETLE_ENABLED=True,
        TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
    )
    engine = create_engine(settings_obj.sqlalchemy_dsn, pool_pre_ping=True, future=True)
    session_factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        with (
            session_factory() as session,
            TigerBeetleLedgerJournal(settings_obj=settings_obj) as journal,
        ):
            payload = run_stable_ref_backfill(
                session,
                journal,
                batch_size=int(args.batch_size),
                max_batches=int(args.max_batches),
                apply=bool(args.apply),
            )
    finally:
        engine.dispose()

    _print_payload(payload, as_json=bool(args.json))
    if bool(args.require_complete) and payload["complete"] is not True:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
