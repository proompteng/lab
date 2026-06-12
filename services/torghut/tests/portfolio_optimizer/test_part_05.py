from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.portfolio_optimizer.support import *


class TestPortfolioOptimizerPart5(_TestPortfolioOptimizerBase):
    def test_optimizer_prefers_lower_concentration_before_raw_pnl_when_blocked(
        self,
    ) -> None:
        def bundle(
            *,
            candidate_id: str,
            symbol: str,
            cluster: str,
            daily_net: tuple[str, str, str, str, str],
        ) -> CandidateEvidenceBundle:
            net_pnl = str(sum(Decimal(value) for value in daily_net) / Decimal("5"))
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": net_pnl,
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "350000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": cluster,
                        "symbol_contribution_shares": {symbol: "1.0"},
                        **_executable_scorecard_fields(candidate_id),
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": daily_net[0],
                            "2026-02-24": daily_net[1],
                            "2026-02-25": daily_net[2],
                            "2026-02-26": daily_net[3],
                            "2026-02-27": daily_net[4],
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "350000",
                            "2026-02-24": "350000",
                            "2026-02-25": "350000",
                            "2026-02-26": "350000",
                            "2026-02-27": "350000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-concentration-first",
                result_path=f"/tmp/{candidate_id}.json",
            )

        high_concentration_a = ("2000", "100", "100", "100", "100")
        high_concentration_b = ("1600", "100", "1000", "1", "100")
        high_concentration_c = ("1600", "1", "100", "1000", "100")
        lower_concentration_a = ("430", "300", "300", "300", "300")
        lower_concentration_b = ("420", "290", "370", "250", "300")
        lower_concentration_c = ("420", "250", "300", "370", "290")
        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    candidate_id="cand-high-a",
                    symbol="NVDA",
                    cluster="high-a",
                    daily_net=high_concentration_a,
                ),
                bundle(
                    candidate_id="cand-high-b",
                    symbol="AAPL",
                    cluster="high-b",
                    daily_net=high_concentration_b,
                ),
                bundle(
                    candidate_id="cand-high-c",
                    symbol="AMZN",
                    cluster="high-c",
                    daily_net=high_concentration_c,
                ),
                bundle(
                    candidate_id="cand-balanced-a",
                    symbol="GOOGL",
                    cluster="balanced-a",
                    daily_net=lower_concentration_a,
                ),
                bundle(
                    candidate_id="cand-balanced-b",
                    symbol="AMD",
                    cluster="balanced-b",
                    daily_net=lower_concentration_b,
                ),
                bundle(
                    candidate_id="cand-balanced-c",
                    symbol="ORCL",
                    cluster="balanced-c",
                    daily_net=lower_concentration_c,
                ),
            ],
            target_net_pnl_per_day=Decimal("300"),
            oracle_policy=ProfitTargetOraclePolicy(min_observed_trading_days=5),
            portfolio_size_min=3,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertCountEqual(
            portfolio.source_candidate_ids,
            ("cand-balanced-a", "cand-balanced-b", "cand-balanced-c"),
        )
        self.assertLess(
            Decimal(portfolio.objective_scorecard["best_day_share"]),
            Decimal("0.30"),
        )
        self.assertIn(
            "best_day_share_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )

    def test_optimizer_rejects_correlated_sleeves_before_minimum_size(
        self,
    ) -> None:
        def bundle(
            *,
            candidate_id: str,
            net_pnl_per_day: str,
            symbol: str,
            cluster: str,
            daily_net: tuple[str, str, str, str, str],
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": net_pnl_per_day,
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "350000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": cluster,
                        "symbol_contribution_shares": {symbol: "1.0"},
                        **_executable_scorecard_fields(candidate_id),
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": daily_net[0],
                            "2026-02-24": daily_net[1],
                            "2026-02-25": daily_net[2],
                            "2026-02-26": daily_net[3],
                            "2026-02-27": daily_net[4],
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "350000",
                            "2026-02-24": "350000",
                            "2026-02-25": "350000",
                            "2026-02-26": "350000",
                            "2026-02-27": "350000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-correlated-search",
                result_path=f"/tmp/{candidate_id}.json",
            )

        correlated_daily_net = ("0", "900", "0", "0", "0")
        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    candidate_id="cand-correlated-a",
                    net_pnl_per_day="180",
                    symbol="INTC",
                    cluster="correlated-a",
                    daily_net=correlated_daily_net,
                ),
                bundle(
                    candidate_id="cand-correlated-b",
                    net_pnl_per_day="180",
                    symbol="INTC",
                    cluster="correlated-b",
                    daily_net=correlated_daily_net,
                ),
                bundle(
                    candidate_id="cand-correlated-c",
                    net_pnl_per_day="180",
                    symbol="INTC",
                    cluster="correlated-c",
                    daily_net=correlated_daily_net,
                ),
                bundle(
                    candidate_id="cand-diverse-a",
                    net_pnl_per_day="650",
                    symbol="AAPL",
                    cluster="diverse-a",
                    daily_net=("650", "650", "650", "650", "650"),
                ),
                bundle(
                    candidate_id="cand-diverse-b",
                    net_pnl_per_day="650",
                    symbol="AMZN",
                    cluster="diverse-b",
                    daily_net=("650", "650", "650", "650", "650"),
                ),
                bundle(
                    candidate_id="cand-diverse-c",
                    net_pnl_per_day="650",
                    symbol="GOOGL",
                    cluster="diverse-c",
                    daily_net=("650", "650", "650", "650", "650"),
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(min_observed_trading_days=5),
            portfolio_size_min=3,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertFalse(
            {
                "cand-correlated-a",
                "cand-correlated-b",
                "cand-correlated-c",
            }.issubset(set(portfolio.source_candidate_ids))
        )
        self.assertCountEqual(
            portfolio.source_candidate_ids,
            ("cand-diverse-a", "cand-diverse-b", "cand-diverse-c"),
        )
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])
        self.assertIn(
            "correlation_cap",
            {item["reason"] for item in portfolio.optimizer_report["rejections"]},
        )
