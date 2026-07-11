from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base
from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    broker_mutation_identity_lock_keys,
    commit_or_rollback,
    database_now,
    insert_receipt_header_if_absent,
    load_receipt_event_history,
    load_receipt_snapshot,
    resolve_receipt_header,
)
from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
)
from app.trading.broker_mutation_receipts.validation import (
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptError,
)


def _sessions(database_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite+pysqlite:///{database_path}", future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )


def _cancel_intent(*, target_key: str = "order-1") -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation="cancel_order",
            risk_class="risk_neutral",
            purpose="operator",
            workflow_id="workflow-1",
            client_request_id="cancel-request-1",
            target=BrokerMutationTarget(kind="order", key=target_key),
            request_payload={"broker_order_id": target_key},
        )
    )


def _initial_event(now: datetime, token: uuid.UUID) -> dict[str, object]:
    return {
        "sequence_no": 1,
        "event_type": "primary_claimed",
        "state": "claimed",
        "event_writer_generation": 7,
        "primary_token": token,
        "primary_epoch": 1,
        "primary_owner": "writer-a",
        "primary_writer_generation": 7,
        "primary_claimed_at": now,
        "primary_lease_expires_at": now + timedelta(seconds=30),
        "released_at": None,
        "release_reason": None,
        "broker_io_started_at": None,
        "recovery_after": None,
        "recovery_token": None,
        "recovery_epoch": 0,
        "recovery_owner": None,
        "recovery_writer_generation": None,
        "recovery_lease_started_at": None,
        "recovery_lease_expires_at": None,
        "recovery_checked_at": None,
        "recovery_observation_epoch": None,
        "recovery_outcome": None,
        "settlement_source": None,
        "settlement_outcome": None,
        "broker_reference": None,
        "execution_id": None,
        "recovery_evidence_json": None,
        "recovery_evidence_sha256": None,
        "settlement_evidence_json": None,
        "settlement_evidence_sha256": None,
        "settled_at": None,
    }


def test_sqlite_persistence_round_trip_and_exact_identity_conflict(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "receipts.sqlite")
    intent = _cancel_intent()
    receipt_id = uuid.uuid4()
    primary_token = uuid.uuid4()

    with sessions() as session:
        assert (
            insert_receipt_header_if_absent(
                session,
                receipt_id=receipt_id,
                intent=intent,
                creator_owner="writer-a",
                origin_writer_generation=7,
            )
            == receipt_id
        )
        now = database_now(session)
        append_full_state_event(
            session,
            receipt_id=receipt_id,
            values=_initial_event(now, primary_token),
        )
        commit_or_rollback(session)

    with sessions() as session:
        snapshot = load_receipt_snapshot(session, receipt_id)
        assert snapshot is not None
        assert snapshot.intent == intent
        assert snapshot.primary_handle.primary_token == primary_token
        assert snapshot.primary_handle.primary_writer_generation == 7
        assert snapshot.lifecycle.sequence_no == 1
        assert snapshot.created_at.tzinfo == timezone.utc
        assert snapshot.lifecycle.primary_claimed_at.tzinfo == timezone.utc
        assert [
            event.sequence_no
            for event in load_receipt_event_history(session, receipt_id)
        ] == [1]

    with sessions() as session:
        assert (
            insert_receipt_header_if_absent(
                session,
                receipt_id=uuid.uuid4(),
                intent=intent,
                creator_owner="writer-b",
                origin_writer_generation=8,
            )
            is None
        )
        resolved = resolve_receipt_header(session, intent=intent)
        assert resolved is not None
        assert resolved.id == receipt_id
        session.rollback()

    conflicting_intent = _cancel_intent(target_key="order-2")
    with sessions() as session:
        assert (
            insert_receipt_header_if_absent(
                session,
                receipt_id=uuid.uuid4(),
                intent=conflicting_intent,
                creator_owner="writer-b",
                origin_writer_generation=8,
            )
            is None
        )
        with pytest.raises(
            BrokerMutationReceiptConflictError,
            match="identity_conflict",
        ):
            resolve_receipt_header(session, intent=conflicting_intent)
        session.rollback()


def test_event_append_requires_every_full_state_field(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "full-state.sqlite")
    intent = _cancel_intent()
    receipt_id = uuid.uuid4()

    with sessions() as session:
        insert_receipt_header_if_absent(
            session,
            receipt_id=receipt_id,
            intent=intent,
            creator_owner="writer-a",
            origin_writer_generation=7,
        )
        with pytest.raises(
            BrokerMutationReceiptError,
            match="event_not_full_state",
        ):
            append_full_state_event(
                session,
                receipt_id=receipt_id,
                values={"sequence_no": 1},
            )
        session.rollback()


def test_identity_lock_keys_are_stable_sorted_and_credential_free() -> None:
    intent = _cancel_intent()

    keys = broker_mutation_identity_lock_keys(intent)

    assert keys == tuple(sorted(keys))
    assert keys == (
        "torghut:broker-mutation:client:alpaca\x1fpaper\x1f"
        + ("a" * 64)
        + "\x1fcancel_order\x1fcancel-request-1",
        "torghut:broker-mutation:intent:alpaca\x1fpaper\x1f"
        + ("a" * 64)
        + "\x1f"
        + intent.canonical_intent_sha256,
    )
