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

    def test_intraday_tsmom_v1_plugin_emits_buy(self) -> None:
        runtime = StrategyRuntime(default_runtime_registry())
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '0.12', 'signal': '0.03'},
                'rsi14': '56',
                'price': '101.5',
                'ema12': '101.0',
                'ema26': '100.5',
                'vol_realized_w60s': '0.008',
            },
        )

        result = runtime.evaluate(
            signal,
            [
                StrategyRuntimeConfig(
                    strategy_id='tsmom',
                    strategy_type='intraday_tsmom_v1',
                    version='1.1.0',
                    params={},
                )
            ],
        )
        self.assertEqual(len(result.decisions), 1)
        self.assertEqual(result.decisions[0].action, 'buy')

    def test_intraday_tsmom_v1_plugin_emits_sell(self) -> None:
        runtime = StrategyRuntime(default_runtime_registry())
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '-0.22', 'signal': '-0.10'},
                'rsi14': '72',
                'price': '100.0',
                'ema12': '100.3',
                'ema26': '100.8',
                'vol_realized_w60s': '0.006',
            },
        )

        result = runtime.evaluate(
            signal,
            [
                StrategyRuntimeConfig(
                    strategy_id='tsmom',
                    strategy_type='intraday_tsmom_v1',
                    version='1.1.0',
                    params={},
                )
            ],
        )
        self.assertEqual(len(result.decisions), 1)
        self.assertEqual(result.decisions[0].action, 'sell')
