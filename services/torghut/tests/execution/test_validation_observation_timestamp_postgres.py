from __future__ import annotations

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text

from app.config import settings
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
    reason="set TORGHUT_TEST_POSTGRES_DSN for lifecycle timestamp migration",
)
def test_postgres_observation_timestamp_guard_upgrade_and_downgrade(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_observed_at"
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        upgrade_reduction_schema(
            alembic,
            schema_engine,
            target="0074_crypto_qty_precision",
        )

        command.upgrade(alembic, "0075_validation_observed_at")
        with schema_engine.connect() as connection:
            upgraded = str(
                connection.scalar(
                    text(
                        "SELECT pg_get_functiondef(to_regprocedure("
                        "'torghut_guard_bm_validation_lineage_0072()'))"
                    )
                )
            )
        assert "observed_at IS NULL" in upgraded

        command.downgrade(alembic, "0074_crypto_qty_precision")
        with schema_engine.connect() as connection:
            downgraded = str(
                connection.scalar(
                    text(
                        "SELECT pg_get_functiondef(to_regprocedure("
                        "'torghut_guard_bm_validation_lineage_0072()'))"
                    )
                )
            )
        assert "observed_at IS NULL" not in downgraded
    finally:
        drop_schema(schema, admin_engine, schema_engine)
