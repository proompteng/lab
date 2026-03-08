from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from scripts.import_hypothesis_runtime_windows import (
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    _load_report_post_cost_expectancy_bps,
    _query_timestamps,
)


class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [(datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),)],
            [(datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),)],
            [
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    Decimal('1.25'),
                    Decimal('0.50'),
                )
            ],
        ]

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._results.pop(0)


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor


class TestImportHypothesisRuntimeWindows(TestCase):
    def test_load_report_post_cost_expectancy_bps_uses_simulation_report(self) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / 'simulation-report.json'
            report_path.write_text(
                '{"pnl":{"net_pnl_estimated":"66.16","execution_notional_total":"200061.4"}}',
                encoding='utf-8',
            )

            value = _load_report_post_cost_expectancy_bps([str(report_path)])

        self.assertEqual(value, Decimal('3.306984755680006238084907933'))

    def test_query_timestamps_filters_to_execution_eligible_decisions(self) -> None:
        cursor = _FakeCursor()
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch('scripts.import_hypothesis_runtime_windows.psycopg.connect', return_value=connection):
            decisions, executions, tca_rows = _query_timestamps(
                dsn='postgresql://example',
                strategy_name='intraday-tsmom-profit-v2',
                account_label='TORGHUT_SIM',
                window_start=window_start,
                window_end=window_end,
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(executions, [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)])
        self.assertEqual(len(tca_rows), 1)
        self.assertEqual(tca_rows[0]['abs_slippage_bps'], Decimal('1.25'))
        self.assertEqual(tca_rows[0]['post_cost_expectancy_bps'], Decimal('0.50'))
        self.assertEqual(len(cursor.executed), 3)
        decision_query, decision_params = cursor.executed[0]
        self.assertIn('d.status = any(%s)', decision_query)
        self.assertEqual(
            decision_params[2],
            list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
        )
        tca_query, _ = cursor.executed[2]
        execution_query, _ = cursor.executed[1]
        self.assertIn('select d.created_at', execution_query)
        self.assertIn('d.created_at >= %s', execution_query)
        self.assertIn('d.created_at < %s', execution_query)
        self.assertNotIn('e.created_at >= %s', execution_query)
        self.assertIn('select\n                    d.created_at', tca_query)
        self.assertIn('d.created_at >= %s', tca_query)
        self.assertIn('d.created_at < %s', tca_query)
        self.assertNotIn('e.created_at >= %s', tca_query)
        self.assertNotIn('t.computed_at >= %s', tca_query)
