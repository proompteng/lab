from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.models import Strategy
from app.strategies.catalog import StrategyConfig, _compose_strategy_description
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

    def test_legacy_buy_supports_fractional_equity_qty_when_enabled(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="fractional-buy",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("50"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(signal, [strategy])

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("0.5000"))
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

    def test_legacy_sell_without_inventory_defaults_to_integer_qty(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="integer-sell",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("150"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                    "rsi14": Decimal("80"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(signal, [strategy], positions=None)

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("1"))
            sizing = decisions[0].params.get("sizing")
            assert isinstance(sizing, dict)
            quantity_resolution = sizing.get("quantity_resolution")
            assert isinstance(quantity_resolution, dict)
            self.assertFalse(quantity_resolution.get("fractional_allowed"))
            self.assertEqual(
                quantity_resolution.get("reason"),
                "sell_inventory_unknown_integer_only",
            )
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

    def test_legacy_sell_without_inventory_below_one_share_is_skipped(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="small-short-sell",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("50"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                    "rsi14": Decimal("80"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(signal, [strategy], positions=None)

            self.assertEqual(decisions, [])
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

    def test_legacy_buy_at_symbol_cap_is_skipped(self) -> None:
        original_max_pct = settings.trading_max_position_pct_equity
        settings.trading_max_position_pct_equity = 0.08
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="capped-buy",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=Decimal("0.08"),
                max_notional_per_trade=Decimal("100"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "8", "market_value": "800"}],
            )

            self.assertEqual(decisions, [])
        finally:
            settings.trading_max_position_pct_equity = original_max_pct

    def test_legacy_sell_reducing_long_can_remain_fractional(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="fractional-reduce-sell",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("50"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                    "rsi14": Decimal("80"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[{"symbol": "AAPL", "qty": "1", "side": "long"}],
            )

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("0.5000"))
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

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
        self.assertEqual(
            runtime_meta.get("primary_strategy_row_id"),
            str(buy_strategy.id),
        )
        self.assertEqual(
            runtime_meta.get("primary_declared_strategy_id"),
            "buy",
        )
        self.assertEqual(runtime_meta.get("compiler_sources"), ["legacy_runtime"])
        source_runtime = runtime_meta.get("source_strategy_runtime")
        assert isinstance(source_runtime, list)
        self.assertEqual(len(source_runtime), 1)
        self.assertEqual(source_runtime[0].get("strategy_row_id"), str(buy_strategy.id))
        self.assertEqual(
            source_runtime[0].get("declared_strategy_id"),
            "buy",
        )
        self.assertEqual(source_runtime[0].get("compiler_source"), "legacy_runtime")
        self.assertEqual(source_runtime[0].get("intent_target_notional"), "100")

    def test_scheduler_runtime_uses_runtime_target_notional_for_qty_resolution(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                }
            )
        )
        strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000010"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
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
                "price": 50,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].qty, Decimal("2"))
        self.assertEqual(decisions[0].params["sizing"]["method"], "runtime_target_notional")

    def test_scheduler_runtime_skips_non_executable_fractional_short_entry(self) -> None:
        class SmallShortPlugin:
            plugin_id = "small_short_plugin"
            version = "1.0.0"
            required_features = ("price",)

            def evaluate(self, context: StrategyContext, features) -> StrategyIntent:  # type: ignore[no-untyped-def]
                return StrategyIntent(
                    strategy_id=context.strategy_id,
                    symbol=context.symbol,
                    direction="sell",
                    confidence=Decimal("0.40"),
                    target_notional=Decimal("50"),
                    horizon=context.timeframe,
                    explain=("sell_signal",),
                    feature_snapshot_hash=features.normalization_hash,
                    required_features=self.required_features,
                )

        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "small_short_plugin": SmallShortPlugin(),
                }
            )
        )
        strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000003"),
            name="sell",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="small_short_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("50"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                "rsi14": Decimal("80"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
            patch.object(settings, "trading_allow_shorts", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=None)

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_skips_buy_when_symbol_cap_is_exhausted(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                }
            )
        )
        strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000004"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="buy_plugin",
            universe_symbols=None,
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("100"),
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
            patch.object(settings, "trading_max_position_pct_equity", 0.08),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "8", "market_value": "800"}],
            )

        self.assertEqual(decisions, [])

    def test_legacy_buy_clips_to_residual_symbol_capacity(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_max_pct = settings.trading_max_position_pct_equity
        settings.trading_fractional_equities_enabled = True
        settings.trading_max_position_pct_equity = 0.08
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="residual-cap-buy",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=Decimal("0.08"),
                max_notional_per_trade=Decimal("500"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "6.5", "market_value": "650"}],
            )

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("1.5000"))
            sizing = decisions[0].params.get("sizing")
            assert isinstance(sizing, dict)
            self.assertEqual(Decimal(str(sizing.get("requested_qty"))), Decimal("1.5"))
            self.assertTrue(sizing.get("symbol_capacity_limited"))
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_max_position_pct_equity = original_max_pct

    def test_legacy_buy_skips_when_residual_symbol_capacity_is_below_min_qty(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_max_pct = settings.trading_max_position_pct_equity
        settings.trading_fractional_equities_enabled = False
        settings.trading_max_position_pct_equity = 0.08
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="residual-cap-min-qty",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=Decimal("0.08"),
                max_notional_per_trade=Decimal("500"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "7.95", "market_value": "795"}],
            )

            self.assertEqual(decisions, [])
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_max_position_pct_equity = original_max_pct

    def test_scheduler_runtime_intraday_tsmom_skips_same_direction_reentry(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.1.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
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

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[{"symbol": "NVDA", "qty": "3", "side": "long", "market_value": "420.75"}],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_position_isolation_skips_unowned_sell_intent(self) -> None:
        buy_strategy_id = uuid.uuid4()
        sell_strategy_id = uuid.uuid4()
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
            id=buy_strategy_id,
            name="isolated-buy",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-buy",
                    strategy_id="isolated-buy",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"position_isolation_mode": "per_strategy"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        sell_strategy = Strategy(
            id=sell_strategy_id,
            name="isolated-sell",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-sell",
                    strategy_id="isolated-sell",
                    strategy_type="sell_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"position_isolation_mode": "per_strategy"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 101,
                "macd": Decimal("0.12"),
                "macd_signal": Decimal("0.08"),
                "rsi14": Decimal("52"),
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [buy_strategy, sell_strategy], positions=[])

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        runtime_payload = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_payload, dict)
        self.assertEqual(runtime_payload.get("position_isolation_mode"), "per_strategy")

    def test_scheduler_runtime_defaults_research_sleeves_to_position_isolation(self) -> None:
        strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(plugins={"buy_plugin": _BuyPlugin()})
        )
        strategy = Strategy(
            id=strategy_id,
            name="isolated-default",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-default",
                    strategy_id="isolated-default",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="mean_reversion_rebound_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_rebound_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 101,
                "macd": Decimal("0.12"),
                "macd_signal": Decimal("0.08"),
                "rsi14": Decimal("52"),
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(len(decisions), 1)
        runtime_payload = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_payload, dict)
        self.assertEqual(runtime_payload.get("position_isolation_mode"), "per_strategy")

    def test_scheduler_runtime_position_isolation_allows_owned_sell_intent(self) -> None:
        buy_strategy_id = uuid.uuid4()
        sell_strategy_id = uuid.uuid4()
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
            id=buy_strategy_id,
            name="isolated-buy",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-buy",
                    strategy_id="isolated-buy",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"position_isolation_mode": "per_strategy"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        sell_strategy = Strategy(
            id=sell_strategy_id,
            name="isolated-sell",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-sell",
                    strategy_id="isolated-sell",
                    strategy_type="sell_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"position_isolation_mode": "per_strategy"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 101,
                "macd": Decimal("0.12"),
                "macd_signal": Decimal("0.08"),
                "rsi14": Decimal("52"),
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [buy_strategy, sell_strategy],
                positions=[
                    {
                        "symbol": "AAPL",
                        "strategy_id": str(sell_strategy_id),
                        "qty": "5",
                        "side": "long",
                        "market_value": "500",
                        "avg_entry_price": "100",
                        "opened_at": "2026-03-27T17:20:00+00:00",
                    }
                ],
            )

        self.assertEqual({decision.action for decision in decisions}, {"buy", "sell"})

    def test_scheduler_runtime_intraday_tsmom_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.1.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=8,
            payload={
                "price": 140.25,
                "ema12": 139.90,
                "ema26": 140.40,
                "macd": -0.205,
                "macd_signal": -0.18,
                "rsi14": 38,
                "vol_realized_w60s": 0.009,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_intraday_tsmom_caps_exit_only_sell_to_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.1.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=9,
            payload={
                "price": 140.25,
                "ema12": 139.90,
                "ema26": 140.40,
                "macd": -0.205,
                "macd_signal": -0.18,
                "rsi14": 38,
                "vol_realized_w60s": 0.009,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "NVDA",
                        "qty": "3",
                        "side": "long",
                        "market_value": "420.75",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("3"))

    def test_scheduler_runtime_intraday_tsmom_exit_only_sell_ignores_entry_notional_budget(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.1.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=10,
            payload={
                "price": 528.29,
                "ema12": 527.90,
                "ema26": 528.40,
                "macd": -0.205,
                "macd_signal": -0.18,
                "rsi14": 38,
                "vol_realized_w60s": 0.009,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_execution_prefer_limit", False),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1008.144239",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("1.9091"))

    def test_scheduler_runtime_intraday_tsmom_skips_signal_exit_at_entry_price(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-profit-protect",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-profit-protect",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"require_positive_price_for_signal_exit": "true"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 17, 14, 29, 1, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": 629.575,
                "ema12": 629.10,
                "ema26": 629.30,
                "macd": -0.022,
                "macd_signal": -0.010,
                "rsi14": 41,
                "vol_realized_w60s": 0.00016,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_execution_prefer_limit", False),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.5884",
                        "side": "long",
                        "market_value": "1000",
                        "avg_entry_price": "629.575",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_intraday_tsmom_allows_signal_exit_above_entry_price(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-profit-protect",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-profit-protect",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"require_positive_price_for_signal_exit": "true"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 529.10,
                "ema12": 528.80,
                "ema26": 529.00,
                "macd": -0.012,
                "macd_signal": -0.004,
                "rsi14": 42,
                "vol_realized_w60s": 0.00018,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1010.47281",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("1.9091"))

    def test_scheduler_runtime_intraday_tsmom_skips_signal_exit_when_executable_limit_below_entry_price(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-profit-protect",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-profit-protect",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"require_positive_price_for_signal_exit": "true"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 529.10,
                "spread": 2.00,
                "ema12": 528.80,
                "ema26": 529.00,
                "macd": -0.012,
                "macd_signal": -0.004,
                "rsi14": 42,
                "vol_realized_w60s": 0.00018,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_execution_prefer_limit", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1010.47281",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_breakout_continuation_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 31, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 522.85,
                "ema12": 523.20,
                "ema26": 523.05,
                "macd": -0.004,
                "macd_signal": 0.005,
                "rsi14": 55,
                "vol_realized_w60s": 0.00020,
                "vwap_session": 523.05,
                "spread": 0.04,
                "imbalance_bid_sz": 4100,
                "imbalance_ask_sz": 4900,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_late_day_continuation_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 19, 8, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 253.54,
                "ema12": 253.72,
                "ema26": 253.61,
                "macd": 0.010,
                "macd_signal": 0.016,
                "rsi14": 53,
                "vol_realized_w60s": 0.00018,
                "vwap_session": 253.68,
                "spread": 0.03,
                "imbalance_bid_sz": 4500,
                "imbalance_ask_sz": 4700,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_end_of_day_reversal_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="end-of-day-reversal",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="end_of_day_reversal_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 40, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 253.44,
                "ema12": 253.30,
                "ema26": 253.12,
                "macd": 0.003,
                "macd_signal": 0.001,
                "rsi14": 57,
                "vol_realized_w60s": 0.00017,
                "vwap_session": 253.10,
                "spread": 0.03,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4500,
                "price_vs_session_open_bps": 8,
                "price_position_in_session_range": 0.68,
                "price_vs_opening_range_low_bps": 24,
                "session_range_bps": 74,
                "recent_spread_bps_avg": 0.72,
                "recent_spread_bps_max": 1.30,
                "recent_imbalance_pressure_avg": 0.06,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_breakout_continuation_skips_exit_only_sell_for_pending_entry_only(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 31, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 522.85,
                "ema12": 523.20,
                "ema26": 523.05,
                "macd": -0.004,
                "macd_signal": 0.005,
                "rsi14": 55,
                "vol_realized_w60s": 0.00020,
                "vwap_session": 523.05,
                "spread": 0.04,
                "imbalance_bid_sz": 4100,
                "imbalance_ask_sz": 4900,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy.id),
                        "qty": "26.4",
                        "side": "long",
                        "market_value": "13803.24",
                        "avg_entry_price": "522.85",
                        "pending_entry": True,
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_research_sleeve_buy_respects_entry_cooldown(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"entry_cooldown_seconds":"300","bullish_hist_min":"0.001","min_bull_rsi":"50","max_bull_rsi":"80","max_spread_bps":"100","min_session_open_drive_bps":"0","min_opening_window_return_bps":"0","min_session_high_above_opening_range_high_bps":"0","min_price_vs_opening_range_high_bps":"-100","max_price_vs_opening_range_high_bps":"100","min_price_vs_opening_window_close_bps":"-100","max_price_vs_opening_window_close_bps":"100","min_opening_range_width_bps":"0","min_session_range_bps":"0","min_session_range_position":"0","min_price_vs_vwap_w5m_bps":"-100","max_price_vs_vwap_w5m_bps":"100","max_recent_spread_bps":"100","max_recent_spread_bps_max":"200","max_recent_quote_jump_bps":"200","min_recent_imbalance_pressure":"-1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 523.25,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.031,
                "macd_signal": 0.012,
                "rsi14": 62,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 46,
                "price_vs_prev_session_close_bps": 46,
                "opening_window_return_from_prev_close_bps": 28,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "recent_quote_invalid_ratio": 0.02,
                "recent_quote_jump_bps_max": 8,
                "recent_microprice_bias_bps_avg": 0.65,
                "cross_section_opening_window_return_from_prev_close_rank": 0.82,
                "cross_section_continuation_rank": 0.84,
                "cross_section_continuation_breadth": 0.61,
            },
        )
        seed_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 14, 0, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=0,
            payload={
                "price": 521.40,
                "ema12": 521.30,
                "ema26": 521.10,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 58,
                "vol_realized_w60s": 0.00015,
                "spread": 0.03,
                "vwap_w5m": 521.28,
                "imbalance_bid_sz": 5000,
                "imbalance_ask_sz": 4600,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            engine.evaluate(seed_signal, [strategy], positions=[])
            first = engine.evaluate(signal, [strategy], positions=[])
            second = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_scheduler_runtime_research_sleeve_buy_respects_max_entries_per_session(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"max_entries_per_session":"1","bullish_hist_min":"0.001","min_bull_rsi":"50","max_bull_rsi":"80","max_spread_bps":"100","min_session_open_drive_bps":"0","min_opening_window_return_bps":"0","min_session_high_above_opening_range_high_bps":"0","min_price_vs_opening_range_high_bps":"-100","max_price_vs_opening_range_high_bps":"100","min_price_vs_opening_window_close_bps":"-100","max_price_vs_opening_window_close_bps":"100","min_opening_range_width_bps":"0","min_session_range_bps":"0","min_session_range_position":"0","min_price_vs_vwap_w5m_bps":"-100","max_price_vs_vwap_w5m_bps":"100","max_recent_spread_bps":"100","max_recent_spread_bps_max":"200","max_recent_quote_jump_bps":"200","min_recent_imbalance_pressure":"-1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        seed_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 14, 0, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=0,
            payload={
                "price": 521.40,
                "ema12": 521.30,
                "ema26": 521.10,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 58,
                "vol_realized_w60s": 0.00015,
                "spread": 0.03,
                "vwap_w5m": 521.28,
                "imbalance_bid_sz": 5000,
                "imbalance_ask_sz": 4600,
            },
        )
        first_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 523.25,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.031,
                "macd_signal": 0.012,
                "rsi14": 62,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 46,
                "price_vs_prev_session_close_bps": 46,
                "opening_window_return_from_prev_close_bps": 28,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "recent_quote_invalid_ratio": 0.02,
                "recent_quote_jump_bps_max": 8,
                "recent_microprice_bias_bps_avg": 0.65,
                "cross_section_opening_window_return_from_prev_close_rank": 0.82,
                "cross_section_continuation_rank": 0.84,
                "cross_section_continuation_breadth": 0.61,
            },
        )
        second_signal = first_signal.model_copy(
            update={
                "event_ts": datetime(2026, 3, 27, 18, 0, 3, tzinfo=timezone.utc),
                "seq": 2,
            }
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            engine.evaluate(seed_signal, [strategy], positions=[])
            first = engine.evaluate(first_signal, [strategy], positions=[])
            second = engine.evaluate(second_signal, [strategy], positions=[])

        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_scheduler_runtime_isolated_buy_cooldown_is_scoped_per_strategy(self) -> None:
        first_strategy_id = uuid.uuid4()
        second_strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                }
            )
        )
        first_strategy = Strategy(
            id=first_strategy_id,
            name="isolated-buy-one",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-buy-one",
                    strategy_id="isolated-buy-one",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "position_isolation_mode": "per_strategy",
                        "entry_cooldown_seconds": "300",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        second_strategy = Strategy(
            id=second_strategy_id,
            name="isolated-buy-two",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-buy-two",
                    strategy_id="isolated-buy-two",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "position_isolation_mode": "per_strategy",
                        "entry_cooldown_seconds": "300",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 101,
                "macd": Decimal("0.12"),
                "macd_signal": Decimal("0.08"),
                "rsi14": Decimal("52"),
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [first_strategy, second_strategy],
                positions=[],
            )

        self.assertEqual(len(decisions), 2)
        self.assertCountEqual(
            [decision.strategy_id for decision in decisions],
            [str(first_strategy_id), str(second_strategy_id)],
        )

    def test_scheduler_runtime_research_sleeve_buy_respects_stop_loss_lockout(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "bullish_hist_min": "0.001",
                        "min_bull_rsi": "50",
                        "max_bull_rsi": "80",
                        "max_spread_bps": "100",
                        "min_session_open_drive_bps": "0",
                        "min_session_high_above_opening_range_high_bps": "0",
                        "min_price_vs_opening_range_high_bps": "-100",
                        "max_price_vs_opening_range_high_bps": "100",
                        "min_opening_range_width_bps": "0",
                        "min_session_range_bps": "0",
                        "min_session_range_position": "0",
                        "min_price_vs_vwap_w5m_bps": "-100",
                        "max_price_vs_vwap_w5m_bps": "100",
                        "max_recent_spread_bps": "100",
                        "max_recent_spread_bps_max": "200",
                        "min_recent_imbalance_pressure": "-1",
                        "long_stop_loss_bps": "25",
                        "stop_loss_lockout_seconds": "1800",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        stop_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 520.00,
                "ema12": 521.00,
                "ema26": 520.80,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 55,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
            },
        )
        buy_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 10, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": 523.25,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.031,
                "macd_signal": 0.012,
                "rsi14": 62,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 46,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            stop_decisions = engine.evaluate(
                stop_signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy.id),
                        "qty": "10",
                        "side": "long",
                        "market_value": "5200",
                        "avg_entry_price": "523.00",
                    }
                ],
            )
            locked_out = engine.evaluate(buy_signal, [strategy], positions=[])

        self.assertEqual(len(stop_decisions), 1)
        self.assertEqual(stop_decisions[0].rationale, "position_stop_loss_exit")
        self.assertEqual(locked_out, [])

    def test_scheduler_runtime_observed_wide_spread_blocks_later_breakout_entry(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"bullish_hist_min":"0.001","min_bull_rsi":"50","max_bull_rsi":"80","max_spread_bps":"100","min_session_open_drive_bps":"0","min_session_high_above_opening_range_high_bps":"0","min_price_vs_opening_range_high_bps":"-100","max_price_vs_opening_range_high_bps":"100","min_opening_range_width_bps":"0","min_session_range_bps":"0","min_session_range_position":"0","min_price_vs_vwap_w5m_bps":"-100","max_price_vs_vwap_w5m_bps":"100","max_recent_spread_bps":"100","max_recent_spread_bps_max":"20","min_recent_imbalance_pressure":"-1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        unstable_quote = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 29, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "imbalance_bid_px": 254.97,
                "imbalance_ask_px": 256.60,
                "price": 255.785,
                "ema12": 254.99,
                "ema26": 254.97,
                "macd": 0.018,
                "macd_signal": 0.025,
                "rsi14": 52.7,
                "vol_realized_w60s": 0.00028,
                "vwap_w5m": 254.72,
                "imbalance_bid_sz": 100,
                "imbalance_ask_sz": 100,
            },
        )
        candidate_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=2,
            payload={
                "imbalance_bid_px": 255.37,
                "imbalance_ask_px": 255.40,
                "price": 255.385,
                "ema12": 255.239,
                "ema26": 255.140,
                "macd": 0.099,
                "macd_signal": 0.064,
                "rsi14": 73.0,
                "vol_realized_w60s": 0.000196,
                "vwap_w5m": 254.832,
                "imbalance_bid_sz": 200,
                "imbalance_ask_sz": 200,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            engine.observe_signal(unstable_quote)
            decisions = engine.evaluate(candidate_signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_research_sleeve_sell_respects_min_hold(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"min_hold_seconds":"120"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 31, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 522.85,
                "ema12": 523.20,
                "ema26": 523.05,
                "macd": -0.004,
                "macd_signal": 0.005,
                "rsi14": 55,
                "vol_realized_w60s": 0.00020,
                "spread": 0.04,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "10",
                        "side": "long",
                        "market_value": "5228.5",
                        "opened_at": "2026-03-27T17:30:40+00:00",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_research_sleeve_buy_respects_max_concurrent_positions(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"max_concurrent_positions":"1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META", "NVDA"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 523.25,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.031,
                "macd_signal": 0.012,
                "rsi14": 62,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "NVDA",
                        "qty": "75.0000",
                        "side": "long",
                        "market_value": "13650.00",
                        "opened_at": "2026-03-27T17:20:00+00:00",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_intraday_tsmom_caps_buy_to_portfolio_gross_limit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-levered",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-levered",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("3.0"),
                    max_notional_per_trade=Decimal("30000"),
                    params={
                        "bullish_hist_min": "0.01",
                        "min_bull_rsi": "55",
                        "max_bull_rsi": "60",
                        "vol_ceil": "0.01",
                        "max_price_above_ema12_bps": "0",
                        "min_price_below_ema12_bps": "0",
                        "max_price_below_ema12_bps": "20",
                        "max_gross_exposure_pct_equity": "1.5",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("3.0"),
            max_notional_per_trade=Decimal("30000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 100.0,
                "ema12": 100.05,
                "ema26": 99.95,
                "macd": 0.05,
                "macd_signal": 0.01,
                "rsi14": 56,
                "vol_realized_w60s": 0.0002,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[
                    {
                        "symbol": "AAPL",
                        "qty": "100",
                        "side": "long",
                        "market_value": "10000",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(decisions[0].qty, Decimal("50"))
        sizing = decisions[0].params["sizing"]
        self.assertEqual(sizing["portfolio_gross_cap"], "15000.0")
        self.assertTrue(sizing["portfolio_gross_limited"])

    def test_scheduler_runtime_intraday_tsmom_skips_buy_when_portfolio_gross_is_exhausted(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-levered",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-levered",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("3.0"),
                    max_notional_per_trade=Decimal("30000"),
                    params={
                        "bullish_hist_min": "0.01",
                        "min_bull_rsi": "55",
                        "max_bull_rsi": "60",
                        "vol_ceil": "0.01",
                        "max_price_above_ema12_bps": "0",
                        "min_price_below_ema12_bps": "0",
                        "max_price_below_ema12_bps": "20",
                        "max_gross_exposure_pct_equity": "1.5",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("3.0"),
            max_notional_per_trade=Decimal("30000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 100.0,
                "ema12": 100.05,
                "ema26": 99.95,
                "macd": 0.05,
                "macd_signal": 0.01,
                "rsi14": 56,
                "vol_realized_w60s": 0.0002,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[
                    {
                        "symbol": "AAPL",
                        "qty": "150",
                        "side": "long",
                        "market_value": "15000",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_intraday_tsmom_emits_stop_loss_exit_overlay(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-stop",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-stop",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"long_stop_loss_bps": "25"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 526.70,
                "ema12": 526.90,
                "ema26": 526.85,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 56.4,
                "vol_realized_w60s": 0.00018,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1005.12497",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("1.9091"))
        self.assertEqual(decisions[0].rationale, "position_stop_loss_exit")
        position_exit = decisions[0].params.get("position_exit")
        assert isinstance(position_exit, dict)
        self.assertEqual(position_exit.get("type"), "long_stop_loss_bps")

    def test_scheduler_runtime_position_exit_overlay_skips_hard_stop_on_wide_spread(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-stop",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-stop",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "long_stop_loss_bps": "25",
                        "long_stop_loss_spread_bps_multiplier": "0.50",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 526.70,
                "spread": 5.00,
                "ema12": 526.90,
                "ema26": 526.85,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 56.4,
                "vol_realized_w60s": 0.00018,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1005.12497",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_position_trailing_stop_exit_after_peak_drawdown(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-trailing-stop",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-trailing-stop",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "long_trailing_stop_activation_profit_bps": "20",
                        "long_trailing_stop_drawdown_bps": "15",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        peak_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 530.00,
                "spread": 0.04,
                "ema12": 529.50,
                "ema26": 529.10,
                "macd": 0.015,
                "macd_signal": 0.010,
                "rsi14": 58.0,
                "vol_realized_w60s": 0.00018,
            },
        )
        trailing_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 30, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": 529.00,
                "spread": 0.04,
                "ema12": 529.30,
                "ema26": 529.05,
                "macd": 0.012,
                "macd_signal": 0.009,
                "rsi14": 56.5,
                "vol_realized_w60s": 0.00018,
            },
        )
        positions = [
            {
                "symbol": "META",
                "qty": "1.9091",
                "side": "long",
                "market_value": "1009.5123",
                "avg_entry_price": "528.29",
            }
        ]

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            initial_decisions = engine.evaluate(peak_signal, [strategy], positions=positions)
            trailing_decisions = engine.evaluate(trailing_signal, [strategy], positions=positions)

        self.assertEqual(initial_decisions, [])
        self.assertEqual(len(trailing_decisions), 1)
        self.assertEqual(trailing_decisions[0].action, "sell")
        self.assertEqual(trailing_decisions[0].rationale, "position_trailing_stop_exit")
        trailing_exit = trailing_decisions[0].params.get("position_exit")
        assert isinstance(trailing_exit, dict)
        self.assertEqual(trailing_exit.get("type"), "long_trailing_stop_bps")

    def test_scheduler_runtime_position_trailing_stop_skips_non_profitable_exit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-trailing-stop-profit-floor",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-trailing-stop-profit-floor",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "require_positive_price_for_signal_exit": "true",
                        "long_trailing_stop_activation_profit_bps": "20",
                        "long_trailing_stop_drawdown_bps": "15",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        peak_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 530.00,
                "spread": 0.04,
                "ema12": 529.50,
                "ema26": 529.10,
                "macd": 0.015,
                "macd_signal": 0.010,
                "rsi14": 58.0,
                "vol_realized_w60s": 0.00018,
            },
        )
        trailing_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 30, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": 528.40,
                "spread": 0.30,
                "ema12": 529.10,
                "ema26": 528.95,
                "macd": 0.012,
                "macd_signal": 0.009,
                "rsi14": 56.5,
                "vol_realized_w60s": 0.00018,
            },
        )
        positions = [
            {
                "symbol": "META",
                "qty": "1.9091",
                "side": "long",
                "market_value": "1009.5123",
                "avg_entry_price": "528.29",
            }
        ]

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_execution_prefer_limit", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            initial_decisions = engine.evaluate(peak_signal, [strategy], positions=positions)
            trailing_decisions = engine.evaluate(trailing_signal, [strategy], positions=positions)

        self.assertEqual(initial_decisions, [])
        self.assertEqual(trailing_decisions, [])

    def test_scheduler_runtime_position_exit_overlay_emits_session_flatten_exit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-session-flatten",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-session-flatten",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "session_flatten_start_minute_utc": "1170",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=13,
            payload={
                "price": 525.10,
                "spread": 0.20,
                "ema12": 525.30,
                "ema26": 525.25,
                "macd": 0.001,
                "macd_signal": 0.001,
                "rsi14": 50.0,
                "vol_realized_w60s": 0.00012,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1002.63",
                        "avg_entry_price": "524.50",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "session_flatten_exit")
        session_exit = decisions[0].params.get("position_exit")
        assert isinstance(session_exit, dict)
        self.assertEqual(session_exit.get("type"), "session_flatten_minute_utc")

    def test_scheduler_runtime_position_exit_overlay_session_flatten_bypasses_profit_floor(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-session-flatten-loss",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-session-flatten-loss",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "session_flatten_start_minute_utc": "1170",
                        "require_positive_price_for_signal_exit": "true",
                        "min_signal_exit_profit_bps": "8",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=13,
            payload={
                "price": 523.90,
                "spread": 0.20,
                "ema12": 524.20,
                "ema26": 524.15,
                "macd": -0.001,
                "macd_signal": 0.001,
                "rsi14": 48.0,
                "vol_realized_w60s": 0.00012,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1000.00",
                        "avg_entry_price": "524.50",
                        "opened_at": "2026-03-27T18:15:00+00:00",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "session_flatten_exit")

    def test_scheduler_runtime_position_exit_overlay_emits_max_hold_exit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation-max-hold",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation-max-hold",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "max_hold_seconds": "300",
                        "require_positive_price_for_signal_exit": "true",
                        "min_signal_exit_profit_bps": "8",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 35, 30, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=14,
            payload={
                "price": 522.90,
                "spread": 0.08,
                "ema12": 523.40,
                "ema26": 523.10,
                "macd": 0.006,
                "macd_signal": 0.004,
                "rsi14": 55.0,
                "vol_realized_w60s": 0.00015,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy.id),
                        "qty": "26.7624",
                        "side": "long",
                        "market_value": "13995.02",
                        "avg_entry_price": "523.40",
                        "opened_at": "2026-03-27T17:30:00+00:00",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "position_time_exit")
        max_hold_exit = decisions[0].params.get("position_exit")
        assert isinstance(max_hold_exit, dict)
        self.assertEqual(max_hold_exit.get("type"), "max_hold_seconds")

    def test_scheduler_runtime_position_exit_overlay_emits_max_hold_exit_for_isolated_strategy(
        self,
    ) -> None:
        strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=strategy_id,
            name="breakout-continuation-max-hold-isolated",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation-max-hold-isolated",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "position_isolation_mode": "per_strategy",
                        "max_hold_seconds": "300",
                        "require_positive_price_for_signal_exit": "true",
                        "min_signal_exit_profit_bps": "8",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 35, 30, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=15,
            payload={
                "price": 522.90,
                "spread": 0.08,
                "ema12": 523.40,
                "ema26": 523.10,
                "macd": 0.006,
                "macd_signal": 0.004,
                "rsi14": 55.0,
                "vol_realized_w60s": 0.00015,
                "vwap_session": 523.05,
                "imbalance_bid_sz": 4100,
                "imbalance_ask_sz": 3900,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy_id),
                        "qty": "26.7624",
                        "side": "long",
                        "market_value": "13995.02",
                        "avg_entry_price": "523.40",
                        "opened_at": "2026-03-27T17:30:00+00:00",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "position_time_exit")
        runtime_payload = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_payload, dict)
        self.assertEqual(runtime_payload.get("position_isolation_mode"), "per_strategy")
        max_hold_exit = decisions[0].params.get("position_exit")
        assert isinstance(max_hold_exit, dict)
        self.assertEqual(max_hold_exit.get("type"), "max_hold_seconds")

    def test_scheduler_runtime_does_not_fallback_to_legacy_when_runtime_returns_no_intents(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="tsmom-only",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"strategy_type":"intraday_tsmom_v1","version":"1.0.0","compiler_source":"spec_v2"}'
            ),
            enabled=True,
            base_timeframe="1Min",
            universe_type="intraday_tsmom_v1",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "ema12": Decimal("100.0"),
                "ema26": Decimal("101.0"),
                "macd": {"macd": Decimal("0.01"), "signal": Decimal("0.05")},
                "rsi14": Decimal("72"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy])
            telemetry = engine.consume_runtime_telemetry()

        self.assertEqual(decisions, [])
        self.assertTrue(telemetry.runtime_enabled)
        self.assertFalse(telemetry.fallback_to_legacy)
        self.assertEqual(telemetry.errors, ())
        self.assertIsNotNone(telemetry.observation)
        if telemetry.observation is not None:
            self.assertEqual(
                telemetry.observation.strategy_intents_total.get(str(strategy.id), 0),
                0,
            )

    def test_scheduler_runtime_fails_closed_when_plugin_missing(self) -> None:
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
        ):
            decisions = engine.evaluate(signal, [strategy])
            telemetry = engine.consume_runtime_telemetry()

        self.assertEqual(decisions, [])
        self.assertFalse(telemetry.fallback_to_legacy)
        self.assertEqual(len(telemetry.errors), 1)
        self.assertEqual(telemetry.errors[0].reason, "plugin_not_found")
        self.assertIsNotNone(telemetry.observation)
        if telemetry.observation is not None:
            self.assertEqual(
                telemetry.observation.strategy_errors_total.get(str(strategy.id)),
                1,
            )

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
                'microstructure_state': {
                    'schema_version': 'microstructure_state_v1',
                    'symbol': 'aapl',
                    'event_ts': datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat(),
                    'spread_bps': '18',
                    'depth_top5_usd': '1200000',
                    'order_flow_imbalance': '0.15',
                    'latency_ms_estimate': 22,
                    'fill_hazard': '0.65',
                    'liquidity_regime': 'compressed',
                },
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

    def test_decision_params_include_microstructure_signal_alias_payload(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='signal-alias',
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
                'microstructure_signal': {
                    'schema_version': 'microstructure_signal_v1',
                    'symbol': 'aapl',
                    'event_ts': datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat(),
                    'horizon': 'PT1S',
                    'uncertainty_band': 'high',
                    'expected_spread_impact_bps': '14',
                    'expected_slippage_bps': '9.2',
                    'feature_quality_status': 'pass',
                    'depth_top5_usd': '1200000',
                    'direction_probabilities': {
                        'up': '0.70',
                        'flat': '0.10',
                        'down': '0.20',
                    },
                    'liquidity_state': 'compressed',
                    'artifact': {
                        'model_id': 'deeplob-bdlob-v1',
                        'feature_schema_version': 'microstructure_signal_v1',
                        'training_run_id': 'run-abc-123',
                    },
                },
            },
            timeframe='1Min',
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        micro = params.get('microstructure_state')
        assert isinstance(micro, dict)
        self.assertEqual(micro.get('schema_version'), 'microstructure_signal_v1')
        self.assertEqual(micro.get('symbol'), 'AAPL')
        self.assertEqual(micro.get('liquidity_state'), 'compressed')

    def test_decision_params_fallback_for_malformed_microstructure_signal(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='signal-alias-fallback',
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
                'microstructure_signal': {
                    'schema_version': 'microstructure_signal_v1',
                    'symbol': 'aapl',
                    'event_ts': '2026-01-01T00:00:00Z',
                    'feature_quality_status': 'fail',
                    'liquidity_state': 'compressed',
                    'expected_spread_impact_bps': '14',
                    'depth_top5_usd': '1200000',
                    'direction_probabilities': {
                        'up': '0.70',
                        'flat': '0.10',
                        'down': '0.20',
                    },
                },
            },
            timeframe='1Min',
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        self.assertNotIn('microstructure_state', decisions[0].params)

    def test_decision_params_do_not_synthesize_microstructure_without_explicit_payload(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='synthesis-safe',
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
            symbol='AAPL',
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
            },
            timeframe='1Min',
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        self.assertIsNone(decisions[0].params.get('microstructure_state'))

    def test_decision_params_include_signal_seq(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='seq-wiring',
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
            symbol='AAPL',
            timeframe='1Min',
            seq=17,
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].params.get('signal_seq'), 17)

    def test_decision_params_include_simulation_context(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='sim-wiring',
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
            symbol='AAPL',
            timeframe='1Min',
            seq=321,
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'simulation_context': {
                    'dataset_event_id': 'evt-321',
                    'source_topic': 'torghut.trades.v1',
                    'source_partition': 4,
                    'source_offset': 1200,
                    'replay_topic': 'torghut.sim.trades.v1',
                },
            },
        )

        with (
            patch.object(settings, 'trading_simulation_enabled', True),
            patch.object(settings, 'trading_simulation_run_id', 'sim-2026-02-27-01'),
            patch.object(settings, 'trading_simulation_dataset_id', 'dataset-1'),
        ):
            decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        simulation_context = decisions[0].params.get('simulation_context')
        self.assertIsInstance(simulation_context, dict)
        assert isinstance(simulation_context, dict)
        self.assertEqual(simulation_context.get('simulation_run_id'), 'sim-2026-02-27-01')
        self.assertEqual(simulation_context.get('dataset_id'), 'dataset-1')
        self.assertEqual(simulation_context.get('dataset_event_id'), 'evt-321')
        self.assertEqual(simulation_context.get('signal_seq'), 321)

    def test_decision_params_do_not_include_simulation_context_when_disabled(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='no-sim',
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
            symbol='AAPL',
            timeframe='1Min',
            seq=11,
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
            },
        )

        with patch.object(settings, 'trading_simulation_enabled', False):
            decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        self.assertNotIn('simulation_context', decisions[0].params)

    def test_decision_params_include_regime_hmm_canonical_payload(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 27, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'hmm_regime_id': 'R2',
                'schema_version': 'hmm_regime_context_v1',
                'hmm_state_posterior': {'R2': '0.75'},
                'hmm_entropy': '1.23',
                'hmm_entropy_band': 'medium',
                'hmm_predicted_next': 'R3',
                'hmm_guardrail': {
                    'stale': False,
                    'fallback_to_defensive': False,
                    'reason': 'stable',
                },
                'hmm_artifact': {
                    'model_id': 'hmm-regime-v1.2.0',
                    'feature_schema': 'hmm-v1-feature-schema',
                    'training_run_id': 'trn_2026-02-28',
                },
                'hmm_transition_shock': False,
                'hmm_duration_ms': 14,
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        regime_payload = params.get('regime_hmm')
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get('regime_id'), 'R2')
        self.assertEqual(regime_payload.get('artifact', {}).get('model_id'), 'hmm-regime-v1.2.0')
        self.assertEqual(regime_payload.get('hmm_state_posterior'), {'R2': '0.75'})
        self.assertEqual(regime_payload.get('hmm_entropy'), '1.23')
        self.assertEqual(regime_payload.get('hmm_entropy_band'), 'medium')
        self.assertEqual(regime_payload.get('hmm_predicted_next'), 'R3')
        self.assertEqual(regime_payload.get('hmm_transition_shock'), False)
        self.assertEqual(params.get('regime_label'), 'r2')
        self.assertEqual(params.get('route_regime_label'), 'r2')

    def test_decision_params_fallback_with_invalid_schema_version_preserves_lineage(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-invalid-schema',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 27, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'schema_version': 'hmm_regime_context_v0',
                'hmm_regime_id': 'R2',
                'hmm_entropy': '1.23',
                'hmm_entropy_band': 'medium',
                'hmm_predicted_next': 'R3',
                'hmm_artifact': {
                    'model_id': 'hmm-regime-v1.2.0',
                    'feature_schema': 'hmm-v1-feature-schema',
                    'training_run_id': 'trn_2026-02-28',
                },
                'hmm_transition_shock': False,
                'hmm_duration_ms': 14,
                'regime_label': 'trend',
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        regime_payload = params.get('regime_hmm')
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get('schema_version'), 'hmm_regime_context_v0')
        self.assertEqual(regime_payload.get('artifact', {}).get('model_id'), 'hmm-regime-v1.2.0')
        self.assertEqual(params.get('route_regime_label'), 'trend')
        self.assertEqual(params.get('regime_label'), 'trend')

    def test_decision_params_fallback_with_invalid_posterior_preserves_lineage(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-invalid-posterior',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 27, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'schema_version': 'hmm_regime_context_v1',
                'hmm_regime_id': 'R2',
                'hmm_state_posterior': {'R2': 'not-a-decimal'},
                'hmm_entropy': '1.23',
                'hmm_entropy_band': 'medium',
                'hmm_predicted_next': 'R3',
                'hmm_artifact': {
                    'model_id': 'hmm-regime-v1.2.0',
                    'feature_schema': 'hmm-v1-feature-schema',
                    'training_run_id': 'trn_2026-02-28',
                },
                'hmm_transition_shock': False,
                'hmm_duration_ms': 14,
                'regime_label': 'trend',
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        regime_payload = params.get('regime_hmm')
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get('schema_version'), 'hmm_regime_context_v1')
        self.assertEqual(regime_payload.get('artifact', {}).get('model_id'), 'hmm-regime-v1.2.0')
        self.assertEqual(params.get('route_regime_label'), 'trend')
        self.assertEqual(params.get('regime_label'), 'trend')

    def test_decision_params_fallback_with_stale_regime_guardrail_preserves_lineage(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-stale-preserves-lineage',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'schema_version': 'hmm_regime_context_v1',
                'hmm_regime_id': 'R2',
                'hmm_state_posterior': {'R2': '0.75'},
                'hmm_entropy': '1.23',
                'hmm_entropy_band': 'medium',
                'hmm_predicted_next': 'R3',
                'hmm_artifact': {
                    'model_id': 'hmm-regime-v1.2.0',
                    'feature_schema': 'hmm-v1-feature-schema',
                    'training_run_id': 'trn_2026-03-01',
                },
                'hmm_guardrail': {'stale': True, 'fallback_to_defensive': False, 'reason': 'aging_output'},
                'hmm_transition_shock': False,
                'regime_label': 'trend',
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        regime_payload = params.get('regime_hmm')
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get('schema_version'), 'hmm_regime_context_v1')
        self.assertEqual(regime_payload.get('artifact', {}).get('model_id'), 'hmm-regime-v1.2.0')
        self.assertEqual(
            regime_payload.get('hmm_guardrail', {}).get('reason'),
            'aging_output'
        )
        self.assertEqual(params.get('route_regime_label'), 'trend')
        self.assertEqual(params.get('regime_label'), 'trend')

    def test_decision_regime_route_label_falls_back_to_explicit_regime_label(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-fallback',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 28, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'regime_label': '  TREND  ',
                'hmm_regime_id': 'unknown',
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        self.assertEqual(params.get('route_regime_label'), 'trend')
        self.assertEqual(params.get('regime_label'), 'trend')

    def test_decision_regime_route_label_falls_back_to_nested_legacy_regime(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-nested-fallback',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 28, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'regime': {'label': '  TREND  '},
                'hmm_regime_id': 'not-a-regime-id',
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        self.assertEqual(params.get('route_regime_label'), 'trend')
        self.assertEqual(params.get('regime_label'), 'trend')
        regime_payload = params.get('regime_hmm')
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get('regime_id'), 'not-a-regime-id')

    def test_decision_regime_route_label_falls_back_when_hmm_stale(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-stale-fallback',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 28, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'regime_label': '  TREND  ',
                'hmm_regime_id': 'R2',
                'hmm_guardrail': {
                    'stale': True,
                    'fallback_to_defensive': False,
                    'reason': 'aging_output',
                },
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        self.assertEqual(params.get('route_regime_label'), 'trend')
        self.assertEqual(params.get('regime_label'), 'trend')

    def test_decision_regime_route_label_ignores_transition_shock(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-transition-shock',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 28, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'regime_label': '  TREND  ',
                'hmm_regime_id': 'R2',
                'hmm_transition_shock': True,
                'hmm_guardrail': {'stale': False, 'fallback_to_defensive': False},
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        self.assertEqual(params.get('route_regime_label'), 'trend')
        self.assertEqual(params.get('regime_label'), 'trend')

    def test_decision_context_omits_regime_hmm_payload_without_explicit_hmm_input(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-omitted',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 28, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        self.assertNotIn('regime_hmm', params)
        self.assertEqual(params.get('route_regime_label'), 'trend')

    def test_decision_context_omits_regime_hmm_payload_with_placeholder_hmm_fields(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-placeholder',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 28, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'regime_hmm': None,
                'hmm_regime_id': None,
                'hmm_state_posterior': None,
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        self.assertNotIn('regime_hmm', params)
        self.assertEqual(params.get('route_regime_label'), 'trend')

    def test_decision_regime_route_label_prefers_explicit_route_label_hint(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='regime-hmm-route-hint',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 28, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
                'route_regime_label': '  MEAN_REVERT  ',
                'hmm_regime_id': 'not-a-regime-id',
                'hmm_guardrail': {
                    'stale': False,
                    'fallback_to_defensive': False,
                    'reason': 'legacy_injection',
                },
            },
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        params = decisions[0].params
        self.assertEqual(params.get('route_regime_label'), 'mean_revert')
        self.assertEqual(params.get('regime_label'), 'mean_revert')

    def test_scheduler_runtime_mode_does_not_enable_when_scheduler_disabled(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name='runtime-disabled-no-flag',
            description='version=1.0.0',
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=None,
            max_notional_per_trade=Decimal('500'),
            max_position_pct_equity=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': Decimal('1.0'), 'signal': Decimal('0.1')},
                'rsi14': Decimal('20'),
                'price': Decimal('100'),
            },
        )
        with (
            patch.object(settings, 'trading_strategy_runtime_mode', 'scheduler_v3'),
            patch.object(settings, 'trading_strategy_scheduler_enabled', False),
        ):
            decisions = engine.evaluate(signal, [strategy])
            telemetry = engine.consume_runtime_telemetry()

        self.assertEqual(len(decisions), 1)
        self.assertFalse(telemetry.runtime_enabled)
        self.assertEqual(telemetry.mode, 'legacy')
