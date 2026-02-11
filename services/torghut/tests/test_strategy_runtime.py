from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.models import Strategy
from app.trading.features import normalize_feature_vector_v3
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
        self.assertEqual(
            decision_a.feature_contract.parity_hash,
            decision_b.feature_contract.parity_hash,
        )

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
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe='1Min')

        self.assertIsNone(decision)
        self.assertFalse(feature_contract.valid)
        self.assertIn('missing_required_features', feature_contract.reasons)

