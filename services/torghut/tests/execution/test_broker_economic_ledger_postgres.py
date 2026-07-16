from __future__ import annotations

import hashlib
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    BrokerAccountActivityCursor,
    BrokerEconomicLedgerEntry,
    BrokerEconomicLedgerInput,
    BrokerEconomicLedgerReconciliation,
    BrokerEconomicLedgerRun,
)
from app.trading.broker_account_activities import (
    BrokerActivityObservation,
    normalize_broker_account_activity,
)
from app.trading.economic_ledger import (
    BrokerEconomicReconciliationBuild,
    LedgerScope,
    normalize_broker_economic_snapshot,
    persist_broker_economic_ledger_reconciliation,
    publish_broker_economic_ledger,
    replay_broker_economic_ledger,
)
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
    reason="set TORGHUT_TEST_POSTGRES_DSN for broker economic ledger fencing",
)
def test_postgres_ledger_publication_is_atomic_balanced_and_immutable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "broker_economic_ledger"
    )
    public_revision_before = _public_alembic_revision(admin_engine)
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        upgrade_reduction_schema(
            alembic,
            schema_engine,
            target="0074_crypto_qty_precision",
        )
        command.upgrade(alembic, "0080_broker_econ_recon_freshness")
        assert _public_alembic_revision(admin_engine) == public_revision_before
        with schema_engine.connect() as connection:
            assert connection.scalar(
                text("SELECT version_num FROM alembic_version")
            ) == ("0080_broker_econ_recon_freshness")
        sessions = sessionmaker(bind=schema_engine, expire_on_commit=False, future=True)
        scope = _seed_source(sessions)

        barrier = threading.Barrier(2)

        def publish_once():
            with sessions() as session, session.begin():
                replay = replay_broker_economic_ledger(session, scope=scope)
                barrier.wait(timeout=10)
                return publish_broker_economic_ledger(
                    session,
                    replay,
                    confirmation_token=replay.publication_token,
                )

        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(publish_once)
            second_future = pool.submit(publish_once)
            first = first_future.result(timeout=30)
            second = second_future.result(timeout=30)

        assert first.journal_run_id == second.journal_run_id
        assert first.state_run_id == second.state_run_id
        assert {first.reused_existing, second.reused_existing} == {False, True}

        with sessions() as session:
            input_row = session.scalar(select(BrokerEconomicLedgerInput))
            runs = tuple(session.scalars(select(BrokerEconomicLedgerRun)))
            entry_count = session.scalar(
                select(func.count()).select_from(BrokerEconomicLedgerEntry)
            )
            journal = next(
                row for row in runs if row.reducer_name == "balanced_journal"
            )
        assert input_row is not None
        assert len(runs) == 2
        assert entry_count == journal.entry_count
        assert entry_count is not None and entry_count > 0
        assert all(run.admissible for run in runs)
        assert {run.input_id for run in runs} == {input_row.id}
        assert len({run.comparison_sha256 for run in runs}) == 1

        snapshot = normalize_broker_economic_snapshot(
            account={"status": "ACTIVE", "cash": "1010", "equity": "1010"},
            positions=[],
            open_orders=[],
            observed_at=datetime(2026, 7, 16, 13, 2, tzinfo=timezone.utc),
        )
        with sessions.begin() as session:
            replay = replay_broker_economic_ledger(session, scope=scope)
            observation = persist_broker_economic_ledger_reconciliation(
                session,
                replay,
                snapshot,
                build=BrokerEconomicReconciliationBuild(
                    source_commit="a" * 40,
                    image_digest=f"sha256:{'b' * 64}",
                ),
            )
        assert observation.result.reconciled is True
        with sessions() as session:
            reconciliation = session.scalar(select(BrokerEconomicLedgerReconciliation))
        assert reconciliation is not None
        assert reconciliation.journal_run_id == journal.id
        assert reconciliation.result_sha256 == observation.result.result_sha256

        with sessions.begin() as session:
            cursor = session.scalar(select(BrokerAccountActivityCursor))
            assert cursor is not None
            assert cursor.last_completed_at is not None
            assert cursor.last_completed_scan_until is not None
            cursor.last_completed_at = datetime(2026, 7, 16, 13, 3, tzinfo=timezone.utc)
            cursor.last_completed_scan_until = datetime(
                2026, 7, 16, 13, 2, tzinfo=timezone.utc
            )
        later_snapshot = normalize_broker_economic_snapshot(
            account={"status": "ACTIVE", "cash": "1010", "equity": "1010"},
            positions=[],
            open_orders=[],
            observed_at=datetime(2026, 7, 16, 13, 3, tzinfo=timezone.utc),
        )
        with sessions.begin() as session:
            advanced_replay = replay_broker_economic_ledger(session, scope=scope)
            later_observation = persist_broker_economic_ledger_reconciliation(
                session,
                advanced_replay,
                later_snapshot,
                build=BrokerEconomicReconciliationBuild(
                    source_commit="a" * 40,
                    image_digest=f"sha256:{'b' * 64}",
                ),
            )
        assert later_observation.runs.source_watermark == input_row.source_watermark
        assert later_observation.result.payload["input_source_watermark"] == (
            input_row.source_watermark.isoformat()
        )
        assert later_observation.result.payload["source_watermark"] == (
            advanced_replay.snapshot.source_watermark.isoformat()
        )
        with sessions() as session:
            assert (
                session.scalar(
                    select(func.count()).select_from(BrokerEconomicLedgerReconciliation)
                )
                == 2
            )

        _assert_manifest_hash_rejected(schema_engine, input_row)
        assert_rejected(
            schema_engine,
            "UPDATE broker_economic_ledger_inputs SET input_count = 0",
        )
        assert_rejected(schema_engine, "DELETE FROM broker_economic_ledger_inputs")
        assert_rejected(schema_engine, "TRUNCATE broker_economic_ledger_inputs")
        assert_rejected(
            schema_engine,
            "UPDATE broker_economic_ledger_runs SET admissible = false",
        )
        assert_rejected(schema_engine, "DELETE FROM broker_economic_ledger_runs")
        assert_rejected(schema_engine, "TRUNCATE broker_economic_ledger_runs")
        assert_rejected(
            schema_engine,
            "UPDATE broker_economic_ledger_entries SET amount = amount + 1",
        )
        assert_rejected(schema_engine, "DELETE FROM broker_economic_ledger_entries")
        assert_rejected(schema_engine, "TRUNCATE broker_economic_ledger_entries")
        assert_rejected(
            schema_engine,
            "UPDATE broker_economic_ledger_reconciliations SET reconciled = false",
        )
        assert_rejected(
            schema_engine, "DELETE FROM broker_economic_ledger_reconciliations"
        )
        assert_rejected(
            schema_engine, "TRUNCATE broker_economic_ledger_reconciliations"
        )
        _assert_reconciliation_source_invariants_rejected(schema_engine, reconciliation)
        _assert_reconciliation_run_swap_rejected(schema_engine, reconciliation)
        _assert_unbalanced_run_rejected(schema_engine, journal)

        with pytest.raises(DBAPIError):
            command.downgrade(alembic, "0077_validation_quarantine")
    finally:
        drop_schema(schema, admin_engine, schema_engine)


def _public_alembic_revision(engine) -> str | None:
    with engine.connect() as connection:
        exists = connection.scalar(
            text("SELECT to_regclass('public.alembic_version') IS NOT NULL")
        )
        if not exists:
            return None
        return connection.scalar(text("SELECT version_num FROM public.alembic_version"))


def _seed_source(sessions: sessionmaker[Session]) -> LedgerScope:
    observed_at = datetime(2026, 7, 16, 13, 0, tzinfo=timezone.utc)
    scope = LedgerScope(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        endpoint_fingerprint="a" * 64,
    )
    observation = BrokerActivityObservation(
        environment=scope.environment,
        account_label=scope.account_label,
        endpoint_fingerprint=scope.endpoint_fingerprint,
        observed_at=observed_at,
    )
    payloads: tuple[dict[str, object], ...] = (
        {
            "activity_type": "CSD",
            "currency": "USD",
            "date": "2026-07-16",
            "id": "cash",
            "net_amount": "1000",
        },
        {
            "activity_type": "FILL",
            "currency": "USD",
            "id": "buy",
            "price": "100",
            "qty": "1",
            "side": "buy",
            "symbol": "AAPL",
            "transaction_time": "2026-07-16T13:00:01Z",
        },
        {
            "activity_type": "FILL",
            "currency": "USD",
            "id": "sell",
            "price": "110",
            "qty": "1",
            "side": "sell",
            "symbol": "AAPL",
            "transaction_time": "2026-07-16T13:00:02Z",
        },
    )
    rows = [
        normalize_broker_account_activity(
            payload,
            observation=observation,
            source_page_token=None,
        )
        for payload in payloads
    ]
    with sessions.begin() as session:
        session.add_all(rows)
        session.add(
            BrokerAccountActivityCursor(
                provider=scope.provider,
                source="account_activities_rest",
                environment=scope.environment,
                account_label=scope.account_label,
                endpoint_fingerprint=scope.endpoint_fingerprint,
                status="complete",
                scan_after=datetime(2016, 1, 1, tzinfo=timezone.utc),
                scan_until=None,
                next_page_token=None,
                last_completed_at=datetime(2026, 7, 16, 13, 2, tzinfo=timezone.utc),
                last_completed_scan_until=datetime(
                    2026, 7, 16, 13, 1, tzinfo=timezone.utc
                ),
                pages_processed=1,
                activities_seen=len(rows),
                activities_inserted=len(rows),
            )
        )
    return scope


def _assert_unbalanced_run_rejected(
    schema_engine,
    valid: BrokerEconomicLedgerRun,
) -> None:
    bad_run_id = uuid.uuid4()
    bad_version = "torghut.broker-economic-journal.unbalanced-test.v1"
    result = json.loads(json.dumps(valid.result))
    result["reducer_version"] = bad_version
    result["journal_sha256"] = "b" * 64
    result_canonical_json = json.dumps(
        result,
        sort_keys=True,
        separators=(",", ":"),
    )
    with pytest.raises(DBAPIError):
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO broker_economic_ledger_entries (
                        run_id, transaction_index, line_number,
                        source_activity_id, transaction_id, posting_rule,
                        transaction_sha256, account, commodity, amount
                    ) VALUES (
                        :run_id, 0, 0, 'cash', 'bad-unbalanced', 'test',
                        :transaction_sha256, 'asset:cash', 'USD', 1
                    )
                    """
                ),
                {"run_id": bad_run_id, "transaction_sha256": "c" * 64},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO broker_economic_ledger_runs (
                        id, input_id, reducer_name, reducer_version,
                        unsupported_count, transaction_count, entry_count,
                        admissible, result, result_canonical_json, result_sha256,
                        projection_sha256, comparison_sha256, journal_sha256
                    ) VALUES (
                        :id, :input_id, :reducer_name, :reducer_version,
                        0, 1, 1, true,
                        CAST(:result AS jsonb), :result, :result_sha256,
                        :projection_sha256, :comparison_sha256, :journal_sha256
                    )
                    """
                ),
                {
                    "id": bad_run_id,
                    "input_id": valid.input_id,
                    "reducer_name": valid.reducer_name,
                    "reducer_version": bad_version,
                    "result": result_canonical_json,
                    "result_sha256": hashlib.sha256(
                        result_canonical_json.encode("utf-8")
                    ).hexdigest(),
                    "projection_sha256": valid.projection_sha256,
                    "comparison_sha256": valid.comparison_sha256,
                    "journal_sha256": "b" * 64,
                },
            )


def _assert_reconciliation_run_swap_rejected(
    schema_engine,
    valid: BrokerEconomicLedgerReconciliation,
) -> None:
    with pytest.raises(DBAPIError):
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO broker_economic_ledger_reconciliations (
                        id, input_id, journal_run_id, state_run_id,
                        input_source_watermark, source_watermark,
                        observed_at, source_age_seconds,
                        max_source_age_seconds, broker_snapshot,
                        broker_snapshot_canonical_json, broker_snapshot_sha256,
                        result, result_canonical_json, result_sha256,
                        comparison_sha256, journal_sha256, reconciled,
                        residual_count, open_order_count, source_commit, image_digest
                    ) VALUES (
                        :id, :input_id, :state_run_id, :journal_run_id,
                        :input_source_watermark, :source_watermark,
                        :observed_at, :source_age_seconds,
                        :max_source_age_seconds, CAST(:broker_snapshot AS jsonb),
                        :broker_snapshot, :broker_snapshot_sha256,
                        CAST(:result AS jsonb), :result, :result_sha256,
                        :comparison_sha256, :journal_sha256, :reconciled,
                        :residual_count, :open_order_count, :source_commit, :image_digest
                    )
                    """
                ),
                {
                    "id": uuid.uuid4(),
                    "input_id": valid.input_id,
                    "journal_run_id": valid.journal_run_id,
                    "state_run_id": valid.state_run_id,
                    "input_source_watermark": valid.input_source_watermark,
                    "source_watermark": valid.source_watermark,
                    "observed_at": valid.observed_at,
                    "source_age_seconds": valid.source_age_seconds,
                    "max_source_age_seconds": valid.max_source_age_seconds,
                    "broker_snapshot": valid.broker_snapshot_canonical_json,
                    "broker_snapshot_sha256": valid.broker_snapshot_sha256,
                    "result": valid.result_canonical_json,
                    "result_sha256": valid.result_sha256,
                    "comparison_sha256": valid.comparison_sha256,
                    "journal_sha256": valid.journal_sha256,
                    "reconciled": valid.reconciled,
                    "residual_count": valid.residual_count,
                    "open_order_count": valid.open_order_count,
                    "source_commit": valid.source_commit,
                    "image_digest": valid.image_digest,
                },
            )


def _assert_reconciliation_source_invariants_rejected(
    schema_engine,
    valid: BrokerEconomicLedgerReconciliation,
) -> None:
    invalid_cases = (
        (
            "input_source_watermark + INTERVAL '1 second'",
            "source_watermark",
            "source_age_seconds",
            "broker economic reconciliation source identity mismatch",
        ),
        (
            "input_source_watermark",
            "source_watermark + INTERVAL '1 second'",
            "source_age_seconds",
            "broker economic reconciliation source age mismatch",
        ),
        (
            "input_source_watermark",
            "source_watermark",
            "source_age_seconds + 1",
            "broker economic reconciliation source age mismatch",
        ),
    )
    for (
        input_watermark_sql,
        source_watermark_sql,
        source_age_sql,
        expected_error,
    ) in invalid_cases:
        with pytest.raises(DBAPIError, match=expected_error):
            with schema_engine.begin() as connection:
                connection.execute(
                    text(
                        f"""
                        INSERT INTO broker_economic_ledger_reconciliations (
                            id, input_id, journal_run_id, state_run_id,
                            input_source_watermark, source_watermark,
                            observed_at, source_age_seconds,
                            max_source_age_seconds, broker_snapshot,
                            broker_snapshot_canonical_json, broker_snapshot_sha256,
                            result, result_canonical_json, result_sha256,
                            comparison_sha256, journal_sha256, reconciled,
                            residual_count, open_order_count, source_commit, image_digest
                        )
                        SELECT
                            :id, input_id, journal_run_id, state_run_id,
                            {input_watermark_sql}, {source_watermark_sql},
                            observed_at, {source_age_sql},
                            max_source_age_seconds, broker_snapshot,
                            broker_snapshot_canonical_json, broker_snapshot_sha256,
                            result, result_canonical_json, result_sha256,
                            comparison_sha256, journal_sha256, reconciled,
                            residual_count, open_order_count, source_commit, image_digest
                        FROM broker_economic_ledger_reconciliations
                        WHERE id = :valid_id
                        """
                    ),
                    {"id": uuid.uuid4(), "valid_id": valid.id},
                )


def _assert_manifest_hash_rejected(
    schema_engine,
    valid: BrokerEconomicLedgerInput,
) -> None:
    with pytest.raises(DBAPIError):
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO broker_economic_ledger_inputs (
                        id, provider, source, environment, account_label,
                        endpoint_fingerprint, quote_currency, source_cursor_id,
                        source_watermark, input_count, duplicate_count,
                        corrected_count, manifest_canonical_json, manifest_sha256
                    ) VALUES (
                        :id, :provider, :source, :environment, :account_label,
                        :endpoint_fingerprint, :quote_currency, :source_cursor_id,
                        :source_watermark, :input_count, :duplicate_count,
                        :corrected_count, :manifest_canonical_json, :manifest_sha256
                    )
                    """
                ),
                {
                    "id": uuid.uuid4(),
                    "provider": valid.provider,
                    "source": valid.source,
                    "environment": valid.environment,
                    "account_label": valid.account_label,
                    "endpoint_fingerprint": valid.endpoint_fingerprint,
                    "quote_currency": valid.quote_currency,
                    "source_cursor_id": valid.source_cursor_id,
                    "source_watermark": valid.source_watermark,
                    "input_count": valid.input_count,
                    "duplicate_count": valid.duplicate_count,
                    "corrected_count": valid.corrected_count,
                    "manifest_canonical_json": valid.manifest_canonical_json,
                    "manifest_sha256": "0" * 64,
                },
            )
