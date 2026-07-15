"""Shared Hyperliquid submit-recovery test doubles."""

from __future__ import annotations

from app.trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRunError,
    BrokerMutationRecoveryRunResult,
)


class _RecoveryWorker:
    def __init__(self, result: BrokerMutationRecoveryRunResult) -> None:
        self.result = result
        self.calls = 0

    def run_once(self) -> BrokerMutationRecoveryRunResult:
        self.calls += 1
        return self.result


class _FailingRecoveryWorker:
    def __init__(self) -> None:
        self.calls = 0

    def run_once(self) -> BrokerMutationRecoveryRunResult:
        self.calls += 1
        raise BrokerMutationRecoveryRunError("recovery unavailable")


def _ready_recovery_worker() -> _RecoveryWorker:
    return _RecoveryWorker(
        BrokerMutationRecoveryRunResult(
            enabled=True,
            scanned=0,
            outcomes={},
        )
    )
