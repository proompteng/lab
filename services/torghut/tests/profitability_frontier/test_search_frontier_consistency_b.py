from __future__ import annotations

# ruff: noqa: F403,F405
from tests.profitability_frontier.search_frontier_base import *


class TestSearchFrontierConsistencyB(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_consistency_penalty_rejects_lucky_strike_and_low_notional_profile(
        self,
    ) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-04-02",
                daily_net={
                    "2026-03-24": "0",
                    "2026-03-25": "0",
                    "2026-03-26": "0",
                    "2026-03-27": "0",
                    "2026-03-30": "0",
                    "2026-03-31": "-150",
                    "2026-04-01": "-100",
                    "2026-04-02": "2650",
                },
                daily_filled_notional={
                    "2026-03-24": "0",
                    "2026-03-25": "0",
                    "2026-03-26": "0",
                    "2026-03-27": "0",
                    "2026-03-30": "0",
                    "2026-03-31": "40000",
                    "2026-04-01": "50000",
                    "2026-04-02": "60000",
                },
                daily_liquidity_notional={
                    "2026-03-31": "1000000",
                    "2026-04-01": "1250000",
                    "2026-04-02": "1500000",
                },
                decision_count=3,
                filled_count=3,
                wins=1,
                losses=2,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("300"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=6,
                min_active_ratio=frontier.Decimal("0.75"),
                min_positive_days=4,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=2,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.55"),
                min_avg_filled_notional_per_day=frontier.Decimal("150000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("200000"),
                require_every_day_active=False,
            ),
        )

        self.assertGreater(penalties, frontier.Decimal("0"))
        self.assertEqual(summary["active_days"], 3)
        self.assertEqual(summary["positive_days"], 1)
        self.assertEqual(
            summary["best_day_share_of_total_pnl"], "1.104166666666666666666666667"
        )
        self.assertEqual(summary["avg_filled_notional_per_day"], "18750")
        self.assertTrue(summary["market_impact_liquidity_evidence_present"])
        self.assertEqual(summary["market_impact_liquidity_day_count"], 3)
        self.assertEqual(summary["market_impact_liquidity_missing_day_count"], 5)
        self.assertEqual(summary["avg_liquidity_notional_per_day"], "468750")
        self.assertEqual(summary["market_impact_stress_model"], "square_root")
        self.assertEqual(summary["market_impact_stress_cost_bps"], "20.0")
        self.assertEqual(summary["market_impact_stress_net_pnl_per_day"], "262.5")
        self.assertTrue(summary["implementation_uncertainty_required"])
        self.assertEqual(
            summary["implementation_uncertainty_model"],
            "impact_latency_cost_model_interval",
        )
        self.assertEqual(summary["implementation_uncertainty_model_count"], 5)
        self.assertIn(
            "impact_decay_reversion_1_5x",
            summary["implementation_uncertainty_scenarios"],
        )
        self.assertEqual(
            summary["market_impact_stress_components"]["source_marker"],
            "realistic_market_impact_arxiv_2603_29086_2026",
        )
        self.assertIn(
            "double_square_root_impact_arxiv_2502_16246_2025",
            summary["market_impact_stress_source_markers"],
        )
        self.assertIn(
            "double_square_root_impact_arxiv_2502_16246_2025",
            summary["market_impact_stress_components"]["source_markers"],
        )
        self.assertEqual(
            summary["market_impact_stress_components"]["almgren_chriss_cost_bps"],
            "10.00",
        )
        self.assertTrue(summary["market_impact_stress_passed"])
        self.assertEqual(
            summary["delay_adjusted_depth_stress_model"], "latency_depth_haircut"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_fillable_notional_per_day"], "18750"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_latency_grid_ms"], ["50", "150", "250"]
        )
        self.assertEqual(summary["delay_adjusted_depth_grid_max_stress_ms"], "250")
        self.assertEqual(
            summary["delay_adjusted_depth_worst_active_day_fillable_notional"],
            "40000",
        )
        self.assertEqual(
            summary["delay_adjusted_depth_p10_active_day_fillable_notional"],
            "40000",
        )
        self.assertTrue(summary["delay_adjusted_depth_tail_coverage_passed"])
        self.assertTrue(summary["delay_adjusted_depth_liquidity_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_liquidity_missing_day_count"], 0)
        self.assertEqual(summary["delay_adjusted_depth_fillable_ratio"], "1")
        self.assertEqual(
            summary["delay_adjusted_depth_unfillable_notional_per_day"], "0"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_stress_net_pnl_per_day"], "298.125"
        )
        self.assertTrue(summary["delay_adjusted_depth_stress_passed"])
        self.assertEqual(
            summary["daily_liquidity_notional"],
            {
                "2026-03-31": "1000000",
                "2026-04-01": "1250000",
                "2026-04-02": "1500000",
            },
        )

    def test_consistency_penalty_selects_almgren_chriss_proxy_when_stricter(
        self,
    ) -> None:
        _, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-24",
                daily_net={"2026-03-24": "1000"},
                daily_filled_notional={"2026-03-24": "1000000"},
                daily_liquidity_notional={"2026-03-24": "1000000"},
                decision_count=10,
                filled_count=10,
                wins=10,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=1,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=1,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("1"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertEqual(summary["market_impact_stress_model"], "almgren_chriss_proxy")
        self.assertEqual(summary["market_impact_stress_cost_bps"], "150")
        self.assertEqual(
            summary["market_impact_stress_components"]["square_root_cost_bps"], "100"
        )
        self.assertEqual(
            summary["market_impact_stress_components"]["almgren_chriss_cost_bps"],
            "150",
        )
        self.assertFalse(summary["market_impact_stress_passed"])

    def test_consistency_penalty_fails_implementation_uncertainty_lower_bound(
        self,
    ) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-25",
                daily_net={
                    "2026-03-24": "514",
                    "2026-03-25": "514",
                },
                daily_filled_notional={
                    "2026-03-24": "100000",
                    "2026-03-25": "100000",
                },
                daily_liquidity_notional={
                    "2026-03-24": "10000000000000",
                    "2026-03-25": "10000000000000",
                },
                decision_count=4,
                filled_count=4,
                wins=4,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=2,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=2,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.60"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertTrue(summary["market_impact_stress_passed"])
        self.assertEqual(summary["market_impact_stress_net_pnl_per_day"], "504.0")
        self.assertFalse(summary["implementation_uncertainty_stability_passed"])
        self.assertEqual(
            summary["implementation_uncertainty_lower_net_pnl_per_day"], "499.0"
        )
        self.assertGreater(penalties, frontier.Decimal("0"))

    def test_consistency_penalty_fails_delay_depth_when_filled_day_lacks_liquidity(
        self,
    ) -> None:
        _, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-25",
                daily_net={
                    "2026-03-24": "800",
                    "2026-03-25": "800",
                },
                daily_filled_notional={
                    "2026-03-24": "200000",
                    "2026-03-25": "200000",
                },
                daily_liquidity_notional={
                    "2026-03-24": "100000",
                },
                decision_count=4,
                filled_count=4,
                wins=4,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=2,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=2,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.75"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertFalse(summary["delay_adjusted_depth_liquidity_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_liquidity_missing_day_count"], 1)
        self.assertEqual(
            summary["delay_adjusted_depth_fillable_notional_per_day"], "47500.00"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_worst_active_day_fillable_notional"], "0"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_p10_active_day_fillable_notional"], "0"
        )
        self.assertFalse(summary["delay_adjusted_depth_tail_coverage_passed"])
        self.assertFalse(summary["delay_adjusted_depth_stress_passed"])

    def test_consistency_penalty_scales_delay_depth_net_for_thin_recorded_liquidity(
        self,
    ) -> None:
        _, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-25",
                daily_net={
                    "2026-03-24": "800",
                    "2026-03-25": "800",
                },
                daily_filled_notional={
                    "2026-03-24": "400000",
                    "2026-03-25": "400000",
                },
                daily_liquidity_notional={
                    "2026-03-24": "200000",
                    "2026-03-25": "200000",
                },
                decision_count=4,
                filled_count=4,
                wins=4,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=2,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=2,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.75"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertTrue(summary["delay_adjusted_depth_liquidity_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_liquidity_missing_day_count"], 0)
        self.assertEqual(
            summary["delay_adjusted_depth_fillable_notional_per_day"], "190000.00"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_worst_grid_fillable_notional_per_day"],
            "150000.00",
        )
        self.assertEqual(
            summary["delay_adjusted_depth_worst_active_day_fillable_notional"],
            "150000.00",
        )
        self.assertEqual(
            summary["delay_adjusted_depth_p10_active_day_fillable_notional"],
            "150000.00",
        )
        self.assertTrue(summary["delay_adjusted_depth_tail_coverage_passed"])
        self.assertEqual(summary["delay_adjusted_depth_fillable_ratio"], "0.475")
        self.assertEqual(
            summary["delay_adjusted_depth_unfillable_notional_per_day"], "210000.00"
        )
        self.assertEqual(
            frontier.Decimal(summary["delay_adjusted_depth_stress_net_pnl_per_day"]),
            frontier.Decimal("361"),
        )

    def test_consistency_penalty_applies_order_lifecycle_fill_survival_to_delay_depth(
        self,
    ) -> None:
        payload = self._payload(
            start_date="2026-03-24",
            end_date="2026-03-24",
            daily_net={"2026-03-24": "1000"},
            daily_filled_notional={"2026-03-24": "100000"},
            daily_liquidity_notional={"2026-03-24": "1000000"},
            decision_count=4,
            filled_count=4,
            wins=4,
            losses=0,
        )
        payload["order_lifecycle"] = {
            "submitted_order_count": 4,
            "filled_order_count": 2,
            "fill_rate": "0.5",
            "fill_survival_sample_count": 4,
            "fill_survival_evidence_present": True,
            "order_qty_to_touch_qty_ratio_p95": "0.25",
            "queue_ahead_depletion_evidence_present": True,
            "queue_ahead_depletion_sample_count": 4,
            "queue_ahead_depletion_rate": "0.50",
            "queue_ahead_depleted_qty_p50": "25",
            "queue_ahead_depletion_time_ms_p50": "125",
            "post_cost_survivorship": {
                "post_cost_survival_rate": "1",
                "gross_positive_killed_by_cost_count": 0,
            },
        }

        _, summary = frontier._consistency_penalty(
            full_window_payload=payload,
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=1,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=1,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("1"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertEqual(summary["fill_survival_sample_count"], 4)
        self.assertTrue(summary["fill_survival_evidence_present"])
        self.assertEqual(summary["fill_survival_fill_rate"], "0.5")
        self.assertTrue(summary["delay_adjusted_depth_fill_survival_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_fill_survival_sample_count"], 4)
        self.assertEqual(summary["delay_adjusted_depth_fill_survival_rate"], "0.5")
        self.assertEqual(
            summary["delay_adjusted_depth_survival_adjusted_fillable_ratio"],
            "0.5",
        )
        self.assertEqual(
            frontier.Decimal(summary["delay_adjusted_depth_stress_net_pnl_per_day"]),
            frontier.Decimal("490"),
        )
        self.assertEqual(summary["delay_adjusted_depth_queue_ratio_p95"], "0.25")
        self.assertTrue(summary["queue_position_survival_fill_curve_evidence_present"])
        self.assertEqual(summary["queue_position_survival_sample_count"], 4)
        self.assertEqual(summary["queue_position_survival_fill_rate"], "0.5")
        self.assertEqual(summary["queue_position_survival_queue_ratio_p95"], "0.25")
        self.assertTrue(
            summary["queue_position_survival_queue_ahead_depletion_evidence_present"]
        )
        self.assertEqual(
            summary["queue_position_survival_queue_ahead_depletion_sample_count"],
            4,
        )
        self.assertTrue(summary["queue_ahead_depletion_evidence_present"])
        self.assertEqual(summary["queue_ahead_depletion_sample_count"], 4)
        self.assertEqual(
            summary["queue_position_survival_adjusted_fillable_ratio"],
            "0.5",
        )
        self.assertEqual(
            frontier.Decimal(
                summary["queue_position_survival_nonfill_opportunity_cost_bps"]
            ),
            frontier.Decimal("51.0"),
        )
        self.assertEqual(
            frontier.Decimal(summary["queue_position_survival_stress_net_pnl_per_day"]),
            frontier.Decimal("490"),
        )
        self.assertEqual(
            frontier.Decimal(
                summary["post_cost_net_pnl_after_queue_position_survival_fill_stress"]
            ),
            frontier.Decimal("490"),
        )

    def test_consistency_penalty_does_not_count_l1_queue_ratio_as_queue_survival(
        self,
    ) -> None:
        payload = self._payload(
            start_date="2026-03-24",
            end_date="2026-03-24",
            daily_net={"2026-03-24": "1000"},
            daily_filled_notional={"2026-03-24": "100000"},
            daily_liquidity_notional={"2026-03-24": "1000000"},
            decision_count=4,
            filled_count=4,
            wins=4,
            losses=0,
        )
        payload["order_lifecycle"] = {
            "submitted_order_count": 4,
            "filled_order_count": 2,
            "fill_rate": "0.5",
            "fill_survival_sample_count": 4,
            "fill_survival_evidence_present": True,
            "order_qty_to_touch_qty_ratio_p95": "0.25",
        }

        _, summary = frontier._consistency_penalty(
            full_window_payload=payload,
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=1,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=1,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("1"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertTrue(summary["delay_adjusted_depth_fill_survival_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_queue_ratio_p95"], "0.25")
        self.assertFalse(summary["queue_position_survival_fill_curve_evidence_present"])
        self.assertFalse(
            summary["queue_position_survival_queue_ahead_depletion_evidence_present"]
        )
        self.assertEqual(
            summary["queue_position_survival_queue_ahead_depletion_sample_count"],
            0,
        )

    def test_consistency_penalty_reports_and_penalizes_capital_realism(self) -> None:
        payload = self._payload(
            start_date="2026-03-24",
            end_date="2026-03-26",
            daily_net={
                "2026-03-24": "600",
                "2026-03-25": "550",
                "2026-03-26": "650",
            },
            daily_filled_notional={
                "2026-03-24": "250000",
                "2026-03-25": "260000",
                "2026-03-26": "270000",
            },
            decision_count=12,
            filled_count=12,
            wins=9,
            losses=3,
        )
        daily = cast(dict[str, dict[str, object]], payload["daily"])
        daily["2026-03-24"]["min_cash"] = "12000"
        daily["2026-03-24"]["max_gross_exposure_pct_equity"] = "0.80"
        daily["2026-03-24"]["negative_cash_observation_count"] = 0
        daily["2026-03-25"]["min_cash"] = "-2500"
        daily["2026-03-25"]["max_gross_exposure_pct_equity"] = "2.40"
        daily["2026-03-25"]["negative_cash_observation_count"] = 3
        daily["2026-03-26"]["min_cash"] = "8000"
        daily["2026-03-26"]["max_gross_exposure_pct_equity"] = "1.10"
        daily["2026-03-26"]["negative_cash_observation_count"] = 0

        penalties, summary = frontier._consistency_penalty(
            full_window_payload=payload,
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=3,
                min_active_ratio=frontier.Decimal("1.0"),
                min_positive_days=3,
                max_worst_day_loss=frontier.Decimal("0"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("0"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.60"),
                min_avg_filled_notional_per_day=frontier.Decimal("200000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("200000"),
                require_every_day_active=True,
                max_gross_exposure_pct_equity=frontier.Decimal("1.50"),
                min_cash=frontier.Decimal("0"),
            ),
        )

        self.assertGreater(penalties, frontier.Decimal("0"))
        self.assertEqual(summary["max_gross_exposure_pct_equity"], "2.40")
        self.assertEqual(summary["min_cash"], "-2500")
        self.assertEqual(summary["negative_cash_observation_count"], 3)
        self.assertEqual(summary["daily_min_cash"]["2026-03-25"], "-2500")
