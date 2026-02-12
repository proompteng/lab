from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.models import Strategy
from app.trading.features import FeatureNormalizationError, normalize_feature_vector_v3
from app.trading.models import SignalEnvelope
from app.trading.strategy_runtime import StrategyRuntime


class TestStrategyRuntime(TestCase):
    def test_runtime_is_deterministic_for_same_input(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name='deterministic',
            description='version=1.0.0',
            enabled=True,
            base_timeframe='1Min',
            universe_type='legacy_macd_rsi',
            universe_symbols=['AAPL'],
            max_position_pct_equity=Decimal('0.02'),
            max_notional_per_trade=Decimal('2500'),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            seq=42,
            payload={'macd': {'macd': 1.2, 'signal': 0.3}, 'rsi14': 25, 'price': 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision_a = runtime.evaluate(strategy, feature_contract, timeframe='1Min')
        decision_b = runtime.evaluate(strategy, feature_contract, timeframe='1Min')

        self.assertIsNotNone(decision_a)
        self.assertIsNotNone(decision_b)
        assert decision_a is not None
        assert decision_b is not None
        self.assertEqual(decision_a.intent.action, 'buy')
        self.assertEqual(decision_a.parameter_hash, decision_b.parameter_hash)
        self.assertEqual(decision_a.feature_hash, decision_b.feature_hash)

    def test_runtime_missing_required_features_fails_closed(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name='invalid',
            description='version=1.0.0',
            enabled=True,
            base_timeframe='1Min',
            universe_type='legacy_macd_rsi',
            universe_symbols=['AAPL'],
            max_position_pct_equity=Decimal('0.02'),
            max_notional_per_trade=Decimal('2500'),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={'price': 101.5},
        )
        runtime = StrategyRuntime()
        with self.assertRaises(FeatureNormalizationError):
            feature_vector = normalize_feature_vector_v3(signal)
            runtime.evaluate(strategy, feature_vector, timeframe='1Min')

    def test_intraday_tsmom_plugin_emits_buy_on_trend(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name='intraday-tsmom',
            description='version=1.0.0',
            enabled=True,
            base_timeframe='1Min',
            universe_type='intraday_tsmom_v1',
            universe_symbols=['NVDA'],
            max_position_pct_equity=Decimal('0.02'),
            max_notional_per_trade=Decimal('2500'),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol='NVDA',
            timeframe='1Min',
            seq=7,
            payload={
                'price': 140.25,
                'ema12': 140.40,
                'ema26': 139.95,
                'macd': 0.45,
                'macd_signal': 0.30,
                'rsi14': 56,
                'vol_realized_w60s': 0.009,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe='1Min')
        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, 'buy')
        self.assertIn('tsmom_trend_up', decision.intent.rationale)
        self.assertIn('momentum_confirmed', decision.intent.rationale)
        self.assertEqual(decision.plugin_id, 'intraday_tsmom')

    def test_intraday_tsmom_plugin_emits_sell_on_downtrend(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name='intraday-tsmom',
            description='version=1.0.0',
            enabled=True,
            base_timeframe='1Min',
            universe_type='intraday_tsmom_v1',
            universe_symbols=['NVDA'],
            max_position_pct_equity=Decimal('0.02'),
            max_notional_per_trade=Decimal('2500'),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol='NVDA',
            timeframe='1Min',
            seq=9,
            payload={
                'price': 140.05,
                'ema12': 139.90,
                'ema26': 140.35,
                'macd': -0.40,
                'macd_signal': -0.25,
                'rsi14': 72,
                'vol_realized_w60s': 0.011,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe='1Min')
        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, 'sell')
        self.assertIn('tsmom_trend_down', decision.intent.rationale)
        self.assertIn('momentum_reversal_exit', decision.intent.rationale)
