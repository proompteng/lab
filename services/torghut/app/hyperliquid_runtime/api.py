"""FastAPI entrypoint for the Hyperliquid testnet runtime deployment."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Response

from app.db import SessionLocal

from .clickhouse import ClickHouseRuntimeReader
from .config import HyperliquidRuntimeConfig
from .exchange import exchange_from_config
from .ledger import HyperliquidTigerBeetleJournal
from .metrics import HyperliquidRuntimeMetrics
from .models import CycleResult
from .service import HyperliquidRuntimeService, runtime_readiness


class RuntimeAppState:
    """Mutable app state isolated to this deployment."""

    def __init__(self) -> None:
        self.config = HyperliquidRuntimeConfig.from_env()
        self.metrics = HyperliquidRuntimeMetrics()
        self.latest_cycle: CycleResult | None = None
        self.latest_error: str | None = None
        self.service = HyperliquidRuntimeService(
            config=self.config,
            clickhouse=ClickHouseRuntimeReader(self.config),
            exchange=exchange_from_config(self.config),
            journal=HyperliquidTigerBeetleJournal(
                cluster_id=self.config.tigerbeetle_cluster_id
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


async def _runtime_loop() -> None:
    while True:
        await asyncio.to_thread(_run_one_cycle)
        await asyncio.sleep(runtime_state.config.poll_interval_seconds)


def _run_one_cycle() -> CycleResult:
    session = SessionLocal()
    try:
        result = runtime_state.service.run_once(session)
        runtime_state.latest_cycle = result
        runtime_state.latest_error = None
        runtime_state.metrics.record_cycle(result)
        return result
    except Exception as exc:
        session.rollback()
        runtime_state.latest_error = f"{type(exc).__name__}:{exc}"
        runtime_state.metrics.record_error(exc)
        raise
    finally:
        session.close()
