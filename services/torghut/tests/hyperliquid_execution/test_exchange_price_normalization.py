"""Exchange price normalization regressions."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import (
    HyperliquidSdkExecutionExchange,
    _normalize_price,
)
from app.hyperliquid_execution.models import ExecutionMarket, OrderIntent, OrderSide


def test_exchange_normalizes_perp_price_to_hyperliquid_tick_rules() -> None:
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
    exchange.filter_supported_markets((_market("SOL"), _market("BTC")))

    sol = exchange.submit_order(_intent("SOL", limit_price=Decimal("82.164061")))
    btc_buy = exchange.submit_order(_intent("BTC", limit_price=Decimal("63369.669123")))
    btc_sell = exchange.submit_order(
        _intent("BTC", side="sell", limit_price=Decimal("63306.331123"))
    )

    assert sol.status == "accepted"
    assert btc_buy.status == "accepted"
    assert btc_sell.status == "accepted"
    assert sdk.orders[0]["limit_px"] == 82.164
    assert sdk.orders[1]["limit_px"] == 63369.0
    assert sdk.orders[2]["limit_px"] == 63307.0


def test_exchange_rejects_non_positive_order_price() -> None:
    with pytest.raises(ValueError, match="order_price_must_be_positive"):
        _normalize_price(Decimal("0"), side="buy", size_decimals=2)


def test_exchange_rejects_price_below_exchange_precision() -> None:
    with pytest.raises(ValueError, match="order_price_below_exchange_precision"):
        _normalize_price(Decimal("0.1"), side="buy", size_decimals=6)


class _FakeSdk:
    def __init__(self) -> None:
        self.orders: list[dict[str, object]] = []

    def order(self, **kwargs: object) -> dict[str, object]:
        self.orders.append(dict(kwargs))
        return {"response": {"data": {"statuses": [{"resting": {"oid": 123}}]}}}


class _FakeInfo:
    def meta(self, *, dex: str = "") -> dict[str, object]:
        return {
            "universe": [
                {"name": "SOL", "szDecimals": 2, "maxLeverage": 10},
                {"name": "BTC", "szDecimals": 3, "maxLeverage": 40},
            ]
        }


class _FakeExchange(HyperliquidSdkExecutionExchange):
    def __init__(self, config: HyperliquidExecutionConfig, *, sdk: _FakeSdk) -> None:
        super().__init__(config)
        self._sdk = sdk
        self._fake_info = _FakeInfo()

    def _exchange(self) -> _FakeSdk:
        return self._sdk

    def _info(self) -> _FakeInfo:
        return self._fake_info

    def _cloid(self, raw: str) -> str:
        return raw


def _intent(
    coin: str,
    *,
    side: OrderSide = "buy",
    limit_price: Decimal,
) -> OrderIntent:
    return OrderIntent(
        market_id=f"hl:perp:default:{coin}",
        coin=coin,
        dex="default",
        side=side,
        size=Decimal("0.1234"),
        limit_price=limit_price,
        notional_usd=Decimal("12.34"),
        cloid="0xabc",
        tif="Ioc",
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc),
    )


def _market(coin: str) -> ExecutionMarket:
    return ExecutionMarket(
        market_id=f"hl:perp:default:{coin}",
        coin=coin,
        dex="default",
        network="mainnet",
        day_notional_volume_usd=Decimal("1000"),
    )
