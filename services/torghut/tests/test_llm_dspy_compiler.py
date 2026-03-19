from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from urllib.parse import urlsplit, unquote

from app.trading.llm.dspy_compile.compiler import compile_dspy_program_artifacts
from app.trading.llm.dspy_compile.hashing import canonical_json


class TestLLMDSPyCompiler(TestCase):
    @staticmethod
    def _normalize_ref(ref: str) -> str:
        parsed = urlsplit(ref)
        if parsed.scheme == "file":
            return str(Path(unquote(parsed.path)))
        return ref

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
            dataset_path.write_text(
                canonical_json(dataset_payload) + "\n", encoding="utf-8"
            )
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
            compiled_artifact_path = artifact_dir.resolve() / "dspy-compiled-program.json"
            self.assertEqual(
                result.compile_result.compiled_artifact_uri,
                f"{compiled_artifact_path}",
            )

            compile_result_payload = json.loads(
                result.compile_result_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                compile_result_payload["compiledArtifactUri"],
                f"{compiled_artifact_path}",
            )
            self.assertEqual(compile_result_payload["optimizer"], "miprov2")
            self.assertEqual(
                self._normalize_ref(compile_result_payload["metricBundle"]["metricPolicyRef"]),
                f"{metric_policy_path.resolve()}",
            )
            self.assertEqual(
                self._normalize_ref(compile_result_payload["metricBundle"]["datasetRef"]),
                f"{dataset_path.resolve()}",
            )
            self.assertEqual(
                compile_result_payload["metricBundle"]["rowCountsBySplit"],
                {"eval": 1, "test": 1, "train": 1},
            )
            compile_metrics_payload = json.loads(
                result.compile_metrics_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                compile_metrics_payload["artifactHash"], result.compile_result.artifact_hash
            )
            self.assertEqual(
                compile_metrics_payload["reproducibilityHash"],
                result.compile_result.reproducibility_hash,
            )
            self.assertEqual(
                len(compile_metrics_payload["reproducibilityHash"]), 64
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

            self.assertEqual(
                first.compile_result.artifact_hash, second.compile_result.artifact_hash
            )
            self.assertEqual(
                first.compile_result.reproducibility_hash,
                second.compile_result.reproducibility_hash,
            )
            self.assertEqual(
                first.compile_result_path.read_text(encoding="utf-8"),
                second.compile_result_path.read_text(encoding="utf-8"),
            )

    def test_compile_hashes_are_stable_for_path_and_file_uri_refs(self) -> None:
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

            created_at = datetime(2026, 2, 27, 12, 45, tzinfo=timezone.utc)
            from_path = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-test",
                artifact_path=artifact_dir,
                dataset_ref=str(dataset_path),
                metric_policy_ref=str(metric_policy_path),
                optimizer="miprov2",
                created_at=created_at,
            )
            from_file_uri = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-test",
                artifact_path=artifact_dir,
                dataset_ref=dataset_path.resolve().as_uri(),
                metric_policy_ref=metric_policy_path.resolve().as_uri(),
                optimizer="miprov2",
                created_at=created_at,
            )

            self.assertEqual(
                from_path.compile_result.reproducibility_hash,
                from_file_uri.compile_result.reproducibility_hash,
            )
            self.assertEqual(
                from_path.compile_result.artifact_hash,
                from_file_uri.compile_result.artifact_hash,
            )
            self.assertEqual(
                self._normalize_ref(from_path.compile_result.metric_bundle["datasetRef"]),
                f"{dataset_path.resolve()}",
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

    def test_compile_result_includes_observed_metrics_when_provided(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
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
                "schemaVersion: torghut.dspy.metrics.v1\npolicy: {}\n",
                encoding="utf-8",
            )

            result = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-test",
                artifact_path=root / "compile",
                dataset_ref=str(dataset_path),
                metric_policy_ref=str(metric_policy_path),
                optimizer="miprov2",
                schema_valid_rate=0.998,
                veto_alignment_rate=0.81,
                false_veto_rate=0.02,
                fallback_rate=0.02,
                latency_p95_ms=1200,
            )
            self.assertEqual(
                result.compile_result.metric_bundle["schemaValidRate"], 0.998
            )
            self.assertEqual(
                result.compile_result.metric_bundle["vetoAlignmentRate"], 0.81
            )
            self.assertEqual(result.compile_result.metric_bundle["falseVetoRate"], 0.02)
            self.assertEqual(result.compile_result.metric_bundle["fallbackRate"], 0.02)
            self.assertEqual(result.compile_result.metric_bundle["latencyP95Ms"], 1200)

    def test_compile_derives_observed_metrics_from_dataset_rows(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
            dataset_path.write_text(
                canonical_json(
                    {
                        "schemaVersion": "torghut.dspy.dataset.v1",
                        "rows": [
                            {
                                "rowId": "row-1",
                                "split": "train",
                                "decision": {
                                    "status": "planned",
                                    "executedAt": None,
                                },
                                "label": {
                                    "verdict": "approve",
                                    "responseJson": {
                                        "verdict": "approve",
                                        "confidence": 0.9,
                                        "confidence_band": "high",
                                        "calibrated_probabilities": {
                                            "approve": 1.0,
                                            "veto": 0.0,
                                            "adjust": 0.0,
                                            "abstain": 0.0,
                                            "escalate": 0.0,
                                        },
                                        "uncertainty": {"score": 0.0, "band": "low"},
                                        "rationale": "approve",
                                        "required_checks": [],
                                        "risk_flags": [],
                                        "dspy": {"latency_ms": 110, "fallback": False},
                                    },
                                },
                            },
                            {
                                "rowId": "row-2",
                                "split": "eval",
                                "decision": {
                                    "status": "executed",
                                    "executedAt": "2026-03-18T16:00:00Z",
                                },
                                "label": {
                                    "verdict": "veto",
                                    "responseJson": {
                                        "verdict": "veto",
                                        "confidence": 0.95,
                                        "confidence_band": "high",
                                        "calibrated_probabilities": {
                                            "approve": 0.0,
                                            "veto": 1.0,
                                            "adjust": 0.0,
                                            "abstain": 0.0,
                                            "escalate": 0.0,
                                        },
                                        "uncertainty": {"score": 0.0, "band": "low"},
                                        "rationale": "veto",
                                        "required_checks": [],
                                        "risk_flags": [],
                                        "dspy": {"latency_ms": 190, "fallback": True},
                                    },
                                },
                            },
                            {
                                "rowId": "row-3",
                                "split": "test",
                                "decision": {
                                    "status": "planned",
                                    "executedAt": None,
                                },
                                "label": {
                                    "verdict": "approve",
                                    "responseJson": {"fallback": "pass_through"},
                                },
                            },
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            metric_policy_path.write_text(
                "schemaVersion: torghut.dspy.metrics.v1\npolicy: {}\n",
                encoding="utf-8",
            )

            result = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-derived",
                artifact_path=root / "compile",
                dataset_ref=str(dataset_path),
                metric_policy_ref=str(metric_policy_path),
                optimizer="miprov2",
            )

            metric_bundle = result.compile_result.metric_bundle
            self.assertEqual(
                metric_bundle["observedMetricsSource"],
                "torghut.dspy.observed-metrics.v1",
            )
            self.assertEqual(metric_bundle["observedMetricsRows"], 3)
            self.assertEqual(metric_bundle["observedMetricsSchemaValidRows"], 2)
            self.assertEqual(metric_bundle["schemaValidRate"], 2 / 3)
            self.assertEqual(metric_bundle["vetoAlignmentRate"], 1.0)
            self.assertEqual(metric_bundle["falseVetoRate"], 1.0)
            self.assertEqual(metric_bundle["fallbackRate"], 2 / 3)
            self.assertEqual(metric_bundle["latencyP95Ms"], 110)

    def test_compile_rejects_partial_observed_metrics(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
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
                "schemaVersion: torghut.dspy.metrics.v1\npolicy: {}\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "observed_metrics_incomplete"):
                compile_dspy_program_artifacts(
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-compile-test",
                    artifact_path=root / "compile",
                    dataset_ref=str(dataset_path),
                    metric_policy_ref=str(metric_policy_path),
                    optimizer="miprov2",
                    schema_valid_rate=0.998,
                )

    def test_compile_metrics_persist_hashes(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
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
                "schemaVersion: torghut.dspy.metrics.v1\npolicy: {}\n",
                encoding="utf-8",
            )

            result = compile_dspy_program_artifacts(
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-compile-test",
                artifact_path=root / "compile",
                dataset_ref=str(dataset_path),
                metric_policy_ref=str(metric_policy_path),
                optimizer="mipro-v2",
            )

            compile_metrics_payload = json.loads(
                result.compile_metrics_path.read_text(encoding="utf-8")
            )
            self.assertEqual(compile_metrics_payload["optimizer"], "miprov2")
            self.assertEqual(
                compile_metrics_payload["compiledArtifactUri"],
                result.compile_result.compiled_artifact_uri,
            )
            self.assertEqual(
                compile_metrics_payload["artifactHash"],
                result.compile_result.artifact_hash,
            )
            self.assertEqual(
                compile_metrics_payload["reproducibilityHash"],
                result.compile_result.reproducibility_hash,
            )
            self.assertEqual(len(compile_metrics_payload["metricBundleHash"]), 64)

    def test_compile_rejects_non_mipro_optimizer(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
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
                "schemaVersion: torghut.dspy.metrics.v1\npolicy: {}\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "optimizer_must_be_mipro"):
                compile_dspy_program_artifacts(
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-compile-test",
                    artifact_path=root / "compile",
                    dataset_ref=str(dataset_path),
                    metric_policy_ref=str(metric_policy_path),
                    optimizer="gepa",
                )

    def test_compile_rejects_artifact_name_outside_artifact_path(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dspy-dataset.json"
            metric_policy_path = root / "dspy-metrics.yaml"
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
                "schemaVersion: torghut.dspy.metrics.v1\npolicy: {}\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ValueError, "compiled_artifact_name_must_be_file_name"
            ):
                compile_dspy_program_artifacts(
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-compile-test",
                    artifact_path=root / "compile",
                    dataset_ref=str(dataset_path),
                    metric_policy_ref=str(metric_policy_path),
                    optimizer="miprov2",
                    compiled_artifact_name="../escape.json",
                )
