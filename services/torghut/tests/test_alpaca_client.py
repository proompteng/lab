from __future__ import annotations

import uuid
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from alpaca.data.requests import StockBarsRequest
from alpaca.trading.requests import GetOrdersRequest

from app.alpaca_client import OrderFirewallViolation, TorghutAlpacaClient
from app.alpaca_client import OrderFirewallToken
from app.config import settings
from app.trading.firewall import OrderFirewall


class DummyModel:
    def __init__(self, **data: Any) -> None:
        self._data = data

    def model_dump(self) -> dict[str, Any]:
        return self._data


class AttributeOnlyModel:
    def __init__(self) -> None:
        self.equity = "12000"
        self.cash = "3000"
        self._internal_cache = "hidden"


class DummyTradingClient:
    def __init__(self) -> None:
        self.cancelled: list[str] = []

    def get_account(self) -> DummyModel:
        return DummyModel(equity="10000", cash="5000", buying_power="20000")

    def get_all_positions(self) -> list[DummyModel]:
        return [DummyModel(symbol="AAPL", qty="1")]

    def get_asset(self, symbol_or_asset_id: str) -> DummyModel:
        return DummyModel(symbol=symbol_or_asset_id, tradable=True)

    def get_orders(self, filter: GetOrdersRequest | None = None) -> list[DummyModel]:
        return [DummyModel(id="order-1", symbol="AAPL", uuid_id=uuid.uuid4())]

    def get_order_by_id(self, order_id: str) -> DummyModel:
        return DummyModel(id=order_id, symbol="AAPL")

    def get_order_by_client_id(self, client_id: str) -> DummyModel:
        return DummyModel(id="order-xyz", client_order_id=client_id)

    def submit_order(self, order_data: Any) -> DummyModel:
        return DummyModel(
            id="order-123",
            symbol=order_data.symbol,
            side=str(order_data.side),
            qty=order_data.qty,
            type=str(order_data.type),
            time_in_force=str(order_data.time_in_force),
            status="accepted",
        )

    def cancel_order_by_id(self, order_id: str) -> None:
        self.cancelled.append(order_id)

    def cancel_orders(self) -> list[DummyModel]:
        return [DummyModel(id="order-1"), DummyModel(id="order-2")]


class DummyBarsResponse:
    def __init__(self, data: dict[str, list[DummyModel]]) -> None:
        self.data = data


class DummyDataClient:
    def __init__(self) -> None:
        self.requested: list[StockBarsRequest] = []

    def get_stock_bars(self, request_params: StockBarsRequest) -> DummyBarsResponse:
        self.requested.append(request_params)
        return DummyBarsResponse(
            data={"AAPL": [DummyModel(symbol="AAPL", open=1, close=2)]}
        )


class TestAlpacaClient(TestCase):
    def setUp(self) -> None:
        self.original_kill_switch = settings.trading_kill_switch_enabled
        settings.trading_kill_switch_enabled = False

    def tearDown(self) -> None:
        settings.trading_kill_switch_enabled = self.original_kill_switch

    def test_alpaca_client_basic_wrappers(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        account = client.get_account()
        self.assertEqual(account["equity"], "10000")

        positions = client.list_positions()
        self.assertEqual(positions[0]["symbol"], "AAPL")

        orders = client.list_open_orders()
        self.assertEqual(orders[0]["id"], "order-1")
        self.assertIsInstance(orders[0]["uuid_id"], str)

        all_orders = client.list_orders()
        self.assertEqual(all_orders[0]["symbol"], "AAPL")

        order = client.get_order("order-abc")
        self.assertEqual(order["id"], "order-abc")

        firewall = OrderFirewall(client)
        submitted = firewall.submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
        )
        self.assertEqual(submitted["status"], "accepted")

        bars = client.get_bars(symbols=["AAPL"], timeframe="1Min", lookback_bars=1)
        self.assertIn("AAPL", bars)
        self.assertEqual(len(bars["AAPL"]), 1)

        cancelled = firewall.cancel_all_orders()
        self.assertEqual(len(cancelled), 2)

    def test_attribute_only_model_payload_uses_public_vars(self) -> None:
        class AttributeOnlyTradingClient(DummyTradingClient):
            def get_account(self) -> AttributeOnlyModel:
                return AttributeOnlyModel()

        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=AttributeOnlyTradingClient(),
            data_client=DummyDataClient(),
        )

        self.assertEqual(
            client.get_account(),
            {
                "cash": "3000",
                "equity": "12000",
            },
        )

    def test_unsupported_model_payload_raises_type_error(self) -> None:
        class UnsupportedAccountTradingClient(DummyTradingClient):
            def get_account(self) -> object:
                return object()

        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=UnsupportedAccountTradingClient(),
            data_client=DummyDataClient(),
        )

        with self.assertRaisesRegex(TypeError, "Unsupported model type"):
            client.get_account()

    def test_get_order_by_client_order_id_uses_alpaca_client_id_lookup(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        order = client.get_order_by_client_order_id("client-123")
        assert order is not None
        self.assertEqual(order["id"], "order-xyz")
        self.assertEqual(order["client_order_id"], "client-123")

    def test_get_asset_returns_model_from_read_surface(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        asset = client.get_asset("AAPL")
        assert asset is not None
        self.assertEqual(asset["symbol"], "AAPL")
        self.assertTrue(asset["tradable"])

    def test_mutating_methods_require_firewall_boundary(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )
        with self.assertRaises(OrderFirewallViolation):
            client.submit_order(
                symbol="AAPL",
                side="buy",
                qty=1,
                order_type="market",
                time_in_force="day",
                firewall_token=cast(OrderFirewallToken, object()),
            )

    def test_read_only_trading_client_does_not_expose_mutations(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        account = client.trading.get_account()
        self.assertEqual(account.model_dump()["equity"], "10000")

        self.assertFalse(hasattr(client.trading, "submit_order"))
        self.assertFalse(hasattr(client.trading, "cancel_order_by_id"))
        self.assertFalse(hasattr(client.trading, "cancel_orders"))

        with self.assertRaises(AttributeError):
            getattr(client.trading, "submit_order")

        with self.assertRaises(AttributeError):
            getattr(client.trading, "cancel_order_by_id")

        with self.assertRaises(AttributeError):
            getattr(client.trading, "cancel_orders")

    def test_market_data_uses_data_endpoint_by_default(self) -> None:
        with patch("app.alpaca_client.StockHistoricalDataClient") as mock_data_client:
            TorghutAlpacaClient(
                api_key="k",
                secret_key="s",
                base_url="https://paper-api.alpaca.markets",
                trading_client=DummyTradingClient(),
            )

            called_kwargs = mock_data_client.call_args.kwargs
            self.assertIsNone(called_kwargs.get("url_override"))
            self.assertTrue(called_kwargs.get("sandbox"))

    def test_live_mode_uses_live_endpoints(self) -> None:
        from app import config

        original = config.settings.trading_mode
        config.settings.trading_mode = "live"

        try:
            with (
                patch("app.alpaca_client.TradingClient") as mock_trading_client,
                patch(
                    "app.alpaca_client.StockHistoricalDataClient"
                ) as mock_data_client,
            ):
                TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://api.alpaca.markets",
                )

                trading_kwargs = mock_trading_client.call_args.kwargs
                data_kwargs = mock_data_client.call_args.kwargs

                self.assertFalse(trading_kwargs.get("paper"))
                self.assertFalse(data_kwargs.get("sandbox"))
        finally:
            config.settings.trading_mode = original

    def test_explicit_paper_override_beats_live_runtime_mode(self) -> None:
        from app import config

        original = config.settings.trading_mode
        config.settings.trading_mode = "live"

        try:
            with (
                patch("app.alpaca_client.TradingClient") as mock_trading_client,
                patch(
                    "app.alpaca_client.StockHistoricalDataClient"
                ) as mock_data_client,
            ):
                client = TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://paper-api.alpaca.markets",
                    paper=True,
                )

                trading_kwargs = mock_trading_client.call_args.kwargs
                data_kwargs = mock_data_client.call_args.kwargs

                self.assertTrue(trading_kwargs.get("paper"))
                self.assertTrue(data_kwargs.get("sandbox"))
                self.assertEqual(client.endpoint_class, "paper")
        finally:
            config.settings.trading_mode = original

    def test_alpaca_base_url_strips_v2_suffix(self) -> None:
        with patch("app.alpaca_client.TradingClient") as mock_trading_client:
            TorghutAlpacaClient(
                api_key="k",
                secret_key="s",
                base_url="https://paper-api.alpaca.markets/v2",
            )

            trading_kwargs = mock_trading_client.call_args.kwargs
            self.assertEqual(
                trading_kwargs.get("url_override"), "https://paper-api.alpaca.markets"
            )
