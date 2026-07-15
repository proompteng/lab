"""Coverage for v2 API, feed, repository, and service surfaces."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from typing import cast

import pytest

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.metrics import HyperliquidExecutionMetrics
from app.hyperliquid_execution.models import (
    CycleResult,
    RuntimeDependencyStatus,
)
from app.hyperliquid_execution.repository import HyperliquidExecutionRepository
from app.hyperliquid_execution.service import (
    HyperliquidExecutionService,
    _CycleContext,
)
from app.trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRunResult,
)
from app.trading.broker_mutation_submit_coordinator import (
    BrokerMutationSubmitCoordinator,
    BrokerMutationSubmissionUnresolved,
)


from tests.hyperliquid_execution.submit_recovery_test_support import (
    _FailingRecoveryWorker,
    _RecoveryWorker,
    _ready_recovery_worker,
)
from tests.hyperliquid_execution.test_runtime_surfaces import (
    _FakeSession,
    _ServiceExchange,
    _ServiceFeed,
    _SUBMIT_COORDINATOR,
    _now,
)


def test_recovery_metrics_count_worker_runs_not_cached_cycle_status() -> None:
    now = _now()
    dependency = RuntimeDependencyStatus(
        name="broker_mutation_recovery",
        ready=True,
        observed_at=now,
        details={
            "run_sequence": 1,
            "outcomes": {"reconciled": 1},
        },
    )
    cycle = CycleResult(
        observed_at=now,
        markets_seen=0,
        selected_coins=(),
        signals_written=0,
        orders_submitted=0,
        orders_cancelled=0,
        dependencies=(dependency,),
        universe_details={},
    )
    metrics = HyperliquidExecutionMetrics()

    metrics.record_cycle(cycle)
    metrics.record_cycle(cycle)
    metrics.record_cycle(
        replace(
            cycle,
            dependencies=(
                replace(
                    dependency,
                    details={
                        "run_sequence": 2,
                        "outcomes": {"reconciled": 2},
                    },
                ),
            ),
        )
    )

    assert (
        'test_broker_mutation_recovery_total{outcome="reconciled"} 3'
        in metrics.render("test")
    )


class _UnresolvedSubmitCoordinator:
    def __init__(self) -> None:
        self.calls = 0

    def submit_unlinked_order(self, *_args: object, **_kwargs: object) -> object:
        self.calls += 1
        raise BrokerMutationSubmissionUnresolved("ambiguous broker response")


class _RecoveryOrderingService(HyperliquidExecutionService):
    _ordering_events: list[str]

    def _load_context(
        self,
        repository: HyperliquidExecutionRepository,
        observed_at: datetime,
    ) -> _CycleContext:
        self._ordering_events.append("context")
        return super()._load_context(repository, observed_at)


class _OrderingRecoveryWorker:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def run_once(self) -> BrokerMutationRecoveryRunResult:
        self._events.append("recovery")
        return BrokerMutationRecoveryRunResult(
            enabled=True,
            scanned=0,
            outcomes={},
        )


def test_recovery_precedes_account_and_open_order_context_reads() -> None:
    now = _now()
    events: list[str] = []
    service = _RecoveryOrderingService(
        config=HyperliquidExecutionConfig.from_env({}),
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=_OrderingRecoveryWorker(events),
    )
    service._ordering_events = events

    service.run_once(_FakeSession())

    assert events == ["recovery", "context"]


def test_disabled_recovery_is_a_fail_closed_execution_dependency() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    recovery = _RecoveryWorker(
        BrokerMutationRecoveryRunResult(
            enabled=False,
            scanned=0,
            outcomes={"disabled": 1},
        )
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=recovery,
    )

    result = service.run_once(_FakeSession())

    dependencies = {dependency.name: dependency for dependency in result.dependencies}
    status = dependencies["broker_mutation_recovery"]
    assert recovery.calls == 1
    assert status.ready is False
    assert status.reason == "broker_mutation_recovery_disabled"
    assert status.details == {
        "enabled": False,
        "run_sequence": 1,
        "scanned": 0,
        "unresolved": 0,
        "outcomes": {"disabled": 1},
        "interval_seconds": 60,
    }
    assert result.orders_submitted == 0


def test_unwired_recovery_is_a_fail_closed_execution_dependency() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
    )

    result = service.run_once(_FakeSession())

    status = next(
        dependency
        for dependency in result.dependencies
        if dependency.name == "broker_mutation_recovery"
    )
    assert status.ready is False
    assert status.reason == "broker_mutation_recovery_unwired"
    assert status.details == {
        "enabled": True,
        "run_sequence": 0,
        "interval_seconds": 60,
    }
    assert result.orders_submitted == 0


def test_recovery_failure_blocks_entry_without_crashing_reconciliation() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    recovery = _FailingRecoveryWorker()
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=recovery,
    )

    result = service.run_once(_FakeSession())

    dependencies = {dependency.name: dependency for dependency in result.dependencies}
    status = dependencies["broker_mutation_recovery"]
    assert recovery.calls == 1
    assert status.ready is False
    assert status.reason == "broker_mutation_recovery_failed"
    assert status.details == {
        "enabled": True,
        "run_sequence": 1,
        "error_class": "RuntimeError",
        "outcomes": {"failed": 1},
        "interval_seconds": 60,
    }
    assert result.orders_submitted == 0
    metrics = HyperliquidExecutionMetrics()
    metrics.record_cycle(result)
    metrics.record_cycle(result)
    assert (
        'hyperliquid_execution_broker_mutation_recovery_total{outcome="failed"} 1'
        in metrics.render("hyperliquid_execution")
    )


def test_unresolved_recovery_count_blocks_entry() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    recovery = _RecoveryWorker(
        BrokerMutationRecoveryRunResult(
            enabled=True,
            scanned=0,
            outcomes={},
            unresolved=1,
        )
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=recovery,
    )

    result = service.run_once(_FakeSession())

    status = next(
        dependency
        for dependency in result.dependencies
        if dependency.name == "broker_mutation_recovery"
    )
    assert status.ready is False
    assert status.reason == "broker_mutation_recovery_unresolved"
    assert status.details["unresolved"] == 1
    assert result.orders_submitted == 0


def test_ambiguous_submit_aborts_cycle_and_latches_recovery() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    coordinator = _UnresolvedSubmitCoordinator()
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=cast(BrokerMutationSubmitCoordinator, coordinator),
        recovery_worker=_ready_recovery_worker(),
    )
    session = _FakeSession()

    with pytest.raises(BrokerMutationSubmissionUnresolved):
        service.run_once(session)

    assert coordinator.calls == 1
    assert session.committed is False
    assert service._latest_recovery_status is not None
    assert service._latest_recovery_status.ready is False
    assert (
        service._latest_recovery_status.reason == "broker_mutation_recovery_unresolved"
    )
    assert service._next_recovery_at is None


def test_recovery_runs_at_most_once_per_configured_interval() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_BROKER_MUTATION_RECOVERY_INTERVAL_SECONDS": "60"}
    )
    recovery = _RecoveryWorker(
        BrokerMutationRecoveryRunResult(
            enabled=True,
            scanned=0,
            outcomes={},
        )
    )
    monotonic_values = iter((0.0, 15.0, 60.0))
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=recovery,
        recovery_clock=lambda: next(monotonic_values),
    )

    results = tuple(service.run_once(_FakeSession()) for _ in range(3))

    assert recovery.calls == 2
    assert all(
        next(
            dependency
            for dependency in result.dependencies
            if dependency.name == "broker_mutation_recovery"
        ).ready
        for result in results
    )
