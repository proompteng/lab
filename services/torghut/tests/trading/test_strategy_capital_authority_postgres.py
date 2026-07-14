from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from time import monotonic

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError

from app.config import settings


POSTGRES_DSN = os.getenv("TORGHUT_TEST_POSTGRES_DSN")
SERVICE_ROOT = Path(__file__).resolve().parents[2]


def _create_pre_migration_schema(
    engine: Engine,
    *,
    historical_strategy_id: uuid.UUID | None = None,
    historical_decision_id: uuid.UUID | None = None,
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE strategies (
                    id UUID PRIMARY KEY,
                    name VARCHAR(255) NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE evidence_epochs (
                    id UUID PRIMARY KEY,
                    evidence_epoch_id VARCHAR(64) NOT NULL UNIQUE,
                    payload_json JSONB
                )
                """
            )
        )
        connection.execute(
            text(
                "INSERT INTO evidence_epochs (id, evidence_epoch_id, payload_json) "
                "VALUES (:id, :epoch_id, '{}'::jsonb)"
            ),
            {"id": uuid.uuid4(), "epoch_id": "tee-postgres-safe"},
        )
        connection.execute(
            text(
                """
                CREATE TABLE trade_decisions (
                    id UUID PRIMARY KEY,
                    strategy_id UUID NOT NULL,
                    alpaca_account_label VARCHAR(64) NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE torghut_options_contract_catalog (
                    contract_symbol TEXT PRIMARY KEY,
                    expiration_date DATE NOT NULL,
                    status TEXT NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                INSERT INTO torghut_options_contract_catalog (
                    contract_symbol, expiration_date, status
                ) VALUES
                    ('ACTIVE', DATE '2026-07-18', 'active'),
                    ('INACTIVE', DATE '2026-07-18', 'inactive')
                """
            )
        )
        if historical_strategy_id is None or historical_decision_id is None:
            return
        connection.execute(
            text("INSERT INTO strategies (id, name) VALUES (:id, :name)"),
            {"id": historical_strategy_id, "name": "historical-safe"},
        )
        connection.execute(
            text(
                """
                INSERT INTO trade_decisions (id, strategy_id, alpaca_account_label)
                VALUES (:id, :strategy_id, 'paper')
                """
            ),
            {
                "id": historical_decision_id,
                "strategy_id": historical_strategy_id,
            },
        )


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in authority migration test",
)
def test_postgres_authority_history_is_database_immutable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"strategy_authority_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    historical_strategy_id = uuid.uuid4()
    historical_decision_id = uuid.uuid4()
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _create_pre_migration_schema(
            schema_engine,
            historical_strategy_id=historical_strategy_id,
            historical_decision_id=historical_decision_id,
        )

        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0062_options_archive_members")
        command.upgrade(alembic, "0064_strategy_capital_authority")
        assert inspect(schema_engine).has_table("strategy_capital_authorities")
        with schema_engine.begin() as connection:
            connection.execute(
                text("DROP INDEX ix_trade_decisions_capital_authority_usage")
            )
            connection.execute(
                text(
                    """
                    CREATE INDEX ix_trade_decisions_capital_authority_usage
                    ON trade_decisions (
                        strategy_id,
                        alpaca_account_label,
                        strategy_capital_authority_evaluated_at
                    )
                    """
                )
            )
            connection.execute(
                text("DROP INDEX ix_options_catalog_active_expiration_symbol")
            )
            connection.execute(
                text(
                    """
                    CREATE INDEX ix_options_catalog_active_expiration_symbol
                    ON torghut_options_contract_catalog (
                        expiration_date,
                        contract_symbol
                    )
                    """
                )
            )
        command.stamp(alembic, "0062_options_archive_members")
        command.upgrade(alembic, "0064_strategy_capital_authority")

        expected_constraints = {
            "ck_trade_decisions_capital_authority_evaluated",
            "ck_trade_decisions_capital_authority_allowed_identity",
            "ck_trade_decisions_capital_authority_identity_pair",
            "ck_trade_decisions_capital_authority_digest",
            "fk_trade_decisions_strategy_capital_authority_identity",
        }
        with schema_engine.connect() as connection:
            constraint_rows = connection.execute(
                text(
                    """
                    SELECT conname, convalidated
                    FROM pg_constraint
                    WHERE conrelid = 'trade_decisions'::regclass
                    """
                )
            ).all()
            validation_state = {
                str(row.conname): bool(row.convalidated) for row in constraint_rows
            }
            assert expected_constraints <= validation_state.keys()
            assert all(validation_state[name] for name in expected_constraints)

            usage_index = connection.execute(
                text(
                    """
                    SELECT indisvalid, pg_get_expr(indpred, indrelid) AS predicate
                    FROM pg_index
                    WHERE indexrelid =
                        'ix_trade_decisions_capital_authority_usage'::regclass
                    """
                )
            ).one()
            assert usage_index.indisvalid is True
            assert "strategy_capital_authority_allowed IS TRUE" in str(
                usage_index.predicate
            )

            archive_index = connection.execute(
                text(
                    """
                    SELECT indisvalid, pg_get_expr(indpred, indrelid) AS predicate
                    FROM pg_index
                    WHERE indexrelid =
                        'ix_options_catalog_active_expiration_symbol'::regclass
                    """
                )
            ).one()
            assert archive_index.indisvalid is True
            assert "status = 'active'::text" in str(archive_index.predicate)

            historical_authority = connection.execute(
                text(
                    """
                    SELECT strategy_capital_authority_id,
                           strategy_capital_authority_digest,
                           strategy_capital_authority_evaluated_at,
                           strategy_capital_authority_allowed
                    FROM trade_decisions
                    WHERE id = :id
                    """
                ),
                {"id": historical_decision_id},
            ).one()
            assert tuple(historical_authority) == (None, None, None, None)

        strategy_id = uuid.uuid4()
        authority_record_id = uuid.uuid4()
        payload = {
            "schema_version": "torghut.strategy-capital-authority.v1",
            "authority_id": "postgres-safe-v1",
            "strategy_ref": "postgres-safe",
            "stage": "shadow_allowed",
            "account_mode": "none",
            "venue": "none",
            "allowed_symbols": [],
            "max_order_notional": "0",
            "max_gross_notional": "0",
            "max_net_notional": "0",
            "max_loss": "0",
            "max_orders_per_minute": 0,
            "max_orders_per_session": 0,
            "reduce_only": True,
            "blockers": ["p0_capital_freeze"],
        }
        with schema_engine.begin() as connection:
            connection.execute(
                text("INSERT INTO strategies (id, name) VALUES (:id, :name)"),
                {"id": strategy_id, "name": "postgres-safe"},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO strategy_capital_authorities (
                        id, authority_id, strategy_id, schema_version, stage,
                        authority_digest, payload_json
                    ) VALUES (
                        :id, :authority_id, :strategy_id, :schema_version, :stage,
                        :authority_digest, CAST(:payload_json AS jsonb)
                    )
                    """
                ),
                {
                    "id": authority_record_id,
                    "authority_id": "postgres-safe-v1",
                    "strategy_id": strategy_id,
                    "schema_version": "torghut.strategy-capital-authority.v1",
                    "stage": "shadow_allowed",
                    "authority_digest": "sha256:" + "a" * 64,
                    "payload_json": json.dumps(payload),
                },
            )
            connection.execute(
                text(
                    "UPDATE strategies SET active_capital_authority_id = :authority_id "
                    "WHERE id = :strategy_id"
                ),
                {
                    "authority_id": authority_record_id,
                    "strategy_id": strategy_id,
                },
            )

        other_strategy_id = uuid.uuid4()
        with schema_engine.begin() as connection:
            connection.execute(
                text("INSERT INTO strategies (id, name) VALUES (:id, :name)"),
                {"id": other_strategy_id, "name": "postgres-other"},
            )
        with pytest.raises(DBAPIError) as cross_strategy:
            with schema_engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO trade_decisions (
                            id, strategy_id, alpaca_account_label,
                            strategy_capital_authority_id,
                            strategy_capital_authority_digest,
                            strategy_capital_authority_evaluated_at,
                            strategy_capital_authority_allowed
                        ) VALUES (
                            :id, :strategy_id, 'paper', :authority_id,
                            :authority_digest, clock_timestamp(), true
                        )
                        """
                    ),
                    {
                        "id": uuid.uuid4(),
                        "strategy_id": other_strategy_id,
                        "authority_id": "postgres-safe-v1",
                        "authority_digest": "sha256:" + "a" * 64,
                    },
                )
        assert getattr(cross_strategy.value.orig, "sqlstate", None) == "23503"

        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO trade_decisions (
                        id, strategy_id, alpaca_account_label,
                        strategy_capital_authority_id,
                        strategy_capital_authority_digest,
                        strategy_capital_authority_evaluated_at,
                        strategy_capital_authority_allowed
                    ) VALUES (
                        :id, :strategy_id, 'paper', :authority_id,
                        :authority_digest, clock_timestamp(), true
                    )
                    """
                ),
                {
                    "id": uuid.uuid4(),
                    "strategy_id": strategy_id,
                    "authority_id": "postgres-safe-v1",
                    "authority_digest": "sha256:" + "a" * 64,
                },
            )

        for statement in (
            "UPDATE strategy_capital_authorities SET stage = 'research_only'",
            "DELETE FROM strategy_capital_authorities",
            "UPDATE evidence_epochs SET payload_json = "
            "jsonb_build_object('tampered', true)",
            "DELETE FROM evidence_epochs",
        ):
            with pytest.raises(DBAPIError) as blocked:
                with schema_engine.begin() as connection:
                    connection.execute(text(statement))
            assert getattr(blocked.value.orig, "sqlstate", None) == "23514"

        with pytest.raises(DBAPIError) as downgrade:
            command.downgrade(alembic, "0062_options_archive_members")
        assert getattr(downgrade.value.orig, "sqlstate", None) == "55000"
        assert inspect(schema_engine).has_table("strategy_capital_authorities")
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in authority migration test",
)
def test_postgres_authority_migration_lock_timeout_is_retry_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"strategy_authority_lock_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _create_pre_migration_schema(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0062_options_archive_members")

        with schema_engine.connect() as blocker, blocker.begin():
            blocker.execute(text("LOCK TABLE trade_decisions IN ROW EXCLUSIVE MODE"))
            started_at = monotonic()
            with pytest.raises(DBAPIError) as timed_out:
                command.upgrade(alembic, "0064_strategy_capital_authority")
            elapsed = monotonic() - started_at

        assert getattr(timed_out.value.orig, "sqlstate", None) == "55P03"
        assert elapsed < 12.0
        assert inspect(schema_engine).has_table("strategy_capital_authorities")
        with schema_engine.connect() as connection:
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
        assert revision == "0063_options_archive_final_idx"
        decision_columns = {
            column["name"]
            for column in inspect(schema_engine).get_columns("trade_decisions")
        }
        assert "strategy_capital_authority_id" not in decision_columns

        command.upgrade(alembic, "0064_strategy_capital_authority")
        with schema_engine.connect() as connection:
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
        assert revision == "0064_strategy_capital_authority"
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
