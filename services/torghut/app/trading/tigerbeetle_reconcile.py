"""TigerBeetle reconciliation for Torghut ledger references."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
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


def _u128_text(value: object) -> str | None:
    if value is None:
        return None
    try:
        return u128_decimal(int(Decimal(str(value).strip())))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _account_payload_matches(
    ref: TigerBeetleTransferRef,
    key: str,
    expected_account_id: int,
) -> bool:
    payload_value = _payload_value(ref, key)
    return payload_value is None or _u128_text(payload_value) == u128_decimal(
        expected_account_id
    )


def _payload_mapping(row: TigerBeetleTransferRef) -> Mapping[str, object]:
    raw_payload = cast(object, row.payload_json)
    if isinstance(raw_payload, Mapping):
        return cast(Mapping[str, object], raw_payload)
    return {}


def _stable_ref_payload(row: TigerBeetleTransferRef) -> Mapping[str, object]:
    stable_ref = _payload_mapping(row).get("stable_ref")
    if isinstance(stable_ref, Mapping):
        return cast(Mapping[str, object], stable_ref)
    return {}


def _stable_ref_matches(row: TigerBeetleTransferRef) -> bool:
    stable_ref = _stable_ref_payload(row)
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
    # Fill refs may have been journaled before the submitted/pending ref was
    # backfilled. Preserve the ref's persisted pending mode when recomputing the
    # expected transfer so reconciliation distinguishes a representational
    # readback difference from a real PostgreSQL/TigerBeetle mismatch.
    plan = build_order_event_transfer_plan(
        session,
        event,
        settings_obj=settings_obj,
        prefer_pending_ref=_payload_value(ref, "pending_mode") != "standalone_fill",
    )
    if plan is None:
        return False
    expected = plan.transfer_spec
    return (
        _u128_text(ref.transfer_id) == u128_decimal(expected.transfer_id)
        and ref.transfer_kind == plan.transfer_kind
        and ref.amount == Decimal(expected.amount)
        and ref.ledger == expected.ledger
        and ref.code == expected.code
        and _account_payload_matches(ref, "debit_account_id", expected.debit_account_id)
        and _account_payload_matches(
            ref,
            "credit_account_id",
            expected.credit_account_id,
        )
    )


def _ref_sample(
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


def _append_sample(samples: list[dict[str, object]], sample: dict[str, object]) -> None:
    if len(samples) < SAMPLE_LIMIT:
        samples.append(sample)


def _transfer_lookup_key(value: object) -> str | None:
    return _u128_text(_attr(value, "id"))


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


def _as_aware_utc(value: datetime) -> datetime:
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
    payload = _payload_mapping(ref)
    raw_amount = payload.get("amount_source") or payload.get(
        "net_strategy_pnl_after_costs"
    )
    if raw_amount is None:
        return None
    try:
        return _usd_to_micros(Decimal(str(raw_amount)))
    except (InvalidOperation, ValueError):
        return None


def _archived_source_amount_micros(ref: TigerBeetleTransferRef) -> Decimal | None:
    if ref.source_type not in {SOURCE_TYPE_EXECUTION, SOURCE_TYPE_EXECUTION_TCA_METRIC}:
        return None
    payload = _payload_mapping(ref)
    raw_amount = payload.get("amount_source")
    if raw_amount is None:
        return None
    try:
        return _usd_to_micros(Decimal(str(raw_amount)))
    except (InvalidOperation, ValueError):
        return None


def _legacy_unversioned_source_ref(ref: TigerBeetleTransferRef) -> bool:
    if ref.source_type not in {SOURCE_TYPE_EXECUTION, SOURCE_TYPE_EXECUTION_TCA_METRIC}:
        return False
    payload = _payload_mapping(ref)
    return (
        ":" not in str(ref.source_id or "")
        and payload.get("amount_source") is None
        and payload.get("source_economic_fingerprint") is None
    )


def _expected_source_amount_micros(
    session: Session,
    ref: TigerBeetleTransferRef,
) -> Decimal | None:
    archived_amount = _archived_source_amount_micros(ref)
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


def _runtime_ledger_ref_is_signed(ref: TigerBeetleTransferRef) -> bool:
    payload = _payload_mapping(ref)
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
    payload = _payload_mapping(ref)
    account_ids = _payload_string_list(payload, "account_ids")
    for key in ("debit_account_id", "credit_account_id"):
        value = payload.get(key)
        if value is None:
            continue
        account_id = str(value)
        if account_id not in account_ids:
            account_ids.append(account_id)
    return account_ids


def _runtime_ledger_ref_coverage(
    session: Session,
    *,
    cluster_id: int,
    sample_limit: int = 50,
    full_ref_scan: bool = True,
) -> dict[str, object]:
    runtime_ref_filter = (
        TigerBeetleTransferRef.cluster_id == cluster_id,
        TigerBeetleTransferRef.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
        TigerBeetleTransferRef.transfer_kind == TRANSFER_KIND_RUNTIME_NET_PNL,
    )
    runtime_ref_count = int(
        session.scalar(
            select(func.count(TigerBeetleTransferRef.id)).where(*runtime_ref_filter)
        )
        or 0
    )
    required_runtime_bucket_count = int(
        session.scalar(
            select(func.count(StrategyRuntimeLedgerBucket.id)).where(
                (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
                | (StrategyRuntimeLedgerBucket.cost_amount != 0)
            )
        )
        or 0
    )
    sample_refs = (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(*runtime_ref_filter)
            .order_by(TigerBeetleTransferRef.created_at.desc())
            .limit(sample_limit)
        )
        .scalars()
        .all()
    )
    if not full_ref_scan:
        runtime_refs = sample_refs
        exact_ref_coverage = runtime_ref_count <= len(runtime_refs)
        current_runtime_refs: list[TigerBeetleTransferRef] = []
        signed_refs: list[TigerBeetleTransferRef] = []
        signed_bucket_ids: set[str] = set()
        if exact_ref_coverage:
            current_bucket_ids = {
                str(bucket_id)
                for bucket_id in session.execute(
                    select(StrategyRuntimeLedgerBucket.id).where(
                        (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
                        | (StrategyRuntimeLedgerBucket.cost_amount != 0)
                    )
                ).scalars()
            }
            current_runtime_refs = [
                ref
                for ref in runtime_refs
                if (
                    ref.runtime_ledger_bucket_id is not None
                    and str(ref.runtime_ledger_bucket_id) in current_bucket_ids
                )
                or (ref.source_id is not None and ref.source_id in current_bucket_ids)
            ]
            signed_refs = [
                ref
                for ref in current_runtime_refs
                if _runtime_ledger_ref_is_signed(ref)
            ]
            signed_bucket_ids = {
                str(ref.runtime_ledger_bucket_id or ref.source_id)
                for ref in signed_refs
                if ref.runtime_ledger_bucket_id is not None or ref.source_id
            }
        runtime_source_ids = [
            str(ref.source_id) for ref in runtime_refs if ref.source_id is not None
        ]
        runtime_transfer_ids = [str(ref.transfer_id) for ref in runtime_refs]
        runtime_account_ids: list[str] = []
        for ref in current_runtime_refs if exact_ref_coverage else runtime_refs:
            for account_id in _runtime_ledger_payload_account_ids(ref):
                if account_id not in runtime_account_ids:
                    runtime_account_ids.append(account_id)
        account_ref_ids: set[str] = (
            {
                str(account_id)
                for account_id in session.execute(
                    select(TigerBeetleAccountRef.account_id).where(
                        TigerBeetleAccountRef.cluster_id == cluster_id,
                        TigerBeetleAccountRef.account_id.in_(runtime_account_ids),
                    )
                ).scalars()
            }
            if runtime_account_ids
            else set()
        )
        missing_account_ids = [
            account_id
            for account_id in runtime_account_ids
            if account_id not in account_ref_ids
        ]
        missing_signed_ref_count = (
            max(
                required_runtime_bucket_count - len(signed_bucket_ids),
                len(current_runtime_refs) - len(signed_refs),
                0,
            )
            if exact_ref_coverage
            else max(
                required_runtime_bucket_count,
                runtime_ref_count,
                0,
            )
        )
        return {
            "runtime_ledger_required_bucket_count": required_runtime_bucket_count,
            "runtime_ledger_ref_count": runtime_ref_count,
            "runtime_ledger_signed_ref_count": len(signed_refs),
            "runtime_ledger_missing_signed_ref_count": missing_signed_ref_count,
            "runtime_ledger_account_ref_count": len(runtime_account_ids)
            - len(missing_account_ids),
            "runtime_ledger_missing_account_ref_count": len(missing_account_ids),
            "runtime_ledger_missing_account_ids": missing_account_ids[:sample_limit],
            "runtime_ledger_source_ids": runtime_source_ids,
            "runtime_ledger_transfer_ids": runtime_transfer_ids,
            "runtime_ledger_signed_bucket_ids": sorted(signed_bucket_ids)[
                :sample_limit
            ],
            "runtime_ledger_ref_coverage_bounded": not exact_ref_coverage,
            "runtime_ledger_ref_sample_size": len(runtime_refs),
        }

    runtime_refs = sample_refs
    if runtime_ref_count > len(sample_refs):
        runtime_refs = (
            session.execute(
                select(TigerBeetleTransferRef)
                .where(*runtime_ref_filter)
                .order_by(TigerBeetleTransferRef.created_at.desc())
            )
            .scalars()
            .all()
        )
    current_bucket_ids = {
        str(bucket_id)
        for bucket_id in session.execute(
            select(StrategyRuntimeLedgerBucket.id).where(
                (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
                | (StrategyRuntimeLedgerBucket.cost_amount != 0)
            )
        ).scalars()
    }
    current_runtime_refs = [
        ref
        for ref in runtime_refs
        if (
            ref.runtime_ledger_bucket_id is not None
            and str(ref.runtime_ledger_bucket_id) in current_bucket_ids
        )
        or (ref.source_id is not None and ref.source_id in current_bucket_ids)
    ]
    signed_refs = [
        ref for ref in current_runtime_refs if _runtime_ledger_ref_is_signed(ref)
    ]
    signed_bucket_ids = {
        str(ref.runtime_ledger_bucket_id or ref.source_id)
        for ref in signed_refs
        if ref.runtime_ledger_bucket_id is not None or ref.source_id
    }
    runtime_source_ids = [
        str(ref.source_id) for ref in runtime_refs if ref.source_id is not None
    ][:sample_limit]
    runtime_transfer_ids = [str(ref.transfer_id) for ref in runtime_refs][:sample_limit]
    runtime_account_ids: list[str] = []
    for ref in current_runtime_refs:
        for account_id in _runtime_ledger_payload_account_ids(ref):
            if account_id not in runtime_account_ids:
                runtime_account_ids.append(account_id)
    account_ref_ids = {
        str(account_id)
        for account_id in session.execute(
            select(TigerBeetleAccountRef.account_id).where(
                TigerBeetleAccountRef.cluster_id == cluster_id
            )
        ).scalars()
    }
    missing_account_ids = [
        account_id
        for account_id in runtime_account_ids
        if account_id not in account_ref_ids
    ]
    missing_signed_ref_count = max(
        required_runtime_bucket_count - len(signed_bucket_ids),
        len(current_runtime_refs) - len(signed_refs),
        0,
    )
    return {
        "runtime_ledger_required_bucket_count": required_runtime_bucket_count,
        "runtime_ledger_ref_count": len(runtime_refs),
        "runtime_ledger_signed_ref_count": len(signed_refs),
        "runtime_ledger_missing_signed_ref_count": missing_signed_ref_count,
        "runtime_ledger_account_ref_count": len(runtime_account_ids)
        - len(missing_account_ids),
        "runtime_ledger_missing_account_ref_count": len(missing_account_ids),
        "runtime_ledger_missing_account_ids": missing_account_ids[:sample_limit],
        "runtime_ledger_source_ids": runtime_source_ids,
        "runtime_ledger_transfer_ids": runtime_transfer_ids,
        "runtime_ledger_signed_bucket_ids": sorted(signed_bucket_ids)[:sample_limit],
        "runtime_ledger_ref_coverage_bounded": False,
        "runtime_ledger_ref_sample_size": len(runtime_refs),
    }


def _runtime_ledger_ref_matches_expected_bucket(
    ref: TigerBeetleTransferRef,
    actual: object,
    bucket: StrategyRuntimeLedgerBucket,
) -> tuple[bool, bool]:
    plan = build_runtime_ledger_bucket_transfer_plan(bucket)
    if plan is None:
        return False, False
    expected = plan.transfer_spec
    payload = _payload_mapping(ref)
    direction_matches = (
        ref.transfer_id == str(expected.transfer_id)
        and ref.transfer_kind == TRANSFER_KIND_RUNTIME_NET_PNL
        and ref.amount == Decimal(expected.amount)
        and ref.ledger == expected.ledger
        and ref.code == expected.code
        and int(_attr(actual, "amount")) == expected.amount
        and int(_attr(actual, "ledger")) == expected.ledger
        and int(_attr(actual, "code")) == expected.code
        and int(_attr(actual, "debit_account_id")) == expected.debit_account_id
        and int(_attr(actual, "credit_account_id")) == expected.credit_account_id
        and str(payload.get("debit_account_id")) == str(expected.debit_account_id)
        and str(payload.get("credit_account_id")) == str(expected.credit_account_id)
        and str(payload.get("signed_amount_micros")) == str(plan.signed_amount_micros)
        and str(payload.get("pnl_direction")) == plan.pnl_direction
    )
    expected_metadata = {
        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
        "run_id": bucket.run_id,
        "candidate_id": bucket.candidate_id,
        "hypothesis_id": bucket.hypothesis_id,
        "observed_stage": bucket.observed_stage,
        "pnl_basis": bucket.pnl_basis,
        "ledger_schema_version": bucket.ledger_schema_version,
        "amount_source": str(plan.amount_source),
        "runtime_key": plan.runtime_key,
    }
    metadata_matches = all(
        str(payload.get(key)) == str(value)
        for key, value in expected_metadata.items()
        if value is not None
    )
    return direction_matches, metadata_matches


def _reconciliation_transfer_refs(
    session: Session,
    *,
    cluster_id: int,
    limit: int,
) -> list[TigerBeetleTransferRef]:
    bounded_limit = max(1, limit)
    recent_refs = (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(TigerBeetleTransferRef.cluster_id == cluster_id)
            .order_by(TigerBeetleTransferRef.created_at.desc())
            .limit(bounded_limit)
        )
        .scalars()
        .all()
    )
    runtime_ledger_refs = (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(
                TigerBeetleTransferRef.cluster_id == cluster_id,
                TigerBeetleTransferRef.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                TigerBeetleTransferRef.transfer_kind == TRANSFER_KIND_RUNTIME_NET_PNL,
            )
            .order_by(TigerBeetleTransferRef.created_at.desc())
            .limit(bounded_limit)
        )
        .scalars()
        .all()
    )
    refs_by_id: dict[str, TigerBeetleTransferRef] = {}
    for ref in (*recent_refs, *runtime_ledger_refs):
        refs_by_id.setdefault(str(ref.id), ref)
    return list(refs_by_id.values())


def tigerbeetle_ref_counts(
    session: Session,
    *,
    cluster_id: int,
    full_ref_scan: bool = True,
) -> dict[str, object]:
    account_total = session.scalar(
        select(func.count(TigerBeetleAccountRef.id)).where(
            TigerBeetleAccountRef.cluster_id == cluster_id
        )
    )
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
    refs_query = (
        select(TigerBeetleTransferRef)
        .where(TigerBeetleTransferRef.cluster_id == cluster_id)
        .order_by(TigerBeetleTransferRef.created_at.desc())
    )
    if not full_ref_scan:
        refs_query = refs_query.limit(SAMPLE_LIMIT)
    refs = session.execute(refs_query).scalars().all()
    stable_ref_count = sum(1 for ref in refs if _stable_ref_payload(ref))
    stable_ref_missing_count = sum(
        1
        for ref in refs
        if ref.source_type and ref.source_id and not _stable_ref_payload(ref)
    )
    stable_ref_mismatch_count = sum(
        1 for ref in refs if _stable_ref_payload(ref) and not _stable_ref_matches(ref)
    )
    runtime_coverage = _runtime_ledger_ref_coverage(
        session,
        cluster_id=cluster_id,
        full_ref_scan=full_ref_scan,
    )
    return {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": cluster_id,
        "account_ref_count": int(account_total or 0),
        "transfer_ref_count": int(total or 0),
        "by_source_type": by_source,
        "order_event_ref_count": by_source.get(SOURCE_TYPE_EXECUTION_ORDER_EVENT, 0),
        "execution_ref_count": by_source.get(SOURCE_TYPE_EXECUTION, 0),
        "cost_ref_count": by_source.get(SOURCE_TYPE_EXECUTION_TCA_METRIC, 0),
        "runtime_ledger_ref_count": by_source.get(
            SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            0,
        ),
        "stable_ref_count": stable_ref_count,
        "stable_ref_missing_count": stable_ref_missing_count,
        "stable_ref_mismatch_count": stable_ref_mismatch_count,
        "stable_ref_diagnostic_bounded": not full_ref_scan,
        "stable_ref_sample_size": len(refs),
        "source_materialization": {
            "account_ref_table": "tigerbeetle_account_refs",
            "transfer_ref_table": "tigerbeetle_transfer_refs",
            "reconciliation_run_table": "tigerbeetle_reconciliation_runs",
            "runtime_ledger_source_table": "strategy_runtime_ledger_buckets",
            "runtime_ledger_source_type": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            "runtime_ledger_transfer_kind": TRANSFER_KIND_RUNTIME_NET_PNL,
        },
        **runtime_coverage,
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
    raw_ref_counts = payload.get("ref_counts")
    ref_counts = (
        cast(Mapping[str, object], raw_ref_counts)
        if isinstance(raw_ref_counts, Mapping)
        else cast(Mapping[str, object], {})
    )
    ref_count_field_names = sorted(
        {
            key
            for key in (
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
            if key in payload or key in ref_counts
        }
    )
    account_ref_count = _payload_int(payload, "account_ref_count") or _payload_int(
        ref_counts,
        "account_ref_count",
    )
    transfer_ref_count = _payload_int(payload, "transfer_ref_count") or _payload_int(
        ref_counts,
        "transfer_ref_count",
    )
    runtime_ledger_ref_count = _payload_int(
        payload,
        "runtime_ledger_ref_count",
    ) or _payload_int(ref_counts, "runtime_ledger_ref_count")
    runtime_ledger_signed_ref_count = _payload_int(
        payload,
        "runtime_ledger_signed_ref_count",
    ) or _payload_int(ref_counts, "runtime_ledger_signed_ref_count")
    stable_ref_count = _payload_int(payload, "stable_ref_count") or _payload_int(
        ref_counts, "stable_ref_count"
    )
    stable_ref_missing_count = _payload_int(
        payload, "stable_ref_missing_count"
    ) or _payload_int(ref_counts, "stable_ref_missing_count")
    stable_ref_mismatch_count = _payload_int(
        payload, "stable_ref_mismatch_count"
    ) or _payload_int(ref_counts, "stable_ref_mismatch_count")
    source_row_missing_count = _payload_int(payload, "source_row_missing_count")
    missing_source_row_count = (
        _payload_int(
            payload,
            "missing_source_row_count",
        )
        or source_row_missing_count
    )
    mismatched_ref_count = _payload_int(payload, "mismatched_ref_count") or int(
        row.mismatched_transfer_count
    )
    observed_at = _as_aware_utc(row.finished_at or row.started_at)
    age_seconds = max(
        0,
        int((datetime.now(timezone.utc) - observed_at).total_seconds()),
    )
    max_age_seconds = _payload_int(payload, "reconciliation_max_age_seconds")
    stale = bool(max_age_seconds > 0 and age_seconds > max_age_seconds)
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": row.status == "ok",
        "cluster_id": row.cluster_id,
        "status": row.status,
        "age_seconds": age_seconds,
        "reconciliation_max_age_seconds": max_age_seconds,
        "reconciliation_stale": stale,
        "reconciliation_freshness": {
            "observed_at": observed_at.isoformat(),
            "age_seconds": age_seconds,
            "max_age_seconds": max_age_seconds,
            "stale": stale,
        },
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "client_lookup_ok": bool(payload.get("client_lookup_ok", row.status == "ok")),
        "client_error": payload.get("client_error"),
        "account_ref_count": account_ref_count,
        "transfer_ref_count": transfer_ref_count,
        "checked_transfer_count": row.checked_transfer_count,
        "missing_transfer_count": row.missing_transfer_count,
        "mismatched_transfer_count": row.mismatched_transfer_count,
        "mismatched_ref_count": mismatched_ref_count,
        "source_missing_count": row.source_missing_count,
        "source_row_missing_count": source_row_missing_count,
        "missing_source_row_count": missing_source_row_count,
        "source_amount_mismatch_count": _payload_int(
            payload, "source_amount_mismatch_count"
        ),
        "legacy_source_amount_unverifiable_count": _payload_int(
            payload, "legacy_source_amount_unverifiable_count"
        ),
        "runtime_ledger_checked_transfer_count": _payload_int(
            payload, "runtime_ledger_checked_transfer_count"
        ),
        "runtime_ledger_signed_transfer_count": _payload_int(
            payload, "runtime_ledger_signed_transfer_count"
        ),
        "runtime_ledger_ref_count": runtime_ledger_ref_count,
        "runtime_ledger_signed_ref_count": runtime_ledger_signed_ref_count,
        "runtime_ledger_missing_signed_ref_count": _payload_int(
            payload,
            "runtime_ledger_missing_signed_ref_count",
        ),
        "runtime_ledger_missing_account_ref_count": _payload_int(
            payload,
            "runtime_ledger_missing_account_ref_count",
        ),
        "stable_ref_count": stable_ref_count,
        "stable_ref_missing_count": stable_ref_missing_count,
        "stable_ref_mismatch_count": stable_ref_mismatch_count,
        "archived_runtime_ledger_source_missing_count": _payload_int(
            payload, "archived_runtime_ledger_source_missing_count"
        ),
        "runtime_ledger_direction_mismatch_count": _payload_int(
            payload, "runtime_ledger_direction_mismatch_count"
        ),
        "runtime_ledger_metadata_mismatch_count": _payload_int(
            payload, "runtime_ledger_metadata_mismatch_count"
        ),
        "unlinked_event_count": _payload_int(payload, "unlinked_event_count"),
        "unlinked_order_event_ref_count": _payload_int(
            payload,
            "unlinked_order_event_ref_count",
        ),
        "unlinked_execution_count": _payload_int(payload, "unlinked_execution_count"),
        "unlinked_execution_ref_count": _payload_int(
            payload,
            "unlinked_execution_ref_count",
        ),
        "unlinked_cost_count": _payload_int(payload, "unlinked_cost_count"),
        "unlinked_cost_ref_count": _payload_int(payload, "unlinked_cost_ref_count"),
        "unlinked_runtime_ledger_count": int(
            _payload_int(payload, "unlinked_runtime_ledger_count")
        ),
        "unlinked_runtime_ledger_ref_count": _payload_int(
            payload,
            "unlinked_runtime_ledger_ref_count",
        ),
        "missing_transfer_refs": payload.get("missing_transfer_refs") or [],
        "mismatched_refs": payload.get("mismatched_refs") or [],
        "missing_source_rows": payload.get("missing_source_rows") or [],
        "unlinked_refs": payload.get("unlinked_refs") or [],
        "legacy_source_amount_unverifiable_refs": payload.get(
            "legacy_source_amount_unverifiable_refs"
        )
        or [],
        "blocker_details": payload.get("blocker_details") or {},
        "ref_counts": payload.get("ref_counts") or {},
        "ref_count_field_names": ref_count_field_names,
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
    refs = _reconciliation_transfer_refs(
        session,
        cluster_id=settings_obj.tigerbeetle_cluster_id,
        limit=limit,
    )
    checked_transfer_count = len(refs)
    missing_transfer_count = 0
    mismatched_transfer_count = 0
    source_row_missing_count = 0
    source_amount_mismatch_count = 0
    legacy_source_amount_unverifiable_count = 0
    runtime_ledger_checked_transfer_count = 0
    runtime_ledger_signed_transfer_count = 0
    runtime_ledger_missing_signed_ref_count = 0
    runtime_ledger_missing_account_ref_count = 0
    archived_runtime_ledger_source_missing_count = 0
    runtime_ledger_direction_mismatch_count = 0
    runtime_ledger_metadata_mismatch_count = 0
    stable_ref_mismatch_count = 0
    blockers: list[str] = []
    mismatched_refs: list[dict[str, object]] = []
    missing_transfer_refs: list[dict[str, object]] = []
    missing_source_rows: list[dict[str, object]] = []
    unlinked_refs: list[dict[str, object]] = []
    legacy_source_amount_unverifiable_refs: list[dict[str, object]] = []

    transfer_lookup: dict[str, object] = {}
    client_lookup_ok = True
    client_error: str | None = None
    owned_client = client is None
    tb_client: TigerBeetleClientProtocol | None = None
    try:
        if refs:
            tb_client = client or create_tigerbeetle_client(settings_obj)
            looked_up = tb_client.lookup_transfers(
                [int(ref.transfer_id) for ref in refs]
            )
            transfer_lookup = {
                lookup_key: item
                for item in looked_up
                if (lookup_key := _transfer_lookup_key(item)) is not None
            }
    except Exception as exc:
        client_lookup_ok = False
        client_error = f"{type(exc).__name__}: {exc}"
        blockers.append(BLOCKER_CLIENT_UNAVAILABLE)
    finally:
        if owned_client and tb_client is not None:
            close = getattr(tb_client, "close", None)
            if callable(close):
                close()

    for ref in refs:
        ref_transfer_id = _u128_text(ref.transfer_id) or str(ref.transfer_id)
        if not _stable_ref_matches(ref):
            stable_ref_mismatch_count += 1
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH)
            _append_sample(
                mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_STABLE_REF_PAYLOAD_MISMATCH,
                    reason="stable_ref_payload_does_not_match_transfer_ref_identity",
                ),
            )
        actual = transfer_lookup.get(ref_transfer_id) if client_lookup_ok else None
        if client_lookup_ok:
            if actual is None:
                missing_transfer_count += 1
                blockers.append(BLOCKER_TRANSFER_MISSING)
                _append_sample(
                    missing_transfer_refs,
                    _ref_sample(
                        ref,
                        blocker=BLOCKER_TRANSFER_MISSING,
                        reason="transfer_ref_not_found_in_tigerbeetle_lookup",
                    ),
                )
                continue
            if Decimal(str(_attr(actual, "amount"))) != ref.amount:
                mismatched_transfer_count += 1
                blockers.append(BLOCKER_AMOUNT_MISMATCH)
                _append_sample(
                    mismatched_refs,
                    _ref_sample(
                        ref,
                        blocker=BLOCKER_AMOUNT_MISMATCH,
                        reason="actual_amount_micros_differs_from_transfer_ref",
                        actual=actual,
                    ),
                )
            if int(str(_attr(actual, "code"))) != ref.code:
                mismatched_transfer_count += 1
                blockers.append(BLOCKER_CODE_MISMATCH)
                _append_sample(
                    mismatched_refs,
                    _ref_sample(
                        ref,
                        blocker=BLOCKER_CODE_MISMATCH,
                        reason="actual_code_differs_from_transfer_ref",
                        actual=actual,
                    ),
                )
            if int(str(_attr(actual, "ledger"))) != ref.ledger:
                mismatched_transfer_count += 1
                blockers.append(BLOCKER_LEDGER_MISMATCH)
                _append_sample(
                    mismatched_refs,
                    _ref_sample(
                        ref,
                        blocker=BLOCKER_LEDGER_MISMATCH,
                        reason="actual_ledger_differs_from_transfer_ref",
                        actual=actual,
                    ),
                )
            debit_account_id = _payload_value(ref, "debit_account_id")
            if debit_account_id is not None and _u128_text(
                _attr(actual, "debit_account_id")
            ) != _u128_text(debit_account_id):
                mismatched_transfer_count += 1
                blockers.append(BLOCKER_DEBIT_ACCOUNT_MISMATCH)
                _append_sample(
                    mismatched_refs,
                    _ref_sample(
                        ref,
                        blocker=BLOCKER_DEBIT_ACCOUNT_MISMATCH,
                        reason=(
                            "actual_debit_account_differs_from_transfer_ref_payload"
                        ),
                        actual=actual,
                    ),
                )
            credit_account_id = _payload_value(ref, "credit_account_id")
            if credit_account_id is not None and _u128_text(
                _attr(actual, "credit_account_id")
            ) != _u128_text(credit_account_id):
                mismatched_transfer_count += 1
                blockers.append(BLOCKER_CREDIT_ACCOUNT_MISMATCH)
                _append_sample(
                    mismatched_refs,
                    _ref_sample(
                        ref,
                        blocker=BLOCKER_CREDIT_ACCOUNT_MISMATCH,
                        reason=(
                            "actual_credit_account_differs_from_transfer_ref_payload"
                        ),
                        actual=actual,
                    ),
                )
        if not _ref_matches_expected_event(
            session,
            ref,
            settings_obj=settings_obj,
        ):
            mismatched_transfer_count += 1
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
        if ref.source_type in {
            SOURCE_TYPE_EXECUTION,
            SOURCE_TYPE_EXECUTION_TCA_METRIC,
            SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
        }:
            expected_source_amount = _expected_source_amount_micros(session, ref)
            if expected_source_amount is None:
                archived_amount = _archived_runtime_ledger_amount_micros(ref)
                if archived_amount is not None and ref.amount == archived_amount:
                    archived_runtime_ledger_source_missing_count += 1
                else:
                    source_row_missing_count += 1
                    blockers.append(BLOCKER_SOURCE_ROW_MISSING)
                    _append_sample(
                        missing_source_rows,
                        _ref_sample(
                            ref,
                            blocker=BLOCKER_SOURCE_ROW_MISSING,
                            reason="source_row_missing_or_source_id_not_uuid",
                            actual=actual,
                        ),
                    )
            elif ref.amount != expected_source_amount:
                if _legacy_unversioned_source_ref(ref):
                    legacy_source_amount_unverifiable_count += 1
                    _append_sample(
                        legacy_source_amount_unverifiable_refs,
                        _ref_sample(
                            ref,
                            blocker="tigerbeetle_legacy_source_amount_unverifiable",
                            reason=(
                                "legacy_source_ref_lacks_revision_or_archived_amount"
                            ),
                            actual=actual,
                        ),
                    )
                else:
                    source_amount_mismatch_count += 1
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
        if ref.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET:
            runtime_ledger_checked_transfer_count += 1
            source_uuid = _uuid_or_none(ref.source_id)
            bucket = (
                session.get(StrategyRuntimeLedgerBucket, source_uuid)
                if source_uuid is not None
                else None
            )
            if bucket is not None and actual is not None:
                direction_matches, metadata_matches = (
                    _runtime_ledger_ref_matches_expected_bucket(ref, actual, bucket)
                )
                if direction_matches:
                    runtime_ledger_signed_transfer_count += 1
                else:
                    runtime_ledger_direction_mismatch_count += 1
                    mismatched_transfer_count += 1
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
                    runtime_ledger_metadata_mismatch_count += 1
                    mismatched_transfer_count += 1
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

    recent_events = (
        session.execute(
            select(ExecutionOrderEvent)
            .order_by(ExecutionOrderEvent.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    unlinked_event_count = 0
    for event in recent_events:
        if _order_event_ref_exists(session, event, settings_obj=settings_obj):
            continue
        if (
            build_order_event_transfer_plan(
                session,
                event,
                settings_obj=settings_obj,
            )
            is None
        ):
            continue
        unlinked_event_count += 1
        _append_sample(
            unlinked_refs,
            {
                "blocker": BLOCKER_UNLINKED_EVENT,
                "source_type": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                "source_id": str(event.id),
                "event_fingerprint": event.event_fingerprint,
            },
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
    unlinked_execution_count = 0
    for execution in recent_executions:
        if _source_ref_exists(
            session,
            settings_obj=settings_obj,
            source_type=SOURCE_TYPE_EXECUTION,
            source_id=str(execution.id),
            transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
            source_pk=execution.id,
        ):
            continue
        unlinked_execution_count += 1
        _append_sample(
            unlinked_refs,
            {
                "blocker": BLOCKER_UNLINKED_EXECUTION,
                "source_type": SOURCE_TYPE_EXECUTION,
                "source_id": str(execution.id),
                "alpaca_order_id": execution.alpaca_order_id,
            },
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
    unlinked_cost_count = 0
    for metric in recent_cost_metrics:
        if _source_ref_exists(
            session,
            settings_obj=settings_obj,
            source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
            source_id=execution_tca_metric_source_id(metric),
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
            source_pk=metric.id,
        ):
            continue
        unlinked_cost_count += 1
        _append_sample(
            unlinked_refs,
            {
                "blocker": BLOCKER_UNLINKED_COST,
                "source_type": SOURCE_TYPE_EXECUTION_TCA_METRIC,
                "source_id": execution_tca_metric_source_id(metric),
                "execution_id": str(metric.execution_id),
            },
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
    unlinked_runtime_ledger_count = 0
    for bucket in recent_runtime_buckets:
        if _source_ref_exists(
            session,
            settings_obj=settings_obj,
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id=str(bucket.id),
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            source_pk=bucket.id,
        ):
            continue
        unlinked_runtime_ledger_count += 1
        _append_sample(
            unlinked_refs,
            {
                "blocker": BLOCKER_UNLINKED_RUNTIME_LEDGER,
                "source_type": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                "source_id": str(bucket.id),
                "run_id": bucket.run_id,
                "candidate_id": bucket.candidate_id,
            },
        )
    if unlinked_runtime_ledger_count:
        blockers.append(BLOCKER_UNLINKED_RUNTIME_LEDGER)

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
    runtime_ledger_missing_signed_ref_count = _payload_int(
        ref_counts,
        "runtime_ledger_missing_signed_ref_count",
    )
    runtime_ledger_missing_account_ref_count = _payload_int(
        ref_counts,
        "runtime_ledger_missing_account_ref_count",
    )
    ref_count_stable_ref_mismatch_count = _payload_int(
        ref_counts,
        "stable_ref_mismatch_count",
    )
    if runtime_ledger_missing_signed_ref_count:
        blockers.append(BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING)
    if runtime_ledger_missing_account_ref_count:
        blockers.append(BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING)
    if ref_count_stable_ref_mismatch_count:
        blockers.append(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH)
    unique_blockers = sorted(set(blockers))
    ok = not unique_blockers
    max_age_seconds = max(1, int(settings_obj.tigerbeetle_reconcile_max_age_seconds))
    payload: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "ok": ok,
        "cluster_id": settings_obj.tigerbeetle_cluster_id,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "age_seconds": 0,
        "reconciliation_stale": False,
        "reconciliation_max_age_seconds": max_age_seconds,
        "reconciliation_freshness": {
            "observed_at": finished_at.isoformat(),
            "age_seconds": 0,
            "max_age_seconds": max_age_seconds,
            "stale": False,
        },
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "client_lookup_ok": client_lookup_ok,
        "client_error": client_error,
        "account_ref_count": _payload_int(ref_counts, "account_ref_count"),
        "transfer_ref_count": _payload_int(ref_counts, "transfer_ref_count"),
        "checked_transfer_count": checked_transfer_count,
        "missing_transfer_count": missing_transfer_count,
        "mismatched_transfer_count": mismatched_transfer_count,
        "mismatched_ref_count": mismatched_transfer_count,
        "source_missing_count": source_missing_count,
        "source_row_missing_count": source_row_missing_count,
        "missing_source_row_count": source_row_missing_count,
        "source_amount_mismatch_count": source_amount_mismatch_count,
        "legacy_source_amount_unverifiable_count": (
            legacy_source_amount_unverifiable_count
        ),
        "runtime_ledger_checked_transfer_count": runtime_ledger_checked_transfer_count,
        "runtime_ledger_signed_transfer_count": runtime_ledger_signed_transfer_count,
        "runtime_ledger_ref_count": _payload_int(
            ref_counts,
            "runtime_ledger_ref_count",
        ),
        "runtime_ledger_signed_ref_count": _payload_int(
            ref_counts,
            "runtime_ledger_signed_ref_count",
        ),
        "runtime_ledger_missing_signed_ref_count": (
            runtime_ledger_missing_signed_ref_count
        ),
        "runtime_ledger_missing_account_ref_count": (
            runtime_ledger_missing_account_ref_count
        ),
        "stable_ref_count": _payload_int(ref_counts, "stable_ref_count"),
        "stable_ref_missing_count": _payload_int(
            ref_counts,
            "stable_ref_missing_count",
        ),
        "stable_ref_mismatch_count": max(
            stable_ref_mismatch_count,
            ref_count_stable_ref_mismatch_count,
        ),
        "archived_runtime_ledger_source_missing_count": archived_runtime_ledger_source_missing_count,
        "runtime_ledger_direction_mismatch_count": (
            runtime_ledger_direction_mismatch_count
        ),
        "runtime_ledger_metadata_mismatch_count": (
            runtime_ledger_metadata_mismatch_count
        ),
        "unlinked_event_count": unlinked_event_count,
        "unlinked_order_event_ref_count": unlinked_event_count,
        "unlinked_execution_count": unlinked_execution_count,
        "unlinked_execution_ref_count": unlinked_execution_count,
        "unlinked_cost_count": unlinked_cost_count,
        "unlinked_cost_ref_count": unlinked_cost_count,
        "unlinked_runtime_ledger_count": unlinked_runtime_ledger_count,
        "unlinked_runtime_ledger_ref_count": unlinked_runtime_ledger_count,
        "ref_counts": ref_counts,
        "missing_transfer_refs": missing_transfer_refs,
        "mismatched_refs": mismatched_refs,
        "missing_source_rows": missing_source_rows,
        "unlinked_refs": unlinked_refs,
        "legacy_source_amount_unverifiable_refs": (
            legacy_source_amount_unverifiable_refs
        ),
        "blocker_details": {
            "missing_transfer_refs": missing_transfer_refs,
            "mismatched_refs": mismatched_refs,
            "missing_source_rows": missing_source_rows,
            "unlinked_refs": unlinked_refs,
            "legacy_source_amount_unverifiable_refs": (
                legacy_source_amount_unverifiable_refs
            ),
        },
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
