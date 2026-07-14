from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from app.config import settings


POSTGRES_DSN = os.getenv("TORGHUT_TEST_POSTGRES_DSN")
SERVICE_ROOT = Path(__file__).resolve().parents[2]


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
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        with schema_engine.begin() as connection:
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

        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0062_options_archive_members")
        command.upgrade(alembic, "0063_strategy_capital_authority")
        assert inspect(schema_engine).has_table("strategy_capital_authorities")

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
            "UPDATE evidence_epochs SET payload_json = '{\"tampered\":true}'::jsonb",
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
