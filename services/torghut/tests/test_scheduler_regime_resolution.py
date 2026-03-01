from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.scheduler import (
    _resolve_decision_regime_label,
    _resolve_decision_regime_label_with_source,
    _resolve_signal_regime,
)


class TestSchedulerRegimeResolution(TestCase):
    def test_allocator_regime_label_is_preferred_when_present(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime_label': 'legacy-regime',
                'allocator': {'regime_label': 'Vol=High|Trend=Flat|Liq=Liquid'},
            },
        )

        regime_label = _resolve_decision_regime_label(decision)

        self.assertEqual(regime_label, 'vol=high|trend=flat|liq=liquid')

    def test_regime_resolution_falls_back_to_legacy_fields(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={'regime': {'label': 'Vol=Mid|Trend=Up|Liq=Liquid'}},
        )

        regime_label = _resolve_decision_regime_label(decision)

        self.assertEqual(regime_label, 'vol=mid|trend=up|liq=liquid')

    def test_regime_resolution_prefers_nested_legacy_label_when_hmm_unknown(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime': {'label': 'Vol=High|Trend=Flat|Liq=Liquid'},
                'regime_hmm': {
                    'regime_id': 'not-a-regime-id',
                    'artifact': {'model_id': 'hmm-regime-v1.2.0'},
                    'guardrail': {'reason': 'unknown_model'},
                },
            },
        )

        source_regime_label = _resolve_decision_regime_label_with_source(decision)

        self.assertEqual(
            source_regime_label,
            ('vol=high|trend=flat|liq=liquid', 'legacy', 'hmm_unknown'),
        )

    def test_regime_resolution_prefers_hmm_when_allocator_missing(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime': {'label': 'Vol=Mid|Trend=Up|Liq=Liquid'},
                'regime_hmm': {
                    'regime_id': 'R2',
                    'artifact': {'model_id': 'hmm-regime-v1.2.0'},
                    'guardrail': {'reason': 'stable'},
                },
            },
        )

        source_regime_label = _resolve_decision_regime_label_with_source(decision)

        self.assertEqual(source_regime_label, ('r2', 'hmm', None))

    def test_regime_resolution_falls_back_to_legacy_when_hmm_regime_stale(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime': {'label': 'Vol=Mid|Trend=Up|Liq=Liquid'},
                'regime_hmm': {
                    'regime_id': 'R2',
                    'artifact': {'model_id': 'hmm-regime-v1.2.0'},
                    'guardrail': {'stale': True, 'reason': 'aging_output'},
                },
            },
        )

        source_regime_label = _resolve_decision_regime_label_with_source(decision)

        self.assertEqual(
            source_regime_label,
            ('vol=mid|trend=up|liq=liquid', 'legacy', 'stale'),
        )

    def test_regime_resolution_falls_back_to_legacy_when_hmm_unknown(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime_label': 'Vol=Mid|Trend=Up|Liq=Liquid',
                'regime_hmm': {
                    'regime_id': 'unknown',
                    'artifact': {'model_id': 'hmm-regime-v1.2.0'},
                    'guardrail': {'reason': 'stable'},
                },
            },
        )

        source_regime_label = _resolve_decision_regime_label_with_source(decision)

        self.assertEqual(
            source_regime_label,
            ('vol=mid|trend=up|liq=liquid', 'legacy', 'hmm_unknown'),
        )

    def test_regime_resolution_falls_back_to_legacy_when_hmm_transition_shock(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime_label': 'trend',
                'regime_hmm': {
                    'regime_id': 'R2',
                    'artifact': {'model_id': 'hmm-regime-v1.2.0'},
                    'guardrail': {'stale': False, 'fallback_to_defensive': False},
                    'transition_shock': True,
                },
            },
        )

        source_regime_label = _resolve_decision_regime_label_with_source(decision)

        self.assertEqual(
            source_regime_label,
            ('trend', 'legacy', 'transition_shock'),
        )

    def test_regime_resolution_prefers_nested_legacy_label_when_hmm_transition_shock(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime': {'label': 'Trend'},
                'regime_hmm': {
                    'regime_id': 'R2',
                    'artifact': {'model_id': 'hmm-regime-v1.2.0'},
                    'guardrail': {'stale': False, 'fallback_to_defensive': False},
                    'transition_shock': True,
                },
            },
        )

        source_regime_label = _resolve_decision_regime_label_with_source(decision)

        self.assertEqual(
            source_regime_label,
            ('trend', 'legacy', 'transition_shock'),
        )

    def test_signal_regime_resolution_falls_back_to_legacy_regime(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol='AAPL',
            payload={'regime': {'label': 'Vol=Mid|Trend=Up|Liq=Liquid'}},
        )

        regime_label = _resolve_signal_regime(signal)

        self.assertEqual(regime_label, 'vol=mid|trend=up|liq=liquid')

    def test_decision_regime_resolution_uses_legacy_when_blank_regime_label(self) -> None:
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
            params={
                'regime_label': '   ',
                'regime': {'label': 'Vol=Mid|Trend=Up|Liq=Liquid'},
            },
        )

        source_regime_label = _resolve_decision_regime_label_with_source(decision)

        self.assertEqual(
            source_regime_label,
            ('vol=mid|trend=up|liq=liquid', 'legacy', None),
        )
