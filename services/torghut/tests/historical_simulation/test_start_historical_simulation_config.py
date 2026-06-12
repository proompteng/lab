from __future__ import annotations

# ruff: noqa: F403,F405
from tests.historical_simulation.start_historical_simulation_base import *


class TestStartHistoricalSimulationConfig(StartHistoricalSimulationTestCaseBase):
    def test_verification_cluster_service_host_candidates_expand_service_namespace_short_form(
        self,
    ) -> None:
        self.assertEqual(
            historical_simulation_verification._cluster_service_host_candidates(
                "karapace.kafka"
            ),
            [
                "karapace.kafka",
                "karapace.kafka.svc",
                "karapace.kafka.svc.cluster.local",
            ],
        )

    def test_verification_http_json_get_retries_cluster_local_service_hostnames(
        self,
    ) -> None:
        attempted_hosts: list[str] = []

        class _FakeResponse:
            status = 200

            def read(self) -> bytes:
                return b"[]"

        class _FakeConnection:
            def __init__(
                self, host: str, port: int | None, timeout: int | None = None
            ) -> None:
                attempted_hosts.append(host)
                self._host = host
                self._port = port
                self._timeout = timeout

            def request(self, method: str, path: str) -> None:
                if self._host == "karapace.kafka":
                    raise OSError("lookup failed")

            def getresponse(self) -> _FakeResponse:
                return _FakeResponse()

            def close(self) -> None:
                return None

        with patch(
            "scripts.historical_simulation_verification.HTTPConnection",
            _FakeConnection,
        ):
            status, body = historical_simulation_verification._http_json_get(
                "http://karapace.kafka:8081",
                "/subjects",
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, "[]")
        self.assertEqual(attempted_hosts, ["karapace.kafka", "karapace.kafka.svc"])

    def test_cluster_service_host_candidates_expand_cluster_local_for_partially_qualified_service(
        self,
    ) -> None:
        self.assertEqual(
            start_historical_simulation._cluster_service_host_candidates(
                "karapace.kafka.svc"
            ),
            ["karapace.kafka.svc", "karapace.kafka.svc.cluster.local"],
        )

    def test_cluster_service_host_candidates_expand_service_namespace_short_form(
        self,
    ) -> None:
        self.assertEqual(
            start_historical_simulation._cluster_service_host_candidates(
                "karapace.kafka"
            ),
            [
                "karapace.kafka",
                "karapace.kafka.svc",
                "karapace.kafka.svc.cluster.local",
            ],
        )

    def test_kafka_host_candidates_expand_cluster_local_for_partially_qualified_service(
        self,
    ) -> None:
        self.assertEqual(
            start_historical_simulation._kafka_host_candidates(
                "kafka-pool-b-5.kafka-kafka-brokers.kafka.svc"
            ),
            [
                "kafka-pool-b-5.kafka-kafka-brokers.kafka.svc",
                "kafka-pool-b-5.kafka-kafka-brokers.kafka.svc.cluster.local",
            ],
        )

    def test_normalize_run_token(self) -> None:
        self.assertEqual(
            _normalize_run_token("Sim-2026/02/27#Run-01"), "sim_2026_02_27_run_01"
        )

    def test_ta_restore_policy_defaults_compact_profiles_to_stateless(self) -> None:
        policy = start_historical_simulation._ta_restore_policy(
            {
                "window": {
                    "start": "2026-03-06T14:30:00Z",
                    "end": "2026-03-06T14:45:00Z",
                },
                "performance": {
                    "replayProfile": "compact",
                },
            }
        )

        self.assertEqual(policy["mode"], "stateless")
        self.assertEqual(policy["source"], "profile_default:compact")

    def test_ta_restore_policy_defaults_full_day_profiles_to_stateless(self) -> None:
        policy = start_historical_simulation._ta_restore_policy(
            {
                "window": {
                    "start": "2026-03-06T14:30:00Z",
                    "end": "2026-03-06T21:00:00Z",
                },
                "performance": {
                    "replayProfile": "full_day",
                },
            }
        )

        self.assertEqual(policy["mode"], "stateless")
        self.assertEqual(policy["source"], "profile_default:full_day")

    def test_analysis_run_name_uses_dns1123_safe_token(self) -> None:
        self.assertEqual(
            _analysis_run_name(
                phase="runtime-ready",
                run_token="sim_2026_03_06_open_hour",
            ),
            "torghut-sim-runtime-ready-sim-2026-03-06-open-hour",
        )

    def test_schema_registry_http_json_get_sets_connection_timeout(self) -> None:
        captured: dict[str, object] = {}

        class _FakeResponse:
            status = 200

            def read(self) -> bytes:
                return b"{}"

        class _FakeConnection:
            def __init__(
                self,
                host: str,
                port: int | None,
                *,
                timeout: int | float | None = None,
            ) -> None:
                captured["host"] = host
                captured["port"] = port
                captured["timeout"] = timeout

            def request(self, method: str, path: str) -> None:
                captured["method"] = method
                captured["path"] = path

            def getresponse(self) -> _FakeResponse:
                return _FakeResponse()

            def close(self) -> None:
                captured["closed"] = True

        with patch(
            "scripts.historical_simulation_verification.HTTPConnection", _FakeConnection
        ):
            status, body = historical_simulation_verification._http_json_get(
                "http://schema-registry:8081",
                "/subjects",
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, "{}")
        self.assertEqual(captured.get("host"), "schema-registry")
        self.assertEqual(captured.get("port"), 8081)
        self.assertEqual(
            captured.get("timeout"),
            historical_simulation_verification.DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS,
        )
        self.assertEqual(captured.get("method"), "GET")
        self.assertEqual(captured.get("path"), "/subjects")
        self.assertTrue(captured.get("closed"))

    def test_compress_dump_file_round_trips_gzip_dump(self) -> None:
        with TemporaryDirectory() as tmpdir:
            raw_path = Path(tmpdir) / "source.ndjson"
            dump_path = Path(tmpdir) / "source-dump.jsonl.gz"
            payload = "\n".join(
                [
                    '{"topic":"torghut.trades.v1","ts":"2026-03-06T14:30:00Z"}',
                    '{"topic":"torghut.quotes.v1","ts":"2026-03-06T14:30:01Z"}',
                ]
            )
            raw_path.write_text(f"{payload}\n", encoding="utf-8")

            _compress_dump_file(source_path=raw_path, dump_path=dump_path)

            self.assertFalse(raw_path.exists())
            self.assertTrue(dump_path.exists())
            self.assertEqual(_count_lines(dump_path), 2)
            with _open_dump_reader(dump_path) as handle:
                self.assertEqual(handle.read().strip(), payload)

    def test_dump_sha256_for_replay_is_stable_across_ndjson_and_gzip(self) -> None:
        with TemporaryDirectory() as tmpdir:
            raw_path = Path(tmpdir) / "source.ndjson"
            gzip_path = Path(tmpdir) / "source-dump.jsonl.gz"
            payload = "\n".join(
                [
                    '{"topic":"torghut.trades.v1","ts":"2026-03-06T14:30:00Z","value":1}',
                    '{"topic":"torghut.trades.v1","ts":"2026-03-06T14:30:01Z","value":2}',
                ]
            )
            raw_path.write_text(f"{payload}\n", encoding="utf-8")
            expected = _dump_sha256_for_replay(raw_path)

            second_raw = Path(tmpdir) / "source-copy.ndjson"
            second_raw.write_text(f"{payload}\n", encoding="utf-8")
            _compress_dump_file(source_path=second_raw, dump_path=gzip_path)

            self.assertEqual(_dump_sha256_for_replay(gzip_path), expected)

    def test_build_resources_derives_isolation_names(self) -> None:
        resources = _build_resources(
            "sim-2026-02-27-01",
            {
                "dataset_id": "torghut-trades-2025q4",
            },
        )
        self.assertEqual(resources.ta_group_id, "torghut-ta-sim-sim_2026_02_27_01")
        self.assertEqual(
            resources.order_feed_group_id, "torghut-order-feed-sim-sim_2026_02_27_01"
        )
        self.assertEqual(
            resources.clickhouse_signal_table,
            "torghut_sim_sim_2026_02_27_01.ta_signals",
        )
        self.assertEqual(
            resources.simulation_topic_by_role["order_updates"],
            "torghut.sim.trade-updates.v1.sim_2026_02_27_01",
        )
        self.assertEqual(
            resources.replay_topic_by_source_topic["torghut.trades.v1"],
            "torghut.sim.trades.v1.sim_2026_02_27_01",
        )

    def test_build_resources_uses_lane_stable_topics_when_warm_lane_enabled(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-2026-02-27-01",
            {
                "dataset_id": "torghut-trades-2025q4",
                "runtime": {
                    "use_warm_lane": True,
                },
            },
        )
        self.assertTrue(resources.warm_lane_enabled)
        self.assertEqual(resources.ta_group_id, "torghut-ta-sim-default")
        self.assertEqual(
            resources.order_feed_group_id, "torghut-order-feed-sim-default"
        )
        self.assertEqual(
            resources.clickhouse_signal_table, "torghut_sim_default.ta_signals"
        )
        self.assertEqual(
            resources.simulation_topic_by_role["order_updates"],
            "torghut.sim.trade-updates.v1",
        )
        self.assertEqual(
            resources.replay_topic_by_source_topic["torghut.trades.v1"],
            "torghut.sim.trades.v1",
        )

    def test_build_resources_ignores_run_scoped_clickhouse_database_when_warm_lane_enabled(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-2026-03-14-warm",
            {
                "dataset_id": "torghut-trades-2025q4",
                "runtime": {
                    "use_warm_lane": True,
                },
                "clickhouse": {
                    "simulation_database": "torghut_sim_stale_run",
                },
            },
        )

        self.assertTrue(resources.warm_lane_enabled)
        self.assertEqual(resources.clickhouse_db, "torghut_sim_default")
        self.assertEqual(
            resources.clickhouse_signal_table, "torghut_sim_default.ta_signals"
        )

    def test_canonicalize_warm_lane_manifest_rewrites_explicit_storage_targets(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-2026-03-14-warm",
            {
                "dataset_id": "torghut-trades-2025q4",
                "runtime": {
                    "use_warm_lane": True,
                },
            },
        )
        manifest = {
            "dataset_id": "torghut-trades-2025q4",
            "runtime": {
                "use_warm_lane": True,
            },
            "clickhouse": {
                "simulation_database": "torghut_sim_stale_run",
            },
            "postgres": {
                "simulation_dsn": "postgresql://torghut:secret@localhost:5432/torghut_sim_stale_run",
                "runtime_simulation_dsn": "postgresql://torghut_app:secret@localhost:5432/torghut_sim_stale_run",
            },
        }

        normalized = start_historical_simulation._canonicalize_warm_lane_manifest(
            manifest,
            resources=resources,
        )

        self.assertEqual(
            normalized["clickhouse"]["simulation_database"], "torghut_sim_default"
        )
        self.assertEqual(
            normalized["postgres"]["simulation_dsn"],
            "postgresql://torghut:secret@localhost:5432/torghut_sim_default",
        )
        self.assertEqual(
            normalized["postgres"]["runtime_simulation_dsn"],
            "postgresql://torghut_app:secret@localhost:5432/torghut_sim_default",
        )

    def test_build_resources_derives_options_lane_isolation_names(self) -> None:
        resources = _build_resources(
            "options-sim-2026-03-06-open",
            {
                "schema_version": "torghut.options-simulation-manifest.v1",
                "lane": "options",
                "dataset_id": "torghut-options-smoke-open-30m-20260306",
                "feed": "indicative",
                "underlyings": ["AAPL", "MSFT"],
                "contract_policy": {
                    "dte_min": 5,
                    "dte_max": 45,
                    "option_types": ["call", "put"],
                },
                "catalog_snapshot_ref": "artifacts/options/catalog-snapshot.json",
                "raw_source_policy": {
                    "prefer_kafka": True,
                },
                "cost_model": {
                    "contract_multiplier": 100,
                },
                "proof_gates": {
                    "minimum_contracts": 10,
                },
            },
        )
        self.assertEqual(resources.lane, "options")
        self.assertEqual(
            resources.ta_group_id, "torghut-options-ta-sim-options_sim_2026_03_06_open"
        )
        self.assertEqual(
            resources.order_feed_group_id,
            "torghut-options-order-feed-sim-options_sim_2026_03_06_open",
        )
        self.assertEqual(
            resources.simulation_topic_by_role["contracts"],
            "torghut.sim.options.contracts.v1.options_sim_2026_03_06_open",
        )
        self.assertEqual(
            resources.replay_topic_by_source_topic["torghut.options.contracts.v1"],
            "torghut.sim.options.contracts.v1.options_sim_2026_03_06_open",
        )
        self.assertEqual(
            resources.clickhouse_signal_table,
            "torghut_sim_options_sim_2026_03_06_open.sim_options_contract_features",
        )
        self.assertEqual(
            resources.clickhouse_price_table,
            "torghut_sim_options_sim_2026_03_06_open.sim_options_contract_bars_1s",
        )
        self.assertEqual(
            resources.clickhouse_table_by_role["surface"],
            "torghut_sim_options_sim_2026_03_06_open.sim_options_surface_features",
        )
        self.assertTrue(
            str(resources.output_root).endswith("artifacts/torghut/simulations/options")
        )

    def test_build_resources_rejects_options_manifest_missing_required_fields(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "options_simulation_manifest_missing_fields:contract_policy,catalog_snapshot_ref,raw_source_policy,cost_model,proof_gates",
        ):
            _build_resources(
                "options-sim-1",
                {
                    "schema_version": "torghut.options-simulation-manifest.v1",
                    "lane": "options",
                    "dataset_id": "dataset-a",
                    "feed": "indicative",
                    "underlyings": ["AAPL"],
                },
            )

    def test_simulation_schema_registry_subject_specs_resolves_container_layout(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-2026-03-11-open-1h",
            {
                "dataset_id": "torghut-tsmom-open-hour-20260311",
            },
        )
        with TemporaryDirectory() as tmpdir:
            app_root = Path(tmpdir) / "app"
            script_path = app_root / "scripts" / "start_historical_simulation.py"
            schema_path = app_root / "docs" / "torghut" / "schemas" / "ta-signals.avsc"
            script_path.parent.mkdir(parents=True)
            script_path.write_text("# test", encoding="utf-8")
            schema_path.parent.mkdir(parents=True)
            schema_path.write_text(
                '{"type":"record","name":"Signal","fields":[]}', encoding="utf-8"
            )

            with patch.object(
                start_historical_simulation, "__file__", str(script_path)
            ):
                specs = _simulation_schema_registry_subject_specs(resources=resources)

        ta_signal_spec = next(spec for spec in specs if spec["role"] == "ta_signals")
        self.assertEqual(ta_signal_spec["schema_path"], str(schema_path.resolve()))

    def test_load_schema_registry_schema_literal_uses_embedded_fallback(self) -> None:
        schema_literal = _load_schema_registry_schema_literal(
            "/docs/torghut/schemas/ta-bars-1s.avsc"
        )
        payload = json.loads(schema_literal)
        self.assertEqual(payload["name"], "TaBar1s")
        self.assertEqual(payload["namespace"], "torghut.ta")

    def test_build_postgres_runtime_config_uses_template(self) -> None:
        config = _build_postgres_runtime_config(
            {
                "postgres": {
                    "admin_dsn": "postgresql://torghut:secret@localhost:5432/postgres",
                    "simulation_dsn_template": "postgresql://torghut:secret@localhost:5432/{db}",
                    "migrations_command": "uv run --frozen alembic upgrade heads",
                }
            },
            simulation_db="torghut_sim_test",
        )
        self.assertEqual(config.simulation_db, "torghut_sim_test")
        self.assertEqual(
            config.simulation_dsn,
            "postgresql://torghut:secret@localhost:5432/torghut_sim_test",
        )

    def test_build_postgres_runtime_config_normalizes_alembic_upgrade_head(
        self,
    ) -> None:
        config = _build_postgres_runtime_config(
            {
                "postgres": {
                    "admin_dsn": "postgresql://torghut:secret@localhost:5432/postgres",
                    "simulation_dsn_template": "postgresql://torghut:secret@localhost:5432/{db}",
                    "migrations_command": "uv run --frozen alembic upgrade head",
                }
            },
            simulation_db="torghut_sim_test",
        )
        self.assertTrue(config.migrations_command.endswith("alembic upgrade heads"))
        self.assertNotIn(" upgrade head ", f" {config.migrations_command} ")

    def test_build_kafka_runtime_config_supports_runtime_auth_overrides(self) -> None:
        with patch.dict(
            "os.environ", {"SIM_KAFKA_PASSWORD": "sim-secret"}, clear=False
        ):
            config = _build_kafka_runtime_config(
                {
                    "kafka": {
                        "bootstrap_servers": "kafka:9092",
                        "security_protocol": "SASL_PLAINTEXT",
                        "sasl_mechanism": "SCRAM-SHA-512",
                        "sasl_username": "torghut",
                        "sasl_password": "base-secret",
                        "runtime_bootstrap_servers": "kafka-runtime:9092",
                        "runtime_security_protocol": "SASL_SSL",
                        "runtime_sasl_mechanism": "SCRAM-SHA-256",
                        "runtime_sasl_username": "torghut-runtime",
                        "runtime_sasl_password_env": "SIM_KAFKA_PASSWORD",
                    }
                }
            )
        self.assertEqual(config.runtime_bootstrap, "kafka-runtime:9092")
        self.assertEqual(config.runtime_security, "SASL_SSL")
        self.assertEqual(config.runtime_sasl, "SCRAM-SHA-256")
        self.assertEqual(config.runtime_username, "torghut-runtime")
        self.assertEqual(config.runtime_password, "sim-secret")

    def test_build_clickhouse_runtime_config_supports_password_env(self) -> None:
        with patch.dict(
            "os.environ",
            {"TORGHUT_CLICKHOUSE_PASSWORD": "clickhouse-secret"},
            clear=False,
        ):
            config = _build_clickhouse_runtime_config(
                {
                    "clickhouse": {
                        "http_url": "http://clickhouse.local:8123",
                        "username": "torghut",
                        "password_env": "TORGHUT_CLICKHOUSE_PASSWORD",
                    }
                }
            )
        self.assertEqual(config.http_url, "http://clickhouse.local:8123")
        self.assertEqual(config.username, "torghut")
        self.assertEqual(config.password, "clickhouse-secret")

    def test_clickhouse_jdbc_url_for_database_uses_http_host_and_query(self) -> None:
        self.assertEqual(
            _clickhouse_jdbc_url_for_database(
                "http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123?compress=1",
                "torghut_sim_test",
            ),
            "jdbc:clickhouse://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123/torghut_sim_test?compress=1",
        )

    def test_simulation_evidence_lineage_extracts_empirical_inputs(self) -> None:
        lineage = _simulation_evidence_lineage(
            {
                "dataset_snapshot_ref": "dataset-20260306",
                "candidate_id": "legacy_macd_rsi@prod",
                "baseline_candidate_id": "legacy_macd_rsi@baseline",
                "strategy_spec_ref": "strategy-specs/legacy_macd_rsi@1.0.0.json",
                "model_refs": ["rules/legacy_macd_rsi", ""],
                "runtime_version_refs": ["services/torghut@sha256:abc", None],
            }
        )

        self.assertEqual(lineage["dataset_snapshot_ref"], "dataset-20260306")
        self.assertEqual(lineage["candidate_id"], "legacy_macd_rsi@prod")
        self.assertEqual(lineage["baseline_candidate_id"], "legacy_macd_rsi@baseline")
        self.assertEqual(
            lineage["strategy_spec_ref"],
            "strategy-specs/legacy_macd_rsi@1.0.0.json",
        )
        self.assertEqual(lineage["model_refs"], ["rules/legacy_macd_rsi"])
        self.assertEqual(
            lineage["runtime_version_refs"],
            ["services/torghut@sha256:abc"],
        )

    def test_build_resources_rejects_legacy_strategy_without_explicit_override(
        self,
    ) -> None:
        with self.assertRaisesRegex(RuntimeError, "legacy_strategy_not_allowed"):
            _build_resources(
                "sim-legacy-1",
                {
                    "dataset_id": "dataset-a",
                    "candidate_id": "legacy_macd_rsi@prod",
                    "baseline_candidate_id": "legacy_macd_rsi@baseline",
                    "strategy_spec_ref": "strategy-specs/legacy_macd_rsi@1.0.0.json",
                    "model_refs": ["rules/legacy_macd_rsi"],
                },
            )

    def test_build_resources_allows_legacy_strategy_with_explicit_override(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-legacy-1",
            {
                "dataset_id": "dataset-a",
                "candidate_id": "legacy_macd_rsi@prod",
                "baseline_candidate_id": "legacy_macd_rsi@baseline",
                "strategy_spec_ref": "strategy-specs/legacy_macd_rsi@1.0.0.json",
                "model_refs": ["rules/legacy_macd_rsi"],
                "experimental": {
                    "allowLegacyStrategy": True,
                },
            },
        )

        self.assertEqual(resources.dataset_id, "dataset-a")

    def test_build_postgres_runtime_config_supports_admin_dsn_password_env(
        self,
    ) -> None:
        with patch.dict(
            "os.environ", {"TORGHUT_POSTGRES_PASSWORD": "postgres-secret"}, clear=False
        ):
            config = _build_postgres_runtime_config(
                {
                    "postgres": {
                        "admin_dsn": "postgresql://torghut_app@localhost:5432/postgres",
                        "admin_dsn_password_env": "TORGHUT_POSTGRES_PASSWORD",
                        "simulation_dsn_template": "postgresql://torghut_app@localhost:5432/{db}",
                    }
                },
                simulation_db="torghut_sim_test",
            )
        self.assertEqual(config.simulation_db, "torghut_sim_test")
        self.assertEqual(
            config.admin_dsn,
            "postgresql://torghut_app:postgres-secret@localhost:5432/postgres",
        )
        self.assertEqual(
            config.simulation_dsn,
            "postgresql://torghut_app:postgres-secret@localhost:5432/torghut_sim_test",
        )

    def test_build_postgres_runtime_config_supports_separate_admin_and_runtime_password_envs(
        self,
    ) -> None:
        with patch.dict(
            "os.environ",
            {
                "TORGHUT_POSTGRES_ADMIN_PASSWORD": "admin-secret",
                "TORGHUT_POSTGRES_PASSWORD": "app-secret",
            },
            clear=False,
        ):
            config = _build_postgres_runtime_config(
                {
                    "postgres": {
                        "admin_dsn": "postgresql://postgres@localhost:5432/postgres",
                        "admin_dsn_password_env": "TORGHUT_POSTGRES_ADMIN_PASSWORD",
                        "simulation_dsn_template": "postgresql://torghut_app@localhost:5432/{db}",
                        "simulation_dsn_password_env": "TORGHUT_POSTGRES_PASSWORD",
                        "runtime_simulation_dsn_template": "postgresql://torghut_app@localhost:5432/{db}",
                        "runtime_simulation_dsn_password_env": "TORGHUT_POSTGRES_PASSWORD",
                    }
                },
                simulation_db="torghut_sim_test",
            )
        self.assertEqual(
            config.admin_dsn,
            "postgresql://postgres:admin-secret@localhost:5432/postgres",
        )
        self.assertEqual(
            config.admin_simulation_dsn,
            "postgresql://postgres:admin-secret@localhost:5432/torghut_sim_test",
        )
        self.assertEqual(
            config.simulation_dsn,
            "postgresql://torghut_app:app-secret@localhost:5432/torghut_sim_test",
        )
        self.assertEqual(
            config.runtime_simulation_dsn,
            "postgresql://torghut_app:app-secret@localhost:5432/torghut_sim_test",
        )

    def test_build_postgres_runtime_config_uses_db_from_explicit_dsn(self) -> None:
        config = _build_postgres_runtime_config(
            {
                "postgres": {
                    "admin_dsn": "postgresql://torghut:secret@localhost:5432/postgres",
                    "simulation_dsn": "postgresql://torghut:secret@localhost:5432/custom_sim_db",
                }
            },
            simulation_db="torghut_sim_should_not_win",
        )
        self.assertEqual(config.simulation_db, "custom_sim_db")

    def test_redact_dsn_credentials_masks_password(self) -> None:
        self.assertEqual(
            _redact_dsn_credentials(
                "postgresql://torghut:secret@localhost:5432/torghut_sim"
            ),
            "postgresql://torghut:***@localhost:5432/torghut_sim",
        )

    def test_is_transient_postgres_error_rejects_fatal_auth_config_failures(
        self,
    ) -> None:
        error = RuntimeError(
            'connection to server at "127.0.0.1", port 5432 failed: FATAL: role "torghut" does not exist'
        )

        self.assertFalse(
            start_historical_simulation._is_transient_postgres_error(error)
        )

    def test_find_vector_extension_blocking_revision(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        target = _find_vector_extension_blocking_revision(repo_root)
        self.assertEqual(target, "0016_whitepaper_engineering_triggers_and_rollout")
