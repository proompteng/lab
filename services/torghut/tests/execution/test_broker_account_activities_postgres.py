from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.config import settings
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    assert_rejected,
    create_schema_engines,
    drop_schema,
)
from tests.execution.infrastructure_validation_postgres_support import (
    upgrade_reduction_schema,
)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for account activity fencing",
)
def test_postgres_account_activities_are_hashed_append_only_facts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "broker_account_activities"
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        upgrade_reduction_schema(
            alembic,
            schema_engine,
            target="0074_crypto_qty_precision",
        )
        command.upgrade(alembic, "0076_broker_account_activities")

        activity_id = uuid.uuid4()
        observed_at = datetime.now(timezone.utc)
        raw_payload = {
            "activity_type": "FILL",
            "id": "activity-01JTEST",
            "order_id": "order-01JTEST",
            "price": "64434.063",
            "qty": "0.0002",
            "symbol": "BTCUSD",
            "transaction_time": observed_at.isoformat(),
        }
        canonical_json = json.dumps(
            raw_payload,
            sort_keys=True,
            separators=(",", ":"),
        )
        payload_sha256 = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
        insert_activity = text(
            """
            INSERT INTO broker_account_activities (
                id, provider, source, environment, account_label,
                endpoint_fingerprint, external_activity_id, activity_type,
                event_at, order_id, symbol, quantity, price, raw_payload,
                raw_payload_canonical_json, raw_payload_sha256,
                normalized_economic_sha256, first_observed_at
            ) VALUES (
                :id, 'alpaca', 'account_activities_rest', 'paper', 'paper-account',
                :endpoint_fingerprint, :external_activity_id, 'FILL',
                :event_at, 'order-01JTEST', 'BTC/USD', 0.0002, 64434.063,
                CAST(:raw_payload AS jsonb), :canonical_json, :payload_sha256,
                :normalized_economic_sha256, :first_observed_at
            )
            """
        )
        values = {
            "id": activity_id,
            "endpoint_fingerprint": "a" * 64,
            "external_activity_id": "activity-01JTEST",
            "event_at": observed_at,
            "raw_payload": canonical_json,
            "canonical_json": canonical_json,
            "payload_sha256": payload_sha256,
            "normalized_economic_sha256": "b" * 64,
            "first_observed_at": observed_at,
        }
        with schema_engine.begin() as connection:
            connection.execute(insert_activity, values)
            connection.execute(
                text(
                    """
                    INSERT INTO broker_account_activity_cursors (
                        id, provider, source, environment, account_label,
                        endpoint_fingerprint, scan_after
                    ) VALUES (
                        :id, 'alpaca', 'account_activities_rest', 'paper',
                        'paper-account', :endpoint_fingerprint, :scan_after
                    )
                    """
                ),
                {
                    "id": uuid.uuid4(),
                    "endpoint_fingerprint": "a" * 64,
                    "scan_after": observed_at,
                },
            )
            connection.execute(
                text(
                    """
                    UPDATE broker_account_activity_cursors
                       SET status = 'complete', pages_processed = 1,
                           activities_seen = 1, activities_inserted = 1,
                           updated_at = clock_timestamp()
                    """
                )
            )

        with schema_engine.connect() as connection:
            stored = connection.execute(
                text(
                    """
                    SELECT raw_payload_sha256,
                           raw_payload_canonical_json::jsonb = raw_payload AS matches
                      FROM broker_account_activities
                     WHERE id = :id
                    """
                ),
                {"id": activity_id},
            ).one()
            cursor = connection.execute(
                text(
                    """
                    SELECT status, pages_processed, activities_seen,
                           activities_inserted
                      FROM broker_account_activity_cursors
                    """
                )
            ).one()
        assert stored.raw_payload_sha256 == payload_sha256
        assert stored.matches is True
        assert tuple(cursor) == ("complete", 1, 1, 1)

        assert_rejected(
            schema_engine,
            "UPDATE broker_account_activities SET activity_type = 'CORRECTION'",
        )
        assert_rejected(schema_engine, "DELETE FROM broker_account_activities")
        assert_rejected(schema_engine, "TRUNCATE broker_account_activities")

        mismatched = dict(values)
        mismatched.update(
            id=uuid.uuid4(),
            external_activity_id="activity-01JHASH",
            payload_sha256="0" * 64,
        )
        with pytest.raises(DBAPIError):
            with schema_engine.begin() as connection:
                connection.execute(insert_activity, mismatched)

        with pytest.raises(DBAPIError):
            command.downgrade(alembic, "0075_validation_observed_at")
    finally:
        drop_schema(schema, admin_engine, schema_engine)
