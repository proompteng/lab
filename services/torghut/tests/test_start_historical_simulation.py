from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from scripts.start_historical_simulation import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    PostgresRuntimeConfig,
    _build_clickhouse_runtime_config,
    _build_argocd_automation_config,
    _build_kafka_runtime_config,
    _build_plan_report,
    _build_postgres_runtime_config,
    _build_resources,
    _configure_torghut_service_for_simulation,
    _discover_automation_pointer,
    _find_vector_extension_blocking_revision,
    _dump_topics,
    _dump_sha256_for_replay,
    _ensure_topics,
    _file_sha256,
    _http_clickhouse_query,
    _merge_env_entries,
    _monitor_run_completion,
    _normalize_run_token,
    _offset_for_time_lookup,
    _pacing_delay_seconds,
    _producer_for_replay,
    _redact_dsn_credentials,
    _restore_ta_configuration,
    _replay_dump,
    _set_argocd_automation_mode,
    _run_migrations,
    _torghut_env_overrides_from_manifest,
    _validate_dump_coverage,
    _validate_window_policy,
    _verify_isolation_guards,
)


class TestStartHistoricalSimulation(TestCase):
    def test_normalize_run_token(self) -> None:
        self.assertEqual(_normalize_run_token('Sim-2026/02/27#Run-01'), 'sim_2026_02_27_run_01')

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
        self.assertEqual(resources.simulation_topic_by_role['order_updates'], 'torghut.sim.trade-updates.v1')
        self.assertEqual(
            resources.replay_topic_by_source_topic['torghut.trades.v1'],
            'torghut.sim.trades.v1',
        )

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

        with patch('scripts.start_historical_simulation.HTTPConnection', _FakeConnection):
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
                postgres_config=postgres_config,
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
                postgres_config=postgres_config,
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
        with (
            patch(
                'scripts.start_historical_simulation._monitor_snapshot',
                return_value={
                    'trade_decisions': 10,
                    'executions': 5,
                    'execution_tca_metrics': 5,
                    'execution_order_events': 0,
                    'cursor_at': '2026-02-27T21:00:01Z',
                },
            ),
            patch('scripts.start_historical_simulation.time.sleep', return_value=None),
            self.assertRaisesRegex(
                RuntimeError,
                'monitor_thresholds_not_met_after_cursor_reached .*execution_order_events=0',
            ),
        ):
            _monitor_run_completion(
                manifest=manifest,
                postgres_config=postgres_config,
            )

    def test_build_argocd_automation_config_defaults(self) -> None:
        config = _build_argocd_automation_config({})
        self.assertFalse(config.manage_automation)
        self.assertEqual(config.applicationset_name, 'product')
        self.assertEqual(config.applicationset_namespace, 'argocd')
        self.assertEqual(config.app_name, 'torghut')

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
                    desired_mode_during_run='manual',
                    restore_mode_after_run='previous',
                    verify_timeout_seconds=30,
                ),
                desired_mode='manual',
            )
        self.assertTrue(report['changed'])
        patch_mock.assert_called_once()
        self.assertEqual(report['current_mode'], 'manual')
