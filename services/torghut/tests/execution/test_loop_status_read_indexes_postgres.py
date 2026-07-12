from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url

from app.config import settings
from app.trading.loop_status import (
    _COUNTS_24H_SQL,
    _LATEST_SIGNAL_SQL,
    _UNEXPECTED_LIVE_ALPACA_SQL,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
)


@dataclass(frozen=True, slots=True)
class LoopStatusIndexHarness:
    engine: Engine
    alembic: AlembicConfig


@pytest.fixture
def loop_status_index_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[LoopStatusIndexHarness]:
    if POSTGRES_DSN is None:
        pytest.skip("set TORGHUT_TEST_POSTGRES_DSN for the loop status index test")
    schema = f"loop_status_indexes_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _create_loop_status_tables(schema_engine)
        _load_realistic_loop_status_rows(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0061_linked_submission_terminal")
        command.upgrade(alembic, "0062_loop_status_read_indexes")
        _vacuum_loop_status_tables(schema_engine)
        yield LoopStatusIndexHarness(engine=schema_engine, alembic=alembic)
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


def _create_loop_status_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE hyperliquid_execution_cycles (
                    id bigint PRIMARY KEY,
                    finished_at timestamptz NOT NULL
                );
                CREATE INDEX ix_hyperliquid_execution_cycles_finished
                    ON hyperliquid_execution_cycles (finished_at);

                CREATE TABLE hyperliquid_execution_signals (
                    id bigint PRIMARY KEY,
                    generated_at timestamptz NOT NULL,
                    feature_event_ts timestamptz NOT NULL,
                    features jsonb NOT NULL,
                    coin text NOT NULL,
                    action text NOT NULL,
                    edge_bps numeric NOT NULL,
                    reason text NOT NULL
                );

                CREATE TABLE hyperliquid_execution_orders (
                    id bigint PRIMARY KEY,
                    execution_network text NOT NULL,
                    created_at timestamptz NOT NULL
                );

                CREATE TABLE hyperliquid_execution_fills (
                    id bigint PRIMARY KEY,
                    execution_network text NOT NULL,
                    event_ts timestamptz NOT NULL
                );

                CREATE TABLE hyperliquid_execution_account_snapshots (
                    id bigint PRIMARY KEY,
                    execution_network text NOT NULL,
                    observed_at timestamptz NOT NULL
                );
                CREATE INDEX ix_hyperliquid_execution_account_observed
                    ON hyperliquid_execution_account_snapshots (observed_at);

                CREATE TABLE executions (
                    id bigint PRIMARY KEY,
                    created_at timestamptz NOT NULL,
                    alpaca_account_label text NOT NULL
                );

                CREATE TABLE execution_order_events (
                    id bigint PRIMARY KEY,
                    event_ts timestamptz,
                    created_at timestamptz NOT NULL,
                    alpaca_account_label text NOT NULL
                )
                """
            )
        )


def _load_realistic_loop_status_rows(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO hyperliquid_execution_cycles (id, finished_at)
                SELECT n, clock_timestamp() - make_interval(secs => n)
                  FROM generate_series(1, 75000) AS n;

                INSERT INTO hyperliquid_execution_signals (
                    id, generated_at, feature_event_ts, features,
                    coin, action, edge_bps, reason
                )
                SELECT n,
                       clock_timestamp() - make_interval(secs => n),
                       clock_timestamp() - make_interval(secs => n + 1),
                       '{"source_lag_seconds":"1","quote_lag_seconds":"1"}'::jsonb,
                       'BTC', 'hold', 0, 'test'
                  FROM generate_series(1, 260000) AS n;

                INSERT INTO hyperliquid_execution_orders (
                    id, execution_network, created_at
                )
                SELECT n, 'testnet', clock_timestamp() - make_interval(mins => n)
                  FROM generate_series(1, 5000) AS n;

                INSERT INTO hyperliquid_execution_fills (
                    id, execution_network, event_ts
                )
                SELECT n, 'testnet', clock_timestamp() - make_interval(mins => n)
                  FROM generate_series(1, 5000) AS n;

                INSERT INTO hyperliquid_execution_account_snapshots (
                    id, execution_network, observed_at
                )
                SELECT n, 'testnet', clock_timestamp() - make_interval(mins => n)
                  FROM generate_series(1, 75000) AS n;

                INSERT INTO executions (id, created_at, alpaca_account_label)
                SELECT n,
                       clock_timestamp() - make_interval(mins => n),
                       CASE WHEN n % 1000 = 0 THEN 'alpaca-live' ELSE 'paper' END
                  FROM generate_series(1, 15000) AS n;

                INSERT INTO execution_order_events (
                    id, event_ts, created_at, alpaca_account_label
                )
                SELECT n,
                       CASE
                           WHEN n % 2 = 0 THEN NULL
                           ELSE clock_timestamp() - make_interval(mins => n)
                       END,
                       clock_timestamp() - make_interval(mins => n),
                       CASE
                           WHEN n = 1 OR n % 10 = 0 THEN 'alpaca-live'
                           ELSE 'paper'
                       END
                  FROM generate_series(1, 150000) AS n;
                DELETE FROM execution_order_events
                 WHERE id <> 1 AND id % 2500 <> 0
                """
            )
        )


def _vacuum_loop_status_tables(engine: Engine) -> None:
    tables = (
        "hyperliquid_execution_cycles",
        "hyperliquid_execution_signals",
        "hyperliquid_execution_orders",
        "hyperliquid_execution_fills",
        "hyperliquid_execution_account_snapshots",
        "executions",
        "execution_order_events",
    )
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        for table_name in tables:
            connection.execute(text(f"VACUUM (ANALYZE) {table_name}"))


def _explain_json(engine: Engine, sql: str) -> str:
    with engine.begin() as connection:
        plan = connection.execute(text(f"EXPLAIN (FORMAT JSON) {sql}")).scalar_one()
    return json.dumps(plan)


def test_indexes_bound_exact_loop_status_reads_and_downgrade_symmetrically(
    loop_status_index_harness: LoopStatusIndexHarness,
) -> None:
    harness = loop_status_index_harness

    latest_plan = _explain_json(harness.engine, _LATEST_SIGNAL_SQL)
    counts_plan = _explain_json(harness.engine, _COUNTS_24H_SQL)
    unexpected_live_plan = _explain_json(harness.engine, _UNEXPECTED_LIVE_ALPACA_SQL)
    assert "ix_hyperliquid_execution_signals_generated_at_desc" in latest_plan
    assert "ix_hyperliquid_execution_signals_generated_at_desc" in counts_plan
    assert "ix_hyperliquid_execution_orders_network_created_desc" in counts_plan
    assert "ix_hyperliquid_execution_fills_network_event_desc" in counts_plan
    assert "ix_hyperliquid_execution_account_observed" in counts_plan
    assert "ix_executions_created_at_desc" in unexpected_live_plan
    assert "ix_execution_order_events_activity_at_desc" in unexpected_live_plan

    started_at = time.monotonic()
    with harness.engine.begin() as connection:
        connection.execute(text("SET LOCAL statement_timeout = '1500ms'"))
        latest = connection.execute(text(_LATEST_SIGNAL_SQL)).mappings().one()
        counts = connection.execute(text(_COUNTS_24H_SQL)).mappings().one()
        unexpected_live = (
            connection.execute(text(_UNEXPECTED_LIVE_ALPACA_SQL)).mappings().one()
        )
    assert time.monotonic() - started_at < 4.5
    assert latest["coin"] == "BTC"
    assert counts["signals_24h"] > 0
    assert unexpected_live == {"orders_24h": 1, "events_24h": 1}

    command.downgrade(harness.alembic, "0061_linked_submission_terminal")
    with harness.engine.connect() as connection:
        version = connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one()
        indexes = connection.execute(
            text(
                """
                SELECT to_regclass('ix_hyperliquid_execution_signals_generated_at_desc'),
                       to_regclass('ix_hyperliquid_execution_orders_network_created_desc'),
                       to_regclass('ix_hyperliquid_execution_fills_network_event_desc'),
                       to_regclass('ix_executions_created_at_desc'),
                       to_regclass('ix_execution_order_events_activity_at_desc'),
                       to_regclass('ix_hyperliquid_execution_account_observed')
                """
            )
        ).one()
    assert version == "0061_linked_submission_terminal"
    assert indexes[:5] == (None, None, None, None, None)
    assert indexes[5] == "ix_hyperliquid_execution_account_observed"
