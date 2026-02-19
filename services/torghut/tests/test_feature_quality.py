from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest import TestCase

from app.trading.feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from app.trading.models import SignalEnvelope


def _signal(
    *,
    ts: datetime,
    symbol: str = 'AAPL',
    seq: int = 1,
    ingest_lag_ms: int = 200,
    schema: str | None = '3.0.0',
    payload_overrides: dict[str, object] | None = None,
) -> SignalEnvelope:
    payload: dict[str, object] = {
        'macd': {'macd': '1', 'signal': '0.4'},
        'rsi14': '48',
        'price': '100',
    }
    if schema is not None:
        payload['feature_schema_version'] = schema
    if payload_overrides:
        payload.update(payload_overrides)
    return SignalEnvelope(
        event_ts=ts,
        ingest_ts=ts + timedelta(milliseconds=ingest_lag_ms),
        symbol=symbol,
        timeframe='1Min',
        seq=seq,
        payload=payload,
    )


class TestFeatureQuality(TestCase):
    def test_batch_fails_closed_on_schema_mismatch(self) -> None:
        signals = [
            _signal(ts=datetime(2026, 1, 1, tzinfo=timezone.utc), seq=1, schema='4.0.0'),
            _signal(ts=datetime(2026, 1, 1, 0, 0, 1, tzinfo=timezone.utc), seq=2),
        ]

        report = evaluate_feature_batch_quality(signals)

        self.assertFalse(report.accepted)
        self.assertEqual(report.schema_mismatch_total, 1)
        self.assertIn('schema_mismatch', report.reasons)

    def test_batch_fails_closed_on_duplicates_and_staleness(self) -> None:
        ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        signals = [
            _signal(ts=ts, seq=1, ingest_lag_ms=1_000),
            _signal(ts=ts, seq=1, ingest_lag_ms=210_000),
        ]

        report = evaluate_feature_batch_quality(
            signals,
            thresholds=FeatureQualityThresholds(
                max_required_null_rate=0.01,
                max_duplicate_ratio=0.10,
                max_staleness_ms=2_000,
            ),
        )

        self.assertFalse(report.accepted)
        self.assertGreater(report.duplicate_ratio, 0)
        self.assertGreater(report.staleness_ms_p95, 2_000)
        self.assertIn('duplicate_ratio_exceeds_threshold', report.reasons)
        self.assertIn('feature_staleness_exceeds_budget', report.reasons)

    def test_batch_fails_closed_on_required_field_null_rate(self) -> None:
        ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        signals = [
            _signal(ts=ts, seq=1),
            _signal(
                ts=ts + timedelta(seconds=1),
                seq=2,
                payload_overrides={'macd': {'macd': None, 'signal': None}},
            ),
        ]

        report = evaluate_feature_batch_quality(
            signals,
            thresholds=FeatureQualityThresholds(max_required_null_rate=0.0),
        )

        self.assertFalse(report.accepted)
        self.assertGreater(report.null_rate_by_field['macd'], 0)
        self.assertIn('required_feature_null_rate_exceeds_threshold', report.reasons)

    def test_batch_fails_on_non_monotonic_progression(self) -> None:
        ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        signals = [
            _signal(ts=ts + timedelta(seconds=1), symbol='MSFT', seq=2),
            _signal(ts=ts, symbol='AAPL', seq=1),
        ]

        report = evaluate_feature_batch_quality(signals)

        self.assertFalse(report.accepted)
        self.assertIn('non_monotonic_progression', report.reasons)
