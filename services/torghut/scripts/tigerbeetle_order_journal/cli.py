#!/usr/bin/env python3
"""Journal existing order-feed events into TigerBeetle and persist reconciliation."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    TigerBeetleLedgerJournal,
)
from app.trading.tigerbeetle_reconcile import (
    reconcile_tigerbeetle_transfers,
)

from .journal_core import (
    _batch_requested_stop,
    _journal_source_batch,
    _parse_args,
    _parse_sources,
    _reset_session_identity_map,
    _select_unlinked_events,
    _select_unlinked_executions,
    _select_unlinked_runtime_buckets,
    _select_unlinked_tca_metrics,
    _sqlalchemy_dsn,
)
from .journal_payloads import (
    _fresh_reconciliation_for_empty_selection,
    _payload,
    _run_supervised_worker,
)


def main() -> int:
    args = _parse_args()
    dsn = os.environ.get(str(args.dsn_env).strip())
    if not dsn:
        raise SystemExit(f"missing DSN env var: {args.dsn_env}")

    started_at = datetime.now(timezone.utc)
    if float(getattr(args, "supervise_timeout_seconds", 0.0) or 0.0) > 0 and not bool(
        getattr(args, "supervised_worker", False)
    ):
        return _run_supervised_worker(args, started_at=started_at)

    batch_size = max(1, min(int(args.batch_size), 5000))
    max_batches = max(1, int(args.max_batches))
    try:
        enabled_sources = _parse_sources(args.sources)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
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
    batches: list[dict[str, Any]] = []
    reconciliation: dict[str, object] | None = None
    stop_journaling = False
    selected_source_rows = 0

    with (
        session_factory() as session,
        TigerBeetleLedgerJournal(
            settings_obj=settings_obj,
        ) as journal,
    ):
        for _ in range(max_batches):
            batch_lengths: list[int] = []
            if (
                SOURCE_TYPE_EXECUTION_ORDER_EVENT in enabled_sources
                and not stop_journaling
            ):
                events = _select_unlinked_events(
                    session,
                    settings_obj=settings_obj,
                    account_label=args.account_label,
                    limit=batch_size,
                    event_scan_limit=args.event_scan_limit,
                )
                event_batch = _journal_source_batch(
                    session,
                    args=args,
                    source=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    rows=events.rows,
                    journal_one=lambda event: journal.journal_order_event(
                        session,
                        event,
                    ),
                    journal_many=lambda rows: journal.journal_order_events(
                        session,
                        rows,
                    ),
                )
                if events.scan_failed:
                    event_batch["failed"] = (
                        int(event_batch["failed"]) + events.scan_failed
                    )
                    event_batch["scan_failed"] = events.scan_failed
                batches.append(event_batch)
                batch_lengths.append(len(events.rows))
                stop_journaling = _batch_requested_stop(event_batch)
            if SOURCE_TYPE_EXECUTION in enabled_sources and not stop_journaling:
                executions = _select_unlinked_executions(
                    session,
                    settings_obj=settings_obj,
                    account_label=args.account_label,
                    limit=batch_size,
                )
                execution_batch = _journal_source_batch(
                    session,
                    args=args,
                    source=SOURCE_TYPE_EXECUTION,
                    rows=executions,
                    journal_one=lambda execution: journal.journal_execution(
                        session,
                        execution,
                    ),
                    journal_many=lambda rows: journal.journal_executions(
                        session,
                        rows,
                    ),
                )
                batches.append(execution_batch)
                batch_lengths.append(len(executions))
                stop_journaling = _batch_requested_stop(execution_batch)
            if (
                SOURCE_TYPE_EXECUTION_TCA_METRIC in enabled_sources
                and not stop_journaling
            ):
                tca_metrics = _select_unlinked_tca_metrics(
                    session,
                    settings_obj=settings_obj,
                    account_label=args.account_label,
                    limit=batch_size,
                )
                tca_batch = _journal_source_batch(
                    session,
                    args=args,
                    source=SOURCE_TYPE_EXECUTION_TCA_METRIC,
                    rows=tca_metrics,
                    journal_one=lambda metric: journal.journal_execution_tca_metric(
                        session,
                        metric,
                    ),
                    journal_many=lambda rows: journal.journal_execution_tca_metrics(
                        session,
                        rows,
                    ),
                )
                batches.append(tca_batch)
                batch_lengths.append(len(tca_metrics))
                stop_journaling = _batch_requested_stop(tca_batch)
            if (
                SOURCE_TYPE_RUNTIME_LEDGER_BUCKET in enabled_sources
                and not stop_journaling
            ):
                runtime_buckets = _select_unlinked_runtime_buckets(
                    session,
                    settings_obj=settings_obj,
                    account_label=args.account_label,
                    limit=batch_size,
                )
                runtime_batch = _journal_source_batch(
                    session,
                    args=args,
                    source=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    rows=runtime_buckets,
                    journal_one=lambda bucket: journal.journal_runtime_ledger_bucket(
                        session,
                        bucket,
                    ),
                    journal_many=lambda rows: journal.journal_runtime_ledger_buckets(
                        session,
                        rows,
                    ),
                )
                batches.append(runtime_batch)
                batch_lengths.append(len(runtime_buckets))
                stop_journaling = _batch_requested_stop(runtime_batch)
            if args.dry_run:
                session.rollback()
                _reset_session_identity_map(session)
                break
            iteration_selected_rows = sum(batch_lengths)
            selected_source_rows += iteration_selected_rows
            if not stop_journaling and iteration_selected_rows > 0:
                stable_ref_backfill = journal.backfill_stable_ref_payloads(
                    session,
                    limit=batch_size,
                )
                batches.append(
                    {
                        "source": "tigerbeetle_stable_ref_payload",
                        "selected": int(stable_ref_backfill["selected"]),
                        "journaled": int(stable_ref_backfill["updated"]),
                        "skipped": int(stable_ref_backfill["skipped"]),
                        "failed": 0,
                        "error_counts": {},
                        "sample_errors": [],
                        "stopped_early": False,
                        "stop_reason": None,
                    }
                )
            session.commit()
            _reset_session_identity_map(session)
            if stop_journaling:
                reconciliation = {
                    "ok": False,
                    "status": "skipped",
                    "reason": "tigerbeetle_journal_stopped_early",
                }
                break
            if batch_lengths and all(length < batch_size for length in batch_lengths):
                break

        if (
            not args.dry_run
            and not args.skip_reconcile
            and not stop_journaling
            and (
                selected_source_rows > 0
                or bool(getattr(args, "reconcile_empty_selection", False))
            )
        ):
            reconciliation = None
            if selected_source_rows == 0:
                reconciliation = _fresh_reconciliation_for_empty_selection(
                    session,
                    settings_obj=settings_obj,
                    account_label=args.account_label,
                )
            if reconciliation is None:
                reconciliation = reconcile_tigerbeetle_transfers(
                    session,
                    settings_obj=settings_obj,
                    client=journal.client_for_reconciliation(),
                    limit=max(1, int(args.reconcile_limit)),
                    persist=True,
                    account_label=args.account_label,
                )
            session.commit()
        elif not args.dry_run and not args.skip_reconcile and not stop_journaling:
            reconciliation = {
                "ok": True,
                "status": "skipped",
                "reason": "no_source_rows_selected",
                "reconcile_empty_selection": False,
            }

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
    return 1 if bool(payload["exit_nonzero"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
