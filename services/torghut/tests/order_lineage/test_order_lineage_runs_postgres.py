from __future__ import annotations

import copy
import hashlib
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from threading import Barrier

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models import (
    BrokerEconomicLedgerInput,
    OrderLineageCanonicalExecutionImport,
    OrderLineageRepairReceipt,
    OrderLineageRepairRun,
)
from app.trading.order_lineage_census import (
    BrokerActivityFact,
    ExecutionLineageFact,
    OrderEventFact,
    OrderLineageCensusEvidence,
    build_order_lineage_census,
)
from app.trading.order_lineage_receipts import (
    canonical_jsonb_text,
)
from app.trading.order_lineage_runs import (
    OrderLineageCensusSources,
    OrderLineageRepairRunDraft,
    build_order_lineage_canonical_execution_import,
    build_order_lineage_repair_run,
    persist_order_lineage_census,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    assert_rejected,
)
from tests.migration_testing import load_migration_module


NOW = datetime(2026, 7, 17, 1, 0, 0, 120_000, tzinfo=timezone.utc)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL guard test",
)
def test_postgres_census_is_atomic_closed_and_append_only() -> None:
    assert POSTGRES_DSN is not None
    schema = f"order_lineage_run_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": (f"-csearch_path={schema} -cTimeZone=America/Los_Angeles")}
    )
    schema_engine = create_engine(schema_url, future=True)
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        _apply_migration(schema_engine, "0081_order_lineage_repair_receipts.py")
        _create_broker_input_parent(schema_engine)
        _create_source_tables(schema_engine)
        _apply_migration(schema_engine, "0082_order_lineage_repair_runs.py")

        input_id = uuid.uuid4()
        activity_id = uuid.uuid4()
        _insert_broker_input(schema_engine, input_id=input_id, manifest_sha="b" * 64)
        _insert_source_rows(schema_engine, activity_id=activity_id)
        sources, receipt = _sources(
            input_id=input_id,
            manifest_sha="b" * 64,
            activity_id=activity_id,
        )
        start = Barrier(2)

        def persist_concurrently(_: int) -> tuple[bool, int, int]:
            with Session(schema_engine) as session, session.begin():
                start.wait(timeout=10)
                persisted = persist_order_lineage_census(
                    session,
                    sources,
                    [receipt],
                    observed_at=NOW,
                )
                return (
                    persisted.run.reused_existing,
                    persisted.inserted_receipt_count,
                    persisted.reused_receipt_count,
                )

        with ThreadPoolExecutor(max_workers=2) as executor:
            concurrent_results = list(executor.map(persist_concurrently, range(2)))
        assert sorted(concurrent_results) == [(False, 1, 0), (True, 0, 1)]
        _assert_row_counts(schema_engine, receipts=1, runs=1)

        assert_rejected(
            schema_engine,
            "UPDATE order_lineage_repair_runs SET observed_at = now()",
        )
        assert_rejected(schema_engine, "DELETE FROM order_lineage_repair_runs")
        assert_rejected(schema_engine, "TRUNCATE order_lineage_repair_runs")
        assert_rejected(
            schema_engine,
            "UPDATE order_lineage_canonical_execution_imports SET observed_at = now()",
        )
        assert_rejected(
            schema_engine,
            "DELETE FROM order_lineage_canonical_execution_imports",
        )
        assert_rejected(
            schema_engine,
            "TRUNCATE order_lineage_canonical_execution_imports",
        )

        draft = build_order_lineage_repair_run(sources, [receipt])
        _assert_noncanonical_run_rejected(schema_engine, draft)
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_nested(
                value,
                "broker_economic_manifest_sha256",
                "0" * 64,
            ),
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_nested(value, "unexpected", True),
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_nested(
                value,
                "broker_economic_input_id",
                str(input_id).upper(),
            ),
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_nested(
                value,
                "broker_source_watermark",
                "2026-07-17T01:00:00Z",
            ),
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: value,
            mutate_result=lambda value: _set_nested(value, "unexpected", True),
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_nested(
                value,
                "order_feed",
                {"event_count": 1, "probe": "classification-count"},
            ),
            mutate_result=lambda value: _set_count(
                value,
                "classification_counts",
                "complete",
                2,
            ),
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_nested(
                value,
                "order_feed",
                {"event_count": 1, "probe": "source-count"},
            ),
            mutate_result=lambda value: _set_count(
                value,
                "source_coverage_counts",
                "both",
                2,
            ),
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_manifest_value(
                value,
                "broker_order_links",
                "activity_set_sha256",
                "d" * 64,
            ),
            match="persisted source manifest mismatch",
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_manifest_value(
                value,
                "order_feed",
                "event_set_sha256",
                "d" * 64,
            ),
            match="persisted source manifest mismatch",
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_manifest_value(
                value,
                "executions",
                "local_execution_set_sha256",
                "e" * 64,
            ),
            match="persisted source manifest mismatch",
        )
        _assert_invalid_run_rejected(
            schema_engine,
            draft,
            mutate_input=lambda value: _set_expected_receipt_count(
                value,
                count=2,
                event_set_sha256="e" * 64,
            ),
            mutate_result=lambda value: _set_result_receipt_count(value, count=2),
            receipt_count=2,
            match="persisted source manifest mismatch",
        )
        _assert_row_counts(schema_engine, receipts=1, runs=1)

        changed_input_id = uuid.uuid4()
        changed_at = NOW + timedelta(minutes=1)
        _insert_broker_input(
            schema_engine,
            input_id=changed_input_id,
            manifest_sha="c" * 64,
            source_watermark=changed_at,
        )
        changed_sources = replace(
            sources,
            broker_economic_input_id=changed_input_id,
            broker_economic_manifest_sha256="c" * 64,
            broker_source_watermark=changed_at,
        )
        with Session(schema_engine) as session, session.begin():
            changed = persist_order_lineage_census(
                session,
                changed_sources,
                [receipt],
                observed_at=changed_at,
            )
            assert not changed.run.reused_existing
            assert changed.reused_receipt_count == 1
        _assert_row_counts(schema_engine, receipts=1, runs=2)
    finally:
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        schema_engine.dispose()
        admin_engine.dispose()


def _create_broker_input_parent(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE broker_economic_ledger_inputs (
                    id UUID PRIMARY KEY,
                    provider VARCHAR(32) NOT NULL,
                    source VARCHAR(64) NOT NULL,
                    environment VARCHAR(16) NOT NULL,
                    account_label VARCHAR(64) NOT NULL,
                    endpoint_fingerprint VARCHAR(64) NOT NULL,
                    quote_currency VARCHAR(16) NOT NULL,
                    source_cursor_id UUID NOT NULL,
                    source_watermark TIMESTAMPTZ NOT NULL,
                    input_count BIGINT NOT NULL,
                    duplicate_count BIGINT NOT NULL,
                    corrected_count BIGINT NOT NULL,
                    manifest_canonical_json TEXT NOT NULL,
                    manifest_sha256 VARCHAR(64) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
        )


def _create_source_tables(engine: Engine) -> None:
    statements = (
        """
        CREATE TABLE broker_account_activities (
            id UUID PRIMARY KEY,
            provider VARCHAR(32) NOT NULL,
            source VARCHAR(64) NOT NULL,
            environment VARCHAR(16) NOT NULL,
            account_label VARCHAR(64) NOT NULL,
            endpoint_fingerprint VARCHAR(64) NOT NULL,
            external_activity_id VARCHAR(256) NOT NULL,
            activity_type VARCHAR(32) NOT NULL,
            event_at TIMESTAMPTZ,
            order_id VARCHAR(128),
            client_order_id VARCHAR(128),
            first_observed_at TIMESTAMPTZ NOT NULL
        )
        """,
        """
        CREATE TABLE execution_order_events (
            id UUID PRIMARY KEY,
            event_fingerprint VARCHAR(64) NOT NULL,
            source_topic VARCHAR(128) NOT NULL,
            source_partition INTEGER,
            source_offset BIGINT,
            alpaca_account_label VARCHAR(64) NOT NULL,
            event_ts TIMESTAMPTZ,
            alpaca_order_id VARCHAR(128),
            client_order_id VARCHAR(128),
            filled_qty_delta NUMERIC(21, 9),
            execution_id UUID,
            trade_decision_id UUID,
            created_at TIMESTAMPTZ NOT NULL
        )
        """,
        """
        CREATE TABLE trade_decisions (
            id UUID PRIMARY KEY,
            strategy_id UUID NOT NULL
        )
        """,
        """
        CREATE TABLE executions (
            id UUID PRIMARY KEY,
            trade_decision_id UUID,
            alpaca_account_label VARCHAR(64) NOT NULL,
            alpaca_order_id VARCHAR(128) NOT NULL,
            client_order_id VARCHAR(128),
            execution_idempotency_key VARCHAR(96),
            updated_at TIMESTAMPTZ NOT NULL
        )
        """,
        """
        CREATE TABLE execution_tca_metrics (
            id UUID PRIMARY KEY,
            execution_id UUID NOT NULL UNIQUE,
            trade_decision_id UUID,
            strategy_id UUID
        )
        """,
        """
        CREATE TABLE trade_decision_submission_claims (
            trade_decision_id UUID PRIMARY KEY
        )
        """,
    )
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


def _apply_migration(engine: Engine, filename: str) -> None:
    module = load_migration_module(filename)
    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            module.upgrade()


def _insert_broker_input(
    engine: Engine,
    *,
    input_id: uuid.UUID,
    manifest_sha: str,
    source_watermark: datetime = NOW,
) -> None:
    with Session(engine) as session, session.begin():
        session.add(
            BrokerEconomicLedgerInput(
                id=input_id,
                provider="alpaca",
                source="account_activities_rest",
                environment="paper",
                account_label="paper-account",
                endpoint_fingerprint="e" * 64,
                quote_currency="USD",
                source_cursor_id=uuid.uuid4(),
                source_watermark=source_watermark,
                input_count=1,
                duplicate_count=0,
                corrected_count=0,
                manifest_canonical_json="{}",
                manifest_sha256=manifest_sha,
            )
        )


def _sources(
    *,
    input_id: uuid.UUID,
    manifest_sha: str,
    activity_id: uuid.UUID,
) -> tuple[OrderLineageCensusSources, object]:
    census = build_order_lineage_census(
        OrderLineageCensusEvidence(
            provider="alpaca",
            environment="paper",
            account_label="paper-account",
            canonical_account_label_sha256="c" * 64,
            order_events=(
                OrderEventFact(
                    id=uuid.UUID(int=1),
                    event_fingerprint="f" * 64,
                    broker_order_id="broker-order",
                    client_order_id="client-order",
                    event_at=NOW,
                    is_fill=True,
                    execution_id=None,
                    trade_decision_id=None,
                    source_topic="trade-updates",
                    source_partition=0,
                    source_offset=1,
                ),
            ),
            broker_activities=(
                BrokerActivityFact(
                    id=activity_id,
                    external_activity_id="activity-1",
                    activity_type="FILL",
                    broker_order_id="broker-order",
                    client_order_id="client-order",
                    event_at=NOW,
                ),
            ),
            local_executions=(),
            canonical_executions=(
                ExecutionLineageFact(
                    source="canonical_cross_dsn",
                    execution_id=uuid.UUID(int=2),
                    broker_order_id="broker-order",
                    client_order_id="client-order",
                    idempotency_key=None,
                    trade_decision_id=None,
                    strategy_id=None,
                    submission_claim_id=None,
                    tca_metric_id=None,
                    updated_at=NOW,
                ),
            ),
        )
    )
    execution_import = build_order_lineage_canonical_execution_import(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        source_database_sha256="9" * 64,
        execution_manifest=census.execution_manifest,
    )
    sources = OrderLineageCensusSources(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        broker_economic_input_id=input_id,
        broker_economic_source="account_activities_rest",
        broker_economic_manifest_sha256=manifest_sha,
        broker_activity_count=1,
        broker_source_watermark=NOW,
        broker_order_link_manifest=census.broker_order_link_manifest,
        order_feed_manifest=census.order_feed_manifest,
        execution_manifest=census.execution_manifest,
        canonical_execution_import=execution_import,
    )
    return sources, census.receipts[0]


def _insert_source_rows(engine: Engine, *, activity_id: uuid.UUID) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO broker_account_activities (
                    id, provider, source, environment, account_label,
                    endpoint_fingerprint, external_activity_id, activity_type,
                    event_at, order_id, client_order_id, first_observed_at
                ) VALUES (
                    :id, 'alpaca', 'account_activities_rest', 'paper',
                    'paper-account', :endpoint, 'activity-1', 'FILL', :now,
                    'broker-order', 'client-order', :now
                )
                """
            ),
            {"id": activity_id, "endpoint": "e" * 64, "now": NOW},
        )
        connection.execute(
            text(
                """
                INSERT INTO execution_order_events (
                    id, event_fingerprint, source_topic, source_partition,
                    source_offset, alpaca_account_label, event_ts,
                    alpaca_order_id, client_order_id, filled_qty_delta,
                    execution_id, trade_decision_id, created_at
                ) VALUES (
                    :id, :fingerprint, 'trade-updates', 0, 1,
                    'paper-account', :now, 'broker-order', 'client-order',
                    1, NULL, NULL, :now
                )
                """
            ),
            {"id": uuid.UUID(int=1), "fingerprint": "f" * 64, "now": NOW},
        )


def _assert_invalid_run_rejected(
    engine: Engine,
    draft: OrderLineageRepairRunDraft,
    *,
    mutate_input: Callable[[dict[str, object]], dict[str, object]],
    mutate_result: Callable[[dict[str, object]], dict[str, object]] | None = None,
    receipt_count: int | None = None,
    match: str | None = None,
) -> None:
    input_manifest = mutate_input(copy.deepcopy(draft.input_manifest))
    result = copy.deepcopy(draft.result)
    if mutate_result is not None:
        result = mutate_result(result)
    input_json = canonical_jsonb_text(input_manifest)
    result_json = canonical_jsonb_text(result)
    row = OrderLineageRepairRun(
        repair_version=draft.repair_version,
        provider=draft.provider,
        environment=draft.environment,
        account_label=draft.account_label,
        broker_economic_input_id=draft.broker_economic_input_id,
        canonical_execution_import_sha256=(draft.canonical_execution_import_sha256),
        input_manifest=input_manifest,
        input_manifest_canonical_json=input_json,
        input_manifest_sha256=_sha256(input_json),
        receipt_count=(draft.receipt_count if receipt_count is None else receipt_count),
        result=result,
        result_canonical_json=result_json,
        result_sha256=_sha256(result_json),
        promotion_authority_eligible=False,
        observed_at=NOW,
    )
    with pytest.raises(DBAPIError, match=match):
        with Session(engine) as session, session.begin():
            session.add(row)
            session.flush()


def _assert_noncanonical_run_rejected(
    engine: Engine,
    draft: OrderLineageRepairRunDraft,
) -> None:
    input_json = f"{draft.input_manifest_canonical_json}\n"
    row = OrderLineageRepairRun(
        repair_version=draft.repair_version,
        provider=draft.provider,
        environment=draft.environment,
        account_label=draft.account_label,
        broker_economic_input_id=draft.broker_economic_input_id,
        canonical_execution_import_sha256=(draft.canonical_execution_import_sha256),
        input_manifest=draft.input_manifest,
        input_manifest_canonical_json=input_json,
        input_manifest_sha256=_sha256(input_json),
        receipt_count=draft.receipt_count,
        result=draft.result,
        result_canonical_json=draft.result_canonical_json,
        result_sha256=draft.result_sha256,
        promotion_authority_eligible=False,
        observed_at=NOW,
    )
    with pytest.raises(DBAPIError, match="run JSON is not canonical"):
        with Session(engine) as session, session.begin():
            session.add(row)
            session.flush()


def _set_nested(value: dict[str, object], key: str, replacement: object):
    value[key] = replacement
    return value


def _set_count(
    value: dict[str, object],
    section: str,
    key: str,
    count: int,
):
    counts = value[section]
    assert isinstance(counts, dict)
    counts[key] = count
    return value


def _set_manifest_value(
    value: dict[str, object],
    section: str,
    key: str,
    replacement: object,
) -> dict[str, object]:
    document = value[section]
    assert isinstance(document, dict)
    document[key] = replacement
    return value


def _set_expected_receipt_count(
    value: dict[str, object],
    *,
    count: int,
    event_set_sha256: str,
) -> dict[str, object]:
    value["expected_order_identity_count"] = count
    return _set_manifest_value(
        value,
        "order_feed",
        "event_set_sha256",
        event_set_sha256,
    )


def _set_result_receipt_count(
    value: dict[str, object],
    *,
    count: int,
) -> dict[str, object]:
    value["receipt_count"] = count
    for section, key in (
        ("classification_counts", "linked_incomplete"),
        ("confidence_counts", "exact"),
        ("execution_source_counts", "canonical_cross_dsn"),
        ("source_coverage_counts", "both"),
    ):
        _set_count(value, section, key, count)
    return value


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _assert_row_counts(engine: Engine, *, receipts: int, runs: int) -> None:
    with Session(engine) as session:
        assert (
            session.scalar(
                select(func.count(OrderLineageCanonicalExecutionImport.manifest_sha256))
            )
            == 1
        )
        assert (
            session.scalar(select(func.count(OrderLineageRepairReceipt.id))) == receipts
        )
        assert session.scalar(select(func.count(OrderLineageRepairRun.id))) == runs
