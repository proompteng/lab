from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    ClickHouseRuntimeConfig,
    ExitStack,
    KafkaRuntimeConfig,
    Path,
    PostgresRuntimeConfig,
    SimpleNamespace,
    StartHistoricalSimulationTestCaseBase,
    TemporaryDirectory,
    _build_resources,
    _ensure_topics,
    datetime,
    patch,
    replace,
    historical_simulation_startup,
    timezone,
)


class TestStartHistoricalSimulationApplyB(StartHistoricalSimulationTestCaseBase):
    def test_apply_rejects_missing_restore_state_config_in_required_mode(self) -> None:
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
            "ta_restore": {"mode": "required"},
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T15:30:00Z",
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with (
                patch(
                    "scripts.historical_simulation_startup.replay_execution._ensure_supported_binary",
                    return_value=None,
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._ensure_lz4_codec_available",
                    return_value=None,
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._acquire_simulation_runtime_lock",
                    return_value={"status": "acquired", "run_id": resources.run_id},
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._capture_cluster_state",
                    return_value={"ta_data": {"TA_GROUP_ID": "prod-ta-group"}},
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._release_simulation_runtime_lock",
                    return_value={"status": "released"},
                ) as release_lock,
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "restore_state_missing:checkpoint_dir,savepoint_dir"
                ):
                    historical_simulation_startup._apply(
                        resources=resources,
                        manifest=manifest,
                        kafka_config=kafka_config,
                        clickhouse_config=clickhouse_config,
                        postgres_config=postgres_config,
                        force_dump=False,
                        force_replay=False,
                    )

        release_lock.assert_called_once_with(resources=resources)

    def test_apply_defaults_compact_profiles_to_stateless_restore(self) -> None:
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
            "clickhouse": {"database_precreated": True},
            "postgres": {"database_precreated": True},
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T15:00:00Z",
            },
            "performance": {
                "replayProfile": "compact",
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with ExitStack() as stack:
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_supported_binary",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_lz4_codec_available",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._acquire_simulation_runtime_lock",
                        return_value={"status": "acquired", "run_id": resources.run_id},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._capture_cluster_state",
                        return_value={
                            "ta_data": {
                                "TA_GROUP_ID": "prod-ta-group",
                                "TA_CHECKPOINT_DIR": "/checkpoints",
                                "TA_SAVEPOINT_DIR": "/savepoints",
                            }
                        },
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_topics",
                        return_value={"status": "ok"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_clickhouse_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_clickhouse_runtime_tables",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_postgres_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_postgres_runtime_permissions",
                        return_value={"grants_applied": True},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._run_migrations",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._reset_postgres_runtime_state",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._seed_simulation_trade_cursor",
                        return_value=datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._upsert_simulation_runtime_context",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._dump_topics",
                        return_value={"records": 1, "sha256": "abc"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._validate_dump_coverage",
                        return_value={"coverage_ratio": 1.0},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ta_runtime_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._torghut_service_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._configure_ta_for_simulation",
                        return_value=None,
                    ),
                )
                restart_ta = stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._restart_ta_deployment",
                        return_value="nonce",
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._configure_torghut_service_for_simulation",
                        return_value=None,
                    ),
                )
                report = historical_simulation_startup._apply(
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
        self.assertEqual(report["ta_restore"]["reason"], "profile_default_stateless")

    def test_apply_falls_back_to_stateless_when_restore_state_config_missing(
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
        manifest = {
            "dataset_id": "dataset-a",
            "ta_restore": {"mode": "stateless_if_missing"},
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
                        "scripts.historical_simulation_startup.replay_execution._ensure_supported_binary",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_lz4_codec_available",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._acquire_simulation_runtime_lock",
                        return_value={"status": "acquired", "run_id": resources.run_id},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._capture_cluster_state",
                        return_value={"ta_data": {"TA_GROUP_ID": "prod-ta-group"}},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_topics",
                        return_value={"status": "ok"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_clickhouse_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_clickhouse_runtime_tables",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_postgres_database"
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ensure_postgres_runtime_permissions",
                        return_value={"grants_applied": True},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._run_migrations",
                        return_value=None,
                    )
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._reset_postgres_runtime_state",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._seed_simulation_trade_cursor",
                        return_value=datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._upsert_simulation_runtime_context",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._dump_topics",
                        return_value={"records": 1, "sha256": "abc"},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._validate_dump_coverage",
                        return_value={"coverage_ratio": 1.0},
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._ta_runtime_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._torghut_service_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._configure_ta_for_simulation",
                        return_value=None,
                    ),
                )
                restart_ta = stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._restart_ta_deployment",
                        return_value="nonce",
                    ),
                )
                stack.enter_context(
                    patch(
                        "scripts.historical_simulation_startup.replay_execution._configure_torghut_service_for_simulation",
                        return_value=None,
                    ),
                )
                report = historical_simulation_startup._apply(
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
        self.assertTrue(report["ta_restore"]["fallback_applied"])
        self.assertEqual(
            report["ta_restore"]["reason"],
            "restore_state_missing:checkpoint_dir,savepoint_dir",
        )

    def test_apply_releases_runtime_lock_when_prepare_fails(self) -> None:
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
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T15:30:00Z",
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with (
                patch(
                    "scripts.historical_simulation_startup.replay_execution._ensure_supported_binary",
                    return_value=None,
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._ensure_lz4_codec_available",
                    return_value=None,
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._acquire_simulation_runtime_lock",
                    return_value={"status": "acquired", "run_id": resources.run_id},
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._capture_cluster_state",
                    return_value={
                        "ta_data": {
                            "TA_GROUP_ID": "prod-ta-group",
                            "TA_CHECKPOINT_DIR": "s3a://bucket/checkpoints",
                            "TA_SAVEPOINT_DIR": "s3a://bucket/savepoints",
                        }
                    },
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._ensure_topics",
                    side_effect=RuntimeError("topic_create_failed"),
                ),
                patch(
                    "scripts.historical_simulation_startup.replay_execution._release_simulation_runtime_lock"
                ) as release_lock,
            ):
                with self.assertRaisesRegex(RuntimeError, "topic_create_failed"):
                    historical_simulation_startup._apply(
                        resources=resources,
                        manifest=manifest,
                        kafka_config=kafka_config,
                        clickhouse_config=clickhouse_config,
                        postgres_config=postgres_config,
                        force_dump=False,
                        force_replay=False,
                    )

        release_lock.assert_called_once_with(resources=resources)

    def test_ensure_clickhouse_runtime_tables_clones_simulation_schema(self) -> None:
        queries: list[str] = []
        source_microbars = (
            "CREATE TABLE torghut.ta_microbars\\n"
            "(\\n`symbol` LowCardinality(String)\\n)\\n"
            "ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/ta_microbars', '{replica}', ingest_ts)"
        )
        source_signals = (
            "CREATE TABLE torghut.ta_signals\\n"
            "(\\n`symbol` LowCardinality(String)\\n)\\n"
            "ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/ta_signals', '{replica}', ingest_ts)"
        )

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            _ = config
            queries.append(query)
            if query == "SHOW CREATE TABLE torghut.ta_microbars":
                return 200, source_microbars
            if query == "SHOW CREATE TABLE torghut.ta_signals":
                return 200, source_signals
            if query.startswith("EXISTS TABLE torghut_sim_sim_1."):
                return 200, "1"
            return 200, ""

        with patch(
            "scripts.historical_simulation_startup.storage_and_database._http_clickhouse_query",
            side_effect=_fake_clickhouse_query,
        ):
            historical_simulation_startup._ensure_clickhouse_runtime_tables(
                config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username="torghut",
                    password="secret",
                ),
                database="torghut_sim_sim_1",
            )

        self.assertEqual(queries[0], "SHOW CREATE TABLE torghut.ta_microbars")
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS torghut_sim_sim_1.ta_microbars", queries[1]
        )
        self.assertIn(
            "/clickhouse/tables/{cluster}/{shard}/torghut_sim_sim_1/ta_microbars",
            queries[1],
        )
        self.assertEqual(queries[2], "EXISTS TABLE torghut_sim_sim_1.ta_microbars")
        self.assertEqual(queries[3], "TRUNCATE TABLE torghut_sim_sim_1.ta_microbars")
        self.assertEqual(queries[4], "SHOW CREATE TABLE torghut.ta_signals")
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS torghut_sim_sim_1.ta_signals", queries[5]
        )
        self.assertIn(
            "/clickhouse/tables/{cluster}/{shard}/torghut_sim_sim_1/ta_signals",
            queries[5],
        )
        self.assertEqual(queries[6], "EXISTS TABLE torghut_sim_sim_1.ta_signals")
        self.assertEqual(queries[7], "TRUNCATE TABLE torghut_sim_sim_1.ta_signals")

    def test_ensure_clickhouse_runtime_tables_clones_schema_across_service_endpoints(
        self,
    ) -> None:
        requests: list[tuple[str, str]] = []
        source_microbars = (
            "CREATE TABLE torghut.ta_microbars\\n"
            "(\\n`symbol` LowCardinality(String)\\n)\\n"
            "ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/ta_microbars', '{replica}', ingest_ts)"
        )
        source_signals = (
            "CREATE TABLE torghut.ta_signals\\n"
            "(\\n`symbol` LowCardinality(String)\\n)\\n"
            "ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/ta_signals', '{replica}', ingest_ts)"
        )

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            requests.append((config.http_url, query))
            if query == "SHOW CREATE TABLE torghut.ta_microbars":
                return 200, source_microbars
            if query == "SHOW CREATE TABLE torghut.ta_signals":
                return 200, source_signals
            if query.startswith("EXISTS TABLE torghut_sim_sim_1."):
                return 200, "1"
            return 200, ""

        with (
            patch(
                "scripts.historical_simulation_startup.storage_and_database._kubectl_json",
                return_value={
                    "subsets": [
                        {
                            "addresses": [
                                {"ip": "10.0.0.10"},
                                {"ip": "10.0.0.11"},
                            ]
                        }
                    ]
                },
            ),
            patch(
                "scripts.historical_simulation_startup.storage_and_database._http_clickhouse_query",
                side_effect=_fake_clickhouse_query,
            ),
        ):
            historical_simulation_startup._ensure_clickhouse_runtime_tables(
                config=ClickHouseRuntimeConfig(
                    http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
                    username="torghut",
                    password="secret",
                ),
                database="torghut_sim_sim_1",
            )

        self.assertEqual(
            requests[0],
            ("http://10.0.0.10:8123", "SHOW CREATE TABLE torghut.ta_microbars"),
        )
        self.assertEqual(requests[1][0], "http://10.0.0.10:8123")
        self.assertEqual(
            requests[2],
            ("http://10.0.0.10:8123", "EXISTS TABLE torghut_sim_sim_1.ta_microbars"),
        )
        self.assertEqual(
            requests[3],
            ("http://10.0.0.10:8123", "TRUNCATE TABLE torghut_sim_sim_1.ta_microbars"),
        )
        self.assertEqual(requests[4][0], "http://10.0.0.11:8123")
        self.assertEqual(
            requests[5],
            ("http://10.0.0.11:8123", "EXISTS TABLE torghut_sim_sim_1.ta_microbars"),
        )
        self.assertEqual(
            requests[6],
            ("http://10.0.0.11:8123", "TRUNCATE TABLE torghut_sim_sim_1.ta_microbars"),
        )
        self.assertEqual(
            requests[7],
            ("http://10.0.0.10:8123", "SHOW CREATE TABLE torghut.ta_signals"),
        )
        self.assertEqual(requests[8][0], "http://10.0.0.10:8123")
        self.assertEqual(
            requests[9],
            ("http://10.0.0.10:8123", "EXISTS TABLE torghut_sim_sim_1.ta_signals"),
        )
        self.assertEqual(
            requests[10],
            ("http://10.0.0.10:8123", "TRUNCATE TABLE torghut_sim_sim_1.ta_signals"),
        )
        self.assertEqual(requests[11][0], "http://10.0.0.11:8123")
        self.assertEqual(
            requests[12],
            ("http://10.0.0.11:8123", "EXISTS TABLE torghut_sim_sim_1.ta_signals"),
        )
        self.assertEqual(
            requests[13],
            ("http://10.0.0.11:8123", "TRUNCATE TABLE torghut_sim_sim_1.ta_signals"),
        )

    def test_wait_for_clickhouse_table_retries_until_visible(self) -> None:
        queries: list[str] = []
        responses = iter([(200, "0"), (200, "0"), (200, "1")])

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            _ = config
            queries.append(query)
            return next(responses)

        with (
            patch(
                "scripts.historical_simulation_startup.storage_and_database._http_clickhouse_query",
                side_effect=_fake_clickhouse_query,
            ),
            patch(
                "scripts.historical_simulation_startup.storage_and_database.time.sleep"
            ) as sleep_mock,
        ):
            historical_simulation_startup._wait_for_clickhouse_table(
                config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username="torghut",
                    password="secret",
                ),
                database="torghut_sim_sim_1",
                table="ta_signals",
                attempts=3,
                sleep_seconds=0.01,
            )

        self.assertEqual(
            queries,
            [
                "EXISTS TABLE torghut_sim_sim_1.ta_signals",
                "EXISTS TABLE torghut_sim_sim_1.ta_signals",
                "EXISTS TABLE torghut_sim_sim_1.ta_signals",
            ],
        )
        self.assertEqual(sleep_mock.call_count, 2)

    def test_wait_for_clickhouse_database_retries_until_visible(self) -> None:
        queries: list[str] = []
        responses = iter([(200, "0"), (200, "1")])

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            _ = config
            queries.append(query)
            return next(responses)

        with (
            patch(
                "scripts.historical_simulation_startup.storage_and_database._http_clickhouse_query",
                side_effect=_fake_clickhouse_query,
            ),
            patch(
                "scripts.historical_simulation_startup.storage_and_database.time.sleep"
            ) as sleep_mock,
        ):
            historical_simulation_startup._wait_for_clickhouse_database(
                config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username="torghut",
                    password="secret",
                ),
                database="torghut_sim_sim_1",
                attempts=2,
                sleep_seconds=0.01,
            )

        self.assertEqual(
            queries,
            [
                "EXISTS DATABASE torghut_sim_sim_1",
                "EXISTS DATABASE torghut_sim_sim_1",
            ],
        )
        self.assertEqual(sleep_mock.call_count, 1)

    def test_ensure_topics_caps_partitions_to_available_brokers(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        manifest = {"kafka": {"default_partitions": 6, "replication_factor": 1}}

        class _FakeNewTopic:
            def __init__(
                self, name: str, num_partitions: int, replication_factor: int
            ) -> None:
                self.name = name
                self.num_partitions = num_partitions
                self.replication_factor = replication_factor

        class _FakeAdmin:
            def __init__(self) -> None:
                self.created: list[_FakeNewTopic] = []
                self._client = SimpleNamespace(
                    cluster=SimpleNamespace(
                        brokers=lambda: {0, 1},
                    )
                )

            def list_topics(self) -> list[str]:
                return []

            def describe_topics(self, topics: list[str]) -> list[dict[str, object]]:
                return [
                    {
                        "topic": topic,
                        "partitions": [{}, {}, {}],
                    }
                    for topic in topics
                ]

            def create_topics(
                self, new_topics: list[_FakeNewTopic], validate_only: bool = False
            ) -> None:
                _ = validate_only
                self.created.extend(new_topics)

            def close(self) -> None:
                return None

        fake_admin = _FakeAdmin()
        with (
            patch.dict(
                "sys.modules",
                {"kafka.admin": SimpleNamespace(NewTopic=_FakeNewTopic)},
            ),
            patch(
                "scripts.historical_simulation_startup.kafka_runtime._kafka_admin_client",
                return_value=fake_admin,
            ),
        ):
            report = _ensure_topics(
                resources=resources,
                config=kafka_config,
                manifest=manifest,
            )

        created_by_topic = {topic.name: topic for topic in fake_admin.created}
        self.assertEqual(report["available_brokers"], 2)
        self.assertGreater(len(report["partition_caps"]), 0)
        self.assertEqual(
            created_by_topic[
                resources.simulation_topic_by_role["trades"]
            ].num_partitions,
            2,
        )
        self.assertEqual(
            created_by_topic[
                resources.simulation_topic_by_role["quotes"]
            ].num_partitions,
            2,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role["bars"]].num_partitions,
            2,
        )
        self.assertEqual(
            created_by_topic[
                resources.simulation_topic_by_role["status"]
            ].num_partitions,
            2,
        )

    def test_ensure_topics_respects_max_partitions_override(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        manifest = {
            "kafka": {
                "default_partitions": 6,
                "replication_factor": 1,
                "max_partitions_per_topic": 1,
            }
        }

        class _FakeNewTopic:
            def __init__(
                self, name: str, num_partitions: int, replication_factor: int
            ) -> None:
                self.name = name
                self.num_partitions = num_partitions
                self.replication_factor = replication_factor

        class _FakeAdmin:
            def __init__(self) -> None:
                self.created: list[_FakeNewTopic] = []
                self._client = SimpleNamespace(
                    cluster=SimpleNamespace(
                        brokers=lambda: {0, 1},
                    )
                )

            def list_topics(self) -> list[str]:
                return []

            def describe_topics(self, topics: list[str]) -> list[dict[str, object]]:
                return [
                    {
                        "topic": topic,
                        "partitions": [{}, {}, {}],
                    }
                    for topic in topics
                ]

            def create_topics(
                self, new_topics: list[_FakeNewTopic], validate_only: bool = False
            ) -> None:
                _ = validate_only
                self.created.extend(new_topics)

            def close(self) -> None:
                return None

        fake_admin = _FakeAdmin()
        with (
            patch.dict(
                "sys.modules",
                {"kafka.admin": SimpleNamespace(NewTopic=_FakeNewTopic)},
            ),
            patch(
                "scripts.historical_simulation_startup.kafka_runtime._kafka_admin_client",
                return_value=fake_admin,
            ),
        ):
            report = _ensure_topics(
                resources=resources,
                config=kafka_config,
                manifest=manifest,
            )

        created_by_topic = {topic.name: topic for topic in fake_admin.created}
        self.assertEqual(report["max_partitions_per_topic"], 1)
        self.assertEqual(
            created_by_topic[
                resources.simulation_topic_by_role["trades"]
            ].num_partitions,
            1,
        )
        self.assertEqual(
            created_by_topic[
                resources.simulation_topic_by_role["quotes"]
            ].num_partitions,
            1,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role["bars"]].num_partitions,
            1,
        )
        self.assertEqual(
            created_by_topic[
                resources.simulation_topic_by_role["status"]
            ].num_partitions,
            1,
        )
