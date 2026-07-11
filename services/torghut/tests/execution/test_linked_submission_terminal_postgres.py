from __future__ import annotations

import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from threading import Event
from unittest.mock import patch

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Connection
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.trading.broker_mutation_receipts import (
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptValidationError,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    acquire_broker_mutation_receipt,
    build_broker_mutation_settlement,
    build_linked_submission_terminal_settlement,
    get_broker_mutation_receipt_history,
    mark_broker_mutation_io_started,
    settle_linked_submission_primary,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    full_state_values_from_event,
    load_latest_receipt_event,
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
class _TerminalHarness:
    alembic: AlembicConfig
    engine: Engine
    sessions: sessionmaker[Session]


@pytest.fixture
def terminal_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[_TerminalHarness]:
    if POSTGRES_DSN is None:
        pytest.skip("set TORGHUT_TEST_POSTGRES_DSN for the opt-in terminal test")
    schema = f"linked_terminal_{uuid.uuid4().hex}"
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
        command.upgrade(alembic, "0061_linked_submission_terminal")
        yield _TerminalHarness(
            alembic=alembic,
            engine=schema_engine,
            sessions=sessions,
        )
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


def _enter_linked_io(
    harness: _TerminalHarness,
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


def _insert_execution(
    session: Session,
    *,
    fixture: LinkedSubmitFixture,
    execution_id: uuid.UUID,
    broker_order_id: str,
) -> None:
    session.execute(
        text(
            """
            INSERT INTO executions (
                id, trade_decision_id, alpaca_account_label,
                client_order_id, alpaca_order_id, status
            ) VALUES (
                :execution_id, :decision_id, 'paper',
                :client_order_id, :broker_order_id, 'accepted'
            )
            """
        ),
        {
            "execution_id": execution_id,
            "decision_id": fixture.decision_id,
            "client_order_id": fixture.claim_handle.client_order_id,
            "broker_order_id": broker_order_id,
        },
    )


def _success_settlement(
    fixture: LinkedSubmitFixture,
    *,
    execution_id: uuid.UUID,
    broker_order_id: str,
):
    return build_linked_submission_terminal_settlement(
        source="primary",
        outcome="acknowledged",
        claim_handle=fixture.claim_handle,
        broker_status="accepted",
        rejection_code=None,
        broker_reference=broker_order_id,
        execution_id=execution_id,
    )


def _assert_broker_io_without_terminal(
    harness: _TerminalHarness,
    *,
    fixture: LinkedSubmitFixture,
    acquired: BrokerMutationReceiptAcquireResult,
) -> None:
    with harness.engine.connect() as connection:
        claim = connection.execute(
            text(
                "SELECT state, completed_at, terminal_receipt_event_id "
                "FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).one()
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
        event_count = connection.execute(
            text(
                "SELECT count(*) FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :receipt_id"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).scalar_one()
    assert tuple(claim) == ("broker_io", None, None)
    assert execution_count == 0
    assert event_count == 2


def test_linked_primary_ack_commits_claim_receipt_execution_once(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "broker-order-ack"
    settlement = _success_settlement(
        fixture,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    with terminal_harness.sessions() as session:
        _insert_execution(
            session,
            fixture=fixture,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
        )
        terminal = settle_linked_submission_primary(
            session,
            handle=acquired.receipt.primary_handle,
            submission_claim_handle=fixture.claim_handle,
            settlement=settlement,
        )
    assert terminal.runtime_result == "submitted"
    assert terminal.submission_claim.state == "submitted"
    assert terminal.submission_claim.execution_id == execution_id
    assert terminal.submission_claim.terminal_receipt_event_id is not None
    assert terminal.receipt.settlement.execution_id == execution_id
    assert terminal.receipt.settlement.evidence_json == settlement.evidence_json
    assert terminal.receipt.settlement.evidence_sha256 == settlement.evidence_sha256
    assert (
        terminal.submission_claim.completed_at == terminal.receipt.settlement.settled_at
    )

    with terminal_harness.sessions() as session:
        repeated = settle_linked_submission_primary(
            session,
            handle=acquired.receipt.primary_handle,
            submission_claim_handle=fixture.claim_handle,
            settlement=settlement,
        )
        history = get_broker_mutation_receipt_history(
            session,
            acquired.receipt.receipt_id,
        )
    assert repeated == terminal
    assert [event.event_type for event in history] == [
        "primary_claimed",
        "broker_io_started",
        "settled",
    ]


def test_linked_primary_rejection_never_fabricates_execution(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    settlement = build_linked_submission_terminal_settlement(
        source="primary",
        outcome="rejected",
        claim_handle=fixture.claim_handle,
        broker_status="rejected",
        rejection_code="broker_rejected",
        broker_reference=None,
        execution_id=None,
    )
    with terminal_harness.sessions() as session:
        terminal = settle_linked_submission_primary(
            session,
            handle=acquired.receipt.primary_handle,
            submission_claim_handle=fixture.claim_handle,
            settlement=settlement,
        )
    assert terminal.runtime_result == "rejected"
    assert terminal.submission_claim.state == "rejected"
    assert terminal.submission_claim.execution_id is None
    assert terminal.receipt.settlement.execution_id is None
    assert terminal.submission_claim.terminal_receipt_event_id is not None
    with terminal_harness.engine.connect() as connection:
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert execution_count == 0

    drift = build_linked_submission_terminal_settlement(
        source="primary",
        outcome="rejected",
        claim_handle=fixture.claim_handle,
        broker_status="rejected",
        rejection_code="risk_rejected",
        broker_reference=None,
        execution_id=None,
    )
    with terminal_harness.sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptConflictError,
            match="broker_mutation_terminal_conflict",
        ):
            settle_linked_submission_primary(
                session,
                handle=acquired.receipt.primary_handle,
                submission_claim_handle=fixture.claim_handle,
                settlement=drift,
            )


def test_linked_terminal_receipt_failure_rolls_back_all_three_writes(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "broker-order-rollback"
    settlement = _success_settlement(
        fixture,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    with terminal_harness.engine.begin() as connection:
        connection.execute(
            text(
                "CREATE FUNCTION torghut_test_fail_terminal() RETURNS trigger "
                "LANGUAGE plpgsql AS $$ BEGIN "
                "IF NEW.event_type = 'settled' THEN "
                "RAISE EXCEPTION 'injected terminal append failure'; END IF; "
                "RETURN NEW; END; $$"
            )
        )
        connection.execute(
            text(
                "CREATE TRIGGER trg_test_fail_terminal BEFORE INSERT "
                "ON broker_mutation_receipt_events FOR EACH ROW "
                "EXECUTE FUNCTION torghut_test_fail_terminal()"
            )
        )
    with terminal_harness.sessions() as session:
        _insert_execution(
            session,
            fixture=fixture,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
        )
        with pytest.raises(DBAPIError, match="injected terminal append failure"):
            settle_linked_submission_primary(
                session,
                handle=acquired.receipt.primary_handle,
                submission_claim_handle=fixture.claim_handle,
                settlement=settlement,
            )
        assert not session.in_transaction()
    _assert_broker_io_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    with terminal_harness.engine.begin() as connection:
        connection.execute(
            text(
                "DROP TRIGGER trg_test_fail_terminal ON broker_mutation_receipt_events"
            )
        )
        connection.execute(text("DROP FUNCTION torghut_test_fail_terminal()"))


@pytest.mark.parametrize("failure_point", ["append", "commit"])
def test_linked_terminal_unexpected_failure_rolls_back_everything(
    terminal_harness: _TerminalHarness,
    failure_point: str,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    execution_id = uuid.uuid4()
    broker_order_id = f"broker-order-{failure_point}"
    settlement = _success_settlement(
        fixture,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    patch_target = "app.trading.broker_mutation_receipts.linked_terminal." + (
        "append_full_state_event" if failure_point == "append" else "commit_or_rollback"
    )
    with terminal_harness.sessions() as session:
        _insert_execution(
            session,
            fixture=fixture,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
        )
        with patch(patch_target, side_effect=RuntimeError(f"injected {failure_point}")):
            with pytest.raises(RuntimeError, match=f"injected {failure_point}"):
                settle_linked_submission_primary(
                    session,
                    handle=acquired.receipt.primary_handle,
                    submission_claim_handle=fixture.claim_handle,
                    settlement=settlement,
                )
        assert not session.in_transaction()
    _assert_broker_io_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )


def test_linked_success_requires_exact_existing_execution(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    settlement = _success_settlement(
        fixture,
        execution_id=uuid.uuid4(),
        broker_order_id="missing-execution",
    )
    with terminal_harness.sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptValidationError,
            match="linked_submission_execution_invalid:execution_not_found",
        ):
            settle_linked_submission_primary(
                session,
                handle=acquired.receipt.primary_handle,
                submission_claim_handle=fixture.claim_handle,
                settlement=settlement,
            )
    _assert_broker_io_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )


def test_postgres_0061_rejects_each_standalone_terminal_half(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "raw-half"
    rejected_settlement = build_linked_submission_terminal_settlement(
        source="primary",
        outcome="rejected",
        claim_handle=fixture.claim_handle,
        broker_status="rejected",
        rejection_code="raw_rejected",
        broker_reference=None,
        execution_id=None,
    )

    with pytest.raises(DBAPIError, match="linked nonterminal state is asymmetric"):
        with terminal_harness.engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO executions (
                        id, trade_decision_id, alpaca_account_label,
                        client_order_id, alpaca_order_id, status
                    ) VALUES (
                        :execution_id, :decision_id, 'paper',
                        :client_order_id, :broker_order_id, 'accepted'
                    )
                    """
                ),
                {
                    "execution_id": execution_id,
                    "decision_id": fixture.decision_id,
                    "client_order_id": fixture.claim_handle.client_order_id,
                    "broker_order_id": broker_order_id,
                },
            )

    with terminal_harness.sessions() as session:
        current = load_latest_receipt_event(
            session,
            acquired.receipt.receipt_id,
        )
        assert current is not None
        values = full_state_values_from_event(current)
        values.update(
            sequence_no=current.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=1,
            settlement_source=rejected_settlement.source,
            settlement_outcome=rejected_settlement.outcome,
            broker_reference=rejected_settlement.broker_reference,
            execution_id=rejected_settlement.execution_id,
            settlement_evidence_json=rejected_settlement.evidence_json,
            settlement_evidence_sha256=rejected_settlement.evidence_sha256,
            settled_at=current.recorded_at,
        )
        append_full_state_event(
            session,
            receipt_id=acquired.receipt.receipt_id,
            values=values,
        )
        with pytest.raises(DBAPIError, match="linked nonterminal state is asymmetric"):
            session.commit()
        session.rollback()

    with pytest.raises(DBAPIError, match="linked claim terminal state is invalid"):
        with terminal_harness.engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO executions (
                        id, trade_decision_id, alpaca_account_label,
                        client_order_id, alpaca_order_id, status
                    ) VALUES (
                        :execution_id, :decision_id, 'paper',
                        :client_order_id, :broker_order_id, 'accepted'
                    )
                    """
                ),
                {
                    "execution_id": execution_id,
                    "decision_id": fixture.decision_id,
                    "client_order_id": fixture.claim_handle.client_order_id,
                    "broker_order_id": broker_order_id,
                },
            )
            connection.execute(
                text(
                    """
                    UPDATE trade_decision_submission_claims
                       SET state = 'submitted', broker_order_id = :broker_order_id,
                           broker_client_order_id = :client_order_id,
                           execution_id = :execution_id, completed_at = now()
                     WHERE trade_decision_id = :decision_id
                    """
                ),
                {
                    "execution_id": execution_id,
                    "decision_id": fixture.decision_id,
                    "client_order_id": fixture.claim_handle.client_order_id,
                    "broker_order_id": broker_order_id,
                },
            )
    _assert_broker_io_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )


def test_postgres_0061_catalog_has_deferred_triangle_guards(
    terminal_harness: _TerminalHarness,
) -> None:
    with terminal_harness.engine.connect() as connection:
        column = connection.execute(
            text(
                """
                SELECT is_nullable
                  FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'trade_decision_submission_claims'
                   AND column_name = 'terminal_receipt_event_id'
                """
            )
        ).scalar_one()
        foreign_key = connection.execute(
            text(
                """
                SELECT confdeltype, confupdtype
                  FROM pg_constraint
                 WHERE conname = 'fk_td_submission_claim_terminal_receipt_event'
                """
            )
        ).one()
        index_is_unique = connection.execute(
            text(
                """
                SELECT indisunique
                  FROM pg_index
                 WHERE indexrelid =
                     'uq_trade_decision_submission_terminal_receipt_event'::regclass
                """
            )
        ).scalar_one()
        triggers = connection.execute(
            text(
                """
                SELECT tgname, tgdeferrable, tginitdeferred
                  FROM pg_trigger
                 WHERE tgname IN (
                     'trg_check_submission_claim_terminal_0061',
                     'trg_check_bm_event_terminal_0061',
                     'trg_check_execution_terminal_0061'
                 )
                 ORDER BY tgname
                """
            )
        ).all()
    assert column == "YES"
    assert tuple(foreign_key) == ("r", "r")
    assert index_is_unique is True
    assert len(triggers) == 3
    assert all(
        deferrable and initially_deferred
        for _, deferrable, initially_deferred in triggers
    )


def test_postgres_0061_linked_recovery_terminal_remains_fail_closed(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    recovery_terminal = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="rejected",
            broker_reference=None,
            execution_id=None,
            evidence_payload={
                "schema_version": "torghut.linked-submission-terminal.v1",
                "decision_id": str(fixture.decision_id),
                "account_label": fixture.claim_handle.account_label,
                "client_order_id": fixture.claim_handle.client_order_id,
                "broker_status": "rejected",
                "rejection_code": "recovery_rejected",
            },
        )
    )
    with terminal_harness.sessions() as session:
        current = load_latest_receipt_event(
            session,
            acquired.receipt.receipt_id,
        )
        assert current is not None
        values = full_state_values_from_event(current)
        values.update(
            sequence_no=current.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=1,
            settlement_source=recovery_terminal.source,
            settlement_outcome=recovery_terminal.outcome,
            broker_reference=None,
            execution_id=None,
            settlement_evidence_json=recovery_terminal.evidence_json,
            settlement_evidence_sha256=recovery_terminal.evidence_sha256,
            settled_at=current.recorded_at,
        )
        with pytest.raises(DBAPIError, match="invalid broker mutation settlement"):
            append_full_state_event(
                session,
                receipt_id=acquired.receipt.receipt_id,
                values=values,
            )
        session.rollback()
    _assert_broker_io_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )


def test_postgres_0061_empty_downgrade_restores_0060_guards(
    terminal_harness: _TerminalHarness,
) -> None:
    command.downgrade(
        terminal_harness.alembic,
        "0060_bm_evidence_envelopes",
    )
    with terminal_harness.engine.connect() as connection:
        revision = connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one()
        terminal_column_count = connection.execute(
            text(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'trade_decision_submission_claims'
                   AND column_name = 'terminal_receipt_event_id'
                """
            )
        ).scalar_one()
        restored_triggers = (
            connection.execute(
                text(
                    """
                SELECT tgname FROM pg_trigger
                 WHERE tgname IN (
                     'trg_guard_td_submission_claim',
                     'trg_guard_bm_receipt_event_b_linked_0060',
                     'trg_guard_bm_receipt_event_c_settlement_0060'
                 )
                """
                )
            )
            .scalars()
            .all()
        )
    assert revision == "0060_bm_evidence_envelopes"
    assert terminal_column_count == 0
    assert set(restored_triggers) == {
        "trg_guard_td_submission_claim",
        "trg_guard_bm_receipt_event_b_linked_0060",
        "trg_guard_bm_receipt_event_c_settlement_0060",
    }
    command.upgrade(
        terminal_harness.alembic,
        "0061_linked_submission_terminal",
    )


def test_postgres_0061_refuses_nonempty_downgrade_without_state_change(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, _ = _enter_linked_io(terminal_harness)
    with pytest.raises(DBAPIError) as refusal:
        command.downgrade(
            terminal_harness.alembic,
            "0060_bm_evidence_envelopes",
        )
    assert getattr(refusal.value.orig, "sqlstate", None) == "55000"
    with terminal_harness.engine.connect() as connection:
        revision = connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one()
        state = connection.execute(
            text(
                "SELECT state FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert revision == "0061_linked_submission_terminal"
    assert state == "broker_io"


def test_linked_exact_primary_terminal_race_converges_to_one_event(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "race-converges"
    settlement = _success_settlement(
        fixture,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    terminal_inserted = Event()
    release_winner = Event()

    def pause_winner_after_terminal_insert(
        _connection: Connection,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if (
            "INSERT INTO broker_mutation_receipt_events" in statement
            and not terminal_inserted.is_set()
        ):
            terminal_inserted.set()
            assert release_winner.wait(timeout=10)

    def winner():
        with terminal_harness.sessions() as session:
            _insert_execution(
                session,
                fixture=fixture,
                execution_id=execution_id,
                broker_order_id=broker_order_id,
            )
            return settle_linked_submission_primary(
                session,
                handle=acquired.receipt.primary_handle,
                submission_claim_handle=fixture.claim_handle,
                settlement=settlement,
            )

    def retry():
        with terminal_harness.sessions() as session:
            return settle_linked_submission_primary(
                session,
                handle=acquired.receipt.primary_handle,
                submission_claim_handle=fixture.claim_handle,
                settlement=settlement,
            )

    event.listen(
        terminal_harness.engine,
        "after_cursor_execute",
        pause_winner_after_terminal_insert,
    )
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            winner_future = executor.submit(winner)
            assert terminal_inserted.wait(timeout=10)
            retry_future = executor.submit(retry)
            with pytest.raises(FutureTimeoutError):
                retry_future.result(timeout=0.2)
            release_winner.set()
            winner_result = winner_future.result(timeout=10)
            retry_result = retry_future.result(timeout=10)
    finally:
        release_winner.set()
        event.remove(
            terminal_harness.engine,
            "after_cursor_execute",
            pause_winner_after_terminal_insert,
        )
    assert winner_result == retry_result
    with terminal_harness.sessions() as session:
        history = get_broker_mutation_receipt_history(
            session,
            acquired.receipt.receipt_id,
        )
    assert [item.event_type for item in history] == [
        "primary_claimed",
        "broker_io_started",
        "settled",
    ]


def test_linked_rejection_race_preserves_first_terminal_evidence(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)
    first = build_linked_submission_terminal_settlement(
        source="primary",
        outcome="rejected",
        claim_handle=fixture.claim_handle,
        broker_status="rejected",
        rejection_code="first_rejection",
        broker_reference=None,
        execution_id=None,
    )
    conflicting = build_linked_submission_terminal_settlement(
        source="primary",
        outcome="rejected",
        claim_handle=fixture.claim_handle,
        broker_status="rejected",
        rejection_code="second_rejection",
        broker_reference=None,
        execution_id=None,
    )
    terminal_inserted = Event()
    release_winner = Event()

    def pause_winner_after_terminal_insert(
        _connection: Connection,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if (
            "INSERT INTO broker_mutation_receipt_events" in statement
            and not terminal_inserted.is_set()
        ):
            terminal_inserted.set()
            assert release_winner.wait(timeout=10)

    def settle(request: BrokerMutationSettlement):
        with terminal_harness.sessions() as session:
            return settle_linked_submission_primary(
                session,
                handle=acquired.receipt.primary_handle,
                submission_claim_handle=fixture.claim_handle,
                settlement=request,
            )

    event.listen(
        terminal_harness.engine,
        "after_cursor_execute",
        pause_winner_after_terminal_insert,
    )
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            winner_future = executor.submit(settle, first)
            assert terminal_inserted.wait(timeout=10)
            conflict_future = executor.submit(settle, conflicting)
            with pytest.raises(FutureTimeoutError):
                conflict_future.result(timeout=0.2)
            release_winner.set()
            winner = winner_future.result(timeout=10)
            with pytest.raises(BrokerMutationReceiptConflictError):
                conflict_future.result(timeout=10)
    finally:
        release_winner.set()
        event.remove(
            terminal_harness.engine,
            "after_cursor_execute",
            pause_winner_after_terminal_insert,
        )
    assert winner.receipt.settlement.evidence_sha256 == first.evidence_sha256
    with terminal_harness.sessions() as session:
        history = get_broker_mutation_receipt_history(
            session,
            acquired.receipt.receipt_id,
        )
    assert len(history) == 3
