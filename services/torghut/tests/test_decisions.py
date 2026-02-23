from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.models import SignalEnvelope
from app.trading.prices import MarketSnapshot, PriceFetcher
from app.trading.strategy_runtime import (
    StrategyContext,
    StrategyIntent,
    StrategyRegistry,
    StrategyRuntime,
)


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


class TestDecisionEngine(TestCase):
    def test_missing_timeframe_skips_strategy(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
            },
            timeframe=None,
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertEqual(decisions, [])

    def test_timeframe_inferred_from_payload_window(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe=None,
            payload={
                "window_size": "1m",
                "macd": {"macd": Decimal("2.0"), "signal": Decimal("0.5")},
                "rsi14": Decimal("20"),
            },
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].timeframe, "1Min")

    def test_price_snapshot_attached_when_fetched(self) -> None:
        class DummyFetcher(PriceFetcher):
            def fetch_price(self, signal: SignalEnvelope):  # type: ignore[override]
                return None

            def fetch_market_snapshot(self, signal: SignalEnvelope):  # type: ignore[override]
                return MarketSnapshot(
                    symbol=signal.symbol,
                    as_of=signal.event_ts,
                    price=Decimal("101.5"),
                    spread=Decimal("0.02"),
                    source="ta_microbars",
                )

        engine = DecisionEngine(price_fetcher=DummyFetcher())
        strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
            },
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.params.get("price"), Decimal("101.5"))
        snapshot = decision.params.get("price_snapshot")
        assert isinstance(snapshot, dict)
        self.assertEqual(snapshot.get("source"), "ta_microbars")
        self.assertEqual(snapshot.get("price"), "101.5")
        self.assertEqual(snapshot.get("spread"), "0.02")

    def test_scheduler_runtime_mode_emits_aggregated_metadata(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name="runtime",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_strategy_runtime_fallback_legacy", True),
        ):
            decisions = engine.evaluate(signal, [strategy])
            telemetry = engine.consume_runtime_telemetry()

        self.assertEqual(len(decisions), 1)
        self.assertTrue(telemetry.runtime_enabled)
        self.assertFalse(telemetry.fallback_to_legacy)
        runtime_meta = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_meta, dict)
        self.assertTrue(runtime_meta.get("aggregated"))
        self.assertEqual(runtime_meta.get("mode"), "scheduler_v3")

    def test_scheduler_runtime_uses_contributing_strategies_for_source_and_sizing(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                    "sell_plugin": _SellPlugin(),
                }
            )
        )
        buy_strategy = Strategy(
            id=uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="buy_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("100"),
        )
        sell_strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            name="sell",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="sell_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("900"),
        )
        off_timeframe_strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
            name="off-timeframe",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="5Min",
            universe_type="buy_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_strategy_runtime_fallback_legacy", False),
        ):
            decisions = engine.evaluate(
                signal, [buy_strategy, sell_strategy, off_timeframe_strategy]
            )

        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.strategy_id, str(buy_strategy.id))
        self.assertEqual(decision.qty, Decimal("1"))
        runtime_meta = decision.params.get("strategy_runtime")
        assert isinstance(runtime_meta, dict)
        self.assertEqual(
            runtime_meta.get("source_strategy_ids"),
            [str(buy_strategy.id)],
        )

    def test_scheduler_runtime_falls_back_to_legacy_when_plugin_missing(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="fallback",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="unknown_custom",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_strategy_runtime_fallback_legacy", True),
        ):
            decisions = engine.evaluate(signal, [strategy])
            telemetry = engine.consume_runtime_telemetry()

        self.assertEqual(len(decisions), 1)
        self.assertTrue(telemetry.fallback_to_legacy)
        self.assertEqual(len(telemetry.errors), 1)
        self.assertEqual(telemetry.errors[0].reason, "plugin_not_found")
        self.assertIsNotNone(telemetry.observation)
        if telemetry.observation is not None:
            self.assertEqual(
                telemetry.observation.strategy_errors_total.get(str(strategy.id)),
                1,
            )
        runtime_meta = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_meta, dict)
        self.assertEqual(runtime_meta.get("plugin_id"), "legacy_builtin")

    def test_scheduler_runtime_attaches_forecast_contract_and_telemetry(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name='runtime-forecast',
            description='version=1.0.0',
            enabled=True,
            base_timeframe='1Min',
            universe_type='legacy_macd_rsi',
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal('500'),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': 100,
            },
            timeframe='1Min',
        )
        with (
            patch.object(settings, 'trading_strategy_runtime_mode', 'scheduler_v3'),
            patch.object(settings, 'trading_strategy_scheduler_enabled', True),
            patch.object(settings, 'trading_strategy_runtime_fallback_legacy', False),
            patch.object(settings, 'trading_forecast_router_enabled', True),
            patch.object(settings, 'trading_forecast_router_policy_path', None),
            patch.object(settings, 'trading_forecast_router_refinement_enabled', True),
        ):
            engine = DecisionEngine(price_fetcher=None)
            decisions = engine.evaluate(signal, [strategy])
            forecast_telemetry = engine.consume_forecast_telemetry()

        self.assertEqual(len(decisions), 1)
        forecast_payload = decisions[0].params.get('forecast')
        forecast_audit = decisions[0].params.get('forecast_audit')
        assert isinstance(forecast_payload, dict)
        assert isinstance(forecast_audit, dict)
        self.assertEqual(forecast_payload.get('schema_version'), 'forecast_contract_v1')
        self.assertIn('interval', forecast_payload)
        self.assertIn('uncertainty', forecast_payload)
        self.assertEqual(len(forecast_telemetry), 1)
        self.assertEqual(forecast_telemetry[0].symbol, 'AAPL')

    def test_decision_params_include_microstructure_advice_and_fragility_payloads(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='wiring',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol='aapl',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'spread': Decimal('0.02'),
                'depth_top5_usd': Decimal('1200000'),
                'order_flow_imbalance': Decimal('0.15'),
                'latency_ms_estimate': 22,
                'fill_hazard': Decimal('0.65'),
                'liquidity_regime': 'compressed',
                'execution_advice': {
                    'urgency_tier': 'normal',
                    'max_participation_rate': '0.05',
                    'preferred_order_type': 'limit',
                    'adverse_selection_risk': '0.22',
                    'expected_shortfall_bps_p50': '1.5',
                    'expected_shortfall_bps_p95': '4.8',
                    'simulator_version': 'sim-v5',
                },
                'spread_acceleration': Decimal('0.30'),
                'liquidity_compression': Decimal('0.35'),
                'crowding_proxy': Decimal('0.40'),
                'correlation_concentration': Decimal('0.45'),
                'fragility_state': 'elevated',
            },
            timeframe='1Min',
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        micro = params.get('microstructure_state')
        assert isinstance(micro, dict)
        self.assertEqual(micro.get('schema_version'), 'microstructure_state_v1')
        self.assertEqual(micro.get('symbol'), 'AAPL')
        self.assertEqual(micro.get('liquidity_regime'), 'compressed')

        advice = params.get('execution_advice')
        assert isinstance(advice, dict)
        self.assertEqual(advice.get('urgency_tier'), 'normal')
        self.assertEqual(advice.get('preferred_order_type'), 'limit')
        self.assertEqual(advice.get('expected_shortfall_bps_p50'), '1.5')

        fragility = params.get('fragility_snapshot')
        assert isinstance(fragility, dict)
        self.assertEqual(fragility.get('schema_version'), 'fragility_snapshot_v1')
        self.assertEqual(fragility.get('symbol'), 'AAPL')
        self.assertEqual(fragility.get('fragility_state'), 'elevated')
        self.assertEqual(fragility.get('spread_acceleration'), Decimal('0.30'))
