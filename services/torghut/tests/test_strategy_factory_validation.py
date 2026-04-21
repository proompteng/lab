from __future__ import annotations

from datetime import UTC, datetime
from unittest import TestCase

import pandas as pd

from app.trading.alpha.metrics import PerformanceSummary
from app.trading.alpha.search import CandidateConfig, CandidateResult
from app.trading.discovery.validation import build_strategy_factory_evaluation


class TestStrategyFactoryValidation(TestCase):
    def test_strategy_factory_evaluation_accepts_non_tsmom_family_metadata(
        self,
    ) -> None:
        index = pd.date_range("2026-03-20", periods=6, freq="B", tz="UTC")
        train_debug = pd.DataFrame(
            {
                "port_ret_net": [0.001, 0.002, 0.0015, 0.0025, 0.001, 0.002],
                "port_ret_gross": [0.0012, 0.0022, 0.0017, 0.0027, 0.0012, 0.0022],
                "turnover": [0.4, 0.3, 0.5, 0.4, 0.3, 0.5],
                "cost_ret": [0.0002, 0.0002, 0.0002, 0.0002, 0.0002, 0.0002],
            },
            index=index,
        )
        test_debug = train_debug.copy()
        best = CandidateResult(
            config=CandidateConfig(
                lookback_days=30,
                vol_lookback_days=10,
                target_daily_vol=0.01,
                max_gross_leverage=1.2,
            ),
            train=PerformanceSummary(
                total_return=0.14,
                cagr=0.34,
                annualized_vol=0.12,
                sharpe=1.8,
                max_drawdown=-0.02,
                days=60,
            ),
            test=PerformanceSummary(
                total_return=0.08,
                cagr=0.24,
                annualized_vol=0.10,
                sharpe=1.5,
                max_drawdown=-0.01,
                days=60,
            ),
        )
        challenger = CandidateResult(
            config=CandidateConfig(
                lookback_days=20,
                vol_lookback_days=10,
                target_daily_vol=0.01,
                max_gross_leverage=1.0,
            ),
            train=PerformanceSummary(
                total_return=0.04,
                cagr=0.10,
                annualized_vol=0.10,
                sharpe=0.7,
                max_drawdown=-0.03,
                days=60,
            ),
            test=PerformanceSummary(
                total_return=0.03,
                cagr=0.08,
                annualized_vol=0.10,
                sharpe=0.5,
                max_drawdown=-0.03,
                days=60,
            ),
        )

        evaluation = build_strategy_factory_evaluation(
            run_id="run-washout-1",
            candidate_id="cand-washout-1",
            best_candidate=best,
            all_candidates=[best, challenger],
            train_debug=train_debug,
            test_debug=test_debug,
            train_summary=best.train,
            test_summary=best.test,
            incumbent_summary=PerformanceSummary(
                total_return=0.02,
                cagr=0.05,
                annualized_vol=0.09,
                sharpe=0.4,
                max_drawdown=-0.04,
                days=60,
            ),
            cost_bps_per_turnover=0.1,
            evaluated_at=datetime(2026, 4, 21, tzinfo=UTC),
            candidate_family="washout_rebound_consistent",
            family_template_id="washout_rebound_v2",
            runtime_family="washout_rebound_consistent",
            runtime_strategy_name="washout-rebound-long-v1",
            baseline_name="washout_rebound_default_v1",
            generator_family="washout_rebound_grid_v1",
            regime_supports=("liquidity_shock_reversal",),
            regime_avoid=("persistent_gap_down",),
        )

        self.assertEqual(evaluation.candidate_family, "washout_rebound_consistent")
        self.assertEqual(
            evaluation.canonical_spec["family_template_id"], "washout_rebound_v2"
        )
        self.assertEqual(
            evaluation.canonical_spec["runtime_strategy_name"],
            "washout-rebound-long-v1",
        )
        self.assertEqual(
            evaluation.null_comparator_summary["incumbent_baseline"]["name"],
            "washout_rebound_default_v1",
        )
        self.assertEqual(
            evaluation.valid_regime_envelope["supports"],
            ["liquidity_shock_reversal"],
        )
        self.assertEqual(
            evaluation.valid_regime_envelope["avoid"],
            ["persistent_gap_down"],
        )
        self.assertEqual(
            {attempt["generator_family"] for attempt in evaluation.attempts},
            {"washout_rebound_grid_v1"},
        )
        self.assertEqual(
            evaluation.cost_calibration.scope_id, "washout_rebound_consistent"
        )
