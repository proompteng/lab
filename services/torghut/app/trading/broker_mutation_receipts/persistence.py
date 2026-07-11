"""Immutable persistence primitives for broker-mutation receipts."""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import cast

from sqlalchemy import and_, func, insert, or_, select, text
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ...models import BrokerMutationReceipt, BrokerMutationReceiptEvent
from .types import (
    BrokerMutationIntent,
    BrokerMutationOperation,
    BrokerMutationPurpose,
    BrokerMutationReceiptEventSnapshot,
    BrokerMutationReceiptEventType,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptLifecycle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationReceiptState,
    BrokerMutationRecoveryAudit,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservationOutcome,
    BrokerMutationRiskClass,
    BrokerMutationRoute,
    BrokerMutationSettlementAudit,
    BrokerMutationSettlementOutcome,
    BrokerMutationSettlementSource,
    BrokerMutationTarget,
    BrokerMutationTargetKind,
)
from .validation import (
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
    as_uuid,
)


_EVENT_FULL_STATE_FIELDS = frozenset(
    {
        "sequence_no",
        "event_type",
        "state",
        "event_writer_generation",
        "primary_token",
        "primary_epoch",
        "primary_owner",
        "primary_writer_generation",
        "primary_claimed_at",
        "primary_lease_expires_at",
        "released_at",
        "release_reason",
        "broker_io_started_at",
        "recovery_after",
        "recovery_token",
        "recovery_epoch",
        "recovery_owner",
        "recovery_writer_generation",
        "recovery_lease_started_at",
        "recovery_lease_expires_at",
        "recovery_checked_at",
        "recovery_observation_epoch",
        "recovery_outcome",
        "settlement_source",
        "settlement_outcome",
        "broker_reference",
        "execution_id",
        "recovery_evidence_json",
        "recovery_evidence_sha256",
        "settlement_evidence_json",
        "settlement_evidence_sha256",
        "settled_at",
    }
)


def as_database_utc_datetime(value: object, *, field: str) -> datetime:
    """Convert a trusted database timestamp into an aware UTC datetime."""

    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value or "").strip().replace("Z", "+00:00")
        if not raw:
            raise BrokerMutationReceiptError(f"database_{field}_unavailable")
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise BrokerMutationReceiptError(f"database_{field}_invalid") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def database_now(session: Session) -> datetime:
    """Read time from the transaction's database instead of the process clock."""

    dialect_name = _supported_dialect(session)
    clock = (
        func.clock_timestamp()
        if dialect_name == "postgresql"
        else func.current_timestamp()
    )
    observed = session.execute(select(clock)).scalar_one()
    return as_database_utc_datetime(observed, field="clock")


def snapshot_from_models(
    header: BrokerMutationReceipt,
    event: BrokerMutationReceiptEvent,
) -> BrokerMutationReceiptSnapshot:
    """Map an immutable header and one full-state event to the typed read model."""

    receipt_id = _database_uuid(header.id, field="receipt_id")
    if _database_uuid(event.receipt_id, field="event_receipt_id") != receipt_id:
        raise BrokerMutationReceiptError("receipt_event_identity_mismatch")
    recovery_handle = _recovery_handle_from_model(event, receipt_id=receipt_id)
    return BrokerMutationReceiptSnapshot(
        receipt_id=receipt_id,
        intent=_intent_from_model(header),
        creator_owner=header.creator_owner,
        origin_writer_generation=int(header.origin_writer_generation),
        created_at=as_database_utc_datetime(header.created_at, field="created_at"),
        primary_handle=BrokerMutationReceiptHandle(
            receipt_id=receipt_id,
            primary_token=_database_uuid(event.primary_token, field="primary_token"),
            primary_epoch=int(event.primary_epoch),
            primary_owner=event.primary_owner,
            primary_writer_generation=int(event.primary_writer_generation),
        ),
        recovery_handle=recovery_handle,
        lifecycle=BrokerMutationReceiptLifecycle(
            state=cast(BrokerMutationReceiptState, event.state),
            event_type=cast(BrokerMutationReceiptEventType, event.event_type),
            sequence_no=int(event.sequence_no),
            event_writer_generation=int(event.event_writer_generation),
            primary_claimed_at=as_database_utc_datetime(
                event.primary_claimed_at,
                field="primary_claimed_at",
            ),
            primary_lease_expires_at=as_database_utc_datetime(
                event.primary_lease_expires_at,
                field="primary_lease_expires_at",
            ),
            released_at=_optional_database_datetime(
                event.released_at,
                field="released_at",
            ),
            release_reason=event.release_reason,
            broker_io_started_at=_optional_database_datetime(
                event.broker_io_started_at,
                field="broker_io_started_at",
            ),
            recovery_after=_optional_database_datetime(
                event.recovery_after,
                field="recovery_after",
            ),
        ),
        recovery=BrokerMutationRecoveryAudit(
            checked_at=_optional_database_datetime(
                event.recovery_checked_at,
                field="recovery_checked_at",
            ),
            observation_epoch=event.recovery_observation_epoch,
            outcome=cast(
                BrokerMutationRecoveryObservationOutcome | None,
                event.recovery_outcome,
            ),
            evidence_json=event.recovery_evidence_json,
            evidence_sha256=event.recovery_evidence_sha256,
        ),
        settlement=BrokerMutationSettlementAudit(
            source=cast(BrokerMutationSettlementSource | None, event.settlement_source),
            outcome=cast(
                BrokerMutationSettlementOutcome | None, event.settlement_outcome
            ),
            broker_reference=event.broker_reference,
            execution_id=(
                _database_uuid(event.execution_id, field="execution_id")
                if event.execution_id is not None
                else None
            ),
            evidence_json=event.settlement_evidence_json,
            evidence_sha256=event.settlement_evidence_sha256,
            settled_at=_optional_database_datetime(
                event.settled_at,
                field="settled_at",
            ),
        ),
    )


def event_snapshot_from_models(
    header: BrokerMutationReceipt,
    event: BrokerMutationReceiptEvent,
) -> BrokerMutationReceiptEventSnapshot:
    """Map one append-only event, retaining its full receipt state."""

    snapshot = snapshot_from_models(header, event)
    return BrokerMutationReceiptEventSnapshot(
        event_id=_database_uuid(event.id, field="event_id"),
        receipt_id=snapshot.receipt_id,
        sequence_no=int(event.sequence_no),
        event_type=cast(BrokerMutationReceiptEventType, event.event_type),
        state=cast(BrokerMutationReceiptState, event.state),
        event_writer_generation=int(event.event_writer_generation),
        recorded_at=as_database_utc_datetime(event.recorded_at, field="recorded_at"),
        snapshot=snapshot,
    )


def _intent_from_model(header: BrokerMutationReceipt) -> BrokerMutationIntent:
    return BrokerMutationIntent(
        broker_route=cast(BrokerMutationRoute, header.broker_route),
        account_label=header.account_label,
        endpoint_fingerprint=header.endpoint_fingerprint,
        operation=cast(BrokerMutationOperation, header.operation),
        risk_class=cast(BrokerMutationRiskClass, header.risk_class),
        purpose=cast(BrokerMutationPurpose, header.purpose),
        workflow_id=header.workflow_id,
        client_request_id=header.client_request_id,
        target=BrokerMutationTarget(
            kind=cast(BrokerMutationTargetKind, header.target_kind),
            key=header.target_key,
        ),
        submission_claim_id=header.submission_claim_id,
        intent_schema_version=header.intent_schema_version,
        canonical_intent_json=header.canonical_intent_json,
        canonical_intent_sha256=header.canonical_intent_sha256,
    )


def _recovery_handle_from_model(
    event: BrokerMutationReceiptEvent,
    *,
    receipt_id: uuid.UUID,
) -> BrokerMutationRecoveryHandle | None:
    recovery_token = event.recovery_token
    lease_metadata = (
        event.recovery_owner,
        event.recovery_writer_generation,
        event.recovery_lease_started_at,
        event.recovery_lease_expires_at,
    )
    if recovery_token is None:
        if int(event.recovery_epoch) != 0 or any(
            value is not None for value in lease_metadata
        ):
            raise BrokerMutationReceiptError("recovery_lease_metadata_invalid")
        return None
    if int(event.recovery_epoch) <= 0 or any(value is None for value in lease_metadata):
        raise BrokerMutationReceiptError("recovery_lease_metadata_invalid")
    recovery_owner = event.recovery_owner
    recovery_writer_generation = event.recovery_writer_generation
    recovery_lease_expires_at = event.recovery_lease_expires_at
    if (
        recovery_owner is None
        or recovery_writer_generation is None
        or recovery_lease_expires_at is None
    ):  # pragma: no cover - narrowed above; retained for strict typing
        raise BrokerMutationReceiptError("recovery_lease_metadata_invalid")
    return BrokerMutationRecoveryHandle(
        receipt_id=receipt_id,
        recovery_token=_database_uuid(recovery_token, field="recovery_token"),
        recovery_epoch=int(event.recovery_epoch),
        recovery_owner=recovery_owner,
        recovery_writer_generation=int(recovery_writer_generation),
        recovery_lease_expires_at=as_database_utc_datetime(
            recovery_lease_expires_at,
            field="recovery_lease_expires_at",
        ),
    )


def _optional_database_datetime(value: object | None, *, field: str) -> datetime | None:
    return as_database_utc_datetime(value, field=field) if value is not None else None


def _database_uuid(value: object, *, field: str) -> uuid.UUID:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise BrokerMutationReceiptError(f"database_{field}_invalid") from exc


def broker_mutation_identity_lock_keys(intent: BrokerMutationIntent) -> tuple[str, ...]:
    """Return every client, intent, and linked-claim identity for a mutation."""

    separator = "\x1f"
    keys = [
        "torghut:broker-mutation:client:"
        + separator.join(
            (
                intent.broker_route,
                intent.account_label,
                intent.endpoint_fingerprint,
                intent.operation,
                intent.client_request_id,
            )
        ),
        "torghut:broker-mutation:intent:"
        + separator.join(
            (
                intent.broker_route,
                intent.account_label,
                intent.endpoint_fingerprint,
                intent.canonical_intent_sha256,
            )
        ),
    ]
    if intent.submission_claim_id is not None:
        keys.extend(
            (
                f"torghut:submission:decision:{intent.submission_claim_id}",
                "torghut:submission:client:"
                + separator.join((intent.account_label, intent.client_request_id)),
            )
        )
    return tuple(sorted(keys))


def broker_mutation_receipt_lock_key(receipt_id: uuid.UUID | str) -> str:
    normalized_receipt_id = as_uuid(receipt_id, field="receipt_id")
    return f"torghut:broker-mutation:receipt:{normalized_receipt_id}"


def lock_broker_mutation_identities(
    session: Session,
    identity_keys: Sequence[str],
) -> None:
    """Acquire all transaction-scoped identity locks in database-defined order."""

    ordered_keys = tuple(sorted(set(identity_keys)))
    if not ordered_keys:
        return
    if any(not key or "\x00" in key for key in ordered_keys):
        raise BrokerMutationReceiptError("broker_mutation_identity_lock_key_invalid")
    dialect_name = _supported_dialect(session)
    if dialect_name == "sqlite":
        return
    session.execute(
        text(
            "SELECT torghut_lock_submission_identities(CAST(:identity_keys AS text[]))"
        ),
        {"identity_keys": list(ordered_keys)},
    )


def insert_receipt_header_if_absent(
    session: Session,
    *,
    receipt_id: uuid.UUID | str,
    intent: BrokerMutationIntent,
    creator_owner: str,
    origin_writer_generation: int,
) -> uuid.UUID | None:
    """Insert one immutable header, returning its ID only when this call won."""

    normalized_receipt_id = as_uuid(receipt_id, field="receipt_id")
    lock_broker_mutation_identities(
        session,
        (
            *broker_mutation_identity_lock_keys(intent),
            broker_mutation_receipt_lock_key(normalized_receipt_id),
        ),
    )
    values: dict[str, object] = {
        "id": normalized_receipt_id,
        "broker_route": intent.broker_route,
        "account_label": intent.account_label,
        "endpoint_fingerprint": intent.endpoint_fingerprint,
        "operation": intent.operation,
        "risk_class": intent.risk_class,
        "purpose": intent.purpose,
        "submission_claim_id": intent.submission_claim_id,
        "workflow_id": intent.workflow_id,
        "client_request_id": intent.client_request_id,
        "target_kind": intent.target.kind,
        "target_key": intent.target.key,
        "intent_schema_version": intent.intent_schema_version,
        "canonical_intent_json": intent.canonical_intent_json,
        "canonical_intent_sha256": intent.canonical_intent_sha256,
        "creator_owner": creator_owner,
        "origin_writer_generation": origin_writer_generation,
    }
    dialect_name = _supported_dialect(session)
    if dialect_name == "postgresql":
        statement = (
            postgresql_insert(BrokerMutationReceipt)
            .values(**values)
            .on_conflict_do_nothing()
            .returning(BrokerMutationReceipt.id)
        )
    else:
        statement = (
            sqlite_insert(BrokerMutationReceipt)
            .values(**values)
            .on_conflict_do_nothing()
            .returning(BrokerMutationReceipt.id)
        )
    inserted_id = session.execute(statement).scalar_one_or_none()
    return (
        _database_uuid(inserted_id, field="inserted_receipt_id")
        if inserted_id is not None
        else None
    )


def resolve_receipt_header(
    session: Session,
    *,
    intent: BrokerMutationIntent,
    for_update: bool = False,
) -> BrokerMutationReceipt | None:
    """Resolve client and intent identities to one exact immutable header."""

    lock_broker_mutation_identities(
        session,
        broker_mutation_identity_lock_keys(intent),
    )
    client_identity = and_(
        BrokerMutationReceipt.broker_route == intent.broker_route,
        BrokerMutationReceipt.account_label == intent.account_label,
        BrokerMutationReceipt.endpoint_fingerprint == intent.endpoint_fingerprint,
        BrokerMutationReceipt.operation == intent.operation,
        BrokerMutationReceipt.client_request_id == intent.client_request_id,
    )
    intent_identity = and_(
        BrokerMutationReceipt.broker_route == intent.broker_route,
        BrokerMutationReceipt.account_label == intent.account_label,
        BrokerMutationReceipt.endpoint_fingerprint == intent.endpoint_fingerprint,
        BrokerMutationReceipt.canonical_intent_sha256 == intent.canonical_intent_sha256,
    )
    statement = (
        select(BrokerMutationReceipt)
        .where(or_(client_identity, intent_identity))
        .execution_options(populate_existing=True)
    )
    candidates = list(session.execute(statement).scalars())
    if not candidates:
        return None
    if len(candidates) != 1:
        raise BrokerMutationReceiptConflictError(
            "broker_mutation_receipt_identity_split"
        )
    header = candidates[0]
    verify_receipt_header_identity(header, intent=intent)
    if for_update:
        locked_header = lock_receipt(session, header.id)
        if locked_header is None:  # pragma: no cover - immutable header cannot vanish
            raise BrokerMutationReceiptError("broker_mutation_receipt_not_found")
        verify_receipt_header_identity(locked_header, intent=intent)
        return locked_header
    return header


def verify_receipt_header_identity(
    header: BrokerMutationReceipt,
    *,
    intent: BrokerMutationIntent,
) -> None:
    """Reject a partial unique-key match or any immutable semantic drift."""

    expected = (
        intent.broker_route,
        intent.account_label,
        intent.endpoint_fingerprint,
        intent.operation,
        intent.risk_class,
        intent.purpose,
        intent.submission_claim_id,
        intent.workflow_id,
        intent.client_request_id,
        intent.target.kind,
        intent.target.key,
        intent.intent_schema_version,
        intent.canonical_intent_json,
        intent.canonical_intent_sha256,
    )
    observed = (
        header.broker_route,
        header.account_label,
        header.endpoint_fingerprint,
        header.operation,
        header.risk_class,
        header.purpose,
        header.submission_claim_id,
        header.workflow_id,
        header.client_request_id,
        header.target_kind,
        header.target_key,
        header.intent_schema_version,
        header.canonical_intent_json,
        header.canonical_intent_sha256,
    )
    if observed != expected:
        raise BrokerMutationReceiptConflictError(
            "broker_mutation_receipt_identity_conflict"
        )


def load_receipt_header(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> BrokerMutationReceipt | None:
    normalized_receipt_id = as_uuid(receipt_id, field="receipt_id")
    return session.execute(
        select(BrokerMutationReceipt)
        .where(BrokerMutationReceipt.id == normalized_receipt_id)
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()


def lock_receipt(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> BrokerMutationReceipt | None:
    """Take the receipt advisory lock before its relational row lock."""

    normalized_receipt_id = as_uuid(receipt_id, field="receipt_id")
    observed_header = load_receipt_header(session, normalized_receipt_id)
    if observed_header is None:
        return None
    lock_broker_mutation_identities(
        session,
        (
            *broker_mutation_identity_lock_keys(_intent_from_model(observed_header)),
            broker_mutation_receipt_lock_key(normalized_receipt_id),
        ),
    )
    return session.execute(
        select(BrokerMutationReceipt)
        .where(BrokerMutationReceipt.id == normalized_receipt_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()


def load_latest_receipt_event(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> BrokerMutationReceiptEvent | None:
    normalized_receipt_id = as_uuid(receipt_id, field="receipt_id")
    return session.execute(
        select(BrokerMutationReceiptEvent)
        .where(BrokerMutationReceiptEvent.receipt_id == normalized_receipt_id)
        .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
        .limit(1)
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()


def load_receipt_event_models(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> list[BrokerMutationReceiptEvent]:
    normalized_receipt_id = as_uuid(receipt_id, field="receipt_id")
    return list(
        session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == normalized_receipt_id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.asc())
            .execution_options(populate_existing=True)
        ).scalars()
    )


def load_receipt_snapshot(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> BrokerMutationReceiptSnapshot | None:
    header = load_receipt_header(session, receipt_id)
    if header is None:
        return None
    event = load_latest_receipt_event(session, header.id)
    if event is None:
        raise BrokerMutationReceiptError("broker_mutation_receipt_event_missing")
    return snapshot_from_models(header, event)


def load_receipt_event_history(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> list[BrokerMutationReceiptEventSnapshot]:
    header = load_receipt_header(session, receipt_id)
    if header is None:
        return []
    return [
        event_snapshot_from_models(header, event)
        for event in load_receipt_event_models(session, header.id)
    ]


def append_full_state_event(
    session: Session,
    *,
    receipt_id: uuid.UUID | str,
    values: Mapping[str, object],
    event_id: uuid.UUID | str | None = None,
) -> BrokerMutationReceiptEvent:
    """Append exactly one complete state snapshot and return the inserted row."""

    _supported_dialect(session)
    normalized_receipt_id = as_uuid(receipt_id, field="receipt_id")
    normalized_event_id = (
        uuid.uuid4() if event_id is None else as_uuid(event_id, field="event_id")
    )
    provided_fields = frozenset(values)
    if provided_fields != _EVENT_FULL_STATE_FIELDS:
        missing = sorted(_EVENT_FULL_STATE_FIELDS - provided_fields)
        unexpected = sorted(provided_fields - _EVENT_FULL_STATE_FIELDS)
        raise BrokerMutationReceiptError(
            "broker_mutation_receipt_event_not_full_state:"
            f"missing={','.join(missing)}:unexpected={','.join(unexpected)}"
        )
    if lock_receipt(session, normalized_receipt_id) is None:
        raise BrokerMutationReceiptError("broker_mutation_receipt_not_found")
    statement = (
        insert(BrokerMutationReceiptEvent)
        .values(
            id=normalized_event_id,
            receipt_id=normalized_receipt_id,
            **dict(values),
        )
        .returning(BrokerMutationReceiptEvent.id)
    )
    inserted_id = _database_uuid(
        session.execute(statement).scalar_one(),
        field="inserted_event_id",
    )
    if inserted_id != normalized_event_id:
        raise BrokerMutationReceiptError("broker_mutation_receipt_event_id_mismatch")
    event = session.execute(
        select(BrokerMutationReceiptEvent)
        .where(BrokerMutationReceiptEvent.id == inserted_id)
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if event is None:  # pragma: no cover - INSERT RETURNING proved the row exists
        raise BrokerMutationReceiptError("inserted_broker_mutation_event_not_found")
    return event


def close_read_transaction(session: Session) -> None:
    session.rollback()


def commit_or_rollback(session: Session) -> None:
    try:
        session.commit()
    except SQLAlchemyError:
        session.rollback()
        raise


def _supported_dialect(session: Session) -> str:
    dialect_name = session.get_bind().dialect.name
    if dialect_name not in {"postgresql", "sqlite"}:
        raise BrokerMutationReceiptError(
            f"broker_mutation_receipt_dialect_unsupported:{dialect_name}"
        )
    return dialect_name


__all__ = [
    "append_full_state_event",
    "as_database_utc_datetime",
    "broker_mutation_identity_lock_keys",
    "broker_mutation_receipt_lock_key",
    "close_read_transaction",
    "commit_or_rollback",
    "database_now",
    "event_snapshot_from_models",
    "insert_receipt_header_if_absent",
    "load_latest_receipt_event",
    "load_receipt_event_history",
    "load_receipt_event_models",
    "load_receipt_header",
    "load_receipt_snapshot",
    "lock_broker_mutation_identities",
    "lock_receipt",
    "resolve_receipt_header",
    "snapshot_from_models",
    "verify_receipt_header_identity",
]
