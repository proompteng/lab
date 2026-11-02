"""Durable ancestry and exclusion proof for one paper broker lifecycle."""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import cast

from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from ..models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    Execution,
    ExecutionOrderEvent,
    TigerBeetleTransferRef,
    TradeDecision,
    TradeDecisionSubmissionClaim,
)
from .broker_mutation_receipts import fingerprint_broker_endpoint
from .infrastructure_validation import (
    INFRASTRUCTURE_VALIDATION_LIFECYCLE_PLAN_SCHEMA_VERSION,
)
from .infrastructure_validation_lifecycle_broker import (
    InfrastructureValidationLifecycleContext,
)
from .infrastructure_validation_records import (
    InfrastructureValidationEvidence,
    InfrastructureValidationPositionEvidence,
    is_non_promotable_validation_event,
    load_infrastructure_validation_evidence,
    require_infrastructure_validation_flat_position_evidence,
    require_infrastructure_validation_position_evidence,
)


_EXPECTED_OPERATIONS = (
    "root_submit",
    "resting_close_submit",
    "replace_order",
    "cancel_order",
    "close_position",
    "close_all_positions",
)


@dataclass(frozen=True, slots=True)
class InfrastructureValidationLifecycleReceiptReport:
    stage: str
    receipt_id: str
    client_request_id: str
    operation: str
    state: str
    settlement_outcome: str
    broker_reference: str


@dataclass(frozen=True, slots=True)
class LifecycleOrderIds:
    root: str
    resting_close: str
    replacement_close: str
    partial_close: str
    final_flatten: str


@dataclass(frozen=True, slots=True)
class LifecycleDatabaseProof:
    receipts: tuple[InfrastructureValidationLifecycleReceiptReport, ...]
    order_event_count: int
    linked_order_event_count: int
    untagged_order_event_count: int
    submission_claim_count: int
    execution_count: int
    trade_decision_count: int
    tigerbeetle_transfer_ref_count: int


class InfrastructureValidationLifecycleProof:
    """Wait for and validate the single durable non-promotable lineage."""

    def __init__(self, context: InfrastructureValidationLifecycleContext) -> None:
        self._context = context

    def wait_lineage(
        self,
        *,
        client_order_id: str | None,
        order_id: str,
    ) -> InfrastructureValidationEvidence:
        deadline = time.monotonic() + self._context.evidence_timeout_seconds
        while time.monotonic() < deadline:
            with self._context.session_factory() as session:
                evidence = load_infrastructure_validation_evidence(
                    session,
                    account_label=self._context.configured_account_label,
                    client_order_id=client_order_id,
                    alpaca_order_id=order_id,
                    endpoint_fingerprint=fingerprint_broker_endpoint(
                        self._context.client.endpoint_url
                    ),
                )
            if evidence is not None and evidence.lineage_parent_terminal:
                if evidence.broker_order_id != order_id:
                    raise RuntimeError(
                        "infrastructure_validation_lineage_order_identity_mismatch"
                    )
                if (
                    evidence.root_plan_schema
                    != INFRASTRUCTURE_VALIDATION_LIFECYCLE_PLAN_SCHEMA_VERSION
                ):
                    raise RuntimeError(
                        "infrastructure_validation_position_ancestry_missing"
                    )
                return evidence
            time.sleep(self._context.poll_interval_seconds)
        raise RuntimeError(
            f"infrastructure_validation_lineage_evidence_timeout:order_id={order_id}"
        )

    def wait_position(
        self,
        *,
        evidence: InfrastructureValidationEvidence,
        symbol: str,
        quantity: Decimal,
        expected_order_id: str,
    ) -> InfrastructureValidationPositionEvidence:
        deadline = time.monotonic() + self._context.evidence_timeout_seconds
        latest_error = "position_fill_missing"
        while time.monotonic() < deadline:
            try:
                with self._context.session_factory() as session:
                    proof = require_infrastructure_validation_position_evidence(
                        session,
                        evidence=evidence,
                        symbol=symbol,
                        signed_quantity=quantity,
                    )
            except RuntimeError as exc:
                if not _transient_position_evidence_error(exc):
                    raise
                latest_error = str(exc)
            else:
                if proof.alpaca_order_id != expected_order_id:
                    latest_error = "position_event_order_not_current"
                else:
                    return proof
            time.sleep(self._context.poll_interval_seconds)
        raise RuntimeError(
            f"infrastructure_validation_position_evidence_timeout:{latest_error}"
        )

    def wait_flat_position(
        self,
        *,
        evidence: InfrastructureValidationEvidence,
        symbol: str,
        expected_order_id: str,
    ) -> InfrastructureValidationPositionEvidence:
        deadline = time.monotonic() + self._context.evidence_timeout_seconds
        latest_error = "position_fill_missing"
        while time.monotonic() < deadline:
            try:
                with self._context.session_factory() as session:
                    proof = require_infrastructure_validation_flat_position_evidence(
                        session,
                        evidence=evidence,
                        symbol=symbol,
                    )
            except RuntimeError as exc:
                if not _transient_position_evidence_error(exc):
                    raise
                latest_error = str(exc)
            else:
                if proof.alpaca_order_id != expected_order_id:
                    latest_error = "flat_event_order_not_current"
                else:
                    return proof
            time.sleep(self._context.poll_interval_seconds)
        raise RuntimeError(
            f"infrastructure_validation_flat_evidence_timeout:{latest_error}"
        )

    def load_database(
        self,
        *,
        root_evidence: InfrastructureValidationEvidence,
        final_evidence: InfrastructureValidationEvidence,
        orders: LifecycleOrderIds,
    ) -> LifecycleDatabaseProof:
        if root_evidence.root_receipt_id != final_evidence.root_receipt_id:
            raise RuntimeError("infrastructure_validation_lifecycle_root_split")
        with self._context.session_factory() as session:
            root = session.get(
                BrokerMutationReceipt,
                final_evidence.root_receipt_id,
            )
            if root is None:
                raise RuntimeError("infrastructure_validation_lineage_root_missing")
            scoped_receipts = session.execute(
                select(BrokerMutationReceipt)
                .where(
                    BrokerMutationReceipt.account_label == root.account_label,
                    BrokerMutationReceipt.endpoint_fingerprint
                    == root.endpoint_fingerprint,
                    BrokerMutationReceipt.created_at
                    >= root.created_at - timedelta(seconds=1),
                )
                .order_by(
                    BrokerMutationReceipt.created_at,
                    BrokerMutationReceipt.id,
                )
            ).scalars()
            receipts = tuple(
                receipt
                for receipt in scoped_receipts
                if _receipt_belongs_to_root(receipt, root.id)
            )
            receipt_reports, client_request_ids = _prove_receipt_chain(
                session,
                root=root,
                receipts=receipts,
                orders=orders,
            )
            exclusion = _prove_evidence_exclusion(
                session,
                root=root,
                client_request_ids=client_request_ids,
                orders=orders,
            )
        return LifecycleDatabaseProof(
            receipts=receipt_reports,
            order_event_count=exclusion.order_event_count,
            linked_order_event_count=exclusion.linked_order_event_count,
            untagged_order_event_count=exclusion.untagged_order_event_count,
            submission_claim_count=exclusion.submission_claim_count,
            execution_count=exclusion.execution_count,
            trade_decision_count=exclusion.trade_decision_count,
            tigerbeetle_transfer_ref_count=(exclusion.tigerbeetle_transfer_ref_count),
        )


def _transient_position_evidence_error(error: RuntimeError) -> bool:
    return str(error) in {
        "infrastructure_validation_position_fill_missing",
        "infrastructure_validation_position_not_reconciled",
    }


def _receipt_belongs_to_root(
    receipt: BrokerMutationReceipt,
    root_receipt_id: object,
) -> bool:
    if receipt.id == root_receipt_id:
        return True
    try:
        request = _intent_request(receipt)
        lineage = _object(request.get("infrastructure_validation_lineage"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return False
    return lineage.get("root_receipt_id") == str(root_receipt_id)


def _prove_receipt_chain(
    session: Session,
    *,
    root: BrokerMutationReceipt,
    receipts: tuple[BrokerMutationReceipt, ...],
    orders: LifecycleOrderIds,
) -> tuple[
    tuple[InfrastructureValidationLifecycleReceiptReport, ...],
    tuple[str, ...],
]:
    if len(receipts) != len(_EXPECTED_OPERATIONS):
        raise RuntimeError(
            "infrastructure_validation_lifecycle_receipt_count_invalid:"
            f"expected={len(_EXPECTED_OPERATIONS)}:actual={len(receipts)}"
        )
    by_stage: dict[str, BrokerMutationReceipt] = {}
    for receipt in receipts:
        stage = _receipt_stage(receipt, root.id)
        if stage in by_stage:
            raise RuntimeError(
                f"infrastructure_validation_lifecycle_duplicate_stage:{stage}"
            )
        by_stage[stage] = receipt
    if any(stage not in by_stage for stage in _EXPECTED_OPERATIONS):
        raise RuntimeError("infrastructure_validation_lifecycle_receipt_stage_missing")
    expected_parents = {
        "resting_close_submit": by_stage["root_submit"].id,
        "replace_order": by_stage["resting_close_submit"].id,
        "cancel_order": by_stage["replace_order"].id,
        "close_position": by_stage["replace_order"].id,
        "close_all_positions": by_stage["close_position"].id,
    }
    expected_references = {
        "root_submit": orders.root,
        "resting_close_submit": orders.resting_close,
        "replace_order": orders.replacement_close,
        "close_position": orders.partial_close,
        "close_all_positions": orders.final_flatten,
    }
    reports: list[InfrastructureValidationLifecycleReceiptReport] = []
    for stage in _EXPECTED_OPERATIONS:
        receipt = by_stage[stage]
        if stage == "root_submit":
            validation = _object(
                _intent_request(receipt).get("infrastructure_validation")
            )
            permit = _object(validation.get("permit"))
            if (
                permit.get("evidence_tag") != "non_promotable_validation"
                or permit.get("promotable") is not False
            ):
                raise RuntimeError(
                    "infrastructure_validation_lifecycle_root_promotable"
                )
        else:
            lineage = _object(
                _intent_request(receipt).get("infrastructure_validation_lineage")
            )
            if (
                lineage.get("parent_receipt_id") != str(expected_parents[stage])
                or lineage.get("root_receipt_id") != str(root.id)
                or lineage.get("promotable") is not False
                or lineage.get("evidence_tag") != "non_promotable_validation"
            ):
                raise RuntimeError(
                    f"infrastructure_validation_lifecycle_parent_invalid:{stage}"
                )
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one_or_none()
        if (
            latest is None
            or latest.state != "settled"
            or latest.settlement_outcome not in {"acknowledged", "reconciled"}
            or not str(latest.broker_reference or "").strip()
        ):
            raise RuntimeError(
                f"infrastructure_validation_lifecycle_receipt_not_terminal:{stage}"
            )
        expected_reference = expected_references.get(stage)
        if (
            expected_reference is not None
            and latest.broker_reference != expected_reference
        ):
            raise RuntimeError(
                f"infrastructure_validation_lifecycle_reference_mismatch:{stage}"
            )
        reports.append(
            InfrastructureValidationLifecycleReceiptReport(
                stage=stage,
                receipt_id=str(receipt.id),
                client_request_id=receipt.client_request_id,
                operation=receipt.operation,
                state=latest.state,
                settlement_outcome=latest.settlement_outcome,
                broker_reference=cast(str, latest.broker_reference),
            )
        )
    return tuple(reports), tuple(
        by_stage[stage].client_request_id for stage in _EXPECTED_OPERATIONS
    )


def _receipt_stage(receipt: BrokerMutationReceipt, root_id: object) -> str:
    if receipt.id == root_id:
        if (
            receipt.operation == "submit_order"
            and receipt.risk_class == "risk_neutral"
            and receipt.purpose == "control_plane_validation"
        ):
            return "root_submit"
        raise RuntimeError("infrastructure_validation_lifecycle_root_contract_invalid")
    stage = {
        ("submit_order", "risk_reducing", "closeout"): "resting_close_submit",
        ("replace_order", "risk_neutral", "repricing"): "replace_order",
        ("cancel_order", "risk_neutral", "operator"): "cancel_order",
        ("close_position", "risk_reducing", "closeout"): "close_position",
        ("close_all_positions", "risk_reducing", "flatten"): ("close_all_positions"),
    }.get((receipt.operation, receipt.risk_class, receipt.purpose))
    if stage is None:
        raise RuntimeError(
            "infrastructure_validation_lifecycle_receipt_contract_invalid:"
            f"{receipt.operation}:{receipt.risk_class}:{receipt.purpose}"
        )
    return stage


def _prove_evidence_exclusion(
    session: Session,
    *,
    root: BrokerMutationReceipt,
    client_request_ids: tuple[str, ...],
    orders: LifecycleOrderIds,
) -> LifecycleDatabaseProof:
    order_ids = (
        orders.root,
        orders.resting_close,
        orders.replacement_close,
        orders.partial_close,
        orders.final_flatten,
    )
    submission_claim_count = _count(
        session,
        select(func.count())
        .select_from(TradeDecisionSubmissionClaim)
        .where(TradeDecisionSubmissionClaim.client_order_id.in_(client_request_ids)),
    )
    execution_count = _count(
        session,
        select(func.count())
        .select_from(Execution)
        .where(
            or_(
                Execution.client_order_id.in_(client_request_ids),
                Execution.alpaca_order_id.in_(order_ids),
            )
        ),
    )
    trade_decision_count = _count(
        session,
        select(func.count())
        .select_from(TradeDecision)
        .where(TradeDecision.decision_hash.in_(client_request_ids)),
    )
    events = tuple(
        session.execute(
            select(ExecutionOrderEvent).where(
                ExecutionOrderEvent.alpaca_account_label == root.account_label,
                ExecutionOrderEvent.created_at
                >= root.created_at - timedelta(seconds=1),
            )
        ).scalars()
    )
    if not events:
        raise RuntimeError("infrastructure_validation_lifecycle_order_events_missing")
    relevant_events = tuple(
        event
        for event in events
        if event.alpaca_order_id in order_ids
        or event.client_order_id in client_request_ids
        or _event_root_receipt_id(event) == str(root.id)
    )
    if len(relevant_events) != len(events):
        raise RuntimeError("infrastructure_validation_lifecycle_account_contaminated")
    linked_count = sum(
        1
        for event in relevant_events
        if event.execution_id is not None or event.trade_decision_id is not None
    )
    untagged_count = sum(
        1
        for event in relevant_events
        if not is_non_promotable_validation_event(event.raw_event)
        or _event_root_receipt_id(event) != str(root.id)
    )
    event_ids = tuple(event.id for event in relevant_events)
    tigerbeetle_count = _count(
        session,
        select(func.count())
        .select_from(TigerBeetleTransferRef)
        .where(TigerBeetleTransferRef.execution_order_event_id.in_(event_ids)),
    )
    if any(
        (
            submission_claim_count,
            execution_count,
            trade_decision_count,
            linked_count,
            untagged_count,
            tigerbeetle_count,
        )
    ):
        raise RuntimeError("infrastructure_validation_lifecycle_evidence_leak")
    return LifecycleDatabaseProof(
        receipts=(),
        order_event_count=len(relevant_events),
        linked_order_event_count=linked_count,
        untagged_order_event_count=untagged_count,
        submission_claim_count=submission_claim_count,
        execution_count=execution_count,
        trade_decision_count=trade_decision_count,
        tigerbeetle_transfer_ref_count=tigerbeetle_count,
    )


def _event_root_receipt_id(event: ExecutionOrderEvent) -> str | None:
    raw = event.raw_event
    if not isinstance(raw, Mapping):
        return None
    marker = cast(Mapping[object, object], raw).get("_torghut_evidence_contract")
    if not isinstance(marker, Mapping):
        return None
    return (
        str(
            cast(Mapping[object, object], marker).get("validation_root_receipt_id")
            or ""
        )
        or None
    )


def _intent_request(receipt: BrokerMutationReceipt) -> dict[str, object]:
    payload = json.loads(receipt.canonical_intent_json)
    intent = _object(payload)
    return _object(intent.get("request"))


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError("infrastructure_validation_json_object_required")
    return {
        str(key): item for key, item in cast(Mapping[object, object], value).items()
    }


def _count(session: Session, statement: Select[tuple[int]]) -> int:
    return int(session.scalar(statement) or 0)


__all__ = [
    "InfrastructureValidationLifecycleProof",
    "InfrastructureValidationLifecycleReceiptReport",
    "LifecycleDatabaseProof",
    "LifecycleOrderIds",
]
