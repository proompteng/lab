from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import TestCase

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import FixtureSignalSource, generate_walk_forward_folds, run_walk_forward
from app.trading.regime import classify_regime


class TestRegimeClassifier(TestCase):
    def test_regime_classifier_is_deterministic(self) -> None:
        fixture_path = Path(__file__).parent / 'fixtures' / 'walkforward_signals.json'
        source = FixtureSignalSource.from_path(fixture_path)
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        end = datetime(2026, 1, 1, 0, 4, tzinfo=timezone.utc)
        folds = generate_walk_forward_folds(
            start,
            end,
            train_window=timedelta(minutes=1),
            test_window=timedelta(minutes=2),
            step=timedelta(minutes=2),
        )

        strategy = Strategy(
            name='wf-regime',
            description=None,
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=['AAPL'],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )

        results = run_walk_forward(
            folds,
            strategies=[strategy],
            signal_source=source,
            decision_engine=DecisionEngine(),
        )
        decisions = results.folds[0].decisions

        label_one = classify_regime(decisions)
        label_two = classify_regime(decisions)
        reversed_label = classify_regime(list(reversed(decisions)))

        self.assertEqual(label_one, label_two)
        self.assertEqual(label_one, reversed_label)
        self.assertEqual(label_one.label(), 'vol=high|trend=up|liq=liquid')
