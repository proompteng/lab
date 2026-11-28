from __future__ import annotations

from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from scripts import (
    historical_simulation_runtime_verification as runtime_verification,
)
from scripts import (
    historical_simulation_startup,
)
from scripts.historical_simulation_runtime_verification import shared_runtime
from scripts.historical_simulation_startup import (
    ClickHouseRuntimeConfig,
    _build_plan_report,
    _build_postgres_runtime_config,
    _clickhouse_query_configs,
    _http_clickhouse_query,
    _pacing_delay_seconds,
    replay_execution,
    storage_and_database,
)
from tests.historical_simulation.fixtures import (
    SimulationOrchestrationTestCase,
    make_argocd_config,
    make_clickhouse_config,
    make_kafka_config,
    make_postgres_config,
    simulation_resources,
    stub_replay_preflight,
    stub_replay_storage,
)


class TestStartHistoricalSimulationClickhouse(SimulationOrchestrationTestCase):
    def test_pacing_delay_modes(self) -> None:
        self.assertEqual(
            _pacing_delay_seconds(
                mode="max_throughput",
                previous_timestamp_ms=1000,
                current_timestamp_ms=4000,
                acceleration=10.0,
            ),
            0.0,
        )
        self.assertEqual(
            _pacing_delay_seconds(
                mode="event_time",
                previous_timestamp_ms=1000,
                current_timestamp_ms=4000,
                acceleration=10.0,
            ),
            3.0,
        )
        self.assertEqual(
            _pacing_delay_seconds(
                mode="accelerated",
                previous_timestamp_ms=1000,
                current_timestamp_ms=4000,
                acceleration=3.0,
            ),
            1.0,
        )

    def test_plan_report_contains_expected_paths(self) -> None:
        resources = simulation_resources()
        postgres_config = _build_postgres_runtime_config(
            {
                "postgres": {
                    "admin_dsn": "postgresql://torghut:secret@localhost:5432/postgres",
                    "simulation_dsn": "postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
                }
            },
            simulation_db="torghut_sim_sim_1",
        )
        report = _build_plan_report(
            resources=resources,
            kafka_config=make_kafka_config(),
            clickhouse_config=make_clickhouse_config(
                password=None,
            ),
            postgres_config=postgres_config,
            argocd_config=make_argocd_config(
                manage_automation=False,
            ),
            manifest={
                "window": {
                    "start": "2026-01-01T00:00:00Z",
                    "end": "2026-01-01T01:00:00Z",
                }
            },
        )
        self.assertEqual(report["run_id"], "sim-1")
        self.assertIn("state_path", report["artifacts"])
        self.assertIn("run_manifest_path", report["artifacts"])
        self.assertIn("dump_path", report["artifacts"])
        self.assertEqual(report["ta_restore"]["mode"], "stateless")
        self.assertEqual(report["ta_restore"]["source"], "profile_default:hourly")
        postgres_dsn = report["resources"]["postgres_simulation_dsn"]
        assert isinstance(postgres_dsn, str)
        self.assertIn(":***@", postgres_dsn)
        self.assertNotIn(":secret@", postgres_dsn)

    def test_http_clickhouse_query_uses_post_with_query_body(self) -> None:
        captured: dict[str, object] = {}

        class _FakeResponse:
            status = 200

            def read(self) -> bytes:
                return b"1"

        class _FakeConnection:
            def __init__(self, host: str, port: int | None) -> None:
                captured["host"] = host
                captured["port"] = port

            def request(
                self,
                method: str,
                path: str,
                body: bytes | None = None,
                headers: dict[str, str] | None = None,
            ) -> None:
                captured["method"] = method
                captured["path"] = path
                captured["body"] = body
                captured["headers"] = headers

            def getresponse(self) -> _FakeResponse:
                return _FakeResponse()

            def close(self) -> None:
                captured["closed"] = True

        with patch.object(
            shared_runtime,
            "HTTPConnection",
            _FakeConnection,
        ):
            status, body = _http_clickhouse_query(
                config=make_clickhouse_config(
                    password="secret",
                ),
                query="SELECT 1",
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, "1")
        self.assertEqual(captured.get("host"), "clickhouse")
        self.assertEqual(captured.get("port"), 8123)
        self.assertEqual(captured.get("method"), "POST")
        self.assertEqual(captured.get("path"), "/")
        self.assertEqual(captured.get("body"), b"SELECT 1")
        headers = captured.get("headers")
        self.assertIsInstance(headers, dict)
        assert isinstance(headers, dict)
        self.assertEqual(headers.get("Content-Type"), "text/plain")
        self.assertEqual(headers.get("X-ClickHouse-User"), "torghut")
        self.assertEqual(headers.get("X-ClickHouse-Key"), "secret")

    def test_verification_http_clickhouse_query_retries_kubernetes_service_endpoints(
        self,
    ) -> None:
        attempted_hosts: list[str] = []

        class _FakeResponse:
            status = 200

            def read(self) -> bytes:
                return b"1"

        class _FakeConnection:
            def __init__(self, host: str, port: int | None) -> None:
                attempted_hosts.append(host)
                self._host = host

            def request(
                self,
                method: str,
                path: str,
                body: bytes | None = None,
                headers: dict[str, str] | None = None,
            ) -> None:
                if self._host == "torghut-clickhouse.torghut.svc.cluster.local":
                    raise OSError(
                        "[Errno 8] nodename nor servname provided, or not known"
                    )

            def getresponse(self) -> _FakeResponse:
                return _FakeResponse()

            def close(self) -> None:
                return None

        def _fake_kubectl_json(
            namespace: str, args: tuple[str, ...]
        ) -> dict[str, object]:
            self.assertEqual(namespace, "torghut")
            if list(args[:3]) == ["get", "service", "torghut-clickhouse"]:
                return {"spec": {"clusterIP": "10.104.171.228"}}
            if list(args[:3]) == ["get", "endpoints", "torghut-clickhouse"]:
                return {"subsets": []}
            self.fail(f"unexpected kubectl args: {args!r}")

        with (
            patch.object(
                shared_runtime,
                "HTTPConnection",
                _FakeConnection,
            ),
            patch.object(
                shared_runtime,
                "_kubectl_json",
                side_effect=_fake_kubectl_json,
            ),
        ):
            status, body = runtime_verification._http_clickhouse_query(
                config=ClickHouseRuntimeConfig(
                    http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
                    username="torghut",
                    password="secret",
                ),
                query="SELECT 1",
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, "1")
        self.assertEqual(
            attempted_hosts,
            ["torghut-clickhouse.torghut.svc.cluster.local", "10.104.171.228"],
        )

    def test_clickhouse_query_configs_resolves_service_endpoints(self) -> None:
        config = ClickHouseRuntimeConfig(
            http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
            username="torghut",
            password="secret",
        )
        with patch.object(
            storage_and_database,
            "_kubectl_json",
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
        ):
            resolved = _clickhouse_query_configs(config)

        self.assertEqual(
            [item.http_url for item in resolved],
            [
                "http://10.0.0.10:8123",
                "http://10.0.0.11:8123",
            ],
        )
        self.assertTrue(all(item.username == "torghut" for item in resolved))
        self.assertTrue(all(item.password == "secret" for item in resolved))

    def test_ensure_clickhouse_database_applies_to_all_service_endpoints(self) -> None:
        requests: list[tuple[str, str]] = []

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            requests.append((config.http_url, query))
            if query == "EXISTS DATABASE torghut_sim_sim_1":
                return 200, "1"
            return 200, ""

        with (
            patch.object(
                storage_and_database,
                "_kubectl_json",
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
            patch.object(
                storage_and_database,
                "_http_clickhouse_query",
                side_effect=_fake_clickhouse_query,
            ),
        ):
            historical_simulation_startup._ensure_clickhouse_database(
                config=ClickHouseRuntimeConfig(
                    http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
                    username="torghut",
                    password="secret",
                ),
                database="torghut_sim_sim_1",
            )

        self.assertEqual(
            requests,
            [
                (
                    "http://10.0.0.10:8123",
                    "CREATE DATABASE IF NOT EXISTS torghut_sim_sim_1",
                ),
                ("http://10.0.0.10:8123", "EXISTS DATABASE torghut_sim_sim_1"),
                (
                    "http://10.0.0.11:8123",
                    "CREATE DATABASE IF NOT EXISTS torghut_sim_sim_1",
                ),
                ("http://10.0.0.11:8123", "EXISTS DATABASE torghut_sim_sim_1"),
            ],
        )

    def test_apply_skips_clickhouse_database_create_when_manifest_marks_precreated(
        self,
    ) -> None:
        resources = simulation_resources()
        kafka_config = make_kafka_config()
        clickhouse_config = make_clickhouse_config(
            password="secret",
        )
        postgres_config = make_postgres_config()
        manifest = {
            "dataset_id": "dataset-a",
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
                stub_replay_preflight(stack, resources)
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_capture_cluster_state",
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
                    patch.object(
                        replay_execution,
                        "_ensure_topics",
                        return_value={"status": "ok"},
                    ),
                )
                ensure_db = stack.enter_context(
                    patch.object(replay_execution, "_ensure_clickhouse_database"),
                )
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_ensure_clickhouse_runtime_tables",
                        return_value=None,
                    ),
                )
                ensure_postgres_db = stack.enter_context(
                    patch.object(replay_execution, "_ensure_postgres_database"),
                )
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_ensure_postgres_runtime_permissions",
                        return_value={"grants_applied": True},
                    ),
                )
                stub_replay_storage(stack)
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_ta_runtime_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_torghut_service_reconfigure_required",
                        return_value=True,
                    ),
                )
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_configure_ta_for_simulation",
                        return_value=None,
                    ),
                )
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_restart_ta_deployment",
                        return_value="nonce",
                    ),
                )
                stack.enter_context(
                    patch.object(
                        replay_execution,
                        "_configure_torghut_service_for_simulation",
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

        ensure_db.assert_not_called()
        ensure_postgres_db.assert_not_called()
        self.assertTrue(report["clickhouse"]["database_precreated"])
        self.assertTrue(report["postgres"]["database_precreated"])
        self.assertEqual(report["simulation_lock"]["status"], "acquired")
