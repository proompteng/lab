from __future__ import annotations

import json
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from typing import Any, ClassVar
from unittest import TestCase

from scripts import verify_trading_readiness as verifier
from scripts.verify_trading_readiness import evaluate_trading_readiness, main


def _ready_status() -> dict[str, object]:
    return {
        'mode': 'paper',
        'running': True,
        'last_error': None,
        'metrics': {
            'market_session_open': 1,
            'decisions_total': 3,
            'orders_submitted_total': 2,
        },
        'proof_floor': {
            'floor_state': 'paper_ready',
            'route_state': 'paper_candidate',
            'capital_state': 'paper_allowed',
            'max_notional': '250',
            'blocking_reasons': [],
            'proof_dimensions': [
                {
                    'dimension': 'alpha_readiness',
                    'state': 'pass',
                    'reason': 'promotion_eligible',
                },
                {
                    'dimension': 'market_context',
                    'state': 'pass',
                    'reason': 'fresh',
                },
                {
                    'dimension': 'quant_ingestion',
                    'state': 'pass',
                    'reason': 'fresh',
                },
                {
                    'dimension': 'execution_tca',
                    'state': 'pass',
                    'reason': 'fresh',
                    'source_ref': {
                        'symbol_routes': {
                            'scope_symbols': ['NVDA', 'AVGO'],
                            'routeable_symbol_count': 2,
                            'blocked_symbol_count': 0,
                            'missing_symbol_count': 0,
                            'routeable_symbols': [
                                {'symbol': 'NVDA', 'avg_abs_slippage_bps': '4.2'},
                                {'symbol': 'AVGO', 'avg_abs_slippage_bps': '5.1'},
                            ],
                            'blocked_symbols': [],
                            'missing_symbols': [],
                        }
                    },
                },
            ],
        },
    }


class _JsonHandler(BaseHTTPRequestHandler):
    payload: ClassVar[object] = {}

    def do_GET(self) -> None:
        body = json.dumps(self.payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def _load_from_test_server(payload: object) -> dict[str, object]:
    response_payload = payload

    class Handler(_JsonHandler):
        payload: ClassVar[object] = response_payload

    server = HTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        host, port = server.server_address
        return verifier._load_status_url(f'http://{host}:{port}/status', timeout_seconds=2.0)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class TestVerifyTradingReadiness(TestCase):
    def test_ready_paper_status_passes_strict_gate(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            profile='paper',
            min_routeable_symbols=2,
            min_decisions=1,
            min_orders=1,
        )

        self.assertTrue(result['ok'])
        self.assertEqual(result['failed_checks'], [])

    def test_live_and_either_profiles_use_live_floor_states_and_market_window(self) -> None:
        status = _ready_status()
        status['mode'] = 'live'
        metrics = status['metrics']
        assert isinstance(metrics, dict)
        metrics.pop('market_session_open')
        proof_floor = status['proof_floor']
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                'floor_state': 'live_micro_ready',
                'route_state': 'live_micro_candidate',
                'capital_state': 'live_allowed',
                'market_window': {'session_open': 'open'},
            }
        )

        live = evaluate_trading_readiness(status, profile='live', min_routeable_symbols=2)
        either = evaluate_trading_readiness(status, profile='either', min_routeable_symbols=2)

        self.assertTrue(live['ok'], live)
        self.assertTrue(either['ok'], either)

    def test_repair_only_route_universe_fails_with_actionable_checks(self) -> None:
        status = _ready_status()
        proof_floor = status['proof_floor']
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                'floor_state': 'repair_only',
                'route_state': 'repair_only',
                'capital_state': 'zero_notional',
                'max_notional': '0',
                'blocking_reasons': [
                    'alpha_readiness_not_promotion_eligible',
                    'execution_tca_route_universe_empty',
                    'market_context_stale',
                ],
            }
        )
        dimensions = proof_floor['proof_dimensions']
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get('dimension') == 'alpha_readiness':
                dimension['state'] = 'fail'
                dimension['reason'] = 'alpha_readiness_not_promotion_eligible'
            if dimension.get('dimension') == 'market_context':
                dimension['state'] = 'stale'
                dimension['reason'] = 'market_context_stale'
            if dimension.get('dimension') == 'execution_tca':
                dimension['state'] = 'fail'
                dimension['reason'] = 'execution_tca_route_universe_empty'
                source_ref = dimension['source_ref']
                assert isinstance(source_ref, dict)
                symbol_routes = source_ref['symbol_routes']
                assert isinstance(symbol_routes, dict)
                symbol_routes.update(
                    {
                        'routeable_symbol_count': 0,
                        'blocked_symbol_count': 1,
                        'missing_symbol_count': 1,
                        'routeable_symbols': [],
                        'blocked_symbols': [{'symbol': 'NVDA'}],
                        'missing_symbols': ['AVGO'],
                    }
                )

        result = evaluate_trading_readiness(
            status,
            profile='paper',
            min_routeable_symbols=2,
            min_decisions=1,
            min_orders=1,
        )

        self.assertFalse(result['ok'])
        self.assertIn('proof_floor_state', result['failed_checks'])
        self.assertIn('capital_state', result['failed_checks'])
        self.assertIn('alpha_readiness_pass', result['failed_checks'])
        self.assertIn('market_context_pass', result['failed_checks'])
        self.assertIn('execution_tca_pass', result['failed_checks'])
        self.assertIn('routeable_symbol_count', result['failed_checks'])
        self.assertIn('blocked_symbol_count', result['failed_checks'])
        self.assertIn('missing_symbol_count', result['failed_checks'])

    def test_quant_empty_fails_unless_informational_quant_is_allowed(self) -> None:
        status = _ready_status()
        proof_floor = status['proof_floor']
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor['proof_dimensions']
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if isinstance(dimension, dict) and dimension.get('dimension') == 'quant_ingestion':
                dimension['state'] = 'informational'
                dimension['reason'] = 'quant_latest_metrics_empty'

        strict = evaluate_trading_readiness(status, require_quant_fresh=True)
        permissive = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(strict['ok'])
        self.assertIn('quant_ingestion_ready', strict['failed_checks'])
        self.assertTrue(permissive['ok'])

    def test_payload_helpers_handle_runtime_payload_shapes(self) -> None:
        self.assertTrue(verifier._bool('open'))
        self.assertFalse(verifier._bool(object()))
        self.assertEqual(verifier._int(True), 1)
        self.assertEqual(verifier._int(3.8), 3)
        self.assertEqual(verifier._int('7.9'), 7)
        self.assertEqual(verifier._int('not-a-number', default=4), 4)
        self.assertEqual(verifier._int('', default=4), 4)
        self.assertIsNone(verifier._decimal(None))
        self.assertIsNone(verifier._decimal('not-a-number'))
        self.assertEqual(verifier._mapping(object()), {})
        self.assertEqual(verifier._sequence('NVDA'), [])

    def test_status_loaders_require_json_objects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / 'status.json'
            status_path.write_text(json.dumps(['not', 'an', 'object']), encoding='utf-8')

            with self.assertRaisesRegex(ValueError, 'json_object_required'):
                verifier._load_json_object(status_path)

        self.assertEqual(_load_from_test_server({'ok': True}), {'ok': True})
        with self.assertRaisesRegex(ValueError, 'json_object_required'):
            _load_from_test_server(['not', 'an', 'object'])

    def test_cli_returns_nonzero_for_failed_status_file(self) -> None:
        status = _ready_status()
        status['running'] = False
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / 'status.json'
            status_path.write_text(json.dumps(status), encoding='utf-8')

            exit_code = main(['--status-file', str(status_path)])

        self.assertEqual(exit_code, 1)
