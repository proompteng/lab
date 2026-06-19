"""FastAPI entrypoint for the Hyperliquid testnet runtime deployment."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import FastAPI, Response

from app.db import SessionLocal

from .clickhouse import ClickHouseRuntimeReader
from .config import HyperliquidRuntimeConfig
from .exchange import exchange_from_config
from .ledger import HyperliquidTigerBeetleJournal
from .metrics import HyperliquidRuntimeMetrics
from .models import CycleResult
from .repository import HyperliquidRuntimeRepository
from .runtime_session import RuntimeSession
from .service import HyperliquidRuntimeService, runtime_readiness

logger = logging.getLogger(__name__)


class RuntimeAppState:
    """Mutable app state isolated to this deployment."""

    def __init__(self) -> None:
        self.config = HyperliquidRuntimeConfig.from_env()
        self.metrics = HyperliquidRuntimeMetrics()
        self.latest_cycle: CycleResult | None = None
        self.latest_error: str | None = None
        self.latest_optimizer_at: datetime | None = None
        self.service = HyperliquidRuntimeService(
            config=self.config,
            clickhouse=ClickHouseRuntimeReader(self.config),
            exchange=exchange_from_config(self.config),
            journal=HyperliquidTigerBeetleJournal(
                cluster_id=self.config.tigerbeetle_cluster_id,
                enabled=self.config.tigerbeetle_enabled,
                required=self.config.tigerbeetle_required,
                journal_enabled=self.config.tigerbeetle_journal_enabled,
                replica_addresses=self.config.tigerbeetle_replica_addresses,
                rpc_timeout_seconds=self.config.tigerbeetle_rpc_timeout_seconds,
            ),
        )
        self.task: asyncio.Task[None] | None = None


runtime_state = RuntimeAppState()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    if runtime_state.config.enabled:
        runtime_state.task = asyncio.create_task(_runtime_loop())
    try:
        yield
    finally:
        if runtime_state.task is not None:
            runtime_state.task.cancel()
            await asyncio.gather(runtime_state.task, return_exceptions=True)


app = FastAPI(title="Torghut Hyperliquid Runtime", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz(response: Response) -> dict[str, object]:
    ready, reasons, dependencies = runtime_readiness(
        config=runtime_state.config,
        latest_cycle=runtime_state.latest_cycle,
        latest_error=runtime_state.latest_error,
    )
    if not ready:
        response.status_code = 503
    return {
        "ready": ready,
        "reasons": reasons,
        "trading_enabled": runtime_state.config.trading_enabled,
        "execution_network": runtime_state.config.execution_network,
        "market_data_network": runtime_state.config.market_data_network,
        "dependencies": [
            {
                "name": dependency.name,
                "ready": dependency.ready,
                "lag_seconds": dependency.lag_seconds,
                "reason": dependency.reason,
                "details": dependency.details,
            }
            for dependency in dependencies
        ],
    }


@app.get("/metrics")
def metrics() -> Response:
    return Response(
        runtime_state.metrics.render(runtime_state.config.metrics_namespace),
        media_type="text/plain; version=0.0.4",
    )


@app.get("/report")
def report() -> dict[str, object]:
    session = SessionLocal()
    try:
        return HyperliquidRuntimeRepository(session).operational_report(
            runtime_payload=_runtime_report_payload(),
            config_payload={
                "execution_network": runtime_state.config.execution_network,
                "market_data_network": runtime_state.config.market_data_network,
                "trade_coins": list(runtime_state.config.trade_coins),
                "excluded_coins": list(runtime_state.config.excluded_coins),
                "max_order_notional_usd": str(
                    runtime_state.config.max_order_notional_usd
                ),
                "min_order_notional_usd": str(
                    runtime_state.config.min_order_notional_usd
                ),
                "max_gross_exposure_usd": str(
                    runtime_state.config.max_gross_exposure_usd
                ),
                "max_symbol_exposure_usd": str(
                    runtime_state.config.max_symbol_exposure_usd
                ),
                "reject_cooldown_threshold": (
                    runtime_state.config.reject_cooldown_threshold
                ),
                "reject_cooldown_window_seconds": (
                    runtime_state.config.reject_cooldown_window_seconds
                ),
                "reject_cooldown_seconds": (
                    runtime_state.config.reject_cooldown_seconds
                ),
                "halted_cooldown_seconds": (
                    runtime_state.config.exchange_staleness_seconds
                ),
            },
        )
    finally:
        session.close()


def _runtime_report_payload() -> dict[str, object]:
    latest_cycle = runtime_state.latest_cycle
    if latest_cycle is None:
        return {
            "latest_cycle_at": None,
            "selected_coins": [],
            "markets_seen": 0,
            "signals_written": 0,
            "decisions_written": 0,
            "orders_submitted": 0,
            "blocked_decisions": 0,
            "dependencies": [],
        }
    return {
        "latest_cycle_at": latest_cycle.observed_at.isoformat(),
        "selected_coins": list(latest_cycle.selected_coins),
        "markets_seen": latest_cycle.markets_seen,
        "signals_written": latest_cycle.signals_written,
        "decisions_written": latest_cycle.decisions_written,
        "orders_submitted": latest_cycle.orders_submitted,
        "blocked_decisions": latest_cycle.blocked_decisions,
        "dependencies": [
            {
                "name": dependency.name,
                "ready": dependency.ready,
                "lag_seconds": dependency.lag_seconds,
                "reason": dependency.reason,
                "details": dependency.details,
            }
            for dependency in latest_cycle.dependency_statuses
        ],
    }


async def _runtime_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(_run_one_cycle)
        except Exception:
            logger.exception("Hyperliquid runtime cycle failed")
        await asyncio.sleep(runtime_state.config.poll_interval_seconds)


def _run_one_cycle() -> CycleResult:
    session = SessionLocal()
    try:
        result = runtime_state.service.run_once(session)
        runtime_state.latest_cycle = result
        runtime_state.latest_error = None
        runtime_state.metrics.record_cycle(result)
        _run_optimizer_if_due(session, result.observed_at)
        return result
    except Exception as exc:
        session.rollback()
        runtime_state.latest_error = f"{type(exc).__name__}:{exc}"
        runtime_state.metrics.record_error(exc)
        raise
    finally:
        session.close()


def _run_optimizer_if_due(
    session: RuntimeSession,
    observed_at: datetime,
) -> None:
    if not runtime_state.config.optimizer_enabled:
        return
    latest_optimizer_at = runtime_state.latest_optimizer_at
    if latest_optimizer_at is not None:
        elapsed_seconds = (
            observed_at.astimezone(timezone.utc)
            - latest_optimizer_at.astimezone(timezone.utc)
        ).total_seconds()
        if elapsed_seconds < runtime_state.config.optimizer_interval_seconds:
            return
    try:
        result = runtime_state.service.run_optimizer_once(session)
    except Exception as exc:
        logger.exception("Hyperliquid optimizer cycle failed")
        runtime_state.metrics.record_optimizer_error(exc)
        return
    if result is None:
        return
    runtime_state.latest_optimizer_at = observed_at
    runtime_state.metrics.record_optimizer(result)
