from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    json,
    tempfile,
    datetime,
    timezone,
    Path,
    _build_profitability_stage_manifest_payload,
    _gate_report,
    _sha256_json,
    _write_janus_artifacts,
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
    PolicyChecksTestCaseBase,
    _candidate_state,
)


class TestPolicyChecksManifestC(PolicyChecksTestCaseBase):
    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_rollback_readiness_fails(
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
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            baseline_report_path = root / "backtest" / "baseline-evaluation-report.json"
            baseline_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            gate_report_path = root / "gates" / "gate-evaluation.json"
            gate_report_path.write_text(json.dumps(_gate_report()), encoding="utf-8")
            recalibration_report_path = root / "gates" / "recalibration-report.json"
            recalibration_report_path.write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
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
                check_status_overrides={
                    ("governance", "rollback_ready"): "fail",
                },
            )
            manifest_payload["overall_status"] = "fail"
            manifest_payload["failure_reasons"] = ["rollout_rehearsal_failed"]
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text(json.dumps(manifest_payload), encoding="utf-8")

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
            "profitability_stage_manifest_required_check_failed",
            promotion.reasons,
        )
        self.assertIn(
            "rollback_ready",
            "\n".join(str(item.get("check", "")) for item in promotion.reason_details),
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_artifact_is_missing(
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
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            baseline_report_path = root / "backtest" / "baseline-evaluation-report.json"
            baseline_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
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
                artifact_path_overrides={
                    ("research", "candidate_spec_present"): root
                    / "research"
                    / "candidate-spec-missing.json",
                },
            )
            manifest_payload["overall_status"] = "pass"
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text(json.dumps(manifest_payload), encoding="utf-8")
            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": True,
                    "gate6_require_janus_evidence": True,
                    "promotion_janus_required_artifacts": [
                        "gates/janus-event-car-v1.json",
                        "gates/janus-hgrm-reward-v1.json",
                    ],
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_artifact_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_check_status_invalid(
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
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            baseline_report_path = root / "backtest" / "baseline-evaluation-report.json"
            baseline_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
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
                check_status_overrides={
                    ("validation", "evaluation_report_present"): "unknown",
                },
            )
            manifest_payload["overall_status"] = "fail"
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text(json.dumps(manifest_payload), encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": True,
                    "gate6_require_janus_evidence": True,
                    "promotion_janus_required_artifacts": [
                        "gates/janus-event-car-v1.json",
                        "gates/janus-hgrm-reward-v1.json",
                    ],
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_stage_check_status_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_artifact_hash_mismatch(
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
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            baseline_report_path = root / "backtest" / "baseline-evaluation-report.json"
            baseline_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
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
            manifest_payload["stages"]["research"]["artifacts"]["candidate_spec"] = {
                "path": "research/candidate-spec.json",
                "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
                "stage": "research",
                "check": "candidate_spec_present",
            }
            manifest_payload["overall_status"] = "pass"
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            ).write_text(json.dumps(manifest_payload), encoding="utf-8")
            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "promotion_require_janus_evidence": True,
                    "gate6_require_janus_evidence": True,
                    "promotion_janus_required_artifacts": [
                        "gates/janus-event-car-v1.json",
                        "gates/janus-hgrm-reward-v1.json",
                    ],
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_artifact_hash_mismatch",
            promotion.reasons,
        )

    def test_rollback_readiness_fails_when_dry_run_stale(self) -> None:
        state = _candidate_state()
        state["rollbackReadiness"] = {
            "killSwitchDryRunPassed": True,
            "gitopsRevertDryRunPassed": True,
            "strategyDisableDryRunPassed": True,
            "dryRunCompletedAt": "2025-01-01T00:00:00+00:00",
            "humanApproved": True,
            "rollbackTarget": "main@deadbeef",
        }
        result = evaluate_rollback_readiness(
            policy_payload={"rollback_dry_run_max_age_hours": 1},
            candidate_state_payload=state,
            now=datetime(2026, 2, 1, tzinfo=timezone.utc),
        )
        self.assertFalse(result.ready)
        self.assertIn("rollback_dry_run_stale", result.reasons)

    def test_rollback_readiness_fails_when_readiness_checks_are_missing(self) -> None:
        result = evaluate_rollback_readiness(
            policy_payload={},
            candidate_state_payload={},
            now=datetime(2026, 2, 1, tzinfo=timezone.utc),
        )

        self.assertFalse(result.ready)
        self.assertIn("rollback_checks_missing_or_failed", result.reasons)
        self.assertIn("rollback_dry_run_timestamp_missing", result.reasons)

    def test_rollback_readiness_fails_when_required_checks_fail(self) -> None:
        state = _candidate_state()
        state["rollbackReadiness"] = {
            "killSwitchDryRunPassed": False,
            "gitopsRevertDryRunPassed": True,
            "strategyDisableDryRunPassed": True,
            "dryRunCompletedAt": datetime(2026, 2, 1, tzinfo=timezone.utc).isoformat(),
            "humanApproved": True,
            "rollbackTarget": "main@deadbeef",
        }
        result = evaluate_rollback_readiness(
            policy_payload={},
            candidate_state_payload=state,
            now=datetime(2026, 2, 1, tzinfo=timezone.utc),
        )

        self.assertFalse(result.ready)
        self.assertIn("rollback_checks_missing_or_failed", result.reasons)
        self.assertIn("killSwitchDryRunPassed", result.missing_checks)

    def test_rollback_readiness_fails_without_human_approval(self) -> None:
        state = _candidate_state()
        state["rollbackReadiness"] = {
            "killSwitchDryRunPassed": True,
            "gitopsRevertDryRunPassed": True,
            "strategyDisableDryRunPassed": True,
            "dryRunCompletedAt": datetime(2026, 2, 1, tzinfo=timezone.utc).isoformat(),
            "humanApproved": False,
            "rollbackTarget": "main@deadbeef",
        }
        result = evaluate_rollback_readiness(
            policy_payload={},
            candidate_state_payload=state,
            now=datetime(2026, 2, 1, tzinfo=timezone.utc),
        )

        self.assertFalse(result.ready)
        self.assertIn("rollback_human_approval_missing", result.reasons)

    def test_promotion_prerequisites_fail_when_janus_artifacts_missing(self) -> None:
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
                json.dumps({"schema_version": "profitability-evidence-v4"}),
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
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("janus_event_car_artifact_missing", promotion.reasons)
        self.assertIn("janus_hgrm_reward_artifact_missing", promotion.reasons)

    def test_promotion_prerequisites_fail_when_janus_artifacts_schema_invalid(
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
            (root / "gates" / "janus-event-car-v1.json").write_text(
                json.dumps({"schema_version": "not-event-car", "summary": {}}),
                encoding="utf-8",
            )
            (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
                json.dumps({"schema_version": "not-hgrm-reward", "summary": {}}),
                encoding="utf-8",
            )

            promotion = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("janus_event_car_schema_invalid", promotion.reasons)
        self.assertIn("janus_hgrm_reward_schema_invalid", promotion.reasons)

    def test_promotion_prerequisites_requires_janus_even_when_profitability_disabled(
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
            gate_report = _gate_report()
            promotion_evidence = gate_report.get("promotion_evidence", {})
            if isinstance(promotion_evidence, dict):
                promotion_evidence.pop("janus_q", None)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": True,
                    "promotion_require_janus_evidence": True,
                    "promotion_janus_required_artifacts": [
                        "gates/janus-event-car-v1.json",
                        "gates/janus-hgrm-reward-v1.json",
                    ],
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertTrue(any("janus" in reason for reason in promotion.reasons))
        self.assertIn("required_artifacts_missing", promotion.reasons)
        self.assertIn("janus_event_car_artifact_missing", promotion.reasons)
        self.assertIn("janus_hgrm_reward_artifact_missing", promotion.reasons)

    def test_promotion_prerequisites_skips_janus_when_not_required(
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
            gate_report = _gate_report()
            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": True,
                    "promotion_require_janus_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertFalse(any("janus" in reason for reason in promotion.reasons))

    def test_allows_progression_when_artifacts_and_rollback_are_ready(self) -> None:
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
                json.dumps({"schema_version": "profitability-evidence-v4"}),
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
                policy_payload={},
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )
            rollback = evaluate_rollback_readiness(
                policy_payload={},
                candidate_state_payload=_candidate_state(),
                now=datetime.now(timezone.utc),
            )

        self.assertTrue(promotion.allowed)
        self.assertTrue(rollback.ready)
        self.assertEqual(promotion.observed_throughput["decision_count"], 12)
        self.assertEqual(promotion.observed_throughput["trade_count"], 7)

    def test_promotion_prerequisites_fail_when_profitability_validation_fails(
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
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            validation_path = root / "gates" / "profitability-evidence-validation.json"
            validation_path.write_text(
                json.dumps(
                    {
                        "passed": False,
                        "reasons": ["market_net_pnl_delta_below_threshold"],
                    }
                ),
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
                policy_payload={},
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn("profitability_evidence_validation_failed", promotion.reasons)
        self.assertTrue(
            any(
                item.get("artifact_ref") == str(validation_path)
                for item in promotion.reason_details
            )
        )
