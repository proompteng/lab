from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.llm_dspy_workflow.support import (
    LLMDSPyWorkflowArtifact,
    Path,
    Session,
    TemporaryDirectory,
    _TestLLMDSPyWorkflowBase,
    _build_dspy_lane_overrides,
    _write_dspy_promotion_eval_snapshot,
    datetime,
    json,
    orchestrate_dspy_agentrun_workflow,
    patch,
    select,
    timezone,
)


class TestOrchestrateDspyAgentrunWorkflowBlocksPromotionOnGateFailure(
    _TestLLMDSPyWorkflowBase
):
    def test_orchestrate_dspy_agentrun_workflow_blocks_promotion_on_gate_failure(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
        ]

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-4"
            _write_dspy_promotion_eval_snapshot(
                artifact_root=artifact_root,
                created_at=datetime.now(timezone.utc),
                gate_compatibility="fail",
                schema_valid_rate=0.91,
                deterministic_compatibility=False,
                fallback_rate=0.42,
            )
            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "artifactHash": "d" * 64,
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "dspy_promotion_gate_blocked:gate_compatibility_not_pass,schema_valid_rate_below_min,deterministic_compatibility_failed,fallback_rate_above_max",
                    ):
                        with Session(self.engine) as session:
                            orchestrate_dspy_agentrun_workflow(
                                session,
                                base_url="http://jangar.test",
                                repository="proompteng/lab",
                                base="main",
                                head="codex/dspy-rollout",
                                artifact_root=str(artifact_root),
                                run_prefix="torghut-dspy-run-4",
                                auth_token="token-123",
                                lane_parameter_overrides=lane_overrides,
                                include_gepa_experiment=False,
                                secret_binding_ref="codex-whitepaper-github-token",
                                ttl_seconds_after_finished=3600,
                            )

                self.assertEqual(submit_mock.call_count, 3)
                self.assertEqual(wait_mock.call_count, 3)

        with Session(self.engine) as session:
            row = session.execute(
                select(LLMDSPyWorkflowArtifact).where(
                    LLMDSPyWorkflowArtifact.run_key == "torghut-dspy-run-4:promote"
                )
            ).scalar_one()
            self.assertEqual(row.status, "blocked")
            metadata = row.metadata_json or {}
            self.assertIsInstance(metadata, dict)
            orchestration = metadata.get("orchestration")
            self.assertIsInstance(orchestration, dict)
            gate_failures = orchestration.get("gateFailures") or []
            self.assertIn(
                "gate_compatibility_not_pass",
                gate_failures,
            )

    def test_orchestrate_dspy_agentrun_workflow_ignores_promotion_gate_overrides(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
            {
                "agentRun": {"id": "record-promote"},
                "resource": {
                    "metadata": {"name": "run-promote", "namespace": "agents"}
                },
            },
        ]

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-immutable"
            _write_dspy_promotion_eval_snapshot(
                artifact_root=artifact_root,
                created_at=datetime.now(timezone.utc),
                gate_compatibility="pass",
                schema_valid_rate=0.999,
                deterministic_compatibility=True,
                fallback_rate=0.01,
            )
            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "artifactHash": "override-hash",
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                    "evalReportRef": f"{artifact_root}/eval/dspy-eval-report.json",
                    "gateCompatibility": "fail",
                    "schemaValidRate": "0.001",
                    "deterministicCompatibility": "fail",
                    "fallbackRate": "0.99",
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with Session(self.engine) as session:
                        orchestrate_dspy_agentrun_workflow(
                            session,
                            base_url="http://jangar.test",
                            repository="proompteng/lab",
                            base="main",
                            head="codex/dspy-rollout",
                            artifact_root=str(artifact_root),
                            run_prefix="torghut-dspy-run-immutable",
                            auth_token="token-123",
                            lane_parameter_overrides=lane_overrides,
                            include_gepa_experiment=False,
                            secret_binding_ref="codex-whitepaper-github-token",
                            ttl_seconds_after_finished=3600,
                        )

            self.assertEqual(submit_mock.call_count, 4)
            self.assertEqual(wait_mock.call_count, 4)
            promote_payload = submit_mock.call_args_list[3].kwargs["payload"]
            promote_parameters = promote_payload["parameters"]
            self.assertEqual(promote_parameters["approvalRef"], "risk-committee")
            self.assertEqual(promote_parameters["promotionTarget"], "constrained_live")
            self.assertEqual(promote_parameters["artifactHash"], "override-hash")
            self.assertNotIn("gateCompatibility", promote_parameters)
            self.assertNotIn("schemaValidRate", promote_parameters)
            self.assertNotIn("deterministicCompatibility", promote_parameters)
            self.assertNotIn("fallbackRate", promote_parameters)
            self.assertEqual(
                promote_parameters["evalReportRef"],
                f"{artifact_root}/eval/dspy-eval-report.json",
            )

    def test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_override_is_internal_but_not_canonical(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
        ]

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-override"
            alternate_eval_path = artifact_root / "alternate" / "dspy-eval-report.json"
            alternate_eval_path.parent.mkdir(parents=True, exist_ok=True)
            alternate_eval_path.write_text(
                json.dumps(
                    {"createdAt": datetime.now(timezone.utc).isoformat()}, default=str
                ),
                encoding="utf-8",
            )
            _write_dspy_promotion_eval_snapshot(
                artifact_root=artifact_root,
                created_at=datetime.now(timezone.utc),
            )
            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                    "evalReportRef": str(alternate_eval_path),
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "dspy_promotion_gate_blocked:eval_report_reference_override_disallowed",
                    ):
                        with Session(self.engine) as session:
                            orchestrate_dspy_agentrun_workflow(
                                session,
                                base_url="http://jangar.test",
                                repository="proompteng/lab",
                                base="main",
                                head="codex/dspy-rollout",
                                artifact_root=str(artifact_root),
                                run_prefix="torghut-dspy-run-override-internal",
                                auth_token="token-123",
                                lane_parameter_overrides=lane_overrides,
                                include_gepa_experiment=False,
                                secret_binding_ref="codex-whitepaper-github-token",
                                ttl_seconds_after_finished=3600,
                            )

            self.assertEqual(submit_mock.call_count, 3)
            self.assertEqual(wait_mock.call_count, 3)

        with Session(self.engine) as session:
            row = session.execute(
                select(LLMDSPyWorkflowArtifact).where(
                    LLMDSPyWorkflowArtifact.run_key
                    == "torghut-dspy-run-override-internal:promote"
                )
            ).scalar_one()
            metadata = row.metadata_json or {}
            self.assertIsInstance(metadata, dict)
            orchestration = metadata.get("orchestration")
            self.assertIsInstance(orchestration, dict)
            gate_failures = orchestration.get("gateFailures") or []
            self.assertIn("eval_report_reference_override_disallowed", gate_failures)

    def test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_missing(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
        ]

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-missing"
            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "dspy_promotion_gate_blocked:eval_report_not_found,eval_report_created_at_missing",
                    ):
                        with Session(self.engine) as session:
                            orchestrate_dspy_agentrun_workflow(
                                session,
                                base_url="http://jangar.test",
                                repository="proompteng/lab",
                                base="main",
                                head="codex/dspy-rollout",
                                artifact_root=str(artifact_root),
                                run_prefix="torghut-dspy-run-missing",
                                auth_token="token-123",
                                lane_parameter_overrides=lane_overrides,
                                include_gepa_experiment=False,
                                secret_binding_ref="codex-whitepaper-github-token",
                                ttl_seconds_after_finished=3600,
                            )

            self.assertEqual(submit_mock.call_count, 3)
            self.assertEqual(wait_mock.call_count, 3)

        with Session(self.engine) as session:
            row = session.execute(
                select(LLMDSPyWorkflowArtifact).where(
                    LLMDSPyWorkflowArtifact.run_key
                    == "torghut-dspy-run-missing:promote"
                )
            ).scalar_one()
            self.assertEqual(row.status, "blocked")
            metadata = row.metadata_json or {}
            self.assertIsInstance(metadata, dict)
            orchestration = metadata.get("orchestration")
            self.assertIsInstance(orchestration, dict)
            gate_failures = orchestration.get("gateFailures") or []
            self.assertIn("eval_report_not_found", gate_failures)

    def test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_stale(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
        ]
        stale_time = datetime(2026, 2, 25, 7, 45, tzinfo=timezone.utc)

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-stale"
            _write_dspy_promotion_eval_snapshot(
                artifact_root=artifact_root,
                created_at=stale_time,
                gate_compatibility="pass",
            )
            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with self.assertRaisesRegex(
                        RuntimeError, "dspy_promotion_gate_blocked:eval_report_stale"
                    ):
                        with Session(self.engine) as session:
                            orchestrate_dspy_agentrun_workflow(
                                session,
                                base_url="http://jangar.test",
                                repository="proompteng/lab",
                                base="main",
                                head="codex/dspy-rollout",
                                artifact_root=str(artifact_root),
                                run_prefix="torghut-dspy-run-stale",
                                auth_token="token-123",
                                lane_parameter_overrides=lane_overrides,
                                include_gepa_experiment=False,
                                secret_binding_ref="codex-whitepaper-github-token",
                                ttl_seconds_after_finished=3600,
                            )

            self.assertEqual(submit_mock.call_count, 3)
            self.assertEqual(wait_mock.call_count, 3)

        with Session(self.engine) as session:
            row = session.execute(
                select(LLMDSPyWorkflowArtifact).where(
                    LLMDSPyWorkflowArtifact.run_key == "torghut-dspy-run-stale:promote"
                )
            ).scalar_one()
            metadata = row.metadata_json or {}
            self.assertIsInstance(metadata, dict)
            orchestration = metadata.get("orchestration")
            self.assertIsInstance(orchestration, dict)
            gate_failures = orchestration.get("gateFailures") or []
            self.assertIn("eval_report_stale", gate_failures)

    def test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_path_is_untrusted(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
        ]

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-untrusted"
            untrusted_eval_path = Path(tmpdir) / "outside" / "dspy-eval-report.json"
            _write_dspy_promotion_eval_snapshot(
                artifact_root=artifact_root,
                created_at=datetime(2026, 2, 27, 7, 45, tzinfo=timezone.utc),
            )
            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                    "evalReportRef": str(untrusted_eval_path),
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "dspy_promotion_gate_blocked:eval_report_outside_artifact_root",
                    ):
                        with Session(self.engine) as session:
                            orchestrate_dspy_agentrun_workflow(
                                session,
                                base_url="http://jangar.test",
                                repository="proompteng/lab",
                                base="main",
                                head="codex/dspy-rollout",
                                artifact_root=str(artifact_root),
                                run_prefix="torghut-dspy-run-untrusted",
                                auth_token="token-123",
                                lane_parameter_overrides=lane_overrides,
                                include_gepa_experiment=False,
                                secret_binding_ref="codex-whitepaper-github-token",
                                ttl_seconds_after_finished=3600,
                            )

            self.assertEqual(submit_mock.call_count, 3)
            self.assertEqual(wait_mock.call_count, 3)

        with Session(self.engine) as session:
            row = session.execute(
                select(LLMDSPyWorkflowArtifact).where(
                    LLMDSPyWorkflowArtifact.run_key
                    == "torghut-dspy-run-untrusted:promote"
                )
            ).scalar_one()
            metadata = row.metadata_json or {}
            self.assertIsInstance(metadata, dict)
            orchestration = metadata.get("orchestration")
            self.assertIsInstance(orchestration, dict)
            gate_failures = orchestration.get("gateFailures") or []
            self.assertIn("eval_report_outside_artifact_root", gate_failures)

    def test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_override_changes_path(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
        ]

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-override"
            alternate_eval_path = (
                artifact_root / "eval" / "dspy-eval-report-override.json"
            )
            _write_dspy_promotion_eval_snapshot(
                artifact_root=artifact_root,
                created_at=datetime.now(timezone.utc),
            )
            alternate_eval_snapshot = {
                "schemaVersion": "torghut.dspy.eval-report.v1",
                "artifactHash": "a" * 64,
                "schemaValidRate": 0.999,
                "gateCompatibility": "pass",
                "metricBundle": {},
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
            alternate_eval_path.parent.mkdir(parents=True, exist_ok=True)
            alternate_eval_path.write_text(
                json.dumps(alternate_eval_snapshot), encoding="utf-8"
            )

            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                    "evalReportRef": str(alternate_eval_path),
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "dspy_promotion_gate_blocked:eval_report_reference_override_disallowed",
                    ):
                        with Session(self.engine) as session:
                            orchestrate_dspy_agentrun_workflow(
                                session,
                                base_url="http://jangar.test",
                                repository="proompteng/lab",
                                base="main",
                                head="codex/dspy-rollout",
                                artifact_root=str(artifact_root),
                                run_prefix="torghut-dspy-run-override",
                                auth_token="token-123",
                                lane_parameter_overrides=lane_overrides,
                                include_gepa_experiment=False,
                                secret_binding_ref="codex-whitepaper-github-token",
                                ttl_seconds_after_finished=3600,
                            )

            self.assertEqual(submit_mock.call_count, 3)
            self.assertEqual(wait_mock.call_count, 3)

        with Session(self.engine) as session:
            row = session.execute(
                select(LLMDSPyWorkflowArtifact).where(
                    LLMDSPyWorkflowArtifact.run_key
                    == "torghut-dspy-run-override:promote"
                )
            ).scalar_one()
            self.assertEqual(row.status, "blocked")
            metadata = row.metadata_json or {}
            self.assertIsInstance(metadata, dict)
            orchestration = metadata.get("orchestration")
            self.assertIsInstance(orchestration, dict)
            gate_failures = orchestration.get("gateFailures") or []
            self.assertIn("eval_report_reference_override_disallowed", gate_failures)

    def test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_payload_is_invalid(
        self,
    ) -> None:
        responses = [
            {
                "agentRun": {"id": "record-dataset"},
                "resource": {
                    "metadata": {"name": "run-dataset", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-compile"},
                "resource": {
                    "metadata": {"name": "run-compile", "namespace": "agents"}
                },
            },
            {
                "agentRun": {"id": "record-eval"},
                "resource": {"metadata": {"name": "run-eval", "namespace": "agents"}},
            },
        ]

        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-invalid"
            eval_output_path = artifact_root / "eval" / "dspy-eval-report.json"
            eval_output_path.parent.mkdir(parents=True, exist_ok=True)
            eval_output_path.write_text("[]", encoding="utf-8")
            lane_overrides = _build_dspy_lane_overrides(
                artifact_root=artifact_root,
                promote_overrides={
                    "approvalRef": "risk-committee",
                    "promotionTarget": "constrained_live",
                },
            )

            with patch(
                "app.trading.llm.dspy_compile.workflow.submit_agents_agentrun",
                side_effect=responses,
            ) as submit_mock:
                with patch(
                    "app.trading.llm.dspy_compile.workflow.wait_for_agents_agentrun_terminal_status",
                    side_effect=["succeeded", "succeeded", "succeeded"],
                ) as wait_mock:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "dspy_promotion_gate_blocked:eval_report_invalid_payload",
                    ):
                        with Session(self.engine) as session:
                            orchestrate_dspy_agentrun_workflow(
                                session,
                                base_url="http://jangar.test",
                                repository="proompteng/lab",
                                base="main",
                                head="codex/dspy-rollout",
                                artifact_root=str(artifact_root),
                                run_prefix="torghut-dspy-run-invalid",
                                auth_token="token-123",
                                lane_parameter_overrides=lane_overrides,
                                include_gepa_experiment=False,
                                secret_binding_ref="codex-whitepaper-github-token",
                                ttl_seconds_after_finished=3600,
                            )

            self.assertEqual(submit_mock.call_count, 3)
            self.assertEqual(wait_mock.call_count, 3)

        with Session(self.engine) as session:
            row = session.execute(
                select(LLMDSPyWorkflowArtifact).where(
                    LLMDSPyWorkflowArtifact.run_key
                    == "torghut-dspy-run-invalid:promote"
                )
            ).scalar_one()
            metadata = row.metadata_json or {}
            self.assertIsInstance(metadata, dict)
            orchestration = metadata.get("orchestration")
            self.assertIsInstance(orchestration, dict)
            gate_failures = orchestration.get("gateFailures") or []
            self.assertIn("eval_report_invalid_payload", gate_failures)
