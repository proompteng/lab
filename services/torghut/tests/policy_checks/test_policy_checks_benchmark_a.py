from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    Path,
    PolicyChecksTestCaseBase,
    _build_benchmark_parity_payload,
    _candidate_state,
    _gate_report,
    _recompute_benchmark_artifact_hash,
    _write_benchmark_parity_payload,
    _write_benchmark_parity_payload_payload,
    _write_contamination_registry_artifact,
    _write_janus_artifacts,
    _write_stress_artifacts,
    datetime,
    evaluate_promotion_prerequisites,
    json,
    tempfile,
    timezone,
)


class TestPolicyChecksBenchmarkA(PolicyChecksTestCaseBase):
    def test_promotion_prerequisites_allow_when_stress_evidence_max_age_is_invalid(
        self,
    ) -> None:
        now = datetime(2026, 2, 25, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            _write_janus_artifacts(root)
            _write_stress_artifacts(root, generated_at=now.isoformat())
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_stress_evidence": True,
                    "promotion_require_patch_targets": [],
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_stress_max_age_hours": 24,
                    "promotion_evidence_max_age_seconds": "3600s",
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
                now=now,
            )

        self.assertTrue(promotion.allowed)
        self.assertNotIn("stress_metrics_evidence_stale", promotion.reasons)
        self.assertNotIn("stress_metrics_artifact_ref_invalid", promotion.reasons)

    def test_promotion_prerequisites_fail_when_stress_evidence_ref_is_untrusted(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            outside = root.parent / "torghut-untrusted-stress-metrics.json"
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            _write_janus_artifacts(root)
            _write_stress_artifacts(root)
            outside.parent.mkdir(parents=True, exist_ok=True)
            outside.write_text(
                json.dumps(
                    {
                        "schema_version": "stress-metrics-v1",
                        "count": 4,
                        "items": [
                            {"case": "spread"},
                            {"case": "volatility"},
                            {"case": "liquidity"},
                            {"case": "halt"},
                        ],
                        "generated_at": datetime(
                            2025, 1, 1, tzinfo=timezone.utc
                        ).isoformat(),
                    },
                ),
                encoding="utf-8",
            )
            gate_report = _gate_report()
            promotion_evidence = gate_report.get("promotion_evidence", {})
            if isinstance(promotion_evidence, dict):
                stress = promotion_evidence.get("stress_metrics")
                if isinstance(stress, dict):
                    stress["artifact_ref"] = str(outside)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_stress_evidence": True,
                    "promotion_require_patch_targets": [],
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("stress_metrics_evidence_ref_not_trusted", promotion.reasons)

    def test_promotion_prerequisites_fail_when_contamination_registry_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            _write_janus_artifacts(root)
            _write_stress_artifacts(root)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": ["paper"],
                    "promotion_require_contamination_registry": True,
                    "promotion_contamination_required_targets": ["paper"],
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn("contamination_registry_artifact_invalid_json", promotion.reasons)

    def test_promotion_prerequisites_fail_when_contamination_registry_detects_leakage(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            _write_janus_artifacts(root)
            _write_stress_artifacts(root)
            _write_contamination_registry_artifact(
                root,
                status="fail",
                leakage_detected=True,
                leakage_rate=0.05,
                check_status_overrides={"leakage_absent": "fail"},
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": ["paper"],
                    "promotion_require_contamination_registry": True,
                    "promotion_contamination_required_targets": ["paper"],
                    "promotion_contamination_max_leakage_rate": "0.0",
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_profitability_stage_manifest": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("contamination_registry_status_not_pass", promotion.reasons)
        self.assertIn("contamination_registry_leakage_detected", promotion.reasons)
        self.assertIn(
            "contamination_registry_leakage_rate_exceeds_threshold",
            promotion.reasons,
        )
        self.assertIn(
            "contamination_registry_required_check_failed",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_artifact_is_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)

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
        self.assertIn("benchmark_parity_artifact_missing", promotion.reasons)
        self.assertIn("required_artifacts_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_benchmark_parity_artifact_is_invalid_json(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks" / "benchmark-parity-report-v1.json").write_text(
                "{ invalid json }", encoding="utf-8"
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
        self.assertIn("benchmark_parity_artifact_invalid_json", promotion.reasons)

    def test_promotion_prerequisites_use_custom_benchmark_parity_artifact(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            artifact_name = "artifacts/benchmark-parity-report-v1.json"
            custom_path = root / artifact_name
            custom_path.parent.mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload(
                adverse_regime_degradation=0.0,
                risk_veto_degradation=0.0,
                confidence_calibration_error_degradation=0.0,
            )
            _write_benchmark_parity_payload_payload(
                root,
                payload=payload,
                path=custom_path,
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_required_artifacts": [artifact_name],
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

        self.assertTrue(promotion.allowed)
        self.assertNotIn("benchmark_parity_artifact_missing", promotion.reasons)
        self.assertNotIn("benchmark_parity_artifact_invalid_json", promotion.reasons)
        self.assertIn(
            "artifacts/benchmark-parity-report-v1.json",
            promotion.required_artifacts,
        )

    def test_promotion_prerequisites_allow_legacy_required_benchmark_parity_artifact(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            _write_benchmark_parity_payload(root)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_required_artifacts": [
                        "benchmarks/benchmark-parity-report-v1.json"
                    ],
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

        self.assertTrue(promotion.allowed)
        self.assertNotIn("benchmark_parity_artifact_missing", promotion.reasons)
        self.assertNotIn("required_artifacts_missing", promotion.reasons)
        self.assertIn(
            "benchmarks/benchmark-parity-report-v1.json",
            promotion.required_artifacts,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_degradation_threshold_is_exceeded(
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
                adverse_regime_degradation=0.02,
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_benchmark_parity": True,
                    "promotion_benchmark_parity_required_targets": ["paper"],
                    "promotion_benchmark_parity_max_adverse_regime_decision_quality_degradation": 0.01,
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
            "benchmark_parity_adverse_regime_degradation_exceeds_threshold",
            promotion.reasons,
        )
        self.assertTrue(
            any(
                item.get("reason")
                == "benchmark_parity_adverse_regime_degradation_exceeds_threshold"
                for item in promotion.reason_details
            )
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_schema_version_is_invalid(
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
                schema_version="benchmark-parity-report-bad",
            )
            (root / "benchmarks" / "benchmark-parity-report-v1.json").write_text(
                json.dumps(payload, sort_keys=True), encoding="utf-8"
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
        self.assertIn("benchmark_parity_schema_version_invalid", promotion.reasons)

    def test_promotion_prerequisites_fail_when_benchmark_parity_identity_is_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload()
            payload["candidate_id"] = ""
            payload["baseline_candidate_id"] = ""
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
        self.assertIn("benchmark_parity_candidate_id_missing", promotion.reasons)
        self.assertIn(
            "benchmark_parity_baseline_candidate_id_missing", promotion.reasons
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_contract_is_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload()
            payload.pop("contract", None)
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
        self.assertIn("benchmark_parity_contract_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_benchmark_parity_contract_metadata_is_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload()
            contract = payload.get("contract")
            if isinstance(contract, dict):
                contract["schema_version"] = "benchmark-parity-contract-v0"
                contract["hash_algorithm"] = "md5"
                contract["required_families"] = ["baseline_regime"]
                contract["required_scorecards"] = ["decision_quality"]
                contract["required_run_fields"] = ["family"]
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
            "benchmark_parity_contract_schema_version_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "benchmark_parity_contract_hash_algorithm_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "benchmark_parity_contract_required_families_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "benchmark_parity_contract_required_scorecards_invalid",
            promotion.reasons,
        )
        self.assertIn(
            "benchmark_parity_contract_required_run_fields_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_contract_scorecard_fields_are_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload()
            contract = payload.get("contract")
            if isinstance(contract, dict):
                contract["required_scorecard_fields"] = {"forecast_quality": ["status"]}
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
            "benchmark_parity_contract_required_scorecard_fields_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_run_schema_is_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload()
            benchmark_runs = payload.get("benchmark_runs")
            if isinstance(benchmark_runs, list) and benchmark_runs:
                if isinstance(benchmark_runs[0], dict):
                    benchmark_runs[0]["schema_version"] = "benchmark-run-v0"
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
            "benchmark_parity_run_schema_version_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_benchmark_parity_artifact_hash_is_missing(
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
            payload["artifact_hash"] = ""
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
        self.assertIn("benchmark_parity_artifact_hash_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_benchmark_parity_artifact_hash_is_invalid(
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
            _recompute_benchmark_artifact_hash(payload)
            payload["artifact_hash"] = (
                "0000000000000000000000000000000000000000000000000000000000000000"
            )
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
        self.assertIn("benchmark_parity_artifact_hash_mismatch", promotion.reasons)

    def test_promotion_prerequisites_fail_when_benchmark_parity_run_is_missing_required_fields(
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
                    run.pop("run_hash", None)
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
        self.assertIn("benchmark_parity_run_missing_required_fields", promotion.reasons)

    def test_promotion_prerequisites_fail_when_benchmark_parity_runs_are_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "benchmarks").mkdir(parents=True, exist_ok=True)
            payload = _build_benchmark_parity_payload()
            payload["benchmark_runs"] = []
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
        self.assertIn("benchmark_parity_runs_missing", promotion.reasons)
