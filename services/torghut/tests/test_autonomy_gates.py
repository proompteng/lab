from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.autonomy.gates import GateInputs, GatePolicyMatrix, evaluate_gate_matrix


class TestAutonomyGates(TestCase):
    def test_gate_matrix_passes_paper_with_safe_metrics(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version='3.0.0',
            required_feature_null_rate=Decimal('0.00'),
            staleness_ms_p95=0,
            symbol_coverage=3,
            metrics={
                'decision_count': 20,
                'trade_count': 10,
                'net_pnl': '50',
                'max_drawdown': '100',
                'turnover_ratio': '1.5',
                'cost_bps': '5',
            },
            robustness={
                'fold_count': 4,
                'negative_fold_count': 1,
                'net_pnl_cv': '0.3',
            },
        )

        report = evaluate_gate_matrix(inputs, policy=policy, promotion_target='paper', code_version='test')

        self.assertTrue(report.promotion_allowed)
        self.assertEqual(report.recommended_mode, 'paper')

    def test_live_remains_gated_by_default(self) -> None:
        policy = GatePolicyMatrix(gate5_live_enabled=False)
        inputs = GateInputs(
            feature_schema_version='3.0.0',
            required_feature_null_rate=Decimal('0.00'),
            staleness_ms_p95=0,
            symbol_coverage=2,
            metrics={
                'decision_count': 20,
                'trade_count': 10,
                'net_pnl': '50',
                'max_drawdown': '100',
                'turnover_ratio': '1.5',
                'cost_bps': '5',
            },
            robustness={'fold_count': 4, 'negative_fold_count': 0, 'net_pnl_cv': '0.2'},
        )

        report = evaluate_gate_matrix(inputs, policy=policy, promotion_target='live', code_version='test')

        self.assertFalse(report.promotion_allowed)
        self.assertIn('live_rollout_disabled_by_policy', report.reasons)
