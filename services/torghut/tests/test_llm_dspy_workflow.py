from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, LLMDSPyWorkflowArtifact
from app.trading.llm.dspy_compile import (
    build_compile_result,
    build_dspy_agentrun_payload,
    build_eval_report,
    build_promotion_record,
    upsert_workflow_artifact_record,
    write_artifact_bundle,
)


class TestLLMDSPyWorkflow(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_compile_result_is_deterministic(self) -> None:
        kwargs = {
            "program_name": "trade-review-committee-v1",
            "signature_versions": {"trade_review": "v1"},
            "optimizer": "miprov2",
            "dataset_payload": {"rows": [{"a": 1}, {"a": 2}]},
            "metric_bundle": {"schema_valid_rate": 0.999, "veto_alignment_rate": 0.87},
            "compiled_prompt_payload": {"prompt": "json-only advisory policy"},
            "compiled_artifact_uri": "s3://torghut-dspy/compile/result.json",
            "seed": "seed-42",
        }
        first = build_compile_result(**kwargs)
        second = build_compile_result(**kwargs)
        self.assertEqual(first.dataset_hash, second.dataset_hash)
        self.assertEqual(first.compiled_prompt_hash, second.compiled_prompt_hash)
        self.assertEqual(first.reproducibility_hash, second.reproducibility_hash)
        self.assertEqual(first.artifact_hash, second.artifact_hash)

    def test_bundle_writes_auditable_json_artifacts(self) -> None:
        compile_result = build_compile_result(
            program_name="trade-review-committee-v1",
            signature_versions={"trade_review": "v1"},
            optimizer="miprov2",
            dataset_payload={"rows": [{"a": 1}]},
            metric_bundle={"schema_valid_rate": 1.0},
            compiled_prompt_payload={"prompt": "json"},
            compiled_artifact_uri="s3://bucket/compile.json",
            seed="seed-1",
        )
        eval_report = build_eval_report(
            compile_result=compile_result,
            schema_valid_rate=1.0,
            veto_alignment_rate=0.9,
            false_veto_rate=0.01,
            latency_p95_ms=900,
            gate_compatibility="pass",
            promotion_recommendation="paper",
            metric_bundle={"sample_count": 42},
        )
        promotion_record = build_promotion_record(
            eval_report=eval_report,
            promotion_target="paper",
            approved=True,
            approval_token_ref="token-ref-1",
            promoted_by="risk-committee",
        )

        with TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            hashes = write_artifact_bundle(
                output_dir,
                compile_result=compile_result,
                eval_report=eval_report,
                promotion_record=promotion_record,
            )
            self.assertIn("dspy-compile-result.json", hashes)
            self.assertIn("dspy-eval-report.json", hashes)
            self.assertIn("dspy-promotion-record.json", hashes)
            self.assertIn("dspy-bundle.json", hashes)
            for name in hashes:
                self.assertTrue((output_dir / name).exists())

    def test_build_dspy_agentrun_payload_enforces_contract(self) -> None:
        payload = build_dspy_agentrun_payload(
            lane="compile",
            idempotency_key="torghut-dspy-compile-abc123",
            repository="proompteng/lab",
            base="main",
            head="codex/torghut-dspy-compile-2026-02-25",
            artifact_path="artifacts/dspy/run-1",
            parameter_overrides={
                "datasetRef": "s3://dataset/path.json",
                "metricPolicyRef": "config/trading/llm/dspy-metrics.yaml",
            },
            secret_binding_ref="codex-whitepaper-github-token",
            ttl_seconds_after_finished=14400,
        )

        self.assertEqual(payload["idempotencyKey"], "torghut-dspy-compile-abc123")
        self.assertEqual(payload["implementationSpecRef"]["name"], "torghut-dspy-compile-mipro-v1")
        self.assertEqual(payload["vcsPolicy"]["mode"], "read-write")
        self.assertEqual(payload["policy"]["secretBindingRef"], "codex-whitepaper-github-token")
        self.assertEqual(payload["ttlSecondsAfterFinished"], 14400)
        self.assertIsInstance(payload["parameters"]["datasetRef"], str)

    def test_upsert_workflow_artifact_record_persists_audit_row(self) -> None:
        compile_result = build_compile_result(
            program_name="trade-review-committee-v1",
            signature_versions={"trade_review": "v1"},
            optimizer="miprov2",
            dataset_payload={"rows": [{"a": 1}]},
            metric_bundle={"schema_valid_rate": 1.0},
            compiled_prompt_payload={"prompt": "json"},
            compiled_artifact_uri="s3://bucket/compile.json",
            seed="seed-1",
        )
        eval_report = build_eval_report(
            compile_result=compile_result,
            schema_valid_rate=1.0,
            veto_alignment_rate=0.9,
            false_veto_rate=0.01,
            latency_p95_ms=900,
            gate_compatibility="pass",
            promotion_recommendation="paper",
            metric_bundle={"sample_count": 42},
        )
        promotion_record = build_promotion_record(
            eval_report=eval_report,
            promotion_target="paper",
            approved=True,
            approval_token_ref="token-ref-1",
            promoted_by="risk-committee",
        )
        with Session(self.engine) as session:
            row = upsert_workflow_artifact_record(
                session,
                run_key="torghut-dspy-compile-1",
                lane="compile",
                status="completed",
                implementation_spec_ref="torghut-dspy-compile-mipro-v1",
                idempotency_key="torghut-dspy-compile-1",
                request_payload={"runtime": {"type": "job"}},
                response_payload={"resource": {"metadata": {"name": "agentrun-1", "namespace": "agents"}}},
                compile_result=compile_result,
                eval_report=eval_report,
                promotion_record=promotion_record,
                metadata={"source": "test"},
            )
            session.commit()

            loaded = session.execute(select(LLMDSPyWorkflowArtifact)).scalar_one()
            self.assertEqual(row.id, loaded.id)
            self.assertEqual(loaded.run_key, "torghut-dspy-compile-1")
            self.assertEqual(loaded.artifact_hash, compile_result.artifact_hash)
            self.assertEqual(loaded.gate_compatibility, "pass")
            self.assertEqual(loaded.promotion_target, "paper")
