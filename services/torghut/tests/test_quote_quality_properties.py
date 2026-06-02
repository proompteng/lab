from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.models import SignalEnvelope
from app.trading.quote_quality import QuoteQualityPolicy, assess_signal_quote_quality


class TestQuoteQualityProperties(TestCase):
    def test_monotone_spread_rejects_only_after_policy_threshold(self) -> None:
        event_ts = datetime(2026, 6, 1, 14, 31, tzinfo=timezone.utc)
        policy = QuoteQualityPolicy(max_executable_spread_bps=Decimal("10"))

        for spread in (
            Decimal("0.01"),
            Decimal("0.05"),
            Decimal("0.10"),
            Decimal("0.20"),
        ):
            bid = Decimal("100")
            ask = bid + spread
            signal = SignalEnvelope(
                event_ts=event_ts,
                symbol="AAPL",
                timeframe="1Sec",
                payload={
                    "price": (bid + ask) / Decimal("2"),
                    "imbalance_bid_px": bid,
                    "imbalance_ask_px": ask,
                },
            )

            status = assess_signal_quote_quality(
                signal=signal,
                previous_price=None,
                policy=policy,
            )

            if status.spread_bps is not None and status.spread_bps > Decimal("10"):
                self.assertFalse(status.valid)
                self.assertEqual(status.reason, "spread_bps_exceeded")
                self.assertEqual(status.operator_next_action, "wait_for_fresh_quote")
            else:
                self.assertTrue(status.valid)
                self.assertEqual(
                    status.operator_next_action, "allow_bounded_collection"
                )

    def test_quote_age_policy_is_monotone(self) -> None:
        event_ts = datetime(2026, 6, 1, 14, 31, tzinfo=timezone.utc)
        policy = QuoteQualityPolicy(max_executable_quote_age_seconds=30)

        for age_seconds in (0, 5, 30, 31, 120):
            quote_ts = event_ts - timedelta(seconds=age_seconds)
            signal = SignalEnvelope(
                event_ts=event_ts,
                symbol="AMZN",
                timeframe="1Sec",
                payload={
                    "price": Decimal("185.12"),
                    "imbalance_bid_px": Decimal("185.10"),
                    "imbalance_ask_px": Decimal("185.14"),
                    "price_snapshot": {
                        "quote_as_of": quote_ts.isoformat(),
                        "source": "alpaca_latest_quote",
                    },
                },
            )

            status = assess_signal_quote_quality(
                signal=signal,
                previous_price=None,
                policy=policy,
            )

            self.assertEqual(status.quote_age_seconds, Decimal(str(float(age_seconds))))
            if age_seconds > 30:
                self.assertFalse(status.valid)
                self.assertEqual(status.reason, "stale_quote")
                self.assertEqual(status.operator_next_action, "wait_for_fresh_quote")
            else:
                self.assertTrue(status.valid)
                self.assertEqual(
                    status.operator_next_action, "allow_bounded_collection"
                )
