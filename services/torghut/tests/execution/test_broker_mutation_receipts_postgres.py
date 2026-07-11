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
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import BrokerMutationReceiptEvent
from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
    canonicalize_broker_mutation_evidence,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryAcquireResult,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlementRequest,
    acquire_broker_mutation_receipt,
    acquire_broker_mutation_recovery,
    build_broker_mutation_settlement,
    build_broker_mutation_recovery_observation,
    get_broker_mutation_receipt_history,
    list_due_broker_mutation_receipt_ids,
    mark_broker_mutation_io_started,
    record_broker_mutation_recovery_observation,
    release_broker_mutation_recovery,
    settle_broker_mutation_primary,
    settle_broker_mutation_recovery,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    commit_or_rollback,
    database_now,
    insert_receipt_header_if_absent,
    load_receipt_event_history,
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


def _force_recovery_due(schema_engine: Engine, receipt_id: uuid.UUID) -> None:
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "DISABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )
        connection.execute(
            text(
                """
                UPDATE broker_mutation_receipt_events
                   SET recovery_after = clock_timestamp() - interval '1 minute',
                       recovery_lease_started_at = CASE
                           WHEN recovery_epoch > 0
                           THEN clock_timestamp() - interval '2 minutes'
                           ELSE NULL
                       END,
                       recovery_lease_expires_at = CASE
                           WHEN recovery_epoch > 0
                           THEN clock_timestamp() - interval '1 minute'
                           ELSE NULL
                       END
                 WHERE id = (
                     SELECT id FROM broker_mutation_receipt_events
                      WHERE receipt_id = :receipt_id
                      ORDER BY sequence_no DESC
                      LIMIT 1
                 )
                """
            ),
            {"receipt_id": receipt_id},
        )
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "ENABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )


def _race_primary_acquisition(
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
) -> BrokerMutationReceiptAcquireResult:
    barrier = Barrier(2)
    tokens = (uuid.uuid4(), uuid.uuid4())

    def acquire(index: int) -> BrokerMutationReceiptAcquireResult:
        with sessions() as session:
            barrier.wait(timeout=10)
            return acquire_broker_mutation_receipt(
                session,
                intent=intent,
                primary_owner=f"writer-{index}",
                writer_generation=index,
                options=BrokerMutationReceiptAcquireOptions(
                    primary_token=tokens[index - 1],
                    lease_seconds=30,
                ),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(acquire, (1, 2)))
    assert sorted(result.outcome for result in results) == ["acquired", "busy"]
    assert len({result.receipt.receipt_id for result in results}) == 1
    return next(result for result in results if result.outcome == "acquired")


def _race_recovery_acquisition(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> BrokerMutationRecoveryHandle:
    barrier = Barrier(2)
    tokens = (uuid.uuid4(), uuid.uuid4())

    def acquire(index: int) -> BrokerMutationRecoveryAcquireResult:
        with sessions() as session:
            barrier.wait(timeout=10)
            return acquire_broker_mutation_recovery(
                session,
                receipt_id=receipt_id,
                recovery_owner=f"reader-{index}",
                writer_generation=index + 10,
                options=BrokerMutationRecoveryAcquireOptions(
                    recovery_token=tokens[index - 1],
                    lease_seconds=30,
                ),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(acquire, (1, 2)))
    assert sorted(result.outcome for result in results) == ["acquired", "busy"]
    winner = next(result for result in results if result.outcome == "acquired")
    assert winner.receipt is not None
    handle = winner.receipt.recovery_handle
    assert handle is not None
    return handle


def _advance_recovery_epoch(
    sessions: sessionmaker[Session],
    schema_engine: Engine,
    receipt_id: uuid.UUID,
    intent: BrokerMutationIntent,
    handle: BrokerMutationRecoveryHandle,
) -> BrokerMutationRecoveryHandle:
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=intent.client_request_id,
            checked_target_key=intent.target.key,
            outcome="not_found",
            evidence_payload={"broker_status": "not_found"},
        )
    )
    with sessions() as session:
        observed = record_broker_mutation_recovery_observation(
            session,
            handle=handle,
            observation=observation,
            retry_seconds=30,
        )
    assert observed.state == "broker_io"
    assert observed.recovery.outcome == "not_found"
    with sessions() as session:
        released = release_broker_mutation_recovery(session, handle=handle)
    assert released.state == "broker_io"
    _force_recovery_due(schema_engine, receipt_id)
    return _race_recovery_acquisition(sessions, receipt_id)


def _race_compatible_settlement(
    sessions: sessionmaker[Session],
    primary_handle: BrokerMutationReceiptHandle,
    recovery_handle: BrokerMutationRecoveryHandle,
) -> tuple[BrokerMutationReceiptSnapshot, BrokerMutationReceiptSnapshot]:
    primary_terminal = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference="broker-order-race",
            execution_id=None,
            evidence_payload={"source": "late_primary_response"},
        )
    )
    recovery_terminal = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="reconciled",
            broker_reference="broker-order-race",
            execution_id=None,
            evidence_payload={"source": "broker_lookup"},
        )
    )
    barrier = Barrier(2)

    def settle_primary() -> BrokerMutationReceiptSnapshot:
        with sessions() as session:
            barrier.wait(timeout=10)
            return settle_broker_mutation_primary(
                session,
                handle=primary_handle,
                settlement=primary_terminal,
            )

    def settle_recovery() -> BrokerMutationReceiptSnapshot:
        with sessions() as session:
            barrier.wait(timeout=10)
            return settle_broker_mutation_recovery(
                session,
                handle=recovery_handle,
                settlement=recovery_terminal,
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        primary_future = executor.submit(settle_primary)
        recovery_future = executor.submit(settle_recovery)
        return primary_future.result(), recovery_future.result()


def _persist_low_level_receipt(
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
) -> uuid.UUID:
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
    return receipt_id


def _append_low_level_broker_io(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> None:
    with sessions() as session:
        latest_id = session.execute(
            text(
                "SELECT id FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :id ORDER BY sequence_no DESC LIMIT 1"
            ),
            {"id": receipt_id},
        ).scalar_one()
        event = session.get(BrokerMutationReceiptEvent, latest_id)
        assert event is not None
        values = _copied_event_values(event)
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


def _race_incompatible_low_level_settlement(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> list[str]:
    barrier = Barrier(2)

    def settle(outcome: str) -> str:
        with sessions() as session:
            latest_id = session.execute(
                text(
                    "SELECT id FROM broker_mutation_receipt_events "
                    "WHERE receipt_id = :id ORDER BY sequence_no DESC LIMIT 1"
                ),
                {"id": receipt_id},
            ).scalar_one()
            event = session.get(BrokerMutationReceiptEvent, latest_id)
            assert event is not None
            values = _copied_event_values(event)
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
                append_full_state_event(session, receipt_id=receipt_id, values=values)
                commit_or_rollback(session)
            except DBAPIError:
                session.rollback()
                return "fenced"
            return "settled"

    with ThreadPoolExecutor(max_workers=2) as executor:
        return list(executor.map(settle, ("acknowledged", "reconciled")))


def _assert_receipt_indexes(schema_engine: Engine) -> None:
    inspector = inspect(schema_engine)
    assert {
        "uq_broker_mutation_receipt_client",
        "uq_broker_mutation_receipt_intent",
    }.issubset(
        {item["name"] for item in inspector.get_indexes("broker_mutation_receipts")}
    )
    assert "uq_broker_mutation_receipt_event_seq" in {
        item["name"] for item in inspector.get_indexes("broker_mutation_receipt_events")
    }


def _assert_lifecycle_terminal_history(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
    terminal_results: tuple[
        BrokerMutationReceiptSnapshot,
        BrokerMutationReceiptSnapshot,
    ],
) -> None:
    assert {result.lifecycle.sequence_no for result in terminal_results} == {7}
    assert len({result.settlement.outcome for result in terminal_results}) == 1
    with sessions() as session:
        history = get_broker_mutation_receipt_history(session, receipt_id)
        assert [event.event_type for event in history] == [
            "primary_claimed",
            "broker_io_started",
            "recovery_claimed",
            "recovery_observed",
            "recovery_released",
            "recovery_claimed",
            "settled",
        ]
        assert list_due_broker_mutation_receipt_ids(session) == ()


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

        _assert_receipt_indexes(schema_engine)

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
        receipt_id = _persist_low_level_receipt(sessions, intent)

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

        _append_low_level_broker_io(sessions, receipt_id)
        outcomes = _race_incompatible_low_level_settlement(sessions, receipt_id)
        assert sorted(outcomes) == ["fenced", "settled"]
        with sessions() as session:
            history = load_receipt_event_history(session, receipt_id)
            assert [event.sequence_no for event in history] == [1, 2, 3]
            assert history[-1].state == "settled"
        with pytest.raises(
            DBAPIError,
            match="refusing to downgrade nonempty broker mutation receipt audit state",
        ):
            command.downgrade(alembic, "0058_decision_submission_claims")
        assert inspect(schema_engine).has_table("broker_mutation_receipts")
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL receipt test",
)
def test_postgres_lifecycle_serializes_identity_recovery_and_terminal_races(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"mutation_lifecycle_{uuid.uuid4().hex}"
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

        decision_id = uuid.uuid4()
        client_request_id = "b" * 64
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
                workflow_id="workflow-race",
                client_request_id=client_request_id,
                target=BrokerMutationTarget(kind="order", key=client_request_id),
                request_payload={"symbol": "AAPL", "qty": Decimal("1")},
                submission_claim_id=decision_id,
            )
        )
        winner = _race_primary_acquisition(sessions, intent)
        primary_handle = winner.receipt.primary_handle
        receipt_id = winner.receipt.receipt_id
        with sessions() as session:
            broker_io = mark_broker_mutation_io_started(
                session,
                handle=primary_handle,
                recovery_seconds=30,
            )
        assert broker_io.state == "broker_io"
        _force_recovery_due(schema_engine, receipt_id)
        with sessions() as session:
            assert list_due_broker_mutation_receipt_ids(session) == (receipt_id,)
        recovery_handle = _race_recovery_acquisition(sessions, receipt_id)
        recovery_handle = _advance_recovery_epoch(
            sessions,
            schema_engine,
            receipt_id,
            intent,
            recovery_handle,
        )
        terminal_results = _race_compatible_settlement(
            sessions,
            primary_handle,
            recovery_handle,
        )
        _assert_lifecycle_terminal_history(sessions, receipt_id, terminal_results)
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL receipt test",
)
def test_postgres_empty_receipt_downgrade_is_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"mutation_downgrade_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
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
        command.downgrade(alembic, "0058_decision_submission_claims")

        inspector = inspect(schema_engine)
        assert not inspector.has_table("broker_mutation_receipts")
        assert not inspector.has_table("broker_mutation_receipt_events")
        assert inspector.has_table("trade_decision_submission_claims")
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
