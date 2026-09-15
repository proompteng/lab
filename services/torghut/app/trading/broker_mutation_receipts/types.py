"""Typed contracts for durable broker-mutation receipts."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Mapping, TypeAlias

from ..decision_submission_claims.types import (
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimSnapshot,
)
from .validation import (
    RECEIPT_DEFAULT_LEASE_SECONDS,
    BrokerMutationReceiptValidationError,
    canonical_broker_request_sha256,
    canonical_broker_request_sha256_from_intent_json,
)


BrokerMutationRoute = Literal["alpaca", "hyperliquid"]
BrokerMutationOperation = Literal[
    "submit_order",
    "replace_order",
    "cancel_order",
    "cancel_all_orders",
    "close_position",
    "close_all_positions",
]
BrokerMutationRiskClass = Literal[
    "risk_increasing",
    "risk_reducing",
    "risk_neutral",
]
BrokerMutationPurpose = Literal[
    "initial_submission",
    "repricing",
    "inventory_conflict",
    "opposite_side_cleanup",
    "kill_switch",
    "governance",
    "closeout",
    "flatten",
    "operator",
    "control_plane_validation",
]
BrokerMutationTargetKind = Literal["order", "position", "account"]
BrokerMutationReceiptState = Literal["claimed", "released", "broker_io", "settled"]
BrokerMutationReceiptEventType = Literal[
    "primary_claimed",
    "primary_renewed",
    "primary_released",
    "broker_io_started",
    "recovery_claimed",
    "recovery_renewed",
    "recovery_released",
    "recovery_observed",
    "settled",
]
BrokerMutationSettlementOutcome = Literal[
    "acknowledged",
    "reconciled",
    "rejected",
    "already_satisfied",
    "validation_quarantine_closed",
]
BrokerMutationSettlementSource = Literal[
    "primary",
    "recovery",
    "preflight",
    "operator_confirmation",
]
BrokerMutationRecoveryObservationOutcome = Literal["not_found", "indeterminate"]
BrokerMutationReceiptAcquireOutcome = Literal[
    "acquired",
    "already_owned",
    "busy",
    "recovery_required",
    "settled",
]
BrokerMutationIoStartOutcome = Literal[
    "authorized",
    "already_started",
    "settled",
]
BrokerMutationRecoveryAcquireOutcome = Literal[
    "acquired",
    "already_owned",
    "busy",
    "not_ready",
    "not_required",
]
BrokerMutationRuntimeResult = Literal[
    "submitted",
    "reconciled",
    "already_processed",
    "deferred",
    "rejected",
]

CanonicalJsonScalar: TypeAlias = None | bool | int | str
CanonicalJsonValue: TypeAlias = (
    CanonicalJsonScalar | list["CanonicalJsonValue"] | dict[str, "CanonicalJsonValue"]
)
CanonicalRequestPayload: TypeAlias = Mapping[str, object]

_IO_PERMIT_SIGNING_KEY = secrets.token_bytes(32)
_IO_PERMIT_CONSUMPTION_LOCK = threading.Lock()
_CONSUMED_IO_PERMIT_TAGS: set[str] = set()


@dataclass(frozen=True, slots=True)
class BrokerMutationTarget:
    kind: BrokerMutationTargetKind
    key: str


@dataclass(frozen=True, slots=True)
class BrokerMutationIntentRequest:
    """Untrusted caller input for one canonical broker-mutation intent."""

    broker_route: str
    account_label: str
    endpoint_fingerprint: str
    operation: str
    risk_class: str
    purpose: str
    workflow_id: str
    client_request_id: str
    target: BrokerMutationTarget
    request_payload: CanonicalRequestPayload
    submission_claim_id: uuid.UUID | str | None = None


@dataclass(frozen=True, slots=True)
class BrokerMutationIntent:
    """Normalized semantic identity for exactly one broker mutation."""

    broker_route: BrokerMutationRoute
    account_label: str
    endpoint_fingerprint: str
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    purpose: BrokerMutationPurpose
    workflow_id: str
    client_request_id: str
    target: BrokerMutationTarget
    submission_claim_id: uuid.UUID | None
    intent_schema_version: str
    canonical_intent_json: str
    canonical_intent_sha256: str

    @property
    def canonical_request_sha256(self) -> str:
        return canonical_broker_request_sha256_from_intent_json(
            self.canonical_intent_json
        )


@dataclass(frozen=True, slots=True)
class BrokerMutationReceiptAcquireOptions:
    primary_token: uuid.UUID | str | None = None
    lease_seconds: int = RECEIPT_DEFAULT_LEASE_SECONDS
    submission_claim_handle: DecisionSubmissionClaimHandle | None = None


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryAcquireOptions:
    recovery_token: uuid.UUID | str | None = None
    lease_seconds: int = RECEIPT_DEFAULT_LEASE_SECONDS


@dataclass(frozen=True, slots=True)
class BrokerMutationReceiptHandle:
    receipt_id: uuid.UUID
    primary_token: uuid.UUID
    primary_epoch: int
    primary_owner: str
    primary_writer_generation: int


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryHandle:
    receipt_id: uuid.UUID
    recovery_token: uuid.UUID
    recovery_epoch: int
    recovery_owner: str
    recovery_writer_generation: int
    recovery_lease_expires_at: datetime


@dataclass(frozen=True, slots=True)
class BrokerMutationReceiptLifecycle:
    state: BrokerMutationReceiptState
    event_type: BrokerMutationReceiptEventType
    sequence_no: int
    event_writer_generation: int
    primary_claimed_at: datetime
    primary_lease_expires_at: datetime
    released_at: datetime | None
    release_reason: str | None
    broker_io_started_at: datetime | None
    recovery_after: datetime | None


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryAudit:
    checked_at: datetime | None
    observation_epoch: int | None
    outcome: BrokerMutationRecoveryObservationOutcome | None
    evidence_json: str | None
    evidence_sha256: str | None


@dataclass(frozen=True, slots=True)
class BrokerMutationSettlementAudit:
    source: BrokerMutationSettlementSource | None
    outcome: BrokerMutationSettlementOutcome | None
    broker_reference: str | None
    execution_id: uuid.UUID | None
    evidence_json: str | None
    evidence_sha256: str | None
    settled_at: datetime | None


@dataclass(frozen=True, slots=True)
class BrokerMutationReceiptSnapshot:
    receipt_id: uuid.UUID
    intent: BrokerMutationIntent
    creator_owner: str
    origin_writer_generation: int
    created_at: datetime
    primary_handle: BrokerMutationReceiptHandle
    submission_claim_handle: DecisionSubmissionClaimHandle | None
    recovery_handle: BrokerMutationRecoveryHandle | None
    lifecycle: BrokerMutationReceiptLifecycle
    recovery: BrokerMutationRecoveryAudit
    settlement: BrokerMutationSettlementAudit

    @property
    def state(self) -> BrokerMutationReceiptState:
        return self.lifecycle.state

    @property
    def settled(self) -> bool:
        return self.lifecycle.state == "settled"


@dataclass(frozen=True, slots=True)
class BrokerMutationReceiptEventSnapshot:
    event_id: uuid.UUID
    receipt_id: uuid.UUID
    sequence_no: int
    event_type: BrokerMutationReceiptEventType
    state: BrokerMutationReceiptState
    event_writer_generation: int
    recorded_at: datetime
    snapshot: BrokerMutationReceiptSnapshot


@dataclass(frozen=True, slots=True)
class BrokerMutationLinkedSubmissionTerminalResult:
    """One atomically committed claim and receipt terminal pair."""

    receipt: BrokerMutationReceiptSnapshot
    submission_claim: DecisionSubmissionClaimSnapshot

    @property
    def runtime_result(self) -> BrokerMutationRuntimeResult:
        return broker_mutation_runtime_result(self.receipt)


@dataclass(frozen=True, slots=True)
class BrokerMutationLinkedSubmissionSettlementRequest:
    """Untrusted broker terminal fields bound to one submission claim."""

    source: str
    outcome: str
    claim_handle: DecisionSubmissionClaimHandle
    broker_status: str
    rejection_code: str | None
    broker_reference: str | None
    execution_id: uuid.UUID | str | None
    recovery_evidence_payload: Mapping[str, object] | None = None


@dataclass(frozen=True, slots=True)
class BrokerMutationLinkedSubmissionRecoveryObservationResult:
    """One atomically committed receipt/claim recovery observation."""

    receipt: BrokerMutationReceiptSnapshot
    submission_claim: DecisionSubmissionClaimSnapshot


@dataclass(frozen=True, slots=True)
class BrokerMutationReceiptAcquireResult:
    outcome: BrokerMutationReceiptAcquireOutcome
    receipt: BrokerMutationReceiptSnapshot

    @property
    def acquired(self) -> bool:
        return self.outcome in {"acquired", "already_owned"}


@dataclass(frozen=True, slots=True)
class BrokerMutationIoPermit:
    """Ephemeral authorization returned only to the broker-I/O transition winner."""

    receipt_id: uuid.UUID
    primary_token: uuid.UUID
    primary_epoch: int
    event_sequence_no: int
    broker_route: BrokerMutationRoute
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    account_label: str
    endpoint_fingerprint: str
    canonical_intent_sha256: str
    canonical_request_sha256: str
    submission_claim_id: uuid.UUID | None
    submission_claim_token: uuid.UUID | None
    submission_claim_fencing_epoch: int | None
    authorization_tag: str = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class BrokerMutationIoPermitIssueRequest:
    receipt_id: uuid.UUID
    primary_token: uuid.UUID
    primary_epoch: int
    event_sequence_no: int
    broker_route: BrokerMutationRoute
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    account_label: str
    endpoint_fingerprint: str
    canonical_intent_sha256: str
    canonical_request_sha256: str
    submission_claim_id: uuid.UUID | None
    submission_claim_token: uuid.UUID | None
    submission_claim_fencing_epoch: int | None


@dataclass(frozen=True, slots=True)
class BrokerMutationIoPermitExpectation:
    broker_route: BrokerMutationRoute | None = None
    operation: BrokerMutationOperation | None = None
    risk_class: BrokerMutationRiskClass | None = None
    account_label: str | None = None
    endpoint_fingerprint: str | None = None
    request_payload: Mapping[str, object] | None = None


def issue_broker_mutation_io_permit(
    request: BrokerMutationIoPermitIssueRequest,
) -> BrokerMutationIoPermit:
    """Issue a process-local capability after the durable I/O boundary commits."""

    fields = (
        request.receipt_id,
        request.primary_token,
        request.primary_epoch,
        request.event_sequence_no,
        request.broker_route,
        request.operation,
        request.risk_class,
        request.account_label,
        request.endpoint_fingerprint,
        request.canonical_intent_sha256,
        request.canonical_request_sha256,
        request.submission_claim_id,
        request.submission_claim_token,
        request.submission_claim_fencing_epoch,
    )
    return BrokerMutationIoPermit(
        receipt_id=request.receipt_id,
        primary_token=request.primary_token,
        primary_epoch=request.primary_epoch,
        event_sequence_no=request.event_sequence_no,
        broker_route=request.broker_route,
        operation=request.operation,
        risk_class=request.risk_class,
        account_label=request.account_label,
        endpoint_fingerprint=request.endpoint_fingerprint,
        canonical_intent_sha256=request.canonical_intent_sha256,
        canonical_request_sha256=request.canonical_request_sha256,
        submission_claim_id=request.submission_claim_id,
        submission_claim_token=request.submission_claim_token,
        submission_claim_fencing_epoch=request.submission_claim_fencing_epoch,
        authorization_tag=_broker_mutation_io_permit_tag(fields),
    )


def validate_broker_mutation_io_permit(
    permit: object,
    *,
    expectation: BrokerMutationIoPermitExpectation | None = None,
) -> BrokerMutationIoPermit:
    """Reject forged or malformed broker-I/O capabilities at adapter boundaries."""

    if not isinstance(permit, BrokerMutationIoPermit):
        raise BrokerMutationReceiptValidationError("broker_mutation_io_permit_required")
    required = expectation or BrokerMutationIoPermitExpectation()
    fields = (
        permit.receipt_id,
        permit.primary_token,
        permit.primary_epoch,
        permit.event_sequence_no,
        permit.broker_route,
        permit.operation,
        permit.risk_class,
        permit.account_label,
        permit.endpoint_fingerprint,
        permit.canonical_intent_sha256,
        permit.canonical_request_sha256,
        permit.submission_claim_id,
        permit.submission_claim_token,
        permit.submission_claim_fencing_epoch,
    )
    expected_tag = _broker_mutation_io_permit_tag(fields)
    if not hmac.compare_digest(permit.authorization_tag, expected_tag):
        raise BrokerMutationReceiptValidationError("broker_mutation_io_permit_invalid")
    if (
        permit.primary_epoch <= 0
        or permit.event_sequence_no <= 0
        or permit.broker_route not in {"alpaca", "hyperliquid"}
        or permit.operation
        not in {
            "submit_order",
            "replace_order",
            "cancel_order",
            "cancel_all_orders",
            "close_position",
            "close_all_positions",
        }
        or permit.risk_class not in {"risk_increasing", "risk_reducing", "risk_neutral"}
        or not permit.account_label
        or len(permit.endpoint_fingerprint) != 64
        or any(
            character not in "0123456789abcdef"
            for character in permit.endpoint_fingerprint
        )
        or len(permit.canonical_intent_sha256) != 64
        or any(
            character not in "0123456789abcdef"
            for character in permit.canonical_intent_sha256
        )
        or len(permit.canonical_request_sha256) != 64
        or any(
            character not in "0123456789abcdef"
            for character in permit.canonical_request_sha256
        )
        or (
            required.broker_route is not None
            and permit.broker_route != required.broker_route
        )
        or (required.operation is not None and permit.operation != required.operation)
        or (
            required.risk_class is not None and permit.risk_class != required.risk_class
        )
        or (
            required.account_label is not None
            and permit.account_label != required.account_label
        )
        or (
            required.endpoint_fingerprint is not None
            and permit.endpoint_fingerprint != required.endpoint_fingerprint
        )
        or (
            required.request_payload is not None
            and permit.canonical_request_sha256
            != canonical_broker_request_sha256(required.request_payload)
        )
    ):
        raise BrokerMutationReceiptValidationError("broker_mutation_io_permit_invalid")
    claim_fields = (
        permit.submission_claim_id,
        permit.submission_claim_token,
        permit.submission_claim_fencing_epoch,
    )
    if any(value is None for value in claim_fields) and any(
        value is not None for value in claim_fields
    ):
        raise BrokerMutationReceiptValidationError("broker_mutation_io_permit_invalid")
    return permit


def consume_broker_mutation_io_permit(
    permit: object,
    *,
    expectation: BrokerMutationIoPermitExpectation,
) -> BrokerMutationIoPermit:
    """Validate and atomically consume one exact broker-I/O capability."""

    validated = validate_broker_mutation_io_permit(
        permit,
        expectation=expectation,
    )
    with _IO_PERMIT_CONSUMPTION_LOCK:
        if validated.authorization_tag in _CONSUMED_IO_PERMIT_TAGS:
            raise BrokerMutationReceiptValidationError(
                "broker_mutation_io_permit_already_consumed"
            )
        _CONSUMED_IO_PERMIT_TAGS.add(validated.authorization_tag)
    return validated


def _broker_mutation_io_permit_tag(fields: tuple[object, ...]) -> str:
    payload = "\x1f".join("" if value is None else str(value) for value in fields)
    return hmac.new(
        _IO_PERMIT_SIGNING_KEY,
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


@dataclass(frozen=True, slots=True)
class BrokerMutationIoStartResult:
    outcome: BrokerMutationIoStartOutcome
    receipt: BrokerMutationReceiptSnapshot
    permit: BrokerMutationIoPermit | None

    @property
    def authorized(self) -> bool:
        return self.outcome == "authorized" and self.permit is not None


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryAcquireResult:
    outcome: BrokerMutationRecoveryAcquireOutcome
    receipt: BrokerMutationReceiptSnapshot | None

    @property
    def acquired(self) -> bool:
        return self.outcome in {"acquired", "already_owned"}


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryObservation:
    checked_client_request_id: str
    checked_target_key: str
    outcome: BrokerMutationRecoveryObservationOutcome
    evidence_json: str
    evidence_sha256: str


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryObservationRequest:
    checked_client_request_id: str
    checked_target_key: str
    outcome: str
    evidence_payload: object


@dataclass(frozen=True, slots=True)
class BrokerMutationSettlement:
    source: BrokerMutationSettlementSource
    outcome: BrokerMutationSettlementOutcome
    broker_reference: str | None
    execution_id: uuid.UUID | None
    evidence_json: str
    evidence_sha256: str


@dataclass(frozen=True, slots=True)
class BrokerMutationSettlementRequest:
    source: str
    outcome: str
    broker_reference: str | None
    execution_id: uuid.UUID | str | None
    evidence_payload: object


def broker_mutation_runtime_result(
    receipt: BrokerMutationReceiptSnapshot,
) -> BrokerMutationRuntimeResult:
    """Map only a durable receipt snapshot to the future runtime contract."""

    settlement_outcome = receipt.settlement.outcome
    if not receipt.settled:
        return "deferred"
    if settlement_outcome is None:
        raise BrokerMutationReceiptValidationError(
            "settled_receipt_requires_settlement_outcome"
        )
    if (
        receipt.intent.submission_claim_id is not None
        and settlement_outcome in {"acknowledged", "reconciled"}
        and receipt.settlement.execution_id is None
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_success_requires_execution"
        )
    if settlement_outcome == "acknowledged":
        return "submitted"
    if settlement_outcome == "reconciled":
        return "reconciled"
    if settlement_outcome == "already_satisfied":
        return "already_processed"
    if settlement_outcome == "validation_quarantine_closed":
        return "already_processed"
    if settlement_outcome == "rejected":
        return "rejected"
    raise BrokerMutationReceiptValidationError(
        f"settlement_outcome_invalid:{settlement_outcome}"
    )


__all__ = [
    "BrokerMutationIntent",
    "BrokerMutationIntentRequest",
    "BrokerMutationIoPermit",
    "BrokerMutationIoPermitExpectation",
    "BrokerMutationIoPermitIssueRequest",
    "BrokerMutationIoStartOutcome",
    "BrokerMutationIoStartResult",
    "BrokerMutationLinkedSubmissionSettlementRequest",
    "BrokerMutationLinkedSubmissionRecoveryObservationResult",
    "BrokerMutationLinkedSubmissionTerminalResult",
    "BrokerMutationOperation",
    "BrokerMutationPurpose",
    "BrokerMutationReceiptAcquireOptions",
    "BrokerMutationReceiptAcquireOutcome",
    "BrokerMutationReceiptAcquireResult",
    "BrokerMutationReceiptEventSnapshot",
    "BrokerMutationReceiptEventType",
    "BrokerMutationReceiptHandle",
    "BrokerMutationReceiptLifecycle",
    "BrokerMutationReceiptSnapshot",
    "BrokerMutationReceiptState",
    "BrokerMutationRecoveryAcquireOutcome",
    "BrokerMutationRecoveryAcquireOptions",
    "BrokerMutationRecoveryAcquireResult",
    "BrokerMutationRecoveryAudit",
    "BrokerMutationRecoveryHandle",
    "BrokerMutationRecoveryObservation",
    "BrokerMutationRecoveryObservationRequest",
    "BrokerMutationRecoveryObservationOutcome",
    "BrokerMutationRiskClass",
    "BrokerMutationRoute",
    "BrokerMutationRuntimeResult",
    "BrokerMutationSettlement",
    "BrokerMutationSettlementRequest",
    "BrokerMutationSettlementAudit",
    "BrokerMutationSettlementOutcome",
    "BrokerMutationSettlementSource",
    "BrokerMutationTarget",
    "BrokerMutationTargetKind",
    "CanonicalJsonScalar",
    "CanonicalJsonValue",
    "CanonicalRequestPayload",
    "broker_mutation_runtime_result",
]
