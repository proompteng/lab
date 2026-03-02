from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
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

    def test_normalization_maps_nested_schema_fields(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 1, 1, 0, 0, 2, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'feature_schema_version': '3.1.0',
                'macd': {'macd': '0.4', 'signal': '0.2', 'hist': '0.2'},
                'ema': {'ema12': '101.1', 'ema26': '100.6'},
                'rsi14': '55',
                'vwap': {'session': '100.8', 'w5m': '100.9'},
                'boll': {'mid': '100', 'upper': '101', 'lower': '99'},
                'vol_realized': {'w60s': '0.009'},
                'imbalance': {'spread': '0.03', 'bid_px': '100.7', 'ask_px': '100.9'},
            },
            seq=3,
            source='fixture',
        )

        fv = normalize_feature_vector_v3(signal)
        self.assertEqual(fv.values['ema12'], Decimal('101.1'))
        self.assertEqual(fv.values['ema26'], Decimal('100.6'))
        self.assertEqual(fv.values['vwap_session'], Decimal('100.8'))
        self.assertEqual(fv.values['vwap_w5m'], Decimal('100.9'))
        self.assertEqual(fv.values['boll_mid'], Decimal('100'))
        self.assertEqual(fv.values['vol_realized_w60s'], Decimal('0.009'))
        self.assertEqual(fv.values['imbalance_spread'], Decimal('0.03'))
        self.assertEqual(fv.values['staleness_ms'], 2000)

    def test_normalization_persists_hmm_transition_shock_and_artifact_lineage(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'hmm_regime_id': 'R2',
                'hmm_transition_shock': True,
                'hmm_entropy': '1.23',
                'hmm_entropy_band': 'medium',
                'hmm_predicted_next': 'R3',
                'hmm_guardrail': {'stale': False, 'fallback_to_defensive': False},
                'hmm_artifact': {
                    'model_id': 'hmm-regime-v1.2.0',
                    'feature_schema': 'hmm-v1-feature-schema',
                    'training_run_id': 'trn_2026-02-28',
                },
                'macd': {'macd': '0.4', 'signal': '0.2'},
                'rsi14': '55',
                'price': '100',
            },
            seq=1,
            source='fixture',
        )

        feature_vector = normalize_feature_vector_v3(signal)
        self.assertTrue(feature_vector.values['hmm_transition_shock'])
        self.assertEqual(feature_vector.values['hmm_artifact_model_id'], 'hmm-regime-v1.2.0')
        self.assertEqual(feature_vector.values['hmm_artifact_feature_schema'], 'hmm-v1-feature-schema')
        self.assertEqual(feature_vector.values['hmm_artifact_training_run_id'], 'trn_2026-02-28')

    def test_normalization_rejects_incompatible_schema_major(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'feature_schema_version': '4.0.0',
                'macd': {'macd': '0.4', 'signal': '0.2'},
                'rsi14': '50',
                'price': '100',
            },
        )

        with self.assertRaises(FeatureNormalizationError):
            normalize_feature_vector_v3(signal)

    def test_normalization_lowercases_explicit_route_regime_label(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '0.4', 'signal': '0.2'},
                'rsi14': '50',
                'price': '100',
                'regime_label': '  TREND  ',
            },
        )

        feature_vector = normalize_feature_vector_v3(signal)
        self.assertEqual(feature_vector.values.get('route_regime_label'), 'trend')
