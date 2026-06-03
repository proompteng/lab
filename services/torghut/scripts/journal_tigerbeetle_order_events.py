#!/usr/bin/env python3
"""Journal existing order-feed events into TigerBeetle and persist reconciliation."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import create_engine, select
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
from app.trading.tigerbeetle_reconcile import (
    latest_tigerbeetle_reconciliation_payload,
    reconcile_tigerbeetle_transfers,
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


def _fresh_reconciliation_for_empty_selection(
    session: Any,
    *,
    settings_obj: Settings,
) -> dict[str, object] | None:
    latest = latest_tigerbeetle_reconciliation_payload(
        session,
        cluster_id=settings_obj.tigerbeetle_cluster_id,
    )
    if latest is None:
        return None
    if not bool(latest.get("ok")):
        return None
    if str(latest.get("status") or "") != "ok":
        return None
    if bool(latest.get("reconciliation_stale")):
        return None
    max_age_seconds = int(latest.get("reconciliation_max_age_seconds") or 0)
    if max_age_seconds <= 0:
        return None
    raw_blockers = latest.get("blockers")
    if isinstance(raw_blockers, Sequence) and not isinstance(
        raw_blockers,
        (str, bytes, bytearray),
    ):
        if any(str(item).strip() for item in raw_blockers):
            return None
    elif raw_blockers:
        return None
    if not bool(latest.get("client_lookup_ok", True)):
        return None
    return {
        "ok": True,
        "status": "skipped",
        "reason": "fresh_reconciliation_available",
        "fresh_reconciliation_available": True,
        "latest_status": str(latest.get("status") or ""),
        "latest_started_at": latest.get("started_at"),
        "latest_finished_at": latest.get("finished_at"),
        "age_seconds": int(latest.get("age_seconds") or 0),
        "reconciliation_stale": False,
        "reconciliation_max_age_seconds": max_age_seconds,
        "checked_transfer_count": int(latest.get("checked_transfer_count") or 0),
        "runtime_ledger_checked_transfer_count": int(
            latest.get("runtime_ledger_checked_transfer_count") or 0
        ),
        "runtime_ledger_signed_transfer_count": int(
            latest.get("runtime_ledger_signed_transfer_count") or 0
        ),
        "runtime_ledger_missing_signed_ref_count": int(
            latest.get("runtime_ledger_missing_signed_ref_count") or 0
        ),
        "blockers": [],
    }


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
    reconciliation_blockers = _reconciliation_blockers(reconciliation)
    hard_failure_reasons = _hard_failure_reasons(
        failed=failed,
        stop_reasons=stop_reasons,
        reconciliation_blockers=reconciliation_blockers,
        reconciliation_ok=reconciliation_ok,
    )
    accounting_blockers = [
        blocker
        for blocker in reconciliation_blockers
        if blocker not in INFRASTRUCTURE_RECONCILIATION_BLOCKERS
    ]
    exit_nonzero = _should_exit_nonzero(
        status=status,
        fail_on_degraded=bool(args.fail_on_degraded),
        allow_data_quality_degraded=bool(
            getattr(args, "allow_data_quality_degraded", False)
        ),
        hard_failure_reasons=hard_failure_reasons,
    )
    return {
        "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
        "ok": status == "ok",
        "status": status,
        "authority": "non_authoritative_tigerbeetle_journal_telemetry",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "fail_on_degraded": bool(args.fail_on_degraded),
        "allow_data_quality_degraded": bool(
            getattr(args, "allow_data_quality_degraded", False)
        ),
        "exit_nonzero": exit_nonzero,
        "exit_policy": (
            "fail_on_hard_failures_only"
            if bool(getattr(args, "allow_data_quality_degraded", False))
            else "fail_on_any_degraded"
        ),
        "dry_run": bool(args.dry_run),
        "dsn_env": args.dsn_env,
        "account_label": args.account_label,
        "batch_size": max(1, min(int(args.batch_size), 5000)),
        "max_batches": max(1, int(args.max_batches)),
        "event_scan_limit": getattr(args, "event_scan_limit", None),
        "sources": list(_parse_sources(getattr(args, "sources", "all"))),
        "skip_reconcile": bool(getattr(args, "skip_reconcile", False)),
        "reconcile_empty_selection": bool(
            getattr(args, "reconcile_empty_selection", False)
        ),
        "commit_each_row": bool(getattr(args, "commit_each_row", False)),
        "supervised_worker": bool(getattr(args, "supervised_worker", False)),
        "supervise_timeout_seconds": float(
            getattr(args, "supervise_timeout_seconds", 0.0) or 0.0
        ),
        "stopped_early": bool(stop_reasons),
        "stop_reasons": stop_reasons,
        "hard_failure_reasons": hard_failure_reasons,
        "accounting_blockers": accounting_blockers,
        "reconciliation_blockers": reconciliation_blockers,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "selected": selected,
        "journaled": journaled,
        "skipped": skipped,
        "failed": failed,
        "batches": batches,
        "reconciliation": reconciliation,
    }


def _reconciliation_blockers(
    reconciliation: Mapping[str, object] | None,
) -> list[str]:
    if reconciliation is None:
        return []
    raw_blockers = reconciliation.get("blockers")
    if not isinstance(raw_blockers, Sequence) or isinstance(
        raw_blockers,
        (str, bytes, bytearray),
    ):
        return []
    return sorted({str(item) for item in raw_blockers if str(item).strip()})


def _hard_failure_reasons(
    *,
    failed: int,
    stop_reasons: Sequence[str],
    reconciliation_blockers: Sequence[str],
    reconciliation_ok: bool,
) -> list[str]:
    reasons: list[str] = []
    if failed:
        reasons.append("journal_batch_failures")
    if (
        not reconciliation_ok
        and not reconciliation_blockers
        and not failed
        and not stop_reasons
    ):
        reasons.append("reconciliation_degraded_without_blockers")
    for reason in stop_reasons:
        clean_reason = str(reason).strip()
        if clean_reason and clean_reason not in reasons:
            reasons.append(clean_reason)
    for blocker in reconciliation_blockers:
        if blocker in INFRASTRUCTURE_RECONCILIATION_BLOCKERS and blocker not in reasons:
            reasons.append(blocker)
    return reasons


def _should_exit_nonzero(
    *,
    status: str,
    fail_on_degraded: bool,
    allow_data_quality_degraded: bool,
    hard_failure_reasons: Sequence[str],
) -> bool:
    if not fail_on_degraded or status == "ok":
        return False
    if allow_data_quality_degraded:
        return bool(hard_failure_reasons)
    return True


def _supervised_timeout_payload(
    *,
    args: argparse.Namespace,
    started_at: datetime,
    timeout_seconds: float,
) -> dict[str, Any]:
    stop_reason = "tigerbeetle_journal_worker_timeout"
    batch = {
        "source": "supervised_worker",
        "selected": 0,
        "journaled": 0,
        "skipped": 0,
        "failed": 1,
        "error_counts": {stop_reason: 1},
        "sample_errors": [
            {
                "error_type": "TimeoutExpired",
                "error": f"journal worker exceeded {timeout_seconds:.3f}s",
            }
        ],
        "stopped_early": True,
        "stop_reason": stop_reason,
    }
    reconciliation = {
        "ok": False,
        "status": "skipped",
        "reason": stop_reason,
    }
    payload = _payload(
        args=args,
        started_at=started_at,
        batches=[batch],
        reconciliation=reconciliation,
    )
    payload.update(
        {
            "supervised_worker": False,
            "supervise_timeout_seconds": timeout_seconds,
        }
    )
    return payload


def _without_arg(argv: Sequence[str], option: str) -> list[str]:
    filtered: list[str] = []
    skip_next = False
    for item in argv:
        if skip_next:
            skip_next = False
            continue
        if item == option:
            skip_next = True
            continue
        if item.startswith(f"{option}="):
            continue
        filtered.append(item)
    return filtered


def _with_source_arg(argv: Sequence[str], source: str | None) -> list[str]:
    worker_args = [item for item in argv if item != "--supervised-worker"]
    if source is None:
        return worker_args
    return [*_without_arg(worker_args, "--sources"), "--sources", source]


def _args_for_source(
    args: argparse.Namespace, source: str | None
) -> argparse.Namespace:
    if source is None:
        return args
    source_args = vars(args).copy()
    source_args["sources"] = source
    return argparse.Namespace(**source_args)


def _supervised_worker_argv(source: str | None = None) -> list[str]:
    return [
        sys.executable,
        os.path.abspath(__file__),
        *_with_source_arg(sys.argv[1:], source),
        "--supervised-worker",
    ]


def _write_supervised_output(value: str | bytes | None, *, stream: Any) -> str:
    if value is None:
        return ""
    text = (
        value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value
    )
    if text:
        stream.write(text)
        stream.flush()
    return text


def _last_journal_payload(text: str) -> dict[str, Any] | None:
    payload: dict[str, Any] | None = None
    for line in text.splitlines():
        clean_line = line.strip()
        if not clean_line.startswith("{"):
            continue
        try:
            candidate = json.loads(clean_line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(candidate, dict)
            and candidate.get("schema_version")
            == "torghut.tigerbeetle-journal-order-events.v1"
        ):
            payload = candidate
    return payload


def _safe_payload_allows_success(payload: Mapping[str, Any] | None) -> bool:
    if not payload:
        return False
    if payload.get("schema_version") != "torghut.tigerbeetle-journal-order-events.v1":
        return False
    if bool(payload.get("exit_nonzero", True)):
        return False
    if bool(payload.get("promotion_authority", True)):
        return False
    if bool(payload.get("overrides_runtime_ledger_authority", True)):
        return False
    if int(payload.get("failed") or 0) != 0:
        return False
    for key in ("hard_failure_reasons", "stop_reasons"):
        raw_value = payload.get(key)
        if isinstance(raw_value, Sequence) and not isinstance(
            raw_value,
            (str, bytes, bytearray),
        ):
            if any(str(item).strip() for item in raw_value):
                return False
        elif raw_value:
            return False
    return True


def _normalize_supervised_returncode(
    *,
    returncode: int,
    payload: Mapping[str, Any] | None,
    worker_args: argparse.Namespace,
) -> int:
    if returncode == 0:
        return 0
    if not _safe_payload_allows_success(payload):
        return returncode
    assert payload is not None
    _emit_progress(
        "supervised_worker_exit_mismatch_normalized",
        returncode=returncode,
        sources=list(_parse_sources(getattr(worker_args, "sources", "all"))),
        status=str(payload.get("status", "")),
        accounting_blockers=list(
            cast(Sequence[object], payload.get("accounting_blockers") or [])
        ),
        reconciliation_blockers=list(
            cast(Sequence[object], payload.get("reconciliation_blockers") or [])
        ),
    )
    return 0


def _run_supervised_worker_once(
    args: argparse.Namespace,
    *,
    started_at: datetime,
    source: str | None = None,
) -> int:
    worker_args = _args_for_source(args, source)
    timeout_seconds = max(float(worker_args.supervise_timeout_seconds), 0.001)
    stdout_text = ""
    stderr_text = ""
    try:
        completed = subprocess.run(
            _supervised_worker_argv(source),
            check=False,
            timeout=timeout_seconds,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired as exc:
        stdout_text += _write_supervised_output(exc.stdout, stream=sys.stdout)
        stderr_text += _write_supervised_output(exc.stderr, stream=sys.stderr)
        _emit_progress(
            "supervised_worker_timeout",
            timeout_seconds=timeout_seconds,
            sources=list(_parse_sources(getattr(worker_args, "sources", "all"))),
        )
        payload = _supervised_timeout_payload(
            args=worker_args,
            started_at=started_at,
            timeout_seconds=timeout_seconds,
        )
        print(
            json.dumps(payload, separators=(",", ":"))
            if worker_args.json
            else json.dumps(payload, indent=2)
        )
        return 1 if bool(payload["exit_nonzero"]) else 0
    stdout_text += _write_supervised_output(completed.stdout, stream=sys.stdout)
    stderr_text += _write_supervised_output(completed.stderr, stream=sys.stderr)
    payload = _last_journal_payload(stdout_text)
    if payload is None:
        payload = _last_journal_payload(stderr_text)
    return _normalize_supervised_returncode(
        returncode=int(completed.returncode),
        payload=payload,
        worker_args=worker_args,
    )


def _run_supervised_worker(args: argparse.Namespace, *, started_at: datetime) -> int:
    sources = _parse_sources(getattr(args, "sources", "all"))
    if len(sources) <= 1:
        return _run_supervised_worker_once(args, started_at=started_at)

    exit_code = 0
    for source in sources:
        source_exit_code = _run_supervised_worker_once(
            args,
            started_at=started_at,
            source=source,
        )
        if source_exit_code:
            exit_code = 1
    return exit_code


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
                )
            if reconciliation is None:
                reconciliation = reconcile_tigerbeetle_transfers(
                    session,
                    settings_obj=settings_obj,
                    client=journal.client_for_reconciliation(),
                    limit=max(1, int(args.reconcile_limit)),
                    persist=True,
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
