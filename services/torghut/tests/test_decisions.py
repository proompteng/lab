from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

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
            payload={"macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")}, "rsi14": Decimal("20")},
            timeframe=None,
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertEqual(decisions, [])

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
            payload={"macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")}, "rsi14": Decimal("20")},
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
