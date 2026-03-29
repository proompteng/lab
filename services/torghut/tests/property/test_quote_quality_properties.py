from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.trading.models import SignalEnvelope
from app.trading.quote_quality import assess_signal_quote_quality
from tests.strategies.signals import crossed_quote_signals, valid_quote_signals
from tests.strategies.trading import positive_prices

pytestmark = pytest.mark.property


@given(signal=valid_quote_signals())
def test_tight_positive_quotes_remain_executable(signal: SignalEnvelope) -> None:
    previous_price = Decimal(signal.payload['price'])

    status = assess_signal_quote_quality(
        signal=signal,
        previous_price=previous_price,
    )

    assert status.valid is True
    assert status.reason is None
    assert status.spread_bps is not None
    assert status.spread_bps >= 0


@given(signal=crossed_quote_signals())
def test_crossed_quotes_always_reject(signal: SignalEnvelope) -> None:
    status = assess_signal_quote_quality(
        signal=signal,
        previous_price=Decimal('100'),
    )

    assert status.valid is False
    assert status.reason == 'crossed_quote'


@given(ask=positive_prices())
def test_zero_top_level_bid_does_not_fall_back_to_nested_bid(ask: Decimal) -> None:
    signal = SignalEnvelope(
        event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
        symbol='META',
        timeframe='1Sec',
        seq=14,
        payload={
            'price': ask,
            'imbalance_bid_px': Decimal('0'),
            'imbalance_ask_px': ask,
            'imbalance': {
                'bid_px': ask - Decimal('0.01'),
                'ask_px': ask,
            },
        },
    )

    status = assess_signal_quote_quality(
        signal=signal,
        previous_price=ask,
    )

    assert status.valid is False
    assert status.reason == 'non_positive_bid'


@given(
    bid=st.decimals(
        min_value=Decimal('-10'),
        max_value=Decimal('0'),
        allow_nan=False,
        allow_infinity=False,
        places=4,
    ),
    ask=positive_prices(),
)
def test_non_positive_bid_is_never_executable(bid: Decimal, ask: Decimal) -> None:
    signal = SignalEnvelope(
        event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
        symbol='META',
        timeframe='1Sec',
        seq=99,
        payload={
            'price': ask,
            'imbalance_bid_px': bid,
            'imbalance_ask_px': ask,
            'spread': ask - bid,
        },
    )

    status = assess_signal_quote_quality(
        signal=signal,
        previous_price=ask,
    )

    assert status.valid is False
    assert status.reason == 'non_positive_bid'
