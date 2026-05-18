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
    }


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
                **_executable_scorecard_fields(),
            },
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertTrue(result["passed"])
        self.assertEqual(result["blockers"], [])

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
        )

        self.assertTrue(result["passed"])
        worst_day_check = next(
            item for item in result["checks"] if item["metric"] == "worst_day_loss"
        )
        self.assertEqual(worst_day_check["mode"], "return_adjusted")

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
