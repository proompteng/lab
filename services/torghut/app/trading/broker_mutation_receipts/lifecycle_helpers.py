"""Shared validation and transaction helpers for receipt lifecycle operations."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import uuid
from dataclasses import dataclass
from datetime import datetime
from sqlalchemy.orm import Session

from ...models import BrokerMutationReceipt, BrokerMutationReceiptEvent
from .canonicalization import (
    verify_broker_mutation_recovery_observation,
    verify_broker_mutation_settlement,
)
from .persistence import (
    append_full_state_event,
    close_read_transaction,
    commit_or_rollback,
    database_now,
    load_latest_receipt_event,
    load_receipt_snapshot,
    lock_receipt,
    snapshot_from_models,
)
from .types import (
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservation,
    BrokerMutationSettlement,
    BrokerMutationSettlementSource,
)
from .validation import (
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
    as_utc_datetime,
    as_uuid,
    optional_text,
    positive_integer,
    required_text,
)


@dataclass(frozen=True, slots=True)
class LockedReceipt:
    header: BrokerMutationReceipt
    event: BrokerMutationReceiptEvent
    snapshot: BrokerMutationReceiptSnapshot
    now: datetime


@contextmanager
def rollback_session_on_error(session: Session) -> Iterator[None]:
    """Rollback every exceptional exit without adding a broad exception handler."""

    completed = False
    try:
        yield
        completed = True
    finally:
        if not completed:
            session.rollback()


def lock_current_receipt(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> LockedReceipt | None:
    header = lock_receipt(session, receipt_id)
    if header is None:
        return None
    event = load_latest_receipt_event(session, header.id)
    if event is None:
        raise BrokerMutationReceiptError("broker_mutation_receipt_event_missing")
    return LockedReceipt(
        header=header,
        event=event,
        snapshot=snapshot_from_models(header, event),
        now=database_now(session),
    )


def committed_snapshot(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> BrokerMutationReceiptSnapshot:
    commit_or_rollback(session)
    snapshot = load_receipt_snapshot(session, receipt_id)
    if snapshot is None:  # pragma: no cover - committed header cannot disappear
        close_read_transaction(session)
        raise BrokerMutationReceiptError("committed_broker_mutation_receipt_not_found")
    close_read_transaction(session)
    return snapshot


def append_and_commit(
    session: Session,
    *,
    receipt_id: uuid.UUID | str,
    values: dict[str, object],
) -> BrokerMutationReceiptSnapshot:
    append_full_state_event(session, receipt_id=receipt_id, values=values)
    return committed_snapshot(session, receipt_id)


def read_and_close(
    session: Session,
    snapshot: BrokerMutationReceiptSnapshot,
) -> BrokerMutationReceiptSnapshot:
    close_read_transaction(session)
    return snapshot


def normalized_primary_handle(
    handle: BrokerMutationReceiptHandle,
) -> BrokerMutationReceiptHandle:
    return BrokerMutationReceiptHandle(
        receipt_id=as_uuid(handle.receipt_id, field="receipt_id"),
        primary_token=as_uuid(handle.primary_token, field="primary_token"),
        primary_epoch=positive_integer(handle.primary_epoch, field="primary_epoch"),
        primary_owner=required_text(
            handle.primary_owner,
            field="primary_owner",
            maximum=128,
        ),
        primary_writer_generation=positive_integer(
            handle.primary_writer_generation,
            field="primary_writer_generation",
        ),
    )


def normalized_recovery_handle(
    handle: BrokerMutationRecoveryHandle,
) -> BrokerMutationRecoveryHandle:
    return BrokerMutationRecoveryHandle(
        receipt_id=as_uuid(handle.receipt_id, field="receipt_id"),
        recovery_token=as_uuid(handle.recovery_token, field="recovery_token"),
        recovery_epoch=positive_integer(handle.recovery_epoch, field="recovery_epoch"),
        recovery_owner=required_text(
            handle.recovery_owner,
            field="recovery_owner",
            maximum=128,
        ),
        recovery_writer_generation=positive_integer(
            handle.recovery_writer_generation,
            field="recovery_writer_generation",
        ),
        recovery_lease_expires_at=as_utc_datetime(
            handle.recovery_lease_expires_at,
            field="recovery_lease_expires_at",
        ),
    )


def primary_handle_matches(
    snapshot: BrokerMutationReceiptSnapshot,
    handle: BrokerMutationReceiptHandle,
) -> bool:
    return snapshot.primary_handle == handle


def recovery_handle_matches(
    snapshot: BrokerMutationReceiptSnapshot,
    handle: BrokerMutationRecoveryHandle,
) -> bool:
    observed = snapshot.recovery_handle
    return (
        observed is not None
        and observed.receipt_id == handle.receipt_id
        and observed.recovery_token == handle.recovery_token
        and observed.recovery_epoch == handle.recovery_epoch
        and observed.recovery_owner == handle.recovery_owner
        and observed.recovery_writer_generation == handle.recovery_writer_generation
    )


def require_primary_handle(
    snapshot: BrokerMutationReceiptSnapshot,
    handle: BrokerMutationReceiptHandle,
) -> None:
    if not primary_handle_matches(snapshot, handle):
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_primary_fenced:{handle.receipt_id}:{handle.primary_epoch}"
        )


def require_recovery_handle(
    snapshot: BrokerMutationReceiptSnapshot,
    handle: BrokerMutationRecoveryHandle,
) -> None:
    if not recovery_handle_matches(snapshot, handle):
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_recovery_fenced:{handle.receipt_id}:{handle.recovery_epoch}"
        )


def normalized_recovery_observation(
    observation: BrokerMutationRecoveryObservation,
) -> BrokerMutationRecoveryObservation:
    verify_broker_mutation_recovery_observation(observation)
    if observation.outcome not in {"not_found", "indeterminate"}:
        raise BrokerMutationReceiptValidationError("recovery_outcome_invalid")
    checked_client_request_id = required_text(
        observation.checked_client_request_id,
        field="checked_client_request_id",
        maximum=128,
    )
    checked_target_key = required_text(
        observation.checked_target_key,
        field="checked_target_key",
        maximum=256,
    )
    return BrokerMutationRecoveryObservation(
        checked_client_request_id=checked_client_request_id,
        checked_target_key=checked_target_key,
        outcome=observation.outcome,
        evidence_json=observation.evidence_json,
        evidence_sha256=observation.evidence_sha256,
    )


def normalized_settlement(
    settlement: BrokerMutationSettlement,
    *,
    expected_source: BrokerMutationSettlementSource,
) -> BrokerMutationSettlement:
    verify_broker_mutation_settlement(settlement)
    if settlement.source != expected_source:
        raise BrokerMutationReceiptValidationError(
            f"settlement_source_mismatch:{expected_source}:{settlement.source}"
        )
    if settlement.outcome not in {
        "acknowledged",
        "reconciled",
        "rejected",
        "already_satisfied",
        "validation_quarantine_closed",
    }:
        raise BrokerMutationReceiptValidationError("settlement_outcome_invalid")
    if expected_source == "preflight" and settlement.outcome != "already_satisfied":
        raise BrokerMutationReceiptValidationError(
            "preflight_requires_already_satisfied"
        )
    if expected_source != "preflight" and settlement.outcome == "already_satisfied":
        raise BrokerMutationReceiptValidationError(
            "already_satisfied_requires_preflight"
        )
    if expected_source == "recovery" and settlement.outcome == "acknowledged":
        raise BrokerMutationReceiptValidationError(
            "recovery_cannot_acknowledge_new_broker_io"
        )
    broker_reference = optional_text(
        settlement.broker_reference,
        field="broker_reference",
        maximum=256,
    )
    if (
        settlement.outcome in {"acknowledged", "reconciled"}
        and broker_reference is None
    ):
        raise BrokerMutationReceiptValidationError(
            f"{settlement.outcome}_requires_broker_reference"
        )
    return BrokerMutationSettlement(
        source=expected_source,
        outcome=settlement.outcome,
        broker_reference=broker_reference,
        execution_id=(
            as_uuid(settlement.execution_id, field="execution_id")
            if settlement.execution_id is not None
            else None
        ),
        evidence_json=settlement.evidence_json,
        evidence_sha256=settlement.evidence_sha256,
    )


def settlement_is_compatible(
    snapshot: BrokerMutationReceiptSnapshot,
    settlement: BrokerMutationSettlement,
) -> bool:
    observed = snapshot.settlement
    if observed.outcome is None or observed.source is None:
        return False
    broker_terminal = {"acknowledged", "reconciled"}
    if observed.outcome in broker_terminal and settlement.outcome in broker_terminal:
        return (
            observed.broker_reference is not None
            and observed.broker_reference == settlement.broker_reference
            and observed.execution_id == settlement.execution_id
        )
    return (
        observed.source == settlement.source
        and observed.outcome == settlement.outcome
        and observed.broker_reference == settlement.broker_reference
        and observed.execution_id == settlement.execution_id
        and observed.evidence_sha256 == settlement.evidence_sha256
    )


def require_compatible_terminal(
    snapshot: BrokerMutationReceiptSnapshot,
    settlement: BrokerMutationSettlement,
) -> BrokerMutationReceiptSnapshot:
    if not settlement_is_compatible(snapshot, settlement):
        raise BrokerMutationReceiptConflictError(
            f"broker_mutation_terminal_conflict:{snapshot.receipt_id}"
        )
    return snapshot


def require_unlinked_terminal(
    snapshot: BrokerMutationReceiptSnapshot,
) -> None:
    """Force linked submit terminals through the atomic P0b/P0c coordinator."""

    if snapshot.intent.submission_claim_id is not None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_requires_atomic_terminal_coordinator"
        )


__all__ = [
    "LockedReceipt",
    "append_and_commit",
    "committed_snapshot",
    "lock_current_receipt",
    "normalized_primary_handle",
    "normalized_recovery_handle",
    "normalized_recovery_observation",
    "normalized_settlement",
    "primary_handle_matches",
    "read_and_close",
    "rollback_session_on_error",
    "recovery_handle_matches",
    "require_compatible_terminal",
    "require_primary_handle",
    "require_recovery_handle",
    "require_unlinked_terminal",
    "settlement_is_compatible",
]
