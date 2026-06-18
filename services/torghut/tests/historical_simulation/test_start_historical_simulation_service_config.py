from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    PostgresRuntimeConfig,
    StartHistoricalSimulationTestCaseBase,
    _build_resources,
    _configure_torghut_service_for_simulation,
    _ensure_simulation_schema_subjects,
    json,
    patch,
)


class TestStartHistoricalSimulationServiceConfig(StartHistoricalSimulationTestCaseBase):
    def test_ensure_simulation_schema_subjects_registers_equity_ta_subjects_only(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-2026-03-06-open-hour",
            {
                "dataset_id": "dataset-a",
            },
        )
        ta_data = {
            "TA_SCHEMA_REGISTRY_URL": "http://karapace.kafka:8081",
        }
        calls: list[tuple[str, str, str | None]] = []

        def _fake_http_request(
            *,
            base_url: str,
            path: str,
            method: str = "GET",
            body: str | None = None,
            headers: dict[str, str] | None = None,
        ) -> tuple[int, str]:
            _ = method
            _ = headers
            calls.append((base_url, path, body))
            if path == "/subjects":
                return 200, "[]"
            if path.endswith(
                f"{resources.simulation_topic_by_role['ta_microbars']}-value/versions/latest"
            ):
                return 404, "{}"
            if path.endswith(
                f"{resources.simulation_topic_by_role['ta_signals']}-value/versions/latest"
            ):
                return 404, "{}"
            if path.endswith(
                f"{resources.simulation_topic_by_role['ta_microbars']}-value/versions"
            ):
                return 200, '{"id": 1}'
            if path.endswith(
                f"{resources.simulation_topic_by_role['ta_signals']}-value/versions"
            ):
                return 200, '{"id": 2}'
            raise AssertionError(f"unexpected request path: {path}")

        with patch(
            "scripts.start_historical_simulation_modules.kafka_runtime._http_request",
            side_effect=_fake_http_request,
        ):
            report = _ensure_simulation_schema_subjects(
                resources=resources,
                ta_data=ta_data,
            )

        self.assertTrue(report["ready"])
        self.assertEqual(
            report["subjects_expected"],
            [
                f"{resources.simulation_topic_by_role['ta_microbars']}-value",
                f"{resources.simulation_topic_by_role['ta_signals']}-value",
            ],
        )
        self.assertEqual(report["subjects_existing"], [])
        self.assertEqual(report["subjects_registered"], report["subjects_expected"])

        posted_bodies = [
            json.loads(body)
            for _, path, body in calls
            if path.endswith("/versions") and body is not None
        ]
        self.assertEqual(len(posted_bodies), 2)
        schema_names = sorted(
            json.loads(payload["schema"])["name"] for payload in posted_bodies
        )
        self.assertEqual(schema_names, ["TaBar1s", "TaSignal"])

    def test_configure_torghut_service_preserves_existing_container_fields(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol="SASL_PLAINTEXT",
            sasl_mechanism="SCRAM-SHA-512",
            sasl_username="user",
            sasl_password="secret",
        )
        service_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "image": "registry.example/lab/torghut@sha256:abc",
                                "volumeMounts": [
                                    {
                                        "name": "strategy-config",
                                        "mountPath": "/etc/torghut",
                                    }
                                ],
                                "env": [
                                    {"name": "DB_DSN", "value": "postgresql://old"},
                                    {"name": "TRADING_MODE", "value": "live"},
                                ],
                            }
                        ]
                    }
                }
            }
        }
        captured_patch: dict[str, object] = {}

        with (
            patch(
                "scripts.start_historical_simulation_modules.runtime_migrations._kubectl_json",
                return_value=service_payload,
            ),
            patch(
                "scripts.start_historical_simulation_modules.runtime_migrations._kubectl_patch",
                side_effect=lambda namespace, kind, name, patch: captured_patch.update(
                    {"namespace": namespace, "kind": kind, "name": name, "patch": patch}
                ),
            ),
        ):
            _configure_torghut_service_for_simulation(
                resources=resources,
                manifest={
                    "window": {
                        "start": "2026-02-27T14:30:00Z",
                        "end": "2026-02-27T21:00:00Z",
                    }
                },
                postgres_config=postgres_config,
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url="http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123",
                    username="torghut",
                    password="clickhouse-secret",
                ),
                kafka_config=kafka_config,
            )

        patch_payload = captured_patch.get("patch")
        self.assertIsInstance(patch_payload, dict)
        assert isinstance(patch_payload, dict)
        containers = (
            patch_payload.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertIsInstance(containers, list)
        assert isinstance(containers, list)
        self.assertEqual(len(containers), 1)
        container = containers[0]
        self.assertIsInstance(container, dict)
        assert isinstance(container, dict)
        self.assertEqual(
            container.get("image"),
            "registry.example/lab/torghut@sha256:abc",
        )
        self.assertEqual(
            container.get("volumeMounts"),
            [{"name": "strategy-config", "mountPath": "/etc/torghut"}],
        )
        env_entries = container.get("env")
        self.assertIsInstance(env_entries, list)
        assert isinstance(env_entries, list)
        env_by_name = {
            str(item.get("name")): item
            for item in env_entries
            if isinstance(item, dict)
        }
        self.assertEqual(
            env_by_name["TRADING_ORDER_FEED_SECURITY_PROTOCOL"].get("value"),
            "SASL_PLAINTEXT",
        )
        self.assertEqual(
            env_by_name["TRADING_ORDER_FEED_SASL_MECHANISM"].get("value"),
            "SCRAM-SHA-512",
        )
        self.assertEqual(
            env_by_name["TRADING_ORDER_FEED_SASL_USERNAME"].get("value"),
            "user",
        )
        self.assertEqual(
            env_by_name["TRADING_ORDER_FEED_SASL_PASSWORD"].get("value"),
            "secret",
        )
        self.assertEqual(
            env_by_name["TRADING_ORDER_FEED_AUTO_OFFSET_RESET"].get("value"),
            "earliest",
        )
        self.assertEqual(
            env_by_name["TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED"].get("value"),
            "true",
        )
        self.assertEqual(
            env_by_name["TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL"].get(
                "value"
            ),
            "SASL_PLAINTEXT",
        )
        self.assertEqual(
            env_by_name["TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM"].get("value"),
            "SCRAM-SHA-512",
        )
        self.assertEqual(
            env_by_name["TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME"].get("value"),
            "user",
        )
        self.assertEqual(
            env_by_name["TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD"].get("value"),
            "secret",
        )
        self.assertEqual(
            env_by_name["TRADING_ENABLED"].get("value"),
            "true",
        )
        self.assertEqual(
            env_by_name["TRADING_STRATEGY_RUNTIME_MODE"].get("value"),
            "scheduler_v3",
        )
        self.assertEqual(
            env_by_name["TRADING_STRATEGY_SCHEDULER_ENABLED"].get("value"),
            "true",
        )
        self.assertEqual(
            env_by_name["TA_CLICKHOUSE_URL"].get("value"),
            "http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123",
        )
        self.assertEqual(
            env_by_name["TA_CLICKHOUSE_USERNAME"].get("value"),
            "torghut",
        )
        self.assertEqual(
            env_by_name["TA_CLICKHOUSE_PASSWORD"].get("value"),
            "clickhouse-secret",
        )
        self.assertEqual(
            env_by_name["TRADING_SIGNAL_ALLOWED_SOURCES"].get("value"),
            "ws,ta",
        )

    def test_configure_torghut_service_applies_manifest_overrides(self) -> None:
        resources = _build_resources(
            "sim-override",
            {
                "dataset_id": "dataset-a",
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_override",
            simulation_db="torghut_sim_sim_override",
            migrations_command="true",
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol="SASL_PLAINTEXT",
            sasl_mechanism="SCRAM-SHA-512",
            sasl_username="user",
            sasl_password="secret",
        )
        service_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "image": "registry.example/lab/torghut@sha256:abc",
                                "env": [
                                    {
                                        "name": "TRADING_FEATURE_MAX_STALENESS_MS",
                                        "value": "120000",
                                    },
                                ],
                            }
                        ]
                    }
                }
            }
        }
        captured_patch: dict[str, object] = {}

        with (
            patch(
                "scripts.start_historical_simulation_modules.runtime_migrations._kubectl_json",
                return_value=service_payload,
            ),
            patch(
                "scripts.start_historical_simulation_modules.runtime_migrations._kubectl_patch",
                side_effect=lambda namespace, kind, name, patch: captured_patch.update(
                    {"namespace": namespace, "kind": kind, "name": name, "patch": patch}
                ),
            ),
        ):
            _configure_torghut_service_for_simulation(
                resources=resources,
                manifest={
                    "window": {
                        "start": "2026-02-27T14:30:00Z",
                        "end": "2026-02-27T21:00:00Z",
                    }
                },
                postgres_config=postgres_config,
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username="torghut",
                    password="secret",
                ),
                kafka_config=kafka_config,
                torghut_env_overrides={
                    "TRADING_FEATURE_MAX_STALENESS_MS": "43200000",
                    "TRADING_FEATURE_QUALITY_ENABLED": "true",
                    "TRADING_STRATEGY_RUNTIME_MODE": "plugin_v3",
                    "TRADING_STRATEGY_SCHEDULER_ENABLED": "false",
                    "TRADING_SIGNAL_ALLOWED_SOURCES": "rest,ws,ta",
                },
            )

        patch_payload = captured_patch.get("patch")
        self.assertIsInstance(patch_payload, dict)
        assert isinstance(patch_payload, dict)
        containers = (
            patch_payload.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertIsInstance(containers, list)
        assert isinstance(containers, list)
        env_entries = containers[0].get("env") if containers else []
        self.assertIsInstance(env_entries, list)
        assert isinstance(env_entries, list)
        env_by_name = {
            str(item.get("name")): item
            for item in env_entries
            if isinstance(item, dict)
        }
        self.assertEqual(
            env_by_name["TRADING_FEATURE_MAX_STALENESS_MS"].get("value"),
            "43200000",
        )
        self.assertEqual(
            env_by_name["TRADING_FEATURE_QUALITY_ENABLED"].get("value"),
            "true",
        )
        self.assertEqual(
            env_by_name["TRADING_STRATEGY_RUNTIME_MODE"].get("value"),
            "plugin_v3",
        )
        self.assertEqual(
            env_by_name["TRADING_STRATEGY_SCHEDULER_ENABLED"].get("value"),
            "false",
        )
        self.assertEqual(
            env_by_name["TRADING_SIGNAL_ALLOWED_SOURCES"].get("value"),
            "rest,ws,ta",
        )

    def test_configure_torghut_service_allows_explicit_runtime_override(self) -> None:
        resources = _build_resources(
            "sim-runtime-override",
            {
                "dataset_id": "dataset-a",
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_runtime_override",
            simulation_db="torghut_sim_sim_runtime_override",
            migrations_command="true",
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol="SASL_PLAINTEXT",
            sasl_mechanism="SCRAM-SHA-512",
            sasl_username="user",
            sasl_password="secret",
        )
        service_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "image": "registry.example/lab/torghut@sha256:abc",
                                "env": [],
                            }
                        ]
                    }
                }
            }
        }
        captured_patch: dict[str, object] = {}

        with (
            patch(
                "scripts.start_historical_simulation_modules.runtime_migrations._kubectl_json",
                return_value=service_payload,
            ),
            patch(
                "scripts.start_historical_simulation_modules.runtime_migrations._kubectl_patch",
                side_effect=lambda namespace, kind, name, patch: captured_patch.update(
                    {"namespace": namespace, "kind": kind, "name": name, "patch": patch}
                ),
            ),
        ):
            _configure_torghut_service_for_simulation(
                resources=resources,
                manifest={
                    "window": {
                        "start": "2026-02-27T14:30:00Z",
                        "end": "2026-02-27T21:00:00Z",
                    }
                },
                postgres_config=postgres_config,
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username="torghut",
                    password="secret",
                ),
                kafka_config=kafka_config,
                torghut_env_overrides={
                    "TRADING_STRATEGY_RUNTIME_MODE": "plugin_v3",
                    "TRADING_STRATEGY_SCHEDULER_ENABLED": "false",
                },
            )

        patch_payload = captured_patch.get("patch")
        self.assertIsInstance(patch_payload, dict)
        assert isinstance(patch_payload, dict)
        containers = (
            patch_payload.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertIsInstance(containers, list)
        assert isinstance(containers, list)
        env_entries = containers[0].get("env") if containers else []
        self.assertIsInstance(env_entries, list)
        assert isinstance(env_entries, list)
        env_by_name = {
            str(item.get("name")): item
            for item in env_entries
            if isinstance(item, dict)
        }
        self.assertEqual(
            env_by_name["TRADING_STRATEGY_RUNTIME_MODE"].get("value"),
            "plugin_v3",
        )
        self.assertEqual(
            env_by_name["TRADING_STRATEGY_SCHEDULER_ENABLED"].get("value"),
            "false",
        )
