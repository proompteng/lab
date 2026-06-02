#!/usr/bin/env python3
"""Journal existing order-feed events into TigerBeetle and persist reconciliation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

from sqlalchemy import String, create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleTransferRef,
)
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TigerBeetleLedgerJournal,
    build_order_event_transfer_plan,
    tigerbeetle_runtime_ledger_journal_payload,
)
from app.trading.tigerbeetle_client import TigerBeetleClientTimeoutError
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
)
from app.trading.tigerbeetle_reconcile import reconcile_tigerbeetle_transfers

DEFAULT_SOURCES = (
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
)
SOURCE_ALIASES = {
    "event": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    "events": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    "execution_order_event": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    "execution_order_events": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    "execution": SOURCE_TYPE_EXECUTION,
    "executions": SOURCE_TYPE_EXECUTION,
    "execution_tca_metric": SOURCE_TYPE_EXECUTION_TCA_METRIC,
    "execution_tca_metrics": SOURCE_TYPE_EXECUTION_TCA_METRIC,
    "tca": SOURCE_TYPE_EXECUTION_TCA_METRIC,
    "cost": SOURCE_TYPE_EXECUTION_TCA_METRIC,
    "costs": SOURCE_TYPE_EXECUTION_TCA_METRIC,
    "runtime": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    "runtime_ledger": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    "strategy_runtime_ledger_bucket": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    "strategy_runtime_ledger_buckets": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
}


@dataclass(frozen=True)
class OrderEventSelection:
    rows: list[ExecutionOrderEvent]
    scan_failed: int


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Journal unlinked Torghut order-feed lifecycle events into TigerBeetle.",
    )
    parser.add_argument("--dsn-env", default="DB_DSN")
    parser.add_argument("--account-label", default=None)
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--max-batches", type=int, default=1)
    parser.add_argument(
        "--event-scan-limit",
        type=int,
        default=None,
        help="Maximum candidate order-feed events to inspect when looking for journalable lifecycle rows.",
    )
    parser.add_argument("--reconcile-limit", type=int, default=1000)
    parser.add_argument(
        "--sources",
        default="all",
        help=(
            "Comma-separated source groups to journal. Supported values: all, "
            "execution_order_event, execution, execution_tca_metric, "
            "strategy_runtime_ledger_bucket."
        ),
    )
    parser.add_argument(
        "--skip-reconcile",
        action="store_true",
        help="Persist journal refs without running reconciliation in this invocation.",
    )
    parser.add_argument(
        "--fail-on-degraded",
        action="store_true",
        help="Exit non-zero when journaling/reconciliation is degraded.",
    )
    parser.add_argument(
        "--progress-interval",
        type=int,
        default=100,
        help="Emit stderr progress every N processed source rows; set 0 to disable.",
    )
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


def _parse_sources(raw_sources: object) -> tuple[str, ...]:
    raw = str(raw_sources or "all").strip()
    if not raw or raw.lower() == "all":
        return DEFAULT_SOURCES

    selected: list[str] = []
    for item in raw.split(","):
        key = item.strip().lower().replace("-", "_")
        if not key:
            continue
        source = SOURCE_ALIASES.get(key)
        if source is None:
            supported = ", ".join(("all", *DEFAULT_SOURCES))
            raise ValueError(
                f"unsupported source {item!r}; expected one of: {supported}"
            )
        if source not in selected:
            selected.append(source)
    if not selected:
        raise ValueError("at least one journal source must be selected")
    return tuple(selected)


def _select_unlinked_events(
    session: Any,
    *,
    settings_obj: Settings,
    account_label: str | None,
    limit: int,
    event_scan_limit: int | None = None,
) -> OrderEventSelection:
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
    if event_scan_limit is None:
        scan_limit = max(limit, min(limit * 20, 10000))
    else:
        scan_limit = max(limit, min(int(event_scan_limit), 10000))
    candidates = session.execute(stmt.limit(scan_limit)).scalars().all()
    events: list[ExecutionOrderEvent] = []
    scan_failed = 0
    for event in candidates:
        try:
            plan = build_order_event_transfer_plan(
                session,
                event,
                settings_obj=settings_obj,
            )
        except Exception:
            scan_failed += 1
            continue
        if plan is None:
            continue
        events.append(event)
        if len(events) >= limit:
            break
    return OrderEventSelection(rows=events, scan_failed=scan_failed)


def _select_unlinked_executions(
    session: Any,
    *,
    settings_obj: Settings,
    account_label: str | None,
    limit: int,
) -> list[Execution]:
    linked_ref = (
        select(TigerBeetleTransferRef.id)
        .where(
            TigerBeetleTransferRef.cluster_id == settings_obj.tigerbeetle_cluster_id,
            TigerBeetleTransferRef.execution_id == Execution.id,
            TigerBeetleTransferRef.transfer_kind == TRANSFER_KIND_EXECUTION_FILL,
        )
        .exists()
    )
    stmt = (
        select(Execution)
        .where(
            ~linked_ref,
            Execution.avg_fill_price.is_not(None),
            Execution.filled_qty > 0,
        )
        .order_by(Execution.created_at.asc())
    )
    if account_label:
        stmt = stmt.where(Execution.alpaca_account_label == account_label)
    return list(session.execute(stmt.limit(limit)).scalars().all())


def _select_unlinked_tca_metrics(
    session: Any,
    *,
    settings_obj: Settings,
    account_label: str | None,
    limit: int,
) -> list[ExecutionTCAMetric]:
    linked_ref = (
        select(TigerBeetleTransferRef.id)
        .where(
            TigerBeetleTransferRef.cluster_id == settings_obj.tigerbeetle_cluster_id,
            TigerBeetleTransferRef.execution_tca_metric_id == ExecutionTCAMetric.id,
            TigerBeetleTransferRef.transfer_kind == TRANSFER_KIND_EXECUTION_COST,
        )
        .exists()
    )
    stmt = (
        select(ExecutionTCAMetric)
        .where(
            ~linked_ref,
            ExecutionTCAMetric.shortfall_notional.is_not(None),
            ExecutionTCAMetric.shortfall_notional != 0,
        )
        .order_by(ExecutionTCAMetric.computed_at.asc())
    )
    if account_label:
        stmt = stmt.where(ExecutionTCAMetric.alpaca_account_label == account_label)
    return list(session.execute(stmt.limit(limit)).scalars().all())


def _select_unlinked_runtime_buckets(
    session: Any,
    *,
    settings_obj: Settings,
    account_label: str | None,
    limit: int,
) -> list[StrategyRuntimeLedgerBucket]:
    complete_ref = (
        select(TigerBeetleTransferRef.id)
        .where(
            TigerBeetleTransferRef.cluster_id == settings_obj.tigerbeetle_cluster_id,
            TigerBeetleTransferRef.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            TigerBeetleTransferRef.source_id
            == StrategyRuntimeLedgerBucket.id.cast(String),
            TigerBeetleTransferRef.transfer_kind == TRANSFER_KIND_RUNTIME_NET_PNL,
            TigerBeetleTransferRef.runtime_ledger_bucket_id
            == StrategyRuntimeLedgerBucket.id,
        )
        .exists()
    )
    stmt = (
        select(StrategyRuntimeLedgerBucket)
        .where(
            ~complete_ref,
            (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
            | (StrategyRuntimeLedgerBucket.cost_amount != 0),
        )
        .order_by(StrategyRuntimeLedgerBucket.bucket_ended_at.asc())
    )
    if account_label:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.account_label == account_label)
    return list(session.execute(stmt.limit(limit)).scalars().all())


def _journal_source_batch(
    session: Any,
    *,
    args: argparse.Namespace,
    source: str,
    rows: list[Any],
    journal_one: Any,
) -> dict[str, Any]:
    batch: dict[str, Any] = {
        "source": source,
        "selected": len(rows),
        "journaled": 0,
        "skipped": 0,
        "failed": 0,
        "error_counts": {},
        "sample_errors": [],
        "stopped_early": False,
        "stop_reason": None,
    }
    progress_interval = max(0, int(getattr(args, "progress_interval", 100) or 0))
    _emit_progress(
        "source_batch_start",
        source=source,
        selected=len(rows),
    )
    for row in rows:
        try:
            if args.dry_run:
                batch["journaled"] = int(batch["journaled"]) + 1
                continue
            with session.begin_nested():
                ref = journal_one(row)
            if ref is None:
                batch["skipped"] = int(batch["skipped"]) + 1
            else:
                if source == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET and isinstance(
                    ref, TigerBeetleTransferRef
                ):
                    _attach_runtime_bucket_journal_payload(row, ref)
                batch["journaled"] = int(batch["journaled"]) + 1
        except Exception as exc:
            batch["failed"] = int(batch["failed"]) + 1
            error_counts = batch["error_counts"]
            if isinstance(error_counts, dict):
                error_key = _error_summary(exc)
                error_counts[error_key] = int(error_counts.get(error_key, 0)) + 1
            sample_errors = batch["sample_errors"]
            if isinstance(sample_errors, list) and len(sample_errors) < 5:
                sample_errors.append(
                    {
                        "row_id": str(getattr(row, "id", "unknown")),
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )
            if isinstance(exc, TigerBeetleClientTimeoutError):
                batch["stopped_early"] = True
                batch["stop_reason"] = "tigerbeetle_rpc_timeout"
                _emit_progress(
                    "source_batch_stopped",
                    source=source,
                    reason=batch["stop_reason"],
                    failed=batch["failed"],
                    journaled=batch["journaled"],
                    skipped=batch["skipped"],
                )
                break
        processed = (
            int(batch["journaled"]) + int(batch["skipped"]) + int(batch["failed"])
        )
        if progress_interval and processed and processed % progress_interval == 0:
            _emit_progress(
                "source_batch_progress",
                source=source,
                processed=processed,
                selected=batch["selected"],
                journaled=batch["journaled"],
                skipped=batch["skipped"],
                failed=batch["failed"],
            )
    _emit_progress(
        "source_batch_complete",
        source=source,
        selected=batch["selected"],
        journaled=batch["journaled"],
        skipped=batch["skipped"],
        failed=batch["failed"],
        stopped_early=batch["stopped_early"],
        stop_reason=batch["stop_reason"],
    )
    return batch


def _emit_progress(event: str, **fields: object) -> None:
    payload = {
        "schema_version": "torghut.tigerbeetle-journal-progress.v1",
        "event": event,
        "ts": datetime.now(timezone.utc).isoformat(),
        **fields,
    }
    print(json.dumps(payload, separators=(",", ":")), file=sys.stderr, flush=True)


def _batch_requested_stop(batch: Mapping[str, Any]) -> bool:
    return bool(batch.get("stopped_early")) and bool(
        str(batch.get("stop_reason") or "")
    )


def _attach_runtime_bucket_journal_payload(
    row: StrategyRuntimeLedgerBucket,
    ref: TigerBeetleTransferRef,
) -> None:
    journal_payload = tigerbeetle_runtime_ledger_journal_payload(
        bucket=row,
        ref=ref,
        status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    )
    existing_payload = (
        dict(row.payload_json) if isinstance(row.payload_json, dict) else {}
    )
    source_refs = [
        str(item)
        for item in existing_payload.get("source_refs", [])
        if str(item).strip()
    ]
    raw_journal_source_refs = journal_payload.get("source_refs")
    journal_source_refs = (
        cast(Sequence[object], raw_journal_source_refs)
        if isinstance(raw_journal_source_refs, Sequence)
        and not isinstance(raw_journal_source_refs, (str, bytes, bytearray))
        else ()
    )
    for source_ref in journal_source_refs:
        if isinstance(source_ref, str) and source_ref not in source_refs:
            source_refs.append(source_ref)
    source_row_counts = (
        dict(existing_payload.get("source_row_counts", {}))
        if isinstance(existing_payload.get("source_row_counts"), dict)
        else {}
    )
    source_row_counts["tigerbeetle_transfer_refs"] = 1
    row.payload_json = {
        **existing_payload,
        "source_refs": source_refs,
        "source_row_counts": source_row_counts,
        "tigerbeetle_journal_parity": journal_payload,
        "tigerbeetle": journal_payload,
        "tigerbeetle_account_ids": journal_payload["account_ids"],
        "tigerbeetle_account_keys": journal_payload["account_keys"],
        "tigerbeetle_transfer_ids": journal_payload["transfer_ids"],
        "tigerbeetle_non_authority_blockers": journal_payload["authority_blockers"],
    }


def _error_summary(exc: Exception) -> str:
    message = str(exc).strip()
    if len(message) > 160:
        message = f"{message[:157]}..."
    return f"{type(exc).__name__}:{message}"


def _reset_session_identity_map(session: Any) -> None:
    expunge_all = getattr(session, "expunge_all", None)
    if callable(expunge_all):
        expunge_all()


def _payload(
    *,
    args: argparse.Namespace,
    started_at: datetime,
    batches: list[dict[str, Any]],
    reconciliation: dict[str, object] | None,
) -> dict[str, Any]:
    selected = sum(int(batch["selected"]) for batch in batches)
    journaled = sum(int(batch["journaled"]) for batch in batches)
    skipped = sum(int(batch["skipped"]) for batch in batches)
    failed = sum(int(batch["failed"]) for batch in batches)
    reconciliation_ok = (
        True
        if reconciliation is None
        else bool(reconciliation.get("ok", reconciliation.get("status") == "ok"))
    )
    status = "ok" if failed == 0 and reconciliation_ok else "degraded"
    stop_reasons = [
        str(batch.get("stop_reason"))
        for batch in batches
        if str(batch.get("stop_reason") or "").strip()
    ]
    return {
        "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
        "ok": status == "ok",
        "status": status,
        "fail_on_degraded": bool(args.fail_on_degraded),
        "dry_run": bool(args.dry_run),
        "dsn_env": args.dsn_env,
        "account_label": args.account_label,
        "batch_size": max(1, min(int(args.batch_size), 5000)),
        "max_batches": max(1, int(args.max_batches)),
        "event_scan_limit": getattr(args, "event_scan_limit", None),
        "sources": list(_parse_sources(getattr(args, "sources", "all"))),
        "skip_reconcile": bool(getattr(args, "skip_reconcile", False)),
        "stopped_early": bool(stop_reasons),
        "stop_reasons": stop_reasons,
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
                )
                batches.append(runtime_batch)
                batch_lengths.append(len(runtime_buckets))
                stop_journaling = _batch_requested_stop(runtime_batch)
            if args.dry_run:
                session.rollback()
                _reset_session_identity_map(session)
                break
            if not stop_journaling:
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

        if not args.dry_run and not args.skip_reconcile and not stop_journaling:
            reconciliation = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=settings_obj,
                client=journal.client_for_reconciliation(),
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
    return 1 if args.fail_on_degraded and payload["status"] != "ok" else 0


if __name__ == "__main__":
    raise SystemExit(main())
