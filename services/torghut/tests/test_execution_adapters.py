from __future__ import annotations

from typing import Any
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.execution_adapters import (
    OrderSubmission,
    SessionRoutingExecutionAdapter,
    SimulationExecutionAdapter,
    build_execution_adapter,
)


def _order_submission(
    *,
    symbol: str,
    side: str,
    qty: float,
    order_type: str,
    time_in_force: str,
    limit_price: float | None = None,
    stop_price: float | None = None,
    extra_params: dict[str, Any] | None = None,
) -> OrderSubmission:
    return OrderSubmission(
        symbol=symbol,
        side=side,
        qty=qty,
        order_type=order_type,
        time_in_force=time_in_force,
        limit_price=limit_price,
        stop_price=stop_price,
        extra_params=extra_params,
    )


def _submit_order(adapter: Any, **kwargs: Any) -> dict[str, Any]:
    return adapter.submit_order(_order_submission(**kwargs))


class FakeOrderFirewall:
    def submit_order(self, **kwargs: Any) -> dict[str, Any]:
        return {
            "id": "fallback-order",
            "status": "accepted",
            "symbol": kwargs.get("symbol", "AAPL"),
            "qty": str(kwargs.get("qty", 1)),
        }

    def cancel_order(self, order_id: str) -> bool:
        _ = order_id
        return True

    def cancel_all_orders(self) -> list[dict[str, str]]:
        return []


class FakeReadClient:
    def get_order(self, order_id: str) -> dict[str, str]:
        return {"id": order_id, "status": "accepted"}

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, str] | None:
        _ = client_order_id
        return None

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        _ = status
        return []

    def list_positions(self) -> list[dict[str, str]]:
        return []


class FakeRoutedAdapter:
    def __init__(self, name: str, *, fail_cancel_all: bool = False) -> None:
        self.name = name
        self.fail_cancel_all = fail_cancel_all
        self.submitted: list[OrderSubmission] = []
        self.cancelled: list[str] = []
        self.seeded_positions: list[dict[str, Any]] | None = None
        self.seeded_missing: list[dict[str, Any]] = []

    def submit_order(self, request: OrderSubmission) -> dict[str, Any]:
        self.submitted.append(request)
        return {
            "id": f"{self.name}-order",
            "status": "accepted",
            "symbol": request.symbol,
        }

    def cancel_order(self, order_id: str) -> bool:
        self.cancelled.append(order_id)
        return True

    def cancel_all_orders(self) -> list[dict[str, str]]:
        if self.fail_cancel_all:
            raise RuntimeError("cancel_all_failed")
        return [{"id": f"{self.name}-cancelled"}]

    def get_order(self, order_id: str) -> dict[str, str]:
        return {
            "id": order_id,
            "status": "accepted",
            "_execution_route_actual": self.name,
        }

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, str] | None:
        return {
            "id": f"{self.name}-{client_order_id}",
            "status": "accepted",
        }

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        return [{"id": f"{self.name}-{status}", "status": status}]

    def list_positions(self) -> list[dict[str, str]]:
        return [{"symbol": "AAPL", "route": self.name}]

    def seed_positions_snapshot(self, positions: list[dict[str, Any]] | None) -> None:
        self.seeded_positions = positions

    def seed_missing_position_snapshot(self, position: dict[str, Any]) -> bool:
        self.seeded_missing.append(position)
        return True


class FakeNoSeedAdapter(FakeRoutedAdapter):
    seed_positions_snapshot = None
    seed_missing_position_snapshot = None


class TestExecutionAdapters(TestCase):
    def test_simulation_adapter_returns_filled_order_with_simulation_context(
        self,
    ) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        payload = _submit_order(
            adapter,
            symbol="AAPL",
            side="buy",
            qty=2.0,
            order_type="market",
            time_in_force="day",
            extra_params={
                "client_order_id": "decision-1",
                "simulation_context": {
                    "dataset_event_id": "evt-1",
                    "source_topic": "torghut.trades.v1",
                    "source_partition": 2,
                    "source_offset": 100,
                },
            },
        )
        self.assertEqual(payload.get("status"), "filled")
        self.assertEqual(payload.get("client_order_id"), "decision-1")
        self.assertEqual(payload.get("alpaca_account_label"), "paper")
        self.assertEqual(payload.get("_execution_idempotency_key"), "decision-1")
        self.assertEqual(
            payload.get("_execution_audit", {}).get("idempotency_key"), "decision-1"
        )
        simulation_context = payload.get("simulation_context")
        self.assertIsInstance(simulation_context, dict)
        assert isinstance(simulation_context, dict)
        self.assertEqual(
            simulation_context.get("simulation_run_id"), "sim-2026-02-27-01"
        )
        self.assertEqual(simulation_context.get("dataset_id"), "dataset-1")
        self.assertEqual(simulation_context.get("dataset_event_id"), "evt-1")
        self.assertEqual(payload.get("_execution_route_actual"), "simulation")

    def test_session_router_submits_to_alpaca_testnet_or_blocks(self) -> None:
        route_state = {"alpaca_open": True, "testnet_enabled": True}
        alpaca = FakeRoutedAdapter("alpaca")
        testnet = FakeRoutedAdapter("testnet")
        adapter = SessionRoutingExecutionAdapter(
            alpaca_adapter=alpaca,
            testnet_adapter=testnet,
            alpaca_regular_session_open=lambda: route_state["alpaca_open"],
            testnet_enabled=lambda: route_state["testnet_enabled"],
        )
        request = _order_submission(
            symbol="AAPL",
            side="buy",
            qty=1.0,
            order_type="market",
            time_in_force="day",
        )

        alpaca_payload = adapter.submit_order(request)
        self.assertEqual(alpaca_payload["_execution_route_actual"], "alpaca")
        self.assertEqual(adapter.last_route, "alpaca")
        self.assertEqual(alpaca.submitted, [request])

        route_state["alpaca_open"] = False
        testnet_payload = adapter.submit_order(request)
        self.assertEqual(testnet_payload["_execution_route_actual"], "testnet")
        self.assertEqual(adapter.last_route, "testnet")
        self.assertEqual(testnet.submitted, [request])

        route_state["testnet_enabled"] = False
        self.assertEqual(adapter.current_route(), "blocked")
        with self.assertRaises(RuntimeError):
            adapter.submit_order(request)

    def test_session_router_read_paths_fail_closed_when_route_is_blocked(self) -> None:
        adapter = SessionRoutingExecutionAdapter(
            alpaca_adapter=FakeRoutedAdapter("alpaca"),
            testnet_adapter=FakeRoutedAdapter("testnet"),
            alpaca_regular_session_open=lambda: False,
            testnet_enabled=lambda: False,
        )

        self.assertFalse(adapter.cancel_order("order-1"))
        self.assertEqual(
            adapter.get_order("order-1"),
            {
                "id": "order-1",
                "status": "not_found",
                "_execution_route_actual": "blocked",
            },
        )
        self.assertIsNone(adapter.get_order_by_client_order_id("client-1"))
        self.assertEqual(adapter.list_orders(), [])
        self.assertEqual(adapter.list_positions(), [])

    def test_session_router_routes_management_calls_and_seed_helpers(self) -> None:
        route_state = {"alpaca_open": True, "testnet_enabled": True}
        alpaca = FakeRoutedAdapter("alpaca")
        testnet = FakeRoutedAdapter("testnet", fail_cancel_all=True)
        adapter = SessionRoutingExecutionAdapter(
            alpaca_adapter=alpaca,
            testnet_adapter=testnet,
            alpaca_regular_session_open=lambda: route_state["alpaca_open"],
            testnet_enabled=lambda: route_state["testnet_enabled"],
        )

        self.assertTrue(adapter.cancel_order("order-1"))
        self.assertEqual(alpaca.cancelled, ["order-1"])
        self.assertEqual(
            adapter.get_order("order-1")["_execution_route_actual"], "alpaca"
        )
        self.assertEqual(
            adapter.get_order_by_client_order_id("client-1"),
            {"id": "alpaca-client-1", "status": "accepted"},
        )
        self.assertEqual(adapter.list_orders(status="open")[0]["id"], "alpaca-open")
        self.assertEqual(adapter.list_positions()[0]["route"], "alpaca")

        route_state["alpaca_open"] = False
        self.assertTrue(adapter.cancel_order("order-2"))
        self.assertEqual(testnet.cancelled, ["order-2"])
        self.assertEqual(
            adapter.get_order("order-2")["_execution_route_actual"], "testnet"
        )
        self.assertEqual(
            adapter.get_order_by_client_order_id("client-2"),
            {"id": "testnet-client-2", "status": "accepted"},
        )
        self.assertEqual(
            adapter.list_orders(status="filled")[0]["id"], "testnet-filled"
        )
        self.assertEqual(adapter.list_positions()[0]["route"], "testnet")

        self.assertEqual(adapter.cancel_all_orders(), [{"id": "alpaca-cancelled"}])
        positions = [{"symbol": "AAPL", "qty": "1"}]
        adapter.seed_positions_snapshot(positions)
        self.assertEqual(testnet.seeded_positions, positions)
        self.assertTrue(adapter.seed_missing_position_snapshot({"symbol": "MSFT"}))
        self.assertEqual(testnet.seeded_missing, [{"symbol": "MSFT"}])

        no_seed = SessionRoutingExecutionAdapter(
            alpaca_adapter=alpaca,
            testnet_adapter=FakeNoSeedAdapter("testnet-no-seed"),
            alpaca_regular_session_open=lambda: False,
            testnet_enabled=lambda: True,
        )
        no_seed.seed_positions_snapshot(positions)
        self.assertFalse(no_seed.seed_missing_position_snapshot({"symbol": "MSFT"}))

    def test_simulation_adapter_does_not_cancel_filled_order(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        payload = _submit_order(
            adapter,
            symbol="AAPL",
            side="buy",
            qty=1.0,
            order_type="market",
            time_in_force="day",
            extra_params={"client_order_id": "decision-2"},
        )
        order_id = str(payload.get("id"))
        self.assertFalse(adapter.cancel_order(order_id))
        fetched = adapter.get_order(order_id)
        self.assertEqual(fetched.get("status"), "filled")

    def test_simulation_adapter_uses_simulation_context_fill_price(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )

        payload = _submit_order(
            adapter,
            symbol="NVDA",
            side="buy",
            qty=2.0,
            order_type="market",
            time_in_force="day",
            extra_params={
                "client_order_id": "decision-context-fill",
                "simulation_context": {
                    "simulated_fill_price": "197.055",
                    "signal_event_ts": "2026-05-05T17:25:06+00:00",
                },
            },
        )

        self.assertEqual(payload.get("status"), "filled")
        self.assertEqual(payload.get("filled_avg_price"), "197.055")
        self.assertEqual(payload.get("filled_qty"), "2")

    def test_simulation_adapter_uses_price_snapshot_fill_price(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )

        payload = _submit_order(
            adapter,
            symbol="NVDA",
            side="buy",
            qty=1.0,
            order_type="market",
            time_in_force="day",
            extra_params={
                "client_order_id": "decision-price-snapshot-fill",
                "simulation_context": {
                    "price_snapshot": {"price": "197.34"},
                    "signal_event_ts": "2026-05-05T17:25:06+00:00",
                },
            },
        )

        self.assertEqual(payload.get("status"), "filled")
        self.assertEqual(payload.get("filled_avg_price"), "197.34")

    def test_simulation_adapter_haircuts_fill_by_queue_depth(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )

        payload = _submit_order(
            adapter,
            symbol="NVDA",
            side="buy",
            qty=10.0,
            order_type="limit",
            time_in_force="day",
            limit_price=100.0,
            extra_params={
                "client_order_id": "decision-queue-partial",
                "simulation_context": {
                    "depth_at_limit": "8",
                    "queue_ahead_qty": "3",
                    "queue_fill_probability": "0.75",
                    "signal_event_ts": "2026-05-05T17:25:06+00:00",
                },
            },
        )

        self.assertEqual(payload.get("status"), "partially_filled")
        self.assertEqual(payload.get("filled_qty"), "5")
        self.assertEqual(payload.get("filled_avg_price"), "100")
        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    "symbol": "NVDA",
                    "qty": "5",
                    "side": "long",
                    "market_value": "500",
                    "alpaca_account_label": "paper",
                }
            ],
        )

    def test_simulation_adapter_keeps_zero_queue_fill_cancelable(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )

        payload = _submit_order(
            adapter,
            symbol="NVDA",
            side="buy",
            qty=10.0,
            order_type="limit",
            time_in_force="day",
            limit_price=100.0,
            extra_params={
                "client_order_id": "decision-queue-unfilled",
                "simulation_context": {
                    "depth_at_limit": "2",
                    "queue_ahead_qty": "4",
                    "signal_event_ts": "2026-05-05T17:25:06+00:00",
                },
            },
        )

        self.assertEqual(payload.get("status"), "accepted")
        self.assertEqual(payload.get("filled_qty"), "0")
        self.assertIsNone(payload.get("filled_avg_price"))
        self.assertEqual(adapter.list_positions(), [])
        self.assertTrue(adapter.cancel_order(str(payload.get("id"))))
        self.assertEqual(
            adapter.get_order(str(payload.get("id"))).get("status"), "canceled"
        )

    def test_simulation_adapter_tracks_synthetic_positions(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        _submit_order(
            adapter,
            symbol="AAPL",
            side="buy",
            qty=1.5,
            order_type="market",
            time_in_force="day",
            limit_price=10.0,
            extra_params={"client_order_id": "decision-long"},
        )
        positions = adapter.list_positions()
        self.assertEqual(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "qty": "1.5",
                    "side": "long",
                    "market_value": "15",
                    "alpaca_account_label": "paper",
                }
            ],
        )
        _submit_order(
            adapter,
            symbol="AAPL",
            side="sell",
            qty=2.0,
            order_type="market",
            time_in_force="day",
            limit_price=10.0,
            extra_params={"client_order_id": "decision-short"},
        )
        positions = adapter.list_positions()
        self.assertEqual(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "qty": "0.5",
                    "side": "short",
                    "market_value": "-5",
                    "alpaca_account_label": "paper",
                }
            ],
        )

    def test_simulation_adapter_resets_state_when_active_run_changes(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        with patch(
            "app.trading.execution_adapters.adapter_types.active_simulation_runtime_context",
            side_effect=[
                {"run_id": "sim-2026-02-27-01", "dataset_id": "dataset-1"},
                {"run_id": "sim-2026-02-27-01", "dataset_id": "dataset-1"},
                {"run_id": "sim-2026-02-28-01", "dataset_id": "dataset-2"},
            ],
        ):
            _submit_order(
                adapter,
                symbol="AAPL",
                side="buy",
                qty=1.0,
                order_type="market",
                time_in_force="day",
                extra_params={"client_order_id": "decision-a"},
            )
            self.assertEqual(len(adapter.list_orders()), 1)
            _submit_order(
                adapter,
                symbol="MSFT",
                side="buy",
                qty=2.0,
                order_type="market",
                time_in_force="day",
                extra_params={"client_order_id": "decision-b"},
            )

        orders = adapter.list_orders()
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0].get("client_order_id"), "decision-b")
        positions = adapter.list_positions()
        self.assertEqual(
            positions,
            [
                {
                    "symbol": "MSFT",
                    "qty": "2",
                    "side": "long",
                    "market_value": "2",
                    "alpaca_account_label": "paper",
                }
            ],
        )

    def test_simulation_adapter_seeds_initial_positions_once(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        adapter.seed_positions_snapshot(
            [
                {"symbol": "AAPL", "qty": "2.5", "side": "long", "market_value": "250"},
                {"symbol": "MSFT", "qty": "1", "side": "short", "market_value": "10"},
            ]
        )
        adapter.seed_positions_snapshot(
            [
                {"symbol": "AAPL", "qty": "9", "side": "long"},
            ]
        )

        _submit_order(
            adapter,
            symbol="AAPL",
            side="sell",
            qty=0.5,
            order_type="market",
            time_in_force="day",
            limit_price=100.0,
            extra_params={"client_order_id": "decision-seeded-sell"},
        )

        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    "symbol": "AAPL",
                    "qty": "2",
                    "side": "long",
                    "market_value": "200",
                    "alpaca_account_label": "paper",
                },
                {
                    "symbol": "MSFT",
                    "qty": "1",
                    "side": "short",
                    "market_value": "-10",
                    "alpaca_account_label": "paper",
                },
            ],
        )

    def test_simulation_adapter_preserves_integer_magnitude_in_positions(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        _submit_order(
            adapter,
            symbol="AAPL",
            side="buy",
            qty=10.0,
            order_type="market",
            time_in_force="day",
            limit_price=100.0,
            extra_params={"client_order_id": "decision-integer"},
        )
        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    "symbol": "AAPL",
                    "qty": "10",
                    "side": "long",
                    "market_value": "1000",
                    "alpaca_account_label": "paper",
                }
            ],
        )

    def test_simulation_adapter_does_not_emit_partial_market_value_for_untracked_seed(
        self,
    ) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        adapter.seed_positions_snapshot(
            [
                {"symbol": "AAPL", "qty": "2", "side": "long"},
            ]
        )

        _submit_order(
            adapter,
            symbol="AAPL",
            side="sell",
            qty=0.5,
            order_type="market",
            time_in_force="day",
            limit_price=100.0,
            extra_params={"client_order_id": "decision-seeded-reduce"},
        )

        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    "symbol": "AAPL",
                    "qty": "1.5",
                    "side": "long",
                    "alpaca_account_label": "paper",
                }
            ],
        )

    def test_simulation_adapter_tracks_cross_zero_market_value_after_untracked_seed(
        self,
    ) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-2026-02-27-01",
            dataset_id="dataset-1",
        )
        adapter.seed_positions_snapshot(
            [
                {"symbol": "AAPL", "qty": "2", "side": "long"},
            ]
        )

        _submit_order(
            adapter,
            symbol="AAPL",
            side="sell",
            qty=3.0,
            order_type="market",
            time_in_force="day",
            limit_price=100.0,
            extra_params={"client_order_id": "decision-seeded-cross-zero"},
        )

        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    "symbol": "AAPL",
                    "qty": "1",
                    "side": "short",
                    "market_value": "-100",
                    "alpaca_account_label": "paper",
                }
            ],
        )

    def test_build_execution_adapter_uses_simulation_when_enabled(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        original_sim_topic = config.settings.trading_simulation_order_updates_topic
        original_sim_bootstrap = (
            config.settings.trading_simulation_order_updates_bootstrap_servers
        )
        original_order_bootstrap = config.settings.trading_order_feed_bootstrap_servers
        original_run_id = config.settings.trading_simulation_run_id
        original_dataset = config.settings.trading_simulation_dataset_id
        original_testnet_after_hours = (
            config.settings.trading_testnet_after_hours_enabled
        )
        try:
            config.settings.trading_simulation_enabled = True
            config.settings.trading_testnet_after_hours_enabled = False
            config.settings.trading_simulation_order_updates_topic = (
                "torghut.sim.trade-updates.v1"
            )
            config.settings.trading_simulation_order_updates_bootstrap_servers = None
            config.settings.trading_order_feed_bootstrap_servers = None
            config.settings.trading_simulation_run_id = "sim-2026"
            config.settings.trading_simulation_dataset_id = "dataset-a"
            adapter = build_execution_adapter(
                alpaca_client=FakeReadClient(),
                order_firewall=FakeOrderFirewall(),
            )
            self.assertEqual(adapter.name, "simulation")
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled
            config.settings.trading_simulation_order_updates_topic = original_sim_topic
            config.settings.trading_simulation_order_updates_bootstrap_servers = (
                original_sim_bootstrap
            )
            config.settings.trading_order_feed_bootstrap_servers = (
                original_order_bootstrap
            )
            config.settings.trading_simulation_run_id = original_run_id
            config.settings.trading_simulation_dataset_id = original_dataset
            config.settings.trading_testnet_after_hours_enabled = (
                original_testnet_after_hours
            )

    def test_build_execution_adapter_uses_alpaca_when_simulation_disabled(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        original_testnet_after_hours = (
            config.settings.trading_testnet_after_hours_enabled
        )
        try:
            config.settings.trading_simulation_enabled = False
            config.settings.trading_testnet_after_hours_enabled = False
            adapter = build_execution_adapter(
                alpaca_client=FakeReadClient(),
                order_firewall=FakeOrderFirewall(),
            )
            self.assertEqual(adapter.name, "alpaca")
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled
            config.settings.trading_testnet_after_hours_enabled = (
                original_testnet_after_hours
            )

    def test_session_router_uses_alpaca_during_regular_market_hours(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        original_testnet_after_hours = (
            config.settings.trading_testnet_after_hours_enabled
        )
        try:
            config.settings.trading_simulation_enabled = False
            config.settings.trading_testnet_after_hours_enabled = True
            with patch(
                "app.trading.execution_adapters.lean_adapter.market_session_is_open",
                return_value=True,
            ):
                adapter = build_execution_adapter(
                    alpaca_client=FakeReadClient(),
                    order_firewall=FakeOrderFirewall(),
                )

                payload = _submit_order(
                    adapter,
                    symbol="AAPL",
                    side="buy",
                    qty=1.0,
                    order_type="market",
                    time_in_force="day",
                )

            self.assertEqual(adapter.name, "session_router")
            self.assertEqual(payload["_execution_route_expected"], "alpaca")
            self.assertEqual(payload["_execution_route_actual"], "alpaca")
            self.assertEqual(payload["id"], "fallback-order")
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled
            config.settings.trading_testnet_after_hours_enabled = (
                original_testnet_after_hours
            )

    def test_session_router_uses_testnet_outside_regular_market_hours(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        original_testnet_after_hours = (
            config.settings.trading_testnet_after_hours_enabled
        )
        try:
            config.settings.trading_simulation_enabled = False
            config.settings.trading_testnet_after_hours_enabled = True
            with patch(
                "app.trading.execution_adapters.lean_adapter.market_session_is_open",
                return_value=False,
            ):
                adapter = build_execution_adapter(
                    alpaca_client=FakeReadClient(),
                    order_firewall=FakeOrderFirewall(),
                )

                payload = _submit_order(
                    adapter,
                    symbol="AAPL",
                    side="buy",
                    qty=1.0,
                    order_type="market",
                    time_in_force="day",
                    extra_params={"client_order_id": "after-hours-testnet"},
                )

            self.assertEqual(adapter.name, "session_router")
            self.assertEqual(payload["_execution_route_expected"], "testnet")
            self.assertEqual(payload["_execution_route_actual"], "testnet")
            self.assertTrue(str(payload["id"]).startswith("sim-order-"))
            self.assertEqual(payload["status"], "filled")
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled
            config.settings.trading_testnet_after_hours_enabled = (
                original_testnet_after_hours
            )

    def test_simulation_adapter_uses_kafka_security_kwargs(self) -> None:
        captured_kwargs: dict[str, Any] = {}

        class _FakeProducer:
            def __init__(self, **kwargs: Any) -> None:
                captured_kwargs.update(kwargs)

            def send(self, *_args: Any, **_kwargs: Any) -> None:
                return None

            def flush(self, timeout: float = 0) -> None:
                _ = timeout

        with patch.dict(
            "sys.modules",
            {"kafka": SimpleNamespace(KafkaProducer=_FakeProducer)},
        ):
            adapter = SimulationExecutionAdapter(
                bootstrap_servers="kafka:9092",
                security_protocol="SASL_PLAINTEXT",
                sasl_mechanism="SCRAM-SHA-512",
                sasl_username="user",
                sasl_password="secret",
                topic="torghut.sim.trade-updates.v1",
                account_label="paper",
                simulation_run_id="sim-2026-02-27-01",
                dataset_id="dataset-1",
            )
            self.assertIsNotNone(adapter)
        self.assertEqual(captured_kwargs.get("security_protocol"), "SASL_PLAINTEXT")
        self.assertEqual(captured_kwargs.get("sasl_mechanism"), "SCRAM-SHA-512")
        self.assertEqual(captured_kwargs.get("sasl_plain_username"), "user")
        self.assertEqual(captured_kwargs.get("sasl_plain_password"), "secret")
