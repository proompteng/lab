from __future__ import annotations

from typing import Any
from unittest import TestCase

from app import config
from app.trading.execution_adapters import LeanExecutionAdapter, OrderSubmission
from app.trading.execution_adapters.lean_adapter import LeanRequest


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


class FakeFallbackAdapter:
    name = "alpaca"

    def __init__(self) -> None:
        self.submitted: list[dict[str, str]] = []
        self.last_route = self.name

    def submit_order(
        self,
        request: OrderSubmission,
        /,
    ) -> dict[str, str]:
        extra_params = request.extra_params or {}
        order = {
            "id": f"order-{len(self.submitted) + 1}",
            "client_order_id": extra_params.get("client_order_id")
            if extra_params
            else "",
            "symbol": request.symbol,
            "side": request.side,
            "type": request.order_type,
            "time_in_force": request.time_in_force,
            "qty": str(request.qty),
            "filled_qty": "0",
            "status": "accepted",
        }
        self.submitted.append(order)
        self.last_route = self.name
        return order

    def cancel_order(self, order_id: str) -> bool:
        self.last_route = self.name
        return True

    def cancel_all_orders(self) -> list[dict[str, str]]:
        self.last_route = self.name
        return []

    def get_order(self, order_id: str) -> dict[str, str]:
        return {"id": order_id, "status": "accepted"}

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, str] | None:
        return next(
            (
                order
                for order in self.submitted
                if order.get("client_order_id") == client_order_id
            ),
            None,
        )

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        _ = status
        return list(self.submitted)

    def list_positions(self) -> list[dict[str, str]]:
        return []

    def get_account(self) -> dict[str, bool]:
        return {"shorting_enabled": True}

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, str | bool]:
        return {
            "symbol": symbol_or_asset_id,
            "tradable": True,
            "shortable": True,
            "easy_to_borrow": True,
        }


class TestLeanExecutionAdapterContracts(TestCase):
    def test_submit_includes_correlation_and_idempotency_audit_fields(self) -> None:
        class CapturingLeanAdapter(LeanExecutionAdapter):
            def __init__(self, **kwargs: Any) -> None:
                super().__init__(**kwargs)
                self.captured_headers: dict[str, str] = {}

            def _request_json_with_headers(
                self,
                request: LeanRequest,
            ) -> dict[str, Any]:
                _ = (request.method, request.payload, request.operation)
                if request.headers:
                    self.captured_headers = dict(request.headers)
                if request.path == "/v1/shadow/simulate":
                    return {"parity_status": "pass", "simulated_slippage_bps": 0.1}
                return {
                    "id": "lean-order-1",
                    "status": "accepted",
                    "symbol": "AAPL",
                    "qty": "1",
                    "client_order_id": "cid-telemetry",
                }

        original_shadow = config.settings.trading_lean_shadow_execution_enabled
        original_disable = config.settings.trading_lean_lane_disable_switch
        try:
            config.settings.trading_lean_shadow_execution_enabled = True
            config.settings.trading_lean_lane_disable_switch = False
            adapter = CapturingLeanAdapter(
                base_url="http://lean.invalid", timeout_seconds=1, fallback=None
            )
            payload = _submit_order(
                adapter,
                symbol="AAPL",
                side="buy",
                qty=1.0,
                order_type="market",
                time_in_force="day",
                extra_params={"client_order_id": "cid-telemetry"},
            )
        finally:
            config.settings.trading_lean_shadow_execution_enabled = original_shadow
            config.settings.trading_lean_lane_disable_switch = original_disable

        self.assertIn("X-Correlation-ID", adapter.captured_headers)
        self.assertEqual(
            adapter.captured_headers.get("Idempotency-Key"), "cid-telemetry"
        )
        self.assertEqual(payload.get("_execution_idempotency_key"), "cid-telemetry")
        self.assertTrue(
            str(payload.get("_execution_correlation_id", "")).startswith("torghut-")
        )
        self.assertEqual(payload.get("_lean_shadow", {}).get("parity_status"), "pass")

    def test_falls_back_to_alpaca_when_runner_unreachable(self) -> None:
        fallback = FakeFallbackAdapter()
        adapter = LeanExecutionAdapter(
            base_url="http://127.0.0.1:9",
            timeout_seconds=1,
            fallback=fallback,
        )

        payload = _submit_order(
            adapter,
            symbol="AAPL",
            side="buy",
            qty=1.0,
            order_type="market",
            time_in_force="day",
            extra_params={"client_order_id": "cid-1"},
        )

        self.assertEqual(payload.get("client_order_id"), "cid-1")
        self.assertEqual(payload.get("_execution_adapter"), "alpaca_fallback")
        self.assertEqual(adapter.last_route, "alpaca_fallback")
        self.assertEqual(len(fallback.submitted), 1)
        self.assertEqual(payload.get("_execution_route_expected"), "lean")
        self.assertEqual(payload.get("_execution_fallback_count"), 1)
        self.assertTrue(
            str(payload.get("_execution_fallback_reason", "")).startswith(
                "lean_submit_order_"
            )
        )

    def test_submit_contract_violation_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                **options: Any,
            ) -> dict[str, str]:
                _ = (method, path, payload, options)
                return {"status": "accepted"}  # missing id/symbol/qty contract keys

        fallback = FakeFallbackAdapter()
        adapter = InvalidLeanAdapter(
            base_url="http://lean.invalid", timeout_seconds=1, fallback=fallback
        )

        payload = _submit_order(
            adapter,
            symbol="MSFT",
            side="buy",
            qty=2.0,
            order_type="market",
            time_in_force="day",
            extra_params={"client_order_id": "cid-2"},
        )

        self.assertEqual(adapter.last_route, "alpaca_fallback")
        self.assertEqual(payload.get("_execution_adapter"), "alpaca_fallback")
        self.assertEqual(payload.get("symbol"), "MSFT")
        self.assertEqual(payload.get("client_order_id"), "cid-2")
        self.assertEqual(
            payload.get("_execution_fallback_reason"),
            "lean_submit_order_contract_violation",
        )

    def test_get_order_contract_violation_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                **options: Any,
            ) -> dict[str, str]:
                _ = (method, path, payload, options)
                return {"symbol": "AAPL"}  # missing id/status

        fallback = FakeFallbackAdapter()
        _submit_order(
            fallback,
            symbol="AAPL",
            side="buy",
            qty=1.0,
            order_type="market",
            time_in_force="day",
            extra_params={"client_order_id": "cid-3"},
        )
        adapter = InvalidLeanAdapter(
            base_url="http://lean.invalid", timeout_seconds=1, fallback=fallback
        )

        order = adapter.get_order("order-1")

        self.assertEqual(adapter.last_route, "alpaca_fallback")
        self.assertEqual(order.get("id"), "order-1")
        self.assertEqual(order.get("status"), "accepted")
        self.assertEqual(
            order.get("_execution_fallback_reason"), "lean_get_order_contract_violation"
        )
        self.assertEqual(order.get("_execution_fallback_count"), 1)

    def test_list_orders_contract_violation_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                **options: Any,
            ) -> dict[str, list[dict[str, str]]]:
                _ = (method, path, payload, options)
                return {"orders": [{"symbol": "AAPL"}]}  # missing id/status

        fallback = FakeFallbackAdapter()
        _submit_order(
            fallback,
            symbol="AAPL",
            side="buy",
            qty=1.0,
            order_type="market",
            time_in_force="day",
            extra_params={"client_order_id": "cid-4"},
        )
        adapter = InvalidLeanAdapter(
            base_url="http://lean.invalid", timeout_seconds=1, fallback=fallback
        )

        orders = adapter.list_orders()

        self.assertEqual(adapter.last_route, "alpaca_fallback")
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0].get("id"), "order-1")
        self.assertEqual(
            orders[0].get("_execution_fallback_reason"),
            "lean_list_orders_contract_violation",
        )
        self.assertEqual(orders[0].get("_execution_fallback_count"), 1)

    def test_list_positions_returns_none_without_fallback(self) -> None:
        adapter = LeanExecutionAdapter(
            base_url="http://lean.invalid",
            timeout_seconds=1,
            fallback=None,
        )
        self.assertIsNone(adapter.list_positions())

    def test_short_precheck_metadata_passthrough_uses_fallback(self) -> None:
        fallback = FakeFallbackAdapter()
        adapter = LeanExecutionAdapter(
            base_url="http://lean.invalid",
            timeout_seconds=1,
            fallback=fallback,
        )

        self.assertEqual(adapter.get_account(), {"shorting_enabled": True})
        self.assertEqual(
            adapter.get_asset("AAPL"),
            {
                "symbol": "AAPL",
                "tradable": True,
                "shortable": True,
                "easy_to_borrow": True,
            },
        )

    def test_submit_symbol_mismatch_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                **options: Any,
            ) -> dict[str, str]:
                _ = (method, path, payload, options)
                return {
                    "id": "lean-order-1",
                    "status": "accepted",
                    "symbol": "TSLA",
                    "qty": "1",
                    "client_order_id": "cid-5",
                }

        fallback = FakeFallbackAdapter()
        adapter = InvalidLeanAdapter(
            base_url="http://lean.invalid", timeout_seconds=1, fallback=fallback
        )

        payload = _submit_order(
            adapter,
            symbol="AAPL",
            side="buy",
            qty=1.0,
            order_type="market",
            time_in_force="day",
            extra_params={"client_order_id": "cid-5"},
        )

        self.assertEqual(adapter.last_route, "alpaca_fallback")
        self.assertEqual(payload.get("symbol"), "AAPL")
        self.assertEqual(
            payload.get("_execution_fallback_reason"),
            "lean_submit_order_contract_violation",
        )
