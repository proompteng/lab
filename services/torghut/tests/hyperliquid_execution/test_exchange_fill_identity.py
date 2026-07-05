"""Fill identity regressions for the Hyperliquid execution exchange."""

from __future__ import annotations

from app.hyperliquid_execution.exchange import _fill_from_payload


def test_exchange_fill_identity_prefers_trade_id_over_order_hash() -> None:
    fill = _fill_from_payload(
        {
            "coin": "NVDA",
            "px": "100",
            "sz": "0.1",
            "fee": "0.01",
            "closedPnl": "0.50",
            "oid": "123",
            "hash": "order-hash",
            "tid": "trade-1",
            "side": "B",
            "time": "1781870400000",
        },
        {"NVDA": "hl:perp:xyz:NVDA"},
    )

    assert fill.fill_hash == "trade-1"
