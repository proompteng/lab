from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from hypothesis import strategies as st

from app.trading.models import SignalEnvelope, StrategyDecision
from scripts.local_intraday_tsmom_replay import PendingOrder, PositionState

from .trading import (
    equity_symbols,
    positive_prices,
    utc_datetimes,
)


@st.composite
def replay_signals(draw: Any, *, symbol: str | None = None) -> SignalEnvelope:
    resolved_symbol = symbol or draw(equity_symbols())
    price = draw(positive_prices())
    spread = draw(
        st.decimals(
            min_value=Decimal("0.0000"),
            max_value=Decimal("1.0000"),
            allow_nan=False,
            allow_infinity=False,
            places=4,
        )
    )
    bid = price - (spread / 2)
    ask = price + (spread / 2)
    if bid <= 0:
        bid = Decimal("0.0001")
        ask = bid + spread
        price = (bid + ask) / 2
    return SignalEnvelope(
        event_ts=draw(utc_datetimes()),
        symbol=resolved_symbol,
        timeframe="1Sec",
        seq=draw(st.integers(min_value=1, max_value=1_000_000)),
        source="ta",
        payload={
            "price": price,
            "imbalance_bid_px": bid,
            "imbalance_ask_px": ask,
            "spread": ask - bid,
        },
    )


def position_state(
    *, strategy_id: str, qty: Decimal, entry_price: Decimal, event_ts: datetime
) -> PositionState:
    return PositionState(
        strategy_id=strategy_id,
        qty=qty,
        avg_entry_price=entry_price,
        opened_at=event_ts,
        entry_cost_total=Decimal("0"),
        decision_at=event_ts,
        pending_entry=False,
    )


def pending_order(
    *, decision: StrategyDecision, signal: SignalEnvelope
) -> PendingOrder:
    return PendingOrder(
        decision=decision,
        created_at=signal.event_ts,
        signal=signal,
    )
