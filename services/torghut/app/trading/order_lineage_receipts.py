"""Deterministic, append-only repair evidence for broker order lineage."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Final, cast

from psycopg.errors import UniqueViolation
from sqlalchemy import or_, select, text as sql_text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

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
_SOURCE_GAP_CLASSIFICATIONS: Final = frozenset(
    {CLASSIFICATION_BROKER_ACTIVITY_ONLY, CLASSIFICATION_ORDER_FEED_ONLY}
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
_IDENTITY_SCOPE_LOCK_STATE: Final = "order_lineage_identity_scope_lock_state"


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
class _NormalizedOrderLineageEvidence:
    provider: str
    environment: str
    account_label: str
    alpaca_order_id: str | None
    client_order_id: str | None
    classification: str
    confidence: str
    execution_source: str
    execution_id: uuid.UUID | None
    decision_id: uuid.UUID | None
    strategy_id: uuid.UUID | None
    claim_id: uuid.UUID | None
    tca_id: uuid.UUID | None
    order_event_ids: tuple[uuid.UUID, ...]
    fill_order_event_ids: tuple[uuid.UUID, ...]
    broker_activity_ids: tuple[uuid.UUID, ...]
    broker_fill_activity_ids: tuple[uuid.UUID, ...]
    source_first_at: datetime
    source_last_at: datetime
    match_basis: tuple[str, ...]
    blockers: tuple[str, ...]


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


@dataclass(slots=True)
class _IdentityScopeLockState:
    transaction: object
    locked_scopes: set[str]


@dataclass(frozen=True, slots=True)
class _DurableOrderIdentity:
    sha256: str
    primary_order_id_kind: str
    primary_order_id: str
    alpaca_order_id: str | None
    client_order_id: str | None


def _normalize_evidence(
    evidence: OrderLineageEvidence,
) -> _NormalizedOrderLineageEvidence:
    alpaca_order_id = _optional_text(evidence.alpaca_order_id)
    client_order_id = _optional_text(evidence.client_order_id)
    if alpaca_order_id is None and client_order_id is None:
        raise ValueError("order_lineage_order_identity_missing")
    source_first_at, source_last_at = _source_window(evidence)
    normalized = _NormalizedOrderLineageEvidence(
        provider=_required_text(evidence.provider, "order_lineage_provider_missing"),
        environment=_required_text(
            evidence.environment,
            "order_lineage_environment_missing",
        ),
        account_label=_required_text(
            evidence.account_label,
            "order_lineage_account_label_missing",
        ),
        alpaca_order_id=alpaca_order_id,
        client_order_id=client_order_id,
        classification=_enum_value(
            evidence.classification,
            CLASSIFICATIONS,
            "order_lineage_classification_invalid",
        ),
        confidence=_enum_value(
            evidence.confidence,
            CONFIDENCES,
            "order_lineage_confidence_invalid",
        ),
        execution_source=_enum_value(
            evidence.execution_source,
            EXECUTION_SOURCES,
            "order_lineage_execution_source_invalid",
        ),
        execution_id=evidence.canonical_execution_id,
        decision_id=evidence.canonical_trade_decision_id,
        strategy_id=evidence.canonical_strategy_id,
        claim_id=evidence.canonical_submission_claim_id,
        tca_id=evidence.canonical_tca_metric_id,
        order_event_ids=_sorted_uuid_set(evidence.order_event_ids),
        fill_order_event_ids=_sorted_uuid_set(evidence.fill_order_event_ids),
        broker_activity_ids=_sorted_uuid_set(evidence.broker_activity_ids),
        broker_fill_activity_ids=_sorted_uuid_set(evidence.broker_fill_activity_ids),
        source_first_at=source_first_at,
        source_last_at=source_last_at,
        match_basis=_sorted_text_set(
            evidence.match_basis,
            allowed=MATCH_BASES,
            error="order_lineage_match_basis_invalid",
        ),
        blockers=_sorted_text_set(
            evidence.blockers,
            allowed=None,
            error="order_lineage_blocker_invalid",
        ),
    )
    _validate_source_contract(normalized)
    _validate_linkage_contract(normalized)
    return normalized


def _source_window(evidence: OrderLineageEvidence) -> tuple[datetime, datetime]:
    if evidence.source_first_at is None or evidence.source_last_at is None:
        raise ValueError("order_lineage_source_window_incomplete")
    source_first_at = _required_utc(evidence.source_first_at)
    source_last_at = _required_utc(evidence.source_last_at)
    if source_first_at > source_last_at:
        raise ValueError("order_lineage_source_window_reversed")
    return source_first_at, source_last_at


def _validate_source_contract(evidence: _NormalizedOrderLineageEvidence) -> None:
    if not set(evidence.fill_order_event_ids).issubset(evidence.order_event_ids):
        raise ValueError("order_lineage_fill_event_not_in_order_events")
    if not set(evidence.broker_fill_activity_ids).issubset(
        evidence.broker_activity_ids
    ):
        raise ValueError("order_lineage_broker_fill_not_in_activities")
    if not evidence.order_event_ids and not evidence.broker_activity_ids:
        raise ValueError("order_lineage_source_evidence_missing")


def build_order_lineage_receipt(
    evidence: OrderLineageEvidence,
) -> OrderLineageReceiptDraft:
    """Validate and canonicalize one order-level evidence observation."""

    normalized = _normalize_evidence(evidence)
    primary_order_id_kind = (
        MATCH_BASIS_ALPACA_ORDER_ID
        if normalized.alpaca_order_id is not None
        else MATCH_BASIS_CLIENT_ORDER_ID
    )
    primary_order_id = normalized.alpaca_order_id or normalized.client_order_id
    if primary_order_id is None:
        raise ValueError("order_lineage_order_identity_missing")
    order_identity_key: dict[str, object] = {
        "account_label": normalized.account_label,
        "environment": normalized.environment,
        "primary_order_id": primary_order_id,
        "primary_order_id_kind": primary_order_id_kind,
        "provider": normalized.provider,
    }
    order_identity_sha256 = _order_identity_sha256(
        provider=normalized.provider,
        environment=normalized.environment,
        account_label=normalized.account_label,
        primary_order_id_kind=primary_order_id_kind,
        primary_order_id=primary_order_id,
    )
    order_identity: dict[str, object] = {
        **order_identity_key,
        "alpaca_order_id": normalized.alpaca_order_id,
        "client_order_id": normalized.client_order_id,
        "sha256": order_identity_sha256,
    }
    links: dict[str, object] = {
        "execution_id": _uuid_text(normalized.execution_id),
        "strategy_id": _uuid_text(normalized.strategy_id),
        "submission_claim_id": _uuid_text(normalized.claim_id),
        "tca_metric_id": _uuid_text(normalized.tca_id),
        "trade_decision_id": _uuid_text(normalized.decision_id),
    }
    payload: dict[str, object] = {
        "blockers": list(normalized.blockers),
        "classification": normalized.classification,
        "confidence": normalized.confidence,
        "execution_source": normalized.execution_source,
        "links": links,
        "match_basis": list(normalized.match_basis),
        "order_identity": order_identity,
        "promotion_authority_eligible": False,
        "repair_version": ORDER_LINEAGE_REPAIR_VERSION,
        "schema_version": ORDER_LINEAGE_EVIDENCE_SCHEMA_VERSION,
        "sources": {
            "broker_activity_ids": [
                str(value) for value in normalized.broker_activity_ids
            ],
            "broker_fill_activity_ids": [
                str(value) for value in normalized.broker_fill_activity_ids
            ],
            "counts": {
                "broker_activities": len(normalized.broker_activity_ids),
                "broker_fills": len(normalized.broker_fill_activity_ids),
                "fill_order_events": len(normalized.fill_order_event_ids),
                "order_events": len(normalized.order_event_ids),
            },
            "fill_order_event_ids": [
                str(value) for value in normalized.fill_order_event_ids
            ],
            "first_at": normalized.source_first_at.isoformat(),
            "last_at": normalized.source_last_at.isoformat(),
            "order_event_ids": [str(value) for value in normalized.order_event_ids],
        },
    }
    canonical_json = _jsonb_canonical_json(payload)
    return OrderLineageReceiptDraft(
        repair_version=ORDER_LINEAGE_REPAIR_VERSION,
        provider=normalized.provider,
        environment=normalized.environment,
        account_label=normalized.account_label,
        order_identity_sha256=order_identity_sha256,
        alpaca_order_id=normalized.alpaca_order_id,
        client_order_id=normalized.client_order_id,
        classification=normalized.classification,
        confidence=normalized.confidence,
        execution_source=normalized.execution_source,
        source_first_at=normalized.source_first_at,
        source_last_at=normalized.source_last_at,
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

    _acquire_identity_scope_lock(session, draft)
    draft, existing = _resolve_durable_order_identity(session, draft)
    if existing is not None:
        _validate_reused_receipt(existing, draft)
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
    except IntegrityError as error:
        if not _is_evidence_unique_violation(error):
            raise
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
        _validate_reused_receipt(existing, draft)
        return PersistedOrderLineageReceipt(receipt=existing, reused_existing=True)
    return PersistedOrderLineageReceipt(receipt=row, reused_existing=False)


def _acquire_identity_scope_lock(
    session: Session,
    draft: OrderLineageReceiptDraft,
) -> None:
    if session.get_bind().dialect.name != "postgresql":
        return
    session.connection()
    transaction = session.get_transaction()
    if transaction is None:
        raise RuntimeError("order_lineage_transaction_missing")
    scope = "\x1f".join(
        (
            draft.repair_version,
            draft.provider,
            draft.environment,
            draft.account_label,
        )
    )
    state = session.info.get(_IDENTITY_SCOPE_LOCK_STATE)
    if not isinstance(state, _IdentityScopeLockState) or (
        state.transaction is not transaction
    ):
        state = _IdentityScopeLockState(transaction=transaction, locked_scopes=set())
        session.info[_IDENTITY_SCOPE_LOCK_STATE] = state
    if scope in state.locked_scopes:
        return
    session.execute(
        sql_text("SELECT pg_advisory_xact_lock(hashtextextended(:identity_scope, 0))"),
        {"identity_scope": scope},
    )
    state.locked_scopes.add(scope)


def _resolve_durable_order_identity(
    session: Session,
    draft: OrderLineageReceiptDraft,
) -> tuple[OrderLineageReceiptDraft, OrderLineageRepairReceipt | None]:
    matches = _matching_identity_receipts(session, draft)
    if not matches:
        return draft, None
    durable = _durable_identity_for_matches(matches, draft)

    payload = dict(draft.evidence)
    identity_value = payload.get("order_identity")
    if not isinstance(identity_value, dict):
        raise ValueError("order_lineage_order_identity_document_missing")
    order_identity = dict(cast(dict[str, object], identity_value))
    order_identity.update(
        {
            "alpaca_order_id": durable.alpaca_order_id,
            "client_order_id": durable.client_order_id,
            "primary_order_id": durable.primary_order_id,
            "primary_order_id_kind": durable.primary_order_id_kind,
            "sha256": durable.sha256,
        }
    )
    payload["order_identity"] = order_identity
    canonical_json = _jsonb_canonical_json(payload)
    resolved = replace(
        draft,
        order_identity_sha256=durable.sha256,
        alpaca_order_id=durable.alpaca_order_id,
        client_order_id=durable.client_order_id,
        evidence=coerce_json_payload(payload),
        evidence_canonical_json=canonical_json,
        evidence_sha256=hashlib.sha256(canonical_json.encode("utf-8")).hexdigest(),
    )
    existing = next(
        (
            row
            for row in matches
            if row.order_identity_sha256 == resolved.order_identity_sha256
            and row.evidence_sha256 == resolved.evidence_sha256
        ),
        None,
    )
    return resolved, existing


def _durable_identity_for_matches(
    matches: list[OrderLineageRepairReceipt],
    draft: OrderLineageReceiptDraft,
) -> _DurableOrderIdentity:
    identity_hashes = {row.order_identity_sha256 for row in matches}
    if len(identity_hashes) != 1:
        raise ValueError("order_lineage_identity_alias_conflict")
    primary_identities = {_persisted_primary_identity(row) for row in matches}
    if len(primary_identities) != 1:
        raise ValueError("order_lineage_primary_identity_conflict")
    primary_order_id_kind, primary_order_id = next(iter(primary_identities))
    alpaca_order_id = _single_order_alias(
        draft.alpaca_order_id,
        *(row.alpaca_order_id for row in matches),
    )
    client_order_id = _single_order_alias(
        draft.client_order_id,
        *(row.client_order_id for row in matches),
    )
    expected_primary_order_id = (
        alpaca_order_id
        if primary_order_id_kind == MATCH_BASIS_ALPACA_ORDER_ID
        else client_order_id
    )
    if expected_primary_order_id != primary_order_id:
        raise ValueError("order_lineage_primary_identity_alias_missing")
    return _DurableOrderIdentity(
        sha256=next(iter(identity_hashes)),
        primary_order_id_kind=primary_order_id_kind,
        primary_order_id=primary_order_id,
        alpaca_order_id=alpaca_order_id,
        client_order_id=client_order_id,
    )


def _matching_identity_receipts(
    session: Session,
    draft: OrderLineageReceiptDraft,
) -> list[OrderLineageRepairReceipt]:
    identity_conditions: list[ColumnElement[bool]] = []
    if draft.alpaca_order_id is not None:
        identity_conditions.append(
            OrderLineageRepairReceipt.alpaca_order_id == draft.alpaca_order_id
        )
    if draft.client_order_id is not None:
        identity_conditions.append(
            OrderLineageRepairReceipt.client_order_id == draft.client_order_id
        )
    if not identity_conditions:
        raise ValueError("order_lineage_order_identity_missing")
    return list(
        session.scalars(
            select(OrderLineageRepairReceipt)
            .where(
                OrderLineageRepairReceipt.repair_version == draft.repair_version,
                OrderLineageRepairReceipt.provider == draft.provider,
                OrderLineageRepairReceipt.environment == draft.environment,
                OrderLineageRepairReceipt.account_label == draft.account_label,
                or_(*identity_conditions),
            )
            .order_by(
                OrderLineageRepairReceipt.created_at,
                OrderLineageRepairReceipt.id,
            )
        )
    )


def _persisted_primary_identity(
    row: OrderLineageRepairReceipt,
) -> tuple[str, str]:
    identity_value = row.evidence.get("order_identity")
    if not isinstance(identity_value, dict):
        raise ValueError("order_lineage_order_identity_document_missing")
    identity = cast(dict[str, object], identity_value)
    primary_order_id_kind = _enum_value(
        identity.get("primary_order_id_kind"),
        MATCH_BASES,
        "order_lineage_primary_identity_kind_invalid",
    )
    primary_order_id = _required_text(
        identity.get("primary_order_id"),
        "order_lineage_primary_identity_missing",
    )
    expected_alias = (
        row.alpaca_order_id
        if primary_order_id_kind == MATCH_BASIS_ALPACA_ORDER_ID
        else row.client_order_id
    )
    expected_hash = _order_identity_sha256(
        provider=row.provider,
        environment=row.environment,
        account_label=row.account_label,
        primary_order_id_kind=primary_order_id_kind,
        primary_order_id=primary_order_id,
    )
    if expected_alias != primary_order_id or expected_hash != row.order_identity_sha256:
        raise ValueError("order_lineage_persisted_identity_invalid")
    return primary_order_id_kind, primary_order_id


def _single_order_alias(*values: str | None) -> str | None:
    aliases = {value for value in values if value is not None}
    if len(aliases) > 1:
        raise ValueError("order_lineage_identity_alias_conflict")
    return next(iter(aliases), None)


def _is_evidence_unique_violation(error: IntegrityError) -> bool:
    return (
        isinstance(error.orig, UniqueViolation)
        and error.orig.diag.constraint_name == "uq_order_lineage_receipt_evidence"
    )


def _validate_reused_receipt(
    receipt: OrderLineageRepairReceipt,
    draft: OrderLineageReceiptDraft,
) -> None:
    persisted_projection = (
        receipt.repair_version,
        receipt.provider,
        receipt.environment,
        receipt.account_label,
        receipt.order_identity_sha256,
        receipt.alpaca_order_id,
        receipt.client_order_id,
        receipt.classification,
        receipt.confidence,
        receipt.execution_source,
        receipt.source_first_at,
        receipt.source_last_at,
        receipt.evidence_canonical_json,
        receipt.evidence_sha256,
        receipt.promotion_authority_eligible,
    )
    draft_projection = (
        draft.repair_version,
        draft.provider,
        draft.environment,
        draft.account_label,
        draft.order_identity_sha256,
        draft.alpaca_order_id,
        draft.client_order_id,
        draft.classification,
        draft.confidence,
        draft.execution_source,
        draft.source_first_at,
        draft.source_last_at,
        draft.evidence_canonical_json,
        draft.evidence_sha256,
        draft.promotion_authority_eligible,
    )
    if persisted_projection != draft_projection:
        raise ValueError("order_lineage_replay_projection_mismatch")


def _validate_linkage_contract(evidence: _NormalizedOrderLineageEvidence) -> None:
    _validate_link_identity(evidence)
    _validate_classification_links(evidence)
    _validate_classification_sources(evidence)


def _validate_link_identity(evidence: _NormalizedOrderLineageEvidence) -> None:
    linked = evidence.execution_id is not None
    downstream_links = (
        evidence.decision_id,
        evidence.strategy_id,
        evidence.claim_id,
        evidence.tca_id,
    )
    if linked != (evidence.execution_source != EXECUTION_SOURCE_NONE) or (
        not linked and any(value is not None for value in downstream_links)
    ):
        raise ValueError("order_lineage_execution_identity_inconsistent")
    if evidence.decision_id is None and (
        evidence.strategy_id is not None or evidence.claim_id is not None
    ):
        raise ValueError("order_lineage_decision_identity_inconsistent")
    if evidence.claim_id is not None and evidence.claim_id != evidence.decision_id:
        raise ValueError("order_lineage_submission_claim_identity_inconsistent")
    if evidence.confidence == CONFIDENCE_EXACT and (
        not linked or not evidence.match_basis
    ):
        raise ValueError("order_lineage_exact_confidence_unproved")
    if evidence.classification == CLASSIFICATION_AMBIGUOUS and not evidence.match_basis:
        raise ValueError("order_lineage_ambiguous_match_basis_missing")
    if (
        MATCH_BASIS_ALPACA_ORDER_ID in evidence.match_basis
        and evidence.alpaca_order_id is None
    ) or (
        MATCH_BASIS_CLIENT_ORDER_ID in evidence.match_basis
        and evidence.client_order_id is None
    ):
        raise ValueError("order_lineage_match_basis_identity_missing")


def _validate_classification_links(
    evidence: _NormalizedOrderLineageEvidence,
) -> None:
    linked = evidence.execution_id is not None
    if evidence.classification in {
        CLASSIFICATION_COMPLETE,
        CLASSIFICATION_LINKED_INCOMPLETE,
    }:
        if not linked or evidence.confidence != CONFIDENCE_EXACT:
            raise ValueError("order_lineage_linked_classification_without_execution")
    elif evidence.classification in _SOURCE_GAP_CLASSIFICATIONS:
        expected_confidence = CONFIDENCE_EXACT if linked else CONFIDENCE_UNPROVED
        if evidence.confidence != expected_confidence:
            raise ValueError("order_lineage_source_gap_confidence_invalid")
    elif linked:
        raise ValueError("order_lineage_unlinked_classification_with_execution")
    if (
        evidence.classification == CLASSIFICATION_COMPLETE
        and _complete_evidence_is_incomplete(evidence)
    ):
        raise ValueError("order_lineage_complete_evidence_incomplete")
    if evidence.classification != CLASSIFICATION_COMPLETE and not evidence.blockers:
        raise ValueError("order_lineage_incomplete_blockers_missing")
    if evidence.classification == CLASSIFICATION_AMBIGUOUS:
        if evidence.confidence != CONFIDENCE_AMBIGUOUS:
            raise ValueError("order_lineage_ambiguous_evidence_invalid")
    elif evidence.confidence == CONFIDENCE_AMBIGUOUS:
        raise ValueError("order_lineage_ambiguous_confidence_misclassified")
    if (
        evidence.classification == CLASSIFICATION_EXTERNAL_OR_UNPROVED
        and evidence.confidence != CONFIDENCE_UNPROVED
    ):
        raise ValueError("order_lineage_unproved_classification_confidence_invalid")


def _complete_evidence_is_incomplete(
    evidence: _NormalizedOrderLineageEvidence,
) -> bool:
    return (
        evidence.decision_id is None
        or evidence.strategy_id is None
        or evidence.claim_id is None
        or evidence.tca_id is None
        or not evidence.order_event_ids
        or not evidence.fill_order_event_ids
        or not evidence.broker_fill_activity_ids
        or bool(evidence.blockers)
    )


def _validate_classification_sources(
    evidence: _NormalizedOrderLineageEvidence,
) -> None:
    if evidence.classification == CLASSIFICATION_BROKER_ACTIVITY_ONLY and (
        evidence.order_event_ids or not evidence.broker_activity_ids
    ):
        raise ValueError("order_lineage_broker_activity_only_sources_invalid")
    if evidence.classification == CLASSIFICATION_ORDER_FEED_ONLY and (
        not evidence.order_event_ids or evidence.broker_activity_ids
    ):
        raise ValueError("order_lineage_order_feed_only_sources_invalid")
    if evidence.classification == CLASSIFICATION_EXTERNAL_OR_UNPROVED and (
        not evidence.order_event_ids or not evidence.broker_activity_ids
    ):
        raise ValueError("order_lineage_external_sources_invalid")


def _jsonb_canonical_json(value: object) -> str:
    """Serialize the receipt subset exactly like PostgreSQL JSONB text output."""

    if isinstance(value, dict):
        mapping = cast(dict[str, object], value)
        items: list[str] = []
        for key in sorted(
            mapping,
            key=lambda item: (len(item.encode("utf-8")), item.encode("utf-8")),
        ):
            rendered_key = json.dumps(key, ensure_ascii=False)
            items.append(f"{rendered_key}: {_jsonb_canonical_json(mapping[key])}")
        return "{" + ", ".join(items) + "}"
    if isinstance(value, (list, tuple)):
        sequence = cast(list[object] | tuple[object, ...], value)
        return "[" + ", ".join(_jsonb_canonical_json(item) for item in sequence) + "]"
    if value is None or isinstance(value, (str, bool, int)):
        return json.dumps(value, allow_nan=False, ensure_ascii=False)
    raise TypeError(f"unsupported order-lineage JSON value: {type(value).__name__}")


def _order_identity_sha256(
    *,
    provider: str,
    environment: str,
    account_label: str,
    primary_order_id_kind: str,
    primary_order_id: str,
) -> str:
    values = (
        provider,
        environment,
        account_label,
        primary_order_id_kind,
        primary_order_id,
    )
    material = "".join(f"{len(value.encode('utf-8'))}:{value}" for value in values)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


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
