from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    Any,
    KafkaRuntimeConfig,
    Path,
    SimpleNamespace,
    StartHistoricalSimulationTestCaseBase,
    TemporaryDirectory,
    _build_resources,
    _dump_topics,
    _file_sha256,
    _offset_for_time_lookup,
    json,
    patch,
    replace,
    start_historical_simulation,
)


class TestStartHistoricalSimulationDumpCacheA(StartHistoricalSimulationTestCaseBase):
    def test_offset_for_time_lookup_falls_back_for_missing_or_invalid_offset(
        self,
    ) -> None:
        class _OffsetMeta:
            def __init__(self, offset: object) -> None:
                self.offset = offset

        self.assertEqual(_offset_for_time_lookup(metadata=None, fallback=17), 17)
        self.assertEqual(
            _offset_for_time_lookup(metadata=_OffsetMeta(-1), fallback=17), 17
        )
        self.assertEqual(
            _offset_for_time_lookup(metadata=_OffsetMeta("bad"), fallback=17), 17
        )
        self.assertEqual(
            _offset_for_time_lookup(metadata=_OffsetMeta(9), fallback=17), 9
        )

    def test_dump_topics_reuses_existing_dump_with_valid_marker(self) -> None:
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
            marker_path = dump_path.with_suffix(".dump-marker.json")
            marker_path.write_text(
                json.dumps(
                    {
                        "dump_sha256": _file_sha256(dump_path),
                        "records": 1,
                    }
                ),
                encoding="utf-8",
            )

            with patch(
                "scripts.start_historical_simulation._consumer_for_dump",
                side_effect=AssertionError(
                    "expected dump reuse; consumer should not be constructed"
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={
                        "window": {
                            "start": "2026-01-01T00:00:00Z",
                            "end": "2026-01-01T01:00:00Z",
                        }
                    },
                    dump_path=dump_path,
                    force=False,
                )

            self.assertTrue(report["reused_existing_dump"])
            self.assertEqual(report["records"], 1)
            self.assertEqual(report["min_source_timestamp_ms"], 1704067200000)
            self.assertEqual(report["max_source_timestamp_ms"], 1704067200000)
            refreshed_marker = json.loads(marker_path.read_text(encoding="utf-8"))
            self.assertEqual(
                refreshed_marker.get("min_source_timestamp_ms"), 1704067200000
            )
            self.assertEqual(
                refreshed_marker.get("max_source_timestamp_ms"), 1704067200000
            )

    def test_dump_topics_redumps_when_marker_missing(self) -> None:
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

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            dump_path.write_text("{}\n", encoding="utf-8")

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
                    side_effect=RuntimeError("dump_invoked"),
                ),
                self.assertRaisesRegex(RuntimeError, "dump_invoked"),
            ):
                _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={
                        "window": {
                            "start": "2026-01-01T00:00:00Z",
                            "end": "2026-01-01T01:00:00Z",
                        }
                    },
                    dump_path=dump_path,
                    force=False,
                )

    def test_dump_topics_restores_durable_cache_hit_without_repolling_kafka(
        self,
    ) -> None:
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
        dump_line = json.dumps(
            {
                "source_topic": resources.source_topic_by_role["trades"],
                "replay_topic": resources.simulation_topic_by_role["trades"],
                "source_timestamp_ms": 1704067200000,
                "key_b64": None,
                "value_b64": None,
                "headers": [],
            }
        )
        dump_bytes = f"{dump_line}\n".encode("utf-8")
        dump_sha256 = start_historical_simulation.hashlib.sha256(dump_bytes).hexdigest()
        cache_artifact_path = (
            "s3://argo-workflows/torghut-simulation-cache/cache-key/source-dump.ndjson"
        )
        cache_manifest_path = f"{cache_artifact_path}.manifest.json"
        manifest = {
            "dataset_id": resources.dataset_id,
            "dataset_snapshot_ref": "dataset-a@snapshot-1",
            "candidate_id": "intraday_tsmom_v1@prod",
            "baseline_candidate_id": "intraday_tsmom_v1@baseline",
            "strategy_spec_ref": "strategy-specs/intraday_tsmom_v1@1.1.0.json",
            "model_refs": ["rules/intraday_tsmom_v1"],
            "runtime_version_refs": ["services/torghut@sha256:abc"],
            "cachePolicy": "prefer_cache",
            "metadata": {
                "cacheKey": "cache-key",
                "cacheDecision": "hit",
                "cacheArtifactPath": cache_artifact_path,
                "cacheChunkManifestPath": cache_manifest_path,
            },
            "performance": {
                "dumpFormat": "ndjson",
                "replayProfile": "compact",
            },
            "window": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T01:00:00Z"},
        }
        artifact_manifest = {
            "dataset_id": resources.dataset_id,
            "run_id": "prior-run",
            "lineage": start_historical_simulation._cache_lineage_payload(manifest),
            "dump_format": "ndjson",
            "cache_policy": "prefer_cache",
            "replay_profile": "compact",
            "chunk_count": 1,
            "chunks": [
                {
                    "path": cache_artifact_path,
                    "records": 1,
                    "sha256": dump_sha256,
                    "payload_sha256": dump_sha256,
                    "min_source_timestamp_ms": 1704067200000,
                    "max_source_timestamp_ms": 1704067200000,
                }
            ],
        }

        class _FakeCephClient:
            def get_object(self, *, bucket: str, key: str) -> bytes:
                if bucket != "argo-workflows":
                    raise AssertionError(f"unexpected bucket: {bucket}")
                if key.endswith(".manifest.json"):
                    return json.dumps(artifact_manifest).encode("utf-8")
                return dump_bytes

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            with (
                patch(
                    "scripts.start_historical_simulation._consumer_for_dump",
                    side_effect=AssertionError(
                        "expected durable cache restore; consumer should not be constructed"
                    ),
                ),
                patch(
                    "scripts.start_historical_simulation._simulation_cache_client_from_env",
                    return_value=(_FakeCephClient(), "argo-workflows"),
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest=manifest,
                    dump_path=dump_path,
                    force=False,
                )

            self.assertTrue(report["restored_from_cache"])
            self.assertEqual(report["records"], 1)
            self.assertEqual(report["cache_artifact_path"], cache_artifact_path)
            self.assertTrue(dump_path.exists())
            marker = json.loads(
                dump_path.with_suffix(".dump-marker.json").read_text(encoding="utf-8")
            )
            self.assertEqual(marker["dump_sha256"], dump_sha256)
            self.assertEqual(marker["records"], 1)

    def test_dump_topics_derives_durable_cache_metadata_for_local_manifests(
        self,
    ) -> None:
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
        dump_line = json.dumps(
            {
                "source_topic": resources.source_topic_by_role["trades"],
                "replay_topic": resources.simulation_topic_by_role["trades"],
                "source_timestamp_ms": 1704067200000,
                "key_b64": None,
                "value_b64": None,
                "headers": [],
            }
        )
        dump_bytes = f"{dump_line}\n".encode("utf-8")
        dump_sha256 = start_historical_simulation.hashlib.sha256(dump_bytes).hexdigest()
        manifest = {
            "dataset_id": resources.dataset_id,
            "dataset_snapshot_ref": "dataset-a@snapshot-1",
            "candidate_id": "intraday_tsmom_v1@prod",
            "baseline_candidate_id": "intraday_tsmom_v1@baseline",
            "strategy_spec_ref": "strategy-specs/intraday_tsmom_v1@1.1.0.json",
            "model_refs": ["rules/intraday_tsmom_v1"],
            "runtime_version_refs": ["services/torghut@sha256:abc"],
            "cachePolicy": "prefer_cache",
            "performance": {
                "dumpFormat": "ndjson",
                "replayProfile": "compact",
            },
            "window": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T01:00:00Z"},
        }
        cache_metadata = start_historical_simulation._cache_metadata(manifest)
        cache_artifact_path = cache_metadata["cache_artifact_path"]
        cache_manifest_path = cache_metadata["cache_manifest_path"]
        self.assertTrue(cache_metadata["cache_key"])
        self.assertTrue(cache_artifact_path.endswith("/source-dump.ndjson"))
        self.assertEqual(cache_manifest_path, f"{cache_artifact_path}.manifest.json")
        artifact_manifest = {
            "dataset_id": resources.dataset_id,
            "run_id": "prior-run",
            "lineage": start_historical_simulation._cache_lineage_payload(manifest),
            "dump_format": "ndjson",
            "cache_policy": "prefer_cache",
            "replay_profile": "compact",
            "chunk_count": 1,
            "chunks": [
                {
                    "path": cache_artifact_path,
                    "records": 1,
                    "sha256": dump_sha256,
                    "payload_sha256": dump_sha256,
                    "min_source_timestamp_ms": 1704067200000,
                    "max_source_timestamp_ms": 1704067200000,
                }
            ],
        }

        class _FakeCephClient:
            def get_object(self, *, bucket: str, key: str) -> bytes:
                if bucket != "argo-workflows":
                    raise AssertionError(f"unexpected bucket: {bucket}")
                if key.endswith(".manifest.json"):
                    return json.dumps(artifact_manifest).encode("utf-8")
                return dump_bytes

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"

            with (
                patch(
                    "scripts.start_historical_simulation._consumer_for_dump",
                    side_effect=AssertionError(
                        "expected durable cache restore; consumer should not be constructed"
                    ),
                ),
                patch(
                    "scripts.start_historical_simulation._simulation_cache_client_from_env",
                    return_value=(_FakeCephClient(), "argo-workflows"),
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest=manifest,
                    dump_path=dump_path,
                    force=False,
                )

            self.assertTrue(report["restored_from_cache"])
            self.assertEqual(report["records"], 1)
            self.assertEqual(report["cache_artifact_path"], cache_artifact_path)
            self.assertTrue(dump_path.exists())

    def test_restore_cached_dump_rejects_lineage_mismatch(self) -> None:
        manifest = {
            "dataset_id": "dataset-a",
            "dataset_snapshot_ref": "dataset-a@snapshot-2",
            "candidate_id": "intraday_tsmom_v1@prod",
            "baseline_candidate_id": "intraday_tsmom_v1@baseline",
            "strategy_spec_ref": "strategy-specs/intraday_tsmom_v1@1.1.0.json",
            "model_refs": ["rules/intraday_tsmom_v1"],
            "runtime_version_refs": ["services/torghut@sha256:def"],
            "cachePolicy": "prefer_cache",
            "performance": {
                "dumpFormat": "ndjson",
                "replayProfile": "compact",
            },
            "window": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T01:00:00Z"},
        }
        cache_metadata = start_historical_simulation._cache_metadata(manifest)
        artifact_manifest = {
            "dataset_id": "dataset-a",
            "run_id": "prior-run",
            "lineage": {
                "schema_version": "torghut-simulation-cache-v1",
                "lane": "equity",
                "dataset_id": "dataset-a",
                "dataset_snapshot_ref": "dataset-a@snapshot-1",
                "window": manifest["window"],
                "strategy_spec_ref": manifest["strategy_spec_ref"],
                "candidate_id": manifest["candidate_id"],
                "baseline_candidate_id": manifest["baseline_candidate_id"],
                "model_refs": manifest["model_refs"],
                "runtime_version_refs": ["services/torghut@sha256:abc"],
                "dump_format": "ndjson",
                "profile": "compact",
            },
            "dump_format": "ndjson",
            "cache_policy": "prefer_cache",
            "replay_profile": "compact",
            "chunk_count": 1,
            "chunks": [
                {
                    "path": cache_metadata["cache_artifact_path"],
                    "records": 1,
                    "sha256": "abc",
                    "payload_sha256": "abc",
                    "min_source_timestamp_ms": 1704067200000,
                    "max_source_timestamp_ms": 1704067200000,
                }
            ],
        }

        class _FakeCephClient:
            def get_object(self, *, bucket: str, key: str) -> bytes:
                if key.endswith(".manifest.json"):
                    return json.dumps(artifact_manifest).encode("utf-8")
                return b"{}\n"

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            with patch(
                "scripts.start_historical_simulation._simulation_cache_client_from_env",
                return_value=(_FakeCephClient(), "argo-workflows"),
            ):
                report = start_historical_simulation._restore_cached_dump_if_available(
                    manifest=manifest,
                    dump_path=dump_path,
                )

        self.assertIsNone(report)
        self.assertFalse(dump_path.exists())

    def test_restore_cached_dump_skips_explicit_non_hit_cache_decision(self) -> None:
        manifest = {
            "cachePolicy": "prefer_cache",
            "metadata": {
                "cacheKey": "cache-key",
                "cacheDecision": "miss",
                "cacheArtifactPath": "s3://argo-workflows/torghut-simulation-cache/cache-key/source-dump.ndjson",
                "cacheChunkManifestPath": (
                    "s3://argo-workflows/torghut-simulation-cache/cache-key/source-dump.ndjson.manifest.json"
                ),
            },
            "performance": {
                "dumpFormat": "ndjson",
            },
        }

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"

            with patch(
                "scripts.start_historical_simulation._simulation_cache_client_from_env",
                side_effect=AssertionError(
                    "non-hit cache decisions must not attempt restore"
                ),
            ):
                report = start_historical_simulation._restore_cached_dump_if_available(
                    manifest=manifest,
                    dump_path=dump_path,
                )

        self.assertIsNone(report)
        self.assertFalse(dump_path.exists())

    def test_simulation_cache_upload_timeout_seconds_scales_with_dump_size(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.jsonl.zst"
            dump_path.write_bytes(b"x" * (5 * 1024 * 1024))

            timeout_seconds = (
                start_historical_simulation._simulation_cache_upload_timeout_seconds(
                    dump_path
                )
            )

        self.assertGreaterEqual(timeout_seconds, 60)

    def test_upload_dump_to_cache_retries_transient_timeout(self) -> None:
        manifest = {
            "dataset_id": "dataset-a",
            "dataset_snapshot_ref": "dataset-a@snapshot-1",
            "candidate_id": "intraday_tsmom_v1@prod",
            "baseline_candidate_id": "intraday_tsmom_v1@baseline",
            "strategy_spec_ref": "strategy-specs/intraday_tsmom_v1@1.1.0.json",
            "model_refs": ["rules/intraday_tsmom_v1"],
            "runtime_version_refs": ["services/torghut@sha256:abc"],
            "cachePolicy": "refresh",
            "performance": {
                "dumpFormat": "ndjson",
                "replayProfile": "compact",
            },
            "window": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T01:00:00Z"},
        }
        client_timeouts: list[int | None] = []
        put_attempts: list[tuple[str, str]] = []

        class _FakeCephClient:
            def __init__(self, timeout_seconds: int | None) -> None:
                self.timeout_seconds = timeout_seconds
                self._attempt = 0

            def put_object(
                self,
                *,
                bucket: str,
                key: str,
                body: bytes,
                content_type: str,
            ) -> dict[str, Any]:
                _ = (body, content_type)
                put_attempts.append((bucket, key))
                self._attempt += 1
                if self._attempt == 1:
                    raise TimeoutError("timed out")
                return {"etag": f"etag-{self._attempt}"}

        def _fake_cache_client(timeout_seconds: int | None = None) -> tuple[Any, str]:
            client_timeouts.append(timeout_seconds)
            return _FakeCephClient(timeout_seconds), "argo-workflows"

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
            dump_path.write_bytes(b"{}\n")
            dump_manifest_path = (
                start_historical_simulation._dump_artifact_manifest_path(dump_path)
            )
            dump_manifest_path.write_text(
                json.dumps(
                    {
                        "dataset_id": "dataset-a",
                        "run_id": "sim-1",
                        "lineage": start_historical_simulation._cache_lineage_payload(
                            manifest
                        ),
                        "dump_format": "ndjson",
                        "cache_policy": "refresh",
                        "replay_profile": "compact",
                        "chunk_count": 1,
                        "chunks": [
                            {
                                "path": str(dump_path),
                                "records": 1,
                                "sha256": "abc",
                                "payload_sha256": "abc",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with (
                patch(
                    "scripts.start_historical_simulation._simulation_cache_client_from_env",
                    side_effect=_fake_cache_client,
                ),
                patch(
                    "scripts.start_historical_simulation.time.sleep",
                    return_value=None,
                ),
            ):
                report = start_historical_simulation._upload_dump_to_cache(
                    manifest=manifest,
                    dump_path=dump_path,
                )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["attempt_count"], 2)
        self.assertEqual(len(client_timeouts), 1)
        self.assertGreaterEqual(client_timeouts[0] or 0, 60)
        self.assertEqual(len(put_attempts), 3)

    def test_dump_topics_records_cache_upload_error_without_failing_fresh_dump(
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
                        self._tp: [_Record(self._tp[0], self._tp[1], 0, 1735693200100)],
                    }
                return {}

            def position(self, tp: tuple[str, int]) -> int:
                _ = tp
                return self._position

            def close(self) -> None:
                return None

        manifest = {
            "dataset_id": "dataset-a",
            "dataset_snapshot_ref": "dataset-a@snapshot-1",
            "candidate_id": "intraday_tsmom_v1@prod",
            "baseline_candidate_id": "intraday_tsmom_v1@baseline",
            "strategy_spec_ref": "strategy-specs/intraday_tsmom_v1@1.1.0.json",
            "model_refs": ["rules/intraday_tsmom_v1"],
            "runtime_version_refs": ["services/torghut@sha256:abc"],
            "cachePolicy": "refresh",
            "performance": {
                "dumpFormat": "ndjson",
                "replayProfile": "compact",
            },
            "window": {"start": "2025-01-01T00:00:00Z", "end": "2025-01-01T00:00:01Z"},
        }

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / "source-dump.ndjson"
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
                patch(
                    "scripts.start_historical_simulation._upload_dump_to_cache",
                    side_effect=TimeoutError("timed out"),
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
        self.assertEqual(report["cache_upload"]["status"], "error")
        self.assertEqual(report["cache_upload"]["error"], "timed out")

    def test_dump_topics_orders_output_deterministically_across_partitions(
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
                self._positions = {
                    (self._topic, 0): 0,
                    (self._topic, 1): 0,
                }
                self._offset_lookup_calls = 0
                self._poll_calls = 0

            def partitions_for_topic(self, topic: str) -> set[int]:
                self._topic = topic
                return {0, 1}

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
                self._positions[tp] = offset

            def poll(
                self, timeout_ms: int = 0, max_records: int = 0
            ) -> dict[tuple[str, int], list[_Record]]:
                _ = (timeout_ms, max_records)
                self._poll_calls += 1
                if self._poll_calls == 1:
                    self._positions[(self._topic, 1)] = 1
                    self._positions[(self._topic, 0)] = 1
                    return {
                        (self._topic, 1): [_Record(self._topic, 1, 0, 1735693200200)],
                        (self._topic, 0): [_Record(self._topic, 0, 0, 1735693200100)],
                    }
                return {}

            def position(self, tp: tuple[str, int]) -> int:
                return self._positions[tp]

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

            lines = [
                json.loads(line)
                for line in dump_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(report["records"], 2)
            self.assertEqual(
                [
                    (
                        line["source_timestamp_ms"],
                        line["source_partition"],
                        line["source_offset"],
                    )
                    for line in lines
                ],
                [
                    (1735693200100, 0, 0),
                    (1735693200200, 1, 0),
                ],
            )
