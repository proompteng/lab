"""Focused Hyperliquid order submission regressions."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.models import OpenOrder, OrderIntent
from tests.hyperliquid_execution.test_exchange_policy import (
    _FakeExchange,
    _FakeSdk,
    _market,
)


def test_exchange_submits_ioc_order() -> None:
    sdk = _FakeSdk()
    sdk.next_order_response = {
        "response": {"data": {"statuses": [{"filled": {"oid": 123}}]}}
    }
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
                "HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "50",
            }
        ),
        sdk=sdk,
    )
    intent = OrderIntent(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        side="buy",
        size=Decimal("1"),
        limit_price=Decimal("10"),
        notional_usd=Decimal("10"),
        cloid="0xabc",
        tif="Ioc",
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc),
    )

    result = exchange.submit_order(intent)

    assert result.status == "filled"
    assert result.exchange_order_id == "123"
    assert sdk.market_opens == [
        {
            "name": "xyz:NVDA",
            "is_buy": True,
            "sz": 1.0,
            "px": 10.0,
            "slippage": 0.0,
            "cloid": "0xabc",
        }
    ]


def test_exchange_rounds_size_up_after_exchange_precision_normalization() -> None:
    sdk = _FakeSdk()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            }
        ),
        sdk=sdk,
    )
    exchange.filter_supported_markets((_market("NVDA", "xyz"),))
    intent = OrderIntent(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        side="buy",
        size=Decimal("0.1999"),
        limit_price=Decimal("50"),
        notional_usd=Decimal("9.995"),
        cloid="0xabc",
        tif="Ioc",
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc),
    )

    result = exchange.submit_order(intent)

    assert result.status == "accepted"
    assert sdk.market_opens[0]["sz"] == 0.2


def test_exchange_cancels_by_oid() -> None:
    sdk = _FakeSdk()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1"}
        ),
        sdk=sdk,
    )
    order = OpenOrder(
        order_id="order",
        coin="NVDA",
        dex="xyz",
        exchange_order_id="123",
        cloid="0xabc",
        status="accepted",
        expires_at=datetime.now(timezone.utc),
    )

    result = exchange.cancel_order(order)

    assert result.status == "cancelled"
    assert sdk.cancels == [("xyz:NVDA", 123)]
