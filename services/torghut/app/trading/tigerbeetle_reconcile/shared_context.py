"""TigerBeetle reconciliation for Torghut ledger references."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.config import Settings, settings
from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    coerce_json_payload,
)
from app.trading.tigerbeetle_client import (
    TigerBeetleClientProtocol,
    create_tigerbeetle_client,
)
from app.trading.tigerbeetle_ids import stable_ref_u128, u128_decimal
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    execution_tca_metric_source_id,
    build_order_event_transfer_plan,
    build_runtime_ledger_bucket_transfer_plan,
    runtime_ledger_amount_source,
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

BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH = (
    "tigerbeetle_runtime_ledger_direction_mismatch"
)

BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH = (
    "tigerbeetle_runtime_ledger_metadata_mismatch"
)

BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING = (
    "tigerbeetle_runtime_ledger_signed_refs_missing"
)

BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING = (
    "tigerbeetle_runtime_ledger_account_refs_missing"
)

BLOCKER_STABLE_REF_PAYLOAD_MISMATCH = "tigerbeetle_stable_ref_payload_mismatch"

BLOCKER_CLIENT_UNAVAILABLE = "tigerbeetle_client_unavailable"

BLOCKER_RECONCILIATION_STALE = "tigerbeetle_reconciliation_stale"

SAMPLE_LIMIT = 50

REF_COUNT_FIELD_NAMES = (
    "account_ref_count",
    "transfer_ref_count",
    "runtime_ledger_ref_count",
    "runtime_ledger_signed_ref_count",
    "runtime_ledger_missing_signed_ref_count",
    "runtime_ledger_missing_account_ref_count",
    "stable_ref_count",
    "stable_ref_missing_count",
    "stable_ref_mismatch_count",
)

COMPACT_REF_COUNT_KEYS = (
    *REF_COUNT_FIELD_NAMES,
    "order_event_ref_count",
    "execution_ref_count",
    "cost_ref_count",
    "runtime_ledger_required_bucket_count",
    "runtime_ledger_account_ref_count",
    "stable_ref_sample_size",
    "runtime_ledger_ref_sample_size",
)

COMPACT_REF_COUNT_FLAG_KEYS = (
    "stable_ref_diagnostic_bounded",
    "runtime_ledger_ref_coverage_bounded",
)


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


def payload_value(row: TigerBeetleTransferRef, key: str) -> str | None:
    raw_payload = cast(object, row.payload_json)
    payload: Mapping[str, object] = (
        cast(Mapping[str, object], raw_payload)
        if isinstance(raw_payload, Mapping)
        else cast(Mapping[str, object], {})
    )
    value: object | None = payload.get(key)
    return None if value is None else str(value)


def u128_text(value: object) -> str | None:
    if value is None:
        return None
    try:
        return u128_decimal(int(Decimal(str(value).strip())))
    except (InvalidOperation, TypeError, ValueError):
        return None


def account_payload_matches(
    ref: TigerBeetleTransferRef,
    key: str,
    expected_account_id: int,
) -> bool:
    payload_text = payload_value(ref, key)
    return payload_text is None or u128_text(payload_text) == u128_decimal(
        expected_account_id
    )


def payload_mapping(row: TigerBeetleTransferRef) -> Mapping[str, object]:
    raw_payload = cast(object, row.payload_json)
    if isinstance(raw_payload, Mapping):
        return cast(Mapping[str, object], raw_payload)
    return {}


def stable_ref_payload(row: TigerBeetleTransferRef) -> Mapping[str, object]:
    stable_ref = payload_mapping(row).get("stable_ref")
    if isinstance(stable_ref, Mapping):
        return cast(Mapping[str, object], stable_ref)
    return {}


def _stable_ref_matches(row: TigerBeetleTransferRef) -> bool:
    stable_ref = stable_ref_payload(row)
    if not stable_ref:
        return True
    components = stable_ref.get("components")
    if not isinstance(components, Mapping):
        return False
    component_mapping = cast(Mapping[str, object], components)
    source_type = str(row.source_type or "").strip()
    source_id = str(row.source_id or "").strip()
    transfer_kind = str(row.transfer_kind or "").strip()
    account_label = str(component_mapping.get("account_label") or "unknown")
    source_signature = str(component_mapping.get("source_signature") or "none")
    try:
        expected_stable_ref_id = u128_decimal(
            stable_ref_u128(
                cluster_id=row.cluster_id,
                account_label=account_label,
                source_type=source_type,
                source_id=source_id,
                transfer_kind=transfer_kind,
                source_signature=source_signature,
            )
        )
    except ValueError:
        return False
    return (
        stable_ref.get("schema_version") == "torghut.tigerbeetle-stable-ref.v1"
        and str(stable_ref.get("stable_ref_id") or "") == expected_stable_ref_id
        and str(component_mapping.get("cluster_id") or "") == str(row.cluster_id)
        and str(component_mapping.get("source_type") or "") == source_type
        and str(component_mapping.get("source_id") or "") == source_id
        and str(component_mapping.get("transfer_kind") or "") == transfer_kind
        and str(stable_ref.get("transfer_id") or "") == str(row.transfer_id)
        and str(stable_ref.get("ledger") or "") == str(row.ledger)
        and str(stable_ref.get("code") or "") == str(row.code)
        and str(stable_ref.get("amount") or "") == str(int(row.amount))
        and stable_ref.get("promotion_authority") is False
        and stable_ref.get("overrides_runtime_ledger_authority") is False
    )


def _stable_ref_archives_event_transfer(
    ref: TigerBeetleTransferRef,
    event: ExecutionOrderEvent,
) -> bool:
    stable_ref = stable_ref_payload(ref)
    if not stable_ref:
        return False
    if not _stable_ref_matches(ref):
        return False
    component_mapping = cast(Mapping[str, object], stable_ref.get("components"))
    source_id = str(ref.source_id or "").strip()
    event_source_id = str(event.id)
    event_signature = str(event.event_fingerprint or "")
    return (
        stable_ref.get("schema_version") == "torghut.tigerbeetle-stable-ref.v1"
        and str(component_mapping.get("source_type") or "")
        == SOURCE_TYPE_EXECUTION_ORDER_EVENT
        and str(component_mapping.get("source_id") or "") == event_source_id
        and source_id == event_source_id
        and str(component_mapping.get("transfer_kind") or "") == ref.transfer_kind
        and str(component_mapping.get("source_signature") or "") == event_signature
        and str(stable_ref.get("transfer_id") or "") == str(ref.transfer_id)
        and str(stable_ref.get("ledger") or "") == str(ref.ledger)
        and str(stable_ref.get("code") or "") == str(ref.code)
        and str(stable_ref.get("amount") or "") == str(int(ref.amount))
        and stable_ref.get("promotion_authority") is False
        and stable_ref.get("overrides_runtime_ledger_authority") is False
    )


def ref_matches_expected_event(
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
    # Fill refs may have been journaled before the submitted/pending ref was
    # backfilled. Preserve the ref's persisted pending mode when recomputing the
    # expected transfer so reconciliation distinguishes a representational
    # readback difference from a real PostgreSQL/TigerBeetle mismatch.
    plan = build_order_event_transfer_plan(
        session,
        event,
        settings_obj=settings_obj,
        prefer_pending_ref=payload_value(ref, "pending_mode") != "standalone_fill",
    )
    if plan is None:
        return False
    expected = plan.transfer_spec
    core_matches = (
        u128_text(ref.transfer_id) == u128_decimal(expected.transfer_id)
        and ref.transfer_kind == plan.transfer_kind
        and ref.amount == Decimal(expected.amount)
        and ref.ledger == expected.ledger
        and ref.code == expected.code
    )
    if not core_matches:
        return False
    accounts_match = account_payload_matches(
        ref, "debit_account_id", expected.debit_account_id
    ) and account_payload_matches(
        ref,
        "credit_account_id",
        expected.credit_account_id,
    )
    return accounts_match or _stable_ref_archives_event_transfer(ref, event)


def ref_sample(
    ref: TigerBeetleTransferRef,
    *,
    blocker: str,
    reason: str,
    actual: object | None = None,
) -> dict[str, object]:
    sample: dict[str, object] = {
        "blocker": blocker,
        "reason": reason,
        "row_id": str(ref.id),
        "transfer_id": str(ref.transfer_id),
        "source_type": ref.source_type,
        "source_id": ref.source_id,
        "execution_order_event_id": (
            str(ref.execution_order_event_id)
            if ref.execution_order_event_id is not None
            else None
        ),
        "execution_id": str(ref.execution_id) if ref.execution_id is not None else None,
        "execution_tca_metric_id": (
            str(ref.execution_tca_metric_id)
            if ref.execution_tca_metric_id is not None
            else None
        ),
        "runtime_ledger_bucket_id": (
            str(ref.runtime_ledger_bucket_id)
            if ref.runtime_ledger_bucket_id is not None
            else None
        ),
    }
    if actual is not None:
        sample["actual_transfer_id"] = str(_attr(actual, "id"))
    return sample


def append_sample(samples: list[dict[str, object]], sample: dict[str, object]) -> None:
    if len(samples) < SAMPLE_LIMIT:
        samples.append(sample)


def transfer_lookup_key(value: object) -> str | None:
    return u128_text(_attr(value, "id"))


def order_event_ref_exists(
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


def source_ref_exists(
    session: Session,
    *,
    settings_obj: Settings,
    source_type: str,
    source_id: str,
    transfer_kind: str,
    source_pk: UUID | None = None,
) -> bool:
    source_clauses = [
        (TigerBeetleTransferRef.source_type == source_type)
        & (TigerBeetleTransferRef.source_id == source_id)
    ]
    if source_pk is not None:
        if source_type == SOURCE_TYPE_EXECUTION:
            source_clauses.append(
                (TigerBeetleTransferRef.source_type == source_type)
                & (TigerBeetleTransferRef.execution_id == source_pk)
            )
        elif source_type == SOURCE_TYPE_EXECUTION_TCA_METRIC:
            source_clauses.append(
                (TigerBeetleTransferRef.source_type == source_type)
                & (TigerBeetleTransferRef.execution_tca_metric_id == source_pk)
            )
        elif source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET:
            source_clauses.append(
                (TigerBeetleTransferRef.source_type == source_type)
                & (TigerBeetleTransferRef.runtime_ledger_bucket_id == source_pk)
            )
    return (
        session.scalar(
            select(TigerBeetleTransferRef.id)
            .where(
                TigerBeetleTransferRef.cluster_id
                == settings_obj.tigerbeetle_cluster_id,
                TigerBeetleTransferRef.transfer_kind == transfer_kind,
                or_(*source_clauses),
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


def _payload_string_list(payload: Mapping[str, object], key: str) -> list[str]:
    value = payload.get(key)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        items = cast(Sequence[object], value)
        return [str(item) for item in items if item is not None]
    if value is None:
        return []
    return [str(value)]


def source_materialization_payload() -> dict[str, object]:
    return {
        "account_ref_table": "tigerbeetle_account_refs",
        "transfer_ref_table": "tigerbeetle_transfer_refs",
        "reconciliation_run_table": "tigerbeetle_reconciliation_runs",
        "runtime_ledger_source_table": "strategy_runtime_ledger_buckets",
        "runtime_ledger_source_type": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
        "runtime_ledger_transfer_kind": TRANSFER_KIND_RUNTIME_NET_PNL,
    }


def compact_reconciliation_ref_counts(
    ref_counts: Mapping[str, object],
    *,
    cluster_id: int,
) -> dict[str, object]:
    raw_by_source = ref_counts.get("by_source_type")
    by_source: dict[str, int] = {}
    if isinstance(raw_by_source, Mapping):
        for source_type, count in cast(Mapping[object, object], raw_by_source).items():
            by_source[str(source_type)] = _payload_int({"count": count}, "count")

    runtime_ledger_ref_count = _payload_int(ref_counts, "runtime_ledger_ref_count")
    if runtime_ledger_ref_count and SOURCE_TYPE_RUNTIME_LEDGER_BUCKET not in by_source:
        by_source[SOURCE_TYPE_RUNTIME_LEDGER_BUCKET] = runtime_ledger_ref_count

    raw_source_materialization = ref_counts.get("source_materialization")
    source_materialization = (
        dict(cast(Mapping[str, object], raw_source_materialization))
        if isinstance(raw_source_materialization, Mapping)
        else source_materialization_payload()
    )
    compact: dict[str, object] = {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": cluster_id,
        "by_source_type": by_source,
        "source_materialization": source_materialization,
    }
    for key in COMPACT_REF_COUNT_KEYS:
        if key in REF_COUNT_FIELD_NAMES or key in ref_counts:
            compact[key] = _payload_int(ref_counts, key)
    for key in COMPACT_REF_COUNT_FLAG_KEYS:
        if key in ref_counts:
            compact[key] = bool(ref_counts[key])
    compact.setdefault(
        "order_event_ref_count",
        by_source.get(SOURCE_TYPE_EXECUTION_ORDER_EVENT, 0),
    )
    compact.setdefault("execution_ref_count", by_source.get(SOURCE_TYPE_EXECUTION, 0))
    compact.setdefault(
        "cost_ref_count",
        by_source.get(SOURCE_TYPE_EXECUTION_TCA_METRIC, 0),
    )
    return compact


def as_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _uuid_or_none(value: str | None) -> UUID | None:
    if not value:
        return None
    uuid_text = value.split(":", 1)[0]
    try:
        return UUID(uuid_text)
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
    return _usd_to_micros(runtime_ledger_amount_source(bucket))


def _archived_runtime_ledger_amount_micros(
    ref: TigerBeetleTransferRef,
) -> Decimal | None:
    if (
        ref.source_type != SOURCE_TYPE_RUNTIME_LEDGER_BUCKET
        or ref.runtime_ledger_bucket_id is not None
    ):
        return None
    payload = payload_mapping(ref)
    raw_amount = payload.get("amount_source") or payload.get(
        "net_strategy_pnl_after_costs"
    )
    if raw_amount is None:
        return None
    try:
        return _usd_to_micros(Decimal(str(raw_amount)))
    except (InvalidOperation, ValueError):
        return None


def archived_source_amount_micros(ref: TigerBeetleTransferRef) -> Decimal | None:
    if ref.source_type not in {SOURCE_TYPE_EXECUTION, SOURCE_TYPE_EXECUTION_TCA_METRIC}:
        return None
    payload = payload_mapping(ref)
    raw_amount = payload.get("amount_source")
    if raw_amount is None:
        return None
    try:
        return _usd_to_micros(Decimal(str(raw_amount)))
    except (InvalidOperation, ValueError):
        return None


def legacy_unversioned_source_ref(ref: TigerBeetleTransferRef) -> bool:
    if ref.source_type not in {SOURCE_TYPE_EXECUTION, SOURCE_TYPE_EXECUTION_TCA_METRIC}:
        return False
    payload = payload_mapping(ref)
    return (
        ":" not in str(ref.source_id or "")
        and payload.get("amount_source") is None
        and payload.get("source_economic_fingerprint") is None
    )


def _expected_source_amount_micros(
    session: Session,
    ref: TigerBeetleTransferRef,
) -> Decimal | None:
    archived_amount = archived_source_amount_micros(ref)
    if archived_amount is not None:
        return archived_amount
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


def runtime_ledger_ref_is_signed(ref: TigerBeetleTransferRef) -> bool:
    payload = payload_mapping(ref)
    signed_amount = payload.get("signed_amount_micros")
    pnl_direction = str(payload.get("pnl_direction") or "")
    debit_account_id = payload.get("debit_account_id")
    credit_account_id = payload.get("credit_account_id")
    try:
        signed_amount_int = int(str(signed_amount))
    except (TypeError, ValueError):
        return False
    return (
        signed_amount_int != 0
        and pnl_direction in {"profit", "loss"}
        and debit_account_id is not None
        and credit_account_id is not None
    )


def _runtime_ledger_payload_account_ids(ref: TigerBeetleTransferRef) -> list[str]:
    payload = payload_mapping(ref)
    account_ids = _payload_string_list(payload, "account_ids")
    for key in ("debit_account_id", "credit_account_id"):
        value = payload.get(key)
        if value is None:
            continue
        account_id = str(value)
        if account_id not in account_ids:
            account_ids.append(account_id)
    return account_ids


archived_runtime_ledger_amount_micros = _archived_runtime_ledger_amount_micros
attr = _attr
cost_amount_micros = _cost_amount_micros
expected_source_amount_micros = _expected_source_amount_micros
execution_amount_micros = _execution_amount_micros
payload_int = _payload_int
payload_string_list = _payload_string_list
runtime_ledger_amount_micros = _runtime_ledger_amount_micros
runtime_ledger_payload_account_ids = _runtime_ledger_payload_account_ids
stable_ref_archives_event_transfer = _stable_ref_archives_event_transfer
stable_ref_matches = _stable_ref_matches
usd_to_micros = _usd_to_micros
uuid_or_none = _uuid_or_none

__all__ = (
    "SCHEMA_VERSION",
    "BLOCKER_TRANSFER_MISSING",
    "BLOCKER_AMOUNT_MISMATCH",
    "BLOCKER_CODE_MISMATCH",
    "BLOCKER_LEDGER_MISMATCH",
    "BLOCKER_DEBIT_ACCOUNT_MISMATCH",
    "BLOCKER_CREDIT_ACCOUNT_MISMATCH",
    "BLOCKER_POSTGRES_REF_MISMATCH",
    "BLOCKER_UNLINKED_EVENT",
    "BLOCKER_UNLINKED_EXECUTION",
    "BLOCKER_UNLINKED_COST",
    "BLOCKER_UNLINKED_RUNTIME_LEDGER",
    "BLOCKER_SOURCE_ROW_MISSING",
    "BLOCKER_SOURCE_AMOUNT_MISMATCH",
    "BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH",
    "BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH",
    "BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING",
    "BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING",
    "BLOCKER_STABLE_REF_PAYLOAD_MISMATCH",
    "BLOCKER_CLIENT_UNAVAILABLE",
    "BLOCKER_RECONCILIATION_STALE",
    "SAMPLE_LIMIT",
    "REF_COUNT_FIELD_NAMES",
    "COMPACT_REF_COUNT_KEYS",
    "COMPACT_REF_COUNT_FLAG_KEYS",
    "payload_value",
    "archived_runtime_ledger_amount_micros",
    "attr",
    "cost_amount_micros",
    "expected_source_amount_micros",
    "execution_amount_micros",
    "payload_int",
    "payload_string_list",
    "runtime_ledger_amount_micros",
    "runtime_ledger_payload_account_ids",
    "stable_ref_archives_event_transfer",
    "stable_ref_matches",
    "usd_to_micros",
    "uuid_or_none",
)


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "BLOCKER_AMOUNT_MISMATCH",
    "BLOCKER_CLIENT_UNAVAILABLE",
    "BLOCKER_CODE_MISMATCH",
    "BLOCKER_CREDIT_ACCOUNT_MISMATCH",
    "BLOCKER_DEBIT_ACCOUNT_MISMATCH",
    "BLOCKER_LEDGER_MISMATCH",
    "BLOCKER_POSTGRES_REF_MISMATCH",
    "BLOCKER_RECONCILIATION_STALE",
    "BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING",
    "BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH",
    "BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH",
    "BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING",
    "BLOCKER_SOURCE_AMOUNT_MISMATCH",
    "BLOCKER_SOURCE_ROW_MISSING",
    "BLOCKER_STABLE_REF_PAYLOAD_MISMATCH",
    "BLOCKER_TRANSFER_MISSING",
    "BLOCKER_UNLINKED_COST",
    "BLOCKER_UNLINKED_EVENT",
    "BLOCKER_UNLINKED_EXECUTION",
    "BLOCKER_UNLINKED_RUNTIME_LEDGER",
    "COMPACT_REF_COUNT_FLAG_KEYS",
    "COMPACT_REF_COUNT_KEYS",
    "ColumnElement",
    "Decimal",
    "Execution",
    "ExecutionOrderEvent",
    "ExecutionTCAMetric",
    "InvalidOperation",
    "Mapping",
    "REF_COUNT_FIELD_NAMES",
    "SAMPLE_LIMIT",
    "SCHEMA_VERSION",
    "SOURCE_TYPE_EXECUTION",
    "SOURCE_TYPE_EXECUTION_ORDER_EVENT",
    "SOURCE_TYPE_EXECUTION_TCA_METRIC",
    "SOURCE_TYPE_RUNTIME_LEDGER_BUCKET",
    "Sequence",
    "Session",
    "Settings",
    "StrategyRuntimeLedgerBucket",
    "TRANSFER_KIND_EXECUTION_COST",
    "TRANSFER_KIND_EXECUTION_FILL",
    "TRANSFER_KIND_RUNTIME_NET_PNL",
    "TigerBeetleAccountRef",
    "TigerBeetleClientProtocol",
    "TigerBeetleReconciliationRun",
    "TigerBeetleTransferRef",
    "UUID",
    "account_payload_matches",
    "append_sample",
    "_archived_runtime_ledger_amount_micros",
    "archived_source_amount_micros",
    "as_aware_utc",
    "_attr",
    "compact_reconciliation_ref_counts",
    "_cost_amount_micros",
    "_execution_amount_micros",
    "_expected_source_amount_micros",
    "legacy_unversioned_source_ref",
    "order_event_ref_exists",
    "_payload_int",
    "payload_mapping",
    "_payload_string_list",
    "ref_matches_expected_event",
    "ref_sample",
    "_runtime_ledger_amount_micros",
    "_runtime_ledger_payload_account_ids",
    "runtime_ledger_ref_is_signed",
    "source_materialization_payload",
    "source_ref_exists",
    "_stable_ref_archives_event_transfer",
    "_stable_ref_matches",
    "stable_ref_payload",
    "transfer_lookup_key",
    "u128_text",
    "_usd_to_micros",
    "_uuid_or_none",
    "account_payload_matches",
    "annotations",
    "append_sample",
    "archived_runtime_ledger_amount_micros",
    "archived_source_amount_micros",
    "as_aware_utc",
    "attr",
    "build_order_event_transfer_plan",
    "build_runtime_ledger_bucket_transfer_plan",
    "cast",
    "coerce_json_payload",
    "compact_reconciliation_ref_counts",
    "cost_amount_micros",
    "create_tigerbeetle_client",
    "datetime",
    "decimal_usd_to_nearest_micros",
    "execution_amount_micros",
    "execution_tca_metric_source_id",
    "expected_source_amount_micros",
    "func",
    "legacy_unversioned_source_ref",
    "or_",
    "order_event_ref_exists",
    "payload_int",
    "payload_mapping",
    "payload_string_list",
    "payload_value",
    "ref_matches_expected_event",
    "ref_sample",
    "runtime_ledger_amount_micros",
    "runtime_ledger_amount_source",
    "runtime_ledger_payload_account_ids",
    "runtime_ledger_ref_is_signed",
    "select",
    "settings",
    "source_materialization_payload",
    "source_ref_exists",
    "stable_ref_archives_event_transfer",
    "stable_ref_matches",
    "stable_ref_payload",
    "stable_ref_u128",
    "timezone",
    "transfer_lookup_key",
    "u128_decimal",
    "u128_text",
    "usd_to_micros",
    "uuid_or_none",
)
