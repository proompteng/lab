from __future__ import annotations

import json
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import TestCase


def _default_gate_report(now: datetime) -> dict[str, object]:
    return {
        "run_id": "run-dry-run",
        "promotion_allowed": True,
        "recommended_mode": "paper",
        "throughput": {
            "signal_count": 10,
            "decision_count": 6,
            "trade_count": 4,
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
                "items": [{"fold_name": "autonomous_lane"}],
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
                "artifact_ref": "gates/stress-metrics-v1.json",
                "generated_at": now.isoformat(),
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
                "rationale_text": "Dry-run fixture rationale.",
            },
        },
        "uncertainty_gate_action": "pass",
        "coverage_error": "0.02",
        "recalibration_run_id": None,
    }


class TestGovernancePolicyDryRun(TestCase):
    def test_dry_run_blocks_progression_when_artifact_missing(self) -> None:
        output = self._run_harness("--simulate-missing-artifact")
        self.assertFalse(output["promotion_progression_allowed"])
        reasons = output["promotion_prerequisites"]["reasons"]
        self.assertIn("required_artifacts_missing", reasons)

    def test_dry_run_blocks_progression_when_rollback_stale(self) -> None:
        output = self._run_harness("--simulate-stale-rollback")
        self.assertFalse(output["promotion_progression_allowed"])
        reasons = output["rollback_readiness"]["reasons"]
        self.assertIn("rollback_dry_run_stale", reasons)

    def test_dry_run_blocks_progression_when_stress_evidence_is_missing(self) -> None:
        output = self._run_harness("--simulate-stress-metrics-missing")
        self.assertFalse(output["promotion_progression_allowed"])
        reasons = output["promotion_prerequisites"]["reasons"]
        self.assertIn("stress_metrics_evidence_artifact_missing", reasons)

    def test_dry_run_blocks_progression_when_stress_evidence_is_stale(self) -> None:
        output = self._run_harness("--simulate-stress-metrics-stale")
        self.assertFalse(output["promotion_progression_allowed"])
        reasons = output["promotion_prerequisites"]["reasons"]
        self.assertIn("stress_metrics_evidence_stale", reasons)

    def test_dry_run_blocks_progression_when_stress_evidence_is_untrusted(self) -> None:
        output = self._run_harness("--simulate-stress-metrics-untrusted")
        self.assertFalse(output["promotion_progression_allowed"])
        reasons = output["promotion_prerequisites"]["reasons"]
        self.assertIn("stress_metrics_evidence_ref_not_trusted", reasons)

    def test_dry_run_allows_progression_when_checks_pass(self) -> None:
        output = self._run_harness()
        self.assertTrue(output["promotion_progression_allowed"])

    def _run_harness(self, *extra_args: str) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        repo_root = Path(__file__).resolve().parents[3]
        service_root = repo_root / "services" / "torghut"
        script = service_root / "scripts" / "run_governance_policy_dry_run.py"
        policy = service_root / "config" / "autonomy-gates-v3.json"

        gate_report = _default_gate_report(now)
        if "--simulate-stress-metrics-stale" in extra_args:
            stress_metrics = gate_report["promotion_evidence"]["stress_metrics"]
            if isinstance(stress_metrics, dict):
                stress_metrics["generated_at"] = (
                    now - timedelta(hours=25)
                ).isoformat()
        if "--simulate-stress-metrics-untrusted" in extra_args:
            stress_metrics = gate_report["promotion_evidence"]["stress_metrics"]
            if isinstance(stress_metrics, dict):
                stress_metrics["artifact_ref"] = str(
                    Path(tempfile.gettempdir())
                    / "torghut-dry-run-stress-metrics-untrusted.json"
                )
                Path(tempfile.gettempdir(), "torghut-dry-run-stress-metrics-untrusted.json").write_text(
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
                            "generated_at": now.isoformat(),
                        },
                        indent=2,
                    ),
                    encoding="utf-8",
                )

        with tempfile.TemporaryDirectory() as tmpdir:
            gate_report_path = Path(tmpdir) / "gate-report.json"
            gate_report_path.write_text(
                json.dumps(gate_report, indent=2), encoding="utf-8"
            )

            cmd = [
                "python3",
                str(script),
                "--policy",
                str(policy),
                "--gate-report",
                str(gate_report_path),
                "--promotion-target",
                "paper",
                *extra_args,
            ]
            result = subprocess.run(
                cmd,
                cwd=service_root,
                check=True,
                capture_output=True,
                text=True,
            )

        return json.loads(result.stdout)
