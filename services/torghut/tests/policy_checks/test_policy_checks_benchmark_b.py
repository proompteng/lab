from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    Path,
    PolicyChecksTestCaseBase,
    _build_benchmark_parity_payload,
    _candidate_state,
    _deeplob_bdlob_policy,
    _gate_report,
    _recompute_benchmark_artifact_hash,
    _write_benchmark_parity_payload,
    _write_benchmark_parity_payload_payload,
    _write_deeplob_bdlob_payload,
    _write_foundation_router_parity_payload,
    _write_minimal_policy_artifacts,
    evaluate_promotion_prerequisites,
    json,
    tempfile,
)


class TestPolicyChecksBenchmarkB(PolicyChecksTestCaseBase):
    def test_promotion_prerequisites_fail_when_benchmark_parity_advisory_output_rate_breaches_threshold(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload(
                adverse_regime_degradation=0.0,
                risk_veto_degradation=0.0,
                confidence_calibration_error_degradation=0.0,
            )
            runs = payload.get("benchmark_runs")
            if isinstance(runs, list) and runs:
                run = runs[0]
                if isinstance(run, dict):
                    metrics = run.get("metrics")
                    if isinstance(metrics, dict):
                        metrics["advisory_output_rate"] = 0.1
            _recompute_benchmark_artifact_hash(payload)
            _write_benchmark_parity_payload_payload(root, payload=payload)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_parity_min_advisory_output_rate": 0.95,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "benchmark_parity_advisory_output_rate_below_minimum",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_policy_violation_rate_is_degraded(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload(
                adverse_regime_degradation=0.0,
                risk_veto_degradation=0.0,
                confidence_calibration_error_degradation=0.0,
            )
            runs = payload.get("benchmark_runs")
            if isinstance(runs, list) and runs:
                run = runs[0]
                if isinstance(run, dict):
                    violations = run.get("policy_violations")
                    if isinstance(violations, dict):
                        violations["rate"] = 0.2
                        violations["baseline_rate"] = 0.1
            _recompute_benchmark_artifact_hash(payload)
            _write_benchmark_parity_payload_payload(root, payload=payload)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_parity_max_policy_violation_rate_degradation": 0.05,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "benchmark_parity_policy_violation_rate_degraded",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_family_results_are_incomplete(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            _write_benchmark_parity_payload(
                root,
                adverse_regime_degradation=0.0,
                risk_veto_degradation=0.0,
                confidence_calibration_error_degradation=0.0,
                families=BENCHMARK_PARITY_REQUIRED_FAMILIES[:2],
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("benchmark_parity_family_results_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_benchmark_parity_risk_veto_degradation_threshold_is_exceeded(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            _write_benchmark_parity_payload(
                root,
                risk_veto_degradation=0.02,
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_parity_max_risk_veto_alignment_degradation": 0.01,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "benchmark_parity_risk_veto_degradation_exceeds_threshold",
            promotion.reasons,
        )
        self.assertTrue(
            any(
                item.get("reason")
                == "benchmark_parity_risk_veto_degradation_exceeds_threshold"
                for item in promotion.reason_details
            )
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_confidence_degradation_threshold_is_exceeded(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            _write_benchmark_parity_payload(
                root,
                confidence_calibration_error_degradation=0.02,
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_parity_max_confidence_calibration_error_degradation": 0.01,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "benchmark_parity_confidence_calibration_error_degradation_exceeds_threshold",
            promotion.reasons,
        )
        self.assertTrue(
            any(
                item.get("reason")
                == "benchmark_parity_confidence_calibration_error_degradation_exceeds_threshold"
                for item in promotion.reason_details
            )
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_scorecard_is_incomplete(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload()
            scorecards = payload.get("scorecards")
            if isinstance(scorecards, dict):
                forecast = scorecards.get("forecast_quality")
                if isinstance(forecast, dict):
                    forecast.pop("confidence_calibration_error_baseline", None)
            _recompute_benchmark_artifact_hash(payload)
            _write_benchmark_parity_payload_payload(root, payload=payload)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "benchmark_parity_scorecard_missing_required_fields",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_scorecard_confidence_drift_is_exceeded(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            _write_benchmark_parity_payload(
                root,
                forecast_confidence_calibration_error=0.03,
                forecast_confidence_calibration_error_baseline=0.01,
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_parity_max_scorecard_confidence_calibration_error_drift": 0.01,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "benchmark_parity_scorecard_confidence_calibration_error_drift_exceeds_threshold",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_foundation_router_parity_artifact_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_foundation_router_parity": True,
                    "promotion_foundation_router_parity_required_targets": ["paper"],
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn("foundation_router_parity_artifact_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_foundation_router_parity_contract_is_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            _write_foundation_router_parity_payload(
                root,
                adapters=("deterministic", "chronos"),
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_foundation_router_parity": True,
                    "promotion_foundation_router_parity_required_targets": ["paper"],
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("foundation_router_parity_adapters_invalid", promotion.reasons)
        self.assertIn(
            "foundation_router_parity_contract_required_adapters_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_foundation_router_parity_latency_breaches_threshold(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            _write_foundation_router_parity_payload(
                root,
                latency_p95_ms=450,
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_foundation_router_parity": True,
                    "promotion_foundation_router_parity_required_targets": ["paper"],
                    "promotion_router_parity_max_latency_ms_p95": 200,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "foundation_router_parity_latency_p95_exceeds_threshold",
            promotion.reasons,
        )

    def test_promotion_prerequisites_pass_with_valid_foundation_router_parity_artifact(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            _write_foundation_router_parity_payload(root)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_foundation_router_parity": True,
                    "promotion_foundation_router_parity_required_targets": ["paper"],
                    "promotion_router_parity_max_fallback_rate": 0.05,
                    "promotion_router_parity_min_calibration_score": 0.85,
                    "promotion_router_parity_max_drift": 0.45,
                    "promotion_router_parity_max_latency_ms_p95": 200,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertFalse(
            any(
                reason.startswith("foundation_router_parity_")
                for reason in promotion.reasons
            )
        )

    def test_promotion_prerequisites_fail_when_deeplob_bdlob_contract_artifact_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            gate_report = _gate_report()
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(gate_report),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_deeplob_bdlob_contract": True,
                    "promotion_deeplob_bdlob_required_targets": ["paper"],
                    "promotion_deeplob_bdlob_required_artifacts": [
                        "microstructure/deeplob-bdlob-report-v1.json"
                    ],
                    "promotion_require_foundation_router_parity": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn(
            "deeplob_bdlob_contract_artifact_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_deeplob_bdlob_artifact_ref_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_report = _gate_report()
            promotion_evidence = gate_report["promotion_evidence"]
            assert isinstance(promotion_evidence, dict)
            promotion_evidence["deeplob_bdlob_contract"] = {}
            _write_minimal_policy_artifacts(root, gate_report)
            _write_deeplob_bdlob_payload(root)

            promotion = evaluate_promotion_prerequisites(
                policy_payload=_deeplob_bdlob_policy(),
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "deeplob_bdlob_contract_artifact_ref_missing",
            promotion.reasons,
        )
        self.assertNotIn(
            "deeplob_bdlob_contract_artifact_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_deeplob_bdlob_artifact_ref_is_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_report = _gate_report()
            promotion_evidence = gate_report["promotion_evidence"]
            assert isinstance(promotion_evidence, dict)
            promotion_evidence["deeplob_bdlob_contract"] = {
                "artifact_ref": "s3://bucket/deeplob-bdlob-report-v1.json",
            }
            _write_minimal_policy_artifacts(root, gate_report)

            promotion = evaluate_promotion_prerequisites(
                policy_payload=_deeplob_bdlob_policy(),
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "deeplob_bdlob_contract_artifact_ref_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_deeplob_bdlob_identity_is_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_report = _gate_report()
            _write_minimal_policy_artifacts(root, gate_report)
            artifact_path = _write_deeplob_bdlob_payload(root)
            payload = json.loads(artifact_path.read_text(encoding="utf-8"))
            payload.pop("artifact_hash")
            payload["candidate_id"] = ""
            payload["schema_version"] = "wrong-schema"
            payload["contract"] = {}
            artifact_path.write_text(json.dumps(payload), encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload=_deeplob_bdlob_policy(),
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "deeplob_bdlob_contract_artifact_hash_missing",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_candidate_id_missing",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_schema_version_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_metadata_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_deeplob_bdlob_payload_contract_is_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_report = _gate_report()
            _write_minimal_policy_artifacts(root, gate_report)
            artifact_path = _write_deeplob_bdlob_payload(root)
            payload = json.loads(artifact_path.read_text(encoding="utf-8"))
            contract = payload["contract"]
            assert isinstance(contract, dict)
            contract["schema_version"] = "wrong-contract-schema"
            contract["hash_algorithm"] = "md5"
            payload.pop("feature_quality_summary")
            payload.pop("prediction_quality_summary")
            payload["cost_adjusted_outcomes"] = {}
            payload["execution_impact_summary"] = {
                "deterministic_gate_compatible": False,
            }
            payload["fallback_summary"] = {"slo_pass": False}
            payload["overall_status"] = "fail"
            artifact_path.write_text(json.dumps(payload), encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload=_deeplob_bdlob_policy(),
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "deeplob_bdlob_contract_artifact_hash_mismatch",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_schema_metadata_version_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_hash_algorithm_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_summary_fields_missing",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_overall_status_not_pass",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_feature_quality_pass_rate_missing",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_slippage_divergence_missing",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_deterministic_gate_compatibility_failed",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_fallback_slo_not_pass",
            promotion.reasons,
        )

    def test_promotion_prerequisites_pass_with_valid_deeplob_bdlob_contract(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            gate_report = _gate_report()
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(gate_report),
                encoding="utf-8",
            )
            _write_deeplob_bdlob_payload(root)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_deeplob_bdlob_contract": True,
                    "promotion_deeplob_bdlob_required_targets": ["paper"],
                    "promotion_deeplob_bdlob_min_feature_quality_pass_rate": 0.99,
                    "promotion_deeplob_bdlob_min_prediction_quality_score": 0.85,
                    "promotion_deeplob_bdlob_min_cost_adjusted_edge_bps": 0.0,
                    "promotion_deeplob_bdlob_max_slippage_divergence_bps": 1.0,
                    "promotion_deeplob_bdlob_min_fallback_reliability": 0.99,
                    "promotion_require_foundation_router_parity": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertFalse(
            any(
                reason.startswith("deeplob_bdlob_contract_")
                for reason in promotion.reasons
            )
        )

    def test_promotion_prerequisites_fail_when_deeplob_bdlob_contract_sets_are_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_report = _gate_report()
            _write_minimal_policy_artifacts(root, gate_report)
            _write_deeplob_bdlob_payload(
                root,
                supporting_artifacts=("microstructure/feature-summary.json",),
                required_summary_fields=("feature_quality_summary",),
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload=_deeplob_bdlob_policy(),
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "deeplob_bdlob_contract_required_supporting_artifacts_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_required_summary_fields_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_supporting_artifacts_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_deeplob_bdlob_metrics_breach_thresholds(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_report = _gate_report()
            _write_minimal_policy_artifacts(root, gate_report)
            _write_deeplob_bdlob_payload(
                root,
                feature_quality_pass_rate=0.75,
                prediction_quality_score=0.4,
                cost_adjusted_edge_bps=-0.3,
                slippage_divergence_bps=4.2,
                fallback_reliability=0.8,
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload=_deeplob_bdlob_policy(),
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "deeplob_bdlob_contract_feature_quality_pass_rate_below_threshold",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_prediction_quality_score_below_threshold",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_cost_adjusted_edge_below_threshold",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_slippage_divergence_exceeds_threshold",
            promotion.reasons,
        )
        self.assertIn(
            "deeplob_bdlob_contract_fallback_reliability_below_threshold",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_advisor_fallback_slo_artifact_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            gate_report = _gate_report()
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(gate_report),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_advisor_fallback_slo": True,
                    "promotion_advisor_fallback_required_targets": ["paper"],
                    "promotion_advisor_fallback_required_artifacts": [
                        "execution/advisor-fallback-slo-report-v1.json"
                    ],
                    "promotion_require_deeplob_bdlob_contract": False,
                    "promotion_require_foundation_router_parity": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn("advisor_fallback_slo_artifact_missing", promotion.reasons)
