from __future__ import annotations

from tests.autonomy_gates.support import (
    Decimal,
    GateInputs,
    GatePolicyMatrix,
    Path,
    _TestAutonomyGatesBase,
    _healthy_forecast_metrics_payload,
    _healthy_gate_inputs,
    _profitability_evidence_payload,
    evaluate_gate_matrix,
    json,
    tempfile,
)


class TestGateMatrixPassesPaperWithSafeMetrics(_TestAutonomyGatesBase):
    def test_gate_matrix_passes_paper_with_safe_metrics(self) -> None:
        policy = GatePolicyMatrix()
        inputs = _healthy_gate_inputs(symbol_coverage=3)

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertTrue(report.evidence_collection_allowed)
        self.assertEqual(report.recommended_mode, "paper")
        payload = report.to_payload()
        self.assertFalse(payload["capital_promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])
        self.assertEqual(
            payload["promotion_blockers"],
            ["autonomy_gate_not_runtime_ledger_authority"],
        )
        self.assertEqual(report.uncertainty_gate_action, "pass")

    def test_gate_matrix_shadow_target_is_evidence_only_when_clean(self) -> None:
        report = evaluate_gate_matrix(
            _healthy_gate_inputs(),
            policy=GatePolicyMatrix(),
            promotion_target="shadow",
            code_version="test",
        )

        self.assertFalse(report.promotion_allowed)
        self.assertTrue(report.evidence_collection_allowed)
        self.assertEqual(report.recommended_mode, "shadow")
        self.assertEqual(
            report.promotion_blockers,
            ["autonomy_gate_not_runtime_ledger_authority"],
        )

    def test_live_remains_gated_by_default(self) -> None:
        policy = GatePolicyMatrix(gate5_live_enabled=False)
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
            llm_metrics={"error_ratio": "0.00"},
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
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("tca_slippage_exceeds_maximum", report.reasons)
        self.assertIn("tca_shortfall_exceeds_maximum", report.reasons)
        self.assertIn("tca_churn_ratio_exceeds_maximum", report.reasons)

    def test_gate2_tca_reasons_use_absolute_values(self) -> None:
        policy = GatePolicyMatrix(
            gate2_max_tca_slippage_bps=Decimal("5"),
            gate2_max_tca_shortfall_notional=Decimal("1"),
            gate2_max_tca_realized_shortfall_bps=Decimal("0.5"),
            gate2_max_tca_divergence_bps=Decimal("0.2"),
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
            robustness={
                "fold_count": 4,
                "negative_fold_count": 0,
                "net_pnl_cv": "0.2",
            },
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "-8",
                "avg_shortfall_notional": "-2",
                "avg_realized_shortfall_bps": "-1",
                "avg_divergence_bps": "-0.3",
                "expected_shortfall_sample_count": 10,
                "expected_shortfall_coverage": "1.0",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("tca_slippage_exceeds_maximum", report.reasons)
        self.assertIn("tca_shortfall_exceeds_maximum", report.reasons)
        self.assertIn("tca_realized_shortfall_bps_exceeds_maximum", report.reasons)
        self.assertIn("tca_divergence_bps_exceeds_maximum", report.reasons)

    def test_gate_matrix_fails_when_tca_slippage_missing(self) -> None:
        policy = GatePolicyMatrix()
        inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=Decimal("0.00"),
            staleness_ms_p95=0,
            symbol_coverage=3,
            tca_metrics={
                "order_count": 12,
                "avg_shortfall_notional": "7",
                "avg_churn_ratio": "0.45",
            },
            llm_metrics={"error_ratio": "0.00"},
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
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("tca_slippage_missing", report.reasons)

    def test_gate_matrix_fails_when_tca_expected_shortfall_calibration_coverage_is_missing(
        self,
    ) -> None:
        policy = GatePolicyMatrix(
            gate2_min_tca_expected_shortfall_coverage=Decimal("0.50"),
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
            robustness={
                "fold_count": 4,
                "negative_fold_count": 0,
                "net_pnl_cv": "0.2",
            },
            llm_metrics={"error_ratio": "0.00"},
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "8",
                "avg_shortfall_notional": "3",
                "avg_churn_ratio": "0.1",
                "expected_shortfall_sample_count": 0,
                "expected_shortfall_coverage": "0",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn(
            "tca_expected_shortfall_calibration_coverage_missing", report.reasons
        )

    def test_gate_matrix_fails_when_tca_expected_shortfall_calibration_coverage_is_below_threshold(
        self,
    ) -> None:
        policy = GatePolicyMatrix(
            gate2_min_tca_expected_shortfall_coverage=Decimal("0.75"),
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
            llm_metrics={"error_ratio": "0.00"},
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "8",
                "avg_shortfall_notional": "3",
                "avg_churn_ratio": "0.1",
                "avg_divergence_bps": "0",
                "avg_realized_shortfall_bps": "0",
                "expected_shortfall_sample_count": 6,
                "expected_shortfall_coverage": "0.50",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn(
            "tca_expected_shortfall_calibration_coverage_below_threshold",
            report.reasons,
        )

    def test_gate_matrix_treats_invalid_tca_expected_shortfall_sample_count_as_missing(
        self,
    ) -> None:
        policy = GatePolicyMatrix(
            gate2_min_tca_expected_shortfall_coverage=Decimal("0.50"),
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
            robustness={
                "fold_count": 4,
                "negative_fold_count": 0,
                "net_pnl_cv": "0.2",
            },
            llm_metrics={"error_ratio": "0.00"},
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "8",
                "avg_shortfall_notional": "3",
                "avg_churn_ratio": "0.1",
                "expected_shortfall_sample_count": "invalid",
                "expected_shortfall_coverage": "0.6",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn(
            "tca_expected_shortfall_calibration_coverage_missing",
            report.reasons,
        )

    def test_gate_matrix_ignores_tca_expected_shortfall_coverage_missing_when_threshold_zero(
        self,
    ) -> None:
        policy = GatePolicyMatrix(
            gate2_min_tca_expected_shortfall_coverage=Decimal("0"),
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
            robustness={
                "fold_count": 4,
                "negative_fold_count": 0,
                "net_pnl_cv": "0.2",
            },
            llm_metrics={"error_ratio": "0.00"},
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "8",
                "avg_shortfall_notional": "3",
                "avg_churn_ratio": "0.1",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertTrue(report.evidence_collection_allowed)
        self.assertNotIn(
            "tca_expected_shortfall_calibration_coverage_missing",
            report.reasons,
        )

    def test_gate_matrix_fails_when_tca_realized_shortfall_and_divergence_exceed_threshold(
        self,
    ) -> None:
        policy = GatePolicyMatrix(
            gate2_max_tca_realized_shortfall_bps=Decimal("1"),
            gate2_max_tca_divergence_bps=Decimal("0.5"),
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
            robustness={
                "fold_count": 4,
                "negative_fold_count": 0,
                "net_pnl_cv": "0.2",
            },
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "8",
                "avg_shortfall_notional": "2",
                "avg_churn_ratio": "0.1",
                "avg_realized_shortfall_bps": "2",
                "avg_divergence_bps": "1",
                "expected_shortfall_sample_count": 10,
                "expected_shortfall_coverage": "0.83",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("tca_realized_shortfall_bps_exceeds_maximum", report.reasons)
        self.assertIn("tca_divergence_bps_exceeds_maximum", report.reasons)

    def test_gate_matrix_fails_when_tca_calibration_error_is_missing_with_evidence(
        self,
    ) -> None:
        policy = GatePolicyMatrix(
            gate2_max_tca_calibration_error_bps=Decimal("0.5"),
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
            robustness={
                "fold_count": 4,
                "negative_fold_count": 0,
                "net_pnl_cv": "0.2",
            },
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "8",
                "avg_shortfall_notional": "3",
                "avg_churn_ratio": "0.1",
                "avg_realized_shortfall_bps": "0",
                "avg_divergence_bps": "0",
                "expected_shortfall_sample_count": 2,
                "expected_shortfall_coverage": "0.83",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            llm_metrics={"error_ratio": "0.00"},
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("tca_calibration_error_missing", report.reasons)

    def test_gate_matrix_fails_when_tca_calibration_error_exceeds_threshold(
        self,
    ) -> None:
        policy = GatePolicyMatrix(
            gate2_max_tca_calibration_error_bps=Decimal("1"),
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
            robustness={
                "fold_count": 4,
                "negative_fold_count": 0,
                "net_pnl_cv": "0.2",
            },
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "8",
                "avg_shortfall_notional": "3",
                "avg_churn_ratio": "0.1",
                "avg_realized_shortfall_bps": "2",
                "avg_divergence_bps": "0",
                "avg_calibration_error_bps": "1.5",
                "expected_shortfall_sample_count": 10,
                "expected_shortfall_coverage": "0.83",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            llm_metrics={"error_ratio": "0.00"},
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("tca_calibration_error_exceeds_maximum", report.reasons)

    def test_gate_matrix_fails_when_profitability_evidence_missing(self) -> None:
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
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("profitability_evidence_missing", report.reasons)

    def test_gate_matrix_fails_when_janus_evidence_incomplete(self) -> None:
        policy = GatePolicyMatrix(gate6_require_janus_evidence=True)
        payload = _profitability_evidence_payload()
        payload["janus_q"] = {
            "schema_version": "janus-q-evidence-v1",
            "evidence_complete": False,
            "reasons": ["janus_reward_event_mapping_incomplete"],
            "event_car": {
                "schema_version": "janus-event-car-v1",
                "event_count": 0,
            },
            "hgrm_reward": {
                "schema_version": "janus-hgrm-reward-v1",
                "reward_count": 0,
            },
        }
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
        self.assertIn("janus_q_evidence_incomplete", report.reasons)
        self.assertIn("janus_event_car_count_below_threshold", report.reasons)
        self.assertIn("janus_hgrm_reward_count_below_threshold", report.reasons)

    def test_gate_matrix_fails_when_fragility_stress_without_stability_mode(
        self,
    ) -> None:
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
            fragility_state="stress",
            fragility_score=Decimal("0.7"),
            stability_mode_active=False,
        )
        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )
        self.assertFalse(report.promotion_allowed)
        self.assertIn("fragility_stability_mode_inactive", report.reasons)

    def test_gate_matrix_fails_when_fragility_inputs_are_invalid(self) -> None:
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
            tca_metrics={
                "order_count": 12,
                "avg_slippage_bps": "18",
                "avg_shortfall_notional": "7",
                "avg_churn_ratio": "0.45",
            },
            forecast_metrics=_healthy_forecast_metrics_payload(),
            profitability_evidence=_profitability_evidence_payload(),
            fragility_state="elevated",
            fragility_score=Decimal("0.60"),
            stability_mode_active=True,
            fragility_inputs_valid=False,
        )
        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("fragility_inputs_invalid", report.reasons)

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

    def test_gate_matrix_fails_when_forecast_health_metrics_missing(self) -> None:
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
            profitability_evidence=_profitability_evidence_payload(),
        )

        report = evaluate_gate_matrix(
            inputs, policy=policy, promotion_target="paper", code_version="test"
        )

        self.assertFalse(report.promotion_allowed)
        self.assertIn("forecast_fallback_rate_missing", report.reasons)
        self.assertIn("forecast_inference_latency_p95_missing", report.reasons)
        self.assertIn("forecast_calibration_score_missing", report.reasons)
