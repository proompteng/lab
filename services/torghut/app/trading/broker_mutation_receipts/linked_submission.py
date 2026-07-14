"""Exact P0b claim fencing for linked submit-order receipts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import TradeDecisionSubmissionClaim
from ..decision_submission_claims.persistence import transition_primary_uncommitted
from ..decision_submission_claims.types import (
    DecisionSubmissionClaimError,
    DecisionSubmissionClaimHandle,
    DecisionSubmissionFenceError,
)
from ..decision_submission_claims.validation import (
    as_utc_datetime,
    validate_broker_io_boundary,
)
from .persistence import (
    broker_mutation_identity_lock_keys,
    database_now,
    lock_broker_mutation_identities,
)
from .types import BrokerMutationIntent, BrokerMutationReceiptState
from .validation import (
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
    as_uuid,
    positive_integer,
    required_text,
)


@dataclass(frozen=True, slots=True)
class LockedSubmissionClaim:
    handle: DecisionSubmissionClaimHandle
    row: TradeDecisionSubmissionClaim
    now: datetime


def normalize_linked_submission_handle(
    intent: BrokerMutationIntent,
    handle: DecisionSubmissionClaimHandle | None,
    *,
    expected_owner: str,
) -> DecisionSubmissionClaimHandle | None:
    """Require the exact held P0b claim for a submit receipt."""

    if intent.submission_claim_id is None:
        if handle is not None:
            raise BrokerMutationReceiptValidationError(
                "unlinked_mutation_forbids_submission_claim_handle"
            )
        return None
    if intent.operation != "submit_order":
        raise BrokerMutationReceiptValidationError(
            "linked_replace_requires_submitted_order_coordinator"
        )
    if handle is None:
        raise BrokerMutationReceiptValidationError(
            "linked_submit_requires_submission_claim_handle"
        )
    normalized = DecisionSubmissionClaimHandle(
        decision_id=as_uuid(handle.decision_id, field="submission_claim_decision_id"),
        claim_token=as_uuid(handle.claim_token, field="submission_claim_token"),
        fencing_epoch=positive_integer(
            handle.fencing_epoch,
            field="submission_claim_fencing_epoch",
        ),
        account_label=required_text(
            handle.account_label,
            field="submission_claim_account_label",
            maximum=64,
        ),
        client_order_id=required_text(
            handle.client_order_id,
            field="submission_claim_client_order_id",
            maximum=128,
        ),
        claim_owner=required_text(
            handle.claim_owner,
            field="submission_claim_owner",
            maximum=128,
        ),
    )
    if (
        normalized.decision_id != intent.submission_claim_id
        or normalized.account_label != intent.account_label
        or normalized.client_order_id != intent.client_request_id
        or normalized.claim_owner != expected_owner
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_claim_identity_mismatch"
        )
    return normalized


def lock_linked_submission_claim(
    session: Session,
    *,
    intent: BrokerMutationIntent,
    handle: DecisionSubmissionClaimHandle,
    expected_states: frozenset[str],
    require_unexpired: bool,
) -> LockedSubmissionClaim:
    """Lock and verify the complete P0b claim identity and lifecycle state."""

    lock_broker_mutation_identities(
        session,
        broker_mutation_identity_lock_keys(intent),
    )
    now = database_now(session)
    row = session.execute(
        select(TradeDecisionSubmissionClaim)
        .where(TradeDecisionSubmissionClaim.trade_decision_id == handle.decision_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if row is None:
        raise BrokerMutationReceiptFenceError("linked_submission_claim_not_found")
    observed = (
        row.trade_decision_id,
        row.account_label,
        row.client_order_id,
        row.claim_token,
        int(row.fencing_epoch),
        row.claim_owner,
    )
    expected = (
        handle.decision_id,
        handle.account_label,
        handle.client_order_id,
        handle.claim_token,
        handle.fencing_epoch,
        handle.claim_owner,
    )
    if observed != expected:
        raise BrokerMutationReceiptFenceError(
            "linked_submission_claim_fenced:"
            f"{handle.decision_id}:{handle.fencing_epoch}"
        )
    if row.state not in expected_states:
        raise BrokerMutationReceiptConflictError(
            "linked_submission_claim_state_mismatch:"
            f"{row.state}:{','.join(sorted(expected_states))}"
        )
    if require_unexpired and as_utc_datetime(row.lease_expires_at) <= now:
        raise BrokerMutationReceiptFenceError(
            f"linked_submission_claim_expired:{handle.decision_id}"
        )
    return LockedSubmissionClaim(handle=handle, row=row, now=now)


def validate_linked_receipt_state(
    session: Session,
    *,
    intent: BrokerMutationIntent,
    handle: DecisionSubmissionClaimHandle | None,
    receipt_state: BrokerMutationReceiptState,
    expected_owner: str,
) -> DecisionSubmissionClaimHandle | None:
    """Reject every asymmetric P0b/P0c state before returning a receipt result."""

    normalized = normalize_linked_submission_handle(
        intent,
        handle,
        expected_owner=expected_owner,
    )
    if normalized is None:
        return None
    if receipt_state in {"claimed", "released"}:
        expected_states = frozenset({"claimed"})
        require_unexpired = True
    elif receipt_state == "broker_io":
        expected_states = frozenset({"broker_io"})
        require_unexpired = False
    else:
        expected_states = frozenset({"submitted", "rejected"})
        require_unexpired = False
    lock_linked_submission_claim(
        session,
        intent=intent,
        handle=normalized,
        expected_states=expected_states,
        require_unexpired=require_unexpired,
    )
    return normalized


def validate_linked_claim_lifecycle(
    session: Session,
    *,
    intent: BrokerMutationIntent,
    receipt_state: BrokerMutationReceiptState,
    stored_handle: DecisionSubmissionClaimHandle | None,
) -> None:
    """Reject a linked receipt whose durable P0b lifecycle disagrees."""

    if intent.submission_claim_id is None:
        if stored_handle is not None:
            raise BrokerMutationReceiptConflictError(
                "unlinked_receipt_has_submission_claim_handle"
            )
        return
    if stored_handle is None:
        raise BrokerMutationReceiptConflictError(
            "linked_receipt_missing_submission_claim_handle"
        )
    expected_identity = (
        intent.submission_claim_id,
        intent.account_label,
        intent.client_request_id,
    )
    stored_identity = (
        stored_handle.decision_id,
        stored_handle.account_label,
        stored_handle.client_order_id,
    )
    if stored_identity != expected_identity:
        raise BrokerMutationReceiptConflictError(
            "linked_submission_claim_identity_mismatch"
        )
    lock_broker_mutation_identities(
        session,
        broker_mutation_identity_lock_keys(intent),
    )
    row = session.execute(
        select(TradeDecisionSubmissionClaim)
        .where(
            TradeDecisionSubmissionClaim.trade_decision_id == intent.submission_claim_id
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if row is None:
        raise BrokerMutationReceiptConflictError("linked_submission_claim_not_found")
    observed_handle = (
        row.trade_decision_id,
        row.account_label,
        row.client_order_id,
        row.claim_token,
        int(row.fencing_epoch),
        row.claim_owner,
    )
    expected_handle = (
        stored_handle.decision_id,
        stored_handle.account_label,
        stored_handle.client_order_id,
        stored_handle.claim_token,
        stored_handle.fencing_epoch,
        stored_handle.claim_owner,
    )
    if observed_handle != expected_handle:
        raise BrokerMutationReceiptConflictError(
            "linked_submission_claim_identity_mismatch"
        )
    if receipt_state in {"claimed", "released"}:
        expected_states = frozenset({"claimed"})
    elif receipt_state == "broker_io":
        expected_states = frozenset({"broker_io"})
    else:
        expected_states = frozenset({"submitted", "rejected"})
    if row.state not in expected_states:
        raise BrokerMutationReceiptConflictError(
            f"linked_submission_lifecycle_mismatch:{receipt_state}:{row.state}"
        )


def transition_linked_submission_io_uncommitted(
    session: Session,
    *,
    intent: BrokerMutationIntent,
    handle: DecisionSubmissionClaimHandle,
    broker_io_started_at: datetime,
    recovery_after: datetime,
) -> None:
    """Cross the P0b claim boundary inside the receipt transaction."""

    lock_linked_submission_claim(
        session,
        intent=intent,
        handle=handle,
        expected_states=frozenset({"claimed"}),
        require_unexpired=True,
    )
    try:
        validate_broker_io_boundary(session, handle=handle)
        transitioned = transition_primary_uncommitted(
            session,
            handle=handle,
            expected_state="claimed",
            values={
                "state": "broker_io",
                "broker_io_started_at": broker_io_started_at,
                "recovery_after": recovery_after,
            },
            require_unexpired_lease=True,
        )
    except DecisionSubmissionFenceError as exc:
        raise BrokerMutationReceiptFenceError(
            f"linked_submission_claim_fenced:{handle.decision_id}"
        ) from exc
    except DecisionSubmissionClaimError as exc:
        raise BrokerMutationReceiptValidationError(
            f"linked_submission_claim_invalid:{exc}"
        ) from exc
    if transitioned.state != "broker_io":  # pragma: no cover - fenced CAS contract
        raise BrokerMutationReceiptConflictError(
            "linked_submission_claim_io_transition_mismatch"
        )


__all__ = [
    "LockedSubmissionClaim",
    "normalize_linked_submission_handle",
    "transition_linked_submission_io_uncommitted",
    "validate_linked_claim_lifecycle",
    "validate_linked_receipt_state",
]
