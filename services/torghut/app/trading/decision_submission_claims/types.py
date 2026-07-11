"""Types and bounds for durable decision submission claims."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal


CLAIM_MIN_LEASE_SECONDS = 5
CLAIM_MAX_LEASE_SECONDS = 300
CLAIM_DEFAULT_LEASE_SECONDS = 30
CLAIM_MIN_RECOVERY_SECONDS = 30
CLAIM_MAX_RECOVERY_SECONDS = 3600
CLAIM_DEFAULT_RECOVERY_SECONDS = 120

ClaimState = Literal["claimed", "broker_io", "submitted"]
ClaimAcquisitionOutcome = Literal[
    "acquired",
    "already_owned",
    "busy",
    "recovery_required",
    "submitted",
    "execution_exists",
    "not_claimable",
]
RecoveryClaimAcquisitionOutcome = Literal[
    "acquired",
    "already_owned",
    "busy",
    "not_ready",
    "not_required",
]
RecoveryObservationOutcome = Literal["not_found", "indeterminate"]


class DecisionSubmissionClaimError(RuntimeError):
    """Base error for invalid or unsafe claim operations."""


class DecisionSubmissionClaimValidationError(DecisionSubmissionClaimError):
    """A request does not match the immutable submission identity."""


class DecisionSubmissionFenceError(DecisionSubmissionClaimError):
    """A stale or invalid owner attempted a fenced mutation."""


@dataclass(frozen=True, slots=True)
class DecisionSubmissionClaimHandle:
    decision_id: uuid.UUID
    claim_token: uuid.UUID
    fencing_epoch: int
    account_label: str
    client_order_id: str
    claim_owner: str


@dataclass(frozen=True, slots=True)
class DecisionSubmissionRecoveryHandle:
    decision_id: uuid.UUID
    recovery_token: uuid.UUID
    recovery_fencing_epoch: int
    account_label: str
    client_order_id: str
    recovery_owner: str
    lease_expires_at: datetime


@dataclass(frozen=True, slots=True)
class DecisionSubmissionClaimAcquireOptions:
    claim_token: uuid.UUID | str | None = None
    lease_seconds: int = CLAIM_DEFAULT_LEASE_SECONDS


@dataclass(frozen=True, slots=True)
class DecisionSubmissionTerminalIdentity:
    broker_order_id: str
    broker_client_order_id: str
    execution_id: uuid.UUID | str


@dataclass(frozen=True, slots=True)
class DecisionSubmissionRecoveryObservation:
    checked_client_order_id: str
    outcome: RecoveryObservationOutcome
    evidence: str


@dataclass(frozen=True, slots=True)
class DecisionSubmissionClaimLifecycle:
    state: ClaimState
    claimed_at: datetime
    lease_expires_at: datetime
    broker_io_started_at: datetime | None
    recovery_after: datetime | None
    released_at: datetime | None
    release_reason: str | None


@dataclass(frozen=True, slots=True)
class DecisionSubmissionRecoveryAudit:
    checked_at: datetime | None
    observation_epoch: int | None
    outcome: str | None
    evidence: str | None


@dataclass(frozen=True, slots=True)
class DecisionSubmissionTerminalAudit:
    broker_order_id: str | None
    broker_client_order_id: str | None
    execution_id: uuid.UUID | None
    completed_at: datetime | None


@dataclass(frozen=True, slots=True)
class DecisionSubmissionClaimSnapshot:
    handle: DecisionSubmissionClaimHandle
    recovery_handle: DecisionSubmissionRecoveryHandle | None
    lifecycle: DecisionSubmissionClaimLifecycle
    recovery_audit: DecisionSubmissionRecoveryAudit
    terminal: DecisionSubmissionTerminalAudit

    @property
    def state(self) -> ClaimState:
        return self.lifecycle.state

    @property
    def claimed_at(self) -> datetime:
        return self.lifecycle.claimed_at

    @property
    def lease_expires_at(self) -> datetime:
        return self.lifecycle.lease_expires_at

    @property
    def broker_io_started_at(self) -> datetime | None:
        return self.lifecycle.broker_io_started_at

    @property
    def recovery_after(self) -> datetime | None:
        return self.lifecycle.recovery_after

    @property
    def recovery_checked_at(self) -> datetime | None:
        return self.recovery_audit.checked_at

    @property
    def recovery_outcome(self) -> str | None:
        return self.recovery_audit.outcome

    @property
    def recovery_observation_epoch(self) -> int | None:
        return self.recovery_audit.observation_epoch

    @property
    def recovery_evidence(self) -> str | None:
        return self.recovery_audit.evidence

    @property
    def released_at(self) -> datetime | None:
        return self.lifecycle.released_at

    @property
    def release_reason(self) -> str | None:
        return self.lifecycle.release_reason

    @property
    def broker_order_id(self) -> str | None:
        return self.terminal.broker_order_id

    @property
    def broker_client_order_id(self) -> str | None:
        return self.terminal.broker_client_order_id

    @property
    def execution_id(self) -> uuid.UUID | None:
        return self.terminal.execution_id

    @property
    def completed_at(self) -> datetime | None:
        return self.terminal.completed_at


@dataclass(frozen=True, slots=True)
class DecisionSubmissionClaimResult:
    outcome: ClaimAcquisitionOutcome
    claim: DecisionSubmissionClaimSnapshot | None

    @property
    def acquired(self) -> bool:
        return self.outcome in {"acquired", "already_owned"}


@dataclass(frozen=True, slots=True)
class DecisionSubmissionRecoveryClaimResult:
    outcome: RecoveryClaimAcquisitionOutcome
    claim: DecisionSubmissionClaimSnapshot | None

    @property
    def acquired(self) -> bool:
        return self.outcome in {"acquired", "already_owned"}
