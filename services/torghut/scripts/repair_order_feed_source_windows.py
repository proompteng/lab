#!/usr/bin/env python3
"""Repair source-window lineage for persisted order-feed events."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.trading.order_feed import (
    backfill_order_feed_source_windows,
    repair_order_feed_execution_links,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Attach non-cursor-authoritative source-window rows to existing order-feed events.",
    )
    parser.add_argument("--dsn-env", default="DB_DSN")
    parser.add_argument("--account-label", default=None)
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--max-batches", type=int, default=1)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit repaired source-window links. Default is dry-run.",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _payload(
    *,
    args: argparse.Namespace,
    started_at: datetime,
    batches: list[dict[str, int]],
) -> dict[str, Any]:
    totals = {
        "selected": sum(batch["selected"] for batch in batches),
        "source_windows_created": sum(
            batch["source_windows_created"] for batch in batches
        ),
        "source_windows_reused": sum(
            batch["source_windows_reused"] for batch in batches
        ),
        "events_linked": sum(batch["events_linked"] for batch in batches),
        "execution_link_candidates": sum(
            batch["execution_link_candidates"] for batch in batches
        ),
        "execution_link_executions_matched": sum(
            batch["execution_link_executions_matched"] for batch in batches
        ),
        "execution_link_executions_linked": sum(
            batch["execution_link_executions_linked"] for batch in batches
        ),
        "execution_link_events_linked": sum(
            batch["execution_link_events_linked"] for batch in batches
        ),
        "execution_link_events_without_execution": sum(
            batch["execution_link_events_without_execution"] for batch in batches
        ),
    }
    return {
        "status": "ok",
        "apply": bool(args.apply),
        "dsn_env": args.dsn_env,
        "account_label": args.account_label,
        "batch_size": max(1, min(int(args.batch_size), 5000)),
        "max_batches": max(1, int(args.max_batches)),
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        **totals,
        "batches": batches,
    }


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _reset_session_identity_map(session: Any) -> None:
    expunge_all = getattr(session, "expunge_all", None)
    if callable(expunge_all):
        expunge_all()


def main() -> int:
    args = _parse_args()
    dsn = os.environ.get(str(args.dsn_env).strip())
    if not dsn:
        raise SystemExit(f"missing DSN env var: {args.dsn_env}")

    started_at = datetime.now(timezone.utc)
    batch_size = max(1, min(int(args.batch_size), 5000))
    max_batches = max(1, int(args.max_batches))
    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    session_factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )
    batches: list[dict[str, int]] = []
    with session_factory() as session:
        for _ in range(max_batches):
            source_window_batch = backfill_order_feed_source_windows(
                session,
                account_label=args.account_label,
                limit=batch_size,
            )
            execution_link_batch = repair_order_feed_execution_links(
                session,
                account_label=args.account_label,
                limit=batch_size,
            )
            batch = {
                **source_window_batch,
                "execution_link_candidates": execution_link_batch["selected"],
                "execution_link_executions_matched": execution_link_batch[
                    "executions_matched"
                ],
                "execution_link_executions_linked": execution_link_batch[
                    "executions_linked"
                ],
                "execution_link_events_linked": execution_link_batch["events_linked"],
                "execution_link_events_without_execution": execution_link_batch[
                    "events_without_execution"
                ],
            }
            batches.append(batch)
            if args.apply:
                session.commit()
                _reset_session_identity_map(session)
            else:
                session.rollback()
                _reset_session_identity_map(session)
                break
            if (
                int(source_window_batch.get("selected") or 0) < batch_size
                and int(execution_link_batch.get("selected") or 0) < batch_size
            ):
                break

    payload = _payload(args=args, started_at=started_at, batches=batches)
    print(
        json.dumps(payload, separators=(",", ":"))
        if args.json
        else json.dumps(payload, indent=2, default=str)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
