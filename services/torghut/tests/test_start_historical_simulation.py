from __future__ import annotations

from unittest import TestCase

from scripts.start_historical_simulation import (
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    _build_plan_report,
    _build_postgres_runtime_config,
    _build_resources,
    _merge_env_entries,
    _normalize_run_token,
    _pacing_delay_seconds,
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
