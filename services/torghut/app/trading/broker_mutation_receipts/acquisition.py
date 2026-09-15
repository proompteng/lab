"""Atomic primary acquisition for one immutable broker mutation."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..decision_submission_claims.types import DecisionSubmissionClaimHandle
from .canonicalization import verify_broker_mutation_intent
from .linked_submission import (
    normalize_linked_submission_handle,
    validate_linked_receipt_state,
)
from .lifecycle_helpers import committed_snapshot
from .persistence import (
    append_full_state_event,
    close_read_transaction,
    database_now,
    full_state_values_from_event,
    insert_receipt_header_if_absent,
    load_latest_receipt_event,
    resolve_receipt_header,
    snapshot_from_models,
)
from .types import (
    BrokerMutationIntent,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptAcquireOutcome,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptSnapshot,
)
from .validation import (
    RECEIPT_DEFAULT_LEASE_SECONDS,
    RECEIPT_MAX_LEASE_SECONDS,
    RECEIPT_MIN_LEASE_SECONDS,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    BrokerMutationReceiptValidationError,
    as_uuid,
    bounded_seconds,
    positive_integer,
    required_text,
)


@dataclass(frozen=True, slots=True)
class _PrimaryRequest:
    intent: BrokerMutationIntent
    owner: str
    writer_generation: int
    token: uuid.UUID
    lease_seconds: int
    submission_claim_handle: DecisionSubmissionClaimHandle | None


def acquire_broker_mutation_receipt(
    session: Session,
    *,
    intent: BrokerMutationIntent,
    primary_owner: str,
    writer_generation: int,
    options: BrokerMutationReceiptAcquireOptions | None = None,
) -> BrokerMutationReceiptAcquireResult:
    """Commit primary ownership before any broker mutation is attempted."""

    try:
        request = _normalize_primary_request(
            intent=intent,
            primary_owner=primary_owner,
            writer_generation=writer_generation,
            options=options,
        )
        return _acquire_primary(session, request)
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def _normalize_primary_request(
    *,
    intent: BrokerMutationIntent,
    primary_owner: str,
    writer_generation: int,
    options: BrokerMutationReceiptAcquireOptions | None,
) -> _PrimaryRequest:
    configured = options or BrokerMutationReceiptAcquireOptions()
    verify_broker_mutation_intent(intent)
    owner = required_text(primary_owner, field="primary_owner", maximum=128)
    submission_claim_handle = normalize_linked_submission_handle(
        intent,
        configured.submission_claim_handle,
        expected_owner=owner,
    )
    lease_seconds = bounded_seconds(
        configured.lease_seconds,
        minimum=RECEIPT_MIN_LEASE_SECONDS,
        maximum=RECEIPT_MAX_LEASE_SECONDS,
        field="lease_seconds",
    )
    if (
        submission_claim_handle is not None
        and lease_seconds > RECEIPT_DEFAULT_LEASE_SECONDS
    ):
        raise BrokerMutationReceiptValidationError(
            f"linked_submission_lease_too_large:{RECEIPT_DEFAULT_LEASE_SECONDS}"
        )
    return _PrimaryRequest(
        intent=intent,
        owner=owner,
        writer_generation=positive_integer(
            writer_generation,
            field="writer_generation",
        ),
        token=(
            as_uuid(configured.primary_token, field="primary_token")
            if configured.primary_token is not None
            else uuid.uuid4()
        ),
        lease_seconds=lease_seconds,
        submission_claim_handle=submission_claim_handle,
    )


def _acquire_primary(
    session: Session,
    request: _PrimaryRequest,
) -> BrokerMutationReceiptAcquireResult:
    header = resolve_receipt_header(session, intent=request.intent, for_update=True)
    now = database_now(session)
    if header is None:
        validate_linked_receipt_state(
            session,
            intent=request.intent,
            handle=request.submission_claim_handle,
            receipt_state="claimed",
            expected_owner=request.owner,
        )
        inserted_id = insert_receipt_header_if_absent(
            session,
            receipt_id=uuid.uuid4(),
            intent=request.intent,
            creator_owner=request.owner,
            origin_writer_generation=request.writer_generation,
        )
        if inserted_id is None:
            raise BrokerMutationReceiptConflictError(
                "broker_mutation_submission_claim_reserved"
            )
        append_full_state_event(
            session,
            receipt_id=inserted_id,
            values=_initial_event_values(request, now),
        )
        return BrokerMutationReceiptAcquireResult(
            outcome="acquired",
            receipt=committed_snapshot(session, inserted_id),
        )

    event = load_latest_receipt_event(session, header.id)
    if event is None:  # pragma: no cover - deferred database guard forbids this
        raise BrokerMutationReceiptError("broker_mutation_receipt_event_missing")
    snapshot = snapshot_from_models(header, event)
    normalized_submission_handle = validate_linked_receipt_state(
        session,
        intent=request.intent,
        handle=request.submission_claim_handle,
        receipt_state=snapshot.state,
        expected_owner=request.owner,
    )
    active_or_irreversible = snapshot.state in {"broker_io", "settled"} or (
        snapshot.state == "claimed"
        and snapshot.lifecycle.primary_lease_expires_at > now
    )
    if (
        active_or_irreversible
        and snapshot.submission_claim_handle != normalized_submission_handle
    ):
        raise BrokerMutationReceiptConflictError(
            "broker_mutation_submission_claim_event_identity_mismatch"
        )
    existing = _existing_primary_result(session, request, snapshot, now)
    if existing is not None:
        return existing
    if snapshot.primary_handle.primary_token == request.token:
        raise BrokerMutationReceiptConflictError("broker_mutation_primary_token_reuse")
    values = full_state_values_from_event(event)
    values.update(
        _primary_claim_event_values(
            request,
            now,
            sequence_no=event.sequence_no + 1,
            primary_epoch=event.primary_epoch + 1,
        )
    )
    append_full_state_event(session, receipt_id=header.id, values=values)
    return BrokerMutationReceiptAcquireResult(
        outcome="acquired",
        receipt=committed_snapshot(session, header.id),
    )


def _existing_primary_result(
    session: Session,
    request: _PrimaryRequest,
    snapshot: BrokerMutationReceiptSnapshot,
    now: datetime,
) -> BrokerMutationReceiptAcquireResult | None:
    if snapshot.state == "settled":
        return _read_result(session, "settled", snapshot)
    if snapshot.state == "broker_io":
        recovery_due = (
            snapshot.lifecycle.recovery_after is not None
            and snapshot.lifecycle.recovery_after <= now
        )
        recovery_active = (
            snapshot.recovery_handle is not None
            and snapshot.recovery_handle.recovery_lease_expires_at > now
        )
        outcome: BrokerMutationReceiptAcquireOutcome = (
            "recovery_required" if recovery_due and not recovery_active else "busy"
        )
        return _read_result(session, outcome, snapshot)
    if snapshot.state not in {"claimed", "released"}:
        raise BrokerMutationReceiptError(
            f"broker_mutation_receipt_state_invalid:{snapshot.state}"
        )
    same_token = snapshot.primary_handle.primary_token == request.token
    same_owner = snapshot.primary_handle.primary_owner == request.owner
    same_generation = (
        snapshot.primary_handle.primary_writer_generation == request.writer_generation
    )
    if same_token and not (same_owner and same_generation):
        raise BrokerMutationReceiptConflictError(
            "broker_mutation_primary_identity_conflict"
        )
    if (
        snapshot.state == "claimed"
        and snapshot.lifecycle.primary_lease_expires_at > now
    ):
        outcome = "already_owned" if same_token else "busy"
        return _read_result(session, outcome, snapshot)
    return None


def _read_result(
    session: Session,
    outcome: BrokerMutationReceiptAcquireOutcome,
    snapshot: BrokerMutationReceiptSnapshot,
) -> BrokerMutationReceiptAcquireResult:
    result = BrokerMutationReceiptAcquireResult(outcome=outcome, receipt=snapshot)
    close_read_transaction(session)
    return result


def _initial_event_values(
    request: _PrimaryRequest,
    now: datetime,
) -> dict[str, object]:
    values: dict[str, object] = {
        "broker_io_started_at": None,
        "recovery_after": None,
        "recovery_token": None,
        "recovery_epoch": 0,
        "recovery_owner": None,
        "recovery_writer_generation": None,
        "recovery_lease_started_at": None,
        "recovery_lease_expires_at": None,
        "recovery_checked_at": None,
        "recovery_observation_epoch": None,
        "recovery_outcome": None,
        "settlement_source": None,
        "settlement_outcome": None,
        "broker_reference": None,
        "execution_id": None,
        "recovery_evidence_json": None,
        "recovery_evidence_sha256": None,
        "settlement_evidence_json": None,
        "settlement_evidence_sha256": None,
        "settled_at": None,
    }
    values.update(
        _primary_claim_event_values(
            request,
            now,
            sequence_no=1,
            primary_epoch=1,
        )
    )
    return values


def _primary_claim_event_values(
    request: _PrimaryRequest,
    now: datetime,
    *,
    sequence_no: int,
    primary_epoch: int,
) -> dict[str, object]:
    """Serialize the complete primary fence for both first claim and takeover."""

    submission_handle = request.submission_claim_handle
    return {
        "sequence_no": sequence_no,
        "event_type": "primary_claimed",
        "state": "claimed",
        "event_writer_generation": request.writer_generation,
        "primary_token": request.token,
        "primary_epoch": primary_epoch,
        "primary_owner": request.owner,
        "primary_writer_generation": request.writer_generation,
        "submission_claim_token": (
            submission_handle.claim_token if submission_handle is not None else None
        ),
        "submission_claim_fencing_epoch": (
            submission_handle.fencing_epoch if submission_handle is not None else None
        ),
        "submission_claim_owner": (
            submission_handle.claim_owner if submission_handle is not None else None
        ),
        "primary_claimed_at": now,
        "primary_lease_expires_at": now + timedelta(seconds=request.lease_seconds),
        "released_at": None,
        "release_reason": None,
    }


__all__ = ["acquire_broker_mutation_receipt"]
