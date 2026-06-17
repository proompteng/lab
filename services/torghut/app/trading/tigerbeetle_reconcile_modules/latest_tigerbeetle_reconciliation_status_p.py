# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""TigerBeetle reconciliation for Torghut ledger references."""

from __future__ import annotations

import sys
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

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
)
from . import shared_context as _shared_context_private_52

from .runtime_ledger_ref_coverage import (
    tigerbeetle_ref_counts,
)
from . import runtime_ledger_ref_coverage as _runtime_ledger_ref_coverage_private_109

_account_payload_matches = getattr(
    _shared_context_private_52, "_account_payload_matches"
)
_append_sample = getattr(_shared_context_private_52, "_append_sample")
_archived_runtime_ledger_amount_micros = getattr(
    _shared_context_private_52, "_archived_runtime_ledger_amount_micros"
)
_archived_source_amount_micros = getattr(
    _shared_context_private_52, "_archived_source_amount_micros"
)
_as_aware_utc = getattr(_shared_context_private_52, "_as_aware_utc")
_attr = getattr(_shared_context_private_52, "_attr")
_compact_reconciliation_ref_counts = getattr(
    _shared_context_private_52, "_compact_reconciliation_ref_counts"
)
_cost_amount_micros = getattr(_shared_context_private_52, "_cost_amount_micros")
_execution_amount_micros = getattr(
    _shared_context_private_52, "_execution_amount_micros"
)
_expected_source_amount_micros = getattr(
    _shared_context_private_52, "_expected_source_amount_micros"
)
_legacy_unversioned_source_ref = getattr(
    _shared_context_private_52, "_legacy_unversioned_source_ref"
)
_order_event_ref_exists = getattr(_shared_context_private_52, "_order_event_ref_exists")
_payload_int = getattr(_shared_context_private_52, "_payload_int")
_payload_mapping = getattr(_shared_context_private_52, "_payload_mapping")
_payload_string_list = getattr(_shared_context_private_52, "_payload_string_list")
_payload_value = getattr(_shared_context_private_52, "payload_value")
_ref_matches_expected_event = getattr(
    _shared_context_private_52, "_ref_matches_expected_event"
)
_ref_sample = getattr(_shared_context_private_52, "_ref_sample")
_runtime_ledger_amount_micros = getattr(
    _shared_context_private_52, "_runtime_ledger_amount_micros"
)
_runtime_ledger_payload_account_ids = getattr(
    _shared_context_private_52, "_runtime_ledger_payload_account_ids"
)
_runtime_ledger_ref_is_signed = getattr(
    _shared_context_private_52, "_runtime_ledger_ref_is_signed"
)
_source_materialization_payload = getattr(
    _shared_context_private_52, "_source_materialization_payload"
)
_source_ref_exists = getattr(_shared_context_private_52, "_source_ref_exists")
_stable_ref_archives_event_transfer = getattr(
    _shared_context_private_52, "_stable_ref_archives_event_transfer"
)
_stable_ref_matches = getattr(_shared_context_private_52, "_stable_ref_matches")
_stable_ref_payload = getattr(_shared_context_private_52, "_stable_ref_payload")
_transfer_lookup_key = getattr(_shared_context_private_52, "_transfer_lookup_key")
_u128_text = getattr(_shared_context_private_52, "_u128_text")
_usd_to_micros = getattr(_shared_context_private_52, "_usd_to_micros")
_uuid_or_none = getattr(_shared_context_private_52, "_uuid_or_none")
_latest_run_compact_status_payload = getattr(
    _runtime_ledger_ref_coverage_private_109, "_latest_run_compact_status_payload"
)
_latest_run_payload = getattr(
    _runtime_ledger_ref_coverage_private_109, "_latest_run_payload"
)
_reconciliation_transfer_refs = getattr(
    _runtime_ledger_ref_coverage_private_109, "_reconciliation_transfer_refs"
)
_runtime_ledger_ref_coverage = getattr(
    _runtime_ledger_ref_coverage_private_109, "_runtime_ledger_ref_coverage"
)
_runtime_ledger_ref_matches_expected_bucket = getattr(
    _runtime_ledger_ref_coverage_private_109,
    "_runtime_ledger_ref_matches_expected_bucket",
)


def _tigerbeetle_reconcile_root_export(name: str, fallback: Any) -> Any:
    root_module = sys.modules.get("app.trading.tigerbeetle_reconcile")
    if root_module is None:
        return fallback
    return getattr(root_module, name, fallback)


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
            client_factory = _tigerbeetle_reconcile_root_export(
                "create_tigerbeetle_client",
                create_tigerbeetle_client,
            )
            tb_client = client or client_factory(settings_obj)
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

    runtime_bucket_filters: list[ColumnElement[bool]] = [
        (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
        | (StrategyRuntimeLedgerBucket.cost_amount != 0)
    ]
    if account_label:
        runtime_bucket_filters.append(
            StrategyRuntimeLedgerBucket.account_label == account_label
        )
    recent_runtime_buckets = (
        session.execute(
            select(StrategyRuntimeLedgerBucket)
            .where(*runtime_bucket_filters)
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
        account_label=account_label,
    )
    compact_ref_counts = _compact_reconciliation_ref_counts(
        ref_counts,
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
        "account_label": account_label,
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
                account_ref_count=_payload_int(compact_ref_counts, "account_ref_count"),
                transfer_ref_count=_payload_int(
                    compact_ref_counts, "transfer_ref_count"
                ),
                runtime_ledger_ref_count=_payload_int(
                    compact_ref_counts,
                    "runtime_ledger_ref_count",
                ),
                runtime_ledger_signed_ref_count=_payload_int(
                    compact_ref_counts,
                    "runtime_ledger_signed_ref_count",
                ),
                runtime_ledger_missing_signed_ref_count=(
                    runtime_ledger_missing_signed_ref_count
                ),
                runtime_ledger_missing_account_ref_count=(
                    runtime_ledger_missing_account_ref_count
                ),
                stable_ref_count=_payload_int(compact_ref_counts, "stable_ref_count"),
                stable_ref_missing_count=_payload_int(
                    compact_ref_counts,
                    "stable_ref_missing_count",
                ),
                stable_ref_mismatch_count=max(
                    stable_ref_mismatch_count,
                    ref_count_stable_ref_mismatch_count,
                ),
                blockers_json=coerce_json_payload(unique_blockers),
                ref_counts_json=coerce_json_payload(compact_ref_counts),
                payload_json=coerce_json_payload(payload),
            )
        )
        session.flush()
    return payload


__all__ = (
    "latest_tigerbeetle_reconciliation_status_payload",
    "latest_tigerbeetle_reconciliation_payload",
    "reconcile_tigerbeetle_transfers",
)
