"""Deterministic, append-only repair evidence for broker order lineage."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import OrderLineageRepairReceipt, coerce_json_payload


ORDER_LINEAGE_REPAIR_VERSION: Final = "torghut.order-lineage-repair.v1"
ORDER_LINEAGE_EVIDENCE_SCHEMA_VERSION: Final = (
    "torghut.order-lineage-repair-evidence.v1"
)

CLASSIFICATION_COMPLETE: Final = "complete"
CLASSIFICATION_LINKED_INCOMPLETE: Final = "linked_incomplete"
CLASSIFICATION_EXTERNAL_OR_UNPROVED: Final = "external_or_unproved"
CLASSIFICATION_AMBIGUOUS: Final = "ambiguous"
CLASSIFICATION_BROKER_ACTIVITY_ONLY: Final = "broker_activity_only"
CLASSIFICATION_ORDER_FEED_ONLY: Final = "order_feed_only"
CLASSIFICATIONS: Final = frozenset(
    {
        CLASSIFICATION_COMPLETE,
        CLASSIFICATION_LINKED_INCOMPLETE,
        CLASSIFICATION_EXTERNAL_OR_UNPROVED,
        CLASSIFICATION_AMBIGUOUS,
        CLASSIFICATION_BROKER_ACTIVITY_ONLY,
        CLASSIFICATION_ORDER_FEED_ONLY,
    }
)

CONFIDENCE_EXACT: Final = "exact"
CONFIDENCE_UNPROVED: Final = "unproved"
CONFIDENCE_AMBIGUOUS: Final = "ambiguous"
CONFIDENCES: Final = frozenset(
    {CONFIDENCE_EXACT, CONFIDENCE_UNPROVED, CONFIDENCE_AMBIGUOUS}
)

EXECUTION_SOURCE_LOCAL: Final = "local"
EXECUTION_SOURCE_CROSS_DSN: Final = "canonical_cross_dsn"
EXECUTION_SOURCE_NONE: Final = "none"
EXECUTION_SOURCES: Final = frozenset(
    {
        EXECUTION_SOURCE_LOCAL,
        EXECUTION_SOURCE_CROSS_DSN,
        EXECUTION_SOURCE_NONE,
    }
)

MATCH_BASIS_ALPACA_ORDER_ID: Final = "alpaca_order_id"
MATCH_BASIS_CLIENT_ORDER_ID: Final = "client_order_id"
MATCH_BASES: Final = frozenset(
    {MATCH_BASIS_ALPACA_ORDER_ID, MATCH_BASIS_CLIENT_ORDER_ID}
)


@dataclass(frozen=True, slots=True)
class OrderLineageEvidence:
    provider: str
    environment: str
    account_label: str
    alpaca_order_id: str | None
    client_order_id: str | None
    classification: str
    confidence: str
    execution_source: str
    canonical_execution_id: uuid.UUID | None = None
    canonical_trade_decision_id: uuid.UUID | None = None
    canonical_strategy_id: uuid.UUID | None = None
    canonical_submission_claim_id: uuid.UUID | None = None
    canonical_tca_metric_id: uuid.UUID | None = None
    order_event_ids: tuple[uuid.UUID, ...] = ()
    fill_order_event_ids: tuple[uuid.UUID, ...] = ()
    broker_activity_ids: tuple[uuid.UUID, ...] = ()
    broker_fill_activity_ids: tuple[uuid.UUID, ...] = ()
    source_first_at: datetime | None = None
    source_last_at: datetime | None = None
    match_basis: tuple[str, ...] = ()
    blockers: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class OrderLineageReceiptDraft:
    repair_version: str
    provider: str
    environment: str
    account_label: str
    order_identity_sha256: str
    alpaca_order_id: str | None
    client_order_id: str | None
    classification: str
    confidence: str
    execution_source: str
    source_first_at: datetime
    source_last_at: datetime
    evidence: dict[str, object]
    evidence_canonical_json: str
    evidence_sha256: str
    promotion_authority_eligible: bool = False


@dataclass(frozen=True, slots=True)
class PersistedOrderLineageReceipt:
    receipt: OrderLineageRepairReceipt
    reused_existing: bool


def build_order_lineage_receipt(
    evidence: OrderLineageEvidence,
) -> OrderLineageReceiptDraft:
    """Validate and canonicalize one order-level evidence observation."""

    provider = _required_text(evidence.provider, "order_lineage_provider_missing")
    environment = _required_text(
        evidence.environment, "order_lineage_environment_missing"
    )
    account_label = _required_text(
        evidence.account_label, "order_lineage_account_label_missing"
    )
    alpaca_order_id = _optional_text(evidence.alpaca_order_id)
    client_order_id = _optional_text(evidence.client_order_id)
    if alpaca_order_id is None and client_order_id is None:
        raise ValueError("order_lineage_order_identity_missing")

    classification = _enum_value(
        evidence.classification,
        CLASSIFICATIONS,
        "order_lineage_classification_invalid",
    )
    confidence = _enum_value(
        evidence.confidence,
        CONFIDENCES,
        "order_lineage_confidence_invalid",
    )
    execution_source = _enum_value(
        evidence.execution_source,
        EXECUTION_SOURCES,
        "order_lineage_execution_source_invalid",
    )
    match_basis = _sorted_text_set(
        evidence.match_basis,
        allowed=MATCH_BASES,
        error="order_lineage_match_basis_invalid",
    )
    blockers = _sorted_text_set(
        evidence.blockers,
        allowed=None,
        error="order_lineage_blocker_invalid",
    )
    order_event_ids = _sorted_uuid_set(evidence.order_event_ids)
    fill_order_event_ids = _sorted_uuid_set(evidence.fill_order_event_ids)
    broker_activity_ids = _sorted_uuid_set(evidence.broker_activity_ids)
    broker_fill_activity_ids = _sorted_uuid_set(evidence.broker_fill_activity_ids)
    if not set(fill_order_event_ids).issubset(order_event_ids):
        raise ValueError("order_lineage_fill_event_not_in_order_events")
    if not set(broker_fill_activity_ids).issubset(broker_activity_ids):
        raise ValueError("order_lineage_broker_fill_not_in_activities")
    if not order_event_ids and not broker_activity_ids:
        raise ValueError("order_lineage_source_evidence_missing")

    if evidence.source_first_at is None or evidence.source_last_at is None:
        raise ValueError("order_lineage_source_window_incomplete")
    source_first_at = _required_utc(evidence.source_first_at)
    source_last_at = _required_utc(evidence.source_last_at)
    if source_first_at > source_last_at:
        raise ValueError("order_lineage_source_window_reversed")

    _validate_linkage_contract(
        classification=classification,
        confidence=confidence,
        execution_source=execution_source,
        execution_id=evidence.canonical_execution_id,
        decision_id=evidence.canonical_trade_decision_id,
        strategy_id=evidence.canonical_strategy_id,
        claim_id=evidence.canonical_submission_claim_id,
        tca_id=evidence.canonical_tca_metric_id,
        order_event_count=len(order_event_ids),
        fill_order_event_count=len(fill_order_event_ids),
        broker_fill_count=len(broker_fill_activity_ids),
        broker_activity_count=len(broker_activity_ids),
        match_basis=match_basis,
        blockers=blockers,
        alpaca_order_id=alpaca_order_id,
        client_order_id=client_order_id,
    )

    primary_order_id_kind = (
        MATCH_BASIS_ALPACA_ORDER_ID
        if alpaca_order_id is not None
        else MATCH_BASIS_CLIENT_ORDER_ID
    )
    primary_order_id = alpaca_order_id or client_order_id
    order_identity_key: dict[str, object] = {
        "account_label": account_label,
        "environment": environment,
        "primary_order_id": primary_order_id,
        "primary_order_id_kind": primary_order_id_kind,
        "provider": provider,
    }
    order_identity_sha256 = _canonical_sha256(order_identity_key)
    order_identity: dict[str, object] = {
        **order_identity_key,
        "alpaca_order_id": alpaca_order_id,
        "client_order_id": client_order_id,
        "sha256": order_identity_sha256,
    }
    links: dict[str, object] = {
        "execution_id": _uuid_text(evidence.canonical_execution_id),
        "strategy_id": _uuid_text(evidence.canonical_strategy_id),
        "submission_claim_id": _uuid_text(evidence.canonical_submission_claim_id),
        "tca_metric_id": _uuid_text(evidence.canonical_tca_metric_id),
        "trade_decision_id": _uuid_text(evidence.canonical_trade_decision_id),
    }
    payload: dict[str, object] = {
        "blockers": list(blockers),
        "classification": classification,
        "confidence": confidence,
        "execution_source": execution_source,
        "links": links,
        "match_basis": list(match_basis),
        "order_identity": order_identity,
        "promotion_authority_eligible": False,
        "repair_version": ORDER_LINEAGE_REPAIR_VERSION,
        "schema_version": ORDER_LINEAGE_EVIDENCE_SCHEMA_VERSION,
        "sources": {
            "broker_activity_ids": [str(value) for value in broker_activity_ids],
            "broker_fill_activity_ids": [
                str(value) for value in broker_fill_activity_ids
            ],
            "counts": {
                "broker_activities": len(broker_activity_ids),
                "broker_fills": len(broker_fill_activity_ids),
                "fill_order_events": len(fill_order_event_ids),
                "order_events": len(order_event_ids),
            },
            "fill_order_event_ids": [str(value) for value in fill_order_event_ids],
            "first_at": source_first_at.isoformat(),
            "last_at": source_last_at.isoformat(),
            "order_event_ids": [str(value) for value in order_event_ids],
        },
    }
    canonical_json = _canonical_json(payload)
    return OrderLineageReceiptDraft(
        repair_version=ORDER_LINEAGE_REPAIR_VERSION,
        provider=provider,
        environment=environment,
        account_label=account_label,
        order_identity_sha256=order_identity_sha256,
        alpaca_order_id=alpaca_order_id,
        client_order_id=client_order_id,
        classification=classification,
        confidence=confidence,
        execution_source=execution_source,
        source_first_at=source_first_at,
        source_last_at=source_last_at,
        evidence=coerce_json_payload(payload),
        evidence_canonical_json=canonical_json,
        evidence_sha256=hashlib.sha256(canonical_json.encode("utf-8")).hexdigest(),
    )


def persist_order_lineage_receipt(
    session: Session,
    draft: OrderLineageReceiptDraft,
    *,
    observed_at: datetime,
) -> PersistedOrderLineageReceipt:
    """Append a new evidence state or reuse the exact existing receipt."""

    existing = session.scalar(
        select(OrderLineageRepairReceipt).where(
            OrderLineageRepairReceipt.order_identity_sha256
            == draft.order_identity_sha256,
            OrderLineageRepairReceipt.repair_version == draft.repair_version,
            OrderLineageRepairReceipt.evidence_sha256 == draft.evidence_sha256,
        )
    )
    if existing is not None:
        return PersistedOrderLineageReceipt(
            receipt=existing,
            reused_existing=True,
        )

    row = OrderLineageRepairReceipt(
        repair_version=draft.repair_version,
        provider=draft.provider,
        environment=draft.environment,
        account_label=draft.account_label,
        order_identity_sha256=draft.order_identity_sha256,
        alpaca_order_id=draft.alpaca_order_id,
        client_order_id=draft.client_order_id,
        classification=draft.classification,
        confidence=draft.confidence,
        execution_source=draft.execution_source,
        source_first_at=draft.source_first_at,
        source_last_at=draft.source_last_at,
        evidence=draft.evidence,
        evidence_canonical_json=draft.evidence_canonical_json,
        evidence_sha256=draft.evidence_sha256,
        promotion_authority_eligible=draft.promotion_authority_eligible,
        observed_at=_required_utc(observed_at),
    )
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        existing = session.scalar(
            select(OrderLineageRepairReceipt).where(
                OrderLineageRepairReceipt.order_identity_sha256
                == draft.order_identity_sha256,
                OrderLineageRepairReceipt.repair_version == draft.repair_version,
                OrderLineageRepairReceipt.evidence_sha256 == draft.evidence_sha256,
            )
        )
        if existing is None:
            raise
        return PersistedOrderLineageReceipt(receipt=existing, reused_existing=True)
    return PersistedOrderLineageReceipt(receipt=row, reused_existing=False)


def _validate_linkage_contract(
    *,
    classification: str,
    confidence: str,
    execution_source: str,
    execution_id: uuid.UUID | None,
    decision_id: uuid.UUID | None,
    strategy_id: uuid.UUID | None,
    claim_id: uuid.UUID | None,
    tca_id: uuid.UUID | None,
    order_event_count: int,
    fill_order_event_count: int,
    broker_fill_count: int,
    broker_activity_count: int,
    match_basis: tuple[str, ...],
    blockers: tuple[str, ...],
    alpaca_order_id: str | None,
    client_order_id: str | None,
) -> None:
    linked = execution_id is not None
    downstream_links = (decision_id, strategy_id, claim_id, tca_id)
    if linked != (execution_source != EXECUTION_SOURCE_NONE) or (
        not linked and any(value is not None for value in downstream_links)
    ):
        raise ValueError("order_lineage_execution_identity_inconsistent")
    if decision_id is None and (strategy_id is not None or claim_id is not None):
        raise ValueError("order_lineage_decision_identity_inconsistent")
    if confidence == CONFIDENCE_EXACT and (not linked or not match_basis):
        raise ValueError("order_lineage_exact_confidence_unproved")
    if classification == CLASSIFICATION_AMBIGUOUS and not match_basis:
        raise ValueError("order_lineage_ambiguous_match_basis_missing")
    if (MATCH_BASIS_ALPACA_ORDER_ID in match_basis and alpaca_order_id is None) or (
        MATCH_BASIS_CLIENT_ORDER_ID in match_basis and client_order_id is None
    ):
        raise ValueError("order_lineage_match_basis_identity_missing")
    if classification in {CLASSIFICATION_COMPLETE, CLASSIFICATION_LINKED_INCOMPLETE}:
        if not linked or confidence != CONFIDENCE_EXACT:
            raise ValueError("order_lineage_linked_classification_without_execution")
    elif linked:
        raise ValueError("order_lineage_unlinked_classification_with_execution")
    if classification == CLASSIFICATION_COMPLETE:
        if (
            decision_id is None
            or strategy_id is None
            or claim_id is None
            or tca_id is None
            or order_event_count <= 0
            or fill_order_event_count <= 0
            or broker_fill_count <= 0
            or blockers
        ):
            raise ValueError("order_lineage_complete_evidence_incomplete")
    if classification != CLASSIFICATION_COMPLETE and not blockers:
        raise ValueError("order_lineage_incomplete_blockers_missing")
    if classification == CLASSIFICATION_AMBIGUOUS:
        if confidence != CONFIDENCE_AMBIGUOUS:
            raise ValueError("order_lineage_ambiguous_evidence_invalid")
    elif confidence == CONFIDENCE_AMBIGUOUS:
        raise ValueError("order_lineage_ambiguous_confidence_misclassified")
    if (
        classification
        in {
            CLASSIFICATION_EXTERNAL_OR_UNPROVED,
            CLASSIFICATION_BROKER_ACTIVITY_ONLY,
            CLASSIFICATION_ORDER_FEED_ONLY,
        }
        and confidence != CONFIDENCE_UNPROVED
    ):
        raise ValueError("order_lineage_unproved_classification_confidence_invalid")
    if classification == CLASSIFICATION_BROKER_ACTIVITY_ONLY and (
        order_event_count != 0 or broker_activity_count <= 0
    ):
        raise ValueError("order_lineage_broker_activity_only_sources_invalid")
    if classification == CLASSIFICATION_ORDER_FEED_ONLY and (
        order_event_count <= 0 or broker_activity_count != 0
    ):
        raise ValueError("order_lineage_order_feed_only_sources_invalid")
    if classification == CLASSIFICATION_EXTERNAL_OR_UNPROVED and (
        order_event_count <= 0 or broker_activity_count <= 0
    ):
        raise ValueError("order_lineage_external_sources_invalid")


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _required_text(value: object, error: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(error)
    return text


def _optional_text(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _enum_value(value: object, allowed: frozenset[str], error: str) -> str:
    text = _required_text(value, error)
    if text not in allowed:
        raise ValueError(error)
    return text


def _sorted_text_set(
    values: tuple[str, ...],
    *,
    allowed: frozenset[str] | None,
    error: str,
) -> tuple[str, ...]:
    normalized = {_required_text(value, error) for value in values}
    if allowed is not None and not normalized.issubset(allowed):
        raise ValueError(error)
    return tuple(sorted(normalized))


def _sorted_uuid_set(values: tuple[uuid.UUID, ...]) -> tuple[uuid.UUID, ...]:
    return tuple(sorted({uuid.UUID(str(value)) for value in values}, key=str))


def _required_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("order_lineage_timestamp_timezone_missing")
    return value.astimezone(timezone.utc)


def _uuid_text(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


__all__ = (
    "CLASSIFICATION_AMBIGUOUS",
    "CLASSIFICATION_BROKER_ACTIVITY_ONLY",
    "CLASSIFICATION_COMPLETE",
    "CLASSIFICATION_EXTERNAL_OR_UNPROVED",
    "CLASSIFICATION_LINKED_INCOMPLETE",
    "CLASSIFICATION_ORDER_FEED_ONLY",
    "CONFIDENCE_AMBIGUOUS",
    "CONFIDENCE_EXACT",
    "CONFIDENCE_UNPROVED",
    "EXECUTION_SOURCE_CROSS_DSN",
    "EXECUTION_SOURCE_LOCAL",
    "EXECUTION_SOURCE_NONE",
    "MATCH_BASIS_ALPACA_ORDER_ID",
    "MATCH_BASIS_CLIENT_ORDER_ID",
    "ORDER_LINEAGE_EVIDENCE_SCHEMA_VERSION",
    "ORDER_LINEAGE_REPAIR_VERSION",
    "OrderLineageEvidence",
    "OrderLineageReceiptDraft",
    "PersistedOrderLineageReceipt",
    "build_order_lineage_receipt",
    "persist_order_lineage_receipt",
)
