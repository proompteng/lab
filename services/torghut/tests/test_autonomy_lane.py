from __future__ import annotations

from unittest import TestCase

from app.trading.autonomy import (
    build_metrics_bundle,
    build_paper_candidate_patch,
    derive_deterministic_run_id,
    evaluate_gate_policy_matrix,
)


class TestAutonomyLane(TestCase):
    def setUp(self) -> None:
        self.policy = {
            'policy_version': 'v3',
            'allow_live_promotion': False,
            'auto_freeze_failure_count': 3,
            'gate_1_max_negative_fold_count': 0,
            'gate_2_max_drawdown': 0.35,
            'gate_2_max_turnover_ratio': 5.0,
            'gate_5_required_paper_days': 14,
        }
        self.evaluation_report = {
            'metrics': {
                'max_drawdown': '0.10',
                'turnover_ratio': '1.5',
            },
            'robustness': {
                'negative_fold_count': 0,
            },
            'multiple_testing': {
                'warning_triggered': False,
            },
        }

    def test_gate_policy_pass_for_paper_path(self) -> None:
        metrics_bundle = build_metrics_bundle(
            self.evaluation_report,
            rollout={
                'paper_stability_days': 21,
                'required_paper_stability_days': 14,
                'compliance_evidence_complete': True,
                'approval_token_present': True,
                'config_drift': False,
            },
        )
        report = evaluate_gate_policy_matrix(
            metrics_bundle,
            self.policy,
            code_version='test',
            promotion_target='paper',
        )

        self.assertEqual(report.overall_status, 'pass')
        self.assertTrue(report.promotion_allowed)
        self.assertEqual(report.recommended_mode, 'paper')

    def test_gate_policy_fail_blocks_live_and_freezes_candidate(self) -> None:
        metrics_bundle = build_metrics_bundle(
            self.evaluation_report,
            data_integrity={
                'schema_compatible': False,
                'feature_null_rate': 0.2,
                'max_feature_null_rate': 0.05,
                'staleness_seconds': 90,
                'max_staleness_seconds': 30,
                'duplicate_rate': 0.5,
                'max_duplicate_rate': 0.01,
                'symbol_coverage': 0.5,
                'min_symbol_coverage': 0.95,
            },
            operations={
                'runbooks_validated': False,
                'kill_switch_dry_run_passed': False,
                'rollback_dry_run_passed': False,
                'alerts_active': False,
            },
            rollout={
                'paper_stability_days': 2,
                'required_paper_stability_days': 14,
                'compliance_evidence_complete': False,
                'approval_token_present': False,
                'config_drift': True,
            },
        )
        report = evaluate_gate_policy_matrix(
            metrics_bundle,
            self.policy,
            code_version='test',
            promotion_target='live',
        )

        self.assertEqual(report.overall_status, 'fail')
        self.assertFalse(report.promotion_allowed)
        self.assertTrue(report.candidate_frozen)
        self.assertEqual(report.recommended_mode, 'shadow')

    def test_paper_candidate_patch_keeps_live_disabled(self) -> None:
        metrics_bundle = build_metrics_bundle(self.evaluation_report)
        report = evaluate_gate_policy_matrix(
            metrics_bundle,
            self.policy,
            code_version='test',
            promotion_target='paper',
        )
        candidate_spec = {
            'candidate_id': 'cand-1',
            'strategy_name': 'cand-strategy',
            'base_timeframe': '1Min',
            'strategy_type': 'legacy_macd_rsi',
            'universe_symbols': ['AAPL'],
        }
        run_id = derive_deterministic_run_id(candidate_spec, {'window': '2026-02-10'})
        patch = build_paper_candidate_patch(candidate_spec, report, run_id=run_id)

        payload = patch['data']['autonomy-candidate.json']
        self.assertIn('"live_enabled": false', payload)

    def test_run_id_is_deterministic(self) -> None:
        candidate_spec = {'candidate_id': 'cand-1', 'strategy_name': 'cand'}
        context = {'window': '2026-02-10', 'policy': 'v3'}
        run_id_a = derive_deterministic_run_id(candidate_spec, context)
        run_id_b = derive_deterministic_run_id(candidate_spec, context)
        self.assertEqual(run_id_a, run_id_b)
