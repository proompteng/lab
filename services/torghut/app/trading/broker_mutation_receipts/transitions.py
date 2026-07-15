"""Fenced primary transitions for immutable broker-mutation receipts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..decision_submission_claims.types import DecisionSubmissionClaimHandle
from .linked_submission import (
    transition_linked_submission_io_uncommitted,
    validate_linked_receipt_state,
)
from .lifecycle_helpers import (
    LockedReceipt,
    append_and_commit,
    committed_snapshot,
    lock_current_receipt,
    normalized_primary_handle,
    normalized_settlement,
    read_and_close,
    require_compatible_terminal,
    require_primary_handle,
    require_unlinked_terminal,
    rollback_session_on_error,
)
from .persistence import append_full_state_event, full_state_values_from_event
from .types import (
    BrokerMutationIoPermitIssueRequest,
    BrokerMutationIoStartResult,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationReceiptState,
    BrokerMutationSettlement,
    BrokerMutationSettlementSource,
    issue_broker_mutation_io_permit,
)
from .validation import (
    RECEIPT_DEFAULT_LEASE_SECONDS,
    RECEIPT_DEFAULT_RECOVERY_SECONDS,
    RECEIPT_MAX_LEASE_SECONDS,
    RECEIPT_MAX_RECOVERY_SECONDS,
    RECEIPT_MIN_LEASE_SECONDS,
    RECEIPT_MIN_RECOVERY_SECONDS,
    BrokerMutationReceiptError,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
    bounded_seconds,
    required_text,
)


@dataclass(frozen=True, slots=True)
class _PrimarySettlementPath:
    handle: BrokerMutationReceiptHandle
    settlement: BrokerMutationSettlement
    expected_source: BrokerMutationSettlementSource
    expected_state: BrokerMutationReceiptState
    require_unexpired_lease: bool


def renew_broker_mutation_receipt(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    lease_seconds: int = RECEIPT_DEFAULT_LEASE_SECONDS,
) -> BrokerMutationReceiptSnapshot:
    """Extend an active pre-I/O primary lease without changing its fence."""

    try:
        normalized = normalized_primary_handle(handle)
        bounded_lease = bounded_seconds(
            lease_seconds,
            minimum=RECEIPT_MIN_LEASE_SECONDS,
            maximum=RECEIPT_MAX_LEASE_SECONDS,
            field="lease_seconds",
        )
        current = _locked_primary(session, normalized)
        if current.snapshot.intent.submission_claim_id is not None:
            raise BrokerMutationReceiptValidationError(
                "linked_submission_receipt_renewal_forbidden"
            )
        if current.snapshot.state != "claimed" or (
            current.snapshot.lifecycle.primary_lease_expires_at <= current.now
        ):
            raise BrokerMutationReceiptFenceError(
                f"broker_mutation_primary_not_renewable:{normalized.receipt_id}"
            )
        lease_expires_at = current.now + timedelta(seconds=bounded_lease)
        if lease_expires_at <= current.snapshot.lifecycle.primary_lease_expires_at:
            return read_and_close(session, current.snapshot)
        values = full_state_values_from_event(current.event)
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="primary_renewed",
            event_writer_generation=normalized.primary_writer_generation,
            primary_lease_expires_at=lease_expires_at,
        )
        return append_and_commit(
            session,
            receipt_id=normalized.receipt_id,
            values=values,
        )
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def release_broker_mutation_receipt(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    reason: str,
) -> BrokerMutationReceiptSnapshot:
    """Release only a pre-I/O primary lease while retaining immutable history."""

    try:
        normalized = normalized_primary_handle(handle)
        normalized_reason = required_text(reason, field="release_reason", maximum=1024)
        current = _locked_primary(session, normalized)
        if current.snapshot.state == "released":
            if current.snapshot.lifecycle.release_reason != normalized_reason:
                raise BrokerMutationReceiptFenceError(
                    f"broker_mutation_release_conflict:{normalized.receipt_id}"
                )
            return read_and_close(session, current.snapshot)
        if current.snapshot.state != "claimed" or (
            current.snapshot.lifecycle.primary_lease_expires_at <= current.now
        ):
            raise BrokerMutationReceiptFenceError(
                f"broker_mutation_primary_not_releasable:{normalized.receipt_id}"
            )
        values = full_state_values_from_event(current.event)
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="primary_released",
            state="released",
            event_writer_generation=normalized.primary_writer_generation,
            primary_lease_expires_at=current.now,
            released_at=current.now,
            release_reason=normalized_reason,
        )
        return append_and_commit(
            session,
            receipt_id=normalized.receipt_id,
            values=values,
        )
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def mark_broker_mutation_io_started(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    submission_claim_handle: DecisionSubmissionClaimHandle | None = None,
    recovery_seconds: int = RECEIPT_DEFAULT_RECOVERY_SECONDS,
) -> BrokerMutationIoStartResult:
    """Commit the irreversible ambiguity boundary before the broker call."""

    with rollback_session_on_error(session):
        normalized = normalized_primary_handle(handle)
        bounded_recovery = bounded_seconds(
            recovery_seconds,
            minimum=RECEIPT_MIN_RECOVERY_SECONDS,
            maximum=RECEIPT_MAX_RECOVERY_SECONDS,
            field="recovery_seconds",
        )
        current = _locked_primary(session, normalized)
        normalized_submission_handle = validate_linked_receipt_state(
            session,
            intent=current.snapshot.intent,
            handle=submission_claim_handle,
            receipt_state=current.snapshot.state,
            expected_owner=normalized.primary_owner,
        )
        if current.snapshot.submission_claim_handle != normalized_submission_handle:
            raise BrokerMutationReceiptConflictError(
                "broker_mutation_submission_claim_event_identity_mismatch"
            )
        if current.snapshot.state in {"broker_io", "settled"}:
            outcome = (
                "already_started"
                if current.snapshot.state == "broker_io"
                else "settled"
            )
            return BrokerMutationIoStartResult(
                outcome=outcome,
                receipt=read_and_close(session, current.snapshot),
                permit=None,
            )
        if current.snapshot.state != "claimed" or (
            current.snapshot.lifecycle.primary_lease_expires_at <= current.now
        ):
            raise BrokerMutationReceiptFenceError(
                f"broker_mutation_primary_cannot_start_io:{normalized.receipt_id}"
            )
        values = full_state_values_from_event(current.event)
        recovery_after = current.now + timedelta(seconds=bounded_recovery)
        if normalized_submission_handle is not None:
            transition_linked_submission_io_uncommitted(
                session,
                intent=current.snapshot.intent,
                handle=normalized_submission_handle,
                broker_io_started_at=current.now,
                recovery_after=recovery_after,
            )
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="broker_io_started",
            state="broker_io",
            event_writer_generation=normalized.primary_writer_generation,
            broker_io_started_at=current.now,
            recovery_after=recovery_after,
        )
        append_full_state_event(
            session, receipt_id=normalized.receipt_id, values=values
        )
        started = committed_snapshot(session, normalized.receipt_id)
        return BrokerMutationIoStartResult(
            outcome="authorized",
            receipt=started,
            permit=issue_broker_mutation_io_permit(
                BrokerMutationIoPermitIssueRequest(
                    receipt_id=started.receipt_id,
                    primary_token=normalized.primary_token,
                    primary_epoch=normalized.primary_epoch,
                    event_sequence_no=started.lifecycle.sequence_no,
                    broker_route=started.intent.broker_route,
                    operation=started.intent.operation,
                    risk_class=started.intent.risk_class,
                    account_label=started.intent.account_label,
                    endpoint_fingerprint=started.intent.endpoint_fingerprint,
                    canonical_intent_sha256=started.intent.canonical_intent_sha256,
                    canonical_request_sha256=started.intent.canonical_request_sha256,
                    submission_claim_id=(
                        normalized_submission_handle.decision_id
                        if normalized_submission_handle is not None
                        else None
                    ),
                    submission_claim_token=(
                        normalized_submission_handle.claim_token
                        if normalized_submission_handle is not None
                        else None
                    ),
                    submission_claim_fencing_epoch=(
                        normalized_submission_handle.fencing_epoch
                        if normalized_submission_handle is not None
                        else None
                    ),
                ),
            ),
        )


def settle_broker_mutation_preflight(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    settlement: BrokerMutationSettlement,
) -> BrokerMutationReceiptSnapshot:
    """Settle already-satisfied intent without fabricating broker I/O."""

    return _settle_primary_path(
        session,
        _PrimarySettlementPath(
            handle=handle,
            settlement=settlement,
            expected_source="preflight",
            expected_state="claimed",
            require_unexpired_lease=True,
        ),
    )


def settle_broker_mutation_primary(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    settlement: BrokerMutationSettlement,
) -> BrokerMutationReceiptSnapshot:
    """Append a terminal broker acknowledgement, reconciliation, or rejection."""

    return _settle_primary_path(
        session,
        _PrimarySettlementPath(
            handle=handle,
            settlement=settlement,
            expected_source="primary",
            expected_state="broker_io",
            require_unexpired_lease=False,
        ),
    )


def _settle_primary_path(
    session: Session,
    path: _PrimarySettlementPath,
) -> BrokerMutationReceiptSnapshot:
    try:
        normalized_handle = normalized_primary_handle(path.handle)
        normalized_terminal = normalized_settlement(
            path.settlement,
            expected_source=path.expected_source,
        )
        current = _locked_primary(session, normalized_handle)
        require_unlinked_terminal(current.snapshot)
        if current.snapshot.state == "settled":
            compatible = require_compatible_terminal(
                current.snapshot,
                normalized_terminal,
            )
            return read_and_close(session, compatible)
        if current.snapshot.state != path.expected_state:
            raise BrokerMutationReceiptFenceError(
                "broker_mutation_primary_settlement_state_mismatch:"
                f"{normalized_handle.receipt_id}:{current.snapshot.state}"
            )
        if path.require_unexpired_lease and (
            current.snapshot.lifecycle.primary_lease_expires_at <= current.now
        ):
            raise BrokerMutationReceiptFenceError(
                f"broker_mutation_primary_lease_expired:{normalized_handle.receipt_id}"
            )
        values = full_state_values_from_event(current.event)
        values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=normalized_handle.primary_writer_generation,
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


def _locked_primary(
    session: Session,
    handle: BrokerMutationReceiptHandle,
) -> LockedReceipt:
    current = lock_current_receipt(session, handle.receipt_id)
    if current is None:
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_receipt_not_found:{handle.receipt_id}"
        )
    require_primary_handle(current.snapshot, handle)
    return current


__all__ = [
    "mark_broker_mutation_io_started",
    "release_broker_mutation_receipt",
    "renew_broker_mutation_receipt",
    "settle_broker_mutation_preflight",
    "settle_broker_mutation_primary",
]
