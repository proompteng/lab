from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.llm.dspy_compile import (
    build_compile_result,
    evaluate_dspy_compile_artifact,
)
from app.trading.llm.dspy_compile.hashing import canonical_json


class TestLLMDSPyEval(TestCase):
    def test_eval_report_passes_when_thresholds_are_met(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            compile_result_path = self._write_compile_result(
                root,
                metric_bundle={
                    "schemaValidRate": 0.998,
                    "vetoAlignmentRate": 0.81,
                    "falseVetoRate": 0.02,
                    "fallbackRate": 0.02,
                    "latencyP95Ms": 1200,
                },
            )
            gate_policy_path = self._write_gate_policy(
                root,
                [
                    "schemaVersion: torghut.dspy.metrics.v1",
                    "policy:",
                    "  schemaValidRateMin: 0.995",
                    "  vetoAlignmentRateMin: 0.80",
                    "  falseVetoRateMax: 0.03",
                    "  fallbackRateMax: 0.03",
                    "  latencyP95MsMax: 1800",
                    "  reproducibility:",
                    "    requiredKeys: [dataset_hash, compiled_prompt_hash, artifact_hash, reproducibility_hash]",
                    "  promotion:",
                    "    defaultRecommendation: paper",
                    "    allowedTargets: [paper, shadow]",
                ],
            )

            result = evaluate_dspy_compile_artifact(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-eval-test",
                artifact_path=root / "eval",
                compile_result_ref=str(compile_result_path),
                gate_policy_ref=str(gate_policy_path),
                created_at=datetime(2026, 2, 27, 14, 0, tzinfo=timezone.utc),
            )

            self.assertEqual(result.eval_report.gate_compatibility, "pass")
            self.assertEqual(result.eval_report.promotion_recommendation, "paper")
            self.assertEqual(result.eval_report.schema_valid_rate, 0.998)
            self.assertEqual(result.eval_report.false_veto_rate, 0.02)

            payload = json.loads(result.eval_report_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["gateCompatibility"], "pass")
            self.assertEqual(payload["promotionRecommendation"], "paper")
            self.assertEqual(payload["schemaValidRate"], 0.998)
            self.assertEqual(payload["falseVetoRate"], 0.02)
            self.assertEqual(payload["latencyP95Ms"], 1200)
            self.assertTrue(payload["metricBundle"]["gateChecks"]["deterministicCompatibility"])
            self.assertEqual(payload["metricBundle"]["gateFailures"], [])

    def test_eval_report_fails_when_schema_and_fallback_thresholds_fail(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            compile_result_path = self._write_compile_result(
                root,
                metric_bundle={
                    "schemaValidRate": 0.90,
                    "vetoAlignmentRate": 0.81,
                    "falseVetoRate": 0.20,
                    "fallbackRate": 0.20,
                    "latencyP95Ms": 800,
                },
            )
            gate_policy_path = self._write_gate_policy(
                root,
                [
                    "schemaVersion: torghut.dspy.metrics.v1",
                    "policy:",
                    "  schemaValidRateMin: 0.995",
                    "  vetoAlignmentRateMin: 0.80",
                    "  falseVetoRateMax: 0.03",
                    "  fallbackRateMax: 0.03",
                    "  latencyP95MsMax: 1800",
                    "  promotion:",
                    "    defaultRecommendation: paper",
                ],
            )

            result = evaluate_dspy_compile_artifact(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-eval-test",
                artifact_path=root / "eval",
                compile_result_ref=str(compile_result_path),
                gate_policy_ref=str(gate_policy_path),
                created_at=datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
            )

            self.assertEqual(result.eval_report.gate_compatibility, "fail")
            self.assertEqual(result.eval_report.promotion_recommendation, "hold")

            payload = json.loads(result.eval_report_path.read_text(encoding="utf-8"))
            self.assertIn("schema_valid_rate_below_min", payload["metricBundle"]["gateFailures"])
            self.assertIn("fallback_rate_above_max", payload["metricBundle"]["gateFailures"])

    def test_eval_report_fails_when_deterministic_compatibility_fails(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            compile_result_path = self._write_compile_result(
                root,
                metric_bundle={
                    "schemaValidRate": 0.999,
                    "vetoAlignmentRate": 0.82,
                    "falseVetoRate": 0.01,
                    "fallbackRate": 0.01,
                    "latencyP95Ms": 700,
                },
                artifact_hash_override="f" * 64,
            )
            gate_policy_path = self._write_gate_policy(
                root,
                [
                    "schemaVersion: torghut.dspy.metrics.v1",
                    "policy:",
                    "  schemaValidRateMin: 0.995",
                    "  vetoAlignmentRateMin: 0.80",
                    "  falseVetoRateMax: 0.03",
                    "  fallbackRateMax: 0.03",
                    "  latencyP95MsMax: 1800",
                ],
            )

            result = evaluate_dspy_compile_artifact(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-eval-test",
                artifact_path=root / "eval",
                compile_result_ref=str(compile_result_path),
                gate_policy_ref=str(gate_policy_path),
                created_at=datetime(2026, 2, 27, 15, 0, tzinfo=timezone.utc),
            )

            self.assertEqual(result.eval_report.gate_compatibility, "fail")
            payload = json.loads(result.eval_report_path.read_text(encoding="utf-8"))
            self.assertIn(
                "deterministic_artifact_hash_mismatch",
                payload["metricBundle"]["deterministicCompatibility"]["failures"],
            )
            self.assertIn(
                "deterministic_artifact_hash_mismatch",
                payload["metricBundle"]["gateFailures"],
            )

    def test_eval_report_output_is_deterministic_for_fixed_inputs(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            compile_result_path = self._write_compile_result(
                root,
                metric_bundle={
                    "schemaValidRate": 0.999,
                    "vetoAlignmentRate": 0.82,
                    "falseVetoRate": 0.01,
                    "fallbackRate": 0.01,
                    "latencyP95Ms": 700,
                },
            )
            gate_policy_path = self._write_gate_policy(
                root,
                [
                    "schemaVersion: torghut.dspy.metrics.v1",
                    "policy:",
                    "  schemaValidRateMin: 0.995",
                    "  vetoAlignmentRateMin: 0.80",
                    "  falseVetoRateMax: 0.03",
                    "  fallbackRateMax: 0.03",
                    "  latencyP95MsMax: 1800",
                    "  promotion:",
                    "    defaultRecommendation: shadow",
                    "    allowedTargets: [paper, shadow, constrained_live]",
                ],
            )
            created_at = datetime(2026, 2, 27, 15, 30, tzinfo=timezone.utc)

            first = evaluate_dspy_compile_artifact(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-eval-test",
                artifact_path=root / "eval-1",
                compile_result_ref=str(compile_result_path),
                gate_policy_ref=str(gate_policy_path),
                created_at=created_at,
            )
            second = evaluate_dspy_compile_artifact(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-eval-test",
                artifact_path=root / "eval-2",
                compile_result_ref=str(compile_result_path),
                gate_policy_ref=str(gate_policy_path),
                created_at=created_at,
            )

            self.assertEqual(
                first.eval_report_path.read_text(encoding="utf-8"),
                second.eval_report_path.read_text(encoding="utf-8"),
            )
            self.assertEqual(first.eval_report.eval_hash, second.eval_report.eval_hash)

    def test_eval_report_rejects_compile_results_without_observed_metrics(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            compile_result_path = self._write_compile_result(
                root,
                metric_bundle={
                    "datasetRef": "artifacts/dspy/run-1/dataset-build/dspy-dataset.json",
                    "metricPolicyRef": "config/trading/llm/dspy-metrics.yaml",
                },
            )
            gate_policy_path = self._write_gate_policy(
                root,
                [
                    "schemaVersion: torghut.dspy.metrics.v1",
                    "policy:",
                    "  schemaValidRateMin: 0.995",
                    "  vetoAlignmentRateMin: 0.80",
                    "  falseVetoRateMax: 0.03",
                    "  fallbackRateMax: 0.03",
                    "  latencyP95MsMax: 1800",
                ],
            )

            with self.assertRaisesRegex(
                ValueError, "compile_result_missing_observed_metrics"
            ):
                evaluate_dspy_compile_artifact(
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-eval-test",
                    artifact_path=root / "eval",
                    compile_result_ref=str(compile_result_path),
                    gate_policy_ref=str(gate_policy_path),
                    created_at=datetime(2026, 2, 27, 16, 0, tzinfo=timezone.utc),
                )

    def _write_compile_result(
        self,
        root: Path,
        *,
        metric_bundle: dict[str, float | int],
        artifact_hash_override: str | None = None,
    ) -> Path:
        compile_result = build_compile_result(
            program_name="trade-review-committee-v1",
            signature_versions={"trade_review": "v1"},
            optimizer="miprov2",
            dataset_payload={"rows": [{"rowId": "row-1", "split": "train"}]},
            metric_bundle=metric_bundle,
            compiled_prompt_payload={"promptTemplate": "torghut.dspy.trade-review.v1"},
            compiled_artifact_uri=f"{root}/compile/dspy-compiled-program.json",
            seed="seed-1",
            created_at=datetime(2026, 2, 27, 12, 0, tzinfo=timezone.utc),
        )
        payload = compile_result.model_dump(mode="json", by_alias=True)
        if artifact_hash_override is not None:
            payload["artifactHash"] = artifact_hash_override
        compile_result_path = root / "compile" / "dspy-compile-result.json"
        compile_result_path.parent.mkdir(parents=True, exist_ok=True)
        compile_result_path.write_text(canonical_json(payload) + "\n", encoding="utf-8")
        return compile_result_path

    def _write_gate_policy(self, root: Path, lines: list[str]) -> Path:
        gate_policy_path = root / "dspy-metrics.yaml"
        gate_policy_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return gate_policy_path
