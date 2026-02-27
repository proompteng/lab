from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, LLMDSPyWorkflowArtifact
from app.trading.llm.dspy_compile import (
    build_compile_result,
    build_dspy_agentrun_payload,
    build_eval_report,
    orchestrate_dspy_agentrun_workflow,
    build_promotion_record,
    upsert_workflow_artifact_record,
    write_artifact_bundle,
)
from app.trading.llm.dspy_compile.workflow import _sanitize_idempotency_key


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
        self.assertEqual(
            payload["implementationSpecRef"]["name"], "torghut-dspy-compile-mipro-v1"
        )
        self.assertEqual(payload["vcsPolicy"]["mode"], "read-write")
        self.assertEqual(
            payload["policy"]["secretBindingRef"], "codex-whitepaper-github-token"
        )
        self.assertEqual(payload["ttlSecondsAfterFinished"], 14400)
        self.assertIsInstance(payload["parameters"]["datasetRef"], str)
        self.assertEqual(payload["parameters"]["issueNumber"], "0")

    def test_build_dspy_agentrun_payload_allows_issue_number_override(self) -> None:
        payload = build_dspy_agentrun_payload(
            lane="dataset-build",
            idempotency_key="torghut-dspy-dataset-abc123",
            repository="proompteng/lab",
            base="main",
            head="codex/torghut-dspy-dataset-2026-02-27",
            artifact_path="artifacts/dspy/run-1",
            parameter_overrides={
                "datasetWindow": "P30D",
                "universeRef": "torghut:equity:enabled",
            },
            issue_number="2125",
        )
        self.assertEqual(payload["parameters"]["issueNumber"], "2125")

    def test_sanitize_idempotency_key_replaces_invalid_chars(self) -> None:
        key = _sanitize_idempotency_key(" :torghut:dspy:run:2026-02-27T07:39:00Z: ")
        self.assertTrue(key)
        self.assertNotIn(":", key)
        self.assertLessEqual(len(key), 63)

    def test_sanitize_idempotency_key_long_values_remain_unique(self) -> None:
        prefix = "torghut-dspy-" + ("x" * 90)
        dataset_key = _sanitize_idempotency_key(f"{prefix}-dataset-build")
        compile_key = _sanitize_idempotency_key(f"{prefix}-compile")

        self.assertLessEqual(len(dataset_key), 63)
        self.assertLessEqual(len(compile_key), 63)
        self.assertNotEqual(dataset_key, compile_key)

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
                response_payload={
                    "resource": {
                        "metadata": {"name": "agentrun-1", "namespace": "agents"}
                    }
                },
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

    def test_orchestrate_dspy_agentrun_workflow_submits_lanes_and_persists_rows(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {"metadata": {"name": "run-dataset", "namespace": "agents"}},
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {"metadata": {"name": "run-compile", "namespace": "agents"}},
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
            {
                "agentRun": {"id": "record-promote"},
                "resource": {"metadata": {"name": "run-promote", "namespace": "agents"}},
            },
        ]

        with patch(
            "app.trading.llm.dspy_compile.workflow.submit_jangar_agentrun",
            side_effect=responses,
        ) as submit_mock:
            with patch(
                "app.trading.llm.dspy_compile.workflow.wait_for_jangar_agentrun_terminal_status",
                side_effect=["succeeded", "succeeded", "succeeded", "succeeded"],
            ) as wait_mock:
                with Session(self.engine) as session:
                    result = orchestrate_dspy_agentrun_workflow(
                        session,
                        base_url="http://jangar.test",
                        repository="proompteng/lab",
                        base="main",
                        head="codex/dspy-rollout",
                        artifact_root="artifacts/dspy/run-1",
                        run_prefix="torghut-dspy-run-1:2026-02-27T07:39:00Z",
                        auth_token="token-123",
                        lane_parameter_overrides={
                            "dataset-build": {
                                "datasetWindow": "P30D",
                                "universeRef": "torghut:equity:enabled",
                            },
                            "compile": {
                                "datasetRef": "artifacts/dspy/run-1/dataset-build/dspy-dataset.json",
                                "metricPolicyRef": "config/trading/llm/dspy-metrics.yaml",
                                "optimizer": "miprov2",
                            },
                            "eval": {
                                "compileResultRef": "artifacts/dspy/run-1/compile/dspy-compile-result.json",
                                "gatePolicyRef": "config/trading/llm/dspy-metrics.yaml",
                            },
                            "promote": {
                                "evalReportRef": "artifacts/dspy/run-1/eval/dspy-eval-report.json",
                                "artifactHash": "a" * 64,
                                "promotionTarget": "constrained_live",
                                "approvalRef": "risk-committee",
                            },
                        },
                        include_gepa_experiment=False,
                        secret_binding_ref="codex-whitepaper-github-token",
                        ttl_seconds_after_finished=3600,
                    )

            self.assertEqual(submit_mock.call_count, 4)
            self.assertEqual(wait_mock.call_count, 4)
            self.assertEqual(
                sorted(result.keys()), ["compile", "dataset-build", "eval", "promote"]
            )
            submitted_idempotency_keys = [
                call.kwargs["idempotency_key"] for call in submit_mock.call_args_list
            ]
            self.assertEqual(len(submitted_idempotency_keys), 4)
            self.assertEqual(len(set(submitted_idempotency_keys)), 4)
            for key in submitted_idempotency_keys:
                self.assertNotIn(":", key)
                self.assertLessEqual(len(key), 63)
            for call in submit_mock.call_args_list:
                payload = call.kwargs["payload"]
                self.assertEqual(payload["parameters"]["issueNumber"], "0")

        with Session(self.engine) as session:
            rows = session.execute(select(LLMDSPyWorkflowArtifact)).scalars().all()
            self.assertEqual(len(rows), 4)
            lane_by_run_key = {row.run_key: row.lane for row in rows}
            self.assertEqual(
                lane_by_run_key[
                    "torghut-dspy-run-1:2026-02-27T07:39:00Z:dataset-build"
                ],
                "dataset-build",
            )
            self.assertEqual(
                lane_by_run_key["torghut-dspy-run-1:2026-02-27T07:39:00Z:compile"],
                "compile",
            )
            self.assertEqual(
                lane_by_run_key["torghut-dspy-run-1:2026-02-27T07:39:00Z:eval"],
                "eval",
            )
            self.assertEqual(
                lane_by_run_key["torghut-dspy-run-1:2026-02-27T07:39:00Z:promote"],
                "promote",
            )
            for row in rows:
                self.assertTrue(row.idempotency_key)
                idempotency_key = str(row.idempotency_key)
                self.assertNotIn(":", idempotency_key)
                self.assertLessEqual(len(idempotency_key), 63)

    def test_orchestrate_dspy_agentrun_workflow_persists_submitted_lanes_before_failure(
        self,
    ) -> None:
        submit_side_effects = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {"metadata": {"name": "run-dataset", "namespace": "agents"}},
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {"metadata": {"name": "run-compile", "namespace": "agents"}},
            },
            RuntimeError("submit_failed"),
        ]

        with patch(
            "app.trading.llm.dspy_compile.workflow.submit_jangar_agentrun",
            side_effect=submit_side_effects,
        ) as submit_mock:
            with patch(
                "app.trading.llm.dspy_compile.workflow.wait_for_jangar_agentrun_terminal_status",
                side_effect=["succeeded", "succeeded"],
            ) as wait_mock:
                with self.assertRaisesRegex(RuntimeError, "submit_failed"):
                    with Session(self.engine) as session:
                        orchestrate_dspy_agentrun_workflow(
                            session,
                            base_url="http://jangar.test",
                            repository="proompteng/lab",
                            base="main",
                            head="codex/dspy-rollout",
                            artifact_root="artifacts/dspy/run-2",
                            run_prefix="torghut-dspy-run-2",
                            auth_token="token-123",
                            lane_parameter_overrides={
                                "dataset-build": {
                                    "datasetWindow": "P30D",
                                    "universeRef": "torghut:equity:enabled",
                                },
                                "compile": {
                                    "datasetRef": "artifacts/dspy/run-2/dataset-build/dspy-dataset.json",
                                    "metricPolicyRef": "config/trading/llm/dspy-metrics.yaml",
                                    "optimizer": "miprov2",
                                },
                                "eval": {
                                    "compileResultRef": "artifacts/dspy/run-2/compile/dspy-compile-result.json",
                                    "gatePolicyRef": "config/trading/llm/dspy-metrics.yaml",
                                },
                                "promote": {
                                    "evalReportRef": "artifacts/dspy/run-2/eval/dspy-eval-report.json",
                                    "artifactHash": "b" * 64,
                                    "promotionTarget": "constrained_live",
                                    "approvalRef": "risk-committee",
                                },
                            },
                            include_gepa_experiment=False,
                            secret_binding_ref="codex-whitepaper-github-token",
                            ttl_seconds_after_finished=3600,
                        )

            self.assertEqual(submit_mock.call_count, 3)
            self.assertEqual(wait_mock.call_count, 2)

        with Session(self.engine) as session:
            rows = session.execute(select(LLMDSPyWorkflowArtifact)).scalars().all()
            run_keys = sorted(row.run_key for row in rows)
            self.assertEqual(
                run_keys,
                [
                    "torghut-dspy-run-2:compile",
                    "torghut-dspy-run-2:dataset-build",
                ],
            )

    def test_orchestrate_dspy_agentrun_workflow_blocks_when_prior_lane_fails(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {"metadata": {"name": "run-dataset", "namespace": "agents"}},
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {"metadata": {"name": "run-compile", "namespace": "agents"}},
            },
        ]

        with patch(
            "app.trading.llm.dspy_compile.workflow.submit_jangar_agentrun",
            side_effect=responses,
        ) as submit_mock:
            with patch(
                "app.trading.llm.dspy_compile.workflow.wait_for_jangar_agentrun_terminal_status",
                side_effect=["failed"],
            ) as wait_mock:
                with self.assertRaisesRegex(
                    RuntimeError, "jangar_agentrun_not_succeeded:dataset-build:failed"
                ):
                    with Session(self.engine) as session:
                        orchestrate_dspy_agentrun_workflow(
                            session,
                            base_url="http://jangar.test",
                            repository="proompteng/lab",
                            base="main",
                            head="codex/dspy-rollout",
                            artifact_root="artifacts/dspy/run-3",
                            run_prefix="torghut-dspy-run-3",
                            auth_token="token-123",
                            lane_parameter_overrides={
                                "dataset-build": {
                                    "datasetWindow": "P30D",
                                    "universeRef": "torghut:equity:enabled",
                                },
                                "compile": {
                                    "datasetRef": "artifacts/dspy/run-3/dataset-build/dspy-dataset.json",
                                    "metricPolicyRef": "config/trading/llm/dspy-metrics.yaml",
                                    "optimizer": "miprov2",
                                },
                                "eval": {
                                    "compileResultRef": "artifacts/dspy/run-3/compile/dspy-compile-result.json",
                                    "gatePolicyRef": "config/trading/llm/dspy-metrics.yaml",
                                },
                                "promote": {
                                    "evalReportRef": "artifacts/dspy/run-3/eval/dspy-eval-report.json",
                                    "artifactHash": "c" * 64,
                                    "promotionTarget": "constrained_live",
                                    "approvalRef": "risk-committee",
                                },
                            },
                            include_gepa_experiment=False,
                            secret_binding_ref="codex-whitepaper-github-token",
                            ttl_seconds_after_finished=3600,
                        )

            self.assertEqual(submit_mock.call_count, 1)
            self.assertEqual(wait_mock.call_count, 1)
