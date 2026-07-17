from __future__ import annotations

import argparse
import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models import BrokerEconomicLedgerInput, ExecutionOrderEvent
from app.trading.order_lineage_census import (
    BrokerActivityFact,
    OrderEventFact,
    OrderLineageCensusEvidence,
    build_order_lineage_census,
)
from scripts import reconcile_cross_dsn_order_feed_links as script
from tests.repair_order_feed_source_windows_script.support import (
    FakeSession,
    FakeSessionFactory,
    seed_canonical_execution,
    sqlite_model_engine,
)


BASE_TIME = datetime(2026, 7, 17, 1, 0, tzinfo=timezone.utc)


def runtime_census() -> script.RuntimeCensus:
    broker_input = BrokerEconomicLedgerInput(
        id=uuid.UUID(int=100),
        provider="alpaca",
        source="account_activities_rest",
        environment="paper",
        account_label="source-account",
        endpoint_fingerprint="e" * 64,
        quote_currency="USD",
        source_cursor_id=uuid.uuid4(),
        source_watermark=BASE_TIME,
        input_count=1,
        duplicate_count=0,
        corrected_count=0,
        manifest_canonical_json="[]",
        manifest_sha256="b" * 64,
    )
    census = build_order_lineage_census(
        OrderLineageCensusEvidence(
            provider="alpaca",
            environment="paper",
            account_label="source-account",
            canonical_account_label_sha256="c" * 64,
            order_events=(
                OrderEventFact(
                    id=uuid.UUID(int=1),
                    event_fingerprint="1" * 64,
                    broker_order_id="broker-order",
                    client_order_id="decision-hash",
                    event_at=BASE_TIME,
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
                    id=uuid.UUID(int=2),
                    external_activity_id="activity-1",
                    activity_type="FILL",
                    broker_order_id="broker-order",
                    client_order_id=None,
                    event_at=BASE_TIME,
                ),
            ),
            local_executions=(),
            canonical_executions=(),
        )
    )
    return script.RuntimeCensus(
        broker_input=broker_input,
        census=census,
        source_account_label_sha256="d" * 64,
        canonical_account_label_sha256="c" * 64,
    )


def test_parse_args_and_dsn_normalization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TRADING_ACCOUNT_LABEL", "source-account")
    monkeypatch.setattr(
        "sys.argv",
        ["reconcile_cross_dsn_order_feed_links.py", "--apply", "--json"],
    )
    args = script.parse_args()

    assert args.source_account_label == "source-account"
    assert args.canonical_account_label == ""
    assert args.apply is True
    assert args.json is True
    assert script.sqlalchemy_dsn("postgres://example/live") == (
        "postgresql+psycopg://example/live"
    )
    assert script.sqlalchemy_dsn("postgresql://example/sim") == (
        "postgresql+psycopg://example/sim"
    )
    assert script.sqlalchemy_dsn("sqlite+pysqlite:///:memory:") == (
        "sqlite+pysqlite:///:memory:"
    )


def test_load_order_events_preserves_source_without_mutation() -> None:
    engine = sqlite_model_engine()
    with Session(engine) as session, session.begin():
        row = ExecutionOrderEvent(
            event_fingerprint="f" * 64,
            source_topic="trade-updates",
            source_partition=0,
            source_offset=10,
            alpaca_account_label="source-account",
            event_ts=BASE_TIME,
            alpaca_order_id="broker-order",
            client_order_id="decision-hash",
            event_type="fill",
            status="filled",
            filled_qty_delta=Decimal("1"),
            raw_event={"event": "fill"},
        )
        session.add(row)
        session.flush()
        original_payload = row.raw_event

        facts = script.load_order_events(session, account_label="source-account")

        assert len(facts) == 1
        assert facts[0].id == row.id
        assert facts[0].is_fill is True
        assert row.raw_event == original_payload


def test_load_execution_lineage_and_canonical_scope_inference() -> None:
    engine = sqlite_model_engine()
    with Session(engine) as session, session.begin():
        decision, execution, metric = seed_canonical_execution(
            session,
            order_id="broker-order",
            client_order_id="decision-hash",
            account_label="canonical-account",
        )
        facts = script.load_execution_lineage(
            session,
            account_label="canonical-account",
            source="canonical_cross_dsn",
        )
        assert len(facts) == 1
        assert facts[0].execution_id == execution.id
        assert facts[0].trade_decision_id == decision.id
        assert facts[0].strategy_id == decision.strategy_id
        assert facts[0].submission_claim_id is None
        assert facts[0].tca_metric_id == metric.id
        assert script.resolve_canonical_account_label(session, requested=None) == (
            "canonical-account"
        )

        seed_canonical_execution(
            session,
            order_id="second-order",
            client_order_id="second-decision",
            account_label="second-account",
        )
        with pytest.raises(ValueError, match="canonical_account_ambiguous"):
            script.resolve_canonical_account_label(session, requested=None)
        assert (
            script.resolve_canonical_account_label(
                session,
                requested="canonical-account",
            )
            == "canonical-account"
        )


def test_source_scope_is_inferred_only_when_unique() -> None:
    engine = sqlite_model_engine()
    with Session(engine) as session, session.begin():
        session.add(_broker_input(account_label="source-account", identity=1))
        assert (
            script.resolve_source_account_label(
                session,
                provider="alpaca",
                environment="paper",
                requested=None,
            )
            == "source-account"
        )
        session.add(_broker_input(account_label="second-account", identity=2))
        session.flush()
        with pytest.raises(ValueError, match="source_account_ambiguous"):
            script.resolve_source_account_label(
                session,
                provider="alpaca",
                environment="paper",
                requested=None,
            )


def test_dry_run_report_is_closed_and_does_not_expose_account_labels() -> None:
    runtime = runtime_census()
    with patch.object(script, "load_runtime_census", return_value=runtime):
        report = script.reconcile_cross_dsn_order_feed_links(
            Session(),
            Session(),
            event_dsn_env="DB_DSN",
            canonical_dsn_env="SIM_DB_DSN",
            source_account_label=None,
            canonical_account_label="canonical-account",
            apply=False,
            now=BASE_TIME,
        )

    rendered = json.dumps(report, sort_keys=True)
    assert report["closed_census"] is True
    assert report["source_rows_mutated"] == 0
    assert report["promotion_authority_eligible"] is False
    assert report["receipt_count"] == 1
    assert report["run_id"] is None
    assert "source-account" not in rendered
    assert "canonical-account" not in rendered


@pytest.mark.parametrize("missing_env", ["DB_DSN", "SIM_DB_DSN"])
def test_main_rejects_missing_database_env(
    missing_env: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DB_DSN", "postgres://example/live")
    monkeypatch.setenv("SIM_DB_DSN", "postgres://example/sim")
    monkeypatch.delenv(missing_env)
    monkeypatch.setattr(
        script,
        "parse_args",
        lambda: argparse.Namespace(
            event_dsn_env="DB_DSN",
            canonical_dsn_env="SIM_DB_DSN",
            source_account_label="source-account",
            canonical_account_label="",
            provider="alpaca",
            environment="",
            apply=False,
            json=True,
        ),
    )

    with pytest.raises(SystemExit, match=f"missing DSN env var: {missing_env}"):
        script.main()


def test_main_commits_only_apply_mode(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    event_session = FakeSession()
    canonical_session = FakeSession()
    args = SimpleNamespace(
        event_dsn_env="DB_DSN",
        canonical_dsn_env="SIM_DB_DSN",
        source_account_label="source-account",
        canonical_account_label="",
        provider="alpaca",
        environment="",
        apply=True,
        json=True,
    )
    monkeypatch.setenv("DB_DSN", "postgres://example/live")
    monkeypatch.setenv("SIM_DB_DSN", "postgres://example/sim")
    monkeypatch.setattr(script, "parse_args", lambda: args)
    factories = iter(
        (FakeSessionFactory(event_session), FakeSessionFactory(canonical_session))
    )

    def fake_create_engine(*_args: object, **_kwargs: object) -> object:
        return object()

    def fake_sessionmaker(**_kwargs: object) -> FakeSessionFactory:
        return next(factories)

    def fake_reconcile(*_args: object, **_kwargs: object) -> dict[str, object]:
        return {
            "status": "ok",
            "promotion_authority_eligible": False,
        }

    monkeypatch.setattr(script, "create_engine", fake_create_engine)
    monkeypatch.setattr(script, "sessionmaker", fake_sessionmaker)
    monkeypatch.setattr(
        script,
        "reconcile_cross_dsn_order_feed_links",
        fake_reconcile,
    )

    assert script.main() == 0
    assert event_session.commits == 1
    assert event_session.rollbacks == 0
    assert canonical_session.rollbacks == 1
    assert json.loads(capsys.readouterr().out)["status"] == "ok"


def _broker_input(*, account_label: str, identity: int) -> BrokerEconomicLedgerInput:
    return BrokerEconomicLedgerInput(
        id=uuid.UUID(int=identity),
        provider="alpaca",
        source="account_activities_rest",
        environment="paper",
        account_label=account_label,
        endpoint_fingerprint=f"{identity:064x}",
        quote_currency="USD",
        source_cursor_id=uuid.UUID(int=identity + 100),
        source_watermark=BASE_TIME,
        input_count=1,
        duplicate_count=0,
        corrected_count=0,
        manifest_canonical_json="[]",
        manifest_sha256=f"{identity:064x}",
    )
