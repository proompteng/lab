from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts import compile_dspy_program


class TestCompileDSPyProgramScript(TestCase):
    def test_assert_repro_guardrails_rejects_wrong_optimizer(self) -> None:
        with self.assertRaisesRegex(ValueError, "optimizer_must_be_miprov2"):
            compile_dspy_program._assert_repro_guardrails(
                artifact_path=compile_dspy_program.REPRO_ARTIFACT_PATH,
                dataset_ref=compile_dspy_program.REPRO_DATASET_REF,
                metric_policy_ref=str(compile_dspy_program.REPRO_METRIC_POLICY_REF),
                optimizer="unsupported",
            )

    def test_resolve_local_ref_supports_file_uri(self) -> None:
        with TemporaryDirectory() as tmp:
            payload = Path(tmp) / "dataset.json"
            payload.write_text("{}", encoding="utf-8")
            resolved = compile_dspy_program._resolve_local_ref(
                f"file://{payload}", field_name="dataset_ref"
            )
            self.assertEqual(resolved, str(payload.resolve()))
