from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.models import SignalEnvelope
from app.trading.prices import MarketSnapshot, PriceFetcher


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

    def test_scheduler_runtime_falls_back_to_legacy_when_plugin_missing(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
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
        runtime_meta = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_meta, dict)
        self.assertEqual(runtime_meta.get("plugin_id"), "legacy_builtin")
