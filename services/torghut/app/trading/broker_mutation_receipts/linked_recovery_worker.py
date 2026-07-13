"""Unwired orchestration for one linked Alpaca submission recovery.

The worker is intentionally a small coordinator, not a broker adapter.  A
caller injects both the SQLAlchemy session factory and the broker lookup
callback.  This keeps the recovery boundary testable and prevents this module
from becoming a second broker client or a second lifecycle implementation.

The only terminal path is::

    acquire -> broker read -> strict observation validation ->
    quantity-only execution materialization -> paired settlement

Missing, notional, complex, and otherwise indeterminate broker responses are
recorded as quarantined observations and never materialized.  A non-terminal
observation releases the paired lease after its retry timestamp is recorded.
The module is deliberately not imported by a runtime or scheduler yet.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol, cast

from sqlalchemy.orm import Session

from ..execution.alpaca_recovery_observation import (
    AlpacaRecoveryObservation,
    AlpacaRecoveryObservationOutcome,
    validate_alpaca_recovery_observation,
)
from ..execution.materialization import (
    RecoveryMaterializationError,
    materialize_validated_alpaca_recovery,
)
from .canonicalization import build_broker_mutation_recovery_observation
from .linked_recovery import (
    acquire_linked_submission_recovery,
    build_linked_submission_recovery_settlement,
    record_linked_submission_recovery_observation,
    release_linked_submission_recovery,
    settle_linked_submission_recovery,
)
from .types import (
    BrokerMutationIntent,
    BrokerMutationLinkedSubmissionRecoveryAcquireResult,
    BrokerMutationLinkedSubmissionRecoveryHandle,
    BrokerMutationLinkedSubmissionTerminalResult,
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryObservationRequest,
)


LinkedRecoveryWorkerOutcome = Literal[
    "not_required",
    "not_ready",
    "busy",
    "not_found",
    "indeterminate",
    "reconciled",
]


class LinkedRecoveryBrokerReader(Protocol):
    """Read one broker order by the immutable linked submission identity."""

    def __call__(
        self,
        *,
        intent: BrokerMutationIntent,
        account_label: str,
        client_order_id: str,
        expected_broker_order_id: str | None,
    ) -> object | None:
        """Return a raw broker payload, or ``None`` when no order was found.

        Implementations must translate dependency-specific failures into
        :class:`LinkedRecoveryBrokerReadError` so the worker can quarantine a
        failed read without swallowing lifecycle or programming errors.
        """
        ...


class LinkedRecoveryBrokerReadError(RuntimeError):
    """A broker/dependency read failed before an order payload was returned."""


class LinkedRecoverySessionFactory(Protocol):
    """Construct a fresh session for each durable recovery boundary."""

    def __call__(self) -> Session:
        """Return a context-manager-capable SQLAlchemy session."""
        ...


@dataclass(frozen=True, slots=True)
class LinkedRecoveryWorkerResult:
    """Safe outcome of one recovery attempt.

    ``indeterminate`` is a quarantine outcome, not a terminal broker state.
    ``error_code`` is intentionally a bounded stable code; raw broker payloads
    and exception messages are never returned as evidence by this coordinator.
    """

    outcome: LinkedRecoveryWorkerOutcome
    acquisition: BrokerMutationLinkedSubmissionRecoveryAcquireResult
    observation: AlpacaRecoveryObservation | None = None
    execution_id: uuid.UUID | None = None
    terminal: BrokerMutationLinkedSubmissionTerminalResult | None = None
    error_code: str | None = None


_WORKER_EVIDENCE_SCHEMA = "torghut.linked-submission-recovery-worker.v1"


def recover_linked_submission(
    *,
    session_factory: LinkedRecoverySessionFactory,
    receipt_id: uuid.UUID | str,
    recovery_owner: str,
    writer_generation: int,
    broker_read: LinkedRecoveryBrokerReader,
    options: BrokerMutationRecoveryAcquireOptions | None = None,
    retry_seconds: int = 120,
) -> LinkedRecoveryWorkerResult:
    """Attempt one fail-closed linked submission recovery.

    Acquisition and every durable follow-up run in a fresh session.  The raw
    broker callback executes outside a database transaction, while execution
    materialization and paired settlement share one transaction so a failed or
    fenced terminal cannot leave an orphaned execution row.

    ``BrokerMutationReceiptFenceError`` and other unexpected persistence
    failures intentionally propagate to the caller.  They indicate a stale
    worker or infrastructure failure and must not be rewritten as broker truth.
    """

    acquisition = _acquire(
        session_factory=session_factory,
        receipt_id=receipt_id,
        recovery_owner=recovery_owner,
        writer_generation=writer_generation,
        options=options,
    )
    if not acquisition.acquired:
        return LinkedRecoveryWorkerResult(
            outcome=cast(LinkedRecoveryWorkerOutcome, acquisition.outcome),
            acquisition=acquisition,
        )

    handle = acquisition.handle
    receipt = acquisition.receipt
    claim = acquisition.submission_claim
    if handle is None or receipt is None or claim is None:  # pragma: no cover
        raise RuntimeError("linked_recovery_acquisition_contract_broken")

    expected_broker_order_id = claim.broker_order_id
    try:
        broker_order = broker_read(
            intent=receipt.intent,
            account_label=receipt.intent.account_label,
            client_order_id=receipt.intent.client_request_id,
            expected_broker_order_id=expected_broker_order_id,
        )
    except LinkedRecoveryBrokerReadError:
        return _quarantine_and_release(
            session_factory=session_factory,
            handle=handle,
            receipt=receipt,
            outcome="indeterminate",
            reason="broker_read_failed",
            error_code="broker_read_failed",
            retry_seconds=retry_seconds,
            acquisition=acquisition,
        )

    if broker_order is None:
        return _quarantine_and_release(
            session_factory=session_factory,
            handle=handle,
            receipt=receipt,
            outcome="not_found",
            reason="broker_order_absent",
            error_code="broker_order_absent",
            retry_seconds=retry_seconds,
            acquisition=acquisition,
        )

    observation = validate_alpaca_recovery_observation(
        intent=receipt.intent,
        account_label=receipt.intent.account_label,
        broker_order=broker_order,
        expected_broker_order_id=expected_broker_order_id,
    )
    if observation.outcome is not AlpacaRecoveryObservationOutcome.VALIDATED:
        reason = (
            observation.reason.value
            if observation.reason is not None
            else "observation_not_validated"
        )
        return _quarantine_and_release(
            session_factory=session_factory,
            handle=handle,
            receipt=receipt,
            outcome="indeterminate",
            reason=reason,
            error_code=reason,
            retry_seconds=retry_seconds,
            acquisition=acquisition,
            observation=observation,
        )

    order = observation.order
    if order is None:  # pragma: no cover - validator outcome contract
        raise RuntimeError("validated_recovery_observation_order_missing")

    try:
        with session_factory() as session:
            execution = materialize_validated_alpaca_recovery(
                session,
                intent=receipt.intent,
                observation=observation,
            )
            settlement = build_linked_submission_recovery_settlement(
                submission_claim_handle=handle.submission_claim,
                broker_status=order.status,
                broker_reference=order.broker_order_id,
                execution_id=execution.id,
            )
            terminal = settle_linked_submission_recovery(
                session,
                handle=handle,
                settlement=settlement,
            )
    except RecoveryMaterializationError:
        # The materializer has already rolled back on session close.  Preserve
        # the broker evidence as quarantined only after that transaction is
        # gone, so a DB identity/lifecycle conflict cannot leave an execution.
        return _quarantine_and_release(
            session_factory=session_factory,
            handle=handle,
            receipt=receipt,
            outcome="indeterminate",
            reason="recovery_materialization_rejected",
            error_code="recovery_materialization_rejected",
            retry_seconds=retry_seconds,
            acquisition=acquisition,
            observation=observation,
        )

    return LinkedRecoveryWorkerResult(
        outcome="reconciled",
        acquisition=acquisition,
        observation=observation,
        execution_id=execution.id,
        terminal=terminal,
    )


def _acquire(
    *,
    session_factory: LinkedRecoverySessionFactory,
    receipt_id: uuid.UUID | str,
    recovery_owner: str,
    writer_generation: int,
    options: BrokerMutationRecoveryAcquireOptions | None,
) -> BrokerMutationLinkedSubmissionRecoveryAcquireResult:
    with session_factory() as session:
        return acquire_linked_submission_recovery(
            session,
            receipt_id=receipt_id,
            recovery_owner=recovery_owner,
            writer_generation=writer_generation,
            options=options,
        )


def _quarantine_and_release(
    *,
    session_factory: LinkedRecoverySessionFactory,
    handle: BrokerMutationLinkedSubmissionRecoveryHandle,
    receipt: BrokerMutationReceiptSnapshot,
    outcome: Literal["not_found", "indeterminate"],
    reason: str,
    error_code: str,
    retry_seconds: int,
    acquisition: BrokerMutationLinkedSubmissionRecoveryAcquireResult,
    observation: AlpacaRecoveryObservation | None = None,
) -> LinkedRecoveryWorkerResult:
    intent = receipt.intent
    recovery_observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=intent.client_request_id,
            checked_target_key=intent.target.key,
            outcome=outcome,
            evidence_payload={
                "schema_version": _WORKER_EVIDENCE_SCHEMA,
                "observation_outcome": outcome,
                "reason": reason,
            },
        )
    )
    with session_factory() as session:
        record_linked_submission_recovery_observation(
            session,
            handle=handle,
            observation=recovery_observation,
            retry_seconds=retry_seconds,
        )
    with session_factory() as session:
        release_linked_submission_recovery(session, handle=handle)
    return LinkedRecoveryWorkerResult(
        outcome=outcome,
        acquisition=acquisition,
        observation=observation,
        error_code=error_code,
    )


__all__ = [
    "LinkedRecoveryBrokerReader",
    "LinkedRecoveryBrokerReadError",
    "LinkedRecoverySessionFactory",
    "LinkedRecoveryWorkerOutcome",
    "LinkedRecoveryWorkerResult",
    "recover_linked_submission",
]
