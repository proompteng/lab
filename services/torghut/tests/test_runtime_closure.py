from __future__ import annotations

import json
import subprocess
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery.autoresearch import (
    ProposalModelPolicy,
    ReplayBudget,
    RuntimeClosurePolicy,
    SnapshotPolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
)
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.runtime_closure import (
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _program() -> StrategyAutoresearchProgram:
    return StrategyAutoresearchProgram(
        program_id='program-1',
        description='desc',
        objective=StrategyObjective(
            target_net_pnl_per_day=Decimal('500'),
            min_active_day_ratio=Decimal('1.0'),
            min_positive_day_ratio=Decimal('0.6'),
            min_daily_notional=Decimal('300000'),
            max_best_day_share=Decimal('0.3'),
            max_worst_day_loss=Decimal('350'),
            max_drawdown=Decimal('900'),
            require_every_day_active=True,
            min_regime_slice_pass_rate=Decimal('0.45'),
            stop_when_objective_met=True,
        ),
        snapshot_policy=SnapshotPolicy(
            bar_interval='PT1S',
            feature_set_id='torghut.mlx-autoresearch.v1',
            quote_quality_policy_id='scheduler_v3_default',
            symbol_policy='args_or_sweep',
            allow_prior_day_features=True,
            allow_cross_sectional_features=True,
        ),
        forbidden_mutations=('runtime_code_path',),
        proposal_model_policy=ProposalModelPolicy(
            enabled=True,
            mode='ranking_only',
            backend_preference='mlx',
            top_k=4,
            exploration_slots=1,
            minimum_history_rows=1,
        ),
        replay_budget=ReplayBudget(max_candidates_per_round=8, exploration_slots=1),
        runtime_closure_policy=RuntimeClosurePolicy(
            enabled=False,
            execute_parity_replay=True,
            execute_approval_replay=True,
            parity_window='full_window',
            approval_window='holdout',
            shadow_validation_mode='require_live_evidence',
            promotion_target='shadow',
        ),
        parity_requirements=('scheduler_v3_parity_replay',),
        promotion_policy='research_only',
        ledger_policy={'append_only': True},
        research_sources=(),
        families=(),
    )


class TestRuntimeClosure(TestCase):
    def test_write_runtime_closure_bundle_emits_fail_closed_governance_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id='run-1',
                program=_program(),
                symbols='AMAT,NVDA',
                train_days=6,
                holdout_days=2,
                full_window_start_date='2026-03-20',
                full_window_end_date='2026-04-09',
                row_counts={'receipt_count': 1, 'signal_row_count': 42},
            )
            best_candidate = {
                'candidate_id': 'cand-1',
                'family_template_id': 'breakout_reclaim_v2',
                'runtime_family': 'breakout_continuation_consistent',
                'runtime_strategy_name': 'breakout-continuation-long-v1',
                'objective_scope': 'research_only',
                'objective_met': True,
                'status': 'keep',
                'mutation_label': 'seed',
                'descriptor_id': 'desc-1',
                'entry_window_start_minute': 45,
                'entry_window_end_minute': 75,
                'max_hold_minutes': 30,
                'rank_count': 1,
                'requires_prev_day_features': True,
                'requires_cross_sectional_features': True,
                'requires_quote_quality_gate': True,
                'net_pnl_per_day': '620',
                'active_day_ratio': '0.85',
                'positive_day_ratio': '0.60',
                'best_day_share': '0.30',
                'worst_day_loss': '300',
                'max_drawdown': '850',
                'proposal_score': 12.0,
                'proposal_rank': 1,
                'promotion_status': 'blocked_pending_runtime_parity',
                'promotion_stage': 'research_candidate',
                'promotion_reason': 'still blocked',
                'promotion_blockers': [
                    'scheduler_v3_parity_missing',
                    'scheduler_v3_approval_missing',
                    'shadow_validation_missing',
                ],
                'promotion_required_evidence': [
                    'checked_in_runtime_family',
                    'scheduler_v3_parity_replay',
                    'scheduler_v3_approval_replay',
                    'live_shadow_validation',
                ],
            }

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id='run-1',
                program=_program(),
                best_candidate=best_candidate,
                manifest=manifest,
            )

            self.assertEqual(summary.status, 'pending_runtime_parity')
            self.assertFalse(summary.promotion_prerequisites['allowed'])
            self.assertFalse(summary.rollback_readiness['ready'])
            self.assertIn('scheduler_v3_parity_replay', summary.next_required_steps)
            self.assertTrue(Path(summary.candidate_spec_path).exists())
            self.assertTrue(Path(summary.promotion_prerequisites_path).exists())
            self.assertTrue(Path(summary.profitability_stage_manifest_path).exists())

            manifest_payload = json.loads(Path(summary.profitability_stage_manifest_path).read_text(encoding='utf-8'))
            self.assertEqual(manifest_payload['candidate_id'], 'cand-1')
            self.assertEqual(manifest_payload['overall_status'], 'fail')
            self.assertIn('validation_stage_incomplete', manifest_payload['failure_reasons'])
            self.assertEqual(manifest_payload['run_context']['run_id'], 'run-1')
            self.assertEqual(
                manifest_payload['run_context']['head'],
                subprocess.run(
                    ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                    cwd=_REPO_ROOT,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
            )

    def test_write_runtime_closure_bundle_executes_runtime_replays_when_enabled(self) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id='run-1',
                program=_program(),
                symbols='AMAT,NVDA',
                train_days=6,
                holdout_days=2,
                full_window_start_date='2026-03-20',
                full_window_end_date='2026-04-09',
                row_counts={'receipt_count': 1, 'signal_row_count': 42},
            )
            configmap_path = run_root / 'strategy-configmap.yaml'
            configmap_path.write_text(
                """
apiVersion: v1
kind: ConfigMap
data:
  strategies.yaml: |
    strategies:
      - name: breakout-continuation-long-v1
        enabled: true
        family: breakout_continuation_consistent
        params:
          max_entries_per_session: '1'
        universe_symbols:
          - AMAT
          - NVDA
""".strip()
                + "\n",
                encoding='utf-8',
            )
            program = _program()
            program = StrategyAutoresearchProgram(
                **{
                    **program.__dict__,
                    'objective': StrategyObjective(
                        target_net_pnl_per_day=Decimal('500'),
                        min_active_day_ratio=Decimal('1.0'),
                        min_positive_day_ratio=Decimal('0.6'),
                        min_daily_notional=Decimal('300000'),
                        max_best_day_share=Decimal('0.3'),
                        max_worst_day_loss=Decimal('350'),
                        max_drawdown=Decimal('900'),
                        require_every_day_active=True,
                        min_regime_slice_pass_rate=Decimal('0'),
                        stop_when_objective_met=True,
                    ),
                    'runtime_closure_policy': RuntimeClosurePolicy(
                        enabled=True,
                        execute_parity_replay=True,
                        execute_approval_replay=True,
                        parity_window='full_window',
                        approval_window='holdout',
                        shadow_validation_mode='require_live_evidence',
                        promotion_target='shadow',
                    ),
                }
            )
            best_candidate = {
                'candidate_id': 'cand-1',
                'family_template_id': 'breakout_reclaim_v2',
                'runtime_family': 'breakout_continuation_consistent',
                'runtime_strategy_name': 'breakout-continuation-long-v1',
                'objective_scope': 'research_only',
                'objective_met': True,
                'status': 'keep',
                'mutation_label': 'seed',
                'descriptor_id': 'desc-1',
                'entry_window_start_minute': 45,
                'entry_window_end_minute': 75,
                'max_hold_minutes': 30,
                'rank_count': 1,
                'requires_prev_day_features': True,
                'requires_cross_sectional_features': True,
                'requires_quote_quality_gate': True,
                'net_pnl_per_day': '620',
                'active_day_ratio': '0.85',
                'positive_day_ratio': '0.60',
                'best_day_share': '0.30',
                'worst_day_loss': '300',
                'max_drawdown': '850',
                'proposal_score': 12.0,
                'proposal_rank': 1,
                'promotion_status': 'blocked_pending_runtime_parity',
                'promotion_stage': 'research_candidate',
                'promotion_reason': 'still blocked',
                'promotion_blockers': [
                    'scheduler_v3_parity_missing',
                    'scheduler_v3_approval_missing',
                    'shadow_validation_missing',
                ],
                'promotion_required_evidence': [
                    'checked_in_runtime_family',
                    'scheduler_v3_parity_replay',
                    'scheduler_v3_approval_replay',
                    'live_shadow_validation',
                ],
                'candidate_params': {'max_entries_per_session': '1'},
                'candidate_strategy_overrides': {'universe_symbols': ['AMAT', 'NVDA']},
                'disable_other_strategies': True,
                'train_start_date': '2026-03-20',
                'train_end_date': '2026-03-27',
                'holdout_start_date': '2026-04-08',
                'holdout_end_date': '2026-04-09',
                'full_window_start_date': '2026-03-20',
                'full_window_end_date': '2026-04-09',
                'normalization_regime': 'price_scaled',
            }

            replay_payload = {
                'start_date': '2026-03-20',
                'end_date': '2026-04-09',
                'net_pnl': '6000',
                'decision_count': 12,
                'filled_count': 9,
                'wins': 7,
                'losses': 2,
                'daily': {
                    '2026-03-20': {'net_pnl': '1000', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-21': {'net_pnl': '800', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-24': {'net_pnl': '700', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-25': {'net_pnl': '900', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-26': {'net_pnl': '1100', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-27': {'net_pnl': '600', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-04-08': {'net_pnl': '500', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-04-09': {'net_pnl': '400', 'filled_count': 1, 'filled_notional': '300000'},
                },
            }

            def _fake_replay_executor(_: object) -> dict[str, object]:
                return dict(replay_payload)

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id='run-1',
                program=program,
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=configmap_path,
                    clickhouse_http_url='http://example.invalid:8123',
                    clickhouse_username='torghut',
                    clickhouse_password='secret',
                    start_equity=Decimal('31590.02'),
                    chunk_minutes=10,
                    symbols=('AMAT', 'NVDA'),
                    progress_log_interval_seconds=30,
                ),
                replay_executor=_fake_replay_executor,
            )

            self.assertEqual(summary.status, 'pending_shadow_validation')
            self.assertTrue(Path(summary.candidate_configmap_path).exists())
            self.assertTrue(Path(summary.parity_replay_path).exists())
            self.assertTrue(Path(summary.approval_replay_path).exists())
            self.assertTrue(Path(summary.shadow_validation_path).exists())
            self.assertIn('live_shadow_validation', summary.next_required_steps)

            parity_report = json.loads(Path(summary.parity_report_path).read_text(encoding='utf-8'))
            self.assertTrue(parity_report['objective_met'])
            self.assertEqual(parity_report['window_name'], 'full_window')

    def test_write_runtime_closure_bundle_keeps_pending_parity_when_execution_skipped(self) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id='run-1',
                program=_program(),
                symbols='AMAT,NVDA',
                train_days=6,
                holdout_days=2,
                full_window_start_date='2026-03-20',
                full_window_end_date='2026-04-09',
            )
            configmap_path = run_root / 'strategy-configmap.yaml'
            configmap_path.write_text(
                """
apiVersion: v1
kind: ConfigMap
data:
  strategies.yaml: |
    strategies:
      - name: breakout-continuation-long-v1
        enabled: true
        family: breakout_continuation_consistent
        params:
          max_entries_per_session: '1'
""".strip()
                + "\n",
                encoding='utf-8',
            )
            program = StrategyAutoresearchProgram(
                **{
                    **_program().__dict__,
                    'runtime_closure_policy': RuntimeClosurePolicy(
                        enabled=True,
                        execute_parity_replay=False,
                        execute_approval_replay=False,
                        parity_window='full_window',
                        approval_window='holdout',
                        shadow_validation_mode='skip',
                        promotion_target='shadow',
                    ),
                }
            )
            best_candidate = {
                'candidate_id': 'cand-1',
                'family_template_id': 'breakout_reclaim_v2',
                'runtime_family': 'breakout_continuation_consistent',
                'runtime_strategy_name': 'breakout-continuation-long-v1',
                'status': 'keep',
                'candidate_params': {'max_entries_per_session': '1'},
                'candidate_strategy_overrides': {},
                'disable_other_strategies': True,
                'full_window_start_date': '2026-03-20',
                'full_window_end_date': '2026-04-09',
            }

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id='run-1',
                program=program,
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=configmap_path,
                    clickhouse_http_url='http://example.invalid:8123',
                    clickhouse_username='torghut',
                    clickhouse_password='secret',
                    start_equity=Decimal('31590.02'),
                    chunk_minutes=10,
                ),
            )

            self.assertEqual(summary.status, 'pending_runtime_parity')
            self.assertEqual(
                summary.next_required_steps,
                ('scheduler_v3_parity_replay', 'scheduler_v3_approval_replay'),
            )
            self.assertEqual(summary.shadow_validation_path, str(run_root / 'runtime-closure' / 'replay' / 'shadow-validation-plan.json'))

    def test_write_runtime_closure_bundle_skips_shadow_status_when_shadow_not_required(self) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id='run-1',
                program=_program(),
                symbols='AMAT,NVDA',
                train_days=6,
                holdout_days=2,
                full_window_start_date='2026-03-20',
                full_window_end_date='2026-04-09',
            )
            configmap_path = run_root / 'strategy-configmap.yaml'
            configmap_path.write_text(
                """
apiVersion: v1
kind: ConfigMap
data:
  strategies.yaml: |
    strategies:
      - name: breakout-continuation-long-v1
        enabled: true
        family: breakout_continuation_consistent
        params:
          max_entries_per_session: '1'
        universe_symbols:
          - AMAT
          - NVDA
""".strip()
                + "\n",
                encoding='utf-8',
            )
            program = StrategyAutoresearchProgram(
                **{
                    **_program().__dict__,
                    'objective': StrategyObjective(
                        target_net_pnl_per_day=Decimal('500'),
                        min_active_day_ratio=Decimal('1.0'),
                        min_positive_day_ratio=Decimal('0.6'),
                        min_daily_notional=Decimal('300000'),
                        max_best_day_share=Decimal('0.3'),
                        max_worst_day_loss=Decimal('350'),
                        max_drawdown=Decimal('900'),
                        require_every_day_active=True,
                        min_regime_slice_pass_rate=Decimal('0'),
                        stop_when_objective_met=True,
                    ),
                    'runtime_closure_policy': RuntimeClosurePolicy(
                        enabled=True,
                        execute_parity_replay=True,
                        execute_approval_replay=True,
                        parity_window='full_window',
                        approval_window='holdout',
                        shadow_validation_mode='skip',
                        promotion_target='shadow',
                    ),
                }
            )
            best_candidate = {
                'candidate_id': 'cand-1',
                'family_template_id': 'breakout_reclaim_v2',
                'runtime_family': 'breakout_continuation_consistent',
                'runtime_strategy_name': 'breakout-continuation-long-v1',
                'status': 'keep',
                'candidate_params': {'max_entries_per_session': '1'},
                'candidate_strategy_overrides': {'universe_symbols': ['AMAT', 'NVDA']},
                'disable_other_strategies': True,
                'holdout_start_date': '2026-04-08',
                'holdout_end_date': '2026-04-09',
                'full_window_start_date': '2026-03-20',
                'full_window_end_date': '2026-04-09',
                'normalization_regime': 'price_scaled',
            }
            replay_payload = {
                'start_date': '2026-03-20',
                'end_date': '2026-04-09',
                'net_pnl': '6000',
                'decision_count': 12,
                'filled_count': 9,
                'wins': 7,
                'losses': 2,
                'daily': {
                    '2026-03-20': {'net_pnl': '1000', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-21': {'net_pnl': '800', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-24': {'net_pnl': '700', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-25': {'net_pnl': '900', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-26': {'net_pnl': '1100', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-03-27': {'net_pnl': '600', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-04-08': {'net_pnl': '500', 'filled_count': 1, 'filled_notional': '300000'},
                    '2026-04-09': {'net_pnl': '400', 'filled_count': 1, 'filled_notional': '300000'},
                },
            }

            def _fake_replay_executor(_: object) -> dict[str, object]:
                return dict(replay_payload)

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id='run-1',
                program=program,
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=configmap_path,
                    clickhouse_http_url='http://example.invalid:8123',
                    clickhouse_username='torghut',
                    clickhouse_password='secret',
                    start_equity=Decimal('31590.02'),
                    chunk_minutes=10,
                    symbols=('AMAT', 'NVDA'),
                    progress_log_interval_seconds=30,
                ),
                replay_executor=_fake_replay_executor,
            )

            self.assertEqual(summary.status, 'ready_for_promotion_review')
            self.assertEqual(summary.next_required_steps, ('promotion_review',))

    def test_write_runtime_closure_bundle_handles_missing_best_candidate(self) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id='run-1',
                program=_program(),
                symbols='AMAT,NVDA',
                train_days=6,
                holdout_days=2,
                full_window_start_date='2026-03-20',
                full_window_end_date='2026-04-09',
            )
            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id='run-1',
                program=_program(),
                best_candidate=None,
                manifest=manifest,
            )

            self.assertEqual(summary.status, 'missing_candidate')
            self.assertTrue((run_root / 'runtime-closure' / 'summary.json').exists())
