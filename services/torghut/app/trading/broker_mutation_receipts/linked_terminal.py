"""Atomic terminal truth for one linked trade-decision submission."""

from __future__ import annotations

import json
import re
import uuid
from typing import cast

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ...models import Execution, TradeDecisionSubmissionClaim
from ..decision_submission_claims.persistence import (
    load_snapshot as load_claim_snapshot,
    snapshot_from_model as snapshot_claim_from_model,
    transition_primary_uncommitted,
)
from ..decision_submission_claims.types import (
    DecisionSubmissionClaimError,
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimSnapshot,
    DecisionSubmissionRecoveryHandle,
    DecisionSubmissionTerminalIdentity,
)
from ..decision_submission_claims.validation import normalized_terminal_identity
from .canonicalization import build_broker_mutation_settlement
from .lifecycle_helpers import (
    lock_current_receipt,
    normalized_primary_handle,
    normalized_settlement,
    require_primary_handle,
    rollback_session_on_error,
)
from .linked_submission import (
    lock_linked_submission_claim,
    normalize_linked_submission_handle,
)
from .persistence import (
    append_full_state_event,
    close_read_transaction,
    commit_or_rollback,
    full_state_values_from_event,
    load_receipt_snapshot,
)
from .types import (
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationLinkedSubmissionTerminalResult,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
    BrokerMutationSettlementOutcome,
    BrokerMutationSettlementRequest,
    BrokerMutationSettlementSource,
)
from .validation import (
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
    optional_text,
    required_text,
)


LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION = "torghut.linked-submission-terminal.v1"
_STABLE_BROKER_VALUE = re.compile(r"^[a-z0-9][a-z0-9_.:-]*$")
_SUCCESS_OUTCOMES: frozenset[str] = frozenset({"acknowledged", "reconciled"})


def build_linked_submission_terminal_settlement(
    request: BrokerMutationLinkedSubmissionSettlementRequest,
) -> BrokerMutationSettlement:
    """Build primary-response evidence bound to one submission claim."""

    source = request.source
    outcome = request.outcome
    if source != "primary":
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_source_invalid"
        )
    if outcome not in {*_SUCCESS_OUTCOMES, "rejected"}:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_outcome_invalid"
        )
    return _build_linked_submission_terminal_settlement(
        source="primary",
        outcome=cast(BrokerMutationSettlementOutcome, outcome),
        claim_handle=request.claim_handle,
        broker_status=request.broker_status,
        rejection_code=request.rejection_code,
        broker_reference=request.broker_reference,
        execution_id=request.execution_id,
    )


def _build_linked_submission_terminal_settlement(
    *,
    source: BrokerMutationSettlementSource,
    outcome: BrokerMutationSettlementOutcome,
    claim_handle: DecisionSubmissionClaimHandle | DecisionSubmissionRecoveryHandle,
    broker_status: str,
    rejection_code: str | None,
    broker_reference: str | None,
    execution_id: uuid.UUID | str | None,
) -> BrokerMutationSettlement:
    """Build the shared exact evidence envelope after source-specific validation."""

    if outcome not in {*_SUCCESS_OUTCOMES, "rejected"}:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_outcome_invalid"
        )
    status = _stable_broker_value(
        broker_status,
        field="broker_status",
        maximum=64,
    )
    code = _linked_rejection_code(
        outcome=outcome,
        rejection_code=rejection_code,
    )
    if outcome == "rejected":
        if broker_reference is not None or execution_id is not None:
            raise BrokerMutationReceiptValidationError(
                "linked_submission_rejection_forbids_execution_identity"
            )
    elif broker_reference is None or execution_id is None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_success_requires_execution_identity"
        )
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source=source,
            outcome=outcome,
            broker_reference=broker_reference,
            execution_id=execution_id,
            evidence_payload={
                "schema_version": LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION,
                "decision_id": str(claim_handle.decision_id),
                "account_label": claim_handle.account_label,
                "client_order_id": claim_handle.client_order_id,
                "broker_status": status,
                "rejection_code": code,
            },
        )
    )


def settle_linked_submission_primary(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    submission_claim_handle: DecisionSubmissionClaimHandle,
    settlement: BrokerMutationSettlement,
) -> BrokerMutationLinkedSubmissionTerminalResult:
    """Commit receipt, claim, and optional Execution as one primary terminal."""

    with rollback_session_on_error(session):
        normalized_handle = normalized_primary_handle(handle)
        normalized_terminal = normalized_settlement(
            settlement,
            expected_source="primary",
        )
        with session.no_autoflush:
            current = lock_current_receipt(session, normalized_handle.receipt_id)
            if current is None:
                raise BrokerMutationReceiptFenceError(
                    f"broker_mutation_receipt_not_found:{normalized_handle.receipt_id}"
                )
            require_primary_handle(current.snapshot, normalized_handle)
            claim_handle = normalize_linked_submission_handle(
                current.snapshot.intent,
                submission_claim_handle,
                expected_owner=normalized_handle.primary_owner,
            )
            if claim_handle is None:  # pragma: no cover - linked normalizer contract
                raise BrokerMutationReceiptValidationError(
                    "linked_submission_terminal_requires_claim"
                )
            if current.snapshot.submission_claim_handle != claim_handle:
                raise BrokerMutationReceiptConflictError(
                    "broker_mutation_submission_claim_event_identity_mismatch"
                )
            expected_claim_states = (
                frozenset({"submitted", "rejected"})
                if current.snapshot.settled
                else frozenset({"broker_io"})
            )
            locked_claim = lock_linked_submission_claim(
                session,
                intent=current.snapshot.intent,
                handle=claim_handle,
                expected_states=expected_claim_states,
                require_unexpired=False,
            )
        _validate_linked_terminal_evidence(
            normalized_terminal,
            claim_handle=claim_handle,
        )
        if current.snapshot.settled:
            _require_exact_terminal_retry(
                current.snapshot,
                normalized_terminal,
                claim=locked_claim.row,
                event_id=current.event.id,
            )
            result = BrokerMutationLinkedSubmissionTerminalResult(
                receipt=current.snapshot,
                submission_claim=_claim_snapshot(locked_claim.row),
            )
            close_read_transaction(session)
            return result
        if current.snapshot.state != "broker_io":
            raise BrokerMutationReceiptFenceError(
                "linked_submission_primary_terminal_state_mismatch:"
                f"{current.snapshot.state}"
            )

        session.flush()
        terminal_values = linked_submission_claim_terminal_values(
            session,
            claim_handle=claim_handle,
            settlement=normalized_terminal,
        )
        event_values = full_state_values_from_event(current.event)
        event_values.update(
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
        terminal_event = append_full_state_event(
            session,
            receipt_id=normalized_handle.receipt_id,
            values=event_values,
        )
        if terminal_event.settled_at is None:  # pragma: no cover - DB trigger contract
            raise BrokerMutationReceiptError(
                "linked_submission_terminal_database_time_missing"
            )
        terminal_values.update(
            completed_at=terminal_event.settled_at,
            terminal_receipt_event_id=terminal_event.id,
        )
        try:
            transition_primary_uncommitted(
                session,
                handle=claim_handle,
                expected_state="broker_io",
                values=terminal_values,
                require_unexpired_lease=False,
            )
        except DecisionSubmissionClaimError as exc:
            raise BrokerMutationReceiptValidationError(
                f"linked_submission_claim_terminal_invalid:{exc}"
            ) from exc
        commit_or_rollback(session)
        return committed_linked_submission_terminal_result(
            session,
            receipt_id=normalized_handle.receipt_id,
            decision_id=claim_handle.decision_id,
        )


def linked_submission_claim_terminal_values(
    session: Session,
    *,
    claim_handle: DecisionSubmissionClaimHandle,
    settlement: BrokerMutationSettlement,
) -> dict[str, object]:
    if settlement.outcome == "rejected":
        _require_no_submission_execution(session, claim_handle)
        if (
            settlement.broker_reference is not None
            or settlement.execution_id is not None
        ):
            raise BrokerMutationReceiptValidationError(
                "linked_submission_rejection_forbids_execution_identity"
            )
        return {
            "state": "rejected",
            "broker_order_id": None,
            "broker_client_order_id": None,
            "execution_id": None,
        }
    if settlement.broker_reference is None or settlement.execution_id is None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_success_requires_execution_identity"
        )
    try:
        broker_order_id, broker_client_order_id, execution_id = (
            normalized_terminal_identity(
                session,
                handle=claim_handle,
                terminal=DecisionSubmissionTerminalIdentity(
                    broker_order_id=settlement.broker_reference,
                    broker_client_order_id=claim_handle.client_order_id,
                    execution_id=settlement.execution_id,
                ),
            )
        )
    except DecisionSubmissionClaimError as exc:
        raise BrokerMutationReceiptValidationError(
            f"linked_submission_execution_invalid:{exc}"
        ) from exc
    return {
        "state": "submitted",
        "broker_order_id": broker_order_id,
        "broker_client_order_id": broker_client_order_id,
        "execution_id": execution_id,
    }


def _require_no_submission_execution(
    session: Session,
    handle: DecisionSubmissionClaimHandle,
) -> None:
    existing = session.execute(
        select(Execution.id)
        .where(
            or_(
                Execution.trade_decision_id == handle.decision_id,
                (
                    (Execution.alpaca_account_label == handle.account_label)
                    & (Execution.client_order_id == handle.client_order_id)
                ),
            )
        )
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_rejection_conflicts_with_execution"
        )


def _validate_linked_terminal_evidence(
    settlement: BrokerMutationSettlement,
    *,
    claim_handle: DecisionSubmissionClaimHandle,
) -> None:
    try:
        document_value: object = json.loads(settlement.evidence_json)
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_evidence_invalid"
        ) from exc
    if not isinstance(document_value, dict):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_evidence_invalid"
        )
    document = cast(dict[str, object], document_value)
    evidence_value = document.get("evidence")
    if not isinstance(evidence_value, dict):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_evidence_shape_mismatch"
        )
    evidence = cast(dict[str, object], evidence_value)
    expected_keys = {
        "schema_version",
        "decision_id",
        "account_label",
        "client_order_id",
        "broker_status",
        "rejection_code",
    }
    if set(evidence) != expected_keys:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_evidence_shape_mismatch"
        )
    if (
        evidence["schema_version"] != LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION
        or evidence["decision_id"] != str(claim_handle.decision_id)
        or evidence["account_label"] != claim_handle.account_label
        or evidence["client_order_id"] != claim_handle.client_order_id
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_evidence_identity_mismatch"
        )
    _stable_broker_value(
        evidence["broker_status"],
        field="broker_status",
        maximum=64,
    )
    _linked_rejection_code(
        outcome=settlement.outcome,
        rejection_code=evidence["rejection_code"],
    )


def _stable_broker_value(value: object, *, field: str, maximum: int) -> str:
    normalized = required_text(value, field=field, maximum=maximum)
    if _STABLE_BROKER_VALUE.fullmatch(normalized) is None:
        raise BrokerMutationReceiptValidationError(f"{field}_not_stable_code")
    return normalized


def _linked_rejection_code(
    *,
    outcome: str,
    rejection_code: object | None,
) -> str | None:
    code = optional_text(rejection_code, field="rejection_code", maximum=128)
    if outcome == "rejected":
        if code is None:
            raise BrokerMutationReceiptValidationError(
                "linked_submission_rejection_code_required"
            )
        return _stable_broker_value(code, field="rejection_code", maximum=128)
    if code is not None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_success_forbids_rejection_code"
        )
    return None


def _require_exact_terminal_retry(
    receipt: BrokerMutationReceiptSnapshot,
    settlement: BrokerMutationSettlement,
    *,
    claim: TradeDecisionSubmissionClaim,
    event_id: uuid.UUID,
) -> None:
    observed = receipt.settlement
    if (
        observed.source != settlement.source
        or observed.outcome != settlement.outcome
        or observed.broker_reference != settlement.broker_reference
        or observed.execution_id != settlement.execution_id
        or observed.evidence_json != settlement.evidence_json
        or observed.evidence_sha256 != settlement.evidence_sha256
    ):
        raise BrokerMutationReceiptConflictError(
            f"broker_mutation_terminal_conflict:{receipt.receipt_id}"
        )
    claim_snapshot = _claim_snapshot(claim)
    expected_state = "rejected" if settlement.outcome == "rejected" else "submitted"
    if (
        claim_snapshot.state != expected_state
        or claim_snapshot.terminal_receipt_event_id != event_id
        or claim_snapshot.execution_id != settlement.execution_id
        or claim_snapshot.broker_order_id != settlement.broker_reference
        or claim_snapshot.completed_at != observed.settled_at
    ):
        raise BrokerMutationReceiptConflictError(
            f"linked_submission_terminal_claim_conflict:{receipt.receipt_id}"
        )


def _claim_snapshot(
    row: TradeDecisionSubmissionClaim,
) -> DecisionSubmissionClaimSnapshot:
    return snapshot_claim_from_model(row)


def committed_linked_submission_terminal_result(
    session: Session,
    *,
    receipt_id: uuid.UUID,
    decision_id: uuid.UUID,
) -> BrokerMutationLinkedSubmissionTerminalResult:
    receipt = load_receipt_snapshot(session, receipt_id)
    claim = load_claim_snapshot(session, decision_id)
    if receipt is None or claim is None:  # pragma: no cover - commit proved both rows
        close_read_transaction(session)
        raise BrokerMutationReceiptError("linked_submission_terminal_readback_missing")
    result = BrokerMutationLinkedSubmissionTerminalResult(
        receipt=receipt,
        submission_claim=claim,
    )
    close_read_transaction(session)
    return result


__all__ = [
    "LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION",
    "build_linked_submission_terminal_settlement",
    "settle_linked_submission_primary",
]
