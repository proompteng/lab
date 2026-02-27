from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.llm.dspy_compile.compiler import compile_dspy_program_artifacts
from app.trading.llm.dspy_compile.hashing import canonical_json


class TestLLMDSPyCompiler(TestCase):
    def test_compile_artifacts_emit_hashes_and_compiled_uri(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
            artifact_dir = root / "compile"

            dataset_payload = {
                "schemaVersion": "torghut.dspy.dataset.v1",
                "rows": [
                    {"rowId": "row-1", "split": "train"},
                    {"rowId": "row-2", "split": "eval"},
                    {"rowId": "row-3", "split": "test"},
                ],
            }
            dataset_path.write_text(canonical_json(dataset_payload) + "\n", encoding="utf-8")
            metric_policy_path.write_text(
                "\n".join(
                    [
                        "schemaVersion: torghut.dspy.metrics.v1",
                        "policy:",
                        "  schemaValidRateMin: 0.995",
                        "  falseVetoRateMax: 0.03",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            created_at = datetime(2026, 2, 27, 12, 0, tzinfo=timezone.utc)
            result = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-test",
                artifact_path=artifact_dir,
                dataset_ref=str(dataset_path),
                metric_policy_ref=str(metric_policy_path),
                optimizer="miprov2",
                created_at=created_at,
            )

            self.assertTrue(result.compile_result_path.exists())
            self.assertTrue(result.compiled_artifact_path.exists())
            self.assertTrue(result.compile_metrics_path.exists())
            self.assertEqual(len(result.compile_result.artifact_hash), 64)
            self.assertEqual(len(result.compile_result.reproducibility_hash), 64)
            self.assertEqual(
                result.compile_result.compiled_artifact_uri,
                f"{artifact_dir}/dspy-compiled-program.json",
            )

            compile_result_payload = json.loads(
                result.compile_result_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                compile_result_payload["compiledArtifactUri"],
                f"{artifact_dir}/dspy-compiled-program.json",
            )
            self.assertEqual(compile_result_payload["optimizer"], "miprov2")
            self.assertEqual(
                compile_result_payload["metricBundle"]["metricPolicyRef"],
                str(metric_policy_path),
            )
            self.assertEqual(
                compile_result_payload["metricBundle"]["datasetRef"],
                str(dataset_path),
            )
            self.assertEqual(
                compile_result_payload["metricBundle"]["rowCountsBySplit"],
                {"eval": 1, "test": 1, "train": 1},
            )

    def test_compile_result_hashes_are_stable_for_fixed_inputs(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
            artifact_dir = root / "compile"

            dataset_path.write_text(
                canonical_json(
                    {
                        "schemaVersion": "torghut.dspy.dataset.v1",
                        "rows": [{"rowId": "row-1", "split": "train"}],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            metric_policy_path.write_text(
                "schemaVersion: torghut.dspy.metrics.v1\npolicy:\n  schemaValidRateMin: 0.995\n",
                encoding="utf-8",
            )

            created_at = datetime(2026, 2, 27, 12, 30, tzinfo=timezone.utc)
            first = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-test",
                artifact_path=artifact_dir,
                dataset_ref=str(dataset_path),
                metric_policy_ref=str(metric_policy_path),
                optimizer="miprov2",
                created_at=created_at,
            )
            second = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-test",
                artifact_path=artifact_dir,
                dataset_ref=str(dataset_path),
                metric_policy_ref=str(metric_policy_path),
                optimizer="miprov2",
                created_at=created_at,
            )

            self.assertEqual(first.compile_result.artifact_hash, second.compile_result.artifact_hash)
            self.assertEqual(
                first.compile_result.reproducibility_hash,
                second.compile_result.reproducibility_hash,
            )
            self.assertEqual(
                first.compile_result_path.read_text(encoding="utf-8"),
                second.compile_result_path.read_text(encoding="utf-8"),
            )

    def test_compile_rejects_non_local_dataset_ref(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            metric_policy_path = root / "dspy-metrics.yaml"
            metric_policy_path.write_text(
                "schemaVersion: torghut.dspy.metrics.v1\npolicy: {}\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "dataset_ref_must_be_local_path"):
                compile_dspy_program_artifacts(
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-compile-test",
                    artifact_path=root / "compile",
                    dataset_ref="s3://bucket/dspy-dataset.json",
                    metric_policy_ref=str(metric_policy_path),
                    optimizer="miprov2",
                )
