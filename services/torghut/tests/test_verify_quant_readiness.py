from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from scripts.verify_quant_readiness import _load_gate_trace


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
