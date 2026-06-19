"""Runtime loop for Hyperliquid execution v2."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from .config import HyperliquidExecutionConfig
from .exchange import HyperliquidExecutionExchange
from .feed_reader import FeedStatus
from .models import (
    CycleRecord,
    CycleResult,
    ExecutionMarket,
    FeatureSnapshot,
    OpenOrder,
    RiskState,
    RuntimeDependencyStatus,
)
from .order_policy import build_maker_order_intent
from .repository import HyperliquidExecutionRepository
from .risk import evaluate_signal_risk
from .strategy import generate_signal
from .universe import UniverseSelectionConfig, select_configured_markets


class HyperliquidExecutionFeed(Protocol):
    """ClickHouse read surface used by one v2 cycle."""

    def status(self) -> FeedStatus:
        """Return feed freshness."""
        ...

    def load_catalog_rows(self) -> list[dict[str, object]]:
        """Load candidate market catalog rows."""
        ...

    def load_feature_rows(self, market_ids: list[str]) -> list[FeatureSnapshot]:
        """Load latest feature rows."""
        ...


class _Session(Protocol):
    def commit(self) -> None:
        """Commit one runtime cycle."""
        ...


class HyperliquidExecutionService:
    """One-cycle v2 orchestrator."""

    def __init__(
        self,
        *,
        config: HyperliquidExecutionConfig,
        feed: HyperliquidExecutionFeed,
        exchange: HyperliquidExecutionExchange,
    ) -> None:
        self._config = config
        self._feed = feed
        self._exchange = exchange

    def run_once(self, session: _Session) -> CycleResult:
        started_at = datetime.now(timezone.utc)
        cycle_id = str(uuid.uuid4())
        repository = HyperliquidExecutionRepository(session)
        context = self._load_context(repository, started_at)
        counts = _CycleCounts()

        counts.orders_cancelled = self._cancel_expired_orders(repository, started_at)

        risk_state = repository.risk_state(
            trading_enabled=self._config.order_submission_enabled(),
            dependencies=context.dependencies,
        )
        self._process_features(
            repository=repository,
            context=_FeatureProcessingContext(
                cycle_id=cycle_id,
                started_at=started_at,
                features=context.features,
                risk_state=risk_state,
            ),
            counts=counts,
        )

        repository.insert_performance_snapshot(observed_at=started_at)
        finished_at = datetime.now(timezone.utc)
        result = CycleResult(
            observed_at=finished_at,
            markets_seen=len(context.markets),
            selected_coins=tuple(market.coin for market in context.markets),
            signals_written=counts.signals_written,
            orders_submitted=counts.orders_submitted,
            orders_cancelled=counts.orders_cancelled,
            dependencies=context.dependencies,
            universe_details=context.universe_details,
        )
        repository.insert_cycle(self._cycle_record(cycle_id, started_at, result))
        session.commit()
        return result

    def _cancel_expired_orders(
        self,
        repository: HyperliquidExecutionRepository,
        started_at: datetime,
    ) -> int:
        cancelled = 0
        for expired in repository.expired_open_orders(now=started_at):
            self._cancel_order(repository, expired)
            cancelled += 1
        return cancelled

    def _cancel_order(
        self,
        repository: HyperliquidExecutionRepository,
        expired: OpenOrder,
    ) -> None:
        result = self._exchange.cancel_order(expired)
        repository.mark_order_cancelled(expired, result)

    def _process_features(
        self,
        *,
        repository: HyperliquidExecutionRepository,
        context: "_FeatureProcessingContext",
        counts: "_CycleCounts",
    ) -> None:
        for feature in context.features:
            signal = generate_signal(feature, self._config, now=context.started_at)
            signal_id = repository.insert_signal(
                cycle_id=context.cycle_id, signal=signal
            )
            counts.signals_written += 1
            verdict = evaluate_signal_risk(signal, context.risk_state, self._config)
            if not verdict.allowed:
                continue
            try:
                intent = build_maker_order_intent(
                    signal=signal,
                    verdict=verdict,
                    config=self._config,
                    signal_id=signal_id,
                    now=context.started_at,
                )
                result = self._exchange.submit_maker_order(intent)
            except Exception:
                continue
            repository.insert_order(intent, result)
            repository.update_reject_cooldown(
                coin=intent.coin,
                rejection_reason=result.rejection_reason,
                config=self._config,
            )
            counts.orders_submitted += 1

    def _cycle_record(
        self,
        cycle_id: str,
        started_at: datetime,
        result: CycleResult,
    ) -> CycleRecord:
        return CycleRecord(
            cycle_id=cycle_id,
            started_at=started_at,
            finished_at=result.observed_at,
            trading_enabled=self._config.trading_enabled,
            selected_coins=result.selected_coins,
            signals_written=result.signals_written,
            orders_submitted=result.orders_submitted,
            orders_cancelled=result.orders_cancelled,
            dependency_statuses=result.dependencies,
            universe_details=result.universe_details,
        )

    def _load_context(
        self,
        repository: HyperliquidExecutionRepository,
        observed_at: datetime,
    ) -> "_CycleContext":
        feed_status = self._feed.status()
        feed_markets, feed_details = select_configured_markets(
            self._feed.load_catalog_rows(),
            config=UniverseSelectionConfig(
                market_data_network=self._config.market_data_network,
                configured_coins=self._config.trade_coins,
                excluded_coins=self._config.excluded_coins,
                min_day_notional_volume_usd=self._config.min_day_notional_volume_usd,
                max_markets=self._config.max_markets_per_cycle,
            ),
        )
        repository.upsert_markets(feed_markets)
        execution_markets, execution_status = self._exchange.filter_supported_markets(
            feed_markets
        )
        fresh_features = self._fresh_features(execution_markets)
        feature_status = _feature_status(execution_markets, fresh_features)
        open_order_status = self._reconcile_exchange_state(
            repository, execution_markets, observed_at
        )
        exchange_status = self._exchange.dependency_status()
        return _CycleContext(
            markets=execution_markets,
            features=fresh_features,
            dependencies=feed_status.statuses
            + (execution_status, feature_status, open_order_status, exchange_status),
            universe_details=self._universe_details(feed_details, execution_status),
        )

    def _fresh_features(
        self, execution_markets: tuple[ExecutionMarket, ...]
    ) -> tuple[FeatureSnapshot, ...]:
        feature_rows = self._feed.load_feature_rows(
            [market.market_id for market in execution_markets]
        )
        return tuple(
            feature
            for feature in feature_rows
            if feature.source_lag_seconds <= self._config.signal_staleness_seconds
        )

    def _reconcile_exchange_state(
        self,
        repository: HyperliquidExecutionRepository,
        execution_markets: tuple[ExecutionMarket, ...],
        observed_at: datetime,
    ) -> RuntimeDependencyStatus:
        market_id_by_coin = {
            market.coin: market.market_id for market in execution_markets
        }
        repository.upsert_fills(self._exchange.reconcile_fills(market_id_by_coin))
        repository.upsert_account_state(
            self._exchange.reconcile_account(market_id_by_coin)
        )
        open_coins = self._exchange.reconcile_open_order_coins(
            frozenset(market_id_by_coin)
        )
        return RuntimeDependencyStatus(
            name="hyperliquid_open_orders",
            ready=True,
            observed_at=observed_at,
            details={"open_order_coins": sorted(open_coins)},
        )

    def _universe_details(
        self,
        feed_details: dict[str, object],
        execution_status: RuntimeDependencyStatus,
    ) -> dict[str, object]:
        details = dict(feed_details)
        details.update(execution_status.details)
        details.update(self._exchange.execution_metadata_details())
        return details


def runtime_readiness(
    *,
    config: HyperliquidExecutionConfig,
    latest_cycle: CycleResult | None,
    latest_error: str | None,
) -> tuple[bool, list[str], tuple[RuntimeDependencyStatus, ...]]:
    """Return API readiness for the v2 runtime."""

    reasons = config.validation_errors()
    if latest_error is not None:
        reasons.append(f"latest_cycle_error:{latest_error}")
    if latest_cycle is None:
        reasons.append("no_successful_cycle")
        return False, reasons, ()
    blockers = [
        dependency.name
        for dependency in latest_cycle.dependencies
        if not dependency.ready
    ]
    reasons.extend(f"dependency_not_ready:{name}" for name in blockers)
    return not reasons, reasons, latest_cycle.dependencies


@dataclass(frozen=True)
class _CycleContext:
    markets: tuple[ExecutionMarket, ...]
    features: tuple[FeatureSnapshot, ...]
    dependencies: tuple[RuntimeDependencyStatus, ...]
    universe_details: dict[str, object]


@dataclass(frozen=True)
class _FeatureProcessingContext:
    cycle_id: str
    started_at: datetime
    features: tuple[FeatureSnapshot, ...]
    risk_state: RiskState


@dataclass
class _CycleCounts:
    signals_written: int = 0
    orders_submitted: int = 0
    orders_cancelled: int = 0


def _feature_status(
    markets: tuple[ExecutionMarket, ...],
    features: tuple[FeatureSnapshot, ...],
) -> RuntimeDependencyStatus:
    feature_market_ids = {feature.market_id for feature in features}
    missing = [
        market.coin for market in markets if market.market_id not in feature_market_ids
    ]
    ready = bool(markets) and not missing
    return RuntimeDependencyStatus(
        name="hyperliquid_mainnet_features",
        ready=ready,
        reason=None if ready else "missing_fresh_features",
        details={
            "missing": missing,
            "features": [feature.coin for feature in features],
        },
    )
