"""FastAPI entrypoint for Hyperliquid execution v2."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Response

from app.db import SessionLocal

from .config import HyperliquidExecutionConfig
from .exchange import exchange_from_config
from .feed_reader import ClickHouseFeedReader
from .metrics import HyperliquidExecutionMetrics
from .models import CycleResult, RuntimeDependencyStatus
from .repository import HyperliquidExecutionRepository
from .service import HyperliquidExecutionService, runtime_readiness


logger = logging.getLogger(__name__)


class RuntimeAppState:
    """Mutable app state isolated to the deployment process."""

    def __init__(self) -> None:
        self.config = HyperliquidExecutionConfig.from_env()
        self.metrics = HyperliquidExecutionMetrics()
        self.latest_cycle: CycleResult | None = None
        self.latest_error: str | None = None
        self.service = HyperliquidExecutionService(
            config=self.config,
            feed=ClickHouseFeedReader(self.config),
            exchange=exchange_from_config(self.config),
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


app = FastAPI(title="Torghut Hyperliquid Execution", lifespan=lifespan)


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
        "order_policy": runtime_state.config.order_policy,
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


@app.get("/trading/status")
def trading_status() -> dict[str, object]:
    ready, reasons, dependencies = runtime_readiness(
        config=runtime_state.config,
        latest_cycle=runtime_state.latest_cycle,
        latest_error=runtime_state.latest_error,
    )
    gate = _operational_submission_gate(
        ready=ready,
        reasons=reasons,
        config=runtime_state.config,
    )
    return {
        "ready": ready,
        "reasons": reasons,
        "trading_enabled": runtime_state.config.trading_enabled,
        "execution_route": runtime_state.config.execution_network,
        "order_policy": runtime_state.config.order_policy,
        "execution_network": runtime_state.config.execution_network,
        "market_data_network": runtime_state.config.market_data_network,
        "dependencies": [
            _dependency_payload(dependency) for dependency in dependencies
        ],
        "latest_cycle": _runtime_report_payload(),
        "config": _config_payload(),
        "operational_submission_gate": gate,
        "live_submission_gate": dict(gate),
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
        return HyperliquidExecutionRepository(session).operational_report(
            runtime_payload=_runtime_report_payload(),
            config_payload=_config_payload(),
        )
    finally:
        session.close()


async def _runtime_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(_run_one_cycle)
        except Exception:
            logger.exception("Hyperliquid execution cycle failed")
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


def _runtime_report_payload() -> dict[str, object]:
    latest_cycle = runtime_state.latest_cycle
    if latest_cycle is None:
        return {
            "latest_cycle_at": None,
            "selected_coins": [],
            "markets_seen": 0,
            "signals_written": 0,
            "orders_submitted": 0,
            "orders_cancelled": 0,
            "universe": {},
        }
    return {
        "latest_cycle_at": latest_cycle.observed_at.isoformat(),
        "selected_coins": list(latest_cycle.selected_coins),
        "markets_seen": latest_cycle.markets_seen,
        "signals_written": latest_cycle.signals_written,
        "orders_submitted": latest_cycle.orders_submitted,
        "orders_cancelled": latest_cycle.orders_cancelled,
        "universe": latest_cycle.universe_details,
    }


def _config_payload() -> dict[str, object]:
    config = runtime_state.config
    return {
        "trading_enabled": config.trading_enabled,
        "allow_short_entries": config.allow_short_entries,
        "market_data_network": config.market_data_network,
        "execution_network": config.execution_network,
        "trade_coins": list(config.trade_coins),
        "excluded_coins": list(config.excluded_coins),
        "min_order_notional_usd": str(config.min_order_notional_usd),
        "max_order_notional_usd": str(config.max_order_notional_usd),
        "max_symbol_exposure_usd": str(config.max_symbol_exposure_usd),
        "max_gross_exposure_usd": str(config.max_gross_exposure_usd),
        "min_edge_bps": str(config.min_edge_bps),
        "cost_buffer_bps": str(config.cost_buffer_bps),
        "signal_staleness_seconds": config.signal_staleness_seconds,
        "feed_readiness_url_configured": config.feed_readiness_url is not None,
        "feed_readiness_timeout_seconds": config.feed_readiness_timeout_seconds,
        "order_policy": config.order_policy,
        "effective_order_tif": config.effective_order_tif,
        "maker_tif": config.maker_tif,
        "maker_ttl_seconds": config.maker_ttl_seconds,
        "max_open_orders_per_symbol": config.max_open_orders_per_symbol,
        "reject_cooldown_threshold": config.reject_cooldown_threshold,
        "reject_cooldown_window_seconds": config.reject_cooldown_window_seconds,
        "reject_cooldown_seconds": config.reject_cooldown_seconds,
        "maintenance_reduce_only_close_enabled": config.maintenance_reduce_only_close_enabled,
        "sample_ready_fill_floor": 40,
    }


def _dependency_payload(dependency: RuntimeDependencyStatus) -> dict[str, object]:
    return {
        "name": dependency.name,
        "ready": dependency.ready,
        "observed_at": dependency.observed_at.isoformat()
        if dependency.observed_at
        else None,
        "lag_seconds": dependency.lag_seconds,
        "reason": dependency.reason,
        "details": dependency.details,
    }


def _operational_submission_gate(
    *,
    ready: bool,
    reasons: list[str],
    config: HyperliquidExecutionConfig,
) -> dict[str, object]:
    blockers = list(reasons)
    if not config.enabled:
        blockers.append("runtime_disabled")
    if not config.trading_enabled:
        blockers.append("trading_disabled")
    deduped_blockers = _dedupe_strings(blockers)
    allowed = ready and config.trading_enabled and not deduped_blockers
    return {
        "allowed": allowed,
        "enabled": allowed,
        "blockers": deduped_blockers,
    }


def _dedupe_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
