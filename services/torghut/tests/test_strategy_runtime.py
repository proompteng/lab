from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.models import Strategy
from app.trading.features import FeatureNormalizationError, normalize_feature_vector_v3
from app.trading.models import SignalEnvelope
from app.trading.strategy_runtime import (
    LegacyMacdRsiPlugin,
    StrategyContext,
    StrategyIntent,
    StrategyRegistry,
    StrategyRuntime,
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


class TestStrategyRuntime(TestCase):
    def test_runtime_is_deterministic_for_same_input(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="deterministic",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=42,
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 25, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision_a = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        decision_b = runtime.evaluate(strategy, feature_contract, timeframe="1Min")

        self.assertIsNotNone(decision_a)
        self.assertIsNotNone(decision_b)
        assert decision_a is not None
        assert decision_b is not None
        self.assertEqual(decision_a.intent.action, "buy")
        self.assertEqual(decision_a.parameter_hash, decision_b.parameter_hash)
        self.assertEqual(decision_a.feature_hash, decision_b.feature_hash)

    def test_runtime_missing_required_features_fails_closed(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="invalid",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"price": 101.5},
        )
        runtime = StrategyRuntime()
        with self.assertRaises(FeatureNormalizationError):
            feature_vector = normalize_feature_vector_v3(signal)
            runtime.evaluate(strategy, feature_vector, timeframe="1Min")

    def test_intraday_tsmom_plugin_emits_buy_on_trend(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=7,
            payload={
                "price": 140.25,
                "ema12": 140.40,
                "ema26": 139.95,
                "macd": 0.45,
                "macd_signal": 0.30,
                "rsi14": 56,
                "vol_realized_w60s": 0.009,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertIn("tsmom_trend_up", decision.intent.rationale)
        self.assertIn("momentum_confirmed", decision.intent.rationale)
        self.assertEqual(decision.plugin_id, "intraday_tsmom")

    def test_intraday_tsmom_plugin_emits_sell_on_downtrend(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=9,
            payload={
                "price": 140.05,
                "ema12": 139.90,
                "ema26": 140.35,
                "macd": -0.40,
                "macd_signal": -0.25,
                "rsi14": 72,
                "vol_realized_w60s": 0.011,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertIn("tsmom_trend_down", decision.intent.rationale)
        self.assertIn("momentum_reversal_exit", decision.intent.rationale)

    def test_runtime_isolates_plugin_failures_and_continues(self) -> None:
        healthy = Strategy(
            id=uuid.uuid4(),
            name="healthy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2000"),
        )
        broken = Strategy(
            id=uuid.uuid4(),
            name="broken",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="failing",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=5,
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 24, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)

        registry = StrategyRegistry(
            plugins={
                "legacy_macd_rsi": LegacyMacdRsiPlugin(),
                "failing": _FailingPlugin(),
            }
        )
        runtime = StrategyRuntime(registry=registry)
        evaluation = runtime.evaluate_all(
            [healthy, broken], feature_contract, timeframe="1Min"
        )

        self.assertEqual(len(evaluation.intents), 1)
        self.assertEqual(evaluation.intents[0].direction, "buy")
        self.assertEqual(len(evaluation.errors), 1)
        self.assertEqual(evaluation.errors[0].strategy_id, str(broken.id))
        self.assertEqual(
            evaluation.observation.strategy_errors_total.get(str(broken.id)), 1
        )

    def test_runtime_replay_is_deterministic_for_fixed_fixture(self) -> None:
        strategy_a = Strategy(
            id=uuid.uuid4(),
            name="legacy-a",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("1000"),
        )
        strategy_b = Strategy(
            id=uuid.uuid4(),
            name="legacy-b",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, 14, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=88,
            payload={"macd": {"macd": 1.5, "signal": 0.4}, "rsi14": 22, "price": 130.1},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        evaluation_a = runtime.evaluate_all(
            [strategy_a, strategy_b], feature_contract, timeframe="1Min"
        )
        evaluation_b = runtime.evaluate_all(
            [strategy_a, strategy_b], feature_contract, timeframe="1Min"
        )

        self.assertEqual(len(evaluation_a.intents), 1)
        self.assertEqual(len(evaluation_b.intents), 1)
        self.assertEqual(evaluation_a.intents[0].symbol, evaluation_b.intents[0].symbol)
        self.assertEqual(
            evaluation_a.intents[0].direction, evaluation_b.intents[0].direction
        )
        self.assertEqual(
            evaluation_a.intents[0].confidence, evaluation_b.intents[0].confidence
        )
        self.assertEqual(
            evaluation_a.intents[0].target_notional,
            evaluation_b.intents[0].target_notional,
        )
        self.assertEqual(
            evaluation_a.intents[0].source_strategy_ids,
            evaluation_b.intents[0].source_strategy_ids,
        )

    def test_runtime_aggregates_source_ids_only_from_winning_direction(self) -> None:
        buy_strategy = Strategy(
            id=uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="buy_plugin",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("100"),
        )
        sell_strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            name="sell",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="sell_plugin",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("900"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=99,
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 24, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                    "sell_plugin": _SellPlugin(),
                }
            )
        )

        evaluation = runtime.evaluate_all(
            [buy_strategy, sell_strategy], feature_contract, timeframe="1Min"
        )

        self.assertEqual(len(evaluation.intents), 1)
        self.assertEqual(evaluation.intents[0].direction, "buy")
        self.assertEqual(
            evaluation.intents[0].source_strategy_ids,
            (str(buy_strategy.id),),
        )

    def test_runtime_rejects_plugin_with_undeclared_contract_feature(self) -> None:
        class InvalidPlugin:
            plugin_id = "invalid_plugin"
            version = "1.0.0"
            required_features = ("price", "not_in_feature_contract")

            def evaluate(self, context, features):  # type: ignore[no-untyped-def]
                _ = context
                _ = features
                return None

        strategy = Strategy(
            id=uuid.uuid4(),
            name="invalid-plugin",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="invalid",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 25, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime(
            registry=StrategyRegistry(plugins={"invalid": InvalidPlugin()})
        )

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        self.assertIsNone(decision)
