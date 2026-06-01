"""TigerBeetle reconciliation for Torghut ledger references."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
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
    build_order_event_transfer_plan,
)
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    decimal_usd_to_nearest_micros,
)


SCHEMA_VERSION = "torghut.tigerbeetle-reconciliation.v1"
BLOCKER_TRANSFER_MISSING = "tigerbeetle_transfer_missing"
BLOCKER_AMOUNT_MISMATCH = "tigerbeetle_transfer_amount_mismatch"
BLOCKER_CODE_MISMATCH = "tigerbeetle_transfer_code_mismatch"
BLOCKER_LEDGER_MISMATCH = "tigerbeetle_transfer_ledger_mismatch"
BLOCKER_DEBIT_ACCOUNT_MISMATCH = "tigerbeetle_transfer_debit_account_mismatch"
BLOCKER_CREDIT_ACCOUNT_MISMATCH = "tigerbeetle_transfer_credit_account_mismatch"
BLOCKER_POSTGRES_REF_MISMATCH = "tigerbeetle_postgres_ref_mismatch"
BLOCKER_UNLINKED_EVENT = "tigerbeetle_unlinked_order_event"
BLOCKER_UNLINKED_EXECUTION = "tigerbeetle_unlinked_execution"
BLOCKER_UNLINKED_COST = "tigerbeetle_unlinked_execution_cost"
BLOCKER_UNLINKED_RUNTIME_LEDGER = "tigerbeetle_unlinked_runtime_ledger"
BLOCKER_SOURCE_ROW_MISSING = "tigerbeetle_source_row_missing"
BLOCKER_SOURCE_AMOUNT_MISMATCH = "tigerbeetle_source_amount_mismatch"
BLOCKER_CLIENT_UNAVAILABLE = "tigerbeetle_client_unavailable"


def _attr(value: object, name: str) -> Any:
    if isinstance(value, Mapping):
        value_mapping = cast(Mapping[str, Any], value)
        result = value_mapping.get(name)
        if result is None and name == "id":
            result = value_mapping.get("transfer_id")
        return result
    if hasattr(value, name):
        return getattr(value, name)
    if name == "id" and hasattr(value, "transfer_id"):
        return getattr(value, "transfer_id")
    raise AttributeError(name)


def _payload_value(row: TigerBeetleTransferRef, key: str) -> str | None:
    raw_payload = cast(object, row.payload_json)
    payload: Mapping[str, object] = (
        cast(Mapping[str, object], raw_payload)
        if isinstance(raw_payload, Mapping)
        else cast(Mapping[str, object], {})
    )
    value: object | None = payload.get(key)
    return None if value is None else str(value)


def _ref_matches_expected_event(
    session: Session,
    ref: TigerBeetleTransferRef,
    *,
    settings_obj: Settings,
) -> bool:
    event = (
        session.get(ExecutionOrderEvent, ref.execution_order_event_id)
        if ref.execution_order_event_id is not None
        else None
    )
    if event is None:
        return True
    plan = build_order_event_transfer_plan(session, event, settings_obj=settings_obj)
    if plan is None:
        return False
    expected = plan.transfer_spec
    return (
        ref.transfer_id == str(expected.transfer_id)
        and ref.transfer_kind == plan.transfer_kind
        and ref.amount == Decimal(expected.amount)
        and ref.ledger == expected.ledger
        and ref.code == expected.code
        and _payload_value(ref, "debit_account_id") == str(expected.debit_account_id)
        and _payload_value(ref, "credit_account_id") == str(expected.credit_account_id)
    )


def _order_event_ref_exists(
    session: Session,
    event: ExecutionOrderEvent,
    *,
    settings_obj: Settings,
) -> bool:
    clauses = [
        TigerBeetleTransferRef.execution_order_event_id == event.id,
        (
            (TigerBeetleTransferRef.source_type == SOURCE_TYPE_EXECUTION_ORDER_EVENT)
            & (TigerBeetleTransferRef.source_id == str(event.id))
        ),
    ]
    if event.event_fingerprint:
        clauses.append(
            (TigerBeetleTransferRef.source_type == SOURCE_TYPE_EXECUTION_ORDER_EVENT)
            & (TigerBeetleTransferRef.event_fingerprint == event.event_fingerprint)
        )
    return (
        session.scalar(
            select(TigerBeetleTransferRef.id)
            .where(
                TigerBeetleTransferRef.cluster_id
                == settings_obj.tigerbeetle_cluster_id,
                or_(*clauses),
            )
            .limit(1)
        )
        is not None
    )


def _source_ref_exists(
    session: Session,
    *,
    settings_obj: Settings,
    source_type: str,
    source_id: str,
    transfer_kind: str,
) -> bool:
    return (
        session.scalar(
            select(TigerBeetleTransferRef.id)
            .where(
                TigerBeetleTransferRef.cluster_id
                == settings_obj.tigerbeetle_cluster_id,
                TigerBeetleTransferRef.source_type == source_type,
                TigerBeetleTransferRef.source_id == source_id,
                TigerBeetleTransferRef.transfer_kind == transfer_kind,
            )
            .limit(1)
        )
        is not None
    )


def _payload_int(payload: Mapping[str, object], key: str) -> int:
    value = payload.get(key)
    if value is None:
        return 0
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _uuid_or_none(value: str | None) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


def _usd_to_micros(value: Decimal | None) -> Decimal | None:
    if value is None:
        return None
    scaled = Decimal(decimal_usd_to_nearest_micros(abs(Decimal(str(value)))))
    if scaled <= 0:
        return None
    return scaled


def _execution_amount_micros(execution: Execution | None) -> Decimal | None:
    if execution is None or execution.avg_fill_price is None:
        return None
    return _usd_to_micros(
        Decimal(str(execution.filled_qty)) * Decimal(str(execution.avg_fill_price))
    )


def _cost_amount_micros(metric: ExecutionTCAMetric | None) -> Decimal | None:
    if metric is None:
        return None
    return _usd_to_micros(metric.shortfall_notional)


def _runtime_ledger_amount_micros(
    bucket: StrategyRuntimeLedgerBucket | None,
) -> Decimal | None:
    if bucket is None:
        return None
    amount_source = (
        bucket.net_strategy_pnl_after_costs
        if bucket.net_strategy_pnl_after_costs != Decimal("0")
        else bucket.cost_amount
    )
    return _usd_to_micros(amount_source)


def _expected_source_amount_micros(
    session: Session,
    ref: TigerBeetleTransferRef,
) -> Decimal | None:
    source_uuid = _uuid_or_none(ref.source_id)
    if source_uuid is None:
        return None
    if ref.source_type == SOURCE_TYPE_EXECUTION:
        return _execution_amount_micros(session.get(Execution, source_uuid))
    if ref.source_type == SOURCE_TYPE_EXECUTION_TCA_METRIC:
        return _cost_amount_micros(session.get(ExecutionTCAMetric, source_uuid))
    if ref.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET:
        return _runtime_ledger_amount_micros(
            session.get(StrategyRuntimeLedgerBucket, source_uuid)
        )
    return None


def tigerbeetle_ref_counts(session: Session, *, cluster_id: int) -> dict[str, object]:
    source_rows = session.execute(
        select(
            TigerBeetleTransferRef.source_type,
            func.count(TigerBeetleTransferRef.id),
        )
        .where(TigerBeetleTransferRef.cluster_id == cluster_id)
        .group_by(TigerBeetleTransferRef.source_type)
    ).all()
    by_source = {
        str(source_type or "unknown"): int(count) for source_type, count in source_rows
    }
    total = session.scalar(
        select(func.count(TigerBeetleTransferRef.id)).where(
            TigerBeetleTransferRef.cluster_id == cluster_id
        )
    )
    return {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": cluster_id,
        "transfer_ref_count": int(total or 0),
        "by_source_type": by_source,
        "order_event_ref_count": by_source.get(SOURCE_TYPE_EXECUTION_ORDER_EVENT, 0),
        "execution_ref_count": by_source.get(SOURCE_TYPE_EXECUTION, 0),
        "cost_ref_count": by_source.get(SOURCE_TYPE_EXECUTION_TCA_METRIC, 0),
        "runtime_ledger_ref_count": by_source.get(
            SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            0,
        ),
    }


def _latest_run_payload(
    row: TigerBeetleReconciliationRun | None,
) -> dict[str, object] | None:
    if row is None:
        return None
    raw_payload_json = cast(object, getattr(row, "payload_json", None))
    payload = (
        cast(dict[str, object], raw_payload_json)
        if isinstance(raw_payload_json, dict)
        else {}
    )
    raw_blockers = payload.get("blockers")
    blockers = (
        [str(item) for item in cast(Sequence[object], raw_blockers)]
        if isinstance(raw_blockers, Sequence)
        and not isinstance(raw_blockers, (str, bytes, bytearray))
        else []
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": row.status == "ok",
        "cluster_id": row.cluster_id,
        "status": row.status,
        "checked_transfer_count": row.checked_transfer_count,
        "missing_transfer_count": row.missing_transfer_count,
        "mismatched_transfer_count": row.mismatched_transfer_count,
        "source_missing_count": row.source_missing_count,
        "source_row_missing_count": _payload_int(payload, "source_row_missing_count"),
        "source_amount_mismatch_count": _payload_int(
            payload, "source_amount_mismatch_count"
        ),
        "unlinked_event_count": _payload_int(payload, "unlinked_event_count"),
        "unlinked_execution_count": _payload_int(payload, "unlinked_execution_count"),
        "unlinked_cost_count": _payload_int(payload, "unlinked_cost_count"),
        "unlinked_runtime_ledger_count": int(
            _payload_int(payload, "unlinked_runtime_ledger_count")
        ),
        "ref_counts": payload.get("ref_counts") or {},
        "started_at": row.started_at.isoformat(),
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        "blockers": blockers,
    }


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
) -> dict[str, object]:
    started_at = datetime.now(timezone.utc)
    refs = (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(
                TigerBeetleTransferRef.cluster_id == settings_obj.tigerbeetle_cluster_id
            )
            .order_by(TigerBeetleTransferRef.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    checked_transfer_count = len(refs)
    missing_transfer_count = 0
    mismatched_transfer_count = 0
    source_row_missing_count = 0
    source_amount_mismatch_count = 0
    blockers: list[str] = []

    transfer_lookup: dict[str, object] = {}
    owned_client = client is None
    tb_client: TigerBeetleClientProtocol | None = None
    try:
        if refs:
            tb_client = client or create_tigerbeetle_client(settings_obj)
            looked_up = tb_client.lookup_transfers(
                [int(ref.transfer_id) for ref in refs]
            )
            transfer_lookup = {str(_attr(item, "id")): item for item in looked_up}
    except Exception:
        blockers.append(BLOCKER_CLIENT_UNAVAILABLE)
    finally:
        if owned_client and tb_client is not None:
            close = getattr(tb_client, "close", None)
            if callable(close):
                close()

    for ref in refs:
        actual = transfer_lookup.get(ref.transfer_id)
        if actual is None:
            missing_transfer_count += 1
            blockers.append(BLOCKER_TRANSFER_MISSING)
            continue
        if Decimal(str(_attr(actual, "amount"))) != ref.amount:
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_AMOUNT_MISMATCH)
        if int(_attr(actual, "code")) != ref.code:
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_CODE_MISMATCH)
        if int(_attr(actual, "ledger")) != ref.ledger:
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_LEDGER_MISMATCH)
        if _payload_value(ref, "debit_account_id") is not None and int(
            _attr(actual, "debit_account_id")
        ) != int(_payload_value(ref, "debit_account_id") or "0"):
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_DEBIT_ACCOUNT_MISMATCH)
        if _payload_value(ref, "credit_account_id") is not None and int(
            _attr(actual, "credit_account_id")
        ) != int(_payload_value(ref, "credit_account_id") or "0"):
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_CREDIT_ACCOUNT_MISMATCH)
        if not _ref_matches_expected_event(
            session,
            ref,
            settings_obj=settings_obj,
        ):
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_POSTGRES_REF_MISMATCH)
        if ref.source_type in {
            SOURCE_TYPE_EXECUTION,
            SOURCE_TYPE_EXECUTION_TCA_METRIC,
            SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
        }:
            expected_source_amount = _expected_source_amount_micros(session, ref)
            if expected_source_amount is None:
                source_row_missing_count += 1
                blockers.append(BLOCKER_SOURCE_ROW_MISSING)
            elif ref.amount != expected_source_amount:
                source_amount_mismatch_count += 1
                blockers.append(BLOCKER_SOURCE_AMOUNT_MISMATCH)

    recent_events = (
        session.execute(
            select(ExecutionOrderEvent)
            .order_by(ExecutionOrderEvent.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    unlinked_event_count = sum(
        1
        for event in recent_events
        if not _order_event_ref_exists(session, event, settings_obj=settings_obj)
        and build_order_event_transfer_plan(
            session,
            event,
            settings_obj=settings_obj,
        )
        is not None
    )
    if unlinked_event_count:
        blockers.append(BLOCKER_UNLINKED_EVENT)

    recent_executions = (
        session.execute(
            select(Execution)
            .where(
                Execution.avg_fill_price.is_not(None),
                Execution.filled_qty > 0,
            )
            .order_by(Execution.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    unlinked_execution_count = sum(
        1
        for execution in recent_executions
        if not _source_ref_exists(
            session,
            settings_obj=settings_obj,
            source_type=SOURCE_TYPE_EXECUTION,
            source_id=str(execution.id),
            transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
        )
    )
    if unlinked_execution_count:
        blockers.append(BLOCKER_UNLINKED_EXECUTION)

    recent_cost_metrics = (
        session.execute(
            select(ExecutionTCAMetric)
            .where(
                ExecutionTCAMetric.shortfall_notional.is_not(None),
                ExecutionTCAMetric.shortfall_notional != 0,
            )
            .order_by(ExecutionTCAMetric.computed_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    unlinked_cost_count = sum(
        1
        for metric in recent_cost_metrics
        if not _source_ref_exists(
            session,
            settings_obj=settings_obj,
            source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
            source_id=str(metric.id),
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
        )
    )
    if unlinked_cost_count:
        blockers.append(BLOCKER_UNLINKED_COST)

    recent_runtime_buckets = (
        session.execute(
            select(StrategyRuntimeLedgerBucket)
            .where(
                (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
                | (StrategyRuntimeLedgerBucket.cost_amount != 0)
            )
            .order_by(StrategyRuntimeLedgerBucket.bucket_ended_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    unlinked_runtime_ledger_count = sum(
        1
        for bucket in recent_runtime_buckets
        if not _source_ref_exists(
            session,
            settings_obj=settings_obj,
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id=str(bucket.id),
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
        )
    )
    if unlinked_runtime_ledger_count:
        blockers.append(BLOCKER_UNLINKED_RUNTIME_LEDGER)

    unique_blockers = sorted(set(blockers))
    ok = not unique_blockers
    finished_at = datetime.now(timezone.utc)
    source_missing_count = (
        unlinked_event_count
        + unlinked_execution_count
        + unlinked_cost_count
        + unlinked_runtime_ledger_count
        + source_row_missing_count
        + source_amount_mismatch_count
    )
    ref_counts = tigerbeetle_ref_counts(
        session,
        cluster_id=settings_obj.tigerbeetle_cluster_id,
    )
    payload: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "ok": ok,
        "cluster_id": settings_obj.tigerbeetle_cluster_id,
        "checked_transfer_count": checked_transfer_count,
        "missing_transfer_count": missing_transfer_count,
        "mismatched_transfer_count": mismatched_transfer_count,
        "source_missing_count": source_missing_count,
        "source_row_missing_count": source_row_missing_count,
        "source_amount_mismatch_count": source_amount_mismatch_count,
        "unlinked_event_count": unlinked_event_count,
        "unlinked_execution_count": unlinked_execution_count,
        "unlinked_cost_count": unlinked_cost_count,
        "unlinked_runtime_ledger_count": unlinked_runtime_ledger_count,
        "ref_counts": ref_counts,
        "blockers": unique_blockers,
    }
    if persist:
        session.add(
            TigerBeetleReconciliationRun(
                cluster_id=settings_obj.tigerbeetle_cluster_id,
                started_at=started_at,
                finished_at=finished_at,
                status="ok" if ok else "degraded",
                checked_transfer_count=checked_transfer_count,
                missing_transfer_count=missing_transfer_count,
                mismatched_transfer_count=mismatched_transfer_count,
                source_missing_count=source_missing_count,
                payload_json=coerce_json_payload(payload),
            )
        )
        session.flush()
    return payload
