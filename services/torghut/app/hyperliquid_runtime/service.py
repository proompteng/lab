"""Runtime loop for the isolated Hyperliquid testnet lane."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from .clickhouse import ClickHouseRuntimeReader
from .config import HyperliquidRuntimeConfig
from .exchange import HyperliquidExchange
from .ledger import HyperliquidTigerBeetleJournal
from .models import (
    CycleResult,
    DecisionRecord,
    FeatureSnapshot,
    HyperliquidMarket,
    PerformanceSnapshot,
    RiskState,
    RuntimeDependencyStatus,
    Signal,
    RiskVerdict,
)
from .repository import HyperliquidRuntimeRepository
from .risk import build_order_intent, evaluate_signal_risk
from .strategy import generate_signal
from .universe import select_equity_like_markets


class HyperliquidRuntimeService:
    """One-cycle runtime orchestrator."""

    def __init__(
        self,
        *,
        config: HyperliquidRuntimeConfig,
        clickhouse: ClickHouseRuntimeReader,
        exchange: HyperliquidExchange,
        journal: HyperliquidTigerBeetleJournal,
    ) -> None:
        self._config = config
        self._clickhouse = clickhouse
        self._exchange = exchange
        self._journal = journal

    def run_once(self, session: Session) -> CycleResult:
        observed_at = datetime.now(timezone.utc)
        repository = HyperliquidRuntimeRepository(session)
        context = self._load_cycle_context(session, repository)

        counts = _CycleCounts()
        for feature in context.features:
            counts += self._process_feature(feature, context, observed_at)

        self._write_performance(repository, context, observed_at)
        session.commit()
        return CycleResult(
            observed_at=observed_at,
            markets_seen=len(context.markets),
            signals_written=counts.signals,
            decisions_written=counts.decisions,
            orders_submitted=counts.orders,
            blocked_decisions=counts.blocked,
            dependency_statuses=context.dependencies,
        )

    def _load_cycle_context(
        self,
        session: Session,
        repository: HyperliquidRuntimeRepository,
    ) -> _CycleContext:
        clickhouse_status = self._clickhouse.status()
        markets = select_equity_like_markets(
            self._clickhouse.load_catalog_rows(),
            market_data_network=self._config.market_data_network,
            allowed_asset_classes=self._config.allowed_asset_classes,
            min_day_notional_volume_usd=self._config.min_day_notional_volume_usd,
            max_markets=self._config.max_markets_per_cycle,
        )
        repository.upsert_markets(markets)
        features = self._clickhouse.load_feature_rows(
            [market.market_id for market in markets]
        )
        fills = self._exchange.reconcile_fills(
            {market.coin: market.market_id for market in markets}
        )
        fill_count = repository.upsert_fills(fills)
        for fill in fills:
            self._journal.persist_refs(session, self._journal.fill_events(fill))
        exchange_status = self._exchange.dependency_status()
        dependencies = clickhouse_status.statuses + (exchange_status,)
        return _CycleContext(
            session=session,
            repository=repository,
            markets=tuple(markets),
            features=tuple(features),
            dependencies=dependencies,
            risk_state=repository.risk_state(dependencies=dependencies),
            fill_count=fill_count,
            exchange_ready=exchange_status.ready,
        )

    def _process_feature(
        self,
        feature: FeatureSnapshot,
        context: _CycleContext,
        observed_at: datetime,
    ) -> _CycleCounts:
        signal = generate_signal(
            feature,
            parameter_version=self._config.strategy_parameter_version,
            now=observed_at,
        )
        signal_id = context.repository.insert_signal(signal)
        verdict = evaluate_signal_risk(signal, context.risk_state, self._config)
        decision_id = context.repository.insert_decision(
            _decision_record(signal_id, signal, verdict)
        )
        if not verdict.allowed:
            return _CycleCounts(signals=1, decisions=1, blocked=1)
        self._submit_allowed_order(signal, verdict, decision_id, context)
        return _CycleCounts(signals=1, decisions=1, orders=1)

    def _submit_allowed_order(
        self,
        signal: Signal,
        verdict: RiskVerdict,
        decision_id: str,
        context: _CycleContext,
    ) -> None:
        intent = build_order_intent(
            signal=signal,
            verdict=verdict,
            config=self._config,
            decision_id=decision_id,
        )
        result = self._exchange.submit_ioc_limit(intent)
        context.repository.insert_order(intent, result)
        self._journal.persist_refs(
            context.session, self._journal.order_events(intent, result)
        )

    def _write_performance(
        self,
        repository: HyperliquidRuntimeRepository,
        context: _CycleContext,
        observed_at: datetime,
    ) -> None:
        repository.insert_performance_snapshot(
            PerformanceSnapshot(
                observed_at=observed_at,
                gross_exposure_usd=context.risk_state.gross_exposure_usd,
                realized_pnl_usd=context.risk_state.daily_realized_pnl_usd,
                unrealized_pnl_usd=Decimal("0"),
                fees_usd=Decimal("0"),
                trade_count=context.fill_count,
                reconciliation_status="pass"
                if context.exchange_ready
                else "exchange_stale",
            )
        )


def runtime_readiness(
    *,
    config: HyperliquidRuntimeConfig,
    latest_cycle: CycleResult | None,
    latest_error: str | None,
) -> tuple[bool, list[str], tuple[RuntimeDependencyStatus, ...]]:
    """Evaluate readiness from config, loop health, and dependency freshness."""

    reasons = config.validation_errors()
    dependencies: tuple[RuntimeDependencyStatus, ...] = ()
    if latest_error:
        reasons.append("latest_cycle_failed")
    if latest_cycle is None:
        reasons.append("cycle_not_completed")
    else:
        dependencies = latest_cycle.dependency_statuses
        reasons.extend(
            f"dependency_not_ready:{dependency.name}"
            for dependency in dependencies
            if not dependency.ready
        )
        cycle_lag = int(
            (datetime.now(timezone.utc) - latest_cycle.observed_at).total_seconds()
        )
        if cycle_lag > config.dependency_staleness_seconds:
            reasons.append("runtime_cycle_stale")
    return not reasons, reasons, dependencies


def _decision_record(
    signal_id: str,
    signal: Signal,
    verdict: RiskVerdict,
) -> DecisionRecord:
    return DecisionRecord(
        signal_id=signal_id,
        signal=signal,
        status="allowed" if verdict.allowed else "blocked",
        reason=verdict.reason,
        order_notional_usd=verdict.order_notional_usd,
    )


@dataclass(frozen=True)
class _CycleContext:
    session: Session
    repository: HyperliquidRuntimeRepository
    markets: tuple[HyperliquidMarket, ...]
    features: tuple[FeatureSnapshot, ...]
    dependencies: tuple[RuntimeDependencyStatus, ...]
    risk_state: RiskState
    fill_count: int
    exchange_ready: bool


@dataclass(frozen=True)
class _CycleCounts:
    signals: int = 0
    decisions: int = 0
    orders: int = 0
    blocked: int = 0

    def __add__(self, other: _CycleCounts) -> _CycleCounts:
        return _CycleCounts(
            signals=self.signals + other.signals,
            decisions=self.decisions + other.decisions,
            orders=self.orders + other.orders,
            blocked=self.blocked + other.blocked,
        )
