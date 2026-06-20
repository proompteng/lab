"""Fake exchange tests for maker order behavior."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import HyperliquidSdkExecutionExchange
from app.hyperliquid_execution.models import ExecutionMarket, OpenOrder, OrderIntent


def test_exchange_submits_alo_maker_order() -> None:
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
    intent = OrderIntent(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        side="buy",
        size=Decimal("1"),
        limit_price=Decimal("10"),
        notional_usd=Decimal("10"),
        cloid="0xabc",
        tif="Alo",
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc),
    )

    result = exchange.submit_maker_order(intent)

    assert result.status == "accepted"
    assert result.exchange_order_id == "123"
    assert sdk.orders[0]["order_type"] == {"limit": {"tif": "Alo"}}
    assert sdk.orders[0]["limit_px"] == 10.0


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
        tif="Alo",
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc),
    )

    result = exchange.submit_maker_order(intent)

    assert result.status == "accepted"
    assert sdk.orders[0]["sz"] == 0.2


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
    assert sdk.cancels == [("NVDA", 123)]


def test_exchange_filters_metadata_reconciles_account_and_tracks_halts() -> None:
    sdk = _FakeSdk()
    info = _FakeInfo()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            }
        ),
        sdk=sdk,
        info=info,
    )
    markets = (
        _market("NVDA", "xyz"),
        _market("OLD", "xyz"),
        _market("HALT", "xyz"),
    )

    selected, status = exchange.filter_supported_markets(markets)
    assert [market.coin for market in selected] == ["NVDA", "HALT"]
    assert status.ready is True
    assert "OLD" in status.details["delisted"]

    halted_intent = _intent("HALT")
    sdk.next_order_response = {
        "response": {"data": {"statuses": [{"error": "Trading is halted."}]}}
    }
    halted = exchange.submit_maker_order(halted_intent)
    assert halted.status == "rejected"

    selected_after_halt, status_after_halt = exchange.filter_supported_markets(markets)
    assert [market.coin for market in selected_after_halt] == ["NVDA"]
    assert "HALT" in status_after_halt.details["halted"]

    fills = exchange.reconcile_fills({"NVDA": "hl:perp:xyz:NVDA"})
    account = exchange.reconcile_account({"NVDA": "hl:perp:xyz:NVDA"})
    open_coins = exchange.reconcile_open_order_coins(frozenset({"NVDA"}))
    dependency = exchange.dependency_status()

    assert fills[0].notional_usd == Decimal("10.000000")
    assert account.account.gross_exposure_usd == Decimal("10.000000")
    assert open_coins == frozenset({"NVDA"})
    assert dependency.ready is True
    assert exchange.execution_metadata_details()


def test_exchange_rejects_non_alo_missing_key_and_local_cancel() -> None:
    exchange = _FakeExchange(HyperliquidExecutionConfig.from_env({}), sdk=_FakeSdk())

    non_alo = exchange.submit_maker_order(_intent("NVDA", tif="Ioc"))
    missing_key = exchange.submit_maker_order(_intent("NVDA"))
    local_cancel = exchange.cancel_order(
        OpenOrder(
            order_id="order",
            coin="NVDA",
            dex="xyz",
            exchange_order_id=None,
            cloid="0xabc",
            status="accepted",
            expires_at=datetime.now(timezone.utc),
        )
    )

    assert non_alo.rejection_reason == "non_alo_order_policy_rejected"
    assert missing_key.rejection_reason == "api_wallet_private_key_missing"
    assert local_cancel.rejection_reason == "missing_exchange_order_id"


class _FakeSdk:
    def __init__(self) -> None:
        self.orders: list[dict[str, Any]] = []
        self.cancels: list[tuple[str, int]] = []
        self.next_order_response: dict[str, object] = {
            "response": {"data": {"statuses": [{"resting": {"oid": 123}}]}}
        }

    def order(self, **kwargs: object) -> dict[str, object]:
        self.orders.append(dict(kwargs))
        return self.next_order_response

    def cancel(self, name: str, oid: int) -> dict[str, object]:
        self.cancels.append((name, oid))
        return {"status": "ok"}


class _FakeInfo:
    def meta(self, *, dex: str = "") -> dict[str, object]:
        if dex == "xyz":
            return {
                "universe": [
                    {"name": "NVDA", "szDecimals": 2},
                    {"name": "OLD", "isDelisted": True, "szDecimals": 2},
                    {"name": "HALT", "szDecimals": 2},
                ]
            }
        return {"universe": [{"name": "BTC", "szDecimals": 3}]}

    def user_fills(self, _account: str) -> list[dict[str, object]]:
        return [
            {
                "coin": "NVDA",
                "px": "100",
                "sz": "0.1",
                "fee": "0.01",
                "closedPnl": "0.50",
                "oid": "123",
                "hash": "fill-1",
                "side": "B",
                "time": "1781870400000",
            },
            {"coin": "BTC", "px": "100", "sz": "1"},
        ]

    def user_state(self, _account: str) -> dict[str, object]:
        return {
            "marginSummary": {"accountValue": "1000"},
            "withdrawable": "900",
            "assetPositions": [
                {
                    "position": {
                        "coin": "NVDA",
                        "szi": "0.1",
                        "entryPx": "100",
                        "unrealizedPnl": "0.25",
                    }
                },
                {"position": {"coin": "BTC", "szi": "1", "entryPx": "10"}},
            ],
        }

    def open_orders(self, _account: str, *, dex: str = "") -> list[dict[str, object]]:
        return [{"coin": "NVDA"}] if dex == "xyz" else [{"coin": "BTC"}]


class _FakeExchange(HyperliquidSdkExecutionExchange):
    def __init__(
        self,
        config: HyperliquidExecutionConfig,
        *,
        sdk: _FakeSdk,
        info: _FakeInfo | None = None,
    ) -> None:
        super().__init__(config)
        self._sdk = sdk
        self._fake_info = info or _FakeInfo()

    def _exchange(self) -> _FakeSdk:
        return self._sdk

    def _info(self) -> _FakeInfo:
        return self._fake_info

    def _cloid(self, raw: str) -> str:
        return raw


def _intent(coin: str, *, tif: str = "Alo") -> OrderIntent:
    return OrderIntent(
        market_id=f"hl:perp:xyz:{coin}",
        coin=coin,
        dex="xyz",
        side="buy",
        size=Decimal("0.1234"),
        limit_price=Decimal("100.1234567"),
        notional_usd=Decimal("12.34"),
        cloid="0xabc",
        tif=tif,
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=45),
    )


def _market(coin: str, dex: str) -> ExecutionMarket:
    return ExecutionMarket(
        market_id=f"hl:perp:{dex}:{coin}",
        coin=coin,
        dex=dex,
        network="mainnet",
        day_notional_volume_usd=Decimal("1000"),
    )
