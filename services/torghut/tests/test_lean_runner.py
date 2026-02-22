from __future__ import annotations

from unittest import TestCase

from fastapi.testclient import TestClient

import app.lean_runner as lean_runner


class FakeTradingClient:
    def __init__(self) -> None:
        self.submit_calls = 0

    def submit_order(self, request):  # type: ignore[no-untyped-def]
        self.submit_calls += 1
        return {
            'id': f'order-{self.submit_calls}',
            'client_order_id': getattr(request, 'client_order_id', 'cid-1') or 'cid-1',
            'symbol': getattr(request, 'symbol', 'AAPL') or 'AAPL',
            'qty': str(getattr(request, 'qty', 1) or 1),
            'status': 'accepted',
        }

    def cancel_order_by_id(self, _order_id: str) -> None:
        return None

    def cancel_orders(self):  # type: ignore[no-untyped-def]
        return []

    def get_order_by_id(self, order_id: str):  # type: ignore[no-untyped-def]
        return {'id': order_id, 'status': 'accepted', 'qty': '1'}

    def get_orders(self, _query):  # type: ignore[no-untyped-def]
        return []


class TestLeanRunner(TestCase):
    def setUp(self) -> None:
        lean_runner.app.state.trading_client = FakeTradingClient()
        lean_runner._idempotency_cache.clear()
        lean_runner._backtests.clear()

    def test_submit_order_idempotency_replay(self) -> None:
        client = TestClient(lean_runner.app)
        payload = {
            'symbol': 'AAPL',
            'side': 'buy',
            'qty': 1,
            'order_type': 'market',
            'time_in_force': 'day',
            'extra_params': {'client_order_id': 'cid-1'},
        }

        first = client.post('/v1/orders/submit', json=payload, headers={'Idempotency-Key': 'cid-1'})
        second = client.post('/v1/orders/submit', json=payload, headers={'Idempotency-Key': 'cid-1'})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json().get('id'), second.json().get('id'))
        self.assertFalse(first.json().get('_lean_audit', {}).get('idempotent_replay'))
        self.assertTrue(second.json().get('_lean_audit', {}).get('idempotent_replay'))

    def test_backtest_submit_and_get(self) -> None:
        client = TestClient(lean_runner.app)
        submitted = client.post('/v1/backtests/submit', json={'lane': 'research', 'config': {'symbol': 'BTC/USD'}})

        self.assertEqual(submitted.status_code, 200)
        backtest_id = submitted.json()['backtest_id']
        lean_runner._backtests[backtest_id].due_at = 0

        fetched = client.get(f'/v1/backtests/{backtest_id}')
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.json().get('status'), 'completed')
        self.assertTrue(fetched.json().get('result', {}).get('deterministic_replay_passed'))

    def test_strategy_shadow_endpoint(self) -> None:
        client = TestClient(lean_runner.app)
        response = client.post(
            '/v1/strategy-shadow/evaluate',
            json={'strategy_id': 's1', 'symbol': 'BTC/USD', 'intent': {'qty': 1}},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn(payload.get('parity_status'), {'pass', 'drift'})
        self.assertIn('governance', payload)
