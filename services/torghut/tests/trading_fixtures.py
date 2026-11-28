"""Fresh input models for equity decision, strategy and pipeline tests."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from app.models import Strategy
from app.strategies.catalog import StrategyConfig, _compose_strategy_description
from app.trading.models import SignalEnvelope
from app.trading.strategy_runtime import (
    FeatureVectorV3,
    PluginEvaluationResult,
    StrategyContext,
    StrategyIntent,
)


def make_strategy(*, name: str, **overrides: object) -> Strategy:
    fields = {
        "description": None,
        "enabled": True,
        "base_timeframe": "1Min",
        "universe_type": "static",
        "universe_symbols": ["AAPL"],
    }
    return Strategy(name=name, **(fields | overrides))


def make_runtime_strategy(*, name: str, **overrides: object) -> Strategy:
    """Give an in-memory strategy an ID before it has been persisted."""
    return make_strategy(id=uuid4(), name=name, **overrides)


def make_catalog_strategy(
    *,
    name: str,
    strategy_type: str,
    max_position_pct_equity: Decimal,
    max_notional_per_trade: Decimal,
    params: dict[str, object] | None = None,
    id: UUID | None = None,
    strategy_id: str | None = None,
    version: str = "1.0.0",
    base_timeframe: str = "1Min",
    universe_type: str = "static",
    universe_symbols: list[str] | None = None,
) -> Strategy:
    symbols = ["AAPL"] if universe_symbols is None else universe_symbols
    fields = {
        "base_timeframe": base_timeframe,
        "universe_type": universe_type,
        "universe_symbols": symbols,
        "max_position_pct_equity": max_position_pct_equity,
        "max_notional_per_trade": max_notional_per_trade,
    }
    return make_strategy(
        id=uuid4() if id is None else id,
        name=name,
        description=_compose_strategy_description(
            StrategyConfig(
                name=name,
                strategy_id=name if strategy_id is None else strategy_id,
                strategy_type=strategy_type,
                version=version,
                params=params,
                **fields,
            )
        ),
        **fields,
    )


def make_signal(
    event_ts: datetime,
    *,
    payload: dict[str, object],
    symbol: str = "AAPL",
    timeframe: str | None = "1Min",
    **overrides: object,
) -> SignalEnvelope:
    return SignalEnvelope(
        event_ts=event_ts,
        payload=payload,
        symbol=symbol,
        timeframe=timeframe,
        **overrides,
    )


def macd_buy_signal(**overrides: object) -> SignalEnvelope:
    return make_signal(
        datetime.now(timezone.utc),
        payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
        **overrides,
    )


class _BuyPlugin:
    plugin_id = "buy_plugin"
    version = "1.0.0"
    required_features = ("price",)

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        return PluginEvaluationResult(
            intent=StrategyIntent(
                strategy_id=context.strategy_id,
                symbol=context.symbol,
                direction="buy",
                confidence=Decimal("0.90"),
                target_notional=Decimal("100"),
                horizon=context.timeframe,
                explain=("buy_signal",),
                feature_snapshot_hash=features.normalization_hash,
                required_features=self.required_features,
            )
        )


class _SellPlugin:
    plugin_id = "sell_plugin"
    version = "1.0.0"
    required_features = ("price",)

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        return PluginEvaluationResult(
            intent=StrategyIntent(
                strategy_id=context.strategy_id,
                symbol=context.symbol,
                direction="sell",
                confidence=Decimal("0.40"),
                target_notional=Decimal("200"),
                horizon=context.timeframe,
                explain=("sell_signal",),
                feature_snapshot_hash=features.normalization_hash,
                required_features=self.required_features,
            )
        )
