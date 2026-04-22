from __future__ import annotations

import io
import json
import sys
from argparse import Namespace
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace

import yaml

import scripts.search_consistent_profitability_frontier as frontier


class TestSearchConsistentProfitabilityFrontier(TestCase):
    def test_parse_args_supports_harness_v2_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = root / 'strategies.yaml'
            sweep_config = root / 'sweep.yaml'
            family_dir = root / 'families'
            strategy_configmap.write_text('apiVersion: v1\nkind: ConfigMap\n', encoding='utf-8')
            sweep_config.write_text('family: breakout_reclaim\nstrategy_name: intraday-tsmom-profit-v3\n', encoding='utf-8')
            family_dir.mkdir()
            with patch.object(
                sys,
                'argv',
                [
                    'prog',
                    '--strategy-configmap',
                    str(strategy_configmap),
                    '--sweep-config',
                    str(sweep_config),
                    '--expected-last-trading-day',
                    '2026-04-07',
                    '--clickhouse-password-env',
                    'TORGHUT_CLICKHOUSE_PASSWORD',
                    '--allow-stale-tape',
                    '--family-template-dir',
                    str(family_dir),
                    '--max-candidates-to-evaluate',
                    '12',
                    '--no-train-screening',
                    '--min-train-screen-net-per-day',
                    '-50',
                    '--min-train-screen-active-ratio',
                    '0.25',
                    '--max-train-screen-worst-day-loss',
                    '125',
                ],
            ):
                args = frontier._parse_args()

        self.assertEqual(args.expected_last_trading_day, '2026-04-07')
        self.assertEqual(args.clickhouse_password_env, 'TORGHUT_CLICKHOUSE_PASSWORD')
        self.assertTrue(args.allow_stale_tape)
        self.assertEqual(args.family_template_dir, family_dir)
        self.assertEqual(args.max_candidates_to_evaluate, 12)
        self.assertFalse(args.train_screening)
        self.assertEqual(args.min_train_screen_net_per_day, '-50')
        self.assertEqual(args.min_train_screen_active_ratio, '0.25')
        self.assertEqual(args.max_train_screen_worst_day_loss, '125')

    def test_clickhouse_password_env_resolution_keeps_secret_out_of_argv(self) -> None:
        with patch.dict('os.environ', {'TORGHUT_CLICKHOUSE_PASSWORD': 'from-env'}):
            resolved = frontier._resolved_clickhouse_password(
                Namespace(clickhouse_password='', clickhouse_password_env='TORGHUT_CLICKHOUSE_PASSWORD')
            )
            direct = frontier._resolved_clickhouse_password(
                Namespace(clickhouse_password='direct', clickhouse_password_env='TORGHUT_CLICKHOUSE_PASSWORD')
            )

        self.assertEqual(resolved, 'from-env')
        self.assertEqual(direct, 'direct')

    def test_rolling_lower_bound_handles_empty_and_short_windows(self) -> None:
        self.assertEqual(frontier._rolling_lower_bound({}, window=3), Decimal('0'))
        self.assertEqual(
            frontier._rolling_lower_bound(
                {'2026-04-03': Decimal('30'), '2026-04-04': Decimal('60')},
                window=5,
            ),
            Decimal('45'),
        )

    def test_selected_normalization_regime_prefers_override(self) -> None:
        self.assertEqual(
            frontier._selected_normalization_regime(
                strategy_overrides={'normalization_regime': 'matched_filter'},
                template_allowed_normalizations=('trading_value_scaled',),
            ),
            'matched_filter',
        )

    def test_candidate_search_key_ignores_local_only_overrides(self) -> None:
        left = frontier._candidate_search_key(
            params_candidate={'long_stop_loss_bps': '12'},
            strategy_overrides={
                'universe_symbols': ['NVDA', 'AMAT'],
                'normalization_regime': 'price_scaled',
            },
        )
        right = frontier._candidate_search_key(
            params_candidate={'long_stop_loss_bps': '12'},
            strategy_overrides={
                'universe_symbols': ['NVDA', 'AMAT'],
                'normalization_regime': 'matched_filter',
            },
        )

        self.assertEqual(left, right)

    def test_candidate_symbols_prefers_cli_filter_then_universe_override(self) -> None:
        self.assertEqual(
            frontier._candidate_symbols(
                cli_symbols=('META',),
                strategy_overrides={'universe_symbols': ['NVDA', 'AMAT']},
            ),
            ('META',),
        )
        self.assertEqual(
            frontier._candidate_symbols(
                cli_symbols=(),
                strategy_overrides={'universe_symbols': ['nvda', ' amat ']},
            ),
            ('NVDA', 'AMAT'),
        )

    @staticmethod
    def _payload(
        *,
        start_date: str,
        end_date: str,
        daily_net: dict[str, str],
        daily_filled_notional: dict[str, str] | None = None,
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
                    'filled_notional': (
                        daily_filled_notional[day]
                        if daily_filled_notional is not None and day in daily_filled_notional
                        else ('1000' if float(value) != 0 else '0')
                    ),
                }
                for day, value in daily_net.items()
            },
        }

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
                                        'name': 'intraday-tsmom-profit-v3',
                                        'enabled': True,
                                        'max_notional_per_trade': '25000',
                                        'max_position_pct_equity': '2.0',
                                        'universe_symbols': ['NVDA', 'AMAT', 'AMD'],
                                        'params': {
                                            'min_cross_section_continuation_rank': '0.60',
                                            'long_stop_loss_bps': '18',
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
                        )
                    },
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        return path

    def _write_sweep_config(self, root: Path) -> Path:
        path = root / 'sweep.yaml'
        path.write_text(
            yaml.safe_dump(
                {
                    'schema_version': 'torghut.replay-frontier-sweep.v1',
                    'family': 'intraday_tsmom_consistent',
                    'strategy_name': 'intraday-tsmom-profit-v3',
                    'disable_other_strategies': True,
                    'constraints': {
                        'holdout_target_net_per_day': '200',
                        'min_active_holdout_days': 2,
                        'max_worst_holdout_day_loss': '200',
                        'min_profit_factor': '1.1',
                    },
                    'consistency_constraints': {
                        'target_net_per_day': '200',
                        'min_active_days': 6,
                        'max_worst_day_loss': '250',
                        'max_negative_days': 1,
                        'max_drawdown': '300',
                        'require_every_day_active': True,
                    },
                    'strategy_overrides': {
                        'universe_symbols': [['NVDA'], ['NVDA', 'AMAT']],
                        'max_notional_per_trade': ['15000'],
                    },
                    'parameters': {
                        'long_stop_loss_bps': ['12', '18'],
                    },
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        return path

    def _make_args(self, *, strategy_configmap: Path, sweep_config: Path, json_output: Path) -> Namespace:
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
            train_days=3,
            holdout_days=3,
            full_window_start_date='',
            full_window_end_date='',
            expected_last_trading_day='',
            allow_stale_tape=False,
            family_template_dir=Path(__file__).resolve().parents[1] / 'config' / 'trading' / 'families',
            prefetch_full_window_rows=False,
            top_n=10,
            max_candidates_to_evaluate=0,
            json_output=json_output,
            symbol_prune_iterations=0,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            train_screening=True,
            min_train_screen_net_per_day='0',
            min_train_screen_active_ratio='0.50',
            max_train_screen_worst_day_loss='',
        )

    def test_strategy_universe_symbols_reads_target_strategy_universe(self) -> None:
        configmap_payload = {
            'data': {
                'strategies.yaml': yaml.safe_dump(
                    {
                        'strategies': [
                            {
                                'name': 'intraday-tsmom-profit-v3',
                                'universe_symbols': ['nvda', ' AMAT '],
                            },
                            {
                                'name': 'other',
                                'universe_symbols': ['META'],
                            },
                        ]
                    },
                    sort_keys=False,
                )
            }
        }
        self.assertEqual(
            frontier._strategy_universe_symbols(
                configmap_payload=configmap_payload,
                strategy_name='intraday-tsmom-profit-v3',
            ),
            ('NVDA', 'AMAT'),
        )

    def test_resolve_prefetch_symbols_uses_override_union_before_base_universe(self) -> None:
        configmap_payload = {
            'data': {
                'strategies.yaml': yaml.safe_dump(
                    {
                        'strategies': [
                            {
                                'name': 'intraday-tsmom-profit-v3',
                                'universe_symbols': ['META'],
                            },
                        ]
                    },
                    sort_keys=False,
                )
            }
        }
        self.assertEqual(
            frontier._resolve_prefetch_symbols(
                cli_symbols=(),
                override_candidates=[
                    {'universe_symbols': ['nvda', 'amat']},
                    {'universe_symbols': ['AMAT', 'amd']},
                ],
                configmap_payload=configmap_payload,
                strategy_name='intraday-tsmom-profit-v3',
            ),
            ('NVDA', 'AMAT', 'AMD'),
        )

    def test_cached_iter_signal_rows_factory_filters_by_date_and_symbol_preserving_order(self) -> None:
        rows = [
            SimpleNamespace(
                symbol='NVDA',
                event_ts=datetime(2026, 3, 23, 14, 0, tzinfo=timezone.utc),
                seq=2,
            ),
            SimpleNamespace(
                symbol='AMAT',
                event_ts=datetime(2026, 3, 23, 14, 0, 1, tzinfo=timezone.utc),
                seq=1,
            ),
            SimpleNamespace(
                symbol='NVDA',
                event_ts=datetime(2026, 3, 24, 14, 0, tzinfo=timezone.utc),
                seq=3,
            ),
        ]
        iterator = frontier._cached_iter_signal_rows_factory(rows)
        config = SimpleNamespace(
            symbols=('NVDA',),
            start_date=date(2026, 3, 23),
            end_date=date(2026, 3, 23),
        )
        filtered = list(iterator(config))
        self.assertEqual([item.symbol for item in filtered], ['NVDA'])
        self.assertEqual(filtered[0].seq, 2)

    def test_apply_candidate_to_configmap_with_overrides_updates_top_level_fields(self) -> None:
        configmap_payload = {
            'apiVersion': 'v1',
            'kind': 'ConfigMap',
            'data': {
                'strategies.yaml': yaml.safe_dump(
                    {
                        'strategies': [
                            {
                                'name': 'intraday-tsmom-profit-v3',
                                'enabled': False,
                                'max_notional_per_trade': '25000',
                                'params': {'long_stop_loss_bps': '18'},
                            },
                            {'name': 'late-day', 'enabled': True, 'params': {}},
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = frontier.apply_candidate_to_configmap_with_overrides(
            configmap_payload=configmap_payload,
            strategy_name='intraday-tsmom-profit-v3',
            candidate_params={'long_stop_loss_bps': '12'},
            strategy_overrides={
                'universe_symbols': ['NVDA', 'AMAT'],
                'max_notional_per_trade': '15000',
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated['data']['strategies.yaml'])
        strategies = {item['name']: item for item in catalog['strategies']}
        self.assertEqual(
            strategies['intraday-tsmom-profit-v3']['params']['long_stop_loss_bps'],
            '12',
        )
        self.assertEqual(
            strategies['intraday-tsmom-profit-v3']['universe_symbols'],
            ['NVDA', 'AMAT'],
        )
        self.assertEqual(
            strategies['intraday-tsmom-profit-v3']['max_notional_per_trade'],
            '15000',
        )
        self.assertFalse(strategies['late-day']['enabled'])

    def test_apply_candidate_to_configmap_with_overrides_skips_search_only_normalization_override(self) -> None:
        configmap_payload = {
            'apiVersion': 'v1',
            'kind': 'ConfigMap',
            'data': {
                'strategies.yaml': yaml.safe_dump(
                    {
                        'strategies': [
                            {
                                'name': 'intraday-tsmom-profit-v3',
                                'enabled': True,
                                'max_notional_per_trade': '25000',
                                'params': {'long_stop_loss_bps': '18'},
                            },
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = frontier.apply_candidate_to_configmap_with_overrides(
            configmap_payload=configmap_payload,
            strategy_name='intraday-tsmom-profit-v3',
            candidate_params={'long_stop_loss_bps': '12'},
            strategy_overrides={
                'normalization_regime': 'opening_window_scaled',
                'universe_symbols': ['NVDA', 'AMAT'],
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated['data']['strategies.yaml'])
        strategy = catalog['strategies'][0]
        self.assertEqual(strategy['params']['long_stop_loss_bps'], '12')
        self.assertEqual(strategy['universe_symbols'], ['NVDA', 'AMAT'])
        self.assertNotIn('normalization_regime', strategy)

    def test_symbol_contributions_from_replay_payload_aggregates_downside_and_activity(self) -> None:
        payload = {
            'funnel': {
                'buckets': [
                    {
                        'trading_day': '2026-03-31',
                        'symbol': 'AVGO',
                        'filled_count': 1,
                        'net_pnl': '-120',
                        'cost_total': '10',
                    },
                    {
                        'trading_day': '2026-04-01',
                        'symbol': 'AVGO',
                        'filled_count': 1,
                        'net_pnl': '30',
                        'cost_total': '5',
                    },
                    {
                        'trading_day': '2026-04-01',
                        'symbol': 'MSFT',
                        'filled_count': 1,
                        'net_pnl': '220',
                        'cost_total': '7',
                    },
                ]
            }
        }
        contributions = frontier._symbol_contributions_from_replay_payload(payload)
        self.assertEqual(list(contributions), ['AVGO', 'MSFT'])
        self.assertEqual(contributions['AVGO']['active_days'], 2)
        self.assertEqual(contributions['AVGO']['negative_days'], 1)
        self.assertEqual(contributions['AVGO']['net_pnl'], '-90')
        self.assertEqual(contributions['AVGO']['downside_pnl'], '120')
        self.assertEqual(contributions['MSFT']['contribution_score'], '220')

    def test_generate_symbol_prune_children_removes_worst_symbols_from_universe(self) -> None:
        children = frontier._generate_symbol_prune_children(
            cli_symbols=(),
            strategy_overrides={'universe_symbols': ['NVDA', 'AVGO', 'MSFT']},
            configmap_payload={},
            strategy_name='intraday-tsmom-profit-v3',
            symbol_contributions={
                'AVGO': {'contribution_score': '-200', 'net_pnl': '-100'},
                'NVDA': {'contribution_score': '-50', 'net_pnl': '10'},
                'MSFT': {'contribution_score': '100', 'net_pnl': '120'},
            },
            branch_count=2,
            min_universe_size=2,
        )
        self.assertEqual(children[0][0], 'AVGO')
        self.assertEqual(children[0][1]['universe_symbols'], ['NVDA', 'MSFT'])
        self.assertEqual(children[1][0], 'NVDA')
        self.assertEqual(children[1][1]['universe_symbols'], ['AVGO', 'MSFT'])

    def test_consistency_penalty_rejects_lucky_strike_and_low_notional_profile(self) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date='2026-03-24',
                end_date='2026-04-02',
                daily_net={
                    '2026-03-24': '0',
                    '2026-03-25': '0',
                    '2026-03-26': '0',
                    '2026-03-27': '0',
                    '2026-03-30': '0',
                    '2026-03-31': '-150',
                    '2026-04-01': '-100',
                    '2026-04-02': '2650',
                },
                daily_filled_notional={
                    '2026-03-24': '0',
                    '2026-03-25': '0',
                    '2026-03-26': '0',
                    '2026-03-27': '0',
                    '2026-03-30': '0',
                    '2026-03-31': '40000',
                    '2026-04-01': '50000',
                    '2026-04-02': '60000',
                },
                decision_count=3,
                filled_count=3,
                wins=1,
                losses=2,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal('300'),
                min_active_days=6,
                min_active_ratio=frontier.Decimal('0.75'),
                min_positive_days=4,
                max_worst_day_loss=frontier.Decimal('250'),
                max_negative_days=2,
                max_drawdown=frontier.Decimal('500'),
                max_best_day_share_of_total_pnl=frontier.Decimal('0.55'),
                min_avg_filled_notional_per_day=frontier.Decimal('150000'),
                min_avg_filled_notional_per_active_day=frontier.Decimal('200000'),
                require_every_day_active=False,
            ),
        )

        self.assertGreater(penalties, frontier.Decimal('0'))
        self.assertEqual(summary['active_days'], 3)
        self.assertEqual(summary['positive_days'], 1)
        self.assertEqual(summary['best_day_share_of_total_pnl'], '1.104166666666666666666666667')
        self.assertEqual(summary['avg_filled_notional_per_day'], '18750')

    def test_main_prefers_consistent_candidate_over_prettier_holdout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(date(2026, 3, 18) + timedelta(days=index) for index in range(6))

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, 'strategy_configmap_path'))
                payload = yaml.safe_load(configmap_path.read_text(encoding='utf-8'))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload['data']['strategies.yaml'])['strategies']
                    if item['name'] == 'intraday-tsmom-profit-v3'
                )
                stop = str(strategy['params']['long_stop_loss_bps'])
                start_date = str(getattr(config, 'start_date'))
                end_date = str(getattr(config, 'end_date'))
                if start_date == '2026-03-18' and end_date == '2026-03-20':
                    return self._payload(
                        start_date='2026-03-18',
                        end_date='2026-03-20',
                        daily_net={
                            '2026-03-18': '80',
                            '2026-03-19': '90',
                            '2026-03-20': '85',
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if start_date == '2026-03-21' and end_date == '2026-03-23':
                    if stop == '12':
                        return self._payload(
                            start_date='2026-03-21',
                            end_date='2026-03-23',
                            daily_net={
                                '2026-03-21': '450',
                                '2026-03-22': '0',
                                '2026-03-23': '0',
                            },
                            decision_count=1,
                            filled_count=1,
                            wins=1,
                            losses=0,
                        )
                    return self._payload(
                        start_date='2026-03-21',
                        end_date='2026-03-23',
                        daily_net={
                            '2026-03-21': '220',
                            '2026-03-22': '210',
                            '2026-03-23': '205',
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if stop == '12':
                    return self._payload(
                        start_date='2026-03-18',
                        end_date='2026-03-23',
                        daily_net={
                            '2026-03-18': '80',
                            '2026-03-19': '90',
                            '2026-03-20': '85',
                            '2026-03-21': '450',
                            '2026-03-22': '0',
                            '2026-03-23': '0',
                        },
                        decision_count=4,
                        filled_count=4,
                        wins=4,
                        losses=0,
                    )
                return self._payload(
                    start_date='2026-03-18',
                    end_date='2026-03-23',
                    daily_net={
                        '2026-03-18': '80',
                        '2026-03-19': '90',
                        '2026-03-20': '85',
                        '2026-03-21': '220',
                        '2026-03-22': '210',
                        '2026-03-23': '205',
                    },
                    decision_count=6,
                    filled_count=6,
                    wins=6,
                    losses=0,
                )

            stdout = io.StringIO()
            snapshot_receipt = SimpleNamespace(
                snapshot_id='snap-test',
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    'snapshot_id': 'snap-test',
                    'source': 'ta',
                    'window_size': 'PT1S',
                    'start_day': '2026-03-18',
                    'end_day': '2026-03-23',
                    'expected_last_trading_day': '2026-03-23',
                    'is_fresh': True,
                    'missing_days': [],
                    'row_count': 123,
                    'stale_override_used': False,
                    'witnesses': [],
                },
            )
            with (
                patch('scripts.search_consistent_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt', return_value=snapshot_receipt),
                patch('scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot'),
                patch('scripts.search_consistent_profitability_frontier.run_replay', side_effect=fake_run_replay),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding='utf-8'))
            stdout_payload = json.loads(stdout.getvalue())
            self.assertEqual(payload, stdout_payload)
            top = payload['top'][0]
            self.assertEqual(top['replay_config']['params']['long_stop_loss_bps'], '18')
            self.assertEqual(top['full_window']['active_days'], 6)
            self.assertEqual(payload['dataset_snapshot_receipt']['snapshot_id'], 'snap-test')
            self.assertEqual(top['ranking']['method'], 'pareto_frontier_v2')
            self.assertEqual(top['family_template_id'], 'intraday_tsmom_v2')

    def test_run_frontier_writes_partial_json_output_between_candidates(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / 'sweep.yaml'
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        'schema_version': 'torghut.replay-frontier-sweep.v1',
                        'family': 'intraday_tsmom_consistent',
                        'strategy_name': 'intraday-tsmom-profit-v3',
                        'disable_other_strategies': True,
                        'constraints': {
                            'holdout_target_net_per_day': '200',
                            'min_active_holdout_days': 2,
                            'max_worst_holdout_day_loss': '200',
                            'min_profit_factor': '1.0',
                        },
                        'consistency_constraints': {
                            'target_net_per_day': '200',
                            'min_active_days': 2,
                            'max_worst_day_loss': '300',
                            'max_negative_days': 1,
                            'max_drawdown': '400',
                            'require_every_day_active': False,
                        },
                        'strategy_overrides': {
                            'universe_symbols': [['NVDA']],
                        },
                        'parameters': {
                            'long_stop_loss_bps': ['12', '18'],
                        },
                    },
                    sort_keys=False,
                ),
                encoding='utf-8',
            )
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.min_train_screen_net_per_day = '1'
            recent_days = tuple(date(2026, 3, 18) + timedelta(days=index) for index in range(6))
            snapshot_receipt = SimpleNamespace(
                snapshot_id='snap-partial',
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    'snapshot_id': 'snap-partial',
                    'source': 'ta',
                    'window_size': 'PT1S',
                    'start_day': '2026-03-18',
                    'end_day': '2026-03-23',
                    'expected_last_trading_day': '2026-03-23',
                    'is_fresh': True,
                    'missing_days': [],
                    'row_count': 123,
                    'stale_override_used': False,
                    'witnesses': [],
                },
            )
            replay_call_count = {'count': 0}

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_call_count['count'] += 1
                if replay_call_count['count'] == 4:
                    partial_payload = json.loads(json_output.read_text(encoding='utf-8'))
                    self.assertEqual(partial_payload['status'], 'running')
                    self.assertEqual(partial_payload['candidate_count'], 1)
                    self.assertEqual(partial_payload['progress']['evaluated_candidates'], 1)
                    self.assertGreaterEqual(partial_payload['progress']['pending_candidates'], 0)
                    self.assertEqual(len(partial_payload['top']), 1)

                configmap_path = Path(getattr(config, 'strategy_configmap_path'))
                payload = yaml.safe_load(configmap_path.read_text(encoding='utf-8'))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload['data']['strategies.yaml'])['strategies']
                    if item['name'] == 'intraday-tsmom-profit-v3'
                )
                stop = str(strategy['params']['long_stop_loss_bps'])
                start_date = str(getattr(config, 'start_date'))
                end_date = str(getattr(config, 'end_date'))
                if start_date == '2026-03-18' and end_date == '2026-03-20':
                    daily_net = (
                        {'2026-03-18': '90', '2026-03-19': '95', '2026-03-20': '100'}
                        if stop == '18'
                        else {'2026-03-18': '60', '2026-03-19': '55', '2026-03-20': '50'}
                    )
                elif start_date == '2026-03-21' and end_date == '2026-03-23':
                    daily_net = (
                        {'2026-03-21': '220', '2026-03-22': '210', '2026-03-23': '205'}
                        if stop == '18'
                        else {'2026-03-21': '120', '2026-03-22': '115', '2026-03-23': '110'}
                    )
                else:
                    daily_net = (
                        {
                            '2026-03-18': '90',
                            '2026-03-19': '95',
                            '2026-03-20': '100',
                            '2026-03-21': '220',
                            '2026-03-22': '210',
                            '2026-03-23': '205',
                        }
                        if stop == '18'
                        else {
                            '2026-03-18': '60',
                            '2026-03-19': '55',
                            '2026-03-20': '50',
                            '2026-03-21': '120',
                            '2026-03-22': '115',
                            '2026-03-23': '110',
                        }
                    )
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            with (
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt', return_value=snapshot_receipt),
                patch('scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot'),
                patch('scripts.search_consistent_profitability_frontier.run_replay', side_effect=fake_run_replay),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(payload['status'], 'completed')
            self.assertEqual(payload['candidate_count'], 2)
            persisted = json.loads(json_output.read_text(encoding='utf-8'))
            self.assertEqual(persisted['status'], 'completed')
            self.assertEqual(persisted['candidate_count'], 2)

    def test_run_frontier_train_screen_skips_dead_candidate_expensive_replays(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / 'sweep.yaml'
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        'schema_version': 'torghut.replay-frontier-sweep.v1',
                        'family': 'intraday_tsmom_consistent',
                        'strategy_name': 'intraday-tsmom-profit-v3',
                        'disable_other_strategies': True,
                        'constraints': {
                            'holdout_target_net_per_day': '200',
                            'min_active_holdout_days': 2,
                            'max_worst_holdout_day_loss': '200',
                            'min_profit_factor': '1.0',
                        },
                        'consistency_constraints': {
                            'target_net_per_day': '200',
                            'min_active_days': 2,
                            'max_worst_day_loss': '300',
                            'max_negative_days': 1,
                            'max_drawdown': '400',
                            'require_every_day_active': True,
                        },
                        'strategy_overrides': {
                            'universe_symbols': [['NVDA']],
                        },
                        'parameters': {
                            'long_stop_loss_bps': ['12'],
                        },
                    },
                    sort_keys=False,
                ),
                encoding='utf-8',
            )
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.min_train_screen_net_per_day = '1'
            recent_days = tuple(date(2026, 3, 18) + timedelta(days=index) for index in range(6))
            snapshot_receipt = SimpleNamespace(
                snapshot_id='snap-screen',
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    'snapshot_id': 'snap-screen',
                    'source': 'ta',
                    'window_size': 'PT1S',
                    'start_day': '2026-03-18',
                    'end_day': '2026-03-23',
                    'expected_last_trading_day': '2026-03-23',
                    'is_fresh': True,
                    'missing_days': [],
                    'row_count': 123,
                    'stale_override_used': False,
                    'witnesses': [],
                },
            )
            replay_calls: list[tuple[str, str]] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_calls.append((str(getattr(config, 'start_date')), str(getattr(config, 'end_date'))))
                return self._payload(
                    start_date='2026-03-18',
                    end_date='2026-03-20',
                    daily_net={
                        '2026-03-18': '0',
                        '2026-03-19': '0',
                        '2026-03-20': '0',
                    },
                    decision_count=0,
                    filled_count=0,
                    wins=0,
                    losses=0,
                )

            with (
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt', return_value=snapshot_receipt),
                patch('scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot'),
                patch('scripts.search_consistent_profitability_frontier.run_replay', side_effect=fake_run_replay),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(replay_calls, [('2026-03-18', '2026-03-20')])
            self.assertEqual(payload['candidate_count'], 1)
            top = payload['top'][0]
            self.assertEqual(top['screening']['status'], 'rejected')
            self.assertTrue(top['screening']['holdout_replay_skipped'])
            self.assertTrue(top['screening']['full_window_replay_skipped'])
            self.assertIn('train_no_decisions', top['hard_vetoes'])
            self.assertIn('train_net_per_day_below_screen', top['hard_vetoes'])

    def test_run_frontier_respects_candidate_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.max_candidates_to_evaluate = 1
            recent_days = tuple(date(2026, 3, 18) + timedelta(days=index) for index in range(6))
            snapshot_receipt = SimpleNamespace(
                snapshot_id='snap-budget',
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    'snapshot_id': 'snap-budget',
                    'source': 'ta',
                    'window_size': 'PT1S',
                    'start_day': '2026-03-18',
                    'end_day': '2026-03-23',
                    'expected_last_trading_day': '2026-03-23',
                    'is_fresh': True,
                    'missing_days': [],
                    'row_count': 123,
                    'stale_override_used': False,
                    'witnesses': [],
                },
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                return self._payload(
                    start_date=str(getattr(config, 'start_date')),
                    end_date=str(getattr(config, 'end_date')),
                    daily_net={'2026-03-18': '100', '2026-03-19': '110', '2026-03-20': '120'},
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            with (
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt', return_value=snapshot_receipt),
                patch('scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot'),
                patch('scripts.search_consistent_profitability_frontier.run_replay', side_effect=fake_run_replay),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(payload['status'], 'candidate_budget_exhausted')
            self.assertEqual(payload['candidate_count'], 1)
            self.assertGreater(payload['progress']['pending_candidates'], 0)
            persisted = json.loads(json_output.read_text(encoding='utf-8'))
            self.assertEqual(persisted['status'], 'candidate_budget_exhausted')

    def test_main_symbol_pruning_promotes_pruned_universe(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / 'sweep.yaml'
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        'schema_version': 'torghut.replay-frontier-sweep.v1',
                        'family': 'breakout_reclaim',
                        'strategy_name': 'intraday-tsmom-profit-v3',
                        'disable_other_strategies': True,
                        'constraints': {
                            'holdout_target_net_per_day': '200',
                            'min_active_holdout_days': 2,
                            'max_worst_holdout_day_loss': '200',
                            'min_profit_factor': '1.0',
                        },
                        'consistency_constraints': {
                            'target_net_per_day': '200',
                            'min_active_days': 2,
                            'max_worst_day_loss': '300',
                            'max_negative_days': 1,
                            'max_drawdown': '400',
                            'require_every_day_active': False,
                        },
                        'strategy_overrides': {
                            'universe_symbols': [['NVDA', 'AVGO']],
                        },
                        'parameters': {
                            'long_stop_loss_bps': ['12'],
                        },
                    },
                    sort_keys=False,
                ),
                encoding='utf-8',
            )
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.symbol_prune_iterations = 1
            args.symbol_prune_candidates = 1
            args.symbol_prune_min_universe_size = 1
            recent_days = tuple(date(2026, 3, 18) + timedelta(days=index) for index in range(6))
            snapshot_receipt = SimpleNamespace(
                snapshot_id='snap-prune',
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    'snapshot_id': 'snap-prune',
                    'source': 'ta',
                    'window_size': 'PT1S',
                    'start_day': '2026-03-18',
                    'end_day': '2026-03-23',
                    'expected_last_trading_day': '2026-03-23',
                    'is_fresh': True,
                    'missing_days': [],
                    'row_count': 123,
                    'stale_override_used': False,
                    'witnesses': [],
                },
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, 'strategy_configmap_path'))
                payload = yaml.safe_load(configmap_path.read_text(encoding='utf-8'))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload['data']['strategies.yaml'])['strategies']
                    if item['name'] == 'intraday-tsmom-profit-v3'
                )
                universe = tuple(strategy.get('universe_symbols') or [])
                start_date = str(getattr(config, 'start_date'))
                end_date = str(getattr(config, 'end_date'))

                if universe == ('NVDA',):
                    daily_net = {
                        '2026-03-18': '240',
                        '2026-03-19': '260',
                        '2026-03-20': '250',
                        '2026-03-21': '280',
                        '2026-03-22': '270',
                        '2026-03-23': '275',
                    }
                    funnel = {
                        'buckets': [
                            {
                                'trading_day': day,
                                'symbol': 'NVDA',
                                'filled_count': 1,
                                'net_pnl': value,
                                'cost_total': '5',
                            }
                            for day, value in daily_net.items()
                        ]
                    }
                else:
                    daily_net = {
                        '2026-03-18': '240',
                        '2026-03-19': '260',
                        '2026-03-20': '250',
                        '2026-03-21': '60',
                        '2026-03-22': '-220',
                        '2026-03-23': '290',
                    }
                    funnel = {
                        'buckets': [
                            {
                                'trading_day': '2026-03-22',
                                'symbol': 'AVGO',
                                'filled_count': 1,
                                'net_pnl': '-260',
                                'cost_total': '10',
                            },
                            {
                                'trading_day': '2026-03-21',
                                'symbol': 'AVGO',
                                'filled_count': 1,
                                'net_pnl': '20',
                                'cost_total': '5',
                            },
                            {
                                'trading_day': '2026-03-18',
                                'symbol': 'NVDA',
                                'filled_count': 1,
                                'net_pnl': '240',
                                'cost_total': '5',
                            },
                        ]
                    }

                if start_date == '2026-03-18' and end_date == '2026-03-20':
                    subset = {day: daily_net[day] for day in ('2026-03-18', '2026-03-19', '2026-03-20')}
                elif start_date == '2026-03-21' and end_date == '2026-03-23':
                    subset = {day: daily_net[day] for day in ('2026-03-21', '2026-03-22', '2026-03-23')}
                else:
                    subset = daily_net
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=subset,
                    decision_count=3,
                    filled_count=3,
                    wins=2,
                    losses=1,
                )
                payload['funnel'] = funnel
                return payload

            stdout = io.StringIO()
            with (
                patch('scripts.search_consistent_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt', return_value=snapshot_receipt),
                patch('scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot'),
                patch('scripts.search_consistent_profitability_frontier.run_replay', side_effect=fake_run_replay),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding='utf-8'))
            top = payload['top'][0]
            self.assertEqual(top['replay_config']['strategy_overrides']['universe_symbols'], ['NVDA'])
            self.assertEqual(top['search_iteration'], 1)
            self.assertEqual(top['pruned_symbol'], 'AVGO')

    def test_main_adds_concentration_hard_vetoes(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / 'sweep.yaml'
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        'schema_version': 'torghut.replay-frontier-sweep.v1',
                        'family': 'breakout_reclaim',
                        'strategy_name': 'intraday-tsmom-profit-v3',
                        'disable_other_strategies': True,
                        'constraints': {
                            'holdout_target_net_per_day': '100',
                            'min_active_holdout_days': 1,
                            'max_worst_holdout_day_loss': '500',
                            'min_profit_factor': '1.0',
                        },
                        'consistency_constraints': {
                            'target_net_per_day': '100',
                            'min_active_days': 1,
                            'max_worst_day_loss': '500',
                            'max_negative_days': 3,
                            'max_drawdown': '800',
                            'require_every_day_active': False,
                            'max_symbol_concentration_share': '0.50',
                            'max_entry_family_contribution_share': '0.50',
                        },
                        'strategy_overrides': {
                            'universe_symbols': [['NVDA', 'AMAT']],
                        },
                        'parameters': {
                            'long_stop_loss_bps': ['12'],
                        },
                    },
                    sort_keys=False,
                ),
                encoding='utf-8',
            )
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(date(2026, 3, 18) + timedelta(days=index) for index in range(6))
            snapshot_receipt = SimpleNamespace(
                snapshot_id='snap-veto',
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    'snapshot_id': 'snap-veto',
                    'source': 'ta',
                    'window_size': 'PT1S',
                    'start_day': '2026-03-18',
                    'end_day': '2026-03-23',
                    'expected_last_trading_day': '2026-03-23',
                    'is_fresh': True,
                    'missing_days': [],
                    'row_count': 123,
                    'stale_override_used': False,
                    'witnesses': [],
                },
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, 'start_date'))
                end_date = str(getattr(config, 'end_date'))
                if start_date == '2026-03-18' and end_date == '2026-03-20':
                    daily_net = {
                        '2026-03-18': '200',
                        '2026-03-19': '180',
                        '2026-03-20': '160',
                    }
                else:
                    daily_net = {
                        '2026-03-21': '220',
                        '2026-03-22': '210',
                        '2026-03-23': '205',
                    }
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )
                payload['trace'] = []
                return payload

            fake_decomposition = SimpleNamespace(
                to_payload=lambda: {'families': {}, 'symbols': {}},
            )
            stdout = io.StringIO()
            with (
                patch('scripts.search_consistent_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt', return_value=snapshot_receipt),
                patch('scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot'),
                patch('scripts.search_consistent_profitability_frontier.run_replay', side_effect=fake_run_replay),
                patch('scripts.search_consistent_profitability_frontier.build_replay_decomposition', return_value=fake_decomposition),
                patch('scripts.search_consistent_profitability_frontier.regime_slice_pass_rate', return_value=Decimal('1')),
                patch('scripts.search_consistent_profitability_frontier.max_symbol_concentration_share', return_value=Decimal('0.90')),
                patch('scripts.search_consistent_profitability_frontier.max_family_contribution_share', return_value=Decimal('0.90')),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding='utf-8'))
            self.assertIn('symbol_concentration_above_max', payload['top'][0]['hard_vetoes'])
            self.assertIn('entry_family_contribution_above_max', payload['top'][0]['hard_vetoes'])

    def test_main_keeps_min_active_days_disabled_for_widened_full_window(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / 'widened-sweep.yaml'
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        'schema_version': 'torghut.replay-frontier-sweep.v1',
                        'family': 'intraday_tsmom_consistent',
                        'strategy_name': 'intraday-tsmom-profit-v3',
                        'disable_other_strategies': True,
                        'constraints': {
                            'holdout_target_net_per_day': '100',
                            'min_active_holdout_days': 1,
                            'max_worst_holdout_day_loss': '500',
                            'min_profit_factor': '1.0',
                        },
                        'consistency_constraints': {
                            'target_net_per_day': '100',
                            'min_active_ratio': '0',
                            'max_worst_day_loss': '500',
                            'max_negative_days': 7,
                            'max_drawdown': '900',
                            'require_every_day_active': False,
                        },
                        'strategy_overrides': {
                            'universe_symbols': [['NVDA']],
                        },
                        'parameters': {
                            'long_stop_loss_bps': ['12'],
                        },
                    },
                    sort_keys=False,
                ),
                encoding='utf-8',
            )
            json_output = root / 'frontier.json'
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.full_window_start_date = '2026-03-17'
            args.full_window_end_date = '2026-03-23'
            recent_days = tuple(date(2026, 3, 18) + timedelta(days=index) for index in range(6))
            snapshot_receipt = SimpleNamespace(
                snapshot_id='snap-wide',
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    'snapshot_id': 'snap-wide',
                    'source': 'ta',
                    'window_size': 'PT1S',
                    'start_day': '2026-03-17',
                    'end_day': '2026-03-23',
                    'expected_last_trading_day': '2026-03-23',
                    'is_fresh': True,
                    'missing_days': [],
                    'row_count': 321,
                    'stale_override_used': False,
                    'witnesses': [],
                },
            )

            daily_net = {
                '2026-03-17': '90',
                '2026-03-18': '110',
                '2026-03-19': '95',
                '2026-03-20': '120',
                '2026-03-21': '130',
                '2026-03-22': '115',
                '2026-03-23': '125',
            }

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, 'start_date'))
                end_date = str(getattr(config, 'end_date'))
                subset = {
                    day: value
                    for day, value in daily_net.items()
                    if start_date <= day <= end_date
                }
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=subset,
                    decision_count=max(1, len(subset)),
                    filled_count=max(1, len(subset)),
                    wins=max(1, len(subset)),
                    losses=0,
                )

            stdout = io.StringIO()
            with (
                patch('scripts.search_consistent_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
                patch('scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt', return_value=snapshot_receipt),
                patch('scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot'),
                patch('scripts.search_consistent_profitability_frontier.run_replay', side_effect=fake_run_replay),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding='utf-8'))
            self.assertEqual(payload['constraints']['consistency']['min_active_days'], 0)
