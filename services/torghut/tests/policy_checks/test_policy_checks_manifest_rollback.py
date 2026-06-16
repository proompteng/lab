from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    Path,
    PolicyChecksTestCaseBase,
    _build_profitability_stage_manifest_payload,
    _candidate_state,
    _gate_report,
    _sha256_json,
    datetime,
    evaluate_promotion_prerequisites,
    json,
    tempfile,
    timezone,
)


class TestPolicyChecksManifestRollback(PolicyChecksTestCaseBase):
    def test_promotion_prerequisites_fails_when_rollback_readiness_artifact_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            for directory in ("research", "backtest", "gates", "profitability"):
                (root / directory).mkdir(parents=True, exist_ok=True)
            paths = {
                "candidate_spec": root / "research" / "candidate-spec.json",
                "candidate_generation": (
                    root / "research" / "candidate-generation-manifest.json"
                ),
                "evaluation_report": root / "backtest" / "evaluation-report.json",
                "walkforward_results": root / "backtest" / "walkforward-results.json",
                "baseline_report": (
                    root / "backtest" / "baseline-evaluation-report.json"
                ),
                "gate_report": root / "gates" / "gate-evaluation.json",
                "profitability_benchmark": (
                    root / "gates" / "profitability-benchmark-v4.json"
                ),
                "profitability_evidence": (
                    root / "gates" / "profitability-evidence-v4.json"
                ),
                "profitability_validation": (
                    root / "gates" / "profitability-evidence-validation.json"
                ),
                "recalibration_report": root / "gates" / "recalibration-report.json",
                "janus_event_car": root / "gates" / "janus-event-car-v1.json",
                "janus_hgrm_reward": root / "gates" / "janus-hgrm-reward-v1.json",
                "rollback_readiness": root / "gates" / "rollback-readiness.json",
            }
            paths["candidate_spec"].write_text("{}", encoding="utf-8")
            paths["candidate_generation"].write_text("{}", encoding="utf-8")
            paths["evaluation_report"].write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            paths["walkforward_results"].write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            paths["baseline_report"].write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            paths["gate_report"].write_text(
                json.dumps(_gate_report()), encoding="utf-8"
            )
            paths["profitability_benchmark"].write_text(
                json.dumps(
                    {
                        "slices": [
                            {"slice_type": "regime", "slice_key": "regime:neutral"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            paths["profitability_evidence"].write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            paths["profitability_validation"].write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            paths["recalibration_report"].write_text(
                json.dumps({"status": "not_required"}),
                encoding="utf-8",
            )
            paths["janus_event_car"].write_text(
                json.dumps(
                    {
                        "schema_version": "janus-event-car-v1",
                        "summary": {"event_count": 1},
                    }
                ),
                encoding="utf-8",
            )
            paths["janus_hgrm_reward"].write_text(
                json.dumps(
                    {
                        "schema_version": "janus-hgrm-reward-v1",
                        "summary": {"reward_count": 1},
                    }
                ),
                encoding="utf-8",
            )
            paths["rollback_readiness"].write_text(
                json.dumps(
                    {"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}
                ),
                encoding="utf-8",
            )
            manifest_payload = _build_profitability_stage_manifest_payload(
                root=root,
                candidate_spec_path=paths["candidate_spec"],
                candidate_generation_manifest_path=paths["candidate_generation"],
                walkforward_results_path=paths["walkforward_results"],
                baseline_evaluation_report_path=paths["baseline_report"],
                evaluation_report_path=paths["evaluation_report"],
                gate_report_path=paths["gate_report"],
                profitability_benchmark_path=paths["profitability_benchmark"],
                profitability_evidence_path=paths["profitability_evidence"],
                profitability_validation_path=paths["profitability_validation"],
                janus_event_car_path=paths["janus_event_car"],
                janus_hgrm_reward_path=paths["janus_hgrm_reward"],
                recalibration_report_path=paths["recalibration_report"],
                rollback_readiness_path=paths["rollback_readiness"],
                artifact_path_overrides={
                    (
                        "governance",
                        "rollback_readiness_present",
                    ): root / "gates" / "rollback-readiness-missing.json",
                },
            )
            manifest_payload["overall_status"] = "fail"
            manifest_payload["failure_reasons"] = [
                "rollback_readiness_contract_missing"
            ]
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
            "profitability_stage_manifest_artifact_missing",
            promotion.reasons,
        )
