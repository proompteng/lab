from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, cast
from unittest import TestCase

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import (
    FixtureSignalSource,
    generate_walk_forward_folds,
    run_walk_forward,
    write_walk_forward_results,
)
from app.trading.models import SignalEnvelope, StrategyDecision


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
        self.assertEqual(
            results.feature_spec, "app.trading.features.extract_signal_features"
        )
        self.assertEqual(fold_result.fold_metrics()["decision_count"], 2)
        self.assertEqual(fold_result.fold_metrics()["buy_count"], 1)
        self.assertEqual(fold_result.fold_metrics()["sell_count"], 1)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "walkforward-results.json"
            write_walk_forward_results(results, output_path)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["feature_spec"], "app.trading.features.extract_signal_features"
            )
            self.assertEqual(len(payload["folds"]), 1)
            fold_payload = payload["folds"][0]
            self.assertEqual(
                fold_payload["regime_label"], "vol=high|trend=up|liq=liquid"
            )
            self.assertEqual(fold_payload["metrics"]["signals_count"], 2)
            self.assertEqual(fold_payload["metrics"]["decision_count"], 2)
            self.assertEqual(
                fold_payload["metrics"]["regime_label"], "vol=high|trend=up|liq=liquid"
            )
            self.assertEqual(
                fold_payload["metrics"]["regime"]["label"],
                "vol=high|trend=up|liq=liquid",
            )

    def test_walkforward_position_snapshot_ignores_malformed_prior_rows(
        self,
    ) -> None:
        class EdgeDecisionEngine:
            def evaluate(
                self,
                signal: SignalEnvelope,
                strategies: Iterable[Strategy],
                *,
                positions: list[dict[str, Any]] | None = None,
            ) -> list[StrategyDecision]:
                del strategies
                if positions is not None and not positions:
                    positions.extend(
                        [
                            {"symbol": "MSFT", "qty": "99", "side": "long"},
                            {"symbol": signal.symbol, "qty": None, "side": "long"},
                            {"symbol": signal.symbol, "qty": "bad", "side": "long"},
                            {
                                "symbol": signal.symbol,
                                "quantity": "2",
                                "side": "short",
                            },
                        ]
                    )

                event_ts = signal.event_ts
                timeframe = signal.timeframe or "1Min"
                return [
                    StrategyDecision(
                        strategy_id="edge",
                        symbol=" ",
                        event_ts=event_ts,
                        timeframe=timeframe,
                        action="buy",
                        qty=Decimal("1"),
                    ),
                    StrategyDecision(
                        strategy_id="edge",
                        symbol=signal.symbol,
                        event_ts=event_ts,
                        timeframe=timeframe,
                        action="buy",
                        qty=Decimal("3"),
                    ),
                    StrategyDecision(
                        strategy_id="edge",
                        symbol=signal.symbol,
                        event_ts=event_ts,
                        timeframe=timeframe,
                        action="buy",
                        qty=Decimal("1"),
                        params={"price": "bad"},
                    ),
                    StrategyDecision(
                        strategy_id="edge",
                        symbol=signal.symbol,
                        event_ts=event_ts,
                        timeframe=timeframe,
                        action="sell",
                        qty=Decimal("2"),
                    ),
                ]

        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        end = start + timedelta(minutes=2)
        signal = SignalEnvelope(
            event_ts=start + timedelta(minutes=1),
            ingest_ts=start + timedelta(minutes=1),
            symbol="AAPL",
            timeframe="1Min",
            payload={
                "macd": {"macd": "0.2", "signal": "0.1"},
                "rsi14": "50",
            },
        )
        strategy = Strategy(
            name="wf-edge",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )

        results = run_walk_forward(
            [
                generate_walk_forward_folds(
                    start,
                    end,
                    train_window=timedelta(minutes=1),
                    test_window=timedelta(minutes=1),
                    step=timedelta(minutes=1),
                )[0]
            ],
            strategies=[strategy],
            signal_source=FixtureSignalSource(signals=[signal]),
            decision_engine=cast(DecisionEngine, EdgeDecisionEngine()),
        )

        fold_result = results.folds[0]
        self.assertEqual(fold_result.signals_count, 1)
        self.assertEqual(len(fold_result.decisions), 4)
