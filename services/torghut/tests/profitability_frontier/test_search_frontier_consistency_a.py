from __future__ import annotations

# ruff: noqa: F403,F405
from tests.profitability_frontier.search_frontier_base import *


class TestSearchFrontierConsistencyA(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_resolve_full_window_rejects_inverted_explicit_dates(self) -> None:
        with self.assertRaisesRegex(ValueError, "full_window_invalid_range"):
            frontier._resolve_full_window(
                args=Namespace(
                    full_window_start_date="2026-04-03",
                    full_window_end_date="2026-04-02",
                ),
                train_days=(date(2026, 4, 1),),
                holdout_days=(date(2026, 4, 2),),
            )

    def test_max_best_day_share_returns_zero_when_positive_total_has_no_positive_day(
        self,
    ) -> None:
        self.assertEqual(
            frontier._max_best_day_share_of_total_pnl(
                daily_net={"2026-04-01": Decimal("-10")},
                total_net_pnl=Decimal("100"),
            ),
            Decimal("0"),
        )

    def test_consistency_penalty_penalizes_excess_negative_days(self) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-03",
                daily_net={
                    "2026-04-01": "-20",
                    "2026-04-02": "-30",
                    "2026-04-03": "200",
                },
                decision_count=3,
                filled_count=3,
                wins=1,
                losses=2,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("10"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=1,
                min_active_ratio=Decimal("0"),
                min_positive_days=1,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=0,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
        )

        self.assertGreaterEqual(penalties, Decimal("600"))
        self.assertEqual(summary["negative_days"], 2)

    def test_consistency_penalty_penalizes_tail_loss_adjusted_net_below_target(
        self,
    ) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-07",
                daily_net={
                    "2026-04-01": "1200",
                    "2026-04-02": "1200",
                    "2026-04-03": "1200",
                    "2026-04-06": "-500",
                    "2026-04-07": "1200",
                },
                daily_filled_notional={
                    "2026-04-01": "100000",
                    "2026-04-02": "100000",
                    "2026-04-03": "100000",
                    "2026-04-06": "100000",
                    "2026-04-07": "100000",
                },
                daily_liquidity_notional={
                    "2026-04-01": "10000000000",
                    "2026-04-02": "10000000000",
                    "2026-04-03": "10000000000",
                    "2026-04-06": "10000000000",
                    "2026-04-07": "10000000000",
                },
                decision_count=5,
                filled_count=5,
                wins=4,
                losses=1,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("500"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=5,
                min_active_ratio=Decimal("1"),
                min_positive_days=4,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=1,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=True,
            ),
        )

        self.assertFalse(summary["conformal_tail_risk_passed"])
        self.assertEqual(
            summary["conformal_tail_risk_model"],
            "empirical_daily_loss_conformal_buffer",
        )
        self.assertEqual(summary["conformal_tail_risk_buffer_per_day"], "500")
        self.assertEqual(
            Decimal(str(summary["conformal_tail_risk_adjusted_net_pnl_per_day"])),
            Decimal("360"),
        )
        self.assertIn(
            "regime_weighted_conformal_var_arxiv_2602_03903_2026",
            summary["conformal_tail_risk_source_markers"],
        )
        self.assertGreaterEqual(penalties, Decimal("140"))

    def test_consistency_penalty_emits_breakeven_transaction_cost_buffer(self) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-07",
                daily_net={
                    "2026-04-01": "700",
                    "2026-04-02": "700",
                    "2026-04-03": "700",
                    "2026-04-06": "700",
                    "2026-04-07": "700",
                },
                daily_filled_notional={
                    "2026-04-01": "100000",
                    "2026-04-02": "100000",
                    "2026-04-03": "100000",
                    "2026-04-06": "100000",
                    "2026-04-07": "100000",
                },
                daily_liquidity_notional={
                    "2026-04-01": "10000000000",
                    "2026-04-02": "10000000000",
                    "2026-04-03": "10000000000",
                    "2026-04-06": "10000000000",
                    "2026-04-07": "10000000000",
                },
                decision_count=5,
                filled_count=5,
                wins=5,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("500"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=5,
                min_active_ratio=Decimal("1"),
                min_positive_days=4,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=1,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=True,
            ),
        )

        self.assertTrue(summary["breakeven_transaction_cost_buffer_passed"])
        self.assertTrue(summary["required_breakeven_transaction_cost_buffer"])
        self.assertTrue(summary["required_seed_model_family_robustness"])
        self.assertFalse(summary["seed_robustness_passed"])
        self.assertEqual(summary["seed_robustness_sample_count"], 0)
        self.assertFalse(summary["model_family_robustness_passed"])
        self.assertEqual(summary["model_family_robustness_family_count"], 0)
        self.assertEqual(
            summary["seed_model_family_robustness_status"],
            "required_not_materialized_by_single_frontier_replay",
        )
        self.assertEqual(summary["transaction_cost_buffer_bps"], "1")
        self.assertEqual(
            Decimal(str(summary["breakeven_transaction_cost_buffer_bps"])),
            Decimal("20"),
        )
        self.assertEqual(
            Decimal(
                str(
                    summary["post_cost_net_pnl_after_breakeven_transaction_cost_buffer"]
                )
            ),
            Decimal("690"),
        )
        self.assertIn(
            "realistic_market_impact_arxiv_2603_29086_2026",
            summary["breakeven_transaction_cost_buffer_source_markers"],
        )
        self.assertIn(
            "regime_weighted_conformal_var_arxiv_2602_03903_2026",
            summary["seed_model_family_robustness_source_markers"],
        )
        self.assertEqual(penalties, Decimal("0"))

    def test_consistency_penalty_blocks_breakeven_transaction_cost_shortfall(
        self,
    ) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-07",
                daily_net={
                    "2026-04-01": "510",
                    "2026-04-02": "510",
                    "2026-04-03": "510",
                    "2026-04-06": "510",
                    "2026-04-07": "510",
                },
                daily_filled_notional={
                    "2026-04-01": "200000",
                    "2026-04-02": "200000",
                    "2026-04-03": "200000",
                    "2026-04-06": "200000",
                    "2026-04-07": "200000",
                },
                daily_liquidity_notional={
                    "2026-04-01": "10000000000",
                    "2026-04-02": "10000000000",
                    "2026-04-03": "10000000000",
                    "2026-04-06": "10000000000",
                    "2026-04-07": "10000000000",
                },
                decision_count=5,
                filled_count=5,
                wins=5,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("500"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=5,
                min_active_ratio=Decimal("1"),
                min_positive_days=4,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=1,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=True,
            ),
        )

        self.assertFalse(summary["breakeven_transaction_cost_buffer_passed"])
        self.assertEqual(
            Decimal(str(summary["breakeven_transaction_cost_buffer_bps"])),
            Decimal("0.5"),
        )
        self.assertEqual(
            Decimal(
                str(
                    summary["post_cost_net_pnl_after_breakeven_transaction_cost_buffer"]
                )
            ),
            Decimal("490"),
        )
        self.assertGreaterEqual(penalties, Decimal("10"))

    def test_consistency_penalty_caps_impossible_count_activity_gates(self) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-03",
                daily_net={
                    "2026-04-01": "20",
                    "2026-04-02": "30",
                    "2026-04-03": "40",
                },
                decision_count=3,
                filled_count=3,
                wins=3,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("0"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=9,
                min_active_ratio=Decimal("0"),
                min_positive_days=9,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=3,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
        )

        self.assertEqual(summary["trading_day_count"], 3)
        self.assertEqual(summary["active_days"], 3)
        self.assertEqual(penalties, Decimal("0"))

    def test_consistency_penalty_penalizes_short_policy_window(self) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-03",
                daily_net={
                    "2026-04-01": "20",
                    "2026-04-02": "30",
                    "2026-04-03": "40",
                },
                decision_count=3,
                filled_count=3,
                wins=3,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("0"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=0,
                min_active_ratio=Decimal("0"),
                min_positive_days=0,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=3,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
                min_window_weekday_count=5,
            ),
        )

        self.assertEqual(summary["trading_day_count"], 3)
        self.assertEqual(summary["min_window_weekday_count_required"], 5)
        self.assertGreaterEqual(penalties, Decimal("2000"))

    def test_objective_veto_policy_caps_min_active_day_ratio_at_one(self) -> None:
        policy = frontier._objective_veto_policy(
            consistency_policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("0"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=9,
                min_active_ratio=Decimal("0"),
                min_positive_days=0,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=3,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
            template_defaults={},
            trading_day_count=5,
        )

        self.assertEqual(policy.required_min_active_day_ratio, Decimal("1"))

    def test_microbar_template_enforces_cash_and_gross_exposure_defaults(
        self,
    ) -> None:
        template = frontier.load_family_template("microbar_cross_sectional_pairs_v1")
        policy = frontier._objective_veto_policy(
            consistency_policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("0"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=0,
                min_active_ratio=Decimal("0"),
                min_positive_days=0,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=3,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
                max_gross_exposure_pct_equity=Decimal("999999999"),
                min_cash=Decimal("-999999999"),
            ),
            template_defaults=template.default_hard_vetoes,
            trading_day_count=5,
        )

        self.assertEqual(policy.required_max_gross_exposure_pct_equity, Decimal("1.0"))
        self.assertEqual(policy.required_min_cash, Decimal("0"))

    def test_consistency_penalty_preserves_order_type_execution_metrics(self) -> None:
        payload = self._payload(
            start_date="2026-04-01",
            end_date="2026-04-02",
            daily_net={"2026-04-01": "120", "2026-04-02": "80"},
            decision_count=4,
            filled_count=3,
            wins=2,
            losses=0,
        )
        payload["decision_count_by_order_type"] = {"market": 2, "limit": 2}
        payload["filled_count_by_order_type"] = {"market": 2, "limit": 1}
        payload["limit_fill_rate"] = "0.50"

        _, summary = frontier._consistency_penalty(
            full_window_payload=payload,
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("10"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=1,
                min_active_ratio=Decimal("0"),
                min_positive_days=1,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=2,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
        )

        self.assertEqual(
            summary["decision_count_by_order_type"], {"market": 2, "limit": 2}
        )
        self.assertEqual(
            summary["filled_count_by_order_type"], {"market": 2, "limit": 1}
        )
        self.assertEqual(summary["limit_fill_rate"], "0.50")
        self.assertEqual(summary["market_limit_order_mix_sample_count"], 4)
        self.assertEqual(summary["limit_fill_probability_sample_count"], 2)
        self.assertTrue(summary["market_limit_order_mix_evidence_present"])
        self.assertTrue(summary["limit_fill_probability_evidence_present"])
