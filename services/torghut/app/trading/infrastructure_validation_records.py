"""Database-backed exclusion contract for infrastructure-validation events."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    ExecutionOrderEvent,
    coerce_json_payload,
)
from .evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from .infrastructure_validation import (
    is_infrastructure_validation_lifecycle_plan_schema,
)


_EVIDENCE_KEY = "_torghut_evidence_contract"
_EVIDENCE_SCHEMA_VERSION = "torghut.order-event-evidence-contract.v1"
_EVIDENCE_TAG = ArtifactProvenance.NON_PROMOTABLE_VALIDATION.value
_EVIDENCE_SEAL = object()
_LINEAGE_SCHEMA_VERSION = "torghut.infrastructure-validation-lineage.v1"
_ORDER_CREATING_LINEAGE_OPERATIONS = (
    "submit_order",
    "replace_order",
    "close_position",
    "close_all_positions",
)
_LINEAGE_KEYS = frozenset(
    {
        "schema_version",
        "root_receipt_id",
        "root_client_order_id",
        "parent_receipt_id",
        "parent_broker_order_id",
        "permit_id",
        "permit_sha256",
        "evidence_tag",
        "promotable",
    }
)


class InfrastructureValidationLineagePending(RuntimeError):
    """An order event may belong to a validation descendant still in broker I/O."""


@dataclass(frozen=True, slots=True)
class InfrastructureValidationEvidence:
    """Database-proven validation ancestry for one broker mutation."""

    receipt_id: uuid.UUID
    broker_order_id: str
    root_receipt_id: uuid.UUID
    root_client_order_id: str
    root_plan_schema: str
    permit_id: str
    permit_sha256: str
    account_label: str
    endpoint_fingerprint: str
    lineage_parent_terminal: bool
    _seal: object = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if self._seal is not _EVIDENCE_SEAL:
            raise PermissionError("infrastructure_validation_evidence_issuer_invalid")


@dataclass(frozen=True, slots=True)
class InfrastructureValidationPositionEvidence:
    """Latest tagged broker fill reconciled to one observed paper position."""

    lineage: InfrastructureValidationEvidence
    order_event_id: uuid.UUID
    alpaca_order_id: str
    symbol: str
    filled_quantity: Decimal
    position_quantity: Decimal
    average_fill_price: Decimal
    _seal: object = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if self._seal is not _EVIDENCE_SEAL:
            raise PermissionError("infrastructure_validation_evidence_issuer_invalid")


@dataclass(frozen=True, slots=True)
class _ValidationLineage:
    root_receipt_id: uuid.UUID
    root_client_order_id: str
    parent_receipt_id: uuid.UUID
    parent_broker_order_id: str
    permit_id: str
    permit_sha256: str


def load_infrastructure_validation_evidence(
    session: Session,
    *,
    account_label: str,
    client_order_id: str | None,
    alpaca_order_id: str | None = None,
    endpoint_fingerprint: str | None = None,
) -> InfrastructureValidationEvidence | None:
    """Resolve broker client/order identities to immutable validation ancestry."""

    normalized_client_order_id = str(client_order_id or "").strip()
    normalized_order_id = str(alpaca_order_id or "").strip()
    normalized_endpoint = str(endpoint_fingerprint or "").strip()
    evidence: list[InfrastructureValidationEvidence] = []
    if normalized_client_order_id.startswith("ivp-"):
        root_receipts = _root_receipts(
            session,
            account_label=account_label,
            client_order_id=normalized_client_order_id,
            endpoint_fingerprint=normalized_endpoint,
        )
        for receipt in root_receipts:
            root_evidence = _root_evidence(
                session,
                receipt,
                expected_client_order_id=normalized_client_order_id,
                observed_broker_order_id=normalized_order_id,
            )
            if root_evidence is not None:
                evidence.append(root_evidence)
    if normalized_order_id:
        descendant_receipts = _descendant_receipts(
            session,
            account_label=account_label,
            alpaca_order_id=normalized_order_id,
            endpoint_fingerprint=normalized_endpoint,
        )
        if len(descendant_receipts) > 1:
            raise RuntimeError("infrastructure_validation_lineage_parent_split")
        evidence.extend(
            _descendant_evidence(session, receipt) for receipt in descendant_receipts
        )
    if not evidence:
        return None
    roots = {
        (
            item.root_receipt_id,
            item.root_client_order_id,
            item.root_plan_schema,
            item.permit_id,
            item.permit_sha256,
        )
        for item in evidence
    }
    if len(roots) != 1:
        raise RuntimeError("infrastructure_validation_receipt_identity_split")
    # Prefer the receipt that created the observed broker order. Root client-ID
    # evidence remains the fallback for cancel/reject events on the setup order.
    return evidence[-1]


def defer_pending_infrastructure_validation_descendant(
    session: Session,
    *,
    account_label: str,
    symbol: str | None,
) -> None:
    """Fail closed until an order-creating validation descendant is settled."""

    normalized_symbol = str(symbol or "").strip().upper()
    if not normalized_symbol:
        return
    for receipt in _pending_descendant_receipts(
        session,
        account_label=account_label,
    ):
        _intent, _lineage, root = _validated_descendant_ancestry(session, receipt)
        if _root_symbol(root) != normalized_symbol:
            continue
        raise InfrastructureValidationLineagePending(
            "infrastructure_validation_descendant_lineage_pending:"
            f"{receipt.id}:{normalized_symbol}"
        )


def infrastructure_validation_lineage_payload(
    evidence: InfrastructureValidationEvidence,
) -> dict[str, object]:
    """Build the exact parent proof sealed into a descendant mutation intent."""

    if not evidence.lineage_parent_terminal:
        raise RuntimeError("infrastructure_validation_lineage_parent_not_terminal")
    return {
        "schema_version": _LINEAGE_SCHEMA_VERSION,
        "root_receipt_id": str(evidence.root_receipt_id),
        "root_client_order_id": evidence.root_client_order_id,
        "parent_receipt_id": str(evidence.receipt_id),
        "parent_broker_order_id": evidence.broker_order_id,
        "permit_id": evidence.permit_id,
        "permit_sha256": evidence.permit_sha256,
        "evidence_tag": _EVIDENCE_TAG,
        "promotable": False,
    }


def require_infrastructure_validation_position_evidence(
    session: Session,
    *,
    evidence: InfrastructureValidationEvidence,
    symbol: str,
    signed_quantity: Decimal,
) -> InfrastructureValidationPositionEvidence:
    """Match a fresh broker position to the latest persisted tagged fill."""

    observed_quantity = Decimal(signed_quantity)
    if not observed_quantity.is_finite() or observed_quantity <= 0:
        raise RuntimeError("infrastructure_validation_position_observation_invalid")
    return _require_infrastructure_validation_position_event(
        session,
        evidence=evidence,
        symbol=symbol,
        expected_position_quantity=observed_quantity,
        require_positive_position=True,
    )


def require_infrastructure_validation_flat_position_evidence(
    session: Session,
    *,
    evidence: InfrastructureValidationEvidence,
    symbol: str,
) -> InfrastructureValidationPositionEvidence:
    """Prove that a tagged lifecycle fill left the validation symbol flat."""

    return _require_infrastructure_validation_position_event(
        session,
        evidence=evidence,
        symbol=symbol,
        expected_position_quantity=Decimal("0"),
        require_positive_position=False,
    )


def _require_infrastructure_validation_position_event(
    session: Session,
    *,
    evidence: InfrastructureValidationEvidence,
    symbol: str,
    expected_position_quantity: Decimal,
    require_positive_position: bool,
) -> InfrastructureValidationPositionEvidence:
    if not is_infrastructure_validation_lifecycle_plan_schema(
        evidence.root_plan_schema
    ):
        raise RuntimeError("infrastructure_validation_position_ancestry_missing")
    normalized_symbol = symbol.strip().upper()
    if not normalized_symbol:
        raise RuntimeError("infrastructure_validation_position_observation_invalid")
    root = session.get(BrokerMutationReceipt, evidence.root_receipt_id)
    if root is None or _root_symbol(root) != normalized_symbol:
        raise RuntimeError("infrastructure_validation_position_symbol_mismatch")
    events = (
        session.execute(
            select(ExecutionOrderEvent)
            .where(
                ExecutionOrderEvent.alpaca_account_label == evidence.account_label,
                ExecutionOrderEvent.symbol == normalized_symbol,
                ExecutionOrderEvent.event_type.in_(("fill", "partial_fill")),
                ExecutionOrderEvent.position_qty.is_not(None),
                ExecutionOrderEvent.execution_id.is_(None),
                ExecutionOrderEvent.trade_decision_id.is_(None),
            )
            .order_by(
                ExecutionOrderEvent.event_ts.desc().nullslast(),
                ExecutionOrderEvent.created_at.desc(),
                ExecutionOrderEvent.id.desc(),
            )
        )
        .scalars()
        .all()
    )
    event = next(
        (
            item
            for item in events
            if _event_matches_validation_root(session, item, evidence=evidence)
        ),
        None,
    )
    if event is None:
        raise RuntimeError("infrastructure_validation_position_fill_missing")
    filled_quantity = _positive_event_decimal(
        event.filled_qty,
        field="filled_quantity",
    )
    average_fill_price = _positive_event_decimal(
        event.avg_fill_price,
        field="average_fill_price",
    )
    position_quantity = _event_decimal(
        event.position_qty,
        field="position_quantity",
    )
    if require_positive_position and position_quantity <= 0:
        raise RuntimeError("infrastructure_validation_position_quantity_invalid")
    if position_quantity != expected_position_quantity:
        raise RuntimeError("infrastructure_validation_position_not_reconciled")
    alpaca_order_id = str(event.alpaca_order_id or "").strip()
    if not alpaca_order_id:
        raise RuntimeError("infrastructure_validation_position_order_missing")
    return InfrastructureValidationPositionEvidence(
        lineage=evidence,
        order_event_id=event.id,
        alpaca_order_id=alpaca_order_id,
        symbol=normalized_symbol,
        filled_quantity=filled_quantity,
        position_quantity=position_quantity,
        average_fill_price=average_fill_price,
        _seal=_EVIDENCE_SEAL,
    )


def _root_receipts(
    session: Session,
    *,
    account_label: str,
    client_order_id: str,
    endpoint_fingerprint: str,
) -> list[BrokerMutationReceipt]:
    statement = select(BrokerMutationReceipt).where(
        BrokerMutationReceipt.account_label == account_label,
        BrokerMutationReceipt.client_request_id == client_order_id,
        BrokerMutationReceipt.purpose == "control_plane_validation",
    )
    if endpoint_fingerprint:
        statement = statement.where(
            BrokerMutationReceipt.endpoint_fingerprint == endpoint_fingerprint
        )
    receipts = session.execute(statement).scalars().all()
    if len(receipts) > 1:
        raise RuntimeError("infrastructure_validation_receipt_identity_split")
    return list(receipts)


def _descendant_receipts(
    session: Session,
    *,
    account_label: str,
    alpaca_order_id: str,
    endpoint_fingerprint: str,
) -> list[BrokerMutationReceipt]:
    statement = (
        select(BrokerMutationReceipt)
        .join(
            BrokerMutationReceiptEvent,
            BrokerMutationReceiptEvent.receipt_id == BrokerMutationReceipt.id,
        )
        .where(
            BrokerMutationReceipt.account_label == account_label,
            BrokerMutationReceipt.broker_route == "alpaca",
            BrokerMutationReceipt.operation.in_(_ORDER_CREATING_LINEAGE_OPERATIONS),
            BrokerMutationReceiptEvent.state == "settled",
            BrokerMutationReceiptEvent.broker_reference == alpaca_order_id,
        )
        .distinct()
    )
    if endpoint_fingerprint:
        statement = statement.where(
            BrokerMutationReceipt.endpoint_fingerprint == endpoint_fingerprint
        )
    return [
        receipt
        for receipt in session.execute(statement).scalars().all()
        if _has_validation_lineage(receipt)
    ]


def _pending_descendant_receipts(
    session: Session,
    *,
    account_label: str,
) -> list[BrokerMutationReceipt]:
    latest = (
        select(
            BrokerMutationReceiptEvent.receipt_id.label("receipt_id"),
            func.max(BrokerMutationReceiptEvent.sequence_no).label("sequence_no"),
        )
        .group_by(BrokerMutationReceiptEvent.receipt_id)
        .subquery()
    )
    statement = (
        select(BrokerMutationReceipt)
        .join(latest, BrokerMutationReceipt.id == latest.c.receipt_id)
        .join(
            BrokerMutationReceiptEvent,
            (BrokerMutationReceiptEvent.receipt_id == latest.c.receipt_id)
            & (BrokerMutationReceiptEvent.sequence_no == latest.c.sequence_no),
        )
        .where(
            BrokerMutationReceipt.account_label == account_label,
            BrokerMutationReceipt.broker_route == "alpaca",
            BrokerMutationReceipt.operation.in_(_ORDER_CREATING_LINEAGE_OPERATIONS),
            BrokerMutationReceiptEvent.state == "broker_io",
        )
    )
    return [
        receipt
        for receipt in session.execute(statement).scalars().all()
        if _has_validation_lineage(receipt)
    ]


def _has_validation_lineage(receipt: BrokerMutationReceipt) -> bool:
    try:
        intent = _parse_json_object(receipt.canonical_intent_json)
        request = _required_object(intent, "request")
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False
    return "infrastructure_validation_lineage" in request


def _root_evidence(
    session: Session,
    receipt: BrokerMutationReceipt,
    *,
    expected_client_order_id: str,
    observed_broker_order_id: str,
) -> InfrastructureValidationEvidence | None:
    permit_id, permit_sha256 = _root_permit_identity(receipt)
    if receipt.client_request_id != expected_client_order_id:
        raise RuntimeError("infrastructure_validation_receipt_identity_split")
    terminal = _lineage_parent_terminal(
        session,
        receipt.id,
        allowed_outcomes=frozenset({"acknowledged", "reconciled"}),
    )
    broker_order_id = (
        _required_broker_reference(terminal)
        if terminal is not None
        else observed_broker_order_id
    )
    if not broker_order_id:
        return None
    return InfrastructureValidationEvidence(
        receipt_id=receipt.id,
        broker_order_id=broker_order_id,
        root_receipt_id=receipt.id,
        root_client_order_id=receipt.client_request_id,
        root_plan_schema=_root_plan_schema(receipt),
        permit_id=permit_id,
        permit_sha256=permit_sha256,
        account_label=receipt.account_label,
        endpoint_fingerprint=receipt.endpoint_fingerprint,
        lineage_parent_terminal=terminal is not None,
        _seal=_EVIDENCE_SEAL,
    )


def _descendant_evidence(
    session: Session,
    receipt: BrokerMutationReceipt,
) -> InfrastructureValidationEvidence:
    _intent, lineage, root = _validated_descendant_ancestry(session, receipt)
    terminal = _require_lineage_parent_terminal(
        session,
        receipt.id,
        allowed_outcomes=frozenset({"acknowledged", "reconciled"}),
    )
    return InfrastructureValidationEvidence(
        receipt_id=receipt.id,
        broker_order_id=_required_broker_reference(terminal),
        root_receipt_id=lineage.root_receipt_id,
        root_client_order_id=lineage.root_client_order_id,
        root_plan_schema=_root_plan_schema(root),
        permit_id=lineage.permit_id,
        permit_sha256=lineage.permit_sha256,
        account_label=receipt.account_label,
        endpoint_fingerprint=receipt.endpoint_fingerprint,
        lineage_parent_terminal=True,
        _seal=_EVIDENCE_SEAL,
    )


def _validated_descendant_ancestry(
    session: Session,
    receipt: BrokerMutationReceipt,
) -> tuple[dict[str, object], _ValidationLineage, BrokerMutationReceipt]:
    intent, lineage = _parse_validation_lineage(receipt)
    root = session.get(BrokerMutationReceipt, lineage.root_receipt_id)
    if root is None:
        raise RuntimeError("infrastructure_validation_lineage_root_missing")
    root_permit = _root_permit_identity(root)
    if (
        root.account_label != receipt.account_label
        or root.endpoint_fingerprint != receipt.endpoint_fingerprint
        or root.client_request_id != lineage.root_client_order_id
        or root_permit != (lineage.permit_id, lineage.permit_sha256)
    ):
        raise RuntimeError("infrastructure_validation_lineage_root_mismatch")
    _require_lineage_parent_terminal(
        session,
        root.id,
        allowed_outcomes=frozenset({"acknowledged", "reconciled"}),
    )
    parent = session.get(BrokerMutationReceipt, lineage.parent_receipt_id)
    if parent is None:
        raise RuntimeError("infrastructure_validation_lineage_parent_missing")
    if (
        parent.account_label != receipt.account_label
        or parent.endpoint_fingerprint != receipt.endpoint_fingerprint
        or _utc(parent.created_at) > _utc(receipt.created_at)
        or parent.operation not in _ORDER_CREATING_LINEAGE_OPERATIONS
        or not _belongs_to_validation_root(parent, lineage.root_receipt_id)
    ):
        raise RuntimeError("infrastructure_validation_lineage_parent_mismatch")
    parent_terminal = _require_lineage_parent_terminal(
        session,
        parent.id,
        allowed_outcomes=frozenset({"acknowledged", "reconciled"}),
    )
    if _required_broker_reference(parent_terminal) != lineage.parent_broker_order_id:
        raise RuntimeError("infrastructure_validation_lineage_parent_mismatch")
    _require_lineage_target(
        receipt,
        intent=intent,
        root=root,
        parent_broker_order_id=lineage.parent_broker_order_id,
    )
    return intent, lineage, root


def _parse_validation_lineage(
    receipt: BrokerMutationReceipt,
) -> tuple[dict[str, object], _ValidationLineage]:
    try:
        intent = _parse_json_object(receipt.canonical_intent_json)
        request = _required_object(intent, "request")
        raw = _required_object(request, "infrastructure_validation_lineage")
        if frozenset(raw) != _LINEAGE_KEYS:
            raise ValueError("validation_lineage_shape_invalid")
        lineage = _ValidationLineage(
            root_receipt_id=uuid.UUID(str(raw["root_receipt_id"])),
            root_client_order_id=str(raw["root_client_order_id"]).strip(),
            parent_receipt_id=uuid.UUID(str(raw["parent_receipt_id"])),
            parent_broker_order_id=str(raw["parent_broker_order_id"]).strip(),
            permit_id=str(raw["permit_id"]).strip(),
            permit_sha256=str(raw["permit_sha256"]).strip(),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "infrastructure_validation_receipt_evidence_invalid"
        ) from exc
    if (
        raw["schema_version"] != _LINEAGE_SCHEMA_VERSION
        or re.fullmatch(r"ivp-[0-9a-f]{44}", lineage.root_client_order_id) is None
        or not lineage.parent_broker_order_id
        or not lineage.permit_id
        or re.fullmatch(r"[0-9a-f]{64}", lineage.permit_sha256) is None
        or raw["evidence_tag"] != _EVIDENCE_TAG
        or raw["promotable"] is not False
    ):
        raise RuntimeError("infrastructure_validation_receipt_evidence_invalid")
    return intent, lineage


def _root_permit_identity(receipt: BrokerMutationReceipt) -> tuple[str, str]:
    try:
        intent = _parse_json_object(receipt.canonical_intent_json)
        request = _required_object(intent, "request")
        validation = _required_object(request, "infrastructure_validation")
        permit = _required_object(validation, "permit")
        permit_id = str(permit["permit_id"]).strip()
        permit_sha256 = str(validation["permit_sha256"]).strip()
        evidence_tag = permit["evidence_tag"]
        promotable = permit["promotable"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "infrastructure_validation_receipt_evidence_invalid"
        ) from exc
    if (
        receipt.purpose != "control_plane_validation"
        or receipt.operation != "submit_order"
        or re.fullmatch(r"ivp-[0-9a-f]{44}", receipt.client_request_id) is None
        or not permit_id
        or re.fullmatch(r"[0-9a-f]{64}", permit_sha256) is None
        or evidence_tag != _EVIDENCE_TAG
        or promotable is not False
    ):
        raise RuntimeError("infrastructure_validation_receipt_evidence_invalid")
    return permit_id, permit_sha256


def _root_plan_schema(receipt: BrokerMutationReceipt) -> str:
    try:
        intent = _parse_json_object(receipt.canonical_intent_json)
        request = _required_object(intent, "request")
        validation = _required_object(request, "infrastructure_validation")
        test_plan = _required_object(validation, "test_plan")
        schema_version = str(test_plan["schema_version"]).strip()
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "infrastructure_validation_receipt_evidence_invalid"
        ) from exc
    if not schema_version:
        raise RuntimeError("infrastructure_validation_receipt_evidence_invalid")
    return schema_version


def _root_symbol(receipt: BrokerMutationReceipt) -> str:
    try:
        intent = _parse_json_object(receipt.canonical_intent_json)
        request = _required_object(intent, "request")
        validation = _required_object(request, "infrastructure_validation")
        test_plan = _required_object(validation, "test_plan")
        symbol = str(test_plan["symbol"]).strip().upper()
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "infrastructure_validation_receipt_evidence_invalid"
        ) from exc
    if not symbol:
        raise RuntimeError("infrastructure_validation_receipt_evidence_invalid")
    return symbol


def _belongs_to_validation_root(
    receipt: BrokerMutationReceipt,
    root_receipt_id: uuid.UUID,
) -> bool:
    if receipt.id == root_receipt_id:
        return True
    try:
        intent = _parse_json_object(receipt.canonical_intent_json)
        request = _required_object(intent, "request")
        lineage = _required_object(request, "infrastructure_validation_lineage")
        lineage_root = uuid.UUID(str(lineage["root_receipt_id"]))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False
    return lineage_root == root_receipt_id


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _require_lineage_target(
    receipt: BrokerMutationReceipt,
    *,
    intent: Mapping[str, object],
    root: BrokerMutationReceipt,
    parent_broker_order_id: str,
) -> None:
    try:
        request = _required_object(intent, "request")
        root_intent = _parse_json_object(root.canonical_intent_json)
        root_request = _required_object(root_intent, "request")
        validation = _required_object(root_request, "infrastructure_validation")
        test_plan = _required_object(validation, "test_plan")
        root_symbol = str(test_plan["symbol"]).strip()
        root_plan_schema = str(test_plan["schema_version"]).strip()
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "infrastructure_validation_receipt_evidence_invalid"
        ) from exc
    lifecycle_root = is_infrastructure_validation_lifecycle_plan_schema(
        root_plan_schema
    )
    target_matches = {
        "submit_order": lifecycle_root
        and receipt.target_key == root_symbol
        and request.get("symbol") == root_symbol,
        "replace_order": receipt.target_key == parent_broker_order_id,
        "cancel_order": receipt.target_key == parent_broker_order_id,
        "close_position": lifecycle_root and receipt.target_key == root_symbol,
        "close_all_positions": lifecycle_root
        and request.get("symbols") == [root_symbol],
    }.get(receipt.operation, False)
    if not target_matches:
        raise RuntimeError("infrastructure_validation_lineage_target_mismatch")


def _require_lineage_parent_terminal(
    session: Session,
    receipt_id: uuid.UUID,
    *,
    allowed_outcomes: frozenset[str],
) -> BrokerMutationReceiptEvent:
    latest = _lineage_parent_terminal(
        session,
        receipt_id,
        allowed_outcomes=allowed_outcomes,
    )
    if latest is None:
        raise RuntimeError("infrastructure_validation_lineage_parent_not_terminal")
    return latest


def _lineage_parent_terminal(
    session: Session,
    receipt_id: uuid.UUID,
    *,
    allowed_outcomes: frozenset[str],
) -> BrokerMutationReceiptEvent | None:
    latest = session.execute(
        select(BrokerMutationReceiptEvent)
        .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
        .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
        .limit(1)
    ).scalar_one_or_none()
    if (
        latest is None
        or latest.state != "settled"
        or latest.settlement_outcome not in allowed_outcomes
    ):
        return None
    return latest


def _required_broker_reference(event: BrokerMutationReceiptEvent) -> str:
    broker_reference = str(event.broker_reference or "").strip()
    if not broker_reference:
        raise RuntimeError("infrastructure_validation_lineage_parent_reference_missing")
    return broker_reference


def _parse_json_object(raw_document: str) -> dict[str, object]:
    raw_value: object = json.loads(raw_document)
    return _object_mapping(raw_value)


def _required_object(
    document: Mapping[str, object],
    key: str,
) -> dict[str, object]:
    return _object_mapping(document[key])


def _object_mapping(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError("infrastructure_validation_json_object_required")
    return {
        str(key): item for key, item in cast(Mapping[object, object], value).items()
    }


def _event_matches_validation_root(
    session: Session,
    event: ExecutionOrderEvent,
    *,
    evidence: InfrastructureValidationEvidence,
) -> bool:
    raw = coerce_json_payload(event.raw_event)
    marker = (
        cast(Mapping[object, object], raw).get(_EVIDENCE_KEY)
        if isinstance(raw, Mapping)
        else None
    )
    if not isinstance(marker, Mapping):
        return False
    values = cast(Mapping[object, object], marker)
    if not (
        is_non_promotable_validation_event(cast(Mapping[object, object], raw))
        and values.get("validation_root_receipt_id") == str(evidence.root_receipt_id)
        and values.get("validation_root_client_order_id")
        == evidence.root_client_order_id
        and values.get("permit_id") == evidence.permit_id
        and values.get("permit_sha256") == evidence.permit_sha256
    ):
        return False
    try:
        receipt_id = uuid.UUID(str(values.get("broker_mutation_receipt_id") or ""))
    except ValueError:
        return False
    receipt = session.get(BrokerMutationReceipt, receipt_id)
    if receipt is None:
        return False
    try:
        receipt_evidence = (
            _root_evidence(
                session,
                receipt,
                expected_client_order_id=evidence.root_client_order_id,
                observed_broker_order_id=str(event.alpaca_order_id or ""),
            )
            if receipt.id == evidence.root_receipt_id
            else _descendant_evidence(session, receipt)
        )
    except RuntimeError:
        return False
    return (
        receipt_evidence is not None
        and receipt_evidence.receipt_id == receipt_id
        and receipt_evidence.root_receipt_id == evidence.root_receipt_id
        and receipt_evidence.root_client_order_id == evidence.root_client_order_id
        and receipt_evidence.permit_id == evidence.permit_id
        and receipt_evidence.permit_sha256 == evidence.permit_sha256
        and receipt_evidence.account_label == evidence.account_label
        and receipt_evidence.endpoint_fingerprint == evidence.endpoint_fingerprint
        and receipt_evidence.broker_order_id == str(event.alpaca_order_id or "")
    )


def _event_decimal(value: object, *, field: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise RuntimeError(f"infrastructure_validation_{field}_invalid") from exc
    if not parsed.is_finite():
        raise RuntimeError(f"infrastructure_validation_{field}_invalid")
    return parsed


def _positive_event_decimal(value: object, *, field: str) -> Decimal:
    parsed = _event_decimal(value, field=field)
    if parsed <= 0:
        raise RuntimeError(f"infrastructure_validation_{field}_invalid")
    return parsed


def tag_infrastructure_validation_event(
    raw_event: object,
    evidence: InfrastructureValidationEvidence,
) -> object:
    """Attach a database-proven non-promotable marker to one broker event."""

    coerced = coerce_json_payload(raw_event)
    payload = (
        {
            str(key): value
            for key, value in cast(Mapping[object, object], coerced).items()
        }
        if isinstance(coerced, Mapping)
        else {"payload": coerced}
    )
    payload[_EVIDENCE_KEY] = {
        "schema_version": _EVIDENCE_SCHEMA_VERSION,
        **evidence_contract_payload(
            provenance=ArtifactProvenance.NON_PROMOTABLE_VALIDATION,
            maturity=EvidenceMaturity.EMPIRICALLY_VALIDATED,
        ),
        "promotable": False,
        "broker_mutation_receipt_id": str(evidence.receipt_id),
        "validation_root_receipt_id": str(evidence.root_receipt_id),
        "validation_root_client_order_id": evidence.root_client_order_id,
        "permit_id": evidence.permit_id,
        "permit_sha256": evidence.permit_sha256,
    }
    return coerce_json_payload(payload)


def strip_unproven_infrastructure_validation_evidence(raw_event: object) -> object:
    """Remove caller-supplied validation evidence before durable persistence."""

    coerced = coerce_json_payload(raw_event)
    if not isinstance(coerced, Mapping):
        return coerced
    payload = {
        str(key): value
        for key, value in cast(Mapping[object, object], coerced).items()
        if str(key) != _EVIDENCE_KEY
    }
    return coerce_json_payload(payload)


def is_non_promotable_validation_event(raw_event: object) -> bool:
    """Return whether a persisted event carries the exact exclusion marker."""

    coerced = coerce_json_payload(raw_event)
    if not isinstance(coerced, Mapping):
        return False
    evidence = cast(Mapping[object, object], coerced).get(_EVIDENCE_KEY)
    if not isinstance(evidence, Mapping):
        return False
    values = cast(Mapping[object, object], evidence)
    return (
        values.get("schema_version") == _EVIDENCE_SCHEMA_VERSION
        and values.get("provenance") == _EVIDENCE_TAG
        and values.get("maturity") == EvidenceMaturity.EMPIRICALLY_VALIDATED.value
        and values.get("authoritative") is False
        and values.get("placeholder") is False
        and values.get("promotable") is False
        and bool(str(values.get("broker_mutation_receipt_id") or "").strip())
        and bool(str(values.get("permit_id") or "").strip())
        and re.fullmatch(
            r"[0-9a-f]{64}",
            str(values.get("permit_sha256") or ""),
        )
        is not None
    )


__all__ = [
    "InfrastructureValidationEvidence",
    "InfrastructureValidationPositionEvidence",
    "infrastructure_validation_lineage_payload",
    "is_non_promotable_validation_event",
    "load_infrastructure_validation_evidence",
    "require_infrastructure_validation_flat_position_evidence",
    "require_infrastructure_validation_position_evidence",
    "strip_unproven_infrastructure_validation_evidence",
    "tag_infrastructure_validation_event",
]
