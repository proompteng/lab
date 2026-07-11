"""Read-only reconciliation leases for ambiguous broker mutations."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ...models import BrokerMutationReceiptEvent
from .lifecycle_helpers import (
    LockedReceipt,
    append_and_commit,
    lock_current_receipt,
    normalized_recovery_handle,
    normalized_recovery_observation,
    normalized_settlement,
    read_and_close,
    require_compatible_terminal,
    require_recovery_handle,
)
from .persistence import (
    close_read_transaction,
    database_now,
    full_state_values_from_event,
)
from .types import (
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryAcquireOutcome,
    BrokerMutationRecoveryAcquireResult,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservation,
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
)
from .validation import (
    RECEIPT_DEFAULT_LEASE_SECONDS,
    RECEIPT_DEFAULT_RECOVERY_SECONDS,
    RECEIPT_MAX_LEASE_SECONDS,
    RECEIPT_MAX_RECOVERY_SECONDS,
    RECEIPT_MIN_LEASE_SECONDS,
    RECEIPT_MIN_RECOVERY_SECONDS,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
    as_uuid,
    bounded_seconds,
    positive_integer,
    required_text,
)


@dataclass(frozen=True, slots=True)
class _RecoveryRequest:
    receipt_id: uuid.UUID
    owner: str
    writer_generation: int
    token: uuid.UUID
    lease_seconds: int


def list_due_broker_mutation_receipt_ids(
    session: Session,
    *,
    limit: int = 100,
) -> tuple[uuid.UUID, ...]:
    try:
        return _list_due_broker_mutation_receipt_ids(session, limit=limit)
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def _list_due_broker_mutation_receipt_ids(
    session: Session,
    *,
    limit: int = 100,
) -> tuple[uuid.UUID, ...]:
    """Return only latest ambiguous receipts; acquisition must recheck each ID."""

    bounded_limit = positive_integer(limit, field="limit")
    if bounded_limit > 1000:
        raise BrokerMutationReceiptValidationError("limit_too_large:1000")
    now = database_now(session)
    latest = (
        select(
            BrokerMutationReceiptEvent.receipt_id.label("receipt_id"),
            func.max(BrokerMutationReceiptEvent.sequence_no).label("sequence_no"),
        )
        .group_by(BrokerMutationReceiptEvent.receipt_id)
        .subquery()
    )
    rows = session.execute(
        select(BrokerMutationReceiptEvent.receipt_id)
        .join(
            latest,
            (BrokerMutationReceiptEvent.receipt_id == latest.c.receipt_id)
            & (BrokerMutationReceiptEvent.sequence_no == latest.c.sequence_no),
        )
        .where(
            BrokerMutationReceiptEvent.state == "broker_io",
            BrokerMutationReceiptEvent.recovery_after.is_not(None),
            BrokerMutationReceiptEvent.recovery_after <= now,
            or_(
                BrokerMutationReceiptEvent.recovery_lease_expires_at.is_(None),
                BrokerMutationReceiptEvent.recovery_lease_expires_at <= now,
            ),
        )
        .order_by(
            BrokerMutationReceiptEvent.recovery_after.asc(),
            BrokerMutationReceiptEvent.receipt_id.asc(),
        )
        .limit(bounded_limit)
    ).scalars()
    receipt_ids = tuple(as_uuid(value, field="receipt_id") for value in rows)
    close_read_transaction(session)
    return receipt_ids


def acquire_broker_mutation_recovery(
    session: Session,
    *,
    receipt_id: uuid.UUID | str,
    recovery_owner: str,
    writer_generation: int,
    options: BrokerMutationRecoveryAcquireOptions | None = None,
) -> BrokerMutationRecoveryAcquireResult:
    """Acquire one fenced, read-only reconciliation lease."""

    try:
        request = _normalize_recovery_request(
            receipt_id=receipt_id,
            recovery_owner=recovery_owner,
            writer_generation=writer_generation,
            options=options,
        )
        return _acquire_recovery(session, request)
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def _normalize_recovery_request(
    *,
    receipt_id: uuid.UUID | str,
    recovery_owner: str,
    writer_generation: int,
    options: BrokerMutationRecoveryAcquireOptions | None,
) -> _RecoveryRequest:
    configured = options or BrokerMutationRecoveryAcquireOptions()
    return _RecoveryRequest(
        receipt_id=as_uuid(receipt_id, field="receipt_id"),
        owner=required_text(recovery_owner, field="recovery_owner", maximum=128),
        writer_generation=positive_integer(
            writer_generation,
            field="writer_generation",
        ),
        token=(
            as_uuid(configured.recovery_token, field="recovery_token")
            if configured.recovery_token is not None
            else uuid.uuid4()
        ),
        lease_seconds=bounded_seconds(
            configured.lease_seconds,
            minimum=RECEIPT_MIN_LEASE_SECONDS,
            maximum=RECEIPT_MAX_LEASE_SECONDS,
            field="lease_seconds",
        ),
    )


def _acquire_recovery(
    session: Session,
    request: _RecoveryRequest,
) -> BrokerMutationRecoveryAcquireResult:
    current = lock_current_receipt(session, request.receipt_id)
    if current is None:
        return _recovery_result(session, "not_required", None)
    existing = _existing_recovery_result(session, current, request)
    if existing is not None:
        return existing
    observed = current.snapshot.recovery_handle
    if observed is not None and observed.recovery_token == request.token:
        raise BrokerMutationReceiptConflictError("broker_mutation_recovery_token_reuse")
    values = full_state_values_from_event(current.event)
    values.update(
        sequence_no=current.event.sequence_no + 1,
        event_type="recovery_claimed",
        event_writer_generation=request.writer_generation,
        recovery_token=request.token,
        recovery_epoch=current.event.recovery_epoch + 1,
        recovery_owner=request.owner,
        recovery_writer_generation=request.writer_generation,
        recovery_lease_started_at=current.now,
        recovery_lease_expires_at=current.now
        + timedelta(seconds=request.lease_seconds),
    )
    snapshot = append_and_commit(
        session,
        receipt_id=request.receipt_id,
        values=values,
    )
    return BrokerMutationRecoveryAcquireResult(outcome="acquired", receipt=snapshot)


def _existing_recovery_result(
    session: Session,
    current: LockedReceipt,
    request: _RecoveryRequest,
) -> BrokerMutationRecoveryAcquireResult | None:
    if current.snapshot.state != "broker_io":
        return _recovery_result(session, "not_required", current.snapshot)
    recovery_after = current.snapshot.lifecycle.recovery_after
    if recovery_after is None or recovery_after > current.now:
        return _recovery_result(session, "not_ready", current.snapshot)
    observed = current.snapshot.recovery_handle
    if observed is None or observed.recovery_lease_expires_at <= current.now:
        return None
    same_token = observed.recovery_token == request.token
    same_owner = observed.recovery_owner == request.owner
    same_generation = observed.recovery_writer_generation == request.writer_generation
    if same_token and not (same_owner and same_generation):
        raise BrokerMutationReceiptConflictError(
            "broker_mutation_recovery_identity_conflict"
        )
    outcome: BrokerMutationRecoveryAcquireOutcome = (
        "already_owned" if same_token else "busy"
    )
    return _recovery_result(session, outcome, current.snapshot)


def _recovery_result(
    session: Session,
    outcome: BrokerMutationRecoveryAcquireOutcome,
    snapshot: BrokerMutationReceiptSnapshot | None,
) -> BrokerMutationRecoveryAcquireResult:
    result = BrokerMutationRecoveryAcquireResult(outcome=outcome, receipt=snapshot)
    close_read_transaction(session)
    return result


def renew_broker_mutation_recovery(
    session: Session,
    *,
    handle: BrokerMutationRecoveryHandle,
    lease_seconds: int = RECEIPT_DEFAULT_LEASE_SECONDS,
) -> BrokerMutationReceiptSnapshot:
    """Extend an active recovery lease without changing its fence."""

    try:
        normalized = normalized_recovery_handle(handle)
        bounded_lease = bounded_seconds(
            lease_seconds,
            minimum=RECEIPT_MIN_LEASE_SECONDS,
            maximum=RECEIPT_MAX_LEASE_SECONDS,
            field="lease_seconds",
        )
        current = _locked_recovery(session, normalized)
        _require_active_recovery(current, normalized)
        lease_expires_at = current.now + timedelta(seconds=bounded_lease)
        observed_expiry = current.snapshot.recovery_handle
        if observed_expiry is None:  # pragma: no cover - handle validation proved it
            raise BrokerMutationReceiptError("recovery_handle_missing")
        if lease_expires_at <= observed_expiry.recovery_lease_expires_at:
            return read_and_close(session, current.snapshot)
        values = full_state_values_from_event(current.event)
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="recovery_renewed",
            event_writer_generation=normalized.recovery_writer_generation,
            recovery_lease_expires_at=lease_expires_at,
        )
        return append_and_commit(
            session,
            receipt_id=normalized.receipt_id,
            values=values,
        )
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def record_broker_mutation_recovery_observation(
    session: Session,
    *,
    handle: BrokerMutationRecoveryHandle,
    observation: BrokerMutationRecoveryObservation,
    retry_seconds: int = RECEIPT_DEFAULT_RECOVERY_SECONDS,
) -> BrokerMutationReceiptSnapshot:
    """Record a negative/unknown read without leaving broker-I/O quarantine."""

    try:
        normalized_handle = normalized_recovery_handle(handle)
        normalized_observation = normalized_recovery_observation(observation)
        bounded_retry = bounded_seconds(
            retry_seconds,
            minimum=RECEIPT_MIN_RECOVERY_SECONDS,
            maximum=RECEIPT_MAX_RECOVERY_SECONDS,
            field="retry_seconds",
        )
        current = _locked_recovery(session, normalized_handle)
        _require_active_recovery(current, normalized_handle)
        if (
            normalized_observation.checked_client_request_id
            != current.snapshot.intent.client_request_id
            or normalized_observation.checked_target_key
            != current.snapshot.intent.target.key
        ):
            raise BrokerMutationReceiptValidationError(
                "recovery_observation_identity_mismatch"
            )
        values = full_state_values_from_event(current.event)
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="recovery_observed",
            event_writer_generation=normalized_handle.recovery_writer_generation,
            recovery_after=current.now + timedelta(seconds=bounded_retry),
            recovery_checked_at=current.now,
            recovery_observation_epoch=normalized_handle.recovery_epoch,
            recovery_outcome=normalized_observation.outcome,
            recovery_evidence_json=normalized_observation.evidence_json,
            recovery_evidence_sha256=normalized_observation.evidence_sha256,
        )
        return append_and_commit(
            session,
            receipt_id=normalized_handle.receipt_id,
            values=values,
        )
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def release_broker_mutation_recovery(
    session: Session,
    *,
    handle: BrokerMutationRecoveryHandle,
) -> BrokerMutationReceiptSnapshot:
    """Release an active reconciliation lease while retaining its audit epoch."""

    try:
        normalized = normalized_recovery_handle(handle)
        current = _locked_recovery(session, normalized)
        if current.event.event_type == "recovery_released":
            return read_and_close(session, current.snapshot)
        _require_active_recovery(current, normalized)
        values = full_state_values_from_event(current.event)
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="recovery_released",
            event_writer_generation=normalized.recovery_writer_generation,
            recovery_lease_expires_at=current.now,
        )
        return append_and_commit(
            session,
            receipt_id=normalized.receipt_id,
            values=values,
        )
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def settle_broker_mutation_recovery(
    session: Session,
    *,
    handle: BrokerMutationRecoveryHandle,
    settlement: BrokerMutationSettlement,
) -> BrokerMutationReceiptSnapshot:
    """Settle broker truth discovered by a fenced recovery reader."""

    try:
        normalized_handle = normalized_recovery_handle(handle)
        normalized_terminal = normalized_settlement(
            settlement,
            expected_source="recovery",
        )
        current = _locked_recovery(session, normalized_handle)
        if current.snapshot.state == "settled":
            compatible = require_compatible_terminal(
                current.snapshot,
                normalized_terminal,
            )
            return read_and_close(session, compatible)
        _require_active_recovery(current, normalized_handle)
        values = full_state_values_from_event(current.event)
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=normalized_handle.recovery_writer_generation,
            settlement_source=normalized_terminal.source,
            settlement_outcome=normalized_terminal.outcome,
            broker_reference=normalized_terminal.broker_reference,
            execution_id=normalized_terminal.execution_id,
            settlement_evidence_json=normalized_terminal.evidence_json,
            settlement_evidence_sha256=normalized_terminal.evidence_sha256,
            settled_at=current.now,
        )
        return append_and_commit(
            session,
            receipt_id=normalized_handle.receipt_id,
            values=values,
        )
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def _locked_recovery(
    session: Session,
    handle: BrokerMutationRecoveryHandle,
) -> LockedReceipt:
    current = lock_current_receipt(session, handle.receipt_id)
    if current is None:
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_receipt_not_found:{handle.receipt_id}"
        )
    require_recovery_handle(current.snapshot, handle)
    return current


def _require_active_recovery(
    current: LockedReceipt,
    handle: BrokerMutationRecoveryHandle,
) -> None:
    if current.snapshot.state != "broker_io":
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_recovery_state_mismatch:{handle.receipt_id}"
        )
    observed = current.snapshot.recovery_handle
    if observed is None or observed.recovery_lease_expires_at <= current.now:
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_recovery_lease_expired:{handle.receipt_id}"
        )


__all__ = [
    "acquire_broker_mutation_recovery",
    "list_due_broker_mutation_receipt_ids",
    "record_broker_mutation_recovery_observation",
    "release_broker_mutation_recovery",
    "renew_broker_mutation_recovery",
    "settle_broker_mutation_recovery",
]
