from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase

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

    def test_promotion_prerequisites_skip_janus_when_profitability_gate_disabled(
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
                policy_payload={"gate6_require_profitability_evidence": False},
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
                "artifact_ref": "backtest/evaluation-report.json",
            },
            "stress_metrics": {
                "count": 4,
                "items": [
                    {"case": "spread"},
                    {"case": "volatility"},
                    {"case": "liquidity"},
                    {"case": "halt"},
                ],
                "artifact_ref": "db:research_stress_metrics",
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
