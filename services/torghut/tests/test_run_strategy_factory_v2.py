from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import scripts.run_strategy_factory_v2 as runner
from app.models import Base, VNextExperimentRun, VNextExperimentSpec


class TestRunStrategyFactoryV2(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

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
                                        'params': {'existing_param': '1'},
                                    }
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

    def _write_family_template(self, root: Path) -> Path:
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
                    'allowed_normalizations': ['price_scaled', 'trading_value_scaled'],
                    'entry_motifs': ['breakout_reclaim'],
                    'exit_motifs': ['trailing_stop'],
                    'risk_controls': ['stop_loss'],
                    'activity_model': {
                        'min_active_day_ratio': '0.50',
                        'min_daily_notional': '200000',
                    },
                    'liquidity_assumptions': {'max_spread_bps': '30'},
                    'regime_activation_rules': [],
                    'day_veto_rules': [{'rule': 'quote_quality', 'action': 'block_day'}],
                    'default_hard_vetoes': {
                        'required_min_active_day_ratio': '0.50',
                        'required_min_daily_notional': '200000',
                        'required_max_best_day_share': '0.50',
                        'required_max_worst_day_loss': '400',
                        'required_max_drawdown': '900',
                        'required_min_regime_slice_pass_rate': '0.40',
                    },
                    'default_selection_objectives': {
                        'target_net_pnl_per_day': '300',
                        'require_positive_day_ratio': '0.60',
                    },
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
        return family_dir

    def _write_seed_sweep(self, root: Path) -> Path:
        seed_dir = root / 'seed'
        seed_dir.mkdir()
        (seed_dir / 'profitability-frontier-consistent-breakout.yaml').write_text(
            yaml.safe_dump(
                {
                    'schema_version': 'torghut.replay-frontier-sweep.v1',
                    'family': 'breakout_continuation_consistent',
                    'family_template_id': 'breakout_reclaim_v2',
                    'strategy_name': 'breakout-continuation-long-v1',
                    'disable_other_strategies': True,
                    'constraints': {'min_profit_factor': '1.10'},
                    'consistency_constraints': {'max_negative_days': 2},
                    'strategy_overrides': {
                        'universe_symbols': [['AMAT', 'NVDA']],
                    },
                    'parameters': {
                        'existing_param': ['1', '2'],
                    },
                },
                sort_keys=False,
            ),
            encoding='utf-8',
        )
        return seed_dir

    def _args(
        self,
        *,
        output_dir: Path,
        strategy_configmap: Path,
        family_template_dir: Path,
        seed_sweep_dir: Path,
    ) -> Namespace:
        return Namespace(
            output_dir=output_dir,
            experiment_id=[],
            paper_run_id=[],
            limit=10,
            strategy_configmap=strategy_configmap,
            family_template_dir=family_template_dir,
            seed_sweep_dir=seed_sweep_dir,
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
            top_n=3,
            persist_results=True,
        )

    def test_run_strategy_factory_v2_compiles_executes_and_persists(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / 'artifacts'
            output_dir.mkdir()

            with Session(self.engine) as session:
                session.add(
                    VNextExperimentSpec(
                        run_id='paper-run-1',
                        candidate_id=None,
                        experiment_id='exp-breakout-1',
                        payload_json={
                            'family_template_id': 'breakout_reclaim_v2',
                            'paper_claim_links': ['claim-1'],
                            'selection_objectives': {
                                'target_net_pnl_per_day': '320',
                                'require_positive_day_ratio': '0.75',
                            },
                            'hard_vetoes': {
                                'required_min_active_day_ratio': '0.50',
                                'required_min_daily_notional': '210000',
                                'required_max_best_day_share': '0.45',
                                'required_max_worst_day_loss': '350',
                                'required_max_drawdown': '800',
                                'required_min_regime_slice_pass_rate': '0.55',
                            },
                            'template_overrides': {
                                'max_notional_per_trade': '50000',
                                'params': {
                                    'long_stop_loss_bps': '12',
                                },
                            },
                            'feature_variants': ['trading_value_scaled'],
                            'veto_controller_variants': [{'rule': 'quote_quality'}],
                        },
                    )
                )
                session.commit()

            fake_payload = {
                'dataset_snapshot_receipt': {'snapshot_id': 'snap-1'},
                'top': [
                    {
                        'candidate_id': 'cand-1',
                        'full_window': {'net_per_day': '321.5'},
                    }
                ],
            }
            with (
                patch(
                    'scripts.run_strategy_factory_v2.SessionLocal',
                    side_effect=lambda: Session(self.engine),
                ),
                patch(
                    'scripts.run_strategy_factory_v2.run_consistent_profitability_frontier',
                    return_value=fake_payload,
                ) as mock_frontier,
            ):
                result = runner.run_strategy_factory_v2(
                    self._args(
                        output_dir=output_dir,
                        strategy_configmap=strategy_configmap,
                        family_template_dir=family_template_dir,
                        seed_sweep_dir=seed_sweep_dir,
                    )
                )

            self.assertEqual(result['status'], 'ok')
            self.assertEqual(result['count'], 1)
            self.assertEqual(result['experiments'][0]['experiment_id'], 'exp-breakout-1')
            self.assertEqual(result['experiments'][0]['top_candidate_id'], 'cand-1')
            self.assertEqual(result['experiments'][0]['dataset_snapshot_id'], 'snap-1')
            mock_frontier.assert_called_once()

            compiled_sweep_path = output_dir / 'exp-breakout-1' / 'compiled-sweep.yaml'
            compiled = yaml.safe_load(compiled_sweep_path.read_text(encoding='utf-8'))
            self.assertEqual(compiled['family_template_id'], 'breakout_reclaim_v2')
            self.assertEqual(compiled['family'], 'breakout_continuation_consistent')
            self.assertEqual(compiled['strategy_name'], 'breakout-continuation-long-v1')
            self.assertEqual(compiled['constraints']['holdout_target_net_per_day'], '320')
            self.assertEqual(compiled['consistency_constraints']['min_active_days'], 5)
            self.assertEqual(compiled['consistency_constraints']['min_positive_days'], 7)
            self.assertEqual(compiled['consistency_constraints']['min_avg_filled_notional_per_day'], '210000')
            self.assertEqual(compiled['strategy_overrides']['normalization_regime'], ['trading_value_scaled'])
            self.assertEqual(compiled['strategy_overrides']['max_notional_per_trade'], ['50000'])
            self.assertEqual(compiled['parameters']['long_stop_loss_bps'], ['12'])
            self.assertEqual(compiled['experiment_spec']['paper_claim_links'], ['claim-1'])

            result_path = output_dir / 'exp-breakout-1' / 'result.json'
            self.assertEqual(json.loads(result_path.read_text(encoding='utf-8')), fake_payload)

            with Session(self.engine) as session:
                run_row = session.execute(
                    select(VNextExperimentRun).where(VNextExperimentRun.experiment_id == 'exp-breakout-1')
                ).scalar_one()
                self.assertEqual(run_row.candidate_id, 'cand-1')
                persisted_spec = session.execute(
                    select(VNextExperimentSpec)
                    .where(VNextExperimentSpec.experiment_id == 'exp-breakout-1')
                    .where(VNextExperimentSpec.run_id != 'paper-run-1')
                ).scalar_one()
                self.assertEqual(persisted_spec.candidate_id, 'cand-1')

    def test_run_strategy_factory_v2_returns_no_experiments_when_source_empty(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            with patch(
                'scripts.run_strategy_factory_v2.SessionLocal',
                side_effect=lambda: Session(self.engine),
            ):
                result = runner.run_strategy_factory_v2(
                    self._args(
                        output_dir=root / 'artifacts',
                        strategy_configmap=strategy_configmap,
                        family_template_dir=family_template_dir,
                        seed_sweep_dir=seed_sweep_dir,
                    )
                )

        self.assertEqual(result, {'status': 'no_experiments', 'count': 0, 'experiments': []})
