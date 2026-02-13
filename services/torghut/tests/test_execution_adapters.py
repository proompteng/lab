from __future__ import annotations

from unittest import TestCase

from app import config
from app.trading.execution_adapters import LeanExecutionAdapter, adapter_enabled_for_symbol


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
