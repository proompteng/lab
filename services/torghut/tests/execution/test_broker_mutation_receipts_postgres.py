from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from decimal import Decimal
from threading import Barrier

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import BrokerMutationReceiptEvent
from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
    canonicalize_broker_mutation_evidence,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    commit_or_rollback,
    database_now,
    insert_receipt_header_if_absent,
    load_receipt_event_history,
    load_receipt_snapshot,
)
from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    assert_rejected,
    create_parent_tables,
    insert_claimed,
    insert_decision,
)


def _initial_event_values(
    *,
    now: datetime,
    token: uuid.UUID,
) -> dict[str, object]:
    return {
        "sequence_no": 1,
        "event_type": "primary_claimed",
        "state": "claimed",
        "event_writer_generation": 1,
        "primary_token": token,
        "primary_epoch": 1,
        "primary_owner": "writer-a",
        "primary_writer_generation": 1,
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


def _copied_event_values(event: BrokerMutationReceiptEvent) -> dict[str, object]:
    return {
        column.name: getattr(event, column.name)
        for column in BrokerMutationReceiptEvent.__table__.columns
        if column.name not in {"id", "receipt_id", "recorded_at"}
    }


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL receipt test",
)
def test_postgres_receipts_are_immutable_contiguous_and_first_terminal_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"mutation_receipts_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0059_broker_mutation_receipts")

        inspector = inspect(schema_engine)
        assert {
            "uq_broker_mutation_receipt_client",
            "uq_broker_mutation_receipt_intent",
        }.issubset(
            {item["name"] for item in inspector.get_indexes("broker_mutation_receipts")}
        )
        assert "uq_broker_mutation_receipt_event_seq" in {
            item["name"]
            for item in inspector.get_indexes("broker_mutation_receipt_events")
        }

        decision_id = uuid.uuid4()
        client_request_id = "a" * 64
        with schema_engine.begin() as connection:
            insert_decision(
                connection,
                decision_id=decision_id,
                client_order_id=client_request_id,
            )
            insert_claimed(
                connection,
                decision_id=decision_id,
                client_order_id=client_request_id,
                claim_token=uuid.uuid4(),
            )

        intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint="a" * 64,
                operation="submit_order",
                risk_class="risk_increasing",
                purpose="initial_submission",
                workflow_id="workflow-1",
                client_request_id=client_request_id,
                target=BrokerMutationTarget(kind="order", key=client_request_id),
                request_payload={"symbol": "AAPL", "qty": Decimal("1")},
                submission_claim_id=decision_id,
            )
        )
        receipt_id = uuid.uuid4()
        with sessions() as session:
            assert (
                insert_receipt_header_if_absent(
                    session,
                    receipt_id=receipt_id,
                    intent=intent,
                    creator_owner="writer-a",
                    origin_writer_generation=1,
                )
                == receipt_id
            )
            now = database_now(session)
            append_full_state_event(
                session,
                receipt_id=receipt_id,
                values=_initial_event_values(now=now, token=uuid.uuid4()),
            )
            commit_or_rollback(session)

        assert_rejected(
            schema_engine,
            "UPDATE broker_mutation_receipts SET purpose = 'operator' WHERE id = :id",
            id=receipt_id,
        )
        assert_rejected(
            schema_engine,
            "DELETE FROM broker_mutation_receipt_events WHERE receipt_id = :id",
            id=receipt_id,
        )

        with sessions() as session:
            current = load_receipt_snapshot(session, receipt_id)
            assert current is not None
            latest = session.execute(
                text(
                    "SELECT id FROM broker_mutation_receipt_events "
                    "WHERE receipt_id = :id ORDER BY sequence_no DESC LIMIT 1"
                ),
                {"id": receipt_id},
            ).scalar_one()
            model = session.get(BrokerMutationReceiptEvent, latest)
            assert model is not None
            values = _copied_event_values(model)
            now = database_now(session)
            values.update(
                sequence_no=2,
                event_type="broker_io_started",
                state="broker_io",
                broker_io_started_at=now,
                recovery_after=now + timedelta(seconds=120),
            )
            append_full_state_event(session, receipt_id=receipt_id, values=values)
            commit_or_rollback(session)

        barrier = Barrier(2)

        def settle(outcome: str) -> str:
            with sessions() as session:
                latest = session.execute(
                    text(
                        "SELECT id FROM broker_mutation_receipt_events "
                        "WHERE receipt_id = :id ORDER BY sequence_no DESC LIMIT 1"
                    ),
                    {"id": receipt_id},
                ).scalar_one()
                model = session.get(BrokerMutationReceiptEvent, latest)
                assert model is not None
                values = _copied_event_values(model)
                evidence_json, evidence_sha256 = canonicalize_broker_mutation_evidence(
                    {"outcome": outcome, "broker_reference": "broker-order-1"}
                )
                values.update(
                    sequence_no=3,
                    event_type="settled",
                    state="settled",
                    settlement_source="primary",
                    settlement_outcome=outcome,
                    broker_reference="broker-order-1",
                    settlement_evidence_json=evidence_json,
                    settlement_evidence_sha256=evidence_sha256,
                    settled_at=database_now(session),
                )
                barrier.wait(timeout=10)
                try:
                    append_full_state_event(
                        session, receipt_id=receipt_id, values=values
                    )
                    commit_or_rollback(session)
                except DBAPIError:
                    session.rollback()
                    return "fenced"
                return "settled"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(settle, ("acknowledged", "reconciled")))
        assert sorted(outcomes) == ["fenced", "settled"]
        with sessions() as session:
            history = load_receipt_event_history(session, receipt_id)
            assert [event.sequence_no for event in history] == [1, 2, 3]
            assert history[-1].state == "settled"
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
