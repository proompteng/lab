from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from scripts.analyze_historical_simulation import (
    _extract_run_scope_decisions,
    _fifo_trade_pnl,
)


class TestAnalyzeHistoricalSimulation(TestCase):
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
