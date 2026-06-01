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
    backfill_order_feed_events_from_executions,
    backfill_order_feed_source_windows,
    repair_order_feed_execution_links,
    repair_order_feed_fill_deltas,
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
        "--backfill-execution-events",
        action="store_true",
        help=(
            "Create non-cursor-authoritative execution_order_events/source windows "
            "from durable executions that predate order-feed persistence."
        ),
    )
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
        "execution_link_decisions_matched": sum(
            batch["execution_link_decisions_matched"] for batch in batches
        ),
        "execution_link_events_linked": sum(
            batch["execution_link_events_linked"] for batch in batches
        ),
        "execution_link_decision_events_linked": sum(
            batch["execution_link_decision_events_linked"] for batch in batches
        ),
        "execution_link_events_without_execution": sum(
            batch["execution_link_events_without_execution"] for batch in batches
        ),
        "execution_link_events_without_decision": sum(
            batch["execution_link_events_without_decision"] for batch in batches
        ),
        "execution_event_backfill_candidates": sum(
            batch["execution_event_backfill_candidates"] for batch in batches
        ),
        "execution_event_backfill_events_created": sum(
            batch["execution_event_backfill_events_created"] for batch in batches
        ),
        "execution_event_backfill_source_windows_created": sum(
            batch["execution_event_backfill_source_windows_created"]
            for batch in batches
        ),
        "execution_event_backfill_skipped_existing_event": sum(
            batch["execution_event_backfill_skipped_existing_event"]
            for batch in batches
        ),
        "execution_event_backfill_skipped_missing_trade_decision": sum(
            batch["execution_event_backfill_skipped_missing_trade_decision"]
            for batch in batches
        ),
        "execution_event_backfill_skipped_missing_order_identity": sum(
            batch["execution_event_backfill_skipped_missing_order_identity"]
            for batch in batches
        ),
        "execution_event_backfill_skipped_source_offset_collision": sum(
            batch["execution_event_backfill_skipped_source_offset_collision"]
            for batch in batches
        ),
        "fill_delta_candidates": sum(
            batch["fill_delta_candidates"] for batch in batches
        ),
        "fill_delta_events_repaired": sum(
            batch["fill_delta_events_repaired"] for batch in batches
        ),
        "fill_delta_non_increasing_events_marked": sum(
            batch["fill_delta_non_increasing_events_marked"] for batch in batches
        ),
        "fill_delta_missing_identity_events_marked": sum(
            batch["fill_delta_missing_identity_events_marked"] for batch in batches
        ),
    }
    return {
        "status": "ok",
        "apply": bool(args.apply),
        "dsn_env": args.dsn_env,
        "account_label": args.account_label,
        "backfill_execution_events": bool(args.backfill_execution_events),
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
            execution_event_backfill_batch = (
                backfill_order_feed_events_from_executions(
                    session,
                    account_label=args.account_label,
                    limit=batch_size,
                )
                if args.backfill_execution_events
                else {
                    "selected": 0,
                    "events_created": 0,
                    "source_windows_created": 0,
                    "skipped_existing_event": 0,
                    "skipped_missing_trade_decision": 0,
                    "skipped_missing_order_identity": 0,
                    "skipped_source_offset_collision": 0,
                }
            )
            fill_delta_batch = repair_order_feed_fill_deltas(
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
                "execution_link_decisions_matched": execution_link_batch.get(
                    "decisions_matched", 0
                ),
                "execution_link_events_linked": execution_link_batch["events_linked"],
                "execution_link_decision_events_linked": execution_link_batch.get(
                    "decision_events_linked", 0
                ),
                "execution_link_events_without_execution": execution_link_batch[
                    "events_without_execution"
                ],
                "execution_link_events_without_decision": execution_link_batch.get(
                    "events_without_decision", 0
                ),
                "execution_event_backfill_candidates": execution_event_backfill_batch[
                    "selected"
                ],
                "execution_event_backfill_events_created": execution_event_backfill_batch[
                    "events_created"
                ],
                "execution_event_backfill_source_windows_created": (
                    execution_event_backfill_batch["source_windows_created"]
                ),
                "execution_event_backfill_skipped_existing_event": (
                    execution_event_backfill_batch["skipped_existing_event"]
                ),
                "execution_event_backfill_skipped_missing_trade_decision": (
                    execution_event_backfill_batch["skipped_missing_trade_decision"]
                ),
                "execution_event_backfill_skipped_missing_order_identity": (
                    execution_event_backfill_batch["skipped_missing_order_identity"]
                ),
                "execution_event_backfill_skipped_source_offset_collision": (
                    execution_event_backfill_batch["skipped_source_offset_collision"]
                ),
                "fill_delta_candidates": fill_delta_batch["selected"],
                "fill_delta_events_repaired": fill_delta_batch["delta_events_repaired"],
                "fill_delta_non_increasing_events_marked": fill_delta_batch[
                    "non_increasing_events_marked"
                ],
                "fill_delta_missing_identity_events_marked": fill_delta_batch[
                    "missing_identity_events_marked"
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
                and int(execution_event_backfill_batch.get("selected") or 0)
                < batch_size
                and int(fill_delta_batch.get("selected") or 0) < batch_size
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
