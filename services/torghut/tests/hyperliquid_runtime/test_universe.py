from __future__ import annotations

from decimal import Decimal

from app.hyperliquid_runtime.universe import classify_asset, select_runtime_markets


def test_classifies_equity_like_perps_only() -> None:
    assert classify_asset(coin="cash:AAPL", dex="cash") == "stocks"
    assert classify_asset(coin="xyz:AAPL", dex="xyz") == "stocks"
    assert classify_asset(coin="USA500", dex="default") == "indices"
    assert classify_asset(coin="xyz:SP500", dex="xyz") == "indices"
    assert classify_asset(coin="OPENAI", dex="xyz") == "preipo"
    assert classify_asset(coin="xyz:OPENAI", dex="xyz") == "preipo"
    assert classify_asset(coin="BTC", dex="default") == "crypto"
    assert classify_asset(coin="HYPE", dex="default") == "crypto"
    assert classify_asset(coin="GOLD", dex="cash") is None
    assert classify_asset(coin="xyz:BRENTOIL", dex="xyz") is None
    assert classify_asset(coin="xyz:JPY", dex="xyz") is None
    assert classify_asset(coin="xyz:NOTVETTED", dex="xyz") is None


def test_selects_liquid_allowed_markets_by_volume() -> None:
    rows = [
        {
            "market_type": "perp",
            "market_id": "hl:perp:cash:cash:AAPL",
            "coin": "cash:AAPL",
            "dex": "cash",
            "payload": '{"dayNtlVlm":"500000","markPx":"210","openInterest":"100000"}',
        },
        {
            "market_type": "perp",
            "market_id": "hl:perp:default:BTC",
            "coin": "BTC",
            "dex": "default",
            "payload": '{"dayNtlVlm":"9000000"}',
        },
        {
            "market_type": "perp",
            "market_id": "hl:perp:xyz:OPENAI",
            "coin": "OPENAI",
            "dex": "xyz",
            "payload": '{"dayNtlVlm":"800000","markPx":"80"}',
        },
    ]

    markets = select_runtime_markets(
        rows,
        market_data_network="mainnet",
        allowed_asset_classes=("crypto", "stocks", "preipo"),
        min_day_notional_volume_usd=Decimal("100000"),
        max_markets=10,
    )

    assert [market.market_id for market in markets] == [
        "hl:perp:default:BTC",
        "hl:perp:xyz:OPENAI",
        "hl:perp:cash:cash:AAPL",
    ]
    assert {market.asset_class for market in markets} == {"crypto", "stocks", "preipo"}
