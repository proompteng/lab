from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.models import StrategyDecision
from app.trading.scheduler import _resolve_decision_regime_label


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
