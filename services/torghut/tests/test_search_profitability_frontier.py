from __future__ import annotations

import io
import json
import sys
from argparse import Namespace
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml

import scripts.search_profitability_frontier as frontier
from scripts.search_profitability_frontier import apply_candidate_to_configmap, iter_parameter_candidates, resolve_sweep_window


class TestSearchProfitabilityFrontier(TestCase):
    def _write_strategy_configmap(self, root: Path) -> Path:
        path = root / 'strategy-configmap.yaml'
        path.write_text(
            yaml.safe_dump(
                {
                    'apiVersion': 'v1',
                    'kind': 'ConfigMap',
                    'data': {
                        'strategies.yaml': yaml.safe_dump(
                            {
                                'strategies': [
                                    {
                                        'name': 'breakout-continuation-long-v1',
                                        'enabled': True,
                                        'params': {
                                            'min_cross_section_continuation_rank': '0.45',
                                            'min_cross_section_continuation_breadth': '0.20',
                                            'min_recent_above_opening_window_close_ratio': '0.55',
                                            'min_recent_microprice_bias_bps': '0.05',
                                        },
                                    },
                                    {
                                        'name': 'late-day-continuation-long-v1',
                                        'enabled': True,
                                        'params': {'min_recent_microprice_bias_bps': '0.20'},
                                    },
                                ]
                            },
                            sort_keys=False,
                        ),
                    },
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        return path

    def _write_sweep_config(
        self,
        root: Path,
        *,
        ranks: list[str],
        hold_ratios: list[str] | None = None,
    ) -> Path:
        path = root / 'sweep.yaml'
        path.write_text(
            yaml.safe_dump(
                {
                    'schema_version': 'torghut.replay-frontier-sweep.v1',
                    'family': 'breakout_continuation',
                    'strategy_name': 'breakout-continuation-long-v1',
                    'disable_other_strategies': True,
                    'constraints': {
                        'holdout_target_net_per_day': '250',
                        'min_active_holdout_days': 3,
                        'max_worst_holdout_day_loss': '150',
                        'min_profit_factor': '1.5',
                        'require_training_decisions': True,
                        'require_holdout_decisions': True,
                    },
                    'parameters': {
                        'min_cross_section_continuation_rank': ranks,
                        'min_recent_above_opening_window_close_ratio': hold_ratios or ['0.55'],
                    },
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        return path

    @staticmethod
    def _payload(
        *,
        start_date: str,
        end_date: str,
        daily_net: dict[str, str],
        decision_count: int,
        filled_count: int,
        wins: int,
        losses: int,
    ) -> dict[str, object]:
        return {
            'start_date': start_date,
            'end_date': end_date,
            'net_pnl': str(sum(float(value) for value in daily_net.values())),
            'decision_count': decision_count,
            'filled_count': filled_count,
            'wins': wins,
            'losses': losses,
            'daily': {
                day: {
                    'net_pnl': value,
                    'filled_count': 1 if float(value) != 0 else 0,
                }
                for day, value in daily_net.items()
            },
        }

    def _make_args(
        self,
        *,
        strategy_configmap: Path,
        sweep_config: Path,
        json_output: Path,
    ) -> Namespace:
        return Namespace(
            strategy_configmap=strategy_configmap,
            sweep_config=sweep_config,
            clickhouse_http_url='http://example.invalid:8123',
            clickhouse_username='torghut',
            clickhouse_password='secret',
            start_equity='31590.02',
            chunk_minutes=10,
            symbols='',
            progress_log_seconds=30,
            train_days=5,
            holdout_days=5,
            top_n=10,
            json_output=json_output,
        )

    def test_resolve_sweep_window_uses_latest_train_and_holdout_days(self) -> None:
        days = [date(2026, 3, 2) + timedelta(days=index) for index in range(20)]

        window = resolve_sweep_window(days, train_days=10, holdout_days=5)

        self.assertEqual(len(window.train_days), 10)
        self.assertEqual(len(window.holdout_days), 5)
        self.assertEqual(window.train_days[0], days[5])
        self.assertEqual(window.train_days[-1], days[14])
        self.assertEqual(window.holdout_days[0], days[15])
        self.assertEqual(window.holdout_days[-1], days[19])

    def test_iter_parameter_candidates_is_deterministic(self) -> None:
        candidates = iter_parameter_candidates(
            {
                'min_rank': ['0.4', '0.5'],
                'min_hold_ratio': ['0.6', '0.7'],
            }
        )

        self.assertEqual(
            candidates,
            [
                {'min_rank': '0.4', 'min_hold_ratio': '0.6'},
                {'min_rank': '0.4', 'min_hold_ratio': '0.7'},
                {'min_rank': '0.5', 'min_hold_ratio': '0.6'},
                {'min_rank': '0.5', 'min_hold_ratio': '0.7'},
            ],
        )

    def test_iter_parameter_candidates_returns_single_empty_candidate_for_empty_grid(self) -> None:
        self.assertEqual(iter_parameter_candidates({}), [{}])

    def test_apply_candidate_to_configmap_updates_target_and_disables_others(self) -> None:
        configmap_payload = {
            'apiVersion': 'v1',
            'kind': 'ConfigMap',
            'data': {
                'strategies.yaml': yaml.safe_dump(
                    {
                        'strategies': [
                            {
                                'name': 'breakout-continuation-long-v1',
                                'enabled': False,
                                'params': {'min_cross_section_continuation_rank': '0.55'},
                            },
                            {
                                'name': 'late-day-continuation-long-v1',
                                'enabled': True,
                                'params': {'min_recent_microprice_bias_bps': '0.20'},
                            },
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = apply_candidate_to_configmap(
            configmap_payload=configmap_payload,
            strategy_name='breakout-continuation-long-v1',
            candidate_params={
                'min_cross_section_continuation_rank': '0.65',
                'min_recent_above_opening_window_close_ratio': '0.75',
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated['data']['strategies.yaml'])
        strategies = {item['name']: item for item in catalog['strategies']}
        self.assertTrue(strategies['breakout-continuation-long-v1']['enabled'])
        self.assertEqual(
            strategies['breakout-continuation-long-v1']['params']['min_cross_section_continuation_rank'],
            '0.65',
        )
        self.assertEqual(
            strategies['breakout-continuation-long-v1']['params']['min_recent_above_opening_window_close_ratio'],
            '0.75',
        )
        self.assertFalse(strategies['late-day-continuation-long-v1']['enabled'])

    def test_apply_candidate_to_configmap_coerces_non_mapping_params(self) -> None:
        configmap_payload = {
            'data': {
                'strategies.yaml': yaml.safe_dump(
                    {
                        'strategies': [
                            {
                                'name': 'breakout-continuation-long-v1',
                                'enabled': True,
                                'params': ['not-a-mapping'],
                            }
                        ]
                    },
                    sort_keys=False,
                )
            }
        }

        updated = apply_candidate_to_configmap(
            configmap_payload=configmap_payload,
            strategy_name='breakout-continuation-long-v1',
            candidate_params={'min_cross_section_continuation_rank': '0.65'},
            disable_other_strategies=False,
        )

        catalog = yaml.safe_load(updated['data']['strategies.yaml'])
        strategy = catalog['strategies'][0]
        self.assertEqual(strategy['params'], {'min_cross_section_continuation_rank': '0.65'})

    def test_apply_candidate_to_configmap_raises_for_missing_strategy(self) -> None:
        with self.assertRaisesRegex(ValueError, 'strategy_not_found:missing'):
            apply_candidate_to_configmap(
                configmap_payload={
                    'data': {
                        'strategies.yaml': yaml.safe_dump({'strategies': []}, sort_keys=False),
                    }
                },
                strategy_name='missing',
                candidate_params={},
                disable_other_strategies=False,
            )

    def test_apply_candidate_to_configmap_rejects_invalid_shapes(self) -> None:
        with self.assertRaisesRegex(ValueError, 'strategy_configmap_missing_data'):
            apply_candidate_to_configmap(
                configmap_payload={},
                strategy_name='breakout-continuation-long-v1',
                candidate_params={},
                disable_other_strategies=False,
            )
        with self.assertRaisesRegex(ValueError, 'strategy_configmap_missing_strategies_yaml'):
            apply_candidate_to_configmap(
                configmap_payload={'data': {}},
                strategy_name='breakout-continuation-long-v1',
                candidate_params={},
                disable_other_strategies=False,
            )
        with self.assertRaisesRegex(ValueError, 'strategy_catalog_not_mapping'):
            apply_candidate_to_configmap(
                configmap_payload={'data': {'strategies.yaml': yaml.safe_dump(['bad'], sort_keys=False)}},
                strategy_name='breakout-continuation-long-v1',
                candidate_params={},
                disable_other_strategies=False,
            )
        with self.assertRaisesRegex(ValueError, 'strategy_catalog_missing_strategies'):
            apply_candidate_to_configmap(
                configmap_payload={'data': {'strategies.yaml': yaml.safe_dump({}, sort_keys=False)}},
                strategy_name='breakout-continuation-long-v1',
                candidate_params={},
                disable_other_strategies=False,
            )

    def test_parse_args_uses_frontier_defaults(self) -> None:
        with patch.object(sys, 'argv', ['search_profitability_frontier.py']):
            args = frontier._parse_args()

        self.assertEqual(args.clickhouse_http_url, 'http://torghut-clickhouse.torghut.svc.cluster.local:8123')
        self.assertEqual(args.clickhouse_username, 'torghut')
        self.assertEqual(args.clickhouse_password, '')
        self.assertEqual(args.start_equity, '31590.02')
        self.assertEqual(args.chunk_minutes, 10)
        self.assertEqual(args.symbols, '')
        self.assertEqual(args.progress_log_seconds, 30)
        self.assertEqual(args.train_days, 10)
        self.assertEqual(args.holdout_days, 5)
        self.assertEqual(args.top_n, 10)
        self.assertIsNone(args.json_output)

    def test_resolve_recent_trading_days_uses_qualified_signal_query(self) -> None:
        with patch('scripts.search_profitability_frontier._http_query', return_value='2026-03-27\n2026-03-26\n') as query:
            days = frontier._resolve_recent_trading_days(
                clickhouse_http_url='http://example.invalid:8123',
                clickhouse_username='torghut',
                clickhouse_password='secret',
                limit=2,
            )

        self.assertEqual(days, (date(2026, 3, 26), date(2026, 3, 27)))
        sql = query.call_args.kwargs['query']
        self.assertIn('FROM torghut.ta_signals', sql)
        self.assertIn("source = 'ta'", sql)
        self.assertIn("window_size = 'PT1S'", sql)

    def test_load_sweep_config_rejects_non_mapping_payload(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'invalid-sweep.yaml'
            path.write_text('- nope\n', encoding='utf-8')

            with self.assertRaisesRegex(ValueError, 'sweep_config_not_mapping'):
                frontier._load_sweep_config(path)

    def test_load_sweep_config_rejects_invalid_schema(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'invalid-sweep.yaml'
            path.write_text(yaml.safe_dump({'schema_version': 'wrong'}), encoding='utf-8')

            with self.assertRaisesRegex(ValueError, 'sweep_config_schema_version_invalid:wrong'):
                frontier._load_sweep_config(path)

    def test_main_writes_frontier_json_and_stdout_payload(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root, ranks=['0.45', '0.55'])
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(10))

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_config = config
                configmap_path = Path(getattr(replay_config, 'strategy_configmap_path'))
                payload = yaml.safe_load(configmap_path.read_text(encoding='utf-8'))
                strategies = yaml.safe_load(payload['data']['strategies.yaml'])['strategies']
                params = next(item['params'] for item in strategies if item['name'] == 'breakout-continuation-long-v1')
                rank = str(params['min_cross_section_continuation_rank'])
                start_date = str(getattr(replay_config, 'start_date'))
                if start_date == '2026-03-16':
                    return self._payload(
                        start_date='2026-03-16',
                        end_date='2026-03-20',
                        daily_net={
                            '2026-03-16': '0',
                            '2026-03-17': '10',
                            '2026-03-18': '0',
                            '2026-03-19': '0',
                            '2026-03-20': '0',
                        },
                        decision_count=2,
                        filled_count=1,
                        wins=1,
                        losses=0,
                    )
                if rank == '0.45':
                    return self._payload(
                        start_date='2026-03-21',
                        end_date='2026-03-25',
                        daily_net={
                            '2026-03-21': '0',
                            '2026-03-22': '50',
                            '2026-03-23': '0',
                            '2026-03-24': '0',
                            '2026-03-25': '0',
                        },
                        decision_count=2,
                        filled_count=1,
                        wins=1,
                        losses=0,
                    )
                return self._payload(
                    start_date='2026-03-21',
                    end_date='2026-03-25',
                    daily_net={
                        '2026-03-21': '0',
                        '2026-03-22': '400',
                        '2026-03-23': '300',
                        '2026-03-24': '350',
                        '2026-03-25': '0',
                    },
                    decision_count=6,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            stdout = io.StringIO()
            with (
                patch('scripts.search_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_profitability_frontier.run_replay', side_effect=fake_run_replay),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding='utf-8'))
            stdout_payload = json.loads(stdout.getvalue())
            self.assertEqual(payload, stdout_payload)
            self.assertEqual(payload['schema_version'], 'torghut.replay-frontier-sweep.v1')
            self.assertEqual(payload['family'], 'breakout_continuation')
            self.assertEqual(payload['strategy_name'], 'breakout-continuation-long-v1')
            self.assertEqual(
                payload['window'],
                {
                    'train_days': ['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20'],
                    'holdout_days': ['2026-03-21', '2026-03-22', '2026-03-23', '2026-03-24', '2026-03-25'],
                },
            )
            self.assertEqual(payload['candidate_count'], 2)
            self.assertGreaterEqual(len(payload['top']), 2)
            top_scores = [float(item['score']) for item in payload['top']]
            self.assertEqual(top_scores, sorted(top_scores, reverse=True))
            self.assertEqual(
                payload['top'][0]['replay_config']['params']['min_cross_section_continuation_rank'],
                '0.55',
            )

    def test_main_ranks_three_candidates_deterministically(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root, ranks=['0.45', '0.55', '0.65'])
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(10))
            holdout_payloads = {
                '0.45': self._payload(
                    start_date='2026-03-21',
                    end_date='2026-03-25',
                    daily_net={
                        '2026-03-21': '0',
                        '2026-03-22': '120',
                        '2026-03-23': '0',
                        '2026-03-24': '0',
                        '2026-03-25': '0',
                    },
                    decision_count=2,
                    filled_count=1,
                    wins=1,
                    losses=0,
                ),
                '0.55': self._payload(
                    start_date='2026-03-21',
                    end_date='2026-03-25',
                    daily_net={
                        '2026-03-21': '0',
                        '2026-03-22': '300',
                        '2026-03-23': '300',
                        '2026-03-24': '0',
                        '2026-03-25': '0',
                    },
                    decision_count=4,
                    filled_count=2,
                    wins=2,
                    losses=0,
                ),
                '0.65': self._payload(
                    start_date='2026-03-21',
                    end_date='2026-03-25',
                    daily_net={
                        '2026-03-21': '0',
                        '2026-03-22': '500',
                        '2026-03-23': '500',
                        '2026-03-24': '500',
                        '2026-03-25': '0',
                    },
                    decision_count=6,
                    filled_count=3,
                    wins=3,
                    losses=0,
                ),
            }

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_config = config
                configmap_path = Path(getattr(replay_config, 'strategy_configmap_path'))
                payload = yaml.safe_load(configmap_path.read_text(encoding='utf-8'))
                strategies = yaml.safe_load(payload['data']['strategies.yaml'])['strategies']
                params = next(item['params'] for item in strategies if item['name'] == 'breakout-continuation-long-v1')
                rank = str(params['min_cross_section_continuation_rank'])
                start_date = str(getattr(replay_config, 'start_date'))
                if start_date == '2026-03-16':
                    return self._payload(
                        start_date='2026-03-16',
                        end_date='2026-03-20',
                        daily_net={
                            '2026-03-16': '0',
                            '2026-03-17': '20',
                            '2026-03-18': '0',
                            '2026-03-19': '0',
                            '2026-03-20': '0',
                        },
                        decision_count=2,
                        filled_count=1,
                        wins=1,
                        losses=0,
                    )
                return holdout_payloads[rank]

            with (
                patch('scripts.search_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_profitability_frontier.run_replay', side_effect=fake_run_replay),
                redirect_stdout(io.StringIO()),
            ):
                frontier.main()

            payload = json.loads(json_output.read_text(encoding='utf-8'))
            ranked = [
                item['replay_config']['params']['min_cross_section_continuation_rank']
                for item in payload['top'][:3]
            ]
            self.assertEqual(ranked, ['0.65', '0.55', '0.45'])

    def test_cli_main_reports_insufficient_recent_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root, ranks=['0.45'])
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / 'frontier.json',
            )
            stderr = io.StringIO()
            with (
                patch('scripts.search_profitability_frontier._parse_args', return_value=args),
                patch(
                    'scripts.search_profitability_frontier._resolve_recent_trading_days',
                    return_value=tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(9)),
                ),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn('insufficient_recent_trading_days:9<10', stderr.getvalue())

    def test_cli_main_reports_invalid_base_configmap_shape(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = root / 'strategy-configmap.yaml'
            strategy_configmap.write_text('- invalid\n', encoding='utf-8')
            sweep_config = self._write_sweep_config(root, ranks=['0.45'])
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / 'frontier.json',
            )
            stderr = io.StringIO()
            recent_days = tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(10))
            with (
                patch('scripts.search_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn('base_strategy_configmap_not_mapping', stderr.getvalue())

    def test_cli_main_reports_missing_family_or_strategy_name(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / 'sweep.yaml'
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        'schema_version': 'torghut.replay-frontier-sweep.v1',
                        'family': '',
                        'strategy_name': '',
                        'parameters': {},
                    }
                ),
                encoding='utf-8',
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / 'frontier.json',
            )
            stderr = io.StringIO()
            recent_days = tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(10))
            with (
                patch('scripts.search_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn('sweep_config_missing_family_or_strategy_name', stderr.getvalue())

    def test_cli_main_reports_non_mapping_parameter_grid(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / 'sweep.yaml'
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        'schema_version': 'torghut.replay-frontier-sweep.v1',
                        'family': 'breakout_continuation',
                        'strategy_name': 'breakout-continuation-long-v1',
                        'parameters': ['not-a-mapping'],
                    }
                ),
                encoding='utf-8',
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / 'frontier.json',
            )
            stderr = io.StringIO()
            recent_days = tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(10))
            with (
                patch('scripts.search_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn('sweep_config_parameters_not_mapping', stderr.getvalue())
