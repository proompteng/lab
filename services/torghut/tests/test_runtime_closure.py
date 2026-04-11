from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery.autoresearch import (
    ProposalModelPolicy,
    ReplayBudget,
    SnapshotPolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
)
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.runtime_closure import write_runtime_closure_bundle


def _program() -> StrategyAutoresearchProgram:
    return StrategyAutoresearchProgram(
        program_id='program-1',
        description='desc',
        objective=StrategyObjective(
            target_net_pnl_per_day='500',  # type: ignore[arg-type]
            min_active_day_ratio='1.0',  # type: ignore[arg-type]
            min_positive_day_ratio='0.6',  # type: ignore[arg-type]
            min_daily_notional='300000',  # type: ignore[arg-type]
            max_best_day_share='0.3',  # type: ignore[arg-type]
            max_worst_day_loss='350',  # type: ignore[arg-type]
            max_drawdown='900',  # type: ignore[arg-type]
            require_every_day_active=True,
            min_regime_slice_pass_rate='0.45',  # type: ignore[arg-type]
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
