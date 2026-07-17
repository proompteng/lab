from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from threading import Barrier

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.trading.order_lineage_receipts import (
    CLASSIFICATION_LINKED_INCOMPLETE,
    CLASSIFICATION_ORDER_FEED_ONLY,
    CONFIDENCE_EXACT,
    EXECUTION_SOURCE_CROSS_DSN,
    MATCH_BASIS_ALPACA_ORDER_ID,
    OrderLineageEvidence,
    build_order_lineage_receipt,
    persist_order_lineage_receipt,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    assert_rejected,
)
from tests.migration_testing import load_migration_module


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL guard test",
)
def test_postgres_receipts_have_one_evidence_authority_and_are_append_only() -> None:
    assert POSTGRES_DSN is not None
    schema = f"order_lineage_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    try:
        with admin_engine.begin() as connection:
            connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        _apply_migration(schema_engine, "0081_order_lineage_repair_receipts.py")

        now = datetime(2026, 7, 16, 20, 0, tzinfo=timezone.utc)
        source_event_id = uuid.uuid4()
        broker_fill_id = uuid.uuid4()
        execution_id = uuid.uuid4()
        evidence = OrderLineageEvidence(
            provider="alpaca",
            environment="paper",
            account_label="paper-account",
            alpaca_order_id="broker-order",
            client_order_id="decision-hash",
            classification=CLASSIFICATION_LINKED_INCOMPLETE,
            confidence=CONFIDENCE_EXACT,
            execution_source=EXECUTION_SOURCE_CROSS_DSN,
            canonical_execution_id=execution_id,
            order_event_ids=(source_event_id,),
            fill_order_event_ids=(source_event_id,),
            broker_activity_ids=(broker_fill_id,),
            broker_fill_activity_ids=(broker_fill_id,),
            source_first_at=now,
            source_last_at=now,
            match_basis=(MATCH_BASIS_ALPACA_ORDER_ID,),
            blockers=("decision_lineage_incomplete",),
        )
        draft = build_order_lineage_receipt(evidence)
        with Session(schema_engine) as session, session.begin():
            persisted = persist_order_lineage_receipt(
                session,
                draft,
                observed_at=now,
            )
            assert not persisted.reused_existing
            receipt_id = persisted.receipt.id
            source_gap = persist_order_lineage_receipt(
                session,
                build_order_lineage_receipt(
                    replace(
                        evidence,
                        alpaca_order_id="feed-only-broker-order",
                        client_order_id="feed-only-decision-hash",
                        classification=CLASSIFICATION_ORDER_FEED_ONLY,
                        broker_activity_ids=(),
                        broker_fill_activity_ids=(),
                        blockers=("broker_activity_missing",),
                    )
                ),
                observed_at=now,
            )
            assert not source_gap.reused_existing

        concurrent_draft = build_order_lineage_receipt(
            replace(
                evidence,
                alpaca_order_id="concurrent-broker-order",
                client_order_id="concurrent-decision-hash",
            )
        )
        start = Barrier(2)

        def persist_concurrently(_: int) -> bool:
            with Session(schema_engine) as session, session.begin():
                start.wait(timeout=10)
                return persist_order_lineage_receipt(
                    session,
                    concurrent_draft,
                    observed_at=now,
                ).reused_existing

        with ThreadPoolExecutor(max_workers=2) as executor:
            reused = list(executor.map(persist_concurrently, range(2)))
        assert sorted(reused) == [False, True]

        columns = {
            column["name"]
            for column in inspect(schema_engine).get_columns(
                "order_lineage_repair_receipts"
            )
        }
        assert "canonical_execution_id" not in columns
        assert "order_event_count" not in columns

        assert_rejected(
            schema_engine,
            "UPDATE order_lineage_repair_receipts SET observed_at = now()",
        )
        assert_rejected(schema_engine, "DELETE FROM order_lineage_repair_receipts")
        assert_rejected(schema_engine, "TRUNCATE order_lineage_repair_receipts")
        assert_rejected(
            schema_engine,
            """
            INSERT INTO order_lineage_repair_receipts (
                id, repair_version, provider, environment, account_label,
                order_identity_sha256, alpaca_order_id, client_order_id,
                classification, confidence, execution_source,
                source_first_at, source_last_at, evidence,
                evidence_canonical_json, evidence_sha256,
                promotion_authority_eligible, observed_at
            )
            SELECT
                :id, repair_version, provider, environment, account_label,
                order_identity_sha256, alpaca_order_id, client_order_id,
                classification, confidence, execution_source,
                source_first_at, source_last_at, evidence,
                evidence_canonical_json, repeat('0', 64),
                promotion_authority_eligible, observed_at
              FROM order_lineage_repair_receipts
            """,
            id=uuid.uuid4(),
        )
        _assert_noncanonical_evidence_rejected(
            schema_engine,
            receipt_id=receipt_id,
        )
        _assert_identity_hash_rejected(
            schema_engine,
            receipt_id=receipt_id,
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="sources.order_event_ids",
            value=["not-a-uuid"],
            error="source IDs are not canonical",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="sources.order_event_ids",
            value=[str(source_event_id), str(source_event_id)],
            error="source IDs are not canonical",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="match_basis",
            value=["unrelated"],
            error="match basis is not canonical",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="match_basis",
            value=["alpaca_order_id", "alpaca_order_id"],
            error="match basis is not canonical",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="links.execution_id",
            value=str(execution_id).upper(),
            error="causal link UUID is not canonical",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="blockers",
            value=["decision_lineage_incomplete", "decision_lineage_incomplete"],
            error="blockers are not canonical",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="extra",
            value="not-in-schema",
            error="evidence shape mismatch",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="promotion_authority_eligible",
            value="false",
            error="evidence scalar type mismatch",
        )
        _assert_evidence_value_rejected(
            schema_engine,
            receipt_id=receipt_id,
            json_path="sources.first_at",
            value="2026-07-16T20:00:00Z",
            error="source evidence mismatch",
        )
    finally:
        with admin_engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        schema_engine.dispose()
        admin_engine.dispose()


def _apply_migration(engine: Engine, filename: str) -> None:
    module = load_migration_module(filename)
    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            module.upgrade()


def _assert_noncanonical_evidence_rejected(
    engine: Engine,
    *,
    receipt_id: uuid.UUID,
) -> None:
    statement = text(
        """
        INSERT INTO order_lineage_repair_receipts (
            id, repair_version, provider, environment, account_label,
            order_identity_sha256, alpaca_order_id, client_order_id,
            classification, confidence, execution_source,
            source_first_at, source_last_at, evidence,
            evidence_canonical_json, evidence_sha256,
            promotion_authority_eligible, observed_at
        )
        SELECT
            :new_id, repair_version, provider, environment, account_label,
            order_identity_sha256, alpaca_order_id, client_order_id,
            classification, confidence, execution_source,
            source_first_at, source_last_at, evidence,
            evidence_canonical_json || E'\n',
            encode(
                sha256(convert_to(evidence_canonical_json || E'\n', 'UTF8')),
                'hex'
            ),
            promotion_authority_eligible, observed_at
          FROM order_lineage_repair_receipts
         WHERE id = :receipt_id
        """
    )
    with pytest.raises(DBAPIError, match="evidence JSON is not canonical"):
        with engine.begin() as connection:
            connection.execute(
                statement,
                {"new_id": uuid.uuid4(), "receipt_id": receipt_id},
            )


def _assert_identity_hash_rejected(
    engine: Engine,
    *,
    receipt_id: uuid.UUID,
) -> None:
    statement = text(
        """
        WITH source AS (
            SELECT *
              FROM order_lineage_repair_receipts
             WHERE id = :receipt_id
        ), changed AS (
            SELECT
                source.*,
                jsonb_set(
                    source.evidence,
                    '{order_identity,sha256}',
                    to_jsonb(CAST(:identity_sha256 AS text)),
                    false
                ) AS changed_evidence
              FROM source
        ), sealed AS (
            SELECT
                changed.*,
                changed_evidence::text AS changed_canonical_json
              FROM changed
        )
        INSERT INTO order_lineage_repair_receipts (
            id, repair_version, provider, environment, account_label,
            order_identity_sha256, alpaca_order_id, client_order_id,
            classification, confidence, execution_source,
            source_first_at, source_last_at, evidence,
            evidence_canonical_json, evidence_sha256,
            promotion_authority_eligible, observed_at
        )
        SELECT
            :new_id, repair_version, provider, environment, account_label,
            :identity_sha256, alpaca_order_id, client_order_id,
            classification, confidence, execution_source,
            source_first_at, source_last_at, changed_evidence,
            changed_canonical_json,
            encode(sha256(convert_to(changed_canonical_json, 'UTF8')), 'hex'),
            promotion_authority_eligible, observed_at
          FROM sealed
        """
    )
    with pytest.raises(DBAPIError, match="identity hash mismatch"):
        with engine.begin() as connection:
            connection.execute(
                statement,
                {
                    "identity_sha256": "f" * 64,
                    "new_id": uuid.uuid4(),
                    "receipt_id": receipt_id,
                },
            )


def _assert_evidence_value_rejected(
    engine: Engine,
    *,
    receipt_id: uuid.UUID,
    json_path: str,
    value: object,
    error: str,
) -> None:
    statement = text(
        """
        WITH source AS (
            SELECT *
              FROM order_lineage_repair_receipts
             WHERE id = :receipt_id
        ), changed AS (
            SELECT
                source.*,
                jsonb_set(
                    source.evidence,
                    string_to_array(:json_path, '.'),
                    CAST(:json_value AS jsonb),
                    true
                ) AS changed_evidence
              FROM source
        ), sealed AS (
            SELECT
                changed.*,
                changed_evidence::text AS changed_canonical_json
              FROM changed
        )
        INSERT INTO order_lineage_repair_receipts (
            id, repair_version, provider, environment, account_label,
            order_identity_sha256, alpaca_order_id, client_order_id,
            classification, confidence, execution_source,
            source_first_at, source_last_at, evidence,
            evidence_canonical_json, evidence_sha256,
            promotion_authority_eligible, observed_at
        )
        SELECT
            :new_id, repair_version, provider, environment, account_label,
            order_identity_sha256, alpaca_order_id, client_order_id,
            classification, confidence, execution_source,
            source_first_at, source_last_at, changed_evidence,
            changed_canonical_json,
            encode(sha256(convert_to(changed_canonical_json, 'UTF8')), 'hex'),
            promotion_authority_eligible, observed_at
          FROM sealed
        """
    )
    with pytest.raises(DBAPIError, match=error):
        with engine.begin() as connection:
            connection.execute(
                statement,
                {
                    "new_id": uuid.uuid4(),
                    "receipt_id": receipt_id,
                    "json_path": json_path,
                    "json_value": json.dumps(value),
                },
            )
