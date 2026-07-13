"""Service regressions for persisted exchange-normalized order intents."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.models import OrderIntent, OrderResult
from app.hyperliquid_execution.service import HyperliquidExecutionService
from tests.hyperliquid_execution.test_runtime_surfaces import (
    _FakeSession,
    _ServiceExchange,
    _ServiceFeed,
    _now,
)


def test_service_persists_exchange_normalized_order_intent() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    session = _FakeSession()
    exchange = _NormalizingServiceExchange(now)
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=exchange,
    )

    result = service.run_once(session)

    assert result.orders_submitted == 1
    assert exchange.validated_intents == exchange.submitted_intents
    assert exchange.submitted_intents[0].size == Decimal("0.2")
    assert exchange.submitted_intents[0].limit_price == Decimal("101.000000")
    assert exchange.submitted_intents[0].notional_usd == Decimal("20.200000")
    order_params = next(
        params
        for sql, params in session.calls
        if "INSERT INTO hyperliquid_execution_orders" in sql
    )
    assert order_params is not None
    assert order_params["size"] == "0.2"
    assert order_params["limit_price"] == "101.000000"
    assert order_params["notional_usd"] == "20.200000"
    multifactor_params = next(
        params
        for sql, params in session.calls
        if "INSERT INTO multifactor_execution_intents" in sql
    )
    assert multifactor_params is not None
    assert multifactor_params["notional_usd"] == "20.200000"


class _NormalizingServiceExchange(_ServiceExchange):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.submitted_intents: list[OrderIntent] = []
        self.validated_intents: list[OrderIntent] = []

    def normalize_order_intent(self, intent: OrderIntent) -> OrderIntent:
        return replace(
            intent,
            size=Decimal("0.2"),
            limit_price=Decimal("101.000000"),
            notional_usd=Decimal("20.200000"),
        )

    def submit_order(self, intent: OrderIntent) -> OrderResult:
        self.submitted_intents.append(intent)
        return super().submit_order(intent)

    def validate_order_intent_crossability(self, intent: OrderIntent) -> None:
        self.validated_intents.append(intent)
