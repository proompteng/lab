from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from hypothesis import given

from app.trading.models import SignalEnvelope
from app.trading.session_context import SessionContextTracker
from tests.strategies.signals import regular_session_signal_series
from tests.strategies.trading import positive_prices

pytestmark = pytest.mark.property


def _session_signal(
    *,
    event_ts: datetime,
    price: Decimal,
    spread: Decimal,
    bid_sz: Decimal,
    ask_sz: Decimal,
) -> SignalEnvelope:
    bid = price - (spread / 2)
    ask = price + (spread / 2)
    return SignalEnvelope(
        event_ts=event_ts,
        symbol='META',
        timeframe='1Sec',
        seq=1,
        source='ta',
        payload={
            'price': price,
            'spread': ask - bid,
            'imbalance_bid_px': bid,
            'imbalance_ask_px': ask,
            'imbalance_bid_sz': bid_sz,
            'imbalance_ask_sz': ask_sz,
            'vwap_w5m': price,
        },
    )


@given(previous_close=positive_prices(), premarket_price=positive_prices())
def test_premarket_tick_never_sets_regular_session_open_anchor(
    previous_close: Decimal,
    premarket_price: Decimal,
) -> None:
    tracker = SessionContextTracker()
    executable_previous_close_spread = max(
        Decimal('0.0001'),
        previous_close * Decimal('0.0005'),
    )
    tracker.enrich_signal_payload(
        _session_signal(
            event_ts=datetime(2026, 3, 24, 19, 59, 0, tzinfo=timezone.utc),
            price=previous_close,
            spread=executable_previous_close_spread,
            bid_sz=Decimal('4000'),
            ask_sz=Decimal('3800'),
        )
    )
    premarket_payload = tracker.enrich_signal_payload(
        _session_signal(
            event_ts=datetime(2026, 3, 25, 12, 45, 0, tzinfo=timezone.utc),
            price=premarket_price,
            spread=Decimal('0.02'),
            bid_sz=Decimal('3900'),
            ask_sz=Decimal('4200'),
        )
    )

    assert 'session_open_price' not in premarket_payload
    assert premarket_payload['prev_session_close_price'] == previous_close


@given(signals=regular_session_signal_series())
def test_session_context_series_preserves_range_and_ratio_invariants(signals: list[SignalEnvelope]) -> None:
    tracker = SessionContextTracker()

    for signal in signals:
        payload = tracker.enrich_signal_payload(signal)
        if 'session_open_price' not in payload:
            continue
        assert payload['session_high_price'] >= payload['session_low_price']
        assert payload['opening_range_high'] >= payload['opening_range_low']
        if 'price_position_in_session_range' in payload:
            assert Decimal('0') <= payload['price_position_in_session_range'] <= Decimal('1')
        for ratio_key in (
            'recent_above_opening_range_high_ratio',
            'recent_above_opening_window_close_ratio',
            'recent_above_vwap_w5m_ratio',
        ):
            ratio = payload.get(ratio_key)
            if ratio is not None:
                assert Decimal('0') <= ratio <= Decimal('1')
        assert payload['session_minutes_elapsed'] >= 0
