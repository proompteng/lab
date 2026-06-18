from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    Path,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    SimpleNamespace,
    StartHistoricalSimulationTestCaseBase,
    _build_resources,
    _run_full_lifecycle,
    patch,
)


class TestStartHistoricalSimulationLifecycleA(StartHistoricalSimulationTestCaseBase):
    def test_run_full_lifecycle_fails_when_activity_verify_is_degraded(self) -> None:
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

        with (
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._ensure_supported_binary",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._update_run_state",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._save_json",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle.persist_completion_trace",
                return_value={},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle.SessionLocal"
            ) as mock_session_local,
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._apply",
                return_value={"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._runtime_verify",
                return_value={"runtime_state": "ready"},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._replay_dump",
                return_value={"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._monitor_run_completion",
                return_value={
                    "status": "degraded",
                    "activity_classification": "decisions_absent",
                    "final_snapshot": {},
                },
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._report_simulation",
                return_value={"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._build_strategy_proof_artifact",
                return_value={"status": "ok", "legacy_path_count": 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            with self.assertRaisesRegex(
                RuntimeError, "simulation_run_failed:activity:decisions_absent"
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

    def test_run_full_lifecycle_reports_completion_trace_persist_failure_without_masking_root_cause(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-persist-failure",
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
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_persist_failure",
            simulation_db="torghut_sim_persist_failure",
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

        class _FakeSession:
            def __enter__(self) -> SimpleNamespace:
                return SimpleNamespace(commit=lambda: None)

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

        fake_engine = SimpleNamespace(dispose=lambda: None)

        with (
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._update_run_state",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._save_json",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._prepare_argocd_for_run",
                return_value={"managed": False},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._restore_argocd_after_run",
                return_value={"managed": False},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._apply",
                side_effect=RuntimeError(
                    "command_binary_not_found:/opt/venv/bin/alembic"
                ),
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._upsert_simulation_progress_row",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._runtime_sessionmaker",
                return_value=(lambda: _FakeSession(), fake_engine),
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle.persist_completion_trace",
                side_effect=RuntimeError(
                    'relation "vnext_completion_gate_results" does not exist'
                ),
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                (
                    "simulation_run_failed:command_binary_not_found:/opt/venv/bin/alembic; "
                    'completion_trace_persist:relation "vnext_completion_gate_results" does not exist'
                ),
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

    def test_run_full_lifecycle_replays_after_runtime_verify(self) -> None:
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
        call_order: list[str] = []

        with (
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._ensure_supported_binary",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._update_run_state",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._save_json",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle.persist_completion_trace",
                return_value={},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle.SessionLocal"
            ) as mock_session_local,
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._prepare_argocd_for_run",
                return_value={"managed": False},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._restore_argocd_after_run",
                return_value={"managed": False},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._apply",
                side_effect=lambda **_: call_order.append("apply") or {"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._runtime_verify",
                side_effect=lambda **_: (
                    call_order.append("runtime_verify") or {"runtime_state": "ready"}
                ),
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._replay_dump",
                side_effect=lambda **_: call_order.append("replay") or {"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._monitor_run_completion",
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
                "scripts.start_historical_simulation_modules.lifecycle._report_simulation",
                side_effect=lambda **_: call_order.append("report") or {"status": "ok"},
            ),
            patch(
                "scripts.start_historical_simulation_modules.lifecycle._build_strategy_proof_artifact",
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

        self.assertEqual(
            call_order,
            ["apply", "runtime_verify", "replay", "monitor", "report"],
        )
