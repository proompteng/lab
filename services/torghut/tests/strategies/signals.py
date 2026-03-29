from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from hypothesis import strategies as st

from app.trading.models import SignalEnvelope

from .trading import (
    equity_symbols,
    executable_spread_bps,
    non_negative_spreads,
    positive_prices,
    size_decimals,
    utc_datetimes,
)


@st.composite
def valid_quote_signals(draw: Any, *, symbol: str | None = None) -> SignalEnvelope:
    resolved_symbol = symbol or draw(equity_symbols())
    price = draw(positive_prices())
    spread_bps = draw(executable_spread_bps())
    spread = (price * spread_bps) / Decimal('10000')
    half_spread = spread / 2
    bid = price - half_spread
    ask = price + half_spread
    if bid <= 0:
        bid = Decimal('0.0001')
        ask = bid + spread
        price = (bid + ask) / 2
    event_ts = draw(utc_datetimes())
    bid_sz = draw(size_decimals())
    ask_sz = draw(size_decimals())
    return SignalEnvelope(
        event_ts=event_ts,
        symbol=resolved_symbol,
        timeframe='1Sec',
        seq=draw(st.integers(min_value=1, max_value=1_000_000)),
        source='ta',
        payload={
            'price': price,
            'spread': ask - bid,
            'imbalance_bid_px': bid,
            'imbalance_ask_px': ask,
            'imbalance_bid_sz': bid_sz,
            'imbalance_ask_sz': ask_sz,
            'vwap_w5m': price,
            'macd': Decimal('0.5'),
            'macd_signal': Decimal('0.2'),
            'rsi14': Decimal('55'),
        },
    )


@st.composite
def crossed_quote_signals(draw: Any, *, symbol: str | None = None) -> SignalEnvelope:
    resolved_symbol = symbol or draw(equity_symbols())
    base_price = draw(positive_prices())
    positive_offset = draw(non_negative_spreads().filter(lambda value: value > 0))
    ask = base_price
    bid = base_price + positive_offset
    return SignalEnvelope(
        event_ts=draw(utc_datetimes()),
        symbol=resolved_symbol,
        timeframe='1Sec',
        seq=draw(st.integers(min_value=1, max_value=1_000_000)),
        source='ta',
        payload={
            'price': (bid + ask) / 2,
            'spread': ask - bid,
            'imbalance_bid_px': bid,
            'imbalance_ask_px': ask,
            'macd': Decimal('0.5'),
            'macd_signal': Decimal('0.2'),
            'rsi14': Decimal('55'),
        },
    )


@st.composite
def regular_session_signal_series(draw: Any) -> list[SignalEnvelope]:
    symbol = draw(equity_symbols())
    day = draw(st.dates(min_value=datetime(2026, 1, 1).date(), max_value=datetime(2026, 12, 31).date()))
    minutes = draw(
        st.lists(
            st.integers(min_value=0, max_value=180),
            min_size=1,
            max_size=12,
            unique=True,
        ).map(sorted)
    )
    prices = draw(st.lists(positive_prices(), min_size=len(minutes), max_size=len(minutes)))
    spreads = draw(st.lists(non_negative_spreads(), min_size=len(minutes), max_size=len(minutes)))
    bid_sizes = draw(st.lists(size_decimals(), min_size=len(minutes), max_size=len(minutes)))
    ask_sizes = draw(st.lists(size_decimals(), min_size=len(minutes), max_size=len(minutes)))
    signals: list[SignalEnvelope] = []
    for index, minute in enumerate(minutes, start=1):
        price = prices[index - 1]
        spread = spreads[index - 1]
        bid = price - (spread / 2)
        ask = price + (spread / 2)
        if bid <= 0:
            bid = Decimal('0.0001')
            ask = bid + spread
            price = (bid + ask) / 2
        event_ts = datetime(day.year, day.month, day.day, 13, 30, tzinfo=timezone.utc) + timedelta(
            minutes=minute,
            seconds=index % 60,
        )
        signals.append(
            SignalEnvelope(
                event_ts=event_ts,
                symbol=symbol,
                timeframe='1Sec',
                seq=index,
                source='ta',
                payload={
                    'price': price,
                    'spread': ask - bid,
                    'imbalance_bid_px': bid,
                    'imbalance_ask_px': ask,
                    'imbalance_bid_sz': bid_sizes[index - 1],
                    'imbalance_ask_sz': ask_sizes[index - 1],
                    'vwap_w5m': price,
                },
            )
        )
    return signals


@st.composite
def feature_contract_signals(draw: Any) -> SignalEnvelope:
    signal = draw(valid_quote_signals())
    payload = dict(signal.payload)
    payload.update(
        {
            'vwap_session': draw(positive_prices()),
            'vwap_w5m': draw(positive_prices()),
            'recent_quote_invalid_ratio': draw(st.decimals(min_value=Decimal('0'), max_value=Decimal('1'), allow_nan=False, allow_infinity=False, places=4)),
            'cross_section_prev_session_close_rank': draw(st.decimals(min_value=Decimal('0'), max_value=Decimal('1'), allow_nan=False, allow_infinity=False, places=4)),
            'cross_section_positive_session_open_ratio': draw(st.decimals(min_value=Decimal('0'), max_value=Decimal('1'), allow_nan=False, allow_infinity=False, places=4)),
        }
    )
    return signal.model_copy(update={'payload': payload})
