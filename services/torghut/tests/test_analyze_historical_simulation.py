from __future__ import annotations

from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from scripts.analyze_historical_simulation import (
    _build_last_price_map,
    _extract_run_scope_decisions,
    _fifo_trade_pnl,
)
from scripts.start_historical_simulation import ClickHouseRuntimeConfig


class TestAnalyzeHistoricalSimulation(TestCase):
    def test_build_last_price_map_uses_lane_specific_price_table(self) -> None:
        captured_queries: list[str] = []

        def _fake_clickhouse_query(*, config, query):  # type: ignore[no-untyped-def]
            _ = config
            captured_queries.append(query)
            return 200, 'AAPL250321C00200000\t1.55\n'

        with patch(
            'scripts.analyze_historical_simulation._http_clickhouse_query',
            side_effect=_fake_clickhouse_query,
        ):
            prices = _build_last_price_map(
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url='http://clickhouse:8123',
                    username=None,
                    password=None,
                ),
                price_table='torghut_sim_options.sim_options_contract_bars_1s',
                tca_rows=[],
                execution_rows=[],
            )

        self.assertEqual(prices['AAPL250321C00200000'], Decimal('1.55'))
        self.assertIn(
            'FROM torghut_sim_options.sim_options_contract_bars_1s',
            captured_queries[0],
        )

    def test_extract_run_scope_decisions_prefers_matching_simulation_context(self) -> None:
        decisions = [
            {
                'id': 'd1',
                'decision_json': {
                    'params': {
                        'simulation_context': {
                            'simulation_run_id': 'run-a',
                        }
                    }
                },
            },
            {
                'id': 'd2',
                'decision_json': {
                    'params': {
                        'simulation_context': {
                            'simulation_run_id': 'run-b',
                        }
                    }
                },
            },
        ]

        scoped = _extract_run_scope_decisions(decisions, run_id='run-b')
        self.assertEqual(len(scoped), 1)
        self.assertEqual(scoped[0]['id'], 'd2')

    def test_fifo_trade_pnl_computes_realized_and_unrealized(self) -> None:
        executions = [
            {
                'id': 'e1',
                'trade_decision_id': 'd1',
                'symbol': 'AAPL',
                'side': 'buy',
                'filled_qty': Decimal('2'),
                'avg_fill_price': Decimal('10'),
                'created_at': '2026-02-27T20:00:00Z',
            },
            {
                'id': 'e2',
                'trade_decision_id': 'd2',
                'symbol': 'AAPL',
                'side': 'sell',
                'filled_qty': Decimal('1'),
                'avg_fill_price': Decimal('13'),
                'created_at': '2026-02-27T20:01:00Z',
            },
        ]

        summary, rows = _fifo_trade_pnl(executions, last_prices={'AAPL': Decimal('12')})
        self.assertEqual(summary['realized_pnl'], Decimal('3'))
        self.assertEqual(summary['unrealized_pnl'], Decimal('2'))
        self.assertEqual(summary['gross_pnl'], Decimal('5'))
        self.assertEqual(len(rows), 2)
