from __future__ import annotations

import json
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml

from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
    MutationSpace,
    StrategyObjective,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    load_strategy_autoresearch_program,
)
from app.trading.discovery.autoresearch_notebooks import (
    build_strategy_discovery_history_notebook,
    build_strategy_factory_history_notebook,
    write_autoresearch_notebooks,
    write_strategy_factory_notebooks,
)
from app.trading.discovery.family_templates import FamilyTemplate
import scripts.run_strategy_autoresearch_loop as runner


def _family_template() -> FamilyTemplate:
    return FamilyTemplate(
        family_id='breakout_reclaim_v2',
        economic_mechanism='Breakout reclaim.',
        supported_markets=('us_equities_intraday',),
        required_features=('quote_quality',),
        allowed_normalizations=('price_scaled', 'opening_window_scaled'),
        entry_motifs=('breakout_reclaim',),
        exit_motifs=('trailing_stop',),
        risk_controls=('stop_loss',),
        activity_model={'min_active_day_ratio': '0.50', 'min_daily_notional': '200000'},
        liquidity_assumptions={'max_spread_bps': '30'},
        regime_activation_rules=(),
        day_veto_rules=(),
        default_hard_vetoes={'required_max_best_day_share': '0.45'},
        default_selection_objectives={'target_net_pnl_per_day': '300'},
        runtime_harness={
            'family': 'breakout_continuation_consistent',
            'strategy_name': 'breakout-continuation-long-v1',
            'disable_other_strategies': True,
        },
    )


class TestStrategyAutoresearch(TestCase):
    def _write_program_fixture(self, root: Path) -> tuple[Path, Path]:
        family_dir = root / 'families'
        family_dir.mkdir()
        (family_dir / 'breakout_reclaim_v2.yaml').write_text(
            yaml.safe_dump(
                {
                    'schema_version': 'torghut.family-template.v1',
                    'family_id': 'breakout_reclaim_v2',
                    'economic_mechanism': 'Breakout reclaim.',
                    'supported_markets': ['us_equities_intraday'],
                    'required_features': ['quote_quality'],
                    'allowed_normalizations': ['price_scaled', 'opening_window_scaled'],
                    'entry_motifs': ['breakout_reclaim'],
                    'exit_motifs': ['trailing_stop'],
                    'risk_controls': ['stop_loss'],
                    'activity_model': {'min_active_day_ratio': '0.50', 'min_daily_notional': '200000'},
                    'liquidity_assumptions': {'max_spread_bps': '30'},
                    'regime_activation_rules': [],
                    'day_veto_rules': [],
                    'default_hard_vetoes': {'required_max_best_day_share': '0.45'},
                    'default_selection_objectives': {'target_net_pnl_per_day': '300'},
                    'runtime_harness': {
                        'family': 'breakout_continuation_consistent',
                        'strategy_name': 'breakout-continuation-long-v1',
                        'disable_other_strategies': True,
                    },
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        sweep_path = root / 'profitability-frontier-consistent-breakout.yaml'
        sweep_path.write_text(
            yaml.safe_dump(
                {
                    'schema_version': 'torghut.replay-frontier-sweep.v1',
                    'family': 'breakout_continuation_consistent',
                    'family_template_id': 'breakout_reclaim_v2',
                    'strategy_name': 'breakout-continuation-long-v1',
                    'disable_other_strategies': True,
                    'constraints': {'holdout_target_net_per_day': '300'},
                    'consistency_constraints': {'target_net_per_day': '300'},
                    'strategy_overrides': {
                        'universe_symbols': [['AMAT', 'NVDA']],
                        'max_position_pct_equity': ['10.0'],
                    },
                    'parameters': {
                        'max_entries_per_session': ['2'],
                        'entry_cooldown_seconds': ['600'],
                    },
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        program_path = root / 'program.yaml'
        program_path.write_text(
            yaml.safe_dump(
                {
                    'schema_version': 'torghut.strategy-autoresearch.v1',
                    'program_id': 'daily-profit',
                    'description': 'Program fixture.',
                    'objective': {
                        'target_net_pnl_per_day': '500',
                        'min_active_day_ratio': '0.80',
                        'min_positive_day_ratio': '0.55',
                        'min_daily_notional': '300000',
                        'max_best_day_share': '0.35',
                        'max_worst_day_loss': '450',
                        'max_drawdown': '1000',
                        'min_regime_slice_pass_rate': '0.40',
                    },
                    'research_sources': [
                        {
                            'source_id': 'paper-1',
                            'title': 'Paper 1',
                            'url': 'https://example.com/paper-1',
                            'published_at': '2026-01-01',
                            'claims': [
                                {
                                    'claim_id': 'claim-1',
                                    'summary': 'Use realistic replay.',
                                    'implication': 'Prefer day-level diagnostics.',
                                }
                            ],
                        }
                    ],
                    'families': [
                        {
                            'family_template_id': 'breakout_reclaim_v2',
                            'seed_sweep_config': './profitability-frontier-consistent-breakout.yaml',
                            'max_iterations': 2,
                            'keep_top_candidates': 1,
                            'frontier_top_n': 2,
                            'symbol_prune_iterations': 1,
                            'symbol_prune_candidates': 1,
                            'symbol_prune_min_universe_size': 2,
                            'parameter_mutations': {
                                'max_entries_per_session': {
                                    'mode': 'numeric_step',
                                    'deltas': ['-1', '0', '1'],
                                    'minimum': '1',
                                    'maximum': '4',
                                }
                            },
                            'strategy_override_mutations': {
                                'normalization_regime': {'mode': 'allowed_normalizations'}
                            },
                        }
                    ],
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        return program_path, family_dir

    def test_load_program_and_apply_objective(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)

            program = load_strategy_autoresearch_program(program_path, family_dir=family_dir)
            self.assertEqual(program.program_id, 'daily-profit')
            self.assertEqual(program.objective.target_net_pnl_per_day, Decimal('500'))
            self.assertEqual(program.families[0].family_template.family_id, 'breakout_reclaim_v2')
            self.assertEqual(program.families[0].strategy_override_mutations['normalization_regime'].mode, 'allowed_normalizations')

            sweep_payload = yaml.safe_load((root / 'profitability-frontier-consistent-breakout.yaml').read_text(encoding='utf-8'))
            updated = apply_program_objective(
                sweep_config=sweep_payload,
                objective=program.objective,
                train_day_count=6,
                holdout_day_count=3,
                full_window_day_count=9,
            )
            self.assertEqual(updated['constraints']['holdout_target_net_per_day'], '500')
            self.assertEqual(updated['consistency_constraints']['max_best_day_share_of_total_pnl'], '0.35')
            self.assertEqual(updated['consistency_constraints']['min_active_days'], 8)

    def test_apply_program_objective_skips_full_window_counts_when_unknown(self) -> None:
        updated = apply_program_objective(
            sweep_config={'constraints': {}, 'consistency_constraints': {}},
            objective=StrategyObjective(
                target_net_pnl_per_day=Decimal('500'),
                min_active_day_ratio=Decimal('0.80'),
                min_positive_day_ratio=Decimal('0.55'),
                min_daily_notional=Decimal('300000'),
                max_best_day_share=Decimal('0.35'),
                max_worst_day_loss=Decimal('450'),
                max_drawdown=Decimal('1000'),
                require_every_day_active=False,
                min_regime_slice_pass_rate=Decimal('0.40'),
                stop_when_objective_met=False,
            ),
            train_day_count=6,
            holdout_day_count=3,
            full_window_day_count=None,
        )
        self.assertNotIn('min_active_days', updated['consistency_constraints'])
        self.assertNotIn('min_positive_days', updated['consistency_constraints'])

    def test_build_mutated_sweep_config_keeps_current_values_and_mutates_neighbors(self) -> None:
        family_plan = FamilyAutoresearchPlan(
            family_template=_family_template(),
            seed_sweep_config=Path('/tmp/example.yaml'),
            max_iterations=2,
            keep_top_candidates=1,
            frontier_top_n=2,
            force_keep_top_candidate_if_all_vetoed=True,
            symbol_prune_iterations=1,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            parameter_mutations={
                'max_entries_per_session': MutationSpace(
                    mode='numeric_step',
                    deltas=(Decimal('-1'), Decimal('0'), Decimal('1')),
                    minimum=Decimal('1'),
                    maximum=Decimal('4'),
                )
            },
            strategy_override_mutations={
                'normalization_regime': MutationSpace(mode='allowed_normalizations')
            },
        )
        base_sweep = {
            'parameters': {
                'max_entries_per_session': ['2'],
                'entry_cooldown_seconds': ['600'],
            },
            'strategy_overrides': {
                'universe_symbols': [['AMAT', 'NVDA']],
                'max_position_pct_equity': ['10.0'],
            },
        }
        candidate = {
            'candidate_id': 'candidate-1',
            'replay_config': {
                'params': {
                    'max_entries_per_session': '2',
                    'entry_cooldown_seconds': '600',
                },
                'strategy_overrides': {
                    'universe_symbols': ['AMAT', 'NVDA'],
                    'max_position_pct_equity': '10.0',
                },
            },
        }

        mutated, description = build_mutated_sweep_config(
            base_sweep_config=base_sweep,
            candidate_payload=candidate,
            family_plan=family_plan,
        )

        self.assertEqual(mutated['parameters']['entry_cooldown_seconds'], ['600'])
        self.assertEqual(mutated['parameters']['max_entries_per_session'], ['2', '1', '3'])
        self.assertEqual(mutated['strategy_overrides']['universe_symbols'], [['AMAT', 'NVDA']])
        self.assertEqual(mutated['strategy_overrides']['normalization_regime'], ['price_scaled', 'opening_window_scaled'])
        self.assertIn('max_entries_per_session', description)

    def test_candidate_meets_objective_respects_vetoes(self) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal('500'),
            min_active_day_ratio=Decimal('0.80'),
            min_positive_day_ratio=Decimal('0.55'),
            min_daily_notional=Decimal('300000'),
            max_best_day_share=Decimal('0.35'),
            max_worst_day_loss=Decimal('450'),
            max_drawdown=Decimal('1000'),
            require_every_day_active=False,
            min_regime_slice_pass_rate=Decimal('0.40'),
            stop_when_objective_met=False,
        )
        candidate = {
            'hard_vetoes': [],
            'objective_scorecard': {
                'net_pnl_per_day': '600',
                'active_day_ratio': '0.80',
                'positive_day_ratio': '0.60',
                'avg_filled_notional_per_day': '350000',
                'best_day_share': '0.30',
                'worst_day_loss': '300',
                'max_drawdown': '900',
                'regime_slice_pass_rate': '0.45',
            },
            'full_window': {'trading_day_count': 9, 'active_days': 7},
        }
        self.assertTrue(candidate_meets_objective(candidate, objective=objective))
        vetoed = dict(candidate)
        vetoed['hard_vetoes'] = ['best_day_share_above_max']
        self.assertFalse(candidate_meets_objective(vetoed, objective=objective))

    def test_write_autoresearch_notebooks_outputs_ipynb_files(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / 'summary.json').write_text(
                json.dumps({'best_candidate': {'candidate_id': 'c-1'}, 'program_id': 'program-1'}),
                encoding='utf-8',
            )
            (root / 'research_dossier.json').write_text(
                json.dumps(
                    {
                        'program_id': 'program-1',
                        'objective': {'target_net_pnl_per_day': '500'},
                        'research_sources': [],
                        'families': [],
                    }
                ),
                encoding='utf-8',
            )
            (root / 'history.jsonl').write_text(
                json.dumps(
                    {
                        'experiment_index': 1,
                        'iteration': 1,
                        'family_template_id': 'breakout_reclaim_v2',
                        'candidate_id': 'c-1',
                        'status': 'keep',
                        'net_pnl_per_day': '600',
                        'active_day_ratio': '0.80',
                        'positive_day_ratio': '0.60',
                        'avg_filled_notional_per_day': '300000',
                        'best_day_share': '0.30',
                        'max_drawdown': '900',
                        'pareto_tier': 1,
                        'mutation_label': 'seed',
                        'hard_vetoes': [],
                        'daily_net': {'2026-04-01': '600'},
                    }
                )
                + '\n',
                encoding='utf-8',
            )
            (root / 'results.tsv').write_text('header\n', encoding='utf-8')

            history_nb, dossier_nb = write_autoresearch_notebooks(root)
            self.assertTrue(history_nb.exists())
            self.assertTrue(dossier_nb.exists())
            payload = json.loads(history_nb.read_text(encoding='utf-8'))
            self.assertEqual(payload['nbformat'], 4)
            joined_source = ''.join(payload['cells'][1]['source'])
            self.assertIn(str(root), joined_source)
            self.assertIn('except ModuleNotFoundError', joined_source)
            all_sources = '\n'.join(''.join(cell.get('source', [])) for cell in payload['cells'])
            self.assertIn('Live Experiment Snapshots', all_sources)

    def test_generated_history_notebook_avoids_hard_pandas_dependency(self) -> None:
        payload = build_strategy_discovery_history_notebook(Path('/tmp/example-run'))
        joined_source = '\n'.join(
            ''.join(cell.get('source', []))
            for cell in payload['cells']
            if cell.get('cell_type') == 'code'
        )
        self.assertIn('except ModuleNotFoundError', joined_source)
        self.assertNotIn('sources_df = pd.DataFrame', joined_source)

    def test_write_strategy_factory_notebooks_outputs_ipynb_files(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / 'summary.json').write_text(
                json.dumps({'runner_run_id': 'factory-1', 'status': 'ok', 'best_candidate': {'candidate_id': 'cand-1'}}),
                encoding='utf-8',
            )
            (root / 'research_dossier.json').write_text(
                json.dumps(
                    {
                        'runner_run_id': 'factory-1',
                        'objective': {'mode': 'strategy_factory_v2'},
                        'source_experiments': [],
                        'families': [],
                        'dataset_snapshots': [],
                    }
                ),
                encoding='utf-8',
            )
            (root / 'history.jsonl').write_text(
                json.dumps(
                    {
                        'experiment_id': 'exp-1',
                        'source_run_id': 'paper-1',
                        'family_template_id': 'breakout_reclaim_v2',
                        'candidate_id': 'cand-1',
                        'status': 'keep',
                        'net_pnl_per_day': '600',
                        'active_day_ratio': '0.80',
                        'best_day_share': '0.30',
                        'max_drawdown': '900',
                        'pareto_tier': 1,
                        'hard_vetoes': [],
                        'decomposition': {'symbols': {'NVDA': {'net_pnl': '600'}}},
                    }
                )
                + '\n',
                encoding='utf-8',
            )
            (root / 'results.tsv').write_text('header\n', encoding='utf-8')

            history_nb, dossier_nb = write_strategy_factory_notebooks(root)
            self.assertTrue(history_nb.exists())
            self.assertTrue(dossier_nb.exists())
            payload = json.loads(history_nb.read_text(encoding='utf-8'))
            self.assertEqual(payload['nbformat'], 4)
            joined_source = '\n'.join(
                ''.join(cell.get('source', []))
                for cell in payload['cells']
                if cell.get('cell_type') == 'code'
            )
            self.assertIn('Best Candidate Decomposition', joined_source)

    def test_generated_strategy_factory_history_notebook_avoids_hard_pandas_dependency(self) -> None:
        payload = build_strategy_factory_history_notebook(Path('/tmp/factory-run'))
        joined_source = '\n'.join(
            ''.join(cell.get('source', []))
            for cell in payload['cells']
            if cell.get('cell_type') == 'code'
        )
        self.assertIn('except ModuleNotFoundError', joined_source)

    def test_run_strategy_autoresearch_loop_writes_history_results_and_notebooks(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / 'strategy-configmap.yaml'
            configmap_path.write_text(
                yaml.safe_dump({'apiVersion': 'v1', 'kind': 'ConfigMap', 'data': {'strategies.yaml': 'strategies: []\n'}}, sort_keys=False),
                encoding='utf-8',
            )
            output_dir = root / 'out'

            responses = [
                {
                    'dataset_snapshot_receipt': {'snapshot_id': 'snap-1'},
                    'top': [
                        {
                            'candidate_id': 'seed-1',
                            'hard_vetoes': [],
                            'ranking': {'pareto_tier': 1, 'tie_breaker_score': '10', 'vetoed': False},
                            'objective_scorecard': {
                                'net_pnl_per_day': '450',
                                'active_day_ratio': '0.70',
                                'positive_day_ratio': '0.55',
                                'avg_filled_notional_per_day': '290000',
                                'avg_filled_notional_per_active_day': '360000',
                                'best_day_share': '0.40',
                                'worst_day_loss': '350',
                                'max_drawdown': '900',
                                'regime_slice_pass_rate': '0.45',
                            },
                            'full_window': {
                                'net_per_day': '450',
                                'trading_day_count': 9,
                                'active_days': 6,
                                'daily_net': {'2026-04-01': '450'},
                                'daily_filled_notional': {'2026-04-01': '290000'},
                            },
                            'replay_config': {
                                'params': {'max_entries_per_session': '2', 'entry_cooldown_seconds': '600'},
                                'strategy_overrides': {'universe_symbols': ['AMAT', 'NVDA']},
                            },
                        }
                    ],
                },
                {
                    'dataset_snapshot_receipt': {'snapshot_id': 'snap-2'},
                    'top': [
                        {
                            'candidate_id': 'mutated-1',
                            'hard_vetoes': [],
                            'ranking': {'pareto_tier': 1, 'tie_breaker_score': '11', 'vetoed': False},
                            'objective_scorecard': {
                                'net_pnl_per_day': '620',
                                'active_day_ratio': '0.85',
                                'positive_day_ratio': '0.60',
                                'avg_filled_notional_per_day': '340000',
                                'avg_filled_notional_per_active_day': '400000',
                                'best_day_share': '0.30',
                                'worst_day_loss': '300',
                                'max_drawdown': '850',
                                'regime_slice_pass_rate': '0.50',
                            },
                            'full_window': {
                                'net_per_day': '620',
                                'trading_day_count': 9,
                                'active_days': 8,
                                'daily_net': {'2026-04-02': '620'},
                                'daily_filled_notional': {'2026-04-02': '340000'},
                            },
                            'replay_config': {
                                'params': {'max_entries_per_session': '1', 'entry_cooldown_seconds': '600'},
                                'strategy_overrides': {'universe_symbols': ['AMAT', 'NVDA']},
                            },
                        }
                    ],
                },
            ]

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url='http://example.invalid:8123',
                clickhouse_username='torghut',
                clickhouse_password='secret',
                start_equity='31590.02',
                chunk_minutes=10,
                symbols='',
                progress_log_seconds=30,
                train_days=6,
                holdout_days=3,
                full_window_start_date='',
                full_window_end_date='',
                expected_last_trading_day='',
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=0,
                json_output=None,
            )

            with patch(
                'scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier',
                side_effect=responses,
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload['status'], 'ok')
            self.assertEqual(payload['frontier_run_count'], 2)
            self.assertTrue(payload['objective_met'])
            run_root = Path(payload['run_root'])
            self.assertTrue((run_root / 'history.jsonl').exists())
            self.assertTrue((run_root / 'results.tsv').exists())
            self.assertTrue((run_root / 'strategy-discovery-history.ipynb').exists())
            summary = json.loads((run_root / 'summary.json').read_text(encoding='utf-8'))
            self.assertEqual(summary['best_candidate']['candidate_id'], 'mutated-1')

    def test_run_strategy_autoresearch_loop_flushes_visible_progress_between_experiments(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / 'strategy-configmap.yaml'
            configmap_path.write_text(
                yaml.safe_dump(
                    {'apiVersion': 'v1', 'kind': 'ConfigMap', 'data': {'strategies.yaml': 'strategies: []\n'}},
                    sort_keys=False,
                ),
                encoding='utf-8',
            )
            output_dir = root / 'out'

            responses = [
                {
                    'dataset_snapshot_receipt': {'snapshot_id': 'snap-1'},
                    'top': [
                        {
                            'candidate_id': 'seed-1',
                            'hard_vetoes': [],
                            'ranking': {'pareto_tier': 1, 'tie_breaker_score': '10', 'vetoed': False},
                            'objective_scorecard': {
                                'net_pnl_per_day': '450',
                                'active_day_ratio': '0.70',
                                'positive_day_ratio': '0.55',
                                'avg_filled_notional_per_day': '290000',
                                'avg_filled_notional_per_active_day': '360000',
                                'best_day_share': '0.40',
                                'worst_day_loss': '350',
                                'max_drawdown': '900',
                                'regime_slice_pass_rate': '0.45',
                            },
                            'full_window': {
                                'net_per_day': '450',
                                'trading_day_count': 9,
                                'active_days': 6,
                                'daily_net': {'2026-04-01': '450'},
                                'daily_filled_notional': {'2026-04-01': '290000'},
                            },
                            'replay_config': {
                                'params': {'max_entries_per_session': '2', 'entry_cooldown_seconds': '600'},
                                'strategy_overrides': {'universe_symbols': ['AMAT', 'NVDA']},
                            },
                        }
                    ],
                },
                {
                    'dataset_snapshot_receipt': {'snapshot_id': 'snap-2'},
                    'top': [
                        {
                            'candidate_id': 'mutated-1',
                            'hard_vetoes': [],
                            'ranking': {'pareto_tier': 1, 'tie_breaker_score': '11', 'vetoed': False},
                            'objective_scorecard': {
                                'net_pnl_per_day': '620',
                                'active_day_ratio': '0.85',
                                'positive_day_ratio': '0.60',
                                'avg_filled_notional_per_day': '340000',
                                'avg_filled_notional_per_active_day': '400000',
                                'best_day_share': '0.30',
                                'worst_day_loss': '300',
                                'max_drawdown': '850',
                                'regime_slice_pass_rate': '0.50',
                            },
                            'full_window': {
                                'net_per_day': '620',
                                'trading_day_count': 9,
                                'active_days': 8,
                                'daily_net': {'2026-04-02': '620'},
                                'daily_filled_notional': {'2026-04-02': '340000'},
                            },
                            'replay_config': {
                                'params': {'max_entries_per_session': '1', 'entry_cooldown_seconds': '600'},
                                'strategy_overrides': {'universe_symbols': ['AMAT', 'NVDA']},
                            },
                        }
                    ],
                },
            ]

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url='http://example.invalid:8123',
                clickhouse_username='torghut',
                clickhouse_password='secret',
                start_equity='31590.02',
                chunk_minutes=10,
                symbols='',
                progress_log_seconds=30,
                train_days=6,
                holdout_days=3,
                full_window_start_date='',
                full_window_end_date='',
                expected_last_trading_day='',
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=0,
                json_output=None,
            )

            frontier_call_count = {'count': 0}

            def _frontier_side_effect(_: Namespace) -> dict[str, object]:
                if frontier_call_count['count'] == 1:
                    run_roots = [path for path in output_dir.iterdir() if path.is_dir()]
                    self.assertEqual(len(run_roots), 1)
                    run_root = run_roots[0]
                    summary = json.loads((run_root / 'summary.json').read_text(encoding='utf-8'))
                    self.assertEqual(summary['status'], 'running')
                    self.assertEqual(summary['frontier_run_count'], 1)
                    history_lines = (run_root / 'history.jsonl').read_text(encoding='utf-8').splitlines()
                    self.assertEqual(len(history_lines), 1)
                    self.assertTrue((run_root / 'strategy-discovery-history.ipynb').exists())
                response = responses[frontier_call_count['count']]
                frontier_call_count['count'] += 1
                return response

            with patch(
                'scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier',
                side_effect=_frontier_side_effect,
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload['status'], 'ok')
            self.assertEqual(frontier_call_count['count'], 2)

    def test_run_strategy_autoresearch_loop_persists_error_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / 'strategy-configmap.yaml'
            configmap_path.write_text(
                yaml.safe_dump(
                    {'apiVersion': 'v1', 'kind': 'ConfigMap', 'data': {'strategies.yaml': 'strategies: []\n'}},
                    sort_keys=False,
                ),
                encoding='utf-8',
            )
            output_dir = root / 'out'

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url='http://example.invalid:8123',
                clickhouse_username='torghut',
                clickhouse_password='secret',
                start_equity='31590.02',
                chunk_minutes=10,
                symbols='',
                progress_log_seconds=30,
                train_days=6,
                holdout_days=3,
                full_window_start_date='',
                full_window_end_date='',
                expected_last_trading_day='',
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=0,
                json_output=None,
            )

            with patch(
                'scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier',
                side_effect=RuntimeError('frontier blew up'),
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload['status'], 'error')
            self.assertEqual(payload['error']['type'], 'RuntimeError')
            self.assertIn('frontier blew up', payload['error']['message'])
            run_root = Path(payload['run_root'])
            self.assertTrue((run_root / 'summary.json').exists())
            self.assertTrue((run_root / 'history.jsonl').exists())
            self.assertTrue((run_root / 'results.tsv').exists())
            self.assertTrue((run_root / 'research_dossier.json').exists())
            self.assertTrue((run_root / 'strategy-discovery-history.ipynb').exists())
