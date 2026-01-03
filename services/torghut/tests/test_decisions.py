from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.models import SignalEnvelope


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
