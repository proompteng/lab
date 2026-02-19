from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase

from app.trading.models import SignalEnvelope
from app.trading.parity import run_feature_parity, write_feature_parity_report


class TestFeatureParity(TestCase):
    def _signal(self, *, price: str, symbol: str = 'AAPL') -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol=symbol,
            timeframe='1Min',
            seq=1,
            source='fixture',
            payload={
                'feature_schema_version': '3.0.0',
                'macd': {'macd': '1.2', 'signal': '0.8'},
                'rsi14': '25',
                'price': price,
            },
        )

    def test_parity_report_detects_drift_and_is_machine_readable(self) -> None:
        online = [self._signal(price='100.00')]
        offline = [self._signal(price='101.00')]

        report = run_feature_parity(online, offline)

        self.assertFalse(report.accepted)
        self.assertIn('numeric_drift_exceeds_threshold', report.reasons)
        self.assertTrue(report.top_drift_fields)
        self.assertEqual(report.top_drift_fields[0]['field'], 'price')
        self.assertEqual(len(report.failing_windows), 1)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = write_feature_parity_report(report, Path(tmpdir) / 'parity.json')
            payload = json.loads(output_path.read_text(encoding='utf-8'))
            self.assertEqual(payload['accepted'], report.accepted)
            self.assertEqual(payload['checked_rows'], 1)
            self.assertEqual(payload['top_drift_fields'][0]['field'], 'price')
