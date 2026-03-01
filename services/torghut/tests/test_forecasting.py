from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase

from app.trading.features import normalize_feature_vector_v3
from app.trading.forecasting import build_default_forecast_router
from app.trading.models import SignalEnvelope


def _signal() -> SignalEnvelope:
    return SignalEnvelope(
        event_ts=datetime(2026, 2, 21, 14, 35, tzinfo=timezone.utc),
        symbol='AAPL',
        timeframe='1Min',
        payload={
            'macd': {'macd': '0.6', 'signal': '0.1'},
            'rsi14': '52',
            'price': '194.32',
            'vol_realized_w60s': '0.008',
            'spread': '0.02',
            'signal_quality_flag': 'high',
        },
    )


class TestForecastRouterV5(TestCase):
    def test_router_emits_forecast_contract_v1_with_uncertainty_and_interval(self) -> None:
        router = build_default_forecast_router(policy_path=None, refinement_enabled=True)
        signal = _signal()
        features = normalize_feature_vector_v3(signal)

        result = router.route_and_forecast(
            feature_vector=features, horizon='1Min', event_ts=signal.event_ts
        )
        payload = result.contract.to_payload()

        self.assertEqual(payload['schema_version'], 'forecast_contract_v1')
        self.assertEqual(payload['symbol'], 'AAPL')
        self.assertIn('interval', payload)
        self.assertIn('uncertainty', payload)
        interval = payload['interval']
        uncertainty = payload['uncertainty']
        assert isinstance(interval, dict)
        assert isinstance(uncertainty, dict)
        self.assertIn('p05', interval)
        self.assertIn('p50', interval)
        self.assertIn('p95', interval)
        self.assertIn('epistemic', uncertainty)
        self.assertIn('aleatoric', uncertainty)

    def test_router_falls_back_when_calibration_below_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': '*',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.95',
                                'max_inference_latency_ms': 200,
                                'disable_refinement': True,
                            }
                        ],
                        'default_calibration_score_by_model_family': {
                            'chronos': '0.50',
                            'baseline': '0.99',
                        },
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )
        self.assertEqual(result.contract.model_family, 'baseline')
        self.assertTrue(result.contract.fallback.applied)
        self.assertEqual(result.contract.fallback.reason, 'calibration_below_threshold')

    def test_router_falls_back_when_latency_budget_breached(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': '*',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 20,
                                'disable_refinement': True,
                            }
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )
        self.assertEqual(result.contract.model_family, 'baseline')
        self.assertTrue(result.contract.fallback.applied)
        self.assertEqual(result.contract.fallback.reason, 'latency_slo_breach')
        self.assertLessEqual(result.contract.inference_latency_ms, 20)

    def test_router_is_deterministic_for_same_input(self) -> None:
        router = build_default_forecast_router(policy_path=None, refinement_enabled=True)
        signal = _signal()
        fv = normalize_feature_vector_v3(signal)

        first = router.route_and_forecast(
            feature_vector=fv, horizon='1Min', event_ts=signal.event_ts
        )
        second = router.route_and_forecast(
            feature_vector=fv, horizon='1Min', event_ts=signal.event_ts
        )

        self.assertEqual(first.contract.to_payload(), second.contract.to_payload())
        self.assertEqual(first.audit.to_payload(), second.audit.to_payload())
        self.assertEqual(first.telemetry.to_payload(), second.telemetry.to_payload())

    def test_router_ignores_stale_hmm_regime_for_route_matching(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'R2',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'mean_revert',
                                'preferred_model_family': 'moment',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        signal.payload['macd']['macd'] = '-0.40'
        signal.payload['macd']['signal'] = '-0.30'
        signal.payload['hmm_regime_id'] = 'R2'
        signal.payload['hmm_guardrail'] = {
            'stale': True,
            'fallback_to_defensive': False,
            'reason': 'aging_model_output',
        }
        signal.payload['hmm_artifact'] = {
            'model_id': 'hmm-regime-v1',
            'feature_schema': 'hmm-v1',
            'training_run_id': 'trn-v1',
        }
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )

        self.assertEqual(result.contract.route_key.split('|')[-1], 'mean_revert')
        self.assertEqual(result.contract.model_family, 'moment')

    def test_router_ignores_invalid_regime_id_and_falls_back_to_explicit_label(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'trend',
                                'preferred_model_family': 'financial_tsfm',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': '*',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        signal.payload['regime_label'] = 'TREND'
        signal.payload['hmm_regime_id'] = 'not-a-regime-id'
        signal.payload['hmm_artifact'] = {
            'model_id': 'hmm-regime-v1',
            'feature_schema': 'hmm-v1',
            'training_run_id': 'trn-v1',
        }
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )

        self.assertEqual(result.contract.route_key.split('|')[-1], 'trend')
        self.assertEqual(result.contract.model_family, 'financial_tsfm')

    def test_router_uses_legacy_regime_block_for_fallback_when_hmm_regime_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'trend',
                                'preferred_model_family': 'financial_tsfm',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': '*',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        signal.payload['regime'] = {'label': 'TREND'}
        signal.payload['hmm_regime_id'] = 'not-a-regime-id'
        signal.payload['hmm_artifact'] = {
            'model_id': 'hmm-regime-v1',
            'feature_schema': 'hmm-v1',
            'training_run_id': 'trn-v1',
        }
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )

        self.assertEqual(result.contract.route_key.split('|')[-1], 'trend')
        self.assertEqual(result.contract.model_family, 'financial_tsfm')

    def test_router_normalizes_explicit_regime_label_for_route_matching(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'trend',
                                'preferred_model_family': 'financial_tsfm',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': '*',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        signal.payload['regime_label'] = 'TREND'
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )

        self.assertEqual(result.contract.route_key.split('|')[-1], 'trend')
        self.assertEqual(result.contract.model_family, 'financial_tsfm')

    def test_router_prefers_hmm_regime_id_over_explicit_regime_label(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'R2',
                                'preferred_model_family': 'financial_tsfm',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'TREND',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        signal.payload['macd']['macd'] = '1.2'
        signal.payload['hmm_regime_id'] = 'R2'
        signal.payload['regime_label'] = 'trend'
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )

        self.assertEqual(result.contract.route_key.split('|')[-1], 'r2')
        self.assertEqual(result.contract.model_family, 'financial_tsfm')

    def test_router_ignores_transition_shock_hmm_regime_for_route_matching(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'R2',
                                'preferred_model_family': 'financial_tsfm',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'mean_revert',
                                'preferred_model_family': 'moment',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': '*',
                                'preferred_model_family': 'chronos',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        signal.payload['macd']['macd'] = '0.40'
        signal.payload['macd']['signal'] = '0.55'
        signal.payload['hmm_regime_id'] = 'R2'
        signal.payload['hmm_transition_shock'] = True
        signal.payload['hmm_guardrail'] = {'stale': False, 'fallback_to_defensive': False}
        signal.payload['hmm_artifact'] = {
            'model_id': 'hmm-regime-v1',
            'feature_schema': 'hmm-v1',
            'training_run_id': 'trn-v1',
        }
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )

        self.assertEqual(result.contract.route_key.split('|')[-1], 'mean_revert')
        self.assertEqual(result.contract.model_family, 'moment')

    def test_router_prefers_normalized_route_regime_label_hint(self) -> None:
        signal = _signal()
        signal.payload['macd']['macd'] = '0.40'
        signal.payload['macd']['signal'] = '0.55'
        signal.payload['hmm_regime_id'] = 'R2'
        signal.payload['hmm_transition_shock'] = True
        signal.payload['hmm_guardrail'] = {'stale': False, 'fallback_to_defensive': False}
        signal.payload['hmm_artifact'] = {
            'model_id': 'hmm-regime-v1',
            'feature_schema': 'hmm-v1',
            'training_run_id': 'trn-v1',
        }
        feature_vector = normalize_feature_vector_v3(signal)

        self.assertNotIn('hmm_transition_shock', feature_vector.values)
        self.assertEqual(feature_vector.values.get('route_regime_label'), 'mean_revert')

    def test_router_prefers_explicit_route_regime_label_hint_when_hmm_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / 'router-policy.json'
            policy_path.write_text(
                json.dumps(
                    {
                        'routes': [
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'trend',
                                'preferred_model_family': 'financial_tsfm',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                            {
                                'symbol_glob': '*',
                                'horizon': '*',
                                'regime': 'mean_revert',
                                'preferred_model_family': 'moment',
                                'candidate_fallbacks': [],
                                'min_calibration_score': '0.80',
                                'max_inference_latency_ms': 400,
                                'disable_refinement': True,
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )
            router = build_default_forecast_router(
                policy_path=str(policy_path), refinement_enabled=False
            )

        signal = _signal()
        signal.payload['route_regime_label'] = 'TREND'
        signal.payload['hmm_regime_id'] = 'not-a-regime-id'
        signal.payload['macd']['macd'] = '0.40'
        signal.payload['macd']['signal'] = '0.55'
        result = router.route_and_forecast(
            feature_vector=normalize_feature_vector_v3(signal),
            horizon='1Min',
            event_ts=signal.event_ts,
        )

        self.assertEqual(result.contract.route_key.split('|')[-1], 'trend')
        self.assertEqual(result.contract.model_family, 'financial_tsfm')
