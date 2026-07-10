from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    Path,
    PolicyChecksTestCaseBase,
    _candidate_state,
    _gate_report,
    _write_janus_artifacts,
    _write_stress_artifacts,
    datetime,
    evaluate_promotion_prerequisites,
    json,
    os,
    patch,
    tempfile,
    timedelta,
    timezone,
)


class TestPolicyChecksRuntimeEvidence(PolicyChecksTestCaseBase):
    def test_shadow_target_does_not_require_profitability_artifacts(self) -> None:
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
                policy_payload={},
                gate_report_payload={
                    "run_id": "run-test",
                    "promotion_allowed": True,
                    "recommended_mode": "shadow",
                    "gates": [
                        {"gate_id": "gate0_data_integrity", "status": "pass"},
                        {"gate_id": "gate1_statistical_robustness", "status": "pass"},
                        {"gate_id": "gate2_risk_capacity", "status": "pass"},
                    ],
                },
                candidate_state_payload=_candidate_state(),
                promotion_target="shadow",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertNotIn("required_artifacts_missing", promotion.reasons)
        self.assertNotIn(
            "gates/profitability-evidence-v4.json",
            promotion.required_artifacts,
        )

    def test_profitability_requirements_can_be_disabled_for_paper(self) -> None:
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

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertNotIn(
            "profitability_evidence_validation_missing",
            promotion.reasons,
        )
        self.assertNotIn(
            "gates/profitability-evidence-v4.json",
            promotion.required_artifacts,
        )

    def test_promotion_prerequisites_fail_when_no_signal_window_detected(self) -> None:
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

            promotion = evaluate_promotion_prerequisites(
                policy_payload={"gate6_require_profitability_evidence": False},
                gate_report_payload=_gate_report(),
                candidate_state_payload={
                    **_candidate_state(),
                    "datasetSnapshotRef": "no_signal_window",
                    "noSignalReason": "cursor_ahead_of_stream",
                },
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("no_signal_window_detected", promotion.reasons)

    def test_promotion_prerequisites_fail_when_no_signal_window_from_throughput(
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

            promotion = evaluate_promotion_prerequisites(
                policy_payload={"gate6_require_profitability_evidence": False},
                gate_report_payload={
                    **_gate_report(),
                    "throughput": {
                        "signal_count": 0,
                        "decision_count": 0,
                        "trade_count": 0,
                        "no_signal_window": True,
                        "no_signal_reason": "cursor_ahead_of_stream",
                    },
                },
                candidate_state_payload={
                    **_candidate_state(),
                    "datasetSnapshotRef": "signals_window",
                    "noSignalReason": None,
                },
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("no_signal_window_detected", promotion.reasons)

    def test_promotion_prerequisites_fail_when_throughput_below_minimums(self) -> None:
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

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_min_signal_count": 5,
                    "promotion_min_decision_count": 5,
                    "promotion_min_trade_count": 3,
                    "gate6_require_profitability_evidence": False,
                },
                gate_report_payload={
                    **_gate_report(),
                    "throughput": {
                        "signal_count": 2,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("signal_count_below_minimum_for_progression", promotion.reasons)
        self.assertIn(
            "decision_count_below_minimum_for_progression",
            promotion.reasons,
        )
        self.assertIn("trade_count_below_minimum_for_progression", promotion.reasons)

    def test_promotion_prerequisites_fail_when_gate_report_run_id_mismatch(
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
            (root / "gates" / "gate-evaluation.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap",
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={"gate6_require_profitability_evidence": False},
                gate_report_payload={**_gate_report(), "run_id": "run-gate-2"},
                candidate_state_payload={**_candidate_state(), "runId": "run-state-1"},
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "run_id_mismatch_between_state_and_gate_report",
            promotion.reasons,
        )
        self.assertTrue(
            any(
                detail.get("reason") == "run_id_mismatch_between_state_and_gate_report"
                and detail.get("candidate_run_id") == "run-state-1"
                and detail.get("gate_report_run_id") == "run-gate-2"
                for detail in promotion.reason_details
            )
        )

    def test_promotion_prerequisites_fail_when_uncertainty_slo_fails(self) -> None:
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "queued", "recalibration_run_id": "recal-1"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={"promotion_uncertainty_max_coverage_error": "0.03"},
                gate_report_payload={
                    **_gate_report(),
                    "uncertainty_gate_action": "degrade",
                    "coverage_error": "0.05",
                    "recalibration_run_id": "recal-1",
                },
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("uncertainty_gate_not_pass", promotion.reasons)
        self.assertIn("uncertainty_calibration_slo_failed", promotion.reasons)

    def test_promotion_prerequisites_fail_when_uncertainty_coverage_non_finite(
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={"promotion_uncertainty_max_coverage_error": "0.03"},
                gate_report_payload={
                    **_gate_report(),
                    "uncertainty_gate_action": "pass",
                    "coverage_error": "NaN",
                },
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("uncertainty_calibration_slo_failed", promotion.reasons)

    def test_promotion_prerequisites_fail_when_uncertainty_thresholds_mismatch(
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_uncertainty_max_coverage_error": "0.03",
                    "gate7_max_coverage_error_pass": "0.05",
                },
                gate_report_payload={
                    **_gate_report(),
                    "uncertainty_gate_action": "pass",
                    "coverage_error": "0.02",
                },
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("uncertainty_policy_threshold_mismatch", promotion.reasons)

    def test_promotion_prerequisites_fail_when_fold_evidence_missing(self) -> None:
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            gate_report = _gate_report()
            evidence = gate_report.get("promotion_evidence", {})
            if isinstance(evidence, dict):
                evidence["fold_metrics"] = {"count": 0, "items": []}

            promotion = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("fold_metrics_evidence_insufficient", promotion.reasons)

    def test_promotion_prerequisites_fail_when_stress_artifact_reference_missing(
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            gate_report = _gate_report()
            evidence = gate_report.get("promotion_evidence", {})
            if isinstance(evidence, dict):
                stress_metrics = evidence.get("stress_metrics")
                if isinstance(stress_metrics, dict):
                    stress_metrics["artifact_ref"] = (
                        "gates/missing-stress-evidence.json"
                    )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_stress_evidence": True,
                    "promotion_require_patch_targets": [],
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_stress_max_age_hours": 1,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("stress_metrics_evidence_artifact_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_stress_artifact_reference_untrusted(
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            gate_report = _gate_report()
            evidence = gate_report.get("promotion_evidence", {})
            if isinstance(evidence, dict):
                stress_metrics = evidence.get("stress_metrics")
                if isinstance(stress_metrics, dict):
                    stress_metrics["artifact_ref"] = "s3://bucket/stress-metrics.json"

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
        self.assertIn("stress_metrics_artifact_ref_untrusted", promotion.reasons)

    def test_promotion_prerequisites_fail_when_stress_evidence_generated_at_is_missing(
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            gate_report = _gate_report()
            stress_path = root / "backtest" / "stale-evaluation-report.json"
            stress_path.write_text("{}", encoding="utf-8")
            evidence = gate_report.get("promotion_evidence", {})
            if isinstance(evidence, dict):
                stress_metrics = evidence.get("stress_metrics")
                if isinstance(stress_metrics, dict):
                    stress_metrics["artifact_ref"] = (
                        "backtest/stale-evaluation-report.json"
                    )
            stale_now = datetime(2026, 2, 25, 12, 0, 0, tzinfo=timezone.utc)
            stale_epoch = (stale_now - timedelta(hours=5)).timestamp()
            os.utime(stress_path, (stale_epoch, stale_epoch))

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_stress_evidence": True,
                    "promotion_require_patch_targets": [],
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_stress_max_age_hours": 1,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
                now=stale_now,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("stress_metrics_evidence_generated_at_missing", promotion.reasons)

    def test_promotion_prerequisites_allow_file_uri_stress_artifact_reference(
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
            _write_janus_artifacts(root)
            _write_stress_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            gate_report = _gate_report()
            evidence = gate_report.get("promotion_evidence", {})
            if isinstance(evidence, dict):
                stress_metrics = evidence.get("stress_metrics")
                if isinstance(stress_metrics, dict):
                    stress_metrics["artifact_ref"] = (
                        f"file://{(root / 'gates/stress-metrics-v1.json').as_posix()}"
                    )

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

        self.assertNotIn("stress_metrics_artifact_ref_untrusted", promotion.reasons)
        self.assertNotIn("stress_metrics_evidence_ref_not_trusted", promotion.reasons)
        self.assertNotIn("stress_metrics_artifact_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_rationale_missing(self) -> None:
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            (root / "gates" / "recalibration-report.json").write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            _write_janus_artifacts(root)
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )
            gate_report = _gate_report()
            evidence = gate_report.get("promotion_evidence", {})
            if isinstance(evidence, dict):
                evidence["promotion_rationale"] = {}

            promotion = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("promotion_rationale_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_stress_evidence_artifact_is_missing(
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
            _write_janus_artifacts(root)
            (root / "gates" / "janus-event-car-v1.json").write_text(
                json.dumps(
                    {
                        "schema_version": "janus-event-car-v1",
                        "summary": {"event_count": 3},
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
                json.dumps(
                    {
                        "schema_version": "janus-hgrm-reward-v1",
                        "summary": {"reward_count": 3},
                    }
                ),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_stress_evidence": True,
                    "promotion_require_patch_targets": [],
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
        self.assertIn("stress_metrics_evidence_artifact_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_stress_evidence_reported_timestamp_is_stale(
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
            _write_janus_artifacts(root)
            _write_stress_artifacts(
                root,
                generated_at="2025-01-01T00:00:00+00:00",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_stress_evidence": True,
                    "promotion_require_patch_targets": [],
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_stress_max_age_hours": 1,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
                now=datetime(2025, 1, 2, tzinfo=timezone.utc),
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("stress_metrics_evidence_stale", promotion.reasons)

    def test_promotion_prerequisites_fail_when_stress_evidence_mtime_is_unavailable(
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

            with patch(
                "app.trading.autonomy.policy_check.evidence_artifacts.os.path.getmtime",
                side_effect=OSError("metadata unavailable"),
            ):
                promotion = evaluate_promotion_prerequisites(
                    policy_payload={
                        "promotion_require_stress_evidence": True,
                        "promotion_require_patch_targets": [],
                        "gate6_require_profitability_evidence": False,
                        "gate6_require_janus_evidence": False,
                        "promotion_stress_max_age_hours": 24,
                        "promotion_evidence_max_age_seconds": 3600,
                    },
                    gate_report_payload=_gate_report(),
                    candidate_state_payload=_candidate_state(),
                    promotion_target="paper",
                    artifact_root=root,
                    now=now,
                )

        self.assertFalse(promotion.allowed)
        self.assertIn("stress_metrics_artifact_ref_invalid", promotion.reasons)
