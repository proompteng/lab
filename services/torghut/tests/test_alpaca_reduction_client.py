from __future__ import annotations

from decimal import Decimal
from unittest import TestCase
from unittest.mock import Mock

from alpaca.trading.requests import ClosePositionRequest, ReplaceOrderRequest

from app.alpaca_client import TorghutAlpacaClient, issue_order_firewall_token


class _Model:
    def __init__(self, **values: object) -> None:
        for key, value in values.items():
            setattr(self, key, value)

    def model_dump(self) -> dict[str, object]:
        return dict(vars(self))


class _ReductionTradingClient:
    def __init__(self) -> None:
        self.replaced: list[tuple[str, ReplaceOrderRequest]] = []
        self.closed: list[tuple[str, ClosePositionRequest]] = []
        self.close_all_cancel_orders: list[bool] = []

    def replace_order_by_id(
        self,
        order_id: str,
        order_data: ReplaceOrderRequest,
    ) -> _Model:
        self.replaced.append((order_id, order_data))
        return _Model(id="replacement-1", status="accepted")

    def close_position(
        self,
        symbol_or_asset_id: str,
        close_options: ClosePositionRequest,
    ) -> _Model:
        self.closed.append((symbol_or_asset_id, close_options))
        return _Model(id="close-1", status="accepted")

    def close_all_positions(self, cancel_orders: bool = False) -> list[_Model]:
        self.close_all_cancel_orders.append(cancel_orders)
        return [
            _Model(
                body={"id": "close-1", "status": "accepted"},
                order_id=None,
                status=200,
                symbol="AAPL",
            )
        ]


class TestAlpacaReductionClient(TestCase):
    def test_reduction_wrappers_build_exact_sdk_requests_behind_capability(
        self,
    ) -> None:
        trading_client = _ReductionTradingClient()
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=trading_client,
            data_client=Mock(),
        )
        token = issue_order_firewall_token()

        replacement = client.replace_order(
            "order-1",
            limit_price=101.25,
            firewall_token=token,
        )
        close = client.close_position(
            "AAPL",
            qty=Decimal("0.5"),
            firewall_token=token,
        )
        close_all = client.close_all_positions(firewall_token=token)

        self.assertEqual(replacement["id"], "replacement-1")
        self.assertEqual(trading_client.replaced[0][0], "order-1")
        self.assertEqual(trading_client.replaced[0][1].limit_price, 101.25)
        self.assertEqual(close["id"], "close-1")
        self.assertEqual(trading_client.closed[0][0], "AAPL")
        self.assertEqual(trading_client.closed[0][1].qty, "0.5")
        self.assertIsNone(close_all[0]["order_id"])
        self.assertEqual(close_all[0]["status"], 200)
        self.assertEqual(close_all[0]["body"]["id"], "close-1")
        self.assertEqual(trading_client.close_all_cancel_orders, [False])

    def test_close_position_uses_exact_broker_position_symbol(self) -> None:
        trading_client = _ReductionTradingClient()
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=trading_client,
            data_client=Mock(),
        )

        client.close_position(
            "BTCUSD",
            qty=Decimal("0.0002"),
            firewall_token=issue_order_firewall_token(),
        )

        self.assertEqual(trading_client.closed[0][0], "BTCUSD")
        self.assertEqual(trading_client.closed[0][1].qty, "0.0002")

    def test_close_position_rejects_canonical_crypto_pair(self) -> None:
        trading_client = _ReductionTradingClient()
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=trading_client,
            data_client=Mock(),
        )

        with self.assertRaisesRegex(
            ValueError,
            "alpaca_close_position_broker_symbol_required",
        ):
            client.close_position(
                "BTC/USD",
                qty=Decimal("0.0002"),
                firewall_token=issue_order_firewall_token(),
            )

        self.assertEqual(trading_client.closed, [])
