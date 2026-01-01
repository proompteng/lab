"""Background scheduler for the trading pipeline."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..config import settings
from ..db import SessionLocal
from ..models import Strategy
from ..snapshots import snapshot_account_and_positions
from .decisions import DecisionEngine
from .execution import OrderExecutor
from .ingest import ClickHouseSignalIngestor
from .models import StrategyDecision
from .reconcile import Reconciler
from .risk import RiskEngine
from .universe import UniverseResolver

logger = logging.getLogger(__name__)


@dataclass
class TradingMetrics:
    decisions_total: int = 0
    orders_submitted_total: int = 0
    orders_rejected_total: int = 0
    reconcile_updates_total: int = 0


@dataclass
class TradingState:
    running: bool = False
    last_run_at: Optional[datetime] = None
    last_reconcile_at: Optional[datetime] = None
    last_error: Optional[str] = None
    metrics: TradingMetrics = field(default_factory=TradingMetrics)


class TradingPipeline:
    """Orchestrate ingest -> decide -> risk -> execute for one cycle."""

    def __init__(
        self,
        alpaca_client: TorghutAlpacaClient,
        ingestor: ClickHouseSignalIngestor,
        decision_engine: DecisionEngine,
        risk_engine: RiskEngine,
        executor: OrderExecutor,
        reconciler: Reconciler,
        universe_resolver: UniverseResolver,
        state: TradingState,
        account_label: str,
        session_factory: Callable[[], Session] = SessionLocal,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.ingestor = ingestor
        self.decision_engine = decision_engine
        self.risk_engine = risk_engine
        self.executor = executor
        self.reconciler = reconciler
        self.universe_resolver = universe_resolver
        self.state = state
        self.account_label = account_label
        self.session_factory = session_factory

    def run_once(self) -> None:
        with self.session_factory() as session:
            strategies = self._load_strategies(session)
            if not strategies:
                logger.info("No enabled strategies found; skipping trading cycle")
                return

            signals = self.ingestor.fetch_signals(session)
            if not signals:
                return

            account_snapshot = snapshot_account_and_positions(session, self.alpaca_client, self.account_label)
            account = {
                "equity": str(account_snapshot.equity),
                "cash": str(account_snapshot.cash),
                "buying_power": str(account_snapshot.buying_power),
            }
            positions = account_snapshot.positions

            allowed_symbols = self.universe_resolver.get_symbols()

            for signal in signals:
                decisions = self.decision_engine.evaluate(signal, strategies)
                if not decisions:
                    continue
                for decision in decisions:
                    self.state.metrics.decisions_total += 1
                    self._handle_decision(session, decision, strategies, account, positions, allowed_symbols)

    def reconcile(self) -> int:
        with self.session_factory() as session:
            updates = self.reconciler.reconcile(session, self.alpaca_client)
            if updates:
                self.state.metrics.reconcile_updates_total += updates
            return updates

    def _handle_decision(
        self,
        session: Session,
        decision: StrategyDecision,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, str]],
        allowed_symbols: Optional[set[str]],
    ) -> None:
        strategy = next((s for s in strategies if str(s.id) == decision.strategy_id), None)
        if strategy is None:
            return

        strategy_symbols = _coerce_strategy_symbols(strategy.universe_symbols)
        if strategy_symbols and allowed_symbols:
            symbol_allowlist = strategy_symbols & allowed_symbols
        elif strategy_symbols:
            symbol_allowlist = strategy_symbols
        else:
            symbol_allowlist = allowed_symbols

        decision_row = self.executor.ensure_decision(session, decision, strategy, self.account_label)
        if self.executor.execution_exists(session, decision_row):
            return

        verdict = self.risk_engine.evaluate(session, decision, strategy, account, positions, symbol_allowlist)
        if not verdict.approved:
            self.state.metrics.orders_rejected_total += 1
            for reason in verdict.reasons:
                logger.info(
                    "Decision rejected strategy_id=%s symbol=%s reason=%s",
                    decision.strategy_id,
                    decision.symbol,
                    reason,
                )
            self.executor.mark_rejected(session, decision_row, ";".join(verdict.reasons))
            return

        if not settings.trading_enabled:
            return

        execution = self.executor.submit_order(
            session,
            self.alpaca_client,
            decision,
            decision_row,
            self.account_label,
        )
        if execution:
            self.state.metrics.orders_submitted_total += 1
            logger.info(
                "Order submitted strategy_id=%s decision_id=%s symbol=%s alpaca_order_id=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
                execution.alpaca_order_id,
            )

    @staticmethod
    def _load_strategies(session: Session) -> list[Strategy]:
        stmt = select(Strategy).where(Strategy.enabled.is_(True))
        return list(session.execute(stmt).scalars().all())


def _coerce_strategy_symbols(raw: object) -> set[str]:
    if raw is None:
        return set()
    if isinstance(raw, list):
        symbols: set[str] = set()
        for symbol in cast(list[Any], raw):
            cleaned = str(symbol).strip()
            if cleaned:
                symbols.add(cleaned)
        return symbols
    if isinstance(raw, str):
        return {symbol.strip() for symbol in raw.split(",") if symbol.strip()}
    return set()


class TradingScheduler:
    """Async background scheduler for trading pipeline."""

    def __init__(self) -> None:
        self.state = TradingState()
        self._task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._pipeline = TradingPipeline(
            alpaca_client=TorghutAlpacaClient(),
            ingestor=ClickHouseSignalIngestor(),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=self.state,
            account_label=settings.trading_account_label,
        )

    async def start(self) -> None:
        if self._task:
            return
        self._stop_event.clear()
        self.state.running = True
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self.state.running = False

    async def _run_loop(self) -> None:
        poll_interval = settings.trading_poll_ms / 1000
        reconcile_interval = settings.trading_reconcile_ms / 1000
        last_reconcile = datetime.now(timezone.utc)

        while not self._stop_event.is_set():
            try:
                self._pipeline.run_once()
                self.state.last_run_at = datetime.now(timezone.utc)
            except Exception as exc:  # pragma: no cover - loop guard
                logger.exception("Trading loop failed: %s", exc)
                self.state.last_error = str(exc)

            now = datetime.now(timezone.utc)
            if now - last_reconcile >= timedelta(seconds=reconcile_interval):
                try:
                    updates = self._pipeline.reconcile()
                    if updates:
                        logger.info("Reconciled %s executions", updates)
                    self.state.last_reconcile_at = datetime.now(timezone.utc)
                except Exception as exc:  # pragma: no cover - loop guard
                    logger.exception("Reconcile loop failed: %s", exc)
                    self.state.last_error = str(exc)
                last_reconcile = now

            await asyncio.sleep(poll_interval)


__all__ = ["TradingScheduler", "TradingState", "TradingMetrics"]
