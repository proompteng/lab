from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy, evaluate_profit_target_oracle


class TestProfitTargetOracle(TestCase):
    def test_profit_target_oracle_accepts_full_doc71_contract(self) -> None:
        result = evaluate_profit_target_oracle(
            {
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
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])
        self.assertEqual(result["blockers"], [])

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
