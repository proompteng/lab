from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest import TestCase
from uuid import uuid4

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import (
    FixtureSignalSource,
    WalkForwardDecision,
    generate_walk_forward_folds,
    run_walk_forward,
)
from app.trading.features import SignalFeatures
from app.trading.models import StrategyDecision
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

    def test_regime_classifier_bucket_boundaries(self) -> None:
        low_regime = classify_regime(
            [
                self._decision(
                    0,
                    price=Decimal('100'),
                    volatility=Decimal('0.009'),
                    macd=Decimal('0.01'),
                    macd_signal=Decimal('0.01'),
                ),
                self._decision(
                    1,
                    price=Decimal('100.1'),
                    volatility=Decimal('0.009'),
                    macd=Decimal('0.01'),
                    macd_signal=Decimal('0.01'),
                ),
            ]
        )
        self.assertEqual(low_regime.label(), 'vol=low|trend=flat|liq=liquid')

        mid_regime = classify_regime(
            [
                self._decision(
                    0,
                    price=Decimal('100'),
                    volatility=Decimal('0.02'),
                    macd=Decimal('0.1'),
                    macd_signal=Decimal('0.01'),
                ),
                self._decision(
                    1,
                    price=Decimal('101'),
                    volatility=Decimal('0.02'),
                    macd=Decimal('0.1'),
                    macd_signal=Decimal('0.01'),
                ),
            ]
        )
        self.assertEqual(mid_regime.label(), 'vol=mid|trend=up|liq=liquid')

        high_illiquid_regime = classify_regime(
            [
                self._decision(
                    0,
                    price=Decimal('100'),
                    volatility=Decimal('0.04'),
                    macd=Decimal('-0.2'),
                    macd_signal=Decimal('0.01'),
                ),
                self._decision(
                    1,
                    price=Decimal('89'),
                    volatility=Decimal('0.04'),
                    macd=Decimal('-0.2'),
                    macd_signal=Decimal('0.01'),
                ),
            ]
        )
        self.assertEqual(high_illiquid_regime.label(), 'vol=high|trend=down|liq=illiquid')

    def test_regime_classifier_deterministic_with_equal_sort_keys(self) -> None:
        event_ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        first = self._decision(
            0,
            event_ts=event_ts,
            strategy_id='stable-order',
            symbol='AAPL',
            price=Decimal('100'),
            volatility=Decimal('0.01'),
            macd=Decimal('0.1'),
            macd_signal=Decimal('0.02'),
        )
        second = self._decision(
            1,
            event_ts=event_ts,
            strategy_id='stable-order',
            symbol='AAPL',
            price=Decimal('100'),
            volatility=Decimal('0.01'),
            macd=Decimal('0.1'),
            macd_signal=Decimal('0.02'),
        )
        third = self._decision(
            2,
            event_ts=event_ts,
            strategy_id='stable-order',
            symbol='AAPL',
            price=None,
            volatility=Decimal('0.01'),
            macd=Decimal('0.1'),
            macd_signal=Decimal('0.02'),
        )

        one = classify_regime([first, second, third])
        two = classify_regime([third, first, second])
        three = classify_regime([second, third, first])

        self.assertEqual(one.label(), 'vol=mid|trend=flat|liq=liquid')
        self.assertEqual(one, two)
        self.assertEqual(two, three)

    @staticmethod
    def _decision(
        minute_offset: int,
        *,
        price: Decimal | None,
        volatility: Decimal | None,
        macd: Decimal | None,
        macd_signal: Decimal | None,
        strategy_id: str | None = None,
        symbol: str = 'AAPL',
        event_ts: datetime | None = None,
    ) -> WalkForwardDecision:
        resolved_ts = event_ts or datetime(2026, 1, 1, 0, minute_offset, tzinfo=timezone.utc)
        decision = StrategyDecision(
            strategy_id=strategy_id or str(uuid4()),
            symbol=symbol,
            event_ts=resolved_ts,
            timeframe='1Min',
            action='buy',
            qty=Decimal('1'),
        )
        features = SignalFeatures(
            macd=macd,
            macd_signal=macd_signal,
            rsi=Decimal('50'),
            price=price,
            volatility=volatility,
        )
        return WalkForwardDecision(decision=decision, features=features)
