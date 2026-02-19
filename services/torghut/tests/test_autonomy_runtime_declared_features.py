from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.autonomy.runtime import (
    StrategyContext,
    StrategyIntent,
    StrategyPluginRegistry,
    StrategyRuntime,
    StrategyRuntimeConfig,
)
from app.trading.models import SignalEnvelope


class _InvalidDeclaredFeaturePlugin:
    strategy_type = 'invalid_declared_feature'
    version = '1.0.0'

    def validate_params(self, params: dict[str, object]) -> None:
        _ = params

    def required_features(self) -> set[str]:
        return {'price', 'this_is_not_in_featurevector_v3'}

    def warmup_bars(self) -> int:
        return 0

    def on_event(self, fv, ctx: StrategyContext):
        _ = fv
        _ = ctx
        return StrategyIntent(
            strategy_id='invalid-strategy',
            symbol='AAPL',
            direction='long',
            confidence=Decimal('0.50'),
            target_qty=Decimal('1'),
            horizon='intraday',
            rationale=['should_not_emit'],
        )


class TestAutonomyRuntimeDeclaredFeatures(TestCase):
    def test_runtime_fails_closed_when_plugin_declares_unknown_feature(self) -> None:
        registry = StrategyPluginRegistry()
        registry.register(_InvalidDeclaredFeaturePlugin())
        runtime = StrategyRuntime(registry=registry)

        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            seq=1,
            source='fixture',
            payload={
                'feature_schema_version': '3.0.0',
                'macd': {'macd': '1', 'signal': '0.5'},
                'rsi14': '45',
                'price': '101',
            },
        )

        result = runtime.evaluate(
            signal,
            [
                StrategyRuntimeConfig(
                    strategy_id='invalid-strategy',
                    strategy_type='invalid_declared_feature',
                    version='1.0.0',
                    params={},
                    base_timeframe='1Min',
                )
            ],
        )

        self.assertEqual(result.decisions, [])
        self.assertIn('declared_features_not_in_schema:invalid-strategy:this_is_not_in_featurevector_v3', result.errors)
