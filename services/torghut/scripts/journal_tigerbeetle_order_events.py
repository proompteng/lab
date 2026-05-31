#!/usr/bin/env python3
"""Journal existing order-feed events into TigerBeetle and persist reconciliation."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.models import ExecutionOrderEvent, TigerBeetleTransferRef
from app.trading.tigerbeetle_journal import (
    TigerBeetleLedgerJournal,
    build_order_event_transfer_plan,
)
from app.trading.tigerbeetle_reconcile import reconcile_tigerbeetle_transfers


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Journal unlinked Torghut order-feed lifecycle events into TigerBeetle.",
    )
    parser.add_argument("--dsn-env", default="DB_DSN")
    parser.add_argument("--account-label", default=None)
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--max-batches", type=int, default=1)
    parser.add_argument("--reconcile-limit", type=int, default=1000)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _select_unlinked_events(
    session: Any,
    *,
    settings_obj: Settings,
    account_label: str | None,
    limit: int,
) -> list[ExecutionOrderEvent]:
    linked_ref = (
        select(TigerBeetleTransferRef.id)
        .where(
            TigerBeetleTransferRef.cluster_id == settings_obj.tigerbeetle_cluster_id,
            TigerBeetleTransferRef.execution_order_event_id == ExecutionOrderEvent.id,
        )
        .exists()
    )
    stmt = (
        select(ExecutionOrderEvent)
        .where(~linked_ref)
        .order_by(
            ExecutionOrderEvent.event_ts.asc().nullsfirst(),
            ExecutionOrderEvent.feed_seq.asc().nullsfirst(),
            ExecutionOrderEvent.created_at.asc(),
        )
    )
    if account_label:
        stmt = stmt.where(ExecutionOrderEvent.alpaca_account_label == account_label)
    scan_limit = max(limit, min(limit * 20, 10000))
    candidates = session.execute(stmt.limit(scan_limit)).scalars().all()
    return [
        event
        for event in candidates
        if build_order_event_transfer_plan(
            session,
            event,
            settings_obj=settings_obj,
        )
        is not None
    ][:limit]


def _payload(
    *,
    args: argparse.Namespace,
    started_at: datetime,
    batches: list[dict[str, int]],
    reconciliation: dict[str, object] | None,
) -> dict[str, Any]:
    selected = sum(batch["selected"] for batch in batches)
    journaled = sum(batch["journaled"] for batch in batches)
    skipped = sum(batch["skipped"] for batch in batches)
    failed = sum(batch["failed"] for batch in batches)
    return {
        "status": "ok" if failed == 0 else "degraded",
        "dry_run": bool(args.dry_run),
        "dsn_env": args.dsn_env,
        "account_label": args.account_label,
        "batch_size": max(1, min(int(args.batch_size), 5000)),
        "max_batches": max(1, int(args.max_batches)),
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "selected": selected,
        "journaled": journaled,
        "skipped": skipped,
        "failed": failed,
        "batches": batches,
        "reconciliation": reconciliation,
    }


def main() -> int:
    args = _parse_args()
    dsn = os.environ.get(str(args.dsn_env).strip())
    if not dsn:
        raise SystemExit(f"missing DSN env var: {args.dsn_env}")

    started_at = datetime.now(timezone.utc)
    batch_size = max(1, min(int(args.batch_size), 5000))
    max_batches = max(1, int(args.max_batches))
    settings_obj = Settings(
        DB_DSN=dsn,
        TORGHUT_TIGERBEETLE_ENABLED=True,
        TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
    )
    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    session_factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )
    batches: list[dict[str, int]] = []
    reconciliation: dict[str, object] | None = None

    with session_factory() as session:
        journal = TigerBeetleLedgerJournal(settings_obj=settings_obj)
        for _ in range(max_batches):
            events = _select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label=args.account_label,
                limit=batch_size,
            )
            batch = {"selected": len(events), "journaled": 0, "skipped": 0, "failed": 0}
            for event in events:
                try:
                    if args.dry_run:
                        batch["journaled"] += 1
                        continue
                    with session.begin_nested():
                        ref = journal.journal_order_event(session, event)
                    if ref is None and not args.dry_run:
                        batch["skipped"] += 1
                    else:
                        batch["journaled"] += 1
                except Exception:
                    batch["failed"] += 1
            batches.append(batch)
            if args.dry_run:
                session.rollback()
                break
            session.commit()
            if len(events) < batch_size:
                break

        if not args.dry_run:
            reconciliation = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=settings_obj,
                limit=max(1, int(args.reconcile_limit)),
                persist=True,
            )
            session.commit()

    payload = _payload(
        args=args,
        started_at=started_at,
        batches=batches,
        reconciliation=reconciliation,
    )
    print(
        json.dumps(payload, separators=(",", ":"))
        if args.json
        else json.dumps(payload, indent=2)
    )
    return 0 if payload["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
