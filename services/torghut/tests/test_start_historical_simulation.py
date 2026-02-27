from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from scripts.start_historical_simulation import (
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    _build_plan_report,
    _build_postgres_runtime_config,
    _build_resources,
    _dump_sha256_for_replay,
    _merge_env_entries,
    _normalize_run_token,
    _offset_for_time_lookup,
    _pacing_delay_seconds,
    _redact_dsn_credentials,
    _restore_ta_configuration,
    _replay_dump,
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
                    'migrations_command': 'uv run --frozen alembic upgrade head',
                }
            },
            simulation_db='torghut_sim_test',
        )
        self.assertEqual(config.simulation_db, 'torghut_sim_test')
        self.assertEqual(
            config.simulation_dsn,
            'postgresql://torghut:secret@localhost:5432/torghut_sim_test',
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

    def test_offset_for_time_lookup_falls_back_for_missing_or_invalid_offset(self) -> None:
        class _OffsetMeta:
            def __init__(self, offset: object) -> None:
                self.offset = offset

        self.assertEqual(_offset_for_time_lookup(metadata=None, fallback=17), 17)
        self.assertEqual(_offset_for_time_lookup(metadata=_OffsetMeta(-1), fallback=17), 17)
        self.assertEqual(_offset_for_time_lookup(metadata=_OffsetMeta('bad'), fallback=17), 17)
        self.assertEqual(_offset_for_time_lookup(metadata=_OffsetMeta(9), fallback=17), 9)

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
