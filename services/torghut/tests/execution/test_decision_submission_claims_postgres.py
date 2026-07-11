from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import TradeDecisionSubmissionClaim
from app.trading.decision_submission_claims import (
    DecisionSubmissionClaimValidationError,
    acquire_decision_submission_claim,
    acquire_decision_submission_recovery_claim,
    mark_decision_submission_broker_io_started,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN as _POSTGRES_DSN,
    SERVICE_ROOT as _SERVICE_ROOT,
    assert_rejected as _assert_rejected,
    create_parent_tables as _create_parent_tables,
    enter_broker_io as _enter_broker_io,
    insert_claimed as _insert_claimed,
    insert_decision as _insert_decision,
)


@pytest.mark.skipif(
    not _POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL CAS test",
)
def test_postgres_recovery_cas_and_transition_guards(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert _POSTGRES_DSN is not None
    schema = f"claim_recovery_{uuid.uuid4().hex}"
    admin_engine = create_engine(_POSTGRES_DSN, future=True)
    schema_url = make_url(_POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(_SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0058_decision_submission_claims")

        inspector = inspect(schema_engine)
        index_names = {
            item["name"]
            for item in inspector.get_indexes("trade_decision_submission_claims")
        }
        assert "uq_trade_decision_submission_recovery_token" in index_names
        assert {
            item.get("options", {}).get("ondelete")
            for item in inspector.get_foreign_keys("trade_decision_submission_claims")
        } == {"RESTRICT"}

        decision_id = uuid.uuid4()
        client_order_id = "a" * 64
        claim_token = uuid.uuid4()
        with schema_engine.begin() as connection:
            _insert_decision(
                connection,
                decision_id=decision_id,
                client_order_id=client_order_id,
            )
            _insert_claimed(
                connection,
                decision_id=decision_id,
                client_order_id=client_order_id,
                claim_token=claim_token,
            )
            _enter_broker_io(connection, decision_id=decision_id)

        recovery_barrier = Barrier(2)

        def acquire(owner: str) -> str:
            with sessions() as session:
                recovery_barrier.wait(timeout=10)
                return acquire_decision_submission_recovery_claim(
                    session,
                    decision_id=decision_id,
                    recovery_owner=owner,
                ).outcome

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(acquire, ("reader-a", "reader-b")))
        assert sorted(outcomes) == ["acquired", "busy"]
        with sessions() as session:
            claim = session.get(TradeDecisionSubmissionClaim, decision_id)
            assert claim is not None
            assert claim.state == "broker_io"
            assert claim.claim_token == claim_token
            assert claim.fencing_epoch == 1
            assert claim.claim_owner == "writer-a"
            assert claim.recovery_fencing_epoch == 1

        for invalid_state in ("claimed", "available"):
            _assert_rejected(
                schema_engine,
                """
                UPDATE trade_decision_submission_claims
                   SET state = :state
                 WHERE trade_decision_id = :decision_id
                """,
                state=invalid_state,
                decision_id=decision_id,
            )
        _assert_rejected(
            schema_engine,
            """
            UPDATE trade_decision_submission_claims
               SET claim_token = :claim_token
             WHERE trade_decision_id = :decision_id
            """,
            claim_token=uuid.uuid4(),
            decision_id=decision_id,
        )
        _assert_rejected(
            schema_engine,
            """
            UPDATE trade_decision_submission_claims
               SET fencing_epoch = 0
             WHERE trade_decision_id = :decision_id
            """,
            decision_id=decision_id,
        )
        _assert_rejected(
            schema_engine,
            """
            UPDATE trade_decision_submission_claims
               SET recovery_token = :token
             WHERE trade_decision_id = :decision_id
            """,
            token=uuid.uuid4(),
            decision_id=decision_id,
        )
        _assert_rejected(
            schema_engine,
            """
            UPDATE trade_decision_submission_claims
               SET recovery_fencing_epoch = 0
             WHERE trade_decision_id = :decision_id
            """,
            decision_id=decision_id,
        )
        _assert_rejected(
            schema_engine,
            """
            UPDATE trade_decision_submission_claims
               SET recovery_checked_at = now(), recovery_outcome = 'not_found',
                   recovery_evidence = 'missing epoch',
                   recovery_observation_epoch = NULL
             WHERE trade_decision_id = :decision_id
            """,
            decision_id=decision_id,
        )
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    UPDATE trade_decision_submission_claims
                       SET recovery_checked_at = now(),
                           recovery_observation_epoch = 1,
                           recovery_outcome = 'not_found',
                           recovery_evidence = 'epoch one observation',
                           recovery_after = now() - interval '1 second',
                           recovery_lease_expires_at = now()
                     WHERE trade_decision_id = :decision_id
                    """
                ),
                {"decision_id": decision_id},
            )
        with sessions() as session:
            second_recovery = acquire_decision_submission_recovery_claim(
                session,
                decision_id=decision_id,
                recovery_owner="reader-epoch-two",
            )
        assert second_recovery.outcome == "acquired"
        assert second_recovery.claim is not None
        assert second_recovery.claim.recovery_handle is not None
        assert second_recovery.claim.recovery_handle.recovery_fencing_epoch == 2
        assert second_recovery.claim.recovery_observation_epoch == 1
        _assert_rejected(
            schema_engine,
            """
            UPDATE trade_decision_submission_claims
               SET recovery_checked_at = now(),
                   recovery_observation_epoch = 1,
                   recovery_outcome = 'indeterminate',
                   recovery_evidence = 'epoch two writer mislabeled as epoch one'
             WHERE trade_decision_id = :decision_id
            """,
            decision_id=decision_id,
        )

        execution_id = uuid.uuid4()
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO executions (
                        id, trade_decision_id, alpaca_account_label,
                        client_order_id, alpaca_order_id
                    ) VALUES (
                        :id, :decision_id, 'paper', :client_order_id, 'broker-1'
                    )
                    """
                ),
                {
                    "id": execution_id,
                    "decision_id": decision_id,
                    "client_order_id": client_order_id,
                },
            )
            connection.execute(
                text(
                    """
                    UPDATE trade_decision_submission_claims
                       SET state = 'submitted', broker_order_id = 'broker-1',
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
        for statement in (
            "UPDATE trade_decision_submission_claims SET state = 'broker_io' "
            "WHERE trade_decision_id = :decision_id",
            "UPDATE trade_decision_submission_claims SET broker_order_id = 'other' "
            "WHERE trade_decision_id = :decision_id",
        ):
            _assert_rejected(schema_engine, statement, decision_id=decision_id)
        _assert_rejected(
            schema_engine,
            "UPDATE trade_decisions SET decision_hash = :new_hash WHERE id = :id",
            new_hash="b" * 64,
            id=decision_id,
        )
        _assert_rejected(
            schema_engine,
            "UPDATE executions SET alpaca_order_id = 'other' WHERE id = :id",
            id=execution_id,
        )
        _assert_rejected(
            schema_engine,
            "DELETE FROM trade_decisions WHERE id = :id",
            id=decision_id,
        )
        _assert_rejected(
            schema_engine,
            "DELETE FROM executions WHERE id = :id",
            id=execution_id,
        )
        _assert_rejected(
            schema_engine,
            "DELETE FROM trade_decision_submission_claims "
            "WHERE trade_decision_id = :id",
            id=decision_id,
        )

        _assert_boundary_guards(schema_engine)
        _assert_public_error_paths_release_locks(schema_engine)
        _assert_rejected(schema_engine, "TRUNCATE trade_decision_submission_claims")
        with pytest.raises(DBAPIError):
            command.downgrade(alembic, "0057_generic_multifactor_machine")
        assert inspect(schema_engine).has_table("trade_decision_submission_claims")
        with schema_engine.connect() as connection:
            remaining = connection.execute(
                text("SELECT count(*) FROM trade_decision_submission_claims")
            ).scalar_one()
        assert remaining > 0
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


def _assert_boundary_guards(engine: Engine) -> None:
    rejected_decision = uuid.uuid4()
    existing_decision = uuid.uuid4()
    rotating_decision = uuid.uuid4()
    mismatch_decision = uuid.uuid4()
    source_decision = uuid.uuid4()
    mismatch_execution = uuid.uuid4()
    new_match_execution = uuid.uuid4()
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=source_decision,
            client_order_id="i" * 64,
        )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :execution_id, :decision_id, 'wrong-account',
                    'wrong-client-h', 'wrong'
                )
                """
            ),
            {
                "execution_id": mismatch_execution,
                "decision_id": source_decision,
            },
        )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :execution_id, :decision_id, 'wrong-account',
                    'wrong-client-e', 'old'
                )
                """
            ),
            {
                "execution_id": new_match_execution,
                "decision_id": source_decision,
            },
        )
        for decision_id, marker in (
            (rejected_decision, "c"),
            (existing_decision, "d"),
            (rotating_decision, "e"),
            (mismatch_decision, "h"),
        ):
            client_order_id = marker * 64
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
        connection.execute(
            text("UPDATE trade_decisions SET status = 'rejected' WHERE id = :id"),
            {"id": rejected_decision},
        )
        _enter_broker_io(connection, decision_id=mismatch_decision)
    _assert_rejected(
        engine,
        """
        INSERT INTO executions (
            id, trade_decision_id, alpaca_account_label,
            client_order_id, alpaca_order_id
        ) VALUES (:execution_id, :decision_id, 'paper', :client_order_id, 'old')
        """,
        execution_id=uuid.uuid4(),
        decision_id=existing_decision,
        client_order_id="d" * 64,
    )
    _assert_rejected(
        engine,
        """
        UPDATE trade_decision_submission_claims
           SET state = 'broker_io', broker_io_started_at = now(),
               recovery_after = now() + interval '1 minute'
         WHERE trade_decision_id = :id
        """,
        id=rejected_decision,
    )
    _assert_rejected(
        engine,
        """
        UPDATE trade_decision_submission_claims
           SET state = 'broker_io', broker_io_started_at = now(),
               recovery_after = now() + interval '1 minute',
               claim_token = :new_token
         WHERE trade_decision_id = :id
        """,
        id=rotating_decision,
        new_token=uuid.uuid4(),
    )
    _assert_rejected(
        engine,
        """
        UPDATE trade_decision_submission_claims
           SET state = 'submitted', broker_order_id = 'wrong',
               broker_client_order_id = :client_order_id,
               execution_id = :execution_id, completed_at = now()
         WHERE trade_decision_id = :decision_id
        """,
        decision_id=mismatch_decision,
        client_order_id="h" * 64,
        execution_id=mismatch_execution,
    )
    _assert_rejected(
        engine,
        """
        UPDATE executions
           SET alpaca_account_label = 'paper', client_order_id = :client_order_id
         WHERE id = :id
        """,
        id=new_match_execution,
        client_order_id="e" * 64,
    )
    _assert_rejected(
        engine,
        "DELETE FROM trade_decision_submission_claims WHERE trade_decision_id = :id",
        id=rotating_decision,
    )
    _assert_rejected(
        engine,
        "DELETE FROM trade_decision_submission_claims WHERE trade_decision_id = :id",
        id=mismatch_decision,
    )


def _assert_public_error_paths_release_locks(engine: Engine) -> None:
    sessions = sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )
    boundary_decision = uuid.uuid4()
    boundary_client_id = "z" * 64
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=boundary_decision,
            client_order_id=boundary_client_id,
        )
    with sessions() as session:
        acquired = acquire_decision_submission_claim(
            session,
            decision_id=boundary_decision,
            client_order_id=boundary_client_id,
            claim_owner="invalid-boundary-test",
        )
    assert acquired.claim is not None
    first_session = sessions()
    try:
        with pytest.raises(
            DecisionSubmissionClaimValidationError,
            match="recovery_seconds_outside_bounds",
        ):
            mark_decision_submission_broker_io_started(
                first_session,
                handle=acquired.claim.handle,
                recovery_seconds=1,
            )
        assert not first_session.in_transaction()
        with sessions() as second_session:
            boundary = mark_decision_submission_broker_io_started(
                second_session,
                handle=acquired.claim.handle,
            )
        assert boundary.transitioned
        assert boundary.claim.state == "broker_io"
    finally:
        first_session.close()

    mismatch_decision = uuid.uuid4()
    mismatch_client_id = "ab" * 32
    mismatch_execution = uuid.uuid4()
    with engine.begin() as connection:
        _insert_decision(
            connection,
            decision_id=mismatch_decision,
            client_order_id=mismatch_client_id,
        )
        connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (
                    :id, :decision_id, 'wrong-account',
                    'wrong-client-ab', 'mismatch-lock-test'
                )
                """
            ),
            {"id": mismatch_execution, "decision_id": mismatch_decision},
        )
    failed_session = sessions()
    try:
        with pytest.raises(
            DecisionSubmissionClaimValidationError,
            match="existing_execution_submission_identity_mismatch",
        ):
            acquire_decision_submission_claim(
                failed_session,
                decision_id=mismatch_decision,
                client_order_id=mismatch_client_id,
                claim_owner="mismatch-lock-test",
            )
        assert not failed_session.in_transaction()
        with sessions() as probe_session:
            probe_session.execute(text("SET LOCAL lock_timeout = '1s'"))
            probe_session.execute(
                text(
                    "SELECT torghut_lock_submission_identities("
                    "CAST(ARRAY[:decision_key, :client_key] AS text[]))"
                ),
                {
                    "decision_key": (
                        f"torghut:submission:decision:{mismatch_decision}"
                    ),
                    "client_key": (
                        f"torghut:submission:client:paper\x1f{mismatch_client_id}"
                    ),
                },
            )
            probe_session.execute(
                text("SELECT id FROM trade_decisions WHERE id = :id FOR UPDATE"),
                {"id": mismatch_decision},
            )
            probe_session.rollback()
    finally:
        failed_session.close()


@pytest.mark.skipif(
    not _POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL downgrade test",
)
def test_empty_postgres_claim_schema_can_downgrade(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert _POSTGRES_DSN is not None
    schema = f"claim_empty_{uuid.uuid4().hex}"
    admin_engine = create_engine(_POSTGRES_DSN, future=True)
    schema_url = make_url(_POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(_SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0058_decision_submission_claims")
        command.downgrade(alembic, "0057_generic_multifactor_machine")
        assert not inspect(schema_engine).has_table("trade_decision_submission_claims")
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.skipif(
    not _POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the downgrade race test",
)
def test_claim_insert_dml_forces_postgres_downgrade_to_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert _POSTGRES_DSN is not None
    schema = f"claim_downgrade_race_{uuid.uuid4().hex}"
    admin_engine = create_engine(_POSTGRES_DSN, future=True)
    schema_url = make_url(_POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    insert_connection = None
    insert_transaction = None
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(_SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0058_decision_submission_claims")
        decision_id = uuid.uuid4()
        client_order_id = "j" * 64
        with schema_engine.begin() as connection:
            _insert_decision(
                connection,
                decision_id=decision_id,
                client_order_id=client_order_id,
            )
        insert_connection = schema_engine.connect()
        insert_transaction = insert_connection.begin()
        _insert_claimed(
            insert_connection,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_token=uuid.uuid4(),
        )
        with pytest.raises(DBAPIError) as blocked_downgrade:
            command.downgrade(alembic, "0057_generic_multifactor_machine")
        assert getattr(blocked_downgrade.value.orig, "sqlstate", None) == "55P03"
        insert_transaction.commit()
        assert inspect(schema_engine).has_table("trade_decision_submission_claims")
        with schema_engine.connect() as connection:
            count = connection.execute(
                text("SELECT count(*) FROM trade_decision_submission_claims")
            ).scalar_one()
        assert count == 1
    finally:
        if insert_transaction is not None and insert_transaction.is_active:
            insert_transaction.rollback()
        if insert_connection is not None:
            insert_connection.close()
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.skipif(
    not _POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the Execution downgrade race test",
)
def test_execution_dml_forces_postgres_downgrade_to_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert _POSTGRES_DSN is not None
    schema = f"execution_downgrade_race_{uuid.uuid4().hex}"
    admin_engine = create_engine(_POSTGRES_DSN, future=True)
    schema_url = make_url(_POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    execution_connection = None
    execution_transaction = None
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(_SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0058_decision_submission_claims")
        decision_id = uuid.uuid4()
        execution_id = uuid.uuid4()
        with schema_engine.begin() as connection:
            _insert_decision(
                connection,
                decision_id=decision_id,
                client_order_id="w" * 64,
            )
        execution_connection = schema_engine.connect()
        execution_transaction = execution_connection.begin()
        execution_connection.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id
                ) VALUES (:id, :decision_id, 'paper', :client_order_id, 'downgrade-race')
                """
            ),
            {
                "id": execution_id,
                "decision_id": decision_id,
                "client_order_id": "w" * 64,
            },
        )
        with pytest.raises(DBAPIError) as blocked_downgrade:
            command.downgrade(alembic, "0057_generic_multifactor_machine")
        assert getattr(blocked_downgrade.value.orig, "sqlstate", None) == "55P03"
        execution_transaction.commit()
        assert inspect(schema_engine).has_table("trade_decision_submission_claims")
        with schema_engine.connect() as connection:
            execution_count = connection.execute(
                text("SELECT count(*) FROM executions WHERE id = :id"),
                {"id": execution_id},
            ).scalar_one()
        assert execution_count == 1
    finally:
        if execution_transaction is not None and execution_transaction.is_active:
            execution_transaction.rollback()
        if execution_connection is not None:
            execution_connection.close()
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
