from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import FixtureSignalSource, generate_walk_forward_folds, run_walk_forward
from app.trading.reporting import EvaluationReportConfig, generate_evaluation_report


class TestRobustnessReport(TestCase):
    def test_fold_stability_and_multiple_testing(self) -> None:
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
            name='wf-robustness',
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

        config = EvaluationReportConfig(
            evaluation_start=start,
            evaluation_end=end,
            signal_source='fixture',
            strategies=[strategy],
            variant_count=25,
            variant_warning_threshold=10,
        )
        report = generate_evaluation_report(results, config=config)

        self.assertEqual(report.robustness.method, 'fold_stability')
        self.assertEqual(report.robustness.fold_count, 1)
        self.assertEqual(report.robustness.net_pnl_mean, Decimal('1'))
        self.assertEqual(report.robustness.net_pnl_std, Decimal('0'))
        self.assertEqual(report.robustness.net_pnl_cv, Decimal('0'))
        self.assertEqual(report.robustness.worst_fold_net_pnl, Decimal('1'))
        self.assertEqual(report.robustness.best_fold_net_pnl, Decimal('1'))
        self.assertEqual(report.robustness.negative_fold_count, 0)
        self.assertEqual(report.robustness.folds[0].net_pnl, Decimal('1'))

        self.assertTrue(report.multiple_testing.warning_triggered)
        self.assertIn('variant_count_exceeds_threshold', report.multiple_testing.warnings)
