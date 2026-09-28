from __future__ import annotations


import uuid
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.models import Strategy
from app.strategies.catalog import StrategyConfig, _compose_strategy_description
from app.trading.decisions import (
    DecisionEngine,
    build_runtime_position_exit_overlay,
    count_open_short_positions,
    exit_position_side_for_strategies,
    is_entry_action_for_strategies,
    is_exit_action_for_strategies,
    passes_runtime_trade_policy,
    record_runtime_trade_policy_decision,
    resolve_qty,
    resolve_qty_for_aggregated,
    resolve_strategy_time_in_force,
)
from app.trading.features import extract_signal_features
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.prices import MarketSnapshot, PriceFetcher
from app.trading.strategy_runtime import (
    FeatureVectorV3,
    PluginEvaluationResult,
    StrategyContext,
    StrategyIntent,
    StrategyRegistry,
    StrategyRuntime,
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


__all__: tuple[str, ...] = (
    "Decimal",
    "DecisionEngine",
    "FeatureVectorV3",
    "MarketSnapshot",
    "PluginEvaluationResult",
    "PriceFetcher",
    "SignalEnvelope",
    "SimpleNamespace",
    "Strategy",
    "StrategyConfig",
    "StrategyContext",
    "StrategyDecision",
    "StrategyIntent",
    "StrategyRegistry",
    "StrategyRuntime",
    "TestCase",
    "_BuyPlugin",
    "_SellPlugin",
    "build_runtime_position_exit_overlay",
    "_compose_strategy_description",
    "count_open_short_positions",
    "exit_position_side_for_strategies",
    "is_entry_action_for_strategies",
    "is_exit_action_for_strategies",
    "passes_runtime_trade_policy",
    "record_runtime_trade_policy_decision",
    "resolve_qty",
    "resolve_qty_for_aggregated",
    "resolve_strategy_time_in_force",
    "datetime",
    "extract_signal_features",
    "patch",
    "settings",
    "timezone",
    "uuid",
)
