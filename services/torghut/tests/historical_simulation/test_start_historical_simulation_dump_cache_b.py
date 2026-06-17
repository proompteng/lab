from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    Any,
    KafkaRuntimeConfig,
    Path,
    PostgresRuntimeConfig,
    SimpleNamespace,
    StartHistoricalSimulationTestCaseBase,
    TemporaryDirectory,
    _build_resources,
    _dump_sha256_for_replay,
    _dump_topics,
    _materialize_deterministic_dump,
    _producer_for_replay,
    _replay_dump,
    _restore_ta_configuration,
    _restore_torghut_env,
    _verify_isolation_guards,
    gzip,
    json,
    patch,
    replace,
    start_historical_simulation,
)


class TestStartHistoricalSimulationDumpCacheB(StartHistoricalSimulationTestCaseBase):
    def test_materialize_deterministic_dump_bounds_sort_memory_and_uses_stage_tmpdir(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            staged_path = dump_path.with_suffix(dump_path.suffix + ".sort-stage.tsv")
            staged_path.write_text(
                "\n".join(
                    [
                        '00000000000000000002\ttorghut.trades.v1\t0000000001\t00000000000000000001\t{"row":2}',
                        '00000000000000000001\ttorghut.trades.v1\t0000000000\t00000000000000000000\t{"row":1}',
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            captured: dict[str, Any] = {}

            def _fake_run(*args: Any, **kwargs: Any) -> SimpleNamespace:
                command = args[0]
                stdout = kwargs["stdout"]
                captured["command"] = command
                captured["env"] = kwargs["env"]
                sorted_rows = sorted(
                    staged_path.read_text(encoding="utf-8").splitlines()
                )
                stdout.write("\n".join(sorted_rows) + "\n")
                return SimpleNamespace(returncode=0)

            with (
                patch.dict(
                    "os.environ",
                    {"TORGHUT_SIM_DUMP_SORT_MEMORY_LIMIT": "768M"},
                    clear=False,
                ),
                patch(
                    "scripts.start_historical_simulation.subprocess.run",
                    side_effect=_fake_run,
                ),
            ):
                payload_sha = _materialize_deterministic_dump(
                    staged_path=staged_path,
                    dump_path=dump_path,
                )

            self.assertEqual(
                captured["command"][:6],
                ["sort", "-S", "768M", "-T", str(staged_path.parent), "-t"],
            )
            self.assertEqual(captured["env"]["LC_ALL"], "C")
            self.assertEqual(
                dump_path.read_text(encoding="utf-8").splitlines(),
                ['{"row":1}', '{"row":2}'],
            )
            self.assertEqual(
                payload_sha,
                start_historical_simulation._dump_sha256_for_replay(dump_path),
            )

    def test_dump_topics_cleans_compressed_sort_temps(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        resources = replace(
            resources,
            replay_topic_by_source_topic={"torghut.trades.v1": "torghut.sim.trades.v1"},
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )

        class _OffsetMeta:
            def __init__(self, offset: int) -> None:
                self.offset = offset

        class _Record:
            def __init__(
                self, topic: str, partition: int, offset: int, timestamp: int
            ) -> None:
                self.topic = topic
                self.partition = partition
                self.offset = offset
                self.timestamp = timestamp
                self.key = None
                self.value = None
                self.headers: list[tuple[str, bytes]] = []

        class _FakeConsumer:
            def __init__(self) -> None:
                self._topic = "torghut.trades.v1"
                self._position = 0
                self._offset_lookup_calls = 0
                self._poll_calls = 0

            def partitions_for_topic(self, topic: str) -> set[int]:
                self._topic = topic
                return {0}

            def assign(self, topic_partitions: list[tuple[str, int]]) -> None:
                self._topic_partitions = topic_partitions

            def beginning_offsets(
                self, topic_partitions: list[tuple[str, int]]
            ) -> dict[tuple[str, int], int]:
                return {tp: 0 for tp in topic_partitions}

            def end_offsets(
                self, topic_partitions: list[tuple[str, int]]
            ) -> dict[tuple[str, int], int]:
                return {tp: 1 for tp in topic_partitions}

            def offsets_for_times(
                self,
                request: dict[tuple[str, int], int],
            ) -> dict[tuple[str, int], _OffsetMeta]:
                self._offset_lookup_calls += 1
                offset = 0 if self._offset_lookup_calls == 1 else 1
                return {tp: _OffsetMeta(offset) for tp in request}

            def seek(self, tp: tuple[str, int], offset: int) -> None:
                self._position = offset

            def poll(
                self, timeout_ms: int = 0, max_records: int = 0
            ) -> dict[tuple[str, int], list[_Record]]:
                _ = (timeout_ms, max_records)
                self._poll_calls += 1
                if self._poll_calls == 1:
                    self._position = 1
                    return {
                        (self._topic, 0): [_Record(self._topic, 0, 0, 1735693200100)],
                    }
                return {}

            def position(self, tp: tuple[str, int]) -> int:
                _ = tp
                return self._position

            def close(self) -> None:
                return None

        manifest = {
            "performance": {
                "dumpFormat": "jsonl.gz",
            },
            "window": {"start": "2025-01-01T00:00:00Z", "end": "2025-01-01T00:00:01Z"},
        }

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.jsonl.gz"
            raw_dump_path = dump_path.with_suffix(dump_path.suffix + ".tmp.ndjson")
            staged_dump_path = dump_path.with_suffix(
                dump_path.suffix + ".sort-stage.tsv"
            )
            sorted_dump_path = raw_dump_path.with_suffix(
                raw_dump_path.suffix + ".sort-output.tsv"
            )

            with (
                patch.dict(
                    "sys.modules",
                    {
                        "kafka": SimpleNamespace(
                            TopicPartition=lambda topic, partition: (topic, partition)
                        )
                    },
                ),
                patch(
                    "scripts.start_historical_simulation._consumer_for_dump",
                    return_value=_FakeConsumer(),
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest=manifest,
                    dump_path=dump_path,
                    force=True,
                )

            self.assertEqual(report["records"], 1)
            self.assertTrue(dump_path.exists())
            self.assertFalse(raw_dump_path.exists())
            self.assertFalse(staged_dump_path.exists())
            self.assertFalse(sorted_dump_path.exists())
            with gzip.open(dump_path, "rt", encoding="utf-8") as handle:
                lines = [json.loads(line) for line in handle]
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["source_timestamp_ms"], 1735693200100)

    def test_dump_topics_completes_when_last_record_reaches_stop_offset(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        resources = replace(
            resources,
            replay_topic_by_source_topic={"torghut.trades.v1": "torghut.sim.trades.v1"},
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )

        class _OffsetMeta:
            def __init__(self, offset: int) -> None:
                self.offset = offset

        class _Record:
            def __init__(
                self, topic: str, partition: int, offset: int, timestamp: int
            ) -> None:
                self.topic = topic
                self.partition = partition
                self.offset = offset
                self.timestamp = timestamp
                self.key = None
                self.value = None
                self.headers: list[tuple[str, bytes]] = []

        class _FakeConsumer:
            def __init__(self) -> None:
                self._tp = ("torghut.trades.v1", 0)
                self._position = 0
                self._poll_calls = 0
                self._offset_lookup_calls = 0

            def partitions_for_topic(self, topic: str) -> set[int]:
                self._topic = topic
                return {0}

            def assign(self, topic_partitions: list[tuple[str, int]]) -> None:
                self._topic_partitions = topic_partitions

            def beginning_offsets(
                self, topic_partitions: list[tuple[str, int]]
            ) -> dict[tuple[str, int], int]:
                return {tp: 0 for tp in topic_partitions}

            def end_offsets(
                self, topic_partitions: list[tuple[str, int]]
            ) -> dict[tuple[str, int], int]:
                return {tp: 3 for tp in topic_partitions}

            def offsets_for_times(
                self,
                request: dict[tuple[str, int], int],
            ) -> dict[tuple[str, int], _OffsetMeta]:
                self._offset_lookup_calls += 1
                offset = 0 if self._offset_lookup_calls == 1 else 3
                return {tp: _OffsetMeta(offset) for tp in request}

            def seek(self, tp: tuple[str, int], offset: int) -> None:
                self._position = offset

            def poll(
                self, timeout_ms: int = 0, max_records: int = 0
            ) -> dict[tuple[str, int], list[_Record]]:
                _ = (timeout_ms, max_records)
                self._poll_calls += 1
                if self._poll_calls == 1:
                    return {
                        self._tp: [
                            _Record(self._tp[0], self._tp[1], 0, 1735693200000),
                            _Record(self._tp[0], self._tp[1], 1, 1735693200100),
                            _Record(self._tp[0], self._tp[1], 2, 1735693200200),
                        ]
                    }
                if self._poll_calls > 5:
                    raise AssertionError(
                        "dump loop did not terminate after final in-window record"
                    )
                return {}

            def position(self, tp: tuple[str, int]) -> int:
                _ = tp
                # Simulate the live failure: consumer position stays on the last written offset.
                return 2

            def close(self) -> None:
                return None

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            fake_consumer = _FakeConsumer()

            with (
                patch.dict(
                    "sys.modules",
                    {
                        "kafka": SimpleNamespace(
                            TopicPartition=lambda topic, partition: (topic, partition)
                        )
                    },
                ),
                patch(
                    "scripts.start_historical_simulation._consumer_for_dump",
                    return_value=fake_consumer,
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={
                        "window": {
                            "start": "2025-01-01T00:00:00Z",
                            "end": "2025-01-01T00:00:01Z",
                        }
                    },
                    dump_path=dump_path,
                    force=True,
                )

            self.assertEqual(report["records"], 3)
            self.assertEqual(report["records_by_topic"], {"torghut.trades.v1": 3})
            self.assertFalse(report["reused_existing_dump"])

    def test_dump_topics_completes_when_global_expected_record_count_is_reached(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        resources = replace(
            resources,
            replay_topic_by_source_topic={
                "torghut.quotes.v1": "torghut.sim.quotes.v1",
                "torghut.trades.v1": "torghut.sim.trades.v1",
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka:9092",
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )

        class _OffsetMeta:
            def __init__(self, offset: int) -> None:
                self.offset = offset

        class _Record:
            def __init__(
                self, topic: str, partition: int, offset: int, timestamp: int
            ) -> None:
                self.topic = topic
                self.partition = partition
                self.offset = offset
                self.timestamp = timestamp
                self.key = None
                self.value = None
                self.headers: list[tuple[str, bytes]] = []

        class _FakeConsumer:
            def __init__(self) -> None:
                self._positions = {
                    ("torghut.quotes.v1", 0): 0,
                    ("torghut.trades.v1", 0): 0,
                }
                self._poll_calls = 0
                self._offset_lookup_calls = 0

            def partitions_for_topic(self, topic: str) -> set[int]:
                _ = topic
                return {0}

            def assign(self, topic_partitions: list[tuple[str, int]]) -> None:
                self._topic_partitions = topic_partitions

            def beginning_offsets(
                self, topic_partitions: list[tuple[str, int]]
            ) -> dict[tuple[str, int], int]:
                return {tp: 0 for tp in topic_partitions}

            def end_offsets(
                self, topic_partitions: list[tuple[str, int]]
            ) -> dict[tuple[str, int], int]:
                return {
                    ("torghut.quotes.v1", 0): 0,
                    ("torghut.trades.v1", 0): 3,
                }

            def offsets_for_times(
                self,
                request: dict[tuple[str, int], int],
            ) -> dict[tuple[str, int], _OffsetMeta]:
                self._offset_lookup_calls += 1
                quotes_offset = 0
                trades_offset = 0 if self._offset_lookup_calls == 1 else 3
                return {
                    ("torghut.quotes.v1", 0): _OffsetMeta(quotes_offset),
                    ("torghut.trades.v1", 0): _OffsetMeta(trades_offset),
                }

            def seek(self, tp: tuple[str, int], offset: int) -> None:
                self._positions[tp] = offset

            def poll(
                self, timeout_ms: int = 0, max_records: int = 0
            ) -> dict[tuple[str, int], list[_Record]]:
                _ = (timeout_ms, max_records)
                self._poll_calls += 1
                if self._poll_calls == 1:
                    return {
                        ("torghut.trades.v1", 0): [
                            _Record("torghut.trades.v1", 0, 0, 1735695000000),
                            _Record("torghut.trades.v1", 0, 1, 1735695000100),
                            _Record("torghut.trades.v1", 0, 2, 1735695000200),
                        ]
                    }
                if self._poll_calls > 3:
                    raise AssertionError(
                        "dump loop did not terminate after global expected record count"
                    )
                return {}

            def position(self, tp: tuple[str, int]) -> int:
                if tp == ("torghut.quotes.v1", 0):
                    # Simulate a partition that never self-marks done even though it has zero expected records.
                    return -1
                return 2

            def close(self) -> None:
                return None

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            fake_consumer = _FakeConsumer()

            with (
                patch.dict(
                    "sys.modules",
                    {
                        "kafka": SimpleNamespace(
                            TopicPartition=lambda topic, partition: (topic, partition)
                        )
                    },
                ),
                patch(
                    "scripts.start_historical_simulation._consumer_for_dump",
                    return_value=fake_consumer,
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={
                        "window": {
                            "start": "2025-01-01T00:00:00Z",
                            "end": "2025-01-01T00:00:01Z",
                        }
                    },
                    dump_path=dump_path,
                    force=True,
                )

            self.assertEqual(report["records"], 3)
            self.assertEqual(report["expected_records"], 3)
            self.assertEqual(report["records_by_topic"], {"torghut.trades.v1": 3})
            self.assertFalse(report["reused_existing_dump"])

    def test_verify_isolation_guards_rejects_simulation_topic_overlap(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
                "simulation_topics": {
                    "trades": "torghut.trades.v1",
                },
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="uv run --frozen alembic upgrade heads",
        )

        with self.assertRaisesRegex(
            RuntimeError, "simulation_topics_isolated_from_sources"
        ):
            _verify_isolation_guards(
                resources=resources,
                postgres_config=postgres_config,
                ta_data={"TA_GROUP_ID": "torghut-ta-main"},
            )

    def test_verify_isolation_guards_accepts_options_auxiliary_tables(self) -> None:
        resources = _build_resources(
            "options-sim-1",
            {
                "schema_version": "torghut.options-simulation-manifest.v1",
                "lane": "options",
                "dataset_id": "dataset-a",
                "feed": "indicative",
                "underlyings": ["AAPL"],
                "contract_policy": {"dte_min": 5, "dte_max": 45},
                "catalog_snapshot_ref": "artifacts/options/catalog.json",
                "raw_source_policy": {"prefer_kafka": True},
                "cost_model": {"contract_multiplier": 100},
                "proof_gates": {"minimum_contracts": 5},
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_options_sim_1",
            simulation_db="torghut_sim_options_sim_1",
            migrations_command="uv run --frozen alembic upgrade heads",
        )

        report = _verify_isolation_guards(
            resources=resources,
            postgres_config=postgres_config,
            ta_data={"OPTIONS_TA_GROUP_ID": "torghut-options-ta-main"},
        )

        self.assertEqual(report["lane"], "options")
        self.assertTrue(report["auxiliary_tables_isolated"])

    def test_replay_dump_ignores_stale_marker_when_dump_changes(self) -> None:
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

        class _FakeProducer:
            def __init__(self) -> None:
                self.sent: list[tuple[str, int | None]] = []

            def send(
                self,
                topic: str,
                *,
                key: bytes | None = None,
                value: bytes | None = None,
                headers: list[tuple[str, bytes]] | None = None,
                timestamp_ms: int | None = None,
            ) -> None:
                _ = (key, value, headers)
                self.sent.append((topic, timestamp_ms))

            def flush(self, timeout: int) -> None:
                _ = timeout

            def close(self, timeout: int) -> None:
                _ = timeout

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            row = {
                "source_topic": resources.source_topic_by_role["trades"],
                "replay_topic": resources.simulation_topic_by_role["trades"],
                "source_timestamp_ms": 1704067200000,
                "key_b64": None,
                "value_b64": None,
                "headers": [],
            }
            dump_path.write_text(json.dumps(row) + "\n", encoding="utf-8")

            marker_path = dump_path.with_suffix(".replay-marker.json")
            marker_path.write_text(
                json.dumps(
                    {
                        "reused_existing_replay": False,
                        "records": 999,
                        "dump_sha256": "stale-checksum",
                    }
                ),
                encoding="utf-8",
            )

            producer = _FakeProducer()
            with patch(
                "scripts.start_historical_simulation._producer_for_replay",
                return_value=producer,
            ):
                report = _replay_dump(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={"replay": {"pace_mode": "max_throughput"}},
                    dump_path=dump_path,
                    force=False,
                )
            self.assertFalse(report["reused_existing_replay"])
            self.assertEqual(report["records"], 1)
            self.assertEqual(
                producer.sent,
                [(resources.simulation_topic_by_role["trades"], 1704067200000)],
            )
            marker_payload = json.loads(marker_path.read_text(encoding="utf-8"))
            self.assertEqual(
                marker_payload.get("dump_sha256"),
                _dump_sha256_for_replay(dump_path),
            )

    def test_replay_dump_prefers_current_mapping_over_dump_replay_topic(self) -> None:
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

        class _FakeProducer:
            def __init__(self) -> None:
                self.sent: list[tuple[str, int | None]] = []

            def send(
                self,
                topic: str,
                *,
                key: bytes | None = None,
                value: bytes | None = None,
                headers: list[tuple[str, bytes]] | None = None,
                timestamp_ms: int | None = None,
            ) -> None:
                _ = (key, value, headers)
                self.sent.append((topic, timestamp_ms))

            def flush(self, timeout: int) -> None:
                _ = timeout

            def close(self, timeout: int) -> None:
                _ = timeout

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            row = {
                "source_topic": resources.source_topic_by_role["trades"],
                "replay_topic": "torghut.sim.legacy.trades.v1",
                "source_timestamp_ms": 1704067200000,
                "key_b64": None,
                "value_b64": None,
                "headers": [],
            }
            dump_path.write_text(json.dumps(row) + "\n", encoding="utf-8")

            producer = _FakeProducer()
            with patch(
                "scripts.start_historical_simulation._producer_for_replay",
                return_value=producer,
            ):
                report = _replay_dump(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={"replay": {"pace_mode": "max_throughput"}},
                    dump_path=dump_path,
                    force=True,
                )

            self.assertEqual(
                producer.sent,
                [(resources.simulation_topic_by_role["trades"], 1704067200000)],
            )
            self.assertEqual(report["replay_topic_overrides"], 1)

    def test_replay_producer_uses_runtime_kafka_connection(self) -> None:
        captured: dict[str, object] = {}

        class _FakeProducer:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

            def send(
                self,
                topic: str,
                *,
                key: bytes | None = None,
                value: bytes | None = None,
                headers: list[tuple[str, bytes]] | None = None,
                timestamp_ms: int | None = None,
            ) -> None:
                _ = (topic, key, value, headers, timestamp_ms)

            def flush(self, timeout: int | float | None = None) -> None:
                _ = timeout

            def close(self, timeout: int | float | None = None) -> None:
                _ = timeout

        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers="kafka-source:9092",
            security_protocol="PLAINTEXT",
            sasl_mechanism="SCRAM-SHA-512",
            sasl_username="source-user",
            sasl_password="source-secret",
            runtime_bootstrap_servers="kafka-runtime:9092",
            runtime_security_protocol="SASL_SSL",
            runtime_sasl_mechanism="SCRAM-SHA-256",
            runtime_sasl_username="runtime-user",
            runtime_sasl_password="runtime-secret",
        )

        with patch.dict(
            "sys.modules",
            {"kafka": SimpleNamespace(KafkaProducer=_FakeProducer)},
        ):
            _producer_for_replay(kafka_config, "sim-run")

        self.assertEqual(captured.get("bootstrap_servers"), ["kafka-runtime:9092"])
        self.assertEqual(captured.get("security_protocol"), "SASL_SSL")
        self.assertEqual(captured.get("sasl_mechanism"), "SCRAM-SHA-256")
        self.assertEqual(captured.get("sasl_plain_username"), "runtime-user")
        self.assertEqual(captured.get("sasl_plain_password"), "runtime-secret")

    def test_restore_ta_configuration_removes_simulation_only_keys(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        state = {
            "ta_data": {
                "TA_GROUP_ID": "torghut-ta-main",
                "TA_TRADES_TOPIC": "torghut.trades.v1",
            }
        }
        current_configmap = {
            "data": {
                "TA_GROUP_ID": "torghut-ta-sim-sim_1",
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1",
                "TA_AUTO_OFFSET_RESET": "earliest",
            }
        }

        with (
            patch(
                "scripts.start_historical_simulation._kubectl_json",
                return_value=current_configmap,
            ),
            patch("scripts.start_historical_simulation._kubectl_patch") as patch_mock,
        ):
            _restore_ta_configuration(resources, state)

        patch_mock.assert_called_once_with(
            resources.namespace,
            "configmap",
            resources.ta_configmap,
            {
                "data": {
                    "TA_GROUP_ID": "torghut-ta-main",
                    "TA_TRADES_TOPIC": "torghut.trades.v1",
                    "TA_AUTO_OFFSET_RESET": None,
                }
            },
        )

    def test_restore_torghut_env_reverts_runtime_overrides_and_trading_enabled(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
            },
        )
        state = {
            "torghut_env_snapshot": {
                "TRADING_ENABLED": {
                    "name": "TRADING_ENABLED",
                    "value": "false",
                },
                "TRADING_MODE": {
                    "name": "TRADING_MODE",
                    "value": "live",
                },
            }
        }
        service_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "env": [
                                    {"name": "TRADING_ENABLED", "value": "true"},
                                    {"name": "TRADING_MODE", "value": "simulation"},
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
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
                "scripts.start_historical_simulation._kubectl_json",
                return_value=service_payload,
            ),
            patch(
                "scripts.start_historical_simulation._kubectl_patch",
                side_effect=lambda namespace, kind, name, patch: captured_patch.update(
                    {"namespace": namespace, "kind": kind, "name": name, "patch": patch}
                ),
            ),
        ):
            _restore_torghut_env(resources, state)

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
            env_by_name["TRADING_ENABLED"].get("value"),
            "false",
        )
        self.assertEqual(
            env_by_name["TRADING_MODE"].get("value"),
            "live",
        )
        self.assertNotIn("TRADING_SIMULATION_ENABLED", env_by_name)
