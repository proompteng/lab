from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest import TestCase

from app.config import settings
from app.trading.broker_mutation_receipts import BrokerMutationReceiptValidationError
from app.trading.firewall import (
    AlpacaSubmitRequest,
    OrderFirewall,
    OrderFirewallBlocked,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_request_payload,
    infrastructure_validation_terminal_state_sha256,
)
from tests.broker_mutation_test_support import (
    alpaca_broker_mutation_test_permit,
    broker_mutation_test_permit,
)


class FakeAlpacaClient:
    endpoint_url = "https://paper-api.alpaca.markets"

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
            permit = alpaca_broker_mutation_test_permit(
                firewall,
                symbol="AAPL",
                side="buy",
                qty=1,
                order_type="market",
                time_in_force="day",
            )
            firewall.submit_order(
                symbol="AAPL",
                side="buy",
                qty=1,
                order_type="market",
                time_in_force="day",
                mutation_permit=permit,
            )

    def test_firewall_allows_submit_when_clear(self) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)

        permit = alpaca_broker_mutation_test_permit(
            firewall,
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
        )
        response = firewall.submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
            mutation_permit=permit,
        )

        self.assertEqual(response["symbol"], "AAPL")
        self.assertEqual(len(client.submissions), 1)

    def test_validation_submit_requires_exact_non_promotable_permit(self) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client, account_label="dedicated-validation-paper")
        now = datetime(2026, 7, 14, 21, 30, tzinfo=timezone.utc)
        permit, plan = _infrastructure_validation_fixture(now)
        mutation_permit = broker_mutation_test_permit(
            request_payload=infrastructure_validation_request_payload(permit, plan),
            broker_route="alpaca",
            risk_class="risk_neutral",
            account_label=firewall.account_label,
            endpoint_url=firewall.broker_endpoint_url,
        )

        response = firewall.submit_verified_infrastructure_validation_order(
            permit,
            plan,
            mutation_permit=mutation_permit,
            now=now,
        )

        self.assertEqual(response["symbol"], "BTC/USD")
        self.assertEqual(len(client.submissions), 1)

    def test_validation_submit_rejects_wrong_mutation_class(self) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client, account_label="dedicated-validation-paper")
        now = datetime(2026, 7, 14, 21, 30, tzinfo=timezone.utc)
        permit, plan = _infrastructure_validation_fixture(now)
        mutation_permit = broker_mutation_test_permit(
            request_payload=infrastructure_validation_request_payload(permit, plan),
            broker_route="alpaca",
            risk_class="risk_increasing",
            account_label=firewall.account_label,
            endpoint_url=firewall.broker_endpoint_url,
        )

        with self.assertRaises(BrokerMutationReceiptValidationError):
            firewall.submit_verified_infrastructure_validation_order(
                permit,
                plan,
                mutation_permit=mutation_permit,
                now=now,
            )

        self.assertEqual(client.submissions, [])

    def test_local_request_validation_precedes_permit_consumption(self) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)
        permit = alpaca_broker_mutation_test_permit(
            firewall,
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
        )

        with self.assertRaisesRegex(ValueError, "limit_price is required"):
            firewall.submit_order(
                symbol="AAPL",
                side="buy",
                qty=1,
                order_type="limit",
                time_in_force="day",
                mutation_permit=permit,
            )

        response = firewall.submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
            mutation_permit=permit,
        )
        self.assertEqual(response["id"], "order-1")
        self.assertEqual(len(client.submissions), 1)

    def test_firewall_rejects_forged_or_cross_route_permits_before_broker_io(
        self,
    ) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)
        request = {
            "symbol": "AAPL",
            "side": "buy",
            "qty": 1,
            "order_type": "market",
            "time_in_force": "day",
        }
        valid = alpaca_broker_mutation_test_permit(firewall, **request)
        forged = replace(valid, authorization_tag="0" * 64)

        for permit in (
            forged,
            broker_mutation_test_permit(
                request_payload={
                    "symbol": "AAPL",
                    "side": "buy",
                    "qty": 1,
                    "order_type": "market",
                    "time_in_force": "day",
                    "limit_price": None,
                    "stop_price": None,
                    "extra_params": {},
                }
            ),
        ):
            with self.assertRaises(BrokerMutationReceiptValidationError):
                firewall.submit_order(
                    symbol="AAPL",
                    side="buy",
                    qty=1,
                    order_type="market",
                    time_in_force="day",
                    mutation_permit=permit,
                )

        self.assertEqual(client.submissions, [])

    def test_fenced_closeout_allows_only_broker_observed_reduction(
        self,
    ) -> None:
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)

        permit = alpaca_broker_mutation_test_permit(
            firewall,
            symbol="AAPL",
            side="sell",
            qty=1,
            order_type="limit",
            time_in_force="day",
            limit_price=100,
            linked=False,
            risk_class="risk_reducing",
        )
        response = firewall.submit_verified_risk_reducing_order(
            AlpacaSubmitRequest(
                symbol="AAPL",
                side="sell",
                qty=1,
                order_type="limit",
                time_in_force="day",
                limit_price=100,
            ),
            mutation_permit=permit,
        )

        self.assertEqual(response["side"], "sell")
        for symbol, side, qty in (
            ("AAPL", "buy", 1),
            ("AAPL", "sell", 2),
            ("MSFT", "sell", 1),
        ):
            with self.assertRaisesRegex(RuntimeError, "risk_reduction"):
                invalid_permit = alpaca_broker_mutation_test_permit(
                    firewall,
                    symbol=symbol,
                    side=side,
                    qty=qty,
                    order_type="limit",
                    time_in_force="day",
                    limit_price=100,
                    linked=False,
                    risk_class="risk_reducing",
                )
                firewall.submit_verified_risk_reducing_order(
                    AlpacaSubmitRequest(
                        symbol=symbol,
                        side=side,
                        qty=qty,
                        order_type="limit",
                        time_in_force="day",
                        limit_price=100,
                    ),
                    mutation_permit=invalid_permit,
                )

        self.assertEqual(len(client.submissions), 1)

    def test_permit_is_request_bound_and_single_use(self) -> None:
        settings.trading_kill_switch_enabled = False
        client = FakeAlpacaClient()
        firewall = OrderFirewall(client)
        permit = alpaca_broker_mutation_test_permit(
            firewall,
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
        )

        with self.assertRaises(BrokerMutationReceiptValidationError):
            firewall.submit_order(
                symbol="AAPL",
                side="buy",
                qty=2,
                order_type="market",
                time_in_force="day",
                mutation_permit=permit,
            )
        self.assertEqual(client.submissions, [])

        firewall.submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
            mutation_permit=permit,
        )
        with self.assertRaisesRegex(
            BrokerMutationReceiptValidationError,
            "already_consumed",
        ):
            firewall.submit_order(
                symbol="AAPL",
                side="buy",
                qty=1,
                order_type="market",
                time_in_force="day",
                mutation_permit=replace(permit),
            )
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


def _infrastructure_validation_fixture(
    now: datetime,
) -> tuple[InfrastructureValidationPermit, InfrastructureValidationOrderPlan]:
    plan = InfrastructureValidationOrderPlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-order-plan.v1",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "1",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "1",
            "stop_price": None,
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-permit.v2",
            "permit_id": "ivp-firewall-test",
            "purpose": "control_plane_validation",
            "venue": "alpaca",
            "asset_class": "crypto",
            "account_mode": "paper",
            "market_session": "continuous",
            "account_label": "dedicated-validation-paper",
            "broker_base_url": "https://paper-api.alpaca.markets",
            "symbols": ["BTC/USD"],
            "sides": ["buy"],
            "order_types": ["limit"],
            "max_orders": 1,
            "max_outstanding_intents": 1,
            "max_notional_usd": "1",
            "max_loss_usd": "1",
            "issued_by": "infrastructure-owner",
            "approved_by": "independent-infrastructure-owner",
            "issued_at": now - timedelta(seconds=1),
            "expires_at": now + timedelta(minutes=5),
            "test_plan_digest": infrastructure_validation_order_plan_sha256(plan),
            "expected_terminal_state": "no_open_orders_no_positions_no_unsettled_claims",
            "expected_terminal_state_digest": infrastructure_validation_terminal_state_sha256(),
            "evidence_tag": "non_promotable_validation",
            "promotable": False,
        }
    )
    return permit, plan
