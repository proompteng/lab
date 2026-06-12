from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.portfolio_optimizer.support import *


class TestPortfolioOptimizerPart4(_TestPortfolioOptimizerBase):
    def test_invalid_evidence_bundles_are_not_admitted_to_portfolios(self) -> None:
        invalid = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-invalid",
            candidate={
                "candidate_id": "cand-invalid",
                "objective_scorecard": {
                    "net_pnl_per_day": "2000",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "best_day_share": "0.1",
                    "stale_tape": True,
                },
            },
            dataset_snapshot_id="snapshot-stale",
            result_path="/tmp/invalid.json",
        )
        missing_cost_payload = invalid.to_payload()
        missing_cost_payload["candidate_id"] = "cand-missing-cost"
        missing_cost_payload["candidate_spec_id"] = "spec-missing-cost"
        missing_cost_payload["cost_calibration"] = {}
        missing_cost = evidence_bundle_from_payload(missing_cost_payload)

        valid_daily_profiles = [
            ("250", "260", "270", "280", "315"),
            ("315", "280", "270", "260", "250"),
        ]
        valid_bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-valid-{index}",
                candidate={
                    "candidate_id": f"cand-valid-{index}",
                    "objective_scorecard": {
                        "net_pnl_per_day": "275",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.8",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "350000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": f"valid-{index}",
                        "symbol_contribution_shares": {
                            "AAPL": "0.25",
                            "NVDA": "0.25",
                            "MSFT": "0.25",
                            "AMAT": "0.25",
                        },
                        **_executable_scorecard_fields(index),
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": valid_daily_profiles[index][0],
                            "2026-02-24": valid_daily_profiles[index][1],
                            "2026-02-25": valid_daily_profiles[index][2],
                            "2026-02-26": valid_daily_profiles[index][3],
                            "2026-02-27": valid_daily_profiles[index][4],
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
                dataset_snapshot_id="snapshot-valid",
                result_path=f"/tmp/valid-{index}.json",
            )
            for index in range(2)
        ]

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[invalid, missing_cost, *valid_bundles],
            target_net_pnl_per_day=Decimal("500"),
            portfolio_size_min=2,
            portfolio_size_max=4,
        )

        self.assertIn("stale_tape", evidence_bundle_blockers(invalid))
        self.assertIn(
            "cost_calibration_missing", evidence_bundle_blockers(missing_cost)
        )
        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertCountEqual(
            portfolio.source_candidate_ids, ("cand-valid-0", "cand-valid-1")
        )
        invalid_rejections = [
            item
            for item in portfolio.optimizer_report["rejections"]
            if item["reason"] == "invalid_evidence_bundle"
        ]
        self.assertEqual(len(invalid_rejections), 2)

    def test_non_composable_frontier_hard_vetoes_are_not_admitted_to_portfolios(
        self,
    ) -> None:
        def bundle(
            *,
            candidate_id: str,
            net_pnl_per_day: str,
            symbol: str,
            cluster: str,
            hard_vetoes: list[str] | None = None,
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "hard_vetoes": hard_vetoes or [],
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
                            "2026-02-23": net_pnl_per_day,
                            "2026-02-24": net_pnl_per_day,
                            "2026-02-25": net_pnl_per_day,
                            "2026-02-26": net_pnl_per_day,
                            "2026-02-27": net_pnl_per_day,
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
                dataset_snapshot_id="snapshot-hard-veto",
                result_path=f"/tmp/{candidate_id}.json",
            )

        vetoed = bundle(
            candidate_id="cand-vetoed-shock",
            net_pnl_per_day="1200",
            symbol="NVDA",
            cluster="vetoed-shock",
            hard_vetoes=["strategy_contract_missing"],
        )
        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                vetoed,
                bundle(
                    candidate_id="cand-clean-a",
                    net_pnl_per_day="600",
                    symbol="AAPL",
                    cluster="clean-a",
                ),
                bundle(
                    candidate_id="cand-clean-b",
                    net_pnl_per_day="600",
                    symbol="AMZN",
                    cluster="clean-b",
                ),
                bundle(
                    candidate_id="cand-clean-c",
                    net_pnl_per_day="600",
                    symbol="GOOGL",
                    cluster="clean-c",
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_best_day_share=Decimal("0.40"),
                min_observed_trading_days=5,
            ),
            portfolio_size_min=3,
            portfolio_size_max=3,
        )

        self.assertEqual(
            vetoed.objective_scorecard["hard_vetoes"],
            ["strategy_contract_missing"],
        )
        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertNotIn("cand-vetoed-shock", portfolio.source_candidate_ids)
        self.assertCountEqual(
            portfolio.source_candidate_ids,
            ("cand-clean-a", "cand-clean-b", "cand-clean-c"),
        )
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])
        self.assertIn(
            {
                "candidate_id": "cand-vetoed-shock",
                "reason": "frontier_non_composable_hard_veto",
                "hard_vetoes": ["strategy_contract_missing"],
            },
            portfolio.optimizer_report["rejections"],
        )

    def test_optimizer_can_compose_capital_safe_single_sleeve_vetoes(self) -> None:
        def bundle(
            *,
            candidate_id: str,
            symbol: str,
            cluster: str,
            daily_net: tuple[str, str, str],
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "hard_vetoes": [
                        "avg_daily_notional_below_min",
                        "best_day_share_above_max",
                        "positive_day_ratio_below_oracle",
                    ],
                    "objective_scorecard": {
                        "net_pnl_per_day": "570",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.67",
                        "worst_day_loss": "40",
                        "max_drawdown": "40",
                        "max_gross_exposure_pct_equity": "0.25",
                        "min_cash": "12000",
                        "negative_cash_observation_count": 0,
                        "best_day_share": "0.80",
                        "avg_filled_notional_per_day": "300000",
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
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "300000",
                            "2026-02-24": "300000",
                            "2026-02-25": "300000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-composable-vetoes",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    candidate_id="cand-offset-a",
                    symbol="AAPL",
                    cluster="offset-a",
                    daily_net=("900", "-120", "930"),
                ),
                bundle(
                    candidate_id="cand-offset-b",
                    symbol="AMZN",
                    cluster="offset-b",
                    daily_net=("-120", "930", "900"),
                ),
                bundle(
                    candidate_id="cand-offset-c",
                    symbol="GOOGL",
                    cluster="offset-c",
                    daily_net=("930", "900", "-120"),
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_best_day_share=Decimal("0.40"),
                min_observed_trading_days=3,
            ),
            portfolio_size_min=3,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertCountEqual(
            portfolio.source_candidate_ids,
            ("cand-offset-a", "cand-offset-b", "cand-offset-c"),
        )
        self.assertEqual(
            portfolio.objective_scorecard["max_gross_exposure_pct_equity"],
            "0.75",
        )
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])

    def test_portfolio_candidate_rejects_pnl_only_replay_without_executable_proof(
        self,
    ) -> None:
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-pnl-only-{index}",
                candidate={
                    "candidate_id": f"cand-pnl-only-{index}",
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": "450",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "350000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": f"pnl-only-{index}",
                        "symbol_contribution_shares": {
                            "AAPL": "0.25",
                            "NVDA": "0.25",
                            "MSFT": "0.25",
                            "AMAT": "0.25",
                        },
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "450",
                            "2026-02-24": "450",
                            "2026-02-25": "450",
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "350000",
                            "2026-02-24": "350000",
                            "2026-02-25": "350000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-pnl-only",
                result_path=f"/tmp/pnl-only-{index}.json",
            )
            for index in range(2)
        ]

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("300"),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertIn(
            "executable_replay_passed_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )

    def test_optimizer_searches_past_concentrated_greedy_sleeve(self) -> None:
        def bundle(
            *,
            candidate_id: str,
            net_pnl_per_day: str,
            symbol: str,
            cluster: str,
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
                            "2026-02-23": net_pnl_per_day,
                            "2026-02-24": net_pnl_per_day,
                            "2026-02-25": net_pnl_per_day,
                            "2026-02-26": net_pnl_per_day,
                            "2026-02-27": net_pnl_per_day,
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
                dataset_snapshot_id="snapshot-beam-search",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    candidate_id="cand-concentrated",
                    net_pnl_per_day="800",
                    symbol="NVDA",
                    cluster="concentrated-alpha",
                ),
                bundle(
                    candidate_id="cand-diverse-a",
                    net_pnl_per_day="600",
                    symbol="AAPL",
                    cluster="diverse-a",
                ),
                bundle(
                    candidate_id="cand-diverse-b",
                    net_pnl_per_day="600",
                    symbol="AMZN",
                    cluster="diverse-b",
                ),
                bundle(
                    candidate_id="cand-diverse-c",
                    net_pnl_per_day="600",
                    symbol="GOOGL",
                    cluster="diverse-c",
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(min_observed_trading_days=5),
            portfolio_size_min=3,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertNotIn("cand-concentrated", portfolio.source_candidate_ids)
        self.assertCountEqual(
            portfolio.source_candidate_ids,
            ("cand-diverse-a", "cand-diverse-b", "cand-diverse-c"),
        )
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])
        self.assertLessEqual(
            Decimal(
                portfolio.objective_scorecard["max_single_symbol_contribution_share"]
            ),
            Decimal("0.35"),
        )
        self.assertEqual(
            portfolio.optimizer_report["method"],
            "deterministic_beam_promotion_ready_search_v2",
        )
        self.assertEqual(
            portfolio.optimizer_report["selection_priority"],
            "oracle_passed_then_blocker_minimized_then_target_met",
        )
        self.assertGreater(portfolio.optimizer_report["finalist_state_count"], 1)

    def test_optimizer_interleaves_large_concentrated_prefix_before_beam_prunes_diversifiers(
        self,
    ) -> None:
        def bundle(
            *,
            candidate_id: str,
            net_pnl_per_day: str,
            symbol: str,
            cluster: str,
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
                            "2026-02-23": net_pnl_per_day,
                            "2026-02-24": net_pnl_per_day,
                            "2026-02-25": net_pnl_per_day,
                            "2026-02-26": net_pnl_per_day,
                            "2026-02-27": net_pnl_per_day,
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
                dataset_snapshot_id="snapshot-concentrated-prefix",
                result_path=f"/tmp/{candidate_id}.json",
            )

        concentrated_prefix = [
            bundle(
                candidate_id=f"cand-nvda-prefix-{index:03d}",
                net_pnl_per_day="1000",
                symbol="NVDA",
                cluster=f"nvda-prefix-{index:03d}",
            )
            for index in range(
                portfolio_optimizer_module.PORTFOLIO_SEARCH_BEAM_WIDTH + 20
            )
        ]
        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                *concentrated_prefix,
                bundle(
                    candidate_id="cand-ready-aapl",
                    net_pnl_per_day="450",
                    symbol="AAPL",
                    cluster="ready-aapl",
                ),
                bundle(
                    candidate_id="cand-ready-amzn",
                    net_pnl_per_day="450",
                    symbol="AMZN",
                    cluster="ready-amzn",
                ),
                bundle(
                    candidate_id="cand-ready-googl",
                    net_pnl_per_day="450",
                    symbol="GOOGL",
                    cluster="ready-googl",
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
            ("cand-ready-aapl", "cand-ready-amzn", "cand-ready-googl"),
        )
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])
        self.assertLessEqual(
            Decimal(
                portfolio.objective_scorecard["max_single_symbol_contribution_share"]
            ),
            Decimal("0.35"),
        )

    def test_optimizer_prefers_nearest_promotion_candidate_over_raw_target_met(
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
                dataset_snapshot_id="snapshot-oracle-aware-fallback",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    candidate_id="cand-sparse-intc",
                    net_pnl_per_day="540",
                    symbol="INTC",
                    cluster="sparse-intc",
                    daily_net=("2700", "0", "0", "0", "0"),
                ),
                bundle(
                    candidate_id="cand-steady-aapl",
                    net_pnl_per_day="480",
                    symbol="AAPL",
                    cluster="steady-aapl",
                    daily_net=("480", "480", "480", "480", "480"),
                ),
                bundle(
                    candidate_id="cand-steady-amzn",
                    net_pnl_per_day="480",
                    symbol="AMZN",
                    cluster="steady-amzn",
                    daily_net=("480", "480", "480", "480", "480"),
                ),
                bundle(
                    candidate_id="cand-steady-googl",
                    net_pnl_per_day="480",
                    symbol="GOOGL",
                    cluster="steady-googl",
                    daily_net=("480", "480", "480", "480", "480"),
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(min_observed_trading_days=5),
            portfolio_size_min=3,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertNotIn("cand-sparse-intc", portfolio.source_candidate_ids)
        self.assertCountEqual(
            portfolio.source_candidate_ids,
            ("cand-steady-aapl", "cand-steady-amzn", "cand-steady-googl"),
        )
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertFalse(portfolio.objective_scorecard["target_met"])
        self.assertEqual(
            portfolio.objective_scorecard["min_daily_net_pnl"],
            "480.0000000000000000000000000",
        )
        self.assertLessEqual(
            Decimal(portfolio.objective_scorecard["max_single_day_contribution_share"]),
            Decimal("0.25"),
        )
        self.assertEqual(
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
            [
                "portfolio_post_cost_net_pnl_per_day_failed",
                "avg_filled_notional_per_day_failed",
            ],
        )
        self.assertEqual(
            Decimal(
                portfolio.objective_scorecard["profit_target_oracle"][
                    "effective_min_avg_filled_notional_per_day"
                ]
            ),
            Decimal("364583.3333333333333333333334"),
        )
