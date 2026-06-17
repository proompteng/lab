from __future__ import annotations

# ruff: noqa: F401

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.models import Strategy
from app.strategies.catalog import (
    StrategyCatalogConfig,
    StrategyConfig,
    _compose_strategy_description,
)
from app.trading.features import (
    FeatureNormalizationError,
    FeatureVectorV3,
    normalize_feature_vector_v3,
)
from app.trading.evaluation_trace import GateTrace, StrategyTrace
from app.trading.models import SignalEnvelope
from app.trading.research_sleeves import (
    _rank_thresholds,
    evaluate_mean_reversion_exhaustion_short,
)
from app.trading.strategy_runtime import (
    LegacyMacdRsiPlugin,
    MicrobarCrossSectionalLongPlugin,
    MicrobarCrossSectionalPairsPlugin,
    MicrobarCrossSectionalShortPlugin,
    StrategyContext,
    StrategyDefinition,
    StrategyIntent,
    StrategyRegistry,
    StrategyRuntime,
    _evaluate_microbar_cross_sectional,
    _microbar_entry_window_minutes,
    _microbar_exit_minute_after_open,
    _microbar_minutes_elapsed,
    _microbar_rank_thresholds,
    _microbar_universe_size,
    _trace_suppression_reason,
)


class _FailingPlugin:
    plugin_id = "failing"
    version = "1.0.0"
    required_features = ("macd",)

    def evaluate(self, context: StrategyContext, features):  # type: ignore[no-untyped-def]
        _ = context
        _ = features
        raise RuntimeError("boom")


class _BuyPlugin:
    plugin_id = "buy_plugin"
    version = "1.0.0"
    required_features = ("price",)

    def evaluate(  # type: ignore[no-untyped-def]
        self, context: StrategyContext, features
    ) -> StrategyIntent:
        return StrategyIntent(
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


class _SellPlugin:
    plugin_id = "sell_plugin"
    version = "1.0.0"
    required_features = ("price",)

    def evaluate(  # type: ignore[no-untyped-def]
        self, context: StrategyContext, features
    ) -> StrategyIntent:
        return StrategyIntent(
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


def _test_feature_vector(
    values: dict[str, object],
    *,
    event_ts: datetime | None = None,
    symbol: str = "META",
) -> FeatureVectorV3:
    return FeatureVectorV3(
        event_ts=event_ts or datetime(2026, 3, 24, 14, 30, 0, tzinfo=timezone.utc),
        symbol=symbol,
        timeframe="1Sec",
        seq=1,
        source="unit-test",
        feature_schema_version="v3",
        values=values,
        normalization_hash="unit-hash",
    )


__all__: tuple[str, ...] = ()
