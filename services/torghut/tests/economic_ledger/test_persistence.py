from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import cast

import pytest
from sqlalchemy import (
    Column,
    Integer,
    MetaData,
    String,
    Table,
    create_engine,
    event,
    func,
    insert,
    select,
    update,
)
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    BrokerAccountActivity,
    BrokerAccountActivityCursor,
    BrokerEconomicLedgerEntry,
    BrokerEconomicLedgerInput,
    BrokerEconomicLedgerReconciliation,
    BrokerEconomicLedgerRun,
)
from app.trading.economic_ledger import (
    BrokerEconomicLedgerReplay,
    BrokerEconomicReconciliationBuild,
    EconomicLedgerError,
    LedgerScope,
    load_broker_economic_ledger_source_rows,
    load_broker_economic_ledger_status,
    normalize_broker_economic_snapshot,
    persist_broker_economic_ledger_reconciliation,
    prepare_broker_economic_ledger_snapshot,
    publish_broker_economic_ledger,
    replay_broker_economic_ledger_snapshot,
)


_OBSERVED_AT = datetime(2026, 7, 16, 13, 0, tzinfo=timezone.utc)
_BUILD = BrokerEconomicReconciliationBuild(
    source_commit="a" * 40,
    image_digest=f"sha256:{'b' * 64}",
)
_SCOPE = LedgerScope(
    provider="alpaca",
    environment="paper",
    account_label="paper-account",
    endpoint_fingerprint="a" * 64,
)
_OPTION_CATALOG = Table(
    "torghut_options_contract_catalog",
    MetaData(),
    Column("contract_symbol", String, primary_key=True),
    Column("contract_size", Integer, nullable=False),
)


def _session_factory() -> sessionmaker[Session]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(connection, _record) -> None:
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(
        engine,
        tables=[
            cast(Table, BrokerAccountActivity.__table__),
            cast(Table, BrokerAccountActivityCursor.__table__),
            cast(Table, BrokerEconomicLedgerInput.__table__),
            cast(Table, BrokerEconomicLedgerRun.__table__),
            cast(Table, BrokerEconomicLedgerEntry.__table__),
            cast(Table, BrokerEconomicLedgerReconciliation.__table__),
        ],
    )
    _OPTION_CATALOG.create(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def _activity(
    external_id: str,
    activity_type: str,
    *,
    offset: int,
    symbol: str | None = None,
    side: str | None = None,
    quantity: str | None = None,
    price: str | None = None,
    net_amount: str | None = None,
    currency: str | None = "USD",
    payload_sha256: str | None = None,
) -> BrokerAccountActivity:
    payload = {"activity_type": activity_type, "id": external_id}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return BrokerAccountActivity(
        provider="alpaca",
        source="account_activities_rest",
        environment="paper",
        account_label="paper-account",
        endpoint_fingerprint="a" * 64,
        external_activity_id=external_id,
        activity_type=activity_type,
        event_at=_OBSERVED_AT + timedelta(seconds=offset),
        symbol=symbol,
        side=side,
        quantity=Decimal(quantity) if quantity is not None else None,
        price=Decimal(price) if price is not None else None,
        net_amount=Decimal(net_amount) if net_amount is not None else None,
        currency=currency,
        raw_payload=payload,
        raw_payload_canonical_json=canonical,
        raw_payload_sha256=(
            payload_sha256 or hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        ),
        normalized_economic_sha256=hashlib.sha256(
            f"economic:{external_id}".encode("utf-8")
        ).hexdigest(),
        first_observed_at=_OBSERVED_AT + timedelta(minutes=1),
    )


def _seed_source(
    sessions: sessionmaker[Session],
    activities: list[BrokerAccountActivity],
    *,
    complete: bool = True,
) -> None:
    with sessions.begin() as session:
        session.add_all(activities)
        session.add(
            BrokerAccountActivityCursor(
                provider="alpaca",
                source="account_activities_rest",
                environment="paper",
                account_label="paper-account",
                endpoint_fingerprint="a" * 64,
                status="complete" if complete else "scanning",
                scan_after=datetime(2016, 1, 1, tzinfo=timezone.utc),
                scan_until=None if complete else _OBSERVED_AT,
                last_completed_at=(
                    _OBSERVED_AT + timedelta(minutes=2) if complete else None
                ),
                last_completed_scan_until=_OBSERVED_AT if complete else None,
                activities_seen=len(activities),
                activities_inserted=len(activities),
                pages_processed=1,
            )
        )


def _supported_history() -> list[BrokerAccountActivity]:
    return [
        _activity("cash", "CSD", offset=0, net_amount="1000"),
        _activity(
            "buy",
            "FILL",
            offset=1,
            symbol="AAPL",
            side="buy",
            quantity="1",
            price="100",
            net_amount=None,
        ),
        _activity(
            "sell",
            "FILL",
            offset=2,
            symbol="AAPL",
            side="sell",
            quantity="1",
            price="110",
            net_amount=None,
        ),
        _activity("fee", "FEE", offset=3, net_amount="-1"),
    ]


def _replay(session: Session) -> BrokerEconomicLedgerReplay:
    source_rows = load_broker_economic_ledger_source_rows(session, scope=_SCOPE)
    snapshot = prepare_broker_economic_ledger_snapshot(source_rows)
    return replay_broker_economic_ledger_snapshot(snapshot)


def test_replay_publishes_one_atomic_idempotent_run_pair() -> None:
    sessions = _session_factory()
    _seed_source(sessions, _supported_history())

    with sessions.begin() as session:
        replay = _replay(session)
        assert replay.reduction.admissible
        assert replay.reduction.comparison.equivalent
        assert replay.publication_token.startswith("publish:")
        payload = replay.to_payload()
        input_payload = cast(dict[str, object], payload["input"])
        journal_payload = cast(dict[str, object], payload["journal"])
        projection_payload = cast(dict[str, object], journal_payload["projection"])
        assert input_payload["cursor_id"] == str(replay.snapshot.cursor_id)
        assert projection_payload["realized_pnl"] == "10"
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_publication_token_mismatch",
        ):
            publish_broker_economic_ledger(
                session,
                replay,
                confirmation_token="publish:wrong",
            )
        published = publish_broker_economic_ledger(
            session,
            replay,
            confirmation_token=replay.publication_token,
        )
        assert published.reused_existing is False

    with sessions.begin() as session:
        replay = _replay(session)
        repeated = publish_broker_economic_ledger(
            session,
            replay,
            confirmation_token=replay.publication_token,
        )
        assert repeated.reused_existing is True
        assert repeated.journal_run_id == published.journal_run_id
        assert repeated.state_run_id == published.state_run_id

    with sessions.begin() as session:
        cursor = session.scalar(select(BrokerAccountActivityCursor))
        assert cursor is not None
        assert cursor.last_completed_at is not None
        assert cursor.last_completed_scan_until is not None
        cursor.last_completed_at += timedelta(minutes=1)
        cursor.last_completed_scan_until += timedelta(minutes=1)
    with sessions.begin() as session:
        advanced = _replay(session)
        assert advanced.publication_token == replay.publication_token
        advanced_publication = publish_broker_economic_ledger(
            session,
            advanced,
            confirmation_token=advanced.publication_token,
        )
        assert advanced_publication.reused_existing is True
        assert advanced_publication.journal_run_id == published.journal_run_id
        assert advanced_publication.state_run_id == published.state_run_id

    with sessions() as session:
        inputs = tuple(session.scalars(select(BrokerEconomicLedgerInput)))
        runs = tuple(session.scalars(select(BrokerEconomicLedgerRun)))
        entry_count = session.scalar(
            select(func.count()).select_from(BrokerEconomicLedgerEntry)
        )
    assert len(inputs) == 1
    assert len(runs) == 2
    assert entry_count is not None and entry_count > 0
    assert {run.reducer_name for run in runs} == {
        "balanced_journal",
        "independent_position_state",
    }
    assert {run.input_id for run in runs} == {inputs[0].id}
    assert inputs[0].manifest_sha256 == replay.snapshot.prepared.manifest_digest
    assert len({run.comparison_sha256 for run in runs}) == 1


def test_publication_rejects_forged_replay_token() -> None:
    sessions = _session_factory()
    _seed_source(sessions, _supported_history())

    with sessions.begin() as session:
        replay = _replay(session)
        forged = replace(replay, publication_token=f"publish:{'0' * 64}")
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_replay_token_invalid",
        ):
            publish_broker_economic_ledger(
                session,
                forged,
                confirmation_token=forged.publication_token,
            )


def test_publication_accepts_later_cursor_watermark_for_unchanged_source() -> None:
    sessions = _session_factory()
    _seed_source(sessions, _supported_history())

    with sessions.begin() as session:
        replay = _replay(session)
    with sessions.begin() as session:
        cursor = session.scalar(select(BrokerAccountActivityCursor))
        assert cursor is not None and cursor.last_completed_scan_until is not None
        cursor.last_completed_scan_until += timedelta(seconds=1)
    with sessions.begin() as session:
        published = publish_broker_economic_ledger(
            session,
            replay,
            confirmation_token=replay.publication_token,
        )

    assert published.source_watermark == replay.snapshot.source_watermark


def test_publication_rejects_cursor_watermark_regression() -> None:
    sessions = _session_factory()
    _seed_source(sessions, _supported_history())

    with sessions.begin() as session:
        replay = _replay(session)
    with sessions.begin() as session:
        cursor = session.scalar(select(BrokerAccountActivityCursor))
        assert cursor is not None and cursor.last_completed_scan_until is not None
        cursor.last_completed_scan_until -= timedelta(seconds=1)
    with sessions.begin() as session:
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_source_watermark_changed",
        ):
            publish_broker_economic_ledger(
                session,
                replay,
                confirmation_token=replay.publication_token,
            )


def test_publication_rejects_source_append_without_cursor_advance() -> None:
    sessions = _session_factory()
    _seed_source(sessions, _supported_history())

    with sessions.begin() as session:
        replay = _replay(session)
    with sessions.begin() as session:
        session.add(_activity("untracked", "FEE", offset=4, net_amount="-0.1"))
    with sessions.begin() as session:
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_source_rows_changed",
        ):
            publish_broker_economic_ledger(
                session,
                replay,
                confirmation_token=replay.publication_token,
            )


def test_replay_rejects_incomplete_cursor_before_reading_source() -> None:
    sessions = _session_factory()
    _seed_source(sessions, _supported_history(), complete=False)

    with sessions.begin() as session:
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_source_cursor_incomplete",
        ):
            _replay(session)


def test_replay_rejects_source_hash_mismatch() -> None:
    sessions = _session_factory()
    activities = _supported_history()
    activities[0].raw_payload_sha256 = "0" * 64
    _seed_source(sessions, activities)

    with sessions.begin() as session:
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_source_hash_mismatch",
        ):
            _replay(session)


def test_replay_requires_option_contract_size_from_catalog() -> None:
    sessions = _session_factory()
    _seed_source(
        sessions,
        [
            _activity("cash", "CSD", offset=0, net_amount="1000"),
            _activity(
                "option-buy",
                "FILL",
                offset=1,
                symbol="AMZN260529P00270000",
                side="buy",
                quantity="1",
                price="1.05",
                net_amount=None,
            ),
        ],
    )

    with sessions.begin() as session:
        with pytest.raises(
            EconomicLedgerError,
            match="economic_option_contract_size_missing",
        ):
            _replay(session)


def test_adjusted_option_contract_size_is_manifest_bound_and_publish_fenced() -> None:
    sessions = _session_factory()
    symbol = "AMZN260529P00270000"
    _seed_source(
        sessions,
        [
            _activity("cash", "CSD", offset=0, net_amount="1000"),
            _activity(
                "option-buy",
                "FILL",
                offset=1,
                symbol=symbol,
                side="buy",
                quantity="2",
                price="1",
                net_amount=None,
            ),
            _activity(
                "option-sell",
                "FILL",
                offset=2,
                symbol=symbol,
                side="sell",
                quantity="2",
                price="2",
                net_amount=None,
            ),
        ],
    )
    with sessions.begin() as session:
        session.execute(
            insert(_OPTION_CATALOG).values(
                contract_symbol=symbol,
                contract_size=10,
            )
        )

    with sessions.begin() as session:
        replay = _replay(session)
    option_activities = [
        item for item in replay.snapshot.activities if item.canonical_symbol == symbol
    ]
    projection_cash = {
        item.commodity: item.amount for item in replay.reduction.journal.projection.cash
    }
    assert replay.snapshot.option_contract_sizes == ((symbol, 10),)
    assert {item.notional_multiplier for item in option_activities} == {Decimal("10")}
    assert {
        item.manifest_payload()["notional_multiplier"] for item in option_activities
    } == {"10"}
    assert projection_cash["USD"] == Decimal("1020")

    with sessions.begin() as session:
        session.execute(
            update(_OPTION_CATALOG)
            .where(_OPTION_CATALOG.c.contract_symbol == symbol)
            .values(contract_size=20)
        )
    with sessions.begin() as session:
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_option_contract_sizes_changed",
        ):
            publish_broker_economic_ledger(
                session,
                replay,
                confirmation_token=replay.publication_token,
            )


def test_unsupported_dry_run_cannot_publish_partial_projection() -> None:
    sessions = _session_factory()
    _seed_source(sessions, [_activity("merger", "MA", offset=0)])

    with sessions.begin() as session:
        replay = _replay(session)
        assert replay.reduction.admissible is False
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_projection_not_admissible",
        ):
            publish_broker_economic_ledger(
                session,
                replay,
                confirmation_token=replay.publication_token,
            )

    with sessions() as session:
        assert (
            session.scalar(select(func.count()).select_from(BrokerEconomicLedgerInput))
            == 0
        )
        assert (
            session.scalar(select(func.count()).select_from(BrokerEconomicLedgerRun))
            == 0
        )


def test_reconciliation_observations_reuse_runs_across_newer_closed_watermarks() -> (
    None
):
    sessions = _session_factory()
    _seed_source(sessions, _supported_history())
    with sessions.begin() as session:
        replay = _replay(session)
        published = publish_broker_economic_ledger(
            session,
            replay,
            confirmation_token=replay.publication_token,
        )
    snapshot = normalize_broker_economic_snapshot(
        account={"status": "ACTIVE", "cash": "1009", "equity": "1009"},
        positions=[],
        open_orders=[],
        observed_at=_OBSERVED_AT + timedelta(minutes=3),
    )
    with sessions.begin() as session:
        first = persist_broker_economic_ledger_reconciliation(
            session,
            replay,
            snapshot,
            build=_BUILD,
        )
        assert first.result.reconciled is True
        assert first.runs.journal_run_id == published.journal_run_id

    with sessions.begin() as session:
        cursor = session.scalar(select(BrokerAccountActivityCursor))
        assert cursor is not None
        assert cursor.last_completed_scan_until is not None
        assert cursor.last_completed_at is not None
        cursor.last_completed_scan_until += timedelta(minutes=10)
        cursor.last_completed_at += timedelta(minutes=10)
    later_snapshot = normalize_broker_economic_snapshot(
        account={"status": "ACTIVE", "cash": "1009", "equity": "1009"},
        positions=[],
        open_orders=[],
        observed_at=_OBSERVED_AT + timedelta(minutes=11),
    )
    with sessions.begin() as session:
        advanced = _replay(session)
        second = persist_broker_economic_ledger_reconciliation(
            session,
            advanced,
            later_snapshot,
            build=_BUILD,
        )
        assert second.runs.journal_run_id == published.journal_run_id
        assert second.runs.state_run_id == published.state_run_id
        assert second.runs.source_watermark == replay.snapshot.source_watermark
        assert second.result.payload["input_source_watermark"] == (
            replay.snapshot.source_watermark.isoformat()
        )
        assert second.result.payload["source_watermark"] == (
            advanced.snapshot.source_watermark.isoformat()
        )
        assert second.result.source_age_seconds == 60
        assert second.result.reconciled is True

    with sessions() as session:
        assert (
            session.scalar(select(func.count()).select_from(BrokerEconomicLedgerInput))
            == 1
        )
        assert (
            session.scalar(select(func.count()).select_from(BrokerEconomicLedgerRun))
            == 2
        )
        assert (
            session.scalar(
                select(func.count()).select_from(BrokerEconomicLedgerReconciliation)
            )
            == 2
        )
        status = load_broker_economic_ledger_status(
            session,
            scope=_SCOPE,
            observed_at=_OBSERVED_AT + timedelta(minutes=12),
        )
        stale_status = load_broker_economic_ledger_status(
            session,
            scope=_SCOPE,
            observed_at=_OBSERVED_AT + timedelta(minutes=13),
            max_observation_age_seconds=60,
        )
    assert status["state"] == "reconciled"
    assert status["reconciled"] is True
    assert status["input_source_watermark"] == (
        replay.snapshot.source_watermark.isoformat()
    )
    assert status["source_watermark"] == advanced.snapshot.source_watermark.isoformat()
    assert status["diagnostic_only"] is True
    assert status["capital_authority"] is False
    assert status["admissible"] is True
    assert status["input_manifest_sha256"] == replay.snapshot.prepared.manifest_digest
    assert status["reducers"] == {
        "journal": replay.reduction.journal.projection.reducer_version,
        "state": replay.reduction.independent.reducer_version,
        "differential_equivalent": True,
        "admissible": True,
    }
    assert status["journal_run_id"] == str(published.journal_run_id)
    assert stale_status["state"] == "stale"
    assert stale_status["reconciled"] is False
    assert "economic_reconciliation_observation_stale" in stale_status["reason_codes"]


def test_reconciliation_refuses_unpublished_changed_manifest() -> None:
    sessions = _session_factory()
    activities = _supported_history()
    _seed_source(sessions, activities)
    with sessions.begin() as session:
        replay = _replay(session)
        publish_broker_economic_ledger(
            session,
            replay,
            confirmation_token=replay.publication_token,
        )
    with sessions.begin() as session:
        session.add(_activity("new-fee", "FEE", offset=4, net_amount="-1"))
        cursor = session.scalar(select(BrokerAccountActivityCursor))
        assert cursor is not None
        assert cursor.last_completed_at is not None
        assert cursor.last_completed_scan_until is not None
        cursor.activities_seen += 1
        cursor.activities_inserted += 1
        cursor.last_completed_at += timedelta(minutes=1)
        cursor.last_completed_scan_until += timedelta(minutes=1)
    snapshot = normalize_broker_economic_snapshot(
        account={"status": "ACTIVE", "cash": "1008", "equity": "1008"},
        positions=[],
        open_orders=[],
        observed_at=_OBSERVED_AT + timedelta(minutes=4),
    )
    with sessions.begin() as session:
        changed = _replay(session)
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_published_input_missing",
        ):
            persist_broker_economic_ledger_reconciliation(
                session,
                changed,
                snapshot,
                build=_BUILD,
            )


def test_reconciliation_status_is_explicitly_missing_before_first_observation() -> None:
    sessions = _session_factory()
    status = None
    with sessions() as session:
        status = load_broker_economic_ledger_status(
            session,
            scope=_SCOPE,
            observed_at=_OBSERVED_AT,
            max_observation_age_seconds=60,
        )
    assert status["state"] == "missing"
    assert status["reason_codes"] == ["economic_reconciliation_missing"]
