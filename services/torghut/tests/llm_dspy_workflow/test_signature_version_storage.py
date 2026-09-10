from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import LLMDSPyWorkflowArtifact
from app.trading.llm.dspy_compile import (
    build_compile_result,
    upsert_workflow_artifact_record,
)
from app.trading.llm.dspy_compile.hashing import hash_payload
from app.trading.llm.dspy_programs.runtime import (
    DSPyRuntimeUnsupportedStateError,
    _resolve_signature_versions,
    _validate_signature_versions_identity,
)
from tests.llm_dspy_workflow.support import _TestLLMDSPyWorkflowBase


class TestSignatureVersionStorage(_TestLLMDSPyWorkflowBase):
    def test_persists_bounded_identity_and_complete_mapping(self) -> None:
        signature_versions = {
            f"committee_{index}": f"version-{index}-{'x' * 24}" for index in range(8)
        }
        compile_result = build_compile_result(
            program_name="trade-review-committee-v1",
            signature_versions=signature_versions,
            optimizer="miprov2",
            dataset_payload={"rows": [{"a": 1}]},
            metric_bundle={"schema_valid_rate": 1.0},
            compiled_prompt_payload={"prompt": "json"},
            compiled_artifact_uri="s3://bucket/compile.json",
            seed="seed-1",
        )

        with Session(self.engine) as session:
            upsert_workflow_artifact_record(
                session,
                run_key="torghut-dspy-signature-map-1",
                lane="compile",
                status="completed",
                implementation_spec_ref="torghut-dspy-compile-mipro-v1",
                idempotency_key="torghut-dspy-signature-map-1",
                request_payload=None,
                response_payload=None,
                compile_result=compile_result,
                eval_report=None,
                promotion_record=None,
                metadata={"source": "test"},
            )
            session.commit()

            loaded = session.execute(select(LLMDSPyWorkflowArtifact)).scalar_one()
            assert loaded.signature_version is not None
            self.assertEqual(len(loaded.signature_version), 64)
            self.assertEqual(
                loaded.signature_version,
                hash_payload({"signature_versions": signature_versions}),
            )
            self.assertIsInstance(loaded.metadata_json, dict)
            assert isinstance(loaded.metadata_json, dict)
            self.assertEqual(
                loaded.metadata_json.get("signature_versions"),
                signature_versions,
            )
            self.assertEqual(loaded.metadata_json.get("source"), "test")

    def test_runtime_prefers_metadata_and_keeps_legacy_fallback(self) -> None:
        signature_versions = {
            "trade_review": "v7",
            "risk_review": "v3",
        }
        identity = hash_payload({"signature_versions": signature_versions})

        resolved = _resolve_signature_versions(
            metadata={"signature_versions": signature_versions},
            legacy_signature_version=identity,
            fallback_signature_version="v1",
        )
        self.assertEqual(resolved, signature_versions)
        _validate_signature_versions_identity(
            persisted_identity=identity,
            signature_versions=resolved,
        )
        self.assertEqual(
            _resolve_signature_versions(
                metadata={},
                legacy_signature_version="trade_review:v2,risk_review:v4",
                fallback_signature_version="v1",
            ),
            {"trade_review": "v2", "risk_review": "v4"},
        )

    def test_runtime_rejects_mapping_identity_mismatch(self) -> None:
        with self.assertRaisesRegex(
            DSPyRuntimeUnsupportedStateError,
            "dspy_signature_versions_identity_mismatch",
        ):
            _validate_signature_versions_identity(
                persisted_identity="a" * 64,
                signature_versions={"trade_review": "v1"},
            )
