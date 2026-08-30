"""Focused regressions for Hyperliquid market-open entry submission."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import HyperliquidSdkExecutionExchange
from app.hyperliquid_execution.models import OrderIntent, OrderResult
from tests.broker_mutation_test_support import (
    hyperliquid_broker_mutation_test_permit,
)


def _submit(exchange: _FakeExchange, intent: OrderIntent) -> OrderResult:
    return exchange.submit_order(
        intent,
        mutation_permit=hyperliquid_broker_mutation_test_permit(exchange, intent),
    )


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

    result = _submit(exchange, _intent(reduce_only=True))

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
        _submit(exchange, _intent(limit_price=Decimal("0")))

    assert sdk.market_opens == []


def test_exchange_passes_hip3_scope_and_executable_price_to_market_open() -> None:
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

    result = _submit(exchange, _intent())

    assert result.status == "accepted"
    assert sdk.market_opens == [
        {
            "name": "xyz:NVDA",
            "is_buy": True,
            "sz": 0.1234,
            "px": 100.1234567,
            "slippage": 0.0,
            "cloid": "0xabc",
        }
    ]


def test_exchange_does_not_double_scope_pre_scoped_market_name() -> None:
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

    result = _submit(
        exchange,
        _intent(coin="xyz:NVDA", market_id="hl:perp:xyz:xyz:NVDA"),
    )

    assert result.status == "accepted"
    assert sdk.market_opens[0]["name"] == "xyz:NVDA"


def test_exchange_leaves_default_dex_market_name_unscoped() -> None:
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

    result = _submit(
        exchange,
        _intent(dex="default", market_id="hl:perp:default:NVDA"),
    )

    assert result.status == "accepted"
    assert sdk.market_opens[0]["name"] == "NVDA"


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
    coin: str = "NVDA",
    dex: str = "xyz",
    market_id: str = "hl:perp:xyz:NVDA",
) -> OrderIntent:
    return OrderIntent(
        market_id=market_id,
        coin=coin,
        dex=dex,
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
