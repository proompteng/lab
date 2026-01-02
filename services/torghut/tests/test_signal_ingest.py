from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from app.trading.ingest import ClickHouseSignalIngestor


class TestSignalIngest(TestCase):
    def test_parse_envelope_row(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="envelope")
        row = {
            "event_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "ingest_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "symbol": "AAPL",
            "payload": {"macd": {"macd": 0.5, "signal": 0.2}, "rsi14": 22},
            "window": {"size": "PT1M"},
            "seq": 10,
            "source": "ta",
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.symbol, "AAPL")
        self.assertEqual(signal.payload.get("rsi14"), 22)
        self.assertEqual(signal.timeframe, "1Min")

    def test_parse_flat_row(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="flat")
        row = {
            "ts": "2026-01-01T00:00:01Z",
            "symbol": "MSFT",
            "macd": 0.8,
            "signal": 0.4,
            "rsi": 55.0,
            "signal_json": '{"vwap": 350.1}',
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.symbol, "MSFT")
        self.assertIn("macd", signal.payload)
        self.assertEqual(signal.payload.get("rsi"), 55.0)
        self.assertEqual(signal.payload.get("vwap"), 350.1)
