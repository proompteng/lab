"""Single durable authority for production broker order submissions."""

from __future__ import annotations

import os
import socket
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Generic, TypeVar

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..models import Execution
from .broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationIoPermit,
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptError,
    BrokerMutationReceiptHandle,
    BrokerMutationSettlement,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    build_linked_submission_terminal_settlement,
    fingerprint_broker_endpoint,
    mark_broker_mutation_io_started,
    settle_broker_mutation_primary,
    settle_linked_submission_primary,
)
from .decision_submission_claims.types import DecisionSubmissionClaimError
from .decision_submission_claims.types import (
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimSnapshot,
)
from .decision_submission_claims import acquire_decision_submission_claim


_BrokerResult = TypeVar("_BrokerResult")
_PROCESS_ID = uuid.uuid4().hex[:12]
_WRITER_GENERATION = max(1, time.time_ns())


class BrokerMutationSubmissionError(RuntimeError):
    """Base error for a submission that the coordinator did not complete."""


class BrokerMutationSubmissionDeferred(BrokerMutationSubmissionError):
    """Durable ownership or unresolved I/O requires later reconciliation."""


class BrokerMutationSubmissionUnresolved(BrokerMutationSubmissionDeferred):
    """Broker I/O started, but no terminal receipt could be committed."""


class BrokerMutationSubmissionAlreadyProcessed(BrokerMutationSubmissionError):
    """The deterministic mutation identity already reached terminal truth."""


class BrokerMutationSubmissionRejected(BrokerMutationSubmissionError):
    """The linked decision is durably rejected or no longer claimable."""


@dataclass(frozen=True, slots=True)
class _BrokerMutationWriterIdentity:
    owner: str
    generation: int


@dataclass(frozen=True, slots=True)
class LinkedOrderSubmission:
    decision_id: uuid.UUID | str
    account_label: str
    client_order_id: str
    endpoint_url: str
    workflow_id: str
    risk_class: str
    request_payload: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class LinkedOrderSubmissionCallbacks:
    broker_call: Callable[[BrokerMutationIoPermit], Mapping[str, object]]
    persist_execution: Callable[[Mapping[str, object]], Execution]


@dataclass(frozen=True, slots=True)
class UnlinkedOrderSubmissionCallbacks(Generic[_BrokerResult]):
    broker_call: Callable[[BrokerMutationIoPermit], _BrokerResult]
    persist_terminal: Callable[[_BrokerResult], None]
    build_settlement: Callable[[_BrokerResult], BrokerMutationSettlement]


@dataclass(frozen=True, slots=True)
class _LinkedTerminalContext:
    handle: BrokerMutationReceiptHandle
    claim: DecisionSubmissionClaimSnapshot
    broker_result: Mapping[str, object]
    callbacks: LinkedOrderSubmissionCallbacks


@dataclass(frozen=True, slots=True)
class _UnlinkedTerminalContext(Generic[_BrokerResult]):
    handle: BrokerMutationReceiptHandle
    broker_result: _BrokerResult
    callbacks: UnlinkedOrderSubmissionCallbacks[_BrokerResult]


@lru_cache(maxsize=8)
def _broker_mutation_writer_identity(component: str) -> _BrokerMutationWriterIdentity:
    normalized_component = component.strip().lower()
    if not normalized_component or len(normalized_component) > 32:
        raise ValueError("broker_mutation_writer_component_invalid")
    hostname = socket.gethostname().strip().lower()[:32] or "unknown-host"
    return _BrokerMutationWriterIdentity(
        owner=f"{normalized_component}:{hostname}:{os.getpid()}:{_PROCESS_ID}",
        generation=_WRITER_GENERATION,
    )


class BrokerMutationSubmitCoordinator:
    """Acquire, authorize, call once, and durably settle one broker submit."""

    def __init__(self, writer_component: str) -> None:
        self._writer = _broker_mutation_writer_identity(writer_component)

    def submit_linked_order(
        self,
        session: Session,
        *,
        request: LinkedOrderSubmission,
        callbacks: LinkedOrderSubmissionCallbacks,
    ) -> Execution:
        intent = _linked_submission_intent(request)
        claim = self._acquire_linked_claim(session, request)
        handle = self._acquire_receipt(
            session,
            intent=intent,
            submission_claim_handle=claim.handle,
        )
        permit = self._start_io(
            session,
            handle=handle,
            submission_claim_handle=claim.handle,
        )
        broker_result = _call_broker(
            callbacks.broker_call,
            permit=permit,
            receipt_id=handle.receipt_id,
            scope="linked_submission",
        )
        return _settle_linked_terminal(
            session,
            _LinkedTerminalContext(
                handle=handle,
                claim=claim,
                broker_result=broker_result,
                callbacks=callbacks,
            ),
        )

    def submit_unlinked_order(
        self,
        session: Session,
        *,
        intent: BrokerMutationIntent,
        callbacks: UnlinkedOrderSubmissionCallbacks[_BrokerResult],
    ) -> _BrokerResult:
        handle = self._acquire_receipt(
            session,
            intent=intent,
            submission_claim_handle=None,
        )
        permit = self._start_io(
            session,
            handle=handle,
            submission_claim_handle=None,
        )
        broker_result = _call_broker(
            callbacks.broker_call,
            permit=permit,
            receipt_id=handle.receipt_id,
            scope="unlinked_submission",
        )
        _settle_unlinked_terminal(
            session,
            _UnlinkedTerminalContext(
                handle=handle,
                broker_result=broker_result,
                callbacks=callbacks,
            ),
        )
        return broker_result

    def _acquire_linked_claim(
        self,
        session: Session,
        request: LinkedOrderSubmission,
    ) -> DecisionSubmissionClaimSnapshot:
        try:
            claim = acquire_decision_submission_claim(
                session,
                decision_id=request.decision_id,
                client_order_id=request.client_order_id,
                claim_owner=self._writer.owner,
            )
        except (DecisionSubmissionClaimError, SQLAlchemyError) as exc:
            session.rollback()
            raise BrokerMutationSubmissionDeferred(
                "linked_submission_claim_unavailable:"
                f"{request.decision_id}:{type(exc).__name__}"
            ) from exc
        if claim.outcome in {"submitted", "execution_exists"}:
            raise BrokerMutationSubmissionAlreadyProcessed(
                f"linked_submission_already_processed:{request.decision_id}"
            )
        if claim.outcome in {"rejected", "not_claimable"}:
            raise BrokerMutationSubmissionRejected(
                f"linked_submission_not_claimable:{request.decision_id}:{claim.outcome}"
            )
        if claim.outcome not in {"acquired", "already_owned"}:
            raise BrokerMutationSubmissionDeferred(
                f"linked_submission_claim_deferred:{request.decision_id}:{claim.outcome}"
            )
        if claim.claim is None:
            raise BrokerMutationSubmissionDeferred(
                f"linked_submission_claim_missing:{request.decision_id}"
            )
        return claim.claim

    def _acquire_receipt(
        self,
        session: Session,
        *,
        intent: BrokerMutationIntent,
        submission_claim_handle: DecisionSubmissionClaimHandle | None,
    ) -> BrokerMutationReceiptHandle:
        scope = (
            "linked_submission"
            if submission_claim_handle is not None
            else "unlinked_submission"
        )
        identity = str(intent.submission_claim_id or intent.client_request_id)
        try:
            acquired = acquire_broker_mutation_receipt(
                session,
                intent=intent,
                primary_owner=self._writer.owner,
                writer_generation=self._writer.generation,
                options=(
                    BrokerMutationReceiptAcquireOptions(
                        submission_claim_handle=submission_claim_handle,
                    )
                    if submission_claim_handle is not None
                    else None
                ),
            )
        except (BrokerMutationReceiptError, SQLAlchemyError) as exc:
            session.rollback()
            raise BrokerMutationSubmissionDeferred(
                f"{scope}_receipt_unavailable:{identity}:{type(exc).__name__}"
            ) from exc
        _require_acquired(acquired.outcome, acquired.receipt.receipt_id)
        return acquired.receipt.primary_handle

    @staticmethod
    def _start_io(
        session: Session,
        *,
        handle: BrokerMutationReceiptHandle,
        submission_claim_handle: DecisionSubmissionClaimHandle | None,
    ) -> BrokerMutationIoPermit:
        scope = (
            "linked_submission"
            if submission_claim_handle is not None
            else "unlinked_submission"
        )
        try:
            io_start = mark_broker_mutation_io_started(
                session,
                handle=handle,
                submission_claim_handle=submission_claim_handle,
            )
        except (BrokerMutationReceiptError, SQLAlchemyError) as exc:
            session.rollback()
            raise BrokerMutationSubmissionDeferred(
                f"{scope}_io_boundary_unavailable:"
                f"{handle.receipt_id}:{type(exc).__name__}"
            ) from exc
        if not io_start.authorized:
            raise BrokerMutationSubmissionDeferred(
                f"{scope}_io_deferred:{handle.receipt_id}:{io_start.outcome}"
            )
        if io_start.permit is None:
            raise BrokerMutationSubmissionDeferred(
                f"{scope}_io_permit_missing:{handle.receipt_id}"
            )
        return io_start.permit


_BROKER_CALLBACK_ERRORS = (
    BrokerMutationReceiptError,
    ArithmeticError,
    AttributeError,
    LookupError,
    OSError,
    RuntimeError,
    TypeError,
    ValueError,
)
_TERMINAL_CALLBACK_ERRORS = _BROKER_CALLBACK_ERRORS + (SQLAlchemyError,)


def _linked_submission_intent(
    request: LinkedOrderSubmission,
) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label=request.account_label,
            endpoint_fingerprint=fingerprint_broker_endpoint(request.endpoint_url),
            operation="submit_order",
            risk_class=request.risk_class,
            purpose="initial_submission",
            workflow_id=request.workflow_id,
            client_request_id=request.client_order_id,
            target=BrokerMutationTarget(kind="order", key=request.client_order_id),
            request_payload=request.request_payload,
            submission_claim_id=request.decision_id,
        )
    )


def _call_broker(
    broker_call: Callable[[BrokerMutationIoPermit], _BrokerResult],
    *,
    permit: BrokerMutationIoPermit,
    receipt_id: uuid.UUID,
    scope: str,
) -> _BrokerResult:
    try:
        return broker_call(permit)
    except _BROKER_CALLBACK_ERRORS as exc:
        raise BrokerMutationSubmissionUnresolved(
            f"{scope}_broker_io_unresolved:{receipt_id}:{type(exc).__name__}"
        ) from exc


def _settle_linked_terminal(
    session: Session,
    context: _LinkedTerminalContext,
) -> Execution:
    try:
        broker_reference = _required_result_text(
            context.broker_result,
            "id",
            "order_id",
        )
        broker_status = _stable_status(context.broker_result.get("status"))
        execution = context.callbacks.persist_execution(context.broker_result)
        settlement = build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="primary",
                outcome="acknowledged",
                claim_handle=context.claim.handle,
                broker_status=broker_status,
                rejection_code=None,
                broker_reference=broker_reference,
                execution_id=execution.id,
            )
        )
        settle_linked_submission_primary(
            session,
            handle=context.handle,
            submission_claim_handle=context.claim.handle,
            settlement=settlement,
        )
        return execution
    except _TERMINAL_CALLBACK_ERRORS as exc:
        session.rollback()
        raise BrokerMutationSubmissionUnresolved(
            "linked_submission_terminal_unresolved:"
            f"{context.handle.receipt_id}:{type(exc).__name__}"
        ) from exc


def _settle_unlinked_terminal(
    session: Session,
    context: _UnlinkedTerminalContext[_BrokerResult],
) -> None:
    try:
        context.callbacks.persist_terminal(context.broker_result)
        settle_broker_mutation_primary(
            session,
            handle=context.handle,
            settlement=context.callbacks.build_settlement(context.broker_result),
        )
    except _TERMINAL_CALLBACK_ERRORS as exc:
        session.rollback()
        raise BrokerMutationSubmissionUnresolved(
            "unlinked_submission_terminal_unresolved:"
            f"{context.handle.receipt_id}:{type(exc).__name__}"
        ) from exc


def _require_acquired(outcome: str, receipt_id: uuid.UUID) -> None:
    if outcome in {"acquired", "already_owned"}:
        return
    if outcome == "settled":
        raise BrokerMutationSubmissionAlreadyProcessed(
            f"broker_mutation_already_processed:{receipt_id}"
        )
    raise BrokerMutationSubmissionDeferred(
        f"broker_mutation_receipt_deferred:{receipt_id}:{outcome}"
    )


def _required_result_text(result: Mapping[str, object], *keys: str) -> str:
    for key in keys:
        value = result.get(key)
        if value is not None and (normalized := str(value).strip()):
            return normalized
    raise ValueError(f"broker_submission_result_missing:{'/'.join(keys)}")


def _stable_status(value: object) -> str:
    normalized = str(value or "accepted").strip().lower().replace(" ", "_")
    return normalized or "accepted"


__all__ = [
    "BrokerMutationSubmissionAlreadyProcessed",
    "BrokerMutationSubmissionDeferred",
    "BrokerMutationSubmissionError",
    "BrokerMutationSubmissionRejected",
    "BrokerMutationSubmissionUnresolved",
    "BrokerMutationSubmitCoordinator",
    "LinkedOrderSubmission",
    "LinkedOrderSubmissionCallbacks",
    "UnlinkedOrderSubmissionCallbacks",
]
