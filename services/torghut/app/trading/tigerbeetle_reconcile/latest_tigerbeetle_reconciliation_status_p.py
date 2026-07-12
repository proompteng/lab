"""TigerBeetle reconciliation for Torghut ledger references."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.models import (
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
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
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
    SCHEMA_VERSION,
    append_sample as _append_sample,
    archived_runtime_ledger_amount_micros as _archived_runtime_ledger_amount_micros,
    attr as _attr,
    compact_reconciliation_ref_counts as _compact_reconciliation_ref_counts,
    expected_source_amount_micros as _expected_source_amount_micros,
    legacy_unversioned_source_ref as _legacy_unversioned_source_ref,
    payload_int as _payload_int,
    payload_value as _payload_value,
    ref_matches_expected_event as _ref_matches_expected_event,
    ref_sample as _ref_sample,
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
from .unlinked_refs import UnlinkedRefContext, collect_unlinked_refs


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


def _empty_strings() -> list[str]:
    return []


def _empty_samples() -> list[dict[str, object]]:
    return []


def _empty_transfer_refs() -> list[TigerBeetleTransferRef]:
    return []


def _empty_transfer_lookup() -> dict[str, object]:
    return {}


@dataclass
class _ReconciliationState:
    counts: _ReconciliationCounts = field(default_factory=_empty_counts)
    blockers: list[str] = field(default_factory=_empty_strings)
    mismatched_refs: list[dict[str, object]] = field(default_factory=_empty_samples)
    missing_transfer_refs: list[dict[str, object]] = field(
        default_factory=_empty_samples
    )
    missing_source_rows: list[dict[str, object]] = field(default_factory=_empty_samples)
    unlinked_refs: list[dict[str, object]] = field(default_factory=_empty_samples)
    legacy_source_amount_unverifiable_refs: list[dict[str, object]] = field(
        default_factory=_empty_samples
    )
    ref_list: Sequence[TigerBeetleTransferRef] = field(
        default_factory=_empty_transfer_refs
    )
    transfer_lookup: dict[str, object] = field(default_factory=_empty_transfer_lookup)
    client_lookup_ok: bool = True
    client_error: str | None = None


@dataclass(frozen=True)
class _TransferValidationContext:
    ref: TigerBeetleTransferRef
    actual: object
    state: _ReconciliationState


@dataclass(frozen=True)
class _SourceValidationContext:
    ref: TigerBeetleTransferRef
    state: _ReconciliationState


@dataclass(frozen=True)
class _ReconciliationRequest:
    settings_obj: Settings
    client: TigerBeetleClientProtocol | None
    limit: int
    persist: bool
    account_label: str | None


@dataclass(frozen=True)
class _PayloadBuildContext:
    settings_obj: Settings
    started_at: datetime
    finished_at: datetime
    state: _ReconciliationState
    ref_counts: dict[str, object]
    unique_blockers: list[str]
    source_missing_count: int
    ref_count_stable_ref_mismatch_count: int


@dataclass(frozen=True)
class _PersistenceContext:
    settings_obj: Settings
    started_at: datetime
    finished_at: datetime
    unique_blockers: list[str]
    ref_counts: dict[str, object]
    compact_ref_counts: dict[str, object]
    payload: dict[str, object]
    counts: _ReconciliationCounts


# ---------------------------------------------------------------------------
# Single transfer processing
# ---------------------------------------------------------------------------


def _process_single_transfer(
    session: Session,
    ref: TigerBeetleTransferRef,
    actual: object | None,
    settings_obj: Settings,
    state: _ReconciliationState,
) -> None:
    """Validate a single transfer against expected state."""

    counts = state.counts
    if not _stable_ref_matches(ref):
        counts.stable_ref_mismatch_count += 1
        counts.mismatched_transfer_count += 1
        state.blockers.append(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH)
        _append_sample(
            state.mismatched_refs,
            _ref_sample(
                ref,
                blocker=BLOCKER_STABLE_REF_PAYLOAD_MISMATCH,
                reason="stable_ref_payload_does_not_match_transfer_ref_identity",
            ),
        )

    source_validation = _SourceValidationContext(ref=ref, state=state)
    _validate_postgres_source_ref(session, settings_obj, source_validation)

    if not state.client_lookup_ok:
        return

    if actual is None:
        counts.missing_transfer_count += 1
        state.blockers.append(BLOCKER_TRANSFER_MISSING)
        _append_sample(
            state.missing_transfer_refs,
            _ref_sample(
                ref,
                blocker=BLOCKER_TRANSFER_MISSING,
                reason="transfer_ref_not_found_in_tigerbeetle_lookup",
            ),
        )
        return

    validation = _TransferValidationContext(ref=ref, actual=actual, state=state)
    _validate_transfer_fields(validation)
    if ref.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET:
        _validate_runtime_ledger(session, validation)


def _validate_transfer_fields(context: _TransferValidationContext) -> None:
    _check_field(
        context,
        "amount",
        lambda a, r: Decimal(str(_attr(a, "amount"))) != r.amount,
        BLOCKER_AMOUNT_MISMATCH,
    )
    _check_field(
        context,
        "code",
        lambda a, r: int(str(_attr(a, "code"))) != r.code,
        BLOCKER_CODE_MISMATCH,
    )
    _check_field(
        context,
        "ledger",
        lambda a, r: int(str(_attr(a, "ledger"))) != r.ledger,
        BLOCKER_LEDGER_MISMATCH,
    )

    debit_account_id = _payload_value(context.ref, "debit_account_id")
    if debit_account_id is not None and _u128_text(
        _attr(context.actual, "debit_account_id")
    ) != _u128_text(debit_account_id):
        _check_and_append(
            context,
            BLOCKER_DEBIT_ACCOUNT_MISMATCH,
            "actual_debit_account_differs_from_transfer_ref_payload",
        )

    credit_account_id = _payload_value(context.ref, "credit_account_id")
    if credit_account_id is not None and _u128_text(
        _attr(context.actual, "credit_account_id")
    ) != _u128_text(credit_account_id):
        _check_and_append(
            context,
            BLOCKER_CREDIT_ACCOUNT_MISMATCH,
            "actual_credit_account_differs_from_transfer_ref_payload",
        )


def _check_field(
    context: _TransferValidationContext,
    field_name: str,
    check_fn: Callable[[object, TigerBeetleTransferRef], bool],
    blocker: str,
) -> None:
    if check_fn(context.actual, context.ref):
        context.state.counts.mismatched_transfer_count += 1
        context.state.blockers.append(blocker)
        _append_sample(
            context.state.mismatched_refs,
            _ref_sample(
                context.ref,
                blocker=blocker,
                reason=f"actual_{field_name}_differs_from_transfer_ref",
                actual=context.actual,
            ),
        )


def _check_and_append(
    context: _TransferValidationContext,
    blocker: str,
    reason: str,
) -> None:
    context.state.counts.mismatched_transfer_count += 1
    context.state.blockers.append(blocker)
    _append_sample(
        context.state.mismatched_refs,
        _ref_sample(
            context.ref,
            blocker=blocker,
            reason=reason,
            actual=context.actual,
        ),
    )


def _validate_postgres_source_ref(
    session: Session,
    settings_obj: Settings,
    context: _SourceValidationContext,
) -> None:
    if not _ref_matches_expected_event(session, context.ref, settings_obj=settings_obj):
        context.state.counts.mismatched_transfer_count += 1
        context.state.blockers.append(BLOCKER_POSTGRES_REF_MISMATCH)
        _append_sample(
            context.state.mismatched_refs,
            _ref_sample(
                context.ref,
                blocker=BLOCKER_POSTGRES_REF_MISMATCH,
                reason="transfer_ref_no_longer_matches_order_event_plan",
            ),
        )

    if context.ref.source_type in {
        SOURCE_TYPE_EXECUTION,
        SOURCE_TYPE_EXECUTION_TCA_METRIC,
        SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    }:
        _validate_source_amount(session, context)
    if context.ref.source_type == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET:
        context.state.counts.runtime_ledger_checked_transfer_count += 1


def _validate_source_amount(
    session: Session,
    context: _SourceValidationContext,
) -> None:
    ref = context.ref
    counts = context.state.counts
    expected_source_amount = _expected_source_amount_micros(session, ref)
    if expected_source_amount is None:
        archived_amount = _archived_runtime_ledger_amount_micros(ref)
        if archived_amount is not None and ref.amount == archived_amount:
            counts.archived_runtime_ledger_source_missing_count += 1
        else:
            counts.source_row_missing_count += 1
            context.state.blockers.append(BLOCKER_SOURCE_ROW_MISSING)
            _append_sample(
                context.state.missing_source_rows,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_SOURCE_ROW_MISSING,
                    reason="source_row_missing_or_source_id_not_uuid",
                ),
            )
    elif ref.amount != expected_source_amount:
        if _legacy_unversioned_source_ref(ref):
            counts.legacy_source_amount_unverifiable_count += 1
            _append_sample(
                context.state.legacy_source_amount_unverifiable_refs,
                _ref_sample(
                    ref,
                    blocker="tigerbeetle_legacy_source_amount_unverifiable",
                    reason="legacy_source_ref_lacks_revision_or_archived_amount",
                ),
            )
        else:
            counts.source_amount_mismatch_count += 1
            context.state.blockers.append(BLOCKER_SOURCE_AMOUNT_MISMATCH)
            _append_sample(
                context.state.mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_SOURCE_AMOUNT_MISMATCH,
                    reason="source_amount_micros_differs_from_transfer_ref",
                ),
            )


def _validate_runtime_ledger(
    session: Session,
    context: _TransferValidationContext,
) -> None:
    ref = context.ref
    counts = context.state.counts
    source_uuid = _uuid_or_none(ref.source_id)
    bucket = (
        session.get(StrategyRuntimeLedgerBucket, source_uuid)
        if source_uuid is not None
        else None
    )
    if bucket is not None:
        direction_matches, metadata_matches = (
            _runtime_ledger_ref_matches_expected_bucket(ref, context.actual, bucket)
        )
        if direction_matches:
            counts.runtime_ledger_signed_transfer_count += 1
        else:
            counts.runtime_ledger_direction_mismatch_count += 1
            counts.mismatched_transfer_count += 1
            context.state.blockers.append(BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH)
            _append_sample(
                context.state.mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH,
                    reason="runtime_ledger_signed_direction_or_accounts_mismatch",
                    actual=context.actual,
                ),
            )
        if not metadata_matches:
            counts.runtime_ledger_metadata_mismatch_count += 1
            counts.mismatched_transfer_count += 1
            context.state.blockers.append(BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH)
            _append_sample(
                context.state.mismatched_refs,
                _ref_sample(
                    ref,
                    blocker=BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH,
                    reason="runtime_ledger_metadata_mismatch",
                    actual=context.actual,
                ),
            )


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------


def _assemble_reconciliation_payload(
    payload: dict[str, object],
    state: _ReconciliationState,
) -> dict[str, object]:
    payload["missing_transfer_refs"] = state.missing_transfer_refs
    payload["mismatched_refs"] = state.mismatched_refs
    payload["missing_source_rows"] = state.missing_source_rows
    payload["unlinked_refs"] = state.unlinked_refs
    payload["legacy_source_amount_unverifiable_refs"] = (
        state.legacy_source_amount_unverifiable_refs
    )
    payload["blocker_details"] = {
        "missing_transfer_refs": state.missing_transfer_refs,
        "mismatched_refs": state.mismatched_refs,
        "missing_source_rows": state.missing_source_rows,
        "unlinked_refs": state.unlinked_refs,
        "legacy_source_amount_unverifiable_refs": (
            state.legacy_source_amount_unverifiable_refs
        ),
    }
    return payload


def _build_payload_dict(context: _PayloadBuildContext) -> dict[str, object]:
    settings_obj = context.settings_obj
    counts = context.state.counts
    ref_counts = context.ref_counts
    ok = not context.unique_blockers
    max_age_seconds = max(1, int(settings_obj.tigerbeetle_reconcile_max_age_seconds))
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": ok,
        "cluster_id": settings_obj.tigerbeetle_cluster_id,
        "account_label": None,
        "started_at": context.started_at.isoformat(),
        "finished_at": context.finished_at.isoformat(),
        "age_seconds": 0,
        "reconciliation_stale": False,
        "reconciliation_max_age_seconds": max_age_seconds,
        "reconciliation_freshness": {
            "observed_at": context.finished_at.isoformat(),
            "age_seconds": 0,
            "max_age_seconds": max_age_seconds,
            "stale": False,
        },
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "client_lookup_ok": context.state.client_lookup_ok,
        "client_error": context.state.client_error,
        "account_ref_count": _payload_int(ref_counts, "account_ref_count"),
        "transfer_ref_count": _payload_int(ref_counts, "transfer_ref_count"),
        "checked_transfer_count": counts.checked_transfer_count,
        "missing_transfer_count": counts.missing_transfer_count,
        "mismatched_transfer_count": counts.mismatched_transfer_count,
        "mismatched_ref_count": counts.mismatched_transfer_count,
        "source_missing_count": context.source_missing_count,
        "source_row_missing_count": counts.source_row_missing_count,
        "missing_source_row_count": counts.source_row_missing_count,
        "source_amount_mismatch_count": counts.source_amount_mismatch_count,
        "legacy_source_amount_unverifiable_count": counts.legacy_source_amount_unverifiable_count,
        "runtime_ledger_checked_transfer_count": counts.runtime_ledger_checked_transfer_count,
        "runtime_ledger_signed_transfer_count": counts.runtime_ledger_signed_transfer_count,
        "runtime_ledger_ref_count": _payload_int(
            ref_counts, "runtime_ledger_ref_count"
        ),
        "runtime_ledger_signed_ref_count": _payload_int(
            ref_counts, "runtime_ledger_signed_ref_count"
        ),
        "runtime_ledger_missing_signed_ref_count": counts.runtime_ledger_missing_signed_ref_count,
        "runtime_ledger_missing_account_ref_count": counts.runtime_ledger_missing_account_ref_count,
        "stable_ref_count": _payload_int(ref_counts, "stable_ref_count"),
        "stable_ref_missing_count": _payload_int(
            ref_counts, "stable_ref_missing_count"
        ),
        "stable_ref_mismatch_count": max(
            counts.stable_ref_mismatch_count,
            context.ref_count_stable_ref_mismatch_count,
        ),
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
        "blockers": context.unique_blockers,
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
    return _process_reconciliation(
        session,
        _ReconciliationRequest(
            settings_obj=settings_obj,
            client=client,
            limit=limit,
            persist=persist,
            account_label=account_label,
        ),
    )


def _run_client_lookup(
    session: Session,
    request: _ReconciliationRequest,
) -> _ReconciliationState:
    refs = _reconciliation_transfer_refs(
        session,
        cluster_id=request.settings_obj.tigerbeetle_cluster_id,
        limit=request.limit,
    )
    state = _ReconciliationState(ref_list=refs)
    tb_client: TigerBeetleClientProtocol | None = None
    owned_client = request.client is None

    try:
        if refs:
            tb_client = request.client or create_tigerbeetle_client(
                request.settings_obj
            )
            looked_up = tb_client.lookup_transfers(
                [int(ref.transfer_id) for ref in refs]
            )
            state.transfer_lookup = {
                lookup_key: item
                for item in looked_up
                if (lookup_key := _transfer_lookup_key(item)) is not None
            }
    except Exception as exc:
        state.client_lookup_ok = False
        state.client_error = f"{type(exc).__name__}: {exc}"
        state.blockers.append(BLOCKER_CLIENT_UNAVAILABLE)
    finally:
        if owned_client and tb_client is not None:
            close = getattr(tb_client, "close", None)
            if callable(close):
                close()
    return state


def _process_refs(
    session: Session,
    refs: Sequence[TigerBeetleTransferRef],
    settings_obj: Settings,
    state: _ReconciliationState,
) -> None:
    state.counts.checked_transfer_count = len(refs)
    for ref in refs:
        ref_transfer_id = _u128_text(ref.transfer_id) or str(ref.transfer_id)
        actual = (
            state.transfer_lookup.get(ref_transfer_id)
            if state.client_lookup_ok
            else None
        )
        _process_single_transfer(
            session,
            ref,
            actual,
            settings_obj,
            state,
        )


def _collect_unlinked(
    session: Session,
    request: _ReconciliationRequest,
    state: _ReconciliationState,
) -> None:
    collected = collect_unlinked_refs(
        UnlinkedRefContext(
            session=session,
            settings_obj=request.settings_obj,
            limit=request.limit,
            account_label=request.account_label,
            blockers=state.blockers,
            samples=state.unlinked_refs,
        )
    )
    state.counts.unlinked_event_count = collected.event_count
    state.counts.unlinked_execution_count = collected.execution_count
    state.counts.unlinked_cost_count = collected.cost_count
    state.counts.unlinked_runtime_ledger_count = collected.runtime_ledger_count


def _process_reconciliation(
    session: Session,
    request: _ReconciliationRequest,
) -> dict[str, object]:
    started_at = datetime.now(timezone.utc)
    state = _run_client_lookup(session, request)
    if state.ref_list:
        _process_refs(session, state.ref_list, request.settings_obj, state)
    _collect_unlinked(session, request, state)
    return _build_final_payload(session, started_at, request, state)


def _build_final_payload(
    session: Session,
    started_at: datetime,
    request: _ReconciliationRequest,
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
    ref_counts = tigerbeetle_ref_counts(
        session,
        cluster_id=request.settings_obj.tigerbeetle_cluster_id,
        account_label=request.account_label,
    )
    compact_ref_counts = _compact_reconciliation_ref_counts(
        ref_counts, cluster_id=request.settings_obj.tigerbeetle_cluster_id
    )
    runtime_ledger_missing_signed_ref_count = _payload_int(
        ref_counts, "runtime_ledger_missing_signed_ref_count"
    )
    runtime_ledger_missing_account_ref_count = _payload_int(
        ref_counts, "runtime_ledger_missing_account_ref_count"
    )
    state.counts.runtime_ledger_missing_signed_ref_count = (
        runtime_ledger_missing_signed_ref_count
    )
    state.counts.runtime_ledger_missing_account_ref_count = (
        runtime_ledger_missing_account_ref_count
    )
    ref_count_stable_ref_mismatch_count = _payload_int(
        ref_counts, "stable_ref_mismatch_count"
    )
    if runtime_ledger_missing_signed_ref_count:
        state.blockers.append(BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING)
    if runtime_ledger_missing_account_ref_count:
        state.blockers.append(BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING)
    if ref_count_stable_ref_mismatch_count:
        state.blockers.append(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH)
    unique_blockers = sorted(set(state.blockers))

    payload = _build_payload_dict(
        _PayloadBuildContext(
            settings_obj=request.settings_obj,
            started_at=started_at,
            finished_at=finished_at,
            state=state,
            ref_counts=ref_counts,
            unique_blockers=unique_blockers,
            source_missing_count=source_missing_count,
            ref_count_stable_ref_mismatch_count=(ref_count_stable_ref_mismatch_count),
        )
    )
    payload = _assemble_reconciliation_payload(payload, state)
    payload["account_label"] = request.account_label

    if request.persist:
        _persist_reconciliation_run(
            session,
            _PersistenceContext(
                settings_obj=request.settings_obj,
                started_at=started_at,
                finished_at=finished_at,
                unique_blockers=unique_blockers,
                ref_counts=ref_counts,
                compact_ref_counts=compact_ref_counts,
                payload=payload,
                counts=state.counts,
            ),
        )
    return payload


def _persist_reconciliation_run(
    session: Session,
    context: _PersistenceContext,
) -> None:
    counts = context.counts
    compact_ref_counts = context.compact_ref_counts
    session.add(
        TigerBeetleReconciliationRun(
            cluster_id=context.settings_obj.tigerbeetle_cluster_id,
            started_at=context.started_at,
            finished_at=context.finished_at,
            status="ok" if not context.unique_blockers else "degraded",
            checked_transfer_count=counts.checked_transfer_count,
            missing_transfer_count=counts.missing_transfer_count,
            mismatched_transfer_count=counts.mismatched_transfer_count,
            source_missing_count=counts.source_row_missing_count
            + counts.source_amount_mismatch_count
            + counts.unlinked_event_count
            + counts.unlinked_execution_count
            + counts.unlinked_cost_count
            + counts.unlinked_runtime_ledger_count,
            account_ref_count=_payload_int(compact_ref_counts, "account_ref_count"),
            transfer_ref_count=_payload_int(compact_ref_counts, "transfer_ref_count"),
            runtime_ledger_ref_count=_payload_int(
                compact_ref_counts, "runtime_ledger_ref_count"
            ),
            runtime_ledger_signed_ref_count=_payload_int(
                compact_ref_counts, "runtime_ledger_signed_ref_count"
            ),
            runtime_ledger_missing_signed_ref_count=counts.runtime_ledger_missing_signed_ref_count,
            runtime_ledger_missing_account_ref_count=counts.runtime_ledger_missing_account_ref_count,
            stable_ref_count=_payload_int(compact_ref_counts, "stable_ref_count"),
            stable_ref_missing_count=_payload_int(
                compact_ref_counts, "stable_ref_missing_count"
            ),
            stable_ref_mismatch_count=max(
                counts.stable_ref_mismatch_count,
                _payload_int(context.ref_counts, "stable_ref_mismatch_count"),
            ),
            blockers_json=coerce_json_payload(context.unique_blockers),
            ref_counts_json=coerce_json_payload(compact_ref_counts),
            payload_json=coerce_json_payload(context.payload),
        )
    )
    session.flush()


__all__ = (
    "latest_tigerbeetle_reconciliation_status_payload",
    "latest_tigerbeetle_reconciliation_payload",
    "reconcile_tigerbeetle_transfers",
)
