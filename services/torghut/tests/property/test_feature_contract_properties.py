from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given

from app.trading.features import normalize_feature_vector_v3
from tests.strategies.signals import feature_contract_signals, valid_quote_signals

pytestmark = pytest.mark.property


@given(signal=valid_quote_signals())
def test_normalization_uses_top_level_midpoint_when_trade_price_missing(signal) -> None:
    payload = dict(signal.payload)
    payload.pop('price', None)
    payload['vwap_session'] = Decimal('999.0')
    payload['vwap_w5m'] = Decimal('998.0')
    rewritten = signal.model_copy(update={'payload': payload})

    feature_vector = normalize_feature_vector_v3(rewritten)
    expected_midpoint = (payload['imbalance_bid_px'] + payload['imbalance_ask_px']) / 2

    assert feature_vector.values['price'] == expected_midpoint


@given(signal=feature_contract_signals())
def test_normalization_preserves_rank_and_ratio_bounds(signal) -> None:
    feature_vector = normalize_feature_vector_v3(signal)

    assert Decimal('0') <= feature_vector.values['recent_quote_invalid_ratio'] <= Decimal('1')
    assert Decimal('0') <= feature_vector.values['cross_section_prev_session_close_rank'] <= Decimal('1')
    assert Decimal('0') <= feature_vector.values['cross_section_positive_session_open_ratio'] <= Decimal('1')


@given(signal=valid_quote_signals())
def test_zero_valued_top_level_fields_win_over_nested_fallback(signal) -> None:
    payload = dict(signal.payload)
    payload.update(
        {
            'spread': Decimal('0'),
            'imbalance_spread': Decimal('0'),
            'imbalance_bid_sz': Decimal('0'),
            'imbalance_ask_sz': Decimal('10'),
            'imbalance': {
                'spread': Decimal('0.5'),
                'bid_px': Decimal('98'),
                'ask_px': Decimal('102'),
                'bid_sz': Decimal('5'),
                'ask_sz': Decimal('5'),
            },
        }
    )
    rewritten = signal.model_copy(update={'payload': payload})

    feature_vector = normalize_feature_vector_v3(rewritten)

    assert feature_vector.values['spread'] == Decimal('0')
    assert feature_vector.values['imbalance_spread'] == Decimal('0')
    assert feature_vector.values['imbalance_bid_sz'] == Decimal('0')
    assert feature_vector.values['imbalance_ask_sz'] == Decimal('10')
