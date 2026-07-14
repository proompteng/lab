from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.trading.llm.dspy_programs.runtime import DSPyReviewRuntime


class TestLLMDSPyRuntimeDuplicateHash(TestCase):
    @staticmethod
    def _fake_session_context(
        row: SimpleNamespace,
        *,
        captured_queries: list[object],
    ) -> object:
        class _FakeResult:
            def scalars(self) -> "_FakeResult":
                return self

            def first(self) -> SimpleNamespace:
                return row

        class _FakeSession:
            def execute(self, query: Any) -> _FakeResult:
                captured_queries.append(query)
                return _FakeResult()

        class _FakeSessionContext:
            def __enter__(self) -> _FakeSession:
                return _FakeSession()

            def __exit__(
                self, exc_type: object, exc: object, tb: object
            ) -> bool | None:
                return None

        return _FakeSessionContext()

    def test_manifest_query_prefers_passing_duplicate_hash_row(self) -> None:
        artifact_hash = "a" * 64
        row = SimpleNamespace(
            artifact_uri="s3://bucket/dspy-compiled-program.json",
            reproducibility_hash="b" * 64,
            optimizer="miprov2",
            dataset_hash="c" * 64,
            compiled_prompt_hash="d" * 64,
            signature_version="trade_review:v1",
            program_name="trade-review-committee-v1",
            gate_compatibility="pass",
            metadata_json={"executor": "dspy_live"},
        )
        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash=artifact_hash,
            program_name=row.program_name,
            signature_version="v1",
            timeout_seconds=8,
        )
        captured_queries: list[object] = []

        with (
            patch(
                "app.db.SessionLocal",
                return_value=self._fake_session_context(
                    row,
                    captured_queries=captured_queries,
                ),
            ),
            patch(
                "app.trading.llm.dspy_programs.runtime.hash_payload",
                return_value=artifact_hash,
            ),
        ):
            manifest = runtime._load_manifest_from_db(artifact_hash)

        self.assertIsNotNone(manifest)
        self.assertEqual(len(captured_queries), 1)
        query_text = str(captured_queries[0])
        self.assertIn("CASE WHEN", query_text)
        self.assertIn("gate_compatibility", query_text)
        self.assertLess(
            query_text.index("gate_compatibility"),
            query_text.index("created_at DESC"),
        )
