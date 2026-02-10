from __future__ import annotations

import uuid
from typing import Any, List
from unittest import TestCase
from unittest.mock import patch

from app.alpaca_client import OrderFirewallToken, TorghutAlpacaClient


class DummyModel:
    def __init__(self, **data: Any) -> None:
        self._data = data

    def model_dump(self) -> dict[str, Any]:
        return self._data


class DummyTradingClient:
    def __init__(self) -> None:
        self.cancelled: List[str] = []

    def get_account(self):  # type: ignore[override]
        return DummyModel(equity="10000", cash="5000", buying_power="20000")

    def get_all_positions(self):  # type: ignore[override]
        return [DummyModel(symbol="AAPL", qty="1")]

    def get_orders(self, filter=None):  # type: ignore[override]
        return [DummyModel(id="order-1", symbol="AAPL", uuid_id=uuid.uuid4())]

    def submit_order(self, order_data):  # type: ignore[override]
        return DummyModel(
            id="order-123",
            symbol=order_data.symbol,
            side=str(order_data.side),
            qty=order_data.qty,
            type=str(order_data.type),
            time_in_force=str(order_data.time_in_force),
            status="accepted",
        )

    def cancel_order_by_id(self, order_id):  # type: ignore[override]
        self.cancelled.append(order_id)

    def cancel_orders(self):  # type: ignore[override]
        return [DummyModel(id="order-1"), DummyModel(id="order-2")]


class DummyDataClient:
    def __init__(self) -> None:
        self.requested = []

    def get_stock_bars(self, request):  # type: ignore[override]
        self.requested.append(request)
        return type("Obj", (), {"data": {"AAPL": [DummyModel(symbol="AAPL", open=1, close=2)]}})()


class TestAlpacaClient(TestCase):
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

        submitted = client.submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
            firewall_token=OrderFirewallToken(),
        )
        self.assertEqual(submitted["status"], "accepted")

        bars = client.get_bars(symbols=["AAPL"], timeframe="1Min", lookback_bars=1)
        self.assertIn("AAPL", bars)
        self.assertEqual(len(bars["AAPL"]), 1)

        cancelled = client.cancel_all_orders(firewall_token=OrderFirewallToken())
        self.assertEqual(len(cancelled), 2)

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
                patch("app.alpaca_client.StockHistoricalDataClient") as mock_data_client,
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

    def test_alpaca_base_url_strips_v2_suffix(self) -> None:
        with patch("app.alpaca_client.TradingClient") as mock_trading_client:
            TorghutAlpacaClient(
                api_key="k",
                secret_key="s",
                base_url="https://paper-api.alpaca.markets/v2",
            )

            trading_kwargs = mock_trading_client.call_args.kwargs
            self.assertEqual(trading_kwargs.get("url_override"), "https://paper-api.alpaca.markets")
