"""Runtime loop for the isolated Hyperliquid testnet lane."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from .clickhouse import ClickHouseStatus
from .config import HyperliquidRuntimeConfig
from .exchange import HyperliquidExchange
from .ledger import HyperliquidJournalEvent
from .models import (
    CycleResult,
    DecisionRecord,
    Fill,
    FeatureSnapshot,
    HyperliquidMarket,
    OrderIntent,
    OrderResult,
    PerformanceSnapshot,
    RiskState,
    RuntimeDependencyStatus,
    Signal,
    RiskVerdict,
)
from .optimizer import (
    OptimizerGateResult,
    build_optimizer_candidate,
    evaluate_optimizer_candidate,
    persist_optimizer_run,
)
from .repository import HyperliquidRuntimeRepository
from .risk import build_order_intent, evaluate_signal_risk
from .runtime_session import RuntimeSession
from .strategy import generate_signal
from .universe import select_equity_like_markets


class HyperliquidRuntimeClickHouse(Protocol):
    """ClickHouse read surface required by one runtime cycle."""

    def status(self) -> ClickHouseStatus:
        """Return feed readiness."""
        ...

    def load_catalog_rows(self) -> list[dict[str, object]]:
        """Load candidate market catalog rows."""
        ...

    def load_feature_rows(self, market_ids: list[str]) -> list[FeatureSnapshot]:
        """Load latest feature rows for selected markets."""
        ...

    def load_optimizer_history_summary(self) -> dict[str, object]:
        """Load bounded ClickHouse market history for offline optimizer input."""
        ...


class HyperliquidRuntimeJournal(Protocol):
    """TigerBeetle journal surface required by one runtime cycle."""

    def fill_events(self, fill: Fill) -> Sequence[HyperliquidJournalEvent]:
        """Build journal events for a fill."""
        ...

    def order_events(
        self,
        intent: OrderIntent,
        result: OrderResult,
    ) -> Sequence[HyperliquidJournalEvent]:
        """Build journal events for an order."""
        ...

    def persist_refs(
        self,
        session: RuntimeSession,
        events: Sequence[HyperliquidJournalEvent],
    ) -> int:
        """Persist journal event references."""
        ...

    def dependency_status(self) -> RuntimeDependencyStatus:
        """Return TigerBeetle journal readiness."""
        ...


class HyperliquidRuntimeService:
    """One-cycle runtime orchestrator."""

    def __init__(
        self,
        *,
        config: HyperliquidRuntimeConfig,
        clickhouse: HyperliquidRuntimeClickHouse,
        exchange: HyperliquidExchange,
        journal: HyperliquidRuntimeJournal,
    ) -> None:
        self._config = config
        self._clickhouse = clickhouse
        self._exchange = exchange
        self._journal = journal

    def run_once(self, session: RuntimeSession) -> CycleResult:
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

    def run_optimizer_once(
        self,
        session: RuntimeSession,
    ) -> OptimizerGateResult | None:
        if not self._config.optimizer_enabled:
            return None
        candidate = build_optimizer_candidate(
            session,
            config=self._config,
            history_summary=self._clickhouse.load_optimizer_history_summary(),
        )
        result = evaluate_optimizer_candidate(candidate, self._config)
        persist_optimizer_run(session, candidate, result)
        session.commit()
        return result

    def _load_cycle_context(
        self,
        session: RuntimeSession,
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
        execution_markets, execution_universe_status = (
            self._exchange.filter_supported_markets(tuple(markets))
        )
        features = (
            self._clickhouse.load_feature_rows(
                [market.market_id for market in execution_markets]
            )
            if execution_markets
            else []
        )
        fresh_features = _fresh_features(
            features, max_source_lag_seconds=self._config.signal_staleness_seconds
        )
        feature_status = _feature_readiness_status(
            execution_markets=execution_markets,
            features=fresh_features,
            clickhouse_ready=clickhouse_status.ready,
        )
        market_id_by_coin = {
            market.coin: market.market_id for market in execution_markets
        }
        journal_status = self._journal.dependency_status()
        if self._config.trading_enabled:
            self._exchange.schedule_dead_man_cancel(
                seconds_from_now=max(60, self._config.poll_interval_seconds * 4)
            )
        fills = self._exchange.reconcile_fills(market_id_by_coin)
        fill_count = repository.upsert_fills(fills)
        if journal_status.ready:
            for fill in fills:
                self._journal.persist_refs(session, self._journal.fill_events(fill))
        account_state = self._exchange.reconcile_account(market_id_by_coin)
        repository.upsert_account_state(account_state)
        open_order_status = self._reconcile_closed_orders(
            session=session,
            repository=repository,
            market_id_by_coin=market_id_by_coin,
            journal_status=journal_status,
        )
        exchange_status = self._exchange.dependency_status()
        dependencies = clickhouse_status.statuses + (
            execution_universe_status,
            feature_status,
            open_order_status,
            journal_status,
            exchange_status,
        )
        return _CycleContext(
            session=session,
            repository=repository,
            markets=execution_markets,
            features=tuple(fresh_features),
            dependencies=dependencies,
            risk_state=repository.risk_state(dependencies=dependencies),
            fill_count=fill_count,
            exchange_ready=exchange_status.ready,
            journal_ready=journal_status.ready,
        )

    def _reconcile_closed_orders(
        self,
        *,
        session: RuntimeSession,
        repository: HyperliquidRuntimeRepository,
        market_id_by_coin: dict[str, str],
        journal_status: RuntimeDependencyStatus,
    ) -> RuntimeDependencyStatus:
        status_name = "hyperliquid_open_order_reconciliation"
        if not self._config.trading_enabled or not market_id_by_coin:
            return RuntimeDependencyStatus(name=status_name, ready=True)
        if not journal_status.ready:
            return RuntimeDependencyStatus(
                name=status_name,
                ready=True,
                reason="skipped_journal_not_ready",
            )
        try:
            open_order_market_ids = self._exchange.reconcile_open_order_market_ids(
                market_id_by_coin
            )
        except Exception as exc:
            return RuntimeDependencyStatus(
                name=status_name,
                ready=False,
                reason=f"open_order_reconciliation_failed:{type(exc).__name__}",
            )
        release_orders = repository.reconcile_closed_orders(
            open_order_market_ids=open_order_market_ids
        )
        for intent, result in release_orders:
            self._journal.persist_refs(
                session,
                self._journal.order_events(intent, result),
            )
        return RuntimeDependencyStatus(
            name=status_name,
            ready=True,
            observed_at=datetime.now(timezone.utc),
            lag_seconds=0,
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
        self._journal.persist_refs(
            context.session,
            self._journal.order_events(
                intent,
                OrderResult(
                    status="submitted",
                    exchange_order_id=None,
                    raw_response={"pre_exchange_submit": True},
                ),
            ),
        )
        try:
            result = self._exchange.submit_ioc_limit(intent)
        except Exception as exc:
            result = OrderResult(
                status="rejected",
                exchange_order_id=None,
                raw_response={"error": type(exc).__name__},
                rejection_reason=f"exchange_submit_failed:{type(exc).__name__}",
            )
        context.repository.insert_order(intent, result)
        if result.status in {"rejected", "cancelled"}:
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
                unrealized_pnl_usd=context.risk_state.unrealized_pnl_usd,
                fees_usd=context.risk_state.daily_fees_usd,
                trade_count=context.fill_count,
                reconciliation_status=_performance_reconciliation_status(context),
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


def _feature_readiness_status(
    *,
    execution_markets: tuple[HyperliquidMarket, ...],
    features: list[FeatureSnapshot],
    clickhouse_ready: bool,
) -> RuntimeDependencyStatus:
    if not execution_markets:
        return RuntimeDependencyStatus(
            name="hyperliquid_execution_features",
            ready=True,
            reason=None,
        )
    feature_market_ids = {feature.market_id for feature in features}
    execution_market_ids = {market.market_id for market in execution_markets}
    if features:
        newest = max(feature.event_ts for feature in features)
        observed_at = datetime.now(timezone.utc)
        missing_count = len(execution_market_ids - feature_market_ids)
        return RuntimeDependencyStatus(
            name="hyperliquid_execution_features",
            ready=True,
            observed_at=newest,
            lag_seconds=max(0, int((observed_at - newest).total_seconds())),
            reason=(
                f"partial_feature_coverage_missing:{missing_count}"
                if missing_count > 0
                else None
            ),
        )
    return RuntimeDependencyStatus(
        name="hyperliquid_execution_features",
        ready=False,
        reason=(
            "missing_fresh_features_for_execution_markets"
            if clickhouse_ready
            else "clickhouse_not_ready_for_execution_features"
        ),
    )


def _fresh_features(
    features: list[FeatureSnapshot], *, max_source_lag_seconds: int
) -> list[FeatureSnapshot]:
    return [
        feature
        for feature in features
        if feature.source_lag_seconds <= max_source_lag_seconds
    ]


def _performance_reconciliation_status(context: _CycleContext) -> str:
    if not context.exchange_ready:
        return "exchange_stale"
    if not context.journal_ready:
        return "tigerbeetle_stale"
    return "pass"


@dataclass(frozen=True)
class _CycleContext:
    session: RuntimeSession
    repository: HyperliquidRuntimeRepository
    markets: tuple[HyperliquidMarket, ...]
    features: tuple[FeatureSnapshot, ...]
    dependencies: tuple[RuntimeDependencyStatus, ...]
    risk_state: RiskState
    fill_count: int
    exchange_ready: bool
    journal_ready: bool


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
