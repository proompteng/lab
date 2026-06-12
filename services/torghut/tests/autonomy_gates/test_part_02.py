from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.autonomy_gates.support import *


class TestAutonomyGatesPart2(_TestAutonomyGatesBase):
    def test_gate_matrix_degrades_when_uncertainty_threshold_exceeded(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=2,
            llm_metrics={"error_ratio": "0.00"},
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={"fold_count": 4, "negative_fold_count": 0, "net_pnl_cv": "0.2"},
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(
                coverage_error="0.06",
                gate_action="degrade",
                recalibration_run_id="recal-1",
                recalibration_artifact_ref="/tmp/recalibration-report.json",
            ),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertEqual(report.uncertainty_gate_action, "degrade")
        self.assertIn("uncertainty_gate_action_degrade", report.reasons)

    def test_gate_matrix_fails_closed_when_uncertainty_inputs_missing(self) -> None:
        policy = GatePolicyMatrix()
        payload = _profitability_evidence_payload()
        confidence = dict(payload["confidence_calibration"])
        del confidence["coverage_error"]
        payload["confidence_calibration"] = confidence
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=2,
            llm_metrics={"error_ratio": "0.00"},
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={"fold_count": 4, "negative_fold_count": 0, "net_pnl_cv": "0.2"},
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=payload,
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertEqual(report.uncertainty_gate_action, "abstain")
        self.assertIn("uncertainty_inputs_missing_or_invalid", report.reasons)

    def test_gate_matrix_blocks_when_llm_metrics_missing(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=2,
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={"fold_count": 4, "negative_fold_count": 0, "net_pnl_cv": "0.2"},
            llm_metrics={},
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("llm_error_ratio_missing", report.reasons)

    def test_gate_matrix_fails_when_feature_staleness_is_missing(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=None,
            symbol_coverage=2,
            llm_metrics={"error_ratio": "0.00"},
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={"fold_count": 4, "negative_fold_count": 0, "net_pnl_cv": "0.2"},
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("feature_staleness_missing", report.reasons)

    def test_gate_matrix_fails_closed_when_uncertainty_inputs_non_finite(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=2,
            llm_metrics={"error_ratio": "0.00"},
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={"fold_count": 4, "negative_fold_count": 0, "net_pnl_cv": "0.2"},
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(
                coverage_error="NaN"
            ),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertEqual(report.uncertainty_gate_action, "abstain")
        self.assertIn("uncertainty_inputs_missing_or_invalid", report.reasons)

    def test_gate_matrix_fails_when_shift_score_reaches_fail_threshold(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=2,
            llm_metrics={"error_ratio": "0.00"},
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={"fold_count": 4, "negative_fold_count": 0, "net_pnl_cv": "0.2"},
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(
                coverage_error="0.02",
                shift_score="0.95",
                recalibration_run_id="recal-1",
                recalibration_artifact_ref="/tmp/recalibration-report.json",
            ),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertEqual(report.uncertainty_gate_action, "fail")
        self.assertIn("regime_shift_score_fail_threshold_exceeded", report.reasons)
