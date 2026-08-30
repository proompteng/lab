from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import inspect, text

from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_schema_engines,
    drop_schema,
)
from tests.execution.infrastructure_validation_postgres_support import (
    upgrade_reduction_schema,
)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for crypto quantity precision",
)
def test_postgres_preserves_nine_decimal_order_feed_quantities() -> None:
    schema, admin_engine, schema_engine, _schema_dsn = create_schema_engines(
        "crypto_quantity_precision"
    )
    try:
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        upgrade_reduction_schema(
            alembic,
            schema_engine,
            target="0074_crypto_qty_precision",
        )

        columns = {
            column["name"]: column["type"]
            for column in inspect(schema_engine).get_columns("execution_order_events")
        }
        for column_name in ("qty", "filled_qty", "filled_qty_delta", "position_qty"):
            assert columns[column_name].precision == 21
            assert columns[column_name].scale == 9

        value = Decimal("0.000449274")
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO execution_order_events "
                    "(id, event_fingerprint, source_topic, alpaca_account_label, "
                    "qty, filled_qty, filled_qty_delta, position_qty, raw_event) "
                    "VALUES (:id, :fingerprint, :topic, :account, :value, :value, "
                    ":value, :value, CAST(:raw_event AS jsonb))"
                ),
                {
                    "account": "paper",
                    "fingerprint": "f" * 64,
                    "id": uuid.uuid4(),
                    "raw_event": "{}",
                    "topic": "torghut.trade-updates.v1",
                    "value": value,
                },
            )
            observed = connection.scalar(
                text(
                    "SELECT position_qty FROM execution_order_events "
                    "WHERE event_fingerprint = :fingerprint"
                ),
                {"fingerprint": "f" * 64},
            )
        assert observed == value

        with pytest.raises(RuntimeError, match="nine-decimal values exist"):
            command.downgrade(alembic, "0073_live_paper_bounds")
    finally:
        drop_schema(schema, admin_engine, schema_engine)
