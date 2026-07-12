from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.trading.broker_mutation_receipts import (
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptAcquireResult,
    acquire_broker_mutation_receipt,
    mark_broker_mutation_io_started,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_parent_tables,
)
from tests.execution.test_broker_mutation_linked_receipts_postgres import (
    LinkedSubmitFixture,
    create_linked_submit_fixture,
)


@dataclass(frozen=True, slots=True)
class RecoveryHarness:
    engine: Engine
    sessions: sessionmaker[Session]
    alembic: AlembicConfig


def build_recovery_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[RecoveryHarness]:
    if POSTGRES_DSN is None:
        pytest.skip("set TORGHUT_TEST_POSTGRES_DSN for the opt-in recovery test")
    schema = f"linked_recovery_{uuid.uuid4().hex}"
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
        command.upgrade(alembic, "0062_linked_submission_recovery")
        yield RecoveryHarness(
            engine=schema_engine,
            sessions=sessions,
            alembic=alembic,
        )
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


def enter_linked_io(
    harness: RecoveryHarness,
) -> tuple[LinkedSubmitFixture, BrokerMutationReceiptAcquireResult]:
    fixture = create_linked_submit_fixture(harness.engine)
    with harness.sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=fixture.intent,
            primary_owner=fixture.claim_handle.claim_owner,
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                submission_claim_handle=fixture.claim_handle,
            ),
        )
    assert acquired.outcome == "acquired"
    with harness.sessions() as session:
        started = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            submission_claim_handle=fixture.claim_handle,
        )
    assert started.authorized
    return fixture, acquired


def force_linked_recovery_due(
    harness: RecoveryHarness,
    *,
    fixture: LinkedSubmitFixture,
    receipt_id: uuid.UUID,
) -> None:
    with harness.engine.begin() as connection:
        due_at = connection.execute(
            text("SELECT clock_timestamp() - interval '1 minute'")
        ).scalar_one()
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
                   SET recovery_after = :due_at
                 WHERE id = (
                     SELECT id FROM broker_mutation_receipt_events
                      WHERE receipt_id = :receipt_id
                      ORDER BY sequence_no DESC LIMIT 1
                 )
                """
            ),
            {"due_at": due_at, "receipt_id": receipt_id},
        )
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "ENABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "DISABLE TRIGGER trg_guard_td_submission_claim_0061_update"
            )
        )
        connection.execute(
            text(
                "UPDATE trade_decision_submission_claims "
                "SET recovery_after = :due_at "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"due_at": due_at, "decision_id": fixture.decision_id},
        )
        connection.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "ENABLE TRIGGER trg_guard_td_submission_claim_0061_update"
            )
        )
