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

    def test_normalization_prefers_executable_price_over_nested_vwap(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '0.4', 'signal': '0.2'},
                'rsi14': '50',
                'vwap': {'session': '100.0', 'w5m': '100.5'},
                'imbalance': {'bid_px': '101.0', 'ask_px': '103.0'},
            },
            seq=2,
            source='fixture',
        )

        feature_vector = normalize_feature_vector_v3(signal)
        self.assertEqual(feature_vector.values.get('price'), Decimal('102'))
        self.assertEqual(feature_vector.values.get('vwap_session'), Decimal('100.0'))
        self.assertEqual(feature_vector.values.get('price_vs_vwap_w5m_bps'), Decimal('149.2537313432835820895522388'))

    def test_normalization_prefers_top_level_imbalance_midpoint_over_vwap_keys(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Sec',
            payload={
                'macd': '0.4',
                'macd_signal': '0.2',
                'rsi14': '50',
                'vwap_session': '109.0',
                'vwap_w5m': '108.5',
                'imbalance_bid_px': '100.0',
                'imbalance_ask_px': '102.0',
            },
            seq=2,
            source='fixture',
        )

        feature_vector = normalize_feature_vector_v3(signal)
        self.assertEqual(feature_vector.values.get('price'), Decimal('101'))
        self.assertEqual(
            feature_vector.values.get('price_vs_vwap_w5m_bps'),
            Decimal('-691.2442396313364055299539171'),
        )

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

    def test_normalization_preserves_zero_valued_top_level_market_fields(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            symbol='AAPL',
            timeframe='1Min',
            payload={
                'macd': {'macd': '0.4', 'signal': '0.2', 'hist': '0'},
                'rsi14': '0',
                'price': '100',
                'spread': '0',
                'imbalance_spread': '0',
                'imbalance_bid_px': '99',
                'imbalance_ask_px': '101',
                'imbalance_bid_sz': '0',
                'imbalance_ask_sz': '10',
                'imbalance': {
                    'spread': '0.5',
                    'bid_px': '98',
                    'ask_px': '102',
                    'bid_sz': '5',
                    'ask_sz': '5',
                },
            },
            seq=4,
            source='fixture',
        )

        fv = normalize_feature_vector_v3(signal)
        self.assertEqual(fv.values['rsi14'], Decimal('0'))
        self.assertEqual(fv.values['macd_hist'], Decimal('0'))
        self.assertEqual(fv.values['spread'], Decimal('0'))
        self.assertEqual(fv.values['spread_bps'], Decimal('0'))
        self.assertEqual(fv.values['imbalance_spread'], Decimal('0'))
        self.assertEqual(fv.values['imbalance_bid_sz'], Decimal('0'))
        self.assertEqual(fv.values['imbalance_ask_sz'], Decimal('10'))
        self.assertEqual(fv.values['imbalance_pressure'], Decimal('-1'))

    def test_normalization_maps_session_context_and_derived_vwap_fields(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 15, 5, tzinfo=timezone.utc),
            symbol='META',
            timeframe='1Sec',
            payload={
                'macd': {'macd': '0.6', 'signal': '0.3'},
                'rsi14': '61',
                'price': '101.2',
                'vwap_session': '100.8',
                'vwap_w5m': '101.0',
                'imbalance_bid_sz': '5100',
                'imbalance_ask_sz': '4300',
                'prev_session_close_price': '99.4',
                'session_open_price': '100.0',
                'session_high_price': '101.2',
                'session_low_price': '99.8',
                'opening_range_high': '100.6',
                'opening_range_low': '99.9',
                'opening_window_close_price': '100.9',
                'opening_range_width_bps': '70',
                'session_range_bps': '140',
                'price_vs_session_open_bps': '120',
                'price_vs_prev_session_close_bps': '181.0865191146881287726358149',
                'opening_window_return_bps': '90',
                'opening_window_return_from_prev_close_bps': '150.9054325955734406438631791',
                'price_vs_opening_range_high_bps': '59.64',
                'price_vs_opening_window_close_bps': '29.73',
                'price_position_in_session_range': '1.0',
                'recent_spread_bps_avg': '0.75',
                'recent_spread_bps_max': '1.20',
                'recent_imbalance_pressure_avg': '0.06',
                'recent_quote_invalid_ratio': '0.04',
                'recent_quote_jump_bps_avg': '12.5',
                'recent_quote_jump_bps_max': '18.2',
                'recent_microprice_bias_bps_avg': '0.85',
                'cross_section_prev_session_close_rank': '0.91',
                'cross_section_positive_session_open_ratio': '0.58',
                'cross_section_positive_prev_session_close_ratio': '0.75',
                'cross_section_positive_opening_window_return_ratio': '0.66',
                'cross_section_positive_opening_window_return_from_prev_close_ratio': '0.83',
                'cross_section_above_vwap_w5m_ratio': '0.50',
                'cross_section_positive_recent_imbalance_ratio': '0.75',
                'cross_section_continuation_breadth': '0.6225',
                'cross_section_opening_window_return_rank': '0.83',
                'cross_section_opening_window_return_from_prev_close_rank': '0.87',
                'session_minutes_elapsed': 95,
            },
            seq=11,
            source='fixture',
        )

        fv = normalize_feature_vector_v3(signal)
        self.assertEqual(fv.values['imbalance_pressure'], Decimal('0.08510638297872340425531914894'))
        self.assertEqual(fv.values['vwap_w5m_vs_session_bps'], Decimal('19.84126984126984126984126984'))
        self.assertEqual(fv.values['price_vs_vwap_w5m_bps'], Decimal('19.80198019801980198019801980'))
        self.assertEqual(fv.values['session_open_price'], Decimal('100.0'))
        self.assertEqual(fv.values['prev_session_close_price'], Decimal('99.4'))
        self.assertEqual(fv.values['opening_range_high'], Decimal('100.6'))
        self.assertEqual(fv.values['opening_window_close_price'], Decimal('100.9'))
        self.assertEqual(fv.values['price_vs_session_open_bps'], Decimal('120'))
        self.assertEqual(
            fv.values['price_vs_prev_session_close_bps'],
            Decimal('181.0865191146881287726358149'),
        )
        self.assertEqual(fv.values['opening_window_return_bps'], Decimal('90'))
        self.assertEqual(
            fv.values['opening_window_return_from_prev_close_bps'],
            Decimal('150.9054325955734406438631791'),
        )
        self.assertEqual(fv.values['price_vs_opening_window_close_bps'], Decimal('29.73'))
        self.assertEqual(fv.values['recent_spread_bps_avg'], Decimal('0.75'))
        self.assertEqual(fv.values['recent_quote_invalid_ratio'], Decimal('0.04'))
        self.assertEqual(fv.values['recent_quote_jump_bps_max'], Decimal('18.2'))
        self.assertEqual(fv.values['recent_microprice_bias_bps_avg'], Decimal('0.85'))
        self.assertEqual(fv.values['cross_section_prev_session_close_rank'], Decimal('0.91'))
        self.assertEqual(fv.values['cross_section_positive_session_open_ratio'], Decimal('0.58'))
        self.assertEqual(fv.values['cross_section_positive_prev_session_close_ratio'], Decimal('0.75'))
        self.assertEqual(fv.values['cross_section_positive_opening_window_return_ratio'], Decimal('0.66'))
        self.assertEqual(
            fv.values['cross_section_positive_opening_window_return_from_prev_close_ratio'],
            Decimal('0.83'),
        )
        self.assertEqual(fv.values['cross_section_above_vwap_w5m_ratio'], Decimal('0.50'))
        self.assertEqual(fv.values['cross_section_positive_recent_imbalance_ratio'], Decimal('0.75'))
        self.assertEqual(fv.values['cross_section_continuation_breadth'], Decimal('0.6225'))
        self.assertEqual(fv.values['cross_section_opening_window_return_rank'], Decimal('0.83'))
        self.assertEqual(
            fv.values['cross_section_opening_window_return_from_prev_close_rank'],
            Decimal('0.87'),
        )
        self.assertEqual(fv.values['session_minutes_elapsed'], 95)

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
