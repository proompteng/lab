from __future__ import annotations

import io
import json
from contextlib import redirect_stdout
from unittest import TestCase
from unittest.mock import patch

from scripts.run_simulation_analysis import _resources_from_args, main


class TestRunSimulationAnalysis(TestCase):
    def test_runtime_ready_resources_include_run_scoped_order_updates_topic(self) -> None:
        class _Args:
            run_id = 'sim-2026-03-06-open-30m-r3'
            dataset_id = 'torghut-smoke-open-30m-20260306'
            namespace = 'torghut'
            ta_configmap = 'torghut-ta-sim-config'
            ta_deployment = 'torghut-ta-sim'
            torghut_service = 'torghut-sim'
            forecast_service = 'torghut-forecast-sim'
            signal_table = 'torghut_sim_2026_03_06_open_30m.ta_signals'
            price_table = 'torghut_sim_2026_03_06_open_30m.ta_microbars'

        resources = _resources_from_args(_Args())
        self.assertEqual(
            resources.simulation_topic_by_role['order_updates'],
            'torghut.sim.trade-updates.v1.sim_2026_03_06_open_30m_r3',
        )

    def test_runtime_ready_exits_zero_with_json_payload(self) -> None:
        stdout = io.StringIO()
        with (
            patch(
                'sys.argv',
                [
                    'run_simulation_analysis.py',
                    'runtime-ready',
                    '--run-id',
                    'sim-1',
                    '--dataset-id',
                    'dataset-a',
                    '--namespace',
                    'torghut',
                    '--torghut-service',
                    'torghut-sim',
                    '--ta-deployment',
                    'torghut-ta-sim',
                    '--forecast-service',
                    'torghut-forecast-sim',
                    '--window-start',
                    '2026-03-06T14:30:00Z',
                    '--window-end',
                    '2026-03-06T15:30:00Z',
                    '--signal-table',
                    'torghut_sim_2026_03_06_open_30m.ta_signals',
                    '--price-table',
                    'torghut_sim_2026_03_06_open_30m.ta_microbars',
                    '--json',
                ],
            ),
            patch(
                'scripts.run_simulation_analysis._runtime_verify',
                return_value={'runtime_state': 'ready', 'environment_state': 'complete'},
            ),
            redirect_stdout(stdout),
        ):
            main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload['runtime_state'], 'ready')

    def test_runtime_ready_waits_until_runtime_is_ready(self) -> None:
        stdout = io.StringIO()
        with (
            patch(
                'sys.argv',
                [
                    'run_simulation_analysis.py',
                    'runtime-ready',
                    '--run-id',
                    'sim-1',
                    '--dataset-id',
                    'dataset-a',
                    '--namespace',
                    'torghut',
                    '--torghut-service',
                    'torghut-sim',
                    '--ta-deployment',
                    'torghut-ta-sim',
                    '--forecast-service',
                    'torghut-forecast-sim',
                    '--window-start',
                    '2026-03-06T14:30:00Z',
                    '--window-end',
                    '2026-03-06T15:30:00Z',
                    '--signal-table',
                    'torghut_sim_2026_03_06_open_30m.ta_signals',
                    '--price-table',
                    'torghut_sim_2026_03_06_open_30m.ta_microbars',
                    '--runtime-timeout-seconds',
                    '30',
                    '--runtime-poll-seconds',
                    '1',
                    '--json',
                ],
            ),
            patch(
                'scripts.run_simulation_analysis._runtime_verify',
                side_effect=[
                    {'runtime_state': 'not_ready', 'environment_state': 'complete'},
                    {'runtime_state': 'ready', 'environment_state': 'complete'},
                ],
            ) as verify_mock,
            patch('scripts.run_simulation_analysis.time.sleep', return_value=None) as sleep_mock,
            redirect_stdout(stdout),
        ):
            main()

        self.assertEqual(verify_mock.call_count, 2)
        sleep_mock.assert_called_once_with(1)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload['runtime_state'], 'ready')

    def test_runtime_ready_requires_signal_and_price_tables(self) -> None:
        with patch(
            'sys.argv',
            [
                'run_simulation_analysis.py',
                'runtime-ready',
                '--run-id',
                'sim-1',
                '--dataset-id',
                'dataset-a',
                '--namespace',
                'torghut',
                '--torghut-service',
                'torghut-sim',
                '--ta-deployment',
                'torghut-ta-sim',
                '--forecast-service',
                'torghut-forecast-sim',
                '--window-start',
                '2026-03-06T14:30:00Z',
                '--window-end',
                '2026-03-06T15:30:00Z',
                '--json',
            ],
        ):
            with self.assertRaises(SystemExit) as ctx:
                main()

        self.assertEqual(ctx.exception.code, 2)

    def test_activity_exits_nonzero_when_report_is_degraded(self) -> None:
        stdout = io.StringIO()
        with (
            patch(
                'sys.argv',
                [
                    'run_simulation_analysis.py',
                    'activity',
                    '--run-id',
                    'sim-1',
                    '--dataset-id',
                    'dataset-a',
                    '--namespace',
                    'torghut',
                    '--torghut-service',
                    'torghut-sim',
                    '--ta-deployment',
                    'torghut-ta-sim',
                    '--forecast-service',
                    'torghut-forecast-sim',
                    '--window-start',
                    '2026-03-06T14:30:00Z',
                    '--window-end',
                    '2026-03-06T15:30:00Z',
                    '--signal-table',
                    'torghut_sim_sim_1.ta_signals',
                    '--price-table',
                    'torghut_sim_sim_1.ta_microbars',
                    '--postgres-base-dsn',
                    'postgresql://torghut:secret@localhost:5432/postgres',
                    '--postgres-database',
                    'torghut_sim_sim_1',
                    '--clickhouse-http-url',
                    'http://clickhouse:8123',
                    '--clickhouse-username',
                    'torghut',
                    '--json',
                ],
            ),
            patch(
                'scripts.run_simulation_analysis._runtime_verify',
                return_value={'runtime_state': 'ready', 'environment_state': 'complete'},
            ),
            patch(
                'scripts.run_simulation_analysis._monitor_run_completion',
                return_value={'status': 'degraded', 'activity_classification': 'executions_absent'},
            ),
            redirect_stdout(stdout),
        ):
            with self.assertRaises(SystemExit) as ctx:
                main()

        self.assertEqual(ctx.exception.code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload['activity_classification'], 'executions_absent')
