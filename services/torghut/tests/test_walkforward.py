from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import TestCase

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import (
    FixtureSignalSource,
    generate_walk_forward_folds,
    run_walk_forward,
    write_walk_forward_results,
)


class TestWalkForwardHarness(TestCase):
    def test_walkforward_fixture_run(self) -> None:
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
            name="wf-test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )

        results = run_walk_forward(
            folds,
            strategies=[strategy],
            signal_source=source,
            decision_engine=DecisionEngine(),
        )

        self.assertEqual(len(results.folds), 1)
        fold_result = results.folds[0]
        self.assertEqual(fold_result.signals_count, 2)
        self.assertEqual(len(fold_result.decisions), 2)
        self.assertEqual(results.feature_spec, "app.trading.features.extract_signal_features")

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "walkforward-results.json"
            write_walk_forward_results(results, output_path)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["feature_spec"], "app.trading.features.extract_signal_features")
            self.assertEqual(len(payload["folds"]), 1)
