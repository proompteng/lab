from __future__ import annotations

from typing import Any
from unittest import TestCase

from app.config import settings
from app.trading.firewall import OrderFirewall, OrderFirewallBlocked


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submissions: list[dict[str, Any]] = []
        self.cancel_all_calls = 0
        self.account_calls = 0
        self.asset_calls: list[str] = []
        self.position_calls = 0
        self.order_list_calls: list[str] = []
        self.order_lookup_calls: list[str] = []
        self.client_order_lookup_calls: list[str] = []

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
        *,
        firewall_token: object | None = None,
    ) -> dict[str, Any]:
        order = {
            "id": "order-1",
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
        }
        self.submissions.append(order)
        return order

    def cancel_all_orders(
        self, *, firewall_token: object | None = None
    ) -> list[dict[str, Any]]:
        self.cancel_all_calls += 1
        return [{"id": "order-1"}]

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: object | None = None
    ) -> bool:
        _ = alpaca_order_id
        return True

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None:
        self.client_order_lookup_calls.append(client_order_id)
        return {"id": "order-1", "client_order_id": client_order_id}

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]:
        self.order_lookup_calls.append(alpaca_order_id)
        return {"id": alpaca_order_id, "status": "accepted"}

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]:
        self.order_list_calls.append(status)
        return [{"id": "order-1", "status": status}]

    def list_positions(self) -> list[dict[str, Any]]:
        self.position_calls += 1
        return [{"symbol": "AAPL", "qty": "1"}]

    def get_account(self) -> dict[str, Any]:
        self.account_calls += 1
        return {"equity": "10000"}

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, Any]:
        self.asset_calls.append(symbol_or_asset_id)
        return {"symbol": symbol_or_asset_id, "tradable": True}


class TestOrderFirewall(TestCase):
    def setUp(self) -> None:
        self.original_kill_switch = settings.trading_kill_switch_enabled

    def tearDown(self) -> None:
        settings.trading_kill_switch_enabled = self.original_kill_switch

    def test_kill_switch_cancels_and_blocks(self) -> None:
        settings.trading_kill_switch_enabled = True
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)

        self.assertTrue(firewall.cancel_open_orders_if_kill_switch())
        self.assertEqual(client.cancel_all_calls, 1)
        self.assertEqual(firewall.status().reason, "kill_switch_enabled")

        with self.assertRaises(OrderFirewallBlocked):
            firewall.submit_order(
                symbol="AAPL",
                side="buy",
                qty=1,
                order_type="market",
                time_in_force="day",
            )

    def test_firewall_allows_submit_when_clear(self) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)

        response = firewall.submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
        )

        self.assertEqual(response["symbol"], "AAPL")
        self.assertEqual(len(client.submissions), 1)

    def test_kill_switch_noop_when_disabled(self) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)

        self.assertFalse(firewall.cancel_open_orders_if_kill_switch())
        self.assertEqual(client.cancel_all_calls, 0)
        self.assertEqual(firewall.status().reason, "ok")

    def test_firewall_read_methods_use_explicit_broker_contract(self) -> None:
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)

        self.assertEqual(
            firewall.list_orders(status="open"), [{"id": "order-1", "status": "open"}]
        )
        self.assertEqual(firewall.list_positions(), [{"symbol": "AAPL", "qty": "1"}])
        self.assertEqual(firewall.get_account(), {"equity": "10000"})
        self.assertEqual(
            firewall.get_asset("AAPL"), {"symbol": "AAPL", "tradable": True}
        )
        self.assertEqual(
            firewall.get_order("order-123"), {"id": "order-123", "status": "accepted"}
        )
        self.assertEqual(
            firewall.get_order_by_client_order_id("client-123"),
            {"id": "order-1", "client_order_id": "client-123"},
        )

        self.assertEqual(client.order_list_calls, ["open"])
        self.assertEqual(client.position_calls, 1)
        self.assertEqual(client.account_calls, 1)
        self.assertEqual(client.asset_calls, ["AAPL"])
        self.assertEqual(client.order_lookup_calls, ["order-123"])
        self.assertEqual(client.client_order_lookup_calls, ["client-123"])
