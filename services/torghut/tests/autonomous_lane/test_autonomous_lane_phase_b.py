from __future__ import annotations

# ruff: noqa: F403,F405
from tests.autonomous_lane.autonomous_lane_support import *


class TestAutonomousLanePhaseB(AutonomousLaneTestCaseBase):
    def test_build_phase_manifest_marks_live_canary_slo_as_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-live-canary-skip"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="live",
                promotion_allowed=True,
                recommended_mode="live",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-127",
                candidate_id="cand-5",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="live",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "live",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=None,
                recommended_mode="live",
                promotion_reasons=[],
                governance_inputs=None,
                drift_promotion_evidence=None,
            )

            canary_phase = manifest["phases"][4]
            self.assertEqual(canary_phase["name"], "paper-canary")
            self.assertEqual(canary_phase["status"], "skipped")
            self.assertEqual(
                canary_phase["slo_gates"][0]["status"],
                "skipped",
            )

    def test_build_phase_manifest_reports_gate_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-fail"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=False,
                recommended_mode="shadow",
                gates=[GateResult(gate_id="gate0_data_integrity", status="fail")],
                reasons=["gate0_data_integrity"],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-124",
                candidate_id="cand-2",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "shadow",
                    "throughput": {
                        "signal_count": 0,
                        "decision_count": 0,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=False,
                    reasons=["missing_artifacts"],
                    required_artifacts=["gates/promotion-evidence-gate.json"],
                    missing_artifacts=["gates/promotion-evidence-gate.json"],
                    reason_details=[{"artifact": "gates/promotion-evidence-gate.json"}],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 0, "decision_count": 0},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": False, "reasons": ["drift_data_missing"]},
                patch_path=None,
                recommended_mode="shadow",
                promotion_reasons=["gate_failed"],
                governance_inputs={},
                drift_promotion_evidence=None,
            )

            self.assertEqual(manifest["status"], "fail")
            self.assertEqual(manifest["phases"][0]["status"], "fail")
            self.assertEqual(manifest["phases"][4]["status"], "fail")

    def test_build_phase_manifest_updates_rollback_proof_when_triggered(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-rollback"
            output_dir.mkdir(parents=True, exist_ok=True)
            rollback_evidence = output_dir / "rollback-evidence.json"
            rollback_evidence.write_text("{}", encoding="utf-8")
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-125",
                candidate_id="cand-3",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "paper",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=output_dir
                / "paper-candidate"
                / "strategy-configmap-patch.yaml",
                recommended_mode="paper",
                promotion_reasons=[],
                governance_inputs={
                    "execution_context": {
                        "repository": "acme/torghut",
                        "base": "main",
                        "head": "paper-path",
                        "artifactPath": str(output_dir),
                        "priorityId": "p1",
                    },
                    "runtime_governance": {
                        "governance_status": "fail",
                        "artifact_refs": ["runtime-check.json"],
                        "drift_status": "drift_detected",
                        "rollback_triggered": True,
                    },
                    "rollback_proof": {
                        "rollback_triggered": True,
                        "rollback_incident_evidence_path": str(rollback_evidence),
                    },
                },
                drift_promotion_evidence=None,
            )

            runtime = manifest["runtime_governance"]
            rollback = manifest["rollback_proof"]
            self.assertEqual(runtime.get("governance_status"), "fail")
            self.assertEqual(manifest["phases"][5]["status"], "fail")
            self.assertEqual(manifest["phases"][6]["status"], "pass")
            self.assertEqual(
                rollback.get("rollback_incident_evidence_path"),
                str(rollback_evidence),
            )
            self.assertIn(str(rollback_evidence), manifest["artifact_refs"])

    def test_build_phase_manifest_requires_rollback_evidence_when_triggered(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-rollback-required"
            output_dir.mkdir(parents=True, exist_ok=True)
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-126",
                candidate_id="cand-4",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "paper",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=None,
                recommended_mode="paper",
                promotion_reasons=[],
                governance_inputs={
                    "execution_context": {
                        "repository": "acme/torghut",
                        "base": "main",
                        "head": "paper-path",
                        "artifactPath": str(output_dir),
                        "priorityId": "p1",
                    },
                    "runtime_governance": {
                        "governance_status": "pass",
                        "artifact_refs": ["runtime-check.json"],
                        "drift_status": "stable",
                        "rollback_triggered": True,
                    },
                    "rollback_proof": {
                        "rollback_triggered": True,
                        "rollback_incident_evidence_path": "",
                    },
                },
                drift_promotion_evidence=None,
            )
            runtime = manifest["runtime_governance"]
            rollback = manifest["rollback_proof"]
            phases_by_name = {
                phase["name"]: phase
                for phase in manifest["phases"]
                if isinstance(phase, dict)
            }
            self.assertEqual(runtime.get("governance_status"), "pass")
            self.assertEqual(phases_by_name["runtime-governance"]["status"], "pass")
            self.assertEqual(phases_by_name["rollback-proof"]["status"], "fail")
            self.assertEqual(rollback.get("rollback_incident_evidence"), "")
            self.assertIn(
                "slo_rollback_evidence_required_when_triggered",
                {
                    item.get("id"): item.get("status")
                    for item in phases_by_name["rollback-proof"]["slo_gates"]
                },
            )

    def test_coerce_phase_status_unknown_status_fails(self) -> None:
        self.assertEqual(coerce_phase_status("blocked"), "fail")
        self.assertEqual(
            coerce_phase_status("blocked", default="skip"),
            "skip",
        )

    def test_run_autonomous_lane_script_forwards_alpha_sidecar_args(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            signals_path = root / "signals.json"
            strategy_config_path = root / "strategy.yaml"
            gate_policy_path = root / "gate-policy.json"
            output_dir = root / "autonomy-out"
            alpha_train_path = root / "alpha-train.csv"
            alpha_test_path = root / "alpha-test.csv"
            alpha_gate_policy_path = root / "alpha-gate-policy.json"

            argv = [
                "run_autonomous_lane.py",
                "--signals",
                str(signals_path),
                "--strategy-config",
                str(strategy_config_path),
                "--gate-policy",
                str(gate_policy_path),
                "--output-dir",
                str(output_dir),
                "--alpha-train-prices",
                str(alpha_train_path),
                "--alpha-test-prices",
                str(alpha_test_path),
                "--alpha-gate-policy",
                str(alpha_gate_policy_path),
            ]

            with (
                patch("sys.argv", argv),
                patch.object(
                    run_autonomous_lane_script,
                    "_resolve_git_sha",
                    return_value="git-sha",
                ),
                patch.object(run_autonomous_lane_script, "print"),
                patch.object(
                    run_autonomous_lane_script,
                    "run_autonomous_lane",
                    return_value=SimpleNamespace(
                        run_id="auto-run",
                        candidate_id="cand-123",
                        output_dir=output_dir,
                        gate_report_path=output_dir / "gates" / "gate-evaluation.json",
                        actuation_intent_path=None,
                        paper_patch_path=None,
                        candidate_spec_path=output_dir
                        / "research"
                        / "candidate-spec.json",
                        candidate_generation_manifest_path=output_dir
                        / "stages"
                        / "candidate-generation.json",
                        evaluation_manifest_path=output_dir
                        / "stages"
                        / "evaluation.json",
                        recommendation_manifest_path=output_dir
                        / "stages"
                        / "recommendation.json",
                        profitability_manifest_path=output_dir
                        / "profitability"
                        / "stage.json",
                        recommendation_artifact_path=output_dir
                        / "gates"
                        / "recommendation.json",
                        benchmark_parity_path=output_dir
                        / "gates"
                        / "benchmark-parity.json",
                        stage_trace_ids={},
                        stage_lineage_root="lineage-root",
                    ),
                ) as run_mock,
            ):
                exit_code = run_autonomous_lane_script.main()

            self.assertEqual(exit_code, 0)
            self.assertEqual(
                run_mock.call_args.kwargs["alpha_train_prices_path"], alpha_train_path
            )
            self.assertEqual(
                run_mock.call_args.kwargs["alpha_test_prices_path"], alpha_test_path
            )
            self.assertEqual(
                run_mock.call_args.kwargs["alpha_gate_policy_path"],
                alpha_gate_policy_path,
            )
