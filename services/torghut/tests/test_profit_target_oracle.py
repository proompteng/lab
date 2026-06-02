from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
    evaluate_profit_target_oracle,
)


def _executable_scorecard_fields() -> dict[str, object]:
    return {
        "executable_replay_passed": True,
        "executable_replay_artifact_ref": "/tmp/executable-replay.json",
        "executable_replay_order_count": 4,
        "executable_replay_account_buying_power": "20000",
        "executable_replay_max_notional_per_trade": "10000",
        "exact_replay_ledger_artifact_ref": "/tmp/exact-replay-ledger.json",
        "exact_replay_ledger_artifact_row_count": 20,
        "exact_replay_ledger_artifact_fill_count": 20,
        "portfolio_post_cost_net_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "portfolio_post_cost_net_pnl_source": "exact_replay_runtime_ledger",
        "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "runtime_ledger_pnl_source": "runtime_ledger",
        "market_impact_stress_passed": True,
        "market_impact_stress_artifact_ref": "/tmp/market-impact-stress.json",
        "market_impact_stress_model": "square_root",
        "market_impact_stress_cost_bps": "6",
        "market_impact_liquidity_evidence_present": True,
        "market_impact_stress_net_pnl_per_day": "535",
        "implementation_uncertainty_required": True,
        "implementation_uncertainty_model": "impact_latency_cost_model_interval",
        "implementation_uncertainty_model_count": 5,
        "implementation_uncertainty_stability_passed": True,
        "implementation_uncertainty_lower_net_pnl_per_day": "515",
        "implementation_uncertainty_upper_net_pnl_per_day": "540",
        "implementation_uncertainty_interval_width_per_day": "25",
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_artifact_ref": "/tmp/delay-adjusted-depth-stress.json",
        "delay_adjusted_depth_stress_model": "latency_depth_haircut",
        "delay_adjusted_depth_stress_ms": "250",
        "delay_adjusted_depth_latency_grid_ms": ["50", "150", "250"],
        "delay_adjusted_depth_grid_max_stress_ms": "250",
        "delay_adjusted_depth_liquidity_evidence_present": True,
        "delay_adjusted_depth_liquidity_missing_day_count": 0,
        "delay_adjusted_depth_fillable_notional_per_day": "525000",
        "delay_adjusted_depth_worst_active_day_fillable_notional": "525000",
        "delay_adjusted_depth_p10_active_day_fillable_notional": "525000",
        "delay_adjusted_depth_tail_coverage_passed": True,
        "queue_position_survival_fill_curve_evidence_present": True,
        "queue_position_survival_sample_count": 20,
        "queue_position_survival_fill_rate": "0.85",
        "queue_position_survival_queue_ratio_p95": "0.25",
        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
        "queue_position_survival_queue_ahead_depletion_sample_count": 20,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 20,
        "delay_adjusted_depth_fill_survival_evidence_present": True,
        "delay_adjusted_depth_fill_survival_sample_count": 20,
        "delay_adjusted_depth_fill_survival_rate": "0.85",
        "fill_survival_evidence_present": True,
        "fill_survival_sample_count": 20,
        "fill_survival_fill_rate": "0.85",
        "delay_adjusted_depth_stress_net_pnl_per_day": "520",
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "515",
        "double_oos_passed": True,
        "double_oos_artifact_ref": "/tmp/double-oos-report.json",
        "double_oos_independent_window_count": 2,
        "double_oos_pass_rate": "1",
        "double_oos_net_pnl_per_day": "530",
        "double_oos_cost_shock_net_pnl_per_day": "515",
    }


def _passing_scorecard() -> dict[str, object]:
    return {
        "net_pnl_per_day": "535",
        "active_day_ratio": "1",
        "positive_day_ratio": "1",
        "best_day_share": "0.23",
        "max_single_day_contribution_share": "0.23",
        "max_cluster_contribution_share": "0.34",
        "max_single_symbol_contribution_share": "0.25",
        "worst_day_loss": "0",
        "max_drawdown": "0",
        "avg_filled_notional_per_day": "700000",
        "regime_slice_pass_rate": "0.55",
        "posterior_edge_lower": "0.01",
        "shadow_parity_status": "within_budget",
        "trading_day_count": 20,
        "daily_net": {f"2026-04-{day:02d}": "535" for day in range(1, 21)},
        **_executable_scorecard_fields(),
    }


def _check_by_metric(result: dict[str, object], metric: str) -> dict[str, object]:
    checks = result["checks"]
    assert isinstance(checks, list)
    for check in checks:
        assert isinstance(check, dict)
        if check.get("metric") == metric:
            return check
    raise AssertionError(f"missing check: {metric}")


class TestProfitTargetOracle(TestCase):
    def test_profit_target_oracle_accepts_full_doc71_contract(self) -> None:
        result = evaluate_profit_target_oracle(
            _passing_scorecard(),
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])
        self.assertEqual(result["blockers"], [])

    def test_profit_target_oracle_uses_target_implied_floor_for_8_bps_edge(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "avg_filled_notional_per_day": "625000",
            "observed_post_cost_expectancy_bps": "8",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])
        self.assertEqual(
            Decimal(str(result["target_implied_min_avg_filled_notional_per_day"])),
            Decimal("625000"),
        )
        self.assertEqual(
            Decimal(str(result["effective_min_avg_filled_notional_per_day"])),
            Decimal("625000"),
        )
        scale_check = _check_by_metric(result, "avg_filled_notional_per_day")
        self.assertEqual(Decimal(str(scale_check["threshold"])), Decimal("625000"))
        self.assertEqual(result["observed_post_cost_expectancy_bps"], "8")
        gate = result["target_implied_notional_gate"]
        self.assertIsInstance(gate, dict)
        self.assertEqual(
            gate["observed_post_cost_expectancy_bps_source"],
            "observed_post_cost_expectancy_bps",
        )
        for key in (
            "promotion_allowed",
            "final_promotion_allowed",
            "final_authority_ok",
            "runtime_ledger_authority",
        ):
            self.assertIsNot(result.get(key), True)
            self.assertIsNot(gate.get(key), True)

    def test_profit_target_oracle_uses_target_implied_floor_for_5_bps_edge(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "avg_filled_notional_per_day": "1000000",
            "observed_post_cost_expectancy_bps": "5",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])
        self.assertEqual(
            Decimal(str(result["target_implied_min_avg_filled_notional_per_day"])),
            Decimal("1000000"),
        )
        self.assertEqual(
            Decimal(str(result["effective_min_avg_filled_notional_per_day"])),
            Decimal("1000000"),
        )

    def test_profit_target_oracle_rejects_missing_or_non_positive_expectancy(
        self,
    ) -> None:
        for expectancy_bps in ("0", "-1"):
            with self.subTest(expectancy_bps=expectancy_bps):
                scorecard = {
                    **_passing_scorecard(),
                    "observed_post_cost_expectancy_bps": expectancy_bps,
                }

                result = evaluate_profit_target_oracle(
                    scorecard,
                    target_net_pnl_per_day=Decimal("500"),
                )

                self.assertFalse(result["passed"])
                self.assertIn(
                    "target_implied_post_cost_expectancy_bps_failed",
                    result["blockers"],
                )
                gate = result["target_implied_notional_gate"]
                self.assertIsInstance(gate, dict)
                self.assertIn(
                    "target_implied_post_cost_expectancy_bps_missing_or_non_positive",
                    gate["blockers"],
                )

        scorecard_without_notional = {
            key: value
            for key, value in _passing_scorecard().items()
            if key != "avg_filled_notional_per_day"
        }
        result = evaluate_profit_target_oracle(
            scorecard_without_notional,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "target_implied_avg_filled_notional_per_day_failed",
            result["blockers"],
        )
        self.assertIn(
            "target_implied_post_cost_expectancy_bps_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_keeps_strong_fixed_floor_as_lower_bound(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "avg_filled_notional_per_day": "700000",
            "observed_post_cost_expectancy_bps": "8",
        }
        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
            policy=ProfitTargetOraclePolicy(
                min_avg_filled_notional_per_day=Decimal("750000")
            ),
        )

        self.assertFalse(result["passed"])
        self.assertIn("avg_filled_notional_per_day_failed", result["blockers"])
        self.assertEqual(
            Decimal(str(result["target_implied_min_avg_filled_notional_per_day"])),
            Decimal("625000"),
        )
        self.assertEqual(
            Decimal(str(result["effective_min_avg_filled_notional_per_day"])),
            Decimal("750000"),
        )
        scale_check = _check_by_metric(result, "avg_filled_notional_per_day")
        self.assertEqual(Decimal(str(scale_check["threshold"])), Decimal("750000"))

    def test_profit_target_oracle_rejects_missing_fill_survival(self) -> None:
        scorecard = {
            **_passing_scorecard(),
            "queue_position_survival_fill_curve_evidence_present": False,
            "queue_position_survival_sample_count": 0,
            "queue_position_survival_fill_rate": "0",
            "delay_adjusted_depth_fill_survival_evidence_present": False,
            "delay_adjusted_depth_fill_survival_sample_count": 0,
            "delay_adjusted_depth_fill_survival_rate": "0",
            "fill_survival_evidence_present": False,
            "fill_survival_sample_count": 0,
            "fill_survival_fill_rate": "0",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "queue_position_survival_fill_curve_evidence_present_failed",
            result["blockers"],
        )
        self.assertIn("fill_survival_evidence_present_failed", result["blockers"])
        self.assertIn("fill_survival_sample_count_failed", result["blockers"])
        self.assertIn("fill_survival_rate_failed", result["blockers"])

    def test_profit_target_oracle_rejects_fill_survival_without_queue_ahead_depletion(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "queue_position_survival_queue_ahead_depletion_evidence_present": False,
            "queue_position_survival_queue_ahead_depletion_sample_count": 0,
            "delay_adjusted_depth_queue_ahead_depletion_evidence_present": False,
            "delay_adjusted_depth_queue_ahead_depletion_sample_count": 0,
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "queue_ahead_depletion_evidence_present_failed", result["blockers"]
        )
        self.assertIn("queue_ahead_depletion_sample_count_failed", result["blockers"])

    def test_profit_target_oracle_rejects_zero_fill_survival_rate(self) -> None:
        scorecard = {
            **_passing_scorecard(),
            "queue_position_survival_fill_rate": "0",
            "delay_adjusted_depth_fill_survival_rate": "0",
            "fill_survival_fill_rate": "0",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("fill_survival_rate_failed", result["blockers"])

    def test_profit_target_oracle_rejects_almgren_chriss_proxy_impact(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "market_impact_stress_model": "almgren_chriss_proxy",
            "market_impact_stress_cost_bps": "150",
            "market_impact_stress_net_pnl_per_day": "510",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("market_impact_stress_model_failed", result["blockers"])

    def test_profit_target_oracle_enforces_mpc_dynamic_schedule_overlay(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "mechanism_overlay_ids": ["mpc_dynamic_execution_schedule"],
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("execution_schedule_trace_present_failed", result["blockers"])
        self.assertIn("liquidity_forecast_present_failed", result["blockers"])
        self.assertIn("inventory_path_trace_present_failed", result["blockers"])
        self.assertIn(
            "mpc_execution_shortfall_evidence_present_failed", result["blockers"]
        )
        self.assertIn("mpc_route_tca_evidence_present_failed", result["blockers"])
        self.assertIn(
            "mpc_schedule_shortfall_ablation_passed_failed", result["blockers"]
        )
        self.assertIn("mpc_schedule_trace_sample_count_failed", result["blockers"])
        self.assertIn("mpc_schedule_shortfall_bps_failed", result["blockers"])
        self.assertIn(
            "mpc_schedule_shortfall_net_pnl_per_day_failed", result["blockers"]
        )

    def test_profit_target_oracle_accepts_mpc_dynamic_schedule_overlay_with_real_evidence(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "mechanism_overlay_ids": ["mpc_dynamic_execution_schedule"],
            "execution_schedule_trace_artifact_ref": "/tmp/mpc-schedule-trace.json",
            "execution_schedule_trace_sample_count": 80,
            "liquidity_forecast_artifact_ref": "/tmp/mpc-liquidity-forecast.json",
            "inventory_path_trace_artifact_ref": "/tmp/mpc-inventory-path.json",
            "execution_shortfall_artifact_ref": "/tmp/mpc-shortfall.json",
            "route_tca_artifact_ref": "/tmp/mpc-route-tca.json",
            "mpc_schedule_shortfall_ablation_passed": True,
            "mpc_schedule_shortfall_ablation_artifact_ref": "/tmp/mpc-ablation.json",
            "mpc_schedule_shortfall_bps": "6",
            "mpc_schedule_shortfall_net_pnl_per_day": "520",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])
        self.assertNotIn("execution_schedule_trace_present_failed", result["blockers"])

    def test_profit_target_oracle_rejects_implementation_uncertainty_below_target(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "implementation_uncertainty_stability_passed": False,
            "implementation_uncertainty_lower_net_pnl_per_day": "499.99",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "implementation_uncertainty_stability_passed_failed",
            result["blockers"],
        )
        self.assertIn(
            "implementation_uncertainty_lower_net_pnl_per_day_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_rejects_conformal_tail_risk_below_target(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "conformal_tail_risk_required": True,
            "conformal_tail_risk_passed": False,
            "conformal_tail_risk_sample_count": 20,
            "conformal_tail_risk_buffer_per_day": "175",
            "conformal_tail_risk_adjusted_net_pnl_per_day": "499.99",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("conformal_tail_risk_passed_failed", result["blockers"])
        self.assertIn(
            "conformal_tail_risk_adjusted_net_pnl_per_day_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_requires_rejected_signal_outcome_learning_when_declared(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "requires_rejected_signal_outcome_learning": True,
            "rejected_signal_outcome_labeled_count": 119,
            "rejected_signal_outcome_pending_ratio": "0.06",
            "rejected_signal_reason_coverage": "0.79",
            "rejected_signal_counterfactual_fields": [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
            ],
            "rejected_signal_outcome_persistence_state": "stale",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "rejected_signal_outcome_labeled_count_failed", result["blockers"]
        )
        self.assertIn(
            "rejected_signal_outcome_pending_ratio_failed", result["blockers"]
        )
        self.assertIn("rejected_signal_reason_coverage_failed", result["blockers"])
        self.assertIn(
            "rejected_signal_counterfactual_fields_present_failed",
            result["blockers"],
        )
        self.assertIn(
            "rejected_signal_outcome_persistence_state_failed", result["blockers"]
        )

    def test_profit_target_oracle_accepts_rejected_signal_outcome_learning_contract(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "mechanism_overlay_ids": ["rejected_signal_outcome_calibration"],
            "rejected_signal_outcome_labeled_count": 120,
            "rejected_signal_outcome_pending_ratio": "0.05",
            "rejected_signal_reason_coverage": "0.80",
            "rejected_signal_counterfactual_fields_present": True,
            "rejected_signal_outcome_persistence_state": "ok",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])

    def test_profit_target_oracle_rejects_alpha_decay_overlay_without_stress(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "mechanism_overlay_ids": ["alpha_decay_predictability_stress"],
            "predictability_decay_stress_passed": False,
            "horizon_decay_curve_present": False,
            "spread_adjusted_label_replay_present": False,
            "predictability_decay_stress_horizon_count": 2,
            "tight_spread_regime_slice_count": 19,
            "predictability_decay_stress_split_pass_rate": "0.59",
            "predictability_decay_stress_best_split_share": "0.36",
            "post_cost_net_pnl_after_predictability_decay_stress": "499.99",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("predictability_decay_stress_passed_failed", result["blockers"])
        self.assertIn(
            "predictability_decay_stress_artifact_present_failed",
            result["blockers"],
        )
        self.assertIn("horizon_decay_curve_present_failed", result["blockers"])
        self.assertIn("spread_adjusted_label_replay_present_failed", result["blockers"])
        self.assertIn(
            "predictability_decay_stress_horizon_count_failed",
            result["blockers"],
        )
        self.assertIn("tight_spread_regime_slice_count_failed", result["blockers"])
        self.assertIn(
            "predictability_decay_stress_split_pass_rate_failed",
            result["blockers"],
        )
        self.assertIn(
            "predictability_decay_stress_best_split_share_failed",
            result["blockers"],
        )
        self.assertIn(
            "post_cost_net_pnl_after_predictability_decay_stress_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_accepts_alpha_decay_stress_contract(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "requires_predictability_decay_stress": True,
            "predictability_decay_stress_passed": True,
            "predictability_decay_stress_artifact_ref": "/tmp/alpha-decay.json",
            "horizon_decay_curve_present": True,
            "spread_adjusted_label_replay_present": True,
            "predictability_decay_stress_horizon_count": 3,
            "tight_spread_regime_slice_count": 20,
            "predictability_decay_stress_split_pass_rate": "0.60",
            "predictability_decay_stress_best_split_share": "0.35",
            "post_cost_net_pnl_after_predictability_decay_stress": "505",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])

    def test_profit_target_oracle_rejects_market_limit_policy_without_order_type_tca_evidence(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"],
            "order_type_ablation_sample_count": 59,
            "order_type_opportunity_cost_bps": "9",
            "market_order_spread_bps": "9",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("order_type_ablation_passed_failed", result["blockers"])
        self.assertIn("order_type_ablation_artifact_present_failed", result["blockers"])
        self.assertIn("order_type_ablation_sample_count_failed", result["blockers"])
        self.assertIn(
            "market_limit_order_mix_evidence_present_failed", result["blockers"]
        )
        self.assertIn(
            "limit_fill_probability_evidence_present_failed", result["blockers"]
        )
        self.assertIn("price_improvement_evidence_present_failed", result["blockers"])
        self.assertIn("opportunity_cost_evidence_present_failed", result["blockers"])
        self.assertIn("execution_shortfall_evidence_present_failed", result["blockers"])
        self.assertIn("route_tca_evidence_present_failed", result["blockers"])
        self.assertIn("order_type_opportunity_cost_bps_failed", result["blockers"])
        self.assertIn("market_order_spread_bps_failed", result["blockers"])

    def test_profit_target_oracle_accepts_market_limit_policy_with_order_type_tca_evidence(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "requires_order_type_execution_quality": True,
            "order_type_ablation_passed": True,
            "order_type_ablation_artifact_ref": "/tmp/order-type-ablation.json",
            "order_type_ablation_sample_count": 60,
            "market_limit_order_mix_evidence_present": True,
            "limit_fill_probability_evidence_present": True,
            "price_improvement_evidence_present": True,
            "opportunity_cost_evidence_present": True,
            "execution_shortfall_evidence_present": True,
            "route_tca_artifact_ref": "/tmp/route-tca.json",
            "order_type_opportunity_cost_bps": "8",
            "market_order_spread_bps": "8",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])

    def test_profit_target_oracle_rejects_route_tca_without_durable_artifact(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "requires_order_type_execution_quality": True,
            "order_type_ablation_passed": True,
            "order_type_ablation_artifact_ref": "/tmp/order-type-ablation.json",
            "order_type_ablation_sample_count": 60,
            "market_limit_order_mix_evidence_present": True,
            "limit_fill_probability_evidence_present": True,
            "price_improvement_evidence_present": True,
            "opportunity_cost_evidence_present": True,
            "execution_shortfall_evidence_present": True,
            "route_tca_evidence_present": True,
            "order_type_opportunity_cost_bps": "8",
            "market_order_spread_bps": "8",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("route_tca_evidence_present_failed", result["blockers"])

    def test_profit_target_oracle_rejects_route_tca_as_order_type_ablation_artifact(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "requires_order_type_execution_quality": True,
            "order_type_ablation_passed": True,
            "order_type_execution_artifact_ref": "/tmp/order-type-execution.json",
            "order_type_ablation_sample_count": 60,
            "market_limit_order_mix_evidence_present": True,
            "limit_fill_probability_evidence_present": True,
            "price_improvement_evidence_present": True,
            "opportunity_cost_evidence_present": True,
            "execution_shortfall_evidence_present": True,
            "route_tca_artifact_ref": "/tmp/route-tca.json",
            "order_type_opportunity_cost_bps": "8",
            "market_order_spread_bps": "8",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("order_type_ablation_artifact_present_failed", result["blockers"])

    def test_profit_target_oracle_rejects_pending_validation_contract_evidence(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "validation_contract_pending_count": 1,
            "validation_live_paper_parity_pending_count": 1,
            "synthetic_evidence_not_promotion_proof_count": 1,
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("validation_contract_pending_count_failed", result["blockers"])
        self.assertIn(
            "validation_live_paper_parity_pending_count_failed",
            result["blockers"],
        )
        self.assertIn(
            "synthetic_evidence_not_promotion_proof_count_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_rejects_missing_market_impact_stress(
        self,
    ) -> None:
        scorecard = _passing_scorecard()
        for key in tuple(scorecard):
            if key.startswith("market_impact"):
                del scorecard[key]

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("market_impact_stress_passed_failed", result["blockers"])
        self.assertIn(
            "market_impact_stress_artifact_present_failed", result["blockers"]
        )
        self.assertIn("market_impact_stress_model_failed", result["blockers"])
        self.assertIn("market_impact_stress_cost_bps_failed", result["blockers"])
        self.assertIn("market_impact_stress_net_pnl_per_day_failed", result["blockers"])
        self.assertIn(
            "market_impact_liquidity_evidence_present_failed", result["blockers"]
        )

    def test_profit_target_oracle_rejects_failed_market_impact_stress(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "market_impact_stress_passed": False,
            "market_impact_stress_model": "linear_fixed_bps",
            "market_impact_stress_cost_bps": "0",
            "market_impact_stress_net_pnl_per_day": "420",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("market_impact_stress_passed_failed", result["blockers"])
        self.assertIn("market_impact_stress_model_failed", result["blockers"])
        self.assertIn("market_impact_stress_cost_bps_failed", result["blockers"])
        self.assertIn("market_impact_stress_net_pnl_per_day_failed", result["blockers"])

    def test_profit_target_oracle_rejects_market_impact_proxy_liquidity(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "market_impact_liquidity_evidence_present": False,
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "market_impact_liquidity_evidence_present_failed", result["blockers"]
        )

    def test_profit_target_oracle_rejects_missing_delay_adjusted_depth_stress(
        self,
    ) -> None:
        scorecard = _passing_scorecard()
        for key in tuple(scorecard):
            if key.startswith("delay_adjusted_depth_stress") or key.startswith(
                "delay_adjusted_depth_fillable"
            ):
                del scorecard[key]

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("delay_adjusted_depth_stress_passed_failed", result["blockers"])
        self.assertIn(
            "delay_adjusted_depth_stress_artifact_present_failed",
            result["blockers"],
        )
        self.assertIn("delay_adjusted_depth_stress_model_failed", result["blockers"])
        self.assertIn("delay_adjusted_depth_stress_ms_failed", result["blockers"])
        self.assertIn(
            "delay_adjusted_depth_fillable_notional_per_day_failed",
            result["blockers"],
        )
        self.assertIn(
            "delay_adjusted_depth_stress_net_pnl_per_day_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_rejects_failed_delay_adjusted_depth_stress(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "delay_adjusted_depth_stress_passed": False,
            "delay_adjusted_depth_stress_model": "optimistic_no_delay_fill",
            "delay_adjusted_depth_stress_ms": "0",
            "delay_adjusted_depth_fillable_notional_per_day": "250000",
            "delay_adjusted_depth_stress_net_pnl_per_day": "460",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("delay_adjusted_depth_stress_passed_failed", result["blockers"])
        self.assertIn("delay_adjusted_depth_stress_model_failed", result["blockers"])
        self.assertIn("delay_adjusted_depth_stress_ms_failed", result["blockers"])
        self.assertIn(
            "delay_adjusted_depth_fillable_notional_per_day_failed",
            result["blockers"],
        )
        self.assertIn(
            "delay_adjusted_depth_stress_net_pnl_per_day_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_rejects_missing_delay_depth_liquidity_evidence(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "delay_adjusted_depth_liquidity_evidence_present": False,
            "delay_adjusted_depth_liquidity_missing_day_count": 1,
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "delay_adjusted_depth_liquidity_evidence_present_failed",
            result["blockers"],
        )
        self.assertIn(
            "delay_adjusted_depth_liquidity_missing_day_count_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_rejects_missing_delay_depth_tail_grid(self) -> None:
        scorecard = {
            **_passing_scorecard(),
            "delay_adjusted_depth_latency_grid_ms": ["50"],
            "delay_adjusted_depth_grid_max_stress_ms": "50",
            "delay_adjusted_depth_tail_coverage_passed": False,
            "delay_adjusted_depth_worst_active_day_fillable_notional": "250000",
            "delay_adjusted_depth_p10_active_day_fillable_notional": "260000",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("delay_adjusted_depth_latency_grid_ms_failed", result["blockers"])
        self.assertIn(
            "delay_adjusted_depth_grid_max_stress_ms_failed",
            result["blockers"],
        )
        self.assertIn(
            "delay_adjusted_depth_tail_coverage_passed_failed",
            result["blockers"],
        )
        self.assertIn(
            "delay_adjusted_depth_worst_active_day_fillable_notional_failed",
            result["blockers"],
        )
        self.assertIn(
            "delay_adjusted_depth_p10_active_day_fillable_notional_failed",
            result["blockers"],
        )

    def test_profit_target_oracle_rejects_missing_double_oos_proof(self) -> None:
        scorecard = _passing_scorecard()
        for key in tuple(scorecard):
            if key.startswith("double_oos"):
                del scorecard[key]

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("double_oos_passed_failed", result["blockers"])
        self.assertIn("double_oos_artifact_present_failed", result["blockers"])
        self.assertIn("double_oos_independent_window_count_failed", result["blockers"])
        self.assertIn("double_oos_pass_rate_failed", result["blockers"])
        self.assertIn("double_oos_net_pnl_per_day_failed", result["blockers"])
        self.assertIn(
            "double_oos_cost_shock_net_pnl_per_day_failed", result["blockers"]
        )

    def test_profit_target_oracle_rejects_single_double_oos_window(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                **_passing_scorecard(),
                "double_oos_independent_window_count": 1,
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("double_oos_independent_window_count_failed", result["blockers"])

    def test_profit_target_oracle_rejects_double_oos_cost_shock_below_target(
        self,
    ) -> None:
        result = evaluate_profit_target_oracle(
            {
                **_passing_scorecard(),
                "double_oos_cost_shock_net_pnl_per_day": "499.99",
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn(
            "double_oos_cost_shock_net_pnl_per_day_failed", result["blockers"]
        )

    def test_profit_target_oracle_accepts_controlled_down_days(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "640",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.75",
                "daily_net": {
                    "2026-04-01": "900",
                    "2026-04-02": "-200",
                    "2026-04-03": "760",
                    "2026-04-06": "1100",
                },
                "trading_day_count": 4,
                "best_day_share": "0.24",
                "max_single_day_contribution_share": "0.24",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "200",
                "max_drawdown": "200",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
            policy=ProfitTargetOraclePolicy(min_observed_trading_days=4),
        )

        self.assertTrue(result["passed"])
        self.assertEqual(result["policy"]["min_daily_net_pnl"], "-999999999")

    def test_profit_target_oracle_allows_drawdown_when_return_quality_is_strong(
        self,
    ) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "9666.67",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.67",
                "daily_net": {
                    "2026-04-01": "-2400",
                    "2026-04-02": "17000",
                    "2026-04-03": "15000",
                },
                "trading_day_count": 3,
                "start_equity": "31590.02",
                "best_day_share": "0.24",
                "max_single_day_contribution_share": "0.24",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "2400",
                "max_drawdown": "3000",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
            policy=ProfitTargetOraclePolicy(min_observed_trading_days=3),
        )

        self.assertTrue(result["passed"])
        worst_day_check = next(
            item for item in result["checks"] if item["metric"] == "worst_day_loss"
        )
        self.assertEqual(worst_day_check["mode"], "return_adjusted")

    def test_profit_target_oracle_rejects_tiny_complete_window(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "900",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "daily_net": {
                    "2026-04-01": "900",
                    "2026-04-02": "900",
                    "2026-04-03": "900",
                    "2026-04-06": "900",
                },
                "trading_day_count": 4,
                "best_day_share": "0.24",
                "max_single_day_contribution_share": "0.24",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("min_observed_trading_days_failed", result["blockers"])
        sample_check = next(
            item
            for item in result["checks"]
            if item["metric"] == "min_observed_trading_days"
        )
        self.assertEqual(sample_check["threshold"], "20")

    def test_profit_target_oracle_rejects_drawdown_above_extended_percent_cap(
        self,
    ) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "12000",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.67",
                "daily_net": {
                    "2026-04-01": "-5000",
                    "2026-04-02": "22000",
                    "2026-04-03": "21000",
                },
                "trading_day_count": 3,
                "start_equity": "31590.02",
                "best_day_share": "0.24",
                "max_single_day_contribution_share": "0.24",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "5000",
                "max_drawdown": "5000",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("worst_day_loss_failed", result["blockers"])
        self.assertIn("max_drawdown_failed", result["blockers"])

    def test_profit_target_oracle_rejects_weak_profit_factor(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "700",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.60",
                "profit_factor": "1.20",
                "start_equity": "31590.02",
                "best_day_share": "0.24",
                "max_single_day_contribution_share": "0.24",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("profit_factor_failed", result["blockers"])
        self.assertEqual(result["policy"]["min_profit_factor"], "1.50")

    def test_profit_target_oracle_can_require_every_day_to_clear_target(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "500",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.40",
                "max_single_day_contribution_share": "0.40",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
                "daily_net": {
                    "2026-04-01": "900",
                    "2026-04-02": "299.99",
                    "2026-04-03": "300",
                },
            },
            target_net_pnl_per_day=Decimal("300"),
            policy=ProfitTargetOraclePolicy(
                min_active_day_ratio=Decimal("1"),
                min_positive_day_ratio=Decimal("1"),
                min_daily_net_pnl=Decimal("300"),
                max_best_day_share=Decimal("0.60"),
                max_worst_day_loss=Decimal("0"),
                max_drawdown=Decimal("0"),
            ),
        )

        self.assertFalse(result["passed"])
        self.assertIn("min_daily_net_pnl_failed", result["blockers"])

    def test_profit_target_oracle_fails_missing_daily_coverage(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "500",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.40",
                "max_single_day_contribution_share": "0.40",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
                "trading_day_count": 3,
                "daily_net": {
                    "2026-04-01": "900",
                    "2026-04-03": "600",
                },
            },
            target_net_pnl_per_day=Decimal("300"),
            policy=ProfitTargetOraclePolicy(
                min_active_day_ratio=Decimal("1"),
                min_positive_day_ratio=Decimal("1"),
                min_daily_net_pnl=Decimal("300"),
                max_best_day_share=Decimal("0.60"),
                max_worst_day_loss=Decimal("0"),
                max_drawdown=Decimal("0"),
            ),
        )

        self.assertFalse(result["passed"])
        self.assertIn("min_daily_net_pnl_failed", result["blockers"])
        self.assertIn("daily_net_observed_day_count_failed", result["blockers"])

    def test_profit_target_oracle_fails_missing_sleeve_daily_coverage(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "700",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.25",
                "max_single_day_contribution_share": "0.25",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                "missing_sleeve_daily_net_count": 1,
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("missing_sleeve_daily_net_count_failed", result["blockers"])

    def test_profit_target_oracle_reports_failed_criteria(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "499",
                "active_day_ratio": "0.5",
                "positive_day_ratio": "0.5",
                "best_day_share": "0.9",
                "worst_day_loss": "500",
                "max_drawdown": "1000",
                "avg_filled_notional_per_day": "10",
                "regime_slice_pass_rate": "0.1",
                "posterior_edge_lower": "0",
                "shadow_parity_status": "missing",
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("portfolio_post_cost_net_pnl_per_day_failed", result["blockers"])
        self.assertIn("max_cluster_contribution_share_failed", result["blockers"])
        self.assertIn("max_single_symbol_contribution_share_failed", result["blockers"])
        self.assertIn("shadow_parity_status_failed", result["blockers"])

    def test_profit_target_oracle_rejects_pnl_only_replay_without_executable_proof(
        self,
    ) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "800",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.20",
                "max_single_day_contribution_share": "0.20",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
            },
            target_net_pnl_per_day=Decimal("300"),
            policy=ProfitTargetOraclePolicy(
                min_active_day_ratio=Decimal("1"),
                min_positive_day_ratio=Decimal("1"),
                min_daily_net_pnl=Decimal("300"),
                max_best_day_share=Decimal("0.60"),
                max_worst_day_loss=Decimal("0"),
                max_drawdown=Decimal("0"),
            ),
        )

        self.assertFalse(result["passed"])
        self.assertIn("executable_replay_passed_failed", result["blockers"])
        self.assertIn("executable_replay_artifact_present_failed", result["blockers"])
        self.assertIn("executable_replay_order_count_failed", result["blockers"])
        self.assertIn("exact_replay_ledger_artifact_present_failed", result["blockers"])

    def test_profit_target_oracle_rejects_missing_exact_replay_ledger(self) -> None:
        scorecard = {
            key: value
            for key, value in _passing_scorecard().items()
            if not key.startswith("exact_replay_ledger_")
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("exact_replay_ledger_artifact_present_failed", result["blockers"])
        self.assertIn(
            "exact_replay_ledger_artifact_row_count_failed", result["blockers"]
        )
        self.assertIn(
            "exact_replay_ledger_artifact_fill_count_failed", result["blockers"]
        )

    def test_profit_target_oracle_rejects_proxy_pnl_with_copied_ledger_counts(
        self,
    ) -> None:
        scorecard = {
            **_passing_scorecard(),
            "portfolio_post_cost_net_pnl_basis": "simulation_report_net_pnl",
            "portfolio_post_cost_net_pnl_source": "simulation_report",
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("portfolio_post_cost_net_pnl_basis_failed", result["blockers"])
        self.assertIn("portfolio_post_cost_net_pnl_source_failed", result["blockers"])

    def test_profit_target_oracle_rejects_missing_ledger_pnl_authority(
        self,
    ) -> None:
        scorecard = {
            key: value
            for key, value in _passing_scorecard().items()
            if key
            not in {
                "portfolio_post_cost_net_pnl_basis",
                "portfolio_post_cost_net_pnl_source",
                "runtime_ledger_pnl_basis",
                "runtime_ledger_pnl_source",
            }
        }

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("portfolio_post_cost_net_pnl_basis_failed", result["blockers"])
        self.assertIn("portfolio_post_cost_net_pnl_source_failed", result["blockers"])

    def test_profit_target_oracle_rejects_runtime_ledger_artifact_aliases(
        self,
    ) -> None:
        scorecard = {
            key: value
            for key, value in _passing_scorecard().items()
            if not key.startswith("exact_replay_ledger_")
        }
        scorecard.update(
            {
                "runtime_ledger_artifact_ref": "/tmp/runtime-ledger.json",
                "runtime_ledger_artifact_row_count": 20,
                "runtime_ledger_artifact_fill_count": 20,
            }
        )

        result = evaluate_profit_target_oracle(
            scorecard,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("exact_replay_ledger_artifact_present_failed", result["blockers"])
        self.assertIn("exact_replay_ledger_artifact_row_count_failed", result["blockers"])
        self.assertIn("exact_replay_ledger_artifact_fill_count_failed", result["blockers"])

    def test_profit_target_oracle_rejects_capital_unsafe_replay(self) -> None:
        result = evaluate_profit_target_oracle(
            {
                "net_pnl_per_day": "900",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.20",
                "max_single_day_contribution_share": "0.20",
                "max_cluster_contribution_share": "0.34",
                "max_single_symbol_contribution_share": "0.25",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "max_gross_exposure_pct_equity": "1.25",
                "min_cash": "-1",
                "negative_cash_observation_count": 2,
                "avg_filled_notional_per_day": "700000",
                "regime_slice_pass_rate": "0.55",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertFalse(result["passed"])
        self.assertIn("max_gross_exposure_pct_equity_failed", result["blockers"])
        self.assertIn("min_cash_failed", result["blockers"])
        self.assertIn("negative_cash_observation_count_failed", result["blockers"])
