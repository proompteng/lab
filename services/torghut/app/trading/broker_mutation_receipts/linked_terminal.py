"""Atomic terminal truth for one linked trade-decision submission."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import cast

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ...models import Execution, TradeDecisionSubmissionClaim
from ..decision_submission_claims.persistence import (
    load_snapshot as load_claim_snapshot,
    snapshot_from_model as snapshot_claim_from_model,
    transition_primary_uncommitted,
    transition_recovery_uncommitted,
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
    normalized_recovery_handle,
    normalized_recovery_observation,
    normalized_settlement,
    require_primary_handle,
    require_recovery_handle,
    rollback_session_on_error,
)
from .linked_submission import (
    lock_linked_submission_claim,
    lock_linked_submission_recovery_claim,
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
    BrokerMutationLinkedSubmissionRecoveryObservationResult,
    BrokerMutationLinkedSubmissionTerminalResult,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservation,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
)
from .validation import (
    RECEIPT_DEFAULT_RECOVERY_SECONDS,
    RECEIPT_MAX_RECOVERY_SECONDS,
    RECEIPT_MIN_RECOVERY_SECONDS,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptValidationError,
    as_uuid,
    bounded_seconds,
    optional_text,
    positive_integer,
    required_text,
)


LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION = "torghut.linked-submission-terminal.v1"
LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION = (
    "torghut.linked-submission-recovery-terminal.v1"
)
_STABLE_BROKER_VALUE = re.compile(r"^[a-z0-9][a-z0-9_.:-]*$")
_SUCCESS_OUTCOMES: frozenset[str] = frozenset({"acknowledged", "reconciled"})


def build_linked_submission_terminal_settlement(
    request: BrokerMutationLinkedSubmissionSettlementRequest,
) -> BrokerMutationSettlement:
    """Build the exact sanitized evidence envelope bound to a submission claim."""

    source = request.source
    outcome = request.outcome
    if source not in {"primary", "recovery"}:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_source_invalid"
        )
    if outcome not in {*_SUCCESS_OUTCOMES, "rejected"}:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_outcome_invalid"
        )
    status = _stable_broker_value(
        request.broker_status,
        field="broker_status",
        maximum=64,
    )
    code = _linked_rejection_code(
        outcome=outcome,
        rejection_code=request.rejection_code,
    )
    if outcome == "rejected":
        if request.broker_reference is not None or request.execution_id is not None:
            raise BrokerMutationReceiptValidationError(
                "linked_submission_rejection_forbids_execution_identity"
            )
    elif request.broker_reference is None or request.execution_id is None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_success_requires_execution_identity"
        )
    if source == "recovery" and outcome == "acknowledged":
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_cannot_acknowledge"
        )
    recovery_evidence = request.recovery_evidence_payload
    if source == "primary":
        if recovery_evidence is not None:
            raise BrokerMutationReceiptValidationError(
                "linked_submission_primary_forbids_recovery_evidence"
            )
        schema_version = LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION
    else:
        if not isinstance(recovery_evidence, Mapping):
            raise BrokerMutationReceiptValidationError(
                "linked_submission_recovery_evidence_required"
            )
        _validate_recovery_terminal_payload(
            recovery_evidence,
            outcome=outcome,
        )
        schema_version = LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION
    evidence_payload: dict[str, object] = {
        "schema_version": schema_version,
        "decision_id": str(request.claim_handle.decision_id),
        "account_label": request.claim_handle.account_label,
        "client_order_id": request.claim_handle.client_order_id,
        "broker_status": status,
        "rejection_code": code,
    }
    if recovery_evidence is not None:
        evidence_payload["recovery"] = dict(recovery_evidence)
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source=source,
            outcome=outcome,
            broker_reference=request.broker_reference,
            execution_id=request.execution_id,
            evidence_payload=evidence_payload,
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
        terminal_values = _claim_terminal_values(
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
        return _committed_terminal_result(
            session,
            receipt_id=normalized_handle.receipt_id,
            decision_id=claim_handle.decision_id,
        )


def record_linked_submission_recovery_observation(
    session: Session,
    *,
    handle: BrokerMutationRecoveryHandle,
    submission_recovery_handle: DecisionSubmissionRecoveryHandle,
    observation: BrokerMutationRecoveryObservation,
    retry_seconds: int = RECEIPT_DEFAULT_RECOVERY_SECONDS,
) -> BrokerMutationLinkedSubmissionRecoveryObservationResult:
    """Atomically record the same negative read on a receipt and linked claim."""

    with rollback_session_on_error(session):
        normalized_handle = normalized_recovery_handle(handle)
        normalized_observation = normalized_recovery_observation(observation)
        bounded_retry = bounded_seconds(
            retry_seconds,
            minimum=RECEIPT_MIN_RECOVERY_SECONDS,
            maximum=RECEIPT_MAX_RECOVERY_SECONDS,
            field="retry_seconds",
        )
        current = lock_current_receipt(session, normalized_handle.receipt_id)
        if current is None:
            raise BrokerMutationReceiptFenceError(
                f"broker_mutation_receipt_not_found:{normalized_handle.receipt_id}"
            )
        require_recovery_handle(current.snapshot, normalized_handle)
        _require_active_receipt_recovery(current.snapshot, current.now)
        primary_claim_handle = _required_submission_claim_handle(current.snapshot)
        claim_recovery_handle = _normalize_claim_recovery_handle(
            submission_recovery_handle
        )
        _require_paired_recovery_handles(
            receipt_handle=normalized_handle,
            claim_handle=claim_recovery_handle,
        )
        lock_linked_submission_recovery_claim(
            session,
            intent=current.snapshot.intent,
            primary_handle=primary_claim_handle,
            recovery_handle=claim_recovery_handle,
        )
        if (
            normalized_observation.checked_client_request_id
            != current.snapshot.intent.client_request_id
            or normalized_observation.checked_target_key
            != current.snapshot.intent.target.key
        ):
            raise BrokerMutationReceiptValidationError(
                "recovery_observation_identity_mismatch"
            )

        retry_at = current.now + timedelta(seconds=bounded_retry)
        event_values = full_state_values_from_event(current.event)
        event_values.update(
            sequence_no=current.event.sequence_no + 1,
            event_type="recovery_observed",
            event_writer_generation=normalized_handle.recovery_writer_generation,
            recovery_after=retry_at,
            recovery_checked_at=current.now,
            recovery_observation_epoch=normalized_handle.recovery_epoch,
            recovery_outcome=normalized_observation.outcome,
            recovery_evidence_json=normalized_observation.evidence_json,
            recovery_evidence_sha256=normalized_observation.evidence_sha256,
        )
        observed_event = append_full_state_event(
            session,
            receipt_id=normalized_handle.receipt_id,
            values=event_values,
        )
        release_values = full_state_values_from_event(observed_event)
        release_values.update(
            sequence_no=observed_event.sequence_no + 1,
            event_type="recovery_released",
            event_writer_generation=normalized_handle.recovery_writer_generation,
        )
        released_event = append_full_state_event(
            session,
            receipt_id=normalized_handle.receipt_id,
            values=release_values,
        )
        if (
            observed_event.recovery_checked_at is None
            or observed_event.recovery_after is None
            or released_event.recovery_lease_expires_at is None
        ):  # pragma: no cover - database trigger contract
            raise BrokerMutationReceiptError(
                "linked_submission_recovery_observation_database_time_missing"
            )
        try:
            transition_recovery_uncommitted(
                session,
                handle=claim_recovery_handle,
                values={
                    "recovery_checked_at": observed_event.recovery_checked_at,
                    "recovery_observation_epoch": (
                        claim_recovery_handle.recovery_fencing_epoch
                    ),
                    "recovery_outcome": normalized_observation.outcome,
                    "recovery_evidence": _claim_recovery_evidence_reference(
                        receipt_id=normalized_handle.receipt_id,
                        evidence_sha256=normalized_observation.evidence_sha256,
                    ),
                    "recovery_after": observed_event.recovery_after,
                    "recovery_lease_expires_at": (
                        released_event.recovery_lease_expires_at
                    ),
                },
            )
        except DecisionSubmissionClaimError as exc:
            raise BrokerMutationReceiptValidationError(
                f"linked_submission_claim_recovery_invalid:{exc}"
            ) from exc
        commit_or_rollback(session)
        return _committed_recovery_observation_result(
            session,
            receipt_id=normalized_handle.receipt_id,
            decision_id=primary_claim_handle.decision_id,
        )


def settle_linked_submission_recovery(
    session: Session,
    *,
    handle: BrokerMutationRecoveryHandle,
    submission_recovery_handle: DecisionSubmissionRecoveryHandle,
    settlement: BrokerMutationSettlement,
) -> BrokerMutationLinkedSubmissionTerminalResult:
    """Commit recovered receipt, linked claim, and optional Execution atomically."""

    with rollback_session_on_error(session):
        normalized_handle = normalized_recovery_handle(handle)
        normalized_terminal = normalized_settlement(
            settlement,
            expected_source="recovery",
        )
        current = lock_current_receipt(session, normalized_handle.receipt_id)
        if current is None:
            raise BrokerMutationReceiptFenceError(
                f"broker_mutation_receipt_not_found:{normalized_handle.receipt_id}"
            )
        require_recovery_handle(current.snapshot, normalized_handle)
        primary_claim_handle = _required_submission_claim_handle(current.snapshot)
        claim_recovery_handle = _normalize_claim_recovery_handle(
            submission_recovery_handle
        )
        _require_paired_recovery_handles(
            receipt_handle=normalized_handle,
            claim_handle=claim_recovery_handle,
        )
        terminal_evidence = _validate_linked_terminal_evidence(
            normalized_terminal,
            claim_handle=primary_claim_handle,
        )
        if current.snapshot.settled:
            locked_claim = lock_linked_submission_claim(
                session,
                intent=current.snapshot.intent,
                handle=primary_claim_handle,
                expected_states=frozenset({"submitted", "rejected"}),
                require_unexpired=False,
            )
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

        _require_active_receipt_recovery(current.snapshot, current.now)
        lock_linked_submission_recovery_claim(
            session,
            intent=current.snapshot.intent,
            primary_handle=primary_claim_handle,
            recovery_handle=claim_recovery_handle,
        )
        session.flush()
        terminal_values = _claim_terminal_values(
            session,
            claim_handle=claim_recovery_handle,
            settlement=normalized_terminal,
        )
        event_values = full_state_values_from_event(current.event)
        event_values.update(
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
        terminal_event = append_full_state_event(
            session,
            receipt_id=normalized_handle.receipt_id,
            values=event_values,
        )
        if terminal_event.settled_at is None:  # pragma: no cover - DB contract
            raise BrokerMutationReceiptError(
                "linked_submission_terminal_database_time_missing"
            )
        terminal_values.update(
            completed_at=terminal_event.settled_at,
            terminal_receipt_event_id=terminal_event.id,
            recovery_checked_at=terminal_event.settled_at,
            recovery_observation_epoch=(claim_recovery_handle.recovery_fencing_epoch),
            recovery_outcome=_linked_recovery_claim_outcome(terminal_evidence),
            recovery_evidence=_claim_recovery_evidence_reference(
                receipt_id=normalized_handle.receipt_id,
                evidence_sha256=normalized_terminal.evidence_sha256,
            ),
            recovery_lease_expires_at=terminal_event.settled_at,
        )
        try:
            transition_recovery_uncommitted(
                session,
                handle=claim_recovery_handle,
                values=terminal_values,
            )
        except DecisionSubmissionClaimError as exc:
            raise BrokerMutationReceiptValidationError(
                f"linked_submission_claim_terminal_invalid:{exc}"
            ) from exc
        commit_or_rollback(session)
        return _committed_terminal_result(
            session,
            receipt_id=normalized_handle.receipt_id,
            decision_id=primary_claim_handle.decision_id,
        )


def _claim_terminal_values(
    session: Session,
    *,
    claim_handle: DecisionSubmissionClaimHandle | DecisionSubmissionRecoveryHandle,
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


def _required_submission_claim_handle(
    receipt: BrokerMutationReceiptSnapshot,
) -> DecisionSubmissionClaimHandle:
    claim_handle = receipt.submission_claim_handle
    if claim_handle is None or receipt.intent.submission_claim_id is None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_requires_claim"
        )
    return claim_handle


def _normalize_claim_recovery_handle(
    handle: DecisionSubmissionRecoveryHandle,
) -> DecisionSubmissionRecoveryHandle:
    return DecisionSubmissionRecoveryHandle(
        decision_id=as_uuid(handle.decision_id, field="recovery_claim_decision_id"),
        recovery_token=as_uuid(
            handle.recovery_token,
            field="recovery_claim_token",
        ),
        recovery_fencing_epoch=positive_integer(
            handle.recovery_fencing_epoch,
            field="recovery_claim_fencing_epoch",
        ),
        account_label=required_text(
            handle.account_label,
            field="recovery_claim_account_label",
            maximum=64,
        ),
        client_order_id=required_text(
            handle.client_order_id,
            field="recovery_claim_client_order_id",
            maximum=128,
        ),
        recovery_owner=required_text(
            handle.recovery_owner,
            field="recovery_claim_owner",
            maximum=128,
        ),
        lease_expires_at=handle.lease_expires_at,
    )


def _require_paired_recovery_handles(
    *,
    receipt_handle: BrokerMutationRecoveryHandle,
    claim_handle: DecisionSubmissionRecoveryHandle,
) -> None:
    if (
        receipt_handle.recovery_token != claim_handle.recovery_token
        or receipt_handle.recovery_owner != claim_handle.recovery_owner
        or receipt_handle.recovery_writer_generation <= 0
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_pair_mismatch"
        )


def _require_active_receipt_recovery(
    receipt: BrokerMutationReceiptSnapshot,
    now: datetime,
) -> None:
    observed = receipt.recovery_handle
    if (
        receipt.state != "broker_io"
        or observed is None
        or observed.recovery_lease_expires_at <= now
    ):
        raise BrokerMutationReceiptFenceError(
            f"broker_mutation_recovery_lease_expired:{receipt.receipt_id}"
        )


def _claim_recovery_evidence_reference(
    *,
    receipt_id: uuid.UUID,
    evidence_sha256: str,
) -> str:
    return f"receipt:{receipt_id}:sha256:{evidence_sha256}"


def _validate_recovery_terminal_payload(
    evidence: Mapping[str, object],
    *,
    outcome: str,
) -> None:
    schema_version = evidence.get("schema_version")
    resolution_state = evidence.get("resolution_state")
    if (
        not isinstance(schema_version, str)
        or not schema_version.startswith("torghut.")
        or evidence.get("automatic_resubmission_attempted") is not False
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_evidence_invalid"
        )
    allowed_resolution_states = (
        {"acknowledged"} if outcome == "reconciled" else {"rejected"}
    )
    if resolution_state not in allowed_resolution_states:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_resolution_invalid"
        )


def _linked_recovery_claim_outcome(
    evidence: Mapping[str, object],
) -> str:
    recovery = evidence.get("recovery")
    if not isinstance(recovery, dict):  # pragma: no cover - validated before commit
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_evidence_shape_mismatch"
        )
    recovery_payload = cast(dict[str, object], recovery)
    resolution_state = recovery_payload.get("resolution_state")
    if resolution_state in {"acknowledged", "rejected"}:
        return "found"
    raise BrokerMutationReceiptValidationError(
        "linked_submission_recovery_resolution_invalid"
    )


def _require_no_submission_execution(
    session: Session,
    handle: DecisionSubmissionClaimHandle | DecisionSubmissionRecoveryHandle,
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
) -> dict[str, object]:
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
    expected_schema_version = LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION
    if settlement.source == "recovery":
        expected_keys.add("recovery")
        expected_schema_version = LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION
    if set(evidence) != expected_keys:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_evidence_shape_mismatch"
        )
    if (
        evidence["schema_version"] != expected_schema_version
        or evidence["decision_id"] != str(claim_handle.decision_id)
        or evidence["account_label"] != claim_handle.account_label
        or evidence["client_order_id"] != claim_handle.client_order_id
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_terminal_evidence_identity_mismatch"
        )
    if settlement.source == "recovery" and not isinstance(
        evidence.get("recovery"), dict
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_evidence_shape_mismatch"
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
    return evidence


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


def _committed_terminal_result(
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


def _committed_recovery_observation_result(
    session: Session,
    *,
    receipt_id: uuid.UUID,
    decision_id: uuid.UUID,
) -> BrokerMutationLinkedSubmissionRecoveryObservationResult:
    receipt = load_receipt_snapshot(session, receipt_id)
    claim = load_claim_snapshot(session, decision_id)
    if receipt is None or claim is None:  # pragma: no cover - commit proved both rows
        close_read_transaction(session)
        raise BrokerMutationReceiptError(
            "linked_submission_recovery_observation_readback_missing"
        )
    result = BrokerMutationLinkedSubmissionRecoveryObservationResult(
        receipt=receipt,
        submission_claim=claim,
    )
    close_read_transaction(session)
    return result


__all__ = [
    "LINKED_SUBMISSION_RECOVERY_TERMINAL_SCHEMA_VERSION",
    "LINKED_SUBMISSION_TERMINAL_SCHEMA_VERSION",
    "build_linked_submission_terminal_settlement",
    "record_linked_submission_recovery_observation",
    "settle_linked_submission_recovery",
    "settle_linked_submission_primary",
]
