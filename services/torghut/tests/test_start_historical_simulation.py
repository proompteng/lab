from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import call, patch

import yaml
from scripts import historical_simulation_verification, start_historical_simulation
from scripts.start_historical_simulation import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    _analysis_run_name,
    _build_clickhouse_runtime_config,
    _build_fill_price_error_budget_payload,
    _build_argocd_automation_config,
    _build_kafka_runtime_config,
    _build_plan_report,
    _build_postgres_runtime_config,
    _build_resources,
    _build_rollouts_analysis_config,
    _build_simulation_completion_trace,
    _compress_dump_file,
    _count_lines,
    _configure_torghut_service_for_simulation,
    _doc29_simulation_gate_ids,
    _discover_automation_pointer,
    _find_vector_extension_blocking_revision,
    _dump_topics,
    _dump_sha256_for_replay,
    _clickhouse_query_configs,
    _clickhouse_jdbc_url_for_database,
    _ensure_simulation_schema_subjects,
    _ensure_topics,
    _file_sha256,
    _http_clickhouse_query,
    _merge_env_entries,
    _monitor_run_completion,
    _normalize_run_token,
    _open_dump_reader,
    _offset_for_time_lookup,
    _pacing_delay_seconds,
    _prepare_argocd_for_run,
    _producer_for_replay,
    _redact_dsn_credentials,
    _restore_ta_configuration,
    _restore_argocd_after_run,
    _restore_torghut_env,
    _replay_dump,
    _run_full_lifecycle,
    _run_rollouts_analysis,
    _load_schema_registry_schema_literal,
    _simulation_schema_registry_subject_specs,
    _simulation_evidence_lineage,
    _set_argocd_application_sync_policy,
    _set_argocd_automation_mode,
    _runtime_verify,
    _run_migrations,
    _torghut_env_overrides_from_manifest,
    _validate_dump_coverage,
    _validate_window_policy,
    _verify_isolation_guards,
)


class TestStartHistoricalSimulation(TestCase):
    def test_cluster_service_host_candidates_expand_cluster_local_for_partially_qualified_service(self) -> None:
        self.assertEqual(
            start_historical_simulation._cluster_service_host_candidates('karapace.kafka.svc'),
            ['karapace.kafka.svc', 'karapace.kafka.svc.cluster.local'],
        )

    def test_cluster_service_host_candidates_expand_service_namespace_short_form(self) -> None:
        self.assertEqual(
            start_historical_simulation._cluster_service_host_candidates('karapace.kafka'),
            ['karapace.kafka', 'karapace.kafka.svc', 'karapace.kafka.svc.cluster.local'],
        )

    def test_kafka_host_candidates_expand_cluster_local_for_partially_qualified_service(self) -> None:
        self.assertEqual(
            start_historical_simulation._kafka_host_candidates(
                'kafka-pool-b-5.kafka-kafka-brokers.kafka.svc'
            ),
            [
                'kafka-pool-b-5.kafka-kafka-brokers.kafka.svc',
                'kafka-pool-b-5.kafka-kafka-brokers.kafka.svc.cluster.local',
            ],
        )

    def test_normalize_run_token(self) -> None:
        self.assertEqual(_normalize_run_token('Sim-2026/02/27#Run-01'), 'sim_2026_02_27_run_01')

    def test_analysis_run_name_uses_dns1123_safe_token(self) -> None:
        self.assertEqual(
            _analysis_run_name(
                phase='runtime-ready',
                run_token='sim_2026_03_06_open_hour',
            ),
            'torghut-sim-runtime-ready-sim-2026-03-06-open-hour',
        )

    def test_schema_registry_http_json_get_sets_connection_timeout(self) -> None:
        captured: dict[str, object] = {}

        class _FakeResponse:
            status = 200

            def read(self) -> bytes:
                return b'{}'

        class _FakeConnection:
            def __init__(
                self,
                host: str,
                port: int | None,
                *,
                timeout: int | float | None = None,
            ) -> None:
                captured['host'] = host
                captured['port'] = port
                captured['timeout'] = timeout

            def request(self, method: str, path: str) -> None:
                captured['method'] = method
                captured['path'] = path

            def getresponse(self) -> _FakeResponse:
                return _FakeResponse()

            def close(self) -> None:
                captured['closed'] = True

        with patch('scripts.historical_simulation_verification.HTTPConnection', _FakeConnection):
            status, body = historical_simulation_verification._http_json_get(
                'http://schema-registry:8081',
                '/subjects',
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, '{}')
        self.assertEqual(captured.get('host'), 'schema-registry')
        self.assertEqual(captured.get('port'), 8081)
        self.assertEqual(
            captured.get('timeout'),
            historical_simulation_verification.DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS,
        )
        self.assertEqual(captured.get('method'), 'GET')
        self.assertEqual(captured.get('path'), '/subjects')
        self.assertTrue(captured.get('closed'))

    def test_compress_dump_file_round_trips_gzip_dump(self) -> None:
        with TemporaryDirectory() as tmpdir:
            raw_path = Path(tmpdir) / 'source.ndjson'
            dump_path = Path(tmpdir) / 'source-dump.jsonl.gz'
            payload = '\n'.join(
                [
                    '{"topic":"torghut.trades.v1","ts":"2026-03-06T14:30:00Z"}',
                    '{"topic":"torghut.quotes.v1","ts":"2026-03-06T14:30:01Z"}',
                ]
            )
            raw_path.write_text(f'{payload}\n', encoding='utf-8')

            _compress_dump_file(source_path=raw_path, dump_path=dump_path)

            self.assertFalse(raw_path.exists())
            self.assertTrue(dump_path.exists())
            self.assertEqual(_count_lines(dump_path), 2)
            with _open_dump_reader(dump_path) as handle:
                self.assertEqual(handle.read().strip(), payload)

    def test_dump_sha256_for_replay_is_stable_across_ndjson_and_gzip(self) -> None:
        with TemporaryDirectory() as tmpdir:
            raw_path = Path(tmpdir) / 'source.ndjson'
            gzip_path = Path(tmpdir) / 'source-dump.jsonl.gz'
            payload = '\n'.join(
                [
                    '{"topic":"torghut.trades.v1","ts":"2026-03-06T14:30:00Z","value":1}',
                    '{"topic":"torghut.trades.v1","ts":"2026-03-06T14:30:01Z","value":2}',
                ]
            )
            raw_path.write_text(f'{payload}\n', encoding='utf-8')
            expected = _dump_sha256_for_replay(raw_path)

            second_raw = Path(tmpdir) / 'source-copy.ndjson'
            second_raw.write_text(f'{payload}\n', encoding='utf-8')
            _compress_dump_file(source_path=second_raw, dump_path=gzip_path)

            self.assertEqual(_dump_sha256_for_replay(gzip_path), expected)

    def test_build_resources_derives_isolation_names(self) -> None:
        resources = _build_resources(
            'sim-2026-02-27-01',
            {
                'dataset_id': 'torghut-trades-2025q4',
            },
        )
        self.assertEqual(resources.ta_group_id, 'torghut-ta-sim-sim_2026_02_27_01')
        self.assertEqual(resources.order_feed_group_id, 'torghut-order-feed-sim-sim_2026_02_27_01')
        self.assertEqual(resources.clickhouse_signal_table, 'torghut_sim_sim_2026_02_27_01.ta_signals')
        self.assertEqual(
            resources.simulation_topic_by_role['order_updates'],
            'torghut.sim.trade-updates.v1.sim_2026_02_27_01',
        )
        self.assertEqual(
            resources.replay_topic_by_source_topic['torghut.trades.v1'],
            'torghut.sim.trades.v1.sim_2026_02_27_01',
        )

    def test_build_resources_derives_options_lane_isolation_names(self) -> None:
        resources = _build_resources(
            'options-sim-2026-03-06-open',
            {
                'schema_version': 'torghut.options-simulation-manifest.v1',
                'lane': 'options',
                'dataset_id': 'torghut-options-smoke-open-30m-20260306',
                'feed': 'indicative',
                'underlyings': ['AAPL', 'MSFT'],
                'contract_policy': {
                    'dte_min': 5,
                    'dte_max': 45,
                    'option_types': ['call', 'put'],
                },
                'catalog_snapshot_ref': 'artifacts/options/catalog-snapshot.json',
                'raw_source_policy': {
                    'prefer_kafka': True,
                },
                'cost_model': {
                    'contract_multiplier': 100,
                },
                'proof_gates': {
                    'minimum_contracts': 10,
                },
            },
        )
        self.assertEqual(resources.lane, 'options')
        self.assertEqual(resources.ta_group_id, 'torghut-options-ta-sim-options_sim_2026_03_06_open')
        self.assertEqual(
            resources.order_feed_group_id,
            'torghut-options-order-feed-sim-options_sim_2026_03_06_open',
        )
        self.assertEqual(
            resources.simulation_topic_by_role['contracts'],
            'torghut.sim.options.contracts.v1.options_sim_2026_03_06_open',
        )
        self.assertEqual(
            resources.replay_topic_by_source_topic['torghut.options.contracts.v1'],
            'torghut.sim.options.contracts.v1.options_sim_2026_03_06_open',
        )
        self.assertEqual(
            resources.clickhouse_signal_table,
            'torghut_sim_options_sim_2026_03_06_open.sim_options_contract_features',
        )
        self.assertEqual(
            resources.clickhouse_price_table,
            'torghut_sim_options_sim_2026_03_06_open.sim_options_contract_bars_1s',
        )
        self.assertEqual(
            resources.clickhouse_table_by_role['surface'],
            'torghut_sim_options_sim_2026_03_06_open.sim_options_surface_features',
        )
        self.assertTrue(str(resources.output_root).endswith('artifacts/torghut/simulations/options'))

    def test_build_resources_rejects_options_manifest_missing_required_fields(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            'options_simulation_manifest_missing_fields:contract_policy,catalog_snapshot_ref,raw_source_policy,cost_model,proof_gates',
        ):
            _build_resources(
                'options-sim-1',
                {
                    'schema_version': 'torghut.options-simulation-manifest.v1',
                    'lane': 'options',
                    'dataset_id': 'dataset-a',
                    'feed': 'indicative',
                    'underlyings': ['AAPL'],
                },
            )

    def test_simulation_schema_registry_subject_specs_resolves_container_layout(self) -> None:
        resources = _build_resources(
            'sim-2026-03-11-open-1h',
            {
                'dataset_id': 'torghut-tsmom-open-hour-20260311',
            },
        )
        with TemporaryDirectory() as tmpdir:
            app_root = Path(tmpdir) / 'app'
            script_path = app_root / 'scripts' / 'start_historical_simulation.py'
            schema_path = app_root / 'docs' / 'torghut' / 'schemas' / 'ta-signals.avsc'
            script_path.parent.mkdir(parents=True)
            script_path.write_text('# test', encoding='utf-8')
            schema_path.parent.mkdir(parents=True)
            schema_path.write_text('{"type":"record","name":"Signal","fields":[]}', encoding='utf-8')

            with patch.object(start_historical_simulation, '__file__', str(script_path)):
                specs = _simulation_schema_registry_subject_specs(resources=resources)

        ta_signal_spec = next(spec for spec in specs if spec['role'] == 'ta_signals')
        self.assertEqual(ta_signal_spec['schema_path'], str(schema_path.resolve()))

    def test_load_schema_registry_schema_literal_uses_embedded_fallback(self) -> None:
        schema_literal = _load_schema_registry_schema_literal('/docs/torghut/schemas/ta-bars-1s.avsc')
        payload = json.loads(schema_literal)
        self.assertEqual(payload['name'], 'TaBar1s')
        self.assertEqual(payload['namespace'], 'torghut.ta')

    def test_build_postgres_runtime_config_uses_template(self) -> None:
        config = _build_postgres_runtime_config(
            {
                'postgres': {
                    'admin_dsn': 'postgresql://torghut:secret@localhost:5432/postgres',
                    'simulation_dsn_template': 'postgresql://torghut:secret@localhost:5432/{db}',
                    'migrations_command': 'uv run --frozen alembic upgrade heads',
                }
            },
            simulation_db='torghut_sim_test',
        )
        self.assertEqual(config.simulation_db, 'torghut_sim_test')
        self.assertEqual(
            config.simulation_dsn,
            'postgresql://torghut:secret@localhost:5432/torghut_sim_test',
        )

    def test_build_postgres_runtime_config_normalizes_alembic_upgrade_head(self) -> None:
        config = _build_postgres_runtime_config(
            {
                'postgres': {
                    'admin_dsn': 'postgresql://torghut:secret@localhost:5432/postgres',
                    'simulation_dsn_template': 'postgresql://torghut:secret@localhost:5432/{db}',
                    'migrations_command': 'uv run --frozen alembic upgrade head',
                }
            },
            simulation_db='torghut_sim_test',
        )
        self.assertTrue(config.migrations_command.endswith('alembic upgrade heads'))
        self.assertNotIn(' upgrade head ', f' {config.migrations_command} ')

    def test_build_kafka_runtime_config_supports_runtime_auth_overrides(self) -> None:
        with patch.dict('os.environ', {'SIM_KAFKA_PASSWORD': 'sim-secret'}, clear=False):
            config = _build_kafka_runtime_config(
                {
                    'kafka': {
                        'bootstrap_servers': 'kafka:9092',
                        'security_protocol': 'SASL_PLAINTEXT',
                        'sasl_mechanism': 'SCRAM-SHA-512',
                        'sasl_username': 'torghut',
                        'sasl_password': 'base-secret',
                        'runtime_bootstrap_servers': 'kafka-runtime:9092',
                        'runtime_security_protocol': 'SASL_SSL',
                        'runtime_sasl_mechanism': 'SCRAM-SHA-256',
                        'runtime_sasl_username': 'torghut-runtime',
                        'runtime_sasl_password_env': 'SIM_KAFKA_PASSWORD',
                    }
                }
            )
        self.assertEqual(config.runtime_bootstrap, 'kafka-runtime:9092')
        self.assertEqual(config.runtime_security, 'SASL_SSL')
        self.assertEqual(config.runtime_sasl, 'SCRAM-SHA-256')
        self.assertEqual(config.runtime_username, 'torghut-runtime')
        self.assertEqual(config.runtime_password, 'sim-secret')

    def test_build_clickhouse_runtime_config_supports_password_env(self) -> None:
        with patch.dict('os.environ', {'TORGHUT_CLICKHOUSE_PASSWORD': 'clickhouse-secret'}, clear=False):
            config = _build_clickhouse_runtime_config(
                {
                    'clickhouse': {
                        'http_url': 'http://clickhouse.local:8123',
                        'username': 'torghut',
                        'password_env': 'TORGHUT_CLICKHOUSE_PASSWORD',
                    }
                }
            )
        self.assertEqual(config.http_url, 'http://clickhouse.local:8123')
        self.assertEqual(config.username, 'torghut')
        self.assertEqual(config.password, 'clickhouse-secret')

    def test_clickhouse_jdbc_url_for_database_uses_http_host_and_query(self) -> None:
        self.assertEqual(
            _clickhouse_jdbc_url_for_database(
                'http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123?compress=1',
                'torghut_sim_test',
            ),
            'jdbc:clickhouse://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123/torghut_sim_test?compress=1',
        )

    def test_simulation_evidence_lineage_extracts_empirical_inputs(self) -> None:
        lineage = _simulation_evidence_lineage(
            {
                'dataset_snapshot_ref': 'dataset-20260306',
                'candidate_id': 'legacy_macd_rsi@prod',
                'baseline_candidate_id': 'legacy_macd_rsi@baseline',
                'strategy_spec_ref': 'strategy-specs/legacy_macd_rsi@1.0.0.json',
                'model_refs': ['rules/legacy_macd_rsi', ''],
                'runtime_version_refs': ['services/torghut@sha256:abc', None],
            }
        )

        self.assertEqual(lineage['dataset_snapshot_ref'], 'dataset-20260306')
        self.assertEqual(lineage['candidate_id'], 'legacy_macd_rsi@prod')
        self.assertEqual(lineage['baseline_candidate_id'], 'legacy_macd_rsi@baseline')
        self.assertEqual(
            lineage['strategy_spec_ref'],
            'strategy-specs/legacy_macd_rsi@1.0.0.json',
        )
        self.assertEqual(lineage['model_refs'], ['rules/legacy_macd_rsi'])
        self.assertEqual(
            lineage['runtime_version_refs'],
            ['services/torghut@sha256:abc'],
        )

    def test_build_resources_rejects_legacy_strategy_without_explicit_override(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'legacy_strategy_not_allowed'):
            _build_resources(
                'sim-legacy-1',
                {
                    'dataset_id': 'dataset-a',
                    'candidate_id': 'legacy_macd_rsi@prod',
                    'baseline_candidate_id': 'legacy_macd_rsi@baseline',
                    'strategy_spec_ref': 'strategy-specs/legacy_macd_rsi@1.0.0.json',
                    'model_refs': ['rules/legacy_macd_rsi'],
                },
            )

    def test_build_resources_allows_legacy_strategy_with_explicit_override(self) -> None:
        resources = _build_resources(
            'sim-legacy-1',
            {
                'dataset_id': 'dataset-a',
                'candidate_id': 'legacy_macd_rsi@prod',
                'baseline_candidate_id': 'legacy_macd_rsi@baseline',
                'strategy_spec_ref': 'strategy-specs/legacy_macd_rsi@1.0.0.json',
                'model_refs': ['rules/legacy_macd_rsi'],
                'experimental': {
                    'allowLegacyStrategy': True,
                },
            },
        )

        self.assertEqual(resources.dataset_id, 'dataset-a')

    def test_build_postgres_runtime_config_supports_admin_dsn_password_env(self) -> None:
        with patch.dict('os.environ', {'TORGHUT_POSTGRES_PASSWORD': 'postgres-secret'}, clear=False):
            config = _build_postgres_runtime_config(
                {
                    'postgres': {
                        'admin_dsn': 'postgresql://torghut_app@localhost:5432/postgres',
                        'admin_dsn_password_env': 'TORGHUT_POSTGRES_PASSWORD',
                        'simulation_dsn_template': 'postgresql://torghut_app@localhost:5432/{db}',
                    }
                },
                simulation_db='torghut_sim_test',
            )
        self.assertEqual(config.simulation_db, 'torghut_sim_test')
        self.assertEqual(
            config.admin_dsn,
            'postgresql://torghut_app:postgres-secret@localhost:5432/postgres',
        )
        self.assertEqual(
            config.simulation_dsn,
            'postgresql://torghut_app:postgres-secret@localhost:5432/torghut_sim_test',
        )

    def test_build_postgres_runtime_config_uses_db_from_explicit_dsn(self) -> None:
        config = _build_postgres_runtime_config(
            {
                'postgres': {
                    'admin_dsn': 'postgresql://torghut:secret@localhost:5432/postgres',
                    'simulation_dsn': 'postgresql://torghut:secret@localhost:5432/custom_sim_db',
                }
            },
            simulation_db='torghut_sim_should_not_win',
        )
        self.assertEqual(config.simulation_db, 'custom_sim_db')

    def test_redact_dsn_credentials_masks_password(self) -> None:
        self.assertEqual(
            _redact_dsn_credentials('postgresql://torghut:secret@localhost:5432/torghut_sim'),
            'postgresql://torghut:***@localhost:5432/torghut_sim',
        )

    def test_is_transient_postgres_error_rejects_fatal_auth_config_failures(self) -> None:
        error = RuntimeError(
            'connection to server at "127.0.0.1", port 5432 failed: FATAL: role "torghut" does not exist'
        )

        self.assertFalse(start_historical_simulation._is_transient_postgres_error(error))

    def test_find_vector_extension_blocking_revision(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        target = _find_vector_extension_blocking_revision(repo_root)
        self.assertEqual(target, '0016_whitepaper_engineering_triggers_and_rollout')

    def test_run_migrations_falls_back_to_pre_vector_revision_on_permission_error(self) -> None:
        config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='/opt/venv/bin/alembic upgrade heads',
        )
        calls: list[str] = []

        def _fake_run_command(args, *, cwd=None, env=None, input_text=None) -> None:
            _ = (cwd, env, input_text)
            calls.append(' '.join(args))
            if args[-1] == 'heads':
                raise RuntimeError('command_failed: permission denied to create extension \"vector\"')
            return None

        def _fake_retry(*, label: str, operation: object, attempts: int = 8, sleep_seconds: float = 0.5) -> None:
            _ = (label, attempts, sleep_seconds)
            return operation()

        with (
            patch('scripts.start_historical_simulation._run_command', side_effect=_fake_run_command),
            patch(
                'scripts.start_historical_simulation._run_with_transient_postgres_retry',
                side_effect=_fake_retry,
            ),
            patch(
                'scripts.start_historical_simulation._find_vector_extension_blocking_revision',
                return_value='0016_whitepaper_engineering_triggers_and_rollout',
            ),
        ):
            _run_migrations(config)

        self.assertEqual(len(calls), 2)
        self.assertIn('heads', calls[0])
        self.assertIn('0016_whitepaper_engineering_triggers_and_rollout', calls[1])

    def test_remove_appledouble_sidecars_deletes_only_sidecar_python_files(self) -> None:
        with TemporaryDirectory() as tmpdir:
            versions_dir = Path(tmpdir)
            sidecar = versions_dir / '._0021_strategy_hypothesis_governance.py'
            migration = versions_dir / '0021_strategy_hypothesis_governance.py'
            sidecar.write_bytes(b'\x00' * 8)
            migration.write_text('# real migration\n')

            start_historical_simulation._remove_appledouble_sidecars(versions_dir)

            self.assertFalse(sidecar.exists())
            self.assertTrue(migration.exists())

    def test_reset_postgres_runtime_state_truncates_runtime_tables(self) -> None:
        config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='/opt/venv/bin/alembic upgrade heads',
        )
        statements: list[object] = []

        class _FakeCursor:
            def __init__(self) -> None:
                self._results: list[tuple[str | None]] = []

            def __enter__(self) -> _FakeCursor:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

            def execute(self, statement: object, params: object | None = None) -> None:
                statements.append((statement, params))
                if statement == 'SELECT to_regclass(%s)':
                    table_name = str((params or ('',))[0])
                    self._results.append((table_name,))

            def fetchone(self) -> tuple[str | None]:
                return self._results.pop(0)

        class _FakeConnection:
            def __enter__(self) -> _FakeConnection:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

            def cursor(self) -> _FakeCursor:
                return _FakeCursor()

        def _fake_retry(*, label: str, operation: object, attempts: int = 8, sleep_seconds: float = 0.5) -> None:
            _ = (label, attempts, sleep_seconds)
            return operation()

        with (
            patch('scripts.start_historical_simulation.psycopg.connect', return_value=_FakeConnection()),
            patch(
                'scripts.start_historical_simulation._run_with_transient_postgres_retry',
                side_effect=_fake_retry,
            ),
        ):
            start_historical_simulation._reset_postgres_runtime_state(config)

        rendered = [(str(statement), params) for statement, params in statements]
        self.assertEqual(
            rendered,
            [
                ('SELECT to_regclass(%s)', ('trade_cursor',)),
                ('Composed([SQL(\'TRUNCATE TABLE \'), Identifier(\'trade_cursor\'), SQL(\' RESTART IDENTITY CASCADE\')])', None),
                ('SELECT to_regclass(%s)', ('trade_decisions',)),
                ('Composed([SQL(\'TRUNCATE TABLE \'), Identifier(\'trade_decisions\'), SQL(\' RESTART IDENTITY CASCADE\')])', None),
                ('SELECT to_regclass(%s)', ('executions',)),
                ('Composed([SQL(\'TRUNCATE TABLE \'), Identifier(\'executions\'), SQL(\' RESTART IDENTITY CASCADE\')])', None),
                ('SELECT to_regclass(%s)', ('execution_tca_metrics',)),
                ('Composed([SQL(\'TRUNCATE TABLE \'), Identifier(\'execution_tca_metrics\'), SQL(\' RESTART IDENTITY CASCADE\')])', None),
                ('SELECT to_regclass(%s)', ('execution_order_events',)),
                (
                    'Composed([SQL(\'TRUNCATE TABLE \'), Identifier(\'execution_order_events\'), SQL(\' RESTART IDENTITY CASCADE\')])',
                    None,
                ),
            ],
        )

    def test_merge_env_entries_updates_and_removes(self) -> None:
        current = [
            {'name': 'A', 'value': '1'},
            {'name': 'B', 'value': '2'},
            {
                'name': 'C',
                'valueFrom': {
                    'secretKeyRef': {
                        'name': 'secret',
                        'key': 'token',
                    }
                },
            },
        ]
        merged = _merge_env_entries(
            current,
            {
                'A': '10',
                'B': None,
                'C': {
                    'valueFrom': {
                        'secretKeyRef': {
                            'name': 'new-secret',
                            'key': 'token',
                        }
                    }
                },
                'D': '4',
            },
        )
        by_name = {item['name']: item for item in merged}
        self.assertEqual(by_name['A']['value'], '10')
        self.assertNotIn('B', by_name)
        self.assertEqual(by_name['C']['valueFrom']['secretKeyRef']['name'], 'new-secret')
        self.assertEqual(by_name['D']['value'], '4')

    def test_torghut_env_overrides_accept_allowlisted_keys(self) -> None:
        overrides = _torghut_env_overrides_from_manifest(
            {
                'torghut_env_overrides': {
                    'TRADING_FEATURE_MAX_STALENESS_MS': 43200000,
                    'TRADING_FEATURE_QUALITY_ENABLED': 'true',
                }
            }
        )
        self.assertEqual(
            overrides,
            {
                'TRADING_FEATURE_MAX_STALENESS_MS': '43200000',
                'TRADING_FEATURE_QUALITY_ENABLED': 'true',
            },
        )

    def test_torghut_env_overrides_reject_disallowed_keys(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'disallowed_torghut_env_override:TRADING_MODE'):
            _torghut_env_overrides_from_manifest(
                {
                    'torghut_env_overrides': {
                        'TRADING_MODE': 'paper',
                    }
                }
            )

    def test_torghut_env_overrides_auto_derives_staleness_for_historical_window(self) -> None:
        overrides = _torghut_env_overrides_from_manifest(
            {
                'window': {
                    'start': '2026-02-27T20:52:32Z',
                }
            },
            now=datetime(2026, 2, 28, 1, 9, 22, tzinfo=timezone.utc),
        )
        self.assertEqual(
            overrides,
            {
                'TRADING_FEATURE_MAX_STALENESS_MS': '15710000',
            },
        )

    def test_torghut_env_overrides_prefers_explicit_staleness(self) -> None:
        overrides = _torghut_env_overrides_from_manifest(
            {
                'window': {
                    'start': '2026-02-27T20:52:32Z',
                },
                'torghut_env_overrides': {
                    'TRADING_FEATURE_MAX_STALENESS_MS': '43200000',
                },
            },
            now=datetime(2026, 2, 28, 1, 9, 22, tzinfo=timezone.utc),
        )
        self.assertEqual(
            overrides,
            {
                'TRADING_FEATURE_MAX_STALENESS_MS': '43200000',
            },
        )

    def test_pacing_delay_modes(self) -> None:
        self.assertEqual(
            _pacing_delay_seconds(
                mode='max_throughput',
                previous_timestamp_ms=1000,
                current_timestamp_ms=4000,
                acceleration=10.0,
            ),
            0.0,
        )
        self.assertEqual(
            _pacing_delay_seconds(
                mode='event_time',
                previous_timestamp_ms=1000,
                current_timestamp_ms=4000,
                acceleration=10.0,
            ),
            3.0,
        )
        self.assertEqual(
            _pacing_delay_seconds(
                mode='accelerated',
                previous_timestamp_ms=1000,
                current_timestamp_ms=4000,
                acceleration=3.0,
            ),
            1.0,
        )

    def test_plan_report_contains_expected_paths(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        postgres_config = _build_postgres_runtime_config(
            {
                'postgres': {
                    'admin_dsn': 'postgresql://torghut:secret@localhost:5432/postgres',
                    'simulation_dsn': 'postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
                }
            },
            simulation_db='torghut_sim_sim_1',
        )
        report = _build_plan_report(
            resources=resources,
            kafka_config=KafkaRuntimeConfig(
                bootstrap_servers='kafka:9092',
                security_protocol=None,
                sasl_mechanism=None,
                sasl_username=None,
                sasl_password=None,
            ),
            clickhouse_config=ClickHouseRuntimeConfig(
                http_url='http://clickhouse:8123',
                username='torghut',
                password=None,
            ),
            postgres_config=postgres_config,
            argocd_config=ArgocdAutomationConfig(
                manage_automation=False,
                applicationset_name='product',
                applicationset_namespace='argocd',
                app_name='torghut',
                root_app_name='root',
                desired_mode_during_run='manual',
                restore_mode_after_run='previous',
                verify_timeout_seconds=600,
            ),
            manifest={'window': {'start': '2026-01-01T00:00:00Z', 'end': '2026-01-01T01:00:00Z'}},
        )
        self.assertEqual(report['run_id'], 'sim-1')
        self.assertIn('state_path', report['artifacts'])
        self.assertIn('run_manifest_path', report['artifacts'])
        self.assertIn('dump_path', report['artifacts'])
        self.assertEqual(report['ta_restore']['mode'], 'required')
        postgres_dsn = report['resources']['postgres_simulation_dsn']
        assert isinstance(postgres_dsn, str)
        self.assertIn(':***@', postgres_dsn)
        self.assertNotIn(':secret@', postgres_dsn)

    def test_http_clickhouse_query_uses_post_with_query_body(self) -> None:
        captured: dict[str, object] = {}

        class _FakeResponse:
            status = 200

            def read(self) -> bytes:
                return b'1'

        class _FakeConnection:
            def __init__(self, host: str, port: int | None) -> None:
                captured['host'] = host
                captured['port'] = port

            def request(
                self,
                method: str,
                path: str,
                body: bytes | None = None,
                headers: dict[str, str] | None = None,
            ) -> None:
                captured['method'] = method
                captured['path'] = path
                captured['body'] = body
                captured['headers'] = headers

            def getresponse(self) -> _FakeResponse:
                return _FakeResponse()

            def close(self) -> None:
                captured['closed'] = True

        with patch('scripts.historical_simulation_verification.HTTPConnection', _FakeConnection):
            status, body = _http_clickhouse_query(
                config=ClickHouseRuntimeConfig(
                    http_url='http://clickhouse:8123',
                    username='torghut',
                    password='secret',
                ),
                query='SELECT 1',
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, '1')
        self.assertEqual(captured.get('host'), 'clickhouse')
        self.assertEqual(captured.get('port'), 8123)
        self.assertEqual(captured.get('method'), 'POST')
        self.assertEqual(captured.get('path'), '/')
        self.assertEqual(captured.get('body'), b'SELECT 1')
        headers = captured.get('headers')
        self.assertIsInstance(headers, dict)
        assert isinstance(headers, dict)
        self.assertEqual(headers.get('Content-Type'), 'text/plain')
        self.assertEqual(headers.get('X-ClickHouse-User'), 'torghut')
        self.assertEqual(headers.get('X-ClickHouse-Key'), 'secret')

    def test_clickhouse_query_configs_resolves_service_endpoints(self) -> None:
        config = ClickHouseRuntimeConfig(
            http_url='http://torghut-clickhouse.torghut.svc.cluster.local:8123',
            username='torghut',
            password='secret',
        )
        with patch(
            'scripts.start_historical_simulation._kubectl_json',
            return_value={
                'subsets': [
                    {
                        'addresses': [
                            {'ip': '10.0.0.10'},
                            {'ip': '10.0.0.11'},
                        ]
                    }
                ]
            },
        ):
            resolved = _clickhouse_query_configs(config)

        self.assertEqual(
            [item.http_url for item in resolved],
            [
                'http://10.0.0.10:8123',
                'http://10.0.0.11:8123',
            ],
        )
        self.assertTrue(all(item.username == 'torghut' for item in resolved))
        self.assertTrue(all(item.password == 'secret' for item in resolved))

    def test_ensure_clickhouse_database_applies_to_all_service_endpoints(self) -> None:
        requests: list[tuple[str, str]] = []

        def _fake_clickhouse_query(*, config: ClickHouseRuntimeConfig, query: str) -> tuple[int, str]:
            requests.append((config.http_url, query))
            if query == 'EXISTS DATABASE torghut_sim_sim_1':
                return 200, '1'
            return 200, ''

        with (
            patch(
                'scripts.start_historical_simulation._kubectl_json',
                return_value={
                    'subsets': [
                        {
                            'addresses': [
                                {'ip': '10.0.0.10'},
                                {'ip': '10.0.0.11'},
                            ]
                        }
                    ]
                },
            ),
            patch(
                'scripts.start_historical_simulation._http_clickhouse_query',
                side_effect=_fake_clickhouse_query,
            ),
        ):
            start_historical_simulation._ensure_clickhouse_database(
                config=ClickHouseRuntimeConfig(
                    http_url='http://torghut-clickhouse.torghut.svc.cluster.local:8123',
                    username='torghut',
                    password='secret',
                ),
                database='torghut_sim_sim_1',
            )

        self.assertEqual(
            requests,
            [
                ('http://10.0.0.10:8123', 'CREATE DATABASE IF NOT EXISTS torghut_sim_sim_1'),
                ('http://10.0.0.10:8123', 'EXISTS DATABASE torghut_sim_sim_1'),
                ('http://10.0.0.11:8123', 'CREATE DATABASE IF NOT EXISTS torghut_sim_sim_1'),
                ('http://10.0.0.11:8123', 'EXISTS DATABASE torghut_sim_sim_1'),
            ],
        )

    def test_apply_skips_clickhouse_database_create_when_manifest_marks_precreated(self) -> None:
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password='secret',
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'clickhouse': {'database_precreated': True},
            'postgres': {'database_precreated': True},
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T15:30:00Z',
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with (
                patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
                patch('scripts.start_historical_simulation._ensure_lz4_codec_available', return_value=None),
                patch(
                    'scripts.start_historical_simulation._acquire_simulation_runtime_lock',
                    return_value={'status': 'acquired', 'run_id': resources.run_id},
                ),
                patch(
                    'scripts.start_historical_simulation._capture_cluster_state',
                    return_value={
                        'ta_data': {
                            'TA_GROUP_ID': 'prod-ta-group',
                            'TA_CHECKPOINT_DIR': 's3a://bucket/checkpoints',
                            'TA_SAVEPOINT_DIR': 's3a://bucket/savepoints',
                        }
                    },
                ),
                patch('scripts.start_historical_simulation._ensure_topics', return_value={'status': 'ok'}),
                patch('scripts.start_historical_simulation._ensure_clickhouse_database') as ensure_db,
                patch('scripts.start_historical_simulation._ensure_clickhouse_runtime_tables', return_value=None),
                patch('scripts.start_historical_simulation._ensure_postgres_database') as ensure_postgres_db,
                patch(
                    'scripts.start_historical_simulation._ensure_postgres_runtime_permissions',
                    return_value={'grants_applied': True},
                ),
                patch('scripts.start_historical_simulation._run_migrations', return_value=None),
                patch('scripts.start_historical_simulation._reset_postgres_runtime_state', return_value=None),
                patch(
                    'scripts.start_historical_simulation._dump_topics',
                    return_value={'records': 1, 'sha256': 'abc'},
                ),
                patch(
                    'scripts.start_historical_simulation._validate_dump_coverage',
                    return_value={'coverage_ratio': 1.0},
                ),
                patch('scripts.start_historical_simulation._configure_ta_for_simulation', return_value=None),
                patch('scripts.start_historical_simulation._restart_ta_deployment', return_value='nonce'),
                patch(
                    'scripts.start_historical_simulation._configure_torghut_service_for_simulation',
                    return_value=None,
                ),
            ):
                report = start_historical_simulation._apply(
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
        self.assertTrue(report['clickhouse']['database_precreated'])
        self.assertTrue(report['postgres']['database_precreated'])
        self.assertEqual(report['simulation_lock']['status'], 'acquired')

    def test_apply_uses_stateless_ta_restart_when_manifest_requests_it(self) -> None:
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password='secret',
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'ta_restore': {'mode': 'stateless'},
            'clickhouse': {'database_precreated': True},
            'postgres': {'database_precreated': True},
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T15:30:00Z',
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with (
                patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
                patch('scripts.start_historical_simulation._ensure_lz4_codec_available', return_value=None),
                patch(
                    'scripts.start_historical_simulation._acquire_simulation_runtime_lock',
                    return_value={'status': 'acquired', 'run_id': resources.run_id},
                ),
                patch(
                    'scripts.start_historical_simulation._capture_cluster_state',
                    return_value={
                        'ta_data': {
                            'TA_GROUP_ID': 'prod-ta-group',
                        }
                    },
                ),
                patch('scripts.start_historical_simulation._ensure_topics', return_value={'status': 'ok'}),
                patch('scripts.start_historical_simulation._ensure_clickhouse_database'),
                patch('scripts.start_historical_simulation._ensure_clickhouse_runtime_tables', return_value=None),
                patch('scripts.start_historical_simulation._ensure_postgres_database'),
                patch(
                    'scripts.start_historical_simulation._ensure_postgres_runtime_permissions',
                    return_value={'grants_applied': True},
                ),
                patch('scripts.start_historical_simulation._run_migrations', return_value=None),
                patch('scripts.start_historical_simulation._reset_postgres_runtime_state', return_value=None),
                patch(
                    'scripts.start_historical_simulation._dump_topics',
                    return_value={'records': 1, 'sha256': 'abc'},
                ),
                patch(
                    'scripts.start_historical_simulation._validate_dump_coverage',
                    return_value={'coverage_ratio': 1.0},
                ),
                patch('scripts.start_historical_simulation._configure_ta_for_simulation', return_value=None),
                patch(
                    'scripts.start_historical_simulation._restart_ta_deployment',
                    return_value='nonce',
                ) as restart_ta,
                patch(
                    'scripts.start_historical_simulation._configure_torghut_service_for_simulation',
                    return_value=None,
                ),
            ):
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
            desired_state='running',
            upgrade_mode='stateless',
        )
        self.assertEqual(report['ta_restore']['effective_upgrade_mode'], 'stateless')
        self.assertEqual(report['ta_restore']['reason'], 'explicit_stateless')

    def test_apply_rejects_missing_restore_state_config_in_required_mode(self) -> None:
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password='secret',
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T15:30:00Z',
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with (
                patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
                patch('scripts.start_historical_simulation._ensure_lz4_codec_available', return_value=None),
                patch(
                    'scripts.start_historical_simulation._acquire_simulation_runtime_lock',
                    return_value={'status': 'acquired', 'run_id': resources.run_id},
                ),
                patch(
                    'scripts.start_historical_simulation._capture_cluster_state',
                    return_value={'ta_data': {'TA_GROUP_ID': 'prod-ta-group'}},
                ),
                patch(
                    'scripts.start_historical_simulation._release_simulation_runtime_lock',
                    return_value={'status': 'released'},
                ) as release_lock,
            ):
                with self.assertRaisesRegex(RuntimeError, 'restore_state_missing:checkpoint_dir,savepoint_dir'):
                    start_historical_simulation._apply(
                        resources=resources,
                        manifest=manifest,
                        kafka_config=kafka_config,
                        clickhouse_config=clickhouse_config,
                        postgres_config=postgres_config,
                        force_dump=False,
                        force_replay=False,
                    )

        release_lock.assert_called_once_with(resources=resources)

    def test_apply_falls_back_to_stateless_when_restore_state_config_missing(self) -> None:
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password='secret',
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'ta_restore': {'mode': 'stateless_if_missing'},
            'clickhouse': {'database_precreated': True},
            'postgres': {'database_precreated': True},
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T15:30:00Z',
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with (
                patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
                patch('scripts.start_historical_simulation._ensure_lz4_codec_available', return_value=None),
                patch(
                    'scripts.start_historical_simulation._acquire_simulation_runtime_lock',
                    return_value={'status': 'acquired', 'run_id': resources.run_id},
                ),
                patch(
                    'scripts.start_historical_simulation._capture_cluster_state',
                    return_value={'ta_data': {'TA_GROUP_ID': 'prod-ta-group'}},
                ),
                patch('scripts.start_historical_simulation._ensure_topics', return_value={'status': 'ok'}),
                patch('scripts.start_historical_simulation._ensure_clickhouse_database'),
                patch('scripts.start_historical_simulation._ensure_clickhouse_runtime_tables', return_value=None),
                patch('scripts.start_historical_simulation._ensure_postgres_database'),
                patch(
                    'scripts.start_historical_simulation._ensure_postgres_runtime_permissions',
                    return_value={'grants_applied': True},
                ),
                patch('scripts.start_historical_simulation._run_migrations', return_value=None),
                patch('scripts.start_historical_simulation._reset_postgres_runtime_state', return_value=None),
                patch(
                    'scripts.start_historical_simulation._dump_topics',
                    return_value={'records': 1, 'sha256': 'abc'},
                ),
                patch(
                    'scripts.start_historical_simulation._validate_dump_coverage',
                    return_value={'coverage_ratio': 1.0},
                ),
                patch('scripts.start_historical_simulation._configure_ta_for_simulation', return_value=None),
                patch(
                    'scripts.start_historical_simulation._restart_ta_deployment',
                    return_value='nonce',
                ) as restart_ta,
                patch(
                    'scripts.start_historical_simulation._configure_torghut_service_for_simulation',
                    return_value=None,
                ),
            ):
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
            desired_state='running',
            upgrade_mode='stateless',
        )
        self.assertTrue(report['ta_restore']['fallback_applied'])
        self.assertEqual(report['ta_restore']['reason'], 'restore_state_missing:checkpoint_dir,savepoint_dir')

    def test_apply_releases_runtime_lock_when_prepare_fails(self) -> None:
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password='secret',
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T15:30:00Z',
            },
        }

        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with (
                patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
                patch('scripts.start_historical_simulation._ensure_lz4_codec_available', return_value=None),
                patch(
                    'scripts.start_historical_simulation._acquire_simulation_runtime_lock',
                    return_value={'status': 'acquired', 'run_id': resources.run_id},
                ),
                patch(
                    'scripts.start_historical_simulation._capture_cluster_state',
                    return_value={
                        'ta_data': {
                            'TA_GROUP_ID': 'prod-ta-group',
                            'TA_CHECKPOINT_DIR': 's3a://bucket/checkpoints',
                            'TA_SAVEPOINT_DIR': 's3a://bucket/savepoints',
                        }
                    },
                ),
                patch(
                    'scripts.start_historical_simulation._ensure_topics',
                    side_effect=RuntimeError('topic_create_failed'),
                ),
                patch('scripts.start_historical_simulation._release_simulation_runtime_lock') as release_lock,
            ):
                with self.assertRaisesRegex(RuntimeError, 'topic_create_failed'):
                    start_historical_simulation._apply(
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

        def _fake_clickhouse_query(*, config: ClickHouseRuntimeConfig, query: str) -> tuple[int, str]:
            _ = config
            queries.append(query)
            if query == 'SHOW CREATE TABLE torghut.ta_microbars':
                return 200, source_microbars
            if query == 'SHOW CREATE TABLE torghut.ta_signals':
                return 200, source_signals
            if query.startswith('EXISTS TABLE torghut_sim_sim_1.'):
                return 200, '1'
            return 200, ''

        with patch(
            'scripts.start_historical_simulation._http_clickhouse_query',
            side_effect=_fake_clickhouse_query,
        ):
            start_historical_simulation._ensure_clickhouse_runtime_tables(
                config=ClickHouseRuntimeConfig(
                    http_url='http://clickhouse:8123',
                    username='torghut',
                    password='secret',
                ),
                database='torghut_sim_sim_1',
            )

        self.assertEqual(queries[0], 'SHOW CREATE TABLE torghut.ta_microbars')
        self.assertIn('CREATE TABLE IF NOT EXISTS torghut_sim_sim_1.ta_microbars', queries[1])
        self.assertIn(
            "/clickhouse/tables/{cluster}/{shard}/torghut_sim_sim_1/ta_microbars",
            queries[1],
        )
        self.assertEqual(queries[2], 'EXISTS TABLE torghut_sim_sim_1.ta_microbars')
        self.assertEqual(queries[3], 'TRUNCATE TABLE torghut_sim_sim_1.ta_microbars')
        self.assertEqual(queries[4], 'SHOW CREATE TABLE torghut.ta_signals')
        self.assertIn('CREATE TABLE IF NOT EXISTS torghut_sim_sim_1.ta_signals', queries[5])
        self.assertIn(
            "/clickhouse/tables/{cluster}/{shard}/torghut_sim_sim_1/ta_signals",
            queries[5],
        )
        self.assertEqual(queries[6], 'EXISTS TABLE torghut_sim_sim_1.ta_signals')
        self.assertEqual(queries[7], 'TRUNCATE TABLE torghut_sim_sim_1.ta_signals')

    def test_ensure_clickhouse_runtime_tables_clones_schema_across_service_endpoints(self) -> None:
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

        def _fake_clickhouse_query(*, config: ClickHouseRuntimeConfig, query: str) -> tuple[int, str]:
            requests.append((config.http_url, query))
            if query == 'SHOW CREATE TABLE torghut.ta_microbars':
                return 200, source_microbars
            if query == 'SHOW CREATE TABLE torghut.ta_signals':
                return 200, source_signals
            if query.startswith('EXISTS TABLE torghut_sim_sim_1.'):
                return 200, '1'
            return 200, ''

        with (
            patch(
                'scripts.start_historical_simulation._kubectl_json',
                return_value={
                    'subsets': [
                        {
                            'addresses': [
                                {'ip': '10.0.0.10'},
                                {'ip': '10.0.0.11'},
                            ]
                        }
                    ]
                },
            ),
            patch(
                'scripts.start_historical_simulation._http_clickhouse_query',
                side_effect=_fake_clickhouse_query,
            ),
        ):
            start_historical_simulation._ensure_clickhouse_runtime_tables(
                config=ClickHouseRuntimeConfig(
                    http_url='http://torghut-clickhouse.torghut.svc.cluster.local:8123',
                    username='torghut',
                    password='secret',
                ),
                database='torghut_sim_sim_1',
            )

        self.assertEqual(requests[0], ('http://10.0.0.10:8123', 'SHOW CREATE TABLE torghut.ta_microbars'))
        self.assertEqual(requests[1][0], 'http://10.0.0.10:8123')
        self.assertEqual(requests[2], ('http://10.0.0.10:8123', 'EXISTS TABLE torghut_sim_sim_1.ta_microbars'))
        self.assertEqual(requests[3], ('http://10.0.0.10:8123', 'TRUNCATE TABLE torghut_sim_sim_1.ta_microbars'))
        self.assertEqual(requests[4][0], 'http://10.0.0.11:8123')
        self.assertEqual(requests[5], ('http://10.0.0.11:8123', 'EXISTS TABLE torghut_sim_sim_1.ta_microbars'))
        self.assertEqual(requests[6], ('http://10.0.0.11:8123', 'TRUNCATE TABLE torghut_sim_sim_1.ta_microbars'))
        self.assertEqual(requests[7], ('http://10.0.0.10:8123', 'SHOW CREATE TABLE torghut.ta_signals'))
        self.assertEqual(requests[8][0], 'http://10.0.0.10:8123')
        self.assertEqual(requests[9], ('http://10.0.0.10:8123', 'EXISTS TABLE torghut_sim_sim_1.ta_signals'))
        self.assertEqual(requests[10], ('http://10.0.0.10:8123', 'TRUNCATE TABLE torghut_sim_sim_1.ta_signals'))
        self.assertEqual(requests[11][0], 'http://10.0.0.11:8123')
        self.assertEqual(requests[12], ('http://10.0.0.11:8123', 'EXISTS TABLE torghut_sim_sim_1.ta_signals'))
        self.assertEqual(requests[13], ('http://10.0.0.11:8123', 'TRUNCATE TABLE torghut_sim_sim_1.ta_signals'))

    def test_wait_for_clickhouse_table_retries_until_visible(self) -> None:
        queries: list[str] = []
        responses = iter([(200, '0'), (200, '0'), (200, '1')])

        def _fake_clickhouse_query(*, config: ClickHouseRuntimeConfig, query: str) -> tuple[int, str]:
            _ = config
            queries.append(query)
            return next(responses)

        with (
            patch(
                'scripts.start_historical_simulation._http_clickhouse_query',
                side_effect=_fake_clickhouse_query,
            ),
            patch('scripts.start_historical_simulation.time.sleep') as sleep_mock,
        ):
            start_historical_simulation._wait_for_clickhouse_table(
                config=ClickHouseRuntimeConfig(
                    http_url='http://clickhouse:8123',
                    username='torghut',
                    password='secret',
                ),
                database='torghut_sim_sim_1',
                table='ta_signals',
                attempts=3,
                sleep_seconds=0.01,
            )

        self.assertEqual(
            queries,
            [
                'EXISTS TABLE torghut_sim_sim_1.ta_signals',
                'EXISTS TABLE torghut_sim_sim_1.ta_signals',
                'EXISTS TABLE torghut_sim_sim_1.ta_signals',
            ],
        )
        self.assertEqual(sleep_mock.call_count, 2)

    def test_wait_for_clickhouse_database_retries_until_visible(self) -> None:
        queries: list[str] = []
        responses = iter([(200, '0'), (200, '1')])

        def _fake_clickhouse_query(*, config: ClickHouseRuntimeConfig, query: str) -> tuple[int, str]:
            _ = config
            queries.append(query)
            return next(responses)

        with (
            patch(
                'scripts.start_historical_simulation._http_clickhouse_query',
                side_effect=_fake_clickhouse_query,
            ),
            patch('scripts.start_historical_simulation.time.sleep') as sleep_mock,
        ):
            start_historical_simulation._wait_for_clickhouse_database(
                config=ClickHouseRuntimeConfig(
                    http_url='http://clickhouse:8123',
                    username='torghut',
                    password='secret',
                ),
                database='torghut_sim_sim_1',
                attempts=2,
                sleep_seconds=0.01,
            )

        self.assertEqual(
            queries,
            [
                'EXISTS DATABASE torghut_sim_sim_1',
                'EXISTS DATABASE torghut_sim_sim_1',
            ],
        )
        self.assertEqual(sleep_mock.call_count, 1)

    def test_ensure_topics_caps_partitions_to_available_brokers(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        manifest = {'kafka': {'default_partitions': 6, 'replication_factor': 1}}

        class _FakeNewTopic:
            def __init__(self, name: str, num_partitions: int, replication_factor: int) -> None:
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
                        'topic': topic,
                        'partitions': [{}, {}, {}],
                    }
                    for topic in topics
                ]

            def create_topics(self, new_topics: list[_FakeNewTopic], validate_only: bool = False) -> None:
                _ = validate_only
                self.created.extend(new_topics)

            def close(self) -> None:
                return None

        fake_admin = _FakeAdmin()
        with (
            patch.dict(
                'sys.modules',
                {'kafka.admin': SimpleNamespace(NewTopic=_FakeNewTopic)},
            ),
            patch('scripts.start_historical_simulation._kafka_admin_client', return_value=fake_admin),
        ):
            report = _ensure_topics(
                resources=resources,
                config=kafka_config,
                manifest=manifest,
            )

        created_by_topic = {topic.name: topic for topic in fake_admin.created}
        self.assertEqual(report['available_brokers'], 2)
        self.assertGreater(len(report['partition_caps']), 0)
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['trades']].num_partitions,
            2,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['quotes']].num_partitions,
            2,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['bars']].num_partitions,
            2,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['status']].num_partitions,
            2,
        )

    def test_ensure_topics_respects_max_partitions_override(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        manifest = {
            'kafka': {
                'default_partitions': 6,
                'replication_factor': 1,
                'max_partitions_per_topic': 1,
            }
        }

        class _FakeNewTopic:
            def __init__(self, name: str, num_partitions: int, replication_factor: int) -> None:
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
                        'topic': topic,
                        'partitions': [{}, {}, {}],
                    }
                    for topic in topics
                ]

            def create_topics(self, new_topics: list[_FakeNewTopic], validate_only: bool = False) -> None:
                _ = validate_only
                self.created.extend(new_topics)

            def close(self) -> None:
                return None

        fake_admin = _FakeAdmin()
        with (
            patch.dict(
                'sys.modules',
                {'kafka.admin': SimpleNamespace(NewTopic=_FakeNewTopic)},
            ),
            patch('scripts.start_historical_simulation._kafka_admin_client', return_value=fake_admin),
        ):
            report = _ensure_topics(
                resources=resources,
                config=kafka_config,
                manifest=manifest,
            )

        created_by_topic = {topic.name: topic for topic in fake_admin.created}
        self.assertEqual(report['max_partitions_per_topic'], 1)
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['trades']].num_partitions,
            1,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['quotes']].num_partitions,
            1,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['bars']].num_partitions,
            1,
        )
        self.assertEqual(
            created_by_topic[resources.simulation_topic_by_role['status']].num_partitions,
            1,
        )

    def test_ensure_simulation_schema_subjects_registers_equity_ta_subjects_only(self) -> None:
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
            },
        )
        ta_data = {
            'TA_SCHEMA_REGISTRY_URL': 'http://karapace.kafka:8081',
        }
        calls: list[tuple[str, str, str | None]] = []

        def _fake_http_request(
            *,
            base_url: str,
            path: str,
            method: str = 'GET',
            body: str | None = None,
            headers: dict[str, str] | None = None,
        ) -> tuple[int, str]:
            _ = method
            _ = headers
            calls.append((base_url, path, body))
            if path == '/subjects':
                return 200, '[]'
            if path.endswith(f"{resources.simulation_topic_by_role['ta_microbars']}-value/versions/latest"):
                return 404, '{}'
            if path.endswith(f"{resources.simulation_topic_by_role['ta_signals']}-value/versions/latest"):
                return 404, '{}'
            if path.endswith(f"{resources.simulation_topic_by_role['ta_microbars']}-value/versions"):
                return 200, '{"id": 1}'
            if path.endswith(f"{resources.simulation_topic_by_role['ta_signals']}-value/versions"):
                return 200, '{"id": 2}'
            raise AssertionError(f'unexpected request path: {path}')

        with patch(
            'scripts.start_historical_simulation._http_request',
            side_effect=_fake_http_request,
        ):
            report = _ensure_simulation_schema_subjects(
                resources=resources,
                ta_data=ta_data,
            )

        self.assertTrue(report['ready'])
        self.assertEqual(
            report['subjects_expected'],
            [
                f"{resources.simulation_topic_by_role['ta_microbars']}-value",
                f"{resources.simulation_topic_by_role['ta_signals']}-value",
            ],
        )
        self.assertEqual(report['subjects_existing'], [])
        self.assertEqual(report['subjects_registered'], report['subjects_expected'])

        posted_bodies = [json.loads(body) for _, path, body in calls if path.endswith('/versions') and body is not None]
        self.assertEqual(len(posted_bodies), 2)
        schema_names = sorted(json.loads(payload['schema'])['name'] for payload in posted_bodies)
        self.assertEqual(schema_names, ['TaBar1s', 'TaSignal'])

    def test_configure_torghut_service_preserves_existing_container_fields(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol='SASL_PLAINTEXT',
            sasl_mechanism='SCRAM-SHA-512',
            sasl_username='user',
            sasl_password='secret',
        )
        service_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'image': 'registry.example/lab/torghut@sha256:abc',
                                'volumeMounts': [{'name': 'strategy-config', 'mountPath': '/etc/torghut'}],
                                'env': [
                                    {'name': 'DB_DSN', 'value': 'postgresql://old'},
                                    {'name': 'TRADING_MODE', 'value': 'live'},
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
                'scripts.start_historical_simulation._kubectl_json',
                return_value=service_payload,
            ),
            patch(
                'scripts.start_historical_simulation._kubectl_patch',
                side_effect=lambda namespace, kind, name, patch: captured_patch.update(
                    {'namespace': namespace, 'kind': kind, 'name': name, 'patch': patch}
                ),
            ),
        ):
            _configure_torghut_service_for_simulation(
                resources=resources,
                manifest={
                    'window': {
                        'start': '2026-02-27T14:30:00Z',
                        'end': '2026-02-27T21:00:00Z',
                    }
                },
                postgres_config=postgres_config,
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url='http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123',
                    username='torghut',
                    password='clickhouse-secret',
                ),
                kafka_config=kafka_config,
            )

        patch_payload = captured_patch.get('patch')
        self.assertIsInstance(patch_payload, dict)
        assert isinstance(patch_payload, dict)
        containers = (
            patch_payload.get('spec', {})
            .get('template', {})
            .get('spec', {})
            .get('containers', [])
        )
        self.assertIsInstance(containers, list)
        assert isinstance(containers, list)
        self.assertEqual(len(containers), 1)
        container = containers[0]
        self.assertIsInstance(container, dict)
        assert isinstance(container, dict)
        self.assertEqual(
            container.get('image'),
            'registry.example/lab/torghut@sha256:abc',
        )
        self.assertEqual(
            container.get('volumeMounts'),
            [{'name': 'strategy-config', 'mountPath': '/etc/torghut'}],
        )
        env_entries = container.get('env')
        self.assertIsInstance(env_entries, list)
        assert isinstance(env_entries, list)
        env_by_name = {
            str(item.get('name')): item
            for item in env_entries
            if isinstance(item, dict)
        }
        self.assertEqual(
            env_by_name['TRADING_ORDER_FEED_SECURITY_PROTOCOL'].get('value'),
            'SASL_PLAINTEXT',
        )
        self.assertEqual(
            env_by_name['TRADING_ORDER_FEED_SASL_MECHANISM'].get('value'),
            'SCRAM-SHA-512',
        )
        self.assertEqual(
            env_by_name['TRADING_ORDER_FEED_SASL_USERNAME'].get('value'),
            'user',
        )
        self.assertEqual(
            env_by_name['TRADING_ORDER_FEED_SASL_PASSWORD'].get('value'),
            'secret',
        )
        self.assertEqual(
            env_by_name['TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL'].get('value'),
            'SASL_PLAINTEXT',
        )
        self.assertEqual(
            env_by_name['TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM'].get('value'),
            'SCRAM-SHA-512',
        )
        self.assertEqual(
            env_by_name['TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME'].get('value'),
            'user',
        )
        self.assertEqual(
            env_by_name['TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD'].get('value'),
            'secret',
        )
        self.assertEqual(
            env_by_name['TRADING_ENABLED'].get('value'),
            'true',
        )
        self.assertEqual(
            env_by_name['TA_CLICKHOUSE_URL'].get('value'),
            'http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123',
        )
        self.assertEqual(
            env_by_name['TA_CLICKHOUSE_USERNAME'].get('value'),
            'torghut',
        )
        self.assertEqual(
            env_by_name['TA_CLICKHOUSE_PASSWORD'].get('value'),
            'clickhouse-secret',
        )
        self.assertEqual(
            env_by_name['TRADING_SIGNAL_ALLOWED_SOURCES'].get('value'),
            'ws,ta',
        )

    def test_configure_torghut_service_applies_manifest_overrides(self) -> None:
        resources = _build_resources(
            'sim-override',
            {
                'dataset_id': 'dataset-a',
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_override',
            simulation_db='torghut_sim_sim_override',
            migrations_command='true',
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol='SASL_PLAINTEXT',
            sasl_mechanism='SCRAM-SHA-512',
            sasl_username='user',
            sasl_password='secret',
        )
        service_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'image': 'registry.example/lab/torghut@sha256:abc',
                                'env': [
                                    {'name': 'TRADING_FEATURE_MAX_STALENESS_MS', 'value': '120000'},
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
                'scripts.start_historical_simulation._kubectl_json',
                return_value=service_payload,
            ),
            patch(
                'scripts.start_historical_simulation._kubectl_patch',
                side_effect=lambda namespace, kind, name, patch: captured_patch.update(
                    {'namespace': namespace, 'kind': kind, 'name': name, 'patch': patch}
                ),
            ),
        ):
            _configure_torghut_service_for_simulation(
                resources=resources,
                manifest={
                    'window': {
                        'start': '2026-02-27T14:30:00Z',
                        'end': '2026-02-27T21:00:00Z',
                    }
                },
                postgres_config=postgres_config,
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url='http://clickhouse:8123',
                    username='torghut',
                    password='secret',
                ),
                kafka_config=kafka_config,
                torghut_env_overrides={
                    'TRADING_FEATURE_MAX_STALENESS_MS': '43200000',
                    'TRADING_FEATURE_QUALITY_ENABLED': 'true',
                },
            )

        patch_payload = captured_patch.get('patch')
        self.assertIsInstance(patch_payload, dict)
        assert isinstance(patch_payload, dict)
        containers = (
            patch_payload.get('spec', {})
            .get('template', {})
            .get('spec', {})
            .get('containers', [])
        )
        self.assertIsInstance(containers, list)
        assert isinstance(containers, list)
        env_entries = containers[0].get('env') if containers else []
        self.assertIsInstance(env_entries, list)
        assert isinstance(env_entries, list)
        env_by_name = {
            str(item.get('name')): item
            for item in env_entries
            if isinstance(item, dict)
        }
        self.assertEqual(
            env_by_name['TRADING_FEATURE_MAX_STALENESS_MS'].get('value'),
            '43200000',
        )
        self.assertEqual(
            env_by_name['TRADING_FEATURE_QUALITY_ENABLED'].get('value'),
            'true',
        )

    def test_offset_for_time_lookup_falls_back_for_missing_or_invalid_offset(self) -> None:
        class _OffsetMeta:
            def __init__(self, offset: object) -> None:
                self.offset = offset

        self.assertEqual(_offset_for_time_lookup(metadata=None, fallback=17), 17)
        self.assertEqual(_offset_for_time_lookup(metadata=_OffsetMeta(-1), fallback=17), 17)
        self.assertEqual(_offset_for_time_lookup(metadata=_OffsetMeta('bad'), fallback=17), 17)
        self.assertEqual(_offset_for_time_lookup(metadata=_OffsetMeta(9), fallback=17), 9)

    def test_dump_topics_reuses_existing_dump_with_valid_marker(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / 'source-dump.ndjson'
            row = {
                'source_topic': resources.source_topic_by_role['trades'],
                'replay_topic': resources.simulation_topic_by_role['trades'],
                'source_timestamp_ms': 1704067200000,
                'key_b64': None,
                'value_b64': None,
                'headers': [],
            }
            dump_path.write_text(json.dumps(row) + '\n', encoding='utf-8')
            marker_path = dump_path.with_suffix('.dump-marker.json')
            marker_path.write_text(
                json.dumps(
                    {
                        'dump_sha256': _file_sha256(dump_path),
                        'records': 1,
                    }
                ),
                encoding='utf-8',
            )

            with patch(
                'scripts.start_historical_simulation._consumer_for_dump',
                side_effect=AssertionError('expected dump reuse; consumer should not be constructed'),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={'window': {'start': '2026-01-01T00:00:00Z', 'end': '2026-01-01T01:00:00Z'}},
                    dump_path=dump_path,
                    force=False,
                )

            self.assertTrue(report['reused_existing_dump'])
            self.assertEqual(report['records'], 1)
            self.assertEqual(report['min_source_timestamp_ms'], 1704067200000)
            self.assertEqual(report['max_source_timestamp_ms'], 1704067200000)
            refreshed_marker = json.loads(marker_path.read_text(encoding='utf-8'))
            self.assertEqual(refreshed_marker.get('min_source_timestamp_ms'), 1704067200000)
            self.assertEqual(refreshed_marker.get('max_source_timestamp_ms'), 1704067200000)

    def test_dump_topics_redumps_when_marker_missing(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / 'source-dump.ndjson'
            dump_path.write_text('{}\n', encoding='utf-8')

            with (
                patch.dict(
                    'sys.modules',
                    {'kafka': SimpleNamespace(TopicPartition=lambda topic, partition: (topic, partition))},
                ),
                patch(
                    'scripts.start_historical_simulation._consumer_for_dump',
                    side_effect=RuntimeError('dump_invoked'),
                ),
                self.assertRaisesRegex(RuntimeError, 'dump_invoked'),
            ):
                _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={'window': {'start': '2026-01-01T00:00:00Z', 'end': '2026-01-01T01:00:00Z'}},
                    dump_path=dump_path,
                    force=False,
                )

    def test_dump_topics_completes_when_last_record_reaches_stop_offset(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        resources = replace(
            resources,
            replay_topic_by_source_topic={'torghut.trades.v1': 'torghut.sim.trades.v1'},
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )

        class _OffsetMeta:
            def __init__(self, offset: int) -> None:
                self.offset = offset

        class _Record:
            def __init__(self, topic: str, partition: int, offset: int, timestamp: int) -> None:
                self.topic = topic
                self.partition = partition
                self.offset = offset
                self.timestamp = timestamp
                self.key = None
                self.value = None
                self.headers: list[tuple[str, bytes]] = []

        class _FakeConsumer:
            def __init__(self) -> None:
                self._tp = ('torghut.trades.v1', 0)
                self._position = 0
                self._poll_calls = 0
                self._offset_lookup_calls = 0

            def partitions_for_topic(self, topic: str) -> set[int]:
                self._topic = topic
                return {0}

            def assign(self, topic_partitions: list[tuple[str, int]]) -> None:
                self._topic_partitions = topic_partitions

            def beginning_offsets(self, topic_partitions: list[tuple[str, int]]) -> dict[tuple[str, int], int]:
                return {tp: 0 for tp in topic_partitions}

            def end_offsets(self, topic_partitions: list[tuple[str, int]]) -> dict[tuple[str, int], int]:
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

            def poll(self, timeout_ms: int = 0, max_records: int = 0) -> dict[tuple[str, int], list[_Record]]:
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
                    raise AssertionError('dump loop did not terminate after final in-window record')
                return {}

            def position(self, tp: tuple[str, int]) -> int:
                _ = tp
                # Simulate the live failure: consumer position stays on the last written offset.
                return 2

            def close(self) -> None:
                return None

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / 'source-dump.ndjson'
            fake_consumer = _FakeConsumer()

            with (
                patch.dict(
                    'sys.modules',
                    {'kafka': SimpleNamespace(TopicPartition=lambda topic, partition: (topic, partition))},
                ),
                patch(
                    'scripts.start_historical_simulation._consumer_for_dump',
                    return_value=fake_consumer,
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={'window': {'start': '2025-01-01T00:00:00Z', 'end': '2025-01-01T00:00:01Z'}},
                    dump_path=dump_path,
                    force=True,
                )

            self.assertEqual(report['records'], 3)
            self.assertEqual(report['records_by_topic'], {'torghut.trades.v1': 3})
            self.assertFalse(report['reused_existing_dump'])

    def test_dump_topics_completes_when_global_expected_record_count_is_reached(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        resources = replace(
            resources,
            replay_topic_by_source_topic={
                'torghut.quotes.v1': 'torghut.sim.quotes.v1',
                'torghut.trades.v1': 'torghut.sim.trades.v1',
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )

        class _OffsetMeta:
            def __init__(self, offset: int) -> None:
                self.offset = offset

        class _Record:
            def __init__(self, topic: str, partition: int, offset: int, timestamp: int) -> None:
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
                    ('torghut.quotes.v1', 0): 0,
                    ('torghut.trades.v1', 0): 0,
                }
                self._poll_calls = 0
                self._offset_lookup_calls = 0

            def partitions_for_topic(self, topic: str) -> set[int]:
                _ = topic
                return {0}

            def assign(self, topic_partitions: list[tuple[str, int]]) -> None:
                self._topic_partitions = topic_partitions

            def beginning_offsets(self, topic_partitions: list[tuple[str, int]]) -> dict[tuple[str, int], int]:
                return {tp: 0 for tp in topic_partitions}

            def end_offsets(self, topic_partitions: list[tuple[str, int]]) -> dict[tuple[str, int], int]:
                return {
                    ('torghut.quotes.v1', 0): 0,
                    ('torghut.trades.v1', 0): 3,
                }

            def offsets_for_times(
                self,
                request: dict[tuple[str, int], int],
            ) -> dict[tuple[str, int], _OffsetMeta]:
                self._offset_lookup_calls += 1
                quotes_offset = 0
                trades_offset = 0 if self._offset_lookup_calls == 1 else 3
                return {
                    ('torghut.quotes.v1', 0): _OffsetMeta(quotes_offset),
                    ('torghut.trades.v1', 0): _OffsetMeta(trades_offset),
                }

            def seek(self, tp: tuple[str, int], offset: int) -> None:
                self._positions[tp] = offset

            def poll(self, timeout_ms: int = 0, max_records: int = 0) -> dict[tuple[str, int], list[_Record]]:
                _ = (timeout_ms, max_records)
                self._poll_calls += 1
                if self._poll_calls == 1:
                    return {
                        ('torghut.trades.v1', 0): [
                            _Record('torghut.trades.v1', 0, 0, 1735695000000),
                            _Record('torghut.trades.v1', 0, 1, 1735695000100),
                            _Record('torghut.trades.v1', 0, 2, 1735695000200),
                        ]
                    }
                if self._poll_calls > 3:
                    raise AssertionError('dump loop did not terminate after global expected record count')
                return {}

            def position(self, tp: tuple[str, int]) -> int:
                if tp == ('torghut.quotes.v1', 0):
                    # Simulate a partition that never self-marks done even though it has zero expected records.
                    return -1
                return 2

            def close(self) -> None:
                return None

        with TemporaryDirectory() as tmp_dir:
            dump_path = Path(tmp_dir) / 'source-dump.ndjson'
            fake_consumer = _FakeConsumer()

            with (
                patch.dict(
                    'sys.modules',
                    {'kafka': SimpleNamespace(TopicPartition=lambda topic, partition: (topic, partition))},
                ),
                patch(
                    'scripts.start_historical_simulation._consumer_for_dump',
                    return_value=fake_consumer,
                ),
            ):
                report = _dump_topics(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={'window': {'start': '2025-01-01T00:00:00Z', 'end': '2025-01-01T00:00:01Z'}},
                    dump_path=dump_path,
                    force=True,
                )

            self.assertEqual(report['records'], 3)
            self.assertEqual(report['expected_records'], 3)
            self.assertEqual(report['records_by_topic'], {'torghut.trades.v1': 3})
            self.assertFalse(report['reused_existing_dump'])

    def test_verify_isolation_guards_rejects_simulation_topic_overlap(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
                'simulation_topics': {
                    'trades': 'torghut.trades.v1',
                },
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='uv run --frozen alembic upgrade heads',
        )

        with self.assertRaisesRegex(RuntimeError, 'simulation_topics_isolated_from_sources'):
            _verify_isolation_guards(
                resources=resources,
                postgres_config=postgres_config,
                ta_data={'TA_GROUP_ID': 'torghut-ta-main'},
            )

    def test_verify_isolation_guards_accepts_options_auxiliary_tables(self) -> None:
        resources = _build_resources(
            'options-sim-1',
            {
                'schema_version': 'torghut.options-simulation-manifest.v1',
                'lane': 'options',
                'dataset_id': 'dataset-a',
                'feed': 'indicative',
                'underlyings': ['AAPL'],
                'contract_policy': {'dte_min': 5, 'dte_max': 45},
                'catalog_snapshot_ref': 'artifacts/options/catalog.json',
                'raw_source_policy': {'prefer_kafka': True},
                'cost_model': {'contract_multiplier': 100},
                'proof_gates': {'minimum_contracts': 5},
            },
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_options_sim_1',
            simulation_db='torghut_sim_options_sim_1',
            migrations_command='uv run --frozen alembic upgrade heads',
        )

        report = _verify_isolation_guards(
            resources=resources,
            postgres_config=postgres_config,
            ta_data={'OPTIONS_TA_GROUP_ID': 'torghut-options-ta-main'},
        )

        self.assertEqual(report['lane'], 'options')
        self.assertTrue(report['auxiliary_tables_isolated'])

    def test_replay_dump_ignores_stale_marker_when_dump_changes(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
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
            dump_path = Path(tmp_dir) / 'source-dump.ndjson'
            row = {
                'source_topic': resources.source_topic_by_role['trades'],
                'replay_topic': resources.simulation_topic_by_role['trades'],
                'source_timestamp_ms': 1704067200000,
                'key_b64': None,
                'value_b64': None,
                'headers': [],
            }
            dump_path.write_text(json.dumps(row) + '\n', encoding='utf-8')

            marker_path = dump_path.with_suffix('.replay-marker.json')
            marker_path.write_text(
                json.dumps(
                    {
                        'reused_existing_replay': False,
                        'records': 999,
                        'dump_sha256': 'stale-checksum',
                    }
                ),
                encoding='utf-8',
            )

            producer = _FakeProducer()
            with patch(
                'scripts.start_historical_simulation._producer_for_replay',
                return_value=producer,
            ):
                report = _replay_dump(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={'replay': {'pace_mode': 'max_throughput'}},
                    dump_path=dump_path,
                    force=False,
                )
            self.assertFalse(report['reused_existing_replay'])
            self.assertEqual(report['records'], 1)
            self.assertEqual(
                producer.sent,
                [(resources.simulation_topic_by_role['trades'], 1704067200000)],
            )
            marker_payload = json.loads(marker_path.read_text(encoding='utf-8'))
            self.assertEqual(
                marker_payload.get('dump_sha256'),
                _dump_sha256_for_replay(dump_path),
            )

    def test_replay_dump_prefers_current_mapping_over_dump_replay_topic(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
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
            dump_path = Path(tmp_dir) / 'source-dump.ndjson'
            row = {
                'source_topic': resources.source_topic_by_role['trades'],
                'replay_topic': 'torghut.sim.legacy.trades.v1',
                'source_timestamp_ms': 1704067200000,
                'key_b64': None,
                'value_b64': None,
                'headers': [],
            }
            dump_path.write_text(json.dumps(row) + '\n', encoding='utf-8')

            producer = _FakeProducer()
            with patch(
                'scripts.start_historical_simulation._producer_for_replay',
                return_value=producer,
            ):
                report = _replay_dump(
                    resources=resources,
                    kafka_config=kafka_config,
                    manifest={'replay': {'pace_mode': 'max_throughput'}},
                    dump_path=dump_path,
                    force=True,
                )

            self.assertEqual(
                producer.sent,
                [(resources.simulation_topic_by_role['trades'], 1704067200000)],
            )
            self.assertEqual(report['replay_topic_overrides'], 1)

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
            bootstrap_servers='kafka-source:9092',
            security_protocol='PLAINTEXT',
            sasl_mechanism='SCRAM-SHA-512',
            sasl_username='source-user',
            sasl_password='source-secret',
            runtime_bootstrap_servers='kafka-runtime:9092',
            runtime_security_protocol='SASL_SSL',
            runtime_sasl_mechanism='SCRAM-SHA-256',
            runtime_sasl_username='runtime-user',
            runtime_sasl_password='runtime-secret',
        )

        with patch.dict(
            'sys.modules',
            {'kafka': SimpleNamespace(KafkaProducer=_FakeProducer)},
        ):
            _producer_for_replay(kafka_config, 'sim-run')

        self.assertEqual(captured.get('bootstrap_servers'), ['kafka-runtime:9092'])
        self.assertEqual(captured.get('security_protocol'), 'SASL_SSL')
        self.assertEqual(captured.get('sasl_mechanism'), 'SCRAM-SHA-256')
        self.assertEqual(captured.get('sasl_plain_username'), 'runtime-user')
        self.assertEqual(captured.get('sasl_plain_password'), 'runtime-secret')

    def test_restore_ta_configuration_removes_simulation_only_keys(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        state = {
            'ta_data': {
                'TA_GROUP_ID': 'torghut-ta-main',
                'TA_TRADES_TOPIC': 'torghut.trades.v1',
            }
        }
        current_configmap = {
            'data': {
                'TA_GROUP_ID': 'torghut-ta-sim-sim_1',
                'TA_TRADES_TOPIC': 'torghut.sim.trades.v1',
                'TA_AUTO_OFFSET_RESET': 'earliest',
            }
        }

        with (
            patch('scripts.start_historical_simulation._kubectl_json', return_value=current_configmap),
            patch('scripts.start_historical_simulation._kubectl_patch') as patch_mock,
        ):
            _restore_ta_configuration(resources, state)

        patch_mock.assert_called_once_with(
            resources.namespace,
            'configmap',
            resources.ta_configmap,
            {
                'data': {
                    'TA_GROUP_ID': 'torghut-ta-main',
                    'TA_TRADES_TOPIC': 'torghut.trades.v1',
                    'TA_AUTO_OFFSET_RESET': None,
                }
            },
        )

    def test_restore_torghut_env_reverts_forecast_overrides_and_trading_enabled(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        state = {
            'torghut_env_snapshot': {
                'TRADING_ENABLED': {
                    'name': 'TRADING_ENABLED',
                    'value': 'false',
                },
                'TRADING_FORECAST_SERVICE_URL': {
                    'name': 'TRADING_FORECAST_SERVICE_URL',
                    'value': 'http://torghut-forecast.torghut.svc.cluster.local:8089',
                },
                'TRADING_FORECAST_ROUTER_PROVIDER_MODE': {
                    'name': 'TRADING_FORECAST_ROUTER_PROVIDER_MODE',
                    'value': 'grpc',
                },
                'TRADING_FORECAST_ROUTER_PROVIDER_URL': None,
            }
        }
        service_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {
                                        'name': 'TRADING_FORECAST_SERVICE_URL',
                                        'value': 'http://torghut-forecast-sim.torghut.svc.cluster.local:8089',
                                    },
                                    {'name': 'TRADING_FORECAST_ROUTER_PROVIDER_MODE', 'value': 'http'},
                                    {
                                        'name': 'TRADING_FORECAST_ROUTER_PROVIDER_URL',
                                        'value': 'http://torghut-forecast-sim.torghut.svc.cluster.local:8089',
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
            patch('scripts.start_historical_simulation._kubectl_json', return_value=service_payload),
            patch(
                'scripts.start_historical_simulation._kubectl_patch',
                side_effect=lambda namespace, kind, name, patch: captured_patch.update(
                    {'namespace': namespace, 'kind': kind, 'name': name, 'patch': patch}
                ),
            ),
        ):
            _restore_torghut_env(resources, state)

        patch_payload = captured_patch.get('patch')
        self.assertIsInstance(patch_payload, dict)
        assert isinstance(patch_payload, dict)
        containers = (
            patch_payload.get('spec', {})
            .get('template', {})
            .get('spec', {})
            .get('containers', [])
        )
        self.assertIsInstance(containers, list)
        assert isinstance(containers, list)
        env_entries = containers[0].get('env') if containers else []
        self.assertIsInstance(env_entries, list)
        assert isinstance(env_entries, list)
        env_by_name = {
            str(item.get('name')): item
            for item in env_entries
            if isinstance(item, dict)
        }
        self.assertEqual(
            env_by_name['TRADING_ENABLED'].get('value'),
            'false',
        )
        self.assertEqual(
            env_by_name['TRADING_FORECAST_SERVICE_URL'].get('value'),
            'http://torghut-forecast.torghut.svc.cluster.local:8089',
        )
        self.assertEqual(
            env_by_name['TRADING_FORECAST_ROUTER_PROVIDER_MODE'].get('value'),
            'grpc',
        )
        self.assertNotIn('TRADING_FORECAST_ROUTER_PROVIDER_URL', env_by_name)

    def test_teardown_requires_runtime_lock_ownership(self) -> None:
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            state_path = resources.output_root / resources.run_token / 'state.json'
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(json.dumps({'ta_job_state': 'running'}))

            with patch(
                'scripts.start_historical_simulation._read_simulation_runtime_lock',
                return_value={'run_id': 'sim-2'},
            ):
                report = start_historical_simulation._teardown(
                    resources=resources,
                    allow_missing_state=False,
                )

        self.assertEqual(report['status'], 'degraded')
        self.assertTrue(report['skipped_restore'])
        self.assertEqual(report['reason'], 'simulation_runtime_lock_not_owned_by_run')
        self.assertEqual(report['simulation_lock']['status'], 'not_owner')

    def test_teardown_releases_runtime_lock_when_state_missing_allowed(self) -> None:
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with patch(
                'scripts.start_historical_simulation._release_simulation_runtime_lock',
                return_value={'status': 'released', 'run_id': resources.run_id},
            ) as release_lock:
                report = start_historical_simulation._teardown(
                    resources=resources,
                    allow_missing_state=True,
                )

        release_lock.assert_called_once_with(resources=resources)
        self.assertFalse(report['state_found'])
        self.assertEqual(report['simulation_lock']['status'], 'released')

    def test_build_simulation_completion_trace_marks_smoke_gate_satisfied(self) -> None:
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'torghut-smoke-open-hour-20260306',
                'dataset_snapshot_ref': 'torghut-smoke-open-hour-20260306',
                'window': {
                    'start': '2026-03-06T14:30:00Z',
                    'end': '2026-03-06T15:30:00Z',
                    'min_coverage_minutes': 60,
                    'strict_coverage_ratio': 0.95,
                },
            },
        )
        postgres = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost/torghut_sim_smoke',
            simulation_db='torghut_sim_smoke',
            migrations_command='alembic upgrade heads',
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            for filename in (
                'run-manifest.json',
                'run-full-lifecycle-manifest.json',
                'runtime-verify.json',
                'replay-report.json',
                'signal-activity.json',
                'decision-activity.json',
                'execution-activity.json',
            ):
                (resources.output_root / resources.run_token / filename).parent.mkdir(
                    parents=True,
                    exist_ok=True,
                )
                (resources.output_root / resources.run_token / filename).write_text(
                    '{}',
                    encoding='utf-8',
                )

            trace = _build_simulation_completion_trace(
                resources=resources,
                manifest={
                    'dataset_snapshot_ref': 'torghut-smoke-open-hour-20260306',
                    'window': {
                        'start': '2026-03-06T14:30:00Z',
                        'end': '2026-03-06T15:30:00Z',
                        'min_coverage_minutes': 60,
                        'strict_coverage_ratio': 0.95,
                    },
                },
                postgres_config=postgres,
                apply_report={
                    'window_policy': {'min_coverage_minutes': 60, 'strict_coverage_ratio': 0.95},
                    'dump_coverage': {'coverage_ratio': 1.0},
                },
                runtime_verify_report={'runtime_state': 'ready'},
                monitor_report={
                    'activity_classification': 'success',
                    'final_snapshot': {
                        'trade_decisions': 12,
                        'executions': 8,
                        'execution_tca_metrics': 8,
                        'execution_order_events': 8,
                    },
                },
                analytics_report={},
                fill_price_error_budget_report={
                    'status': 'within_budget',
                    'schema_version': 'fill-price-error-budget-report-v1',
                },
                rollouts_report={},
                errors=[],
            )

        smoke = trace['result_by_gate']['simulation_smoke_execution_funnel']
        self.assertEqual(smoke['status'], 'satisfied')
        self.assertEqual(trace['dataset_snapshot_ref'], 'torghut-smoke-open-hour-20260306')
        self.assertEqual(
            smoke['acceptance_snapshot']['fill_price_error_budget_status'],
            'within_budget',
        )

    def test_fill_price_error_budget_payload_rejects_missing_percentiles(self) -> None:
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'torghut-smoke-open-hour-20260306',
            },
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            payload, artifact_path = _build_fill_price_error_budget_payload(
                resources=resources,
                analytics_report={
                    'funnel': {'execution_tca_metrics': 5},
                    'execution_quality': {
                        'slippage_bps': {
                            'avg_abs': '1.0',
                            'p50_abs': None,
                            'p95_abs': None,
                            'max_abs': None,
                        }
                    },
                },
                manifest={},
            )

        assert payload is not None
        self.assertEqual(payload['status'], 'pending_runtime_observation')
        self.assertFalse(payload['metric_observation_complete'])
        self.assertIsNotNone(artifact_path)

    def test_build_simulation_completion_trace_allows_full_day_gate_without_runtime_ready(self) -> None:
        resources = _build_resources(
            'sim-2026-03-06-full-day',
            {
                'dataset_id': 'torghut-full-day-20260306',
                'dataset_snapshot_ref': 'torghut-full-day-20260306',
                'window': {
                    'profile': 'us_equities_regular',
                    'start': '2026-03-06T14:30:00Z',
                    'end': '2026-03-06T21:00:00Z',
                    'min_coverage_minutes': 390,
                    'strict_coverage_ratio': 0.95,
                },
            },
        )
        postgres = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost/torghut_sim_full_day',
            simulation_db='torghut_sim_full_day',
            migrations_command='alembic upgrade heads',
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            for filename in (
                'run-manifest.json',
                'run-full-lifecycle-manifest.json',
                'runtime-verify.json',
                'replay-report.json',
                'signal-activity.json',
                'decision-activity.json',
                'execution-activity.json',
            ):
                (resources.output_root / resources.run_token / filename).parent.mkdir(
                    parents=True,
                    exist_ok=True,
                )
                (resources.output_root / resources.run_token / filename).write_text(
                    '{}',
                    encoding='utf-8',
                )

            trace = _build_simulation_completion_trace(
                resources=resources,
                manifest={
                    'dataset_snapshot_ref': 'torghut-full-day-20260306',
                    'window': {
                        'profile': 'us_equities_regular',
                        'start': '2026-03-06T14:30:00Z',
                        'end': '2026-03-06T21:00:00Z',
                        'min_coverage_minutes': 390,
                        'strict_coverage_ratio': 0.95,
                    },
                },
                postgres_config=postgres,
                apply_report={
                    'window_policy': {'min_coverage_minutes': 390, 'strict_coverage_ratio': 0.95},
                    'dump_coverage': {'coverage_ratio': 1.0},
                },
                runtime_verify_report={'runtime_state': 'not_ready'},
                monitor_report={
                    'activity_classification': 'success',
                    'final_snapshot': {
                        'trade_decisions': 1145,
                        'executions': 528,
                        'execution_tca_metrics': 528,
                        'execution_order_events': 520,
                    },
                },
                analytics_report={},
                fill_price_error_budget_report={
                    'status': 'within_budget',
                    'schema_version': 'fill-price-error-budget-report-v1',
                },
                rollouts_report={},
                errors=[],
            )

        full_day = trace['result_by_gate']['simulation_full_day_coverage']
        self.assertEqual(full_day['status'], 'satisfied')
        self.assertIsNone(full_day['blocked_reason'])

    def test_validate_window_policy_us_equities_regular_profile(self) -> None:
        policy = _validate_window_policy(
            {
                'window': {
                    'profile': 'us_equities_regular',
                    'trading_day': '2026-02-27',
                    'timezone': 'America/New_York',
                    'start': '2026-02-27T14:30:00Z',
                    'end': '2026-02-27T21:00:00Z',
                }
            }
        )
        self.assertEqual(policy['profile'], 'us_equities_regular')
        self.assertEqual(policy['min_coverage_minutes'], 390)

    def test_doc29_simulation_gate_ids_normalize_mixed_case_profile(self) -> None:
        gate_ids = _doc29_simulation_gate_ids(
            {
                'window': {
                    'profile': 'US_EQUITIES_REGULAR',
                    'min_coverage_minutes': 60,
                }
            }
        )
        self.assertEqual(gate_ids, ['simulation_full_day_coverage'])

    def test_validate_window_policy_rejects_profile_mismatch(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'window_profile_mismatch:us_equities_regular'):
            _validate_window_policy(
                {
                    'window': {
                        'profile': 'us_equities_regular',
                        'trading_day': '2026-02-27',
                        'timezone': 'America/New_York',
                        'start': '2026-02-27T15:00:00Z',
                        'end': '2026-02-27T21:00:00Z',
                    }
                }
            )

    def test_validate_dump_coverage_rejects_short_dump_span(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'dump_coverage_too_short'):
            _validate_dump_coverage(
                manifest={
                    'window': {
                        'profile': 'us_equities_regular',
                        'trading_day': '2026-02-27',
                        'timezone': 'America/New_York',
                        'start': '2026-02-27T14:30:00Z',
                        'end': '2026-02-27T21:00:00Z',
                    }
                },
                dump_report={
                    'records': 100,
                    'min_source_timestamp_ms': 1709044200000,
                    'max_source_timestamp_ms': 1709044200000 + (30 * 60 * 1000),
                },
            )

    def test_monitor_run_completion_requires_order_events_when_executions_exist(self) -> None:
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        manifest = {
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T21:00:00Z',
            },
            'monitor': {
                'timeout_seconds': 10,
                'poll_seconds': 1,
                'min_trade_decisions': 1,
                'min_executions': 1,
                'min_execution_tca_metrics': 1,
                'min_execution_order_events': 0,
                'cursor_grace_seconds': 0,
            },
        }
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        with (
            patch(
                'scripts.historical_simulation_verification._monitor_snapshot',
                return_value={
                    'trade_decisions': 10,
                    'executions': 5,
                    'execution_tca_metrics': 5,
                    'execution_order_events': 0,
                    'cursor_at': '2026-02-27T21:00:01Z',
                },
            ),
            patch(
                'scripts.historical_simulation_verification._signal_snapshot',
                return_value={'signal_rows': 10, 'price_rows': 10},
            ),
            patch('scripts.historical_simulation_verification.time.sleep', return_value=None),
        ):
            report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify={'runtime_state': 'ready'},
            )
        self.assertEqual(report['status'], 'degraded')
        self.assertEqual(report['activity_classification'], 'executions_absent')

    def test_monitor_run_completion_succeeds_when_terminal_signal_precedes_window_end(self) -> None:
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        manifest = {
            'window': {
                'start': '2026-03-11T13:30:00Z',
                'end': '2026-03-11T13:35:00Z',
            },
            'monitor': {
                'timeout_seconds': 30,
                'poll_seconds': 1,
                'cursor_grace_seconds': 5,
            },
        }
        resources = _build_resources('sim-1', {'dataset_id': 'dataset-a'})
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        with (
            patch(
                'scripts.historical_simulation_verification._monitor_snapshot',
                return_value={
                    'trade_decisions': 12,
                    'executions': 12,
                    'execution_tca_metrics': 12,
                    'execution_order_events': 12,
                    'cursor_at': '2026-03-11T13:34:58Z',
                },
            ),
            patch(
                'scripts.historical_simulation_verification._signal_snapshot',
                return_value={
                    'signal_rows': 120,
                    'price_rows': 120,
                    'last_signal_ts': '2026-03-11T13:34:58Z',
                    'last_price_ts': '2026-03-11T13:34:59Z',
                },
            ),
            patch('scripts.historical_simulation_verification.time.sleep', return_value=None),
        ):
            report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify={'runtime_state': 'ready'},
            )

        self.assertEqual(report['status'], 'ok')
        self.assertEqual(report['activity_classification'], 'success')
        self.assertEqual(report['effective_terminal_signal_ts'], '2026-03-11T13:34:58+00:00')
        self.assertEqual(report['dataset_alignment'], 'window_declared_beyond_dataset')

    def test_run_full_lifecycle_fails_when_activity_verify_is_degraded(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T21:00:00Z',
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=False,
            applicationset_name='product',
            applicationset_namespace='argocd',
            app_name='torghut',
            root_app_name='root',
            desired_mode_during_run='manual',
            restore_mode_after_run='previous',
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=False,
            namespace='agents',
            runtime_template='torghut-runtime-ready-v1',
            activity_template='torghut-sim-activity-v1',
            teardown_template='torghut-teardown-v1',
            artifact_template='torghut-artifact-v1',
            verify_timeout_seconds=900,
            verify_poll_seconds=5,
        )

        with (
            patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
            patch('scripts.start_historical_simulation._update_run_state', return_value=None),
            patch('scripts.start_historical_simulation._save_json', return_value=None),
            patch('scripts.start_historical_simulation.persist_completion_trace', return_value={}),
            patch('scripts.start_historical_simulation.SessionLocal') as mock_session_local,
            patch('scripts.start_historical_simulation._apply', return_value={'status': 'ok'}),
            patch('scripts.start_historical_simulation._runtime_verify', return_value={'runtime_state': 'ready'}),
            patch('scripts.start_historical_simulation._replay_dump', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._monitor_run_completion',
                return_value={
                    'status': 'degraded',
                    'activity_classification': 'decisions_absent',
                    'final_snapshot': {},
                },
            ),
            patch('scripts.start_historical_simulation._report_simulation', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._build_strategy_proof_artifact',
                return_value={'status': 'ok', 'legacy_path_count': 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(commit=lambda: None)
            with self.assertRaisesRegex(RuntimeError, 'simulation_run_failed:activity:decisions_absent'):
                _run_full_lifecycle(
                    resources=resources,
                    manifest=manifest,
                    manifest_path=Path('/tmp/manifest.json'),
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
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T21:00:00Z',
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=False,
            applicationset_name='product',
            applicationset_namespace='argocd',
            app_name='torghut',
            root_app_name='root',
            desired_mode_during_run='manual',
            restore_mode_after_run='previous',
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=False,
            namespace='agents',
            runtime_template='torghut-runtime-ready-v1',
            activity_template='torghut-sim-activity-v1',
            teardown_template='torghut-teardown-v1',
            artifact_template='torghut-artifact-v1',
            verify_timeout_seconds=900,
            verify_poll_seconds=5,
        )
        call_order: list[str] = []

        with (
            patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
            patch('scripts.start_historical_simulation._update_run_state', return_value=None),
            patch('scripts.start_historical_simulation._save_json', return_value=None),
            patch('scripts.start_historical_simulation.persist_completion_trace', return_value={}),
            patch('scripts.start_historical_simulation.SessionLocal') as mock_session_local,
            patch('scripts.start_historical_simulation._prepare_argocd_for_run', return_value={'managed': False}),
            patch('scripts.start_historical_simulation._restore_argocd_after_run', return_value={'managed': False}),
            patch(
                'scripts.start_historical_simulation._apply',
                side_effect=lambda **_: call_order.append('apply') or {'status': 'ok'},
            ),
            patch(
                'scripts.start_historical_simulation._runtime_verify',
                side_effect=lambda **_: call_order.append('runtime_verify') or {'runtime_state': 'ready'},
            ),
            patch(
                'scripts.start_historical_simulation._replay_dump',
                side_effect=lambda **_: call_order.append('replay') or {'status': 'ok'},
            ),
            patch(
                'scripts.start_historical_simulation._monitor_run_completion',
                side_effect=lambda **_: call_order.append('monitor')
                or {
                    'status': 'ok',
                    'activity_classification': 'success',
                    'final_snapshot': {
                        'signal_rows': 5,
                        'price_rows': 5,
                        'trade_decisions': 3,
                        'cursor_at': '2026-02-27T21:00:00Z',
                        'executions': 2,
                        'execution_tca_metrics': 2,
                        'execution_order_events': 2,
                    },
                },
            ),
            patch(
                'scripts.start_historical_simulation._report_simulation',
                side_effect=lambda **_: call_order.append('report') or {'status': 'ok'},
            ),
            patch(
                'scripts.start_historical_simulation._build_strategy_proof_artifact',
                return_value={'status': 'ok', 'legacy_path_count': 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(commit=lambda: None)
            _run_full_lifecycle(
                resources=resources,
                manifest=manifest,
                manifest_path=Path('/tmp/manifest.json'),
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
            ['apply', 'runtime_verify', 'replay', 'monitor', 'report'],
        )

    def test_run_full_lifecycle_does_not_fail_when_activity_analysis_corroboration_is_unsuccessful(self) -> None:
        resources = _build_resources(
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T21:00:00Z',
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=False,
            applicationset_name='product',
            applicationset_namespace='argocd',
            app_name='torghut',
            root_app_name='root',
            desired_mode_during_run='manual',
            restore_mode_after_run='previous',
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace='torghut',
            runtime_template='torghut-simulation-runtime-ready',
            activity_template='torghut-simulation-activity',
            teardown_template='torghut-simulation-teardown-clean',
            artifact_template='torghut-simulation-artifact-bundle',
            verify_timeout_seconds=30,
            verify_poll_seconds=5,
        )

        with (
            patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
            patch('scripts.start_historical_simulation._update_run_state', return_value=None),
            patch('scripts.start_historical_simulation._save_json', return_value=None),
            patch('scripts.start_historical_simulation.persist_completion_trace', return_value={}),
            patch('scripts.start_historical_simulation._upsert_simulation_progress_row', return_value=None),
            patch('scripts.start_historical_simulation.SessionLocal') as mock_session_local,
            patch('scripts.start_historical_simulation._prepare_argocd_for_run', return_value={'managed': False}),
            patch('scripts.start_historical_simulation._restore_argocd_after_run', return_value={'managed': False}),
            patch('scripts.start_historical_simulation._apply', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._run_rollouts_analysis',
                side_effect=[
                    {'phase': 'Successful'},
                    {'phase': 'Failed'},
                ],
            ),
            patch('scripts.start_historical_simulation._runtime_verify', return_value={'runtime_state': 'ready'}),
            patch('scripts.start_historical_simulation._replay_dump', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._monitor_run_completion',
                return_value={
                    'status': 'ok',
                    'activity_classification': 'success',
                    'final_snapshot': {
                        'signal_rows': 5,
                        'price_rows': 5,
                        'trade_decisions': 3,
                        'cursor_at': '2026-02-27T21:00:00Z',
                        'executions': 2,
                        'execution_tca_metrics': 2,
                        'execution_order_events': 2,
                    },
                },
            ),
            patch('scripts.start_historical_simulation._report_simulation', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._build_strategy_proof_artifact',
                return_value={'status': 'ok', 'legacy_path_count': 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(commit=lambda: None)
            report = _run_full_lifecycle(
                resources=resources,
                manifest=manifest,
                manifest_path=Path('/tmp/manifest.json'),
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

        self.assertEqual(report['status'], 'ok')
        self.assertEqual(report['monitor']['activity_classification'], 'success')
        self.assertEqual(report['rollouts']['activity_analysis_run']['phase'], 'Failed')

    def test_run_full_lifecycle_aborts_before_replay_when_runtime_not_ready(self) -> None:
        resources = _build_resources(
            'sim-runtime-gate-fail',
            {
                'dataset_id': 'dataset-a',
            },
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T21:00:00Z',
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_runtime_gate',
            simulation_db='torghut_sim_runtime_gate',
            migrations_command='true',
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=False,
            applicationset_name='product',
            applicationset_namespace='argocd',
            app_name='torghut',
            root_app_name='root',
            desired_mode_during_run='manual',
            restore_mode_after_run='previous',
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace='torghut',
            runtime_template='torghut-simulation-runtime-ready',
            activity_template='torghut-simulation-activity',
            teardown_template='torghut-simulation-teardown-clean',
            artifact_template='torghut-simulation-artifact-bundle',
            verify_timeout_seconds=60,
            verify_poll_seconds=5,
        )

        with (
            patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
            patch('scripts.start_historical_simulation._update_run_state', return_value=None),
            patch('scripts.start_historical_simulation._save_json', return_value=None),
            patch('scripts.start_historical_simulation.persist_completion_trace', return_value={}),
            patch('scripts.start_historical_simulation._upsert_simulation_progress_row', return_value=None),
            patch('scripts.start_historical_simulation.SessionLocal') as mock_session_local,
            patch('scripts.start_historical_simulation._prepare_argocd_for_run', return_value={'managed': False}),
            patch('scripts.start_historical_simulation._restore_argocd_after_run', return_value={'managed': False}),
            patch('scripts.start_historical_simulation._apply', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._run_rollouts_analysis',
                return_value={'phase': 'Failed'},
            ),
            patch(
                'scripts.start_historical_simulation._runtime_verify',
                return_value={'runtime_state': 'not_ready'},
            ),
            patch('scripts.start_historical_simulation._replay_dump') as replay_dump,
            patch(
                'scripts.start_historical_simulation._report_simulation',
                return_value={'status': 'ok'},
            ),
            patch(
                'scripts.start_historical_simulation._build_strategy_proof_artifact',
                return_value={'status': 'ok', 'legacy_path_count': 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(commit=lambda: None)
            with self.assertRaisesRegex(
                RuntimeError,
                'simulation_run_failed:environment_incomplete',
            ):
                _run_full_lifecycle(
                    resources=resources,
                    manifest=manifest,
                    manifest_path=Path('/tmp/manifest.json'),
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
            'sim-1',
            {
                'dataset_id': 'dataset-a',
            },
        )
        manifest = {
            'dataset_id': 'dataset-a',
            'window': {
                'start': '2026-02-27T14:30:00Z',
                'end': '2026-02-27T21:00:00Z',
            },
        }
        kafka_config = KafkaRuntimeConfig(
            bootstrap_servers='kafka:9092',
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        argocd_config = ArgocdAutomationConfig(
            manage_automation=False,
            applicationset_name='product',
            applicationset_namespace='argocd',
            app_name='torghut',
            root_app_name='root',
            desired_mode_during_run='manual',
            restore_mode_after_run='previous',
            verify_timeout_seconds=600,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=False,
            namespace='agents',
            runtime_template='torghut-runtime-ready-v1',
            activity_template='torghut-sim-activity-v1',
            teardown_template='torghut-teardown-v1',
            artifact_template='torghut-artifact-v1',
            verify_timeout_seconds=30,
            verify_poll_seconds=5,
        )

        with (
            patch('scripts.start_historical_simulation._ensure_supported_binary', return_value=None),
            patch('scripts.start_historical_simulation._update_run_state', return_value=None),
            patch('scripts.start_historical_simulation._save_json', return_value=None),
            patch('scripts.start_historical_simulation.persist_completion_trace', return_value={}),
            patch('scripts.start_historical_simulation.SessionLocal') as mock_session_local,
            patch('scripts.start_historical_simulation._prepare_argocd_for_run', return_value={'managed': False}),
            patch('scripts.start_historical_simulation._restore_argocd_after_run', return_value={'managed': False}),
            patch('scripts.start_historical_simulation._apply', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._runtime_verify',
                side_effect=[
                    {'runtime_state': 'not_ready'},
                    {'runtime_state': 'ready'},
                ],
            ) as runtime_verify_mock,
            patch('scripts.start_historical_simulation.time.sleep', return_value=None) as sleep_mock,
            patch('scripts.start_historical_simulation._replay_dump', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._monitor_run_completion',
                return_value={
                    'status': 'ok',
                    'activity_classification': 'success',
                    'final_snapshot': {
                        'signal_rows': 5,
                        'price_rows': 5,
                        'trade_decisions': 3,
                        'cursor_at': '2026-02-27T21:00:00Z',
                        'executions': 2,
                        'execution_tca_metrics': 2,
                        'execution_order_events': 2,
                    },
                },
            ),
            patch('scripts.start_historical_simulation._report_simulation', return_value={'status': 'ok'}),
            patch(
                'scripts.start_historical_simulation._build_strategy_proof_artifact',
                return_value={'status': 'ok', 'legacy_path_count': 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(commit=lambda: None)
            _run_full_lifecycle(
                resources=resources,
                manifest=manifest,
                manifest_path=Path('/tmp/manifest.json'),
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

    def test_runtime_verify_accepts_dedicated_sim_runtime_with_ready_replicas(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_signals'},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_microbars'},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': 'sim-2026-03-06-open-hour'},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [
                    {
                        'type': 'Ready',
                        'status': 'True',
                    }
                ],
            }
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': 'torghut.sim.trades.v1.sim_2026_03_06_open_hour',
                'TA_QUOTES_TOPIC': 'torghut.sim.quotes.v1.sim_2026_03_06_open_hour',
                'TA_BARS1M_TOPIC': 'torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour',
                'TA_MICROBARS_TOPIC': 'torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour',
                'TA_SIGNALS_TOPIC': 'torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour',
                'TA_CLICKHOUSE_URL': 'jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {
                        'name': 'torghut-sim-00001-deployment',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                    {
                        'name': 'torghut-forecast-sim',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'ready')
        self.assertEqual(report['environment_state'], 'complete')
        self.assertEqual(report['torghut_service']['name'], 'torghut-sim')
        self.assertTrue(all(report['ta_runtime_config'].values()))

    def test_runtime_verify_accepts_options_lane_topics_and_tables(self) -> None:
        manifest = {
            'schema_version': 'torghut.options-simulation-manifest.v1',
            'lane': 'options',
            'feed': 'indicative',
            'underlyings': ['AAPL'],
            'contract_policy': {'dte_min': 5, 'dte_max': 45},
            'catalog_snapshot_ref': 'artifacts/options/catalog.json',
            'raw_source_policy': {'prefer_kafka': True},
            'cost_model': {'contract_multiplier': 100},
            'proof_gates': {'minimum_contracts': 5},
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:00:00Z',
            },
        }
        resources = _build_resources(
            'options-sim-2026-03-06-open',
            {
                **manifest,
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-options-ta-sim-config',
                    'ta_deployment': 'torghut-options-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': resources.clickhouse_signal_table},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': resources.clickhouse_price_table},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {
                                        'name': 'TRADING_ORDER_FEED_TOPIC',
                                        'value': resources.simulation_topic_by_role['order_updates'],
                                    },
                                    {
                                        'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC',
                                        'value': resources.simulation_topic_by_role['order_updates'],
                                    },
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': resources.run_id},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [
                    {
                        'type': 'Ready',
                        'status': 'True',
                    }
                ],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TOPIC_OPTIONS_CONTRACTS': resources.simulation_topic_by_role['contracts'],
                'TOPIC_OPTIONS_TRADES': resources.simulation_topic_by_role['trades'],
                'TOPIC_OPTIONS_QUOTES': resources.simulation_topic_by_role['quotes'],
                'TOPIC_OPTIONS_SNAPSHOTS': resources.simulation_topic_by_role['snapshots'],
                'TOPIC_OPTIONS_STATUS': resources.simulation_topic_by_role['status'],
                'TOPIC_OPTIONS_TA_CONTRACT_BARS': resources.simulation_topic_by_role['ta_contract_bars'],
                'TOPIC_OPTIONS_TA_CONTRACT_FEATURES': resources.simulation_topic_by_role['ta_contract_features'],
                'TOPIC_OPTIONS_TA_SURFACE_FEATURES': resources.simulation_topic_by_role['ta_surface_features'],
                'TOPIC_OPTIONS_TA_STATUS': resources.simulation_topic_by_role['ta_status'],
                'OPTIONS_TA_CLICKHOUSE_URL': 'jdbc:clickhouse://clickhouse/torghut_sim_options_sim_2026_03_06_open',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {
                        'name': 'torghut-sim-00001-deployment',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                    {
                        'name': 'torghut-forecast-sim',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-options-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'ready')
        self.assertTrue(all(report['ta_runtime_config'].values()))

    def test_runtime_verify_reads_strategy_runtime_flags_from_envfrom_configmap(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'envFrom': [
                                    {'configMapRef': {'name': 'torghut-autonomy-config'}},
                                ],
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_signals'},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_microbars'},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': 'sim-2026-03-06-open-hour'},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [
                    {
                        'type': 'Ready',
                        'status': 'True',
                    }
                ],
            },
        }
        autonomy_configmap_payload = {
            'data': {
                'TRADING_STRATEGY_RUNTIME_MODE': 'scheduler_v3',
                'TRADING_STRATEGY_SCHEDULER_ENABLED': 'true',
            }
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': 'torghut.sim.trades.v1.sim_2026_03_06_open_hour',
                'TA_QUOTES_TOPIC': 'torghut.sim.quotes.v1.sim_2026_03_06_open_hour',
                'TA_BARS1M_TOPIC': 'torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour',
                'TA_MICROBARS_TOPIC': 'torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour',
                'TA_SIGNALS_TOPIC': 'torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour',
                'TA_CLICKHOUSE_URL': 'jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, autonomy_configmap_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {
                        'name': 'torghut-sim-00001-deployment',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                    {
                        'name': 'torghut-forecast-sim',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'ready')
        self.assertTrue(report['torghut_service']['trading_config']['strategy_runtime_active'])

    def test_runtime_verify_rejects_scheduler_runtime_disabled(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'false'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_signals'},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_microbars'},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': 'sim-2026-03-06-open-hour'},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [
                    {
                        'type': 'Ready',
                        'status': 'True',
                    }
                ],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': 'torghut.sim.trades.v1.sim_2026_03_06_open_hour',
                'TA_QUOTES_TOPIC': 'torghut.sim.quotes.v1.sim_2026_03_06_open_hour',
                'TA_BARS1M_TOPIC': 'torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour',
                'TA_MICROBARS_TOPIC': 'torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour',
                'TA_SIGNALS_TOPIC': 'torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour',
                'TA_CLICKHOUSE_URL': 'jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {
                        'name': 'torghut-sim-00001-deployment',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                    {
                        'name': 'torghut-forecast-sim',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'not_ready')
        self.assertFalse(report['torghut_service']['trading_config']['strategy_runtime_active'])

    def test_runtime_verify_rejects_trading_disabled_sim_revision(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'false'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_signals'},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_microbars'},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': 'sim-2026-03-06-open-hour'},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [
                    {
                        'type': 'Ready',
                        'status': 'True',
                    }
                ],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': 'torghut.sim.trades.v1.sim_2026_03_06_open_hour',
                'TA_QUOTES_TOPIC': 'torghut.sim.quotes.v1.sim_2026_03_06_open_hour',
                'TA_BARS1M_TOPIC': 'torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour',
                'TA_MICROBARS_TOPIC': 'torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour',
                'TA_SIGNALS_TOPIC': 'torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour',
                'TA_CLICKHOUSE_URL': 'jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {
                        'name': 'torghut-sim-00001-deployment',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                    {
                        'name': 'torghut-forecast-sim',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'not_ready')
        self.assertEqual(report['environment_state'], 'environment_incomplete')
        self.assertFalse(report['torghut_service']['trading_config']['trading_enabled'])

    def test_runtime_verify_rejects_ta_topic_mismatch(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_signals'},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_microbars'},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': 'sim-2026-03-06-open-hour'},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [
                    {
                        'type': 'Ready',
                        'status': 'True',
                    }
                ],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': 'torghut.sim.trades.v1.sim_2026_03_06_open_hour_r18',
                'TA_QUOTES_TOPIC': 'torghut.sim.quotes.v1.sim_2026_03_06_open_hour_r18',
                'TA_BARS1M_TOPIC': 'torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour_r18',
                'TA_MICROBARS_TOPIC': 'torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour_r18',
                'TA_SIGNALS_TOPIC': 'torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour_r18',
                'TA_CLICKHOUSE_URL': 'jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour_r18',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {
                        'name': 'torghut-sim-00001-deployment',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                    {
                        'name': 'torghut-forecast-sim',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'not_ready')
        self.assertEqual(report['environment_state'], 'environment_incomplete')
        self.assertFalse(report['ta_runtime_config']['trades_topic'])

    def test_runtime_verify_rejects_missing_ta_signal_source_allowlist(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_signals'},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': 'torghut_sim_sim_2026_03_06_open_hour.ta_microbars'},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': 'torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour'},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': 'sim-2026-03-06-open-hour'},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [
                    {
                        'type': 'Ready',
                        'status': 'True',
                    }
                ],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': 'torghut.sim.trades.v1.sim_2026_03_06_open_hour',
                'TA_QUOTES_TOPIC': 'torghut.sim.quotes.v1.sim_2026_03_06_open_hour',
                'TA_BARS1M_TOPIC': 'torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour',
                'TA_MICROBARS_TOPIC': 'torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour',
                'TA_SIGNALS_TOPIC': 'torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour',
                'TA_CLICKHOUSE_URL': 'jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {
                        'name': 'torghut-sim-00001-deployment',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                    {
                        'name': 'torghut-forecast-sim',
                        'ready_replicas': 1,
                        'available_replicas': 1,
                        'replicas': 1,
                    },
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'not_ready')
        self.assertEqual(report['environment_state'], 'environment_incomplete')
        self.assertFalse(report['torghut_service']['trading_config']['signal_allowed_sources'])

    def test_runtime_verify_rejects_schema_registry_subject_failure(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': resources.clickhouse_signal_table},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': resources.clickhouse_price_table},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': resources.simulation_topic_by_role['order_updates']},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': resources.simulation_topic_by_role['order_updates']},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': resources.run_id},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [{'type': 'Ready', 'status': 'True'}],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TA_SCHEMA_REGISTRY_URL': 'http://karapace.kafka:8081',
                'TA_TRADES_TOPIC': resources.simulation_topic_by_role['trades'],
                'TA_QUOTES_TOPIC': resources.simulation_topic_by_role['quotes'],
                'TA_BARS1M_TOPIC': resources.simulation_topic_by_role['bars'],
                'TA_MICROBARS_TOPIC': resources.simulation_topic_by_role['ta_microbars'],
                'TA_SIGNALS_TOPIC': resources.simulation_topic_by_role['ta_signals'],
                'TA_CLICKHOUSE_URL': f'jdbc:clickhouse://clickhouse/{resources.clickhouse_db}',
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {'name': 'torghut-sim-00001-deployment', 'ready_replicas': 1, 'available_replicas': 1, 'replicas': 1},
                    {'name': 'torghut-forecast-sim', 'ready_replicas': 1, 'available_replicas': 1, 'replicas': 1},
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
            patch(
                'scripts.historical_simulation_verification._http_json_get',
                side_effect=[(200, '[]'), (404, '{}'), (200, '{}')],
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'not_ready')
        self.assertEqual(report['schema_registry']['reason'], 'schema_subject_missing')
        self.assertEqual(
            report['schema_registry']['subjects_checked'],
            [
                f"{resources.simulation_topic_by_role['ta_microbars']}-value",
                f"{resources.simulation_topic_by_role['ta_signals']}-value",
            ],
        )
        self.assertEqual(
            report['schema_registry']['subjects_missing'],
            [f"{resources.simulation_topic_by_role['ta_microbars']}-value"],
        )

    def test_flink_runtime_health_classifies_missing_restore_state(self) -> None:
        deployment = {
            'spec': {
                'job': {
                    'state': 'running',
                    'upgradeMode': 'last-state',
                }
            },
            'status': {
                'jobManagerDeploymentStatus': 'MISSING',
                'jobStatus': {
                    'state': 'FAILED',
                    'error': 'Checkpoint path not found while restoring last-state',
                },
            },
        }

        with patch(
            'scripts.historical_simulation_verification._kubectl_json',
            return_value=deployment,
        ):
            health = historical_simulation_verification._flink_runtime_health(
                'torghut',
                'torghut-ta-sim',
            )

        self.assertEqual(health['restore_state_reason'], 'restore_state_missing')
        self.assertEqual(health['upgrade_mode'], 'last-state')

    def test_runtime_verify_rejects_stale_analysis_template_images(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            }
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'image': 'registry.ide-newton.ts.net/lab/torghut@sha256:service',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': resources.clickhouse_signal_table},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': resources.clickhouse_price_table},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': resources.simulation_topic_by_role['order_updates']},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': resources.simulation_topic_by_role['order_updates']},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': resources.run_id},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [{'type': 'Ready', 'status': 'True'}],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': resources.simulation_topic_by_role['trades'],
                'TA_QUOTES_TOPIC': resources.simulation_topic_by_role['quotes'],
                'TA_BARS1M_TOPIC': resources.simulation_topic_by_role['bars'],
                'TA_MICROBARS_TOPIC': resources.simulation_topic_by_role['ta_microbars'],
                'TA_SIGNALS_TOPIC': resources.simulation_topic_by_role['ta_signals'],
                'TA_CLICKHOUSE_URL': f'jdbc:clickhouse://clickhouse/{resources.clickhouse_db}',
            }
        }
        runtime_template_payload = {
            'spec': {
                'metrics': [
                    {
                        'provider': {
                            'job': {
                                'spec': {
                                    'template': {
                                        'spec': {
                                            'containers': [
                                                {'image': 'registry.ide-newton.ts.net/lab/torghut@sha256:stale'}
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        }
        activity_template_payload = {
            'spec': {
                'metrics': [
                    {
                        'provider': {
                            'job': {
                                'spec': {
                                    'template': {
                                        'spec': {
                                            'containers': [
                                                {'image': 'registry.ide-newton.ts.net/lab/torghut@sha256:service'}
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        }

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[
                    kservice_payload,
                    ta_configmap_payload,
                    runtime_template_payload,
                    activity_template_payload,
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {'name': 'torghut-sim-00001-deployment', 'ready_replicas': 1, 'available_replicas': 1, 'replicas': 1},
                    {'name': 'torghut-forecast-sim', 'ready_replicas': 1, 'available_replicas': 1, 'replicas': 1},
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['runtime_state'], 'not_ready')
        self.assertEqual(report['analysis_images']['reason'], 'analysis_image_stale')
        self.assertIn(
            'torghut-simulation-runtime-ready',
            report['analysis_images']['mismatched_templates'],
        )

    def test_runtime_verify_uses_manifest_override_for_analysis_templates(self) -> None:
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            },
            'rollouts': {
                'runtime_template': 'torghut-runtime-ready-v1',
                'activity_template': 'torghut-sim-activity-v1',
            },
        }
        resources = _build_resources(
            'sim-2026-03-06-open-hour',
            {
                'dataset_id': 'dataset-a',
                'runtime': {
                    'target_mode': 'dedicated_service',
                    'namespace': 'torghut',
                    'ta_configmap': 'torghut-ta-sim-config',
                    'ta_deployment': 'torghut-ta-sim',
                    'torghut_service': 'torghut-sim',
                    'torghut_forecast_service': 'torghut-forecast-sim',
                },
            },
        )
        kservice_payload = {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': 'user-container',
                                'image': 'registry.ide-newton.ts.net/lab/torghut@sha256:service',
                                'env': [
                                    {'name': 'TRADING_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIMULATION_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_STRATEGY_RUNTIME_MODE', 'value': 'scheduler_v3'},
                                    {'name': 'TRADING_STRATEGY_SCHEDULER_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_SIGNAL_TABLE', 'value': resources.clickhouse_signal_table},
                                    {'name': 'TRADING_PRICE_TABLE', 'value': resources.clickhouse_price_table},
                                    {'name': 'TRADING_ORDER_FEED_ENABLED', 'value': 'true'},
                                    {'name': 'TRADING_ORDER_FEED_TOPIC', 'value': resources.simulation_topic_by_role['order_updates']},
                                    {'name': 'TRADING_SIMULATION_ORDER_UPDATES_TOPIC', 'value': resources.simulation_topic_by_role['order_updates']},
                                    {'name': 'TRADING_SIMULATION_RUN_ID', 'value': resources.run_id},
                                    {'name': 'TRADING_SIGNAL_ALLOWED_SOURCES', 'value': 'ws,ta'},
                                ],
                            }
                        ]
                    }
                }
            },
            'status': {
                'latestReadyRevisionName': 'torghut-sim-00001',
                'conditions': [{'type': 'Ready', 'status': 'True'}],
            },
        }
        ta_configmap_payload = {
            'data': {
                'TA_TRADES_TOPIC': resources.simulation_topic_by_role['trades'],
                'TA_QUOTES_TOPIC': resources.simulation_topic_by_role['quotes'],
                'TA_BARS1M_TOPIC': resources.simulation_topic_by_role['bars'],
                'TA_MICROBARS_TOPIC': resources.simulation_topic_by_role['ta_microbars'],
                'TA_SIGNALS_TOPIC': resources.simulation_topic_by_role['ta_signals'],
                'TA_CLICKHOUSE_URL': f'jdbc:clickhouse://clickhouse/{resources.clickhouse_db}',
            }
        }
        runtime_template_payload = {
            'spec': {
                'metrics': [
                    {
                        'provider': {
                            'job': {
                                'spec': {
                                    'template': {
                                        'spec': {
                                            'containers': [
                                                {'image': 'registry.ide-newton.ts.net/lab/torghut@sha256:service'}
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        }
        activity_template_payload = runtime_template_payload

        with (
            patch(
                'scripts.historical_simulation_verification._kubectl_json',
                side_effect=[
                    kservice_payload,
                    ta_configmap_payload,
                    runtime_template_payload,
                    activity_template_payload,
                ],
            ) as kubectl_json,
            patch(
                'scripts.historical_simulation_verification._deployment_replica_health',
                side_effect=[
                    {'name': 'torghut-sim-00001-deployment', 'ready_replicas': 1, 'available_replicas': 1, 'replicas': 1},
                    {'name': 'torghut-forecast-sim', 'ready_replicas': 1, 'available_replicas': 1, 'replicas': 1},
                ],
            ),
            patch(
                'scripts.historical_simulation_verification._flink_runtime_health',
                return_value={
                    'name': 'torghut-ta-sim',
                    'desired_state': 'running',
                    'lifecycle_state': 'RUNNING',
                    'job_manager_status': 'DEPLOYED',
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report['analysis_images']['reason'], 'ok')
        kubectl_calls = [call.args[1][2] for call in kubectl_json.call_args_list[2:]]
        self.assertEqual(kubectl_calls, ['torghut-runtime-ready-v1', 'torghut-sim-activity-v1'])

    def test_build_argocd_automation_config_defaults(self) -> None:
        config = _build_argocd_automation_config({})
        self.assertFalse(config.manage_automation)
        self.assertEqual(config.applicationset_name, 'product')
        self.assertEqual(config.applicationset_namespace, 'argocd')
        self.assertEqual(config.app_name, 'torghut')

    def test_build_argocd_automation_config_preserves_dedicated_service_opt_in(self) -> None:
        config = _build_argocd_automation_config(
            {
                'runtime': {'target_mode': 'dedicated_service'},
                'argocd': {'manage_automation': True},
            }
        )

        self.assertTrue(config.manage_automation)

    def test_build_rollouts_analysis_config_defaults(self) -> None:
        config = _build_rollouts_analysis_config({})
        self.assertFalse(config.enabled)
        self.assertEqual(config.namespace, 'torghut')
        self.assertEqual(config.runtime_template, 'torghut-simulation-runtime-ready')
        self.assertEqual(config.activity_template, 'torghut-simulation-activity')
        self.assertEqual(config.teardown_template, 'torghut-simulation-teardown-clean')
        self.assertEqual(config.verify_poll_seconds, 5)

    def test_run_rollouts_analysis_materializes_analysisrun_from_template(self) -> None:
        resources = _build_resources('sim-2026-03-06-open-hour', {'dataset_id': 'dataset-a'})
        manifest = {
            'window': {
                'start': '2026-03-06T14:30:00Z',
                'end': '2026-03-06T15:30:00Z',
            },
            'monitor': {
                'timeout_seconds': 60,
                'poll_seconds': 5,
                'min_trade_decisions': 1,
                'min_executions': 1,
                'min_execution_tca_metrics': 1,
                'min_execution_order_events': 1,
                'cursor_grace_seconds': 10,
            },
        }
        postgres_config = PostgresRuntimeConfig(
            admin_dsn='postgresql://torghut:secret@localhost:5432/postgres',
            simulation_dsn='postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1',
            simulation_db='torghut_sim_sim_1',
            migrations_command='true',
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url='http://clickhouse:8123',
            username='torghut',
            password=None,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace='torghut',
            runtime_template='torghut-simulation-runtime-ready',
            activity_template='torghut-simulation-activity',
            teardown_template='torghut-simulation-teardown-clean',
            artifact_template='torghut-simulation-artifact-bundle',
            verify_timeout_seconds=60,
            verify_poll_seconds=5,
        )
        captured_apply: dict[str, object] = {}

        def _fake_kubectl_json(namespace: str, args: list[str]) -> dict[str, object]:
            self.assertEqual(namespace, 'torghut')
            if args[:3] == ['get', 'analysistemplate', 'torghut-simulation-runtime-ready']:
                return {
                    'spec': {
                        'args': [
                            {'name': 'runId'},
                            {'name': 'datasetId'},
                            {'name': 'namespace'},
                            {'name': 'torghutService'},
                            {'name': 'taDeployment'},
                            {'name': 'forecastService'},
                            {'name': 'windowStart'},
                            {'name': 'windowEnd'},
                            {'name': 'signalTable'},
                            {'name': 'priceTable'},
                            {'name': 'runtimeVerifyTimeoutSeconds'},
                            {'name': 'runtimeVerifyPollSeconds'},
                        ],
                        'metrics': [{'name': 'runtime-ready'}],
                    }
                }
            if args[:3] == ['get', 'analysisrun', 'torghut-sim-runtime-ready-sim-2026-03-06-open-hour']:
                return {'status': {'phase': 'Successful'}}
            raise AssertionError(f'unexpected kubectl args: {args}')

        with (
            patch('scripts.start_historical_simulation._kubectl_delete_if_exists', return_value=None),
            patch(
                'scripts.start_historical_simulation._kubectl_apply',
                side_effect=lambda namespace, payload: captured_apply.update({'namespace': namespace, 'payload': payload}),
            ),
            patch('scripts.start_historical_simulation._kubectl_json', side_effect=_fake_kubectl_json),
        ):
            report = _run_rollouts_analysis(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                rollouts_config=rollouts_config,
                phase='runtime-ready',
                template_name='torghut-simulation-runtime-ready',
            )

        self.assertEqual(report['phase'], 'Successful')
        payload = captured_apply['payload']
        self.assertIsInstance(payload, dict)
        assert isinstance(payload, dict)
        self.assertEqual(payload['kind'], 'AnalysisRun')
        self.assertEqual(payload['metadata']['name'], 'torghut-sim-runtime-ready-sim-2026-03-06-open-hour')
        self.assertEqual(payload['spec']['args'][8]['value'], 'torghut_sim_sim_2026_03_06_open_hour.ta_signals')
        self.assertEqual(payload['spec']['args'][9]['value'], 'torghut_sim_sim_2026_03_06_open_hour.ta_microbars')
        self.assertEqual(payload['spec']['args'][-2]['value'], '60')
        self.assertEqual(payload['spec']['args'][-1]['value'], '5')

    def test_runtime_ready_template_declares_signal_and_price_tables(self) -> None:
        template_path = (
            Path(__file__).resolve().parents[3]
            / 'argocd'
            / 'applications'
            / 'torghut'
            / 'analysis-template-runtime-ready.yaml'
        )
        template = yaml.safe_load(template_path.read_text(encoding='utf-8'))
        spec = template['spec']
        arg_names = [entry['name'] for entry in spec['args']]
        self.assertIn('signalTable', arg_names)
        self.assertIn('priceTable', arg_names)
        args_text = spec['metrics'][0]['provider']['job']['spec']['template']['spec']['containers'][0]['args'][0]
        self.assertIn('--signal-table "{{args.signalTable}}"', args_text)
        self.assertIn('--price-table "{{args.priceTable}}"', args_text)

    def test_discover_automation_pointer_finds_nested_element(self) -> None:
        payload = {
            'spec': {
                'generators': [
                    {
                        'matrix': {
                            'generators': [
                                {'git': {'repoURL': 'https://example.invalid'}},
                                {
                                    'list': {
                                        'elements': [
                                            {'name': 'other', 'automation': 'auto'},
                                            {'name': 'torghut', 'automation': 'manual'},
                                        ]
                                    }
                                },
                            ]
                        }
                    }
                ]
            }
        }
        discovered = _discover_automation_pointer(payload, app_name='torghut')
        self.assertIsNotNone(discovered)
        assert discovered is not None
        pointer, mode = discovered
        self.assertIn('/spec/', pointer)
        self.assertEqual(mode, 'manual')

    def test_set_argocd_automation_mode_patches_and_verifies(self) -> None:
        payload_auto = {
            'spec': {
                'generators': [
                    {
                        'list': {
                            'elements': [
                                {'name': 'torghut', 'automation': 'auto'},
                            ]
                        }
                    }
                ]
            }
        }
        payload_manual = {
            'spec': {
                'generators': [
                    {
                        'list': {
                            'elements': [
                                {'name': 'torghut', 'automation': 'manual'},
                            ]
                        }
                    }
                ]
            }
        }
        with (
            patch(
                'scripts.start_historical_simulation._kubectl_json_global',
                side_effect=[payload_auto, payload_manual],
            ),
            patch('scripts.start_historical_simulation._kubectl_patch_json') as patch_mock,
        ):
            report = _set_argocd_automation_mode(
                config=ArgocdAutomationConfig(
                    manage_automation=True,
                    applicationset_name='product',
                    applicationset_namespace='argocd',
                    app_name='torghut',
                    root_app_name='root',
                    desired_mode_during_run='manual',
                    restore_mode_after_run='previous',
                    verify_timeout_seconds=30,
                ),
                desired_mode='manual',
            )
        self.assertTrue(report['changed'])
        patch_mock.assert_called_once()
        self.assertEqual(report['current_mode'], 'manual')

    def test_set_argocd_application_sync_policy_patches_and_verifies(self) -> None:
        payload_auto = {
            'spec': {
                'syncPolicy': {
                    'automated': {
                        'enabled': True,
                        'prune': True,
                        'selfHeal': True,
                    },
                    'syncOptions': ['CreateNamespace=true'],
                }
            }
        }
        payload_manual = {
            'spec': {
                'syncPolicy': {
                    'automated': {
                        'enabled': False,
                        'prune': False,
                        'selfHeal': False,
                    },
                    'syncOptions': ['CreateNamespace=true'],
                }
            }
        }
        with (
            patch(
                'scripts.start_historical_simulation._kubectl_json_global',
                side_effect=[payload_auto, payload_manual],
            ),
            patch('scripts.start_historical_simulation._kubectl_patch') as patch_mock,
        ):
            report = _set_argocd_application_sync_policy(
                config=ArgocdAutomationConfig(
                    manage_automation=True,
                    applicationset_name='product',
                    applicationset_namespace='argocd',
                    app_name='torghut',
                    root_app_name='root',
                    desired_mode_during_run='manual',
                    restore_mode_after_run='previous',
                    verify_timeout_seconds=30,
                ),
                desired_sync_policy=payload_manual['spec']['syncPolicy'],
            )
        self.assertTrue(report['changed'])
        patch_mock.assert_called_once()
        self.assertEqual(
            report['current_sync_policy']['automated'],
            {'enabled': False, 'prune': False, 'selfHeal': False},
        )

    def test_argocd_application_mode_from_sync_policy_treats_missing_automation_as_manual(self) -> None:
        self.assertEqual(
            start_historical_simulation._argocd_application_mode_from_sync_policy(
                {'syncOptions': ['CreateNamespace=true']}
            ),
            'manual',
        )
        self.assertEqual(
            start_historical_simulation._argocd_application_mode_from_sync_policy(
                {'automated': {'enabled': True}}
            ),
            'auto',
        )

    def test_prepare_argocd_for_run_pauses_root_and_applicationset(self) -> None:
        config = ArgocdAutomationConfig(
            manage_automation=True,
            applicationset_name='product',
            applicationset_namespace='argocd',
            app_name='torghut',
            root_app_name='root',
            desired_mode_during_run='manual',
            restore_mode_after_run='previous',
            verify_timeout_seconds=30,
        )
        with (
            patch(
                'scripts.start_historical_simulation._read_argocd_automation_mode',
                return_value={'pointer': '/spec/generators/0/list/elements/0/automation', 'mode': 'auto'},
            ) as automation_read_mock,
            patch(
                'scripts.start_historical_simulation._read_named_argocd_application_sync_policy',
                return_value={
                    'sync_policy': {
                        'automated': {'enabled': True, 'prune': True, 'selfHeal': True},
                        'syncOptions': ['CreateNamespace=true'],
                    },
                    'automation_mode': 'auto',
                },
            ) as application_read_mock,
            patch(
                'scripts.start_historical_simulation._set_argocd_application_sync_policy',
                return_value={
                    'previous_sync_policy': {
                        'automated': {'enabled': True, 'prune': True, 'selfHeal': True},
                    },
                    'current_sync_policy': {
                        'automated': {'enabled': False, 'prune': False, 'selfHeal': False},
                    },
                    'changed': True,
                },
            ) as root_application_mock,
            patch(
                'scripts.start_historical_simulation._set_argocd_automation_mode',
                return_value={
                    'pointer': '/spec/generators/0/list/elements/0/automation',
                    'previous_mode': 'auto',
                    'desired_mode': 'manual',
                    'current_mode': 'manual',
                    'changed': True,
                },
            ) as applicationset_mock,
            patch(
                'scripts.start_historical_simulation._wait_for_argocd_application_mode',
                return_value={
                    'app_name': 'torghut',
                    'current_mode': 'manual',
                },
            ) as application_mode_mock,
        ):
            report = _prepare_argocd_for_run(config=config)
        automation_read_mock.assert_called_once()
        application_read_mock.assert_called_once_with(
            namespace='argocd',
            app_name='root',
        )
        root_application_mock.assert_called_once()
        applicationset_mock.assert_called_once()
        application_mode_mock.assert_called_once()
        self.assertTrue(report['changed'])
        self.assertIn('application', report)
        self.assertIn('root_application', report)
        self.assertTrue(report['applicationset_managed'])
        self.assertEqual(report['previous_mode'], 'auto')
        self.assertEqual(report['current_mode'], 'manual')

    def test_restore_argocd_after_run_restores_root_and_applicationset(self) -> None:
        config = ArgocdAutomationConfig(
            manage_automation=True,
            applicationset_name='product',
            applicationset_namespace='argocd',
            app_name='torghut',
            root_app_name='root',
            desired_mode_during_run='manual',
            restore_mode_after_run='previous',
            verify_timeout_seconds=30,
        )
        previous_sync_policy = {
            'automated': {'enabled': True, 'prune': True, 'selfHeal': True},
            'syncOptions': ['CreateNamespace=true'],
        }
        with (
            patch(
                'scripts.start_historical_simulation._set_argocd_automation_mode',
                return_value={
                    'pointer': '/spec/generators/0/list/elements/0/automation',
                    'previous_mode': 'manual',
                    'desired_mode': 'auto',
                    'current_mode': 'auto',
                    'changed': True,
                },
            ) as applicationset_mock,
            patch(
                'scripts.start_historical_simulation._set_argocd_application_sync_policy',
                return_value={
                    'previous_sync_policy': {
                        'automated': {'enabled': False, 'prune': False, 'selfHeal': False},
                    },
                    'current_sync_policy': previous_sync_policy,
                    'changed': True,
                },
            ) as application_mock,
            patch(
                'scripts.start_historical_simulation._wait_for_argocd_application_mode',
                return_value={
                    'app_name': 'torghut',
                    'current_mode': 'auto',
                },
            ) as application_mode_mock,
        ):
            report = _restore_argocd_after_run(
                config=config,
                previous_mode='auto',
                previous_sync_policy=previous_sync_policy,
            )
        applicationset_mock.assert_called_once()
        application_mock.assert_called_once()
        application_mode_mock.assert_called_once()
        self.assertTrue(report['changed'])
        self.assertEqual(report['restored_mode'], 'auto')
        self.assertTrue(report['applicationset_managed'])
        self.assertEqual(report['current_mode'], 'auto')
