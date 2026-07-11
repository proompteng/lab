"""Atomic recovery lifecycle for one linked trade-decision submission."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy.orm import Session

from ...models import BrokerMutationReceiptEvent
from ..decision_submission_claims.persistence import (
    snapshot_from_model as snapshot_claim_from_model,
)
from ..decision_submission_claims.types import DecisionSubmissionRecoveryHandle
from .canonicalization import build_broker_mutation_settlement
from .lifecycle_helpers import (
    LockedReceipt,
    lock_current_receipt,
    normalized_recovery_observation,
    normalized_settlement,
    rollback_session_on_error,
)
from .linked_terminal import (
    committed_linked_submission_terminal_result,
    linked_submission_claim_terminal_values,
)
from .linked_recovery_support import (
    LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION,
    STABLE_BROKER_STATUS as _STABLE_BROKER_STATUS,
    acquire_claim_recovery_uncommitted as _acquire_claim_recovery_uncommitted,
    acquire_read_result as _acquire_read_result,
    commit_pair_result as _commit_pair_result,
    committed_acquisition_result as _committed_acquisition_result,
    existing_acquisition_result as _existing_acquisition_result,
    lock_active_pair as _lock_active_pair,
    lock_linked_claim as _lock_linked_claim,
    normalize_claim_recovery_handle as _normalize_claim_recovery_handle,
    normalize_paired_handle as _normalize_paired_handle,
    normalize_recovery_request as _normalize_recovery_request,
    read_pair_result as _read_pair_result,
    require_active_pair as _require_active_pair,
    require_exact_terminal_retry as _require_exact_terminal_retry,
    require_nonterminal_pair as _require_nonterminal_pair,
    require_pair_handle as _require_pair_handle,
    require_recovery_due as _require_recovery_due,
    transition_claim_recovery as _transition_claim_recovery,
    validate_recovery_terminal_evidence as _validate_recovery_terminal_evidence,
)
from .persistence import (
    append_full_state_event,
    close_read_transaction,
    commit_or_rollback,
    full_state_values_from_event,
)
from .types import (
    BrokerMutationLinkedSubmissionRecoveryAcquireResult,
    BrokerMutationLinkedSubmissionRecoveryHandle,
    BrokerMutationLinkedSubmissionRecoveryResult,
    BrokerMutationLinkedSubmissionTerminalResult,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryObservation,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
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
    required_text,
)


def _append_recovery_event(
    session: Session,
    *,
    current: LockedReceipt,
    event_type: str,
    writer_generation: int,
    changes: dict[str, object],
) -> BrokerMutationReceiptEvent:
    """Append through this module so rollback injection tests stay precise."""

    values = full_state_values_from_event(current.event)
    values.update(
        sequence_no=current.event.sequence_no + 1,
        event_type=event_type,
        event_writer_generation=writer_generation,
        **changes,
    )
    return append_full_state_event(
        session,
        receipt_id=current.header.id,
        values=values,
    )


def acquire_linked_submission_recovery(
    session: Session,
    *,
    receipt_id: uuid.UUID | str,
    recovery_owner: str,
    writer_generation: int,
    options: BrokerMutationRecoveryAcquireOptions | None = None,
) -> BrokerMutationLinkedSubmissionRecoveryAcquireResult:
    """Acquire one receipt/claim recovery fence pair in a single transaction."""

    with rollback_session_on_error(session):
        request = _normalize_recovery_request(
            receipt_id=receipt_id,
            recovery_owner=recovery_owner,
            writer_generation=writer_generation,
            options=options,
        )
        with session.no_autoflush:
            current = lock_current_receipt(session, request.receipt_id)
            if current is None:
                return _acquire_read_result(session, "not_required", None, None)
            claim = _lock_linked_claim(
                session,
                current=current,
                expected_states=(
                    frozenset({"broker_io"})
                    if current.snapshot.state == "broker_io"
                    else frozenset({"submitted", "rejected"})
                ),
            )
            if current.snapshot.state != "broker_io":
                return _acquire_read_result(
                    session,
                    "not_required",
                    current,
                    claim,
                )
            _require_nonterminal_pair(current, claim)
            existing = _existing_acquisition_result(
                session,
                current=current,
                claim=claim,
                request=request,
            )
            if existing is not None:
                return existing
            _require_recovery_due(current, claim)

        event_values = full_state_values_from_event(current.event)
        event_values.update(
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
        event = append_full_state_event(
            session,
            receipt_id=request.receipt_id,
            values=event_values,
        )
        if (
            event.recovery_token is None
            or event.recovery_owner is None
            or event.recovery_lease_started_at is None
            or event.recovery_lease_expires_at is None
        ):
            raise BrokerMutationReceiptError(
                "linked_submission_recovery_database_lease_missing"
            )
        _acquire_claim_recovery_uncommitted(
            session,
            claim=claim,
            request=request,
            event=event,
        )
        commit_or_rollback(session)
        return _committed_acquisition_result(
            session,
            receipt_id=request.receipt_id,
            decision_id=claim.handle.decision_id,
            outcome="acquired",
        )


def renew_linked_submission_recovery(
    session: Session,
    *,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
    lease_seconds: int = RECEIPT_DEFAULT_LEASE_SECONDS,
) -> BrokerMutationLinkedSubmissionRecoveryResult:
    """Renew both active recovery leases without changing either fence."""

    with rollback_session_on_error(session):
        normalized = _normalize_paired_handle(handle)
        bounded_lease = bounded_seconds(
            lease_seconds,
            minimum=RECEIPT_MIN_LEASE_SECONDS,
            maximum=RECEIPT_MAX_LEASE_SECONDS,
            field="lease_seconds",
        )
        current, claim = _lock_active_pair(session, normalized)
        observed = current.snapshot.recovery_handle
        if observed is None:  # pragma: no cover - pair validation proved it
            raise BrokerMutationReceiptError("recovery_handle_missing")
        if observed.recovery_lease_expires_at > (
            normalized.receipt.recovery_lease_expires_at
        ):
            return _read_pair_result(session, current=current, claim=claim)
        if observed.recovery_lease_expires_at < (
            normalized.receipt.recovery_lease_expires_at
        ):
            raise BrokerMutationReceiptConflictError(
                "linked_submission_recovery_renewal_conflict"
            )
        requested_expiry = current.now + timedelta(seconds=bounded_lease)
        if requested_expiry <= observed.recovery_lease_expires_at:
            return _read_pair_result(session, current=current, claim=claim)
        event = _append_recovery_event(
            session,
            current=current,
            event_type="recovery_renewed",
            writer_generation=normalized.receipt.recovery_writer_generation,
            changes={"recovery_lease_expires_at": requested_expiry},
        )
        if event.recovery_lease_expires_at is None:
            raise BrokerMutationReceiptError(
                "linked_submission_recovery_database_expiry_missing"
            )
        _transition_claim_recovery(
            session,
            handle=normalized.submission_claim,
            values={"recovery_lease_expires_at": event.recovery_lease_expires_at},
        )
        return _commit_pair_result(
            session,
            receipt_id=current.header.id,
            decision_id=claim.handle.decision_id,
        )


def record_linked_submission_recovery_observation(
    session: Session,
    *,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
    observation: BrokerMutationRecoveryObservation,
    retry_seconds: int = RECEIPT_DEFAULT_RECOVERY_SECONDS,
) -> BrokerMutationLinkedSubmissionRecoveryResult:
    """Record one paired negative/unknown read and preserve quarantine."""

    with rollback_session_on_error(session):
        normalized_handle = _normalize_paired_handle(handle)
        normalized_observation = normalized_recovery_observation(observation)
        bounded_retry = bounded_seconds(
            retry_seconds,
            minimum=RECEIPT_MIN_RECOVERY_SECONDS,
            maximum=RECEIPT_MAX_RECOVERY_SECONDS,
            field="retry_seconds",
        )
        current, claim = _lock_active_pair(session, normalized_handle)
        if (
            normalized_observation.checked_client_request_id
            != current.snapshot.intent.client_request_id
            or normalized_observation.checked_target_key
            != current.snapshot.intent.target.key
        ):
            raise BrokerMutationReceiptValidationError(
                "recovery_observation_identity_mismatch"
            )
        if (
            current.event.recovery_observation_epoch
            == normalized_handle.receipt.recovery_epoch
        ):
            checked_at = current.event.recovery_checked_at
            recovery_after = current.event.recovery_after
            exact_retry = (
                current.event.recovery_outcome == normalized_observation.outcome
                and current.event.recovery_evidence_json
                == normalized_observation.evidence_json
                and current.event.recovery_evidence_sha256
                == normalized_observation.evidence_sha256
                and checked_at is not None
                and recovery_after is not None
                and recovery_after - checked_at == timedelta(seconds=bounded_retry)
            )
            if exact_retry:
                return _read_pair_result(
                    session,
                    current=current,
                    claim=claim,
                )
            raise BrokerMutationReceiptConflictError(
                "linked_submission_recovery_observation_conflict"
            )
        event = _append_recovery_event(
            session,
            current=current,
            event_type="recovery_observed",
            writer_generation=(normalized_handle.receipt.recovery_writer_generation),
            changes={
                "recovery_after": current.now + timedelta(seconds=bounded_retry),
                "recovery_checked_at": current.now,
                "recovery_observation_epoch": (
                    normalized_handle.receipt.recovery_epoch
                ),
                "recovery_outcome": normalized_observation.outcome,
                "recovery_evidence_json": normalized_observation.evidence_json,
                "recovery_evidence_sha256": (normalized_observation.evidence_sha256),
            },
        )
        if event.recovery_checked_at is None or event.recovery_after is None:
            raise BrokerMutationReceiptError(
                "linked_submission_recovery_database_observation_missing"
            )
        _transition_claim_recovery(
            session,
            handle=normalized_handle.submission_claim,
            values={
                "recovery_checked_at": event.recovery_checked_at,
                "recovery_observation_epoch": event.recovery_observation_epoch,
                "recovery_outcome": event.recovery_outcome,
                "recovery_evidence": event.recovery_evidence_json,
                "recovery_after": event.recovery_after,
            },
        )
        return _commit_pair_result(
            session,
            receipt_id=current.header.id,
            decision_id=claim.handle.decision_id,
        )


def release_linked_submission_recovery(
    session: Session,
    *,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
) -> BrokerMutationLinkedSubmissionRecoveryResult:
    """Expire both active recovery leases at one database timestamp."""

    with rollback_session_on_error(session):
        normalized = _normalize_paired_handle(handle)
        current = lock_current_receipt(session, normalized.receipt.receipt_id)
        if current is None:
            raise BrokerMutationReceiptFenceError(
                f"broker_mutation_receipt_not_found:{normalized.receipt.receipt_id}"
            )
        claim = _lock_linked_claim(
            session,
            current=current,
            expected_states=frozenset({"broker_io"}),
        )
        _require_pair_handle(current, claim, normalized)
        if current.event.event_type == "recovery_released":
            return _read_pair_result(session, current=current, claim=claim)
        _require_active_pair(current, claim, normalized)
        event = _append_recovery_event(
            session,
            current=current,
            event_type="recovery_released",
            writer_generation=normalized.receipt.recovery_writer_generation,
            changes={"recovery_lease_expires_at": current.now},
        )
        if event.recovery_lease_expires_at is None:
            raise BrokerMutationReceiptError(
                "linked_submission_recovery_database_expiry_missing"
            )
        _transition_claim_recovery(
            session,
            handle=normalized.submission_claim,
            values={"recovery_lease_expires_at": event.recovery_lease_expires_at},
        )
        return _commit_pair_result(
            session,
            receipt_id=current.header.id,
            decision_id=claim.handle.decision_id,
        )


def build_linked_submission_recovery_settlement(
    *,
    submission_claim_handle: DecisionSubmissionRecoveryHandle,
    broker_status: str,
    broker_reference: str,
    execution_id: uuid.UUID | str,
) -> BrokerMutationSettlement:
    """Build exact positive lookup evidence; recovery can only reconcile."""

    handle = _normalize_claim_recovery_handle(submission_claim_handle)
    normalized_status = required_text(
        broker_status,
        field="broker_status",
        maximum=64,
    )
    if _STABLE_BROKER_STATUS.fullmatch(normalized_status) is None:
        raise BrokerMutationReceiptValidationError("broker_status_not_stable_code")
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="reconciled",
            broker_reference=required_text(
                broker_reference,
                field="broker_reference",
                maximum=256,
            ),
            execution_id=as_uuid(execution_id, field="execution_id"),
            evidence_payload={
                "schema_version": (LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION),
                "decision_id": str(handle.decision_id),
                "account_label": handle.account_label,
                "client_order_id": handle.client_order_id,
                "checked_client_order_id": handle.client_order_id,
                "checked_target_key": handle.client_order_id,
                "observation_outcome": "found",
                "broker_status": normalized_status,
                "rejection_code": None,
            },
        )
    )


def settle_linked_submission_recovery(
    session: Session,
    *,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
    settlement: BrokerMutationSettlement,
) -> BrokerMutationLinkedSubmissionTerminalResult:
    """Commit recovered receipt, claim, and Execution truth exactly once."""

    with rollback_session_on_error(session):
        normalized_handle = _normalize_paired_handle(handle)
        normalized_terminal = normalized_settlement(
            settlement,
            expected_source="recovery",
        )
        if normalized_terminal.outcome != "reconciled":
            raise BrokerMutationReceiptValidationError(
                "linked_submission_recovery_requires_reconciled"
            )
        with session.no_autoflush:
            current = lock_current_receipt(
                session,
                normalized_handle.receipt.receipt_id,
            )
            if current is None:
                raise BrokerMutationReceiptFenceError(
                    "linked_submission_recovery_receipt_not_found"
                )
            claim = _lock_linked_claim(
                session,
                current=current,
                expected_states=(
                    frozenset({"submitted"})
                    if current.snapshot.state == "settled"
                    else frozenset({"broker_io"})
                ),
            )
            _require_pair_handle(current, claim, normalized_handle)
        _validate_recovery_terminal_evidence(
            normalized_terminal,
            handle=normalized_handle.submission_claim,
        )
        if current.snapshot.state == "settled":
            _require_exact_terminal_retry(
                current=current,
                claim=claim,
                settlement=normalized_terminal,
                handle=normalized_handle,
            )
            result = BrokerMutationLinkedSubmissionTerminalResult(
                receipt=current.snapshot,
                submission_claim=snapshot_claim_from_model(claim.row),
            )
            close_read_transaction(session)
            return result
        if current.snapshot.state != "broker_io":
            raise BrokerMutationReceiptFenceError(
                "linked_submission_recovery_terminal_state_mismatch:"
                f"{current.snapshot.state}"
            )
        _require_active_pair(current, claim, normalized_handle)

        session.flush()
        primary_handle = current.snapshot.submission_claim_handle
        if primary_handle is None:  # pragma: no cover - linked lock proved it
            raise BrokerMutationReceiptError(
                "linked_submission_recovery_primary_handle_missing"
            )
        terminal_values = linked_submission_claim_terminal_values(
            session,
            claim_handle=primary_handle,
            settlement=normalized_terminal,
        )
        event = _append_recovery_event(
            session,
            current=current,
            event_type="settled",
            writer_generation=(normalized_handle.receipt.recovery_writer_generation),
            changes={
                "state": "settled",
                "settlement_source": normalized_terminal.source,
                "settlement_outcome": normalized_terminal.outcome,
                "broker_reference": normalized_terminal.broker_reference,
                "execution_id": normalized_terminal.execution_id,
                "settlement_evidence_json": normalized_terminal.evidence_json,
                "settlement_evidence_sha256": normalized_terminal.evidence_sha256,
                "recovery_lease_expires_at": current.now,
                "settled_at": current.now,
            },
        )
        if event.settled_at is None or event.recovery_lease_expires_at is None:
            raise BrokerMutationReceiptError(
                "linked_submission_recovery_database_terminal_time_missing"
            )
        terminal_values.update(
            recovery_checked_at=event.settled_at,
            recovery_observation_epoch=(
                normalized_handle.submission_claim.recovery_fencing_epoch
            ),
            recovery_outcome="found",
            recovery_evidence=normalized_terminal.evidence_json,
            recovery_lease_expires_at=event.recovery_lease_expires_at,
            completed_at=event.settled_at,
            terminal_receipt_event_id=event.id,
        )
        _transition_claim_recovery(
            session,
            handle=normalized_handle.submission_claim,
            values=terminal_values,
        )
        commit_or_rollback(session)
        return committed_linked_submission_terminal_result(
            session,
            receipt_id=current.header.id,
            decision_id=claim.handle.decision_id,
        )


__all__ = [
    "LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION",
    "acquire_linked_submission_recovery",
    "build_linked_submission_recovery_settlement",
    "record_linked_submission_recovery_observation",
    "release_linked_submission_recovery",
    "renew_linked_submission_recovery",
    "settle_linked_submission_recovery",
]
