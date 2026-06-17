from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    Path,
    PolicyChecksTestCaseBase,
    _build_profitability_stage_manifest_payload,
    _candidate_state,
    _gate_report,
    _sha256_json,
    _sha256_path,
    datetime,
    evaluate_promotion_prerequisites,
    json,
    tempfile,
    timezone,
)


class TestPolicyChecksManifestB(PolicyChecksTestCaseBase):
    def test_promotion_prerequisites_fail_when_profitability_stage_manifest_replay_hash_mismatch(
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
            replay_contract = manifest_payload.get("replay_contract")
            if not isinstance(replay_contract, dict):
                raise AssertionError("expected replay_contract in manifest payload")
            replay_hashes = replay_contract.get("artifact_hashes")
            if not isinstance(replay_hashes, dict):
                raise AssertionError(
                    "expected replay_contract.artifact_hashes in manifest payload"
                )
            replay_hashes["research/candidate-spec.json"] = "0" * 64
            replay_contract["contract_hash"] = _sha256_json(
                {"artifact_hashes": replay_hashes}
            )
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
            "profitability_stage_manifest_replay_artifact_hash_mismatch",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fail_when_profitability_stage_manifest_artifact_hash_mismatch(
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
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(_gate_report()), encoding="utf-8"
            )
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
            (root / "gates" / "janus-event-car-v1.json").write_text(
                json.dumps(
                    {
                        "schema_version": "janus-event-car-v1",
                        "summary": {"event_count": 2},
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
                json.dumps(
                    {
                        "schema_version": "janus-hgrm-reward-v1",
                        "summary": {"reward_count": 2},
                    }
                ),
                encoding="utf-8",
            )
            manifest_path = (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            )
            manifest_payload = {
                "schema_version": "profitability-stage-manifest-v1",
                "candidate_id": "cand-test",
                "strategy_family": "deterministic",
                "llm_artifact_ref": None,
                "router_artifact_ref": "strategy-config",
                "run_context": {
                    "repository": "proompteng/lab",
                    "base": "main",
                    "head": "agentruns/main",
                    "artifact_path": str(root),
                    "run_id": "run-test",
                },
                "stages": {
                    "research": {
                        "status": "pass",
                        "checks": [
                            {"check": "candidate_spec_present", "status": "pass"}
                        ],
                        "artifacts": {
                            "candidate_spec": {
                                "path": "research/candidate-spec.json",
                                "sha256": "deadbeef",
                                "stage": "research",
                                "check": "candidate_spec_present",
                            }
                        },
                        "owner": "research-orchestrator",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                    "validation": {
                        "status": "pass",
                        "checks": [
                            {"check": "evaluation_report_present", "status": "pass"}
                        ],
                        "artifacts": {
                            "evaluation_report": {
                                "path": "backtest/evaluation-report.json",
                                "sha256": _sha256_path(
                                    root / "backtest" / "evaluation-report.json"
                                ),
                                "stage": "validation",
                                "check": "evaluation_report_present",
                            }
                        },
                        "owner": "validation-service",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                    "execution": {
                        "status": "pass",
                        "checks": [
                            {"check": "walkforward_results_present", "status": "pass"},
                            {"check": "gate_matrix_approval", "status": "pass"},
                        ],
                        "artifacts": {
                            "walkforward_results": {
                                "path": "backtest/evaluation-report.json",
                                "sha256": _sha256_path(
                                    root / "backtest" / "evaluation-report.json"
                                ),
                                "stage": "execution",
                                "check": "walkforward_results_present",
                            }
                        },
                        "owner": "execution-sim",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                    "governance": {
                        "status": "pass",
                        "checks": [{"check": "rollback_ready", "status": "pass"}],
                        "artifacts": {
                            "candidate_spec": {
                                "path": "research/candidate-spec.json",
                                "sha256": _sha256_path(candidate_spec_path),
                                "stage": "governance",
                                "check": "candidate_spec_present",
                            }
                        },
                        "owner": "governance-policy",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                },
                "overall_status": "pass",
                "failure_reasons": [],
                "rollback_contract_ref": "gates/rollback-readiness.json",
                "created_at_utc": "2026-03-01T00:00:00+00:00",
            }
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            manifest_path.write_text(json.dumps(manifest_payload), encoding="utf-8")

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

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_artifact_payload_invalid_json(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "profitability").mkdir(parents=True, exist_ok=True)
            candidate_spec_path = root / "research" / "candidate-spec.json"
            candidate_spec_invalid_path = (
                root / "research" / "candidate-spec-corrupt.json"
            )
            candidate_spec_path.write_text("{}", encoding="utf-8")
            candidate_spec_invalid_path.write_text("{ invalid json }", encoding="utf-8")
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
                    ("research", "candidate_spec_present"): candidate_spec_invalid_path,
                },
            )
            manifest_payload["overall_status"] = "pass"
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            manifest_path = (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            )
            manifest_path.write_text(json.dumps(manifest_payload), encoding="utf-8")

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
            "profitability_stage_manifest_artifact_invalid_json",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_stage_transition_breaks(
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
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
            gate_report_path = root / "gates" / "gate-evaluation.json"
            gate_report_path.write_text(json.dumps(_gate_report()), encoding="utf-8")
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(
                json.dumps({"status": "ok"}), encoding="utf-8"
            )
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
            (root / "gates" / "janus-event-car-v1.json").write_text(
                json.dumps(
                    {
                        "schema_version": "janus-event-car-v1",
                        "summary": {"event_count": 1},
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
                json.dumps(
                    {
                        "schema_version": "janus-hgrm-reward-v1",
                        "summary": {"reward_count": 1},
                    }
                ),
                encoding="utf-8",
            )
            (root / "gates" / "rollback-readiness.json").write_text(
                json.dumps(
                    {"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}
                ),
                encoding="utf-8",
            )
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").parent.mkdir(
                parents=True, exist_ok=True
            )
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            manifest_path = (
                root / "profitability" / "profitability-stage-manifest-v1.json"
            )
            manifest_payload = {
                "schema_version": "profitability-stage-manifest-v1",
                "candidate_id": "cand-test",
                "strategy_family": "deterministic",
                "llm_artifact_ref": None,
                "router_artifact_ref": "strategy-config",
                "run_context": {
                    "repository": "proompteng/lab",
                    "base": "main",
                    "head": "agentruns/main",
                    "artifact_path": str(root),
                    "run_id": "run-test",
                },
                "stages": {
                    "research": {
                        "status": "pass",
                        "checks": [
                            {"check": "candidate_spec_present", "status": "pass"}
                        ],
                        "artifacts": {
                            "candidate_spec": {
                                "path": "research/candidate-spec.json",
                                "sha256": _sha256_path(candidate_spec_path),
                                "stage": "research",
                                "check": "candidate_spec_present",
                            }
                        },
                        "owner": "research-orchestrator",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                    "validation": {
                        "status": "fail",
                        "checks": [
                            {"check": "evaluation_report_present", "status": "pass"},
                            {
                                "check": "profitability_benchmark_present",
                                "status": "fail",
                                "reason": "missing",
                            },
                        ],
                        "artifacts": {
                            "evaluation_report": {
                                "path": "backtest/evaluation-report.json",
                                "sha256": _sha256_path(evaluation_report_path),
                                "stage": "validation",
                                "check": "evaluation_report_present",
                            }
                        },
                        "owner": "validation-service",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                    "execution": {
                        "status": "pass",
                        "checks": [
                            {"check": "walkforward_results_present", "status": "pass"},
                            {"check": "evaluation_report_present", "status": "pass"},
                            {"check": "gate_evaluation_present", "status": "pass"},
                            {"check": "janus_event_car_present", "status": "pass"},
                            {"check": "janus_hgrm_reward_present", "status": "pass"},
                            {"check": "recalibration_report_present", "status": "pass"},
                            {"check": "gate_matrix_approval", "status": "pass"},
                            {"check": "drift_gate_approval", "status": "pass"},
                        ],
                        "artifacts": {
                            "walkforward_results": {
                                "path": "backtest/walkforward-results.json",
                                "sha256": _sha256_path(walkforward_results_path),
                                "stage": "execution",
                                "check": "walkforward_results_present",
                            },
                            "evaluation_report": {
                                "path": "backtest/evaluation-report.json",
                                "sha256": _sha256_path(evaluation_report_path),
                                "stage": "execution",
                                "check": "evaluation_report_present",
                            },
                            "gate_evaluation": {
                                "path": "gates/gate-evaluation.json",
                                "sha256": _sha256_path(gate_report_path),
                                "stage": "execution",
                                "check": "gate_evaluation_present",
                            },
                            "janus_event_car": {
                                "path": "gates/janus-event-car-v1.json",
                                "sha256": _sha256_path(
                                    root / "gates" / "janus-event-car-v1.json"
                                ),
                                "stage": "execution",
                                "check": "janus_event_car_present",
                            },
                            "janus_hgrm_reward": {
                                "path": "gates/janus-hgrm-reward-v1.json",
                                "sha256": _sha256_path(
                                    root / "gates" / "janus-hgrm-reward-v1.json"
                                ),
                                "stage": "execution",
                                "check": "janus_hgrm_reward_present",
                            },
                            "recalibration_report": {
                                "path": "gates/recalibration-report.json",
                                "sha256": _sha256_path(
                                    root / "gates" / "recalibration-report.json"
                                ),
                                "stage": "execution",
                                "check": "recalibration_report_present",
                            },
                        },
                        "owner": "execution-sim",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                    "governance": {
                        "status": "pass",
                        "checks": [
                            {"check": "rollback_ready", "status": "pass"},
                            {"check": "gate_report_present", "status": "pass"},
                            {"check": "candidate_spec_present", "status": "pass"},
                            {"check": "risk_controls_attestable", "status": "pass"},
                        ],
                        "artifacts": {
                            "candidate_spec": {
                                "path": "research/candidate-spec.json",
                                "sha256": _sha256_path(candidate_spec_path),
                                "stage": "governance",
                                "check": "candidate_spec_present",
                            },
                            "gate_evaluation": {
                                "path": "gates/gate-evaluation.json",
                                "sha256": _sha256_path(gate_report_path),
                                "stage": "governance",
                                "check": "gate_evaluation_present",
                            },
                            "rollback_readiness": {
                                "path": "gates/rollback-readiness.json",
                                "sha256": _sha256_path(
                                    root / "gates" / "rollback-readiness.json"
                                ),
                                "stage": "governance",
                                "check": "rollback_readiness_present",
                            },
                        },
                        "owner": "governance-policy",
                        "completed_at_utc": "2026-03-01T00:00:00+00:00",
                    },
                },
                "overall_status": "fail",
                "failure_reasons": ["validation_check_failed"],
                "rollback_contract_ref": "gates/rollback-readiness.json",
                "created_at_utc": "2026-03-01T00:00:00+00:00",
            }
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            manifest_path.write_text(json.dumps(manifest_payload), encoding="utf-8")

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_profitability_stage_manifest": True,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                    "promotion_require_janus_evidence": False,
                },
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertFalse(promotion.allowed)
        self.assertIn(
            "profitability_stage_manifest_stage_transition_violation",
            promotion.reasons,
        )
        self.assertIn(
            "profitability_stage_manifest_stage_chain_not_passed",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_has_extra_stage(
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
                recalibration_report_path=root / "gates" / "recalibration-report.json",
            )
            manifest_payload["stages"]["telemetry_audit"] = {
                "status": "pass",
                "checks": [{"check": "noop", "status": "pass"}],
                "artifacts": {},
                "owner": "qa",
                "completed_at_utc": "2026-03-01T00:00:00+00:00",
            }
            manifest_payload["overall_status"] = "pass"
            manifest_payload["failure_reasons"] = []
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
            "profitability_stage_manifest_stage_set_invalid",
            promotion.reasons,
        )
