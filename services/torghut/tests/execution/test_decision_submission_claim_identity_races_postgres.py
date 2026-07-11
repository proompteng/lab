from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timedelta, timezone
from threading import Barrier, Event

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import event, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.trading.decision_submission_claims import (
    DecisionSubmissionClaimResult,
    DecisionSubmissionClaimSnapshot,
    acquire_decision_submission_claim,
    mark_decision_submission_broker_io_started,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    assert_rejected as _assert_rejected,
    create_schema_engines,
    drop_schema,
    enter_broker_io as _enter_broker_io,
    insert_claimed as _insert_claimed,
    insert_decision as _insert_decision,
)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for PostgreSQL identity race tests",
)
def test_postgres_submission_claim_identity_races(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "claim_identity_races"
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0058_decision_submission_claims")
        _assert_app_acquire_locks_before_parent(schema_engine)
        _assert_app_boundary_locks_before_parent(schema_engine)
        _assert_partial_identity_guards(schema_engine)
        _assert_preclaim_advisory_lock_orderings(schema_engine)
        _assert_cross_decision_identity_race(schema_engine)
        _assert_parent_and_execution_lock_races(schema_engine)
        _assert_late_primary_recovery_no_deadlock(schema_engine)
        _assert_execution_status_update_terminal_no_deadlock(schema_engine)
    finally:
        drop_schema(schema, admin_engine, schema_engine)


def _assert_app_acquire_locks_before_parent(engine: Engine) -> None:
    decision_id = uuid.uuid4()
    execution_id = uuid.uuid4()
    client_order_id = "x" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
        )
    identity_locked = Event()
    release_acquire = Event()

    def pause_after_lock(
        _connection: Connection,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if "torghut_lock_submission_identities" in statement:
            identity_locked.set()
            assert release_acquire.wait(timeout=10)

    sessions = sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )

    def acquire_claim() -> DecisionSubmissionClaimResult:
        with sessions() as session:
            return acquire_decision_submission_claim(
                session,
                decision_id=decision_id,
                client_order_id=client_order_id,
                claim_owner="app-acquire",
            )

    def insert_execution() -> None:
        with engine.begin() as connection:
            _insert_exact_execution(
                connection,
                execution_id=execution_id,
                decision_id=decision_id,
                client_order_id=client_order_id,
                broker_order_id="app-acquire-race",
            )

    event.listen(engine, "after_cursor_execute", pause_after_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            acquire_future = executor.submit(acquire_claim)
            try:
                assert identity_locked.wait(timeout=10)
                execution_future = executor.submit(insert_execution)
                with pytest.raises(FutureTimeoutError):
                    execution_future.result(timeout=0.5)
                release_acquire.set()
                acquired = acquire_future.result(timeout=10)
                assert acquired.outcome == "acquired"
                with pytest.raises(DBAPIError) as rejected_execution:
                    execution_future.result(timeout=10)
                assert (
                    getattr(rejected_execution.value.orig, "sqlstate", None) == "23514"
                )
            finally:
                release_acquire.set()
    finally:
        event.remove(engine, "after_cursor_execute", pause_after_lock)


def _assert_app_boundary_locks_before_parent(engine: Engine) -> None:
    decision_id = uuid.uuid4()
    execution_id = uuid.uuid4()
    client_order_id = "y" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
        )
    sessions = sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )
    with sessions() as session:
        acquired = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="app-boundary",
        )
    assert acquired.claim is not None
    handle = acquired.claim.handle
    identity_locked = Event()
    release_boundary = Event()

    def pause_after_lock(
        _connection: Connection,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if "torghut_lock_submission_identities" in statement:
            identity_locked.set()
            assert release_boundary.wait(timeout=10)

    def enter_boundary() -> DecisionSubmissionClaimSnapshot:
        with sessions() as session:
            result = mark_decision_submission_broker_io_started(
                session,
                handle=handle,
            )
            assert result.transitioned
            return result.claim

    def insert_execution() -> None:
        with engine.begin() as connection:
            _insert_exact_execution(
                connection,
                execution_id=execution_id,
                decision_id=decision_id,
                client_order_id=client_order_id,
                broker_order_id="app-boundary-race",
            )

    event.listen(engine, "after_cursor_execute", pause_after_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            boundary_future = executor.submit(enter_boundary)
            try:
                assert identity_locked.wait(timeout=10)
                execution_future = executor.submit(insert_execution)
                with pytest.raises(FutureTimeoutError):
                    execution_future.result(timeout=0.5)
                release_boundary.set()
                boundary = boundary_future.result(timeout=10)
                assert boundary.state == "broker_io"
                execution_future.result(timeout=10)
            finally:
                release_boundary.set()
    finally:
        event.remove(engine, "after_cursor_execute", pause_after_lock)
    with engine.connect() as connection:
        execution_count = connection.execute(
            text("SELECT count(*) FROM executions WHERE id = :id"),
            {"id": execution_id},
        ).scalar_one()
    assert execution_count == 1


def _insert_exact_execution(
    connection: Connection,
    *,
    execution_id: uuid.UUID,
    decision_id: uuid.UUID,
    client_order_id: str,
    broker_order_id: str,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO executions (
                id, trade_decision_id, alpaca_account_label,
                client_order_id, alpaca_order_id
            ) VALUES (
                :execution_id, :decision_id, 'paper',
                :client_order_id, :broker_order_id
            )
            """
        ),
        {
            "execution_id": execution_id,
            "decision_id": decision_id,
            "client_order_id": client_order_id,
            "broker_order_id": broker_order_id,
        },
    )


def _assert_partial_identity_guards(engine: Engine) -> None:
    decision_match_claim = uuid.uuid4()
    pair_match_claim = uuid.uuid4()
    pair_source_decision = uuid.uuid4()
    mutation_claim = uuid.uuid4()
    mutation_source_decision = uuid.uuid4()
    decision_mutation_execution = uuid.uuid4()
    mutation_execution = uuid.uuid4()
    with engine.begin() as connection:
        for decision_id, marker in (
            (decision_match_claim, "l"),
            (pair_match_claim, "m"),
            (pair_source_decision, "n"),
            (mutation_claim, "o"),
            (mutation_source_decision, "p"),
        ):
            _insert_decision(
                connection,
                decision_id=decision_id,
                client_order_id=marker * 64,
            )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :id, :decision_id, 'wrong-account',
                    'wrong-client-l', 'decision-mutation-source'
                )
                """
            ),
            {
                "id": decision_mutation_execution,
                "decision_id": pair_source_decision,
            },
        )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :id, :decision_id, 'wrong-account',
                    'wrong-client-o', 'mutation-source'
                )
                """
            ),
            {
                "id": mutation_execution,
                "decision_id": mutation_source_decision,
            },
        )
        for decision_id, marker in (
            (decision_match_claim, "l"),
            (pair_match_claim, "m"),
            (mutation_claim, "o"),
        ):
            _insert_claimed(
                connection,
                decision_id=decision_id,
                client_order_id=marker * 64,
                claim_token=uuid.uuid4(),
            )
    _assert_rejected(
        engine,
        """
        INSERT INTO executions (
            id, trade_decision_id, alpaca_account_label,
            client_order_id, alpaca_order_id
        ) VALUES (
            :id, :decision_id, 'wrong-account',
            'wrong-client-l', 'partial-decision'
        )
        """,
        id=uuid.uuid4(),
        decision_id=decision_match_claim,
    )
    _assert_rejected(
        engine,
        """
        INSERT INTO executions (
            id, trade_decision_id, alpaca_account_label,
            client_order_id, alpaca_order_id
        ) VALUES (
            :id, :decision_id, 'paper', :client_order_id, 'partial-pair'
        )
        """,
        id=uuid.uuid4(),
        decision_id=pair_source_decision,
        client_order_id="m" * 64,
    )
    _assert_rejected(
        engine,
        """
        UPDATE executions
           SET trade_decision_id = :decision_id
         WHERE id = :id
        """,
        id=decision_mutation_execution,
        decision_id=decision_match_claim,
    )
    _assert_rejected(
        engine,
        """
        UPDATE executions
           SET alpaca_account_label = 'paper', client_order_id = :client_order_id
         WHERE id = :id
        """,
        id=mutation_execution,
        client_order_id="o" * 64,
    )


def _assert_preclaim_advisory_lock_orderings(engine: Engine) -> None:
    _assert_execution_identity_wins_before_claim(engine)
    _assert_claim_identity_wins_before_execution(engine)


def _assert_execution_identity_wins_before_claim(engine: Engine) -> None:
    claim_decision = uuid.uuid4()
    source_decision = uuid.uuid4()
    execution_id = uuid.uuid4()
    client_order_id = "s" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=claim_decision,
            client_order_id=client_order_id,
        )
        _insert_decision(
            connection,
            decision_id=source_decision,
            client_order_id="t" * 64,
        )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :id, :decision_id, 'wrong-account', 'wrong-client-s', 'preclaim-source'
                )
                """
            ),
            {"id": execution_id, "decision_id": source_decision},
        )
    execution_connection = engine.connect()
    execution_transaction = execution_connection.begin()
    try:
        execution_connection.execute(
            text(
                """
                UPDATE executions
                   SET alpaca_account_label = 'paper',
                       client_order_id = :client_order_id
                 WHERE id = :id
                """
            ),
            {"id": execution_id, "client_order_id": client_order_id},
        )

        def insert_claim() -> None:
            with engine.begin() as connection:
                _insert_claimed(
                    connection,
                    decision_id=claim_decision,
                    client_order_id=client_order_id,
                    claim_token=uuid.uuid4(),
                )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(insert_claim)
            with pytest.raises(FutureTimeoutError):
                future.result(timeout=0.5)
            execution_transaction.commit()
            with pytest.raises(DBAPIError) as rejected_claim:
                future.result(timeout=10)
        assert getattr(rejected_claim.value.orig, "sqlstate", None) == "23514"
    finally:
        if execution_transaction.is_active:
            execution_transaction.rollback()
        execution_connection.close()
    with engine.connect() as connection:
        claim_count = connection.execute(
            text(
                """
                SELECT count(*) FROM trade_decision_submission_claims
                 WHERE trade_decision_id = :id
                """
            ),
            {"id": claim_decision},
        ).scalar_one()
    assert claim_count == 0


def _assert_claim_identity_wins_before_execution(engine: Engine) -> None:
    claim_decision = uuid.uuid4()
    source_decision = uuid.uuid4()
    execution_id = uuid.uuid4()
    client_order_id = "u" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=claim_decision,
            client_order_id=client_order_id,
        )
        _insert_decision(
            connection,
            decision_id=source_decision,
            client_order_id="v" * 64,
        )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :id, :decision_id, 'wrong-account', 'wrong-client-u', 'claim-first-source'
                )
                """
            ),
            {"id": execution_id, "decision_id": source_decision},
        )
    claim_connection = engine.connect()
    claim_transaction = claim_connection.begin()
    try:
        _insert_claimed(
            claim_connection,
            decision_id=claim_decision,
            client_order_id=client_order_id,
            claim_token=uuid.uuid4(),
        )

        def mutate_execution() -> None:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        UPDATE executions
                           SET alpaca_account_label = 'paper',
                               client_order_id = :client_order_id
                         WHERE id = :id
                        """
                    ),
                    {"id": execution_id, "client_order_id": client_order_id},
                )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(mutate_execution)
            with pytest.raises(FutureTimeoutError):
                future.result(timeout=0.5)
            claim_transaction.commit()
            with pytest.raises(DBAPIError) as rejected_execution:
                future.result(timeout=10)
        assert getattr(rejected_execution.value.orig, "sqlstate", None) == "23514"
    finally:
        if claim_transaction.is_active:
            claim_transaction.rollback()
        claim_connection.close()
    with engine.begin() as connection:
        _enter_broker_io(connection, decision_id=claim_decision)
    with engine.connect() as connection:
        execution_identity = connection.execute(
            text(
                """
                SELECT alpaca_account_label, client_order_id
                  FROM executions WHERE id = :id
                """
            ),
            {"id": execution_id},
        ).one()
        claim_state = connection.execute(
            text(
                """
                SELECT state FROM trade_decision_submission_claims
                 WHERE trade_decision_id = :id
                """
            ),
            {"id": claim_decision},
        ).scalar_one()
    assert execution_identity == ("wrong-account", "wrong-client-u")
    assert claim_state == "broker_io"


def _assert_cross_decision_identity_race(engine: Engine) -> None:
    claim_decision = uuid.uuid4()
    source_decision = uuid.uuid4()
    execution_id = uuid.uuid4()
    client_order_id = "q" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=claim_decision,
            client_order_id=client_order_id,
        )
        _insert_claimed(
            connection,
            decision_id=claim_decision,
            client_order_id=client_order_id,
            claim_token=uuid.uuid4(),
        )
        _insert_decision(
            connection,
            decision_id=source_decision,
            client_order_id="r" * 64,
        )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :id, :decision_id, 'wrong-account', 'wrong-client-q', 'race-source'
                )
                """
            ),
            {"id": execution_id, "decision_id": source_decision},
        )
    barrier = Barrier(2)

    def mutate_execution() -> str:
        barrier.wait(timeout=10)
        try:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        UPDATE executions
                           SET alpaca_account_label = 'paper',
                               client_order_id = :client_order_id
                         WHERE id = :id
                        """
                    ),
                    {"id": execution_id, "client_order_id": client_order_id},
                )
        except DBAPIError:
            return "execution_rejected"
        return "execution_mutated"

    def enter_broker_io() -> str:
        barrier.wait(timeout=10)
        with engine.begin() as connection:
            _enter_broker_io(connection, decision_id=claim_decision)
        return "broker_io"

    with ThreadPoolExecutor(max_workers=2) as executor:
        mutation_future = executor.submit(mutate_execution)
        boundary_future = executor.submit(enter_broker_io)
        outcomes = [
            mutation_future.result(timeout=10),
            boundary_future.result(timeout=10),
        ]
    assert sorted(outcomes) == ["broker_io", "execution_rejected"]
    with engine.connect() as connection:
        execution_identity = connection.execute(
            text(
                """
                SELECT alpaca_account_label, client_order_id
                  FROM executions WHERE id = :id
                """
            ),
            {"id": execution_id},
        ).one()
        claim_state = connection.execute(
            text(
                """
                SELECT state FROM trade_decision_submission_claims
                 WHERE trade_decision_id = :id
                """
            ),
            {"id": claim_decision},
        ).scalar_one()
    assert execution_identity == ("wrong-account", "wrong-client-q")
    assert claim_state == "broker_io"


def _assert_parent_and_execution_lock_races(engine: Engine) -> None:
    decision_id = uuid.uuid4()
    client_order_id = "f" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
        )
    claim_connection = engine.connect()
    claim_transaction = claim_connection.begin()
    started = Event()
    try:
        _insert_claimed(
            claim_connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_token=uuid.uuid4(),
        )

        def update_parent() -> None:
            started.set()
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "UPDATE trade_decisions SET decision_hash = :hash "
                        "WHERE id = :id"
                    ),
                    {"hash": "g" * 64, "id": decision_id},
                )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(update_parent)
            assert started.wait(timeout=10)
            claim_transaction.commit()
            with pytest.raises(DBAPIError):
                future.result(timeout=10)
    finally:
        if claim_transaction.is_active:
            claim_transaction.rollback()
        claim_connection.close()

    execution_id = uuid.uuid4()
    with engine.begin() as connection:
        _enter_broker_io(connection, decision_id=decision_id)
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (:execution_id, :decision_id, 'paper', :client_order_id, 'race-order')
                """
            ),
            {
                "execution_id": execution_id,
                "decision_id": decision_id,
                "client_order_id": client_order_id,
            },
        )
    terminal_connection = engine.connect()
    terminal_transaction = terminal_connection.begin()
    started.clear()
    try:
        terminal_connection.execute(
            text(
                """
                UPDATE trade_decision_submission_claims
                   SET state = 'submitted', broker_order_id = 'race-order',
                       broker_client_order_id = :client_order_id,
                       execution_id = :execution_id, completed_at = now(),
                       updated_at = now()
                 WHERE trade_decision_id = :decision_id
                """
            ),
            {
                "decision_id": decision_id,
                "client_order_id": client_order_id,
                "execution_id": execution_id,
            },
        )

        def update_execution() -> None:
            started.set()
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "UPDATE executions SET client_order_id = :client WHERE id = :id"
                    ),
                    {"client": "wrong", "id": execution_id},
                )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(update_execution)
            assert started.wait(timeout=10)
            terminal_transaction.commit()
            with pytest.raises(DBAPIError):
                future.result(timeout=10)
    finally:
        if terminal_transaction.is_active:
            terminal_transaction.rollback()
        terminal_connection.close()


def _assert_late_primary_recovery_no_deadlock(engine: Engine) -> None:
    decision_id = uuid.uuid4()
    execution_id = uuid.uuid4()
    client_order_id = "i" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
        )
        _insert_claimed(
            connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_token=uuid.uuid4(),
        )
        _enter_broker_io(connection, decision_id=decision_id)

    late_connection = engine.connect()
    late_transaction = late_connection.begin()
    recovery_updated = Event()
    terminal_started = Event()
    try:
        late_connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (:execution_id, :decision_id, 'paper', :client_order_id, 'late-order')
                """
            ),
            {
                "execution_id": execution_id,
                "decision_id": decision_id,
                "client_order_id": client_order_id,
            },
        )

        def recovery_update() -> None:
            with engine.begin() as connection:
                now = datetime.now(timezone.utc)
                connection.execute(
                    text(
                        """
                        UPDATE trade_decision_submission_claims
                           SET recovery_token = :token,
                               recovery_fencing_epoch = 1,
                               recovery_owner = 'reader-race',
                               recovery_lease_started_at = :now,
                               recovery_lease_expires_at = :expires,
                               updated_at = :now
                         WHERE trade_decision_id = :decision_id
                        """
                    ),
                    {
                        "token": uuid.uuid4(),
                        "now": now,
                        "expires": now + timedelta(minutes=1),
                        "decision_id": decision_id,
                    },
                )
                recovery_updated.set()
                assert terminal_started.wait(timeout=10)

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(recovery_update)
            if not recovery_updated.wait(timeout=10):
                terminal_started.set()
                late_transaction.rollback()
                future.result(timeout=10)
                pytest.fail("recovery update blocked behind Execution parent FK lock")
            terminal_started.set()
            late_connection.execute(
                text(
                    """
                    UPDATE trade_decision_submission_claims
                       SET state = 'submitted', broker_order_id = 'late-order',
                           broker_client_order_id = :client_order_id,
                           execution_id = :execution_id, completed_at = now(),
                           updated_at = now()
                     WHERE trade_decision_id = :decision_id
                    """
                ),
                {
                    "decision_id": decision_id,
                    "client_order_id": client_order_id,
                    "execution_id": execution_id,
                },
            )
            late_transaction.commit()
            future.result(timeout=10)
    finally:
        terminal_started.set()
        if late_transaction.is_active:
            late_transaction.rollback()
        late_connection.close()


def _assert_execution_status_update_terminal_no_deadlock(engine: Engine) -> None:
    decision_id = uuid.uuid4()
    execution_id = uuid.uuid4()
    client_order_id = "k" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
        )
        _insert_claimed(
            connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_token=uuid.uuid4(),
        )
        _enter_broker_io(connection, decision_id=decision_id)
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id, status
                ) VALUES (
                    :execution_id, :decision_id, 'paper',
                    :client_order_id, 'status-race-order', 'accepted'
                )
                """
            ),
            {
                "execution_id": execution_id,
                "decision_id": decision_id,
                "client_order_id": client_order_id,
            },
        )

    status_connection = engine.connect()
    status_transaction = status_connection.begin()
    try:
        status_connection.execute(
            text("UPDATE executions SET status = 'filled' WHERE id = :id"),
            {"id": execution_id},
        )

        def terminalize() -> None:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        UPDATE trade_decision_submission_claims
                           SET state = 'submitted',
                               broker_order_id = 'status-race-order',
                               broker_client_order_id = :client_order_id,
                               execution_id = :execution_id,
                               completed_at = now(), updated_at = now()
                         WHERE trade_decision_id = :decision_id
                        """
                    ),
                    {
                        "decision_id": decision_id,
                        "client_order_id": client_order_id,
                        "execution_id": execution_id,
                    },
                )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(terminalize)
            try:
                future.result(timeout=10)
            except FutureTimeoutError:
                status_transaction.rollback()
                future.result(timeout=10)
                pytest.fail("terminal claim blocked on a non-identity Execution update")
        with pytest.raises(DBAPIError) as stale_terminal:
            status_connection.execute(
                text(
                    """
                    UPDATE trade_decision_submission_claims
                       SET completed_at = now()
                     WHERE trade_decision_id = :decision_id
                    """
                ),
                {"decision_id": decision_id},
            )
        assert getattr(stale_terminal.value.orig, "sqlstate", None) == "23514"
        status_transaction.rollback()
    finally:
        if status_transaction.is_active:
            status_transaction.rollback()
        status_connection.close()
