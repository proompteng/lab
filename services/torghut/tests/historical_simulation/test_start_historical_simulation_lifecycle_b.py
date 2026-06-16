from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    Any,
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    ExitStack,
    KafkaRuntimeConfig,
    Path,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    SimpleNamespace,
    StartHistoricalSimulationTestCaseBase,
    _build_resources,
    _run_full_lifecycle,
    patch,
    start_historical_simulation,
)


class TestStartHistoricalSimulationLifecycleB(StartHistoricalSimulationTestCaseBase):
    def test_run_full_lifecycle_runs_autonomy_lane_when_enabled(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=False,
            applicationset_name="product",
            applicationset_namespace="argocd",
            app_name="torghut",
            root_app_name="root",
            desired_mode_during_run="manual",
            restore_mode_after_run="previous",
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=False,
            namespace="agents",
            runtime_template="torghut-runtime-ready-v1",
            activity_template="torghut-sim-activity-v1",
            teardown_template="torghut-teardown-v1",
            artifact_template="torghut-artifact-v1",
            verify_timeout_seconds=900,
            verify_poll_seconds=5,
        )
        autonomy_config = start_historical_simulation.AutonomyLaneConfig(
            enabled=True,
            signals_path=Path("/tmp/signals.json"),
            strategy_config_path=Path("/tmp/strategy.yaml"),
            gate_policy_path=Path("/tmp/gate-policy.json"),
            output_dir=Path("/tmp/autonomy"),
            artifact_path=Path("/tmp/autonomy"),
            repository="proompteng/lab",
            base="main",
            head="codex/strategy-factory",
            priority_id="ARC-2000",
            promotion_target="paper",
        )
        call_order: list[str] = []

        with (
            patch(
                "scripts.start_historical_simulation._ensure_supported_binary",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation._update_run_state",
                return_value=None,
            ),
            patch("scripts.start_historical_simulation._save_json", return_value=None),
            patch(
                "scripts.start_historical_simulation.persist_completion_trace",
                return_value={},
            ),
            patch(
                "scripts.start_historical_simulation.SessionLocal"
            ) as mock_session_local,
            patch(
                "scripts.start_historical_simulation._prepare_argocd_for_run",
                return_value={"managed": False},
            ),
            patch(
                "scripts.start_historical_simulation._restore_argocd_after_run",
                return_value={"managed": False},
            ),
            patch(
                "scripts.start_historical_simulation._apply",
                side_effect=lambda **_: call_order.append("apply") or {"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation._runtime_verify",
                side_effect=lambda **_: (
                    call_order.append("runtime_verify") or {"runtime_state": "ready"}
                ),
            ),
            patch(
                "scripts.start_historical_simulation._replay_dump",
                side_effect=lambda **_: call_order.append("replay") or {"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation._monitor_run_completion",
                side_effect=lambda **_: (
                    call_order.append("monitor")
                    or {
                        "status": "ok",
                        "activity_classification": "success",
                        "final_snapshot": {
                            "signal_rows": 5,
                            "price_rows": 5,
                            "trade_decisions": 3,
                            "cursor_at": "2026-02-27T21:00:00Z",
                            "executions": 2,
                            "execution_tca_metrics": 2,
                            "execution_order_events": 2,
                        },
                    }
                ),
            ),
            patch(
                "scripts.start_historical_simulation._report_simulation",
                side_effect=lambda **_: call_order.append("report") or {"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation.run_autonomous_lane",
                side_effect=lambda **kwargs: (
                    call_order.append("autonomy")
                    or SimpleNamespace(
                        run_id="auto-run",
                        candidate_id="cand-auto",
                        output_dir=kwargs["output_dir"],
                        gate_report_path=Path(
                            "/tmp/autonomy/gates/gate-evaluation.json"
                        ),
                        actuation_intent_path=None,
                        paper_patch_path=None,
                        phase_manifest_path=Path(
                            "/tmp/autonomy/rollout/phase-manifest.json"
                        ),
                        recommendation_artifact_path=Path(
                            "/tmp/autonomy/gates/recommendation.json"
                        ),
                        candidate_spec_path=Path(
                            "/tmp/autonomy/research/candidate-spec.json"
                        ),
                        candidate_generation_manifest_path=Path(
                            "/tmp/autonomy/stages/candidate-generation.json"
                        ),
                        evaluation_manifest_path=Path(
                            "/tmp/autonomy/stages/evaluation.json"
                        ),
                        recommendation_manifest_path=Path(
                            "/tmp/autonomy/stages/recommendation.json"
                        ),
                        profitability_manifest_path=Path(
                            "/tmp/autonomy/profitability/profitability-stage.json"
                        ),
                        benchmark_parity_path=Path(
                            "/tmp/autonomy/gates/benchmark-parity.json"
                        ),
                        foundation_router_parity_path=Path(
                            "/tmp/autonomy/router/foundation-router-parity.json"
                        ),
                        stage_trace_ids={"evaluation": "trace-1"},
                        stage_lineage_root="lineage-root",
                    )
                ),
            ) as autonomy_mock,
            patch(
                "scripts.start_historical_simulation._build_strategy_proof_artifact",
                return_value={"status": "ok", "legacy_path_count": 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            report = _run_full_lifecycle(
                resources=resources,
                manifest=manifest,
                manifest_path=Path("/tmp/manifest.json"),
                autonomy_config=autonomy_config,
                kafka_config=kafka_config,
                clickhouse_config=clickhouse_config,
                postgres_config=postgres_config,
                argocd_config=argocd_config,
                rollouts_config=rollouts_config,
                force_dump=False,
                force_replay=False,
                skip_teardown=True,
                report_only=False,
            )

        self.assertEqual(
            call_order,
            ["apply", "runtime_verify", "replay", "monitor", "report", "autonomy"],
        )
        self.assertEqual(report["autonomy"]["candidate_id"], "cand-auto")
        self.assertEqual(report["run_summary"]["autonomy"]["candidate_id"], "cand-auto")
        self.assertEqual(
            autonomy_mock.call_args.kwargs["signals_path"],
            Path("/tmp/signals.json"),
        )

    def test_run_full_lifecycle_does_not_fail_when_activity_analysis_corroboration_is_unsuccessful(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=False,
            applicationset_name="product",
            applicationset_namespace="argocd",
            app_name="torghut",
            root_app_name="root",
            desired_mode_during_run="manual",
            restore_mode_after_run="previous",
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace="torghut",
            runtime_template="torghut-simulation-runtime-ready",
            activity_template="torghut-simulation-activity",
            teardown_template="torghut-simulation-teardown-clean",
            artifact_template="torghut-simulation-artifact-bundle",
            verify_timeout_seconds=30,
            verify_poll_seconds=5,
        )

        with ExitStack() as stack:
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._ensure_supported_binary",
                    return_value=None,
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._update_run_state",
                    return_value=None,
                )
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._save_json", return_value=None
                )
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation.persist_completion_trace",
                    return_value={},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._upsert_simulation_progress_row",
                    return_value=None,
                ),
            )
            mock_session_local = stack.enter_context(
                patch("scripts.start_historical_simulation.SessionLocal")
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._prepare_argocd_for_run",
                    return_value={"managed": False},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._restore_argocd_after_run",
                    return_value={"managed": False},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._apply",
                    return_value={"status": "ok"},
                )
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._run_rollouts_analysis",
                    side_effect=[
                        {"phase": "Successful"},
                        {"phase": "Failed"},
                    ],
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._runtime_verify",
                    return_value={"runtime_state": "ready"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._replay_dump",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._monitor_run_completion",
                    return_value={
                        "status": "ok",
                        "activity_classification": "success",
                        "final_snapshot": {
                            "signal_rows": 5,
                            "price_rows": 5,
                            "trade_decisions": 3,
                            "cursor_at": "2026-02-27T21:00:00Z",
                            "executions": 2,
                            "execution_tca_metrics": 2,
                            "execution_order_events": 2,
                        },
                    },
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._report_simulation",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._build_strategy_proof_artifact",
                    return_value={"status": "ok", "legacy_path_count": 0},
                ),
            )
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            report = _run_full_lifecycle(
                resources=resources,
                manifest=manifest,
                manifest_path=Path("/tmp/manifest.json"),
                kafka_config=kafka_config,
                clickhouse_config=clickhouse_config,
                postgres_config=postgres_config,
                argocd_config=argocd_config,
                rollouts_config=rollouts_config,
                force_dump=False,
                force_replay=False,
                skip_teardown=True,
                report_only=False,
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["monitor"]["activity_classification"], "success")
        self.assertEqual(report["rollouts"]["activity_analysis_run"]["phase"], "Failed")

    def test_run_full_lifecycle_runs_teardown_analysis_after_argocd_restore(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-teardown-clean-order",
            {
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_teardown_order",
            simulation_db="torghut_sim_teardown_order",
            migrations_command="true",
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=True,
            applicationset_name="product",
            applicationset_namespace="argocd",
            app_name="torghut",
            root_app_name="root",
            desired_mode_during_run="manual",
            restore_mode_after_run="previous",
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace="torghut",
            runtime_template="torghut-simulation-runtime-ready",
            activity_template="torghut-simulation-activity",
            teardown_template="torghut-simulation-teardown-clean",
            artifact_template="torghut-simulation-artifact-bundle",
            verify_timeout_seconds=30,
            verify_poll_seconds=5,
        )
        call_order: list[str] = []

        def _rollouts_side_effect(*, phase: str, **_: Any) -> dict[str, Any]:
            call_order.append(phase)
            return {"phase": "Successful"}

        with ExitStack() as stack:
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._ensure_supported_binary",
                    return_value=None,
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._update_run_state",
                    return_value=None,
                )
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._save_json", return_value=None
                )
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation.persist_completion_trace",
                    return_value={},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._upsert_simulation_progress_row",
                    return_value=None,
                ),
            )
            mock_session_local = stack.enter_context(
                patch("scripts.start_historical_simulation.SessionLocal")
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._read_argocd_automation_mode",
                    return_value={"mode": "auto"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._read_named_argocd_application_sync_policy",
                    return_value={"sync_policy": {"automated": {"enabled": True}}},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._read_argocd_application_sync_policy",
                    return_value={
                        "sync_policy": {"automated": {"enabled": True}},
                        "automation_mode": "auto",
                        "ignore_differences": [],
                    },
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._prepare_argocd_for_run",
                    return_value={"managed": False},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._restore_argocd_after_run",
                    side_effect=lambda **_: (
                        call_order.append("argocd_restore") or {"managed": False}
                    ),
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._wait_for_torghut_service_revision_ready",
                    return_value={
                        "ready": True,
                        "condition_ready": "True",
                        "latest_created_revision": "torghut-sim-00002",
                        "latest_ready_revision": "torghut-sim-00002",
                        "revision_settled": True,
                    },
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._apply",
                    return_value={"status": "ok"},
                )
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._run_rollouts_analysis",
                    side_effect=_rollouts_side_effect,
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._runtime_verify",
                    return_value={"runtime_state": "ready"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._replay_dump",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._monitor_run_completion",
                    return_value={
                        "status": "ok",
                        "activity_classification": "success",
                        "final_snapshot": {
                            "signal_rows": 5,
                            "price_rows": 5,
                            "trade_decisions": 3,
                            "cursor_at": "2026-02-27T21:00:00Z",
                            "executions": 2,
                            "execution_tca_metrics": 2,
                            "execution_order_events": 2,
                        },
                    },
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._report_simulation",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._build_strategy_proof_artifact",
                    return_value={"status": "ok", "legacy_path_count": 0},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._teardown",
                    side_effect=lambda **_: call_order.append("teardown") or None,
                ),
            )
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            report = _run_full_lifecycle(
                resources=resources,
                manifest=manifest,
                manifest_path=Path("/tmp/manifest.json"),
                kafka_config=kafka_config,
                clickhouse_config=clickhouse_config,
                postgres_config=postgres_config,
                argocd_config=argocd_config,
                rollouts_config=rollouts_config,
                force_dump=False,
                force_replay=False,
                skip_teardown=False,
                report_only=False,
            )

        self.assertEqual(report["status"], "ok")
        self.assertTrue(report["rollouts"]["teardown_settle"]["ready"])
        self.assertTrue(report["teardown"]["service_revision_settle"]["ready"])
        self.assertEqual(report["teardown"]["analysis_run"]["phase"], "Successful")
        self.assertEqual(
            call_order,
            [
                "runtime-ready",
                "activity",
                "teardown",
                "argocd_restore",
                "teardown-clean",
            ],
        )
