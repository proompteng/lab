"""Shared fences, validation, and readback for linked recovery coordination."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import cast

from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from ...models import BrokerMutationReceiptEvent, TradeDecisionSubmissionClaim
from ..decision_submission_claims.persistence import (
    load_snapshot as load_claim_snapshot,
    recovery_handle_matches as claim_recovery_handle_matches,
    snapshot_from_model as snapshot_claim_from_model,
    transition_recovery_uncommitted,
)
from ..decision_submission_claims.types import (
    DecisionSubmissionClaimError,
    DecisionSubmissionRecoveryHandle,
    DecisionSubmissionFenceError,
)
from .lifecycle_helpers import (
    LockedReceipt,
    lock_current_receipt,
    normalized_recovery_handle,
    recovery_handle_matches,
)
from .linked_submission import LockedSubmissionClaim, lock_linked_submission_claim
from .persistence import (
    close_read_transaction,
    commit_or_rollback,
    load_receipt_snapshot,
)
from .types import (
    BrokerMutationLinkedSubmissionRecoveryAcquireResult,
    BrokerMutationLinkedSubmissionRecoveryHandle,
    BrokerMutationLinkedSubmissionRecoveryResult,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryAcquireOutcome,
    BrokerMutationSettlement,
)
from .validation import (
    RECEIPT_MAX_LEASE_SECONDS,
    RECEIPT_MIN_LEASE_SECONDS,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
    as_utc_datetime,
    as_uuid,
    bounded_seconds,
    positive_integer,
    required_text,
)


LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION = (
    "torghut.linked-submission-recovery-terminal.v1"
)
STABLE_BROKER_STATUS = re.compile(r"^[a-z0-9][a-z0-9_.:-]*$")


@dataclass(frozen=True, slots=True)
class RecoveryRequest:
    receipt_id: uuid.UUID
    owner: str
    writer_generation: int
    token: uuid.UUID
    lease_seconds: int


def normalize_recovery_request(
    *,
    receipt_id: uuid.UUID | str,
    recovery_owner: str,
    writer_generation: int,
    options: BrokerMutationRecoveryAcquireOptions | None,
) -> RecoveryRequest:
    configured = options or BrokerMutationRecoveryAcquireOptions()
    return RecoveryRequest(
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


def normalize_claim_recovery_handle(
    handle: DecisionSubmissionRecoveryHandle,
) -> DecisionSubmissionRecoveryHandle:
    return DecisionSubmissionRecoveryHandle(
        decision_id=as_uuid(handle.decision_id, field="decision_id"),
        recovery_token=as_uuid(handle.recovery_token, field="recovery_token"),
        recovery_fencing_epoch=positive_integer(
            handle.recovery_fencing_epoch,
            field="recovery_fencing_epoch",
        ),
        account_label=required_text(
            handle.account_label,
            field="account_label",
            maximum=64,
        ),
        client_order_id=required_text(
            handle.client_order_id,
            field="client_order_id",
            maximum=128,
        ),
        recovery_owner=required_text(
            handle.recovery_owner,
            field="recovery_owner",
            maximum=128,
        ),
        lease_expires_at=as_utc_datetime(
            handle.lease_expires_at,
            field="lease_expires_at",
        ),
    )


def normalize_paired_handle(
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
) -> BrokerMutationLinkedSubmissionRecoveryHandle:
    receipt = normalized_recovery_handle(handle.receipt)
    claim = normalize_claim_recovery_handle(handle.submission_claim)
    if (
        receipt.recovery_token != claim.recovery_token
        or receipt.recovery_epoch != claim.recovery_fencing_epoch
        or receipt.recovery_owner != claim.recovery_owner
        or receipt.recovery_lease_expires_at != claim.lease_expires_at
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_handle_mismatch"
        )
    return BrokerMutationLinkedSubmissionRecoveryHandle(
        receipt=receipt,
        submission_claim=claim,
    )


def lock_linked_claim(
    session: Session,
    *,
    current: LockedReceipt,
    expected_states: frozenset[str],
) -> LockedSubmissionClaim:
    stored = current.snapshot.submission_claim_handle
    if (
        current.snapshot.intent.submission_claim_id is None
        or current.snapshot.intent.operation != "submit_order"
        or stored is None
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_requires_linked_submit_receipt"
        )
    return lock_linked_submission_claim(
        session,
        intent=current.snapshot.intent,
        handle=stored,
        expected_states=expected_states,
        require_unexpired=False,
    )


def require_nonterminal_pair(
    current: LockedReceipt,
    claim: LockedSubmissionClaim,
) -> None:
    row = claim.row
    receipt_handle = current.snapshot.recovery_handle
    if (receipt_handle is None) != (row.recovery_token is None):
        raise BrokerMutationReceiptConflictError(
            "linked_submission_recovery_state_asymmetric"
        )
    expected = (
        current.event.recovery_epoch,
        current.event.recovery_token,
        current.event.recovery_owner,
        current.event.recovery_lease_started_at,
        current.event.recovery_lease_expires_at,
        current.event.recovery_checked_at,
        current.event.recovery_observation_epoch,
        current.event.recovery_outcome,
        current.event.recovery_evidence_json,
    )
    observed = (
        int(row.recovery_fencing_epoch),
        row.recovery_token,
        row.recovery_owner,
        row.recovery_lease_started_at,
        row.recovery_lease_expires_at,
        row.recovery_checked_at,
        row.recovery_observation_epoch,
        row.recovery_outcome,
        row.recovery_evidence,
    )
    if observed != expected:
        raise BrokerMutationReceiptConflictError(
            "linked_submission_recovery_state_asymmetric"
        )


def require_recovery_due(
    current: LockedReceipt,
    claim: LockedSubmissionClaim,
) -> None:
    if (
        current.snapshot.lifecycle.recovery_after is None
        or claim.row.recovery_after is None
        or current.snapshot.lifecycle.recovery_after > current.now
        or claim.row.recovery_after > current.now
    ):
        raise BrokerMutationReceiptFenceError("linked_submission_recovery_not_ready")


def existing_acquisition_result(
    session: Session,
    *,
    current: LockedReceipt,
    claim: LockedSubmissionClaim,
    request: RecoveryRequest,
) -> BrokerMutationLinkedSubmissionRecoveryAcquireResult | None:
    recovery_after = current.snapshot.lifecycle.recovery_after
    if recovery_after is None or recovery_after > current.now:
        return acquire_read_result(session, "not_ready", current, claim)
    observed = current.snapshot.recovery_handle
    if observed is None or observed.recovery_lease_expires_at <= current.now:
        if observed is not None and observed.recovery_token == request.token:
            raise BrokerMutationReceiptConflictError(
                "broker_mutation_recovery_token_reuse"
            )
        return None
    if observed.recovery_token == request.token:
        if (
            observed.recovery_owner != request.owner
            or observed.recovery_writer_generation != request.writer_generation
        ):
            raise BrokerMutationReceiptConflictError(
                "broker_mutation_recovery_identity_conflict"
            )
        outcome: BrokerMutationRecoveryAcquireOutcome = "already_owned"
    else:
        outcome = "busy"
    return acquire_read_result(session, outcome, current, claim)


def acquire_claim_recovery_uncommitted(
    session: Session,
    *,
    claim: LockedSubmissionClaim,
    request: RecoveryRequest,
    event: BrokerMutationReceiptEvent,
) -> None:
    if (
        event.recovery_token is None
        or event.recovery_owner is None
        or event.recovery_lease_started_at is None
        or event.recovery_lease_expires_at is None
    ):
        raise BrokerMutationReceiptError(
            "linked_submission_recovery_database_lease_missing"
        )
    previous_epoch = int(claim.row.recovery_fencing_epoch)
    transitioned = session.execute(
        update(TradeDecisionSubmissionClaim)
        .where(
            TradeDecisionSubmissionClaim.trade_decision_id == claim.handle.decision_id,
            TradeDecisionSubmissionClaim.claim_token == claim.handle.claim_token,
            TradeDecisionSubmissionClaim.fencing_epoch == claim.handle.fencing_epoch,
            TradeDecisionSubmissionClaim.claim_owner == claim.handle.claim_owner,
            TradeDecisionSubmissionClaim.state == "broker_io",
            TradeDecisionSubmissionClaim.recovery_fencing_epoch == previous_epoch,
            TradeDecisionSubmissionClaim.recovery_after.is_not(None),
            TradeDecisionSubmissionClaim.recovery_after <= claim.now,
            or_(
                TradeDecisionSubmissionClaim.recovery_lease_expires_at.is_(None),
                TradeDecisionSubmissionClaim.recovery_lease_expires_at <= claim.now,
            ),
        )
        .values(
            recovery_token=event.recovery_token,
            recovery_fencing_epoch=event.recovery_epoch,
            recovery_owner=event.recovery_owner,
            recovery_lease_started_at=event.recovery_lease_started_at,
            recovery_lease_expires_at=event.recovery_lease_expires_at,
            updated_at=event.recovery_lease_started_at,
        )
        .returning(TradeDecisionSubmissionClaim.trade_decision_id)
    ).scalar_one_or_none()
    if transitioned is None:
        raise BrokerMutationReceiptFenceError(
            f"linked_submission_recovery_claim_fenced:{claim.handle.decision_id}"
        )
    if event.recovery_token != request.token or event.recovery_epoch != (
        previous_epoch + 1
    ):
        raise BrokerMutationReceiptError(
            "linked_submission_recovery_database_fence_mismatch"
        )


def lock_active_pair(
    session: Session,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
) -> tuple[LockedReceipt, LockedSubmissionClaim]:
    current = lock_current_receipt(session, handle.receipt.receipt_id)
    if current is None:
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_receipt_not_found:{handle.receipt.receipt_id}"
        )
    claim = lock_linked_claim(
        session,
        current=current,
        expected_states=frozenset({"broker_io"}),
    )
    require_pair_handle(current, claim, handle)
    require_active_pair(current, claim, handle)
    return current, claim


def require_pair_handle(
    current: LockedReceipt,
    claim: LockedSubmissionClaim,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
) -> None:
    if not recovery_handle_matches(current.snapshot, handle.receipt):
        raise BrokerMutationReceiptFenceError(
            "linked_submission_receipt_recovery_fenced"
        )
    claim_snapshot = snapshot_claim_from_model(claim.row)
    if not claim_recovery_handle_matches(claim_snapshot, handle.submission_claim):
        raise BrokerMutationReceiptFenceError("linked_submission_claim_recovery_fenced")
    if (
        current.event.recovery_token != claim.row.recovery_token
        or current.event.recovery_epoch != claim.row.recovery_fencing_epoch
        or current.event.recovery_owner != claim.row.recovery_owner
    ):
        raise BrokerMutationReceiptConflictError(
            "linked_submission_recovery_state_asymmetric"
        )


def require_active_pair(
    current: LockedReceipt,
    claim: LockedSubmissionClaim,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
) -> None:
    receipt_expiry = current.event.recovery_lease_expires_at
    claim_expiry = claim.row.recovery_lease_expires_at
    if (
        current.snapshot.state != "broker_io"
        or claim.row.state != "broker_io"
        or receipt_expiry is None
        or claim_expiry is None
        or receipt_expiry <= current.now
        or claim_expiry <= current.now
    ):
        raise BrokerMutationReceiptFenceError(
            f"linked_submission_recovery_lease_expired:{handle.receipt.receipt_id}"
        )


def transition_claim_recovery(
    session: Session,
    *,
    handle: DecisionSubmissionRecoveryHandle,
    values: dict[str, object],
) -> None:
    try:
        transition_recovery_uncommitted(session, handle=handle, values=values)
    except DecisionSubmissionFenceError as exc:
        raise BrokerMutationReceiptFenceError(
            "linked_submission_claim_recovery_fenced"
        ) from exc
    except DecisionSubmissionClaimError as exc:
        raise BrokerMutationReceiptValidationError(
            f"linked_submission_claim_recovery_invalid:{exc}"
        ) from exc


def validate_recovery_terminal_evidence(
    settlement: BrokerMutationSettlement,
    *,
    handle: DecisionSubmissionRecoveryHandle,
) -> None:
    try:
        document_value: object = json.loads(settlement.evidence_json)
    except (json.JSONDecodeError, TypeError) as exc:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_evidence_invalid"
        ) from exc
    if not isinstance(document_value, dict):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_evidence_invalid"
        )
    document = cast(dict[str, object], document_value)
    evidence_value = document.get("evidence")
    if not isinstance(evidence_value, dict):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_evidence_shape_mismatch"
        )
    evidence = cast(dict[str, object], evidence_value)
    expected = {
        "schema_version": LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION,
        "decision_id": str(handle.decision_id),
        "account_label": handle.account_label,
        "client_order_id": handle.client_order_id,
        "checked_client_order_id": handle.client_order_id,
        "checked_target_key": handle.client_order_id,
        "observation_outcome": "found",
        "broker_status": evidence.get("broker_status"),
        "rejection_code": None,
    }
    if set(evidence) != set(expected) or evidence != expected:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_evidence_identity_mismatch"
        )
    status = evidence.get("broker_status")
    if (
        not isinstance(status, str)
        or len(status) > 64
        or STABLE_BROKER_STATUS.fullmatch(status) is None
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_broker_status_invalid"
        )


def require_exact_terminal_retry(
    *,
    current: LockedReceipt,
    claim: LockedSubmissionClaim,
    settlement: BrokerMutationSettlement,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
) -> None:
    observed = current.snapshot.settlement
    claim_snapshot = snapshot_claim_from_model(claim.row)
    if (
        observed.source != settlement.source
        or observed.outcome != settlement.outcome
        or observed.broker_reference != settlement.broker_reference
        or observed.execution_id != settlement.execution_id
        or observed.evidence_json != settlement.evidence_json
        or observed.evidence_sha256 != settlement.evidence_sha256
        or claim_snapshot.state != "submitted"
        or claim_snapshot.terminal_receipt_event_id != current.event.id
        or claim_snapshot.execution_id != settlement.execution_id
        or claim_snapshot.broker_order_id != settlement.broker_reference
        or claim_snapshot.completed_at != observed.settled_at
        or claim_snapshot.recovery_outcome != "found"
        or claim_snapshot.recovery_observation_epoch
        != handle.submission_claim.recovery_fencing_epoch
        or claim_snapshot.recovery_evidence != settlement.evidence_json
    ):
        raise BrokerMutationReceiptConflictError(
            f"linked_submission_recovery_terminal_conflict:{current.header.id}"
        )


def acquire_read_result(
    session: Session,
    outcome: BrokerMutationRecoveryAcquireOutcome,
    current: LockedReceipt | None,
    claim: LockedSubmissionClaim | None,
) -> BrokerMutationLinkedSubmissionRecoveryAcquireResult:
    result = BrokerMutationLinkedSubmissionRecoveryAcquireResult(
        outcome=outcome,
        receipt=current.snapshot if current is not None else None,
        submission_claim=(
            snapshot_claim_from_model(claim.row) if claim is not None else None
        ),
    )
    close_read_transaction(session)
    return result


def committed_acquisition_result(
    session: Session,
    *,
    receipt_id: uuid.UUID,
    decision_id: uuid.UUID,
    outcome: BrokerMutationRecoveryAcquireOutcome,
) -> BrokerMutationLinkedSubmissionRecoveryAcquireResult:
    receipt = load_receipt_snapshot(session, receipt_id)
    claim = load_claim_snapshot(session, decision_id)
    if receipt is None or claim is None:
        close_read_transaction(session)
        raise BrokerMutationReceiptError("linked_submission_recovery_readback_missing")
    result = BrokerMutationLinkedSubmissionRecoveryAcquireResult(
        outcome=outcome,
        receipt=receipt,
        submission_claim=claim,
    )
    close_read_transaction(session)
    return result


def read_pair_result(
    session: Session,
    *,
    current: LockedReceipt,
    claim: LockedSubmissionClaim,
) -> BrokerMutationLinkedSubmissionRecoveryResult:
    result = BrokerMutationLinkedSubmissionRecoveryResult(
        receipt=current.snapshot,
        submission_claim=snapshot_claim_from_model(claim.row),
    )
    close_read_transaction(session)
    return result


def commit_pair_result(
    session: Session,
    *,
    receipt_id: uuid.UUID,
    decision_id: uuid.UUID,
) -> BrokerMutationLinkedSubmissionRecoveryResult:
    commit_or_rollback(session)
    receipt = load_receipt_snapshot(session, receipt_id)
    claim = load_claim_snapshot(session, decision_id)
    if receipt is None or claim is None:
        close_read_transaction(session)
        raise BrokerMutationReceiptError("linked_submission_recovery_readback_missing")
    result = BrokerMutationLinkedSubmissionRecoveryResult(
        receipt=receipt,
        submission_claim=claim,
    )
    close_read_transaction(session)
    return result
