from __future__ import annotations

from typing import Any
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.execution_adapters import (
    LeanExecutionAdapter,
    SimulationExecutionAdapter,
    adapter_enabled_for_symbol,
    build_execution_adapter,
)


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

    def list_positions(self) -> list[dict[str, str]]:
        return []


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

    def list_positions(self) -> list[dict[str, str]]:
        return []


class TestExecutionAdapters(TestCase):
    def test_simulation_adapter_returns_filled_order_with_simulation_context(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        payload = adapter.submit_order(
            symbol='AAPL',
            side='buy',
            qty=2.0,
            order_type='market',
            time_in_force='day',
            extra_params={
                'client_order_id': 'decision-1',
                'simulation_context': {
                    'dataset_event_id': 'evt-1',
                    'source_topic': 'torghut.trades.v1',
                    'source_partition': 2,
                    'source_offset': 100,
                },
            },
        )
        self.assertEqual(payload.get('status'), 'filled')
        self.assertEqual(payload.get('client_order_id'), 'decision-1')
        simulation_context = payload.get('simulation_context')
        self.assertIsInstance(simulation_context, dict)
        assert isinstance(simulation_context, dict)
        self.assertEqual(simulation_context.get('simulation_run_id'), 'sim-2026-02-27-01')
        self.assertEqual(simulation_context.get('dataset_id'), 'dataset-1')
        self.assertEqual(simulation_context.get('dataset_event_id'), 'evt-1')
        self.assertEqual(payload.get('_execution_route_actual'), 'simulation')

    def test_simulation_adapter_does_not_cancel_filled_order(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        payload = adapter.submit_order(
            symbol='AAPL',
            side='buy',
            qty=1.0,
            order_type='market',
            time_in_force='day',
            extra_params={'client_order_id': 'decision-2'},
        )
        order_id = str(payload.get('id'))
        self.assertFalse(adapter.cancel_order(order_id))
        fetched = adapter.get_order(order_id)
        self.assertEqual(fetched.get('status'), 'filled')

    def test_simulation_adapter_tracks_synthetic_positions(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        adapter.submit_order(
            symbol='AAPL',
            side='buy',
            qty=1.5,
            order_type='market',
            time_in_force='day',
            limit_price=10.0,
            extra_params={'client_order_id': 'decision-long'},
        )
        positions = adapter.list_positions()
        self.assertEqual(
            positions,
            [
                {
                    'symbol': 'AAPL',
                    'qty': '1.5',
                    'side': 'long',
                    'market_value': '15',
                    'alpaca_account_label': 'paper',
                }
            ],
        )
        adapter.submit_order(
            symbol='AAPL',
            side='sell',
            qty=2.0,
            order_type='market',
            time_in_force='day',
            limit_price=10.0,
            extra_params={'client_order_id': 'decision-short'},
        )
        positions = adapter.list_positions()
        self.assertEqual(
            positions,
            [
                {
                    'symbol': 'AAPL',
                    'qty': '0.5',
                    'side': 'short',
                    'market_value': '-5',
                    'alpaca_account_label': 'paper',
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
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        with patch(
            'app.trading.execution_adapters.active_simulation_runtime_context',
            side_effect=[
                {'run_id': 'sim-2026-02-27-01', 'dataset_id': 'dataset-1'},
                {'run_id': 'sim-2026-02-27-01', 'dataset_id': 'dataset-1'},
                {'run_id': 'sim-2026-02-28-01', 'dataset_id': 'dataset-2'},
            ],
        ):
            adapter.submit_order(
                symbol='AAPL',
                side='buy',
                qty=1.0,
                order_type='market',
                time_in_force='day',
                extra_params={'client_order_id': 'decision-a'},
            )
            self.assertEqual(len(adapter.list_orders()), 1)
            adapter.submit_order(
                symbol='MSFT',
                side='buy',
                qty=2.0,
                order_type='market',
                time_in_force='day',
                extra_params={'client_order_id': 'decision-b'},
            )

        orders = adapter.list_orders()
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0].get('client_order_id'), 'decision-b')
        positions = adapter.list_positions()
        self.assertEqual(
            positions,
            [
                {
                    'symbol': 'MSFT',
                    'qty': '2',
                    'side': 'long',
                    'market_value': '2',
                    'alpaca_account_label': 'paper',
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
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        adapter.seed_positions_snapshot(
            [
                {'symbol': 'AAPL', 'qty': '2.5', 'side': 'long', 'market_value': '250'},
                {'symbol': 'MSFT', 'qty': '1', 'side': 'short', 'market_value': '10'},
            ]
        )
        adapter.seed_positions_snapshot(
            [
                {'symbol': 'AAPL', 'qty': '9', 'side': 'long'},
            ]
        )

        adapter.submit_order(
            symbol='AAPL',
            side='sell',
            qty=0.5,
            order_type='market',
            time_in_force='day',
            limit_price=100.0,
            extra_params={'client_order_id': 'decision-seeded-sell'},
        )

        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    'symbol': 'AAPL',
                    'qty': '2',
                    'side': 'long',
                    'market_value': '200',
                    'alpaca_account_label': 'paper',
                },
                {
                    'symbol': 'MSFT',
                    'qty': '1',
                    'side': 'short',
                    'market_value': '-10',
                    'alpaca_account_label': 'paper',
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
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        adapter.submit_order(
            symbol='AAPL',
            side='buy',
            qty=10.0,
            order_type='market',
            time_in_force='day',
            limit_price=100.0,
            extra_params={'client_order_id': 'decision-integer'},
        )
        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    'symbol': 'AAPL',
                    'qty': '10',
                    'side': 'long',
                    'market_value': '1000',
                    'alpaca_account_label': 'paper',
                }
            ],
        )

    def test_simulation_adapter_does_not_emit_partial_market_value_for_untracked_seed(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        adapter.seed_positions_snapshot(
            [
                {'symbol': 'AAPL', 'qty': '2', 'side': 'long'},
            ]
        )

        adapter.submit_order(
            symbol='AAPL',
            side='sell',
            qty=0.5,
            order_type='market',
            time_in_force='day',
            limit_price=100.0,
            extra_params={'client_order_id': 'decision-seeded-reduce'},
        )

        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    'symbol': 'AAPL',
                    'qty': '1.5',
                    'side': 'long',
                    'alpaca_account_label': 'paper',
                }
            ],
        )

    def test_simulation_adapter_tracks_cross_zero_market_value_after_untracked_seed(self) -> None:
        adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic='torghut.sim.trade-updates.v1',
            account_label='paper',
            simulation_run_id='sim-2026-02-27-01',
            dataset_id='dataset-1',
        )
        adapter.seed_positions_snapshot(
            [
                {'symbol': 'AAPL', 'qty': '2', 'side': 'long'},
            ]
        )

        adapter.submit_order(
            symbol='AAPL',
            side='sell',
            qty=3.0,
            order_type='market',
            time_in_force='day',
            limit_price=100.0,
            extra_params={'client_order_id': 'decision-seeded-cross-zero'},
        )

        self.assertEqual(
            adapter.list_positions(),
            [
                {
                    'symbol': 'AAPL',
                    'qty': '1',
                    'side': 'short',
                    'market_value': '-100',
                    'alpaca_account_label': 'paper',
                }
            ],
        )

    def test_build_execution_adapter_uses_simulation_when_enabled(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        original_sim_topic = config.settings.trading_simulation_order_updates_topic
        original_sim_bootstrap = config.settings.trading_simulation_order_updates_bootstrap_servers
        original_order_bootstrap = config.settings.trading_order_feed_bootstrap_servers
        original_run_id = config.settings.trading_simulation_run_id
        original_dataset = config.settings.trading_simulation_dataset_id
        try:
            config.settings.trading_simulation_enabled = True
            config.settings.trading_simulation_order_updates_topic = 'torghut.sim.trade-updates.v1'
            config.settings.trading_simulation_order_updates_bootstrap_servers = None
            config.settings.trading_order_feed_bootstrap_servers = None
            config.settings.trading_simulation_run_id = 'sim-2026'
            config.settings.trading_simulation_dataset_id = 'dataset-a'
            adapter = build_execution_adapter(
                alpaca_client=FakeReadClient(),
                order_firewall=FakeOrderFirewall(),
            )
            self.assertEqual(adapter.name, 'simulation')
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled
            config.settings.trading_simulation_order_updates_topic = original_sim_topic
            config.settings.trading_simulation_order_updates_bootstrap_servers = original_sim_bootstrap
            config.settings.trading_order_feed_bootstrap_servers = original_order_bootstrap
            config.settings.trading_simulation_run_id = original_run_id
            config.settings.trading_simulation_dataset_id = original_dataset

    def test_build_execution_adapter_uses_alpaca_when_simulation_disabled(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        try:
            config.settings.trading_simulation_enabled = False
            adapter = build_execution_adapter(
                alpaca_client=FakeReadClient(),
                order_firewall=FakeOrderFirewall(),
            )
            self.assertEqual(adapter.name, 'alpaca')
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled

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
            'sys.modules',
            {'kafka': SimpleNamespace(KafkaProducer=_FakeProducer)},
        ):
            adapter = SimulationExecutionAdapter(
                bootstrap_servers='kafka:9092',
                security_protocol='SASL_PLAINTEXT',
                sasl_mechanism='SCRAM-SHA-512',
                sasl_username='user',
                sasl_password='secret',
                topic='torghut.sim.trade-updates.v1',
                account_label='paper',
                simulation_run_id='sim-2026-02-27-01',
                dataset_id='dataset-1',
            )
            self.assertIsNotNone(adapter)
        self.assertEqual(captured_kwargs.get('security_protocol'), 'SASL_PLAINTEXT')
        self.assertEqual(captured_kwargs.get('sasl_mechanism'), 'SCRAM-SHA-512')
        self.assertEqual(captured_kwargs.get('sasl_plain_username'), 'user')
        self.assertEqual(captured_kwargs.get('sasl_plain_password'), 'secret')

    def test_adapter_enabled_for_symbol_true_for_simulation(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        try:
            config.settings.trading_simulation_enabled = True
            self.assertTrue(adapter_enabled_for_symbol('AAPL'))
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled

    def test_adapter_enabled_for_symbol_false_without_simulation(self) -> None:
        original_sim_enabled = config.settings.trading_simulation_enabled
        try:
            config.settings.trading_simulation_enabled = False
            self.assertFalse(adapter_enabled_for_symbol('AAPL'))
        finally:
            config.settings.trading_simulation_enabled = original_sim_enabled

    def test_lean_submit_includes_correlation_and_idempotency_audit_fields(self) -> None:
        class CapturingLeanAdapter(LeanExecutionAdapter):
            def __init__(self, **kwargs):  # type: ignore[no-untyped-def]
                super().__init__(**kwargs)
                self.captured_headers: dict[str, str] = {}

            def _request_json_with_headers(  # type: ignore[override]
                self,
                method: str,
                path: str,
                payload: dict[str, str] | None,
                *,
                headers: dict[str, str] | None,
                operation: str,
            ):
                _ = (method, payload, operation)
                if headers:
                    self.captured_headers = dict(headers)
                if path == '/v1/shadow/simulate':
                    return {'parity_status': 'pass', 'simulated_slippage_bps': 0.1}
                return {
                    'id': 'lean-order-1',
                    'status': 'accepted',
                    'symbol': 'AAPL',
                    'qty': '1',
                    'client_order_id': 'cid-telemetry',
                }

        original_shadow = config.settings.trading_lean_shadow_execution_enabled
        original_disable = config.settings.trading_lean_lane_disable_switch
        try:
            config.settings.trading_lean_shadow_execution_enabled = True
            config.settings.trading_lean_lane_disable_switch = False
            adapter = CapturingLeanAdapter(base_url='http://lean.invalid', timeout_seconds=1, fallback=None)
            payload = adapter.submit_order(
                symbol='AAPL',
                side='buy',
                qty=1.0,
                order_type='market',
                time_in_force='day',
                extra_params={'client_order_id': 'cid-telemetry'},
            )
        finally:
            config.settings.trading_lean_shadow_execution_enabled = original_shadow
            config.settings.trading_lean_lane_disable_switch = original_disable

        self.assertIn('X-Correlation-ID', adapter.captured_headers)
        self.assertEqual(adapter.captured_headers.get('Idempotency-Key'), 'cid-telemetry')
        self.assertEqual(payload.get('_execution_idempotency_key'), 'cid-telemetry')
        self.assertTrue(str(payload.get('_execution_correlation_id', '')).startswith('torghut-'))
        self.assertEqual(payload.get('_lean_shadow', {}).get('parity_status'), 'pass')

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
            def _request_json(  # type: ignore[override]
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                *,
                headers: dict[str, str] | None = None,
                operation: str = 'request_json',
            ):
                _ = (method, path, payload, headers, operation)
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
            def _request_json(  # type: ignore[override]
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                *,
                headers: dict[str, str] | None = None,
                operation: str = 'request_json',
            ):
                _ = (method, path, payload, headers, operation)
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
            def _request_json(  # type: ignore[override]
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                *,
                headers: dict[str, str] | None = None,
                operation: str = 'request_json',
            ):
                _ = (method, path, payload, headers, operation)
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

    def test_lean_list_positions_returns_none_without_fallback(self) -> None:
        adapter = LeanExecutionAdapter(
            base_url='http://lean.invalid',
            timeout_seconds=1,
            fallback=None,
        )
        self.assertIsNone(adapter.list_positions())

    def test_lean_submit_symbol_mismatch_triggers_fallback(self) -> None:
        class InvalidLeanAdapter(LeanExecutionAdapter):
            def _request_json(  # type: ignore[override]
                self,
                method: str,
                path: str,
                payload: dict[str, Any] | None = None,
                *,
                headers: dict[str, str] | None = None,
                operation: str = 'request_json',
            ):
                _ = (method, path, payload, headers, operation)
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
