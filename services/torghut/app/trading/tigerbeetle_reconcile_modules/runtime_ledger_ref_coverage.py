# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821

from .shared_context import (
    BLOCKER_AMOUNT_MISMATCH,
    BLOCKER_CLIENT_UNAVAILABLE,
    BLOCKER_CODE_MISMATCH,
    BLOCKER_CREDIT_ACCOUNT_MISMATCH,
    BLOCKER_DEBIT_ACCOUNT_MISMATCH,
    BLOCKER_LEDGER_MISMATCH,
    BLOCKER_POSTGRES_REF_MISMATCH,
    BLOCKER_RECONCILIATION_STALE,
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
    COMPACT_REF_COUNT_FLAG_KEYS,
    COMPACT_REF_COUNT_KEYS,
    REF_COUNT_FIELD_NAMES,
    SAMPLE_LIMIT,
    SCHEMA_VERSION,
    account_payload_matches as _account_payload_matches,
    append_sample as _append_sample,
    archived_runtime_ledger_amount_micros as _archived_runtime_ledger_amount_micros,
    archived_source_amount_micros as _archived_source_amount_micros,
    as_aware_utc as _as_aware_utc,
    attr as _attr,
    compact_reconciliation_ref_counts as _compact_reconciliation_ref_counts,
    cost_amount_micros as _cost_amount_micros,
    execution_amount_micros as _execution_amount_micros,
    expected_source_amount_micros as _expected_source_amount_micros,
    legacy_unversioned_source_ref as _legacy_unversioned_source_ref,
    order_event_ref_exists as _order_event_ref_exists,
    payload_int as _payload_int,
    payload_mapping as _payload_mapping,
    payload_string_list as _payload_string_list,
    payload_value as _payload_value,
    ref_matches_expected_event as _ref_matches_expected_event,
    ref_sample as _ref_sample,
    runtime_ledger_amount_micros as _runtime_ledger_amount_micros,
    runtime_ledger_payload_account_ids as _runtime_ledger_payload_account_ids,
    runtime_ledger_ref_is_signed as _runtime_ledger_ref_is_signed,
    source_materialization_payload as _source_materialization_payload,
    source_ref_exists as _source_ref_exists,
    stable_ref_archives_event_transfer as _stable_ref_archives_event_transfer,
    stable_ref_matches as _stable_ref_matches,
    stable_ref_payload as _stable_ref_payload,
    transfer_lookup_key as _transfer_lookup_key,
    u128_text as _u128_text,
    usd_to_micros as _usd_to_micros,
    uuid_or_none as _uuid_or_none,
)


def _runtime_ledger_ref_coverage(
    session: Session,
    *,
    cluster_id: int,
    account_label: str | None = None,
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
    required_bucket_filters: list[ColumnElement[bool]] = [
        (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
        | (StrategyRuntimeLedgerBucket.cost_amount != 0)
    ]
    if account_label:
        required_bucket_filters.append(
            StrategyRuntimeLedgerBucket.account_label == account_label
        )
    required_runtime_bucket_count = int(
        session.scalar(
            select(func.count(StrategyRuntimeLedgerBucket.id)).where(
                *required_bucket_filters
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
                        *required_bucket_filters
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
            select(StrategyRuntimeLedgerBucket.id).where(*required_bucket_filters)
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
    account_label: str | None = None,
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
        account_label=account_label,
        full_ref_scan=full_ref_scan,
    )
    return {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": cluster_id,
        "account_label": account_label,
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
            "runtime_ledger_account_label_scope": account_label,
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
        {key for key in REF_COUNT_FIELD_NAMES if key in payload or key in ref_counts}
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


def _latest_run_compact_status_payload(
    row: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if row is None:
        return None
    raw_blockers_json = row.get("blockers_json")
    raw_ref_counts_json = row.get("ref_counts_json")
    if raw_blockers_json is None and raw_ref_counts_json is None:
        return None

    blockers = _payload_string_list({"blockers": raw_blockers_json}, "blockers")
    raw_ref_counts = (
        cast(Mapping[str, object], raw_ref_counts_json)
        if isinstance(raw_ref_counts_json, Mapping)
        else cast(Mapping[str, object], {})
    )
    ref_count_source = dict(raw_ref_counts)
    for key in REF_COUNT_FIELD_NAMES:
        ref_count_source[key] = _payload_int(row, key)

    cluster_id = _payload_int(row, "cluster_id")
    ref_counts = _compact_reconciliation_ref_counts(
        ref_count_source,
        cluster_id=cluster_id,
    )

    raw_started_at = row.get("started_at")
    started_at = (
        _as_aware_utc(raw_started_at)
        if isinstance(raw_started_at, datetime)
        else datetime.now(timezone.utc)
    )
    raw_finished_at = row.get("finished_at")
    finished_at = (
        _as_aware_utc(raw_finished_at)
        if isinstance(raw_finished_at, datetime)
        else None
    )
    observed_at = finished_at or started_at
    age_seconds = max(
        0,
        int((datetime.now(timezone.utc) - observed_at).total_seconds()),
    )
    max_age_seconds = max(1, int(settings.tigerbeetle_reconcile_max_age_seconds))
    stale = age_seconds > max_age_seconds
    status = str(row.get("status") or "unknown")
    source_missing_count = _payload_int(row, "source_missing_count")
    mismatched_transfer_count = _payload_int(row, "mismatched_transfer_count")
    client_lookup_ok = status == "ok" and BLOCKER_CLIENT_UNAVAILABLE not in blockers
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": status == "ok" and not blockers,
        "cluster_id": cluster_id,
        "status": status,
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
        "client_lookup_ok": client_lookup_ok,
        "client_error": None,
        "account_ref_count": _payload_int(row, "account_ref_count"),
        "transfer_ref_count": _payload_int(row, "transfer_ref_count"),
        "checked_transfer_count": _payload_int(row, "checked_transfer_count"),
        "missing_transfer_count": _payload_int(row, "missing_transfer_count"),
        "mismatched_transfer_count": mismatched_transfer_count,
        "mismatched_ref_count": mismatched_transfer_count,
        "source_missing_count": source_missing_count,
        "source_row_missing_count": source_missing_count,
        "missing_source_row_count": source_missing_count,
        "source_amount_mismatch_count": 0,
        "legacy_source_amount_unverifiable_count": 0,
        "runtime_ledger_checked_transfer_count": 0,
        "runtime_ledger_signed_transfer_count": 0,
        "runtime_ledger_ref_count": _payload_int(row, "runtime_ledger_ref_count"),
        "runtime_ledger_signed_ref_count": _payload_int(
            row,
            "runtime_ledger_signed_ref_count",
        ),
        "runtime_ledger_missing_signed_ref_count": _payload_int(
            row,
            "runtime_ledger_missing_signed_ref_count",
        ),
        "runtime_ledger_missing_account_ref_count": _payload_int(
            row,
            "runtime_ledger_missing_account_ref_count",
        ),
        "stable_ref_count": _payload_int(row, "stable_ref_count"),
        "stable_ref_missing_count": _payload_int(row, "stable_ref_missing_count"),
        "stable_ref_mismatch_count": _payload_int(row, "stable_ref_mismatch_count"),
        "archived_runtime_ledger_source_missing_count": 0,
        "runtime_ledger_direction_mismatch_count": 0,
        "runtime_ledger_metadata_mismatch_count": 0,
        "unlinked_event_count": 0,
        "unlinked_order_event_ref_count": 0,
        "unlinked_execution_count": 0,
        "unlinked_execution_ref_count": 0,
        "unlinked_cost_count": 0,
        "unlinked_cost_ref_count": 0,
        "unlinked_runtime_ledger_count": 0,
        "unlinked_runtime_ledger_ref_count": 0,
        "missing_transfer_refs": [],
        "mismatched_refs": [],
        "missing_source_rows": [],
        "unlinked_refs": [],
        "legacy_source_amount_unverifiable_refs": [],
        "blocker_details": {},
        "ref_counts": ref_counts,
        "ref_count_field_names": list(REF_COUNT_FIELD_NAMES),
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat() if finished_at else None,
        "blockers": blockers,
        "compact_status": True,
        "payload_json_skipped": True,
    }


__all__ = ("tigerbeetle_ref_counts",)
