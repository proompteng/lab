"""Single durable authority for every production broker mutation."""

from __future__ import annotations

import os
import socket
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Generic, TypeVar

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..models import Execution
from .broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationExplicitRejection,
    BrokerMutationIoPermit,
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptError,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    build_linked_submission_terminal_settlement,
    fingerprint_broker_endpoint,
    mark_broker_mutation_io_started,
    release_broker_mutation_receipt,
    settle_broker_mutation_primary,
    settle_broker_mutation_preflight,
    settle_linked_submission_primary,
)
from .decision_submission_claims.types import DecisionSubmissionClaimError
from .decision_submission_claims.types import (
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimSnapshot,
)
from .decision_submission_claims import acquire_decision_submission_claim
from .infrastructure_validation import (
    InfrastructureValidationPermit,
    InfrastructureValidationSubmitPlan,
    authorize_infrastructure_validation_order,
    infrastructure_validation_client_order_id,
    infrastructure_validation_request_payload,
)


_BrokerResult = TypeVar("_BrokerResult")
_PROCESS_ID = uuid.uuid4().hex[:12]
_WRITER_GENERATION = max(1, time.time_ns())


class BrokerMutationError(RuntimeError):
    """Base error for a mutation that the coordinator did not complete."""


class BrokerMutationDeferred(BrokerMutationError):
    """Durable ownership or unresolved I/O requires later reconciliation."""


class BrokerMutationUnresolved(BrokerMutationDeferred):
    """Broker I/O started, but no terminal receipt could be committed."""


class BrokerMutationAlreadyProcessed(BrokerMutationError):
    """The deterministic mutation identity already reached terminal truth."""


class BrokerMutationRejected(BrokerMutationError):
    """The mutation is durably rejected or no longer claimable."""


class BrokerMutationPreflightFailed(BrokerMutationError):
    """A reversible pre-I/O check failed before the broker boundary."""


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
class UnlinkedMutationCallbacks(Generic[_BrokerResult]):
    broker_call: Callable[[BrokerMutationIoPermit], _BrokerResult]
    persist_terminal: Callable[[_BrokerResult], None]
    build_settlement: Callable[[_BrokerResult], BrokerMutationSettlement]
    preflight: Callable[[], None] | None = None


@dataclass(frozen=True, slots=True)
class InfrastructureValidationOrderSubmission:
    permit: InfrastructureValidationPermit
    plan: InfrastructureValidationSubmitPlan
    account_label: str
    endpoint_url: str


@dataclass(frozen=True, slots=True)
class _LinkedTerminalContext:
    handle: BrokerMutationReceiptHandle
    claim: DecisionSubmissionClaimSnapshot
    broker_result: Mapping[str, object]
    callbacks: LinkedOrderSubmissionCallbacks


@dataclass(frozen=True, slots=True)
class _UnlinkedTerminalContext(Generic[_BrokerResult]):
    handle: BrokerMutationReceiptHandle
    scope: str
    broker_result: _BrokerResult
    callbacks: UnlinkedMutationCallbacks[_BrokerResult]


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


class BrokerMutationCoordinator:
    """Acquire, authorize, call once, and durably settle one broker mutation."""

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
            scope="linked_submission",
        )
        try:
            broker_result = _call_broker(
                callbacks.broker_call,
                permit=permit,
                receipt_id=handle.receipt_id,
                scope="linked_submission",
            )
        except BrokerMutationExplicitRejection as exc:
            _settle_linked_broker_rejection(
                session,
                handle=handle,
                claim=claim,
                rejection=exc,
            )
            raise BrokerMutationRejected(
                _broker_rejection_message("linked_submission", handle.receipt_id, exc)
            ) from exc
        return _settle_linked_terminal(
            session,
            _LinkedTerminalContext(
                handle=handle,
                claim=claim,
                broker_result=broker_result,
                callbacks=callbacks,
            ),
        )

    def execute_unlinked_mutation(
        self,
        session: Session,
        *,
        intent: BrokerMutationIntent,
        callbacks: UnlinkedMutationCallbacks[_BrokerResult],
    ) -> _BrokerResult:
        if intent.submission_claim_id is not None:
            raise BrokerMutationRejected("linked_mutation_requires_linked_authority")
        if intent.purpose == "control_plane_validation":
            raise BrokerMutationRejected(
                "infrastructure_validation_requires_dedicated_submit_authority"
            )
        return self._execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=callbacks,
        )

    def settle_preflight(
        self,
        session: Session,
        *,
        intent: BrokerMutationIntent,
        settlement: BrokerMutationSettlement,
    ) -> BrokerMutationReceiptSnapshot:
        """Durably record that observation proved a mutation already satisfied."""

        if intent.submission_claim_id is not None:
            raise BrokerMutationRejected("linked_mutation_requires_linked_authority")
        handle = self._acquire_receipt(
            session,
            intent=intent,
            submission_claim_handle=None,
        )
        try:
            return settle_broker_mutation_preflight(
                session,
                handle=handle,
                settlement=settlement,
            )
        except (BrokerMutationReceiptError, SQLAlchemyError) as exc:
            session.rollback()
            raise BrokerMutationUnresolved(
                "mutation_preflight_terminal_unresolved:"
                f"{handle.receipt_id}:{type(exc).__name__}"
            ) from exc

    def submit_infrastructure_validation_order(
        self,
        session: Session,
        *,
        request: InfrastructureValidationOrderSubmission,
        callbacks: UnlinkedMutationCallbacks[_BrokerResult],
        now: datetime | None = None,
    ) -> _BrokerResult:
        """Submit one permit-bound, non-promotable paper validation order."""

        evaluated_at = now or datetime.now(timezone.utc)
        authorize_infrastructure_validation_order(
            request.permit,
            request.plan,
            account_label=request.account_label,
            broker_base_url=request.endpoint_url,
            now=evaluated_at,
        )
        client_order_id = infrastructure_validation_client_order_id(
            request.permit,
            request.plan,
        )
        intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label=request.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(request.endpoint_url),
                operation="submit_order",
                risk_class="risk_neutral",
                purpose="control_plane_validation",
                workflow_id=client_order_id,
                client_request_id=client_order_id,
                target=BrokerMutationTarget(kind="order", key=client_order_id),
                request_payload=infrastructure_validation_request_payload(
                    request.permit,
                    request.plan,
                ),
            )
        )
        return self._execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=callbacks,
        )

    def _execute_unlinked_mutation(
        self,
        session: Session,
        *,
        intent: BrokerMutationIntent,
        callbacks: UnlinkedMutationCallbacks[_BrokerResult],
    ) -> _BrokerResult:
        scope = _unlinked_scope(intent)
        handle = self._acquire_receipt(
            session,
            intent=intent,
            submission_claim_handle=None,
        )
        _run_unlinked_preflight(
            session,
            handle=handle,
            preflight=callbacks.preflight,
        )
        permit = self._start_io(
            session,
            handle=handle,
            submission_claim_handle=None,
            scope=scope,
        )
        try:
            broker_result = _call_broker(
                callbacks.broker_call,
                permit=permit,
                receipt_id=handle.receipt_id,
                scope=scope,
            )
        except BrokerMutationExplicitRejection as exc:
            _settle_unlinked_broker_rejection(
                session,
                handle=handle,
                scope=scope,
                rejection=exc,
            )
            raise BrokerMutationRejected(
                _broker_rejection_message(scope, handle.receipt_id, exc)
            ) from exc
        _settle_unlinked_terminal(
            session,
            _UnlinkedTerminalContext(
                handle=handle,
                scope=scope,
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
            raise BrokerMutationDeferred(
                "linked_submission_claim_unavailable:"
                f"{request.decision_id}:{type(exc).__name__}"
            ) from exc
        if claim.outcome in {"submitted", "execution_exists"}:
            raise BrokerMutationAlreadyProcessed(
                f"linked_submission_already_processed:{request.decision_id}"
            )
        if claim.outcome in {"rejected", "not_claimable"}:
            raise BrokerMutationRejected(
                f"linked_submission_not_claimable:{request.decision_id}:{claim.outcome}"
            )
        if claim.outcome not in {"acquired", "already_owned"}:
            raise BrokerMutationDeferred(
                f"linked_submission_claim_deferred:{request.decision_id}:{claim.outcome}"
            )
        if claim.claim is None:
            raise BrokerMutationDeferred(
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
            else _unlinked_scope(intent)
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
            raise BrokerMutationDeferred(
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
        scope: str,
    ) -> BrokerMutationIoPermit:
        try:
            io_start = mark_broker_mutation_io_started(
                session,
                handle=handle,
                submission_claim_handle=submission_claim_handle,
            )
        except (BrokerMutationReceiptError, SQLAlchemyError) as exc:
            session.rollback()
            raise BrokerMutationDeferred(
                f"{scope}_io_boundary_unavailable:"
                f"{handle.receipt_id}:{type(exc).__name__}"
            ) from exc
        if not io_start.authorized:
            raise BrokerMutationDeferred(
                f"{scope}_io_deferred:{handle.receipt_id}:{io_start.outcome}"
            )
        if io_start.permit is None:
            raise BrokerMutationDeferred(
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


def _run_unlinked_preflight(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    preflight: Callable[[], None] | None,
) -> None:
    if preflight is None:
        return
    try:
        preflight()
    except BrokerMutationPreflightFailed as exc:
        try:
            release_broker_mutation_receipt(
                session,
                handle=handle,
                reason=f"preflight_failed:{type(exc).__name__}",
            )
        except (BrokerMutationReceiptError, SQLAlchemyError) as release_exc:
            session.rollback()
            raise BrokerMutationDeferred(
                "unlinked_submission_preflight_release_unavailable:"
                f"{handle.receipt_id}:{type(release_exc).__name__}"
            ) from release_exc
        raise


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
    except BrokerMutationExplicitRejection:
        raise
    except _BROKER_CALLBACK_ERRORS as exc:
        raise BrokerMutationUnresolved(
            f"{scope}_broker_io_unresolved:{receipt_id}:{type(exc).__name__}"
        ) from exc


def _settle_linked_broker_rejection(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    claim: DecisionSubmissionClaimSnapshot,
    rejection: BrokerMutationExplicitRejection,
) -> None:
    try:
        settlement = build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="primary",
                outcome="rejected",
                claim_handle=claim.handle,
                broker_status=rejection.broker_status,
                rejection_code=rejection.rejection_code,
                broker_reference=None,
                execution_id=None,
            )
        )
        settle_linked_submission_primary(
            session,
            handle=handle,
            submission_claim_handle=claim.handle,
            settlement=settlement,
        )
    except _TERMINAL_CALLBACK_ERRORS as exc:
        session.rollback()
        raise BrokerMutationUnresolved(
            f"linked_submission_rejection_unresolved:{handle.receipt_id}:"
            f"{type(exc).__name__}"
        ) from exc


def _settle_unlinked_broker_rejection(
    session: Session,
    *,
    handle: BrokerMutationReceiptHandle,
    scope: str,
    rejection: BrokerMutationExplicitRejection,
) -> None:
    try:
        settlement = build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="primary",
                outcome="rejected",
                broker_reference=None,
                execution_id=None,
                evidence_payload={
                    "schema_version": ("torghut.broker-mutation-explicit-rejection.v1"),
                    "broker_status": rejection.broker_status,
                    "rejection_code": rejection.rejection_code,
                    "detail": rejection.detail,
                },
            )
        )
        settle_broker_mutation_primary(
            session,
            handle=handle,
            settlement=settlement,
        )
    except _TERMINAL_CALLBACK_ERRORS as exc:
        session.rollback()
        raise BrokerMutationUnresolved(
            f"{scope}_rejection_unresolved:{handle.receipt_id}:{type(exc).__name__}"
        ) from exc


def _broker_rejection_message(
    scope: str,
    receipt_id: uuid.UUID,
    rejection: BrokerMutationExplicitRejection,
) -> str:
    return (
        f"{scope}_broker_rejected:{receipt_id}:"
        f"{rejection.broker_status}:{rejection.rejection_code}"
    )


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
        raise BrokerMutationUnresolved(
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
        raise BrokerMutationUnresolved(
            f"{context.scope}_terminal_unresolved:"
            f"{context.handle.receipt_id}:{type(exc).__name__}"
        ) from exc


def _require_acquired(outcome: str, receipt_id: uuid.UUID) -> None:
    if outcome in {"acquired", "already_owned"}:
        return
    if outcome == "settled":
        raise BrokerMutationAlreadyProcessed(
            f"broker_mutation_already_processed:{receipt_id}"
        )
    raise BrokerMutationDeferred(
        f"broker_mutation_receipt_deferred:{receipt_id}:{outcome}"
    )


def _required_result_text(result: Mapping[str, object], *keys: str) -> str:
    for key in keys:
        value = result.get(key)
        if value is not None and (normalized := str(value).strip()):
            return normalized
    raise ValueError(f"broker_submission_result_missing:{'/'.join(keys)}")


def _unlinked_scope(intent: BrokerMutationIntent) -> str:
    if intent.operation == "submit_order":
        return "unlinked_submission"
    return f"unlinked_{intent.operation}"


def _stable_status(value: object) -> str:
    normalized = str(value or "accepted").strip().lower().replace(" ", "_")
    return normalized or "accepted"


__all__ = [
    "BrokerMutationAlreadyProcessed",
    "BrokerMutationDeferred",
    "BrokerMutationError",
    "BrokerMutationPreflightFailed",
    "BrokerMutationRejected",
    "BrokerMutationUnresolved",
    "BrokerMutationCoordinator",
    "InfrastructureValidationOrderSubmission",
    "LinkedOrderSubmission",
    "LinkedOrderSubmissionCallbacks",
    "UnlinkedMutationCallbacks",
]
