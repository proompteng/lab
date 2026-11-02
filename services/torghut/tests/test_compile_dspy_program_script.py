from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts import compile_dspy_program


class TestCompileDSPyProgramScript(TestCase):
    def test_resolve_local_ref_supports_file_uri(self) -> None:
        with TemporaryDirectory() as tmp:
            payload = Path(tmp) / "dataset.json"
            payload.write_text("{}", encoding="utf-8")
            resolved = compile_dspy_program._resolve_local_ref(
                f"file://{payload}", field_name="dataset_ref"
            )
            self.assertEqual(resolved, str(payload.resolve()))
