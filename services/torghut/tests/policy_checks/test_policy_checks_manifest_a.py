from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    Path,
    PolicyChecksTestCaseBase,
    _build_profitability_stage_manifest_payload,
    _candidate_state,
    _gate_report,
    _sha256_json,
    datetime,
    evaluate_alpha_readiness_summary,
    evaluate_promotion_prerequisites,
    json,
    tempfile,
    timezone,
)


class TestPolicyChecksManifestA(PolicyChecksTestCaseBase):
    def test_alpha_readiness_summary_skips_disabled_policy_gates(self) -> None:
        reasons, details = evaluate_alpha_readiness_summary(
            policy_payload={
                "promotion_require_alpha_readiness_contract": False,
                "promotion_require_jangar_dependency_quorum": False,
            },
            gate_report_payload={},
            promotion_target="paper",
        )

        self.assertEqual(reasons, [])
        self.assertEqual(details, [])

    def test_promotion_prerequisites_fail_when_patch_missing_for_paper(self) -> None:
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
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "profitability-evidence-validation.json").write_text(
                json.dumps({"passed": True}),
                encoding="utf-8",
            )

            result = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(result.allowed)
        self.assertIn("required_artifacts_missing", result.reasons)
        self.assertIn(
            "paper-candidate/strategy-configmap-patch.yaml", result.missing_artifacts
        )
        self.assertIn("gates/recalibration-report.json", result.missing_artifacts)

    def test_promotion_prerequisites_fail_when_profitability_stage_manifest_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "profitability").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text("{}", encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn(
            "profitability/profitability-stage-manifest-v1.json",
            promotion.missing_artifacts,
        )
        self.assertIn(
            "profitability_stage_manifest_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_profitability_stage_manifest_invalid_json(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "profitability").mkdir(parents=True, exist_ok=True)
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text("{ invalid json }", encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_invalid_json",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_design_doc_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "profitability").mkdir(parents=True, exist_ok=True)
            candidate_spec_path = root / "research" / "candidate-spec.json"
            candidate_spec_path.write_text(
                json.dumps({"candidate_id": "cand-test"}), encoding="utf-8"
            )
            candidate_generation_manifest_path = (
                root / "research" / "candidate-generation-manifest.json"
            )
            candidate_generation_manifest_path.write_text("{}", encoding="utf-8")
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            baseline_report_path = root / "backtest" / "baseline-evaluation-report.json"
            baseline_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            gate_report_path = root / "gates" / "gate-evaluation.json"
            gate_report_path.write_text(json.dumps(_gate_report()), encoding="utf-8")
            profitability_benchmark_path = (
                root / "gates" / "profitability-benchmark-v4.json"
            )
            profitability_benchmark_path.write_text("{}", encoding="utf-8")
            profitability_evidence_path = (
                root / "gates" / "profitability-evidence-v4.json"
            )
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = (
                root / "gates" / "profitability-evidence-validation.json"
            )
            profitability_validation_path.write_text(
                json.dumps({"passed": True}),
                encoding="utf-8",
            )
            janus_event_car_path = root / "gates" / "janus-event-car-v1.json"
            janus_event_car_path.write_text(
                json.dumps({"schema_version": "janus-event-car-v1"}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1"}),
                encoding="utf-8",
            )
            recalibration_report_path = root / "gates" / "recalibration-report.json"
            recalibration_report_path.write_text(
                json.dumps({"status": "pass"}),
                encoding="utf-8",
            )

            manifest_payload = _build_profitability_stage_manifest_payload(
                root=root,
                candidate_spec_path=candidate_spec_path,
                candidate_generation_manifest_path=candidate_generation_manifest_path,
                walkforward_results_path=walkforward_results_path,
                baseline_evaluation_report_path=baseline_report_path,
                evaluation_report_path=evaluation_report_path,
                gate_report_path=gate_report_path,
                profitability_benchmark_path=profitability_benchmark_path,
                profitability_evidence_path=profitability_evidence_path,
                profitability_validation_path=profitability_validation_path,
                janus_event_car_path=janus_event_car_path,
                janus_hgrm_reward_path=janus_hgrm_reward_path,
                recalibration_report_path=recalibration_report_path,
            )
            manifest_payload["run_context"]["design_doc"] = ""
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text(
                json.dumps(manifest_payload),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_design_doc_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_design_doc_invalid(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "profitability").mkdir(parents=True, exist_ok=True)
            candidate_spec_path = root / "research" / "candidate-spec.json"
            candidate_spec_path.write_text("{}", encoding="utf-8")
            candidate_generation_manifest_path = (
                root / "research" / "candidate-generation-manifest.json"
            )
            candidate_generation_manifest_path.write_text("{}", encoding="utf-8")
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}),
                encoding="utf-8",
            )
            baseline_report_path = root / "backtest" / "baseline-evaluation-report.json"
            baseline_report_path.write_text(
                json.dumps({"status": "ok"}),
                encoding="utf-8",
            )
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}),
                encoding="utf-8",
            )
            gate_report_path = root / "gates" / "gate-evaluation.json"
            gate_report_path.write_text(json.dumps(_gate_report()), encoding="utf-8")
            profitability_benchmark_path = (
                root / "gates" / "profitability-benchmark-v4.json"
            )
            profitability_benchmark_path.write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            profitability_evidence_path = (
                root / "gates" / "profitability-evidence-v4.json"
            )
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = (
                root / "gates" / "profitability-evidence-validation.json"
            )
            profitability_validation_path.write_text(
                json.dumps({"passed": True}),
                encoding="utf-8",
            )
            recalibration_report_path = root / "gates" / "recalibration-report.json"
            recalibration_report_path.write_text(
                json.dumps({"status": "pass"}),
                encoding="utf-8",
            )
            janus_event_car_path = root / "gates" / "janus-event-car-v1.json"
            janus_event_car_path.write_text(
                json.dumps({"schema_version": "janus-event-car-v1"}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1"}),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps(
                    {"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}
                ),
                encoding="utf-8",
            )

            manifest_payload = _build_profitability_stage_manifest_payload(
                root=root,
                candidate_spec_path=candidate_spec_path,
                candidate_generation_manifest_path=candidate_generation_manifest_path,
                walkforward_results_path=walkforward_results_path,
                baseline_evaluation_report_path=baseline_report_path,
                evaluation_report_path=evaluation_report_path,
                gate_report_path=gate_report_path,
                profitability_benchmark_path=profitability_benchmark_path,
                profitability_evidence_path=profitability_evidence_path,
                profitability_validation_path=profitability_validation_path,
                janus_event_car_path=janus_event_car_path,
                janus_hgrm_reward_path=janus_hgrm_reward_path,
                recalibration_report_path=recalibration_report_path,
                rollback_readiness_path=rollback_readiness_path,
            )
            manifest_payload["run_context"]["design_doc"] = "not-a-design-doc-reference"
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text(
                json.dumps(manifest_payload),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_design_doc_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_hmm_state_posterior_required_and_missing(
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
            promotion_evidence = gate_report.get("promotion_evidence", {})
            assert isinstance(promotion_evidence, dict)
            promotion_evidence.pop("hmm_state_posterior", None)
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(gate_report),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_hmm_state_posterior": True,
                    "promotion_hmm_required_targets": ["paper", "live"],
                    "promotion_hmm_required_artifacts": [
                        "gates/hmm-state-posterior-v1.json"
                    ],
                    "promotion_require_patch_targets": [],
                    "promotion_require_profitability_stage_manifest": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "gate6_require_profitability_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn(
            "gates/hmm-state-posterior-v1.json",
            promotion.missing_artifacts,
        )
        self.assertIn("hmm_state_posterior_artifact_ref_missing", promotion.reasons)

    def test_promotion_prerequisites_accept_valid_hmm_state_posterior_evidence(
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
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(_gate_report()),
                encoding="utf-8",
            )

            hmm_artifact = root / "gates" / "hmm-state-posterior-v1.json"
            hmm_payload = {
                "schema_version": "hmm-state-posterior-v1",
                "run_id": "run-test",
                "candidate_id": "cand-test",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "samples_total": 5,
                "authoritative_samples": 3,
                "authoritative_sample_ratio": "0.6",
                "transition_shock_samples": 0,
                "stale_or_defensive_samples": 0,
                "regime_counts": {"r2": 5},
                "entropy_band_counts": {"medium": 5},
                "guardrail_reason_counts": {"none": 5},
                "posterior_mass_by_regime": {"r2": "4.2"},
                "top_regime_by_posterior_mass": "r2",
                "source_lineage": {
                    "walkforward_results_artifact_ref": "backtest/walkforward-results.json",
                    "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                    "decision_source": "walkforward_results",
                },
            }
            hmm_payload["artifact_hash"] = _sha256_json(
                {
                    key: value
                    for key, value in hmm_payload.items()
                    if key != "artifact_hash"
                }
            )
            hmm_artifact.write_text(json.dumps(hmm_payload), encoding="utf-8")

            gate_report = _gate_report()
            promotion_evidence = gate_report.get("promotion_evidence", {})
            assert isinstance(promotion_evidence, dict)
            promotion_evidence["hmm_state_posterior"] = {
                "artifact_ref": "gates/hmm-state-posterior-v1.json",
                "schema_version": "hmm-state-posterior-v1",
                "samples_total": 5,
                "authoritative_samples": 3,
                "authoritative_sample_ratio": "0.6",
            }

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_hmm_state_posterior": True,
                    "promotion_hmm_required_targets": ["paper", "live"],
                    "promotion_hmm_required_artifacts": [
                        "gates/hmm-state-posterior-v1.json"
                    ],
                    "promotion_hmm_min_authoritative_sample_ratio": "0.5",
                    "promotion_require_patch_targets": [],
                    "promotion_require_profitability_stage_manifest": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "gate6_require_profitability_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertNotIn("hmm_state_posterior_artifact_ref_missing", promotion.reasons)
        self.assertIn(
            str(root / "gates" / "hmm-state-posterior-v1.json"), promotion.artifact_refs
        )

    def test_promotion_prerequisites_fail_when_hmm_regime_quality_ratio_exceeds_threshold(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}",
                encoding="utf-8",
            )
            gate_report = _gate_report()
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(gate_report),
                encoding="utf-8",
            )

            hmm_artifact = root / "gates" / "hmm-state-posterior-v1.json"
            hmm_payload = {
                "schema_version": "hmm-state-posterior-v1",
                "run_id": "run-test",
                "candidate_id": "cand-test",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "samples_total": 10,
                "authoritative_samples": 6,
                "authoritative_sample_ratio": "0.6",
                "transition_shock_samples": 4,
                "stale_or_defensive_samples": 3,
                "regime_counts": {"r2": 10},
                "entropy_band_counts": {"medium": 10},
                "guardrail_reason_counts": {"none": 7, "transition_shock": 3},
                "posterior_mass_by_regime": {"r2": "6.0", "r1": "4.0"},
                "top_regime_by_posterior_mass": "r2",
                "source_lineage": {
                    "walkforward_results_artifact_ref": "backtest/walkforward-results.json",
                    "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                    "decision_source": "walkforward_results",
                },
            }
            hmm_payload["artifact_hash"] = _sha256_json(
                {
                    key: value
                    for key, value in hmm_payload.items()
                    if key != "artifact_hash"
                }
            )
            hmm_artifact.write_text(json.dumps(hmm_payload), encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_hmm_state_posterior": True,
                    "promotion_hmm_required_targets": ["paper", "live"],
                    "promotion_hmm_required_artifacts": [
                        "gates/hmm-state-posterior-v1.json"
                    ],
                    "promotion_hmm_max_transition_shock_ratio": "0.2",
                    "promotion_hmm_max_stale_or_defensive_ratio": "0.2",
                    "promotion_require_patch_targets": [],
                    "promotion_require_profitability_stage_manifest": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "gate6_require_profitability_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "hmm_state_posterior_transition_shock_ratio_exceeds_threshold",
            promotion.reasons,
        )
        self.assertIn(
            "hmm_state_posterior_stale_or_defensive_ratio_exceeds_threshold",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_expert_router_registry_required_and_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}",
                encoding="utf-8",
            )
            gate_report = _gate_report()
            promotion_evidence = gate_report.get("promotion_evidence", {})
            assert isinstance(promotion_evidence, dict)
            promotion_evidence.pop("expert_router_registry", None)
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(gate_report),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_expert_router_registry": True,
                    "promotion_expert_router_required_targets": ["paper", "live"],
                    "promotion_expert_router_required_artifacts": [
                        "gates/expert-router-registry-v1.json"
                    ],
                    "promotion_require_patch_targets": [],
                    "promotion_require_profitability_stage_manifest": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "gate6_require_profitability_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn(
            "gates/expert-router-registry-v1.json",
            promotion.missing_artifacts,
        )
        self.assertIn(
            "expert_router_registry_artifact_ref_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_accept_valid_expert_router_registry_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}",
                encoding="utf-8",
            )
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(_gate_report()),
                encoding="utf-8",
            )
            expert_router_artifact = root / "gates" / "expert-router-registry-v1.json"
            expert_router_payload = {
                "schema_version": "expert-router-registry-v1",
                "run_id": "run-test",
                "candidate_id": "cand-test",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "router_version": "router-v1",
                "route_count": 5,
                "fallback_count": 0,
                "fallback_rate": "0",
                "max_expert_weight": "0.62",
                "avg_expert_weights": {
                    "trend": "0.62",
                    "reversal": "0.14",
                    "breakout": "0.20",
                    "defensive": "0.04",
                },
                "top_expert_counts": {
                    "trend": 5,
                    "reversal": 0,
                    "breakout": 0,
                    "defensive": 0,
                },
                "concentration": {
                    "dominant_expert": "trend",
                    "dominant_expert_count": 5,
                    "max_expert_weight": "0.62",
                },
                "slo_feedback": {
                    "max_fallback_rate": "0.05",
                    "max_expert_concentration": "0.85",
                    "fallback_rate": "0",
                    "max_observed_expert_weight": "0.62",
                    "fallback_slo_pass": True,
                    "concentration_slo_pass": True,
                    "overall_status": "pass",
                    "reasons": [],
                },
                "source_lineage": {
                    "walkforward_results_artifact_ref": "backtest/walkforward-results.json",
                    "hmm_state_posterior_artifact_ref": "gates/hmm-state-posterior-v1.json",
                    "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                    "strategy_config_artifact_ref": "research/candidate-spec.json",
                },
            }
            expert_router_payload["artifact_hash"] = _sha256_json(
                {
                    key: value
                    for key, value in expert_router_payload.items()
                    if key != "artifact_hash"
                }
            )
            expert_router_artifact.write_text(
                json.dumps(expert_router_payload),
                encoding="utf-8",
            )

            gate_report = _gate_report()
            promotion_evidence = gate_report.get("promotion_evidence", {})
            assert isinstance(promotion_evidence, dict)
            promotion_evidence["expert_router_registry"] = {
                "artifact_ref": "gates/expert-router-registry-v1.json",
                "schema_version": "expert-router-registry-v1",
                "route_count": 5,
                "fallback_rate": "0",
                "max_expert_weight": "0.62",
            }

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_expert_router_registry": True,
                    "promotion_expert_router_required_targets": ["paper", "live"],
                    "promotion_expert_router_required_artifacts": [
                        "gates/expert-router-registry-v1.json"
                    ],
                    "promotion_expert_router_min_route_count": 1,
                    "promotion_expert_router_max_fallback_rate": "0.05",
                    "promotion_expert_router_max_expert_concentration": "0.85",
                    "promotion_require_patch_targets": [],
                    "promotion_require_profitability_stage_manifest": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "gate6_require_profitability_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertNotIn(
            "expert_router_registry_artifact_ref_missing",
            promotion.reasons,
        )
        self.assertIn(
            str(root / "gates" / "expert-router-registry-v1.json"),
            promotion.artifact_refs,
        )

    def test_promotion_prerequisites_fail_when_profitability_stage_manifest_replay_contract_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "profitability").mkdir(parents=True, exist_ok=True)

            candidate_spec_path = root / "research" / "candidate-spec.json"
            candidate_spec_path.write_text("{}", encoding="utf-8")
            candidate_generation_manifest_path = (
                root / "research" / "candidate-generation-manifest.json"
            )
            candidate_generation_manifest_path.write_text("{}", encoding="utf-8")
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}),
                encoding="utf-8",
            )
            baseline_report_path = root / "backtest" / "baseline-evaluation-report.json"
            baseline_report_path.write_text(
                json.dumps({"status": "ok"}),
                encoding="utf-8",
            )
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}),
                encoding="utf-8",
            )
            gate_report_path = root / "gates" / "gate-evaluation.json"
            gate_report_path.write_text(json.dumps(_gate_report()), encoding="utf-8")
            profitability_benchmark_path = (
                root / "gates" / "profitability-benchmark-v4.json"
            )
            profitability_benchmark_path.write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            profitability_evidence_path = (
                root / "gates" / "profitability-evidence-v4.json"
            )
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = (
                root / "gates" / "profitability-evidence-validation.json"
            )
            profitability_validation_path.write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            recalibration_report_path = root / "gates" / "recalibration-report.json"
            recalibration_report_path.write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            janus_event_car_path = root / "gates" / "janus-event-car-v1.json"
            janus_event_car_path.write_text(
                json.dumps(
                    {
                        "schema_version": "janus-event-car-v1",
                        "summary": {"event_count": 1},
                    }
                ),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps(
                    {
                        "schema_version": "janus-hgrm-reward-v1",
                        "summary": {"reward_count": 1},
                    }
                ),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps(
                    {"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}
                ),
                encoding="utf-8",
            )

            manifest_payload = _build_profitability_stage_manifest_payload(
                root=root,
                candidate_spec_path=candidate_spec_path,
                candidate_generation_manifest_path=candidate_generation_manifest_path,
                walkforward_results_path=walkforward_results_path,
                baseline_evaluation_report_path=baseline_report_path,
                evaluation_report_path=evaluation_report_path,
                gate_report_path=gate_report_path,
                profitability_benchmark_path=profitability_benchmark_path,
                profitability_evidence_path=profitability_evidence_path,
                profitability_validation_path=profitability_validation_path,
                janus_event_car_path=janus_event_car_path,
                janus_hgrm_reward_path=janus_hgrm_reward_path,
                recalibration_report_path=recalibration_report_path,
                rollback_readiness_path=rollback_readiness_path,
            )
            manifest_payload.pop("replay_contract", None)
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text(
                json.dumps(manifest_payload),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "promotion_require_profitability_stage_replay_contract": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="shadow",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_replay_contract_missing",
            promotion.reasons,
        )
