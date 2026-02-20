from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from scripts.verify_quant_readiness import (
    _evaluate_acceptance_window,
    _load_gate_trace,
)


class TestVerifyQuantReadiness(TestCase):
    def test_load_gate_trace_reads_required_trace_ids(self) -> None:
        payload = {
            'provenance': {
                'gate_report_trace_id': 'abc123',
                'recommendation_trace_id': 'def456',
            }
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'gate.json'
            path.write_text(json.dumps(payload), encoding='utf-8')
            trace = _load_gate_trace(path)
        self.assertEqual(trace['gate_report_trace_id'], 'abc123')
        self.assertEqual(trace['recommendation_trace_id'], 'def456')

    def test_load_gate_trace_raises_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'gate.json'
            path.write_text(json.dumps({'provenance': {'gate_report_trace_id': 'abc123'}}), encoding='utf-8')
            with self.assertRaises(ValueError):
                _load_gate_trace(path)

    def test_acceptance_window_passes_when_thresholds_met(self) -> None:
        result = _evaluate_acceptance_window(
            non_skipped_runs=3,
            trade_decisions=18,
            executions=7,
            full_chain_runs=2,
            route_total=10,
            missing_route_rows=0,
            min_non_skipped_runs=1,
            min_trade_decisions=1,
            min_executions=1,
            min_full_chain_runs=1,
            min_route_coverage_ratio=0.95,
        )
        self.assertTrue(result['passed'])
        lookback = result['lookback']
        self.assertEqual(lookback['route_coverage_ratio'], 1.0)

    def test_acceptance_window_fails_when_route_coverage_too_low(self) -> None:
        result = _evaluate_acceptance_window(
            non_skipped_runs=2,
            trade_decisions=4,
            executions=4,
            full_chain_runs=1,
            route_total=4,
            missing_route_rows=1,
            min_non_skipped_runs=1,
            min_trade_decisions=1,
            min_executions=1,
            min_full_chain_runs=1,
            min_route_coverage_ratio=0.9,
        )
        self.assertFalse(result['passed'])
        lookback = result['lookback']
        self.assertEqual(lookback['route_coverage_ratio'], 0.75)
