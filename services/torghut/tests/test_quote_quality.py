from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.models import SignalEnvelope
from app.trading.quote_quality import (
    QuoteQualityPolicy,
    SignalQuoteQualityTracker,
    assess_signal_quote_quality,
)


class TestQuoteQuality(TestCase):
    def _signal(self, *, bid: str, ask: str, price: str) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": Decimal(price),
                "imbalance_bid_px": Decimal(bid),
                "imbalance_ask_px": Decimal(ask),
                "spread": Decimal(ask) - Decimal(bid),
            },
        )

    def test_assess_signal_quote_quality_rejects_crossed_quote(self) -> None:
        status = assess_signal_quote_quality(
            signal=self._signal(bid="525.10", ask="525.00", price="525.05"),
            previous_price=Decimal("525.00"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "crossed_quote")

    def test_tracker_uses_last_valid_price_for_jump_filter(self) -> None:
        tracker = SignalQuoteQualityTracker(
            policy=QuoteQualityPolicy(
                max_executable_spread_bps=Decimal("500"),
                max_quote_mid_jump_bps=Decimal("100"),
                max_jump_with_wide_spread_bps=Decimal("25"),
            )
        )
        first = tracker.assess(
            self._signal(bid="524.98", ask="525.02", price="525.00")
        )
        second = tracker.assess(
            self._signal(bid="504.00", ask="506.50", price="505.25")
        )

        self.assertTrue(first.valid)
        self.assertFalse(second.valid)
        self.assertEqual(second.reason, "wide_spread_midpoint_jump")

    def test_assess_signal_quote_quality_uses_nested_imbalance_midpoint(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol='META',
            timeframe='1Sec',
            seq=13,
            payload={
                'imbalance': {
                    'bid_px': Decimal('525.00'),
                    'ask_px': Decimal('525.04'),
                    'spread': Decimal('0.04'),
                },
                'vwap': {'session': Decimal('523.10')},
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal('525.01'),
        )

        self.assertTrue(status.valid)
        self.assertEqual(status.spread_bps, Decimal('0.7618757380671212525237133823'))

    def test_assess_signal_quote_quality_rejects_zero_top_level_bid_without_falling_back(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol='META',
            timeframe='1Sec',
            seq=14,
            payload={
                'price': Decimal('525.00'),
                'imbalance_bid_px': Decimal('0'),
                'imbalance_ask_px': Decimal('525.04'),
                'imbalance': {
                    'bid_px': Decimal('525.00'),
                    'ask_px': Decimal('525.04'),
                },
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal('525.01'),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, 'non_positive_bid')
