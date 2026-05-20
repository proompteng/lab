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
        "market_impact_stress_passed": True,
        "market_impact_stress_artifact_ref": "/tmp/market-impact-stress.json",
        "market_impact_stress_model": "square_root",
        "market_impact_stress_cost_bps": "6",
        "market_impact_liquidity_evidence_present": True,
        "market_impact_stress_net_pnl_per_day": "535",
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_artifact_ref": "/tmp/delay-adjusted-depth-stress.json",
        "delay_adjusted_depth_stress_model": "latency_depth_haircut",
        "delay_adjusted_depth_stress_ms": "250",
        "delay_adjusted_depth_liquidity_evidence_present": True,
        "delay_adjusted_depth_liquidity_missing_day_count": 0,
        "delay_adjusted_depth_fillable_notional_per_day": "525000",
        "delay_adjusted_depth_stress_net_pnl_per_day": "520",
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


class TestProfitTargetOracle(TestCase):
    def test_profit_target_oracle_accepts_full_doc71_contract(self) -> None:
        result = evaluate_profit_target_oracle(
            _passing_scorecard(),
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])
        self.assertEqual(result["blockers"], [])

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
