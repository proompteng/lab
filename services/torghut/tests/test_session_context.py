from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import cast
from unittest import TestCase

from app.trading.models import SignalEnvelope
from app.trading.session_context import SessionContextTracker


def _signal(
    *,
    event_ts: datetime,
    symbol: str = 'META',
    price: str,
    spread: str,
    bid_sz: str,
    ask_sz: str,
    vwap_w5m: str | None = None,
) -> SignalEnvelope:
    price_value = Decimal(price)
    spread_value = Decimal(spread)
    bid_px = price_value - (spread_value / 2)
    ask_px = price_value + (spread_value / 2)
    return SignalEnvelope(
        event_ts=event_ts,
        symbol=symbol,
        timeframe='1Sec',
        seq=1,
        source='ta',
        payload={
            'price': price_value,
            'spread': spread_value,
            'imbalance_bid_px': bid_px,
            'imbalance_ask_px': ask_px,
            'imbalance_bid_sz': Decimal(bid_sz),
            'imbalance_ask_sz': Decimal(ask_sz),
            'vwap_w5m': Decimal(vwap_w5m) if vwap_w5m is not None else None,
        },
    )


class TestSessionContextTracker(TestCase):
    def test_tracker_enriches_session_and_opening_range_fields(self) -> None:
        tracker = SessionContextTracker()

        open_signal = _signal(
            event_ts=datetime(2026, 3, 24, 13, 30, 5, tzinfo=timezone.utc),
            price='100.00',
            spread='0.04',
            bid_sz='4200',
            ask_sz='3800',
        )
        breakout_signal = _signal(
            event_ts=datetime(2026, 3, 24, 14, 5, 0, tzinfo=timezone.utc),
            price='101.20',
            spread='0.03',
            bid_sz='5100',
            ask_sz='4300',
        )

        open_payload = tracker.enrich_signal_payload(open_signal)
        breakout_payload = tracker.enrich_signal_payload(breakout_signal)

        self.assertEqual(open_payload['session_open_price'], Decimal('100.00'))
        self.assertEqual(breakout_payload['session_open_price'], Decimal('100.00'))
        self.assertEqual(breakout_payload['opening_range_high'], Decimal('100.00'))
        self.assertEqual(breakout_payload['opening_range_low'], Decimal('100.00'))
        self.assertEqual(breakout_payload['opening_window_close_price'], Decimal('100.00'))
        self.assertEqual(breakout_payload['opening_window_return_bps'], Decimal('0'))
        self.assertEqual(breakout_payload['session_high_price'], Decimal('101.20'))
        self.assertEqual(breakout_payload['session_low_price'], Decimal('100.00'))
        self.assertEqual(breakout_payload['session_minutes_elapsed'], 35)
        self.assertGreater(breakout_payload['price_vs_session_open_bps'], Decimal('100'))
        self.assertGreater(breakout_payload['price_vs_opening_range_high_bps'], Decimal('100'))
        self.assertGreater(breakout_payload['recent_spread_bps_avg'], Decimal('0'))
        self.assertGreater(breakout_payload['recent_imbalance_pressure_avg'], Decimal('0'))

    def test_tracker_resets_state_on_new_session_day(self) -> None:
        tracker = SessionContextTracker()
        first_day = _signal(
            event_ts=datetime(2026, 3, 24, 19, 45, 0, tzinfo=timezone.utc),
            price='101.00',
            spread='0.03',
            bid_sz='4500',
            ask_sz='4100',
        )
        second_day = _signal(
            event_ts=datetime(2026, 3, 25, 13, 30, 0, tzinfo=timezone.utc),
            price='98.00',
            spread='0.02',
            bid_sz='3900',
            ask_sz='4200',
        )

        tracker.enrich_signal_payload(first_day)
        second_payload = tracker.enrich_signal_payload(second_day)

        self.assertEqual(second_payload['session_open_price'], Decimal('98.00'))
        self.assertEqual(second_payload['prev_session_close_price'], Decimal('101.00'))
        self.assertEqual(second_payload['session_high_price'], Decimal('98.00'))
        self.assertEqual(second_payload['opening_range_high'], Decimal('98.00'))
        self.assertEqual(second_payload['price_vs_session_open_bps'], Decimal('0'))
        self.assertEqual(
            second_payload['price_vs_prev_session_close_bps'],
            Decimal('-297.0297029702970297029702970'),
        )

    def test_tracker_locks_opening_window_close_and_return_after_first_half_hour(self) -> None:
        tracker = SessionContextTracker()
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 13, 30, 5, tzinfo=timezone.utc),
                price='100.00',
                spread='0.03',
                bid_sz='4200',
                ask_sz='3800',
            )
        )
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 13, 55, 0, tzinfo=timezone.utc),
                price='101.00',
                spread='0.03',
                bid_sz='4600',
                ask_sz='3900',
            )
        )
        late_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 14, 20, 0, tzinfo=timezone.utc),
                price='102.50',
                spread='0.03',
                bid_sz='5100',
                ask_sz='4200',
            )
        )

        self.assertEqual(late_payload['opening_window_close_price'], Decimal('101.00'))
        self.assertEqual(late_payload['opening_window_return_bps'], Decimal('100'))
        self.assertEqual(late_payload['price_vs_opening_window_close_bps'], Decimal('148.5148514851485148514851485'))

    def test_tracker_emits_previous_close_anchored_opening_metrics(self) -> None:
        tracker = SessionContextTracker()
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 19, 59, 0, tzinfo=timezone.utc),
                price='101.00',
                spread='0.03',
                bid_sz='4500',
                ask_sz='4100',
            )
        )
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 25, 13, 30, 5, tzinfo=timezone.utc),
                price='99.00',
                spread='0.03',
                bid_sz='4200',
                ask_sz='3800',
            )
        )
        opening_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 25, 13, 55, 0, tzinfo=timezone.utc),
                price='100.50',
                spread='0.03',
                bid_sz='4700',
                ask_sz='3900',
            )
        )

        self.assertEqual(opening_payload['prev_session_close_price'], Decimal('101.00'))
        self.assertEqual(
            opening_payload['opening_window_return_bps'],
            Decimal('151.5151515151515151515151515'),
        )
        self.assertEqual(
            opening_payload['opening_window_return_from_prev_close_bps'],
            Decimal('-49.50495049504950495049504950'),
        )
        self.assertEqual(
            opening_payload['price_vs_prev_session_close_bps'],
            Decimal('-49.50495049504950495049504950'),
        )

    def test_tracker_prefers_nested_midpoint_over_vwap_fallback(self) -> None:
        tracker = SessionContextTracker()
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 13, 45, 0, tzinfo=timezone.utc),
            symbol='META',
            timeframe='1Sec',
            seq=2,
            source='ta',
            payload={
                'vwap': {'session': Decimal('100.0'), 'w5m': Decimal('100.2')},
                'imbalance': {
                    'bid_px': Decimal('101.0'),
                    'ask_px': Decimal('103.0'),
                    'spread': Decimal('2.0'),
                    'bid_sz': Decimal('5200'),
                    'ask_sz': Decimal('4300'),
                },
            },
        )

        payload = tracker.enrich_signal_payload(signal)
        self.assertEqual(payload['session_open_price'], Decimal('102.0'))
        self.assertEqual(payload['recent_spread_bps_avg'], Decimal('196.0784313725490196078431373'))
        self.assertGreater(payload['recent_imbalance_pressure_avg'], Decimal('0'))

    def test_tracker_emits_cross_section_continuation_and_reversal_ranks(self) -> None:
        tracker = SessionContextTracker()
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 13, 30, 5, tzinfo=timezone.utc),
                symbol='AAPL',
                price='100.00',
                spread='0.03',
                bid_sz='5200',
                ask_sz='4100',
                vwap_w5m='100.00',
            )
        )
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 13, 30, 6, tzinfo=timezone.utc),
                symbol='META',
                price='100.00',
                spread='0.03',
                bid_sz='4200',
                ask_sz='4300',
                vwap_w5m='100.00',
            )
        )

        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 13, 55, 0, tzinfo=timezone.utc),
                symbol='AAPL',
                price='101.10',
                spread='0.03',
                bid_sz='5500',
                ask_sz='4000',
                vwap_w5m='100.80',
            )
        )
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 13, 55, 5, tzinfo=timezone.utc),
                symbol='META',
                price='99.10',
                spread='0.03',
                bid_sz='4300',
                ask_sz='4400',
                vwap_w5m='99.40',
            )
        )

        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 14, 5, 0, tzinfo=timezone.utc),
                symbol='AAPL',
                price='102.40',
                spread='0.03',
                bid_sz='5600',
                ask_sz='3900',
                vwap_w5m='101.90',
            )
        )
        loser_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 14, 5, 5, tzinfo=timezone.utc),
                symbol='META',
                price='98.70',
                spread='0.03',
                bid_sz='5400',
                ask_sz='3600',
                vwap_w5m='99.30',
            )
        )
        leader_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 14, 5, 10, tzinfo=timezone.utc),
                symbol='AAPL',
                price='102.55',
                spread='0.03',
                bid_sz='5700',
                ask_sz='3800',
                vwap_w5m='102.00',
            )
        )

        self.assertEqual(loser_payload['cross_section_session_open_rank'], Decimal('0'))
        self.assertEqual(loser_payload['cross_section_opening_window_return_rank'], Decimal('0'))
        self.assertEqual(leader_payload['cross_section_session_open_rank'], Decimal('1'))
        self.assertEqual(leader_payload['cross_section_opening_window_return_rank'], Decimal('1'))
        self.assertEqual(leader_payload['cross_section_positive_session_open_ratio'], Decimal('0.5'))
        self.assertEqual(leader_payload['cross_section_positive_opening_window_return_ratio'], Decimal('0.5'))
        self.assertEqual(leader_payload['cross_section_above_vwap_w5m_ratio'], Decimal('0.5'))
        self.assertEqual(leader_payload['cross_section_positive_recent_imbalance_ratio'], Decimal('1'))
        self.assertEqual(leader_payload['cross_section_continuation_breadth'], Decimal('0.625'))
        self.assertLess(
            cast(Decimal, loser_payload['cross_section_continuation_rank']),
            cast(Decimal, leader_payload['cross_section_continuation_rank']),
        )
        self.assertGreater(
            cast(Decimal, loser_payload['cross_section_reversal_rank']),
            cast(Decimal, leader_payload['cross_section_reversal_rank']),
        )

    def test_tracker_emits_quote_instability_and_microprice_bias_features(self) -> None:
        tracker = SessionContextTracker()
        first_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 18, 8, 24, tzinfo=timezone.utc),
                symbol='AAPL',
                price='210.00',
                spread='0.04',
                bid_sz='6200',
                ask_sz='4100',
                vwap_w5m='209.95',
            )
        )
        unstable_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 18, 8, 25, tzinfo=timezone.utc),
                symbol='AAPL',
                price='210.00',
                spread='2.10',
                bid_sz='6400',
                ask_sz='3900',
                vwap_w5m='209.96',
            )
        )

        self.assertEqual(first_payload['recent_quote_invalid_ratio'], Decimal('0'))
        self.assertEqual(unstable_payload['recent_quote_invalid_ratio'], Decimal('0.5'))
        self.assertIsNone(unstable_payload['recent_quote_jump_bps_max'])
        self.assertGreater(
            cast(Decimal, unstable_payload['recent_microprice_bias_bps_avg']),
            Decimal('0'),
        )

    def test_tracker_prefers_prev_close_in_cross_section_continuation_rank(self) -> None:
        tracker = SessionContextTracker()
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 19, 59, 0, tzinfo=timezone.utc),
                symbol='AAPL',
                price='105.00',
                spread='0.03',
                bid_sz='5200',
                ask_sz='4100',
                vwap_w5m='104.80',
            )
        )
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 24, 19, 59, 1, tzinfo=timezone.utc),
                symbol='META',
                price='95.00',
                spread='0.03',
                bid_sz='5000',
                ask_sz='4200',
                vwap_w5m='95.10',
            )
        )
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 25, 13, 30, 5, tzinfo=timezone.utc),
                symbol='AAPL',
                price='99.00',
                spread='0.03',
                bid_sz='5100',
                ask_sz='4300',
                vwap_w5m='99.00',
            )
        )
        tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 25, 13, 30, 6, tzinfo=timezone.utc),
                symbol='META',
                price='99.00',
                spread='0.03',
                bid_sz='5300',
                ask_sz='4000',
                vwap_w5m='99.00',
            )
        )
        aapl_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 25, 13, 55, 0, tzinfo=timezone.utc),
                symbol='AAPL',
                price='100.50',
                spread='0.03',
                bid_sz='5200',
                ask_sz='4100',
                vwap_w5m='100.30',
            )
        )
        meta_payload = tracker.enrich_signal_payload(
            _signal(
                event_ts=datetime(2026, 3, 25, 13, 55, 1, tzinfo=timezone.utc),
                symbol='META',
                price='100.50',
                spread='0.03',
                bid_sz='5400',
                ask_sz='3900',
                vwap_w5m='100.30',
            )
        )

        self.assertLess(
            cast(Decimal, aapl_payload['cross_section_prev_session_close_rank']),
            cast(Decimal, meta_payload['cross_section_prev_session_close_rank']),
        )
        self.assertLess(
            cast(Decimal, aapl_payload['cross_section_continuation_rank']),
            cast(Decimal, meta_payload['cross_section_continuation_rank']),
        )
