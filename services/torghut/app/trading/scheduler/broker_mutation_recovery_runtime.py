"""Scheduler wiring for observation-only broker submission recovery."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from typing import Protocol

from ...db import SessionLocal
from ..alpaca_submit_recovery import AlpacaSubmitRecoveryRoute
from ..broker_mutation_recovery_worker import (
    BrokerMutationRecoveryPolicy,
    BrokerMutationRecoveryWorker,
)
from .pipeline import TradingPipeline

logger = logging.getLogger(__name__)


class _RecoveryMetrics(Protocol):
    def record_broker_mutation_recovery(
        self,
        *,
        outcome: str,
        count: int = 1,
    ) -> None: ...


class _RuntimeFailureEmitter(Protocol):
    def __call__(
        self,
        *,
        loop_name: str,
        error: Exception,
    ) -> None: ...


def build_alpaca_submit_recovery_worker(
    pipelines: Iterable[TradingPipeline],
    *,
    enabled: bool,
) -> BrokerMutationRecoveryWorker:
    routes = tuple(
        AlpacaSubmitRecoveryRoute(
            client=pipeline.alpaca_client,
            firewall=pipeline.order_firewall,
            executor=pipeline.executor,
            account_label=pipeline.account_label,
            endpoint_url=pipeline.order_firewall.broker_endpoint_url,
        )
        for pipeline in pipelines
    )
    return BrokerMutationRecoveryWorker(
        session_factory=SessionLocal,
        routes=routes,
        component="alpaca-recovery",
        enabled=enabled,
        policy=BrokerMutationRecoveryPolicy(batch_size=1),
    )


async def reconcile_broker_mutation_recovery(
    worker: BrokerMutationRecoveryWorker | None,
    *,
    metrics: _RecoveryMetrics,
    emit_failure: _RuntimeFailureEmitter,
) -> bool:
    if worker is None:
        return True
    try:
        result = await asyncio.to_thread(worker.run_once)
    except Exception as exc:
        metrics.record_broker_mutation_recovery(outcome="failed")
        emit_failure(loop_name="broker_mutation_recovery", error=exc)
        return False
    for outcome, count in result.outcomes.items():
        metrics.record_broker_mutation_recovery(outcome=outcome, count=count)
    if result.scanned:
        logger.info(
            "Broker mutation recovery scanned=%s outcomes=%s",
            result.scanned,
            dict(result.outcomes),
        )
    return not result.failed
