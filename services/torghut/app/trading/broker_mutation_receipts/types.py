"""Typed contracts for durable broker-mutation receipts."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Mapping, TypeAlias

from ..decision_submission_claims.types import (
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimSnapshot,
    DecisionSubmissionRecoveryHandle,
)
from .validation import (
    RECEIPT_DEFAULT_LEASE_SECONDS,
    BrokerMutationReceiptValidationError,
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
]
BrokerMutationSettlementSource = Literal["primary", "recovery", "preflight"]
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


@dataclass(frozen=True, slots=True)
class BrokerMutationLinkedSubmissionRecoveryHandle:
    """The exact paired receipt and submission-claim recovery fences."""

    receipt: BrokerMutationRecoveryHandle
    submission_claim: DecisionSubmissionRecoveryHandle


@dataclass(frozen=True, slots=True)
class BrokerMutationLinkedSubmissionRecoveryResult:
    """One atomically committed linked recovery state pair."""

    receipt: BrokerMutationReceiptSnapshot
    submission_claim: DecisionSubmissionClaimSnapshot

    @property
    def handle(self) -> BrokerMutationLinkedSubmissionRecoveryHandle:
        return _linked_submission_recovery_handle(
            receipt=self.receipt,
            submission_claim=self.submission_claim,
        )


@dataclass(frozen=True, slots=True)
class BrokerMutationLinkedSubmissionRecoveryAcquireResult:
    outcome: BrokerMutationRecoveryAcquireOutcome
    receipt: BrokerMutationReceiptSnapshot | None
    submission_claim: DecisionSubmissionClaimSnapshot | None

    @property
    def acquired(self) -> bool:
        return self.outcome in {"acquired", "already_owned"}

    @property
    def handle(self) -> BrokerMutationLinkedSubmissionRecoveryHandle | None:
        if not self.acquired:
            return None
        if self.receipt is None or self.submission_claim is None:
            raise BrokerMutationReceiptValidationError(
                "linked_submission_recovery_acquisition_state_missing"
            )
        return _linked_submission_recovery_handle(
            receipt=self.receipt,
            submission_claim=self.submission_claim,
        )


def _linked_submission_recovery_handle(
    *,
    receipt: BrokerMutationReceiptSnapshot,
    submission_claim: DecisionSubmissionClaimSnapshot,
) -> BrokerMutationLinkedSubmissionRecoveryHandle:
    receipt_handle = receipt.recovery_handle
    claim_handle = submission_claim.recovery_handle
    if receipt_handle is None or claim_handle is None:
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_handle_missing"
        )
    if (
        receipt_handle.recovery_token != claim_handle.recovery_token
        or receipt_handle.recovery_epoch != claim_handle.recovery_fencing_epoch
        or receipt_handle.recovery_owner != claim_handle.recovery_owner
        or receipt_handle.recovery_lease_expires_at != claim_handle.lease_expires_at
    ):
        raise BrokerMutationReceiptValidationError(
            "linked_submission_recovery_handle_mismatch"
        )
    return BrokerMutationLinkedSubmissionRecoveryHandle(
        receipt=receipt_handle,
        submission_claim=claim_handle,
    )


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
    submission_claim_id: uuid.UUID | None
    submission_claim_token: uuid.UUID | None
    submission_claim_fencing_epoch: int | None


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
    if settlement_outcome == "rejected":
        return "rejected"
    raise BrokerMutationReceiptValidationError(
        f"settlement_outcome_invalid:{settlement_outcome}"
    )


__all__ = [
    "BrokerMutationIntent",
    "BrokerMutationIntentRequest",
    "BrokerMutationIoPermit",
    "BrokerMutationIoStartOutcome",
    "BrokerMutationIoStartResult",
    "BrokerMutationLinkedSubmissionSettlementRequest",
    "BrokerMutationLinkedSubmissionRecoveryAcquireResult",
    "BrokerMutationLinkedSubmissionRecoveryHandle",
    "BrokerMutationLinkedSubmissionRecoveryResult",
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
