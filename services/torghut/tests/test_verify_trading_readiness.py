from __future__ import annotations

import json
import tempfile
from decimal import Decimal
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
        'route_reacquisition_board': {
            'schema_version': 'torghut.route-reacquisition-board.v1',
            'state': 'candidate',
            'capital_state': 'paper_allowed',
            'jangar_continuity': {
                'epoch_id': 'truth-settlement:paper_canary:ready',
                'state': 'present',
                'decision': 'allow',
                'fresh_until': '2026-05-08T12:00:00+00:00',
                'blocking_reasons': [],
            },
            'summary': {
                'row_count': 2,
                'state_counts': {'routeable': 2},
                'zero_notional_row_count': 0,
                'expected_unblock_value': 8,
                'top_repair_symbols': [],
                'capital_eligible_symbol_count': 2,
            },
            'rows': [
                {
                    'symbol': 'NVDA',
                    'state': 'routeable',
                    'max_notional': '250',
                },
                {
                    'symbol': 'AVGO',
                    'state': 'routeable',
                    'max_notional': '250',
                },
            ],
        },
        'route_reacquisition_book': {
            'schema_version': 'torghut.route-reacquisition-book.v1',
            'state': 'paper_candidate',
            'summary': {
                'paper_route_probe_eligible_symbols': ['NVDA'],
                'paper_route_probe_active_symbols': ['NVDA'],
            },
            'paper_route_probe': {
                'configured_enabled': True,
                'configured_max_notional': '25',
                'active': True,
                'effective_max_notional': '25',
                'next_session_max_notional': '25',
                'eligible_symbol_count': 1,
                'eligible_symbols': ['NVDA'],
                'active_symbols': ['NVDA'],
                'blocking_reasons': [],
                'capital_authority': 'none',
            },
        },
    }


def _completion_status(
    *,
    gate_status: str = 'satisfied',
    blocked_reason: str | None = None,
    net_pnl: str = '600',
    expectancy_bps: str = '12.5',
    trading_day_count: int | None = 25,
    ledger_refs: list[str] | None = None,
    unbacked_refs: list[str] | None = None,
) -> dict[str, object]:
    runtime_ledger_summary: dict[str, object] = {
        'runtime_ledger_bucket_count': 1,
        'runtime_ledger_fill_count': 4,
        'runtime_ledger_closed_trade_count': 2,
        'runtime_ledger_filled_notional': '50000',
        'runtime_ledger_net_strategy_pnl_after_costs': net_pnl,
        'runtime_ledger_post_cost_expectancy_bps': expectancy_bps,
    }
    if trading_day_count is not None:
        runtime_ledger_summary['runtime_ledger_observed_trading_day_count'] = (
            trading_day_count
        )
    return {
        'doc_id': 'doc29',
        'summary': {'all_satisfied': gate_status == 'satisfied'},
        'gates': [
            {
                'gate_id': verifier.DOC29_LIVE_SCALE_GATE,
                'status': gate_status,
                'blocked_reason': blocked_reason,
                'candidate_id': 'cand-1',
                'db_row_refs': {
                    'strategy_runtime_ledger_buckets': ledger_refs
                    if ledger_refs is not None
                    else ['bucket-1'],
                    'runtime_ledger_unbacked_hypothesis_metric_windows': unbacked_refs
                    if unbacked_refs is not None
                    else [],
                },
                'runtime_ledger_summary': runtime_ledger_summary,
            }
        ],
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
        return verifier._load_status_url(
            f'http://{host}:{port}/status', timeout_seconds=2.0
        )
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

    def test_runtime_ledger_profit_proof_can_be_required_from_completion_status(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(),
            profile='paper',
            min_routeable_symbols=2,
            min_runtime_ledger_net_pnl=Decimal('500'),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal('20'),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertTrue(result['ok'], result)
        self.assertEqual(result['failed_checks'], [])
        self.assertEqual(
            result['completion_profit_proof']['gate_id'],
            verifier.DOC29_LIVE_SCALE_GATE,
        )

    def test_runtime_ledger_profit_proof_fails_closed_on_missing_or_weak_completion(
        self,
    ) -> None:
        missing = evaluate_trading_readiness(
            _ready_status(),
            min_runtime_ledger_net_pnl=Decimal('500'),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(missing['ok'])
        self.assertIn('completion_status_present', missing['failed_checks'])

        weak = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                gate_status='blocked',
                blocked_reason='runtime_ledger_profit_proof_missing',
                net_pnl='499.99',
                expectancy_bps='0',
                trading_day_count=2,
                ledger_refs=[],
                unbacked_refs=['window-1'],
            ),
            min_runtime_ledger_net_pnl=Decimal('500'),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal('500'),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(weak['ok'])
        for check_name in (
            'doc29_live_scale_gate_satisfied',
            'runtime_ledger_db_refs_present',
            'runtime_ledger_unbacked_windows_empty',
            'runtime_ledger_observed_trading_days',
            'runtime_ledger_net_pnl_target',
            'runtime_ledger_daily_net_pnl_target',
            'runtime_ledger_post_cost_expectancy_positive',
        ):
            self.assertIn(check_name, weak['failed_checks'])

    def test_runtime_ledger_profit_proof_requires_observed_days_and_daily_pnl(
        self,
    ) -> None:
        short_window = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl='15000',
                trading_day_count=3,
            ),
            min_runtime_ledger_net_pnl=Decimal('12500'),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal('500'),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(short_window['ok'])
        self.assertIn(
            'runtime_ledger_observed_trading_days',
            short_window['failed_checks'],
        )

        weak_daily = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl='600',
                trading_day_count=25,
            ),
            min_runtime_ledger_net_pnl=Decimal('500'),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal('500'),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(weak_daily['ok'])
        self.assertIn(
            'runtime_ledger_daily_net_pnl_target',
            weak_daily['failed_checks'],
        )

    def test_live_and_either_profiles_use_live_floor_states_and_market_window(
        self,
    ) -> None:
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

        live = evaluate_trading_readiness(
            status, profile='live', min_routeable_symbols=2
        )
        either = evaluate_trading_readiness(
            status, profile='either', min_routeable_symbols=2
        )

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

        status['route_reacquisition_board'] = {
            'schema_version': 'torghut.route-reacquisition-board.v1',
            'state': 'repair_only',
            'capital_state': 'zero_notional',
            'summary': {
                'row_count': 2,
                'state_counts': {'blocked': 1, 'missing': 1},
                'zero_notional_row_count': 2,
                'expected_unblock_value': 3,
                'top_repair_symbols': ['NVDA', 'AVGO'],
                'capital_eligible_symbol_count': 0,
            },
            'rows': [
                {'symbol': 'NVDA', 'state': 'blocked', 'max_notional': '0'},
                {'symbol': 'AVGO', 'state': 'missing', 'max_notional': '0'},
            ],
        }

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
        self.assertIn('route_board_jangar_continuity_ready', result['failed_checks'])
        self.assertIn('route_board_capital_eligible_symbols', result['failed_checks'])
        self.assertIn('route_board_zero_notional_rows', result['failed_checks'])

    def test_optional_quant_empty_fails_unless_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status['proof_floor']
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor['proof_dimensions']
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get('dimension') == 'quant_ingestion'
            ):
                dimension['state'] = 'informational'
                dimension['reason'] = 'quant_latest_metrics_empty'
                dimension['source_ref'] = {'required': False}

        strict = evaluate_trading_readiness(status, require_quant_fresh=True)
        permissive = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(strict['ok'])
        self.assertIn('quant_ingestion_ready', strict['failed_checks'])
        self.assertTrue(permissive['ok'])

    def test_required_quant_empty_fails_even_when_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status['proof_floor']
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor['proof_dimensions']
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get('dimension') == 'quant_ingestion'
            ):
                dimension['state'] = 'informational'
                dimension['reason'] = 'quant_latest_metrics_empty'
                dimension['source_ref'] = {'required': True}

        result = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(result['ok'])
        self.assertIn('quant_ingestion_ready', result['failed_checks'])

    def test_legacy_evidence_required_quant_empty_fails_when_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status['proof_floor']
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor['proof_dimensions']
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get('dimension') == 'quant_ingestion'
            ):
                dimension['state'] = 'informational'
                dimension['reason'] = 'quant_latest_metrics_empty'
                dimension['source_ref'] = {'evidence_required': True}

        result = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(result['ok'])
        self.assertIn('quant_ingestion_ready', result['failed_checks'])

    def test_closed_session_paper_route_probe_candidate_can_be_required_for_next_session(
        self,
    ) -> None:
        status = _ready_status()
        metrics = status['metrics']
        assert isinstance(metrics, dict)
        metrics['market_session_open'] = 0
        route_book = status['route_reacquisition_book']
        assert isinstance(route_book, dict)
        probe = route_book['paper_route_probe']
        assert isinstance(probe, dict)
        probe.update(
            {
                'active': False,
                'effective_max_notional': '0',
                'next_session_max_notional': '25',
                'active_symbols': [],
                'blocking_reasons': ['market_session_closed'],
            }
        )
        summary = route_book['summary']
        assert isinstance(summary, dict)
        summary['paper_route_probe_active_symbols'] = []

        result = evaluate_trading_readiness(
            status,
            require_market_open=False,
            require_paper_route_probe_candidate=True,
        )

        self.assertTrue(result['ok'], result)
        self.assertEqual(result['paper_route_probe']['eligible_symbols'], ['NVDA'])
        self.assertEqual(
            result['paper_route_probe']['blocking_reasons'], ['market_session_closed']
        )

    def test_required_paper_route_probe_candidate_fails_without_bounded_candidate(
        self,
    ) -> None:
        status = _ready_status()
        route_book = status['route_reacquisition_book']
        assert isinstance(route_book, dict)
        probe = route_book['paper_route_probe']
        assert isinstance(probe, dict)
        probe.update(
            {
                'configured_enabled': False,
                'effective_max_notional': '0',
                'next_session_max_notional': '0',
                'eligible_symbol_count': 0,
                'eligible_symbols': [],
                'active_symbols': [],
                'blocking_reasons': ['paper_route_probe_disabled'],
            }
        )
        summary = route_book['summary']
        assert isinstance(summary, dict)
        summary['paper_route_probe_eligible_symbols'] = []
        summary['paper_route_probe_active_symbols'] = []

        result = evaluate_trading_readiness(
            status, require_paper_route_probe_candidate=True
        )

        self.assertFalse(result['ok'])
        self.assertIn('paper_route_probe_configured', result['failed_checks'])
        self.assertIn('paper_route_probe_candidate_symbols', result['failed_checks'])
        self.assertIn('paper_route_probe_notional_positive', result['failed_checks'])
        self.assertIn('paper_route_probe_blockers', result['failed_checks'])

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
            status_path.write_text(
                json.dumps(['not', 'an', 'object']), encoding='utf-8'
            )

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

    def test_cli_accepts_completion_file_for_runtime_ledger_profit_proof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / 'status.json'
            completion_path = Path(tmp_dir) / 'completion.json'
            status_path.write_text(json.dumps(_ready_status()), encoding='utf-8')
            completion_path.write_text(
                json.dumps(_completion_status()), encoding='utf-8'
            )

            exit_code = main(
                [
                    '--status-file',
                    str(status_path),
                    '--completion-file',
                    str(completion_path),
                    '--require-runtime-ledger-profit-proof',
                    '--min-runtime-ledger-net-pnl',
                    '500',
                    '--min-runtime-ledger-trading-days',
                    '25',
                    '--min-runtime-ledger-daily-net-pnl',
                    '20',
                ]
            )

        self.assertEqual(exit_code, 0)

    def test_cli_rejects_non_decimal_runtime_ledger_profit_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / 'status.json'
            status_path.write_text(json.dumps(_ready_status()), encoding='utf-8')

            with self.assertRaisesRegex(SystemExit, 'must be decimal'):
                main(
                    [
                        '--status-file',
                        str(status_path),
                        '--require-runtime-ledger-profit-proof',
                        '--min-runtime-ledger-net-pnl',
                        'not-a-number',
                    ]
                )

            with self.assertRaisesRegex(SystemExit, 'daily-net-pnl must be decimal'):
                main(
                    [
                        '--status-file',
                        str(status_path),
                        '--require-runtime-ledger-profit-proof',
                        '--min-runtime-ledger-daily-net-pnl',
                        'not-a-number',
                    ]
                )
