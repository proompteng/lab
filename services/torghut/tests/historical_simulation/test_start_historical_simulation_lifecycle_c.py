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
    _runtime_verify,
    call,
    patch,
)


class TestStartHistoricalSimulationLifecycleC(StartHistoricalSimulationTestCaseBase):
    def test_run_full_lifecycle_fails_before_teardown_clean_when_teardown_settle_not_ready(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-teardown-settle-fail",
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
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_teardown_settle_fail",
            simulation_db="torghut_sim_teardown_settle_fail",
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
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch(
                    "scripts.start_historical_simulation._wait_for_torghut_service_revision_ready",
                    return_value={
                        "ready": False,
                        "condition_ready": "Unknown",
                        "latest_created_revision": "torghut-sim-00002",
                        "latest_ready_revision": "torghut-sim-00001",
                        "revision_settled": False,
                    },
                ),
            )
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "simulation_run_failed:teardown_settle:runtime_not_ready",
            ):
                _run_full_lifecycle(
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

        self.assertEqual(call_order, ["runtime-ready", "activity", "argocd_restore"])

    def test_run_full_lifecycle_fails_when_teardown_analysis_is_unsuccessful_after_restore(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-teardown-clean-fail",
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
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_teardown_fail",
            simulation_db="torghut_sim_teardown_fail",
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

        def _rollouts_side_effect(*, phase: str, **_: Any) -> dict[str, Any]:
            if phase == "teardown-clean":
                return {"phase": "Failed"}
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
                    return_value={"status": "ok"},
                ),
            )
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "simulation_run_failed:teardown:environment_incomplete",
            ):
                _run_full_lifecycle(
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

    def test_run_full_lifecycle_aborts_before_replay_when_runtime_not_ready(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-runtime-gate-fail",
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
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_runtime_gate",
            simulation_db="torghut_sim_runtime_gate",
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
            verify_timeout_seconds=60,
            verify_poll_seconds=5,
        )

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
                "scripts.start_historical_simulation._upsert_simulation_progress_row",
                return_value=None,
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
                return_value={"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation._run_rollouts_analysis",
                return_value={"phase": "Failed"},
            ),
            patch(
                "scripts.start_historical_simulation._runtime_verify",
                return_value={"runtime_state": "not_ready"},
            ),
            patch("scripts.start_historical_simulation._replay_dump") as replay_dump,
            patch(
                "scripts.start_historical_simulation._report_simulation",
                return_value={"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation._build_strategy_proof_artifact",
                return_value={"status": "ok", "legacy_path_count": 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "simulation_run_failed:environment_incomplete",
            ):
                _run_full_lifecycle(
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

        replay_dump.assert_not_called()

    def test_run_full_lifecycle_waits_for_runtime_verify_without_rollouts(self) -> None:
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
            verify_timeout_seconds=30,
            verify_poll_seconds=5,
        )

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
                return_value={"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation._runtime_verify",
                side_effect=[
                    {"runtime_state": "not_ready"},
                    {"runtime_state": "ready"},
                ],
            ) as runtime_verify_mock,
            patch(
                "scripts.start_historical_simulation.time.sleep", return_value=None
            ) as sleep_mock,
            patch(
                "scripts.start_historical_simulation._replay_dump",
                return_value={"status": "ok"},
            ),
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
            patch(
                "scripts.start_historical_simulation._report_simulation",
                return_value={"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation._build_strategy_proof_artifact",
                return_value={"status": "ok", "legacy_path_count": 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            _run_full_lifecycle(
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

        self.assertEqual(runtime_verify_mock.call_count, 2)
        self.assertGreaterEqual(len(sleep_mock.call_args_list), 1)
        self.assertEqual(sleep_mock.call_args_list[0], call(5))

    def test_runtime_verify_accepts_dedicated_sim_runtime_with_ready_replicas(
        self,
    ) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            }
        }
        resources = _build_resources(
            "sim-2026-03-06-open-hour",
            {
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "ta_configmap": "torghut-ta-sim-config",
                    "ta_deployment": "torghut-ta-sim",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        kservice_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "env": [
                                    {"name": "TRADING_ENABLED", "value": "true"},
                                    {
                                        "name": "TRADING_PIPELINE_MODE",
                                        "value": "simple",
                                    },
                                    {
                                        "name": "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_RUNTIME_MODE",
                                        "value": "scheduler_v3",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_SCHEDULER_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_AUTO_OFFSET_RESET",
                                        "value": "earliest",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": "sim-2026-03-06-open-hour",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_ALLOWED_SOURCES",
                                        "value": "ws,ta",
                                    },
                                ],
                            }
                        ]
                    }
                }
            },
            "status": {
                "latestReadyRevisionName": "torghut-sim-00001",
                "conditions": [
                    {
                        "type": "Ready",
                        "status": "True",
                    }
                ],
            },
        }
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1.sim_2026_03_06_open_hour",
                "TA_QUOTES_TOPIC": "torghut.sim.quotes.v1.sim_2026_03_06_open_hour",
                "TA_BARS1M_TOPIC": "torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour",
                "TA_MICROBARS_TOPIC": "torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour",
                "TA_SIGNALS_TOPIC": "torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour",
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_verification._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_verification._deployment_replica_health",
                side_effect=[
                    {
                        "name": "torghut-sim-00001-deployment",
                        "ready_replicas": 1,
                        "available_replicas": 1,
                        "replicas": 1,
                    },
                ],
            ),
            patch(
                "scripts.historical_simulation_verification._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "DEPLOYED",
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report["runtime_state"], "ready")
        self.assertEqual(report["environment_state"], "complete")
        self.assertEqual(report["torghut_service"]["name"], "torghut-sim")
        self.assertTrue(all(report["ta_runtime_config"].values()))

    def test_runtime_verify_rejects_simple_sim_runtime_without_order_feed_telemetry(
        self,
    ) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            }
        }
        resources = _build_resources(
            "sim-2026-03-06-open-hour",
            {
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "ta_configmap": "torghut-ta-sim-config",
                    "ta_deployment": "torghut-ta-sim",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        kservice_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "env": [
                                    {"name": "TRADING_ENABLED", "value": "true"},
                                    {
                                        "name": "TRADING_PIPELINE_MODE",
                                        "value": "simple",
                                    },
                                    {
                                        "name": "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED",
                                        "value": "false",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_RUNTIME_MODE",
                                        "value": "scheduler_v3",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_SCHEDULER_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": resources.clickhouse_signal_table,
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": resources.clickhouse_price_table,
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": resources.simulation_topic_by_role[
                                            "order_updates"
                                        ],
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_AUTO_OFFSET_RESET",
                                        "value": "latest",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": resources.simulation_topic_by_role[
                                            "order_updates"
                                        ],
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": resources.run_id,
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_ALLOWED_SOURCES",
                                        "value": "ws,ta",
                                    },
                                ],
                            }
                        ]
                    }
                }
            },
            "status": {
                "latestReadyRevisionName": "torghut-sim-00001",
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": resources.simulation_topic_by_role["trades"],
                "TA_QUOTES_TOPIC": resources.simulation_topic_by_role["quotes"],
                "TA_BARS1M_TOPIC": resources.simulation_topic_by_role["bars"],
                "TA_MICROBARS_TOPIC": resources.simulation_topic_by_role[
                    "ta_microbars"
                ],
                "TA_SIGNALS_TOPIC": resources.simulation_topic_by_role["ta_signals"],
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_verification._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_verification._deployment_replica_health",
                return_value={
                    "name": "torghut-sim-00001-deployment",
                    "ready_replicas": 1,
                    "available_replicas": 1,
                    "replicas": 1,
                },
            ),
            patch(
                "scripts.historical_simulation_verification._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "DEPLOYED",
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        trading_config = report["torghut_service"]["trading_config"]
        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertFalse(trading_config["simple_order_feed_telemetry"])
        self.assertFalse(trading_config["order_feed_auto_offset_reset"])
