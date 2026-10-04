"""Fenced recovery for broker-observed orders with durable linked submissions."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import SimpleNamespace
from typing import cast

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ...models import BrokerMutationReceipt, Execution, TradeDecision
from ..alpaca_mutation_recovery import (
    ALPACA_SUBMIT_RECOVERY_READ_SCHEMA_VERSION,
    LinkedSubmissionRecoveryExecutor,
    build_alpaca_found_settlement,
)
from ..broker_mutation_receipts import (
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryHandle,
    acquire_broker_mutation_recovery,
    fingerprint_broker_endpoint,
    get_broker_mutation_receipt,
    release_broker_mutation_recovery,
    settle_linked_submission_recovery,
)
from ..broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRead,
    broker_mutation_recovery_writer_identity,
)
from ..broker_mutation_coordinator import BrokerMutationDeferred
from ..decision_submission_claims import (
    DecisionSubmissionRecoveryHandle,
    acquire_decision_submission_recovery_claim,
)
from ..firewall import OrderFirewall
from .durable_existing_order_rejection import stage_broker_rejected_decision


logger = logging.getLogger(__name__)
_RECOVERY_LEASE_SECONDS = 60
_RECOVERY_OWNER, _RECOVERY_WRITER_GENERATION = broker_mutation_recovery_writer_identity(
    "order-executor"
)


@dataclass(frozen=True, slots=True)
class DurableExistingOrderRecoveryRequest:
    executor: LinkedSubmissionRecoveryExecutor
    session: Session
    firewall: OrderFirewall
    decision_row: TradeDecision
    account_label: str
    existing_orders: Sequence[Mapping[str, object]]


@dataclass(frozen=True, slots=True)
class DurableExistingOrderRecoveryResult:
    """Whether an existing order was handled and the recovered execution, if any."""

    handled: bool
    execution: Execution | None = None


@dataclass(frozen=True, slots=True)
class _DurableRecoveryContext:
    request: DurableExistingOrderRecoveryRequest
    receipt_id: uuid.UUID
    order_response: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class _LinkedRecoveryLeases:
    receipt: BrokerMutationReceiptSnapshot
    receipt_handle: BrokerMutationRecoveryHandle
    claim_handle: DecisionSubmissionRecoveryHandle


def recover_durable_linked_existing_order(
    request: DurableExistingOrderRecoveryRequest,
) -> DurableExistingOrderRecoveryResult:
    """Settle a broker-observed linked submit or defer it to fenced recovery.

    Returns ``False`` only when no durable linked receipt exists, allowing the
    caller to retain the legacy backfill path for pre-receipt orders.
    """

    context = _resolve_recovery_context(request)
    if context is None:
        return DurableExistingOrderRecoveryResult(handled=False)
    receipt = get_broker_mutation_receipt(request.session, context.receipt_id)
    if receipt is None:  # pragma: no cover - immutable header was just observed
        raise RuntimeError("linked_submission_recovery_receipt_not_found")
    if receipt.state == "settled":
        execution = _restore_settled_recovery_state(context, receipt)
        return DurableExistingOrderRecoveryResult(
            handled=True,
            execution=execution,
        )
    if receipt.state != "broker_io":
        raise RuntimeError(
            "linked_submission_existing_order_without_broker_io:"
            f"{request.decision_row.id}:{receipt.state}"
        )
    leases = _acquire_linked_recovery_leases(context)
    execution = _settle_observed_order(context, leases)
    return DurableExistingOrderRecoveryResult(
        handled=True,
        execution=execution,
    )


def _resolve_recovery_context(
    request: DurableExistingOrderRecoveryRequest,
) -> _DurableRecoveryContext | None:
    endpoint_fingerprint = fingerprint_broker_endpoint(
        request.firewall.broker_endpoint_url
    )
    receipt_id = request.session.execute(
        select(BrokerMutationReceipt.id).where(
            BrokerMutationReceipt.submission_claim_id == request.decision_row.id,
            BrokerMutationReceipt.broker_route == "alpaca",
            BrokerMutationReceipt.operation == "submit_order",
            BrokerMutationReceipt.account_label == request.account_label,
            BrokerMutationReceipt.endpoint_fingerprint == endpoint_fingerprint,
            BrokerMutationReceipt.client_request_id
            == request.decision_row.decision_hash,
        )
    ).scalar_one_or_none()
    request.session.rollback()
    if receipt_id is None:
        foreign_receipt_id = request.session.execute(
            select(BrokerMutationReceipt.id)
            .where(
                BrokerMutationReceipt.submission_claim_id == request.decision_row.id,
                BrokerMutationReceipt.broker_route == "alpaca",
                BrokerMutationReceipt.operation == "submit_order",
                BrokerMutationReceipt.account_label == request.account_label,
                BrokerMutationReceipt.client_request_id
                == request.decision_row.decision_hash,
            )
            .limit(1)
        ).scalar_one_or_none()
        request.session.rollback()
        if foreign_receipt_id is not None:
            raise RuntimeError(
                "linked_submission_recovery_endpoint_mismatch:"
                f"{request.decision_row.id}:{endpoint_fingerprint}"
            )
        return None
    if len(request.existing_orders) != 1:
        raise RuntimeError(
            "linked_submission_recovery_existing_order_count_invalid:"
            f"{request.decision_row.id}:{len(request.existing_orders)}"
        )
    return _DurableRecoveryContext(
        request=request,
        receipt_id=receipt_id,
        order_response=request.existing_orders[0],
    )


def _restore_settled_recovery_state(
    context: _DurableRecoveryContext,
    receipt: BrokerMutationReceiptSnapshot,
) -> Execution | None:
    if receipt.settlement.outcome == "rejected":
        stage_broker_rejected_decision(
            context.request.session,
            decision_row=context.request.decision_row,
            account_label=context.request.account_label,
        )
        context.request.session.commit()
        execution = None
    else:
        execution = _load_recovered_execution(
            context.request.session,
            execution_id=receipt.settlement.execution_id,
            required=receipt.settlement.outcome in {"acknowledged", "reconciled"},
        )
    logger.info(
        "Durable linked submission already settled decision_id=%s receipt_id=%s",
        context.request.decision_row.id,
        context.receipt_id,
    )
    return execution


def _acquire_linked_recovery_leases(
    context: _DurableRecoveryContext,
) -> _LinkedRecoveryLeases:
    request = context.request
    recovery_token = uuid.uuid4()
    acquired_receipt = acquire_broker_mutation_recovery(
        request.session,
        receipt_id=context.receipt_id,
        recovery_owner=_RECOVERY_OWNER,
        writer_generation=_RECOVERY_WRITER_GENERATION,
        options=BrokerMutationRecoveryAcquireOptions(
            recovery_token=recovery_token,
            lease_seconds=_RECOVERY_LEASE_SECONDS,
        ),
    )
    if not acquired_receipt.acquired or acquired_receipt.receipt is None:
        logger.info(
            "Deferred durable linked existing-order recovery decision_id=%s "
            "receipt_id=%s outcome=%s",
            request.decision_row.id,
            context.receipt_id,
            acquired_receipt.outcome,
        )
        raise BrokerMutationDeferred(
            "linked_submission_existing_order_recovery_deferred:"
            f"{request.decision_row.id}:receipt:{acquired_receipt.outcome}"
        )
    receipt = acquired_receipt.receipt
    receipt_handle = receipt.recovery_handle
    if receipt_handle is None:  # pragma: no cover - acquired result contract
        raise RuntimeError("linked_submission_recovery_receipt_handle_missing")

    acquired_claim = acquire_decision_submission_recovery_claim(
        request.session,
        decision_id=request.decision_row.id,
        recovery_owner=_RECOVERY_OWNER,
        recovery_token=recovery_token,
        lease_seconds=_RECOVERY_LEASE_SECONDS,
    )
    if not acquired_claim.acquired or acquired_claim.claim is None:
        release_broker_mutation_recovery(request.session, handle=receipt_handle)
        logger.info(
            "Deferred durable linked existing-order recovery decision_id=%s "
            "receipt_id=%s claim_outcome=%s",
            request.decision_row.id,
            context.receipt_id,
            acquired_claim.outcome,
        )
        raise BrokerMutationDeferred(
            "linked_submission_existing_order_recovery_deferred:"
            f"{request.decision_row.id}:claim:{acquired_claim.outcome}"
        )
    claim_handle = acquired_claim.claim.recovery_handle
    if claim_handle is None:  # pragma: no cover - acquired result contract
        release_broker_mutation_recovery(request.session, handle=receipt_handle)
        raise RuntimeError("linked_submission_recovery_claim_handle_missing")
    return _LinkedRecoveryLeases(
        receipt=receipt,
        receipt_handle=receipt_handle,
        claim_handle=claim_handle,
    )


def _settle_observed_order(
    context: _DurableRecoveryContext,
    leases: _LinkedRecoveryLeases,
) -> Execution | None:
    request = context.request
    read = BrokerMutationRecoveryRead(
        outcome="found",
        broker_result=dict(context.order_response),
        evidence={
            "schema_version": ALPACA_SUBMIT_RECOVERY_READ_SCHEMA_VERSION,
            "route": "alpaca",
            "exact_client_order_lookup": "found",
            "history_status": "all",
            "history_limit": 1,
            "history_count": 0,
            "history_complete": False,
            "history_match_count": 1,
            "absence_proof_complete": False,
            "recovery_entrypoint": "order_executor_existing_order",
        },
    )
    try:
        settlement = build_alpaca_found_settlement(
            request.session,
            leases.receipt,
            read,
            executor=request.executor,
            firewall=request.firewall,
        )
        if settlement.outcome == "rejected":
            stage_broker_rejected_decision(
                request.session,
                decision_row=request.decision_row,
                account_label=request.account_label,
            )
        execution = _load_recovered_execution(
            request.session,
            execution_id=settlement.execution_id,
            required=settlement.outcome in {"acknowledged", "reconciled"},
        )
        terminal = settle_linked_submission_recovery(
            request.session,
            handle=leases.receipt_handle,
            submission_recovery_handle=leases.claim_handle,
            settlement=settlement,
        )
    except (SQLAlchemyError, TypeError, ValueError, RuntimeError):
        request.session.rollback()
        raise
    logger.info(
        "Recovered durable linked existing order decision_id=%s receipt_id=%s "
        "result=%s",
        request.decision_row.id,
        context.receipt_id,
        terminal.runtime_result,
    )
    return execution


def _load_recovered_execution(
    session: Session,
    *,
    execution_id: uuid.UUID | None,
    required: bool,
) -> Execution | None:
    if execution_id is None:
        if required:
            raise RuntimeError("linked_submission_recovery_execution_missing")
        return None
    identity_key = session.identity_key(Execution, execution_id)
    execution = session.identity_map.get(identity_key)
    if execution is not None:
        return cast(Execution, execution)

    available_columns = set(
        session.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'executions'"
            )
        ).scalars()
    )
    projection_columns = [
        column
        for column in (
            "id",
            "alpaca_order_id",
            "status",
            "filled_qty",
            "raw_order",
            "execution_audit_json",
            "execution_actual_adapter",
            "execution_expected_adapter",
            "execution_fallback_reason",
            "execution_fallback_count",
            "execution_correlation_id",
            "execution_idempotency_key",
        )
        if column in available_columns
    ]
    if "id" not in projection_columns:
        if required:
            raise RuntimeError("linked_submission_recovery_execution_schema_missing")
        return None
    row = (
        session.execute(
            text(
                f"SELECT {', '.join(projection_columns)} FROM executions "
                "WHERE id = :execution_id"
            ),
            {"execution_id": execution_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise RuntimeError("linked_submission_recovery_execution_not_found")
    payload: dict[str, object] = {
        "id": execution_id,
        "alpaca_order_id": None,
        "status": "",
        "filled_qty": None,
        "raw_order": {},
        "execution_audit_json": {},
        "execution_actual_adapter": None,
        "execution_expected_adapter": None,
        "execution_fallback_reason": None,
        "execution_fallback_count": 0,
        "execution_correlation_id": None,
        "execution_idempotency_key": None,
    }
    payload.update(dict(row))
    return cast(Execution, SimpleNamespace(**payload))


__all__ = [
    "DurableExistingOrderRecoveryRequest",
    "DurableExistingOrderRecoveryResult",
    "recover_durable_linked_existing_order",
]
