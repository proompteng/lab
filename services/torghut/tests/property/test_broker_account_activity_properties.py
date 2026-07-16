from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from app.trading.broker_account_activities import (
    BrokerActivityObservation,
    BrokerStreamPosition,
    normalize_broker_account_activity,
    normalize_broker_trade_update,
)


@given(
    quantity=st.decimals(
        min_value="0.000001",
        max_value="1000000",
        places=6,
        allow_nan=False,
        allow_infinity=False,
    ),
    price=st.decimals(
        min_value="0.000001",
        max_value="1000000",
        places=6,
        allow_nan=False,
        allow_infinity=False,
    ),
    side=st.sampled_from(("buy", "sell")),
)
def test_equivalent_fill_shapes_have_one_digest_across_decimal_encodings(
    quantity: Decimal,
    price: Decimal,
    side: str,
) -> None:
    quantity_text = format(quantity, "f")
    price_text = format(price, "f")
    observed_at = datetime(2026, 7, 16, tzinfo=timezone.utc)
    observation = BrokerActivityObservation(
        environment="paper",
        account_label="paper-account",
        endpoint_fingerprint="a" * 64,
        observed_at=observed_at,
    )
    rest = normalize_broker_account_activity(
        {
            "activity_type": "FILL",
            "cum_qty": quantity_text,
            "id": "activity-1",
            "leaves_qty": "0",
            "order_id": "order-1",
            "price": price_text,
            "qty": quantity_text,
            "side": side,
            "symbol": "BTC/USD",
            "transaction_time": "2026-07-16T07:39:00.123456Z",
            "type": "fill",
        },
        observation=observation,
        source_page_token=None,
    )
    stream = normalize_broker_trade_update(
        {
            "stream": "trade_updates",
            "data": {
                "event": "fill",
                "event_id": "event-1",
                "order": {
                    "filled_qty": f"{quantity_text}0",
                    "id": "order-1",
                    "qty": f"{quantity_text}0",
                    "side": side,
                    "symbol": "BTCUSD",
                },
                "price": f"{price_text}0",
                "qty": f"{quantity_text}0",
                "timestamp": "2026-07-16T07:39:00.123456789Z",
            },
        },
        event_fingerprint="b" * 64,
        observation=observation,
        position=BrokerStreamPosition(
            topic="torghut.trade-updates.v2",
            partition=0,
            offset=1,
        ),
    )

    assert rest.normalized_economic_sha256 == stream.normalized_economic_sha256
