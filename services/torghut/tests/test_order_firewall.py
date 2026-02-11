from __future__ import annotations

from unittest import TestCase

from app.config import settings
from app.trading.firewall import OrderFirewall, OrderFirewallBlocked


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submissions: list[dict[str, str]] = []
        self.cancel_all_calls = 0

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, str] | None = None,
        *,
        firewall_token: object | None = None,
    ) -> dict[str, str]:
        order = {
            "id": "order-1",
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
        }
        self.submissions.append(order)
        return order

    def cancel_all_orders(self, *, firewall_token: object | None = None) -> list[dict[str, str]]:
        self.cancel_all_calls += 1
        return [{"id": "order-1"}]

    def cancel_order(self, alpaca_order_id: str, *, firewall_token: object | None = None) -> bool:
        return True


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
