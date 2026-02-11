from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from app.trading.features import FeatureNormalizationError, normalize_feature_vector_v3
from app.trading.models import SignalEnvelope


class TestFeatureContractV3(TestCase):
    def test_normalization_produces_stable_hash_for_same_input(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '1.2', 'signal': '0.8'},
                'rsi14': '22',
                'price': '100.5',
            },
            seq=10,
            source='fixture',
        )

        first = normalize_feature_vector_v3(signal)
        second = normalize_feature_vector_v3(signal)

        self.assertEqual(first.normalization_hash, second.normalization_hash)
        self.assertEqual(first.feature_schema_version, '3.0.0')

    def test_normalization_fails_closed_when_required_fields_missing(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={'rsi14': '20', 'price': '100'},
        )

        with self.assertRaises(FeatureNormalizationError):
            normalize_feature_vector_v3(signal)
