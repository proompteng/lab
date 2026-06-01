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
        first = tracker.assess(self._signal(bid="524.98", ask="525.02", price="525.00"))
        second = tracker.assess(
            self._signal(bid="504.00", ask="506.50", price="505.25")
        )

        self.assertTrue(first.valid)
        self.assertFalse(second.valid)
        self.assertEqual(second.reason, "wide_spread_midpoint_jump")

    def test_assess_signal_quote_quality_uses_nested_imbalance_midpoint(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=13,
            payload={
                "imbalance": {
                    "bid_px": Decimal("525.00"),
                    "ask_px": Decimal("525.04"),
                    "spread": Decimal("0.04"),
                },
                "vwap": {"session": Decimal("523.10")},
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertTrue(status.valid)
        self.assertEqual(status.spread_bps, Decimal("0.7618757380671212525237133823"))

    def test_assess_signal_quote_quality_rejects_spread_without_executable_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=16,
            payload={
                "price": Decimal("525.00"),
                "spread": Decimal("0.04"),
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "missing_executable_quote")

    def test_assess_signal_quote_quality_rejects_zero_top_level_bid_without_falling_back(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=14,
            payload={
                "price": Decimal("525.00"),
                "imbalance_bid_px": Decimal("0"),
                "imbalance_ask_px": Decimal("525.04"),
                "imbalance": {
                    "bid_px": Decimal("525.00"),
                    "ask_px": Decimal("525.04"),
                },
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "non_positive_bid")

    def test_assess_signal_quote_quality_rejects_price_without_executable_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=15,
            payload={
                "price": Decimal("525.00"),
                "vwap_session": Decimal("524.98"),
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "missing_executable_quote")

    def test_assess_signal_quote_quality_rejects_non_positive_price_with_top_level_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=15,
            payload={
                "price": Decimal("0"),
                "bid": Decimal("525.00"),
                "ask": Decimal("525.04"),
                "source": "paper_route_h_pairs_quote",
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "non_positive_price")
        self.assertEqual(status.price, Decimal("0"))
        self.assertEqual(status.bid, Decimal("525.00"))
        self.assertEqual(status.ask, Decimal("525.04"))
        self.assertEqual(status.source, "paper_route_h_pairs_quote")

    def test_assess_signal_quote_quality_uses_top_level_bid_ask_midpoint(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=15,
            payload={
                "bid": Decimal("525.00"),
                "ask": Decimal("525.04"),
                "source": "paper_route_h_pairs_quote",
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertTrue(status.valid)
        self.assertEqual(status.price, Decimal("525.02"))
        self.assertEqual(status.bid, Decimal("525.00"))
        self.assertEqual(status.ask, Decimal("525.04"))
        self.assertEqual(status.source, "paper_route_h_pairs_quote")

    def test_assess_signal_quote_quality_rejects_non_positive_top_level_ask_px(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=15,
            payload={
                "price": Decimal("525.00"),
                "bid_px": Decimal("525.00"),
                "ask_px": Decimal("0"),
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "non_positive_ask")
        self.assertEqual(status.bid, Decimal("525.00"))
        self.assertEqual(status.ask, Decimal("0"))
        self.assertEqual(
            status.repair_action,
            "refresh_ask_quote_before_routeability_claim",
        )

    def test_assess_signal_quote_quality_rejects_missing_bid(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=16,
            payload={
                "price": Decimal("525.00"),
                "imbalance_ask_px": Decimal("525.04"),
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "missing_bid")

    def test_assess_signal_quote_quality_rejects_missing_ask(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=17,
            payload={
                "price": Decimal("525.00"),
                "imbalance_bid_px": Decimal("525.00"),
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("525.01"),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "missing_ask")

    def test_assess_signal_quote_quality_rejects_stale_quote_with_metadata(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=18,
            payload={
                "price": Decimal("190.01"),
                "imbalance_bid_px": Decimal("190.00"),
                "imbalance_ask_px": Decimal("190.02"),
                "price_snapshot": {
                    "quote_as_of": "2026-03-27T17:29:00+00:00",
                    "quote_source": "ta_signals_quote",
                },
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=None,
            policy=QuoteQualityPolicy(max_executable_quote_age_seconds=30),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "stale_quote")
        self.assertEqual(status.source, "ta_signals_quote")
        self.assertEqual(status.quote_age_seconds, Decimal("84.0"))
        self.assertEqual(status.bid, Decimal("190.00"))
        self.assertEqual(status.ask, Decimal("190.02"))
        self.assertEqual(
            status.repair_action,
            "refresh_quote_snapshot_and_recompute_route_fillability",
        )
        self.assertIn("fresh_quote_as_of", status.evidence_requirements)

    def test_assess_signal_quote_quality_uses_h_pairs_price_snapshot_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=19,
            payload={
                "price_snapshot": {
                    "price": "190.01",
                    "bid": "190.00",
                    "ask": "190.02",
                    "spread": "0.02",
                    "quote_as_of": "2026-03-27T17:30:23+00:00",
                    "quote_source": "paper_route_h_pairs_quote",
                },
                "strategy_runtime": {
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                },
            },
        )

        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("190.00"),
            policy=QuoteQualityPolicy(max_executable_quote_age_seconds=30),
        )

        self.assertTrue(status.valid)
        self.assertIsNone(status.reason)
        self.assertEqual(status.fillability_state, "executable_quote_ready")
        self.assertIsNone(status.repair_action)
        self.assertEqual(status.source, "paper_route_h_pairs_quote")
        self.assertEqual(status.quote_age_seconds, Decimal("1.0"))
        self.assertEqual(status.price, Decimal("190.01"))
        self.assertEqual(status.bid, Decimal("190.00"))
        self.assertEqual(status.ask, Decimal("190.02"))
        self.assertEqual(
            status.to_readback()["fillability_state"], "executable_quote_ready"
        )

    def test_assess_signal_quote_quality_exposes_fillability_repair_readback(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=20,
            payload={
                "price_snapshot": {
                    "price": "190.01",
                    "ask": "190.02",
                    "quote_as_of": "2026-03-27T17:30:23+00:00",
                    "quote_source": "paper_route_h_pairs_quote",
                },
            },
        )

        status = assess_signal_quote_quality(signal=signal, previous_price=None)

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "missing_bid")
        self.assertEqual(status.fillability_state, "blocked")
        self.assertEqual(
            status.repair_action, "collect_bid_quote_before_routeability_claim"
        )
        self.assertEqual(
            status.evidence_requirements, ("bid_px", "quote_source", "quote_as_of")
        )
        self.assertEqual(
            status.to_readback()["repair_action"],
            "collect_bid_quote_before_routeability_claim",
        )

    def test_assess_signal_quote_quality_rejects_non_positive_snapshot_price(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=21,
            payload={
                "price": Decimal("0"),
                "bid": Decimal("190.00"),
                "ask": Decimal("190.02"),
                "quote_source": "top_level_quote",
            },
        )

        status = assess_signal_quote_quality(signal=signal, previous_price=None)

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "non_positive_price")
        self.assertEqual(status.source, "top_level_quote")
        self.assertEqual(
            status.repair_action, "collect_positive_executable_reference_price"
        )

    def test_assess_signal_quote_quality_rejects_non_positive_ask(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=22,
            payload={
                "price": Decimal("190.00"),
                "bid": Decimal("190.00"),
                "ask": Decimal("0"),
            },
        )

        status = assess_signal_quote_quality(signal=signal, previous_price=None)

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "non_positive_ask")
        self.assertEqual(
            status.repair_action, "refresh_ask_quote_before_routeability_claim"
        )

    def test_assess_signal_quote_quality_accepts_bid_ask_aliases(
        self,
    ) -> None:
        top_level = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=23,
            payload={
                "price": Decimal("190.01"),
                "bid": Decimal("190.00"),
                "ask": Decimal("190.02"),
            },
        )
        px_aliases = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=24,
            payload={
                "price": Decimal("190.01"),
                "bid_px": Decimal("190.00"),
                "ask_px": Decimal("190.02"),
            },
        )

        self.assertTrue(
            assess_signal_quote_quality(signal=top_level, previous_price=None).valid
        )
        self.assertTrue(
            assess_signal_quote_quality(signal=px_aliases, previous_price=None).valid
        )

    def test_assess_signal_quote_quality_uses_executable_quote_midpoint(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=25,
            payload={
                "executable_quote": {
                    "bid_px": Decimal("190.00"),
                    "ask_px": Decimal("190.02"),
                    "source": "sim_quote_receipt",
                },
            },
        )

        status = assess_signal_quote_quality(signal=signal, previous_price=None)

        self.assertTrue(status.valid)
        self.assertEqual(status.price, Decimal("190.01"))
        self.assertEqual(status.source, "sim_quote_receipt")
