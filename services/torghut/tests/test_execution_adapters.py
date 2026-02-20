from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.execution_adapters import LeanExecutionAdapter, adapter_enabled_for_symbol, build_execution_adapter


class FakeFallbackAdapter:
    name = 'alpaca'

    def __init__(self) -> None:
        self.submitted: list[dict[str, str]] = []
        self.last_route = self.name

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
    ) -> dict[str, str]:
        order = {
            'id': f'order-{len(self.submitted) + 1}',
            'client_order_id': extra_params.get('client_order_id') if extra_params else '',
            'symbol': symbol,
            'side': side,
            'type': order_type,
            'time_in_force': time_in_force,
            'qty': str(qty),
            'filled_qty': '0',
            'status': 'accepted',
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
        return {'id': order_id, 'status': 'accepted'}

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, str] | None:
        return next((order for order in self.submitted if order.get('client_order_id') == client_order_id), None)

    def list_orders(self, status: str = 'all') -> list[dict[str, str]]:
        _ = status
        return list(self.submitted)


class FakeOrderFirewall:
    def submit_order(self, **kwargs):  # type: ignore[no-untyped-def]
        return {
            'id': 'fallback-order',
            'status': 'accepted',
            'symbol': kwargs.get('symbol', 'AAPL'),
            'qty': str(kwargs.get('qty', 1)),
        }

    def cancel_order(self, order_id: str) -> bool:
        _ = order_id
        return True

    def cancel_all_orders(self) -> list[dict[str, str]]:
        return []


class FakeReadClient:
    def get_order(self, order_id: str) -> dict[str, str]:
        return {'id': order_id, 'status': 'accepted'}

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, str] | None:
        _ = client_order_id
        return None

    def list_orders(self, status: str = 'all') -> list[dict[str, str]]:
        _ = status
        return []


class TestExecutionAdapters(TestCase):
    def test_lean_adapter_falls_back_to_alpaca_when_runner_unreachable(self) -> None:
        fallback = FakeFallbackAdapter()
        adapter = LeanExecutionAdapter(
            base_url='http://127.0.0.1:9',
            timeout_seconds=1,
            fallback=fallback,
        )

        payload = adapter.submit_order(
            symbol='AAPL',
            side='buy',
            qty=1.0,
            order_type='market',
            time_in_force='day',
            extra_params={'client_order_id': 'cid-1'},
        )

        self.assertEqual(payload.get('client_order_id'), 'cid-1')
        self.assertEqual(payload.get('_execution_adapter'), 'alpaca_fallback')
        self.assertEqual(adapter.last_route, 'alpaca_fallback')
        self.assertEqual(len(fallback.submitted), 1)
        self.assertEqual(payload.get('_execution_route_expected'), 'lean')
        self.assertEqual(payload.get('_execution_fallback_count'), 1)
        self.assertTrue(str(payload.get('_execution_fallback_reason', '')).startswith('lean_submit_order_'))

    def test_lean_submit_contract_violation_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(self, method: str, path: str, payload: dict[str, str] | None = None):  # type: ignore[override]
                _ = (method, path, payload)
                return {'status': 'accepted'}  # missing id/symbol/qty contract keys

        fallback = FakeFallbackAdapter()
        adapter = InvalidLeanAdapter(base_url='http://lean.invalid', timeout_seconds=1, fallback=fallback)

        payload = adapter.submit_order(
            symbol='MSFT',
            side='buy',
            qty=2.0,
            order_type='market',
            time_in_force='day',
            extra_params={'client_order_id': 'cid-2'},
        )

        self.assertEqual(adapter.last_route, 'alpaca_fallback')
        self.assertEqual(payload.get('_execution_adapter'), 'alpaca_fallback')
        self.assertEqual(payload.get('symbol'), 'MSFT')
        self.assertEqual(payload.get('client_order_id'), 'cid-2')
        self.assertEqual(payload.get('_execution_fallback_reason'), 'lean_submit_order_contract_violation')

    def test_lean_get_order_contract_violation_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(self, method: str, path: str, payload: dict[str, str] | None = None):  # type: ignore[override]
                _ = (method, path, payload)
                return {'symbol': 'AAPL'}  # missing id/status

        fallback = FakeFallbackAdapter()
        fallback.submit_order(
            symbol='AAPL',
            side='buy',
            qty=1.0,
            order_type='market',
            time_in_force='day',
            extra_params={'client_order_id': 'cid-3'},
        )
        adapter = InvalidLeanAdapter(base_url='http://lean.invalid', timeout_seconds=1, fallback=fallback)

        order = adapter.get_order('order-1')

        self.assertEqual(adapter.last_route, 'alpaca_fallback')
        self.assertEqual(order.get('id'), 'order-1')
        self.assertEqual(order.get('status'), 'accepted')
        self.assertEqual(order.get('_execution_fallback_reason'), 'lean_get_order_contract_violation')
        self.assertEqual(order.get('_execution_fallback_count'), 1)

    def test_lean_list_orders_contract_violation_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(self, method: str, path: str, payload: dict[str, str] | None = None):  # type: ignore[override]
                _ = (method, path, payload)
                return {'orders': [{'symbol': 'AAPL'}]}  # missing id/status

        fallback = FakeFallbackAdapter()
        fallback.submit_order(
            symbol='AAPL',
            side='buy',
            qty=1.0,
            order_type='market',
            time_in_force='day',
            extra_params={'client_order_id': 'cid-4'},
        )
        adapter = InvalidLeanAdapter(base_url='http://lean.invalid', timeout_seconds=1, fallback=fallback)

        orders = adapter.list_orders()

        self.assertEqual(adapter.last_route, 'alpaca_fallback')
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0].get('id'), 'order-1')
        self.assertEqual(orders[0].get('_execution_fallback_reason'), 'lean_list_orders_contract_violation')
        self.assertEqual(orders[0].get('_execution_fallback_count'), 1)

    def test_lean_submit_symbol_mismatch_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(self, method: str, path: str, payload: dict[str, str] | None = None):  # type: ignore[override]
                _ = (method, path, payload)
                return {
                    'id': 'lean-order-1',
                    'status': 'accepted',
                    'symbol': 'TSLA',
                    'qty': '1',
                    'client_order_id': 'cid-5',
                }

        fallback = FakeFallbackAdapter()
        adapter = InvalidLeanAdapter(base_url='http://lean.invalid', timeout_seconds=1, fallback=fallback)

        payload = adapter.submit_order(
            symbol='AAPL',
            side='buy',
            qty=1.0,
            order_type='market',
            time_in_force='day',
            extra_params={'client_order_id': 'cid-5'},
        )

        self.assertEqual(adapter.last_route, 'alpaca_fallback')
        self.assertEqual(payload.get('symbol'), 'AAPL')
        self.assertEqual(payload.get('_execution_fallback_reason'), 'lean_submit_order_contract_violation')

    def test_symbol_allowlist_policy(self) -> None:
        original_adapter = config.settings.trading_execution_adapter
        original_policy = config.settings.trading_execution_adapter_policy
        original_symbols = config.settings.trading_execution_adapter_symbols_raw
        try:
            config.settings.trading_execution_adapter = 'lean'
            config.settings.trading_execution_adapter_policy = 'allowlist'
            config.settings.trading_execution_adapter_symbols_raw = 'NVDA,MU'
            self.assertTrue(adapter_enabled_for_symbol('NVDA'))
            self.assertFalse(adapter_enabled_for_symbol('AAPL'))

            config.settings.trading_execution_adapter_policy = 'all'
            self.assertTrue(adapter_enabled_for_symbol('AAPL'))

            config.settings.trading_execution_adapter_policy = 'allowlist'
            config.settings.trading_execution_adapter_symbols_raw = ''
            self.assertTrue(adapter_enabled_for_symbol('AAPL'))
        finally:
            config.settings.trading_execution_adapter = original_adapter
            config.settings.trading_execution_adapter_policy = original_policy
            config.settings.trading_execution_adapter_symbols_raw = original_symbols

    def test_build_execution_adapter_falls_back_when_healthcheck_required_and_unhealthy(self) -> None:
        original_adapter = config.settings.trading_execution_adapter
        original_mode = config.settings.trading_mode
        original_url = config.settings.trading_lean_runner_url
        original_fallback = config.settings.trading_execution_fallback_adapter
        original_healthcheck_enabled = config.settings.trading_lean_runner_healthcheck_enabled
        original_healthcheck_required = config.settings.trading_lean_runner_require_healthy
        try:
            config.settings.trading_execution_adapter = 'lean'
            config.settings.trading_mode = 'live'
            config.settings.trading_lean_runner_url = 'http://lean.invalid'
            config.settings.trading_execution_fallback_adapter = 'alpaca'
            config.settings.trading_lean_runner_healthcheck_enabled = True
            config.settings.trading_lean_runner_require_healthy = True

            with patch('app.trading.execution_adapters._check_lean_runner_health', return_value=(False, 'timeout')):
                adapter = build_execution_adapter(
                    alpaca_client=FakeReadClient(),
                    order_firewall=FakeOrderFirewall(),
                )
            self.assertEqual(adapter.name, 'alpaca')
        finally:
            config.settings.trading_execution_adapter = original_adapter
            config.settings.trading_mode = original_mode
            config.settings.trading_lean_runner_url = original_url
            config.settings.trading_execution_fallback_adapter = original_fallback
            config.settings.trading_lean_runner_healthcheck_enabled = original_healthcheck_enabled
            config.settings.trading_lean_runner_require_healthy = original_healthcheck_required

    def test_build_execution_adapter_allows_lean_when_healthcheck_nonblocking(self) -> None:
        original_adapter = config.settings.trading_execution_adapter
        original_mode = config.settings.trading_mode
        original_url = config.settings.trading_lean_runner_url
        original_fallback = config.settings.trading_execution_fallback_adapter
        original_healthcheck_enabled = config.settings.trading_lean_runner_healthcheck_enabled
        original_healthcheck_required = config.settings.trading_lean_runner_require_healthy
        try:
            config.settings.trading_execution_adapter = 'lean'
            config.settings.trading_mode = 'paper'
            config.settings.trading_lean_runner_url = 'http://lean.invalid'
            config.settings.trading_execution_fallback_adapter = 'alpaca'
            config.settings.trading_lean_runner_healthcheck_enabled = True
            config.settings.trading_lean_runner_require_healthy = False

            with patch('app.trading.execution_adapters._check_lean_runner_health', return_value=(False, 'timeout')):
                adapter = build_execution_adapter(
                    alpaca_client=FakeReadClient(),
                    order_firewall=FakeOrderFirewall(),
                )
            self.assertEqual(adapter.name, 'lean')
        finally:
            config.settings.trading_execution_adapter = original_adapter
            config.settings.trading_mode = original_mode
            config.settings.trading_lean_runner_url = original_url
            config.settings.trading_execution_fallback_adapter = original_fallback
            config.settings.trading_lean_runner_healthcheck_enabled = original_healthcheck_enabled
            config.settings.trading_lean_runner_require_healthy = original_healthcheck_required
