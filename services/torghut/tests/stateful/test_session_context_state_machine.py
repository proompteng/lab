from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

import pytest
from hypothesis import settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule, run_state_machine_as_test

from app.trading.models import SignalEnvelope
from app.trading.session_context import SessionContextTracker
from tests.strategies.trading import non_negative_spreads, positive_prices, size_decimals

pytestmark = [pytest.mark.property, pytest.mark.stateful]


def _signal(
    *,
    day: date,
    event_time: time,
    price: Decimal,
    spread: Decimal,
    bid_sz: Decimal,
    ask_sz: Decimal,
) -> SignalEnvelope:
    bid = price - (spread / 2)
    ask = price + (spread / 2)
    if bid <= 0:
        bid = Decimal('0.0001')
        ask = bid + spread
        price = (bid + ask) / 2
    return SignalEnvelope(
        event_ts=datetime.combine(day, event_time, tzinfo=timezone.utc),
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


class SessionContextStateMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.tracker = SessionContextTracker()
        self.current_day = date(2026, 3, 24)
        self.expected_prev_close: Decimal | None = None
        self.expected_open_price: Decimal | None = None
        self.opened_today = False
        self.closed_today = False
        self.last_payload: dict[str, object] | None = None

    @precondition(lambda self: self.opened_today and not self.closed_today)
    @rule(price=positive_prices(), spread=non_negative_spreads(), bid_sz=size_decimals(), ask_sz=size_decimals())
    def close_session(self, price: Decimal, spread: Decimal, bid_sz: Decimal, ask_sz: Decimal) -> None:
        self.last_payload = self.tracker.enrich_signal_payload(
            _signal(
                day=self.current_day,
                event_time=time(19, 59),
                price=price,
                spread=spread,
                bid_sz=bid_sz,
                ask_sz=ask_sz,
            )
        )
        state = self.tracker._state_by_symbol['META']
        self.expected_prev_close = (
            state.last_valid_quote_price
            or state.opening_window_close_price
            or state.session_open_price
        )
        self.closed_today = True

    @precondition(lambda self: self.closed_today or self.last_payload is None)
    @rule()
    def advance_day(self) -> None:
        self.current_day = self.current_day + timedelta(days=1)
        self.expected_open_price = None
        self.opened_today = False
        self.closed_today = False
        self.last_payload = None

    @precondition(lambda self: not self.opened_today and not self.closed_today)
    @rule(price=positive_prices(), spread=non_negative_spreads(), bid_sz=size_decimals(), ask_sz=size_decimals())
    def premarket_tick(self, price: Decimal, spread: Decimal, bid_sz: Decimal, ask_sz: Decimal) -> None:
        payload = self.tracker.enrich_signal_payload(
            _signal(
                day=self.current_day,
                event_time=time(12, 45),
                price=price,
                spread=spread,
                bid_sz=bid_sz,
                ask_sz=ask_sz,
            )
        )
        self.last_payload = payload
        assert 'session_open_price' not in payload
        if self.expected_prev_close is not None:
            assert payload['prev_session_close_price'] == self.expected_prev_close

    @precondition(lambda self: not self.closed_today)
    @rule(price=positive_prices(), spread=non_negative_spreads(), bid_sz=size_decimals(), ask_sz=size_decimals())
    def regular_open_tick(self, price: Decimal, spread: Decimal, bid_sz: Decimal, ask_sz: Decimal) -> None:
        payload = self.tracker.enrich_signal_payload(
            _signal(
                day=self.current_day,
                event_time=time(13, 30, 5),
                price=price,
                spread=spread,
                bid_sz=bid_sz,
                ask_sz=ask_sz,
            )
        )
        if not self.opened_today:
            self.expected_open_price = payload['session_open_price']
            self.opened_today = True
        self.last_payload = payload
        assert payload['session_open_price'] == self.expected_open_price

    @precondition(lambda self: not self.closed_today)
    @rule(
        price=positive_prices(),
        spread=non_negative_spreads(),
        bid_sz=size_decimals(),
        ask_sz=size_decimals(),
        minute_offset=st.integers(min_value=1, max_value=180),
    )
    def regular_session_tick(
        self,
        price: Decimal,
        spread: Decimal,
        bid_sz: Decimal,
        ask_sz: Decimal,
        minute_offset: int,
    ) -> None:
        if not self.opened_today:
            self.regular_open_tick(price, spread, bid_sz, ask_sz)
            return
        payload = self.tracker.enrich_signal_payload(
            _signal(
                day=self.current_day,
                event_time=(datetime(2026, 1, 1, 13, 30, tzinfo=timezone.utc) + timedelta(minutes=minute_offset)).time(),
                price=price,
                spread=spread,
                bid_sz=bid_sz,
                ask_sz=ask_sz,
            )
        )
        self.last_payload = payload
        assert payload['session_open_price'] == self.expected_open_price

    @invariant()
    def payload_invariants_hold(self) -> None:
        if self.last_payload is None or 'session_open_price' not in self.last_payload:
            return
        payload = self.last_payload
        assert payload['session_high_price'] >= payload['session_low_price']
        assert payload['opening_range_high'] >= payload['opening_range_low']
        if 'price_position_in_session_range' in payload:
            assert Decimal('0') <= payload['price_position_in_session_range'] <= Decimal('1')


def test_session_context_state_machine() -> None:
    run_state_machine_as_test(
        SessionContextStateMachine,
        settings=settings(max_examples=20, stateful_step_count=20, deadline=None),
    )
