from __future__ import annotations

from datetime import UTC, datetime
from unittest import TestCase

import pandas as pd

from app.trading.alpha.metrics import PerformanceSummary
from app.trading.alpha.search import CandidateConfig, CandidateResult
from app.trading.discovery.validation import (
    _temporal_embargo_bundle,
    build_strategy_factory_evaluation,
)


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

    def test_strategy_factory_evaluation_reports_walk_forward_surface_correlation(
        self,
    ) -> None:
        def candidate(
            *,
            lookback_days: int,
            train_sharpe: float,
            test_sharpe: float,
            train_return: float,
            test_return: float,
        ) -> CandidateResult:
            return CandidateResult(
                config=CandidateConfig(
                    lookback_days=lookback_days,
                    vol_lookback_days=10,
                    target_daily_vol=0.01,
                    max_gross_leverage=1.0,
                ),
                train=PerformanceSummary(
                    total_return=train_return,
                    cagr=train_return,
                    annualized_vol=0.10,
                    sharpe=train_sharpe,
                    max_drawdown=-0.02,
                    days=60,
                ),
                test=PerformanceSummary(
                    total_return=test_return,
                    cagr=test_return,
                    annualized_vol=0.10,
                    sharpe=test_sharpe,
                    max_drawdown=-0.02,
                    days=60,
                ),
            )

        index = pd.date_range("2026-04-01", periods=8, freq="B", tz="UTC")
        debug_frame = pd.DataFrame(
            {
                "port_ret_net": [0.0015] * 8,
                "port_ret_gross": [0.0017] * 8,
                "turnover": [0.3] * 8,
                "cost_ret": [0.0002] * 8,
            },
            index=index,
        )
        candidates = [
            candidate(
                lookback_days=20,
                train_sharpe=2.0,
                test_sharpe=1.8,
                train_return=0.10,
                test_return=0.09,
            ),
            candidate(
                lookback_days=30,
                train_sharpe=1.5,
                test_sharpe=1.4,
                train_return=0.08,
                test_return=0.07,
            ),
            candidate(
                lookback_days=40,
                train_sharpe=1.0,
                test_sharpe=0.9,
                train_return=0.05,
                test_return=0.04,
            ),
            candidate(
                lookback_days=50,
                train_sharpe=0.5,
                test_sharpe=0.4,
                train_return=0.02,
                test_return=0.01,
            ),
        ]

        evaluation = build_strategy_factory_evaluation(
            run_id="run-wfc-1",
            candidate_id="cand-wfc-1",
            best_candidate=candidates[0],
            all_candidates=candidates,
            train_debug=debug_frame,
            test_debug=debug_frame,
            train_summary=candidates[0].train,
            test_summary=candidates[0].test,
            incumbent_summary=PerformanceSummary(
                total_return=0.01,
                cagr=0.02,
                annualized_vol=0.09,
                sharpe=0.2,
                max_drawdown=-0.03,
                days=60,
            ),
            cost_bps_per_turnover=0.1,
            evaluated_at=datetime(2026, 5, 19, tzinfo=UTC),
        )

        surface_test = next(
            item
            for item in evaluation.validation_tests
            if item.test_name == "walk_forward_surface_correlation"
        )
        self.assertEqual(surface_test.status, "pass")
        self.assertEqual(
            surface_test.metric_bundle["source"],
            "walk_forward_correlation_ssrn_6324079_2026",
        )
        self.assertGreaterEqual(
            surface_test.metric_bundle["surface_correlation"],
            surface_test.metric_bundle["min_surface_correlation"],
        )

    def test_strategy_factory_evaluation_gates_transaction_cost_stress(
        self,
    ) -> None:
        def candidate(
            *,
            lookback_days: int,
            train_sharpe: float,
            test_sharpe: float,
            train_return: float,
            test_return: float,
        ) -> CandidateResult:
            return CandidateResult(
                config=CandidateConfig(
                    lookback_days=lookback_days,
                    vol_lookback_days=10,
                    target_daily_vol=0.01,
                    max_gross_leverage=1.0,
                ),
                train=PerformanceSummary(
                    total_return=train_return,
                    cagr=train_return,
                    annualized_vol=0.10,
                    sharpe=train_sharpe,
                    max_drawdown=-0.02,
                    days=60,
                ),
                test=PerformanceSummary(
                    total_return=test_return,
                    cagr=test_return,
                    annualized_vol=0.10,
                    sharpe=test_sharpe,
                    max_drawdown=-0.02,
                    days=60,
                ),
            )

        index = pd.date_range("2026-04-01", periods=8, freq="B", tz="UTC")
        debug_frame = pd.DataFrame(
            {
                "port_ret_net": [0.0001] * 8,
                "port_ret_gross": [0.0005] * 8,
                "turnover": [0.3] * 8,
                "cost_ret": [0.0004] * 8,
            },
            index=index,
        )
        candidates = [
            candidate(
                lookback_days=20,
                train_sharpe=2.0,
                test_sharpe=1.8,
                train_return=0.10,
                test_return=0.09,
            ),
            candidate(
                lookback_days=30,
                train_sharpe=1.5,
                test_sharpe=1.4,
                train_return=0.08,
                test_return=0.07,
            ),
            candidate(
                lookback_days=40,
                train_sharpe=1.0,
                test_sharpe=0.9,
                train_return=0.05,
                test_return=0.04,
            ),
        ]

        evaluation = build_strategy_factory_evaluation(
            run_id="run-cost-stress-1",
            candidate_id="cand-cost-stress-1",
            best_candidate=candidates[0],
            all_candidates=candidates,
            train_debug=debug_frame,
            test_debug=debug_frame,
            train_summary=candidates[0].train,
            test_summary=candidates[0].test,
            incumbent_summary=PerformanceSummary(
                total_return=0.01,
                cagr=0.02,
                annualized_vol=0.09,
                sharpe=0.2,
                max_drawdown=-0.03,
                days=60,
            ),
            cost_bps_per_turnover=0.1,
            evaluated_at=datetime(2026, 5, 19, tzinfo=UTC),
        )

        stress_test = next(
            item
            for item in evaluation.validation_tests
            if item.test_name == "transaction_cost_stress"
        )
        self.assertEqual(stress_test.status, "fail")
        self.assertEqual(
            stress_test.metric_bundle["source"],
            "transaction_cost_trap_ssrn_6422358_2025",
        )
        self.assertLess(
            stress_test.metric_bundle["worst_projected_net_return_mean"],
            stress_test.metric_bundle["required_min_projected_net_return_mean"],
        )

    def test_strategy_factory_evaluation_gates_overlapping_train_test_windows(
        self,
    ) -> None:
        def candidate(
            *,
            lookback_days: int,
            train_sharpe: float,
            test_sharpe: float,
            train_return: float,
            test_return: float,
        ) -> CandidateResult:
            return CandidateResult(
                config=CandidateConfig(
                    lookback_days=lookback_days,
                    vol_lookback_days=10,
                    target_daily_vol=0.01,
                    max_gross_leverage=1.0,
                ),
                train=PerformanceSummary(
                    total_return=train_return,
                    cagr=train_return,
                    annualized_vol=0.10,
                    sharpe=train_sharpe,
                    max_drawdown=-0.02,
                    days=60,
                ),
                test=PerformanceSummary(
                    total_return=test_return,
                    cagr=test_return,
                    annualized_vol=0.10,
                    sharpe=test_sharpe,
                    max_drawdown=-0.02,
                    days=60,
                ),
            )

        train_index = pd.date_range("2026-04-01", periods=8, freq="B", tz="UTC")
        test_index = pd.date_range("2026-04-08", periods=8, freq="B", tz="UTC")
        train_debug = pd.DataFrame(
            {
                "port_ret_net": [0.0015] * 8,
                "port_ret_gross": [0.0017] * 8,
                "turnover": [0.3] * 8,
                "cost_ret": [0.0002] * 8,
            },
            index=train_index,
        )
        test_debug = pd.DataFrame(
            {
                "port_ret_net": [0.0015] * 8,
                "port_ret_gross": [0.0017] * 8,
                "turnover": [0.3] * 8,
                "cost_ret": [0.0002] * 8,
            },
            index=test_index,
        )
        candidates = [
            candidate(
                lookback_days=20,
                train_sharpe=2.0,
                test_sharpe=1.8,
                train_return=0.10,
                test_return=0.09,
            ),
            candidate(
                lookback_days=30,
                train_sharpe=1.5,
                test_sharpe=1.4,
                train_return=0.08,
                test_return=0.07,
            ),
            candidate(
                lookback_days=40,
                train_sharpe=1.0,
                test_sharpe=0.9,
                train_return=0.05,
                test_return=0.04,
            ),
        ]

        evaluation = build_strategy_factory_evaluation(
            run_id="run-embargo-1",
            candidate_id="cand-embargo-1",
            best_candidate=candidates[0],
            all_candidates=candidates,
            train_debug=train_debug,
            test_debug=test_debug,
            train_summary=candidates[0].train,
            test_summary=candidates[0].test,
            incumbent_summary=PerformanceSummary(
                total_return=0.01,
                cagr=0.02,
                annualized_vol=0.09,
                sharpe=0.2,
                max_drawdown=-0.03,
                days=60,
            ),
            cost_bps_per_turnover=0.1,
            evaluated_at=datetime(2026, 5, 19, tzinfo=UTC),
        )

        embargo_test = next(
            item
            for item in evaluation.validation_tests
            if item.test_name == "temporal_embargo_gap"
        )
        self.assertEqual(embargo_test.status, "fail")
        self.assertEqual(
            embargo_test.metric_bundle["source"],
            "double_oos_walkforward_arxiv_2602_10785_2026",
        )
        self.assertGreater(
            embargo_test.metric_bundle["overlapping_timestamp_count"],
            0,
        )
        self.assertIn(
            "train_test_timestamp_overlap",
            embargo_test.metric_bundle["reason_codes"],
        )

    def test_temporal_embargo_bundle_fails_closed_when_windows_are_missing(
        self,
    ) -> None:
        metric_bundle = _temporal_embargo_bundle(
            train_debug=pd.DataFrame(index=pd.DatetimeIndex([], tz="UTC")),
            test_debug=pd.DataFrame(index=pd.DatetimeIndex([], tz="UTC")),
        )

        self.assertFalse(metric_bundle["passed"])
        self.assertIn("train_window_missing", metric_bundle["reason_codes"])
        self.assertIn("test_window_missing", metric_bundle["reason_codes"])
        self.assertIn("temporal_gap_unmeasured", metric_bundle["reason_codes"])
