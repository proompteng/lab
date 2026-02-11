from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import FixtureSignalSource, generate_walk_forward_folds, run_walk_forward
from app.trading.reporting import EvaluationGatePolicy, EvaluationReportConfig, generate_evaluation_report


class TestEvaluationReport(TestCase):
    def test_report_generation_from_fixture(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
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
            name="wf-report",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        strategy.id = uuid.uuid4()

        results = run_walk_forward(
            folds,
            strategies=[strategy],
            signal_source=source,
            decision_engine=DecisionEngine(),
        )

        config = EvaluationReportConfig(
            evaluation_start=start,
            evaluation_end=end,
            signal_source="fixture",
            strategies=[strategy],
            git_sha="test-sha",
            run_id="test-run",
        )
        report = generate_evaluation_report(results, config=config, gate_policy=EvaluationGatePolicy())

        self.assertEqual(report.metrics.decision_count, 2)
        self.assertEqual(report.metrics.trade_count, 1)
        self.assertEqual(report.metrics.gross_pnl, Decimal("1"))
        self.assertEqual(report.metrics.net_pnl, Decimal("1"))
        self.assertEqual(report.metrics.total_cost, Decimal("0"))
        self.assertEqual(report.metrics.max_drawdown, Decimal("0"))
        self.assertEqual(report.gates.recommended_mode, "shadow")
        self.assertFalse(report.gates.promotion_allowed)
        self.assertEqual(report.impact_assumptions.default_execution_seconds, 60)
        self.assertEqual(report.impact_assumptions.decisions_with_adv, 0)
        self.assertIn("impact_bps_at_full_participation", report.impact_assumptions.assumptions)

        turnover_ratio = report.metrics.turnover_ratio.quantize(Decimal("0.1"))
        self.assertEqual(turnover_ratio, Decimal("4.0"))

    def test_report_prefers_recorded_impact_inputs_when_present(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
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
            name="wf-report-impact-inputs",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        strategy.id = uuid.uuid4()

        results = run_walk_forward(
            folds,
            strategies=[strategy],
            signal_source=source,
            decision_engine=DecisionEngine(),
        )

        for fold in results.folds:
            for item in fold.decisions:
                item.decision.params["impact_assumptions"] = {
                    "inputs": {
                        "spread": "0.10",
                        "volatility": "0.004",
                        "adv": "1200000",
                        "execution_seconds": 120,
                    }
                }

        config = EvaluationReportConfig(
            evaluation_start=start,
            evaluation_end=end,
            signal_source="fixture",
            strategies=[strategy],
            git_sha="test-sha",
            run_id="test-run-impact",
        )
        report = generate_evaluation_report(results, config=config, gate_policy=EvaluationGatePolicy())

        self.assertEqual(report.impact_assumptions.default_execution_seconds, 120)
        self.assertEqual(report.impact_assumptions.decisions_with_spread, 2)
        self.assertEqual(report.impact_assumptions.decisions_with_volatility, 2)
        self.assertEqual(report.impact_assumptions.decisions_with_adv, 2)
        self.assertEqual(report.impact_assumptions.assumptions["recorded_inputs_count"], "2")

    def test_report_uses_deterministic_execution_seconds_mode_on_tie(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
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
            name="wf-report-impact-mode-tie",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        strategy.id = uuid.uuid4()

        results = run_walk_forward(
            folds,
            strategies=[strategy],
            signal_source=source,
            decision_engine=DecisionEngine(),
        )

        execution_seconds_values = [120, 60]
        cursor = 0
        for fold in results.folds:
            for item in fold.decisions:
                item.decision.params["impact_assumptions"] = {
                    "inputs": {
                        "execution_seconds": execution_seconds_values[cursor],
                    }
                }
                cursor += 1

        config = EvaluationReportConfig(
            evaluation_start=start,
            evaluation_end=end,
            signal_source="fixture",
            strategies=[strategy],
            git_sha="test-sha",
            run_id="test-run-impact-mode-tie",
        )
        report = generate_evaluation_report(results, config=config, gate_policy=EvaluationGatePolicy())

        self.assertEqual(report.impact_assumptions.default_execution_seconds, 60)
