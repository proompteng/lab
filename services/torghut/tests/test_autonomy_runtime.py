from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from app.trading.autonomy.runtime import StrategyRuntime, StrategyRuntimeConfig, default_runtime_registry
from app.trading.models import SignalEnvelope


class TestAutonomyRuntime(TestCase):
    def test_runtime_deterministic_ordering(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '1.5', 'signal': '0.5'},
                'rsi14': '20',
                'price': '101',
            },
        )
        runtime = StrategyRuntime(default_runtime_registry())
        strategies = [
            StrategyRuntimeConfig(
                strategy_id='b-strategy',
                strategy_type='legacy_macd_rsi',
                version='1.0.0',
                params={'qty': 1},
                priority=200,
            ),
            StrategyRuntimeConfig(
                strategy_id='a-strategy',
                strategy_type='legacy_macd_rsi',
                version='1.0.0',
                params={'qty': 1},
                priority=100,
            ),
        ]

        first = runtime.evaluate(signal, strategies)
        second = runtime.evaluate(signal, strategies)

        self.assertEqual([d.strategy_id for d in first.decisions], ['a-strategy', 'b-strategy'])
        self.assertEqual(
            [decision.model_dump(mode='json') for decision in first.decisions],
            [decision.model_dump(mode='json') for decision in second.decisions],
        )

    def test_runtime_isolates_plugin_errors(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '1.5', 'signal': '0.5'},
                'rsi14': '20',
                'price': '101',
            },
        )
        runtime = StrategyRuntime(default_runtime_registry())
        strategies = [
            StrategyRuntimeConfig(
                strategy_id='good',
                strategy_type='legacy_macd_rsi',
                version='1.0.0',
                params={'qty': 1},
            ),
            StrategyRuntimeConfig(
                strategy_id='bad',
                strategy_type='missing_plugin',
                version='9.9.9',
                params={},
            ),
        ]

        result = runtime.evaluate(signal, strategies)

        self.assertEqual(len(result.decisions), 1)
        self.assertTrue(any(error.startswith('plugin_not_found:missing_plugin@9.9.9') for error in result.errors))
