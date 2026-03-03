from __future__ import annotations

import os
import json
import tempfile
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.trading.parity import (
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_SCHEMA_VERSION,
)
from app.trading.autonomy.policy_checks import (
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)


class TestPolicyChecks(TestCase):
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

    def test_promotion_prerequisites_fail_when_profitability_stage_manifest_missing(self) -> None:
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
                "{ invalid json }", encoding="utf-8"
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
            "profitability_stage_manifest_invalid_json",
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
                {key: value for key, value in hmm_payload.items() if key != "artifact_hash"}
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
        self.assertIn(str(root / "gates" / "hmm-state-posterior-v1.json"), promotion.artifact_refs)

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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps(
                    {"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}
                ),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
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
                    {"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}
                ),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps(
                    {"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}
                ),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps(
                    {"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}
                ),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
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
                    {"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}
                ),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps(
                    {"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}
                ),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
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
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
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
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 2}}),
                encoding="utf-8",
            )
            (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 2}}),
                encoding="utf-8",
            )
            manifest_path = root / "profitability" / "profitability-stage-manifest-v1.json"
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
                                "sha256": _sha256_path(root / "backtest" / "evaluation-report.json"),
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
            candidate_spec_invalid_path = root / "research" / "candidate-spec-corrupt.json"
            candidate_spec_path.write_text("{}", encoding="utf-8")
            candidate_spec_invalid_path.write_text("{ invalid json }", encoding="utf-8")
            candidate_generation_manifest_path = (
                root / "research" / "candidate-generation-manifest.json"
            )
            candidate_generation_manifest_path.write_text("{}", encoding="utf-8")
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
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
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            manifest_path = root / "profitability" / "profitability-stage-manifest-v1.json"
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

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_stage_transition_breaks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "profitability").mkdir(parents=True, exist_ok=True)
            candidate_spec_path = root / "research" / "candidate-spec.json"
            candidate_spec_path.write_text("{}", encoding="utf-8")
            evaluation_report_path = root / "backtest" / "evaluation-report.json"
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
            gate_report_path = root / "gates" / "gate-evaluation.json"
            gate_report_path.write_text(json.dumps(_gate_report()), encoding="utf-8")
            walkforward_results_path = root / "backtest" / "walkforward-results.json"
            walkforward_results_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
            (root / "gates" / "profitability-evidence-v4.json").write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            (root / "gates" / "profitability-benchmark-v4.json").write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
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
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}),
                encoding="utf-8",
            )
            (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}),
                encoding="utf-8",
            )
            (root / "gates" / "rollback-readiness.json").write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
                encoding="utf-8",
            )
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").parent.mkdir(
                parents=True, exist_ok=True
            )
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
                "kind: ConfigMap", encoding="utf-8"
            )

            manifest_path = root / "profitability" / "profitability-stage-manifest-v1.json"
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
                        "checks": [{"check": "candidate_spec_present", "status": "pass"}],
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
                                "sha256": _sha256_path(root / "gates" / "recalibration-report.json"),
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

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_has_extra_stage(self) -> None:
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
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
            profitability_validation_path.write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            janus_event_car_path = root / "gates" / "janus-event-car-v1.json"
            janus_event_car_path.write_text(
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
                json.dumps(manifest_payload), encoding="utf-8"
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
            "profitability_stage_manifest_stage_set_invalid",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_rollback_readiness_artifact_missing(
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
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
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
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
                    (
                        "governance",
                        "rollback_readiness_present",
                    ): root / "gates" / "rollback-readiness-missing.json",
                },
            )
            manifest_payload["overall_status"] = "fail"
            manifest_payload["failure_reasons"] = ["rollback_readiness_contract_missing"]
            manifest_payload["content_hash"] = _sha256_json(
                {k: v for k, v in manifest_payload.items() if k != "content_hash"}
            )
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
                json.dumps(manifest_payload), encoding="utf-8"
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
            "profitability_stage_manifest_artifact_missing",
            promotion.reasons,
        )

    def test_promotion_prerequisites_fails_when_profitability_stage_manifest_rollback_readiness_fails(self) -> None:
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
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
            profitability_validation_path.write_text(
                json.dumps({"passed": True, "reasons": []}),
                encoding="utf-8",
            )
            janus_event_car_path = root / "gates" / "janus-event-car-v1.json"
            janus_event_car_path.write_text(
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
                json.dumps(manifest_payload), encoding="utf-8"
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
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
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
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
                json.dumps(manifest_payload), encoding="utf-8"
            )
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
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
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
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
                json.dumps(manifest_payload), encoding="utf-8"
            )

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
            evaluation_report_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")
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
            profitability_benchmark_path = root / "gates" / "profitability-benchmark-v4.json"
            profitability_benchmark_path.write_text(
                json.dumps({"slices": [{"slice_type": "regime", "slice_key": "regime:neutral"}]}),
                encoding="utf-8",
            )
            profitability_evidence_path = root / "gates" / "profitability-evidence-v4.json"
            profitability_evidence_path.write_text(
                json.dumps({"schema_version": "profitability-evidence-v4"}),
                encoding="utf-8",
            )
            profitability_validation_path = root / "gates" / "profitability-evidence-validation.json"
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
                json.dumps({"schema_version": "janus-event-car-v1", "summary": {"event_count": 1}}),
                encoding="utf-8",
            )
            janus_hgrm_reward_path = root / "gates" / "janus-hgrm-reward-v1.json"
            janus_hgrm_reward_path.write_text(
                json.dumps({"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 1}}),
                encoding="utf-8",
            )
            rollback_readiness_path = root / "gates" / "rollback-readiness.json"
            rollback_readiness_path.write_text(
                json.dumps({"dryRunCompletedAt": datetime.now(timezone.utc).isoformat()}),
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
            (root / "profitability" / "profitability-stage-manifest-v1.json").write_text(
                json.dumps(manifest_payload), encoding="utf-8"
            )
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

    def test_promotion_prerequisites_fail_when_janus_artifacts_schema_invalid(self) -> None:
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
            (root / "gates" / "gate-evaluation.json").write_text(
                "{}", encoding="utf-8"
            )
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
            (root / "gates" / "gate-evaluation.json").write_text(
                "{}", encoding="utf-8"
            )
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

    def test_promotion_prerequisites_fail_when_uncertainty_coverage_non_finite(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text("{}", encoding="utf-8")
            (root / "backtest" / "evaluation-report.json").write_text("{}", encoding="utf-8")
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

    def test_promotion_prerequisites_fail_when_uncertainty_thresholds_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "paper-candidate").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text("{}", encoding="utf-8")
            (root / "backtest" / "evaluation-report.json").write_text("{}", encoding="utf-8")
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

    def test_promotion_prerequisites_fail_when_stress_artifact_reference_missing(self) -> None:
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
                "{}", encoding="utf-8",
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
                    stress_metrics["artifact_ref"] = "gates/missing-stress-evidence.json"

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

    def test_promotion_prerequisites_fail_when_stress_artifact_reference_untrusted(self) -> None:
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
                "{}", encoding="utf-8",
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
                "{}", encoding="utf-8",
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
                    stress_metrics["artifact_ref"] = "backtest/stale-evaluation-report.json"
            stale_now = datetime(2026, 2, 25, 12, 0, 0, tzinfo=timezone.utc)
            stale_epoch = (
                stale_now - timedelta(hours=5)
            ).timestamp()
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

    def test_promotion_prerequisites_allow_file_uri_stress_artifact_reference(self) -> None:
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
                    {"schema_version": "janus-event-car-v1", "summary": {"event_count": 3}}
                ),
                encoding="utf-8",
            )
            (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
                json.dumps(
                    {"schema_version": "janus-hgrm-reward-v1", "summary": {"reward_count": 3}}
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
        self.assertIn(
            "stress_metrics_evidence_artifact_missing", promotion.reasons
        )

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
                "app.trading.autonomy.policy_checks.os.path.getmtime",
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

    def test_promotion_prerequisites_fail_when_contamination_registry_missing(self) -> None:
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

    def test_promotion_prerequisites_fail_when_contamination_registry_detects_leakage(self) -> None:
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
            payload["artifact_hash"] = "0000000000000000000000000000000000000000000000000000000000000000"
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


def _candidate_state() -> dict[str, object]:
    return {
        "candidateId": "cand-test",
        "runId": "run-test",
        "activeStage": "gate-evaluation",
        "paused": False,
        "datasetSnapshotRef": "signals_window",
        "noSignalReason": None,
        "rollbackReadiness": {
            "killSwitchDryRunPassed": True,
            "gitopsRevertDryRunPassed": True,
            "strategyDisableDryRunPassed": True,
            "dryRunCompletedAt": datetime.now(timezone.utc).isoformat(),
            "humanApproved": True,
            "rollbackTarget": "main@a1b2c3d",
        },
    }


def _write_benchmark_parity_payload(
    root: Path,
    *,
    adverse_regime_degradation: float = 0.0,
    risk_veto_degradation: float = 0.0,
    confidence_calibration_error_degradation: float = 0.0,
    families: tuple[str, ...] = BENCHMARK_PARITY_REQUIRED_FAMILIES,
    schema_version: str = BENCHMARK_PARITY_SCHEMA_VERSION,
) -> Path:
    payload = _build_benchmark_parity_payload(
        families=families,
        adverse_regime_degradation=adverse_regime_degradation,
        risk_veto_degradation=risk_veto_degradation,
        confidence_calibration_error_degradation=confidence_calibration_error_degradation,
        schema_version=schema_version,
    )
    return _write_benchmark_parity_payload_payload(root, payload=payload)


def _write_benchmark_parity_payload_payload(
    root: Path,
    *,
    payload: dict[str, object],
    path: Path | None = None,
) -> Path:
    artifact_path = (
        root / "benchmarks" / "benchmark-parity-report-v1.json"
        if path is None
        else path
    )
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(payload), encoding="utf-8")
    return artifact_path


def _build_benchmark_parity_payload(
    *,
    families: tuple[str, ...] = BENCHMARK_PARITY_REQUIRED_FAMILIES,
    adverse_regime_degradation: float = 0.0,
    risk_veto_degradation: float = 0.0,
    confidence_calibration_error_degradation: float = 0.0,
    schema_version: str = BENCHMARK_PARITY_SCHEMA_VERSION,
) -> dict[str, object]:
    payload = {
        "schema_version": schema_version,
        "candidate_id": "cand-test",
        "baseline_candidate_id": "base-test",
        "benchmark_runs": [
            _build_test_benchmark_parity_run(family)
            for family in families
        ],
        "scorecards": {
            "decision_quality": {"status": "pass"},
            "reasoning_quality": {"status": "pass"},
            "forecast_quality": {"status": "pass"},
        },
        "overall_parity_status": "pass",
        "degradation_summary": {
            "adverse_regime_decision_quality": {
                "degradation": adverse_regime_degradation,
            },
            "risk_veto_alignment": {
                "degradation": risk_veto_degradation,
            },
            "confidence_calibration_error": {
                "degradation": confidence_calibration_error_degradation,
            },
        },
        "created_at_utc": datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat(),
        "artifact_hash": "",
    }
    _recompute_benchmark_artifact_hash(payload)
    return payload


def _build_test_benchmark_parity_run(
    family: str, *,
    run_hash: str = "test-run-hash",
) -> dict[str, object]:
    return {
        "family": family,
        "dataset_ref": "benchmarks/external-labeled-stream-v1",
        "window_ref": "20260201T000000Z",
        "metrics": {
            "advisory_output_rate": 0.998,
            "risk_veto_alignment": 0.95,
            "confidence_calibration_error": 0.015,
        },
        "slice_metrics": {
            "baseline_regime": {
                "decision_quality": 0.88,
                "policy_violation_rate": 0.01,
            },
            "adverse_regime": {
                "decision_quality": 0.86,
                "policy_violation_rate": 0.01,
            },
        },
        "policy_violations": {
            "deterministic_gate_compatible": True,
            "rate": 0.01,
            "baseline_rate": 0.01,
            "fallback_rate": 0.001,
            "timeout_rate": 0.001,
        },
        "run_hash": run_hash,
    }


def _recompute_benchmark_artifact_hash(payload: dict[str, object]) -> str:
    payload_without_hash = {
        key: value for key, value in payload.items() if key != "artifact_hash"
    }
    artifact_hash = _sha256_json(payload_without_hash)
    payload["artifact_hash"] = artifact_hash
    return artifact_hash


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_json(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _build_profitability_stage_manifest_payload(
    *,
    root: Path,
    candidate_spec_path: Path,
    candidate_generation_manifest_path: Path,
    walkforward_results_path: Path,
    baseline_evaluation_report_path: Path,
    evaluation_report_path: Path,
    gate_report_path: Path,
    profitability_benchmark_path: Path,
    profitability_evidence_path: Path,
    profitability_validation_path: Path,
    janus_event_car_path: Path,
    janus_hgrm_reward_path: Path,
    recalibration_report_path: Path,
    hmm_state_posterior_path: Path | None = None,
    rollback_readiness_path: Path | None = None,
    stage_statuses: dict[str, str] | None = None,
    check_status_overrides: dict[tuple[str, str], str] | None = None,
    artifact_path_overrides: dict[tuple[str, str], Path] | None = None,
) -> dict[str, object]:
    def _artifact_sha(payload_path: Path | None) -> str:
        if payload_path is None or not payload_path.exists():
            return "missing"
        return _sha256_path(payload_path)

    def _artifact_path(payload_path: Path | None) -> str:
        if payload_path is None:
            return ""
        try:
            return str(payload_path.relative_to(root))
        except ValueError:
            return str(payload_path)

    rollback_readiness_path = (
        rollback_readiness_path or (root / "gates" / "rollback-readiness.json")
    )
    if hmm_state_posterior_path is None:
        hmm_state_posterior_path = root / "gates" / "hmm-state-posterior-v1.json"
    if not hmm_state_posterior_path.exists():
        hmm_state_posterior_path.parent.mkdir(parents=True, exist_ok=True)
        hmm_payload: dict[str, object] = {
            "schema_version": "hmm-state-posterior-v1",
            "run_id": "run-test",
            "candidate_id": "cand-test",
            "generated_at": "2026-03-01T00:00:00+00:00",
            "samples_total": 1,
            "authoritative_samples": 0,
            "authoritative_sample_ratio": "0",
            "transition_shock_samples": 0,
            "stale_or_defensive_samples": 0,
            "regime_counts": {"unknown": 1},
            "entropy_band_counts": {"low": 1},
            "guardrail_reason_counts": {"none": 1},
            "posterior_mass_by_regime": {"unknown": "1"},
            "top_regime_by_posterior_mass": "unknown",
            "source_lineage": {
                "walkforward_results_artifact_ref": "backtest/walkforward-results.json",
                "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                "decision_source": "walkforward_results",
            },
        }
        hmm_payload["artifact_hash"] = _sha256_json(
            {k: v for k, v in hmm_payload.items() if k != "artifact_hash"}
        )
        hmm_state_posterior_path.write_text(
            json.dumps(hmm_payload),
            encoding="utf-8",
        )

    stage_owner = {
        "research": "research-orchestrator",
        "validation": "validation-service",
        "execution": "execution-sim",
        "governance": "governance-policy",
    }
    stage_checks: dict[str, list[tuple[str, str, Path]]] = {
        "research": [
            ("candidate_spec_present", "candidate_spec", candidate_spec_path),
            ("candidate_generation_manifest_present", "candidate_generation_manifest", candidate_generation_manifest_path),
            ("walkforward_results_present", "walkforward_results", walkforward_results_path),
            ("baseline_evaluation_report_present", "baseline_evaluation_report", baseline_evaluation_report_path),
        ],
        "validation": [
            ("evaluation_report_present", "evaluation_report", evaluation_report_path),
            ("profitability_benchmark_present", "profitability_benchmark", profitability_benchmark_path),
            ("profitability_evidence_present", "profitability_evidence", profitability_evidence_path),
            ("profitability_validation_present", "profitability_validation", profitability_validation_path),
        ],
        "execution": [
            ("walkforward_results_present", "walkforward_results", walkforward_results_path),
            ("evaluation_report_present", "evaluation_report", evaluation_report_path),
            ("gate_evaluation_present", "gate_evaluation", gate_report_path),
            ("hmm_state_posterior_present", "hmm_state_posterior", hmm_state_posterior_path),
            ("janus_event_car_present", "janus_event_car", janus_event_car_path),
            ("janus_hgrm_reward_present", "janus_hgrm_reward", janus_hgrm_reward_path),
            ("recalibration_report_present", "recalibration_report", recalibration_report_path),
            ("gate_matrix_approval", "", gate_report_path),
            ("drift_gate_approval", "", gate_report_path),
        ],
        "governance": [
            ("rollback_ready", "", gate_report_path),
            ("gate_report_present", "", gate_report_path),
            ("candidate_spec_present", "candidate_spec", candidate_spec_path),
            (
                "rollback_readiness_present",
                "rollback_readiness",
                rollback_readiness_path,
            ),
            ("risk_controls_attestable", "", candidate_spec_path),
        ],
    }
    resolved_stage_statuses = {
        "research": "pass",
        "validation": "pass",
        "execution": "pass",
        "governance": "pass",
    }
    if stage_statuses:
        resolved_stage_statuses.update(stage_statuses)
    resolved_check_statuses = check_status_overrides or {}
    resolved_artifacts = artifact_path_overrides or {}

    stages: dict[str, object] = {}
    for stage_name in ("research", "validation", "execution", "governance"):
        checks: list[dict[str, str]] = []
        artifacts: dict[str, Any] = {}
        for check_name, artifact_key, default_path in stage_checks[stage_name]:
            check_key = (stage_name, check_name)
            checks.append(
                {
                    "check": check_name,
                    "status": resolved_check_statuses.get(check_key, "pass"),
                }
            )
            artifact_path = resolved_artifacts.get(check_key, default_path)
            if not artifact_key or artifact_path is None:
                continue
            artifacts[artifact_key] = {
                "path": _artifact_path(artifact_path),
                "sha256": _artifact_sha(artifact_path),
                "stage": stage_name,
                "check": check_name,
            }
        stages[stage_name] = {
            "status": resolved_stage_statuses[stage_name],
            "checks": checks,
            "artifacts": artifacts,
            "owner": stage_owner[stage_name],
            "completed_at_utc": "2026-03-01T00:00:00+00:00",
        }
    replay_artifact_hashes: dict[str, str] = {}
    for stage_payload_raw in stages.values():
        if not isinstance(stage_payload_raw, dict):
            continue
        stage_payload = stage_payload_raw
        artifacts_raw = stage_payload.get("artifacts")
        if not isinstance(artifacts_raw, dict):
            continue
        for artifact_payload_raw in artifacts_raw.values():
            if not isinstance(artifact_payload_raw, dict):
                continue
            artifact_payload = artifact_payload_raw
            artifact_ref = str(artifact_payload.get("path", "")).strip()
            artifact_sha = str(artifact_payload.get("sha256", "")).strip()
            if artifact_ref and artifact_sha:
                replay_artifact_hashes[artifact_ref] = artifact_sha
    manifest = {
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
        "stages": stages,
        "overall_status": "pass",
        "failure_reasons": [],
        "replay_contract": {
            "artifact_hashes": replay_artifact_hashes,
            "contract_hash": _sha256_json({"artifact_hashes": replay_artifact_hashes}),
            "hash_algorithm": "sha256",
        },
        "rollback_contract_ref": "gates/rollback-readiness.json",
        "created_at_utc": "2026-03-01T00:00:00+00:00",
    }
    manifest["content_hash"] = _sha256_json(
        {k: v for k, v in manifest.items() if k != "content_hash"}
    )
    return manifest


def _write_janus_artifacts(root: Path) -> None:
    (root / "gates" / "janus-event-car-v1.json").write_text(
        json.dumps(
            {
                "schema_version": "janus-event-car-v1",
                "summary": {"event_count": 2},
                "records": [{"event_id": "evt-1"}, {"event_id": "evt-2"}],
            }
        ),
        encoding="utf-8",
    )
    (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
        json.dumps(
            {
                "schema_version": "janus-hgrm-reward-v1",
                "summary": {"reward_count": 2},
                "rewards": [{"reward_id": "rwd-1"}, {"reward_id": "rwd-2"}],
            }
        ),
        encoding="utf-8",
    )


def _write_stress_artifacts(
    root: Path,
    *,
    generated_at: str = "",
    count: int = 4,
) -> None:
    payload = {
        "schema_version": "stress-metrics-v1",
        "count": count,
        "items": [
            {"case": "spread"},
            {"case": "volatility"},
            {"case": "liquidity"},
            {"case": "halt"},
        ],
        "generated_at": generated_at
        or datetime(2025, 1, 1, tzinfo=timezone.utc).isoformat(),
    }
    (root / "gates" / "stress-metrics-v1.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def _write_contamination_registry_artifact(
    root: Path,
    *,
    status: str = "pass",
    leakage_detected: bool = False,
    leakage_rate: float = 0.0,
    check_status_overrides: dict[str, str] | None = None,
) -> None:
    checks = {
        "temporal_ordering": "pass",
        "lineage_complete": "pass",
        "leakage_absent": "pass",
        "embargo_windows_enforced": "pass",
    }
    if check_status_overrides:
        checks.update(check_status_overrides)
    payload: dict[str, object] = {
        "schema_version": "contamination-leakage-report-v1",
        "run_id": "run-test",
        "candidate_id": "cand-test",
        "generated_at": datetime(2026, 3, 3, tzinfo=timezone.utc).isoformat(),
        "status": status,
        "leakage_detected": leakage_detected,
        "leakage_rate": leakage_rate,
        "temporal_integrity": {
            "event_time_ordering_passed": True,
            "embargo_windows_enforced": True,
        },
        "source_lineage": {
            "complete": True,
            "feature_sources": [
                "research/candidate-spec.json",
                "backtest/evaluation-report.json",
            ],
            "prompt_sources": [],
        },
        "checks": [
            {"check": check_name, "status": check_status}
            for check_name, check_status in checks.items()
        ],
        "artifact_refs": [
            "research/candidate-spec.json",
            "backtest/evaluation-report.json",
        ],
    }
    payload["artifact_hash"] = _sha256_json(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    (root / "gates" / "contamination-leakage-report-v1.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def _gate_report() -> dict[str, object]:
    return {
        "run_id": "run-test",
        "promotion_allowed": True,
        "recommended_mode": "paper",
        "throughput": {
            "signal_count": 16,
            "decision_count": 12,
            "trade_count": 7,
            "no_signal_window": False,
            "no_signal_reason": None,
        },
        "gates": [
            {"gate_id": "gate0_data_integrity", "status": "pass"},
            {"gate_id": "gate1_statistical_robustness", "status": "pass"},
            {"gate_id": "gate2_risk_capacity", "status": "pass"},
            {"gate_id": "gate7_uncertainty_calibration", "status": "pass"},
        ],
        "promotion_evidence": {
            "fold_metrics": {
                "count": 1,
                "items": [{"fold_name": "fold-1"}],
                "artifact_ref": "gates/stress-metrics-v1.json",
            },
            "stress_metrics": {
                "count": 4,
                "items": [
                    {"case": "spread"},
                    {"case": "volatility"},
                    {"case": "liquidity"},
                    {"case": "halt"},
                ],
                "artifact_ref": "gates/stress-metrics-v1.json",
            },
            "janus_q": {
                "event_car": {
                    "count": 2,
                    "artifact_ref": "gates/janus-event-car-v1.json",
                },
                "hgrm_reward": {
                    "count": 2,
                    "artifact_ref": "gates/janus-hgrm-reward-v1.json",
                },
                "evidence_complete": True,
                "reasons": [],
            },
            "contamination_registry": {
                "artifact_ref": "gates/contamination-leakage-report-v1.json",
                "status": "pass",
                "leakage_detected": False,
                "leakage_rate": 0.0,
            },
            "hmm_state_posterior": {
                "artifact_ref": "gates/hmm-state-posterior-v1.json",
                "schema_version": "hmm-state-posterior-v1",
                "samples_total": 12,
                "authoritative_samples": 8,
                "authoritative_sample_ratio": "0.6667",
            },
            "promotion_rationale": {
                "requested_target": "paper",
                "gate_recommended_mode": "paper",
                "gate_reasons": ["gate_result_ok"],
            },
        },
        "uncertainty_gate_action": "pass",
        "coverage_error": "0.02",
        "recalibration_run_id": None,
    }
