from __future__ import annotations

import json
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.trading.autonomy.gates import (
    GateInputs,
    GatePolicyMatrix,
    evaluate_gate_matrix,
)


class TestAutonomyGates(TestCase):
    def test_gate_matrix_passes_paper_with_safe_metrics(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=3,
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={
                "fold_count": 4,
                "negative_fold_count": 1,
                "net_pnl_cv": "0.3",
            },
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertTrue(report.promotion_allowed)
        self.assertEqual(report.recommended_mode, "paper")
        self.assertEqual(report.uncertainty_gate_action, "pass")

    def test_live_remains_gated_by_default(self) -> None:
        policy = GatePolicyMatrix(gate5_live_enabled=False)
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
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="live", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("live_rollout_disabled_by_policy", report.reasons)

    def test_policy_loader_preserves_explicit_zero_thresholds(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / "policy.json"
            policy_path.write_text(
                json.dumps(
                    {
                        "gate0_max_null_rate": "0",
                        "gate1_min_net_pnl": "0",
                        "gate3_max_llm_error_ratio": "0",
                    }
                ),
                encoding="utf-8",
            )
            policy = GatePolicyMatrix.from_path(policy_path)

        self.assertEqual(policy.gate0_max_null_rate, Decimal("0"))
        self.assertEqual(policy.gate1_min_net_pnl, Decimal("0"))
        self.assertEqual(policy.gate3_max_llm_error_ratio, Decimal("0"))

    def test_gate_matrix_fails_when_tca_degrades_beyond_thresholds(self) -> None:
        policy = GatePolicyMatrix(
            gate2_max_tca_slippage_bps=Decimal("10"),
            gate2_max_tca_shortfall_notional=Decimal("5"),
            gate2_max_tca_churn_ratio=Decimal("0.20"),
        )
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=3,
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={
                "fold_count": 4,
                "negative_fold_count": 1,
                "net_pnl_cv": "0.3",
            },
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "18",
                "avg_shortfall_notional": "7",
                "avg_churn_ratio": "0.45",
            },
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("tca_slippage_exceeds_maximum", report.reasons)
        self.assertIn("tca_shortfall_exceeds_maximum", report.reasons)
        self.assertIn("tca_churn_ratio_exceeds_maximum", report.reasons)

    def test_gate_matrix_fails_when_profitability_evidence_missing(self) -> None:
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
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("profitability_evidence_missing", report.reasons)

    def test_gate_matrix_fails_when_fragility_stress_without_stability_mode(self) -> None:
        policy = GatePolicyMatrix(
            gate2_max_fragility_score=Decimal("0.9"),
            gate2_max_fragility_state_rank=3,
            gate2_require_stability_mode_under_stress=True,
        )
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
            profitability_evidence=_profitability_evidence_payload(),
            fragility_state="stress",
            fragility_score=Decimal("0.7"),
            stability_mode_active=False,
        )
        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )
        self.assertFalse(report.promotion_allowed)
        self.assertIn("fragility_stability_mode_inactive", report.reasons)

    def test_gate_matrix_fails_when_forecast_health_metrics_degrade(self) -> None:
        policy = GatePolicyMatrix(
            gate3_max_forecast_fallback_rate=Decimal("0.05"),
            gate3_max_forecast_latency_ms_p95=150,
            gate3_min_forecast_calibration_score=Decimal("0.90"),
        )
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
            forecast_metrics={
                "fallback_rate": "0.15",
                "inference_latency_ms_p95": "201",
                "calibration_score_min": "0.75",
            },
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("forecast_fallback_rate_exceeds_threshold", report.reasons)
        self.assertIn("forecast_inference_latency_exceeds_threshold", report.reasons)
        self.assertIn("forecast_calibration_score_below_threshold", report.reasons)

    def test_gate_matrix_degrades_when_uncertainty_threshold_exceeded(self) -> None:
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
            metrics={
                "decision_count": 20,
                "trade_count": 10,
                "net_pnl": "50",
                "max_drawdown": "100",
                "turnover_ratio": "1.5",
                "cost_bps": "5",
            },
            robustness={"fold_count": 4, "negative_fold_count": 0, "net_pnl_cv": "0.2"},
            profitability_evidence=payload,
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertEqual(report.uncertainty_gate_action, "abstain")
        self.assertIn("uncertainty_inputs_missing_or_invalid", report.reasons)


def _profitability_evidence_payload(
    *,
    coverage_error: str = "0.02",
    shift_score: str = "0.20",
    gate_action: str = "pass",
    recalibration_run_id: str | None = None,
    recalibration_artifact_ref: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "profitability-evidence-v4",
        "risk_adjusted_metrics": {
            "market_net_pnl_delta": "0",
            "regime_slice_pass_ratio": "1",
            "return_over_drawdown": "0.5",
        },
        "cost_fill_realism": {"cost_bps": "5"},
        "confidence_calibration": {
            "calibration_error": "0.2",
            "target_coverage": "0.90",
            "observed_coverage": str(Decimal("0.90") - Decimal(coverage_error)),
            "coverage_error": coverage_error,
            "avg_interval_width": "0.75",
            "shift_score": shift_score,
            "gate_action": gate_action,
            "recalibration_run_id": recalibration_run_id,
            "recalibration_artifact_ref": recalibration_artifact_ref,
        },
        "reproducibility": {
            "artifact_hashes": {
                "signals": "a",
                "strategy_config": "b",
                "gate_policy": "c",
                "candidate_report": "d",
                "baseline_report": "e",
            }
        },
        "benchmark": {"schema_version": "profitability-benchmark-v4"},
        "validation": {"passed": True},
    }
