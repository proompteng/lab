import argparse
import io
import json
from contextlib import redirect_stdout
from unittest import TestCase
from unittest.mock import patch

from scripts import ta_replay_runner as runner


_TABLE_COVERAGE_TSV = """table_name\tdays\tfirst_day\tlast_day\trows
ta_microbars\t19\t2026-04-27\t2026-05-22\t1281193
ta_signals\t9\t2026-05-12\t2026-05-22\t632380
"""

_DAY_GAP_TSV = """trading_day\tsignal_rows\tmicrobar_rows
2026-05-22\t58446\t58446
2026-05-08\t0\t68396
2026-05-07\t0\t66008
"""


class TestTaReplayRunnerCoveragePreflight(TestCase):
    def _args(self) -> argparse.Namespace:
        return argparse.Namespace(
            namespace='torghut',
            verify=False,
            json=True,
            check_clickhouse_coverage=True,
            clickhouse_http_url='http://clickhouse.test:8123',
            clickhouse_username='torghut',
            clickhouse_password='secret',
            clickhouse_password_env='TA_CLICKHOUSE_PASSWORD',
            clickhouse_timeout_seconds=5,
            coverage_day_limit=40,
            required_trading_days=25,
        )

    def test_load_clickhouse_coverage_flags_signal_shortfall_and_microbar_only_days(
        self,
    ) -> None:
        with patch.object(
            runner,
            '_clickhouse_query',
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            coverage = runner._load_clickhouse_coverage(self._args())

        assert coverage is not None
        self.assertEqual(coverage['status'], 'insufficient_ta_signal_days')
        self.assertIn('insufficient_ta_signal_days:9<25', coverage['blockers'])
        self.assertIn('microbar_only_days:2', coverage['blockers'])
        self.assertEqual(coverage['summary']['ta_signals_days'], 9)
        self.assertEqual(coverage['summary']['ta_microbars_days'], 19)
        self.assertEqual(coverage['summary']['missing_signal_days_vs_required'], 16)
        self.assertEqual(
            coverage['summary']['microbar_only_days'],
            ['2026-05-08', '2026-05-07'],
        )

    def test_plan_json_embeds_coverage_preflight(self) -> None:
        state = runner.ReplayState(
            namespace='torghut',
            ta_group_id='torghut-ta-2025-12-23',
            ta_auto_offset_reset='latest',
            flink_job_state='running',
            flink_restart_nonce=7,
            flink_status_state='RUNNING',
        )
        plan = {
            'replay_group_id': 'torghut-ta-replay-profit-proof',
            'ta_auto_offset_reset': 'earliest',
        }
        output = io.StringIO()
        with patch.object(
            runner,
            '_clickhouse_query',
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            with redirect_stdout(output):
                exit_code = runner._handle_plan_mode(
                    args=self._args(),
                    state=state,
                    plan=plan,
                    warnings=[],
                )

        self.assertEqual(exit_code, 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(
            payload['coverage']['schema_version'],
            'torghut.ta-replay-coverage-preflight.v1',
        )
        self.assertEqual(
            payload['coverage']['summary']['missing_signal_days_vs_required'], 16
        )
