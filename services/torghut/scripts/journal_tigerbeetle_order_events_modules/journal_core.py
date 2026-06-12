#!/usr/bin/env python3
"""Journal existing order-feed events into TigerBeetle and persist reconciliation."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import select

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
    build_runtime_ledger_bucket_transfer_plan,
    build_order_event_transfer_plan,
    tigerbeetle_runtime_ledger_journal_payload,
)
from app.trading.tigerbeetle_client import TigerBeetleClientTimeoutError
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
)


DEFAULT_SOURCES = (
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
)

INFRASTRUCTURE_RECONCILIATION_BLOCKERS = frozenset(
    {
        "tigerbeetle_client_unavailable",
    }
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

DEFAULT_JOURNAL_BATCH_CHUNK_SIZE = 25

MAX_JOURNAL_BATCH_CHUNK_SIZE = 5000


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
        "--reconcile-empty-selection",
        action="store_true",
        help=(
            "Run bounded reconciliation even when this invocation selects no new "
            "source rows. This is intended for scheduled freshness probes; by "
            "default empty source slices remain a no-op."
        ),
    )
    parser.add_argument(
        "--fail-on-degraded",
        action="store_true",
        help="Exit non-zero when journaling/reconciliation is degraded.",
    )
    parser.add_argument(
        "--allow-data-quality-degraded",
        action="store_true",
        help=(
            "When --fail-on-degraded is set, allow non-authoritative scheduled "
            "telemetry runs to exit zero for reconciliation/accounting data-quality "
            "blockers while still failing closed for journal batch failures, "
            "TigerBeetle infrastructure blockers, timeouts, and unhandled errors."
        ),
    )
    parser.add_argument(
        "--progress-interval",
        type=int,
        default=100,
        help="Emit stderr progress every N processed source rows; set 0 to disable.",
    )
    parser.add_argument(
        "--journal-batch-chunk-size",
        type=int,
        default=DEFAULT_JOURNAL_BATCH_CHUNK_SIZE,
        help=(
            "Maximum rows passed to one native TigerBeetle batch call inside a "
            "selected source batch."
        ),
    )
    parser.add_argument(
        "--commit-each-row",
        action="store_true",
        help=(
            "Commit each successfully journaled source row before moving to the "
            "next row. This keeps scheduled catch-up progress durable when a "
            "later native TigerBeetle call has to be killed by the supervisor."
        ),
    )
    parser.add_argument(
        "--supervise-timeout-seconds",
        type=float,
        default=0.0,
        help=(
            "Run the journal worker in a child process and kill it after this "
            "deadline. This bounds native TigerBeetle client calls that cannot "
            "be interrupted safely from a Python thread."
        ),
    )
    parser.add_argument(
        "--supervised-worker",
        action="store_true",
        help=argparse.SUPPRESS,
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
        .order_by(Execution.created_at.desc(), Execution.id.desc())
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
        .order_by(
            ExecutionTCAMetric.computed_at.desc().nullslast(),
            ExecutionTCAMetric.created_at.desc(),
            ExecutionTCAMetric.id.desc(),
        )
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
    stmt = (
        select(StrategyRuntimeLedgerBucket)
        .where(
            (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
            | (StrategyRuntimeLedgerBucket.cost_amount != 0),
        )
        .order_by(StrategyRuntimeLedgerBucket.bucket_ended_at.asc())
    )
    if account_label:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.account_label == account_label)
    scan_limit = max(limit, min(limit * 20, 10000))
    candidates = session.execute(stmt.limit(scan_limit)).scalars().all()
    buckets: list[StrategyRuntimeLedgerBucket] = []
    for bucket in candidates:
        if _runtime_bucket_has_signed_ref(
            session,
            bucket,
            settings_obj=settings_obj,
        ):
            continue
        buckets.append(bucket)
        if len(buckets) >= limit:
            break
    return buckets


def _runtime_bucket_has_signed_ref(
    session: Any,
    bucket: StrategyRuntimeLedgerBucket,
    *,
    settings_obj: Settings,
) -> bool:
    refs = (
        session.execute(
            select(TigerBeetleTransferRef).where(
                TigerBeetleTransferRef.cluster_id
                == settings_obj.tigerbeetle_cluster_id,
                TigerBeetleTransferRef.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                TigerBeetleTransferRef.source_id == str(bucket.id),
                TigerBeetleTransferRef.transfer_kind == TRANSFER_KIND_RUNTIME_NET_PNL,
                TigerBeetleTransferRef.runtime_ledger_bucket_id == bucket.id,
            )
        )
        .scalars()
        .all()
    )
    return any(_runtime_ref_matches_signed_bucket(ref, bucket) for ref in refs)


def _payload_mapping(row: TigerBeetleTransferRef) -> Mapping[str, object]:
    raw_payload = cast(object, row.payload_json)
    if isinstance(raw_payload, Mapping):
        return cast(Mapping[str, object], raw_payload)
    return {}


def _payload_int_matches(
    payload: Mapping[str, object],
    key: str,
    expected: int,
) -> bool:
    value = payload.get(key)
    if value is None:
        return False
    try:
        return int(str(value)) == expected
    except (TypeError, ValueError):
        return False


def _runtime_ref_matches_signed_bucket(
    ref: TigerBeetleTransferRef,
    bucket: StrategyRuntimeLedgerBucket,
) -> bool:
    plan = build_runtime_ledger_bucket_transfer_plan(bucket)
    if plan is None:
        return False
    transfer_spec = plan.transfer_spec
    payload = _payload_mapping(ref)
    return (
        ref.transfer_id == str(transfer_spec.transfer_id)
        and ref.transfer_kind == TRANSFER_KIND_RUNTIME_NET_PNL
        and ref.amount == Decimal(transfer_spec.amount)
        and ref.ledger == transfer_spec.ledger
        and ref.code == transfer_spec.code
        and ref.runtime_ledger_bucket_id == bucket.id
        and ref.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET
        and ref.source_id == str(bucket.id)
        and _payload_int_matches(
            payload,
            "debit_account_id",
            transfer_spec.debit_account_id,
        )
        and _payload_int_matches(
            payload,
            "credit_account_id",
            transfer_spec.credit_account_id,
        )
        and _payload_int_matches(
            payload,
            "signed_amount_micros",
            plan.signed_amount_micros,
        )
        and str(payload.get("pnl_direction") or "") == plan.pnl_direction
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


def _journal_source_batch(
    session: Any,
    *,
    args: argparse.Namespace,
    source: str,
    rows: list[Any],
    journal_one: Any,
    journal_many: Any | None = None,
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
        "journal_batch_chunk_size": max(
            1,
            min(
                int(
                    getattr(
                        args,
                        "journal_batch_chunk_size",
                        DEFAULT_JOURNAL_BATCH_CHUNK_SIZE,
                    )
                    or DEFAULT_JOURNAL_BATCH_CHUNK_SIZE
                ),
                MAX_JOURNAL_BATCH_CHUNK_SIZE,
            ),
        ),
        "journal_batch_chunks": 0,
    }
    progress_interval = max(0, int(getattr(args, "progress_interval", 100) or 0))
    _emit_progress(
        "source_batch_start",
        source=source,
        selected=len(rows),
    )
    if journal_many is not None and rows and not args.dry_run:
        try:
            chunk_size = int(batch["journal_batch_chunk_size"])
            for chunk_index, chunk_start in enumerate(range(0, len(rows), chunk_size)):
                chunk_rows = rows[chunk_start : chunk_start + chunk_size]
                with session.begin_nested():
                    refs = list(journal_many(chunk_rows))
                if len(refs) != len(chunk_rows):
                    raise RuntimeError(
                        "tigerbeetle_journal_batch_result_count_mismatch"
                    )
                for row, ref in zip(chunk_rows, refs):
                    if ref is None:
                        batch["skipped"] = int(batch["skipped"]) + 1
                        continue
                    if source == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET and isinstance(
                        ref, TigerBeetleTransferRef
                    ):
                        _attach_runtime_bucket_journal_payload(row, ref)
                    batch["journaled"] = int(batch["journaled"]) + 1
                batch["journal_batch_chunks"] = int(batch["journal_batch_chunks"]) + 1
                if bool(getattr(args, "commit_each_row", False)):
                    session.commit()
                    _reset_session_identity_map(session)
                _emit_progress(
                    "source_batch_chunk_complete",
                    source=source,
                    chunk_index=chunk_index,
                    chunk_size=len(chunk_rows),
                    selected=batch["selected"],
                    journaled=batch["journaled"],
                    skipped=batch["skipped"],
                    failed=batch["failed"],
                )
        except Exception as exc:
            if not isinstance(exc, TigerBeetleClientTimeoutError):
                _emit_progress(
                    "source_batch_fallback_row_by_row",
                    source=source,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                for row in rows:
                    try:
                        with session.begin_nested():
                            ref = journal_one(row)
                        if ref is None:
                            batch["skipped"] = int(batch["skipped"]) + 1
                        else:
                            if (
                                source == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET
                                and isinstance(ref, TigerBeetleTransferRef)
                            ):
                                _attach_runtime_bucket_journal_payload(row, ref)
                            batch["journaled"] = int(batch["journaled"]) + 1
                            if bool(getattr(args, "commit_each_row", False)):
                                session.commit()
                                _reset_session_identity_map(session)
                    except Exception as row_exc:
                        batch["failed"] = int(batch["failed"]) + 1
                        error_counts = batch["error_counts"]
                        if isinstance(error_counts, dict):
                            error_key = _error_summary(row_exc)
                            error_counts[error_key] = (
                                int(error_counts.get(error_key, 0)) + 1
                            )
                        sample_errors = batch["sample_errors"]
                        if isinstance(sample_errors, list) and len(sample_errors) < 5:
                            sample_errors.append(
                                {
                                    "row_id": str(getattr(row, "id", "unknown")),
                                    "error_type": type(row_exc).__name__,
                                    "error": str(row_exc),
                                }
                            )
                        if isinstance(row_exc, TigerBeetleClientTimeoutError):
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

            batch["failed"] = int(batch["failed"]) + 1
            error_counts = batch["error_counts"]
            if isinstance(error_counts, dict):
                error_key = _error_summary(exc)
                error_counts[error_key] = int(error_counts.get(error_key, 0)) + 1
            sample_errors = batch["sample_errors"]
            if isinstance(sample_errors, list) and len(sample_errors) < 5:
                sample_errors.append(
                    {
                        "row_id": "batch",
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )
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
    for row in rows:
        if progress_interval == 1:
            _emit_progress(
                "source_row_start",
                source=source,
                row_id=str(getattr(row, "id", "unknown")),
            )
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
                if bool(getattr(args, "commit_each_row", False)):
                    session.commit()
                    _reset_session_identity_map(session)
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
