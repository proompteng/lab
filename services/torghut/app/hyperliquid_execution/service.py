"""Runtime loop for Hyperliquid execution v2."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol, cast

from .config import HyperliquidExecutionConfig
from .entry_processing import process_features
from .exchange import HyperliquidExecutionExchange
from .feed_reader import FeedStatus
from .maintenance import close_largest_positions_over_cap, risk_state_over_cap
from .models import (
    CycleRecord,
    CycleResult,
    ExecutionMarket,
    FeatureSnapshot,
    OpenOrder,
    RiskState,
    RuntimeDependencyStatus,
)
from .repository import HyperliquidExecutionRepository
from .reconciliation_keys import market_id_by_reconciliation_coin
from .runtime_details import risk_state_details, universe_details
from .universe import UniverseSelectionConfig, select_configured_markets


class HyperliquidExecutionFeed(Protocol):
    def status(self) -> FeedStatus: ...

    def load_catalog_rows(self) -> list[dict[str, object]]: ...

    def load_feature_rows(self, market_ids: list[str]) -> list[FeatureSnapshot]: ...


class _Session(Protocol):
    def commit(self) -> None: ...


class HyperliquidExecutionService:
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
        repository.insert_cycle(
            self._cycle_record(
                cycle_id,
                started_at,
                CycleResult(
                    observed_at=started_at,
                    markets_seen=len(context.markets),
                    selected_coins=tuple(market.coin for market in context.markets),
                    signals_written=0,
                    orders_submitted=0,
                    orders_cancelled=0,
                    dependencies=context.dependencies,
                    universe_details=context.universe_details,
                ),
            )
        )

        counts.orders_cancelled = self._cancel_expired_orders(repository, started_at)

        risk_state = repository.risk_state(
            trading_enabled=self._config.order_submission_enabled(),
            dependencies=context.dependencies,
            max_leverage_by_coin={
                market.coin: market.max_leverage
                for market in context.markets
                if market.max_leverage is not None
            },
        )
        context.universe_details["risk_state"] = risk_state_details(
            risk_state, self._config
        )
        maintenance_reduce_only = self._reduce_over_cap_exposure(risk_state)
        counts.record_maintenance_reduce_only(maintenance_reduce_only)
        if not _maintenance_reduce_only_ran(maintenance_reduce_only):
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
        repository.insert_multifactor_attribution_snapshot(
            run_id=cycle_id,
            observed_at=started_at,
        )
        finished_at = datetime.now(timezone.utc)
        universe_details = _cycle_universe_details(context.universe_details, counts)
        result = CycleResult(
            observed_at=finished_at,
            markets_seen=len(context.markets),
            selected_coins=tuple(market.coin for market in context.markets),
            signals_written=counts.signals_written,
            orders_submitted=counts.orders_submitted,
            orders_cancelled=counts.orders_cancelled,
            dependencies=context.dependencies,
            universe_details=universe_details,
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

    def _reduce_over_cap_exposure(self, risk_state: RiskState) -> dict[str, object]:
        if not risk_state_over_cap(risk_state, self._config):
            return {
                "schema_version": "torghut.hyperliquid-execution-over-cap-maintenance.v1",
                "over_cap": False,
                "gross_over_cap": False,
                "symbol_over_cap": False,
                "symbol_over_cap_coins": [],
                "actions": [],
            }
        return close_largest_positions_over_cap(
            config=self._config,
            exchange=self._exchange,
            execute=True,
            max_actions=1,
        )

    def _process_features(
        self,
        *,
        repository: HyperliquidExecutionRepository,
        context: "_FeatureProcessingContext",
        counts: "_CycleCounts",
    ) -> None:
        process_features(
            repository=repository,
            config=self._config,
            exchange=self._exchange,
            context=context,
            counts=counts,
        )

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
        liquid_markets, liquidity_status = self._exchange.filter_crossable_markets(
            execution_markets
        )
        fresh_features = self._fresh_features(liquid_markets)
        selected_markets, selected_features = _select_markets_with_fresh_features(
            liquid_markets, fresh_features
        )
        feature_status = _feature_status(liquid_markets, fresh_features)
        open_order_status = self._reconcile_exchange_state(
            repository, selected_markets, observed_at
        )
        exchange_status = self._exchange.dependency_status()
        return _CycleContext(
            markets=selected_markets,
            features=selected_features,
            dependencies=feed_status.statuses
            + (
                execution_status,
                liquidity_status,
                feature_status,
                open_order_status,
                exchange_status,
            ),
            universe_details=universe_details(
                feed_details,
                (execution_status, liquidity_status),
                feature_status,
                selected_markets,
                self._exchange.execution_metadata_details(),
            ),
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
        market_id_by_coin = market_id_by_reconciliation_coin(execution_markets)
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


def runtime_readiness(
    *,
    config: HyperliquidExecutionConfig,
    latest_cycle: CycleResult | None,
    latest_error: str | None,
) -> tuple[bool, list[str], tuple[RuntimeDependencyStatus, ...]]:
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


def _empty_counts() -> dict[str, int]:
    return {}


def _empty_nested_counts() -> dict[str, dict[str, int]]:
    return {}


def _empty_gate_details() -> dict[str, dict[str, object]]:
    return {}


@dataclass
class _CycleCounts:
    signals_written: int = 0
    orders_submitted: int = 0
    orders_cancelled: int = 0
    risk_blocks_by_reason: dict[str, int] = field(default_factory=_empty_counts)
    risk_blocks_by_coin: dict[str, dict[str, int]] = field(
        default_factory=_empty_nested_counts
    )
    order_errors_by_type: dict[str, int] = field(default_factory=_empty_counts)
    maintenance_reduce_only: dict[str, object] | None = None
    position_reduce_only: dict[str, object] | None = None
    profitability_gates: dict[str, dict[str, object]] = field(
        default_factory=_empty_gate_details
    )
    latest_profitability_gate: dict[str, object] | None = None

    def record_risk_block(self, coin: str, reason: str) -> None:
        self.risk_blocks_by_reason[reason] = (
            self.risk_blocks_by_reason.get(reason, 0) + 1
        )
        coin_blocks = self.risk_blocks_by_coin.setdefault(coin, {})
        coin_blocks[reason] = coin_blocks.get(reason, 0) + 1

    def record_order_error(self, error_type: str) -> None:
        self.order_errors_by_type[error_type] = (
            self.order_errors_by_type.get(error_type, 0) + 1
        )

    def record_maintenance_reduce_only(self, report: dict[str, object]) -> None:
        self.maintenance_reduce_only = report
        actions = report.get("actions")
        if not isinstance(actions, list):
            return
        action_items = cast(list[object], actions)
        submitted_statuses = {"accepted", "filled", "submitted"}
        self.orders_submitted += sum(
            1
            for action in action_items
            if isinstance(action, dict)
            and cast(dict[str, object], action).get("status") in submitted_statuses
        )

    def record_position_reduce_only(self, action: dict[str, object]) -> None:
        self.position_reduce_only = action
        if action.get("status") in {"accepted", "filled", "submitted"}:
            self.orders_submitted += 1

    def record_profitability_gate(
        self,
        coin: str,
        gate: dict[str, object],
    ) -> None:
        details = {"coin": coin, **gate}
        self.profitability_gates[coin] = details
        self.latest_profitability_gate = details


def _select_markets_with_fresh_features(
    markets: tuple[ExecutionMarket, ...],
    features: tuple[FeatureSnapshot, ...],
) -> tuple[tuple[ExecutionMarket, ...], tuple[FeatureSnapshot, ...]]:
    feature_by_market_id = {
        feature.market_id: feature for feature in reversed(features)
    }
    selected_markets = tuple(
        market for market in markets if market.market_id in feature_by_market_id
    )
    selected_features = tuple(
        feature_by_market_id[market.market_id] for market in selected_markets
    )
    return selected_markets, selected_features


def _cycle_universe_details(
    universe_details: dict[str, object],
    counts: _CycleCounts,
) -> dict[str, object]:
    details = dict(universe_details)
    if counts.maintenance_reduce_only is not None:
        details["maintenance_reduce_only"] = counts.maintenance_reduce_only
    if counts.position_reduce_only is not None:
        details["position_reduce_only"] = counts.position_reduce_only
    if counts.profitability_gates:
        details["profitability_gates"] = {
            coin: dict(gate)
            for coin, gate in sorted(counts.profitability_gates.items())
        }
    if counts.latest_profitability_gate is not None:
        details["profitability_gate"] = dict(counts.latest_profitability_gate)
    if counts.risk_blocks_by_reason:
        details["risk_blocks_by_reason"] = dict(
            sorted(counts.risk_blocks_by_reason.items())
        )
    if counts.risk_blocks_by_coin:
        details["risk_blocks_by_coin"] = {
            coin: dict(sorted(reason_counts.items()))
            for coin, reason_counts in sorted(counts.risk_blocks_by_coin.items())
        }
    if counts.order_errors_by_type:
        details["order_errors_by_type"] = dict(
            sorted(counts.order_errors_by_type.items())
        )
    return details


def _maintenance_reduce_only_ran(report: dict[str, object]) -> bool:
    actions = report.get("actions")
    return isinstance(actions, list) and bool(cast(list[object], actions))


def _feature_status(
    markets: tuple[ExecutionMarket, ...],
    features: tuple[FeatureSnapshot, ...],
) -> RuntimeDependencyStatus:
    feature_market_ids = {feature.market_id for feature in features}
    missing = [
        market.coin for market in markets if market.market_id not in feature_market_ids
    ]
    ready = bool(features)
    reason: str | None = None
    if not ready:
        reason = "no_fresh_features" if markets else "no_execution_markets"
    return RuntimeDependencyStatus(
        name="hyperliquid_mainnet_features",
        ready=ready,
        reason=reason,
        details={
            "missing": missing,
            "features": [feature.coin for feature in features],
        },
    )
