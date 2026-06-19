from __future__ import annotations

from pytest import MonkeyPatch

from app.hyperliquid_runtime.service import HyperliquidRuntimeService
from tests.hyperliquid_runtime.test_service_repository import (
    _config,
    _enabled_service,
    _FakeClickHouse,
    _FakeExchange,
    _FakeJournal,
    _FakeRepository,
    _FakeSession,
    _patch_repository,
)


def test_runtime_service_shadow_mode_does_not_submit_or_journal_orders(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False)
    journal = _FakeJournal()
    _patch_repository(monkeypatch, repository)
    service = HyperliquidRuntimeService(
        config=_config(),
        clickhouse=_FakeClickHouse(),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.markets_seen == 1
    assert result.signals_written == 1
    assert result.decisions_written == 1
    assert result.orders_submitted == 0
    assert result.blocked_decisions == 1
    assert repository.decision.reason == "trading_disabled_shadow"
    assert exchange.submitted == []
    assert repository.orders == []
    assert journal.persisted == []


def test_runtime_service_blocks_when_tigerbeetle_is_not_ready(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False)
    journal = _FakeJournal(ready=False)
    _patch_repository(monkeypatch, repository)
    service = _enabled_service(exchange=exchange, journal=journal)
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.orders_submitted == 0
    assert result.blocked_decisions == 1
    assert repository.decision.reason == "dependency_not_ready:hyperliquid_tigerbeetle"
    assert repository.performance[0].reconciliation_status == "tigerbeetle_stale"
    assert exchange.submitted == []
    assert journal.persisted == []


def test_runtime_service_blocks_when_no_testnet_execution_markets(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False, supports_markets=False)
    journal = _FakeJournal()
    _patch_repository(monkeypatch, repository)
    service = _enabled_service(exchange=exchange, journal=journal)
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.markets_seen == 0
    assert result.signals_written == 0
    assert result.decisions_written == 0
    assert result.orders_submitted == 0
    assert any(
        dependency.name == "hyperliquid_execution_universe"
        and not dependency.ready
        and dependency.reason == "no_execution_supported_markets"
        for dependency in result.dependency_statuses
    )
    assert exchange.submitted == []
    assert repository.orders == []
    assert journal.persisted == []


def test_runtime_service_marks_missing_execution_features_not_ready(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False)
    journal = _FakeJournal()
    _patch_repository(monkeypatch, repository)
    service = _enabled_service(
        clickhouse=_FakeClickHouse(features=[]),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.markets_seen == 1
    assert result.signals_written == 0
    assert result.decisions_written == 0
    assert result.orders_submitted == 0
    assert any(
        dependency.name == "hyperliquid_execution_features"
        and not dependency.ready
        and dependency.reason == "missing_fresh_features_for_execution_markets"
        for dependency in result.dependency_statuses
    )
    assert exchange.submitted == []
    assert repository.orders == []
