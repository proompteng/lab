from __future__ import annotations

import io
import json
from argparse import Namespace
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace

import yaml

import scripts.search_consistent_profitability_frontier as frontier


class TestSearchConsistentProfitabilityFrontier(TestCase):
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
            prefetch_full_window_rows=False,
            top_n=10,
            json_output=json_output,
            symbol_prune_iterations=0,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
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
            with (
                patch('scripts.search_consistent_profitability_frontier._parse_args', return_value=args),
                patch('scripts.search_consistent_profitability_frontier._resolve_recent_trading_days', return_value=recent_days),
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
