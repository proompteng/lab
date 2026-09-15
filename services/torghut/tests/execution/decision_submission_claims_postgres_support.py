from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine, make_url
from sqlalchemy.exc import DBAPIError


POSTGRES_DSN = os.getenv("TORGHUT_TEST_POSTGRES_DSN")
SERVICE_ROOT = Path(__file__).resolve().parents[2]


def create_schema_engines(prefix: str) -> tuple[str, Engine, Engine, str]:
    assert POSTGRES_DSN is not None
    schema = f"{prefix}_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    with admin_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    create_parent_tables(schema_engine)
    return (
        schema,
        admin_engine,
        schema_engine,
        schema_url.render_as_string(hide_password=False),
    )


def drop_schema(schema: str, admin_engine: Engine, schema_engine: Engine) -> None:
    schema_engine.dispose()
    with admin_engine.begin() as connection:
        connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
    admin_engine.dispose()


def create_parent_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE trade_decisions (
                    id UUID PRIMARY KEY,
                    strategy_id UUID,
                    alpaca_account_label VARCHAR(64) NOT NULL,
                    symbol VARCHAR(64) NOT NULL DEFAULT 'AAPL',
                    timeframe VARCHAR(16) NOT NULL DEFAULT '1Min',
                    decision_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    rationale TEXT,
                    decision_hash VARCHAR(64),
                    status VARCHAR(32) NOT NULL,
                    executed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE executions (
                    id UUID PRIMARY KEY,
                    trade_decision_id UUID REFERENCES trade_decisions(id)
                        ON DELETE SET NULL,
                    alpaca_account_label VARCHAR(64) NOT NULL,
                    client_order_id VARCHAR(128),
                    alpaca_order_id VARCHAR(128) NOT NULL,
                    status VARCHAR(32) NOT NULL DEFAULT 'accepted',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
        )


def insert_decision(
    connection: Connection,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
    status: str = "planned",
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO trade_decisions (
                id, alpaca_account_label, decision_hash, status
            ) VALUES (:id, 'paper', :client_order_id, :status)
            """
        ),
        {"id": decision_id, "client_order_id": client_order_id, "status": status},
    )


def insert_claimed(
    connection: Connection,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
    claim_token: uuid.UUID,
) -> None:
    now = datetime.now(timezone.utc)
    connection.execute(
        text(
            """
            INSERT INTO trade_decision_submission_claims (
                trade_decision_id, account_label, client_order_id,
                claim_token, fencing_epoch, state, claim_owner,
                claimed_at, lease_expires_at
            ) VALUES (
                :decision_id, 'paper', :client_order_id,
                :claim_token, 1, 'claimed', 'writer-a',
                :claimed_at, :lease_expires_at
            )
            """
        ),
        {
            "decision_id": decision_id,
            "client_order_id": client_order_id,
            "claim_token": claim_token,
            "claimed_at": now,
            "lease_expires_at": now + timedelta(minutes=5),
        },
    )


def enter_broker_io(connection: Connection, *, decision_id: uuid.UUID) -> None:
    now = datetime.now(timezone.utc)
    connection.execute(
        text(
            """
            UPDATE trade_decision_submission_claims
               SET state = 'broker_io',
                   broker_io_started_at = :now,
                   recovery_after = :recovery_after,
                   updated_at = :now
             WHERE trade_decision_id = :decision_id
            """
        ),
        {
            "decision_id": decision_id,
            "now": now,
            "recovery_after": now - timedelta(minutes=1),
        },
    )


def assert_rejected(engine: Engine, statement: str, **params: object) -> None:
    with pytest.raises(DBAPIError):
        with engine.begin() as connection:
            connection.execute(text(statement), params)
