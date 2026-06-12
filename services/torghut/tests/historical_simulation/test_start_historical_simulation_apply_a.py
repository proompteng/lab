from __future__ import annotations

# ruff: noqa: F403,F405
from tests.historical_simulation.start_historical_simulation_base import *


class TestStartHistoricalSimulationApplyA(StartHistoricalSimulationTestCaseBase):
    def test_apply_reasserts_manual_argocd_control_before_runtime_mutation(
        self,
    ) -> None:
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
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
            password="secret",
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
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
            verify_timeout_seconds=30,
        )
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T15:30:00Z",
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with ExitStack() as stack:
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_supported_binary"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_lz4_codec_available"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._acquire_simulation_runtime_lock",
                        return_value={"status": "acquired", "run_id": resources.run_id},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._capture_cluster_state",
                        return_value={
                            "ta_data": {
                                "TA_GROUP_ID": "prod-ta-group",
                                "TA_CHECKPOINT_DIR": "s3a://bucket/checkpoints",
                                "TA_SAVEPOINT_DIR": "s3a://bucket/savepoints",
                            }
                        },
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_topics",
                        return_value={"status": "ok"},
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_clickhouse_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_clickhouse_runtime_tables",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_postgres_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_postgres_runtime_permissions",
                        return_value={"grants_applied": True},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._run_migrations",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._reset_postgres_runtime_state",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._seed_simulation_trade_cursor",
                        return_value=datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._upsert_simulation_runtime_context",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._dump_topics",
                        return_value={"records": 1, "sha256": "abc"},
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._validate_dump_coverage",
                        return_value={"coverage_ratio": 1.0},
                    ),
                )
                runtime_guard = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_argocd_manual_before_runtime_mutation",
                        return_value={"managed": True, "changed": True},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ta_runtime_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._torghut_service_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_ta_for_simulation",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._restart_ta_deployment",
                        return_value="nonce",
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_torghut_service_for_simulation",
                        return_value=None,
                    ),
                )

                report = start_historical_simulation._apply(
                    resources=resources,
                    manifest=manifest,
                    kafka_config=kafka_config,
                    clickhouse_config=clickhouse_config,
                    postgres_config=postgres_config,
                    argocd_config=argocd_config,
                    force_dump=False,
                    force_replay=False,
                )

        runtime_guard.assert_called_once_with(config=argocd_config, resources=resources)
        self.assertEqual(
            report["argocd_runtime_guard"], {"managed": True, "changed": True}
        )

    def test_apply_restarts_ta_when_warm_lane_baseline_is_already_ready(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
                "runtime": {"use_warm_lane": True},
            },
        )
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
            password="secret",
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_default",
            simulation_db="torghut_sim_default",
            migrations_command="true",
        )
        manifest = {
            "dataset_id": "dataset-a",
            "runtime": {"use_warm_lane": True},
            "clickhouse": {"database_precreated": True},
            "postgres": {"database_precreated": True},
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T15:30:00Z",
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with ExitStack() as stack:
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_supported_binary",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_lz4_codec_available",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._acquire_simulation_runtime_lock",
                        return_value={"status": "acquired", "run_id": resources.run_id},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._capture_cluster_state",
                        return_value={
                            "ta_data": {"TA_GROUP_ID": "torghut-ta-sim-default"}
                        },
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_topics",
                        return_value={"status": "ok"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_clickhouse_runtime_tables",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_postgres_runtime_permissions",
                        return_value={"grants_applied": True},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._run_migrations",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._reset_postgres_runtime_state",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._seed_simulation_trade_cursor",
                        return_value=datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._upsert_simulation_runtime_context",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._dump_topics",
                        return_value={"records": 1, "sha256": "abc"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._validate_dump_coverage",
                        return_value={"coverage_ratio": 1.0},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ta_runtime_reconfigure_required",
                        return_value=False,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._torghut_service_reconfigure_required",
                        return_value=False,
                    ),
                )
                configure_ta = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_ta_for_simulation"
                    ),
                )
                restart_ta = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._restart_ta_deployment",
                        return_value=7,
                    ),
                )
                configure_service = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_torghut_service_for_simulation"
                    ),
                )
                report = start_historical_simulation._apply(
                    resources=resources,
                    manifest=manifest,
                    kafka_config=kafka_config,
                    clickhouse_config=clickhouse_config,
                    postgres_config=postgres_config,
                    force_dump=False,
                    force_replay=False,
                )

        configure_ta.assert_not_called()
        restart_ta.assert_called_once_with(
            resources,
            desired_state="running",
            upgrade_mode="stateless",
        )
        configure_service.assert_not_called()
        self.assertTrue(report["warm_lane_enabled"])
        self.assertFalse(report["ta_reconfigured"])
        self.assertTrue(report["ta_restart_forced"])
        self.assertEqual(report["ta_restart_nonce"], 7)
        self.assertFalse(report["torghut_reconfigured"])
        self.assertEqual(report["seeded_cursor_at"], "2026-02-27T14:30:00+00:00")

    def test_resolve_warm_lane_runtime_postgres_config_uses_current_kservice_dsn(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
                "runtime": {"use_warm_lane": True},
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://postgres:admin-secret@db.example:5432/postgres",
            simulation_dsn="postgresql://postgres:admin-secret@db.example:5432/torghut_sim_default",
            simulation_db="torghut_sim_default",
            migrations_command="true",
        )

        def _kubectl_json_side_effect(
            namespace: str, args: list[str]
        ) -> dict[str, Any]:
            self.assertEqual(namespace, "torghut")
            if args[:3] == ["get", "kservice", "torghut-sim"]:
                return {
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [
                                    {
                                        "env": [
                                            {
                                                "name": "TORGHUT_SIM_DB_HOST",
                                                "valueFrom": {
                                                    "secretKeyRef": {
                                                        "name": "torghut-db-app",
                                                        "key": "host",
                                                    }
                                                },
                                            },
                                            {
                                                "name": "TORGHUT_SIM_DB_PORT",
                                                "valueFrom": {
                                                    "secretKeyRef": {
                                                        "name": "torghut-db-app",
                                                        "key": "port",
                                                    }
                                                },
                                            },
                                            {
                                                "name": "TORGHUT_SIM_DB_USER",
                                                "valueFrom": {
                                                    "secretKeyRef": {
                                                        "name": "torghut-db-app",
                                                        "key": "username",
                                                    }
                                                },
                                            },
                                            {
                                                "name": "TORGHUT_SIM_DB_PASSWORD",
                                                "valueFrom": {
                                                    "secretKeyRef": {
                                                        "name": "torghut-db-app",
                                                        "key": "password",
                                                    }
                                                },
                                            },
                                            {
                                                "name": "DB_DSN",
                                                "value": "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
                                            },
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            if args[:3] == ["get", "secret", "torghut-db-app"]:
                encoded = {
                    "host": "ZGIuZXhhbXBsZQ==",
                    "port": "NTQzMg==",
                    "username": "dG9yZ2h1dF9hcHA=",
                    "password": "YXBwLXNlY3JldA==",
                }
                return {"data": encoded}
            raise AssertionError(f"unexpected kubectl args: {args}")

        with patch(
            "scripts.start_historical_simulation._kubectl_json",
            side_effect=_kubectl_json_side_effect,
        ):
            resolved = _resolve_warm_lane_runtime_postgres_config(
                resources=resources,
                postgres_config=postgres_config,
            )

        self.assertEqual(
            resolved.torghut_runtime_dsn,
            "postgresql://torghut_app:app-secret@db.example:5432/torghut_sim_default",
        )

    def test_apply_uses_resolved_warm_lane_runtime_dsn_for_permissions_and_migrations(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
                "runtime": {"use_warm_lane": True},
            },
        )
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
            password="secret",
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://postgres:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://postgres:secret@localhost:5432/torghut_sim_default",
            simulation_db="torghut_sim_default",
            migrations_command="true",
        )
        runtime_config = replace(
            postgres_config,
            runtime_simulation_dsn="postgresql://torghut_app:secret@localhost:5432/torghut_sim_default",
        )
        manifest = {
            "dataset_id": "dataset-a",
            "runtime": {"use_warm_lane": True},
            "clickhouse": {"database_precreated": True},
            "postgres": {"database_precreated": True},
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T15:30:00Z",
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with ExitStack() as stack:
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_supported_binary",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_lz4_codec_available",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._acquire_simulation_runtime_lock",
                        return_value={"status": "acquired", "run_id": resources.run_id},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._capture_cluster_state",
                        return_value={
                            "ta_data": {"TA_GROUP_ID": "torghut-ta-sim-default"}
                        },
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_topics",
                        return_value={"status": "ok"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_clickhouse_runtime_tables",
                        return_value=None,
                    ),
                )
                ensure_permissions = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_postgres_runtime_permissions",
                        return_value={"grants_applied": True},
                    ),
                )
                run_migrations = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._run_migrations",
                        return_value=None,
                    ),
                )
                reset_runtime_state = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._reset_postgres_runtime_state",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._seed_simulation_trade_cursor",
                        return_value=datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._upsert_simulation_runtime_context",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._dump_topics",
                        return_value={"records": 1, "sha256": "abc"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._validate_dump_coverage",
                        return_value={"coverage_ratio": 1.0},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ta_runtime_reconfigure_required",
                        return_value=False,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._torghut_service_reconfigure_required",
                        return_value=False,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_ta_for_simulation",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._restart_ta_deployment",
                        return_value=1,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_torghut_service_for_simulation",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._release_simulation_runtime_lock",
                        return_value={"status": "released", "run_id": resources.run_id},
                    ),
                )
                start_historical_simulation._apply(
                    resources=resources,
                    manifest=manifest,
                    kafka_config=kafka_config,
                    clickhouse_config=clickhouse_config,
                    postgres_config=runtime_config,
                    force_dump=False,
                    force_replay=False,
                )

        self.assertEqual(
            ensure_permissions.call_args_list,
            [call(runtime_config), call(runtime_config)],
        )
        run_migrations.assert_called_once_with(runtime_config)
        reset_runtime_state.assert_called_once_with(runtime_config)

    def test_apply_uses_stateless_ta_restart_when_manifest_requests_it(self) -> None:
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
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
            password="secret",
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        manifest = {
            "dataset_id": "dataset-a",
            "ta_restore": {"mode": "stateless"},
            "clickhouse": {"database_precreated": True},
            "postgres": {"database_precreated": True},
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T15:30:00Z",
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with ExitStack() as stack:
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_supported_binary",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_lz4_codec_available",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._acquire_simulation_runtime_lock",
                        return_value={"status": "acquired", "run_id": resources.run_id},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._capture_cluster_state",
                        return_value={
                            "ta_data": {
                                "TA_GROUP_ID": "prod-ta-group",
                            }
                        },
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_topics",
                        return_value={"status": "ok"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_clickhouse_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_clickhouse_runtime_tables",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_postgres_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ensure_postgres_runtime_permissions",
                        return_value={"grants_applied": True},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._run_migrations",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._reset_postgres_runtime_state",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._seed_simulation_trade_cursor",
                        return_value=datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._upsert_simulation_runtime_context",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._dump_topics",
                        return_value={"records": 1, "sha256": "abc"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._validate_dump_coverage",
                        return_value={"coverage_ratio": 1.0},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._ta_runtime_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._torghut_service_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_ta_for_simulation",
                        return_value=None,
                    ),
                )
                restart_ta = stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._restart_ta_deployment",
                        return_value="nonce",
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.start_historical_simulation._configure_torghut_service_for_simulation",
                        return_value=None,
                    ),
                )
                report = start_historical_simulation._apply(
                    resources=resources,
                    manifest=manifest,
                    kafka_config=kafka_config,
                    clickhouse_config=clickhouse_config,
                    postgres_config=postgres_config,
                    force_dump=False,
                    force_replay=False,
                )

        restart_ta.assert_called_once_with(
            resources,
            desired_state="running",
            upgrade_mode="stateless",
        )
        self.assertEqual(report["ta_restore"]["effective_upgrade_mode"], "stateless")
        self.assertEqual(report["ta_restore"]["reason"], "explicit_stateless")
