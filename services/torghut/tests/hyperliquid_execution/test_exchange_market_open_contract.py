"""Focused regressions for Hyperliquid market-open entry submission."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import HyperliquidSdkExecutionExchange
from app.hyperliquid_execution.models import OrderIntent


def test_exchange_rejects_reduce_only_entry_submission() -> None:
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            }
        ),
        sdk=_FakeSdk(),
    )

    result = exchange.submit_order(_intent(reduce_only=True))

    assert result.rejection_reason == "reduce_only_entry_orders_unsupported"


def test_exchange_rejects_non_positive_order_price_before_market_open() -> None:
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

    with pytest.raises(ValueError, match="order_price_must_be_positive"):
        exchange.submit_order(_intent(limit_price=Decimal("0")))

    assert sdk.market_opens == []


class _FakeSdk:
    def __init__(self) -> None:
        self.market_opens: list[dict[str, object]] = []

    def market_open(self, **kwargs: object) -> dict[str, object]:
        self.market_opens.append(dict(kwargs))
        return {"response": {"data": {"statuses": [{"resting": {"oid": 123}}]}}}


class _FakeExchange(HyperliquidSdkExecutionExchange):
    def __init__(self, config: HyperliquidExecutionConfig, *, sdk: _FakeSdk) -> None:
        super().__init__(config)
        self._sdk = sdk

    def _exchange(self) -> _FakeSdk:
        return self._sdk

    def _cloid(self, raw: str) -> str:
        return raw


def _intent(
    *,
    reduce_only: bool = False,
    limit_price: Decimal = Decimal("100.1234567"),
) -> OrderIntent:
    return OrderIntent(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        side="buy",
        size=Decimal("0.1234"),
        limit_price=limit_price,
        notional_usd=Decimal("12.34"),
        cloid="0xabc",
        tif="Ioc",
        reduce_only=reduce_only,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc),
    )
