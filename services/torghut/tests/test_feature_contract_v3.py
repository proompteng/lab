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

    def test_normalization_uses_midpoint_imbalance_for_price(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '0.4', 'signal': '0.2'},
                'rsi14': '50',
                'imbalance': {'bid_px': '100.0', 'ask_px': '102.0'},
            },
            seq=1,
            source='fixture',
        )

        feature_vector = normalize_feature_vector_v3(signal)
        self.assertEqual(feature_vector.values.get('price'), 101)
