"""TigerBeetle reconciliation for Torghut ledger references."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.config import Settings, settings
from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleReconciliationRun,
    coerce_json_payload,
)
from app.trading.tigerbeetle_client import (
    TigerBeetleClientProtocol,
    create_tigerbeetle_client,
)
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    execution_tca_metric_source_id,
    build_order_event_transfer_plan,
)
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
)

from .shared_context import (
    BLOCKER_AMOUNT_MISMATCH,
    BLOCKER_CLIENT_UNAVAILABLE,
    BLOCKER_CODE_MISMATCH,
    BLOCKER_CREDIT_ACCOUNT_MISMATCH,
    BLOCKER_DEBIT_ACCOUNT_MISMATCH,
    BLOCKER_LEDGER_MISMATCH,
    BLOCKER_POSTGRES_REF_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING,
    BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING,
    BLOCKER_SOURCE_AMOUNT_MISMATCH,
    BLOCKER_SOURCE_ROW_MISSING,
    BLOCKER_STABLE_REF_PAYLOAD_MISMATCH,
    BLOCKER_TRANSFER_MISSING,
    BLOCKER_UNLINKED_COST,
    BLOCKER_UNLINKED_EVENT,
    BLOCKER_UNLINKED_EXECUTION,
    BLOCKER_UNLINKED_RUNTIME_LEDGER,
    SCHEMA_VERSION,
    append_sample as _append_sample,
    archived_runtime_ledger_amount_micros as _archived_runtime_ledger_amount_micros,
    attr as _attr,
    compact_reconciliation_ref_counts as _compact_reconciliation_ref_counts,
    expected_source_amount_micros as _expected_source_amount_micros,
    legacy_unversioned_source_ref as _legacy_unversioned_source_ref,
    order_event_ref_exists as _order_event_ref_exists,
    payload_int as _payload_int,
    payload_value as _payload_value,
    ref_matches_expected_event as _ref_matches_expected_event,
    ref_sample as _ref_sample,
    source_ref_exists as _source_ref_exists,
    stable_ref_matches as _stable_ref_matches,
    transfer_lookup_key as _transfer_lookup_key,
    u128_text as _u128_text,
    uuid_or_none as _uuid_or_none,
)

from .runtime_ledger_ref_coverage import (
    latest_run_compact_status_payload as _latest_run_compact_status_payload,
    latest_run_payload as _latest_run_payload,
    reconciliation_transfer_refs as _reconciliation_transfer_refs,
    runtime_ledger_ref_matches_expected_bucket as _runtime_ledger_ref_matches_expected_bucket,
    tigerbeetle_ref_counts,
)


# ---------------------------------------------------------------------------
# Payload dataclass
# ---------------------------------------------------------------------------

@dataclass
class _ReconciliationState:
    counts: _ReconciliationCounts = field(default_factory=_empty_counts)
    blockers: list[str] = field(default_factory=list)
    mismatched_refs: list[dict[str, object]] = field(default_factory=list)
    missing_transfer_refs: list[dict[str, object]] = field(default_factory=list)
    missing_source_rows: list[dict[str, object]] = field(default_factory=list)
    unlinked_refs: list[dict[str, object]] = field(default_factory=list)
    legacy_source_amount_unverifiable_refs: list[dict[str, object]] = field(default_factory=list)
    transfer_lookup: dict[str, object] = field(default_factory=dict)
    client_lookup_ok: bool = True
    client_error: str | None = None


@dataclass
class _ReconciliationCounts:
    checked_transfer_count: int = 0
    missing_transfer_count: int = 0
    mismatched_transfer_count: int = 0
    source_row_missing_count: int = 0
    source_amount_mismatch_count: int = 0
    legacy_source_amount_unverifiable_count: int = 0
    runtime_ledger_checked_transfer_count: int = 0
    runtime_ledger_signed_transfer_count: int = 0
    runtime_ledger_missing_signed_ref_count: int = 0
    runtime_ledger_missing_account_ref_count: int = 0
    archived_runtime_ledger_source_missing_count: int = 0
    runtime_ledger_direction_mismatch_count: int = 0
    runtime_ledger_metadata_mismatch_count: int = 0
    stable_ref_mismatch_count: int = 0
    unlinked_event_count: int = 0
    unlinked_execution_count: int = 0
    unlinked_cost_count: int = 0
    unlinked_runtime_ledger_count: int = 0


def _empty_counts() -> _ReconciliationCounts:
    return _ReconciliationCounts()


# ---------------------------------------------------------------------------
# Single transfer processing
# ---------------------------------------------------------------------------

def _process_single_transfer(
    session: Session,
    ref: Any,  # type: ignore[name-defined]
    actual: dict[str, object] | None,
    client_lookup_ok: bool,
    ref_transfer_id: str,
    counts: _ReconciliationCounts,
    blockers: list[str],
    mismatched_refs: list[dict[str, object]],
) -> None:
    """Validate a single transfer against expected state."""

    if not _stable_ref_matches(ref):
        counts.stable_ref_mismatch_count += 1
        counts.mismatched_transfer_count += 1
        blockers.append(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH)
        _append_sample(
            mismatched_refs,
            _ref_sample(
                ref,
                blocker=BLOCKER_STABLE_REF_PAYLOAD_MISMATCH,
                reason="stable_ref_payload_does_not_match_transfer_ref_identity",
            ),
        )
        return

    if not client_lookup_ok:
        return

    if actual is None:
        counts.missing_transfer_count += 1
        blockers.append(BLOCKER_TRANSFER_MISSING)
        _append_sample(
            mismatched_refs,
            _ref_sample(
                ref,
                blocker=BLOCKER_TRANSFER_MISSING,
                reason="transfer_ref_not_found_in_tigerbeetle_lookup",
            ),
        )
        return

    _validate_transfer_fields(ref, actual, counts, blockers, mismatched_refs)
    _validate_event_ref(session, ref, actual, counts, blockers, mismatched_refs)


def _validate_transfer_fields(
    ref: Any,
    actual: dict[str, object],
    counts: _ReconciliationCounts,
    blockers: list[str],
    mismatched_refs: list[dict[str, object]],
) -> None:
    _check_field(ref, actual, counts, blockers, mismatched_refs, "amount", lambda a, r: Decimal(str(_attr(a, "amount"))) != r.amount, BLOCKER_AMOUNT_MISMATCH)
    _check_field(ref, actual, counts, blockers, mismatched_refs, "code", lambda a, r: int(str(_attr(a, "code"))) != r.code, BLOCKER_CODE_MISMATCH)
    _check_field(ref, actual, counts, blockers, mismatched_refs, "ledger", lambda a, r: int(str(_attr(a, "ledger"))) != r.ledger, BLOCKER_LEDGER_MISMATCH)

    debit_account_id = _payload_value(ref, "debit_account_id")
    if debit_account_id is not None and _u128_text(_attr(actual, "debit_account_id")) != _u128_text(debit_account_id):
        _check_and_append(counts, blockers, mismatched_refs, ref, BLOCKER_DEBIT_ACCOUNT_MISMATCH, "actual_debit_account_differs_from_transfer_ref_payload", actual)

    credit_account_id = _payload_value(ref, "credit_account_id")
    if credit_account_id is not None and _u128_text(_attr(actual, "credit_account_id")) != _u128_text(credit_account_id):
        _check_and_append(counts, blockers, mismatched_refs, ref, BLOCKER_CREDIT_ACCOUNT_MISMATCH, "actual_credit_account_differs_from_transfer_ref_payload", actual)


def _check_field(
    ref: Any,
    actual: dict[str, object],
    counts: _ReconciliationCounts,
    blockers: list[str],
    mismatched_refs: list[dict[str, object]],
    field_name: str,
    check_fn: object,
    blocker: str,
) -> None:
    if check_fn(actual, ref):
        counts.mismatched_transfer_count += 1
        blockers.append(blocker)
        mismatched_refs.append(_ref_sample(ref, blocker=blocker, reason=f"actual_{field_name}_differs_from_transfer_ref", actual=actual))


def _check_and_append(
    counts: _ReconciliationCounts,
    blockers: list[str],
    mismatched_refs: list[dict[str, object]],
    ref: Any,
    blocker: str,
    reason: str,
    actual: dict[str, object],
) -> None:
    counts.mismatched_transfer_count += 1
    blockers.append(blocker)
    mismatched_refs.append(_ref_sample(ref, blocker=blocker, reason=reason, actual=actual))


def _validate_event_ref(
    session: Session,
    ref: Any,
    actual: dict[str, object],
    counts: _ReconciliationCounts,
    blockers: list[str],
    mismatched_refs: list[dict[str, object]],
) -> None:
    if not _ref_matches_expected_event(session, ref, settings_obj=settings):
        counts.mismatched_transfer_count += 1
        blockers.append(BLOCKER_POSTGRES_REF_MISMATCH)
        _append_sample(
            mismatched_refs,
            _ref_sample(
                ref,
                blocker=BLOCKER_POSTGRES_REF_MISMATCH,
                reason="transfer_ref_no_longer_matches_order_event_plan",
                actual=actual,
            ),
        )

    if ref.source_type in {SOURCE_TYPE_EXECUTION, SOURCE_TYPE_EXECUTION_TCA_METRIC, SOURCE_TYPE_RUNTIME_LEDGER_BUCKET}:
        _validate_source_amount(session, ref, actual, counts, blockers, mismatched_refs)

    if ref.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET:
        _validate_runtime_ledger(session, ref, actual, counts, blockers, mismatched_refs)


def _validate_source_amount(
    session: Session,
    ref: Any,
    actual: dict[str, object],
    counts: _ReconciliationCounts,
    blockers: list[str],
    mismatched_refs: list[dict[str, object]],
) -> None:
    expected_source_amount = _expected_source_amount_micros(session, ref)
    if expected_source_amount is None:
        archived_amount = _archived_runtime_ledger_amount_micros(ref)
        if archived_amount is not None and ref.amount == archived_amount:
            counts.archived_runtime_ledger_source_missing_count += 1
        else:
            counts.source_row_missing_count += 1
            blockers.append(BLOCKER_SOURCE_ROW_MISSING)
            _append_sample(
                mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_SOURCE_ROW_MISSING,
                    reason="source_row_missing_or_source_id_not_uuid",
                    actual=actual,
                ),
            )
    elif ref.amount != expected_source_amount:
        if _legacy_unversioned_source_ref(ref):
            counts.legacy_source_amount_unverifiable_count += 1
            _append_sample(
                mismatched_refs,
                _ref_sample(
                    ref,
                    blocker="tigerbeetle_legacy_source_amount_unverifiable",
                    reason="legacy_source_ref_lacks_revision_or_archived_amount",
                    actual=actual,
                ),
            )
        else:
            counts.source_amount_mismatch_count += 1
            blockers.append(BLOCKER_SOURCE_AMOUNT_MISMATCH)
            _append_sample(
                mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_SOURCE_AMOUNT_MISMATCH,
                    reason="source_amount_micros_differs_from_transfer_ref",
                    actual=actual,
                ),
            )


def _validate_runtime_ledger(
    session: Session,
    ref: Any,
    actual: dict[str, object],
    counts: _ReconciliationCounts,
    blockers: list[str],
    mismatched_refs: list[dict[str, object]],
) -> None:
    counts.runtime_ledger_checked_transfer_count += 1
    source_uuid = _uuid_or_none(ref.source_id)
    bucket = session.get(StrategyRuntimeLedgerBucket, source_uuid) if source_uuid is not None else None
    if bucket is not None and actual is not None:
        direction_matches, metadata_matches = _runtime_ledger_ref_matches_expected_bucket(ref, actual, bucket)
        if direction_matches:
            counts.runtime_ledger_signed_transfer_count += 1
        else:
            counts.runtime_ledger_direction_mismatch_count += 1
            counts.mismatched_transfer_count += 1
            blockers.append(BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH)
            _append_sample(
                mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH,
                    reason="runtime_ledger_signed_direction_or_accounts_mismatch",
                    actual=actual,
                ),
            )
        if not metadata_matches:
            counts.runtime_ledger_metadata_mismatch_count += 1
            counts.mismatched_transfer_count += 1
            blockers.append(BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH)
            _append_sample(
                mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH,
                    reason="runtime_ledger_metadata_mismatch",
                    actual=actual,
                ),
            )


# ---------------------------------------------------------------------------
# Unlinked queries
# ---------------------------------------------------------------------------

def _query_unlinked_events(
    session: Session,
    settings_obj: Settings,
    limit: int,
    blockers: list[str],
    unlinked_refs: list[dict[str, object]],
) -> int:
    unlinked_event_count = 0
    recent_events = session.execute(select(ExecutionOrderEvent).order_by(ExecutionOrderEvent.created_at.desc()).limit(limit)).scalars().all()
    for event in recent_events:
        if _order_event_ref_exists(session, event, settings_obj=settings_obj):
            continue
        if build_order_event_transfer_plan(session, event, settings_obj=settings_obj) is None:
            continue
        unlinked_event_count += 1
        _append_sample(
            unlinked_refs,
            {"blocker": BLOCKER_UNLINKED_EVENT, "source_type": SOURCE_TYPE_EXECUTION_ORDER_EVENT, "source_id": str(event.id), "event_fingerprint": event.event_fingerprint},
        )
    if unlinked_event_count:
        blockers.append(BLOCKER_UNLINKED_EVENT)
    return unlinked_event_count


def _query_unlinked_executions(
    session: Session,
    settings_obj: Settings,
    limit: int,
    blockers: list[str],
    unlinked_refs: list[dict[str, object]],
) -> int:
    unlinked_execution_count = 0
    recent_executions = session.execute(select(Execution).where(Execution.avg_fill_price.is_not(None), Execution.filled_qty > 0).order_by(Execution.created_at.desc()).limit(limit)).scalars().all()
    for execution in recent_executions:
        if _source_ref_exists(session, settings_obj=settings_obj, source_type=SOURCE_TYPE_EXECUTION, source_id=str(execution.id), transfer_kind=TRANSFER_KIND_EXECUTION_FILL, source_pk=execution.id):
            continue
        unlinked_execution_count += 1
        _append_sample(
            unlinked_refs,
            {"blocker": BLOCKER_UNLINKED_EXECUTION, "source_type": SOURCE_TYPE_EXECUTION, "source_id": str(execution.id), "alpaca_order_id": execution.alpaca_order_id},
        )
    if unlinked_execution_count:
        blockers.append(BLOCKER_UNLINKED_EXECUTION)
    return unlinked_execution_count


def _query_unlinked_costs(
    session: Session,
    settings_obj: Settings,
    limit: int,
    blockers: list[str],
    unlinked_refs: list[dict[str, object]],
) -> int:
    unlinked_cost_count = 0
    recent_cost_metrics = session.execute(select(ExecutionTCAMetric).where(ExecutionTCAMetric.shortfall_notional.is_not(None), ExecutionTCAMetric.shortfall_notional != 0).order_by(ExecutionTCAMetric.computed_at.desc()).limit(limit)).scalars().all()
    for metric in recent_cost_metrics:
        if _source_ref_exists(session, settings_obj=settings_obj, source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC, source_id=execution_tca_metric_source_id(metric), transfer_kind=TRANSFER_KIND_EXECUTION_COST, source_pk=metric.id):
            continue
        unlinked_cost_count += 1
        _append_sample(
            unlinked_refs,
            {"blocker": BLOCKER_UNLINKED_COST, "source_type": SOURCE_TYPE_EXECUTION_TCA_METRIC, "source_id": execution_tca_metric_source_id(metric), "execution_id": str(metric.execution_id)},
        )
    if unlinked_cost_count:
        blockers.append(BLOCKER_UNLINKED_COST)
    return unlinked_cost_count


def _query_unlinked_runtime_buckets(
    session: Session,
    settings_obj: Settings,
    limit: int,
    account_label: str | None,
    blockers: list[str],
    unlinked_refs: list[dict[str, object]],
) -> int:
    unlinked_runtime_ledger_count = 0
    runtime_bucket_filters: list[ColumnElement[bool]] = [
        (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0) | (StrategyRuntimeLedgerBucket.cost_amount != 0)
    ]
    if account_label:
        runtime_bucket_filters.append(StrategyRuntimeLedgerBucket.account_label == account_label)
    recent_runtime_buckets = session.execute(select(StrategyRuntimeLedgerBucket).where(*runtime_bucket_filters).order_by(StrategyRuntimeLedgerBucket.bucket_ended_at.desc()).limit(limit)).scalars().all()
    for bucket in recent_runtime_buckets:
        if _source_ref_exists(session, settings_obj=settings_obj, source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET, source_id=str(bucket.id), transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL, source_pk=bucket.id):
            continue
        unlinked_runtime_ledger_count += 1
        _append_sample(
            unlinked_refs,
            {"blocker": BLOCKER_UNLINKED_RUNTIME_LEDGER, "source_type": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET, "source_id": str(bucket.id), "run_id": bucket.run_id, "candidate_id": bucket.candidate_id},
        )
    if unlinked_runtime_ledger_count:
        blockers.append(BLOCKER_UNLINKED_RUNTIME_LEDGER)
    return unlinked_runtime_ledger_count


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------

def _assemble_reconciliation_payload(
    settings_obj: Settings,
    started_at: datetime,
    finished_at: datetime,
    payload: dict[str, object],
    missing_transfer_refs: list[dict[str, object]],
    mismatched_refs: list[dict[str, object]],
    missing_source_rows: list[dict[str, object]],
    unlinked_refs: list[dict[str, object]],
    legacy_source_amount_unverifiable_refs: list[dict[str, object]],
) -> dict[str, object]:
    payload["blocker_details"] = {
        "missing_transfer_refs": missing_transfer_refs,
        "mismatched_refs": mismatched_refs,
        "missing_source_rows": missing_source_rows,
        "unlinked_refs": unlinked_refs,
        "legacy_source_amount_unverifiable_refs": legacy_source_amount_unverifiable_refs,
    }
    return payload


def _build_payload_dict(
    settings_obj: Settings,
    started_at: datetime,
    finished_at: datetime,
    counts: _ReconciliationCounts,
    ref_counts: dict[str, object],
    client_lookup_ok: bool,
    client_error: str | None,
    unique_blockers: list[str],
    source_missing_count: int,
    stable_ref_mismatch_count: int,
    ref_count_stable_ref_mismatch_count: int,
    stable_ref_mismatch_actual: int,
) -> dict[str, object]:
    ok = not unique_blockers
    max_age_seconds = max(1, int(settings_obj.tigerbeetle_reconcile_max_age_seconds))
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": ok,
        "cluster_id": settings_obj.tigerbeetle_cluster_id,
        "account_label": None,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "age_seconds": 0,
        "reconciliation_stale": False,
        "reconciliation_max_age_seconds": max_age_seconds,
        "reconciliation_freshness": {"observed_at": finished_at.isoformat(), "age_seconds": 0, "max_age_seconds": max_age_seconds, "stale": False},
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "client_lookup_ok": client_lookup_ok,
        "client_error": client_error,
        "account_ref_count": _payload_int(ref_counts, "account_ref_count"),
        "transfer_ref_count": _payload_int(ref_counts, "transfer_ref_count"),
        "checked_transfer_count": counts.checked_transfer_count,
        "missing_transfer_count": counts.missing_transfer_count,
        "mismatched_transfer_count": counts.mismatched_transfer_count,
        "mismatched_ref_count": counts.mismatched_transfer_count,
        "source_missing_count": source_missing_count,
        "source_row_missing_count": counts.source_row_missing_count,
        "missing_source_row_count": counts.source_row_missing_count,
        "source_amount_mismatch_count": counts.source_amount_mismatch_count,
        "legacy_source_amount_unverifiable_count": counts.legacy_source_amount_unverifiable_count,
        "runtime_ledger_checked_transfer_count": counts.runtime_ledger_checked_transfer_count,
        "runtime_ledger_signed_transfer_count": counts.runtime_ledger_signed_transfer_count,
        "runtime_ledger_ref_count": _payload_int(ref_counts, "runtime_ledger_ref_count"),
        "runtime_ledger_signed_ref_count": _payload_int(ref_counts, "runtime_ledger_signed_ref_count"),
        "runtime_ledger_missing_signed_ref_count": counts.runtime_ledger_missing_signed_ref_count,
        "runtime_ledger_missing_account_ref_count": counts.runtime_ledger_missing_account_ref_count,
        "stable_ref_count": _payload_int(ref_counts, "stable_ref_count"),
        "stable_ref_missing_count": _payload_int(ref_counts, "stable_ref_missing_count"),
        "stable_ref_mismatch_count": max(stable_ref_mismatch_count, ref_count_stable_ref_mismatch_count),
        "archived_runtime_ledger_source_missing_count": counts.archived_runtime_ledger_source_missing_count,
        "runtime_ledger_direction_mismatch_count": counts.runtime_ledger_direction_mismatch_count,
        "runtime_ledger_metadata_mismatch_count": counts.runtime_ledger_metadata_mismatch_count,
        "unlinked_event_count": counts.unlinked_event_count,
        "unlinked_order_event_ref_count": counts.unlinked_event_count,
        "unlinked_execution_count": counts.unlinked_execution_count,
        "unlinked_execution_ref_count": counts.unlinked_execution_count,
        "unlinked_cost_count": counts.unlinked_cost_count,
        "unlinked_cost_ref_count": counts.unlinked_cost_count,
        "unlinked_runtime_ledger_count": counts.unlinked_runtime_ledger_count,
        "unlinked_runtime_ledger_ref_count": counts.unlinked_runtime_ledger_count,
        "ref_counts": ref_counts,
        "missing_transfer_refs": [],
        "mismatched_refs": [],
        "missing_source_rows": [],
        "unlinked_refs": [],
        "legacy_source_amount_unverifiable_refs": [],
        "blockers": unique_blockers,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def latest_tigerbeetle_reconciliation_status_payload(
    session: Session,
    *,
    cluster_id: int,
) -> dict[str, object] | None:
    row = (
        session.execute(
            select(
                TigerBeetleReconciliationRun.id,
                TigerBeetleReconciliationRun.cluster_id,
                TigerBeetleReconciliationRun.started_at,
                TigerBeetleReconciliationRun.finished_at,
                TigerBeetleReconciliationRun.status,
                TigerBeetleReconciliationRun.checked_transfer_count,
                TigerBeetleReconciliationRun.missing_transfer_count,
                TigerBeetleReconciliationRun.mismatched_transfer_count,
                TigerBeetleReconciliationRun.source_missing_count,
                TigerBeetleReconciliationRun.account_ref_count,
                TigerBeetleReconciliationRun.transfer_ref_count,
                TigerBeetleReconciliationRun.runtime_ledger_ref_count,
                TigerBeetleReconciliationRun.runtime_ledger_signed_ref_count,
                TigerBeetleReconciliationRun.runtime_ledger_missing_signed_ref_count,
                TigerBeetleReconciliationRun.runtime_ledger_missing_account_ref_count,
                TigerBeetleReconciliationRun.stable_ref_count,
                TigerBeetleReconciliationRun.stable_ref_missing_count,
                TigerBeetleReconciliationRun.stable_ref_mismatch_count,
                TigerBeetleReconciliationRun.blockers_json,
                TigerBeetleReconciliationRun.ref_counts_json,
            )
            .where(TigerBeetleReconciliationRun.cluster_id == cluster_id)
            .order_by(TigerBeetleReconciliationRun.started_at.desc())
            .limit(1)
        )
        .mappings()
        .first()
    )
    return _latest_run_compact_status_payload(
        None if row is None else cast(Mapping[str, object], row)
    )


def latest_tigerbeetle_reconciliation_payload(
    session: Session,
    *,
    cluster_id: int,
) -> dict[str, object] | None:
    row = (
        session.execute(
            select(TigerBeetleReconciliationRun)
            .where(TigerBeetleReconciliationRun.cluster_id == cluster_id)
            .order_by(TigerBeetleReconciliationRun.started_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    return _latest_run_payload(row)


def reconcile_tigerbeetle_transfers(
    session: Session,
    *,
    settings_obj: Settings = settings,
    client: TigerBeetleClientProtocol | None = None,
    limit: int = 500,
    persist: bool = True,
    account_label: str | None = None,
) -> dict[str, object]:
    started_at = datetime.now(timezone.utc)
    return _process_reconciliation(session, settings_obj, client, limit, persist, account_label)


def _process_reconciliation(
    session: Session,
    settings_obj: Settings,
    client: TigerBeetleClientProtocol | None,
    limit: int,
    persist: bool,
    account_label: str | None,
) -> dict[str, object]:
    started_at = datetime.now(timezone.utc)
    state = _run_client_lookup(session, client, settings_obj, limit)
    if state.ref_list:
        _process_refs(session, state.ref_list, state)
    _collect_unlinked(session, settings_obj, limit, state)
    return _build_final_payload(
        session, settings_obj, started_at, persist, account_label, state,
    )


def _build_final_payload(
    session: Session,
    settings_obj: Settings,
    started_at: datetime,
    persist: bool,
    account_label: str | None,
    state: _ReconciliationState,
) -> dict[str, object]:
    finished_at = datetime.now(timezone.utc)
    source_missing_count = (
        state.counts.unlinked_event_count
        + state.counts.unlinked_execution_count
        + state.counts.unlinked_cost_count
        + state.counts.unlinked_runtime_ledger_count
        + state.counts.source_row_missing_count
        + state.counts.source_amount_mismatch_count
    )
    ref_counts = tigerbeetle_ref_counts(session, cluster_id=settings_obj.tigerbeetle_cluster_id, account_label=account_label)
    compact_ref_counts = _compact_reconciliation_ref_counts(ref_counts, cluster_id=settings_obj.tigerbeetle_cluster_id)
    runtime_ledger_missing_signed_ref_count = _payload_int(ref_counts, "runtime_ledger_missing_signed_ref_count")
    runtime_ledger_missing_account_ref_count = _payload_int(ref_counts, "runtime_ledger_missing_account_ref_count")
    ref_count_stable_ref_mismatch_count = _payload_int(ref_counts, "stable_ref_mismatch_count")
    if runtime_ledger_missing_signed_ref_count:
        state.blockers.append(BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING)
    if runtime_ledger_missing_account_ref_count:
        state.blockers.append(BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING)
    if ref_count_stable_ref_mismatch_count:
        state.blockers.append(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH)
    unique_blockers = sorted(set(state.blockers))

    payload = _build_payload_dict(
        settings_obj,
        started_at,
        finished_at,
        state.counts,
        ref_counts,
        compact_ref_counts,
        state.client_lookup_ok,
        state.client_error,
        unique_blockers,
        source_missing_count,
        state.counts.stable_ref_mismatch_count,
        ref_count_stable_ref_mismatch_count,
        state.counts.stable_ref_mismatch_count,
    )
    payload = _assemble_reconciliation_payload(
        settings_obj,
        started_at,
        finished_at,
        payload,
        state.missing_transfer_refs,
        state.mismatched_refs,
        state.missing_source_rows,
        state.unlinked_refs,
        state.legacy_source_amount_unverifiable_refs,
    )
    payload["account_label"] = account_label

    if persist:
        _persist_reconciliation_run(
            session,
            settings_obj,
            started_at,
            finished_at,
            unique_blockers,
            ref_counts,
            compact_ref_counts,
            payload,
            state.counts,
        )
    return payload


def _persist_reconciliation_run(
    session: Session,
    settings_obj: Settings,
    started_at: datetime,
    finished_at: datetime,
    unique_blockers: list[str],
    ref_counts: dict[str, object],
    compact_ref_counts: dict[str, object],
    payload: dict[str, object],
    counts: _ReconciliationCounts,
) -> None:
    session.add(
        TigerBeetleReconciliationRun(
            cluster_id=settings_obj.tigerbeetle_cluster_id,
            started_at=started_at,
            finished_at=finished_at,
            status="ok" if not unique_blockers else "degraded",
            checked_transfer_count=counts.checked_transfer_count,
            missing_transfer_count=counts.missing_transfer_count,
            mismatched_transfer_count=counts.mismatched_transfer_count,
            source_missing_count=counts.source_row_missing_count + counts.source_amount_mismatch_count + counts.unlinked_event_count + counts.unlinked_execution_count + counts.unlinked_cost_count + counts.unlinked_runtime_ledger_count,
            account_ref_count=_payload_int(compact_ref_counts, "account_ref_count"),
            transfer_ref_count=_payload_int(compact_ref_counts, "transfer_ref_count"),
            runtime_ledger_ref_count=_payload_int(compact_ref_counts, "runtime_ledger_ref_count"),
            runtime_ledger_signed_ref_count=_payload_int(compact_ref_counts, "runtime_ledger_signed_ref_count"),
            runtime_ledger_missing_signed_ref_count=counts.runtime_ledger_missing_signed_ref_count,
            runtime_ledger_missing_account_ref_count=counts.runtime_ledger_missing_account_ref_count,
            stable_ref_count=_payload_int(compact_ref_counts, "stable_ref_count"),
            stable_ref_missing_count=_payload_int(compact_ref_counts, "stable_ref_missing_count"),
            stable_ref_mismatch_count=max(counts.stable_ref_mismatch_count, _payload_int(ref_counts, "stable_ref_mismatch_count")),
            blockers_json=coerce_json_payload(unique_blockers),
            ref_counts_json=coerce_json_payload(compact_ref_counts),
            payload_json=coerce_json_payload(payload),
        )
    )
    session.flush()


__all__ = (
    "latest_tigerbeetle_reconciliation_status_payload",
    "latest_tigerbeetle_reconciliation_payload",
    "reconcile_tigerbeetle_transfers",
)
