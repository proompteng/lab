from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.portfolio_optimizer.support import *


class TestPortfolioOptimizerPart3(_TestPortfolioOptimizerBase):
    def test_portfolio_allows_research_candidates_pending_validation_contract(
        self,
    ) -> None:
        def bundle(
            candidate_id: str, symbol: str, blockers: list[str]
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": "280",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "5000",
                        "negative_cash_observation_count": 0,
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "150000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": candidate_id,
                        "symbol_contribution_shares": {symbol: "1.0"},
                        **_executable_scorecard_fields(candidate_id),
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "280",
                            "2026-02-24": "280",
                            "2026-02-25": "280",
                            "2026-02-26": "280",
                            "2026-02-27": "280",
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "150000",
                            "2026-02-24": "150000",
                            "2026-02-25": "150000",
                            "2026-02-26": "150000",
                            "2026-02-27": "150000",
                        },
                    },
                    "promotion_readiness": {
                        "stage": "research_candidate",
                        "status": "blocked_pending_validation_contract",
                        "promotable": False,
                        "blockers": blockers,
                    },
                },
                dataset_snapshot_id=f"historical-market-replay-{candidate_id}",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    "validation-pending-a",
                    "AAPL",
                    [
                        "validation_contract_pending",
                        "validation_live_paper_parity_pending",
                    ],
                ),
                bundle(
                    "validation-pending-b",
                    "AMZN",
                    ["validation_contract_pending"],
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.50"),
                max_single_symbol_contribution_share=Decimal("0.50"),
                min_observed_trading_days=5,
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertEqual(portfolio.objective_scorecard["net_pnl_per_day"], "560")
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertEqual(
            portfolio.objective_scorecard["validation_contract_pending_count"], 2
        )
        self.assertEqual(
            portfolio.objective_scorecard["validation_live_paper_parity_pending_count"],
            1,
        )
        self.assertIn(
            "validation_contract_pending_count_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )
        self.assertIn(
            "validation_live_paper_parity_pending_count_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )
        self.assertEqual(
            {sleeve["candidate_id"] for sleeve in portfolio.sleeves},
            {"validation-pending-a", "validation-pending-b"},
        )

    def test_portfolio_sleeves_preserve_runtime_params_for_closure(self) -> None:
        def bundle(candidate_id: str, symbol: str) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": "300",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "5000",
                        "negative_cash_observation_count": 0,
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "150000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": candidate_id,
                        "symbol_contribution_shares": {symbol: "1.0"},
                        "max_notional_per_trade": "24000",
                        "max_position_pct_equity": "0.76",
                        "runtime_params": {
                            "entry_minute_after_open": "35",
                            "entry_window_minutes": "25",
                            "exit_minute_after_open": "180",
                            "signal_motif": "opening_window_prev_close_reversal",
                            "rank_feature": (
                                "cross_section_opening_window_return_from_prev_close_rank"
                            ),
                            "selection_mode": "reversal",
                            "top_n": "2",
                            "gate_feature": (
                                "cross_section_positive_opening_window_return_from_prev_close_ratio"
                            ),
                            "gate_min": "0.20",
                            "gate_max": "0.85",
                        },
                        "universe_symbols": ["NVDA", "AVGO", "AMD"],
                        **_executable_scorecard_fields(candidate_id),
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "300",
                            "2026-02-24": "300",
                            "2026-02-25": "300",
                            "2026-02-26": "300",
                            "2026-02-27": "300",
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "150000",
                            "2026-02-24": "150000",
                            "2026-02-25": "150000",
                            "2026-02-26": "150000",
                            "2026-02-27": "150000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-runtime-param-carry",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle("cand-prevclose-a", "NVDA"),
                bundle("cand-prevclose-b", "AVGO"),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.50"),
                max_single_symbol_contribution_share=Decimal("0.50"),
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        first_sleeve = portfolio.sleeves[0]
        self.assertEqual(first_sleeve["signal"], "opening_window_prev_close_reversal")
        self.assertEqual(
            first_sleeve["params"]["gate_feature"],
            "cross_section_positive_opening_window_return_from_prev_close_ratio",
        )
        self.assertEqual(first_sleeve["universe_symbols"], ["NVDA", "AVGO", "AMD"])
        self.assertEqual(first_sleeve["max_notional_per_trade"], "24000")
        self.assertEqual(first_sleeve["max_position_pct_equity"], "0.76")

    def test_portfolio_candidate_round_trips_from_optimizer_payload(self) -> None:
        daily_profiles = [
            ("610", "620", "630", "640", "650"),
            ("640", "630", "620", "610", "600"),
            ("630", "610", "650", "620", "640"),
        ]
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{index}",
                candidate={
                    "candidate_id": f"cand-{index}",
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": "625",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.8",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "350000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": f"cluster-{index}",
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
                            "2026-02-23": daily_profiles[index][0],
                            "2026-02-24": daily_profiles[index][1],
                            "2026-02-25": daily_profiles[index][2],
                            "2026-02-26": daily_profiles[index][3],
                            "2026-02-27": daily_profiles[index][4],
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
                dataset_snapshot_id="snapshot-1",
                result_path=f"/tmp/spec-{index}.json",
            )
            for index in range(3)
        ]

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(min_observed_trading_days=5),
            portfolio_size_min=2,
            portfolio_size_max=4,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        reloaded = portfolio_candidate_from_payload(portfolio.to_payload())
        self.assertEqual(
            reloaded.portfolio_candidate_id, portfolio.portfolio_candidate_id
        )
        self.assertTrue(reloaded.objective_scorecard["target_met"])
        self.assertTrue(reloaded.objective_scorecard["oracle_passed"])
        self.assertEqual(
            reloaded.objective_scorecard["net_pnl_per_day"],
            "626.6666666666666666666666664",
        )
        self.assertLessEqual(
            Decimal(reloaded.objective_scorecard["max_cluster_contribution_share"]),
            Decimal("0.40"),
        )
        self.assertLessEqual(
            Decimal(
                reloaded.objective_scorecard["max_single_symbol_contribution_share"]
            ),
            Decimal("0.35"),
        )
        self.assertEqual(
            reloaded.objective_scorecard["profit_target_oracle"]["blockers"], []
        )

    def test_optimizer_rejects_undersized_portfolio_candidate(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-single-sleeve",
            candidate={
                "candidate_id": "cand-single-sleeve",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "objective_scorecard": {
                    "net_pnl_per_day": "2100",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.33",
                    "worst_day_loss": "447",
                    "max_drawdown": "548",
                    "best_day_share": "1.0",
                    "avg_filled_notional_per_day": "318444",
                    "regime_slice_pass_rate": "0.55",
                    "posterior_edge_lower": "0.01",
                    "shadow_parity_status": "within_budget",
                    "correlation_cluster": "single-sleeve-cluster",
                    "symbol_contribution_shares": {"NVDA": "1.0"},
                    **_executable_scorecard_fields("single-sleeve"),
                },
                "full_window": {
                    "daily_net": {
                        "2026-04-29": "-100.37",
                        "2026-04-30": "-447.41",
                        "2026-05-01": "6835.18",
                    },
                    "daily_filled_notional": {
                        "2026-04-29": "318444",
                        "2026-04-30": "318444",
                        "2026-05-01": "318444",
                    },
                },
            },
            dataset_snapshot_id="snapshot-single-sleeve",
            result_path="/tmp/single-sleeve.json",
        )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[bundle],
            target_net_pnl_per_day=Decimal("500"),
            portfolio_size_min=3,
            portfolio_size_max=3,
        )

        self.assertIsNone(portfolio)

    def test_invalid_portfolio_candidate_payload_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "portfolio_candidate_schema_invalid"):
            portfolio_candidate_from_payload({"schema_version": "bad"})

    def test_portfolio_optimizer_uses_decomposition_symbol_shares_when_scorecard_missing(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-chip-decomposition",
            candidate={
                "candidate_id": "cand-chip-decomposition",
                "runtime_family": "momentum_pullback_consistent",
                "runtime_strategy_name": "momentum-pullback-long-v1",
                "family_template_id": "momentum_pullback_v1",
                "objective_scorecard": {
                    "net_pnl_per_day": "350",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "best_day_share": "0.34",
                    "avg_filled_notional_per_day": "350000",
                    "regime_slice_pass_rate": "0.55",
                    "posterior_edge_lower": "0.01",
                    "shadow_parity_status": "within_budget",
                    "daily_net": {
                        "2026-02-23": "340",
                        "2026-02-24": "350",
                        "2026-02-25": "360",
                    },
                    "daily_filled_notional": {
                        "2026-02-23": "350000",
                        "2026-02-24": "350000",
                        "2026-02-25": "350000",
                    },
                    **_executable_scorecard_fields("decomposition"),
                },
                "decomposition": {
                    "symbols": {
                        "NVDA": {"positive_pnl_share": "0.34"},
                        "AVGO": {"positive_pnl_share": "0.33"},
                        "TSM": {"positive_pnl_share": "0.33"},
                    }
                },
            },
            dataset_snapshot_id="snapshot-chip-decomposition",
            result_path="/tmp/chip-decomposition.json",
        )

        self.assertEqual(
            bundle.objective_scorecard["symbol_contribution_shares"],
            {"NVDA": "0.34", "AVGO": "0.33", "TSM": "0.33"},
        )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[bundle],
            target_net_pnl_per_day=Decimal("300"),
            portfolio_size_min=1,
            portfolio_size_max=1,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        symbol_shares = portfolio.objective_scorecard["symbol_contribution_shares"]
        self.assertEqual(
            symbol_shares,
            {
                "AVGO": "0.33",
                "NVDA": "0.34",
                "TSM": "0.33",
            },
        )
        self.assertNotIn("UNKNOWN", symbol_shares)
        self.assertEqual(
            portfolio.objective_scorecard["max_single_symbol_contribution_share"],
            "0.34",
        )

    def test_optimizer_keeps_research_candidate_blocked_on_scheduler_approval(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-approval-blocked",
            candidate={
                "candidate_id": "cand-approval-blocked",
                "runtime_family": "momentum_pullback_consistent",
                "runtime_strategy_name": "momentum-pullback-long-v1",
                "family_template_id": "momentum_pullback_v1",
                "objective_scorecard": {
                    "net_pnl_per_day": "325",
                    "active_day_ratio": "0.50",
                    "positive_day_ratio": "0.50",
                    "worst_day_loss": "10",
                    "max_drawdown": "15",
                    "best_day_share": "0.75",
                    "avg_filled_notional_per_day": "150000",
                    "regime_slice_pass_rate": "0.55",
                    "posterior_edge_lower": "0.01",
                    "daily_net": {
                        "2026-02-23": "650",
                        "2026-02-24": "0",
                    },
                    "daily_filled_notional": {
                        "2026-02-23": "300000",
                        "2026-02-24": "0",
                    },
                },
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "blocked_pending_runtime_parity",
                    "promotable": False,
                    "blockers": [
                        "scheduler_v3_parity_missing",
                        "scheduler_v3_approval_missing",
                        "shadow_validation_missing",
                    ],
                },
            },
            dataset_snapshot_id="snapshot-approval-blocked",
            result_path="/tmp/spec-approval-blocked.json",
        )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[bundle],
            target_net_pnl_per_day=Decimal("300"),
            portfolio_size_min=1,
            portfolio_size_max=1,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertEqual(
            portfolio.sleeves[0]["promotion_status"],
            "blocked_pending_runtime_parity",
        )

    def test_portfolio_optimizer_counts_missing_trading_days_against_oracle(
        self,
    ) -> None:
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-missing-day-{index}",
                candidate={
                    "candidate_id": f"cand-missing-day-{index}",
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": "900",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.5",
                        "avg_filled_notional_per_day": "350000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": f"missing-day-{index}",
                        "symbol_contribution_shares": {
                            "AAPL": "0.25",
                            "NVDA": "0.25",
                            "MSFT": "0.25",
                            "AMAT": "0.25",
                        },
                        **_executable_scorecard_fields(index),
                    },
                    "full_window": {
                        "trading_day_count": 3,
                        "daily_net": {
                            "2026-02-23": "900",
                            "2026-02-24": "900",
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "350000",
                            "2026-02-24": "350000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-missing-day",
                result_path=f"/tmp/missing-day-{index}.json",
            )
            for index in range(2)
        ]

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("500"),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        scorecard = portfolio.objective_scorecard
        self.assertEqual(scorecard["trading_day_count"], 3)
        self.assertEqual(scorecard["daily_net_observed_day_count"], 2)
        self.assertEqual(scorecard["missing_daily_net_count"], 1)
        self.assertFalse(scorecard["oracle_passed"])
        self.assertIn(
            "daily_net_observed_day_count_failed",
            scorecard["profit_target_oracle"]["blockers"],
        )

    def test_portfolio_optimizer_does_not_synthesize_daily_net_proof_from_scalar_pnl(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-scalar-pnl-only",
            candidate={
                "candidate_id": "cand-scalar-pnl-only",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "objective_scorecard": {
                    "net_pnl_per_day": "900",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "best_day_share": "0.25",
                    "avg_filled_notional_per_day": "350000",
                    "regime_slice_pass_rate": "0.55",
                    "posterior_edge_lower": "0.01",
                    "shadow_parity_status": "within_budget",
                    "correlation_cluster": "scalar-pnl-only",
                    "symbol_contribution_shares": {"AAPL": "1.0"},
                    **_executable_scorecard_fields("scalar-pnl-only"),
                },
            },
            dataset_snapshot_id="snapshot-scalar-pnl-only",
            result_path="/tmp/scalar-pnl-only.json",
        )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[bundle],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_best_day_share=Decimal("1.0"),
                max_cluster_contribution_share=Decimal("1.0"),
                max_single_symbol_contribution_share=Decimal("1.0"),
            ),
            portfolio_size_min=1,
            portfolio_size_max=1,
        )

        self.assertEqual(portfolio_optimizer_module._daily_net(bundle), {})
        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        scorecard = portfolio.objective_scorecard
        self.assertEqual(scorecard["daily_net"], {})
        self.assertEqual(scorecard["trading_day_count"], 1)
        self.assertEqual(scorecard["daily_net_observed_day_count"], 0)
        self.assertEqual(scorecard["missing_daily_net_count"], 1)
        self.assertFalse(scorecard["oracle_passed"])
        self.assertIn(
            "daily_net_observed_day_count_failed",
            scorecard["profit_target_oracle"]["blockers"],
        )

    def test_portfolio_optimizer_blocks_missing_sleeve_daily_net_coverage(
        self,
    ) -> None:
        def bundle(
            *,
            candidate_id: str,
            daily_net: dict[str, str],
            cluster: str,
            symbol: str,
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "runtime_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "objective_scorecard": {
                        "net_pnl_per_day": "900",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.25",
                        "avg_filled_notional_per_day": "350000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": cluster,
                        "symbol_contribution_shares": {symbol: "1.0"},
                        **_executable_scorecard_fields(candidate_id),
                    },
                    "full_window": {
                        "trading_day_count": 3,
                        "daily_net": daily_net,
                        "daily_filled_notional": {
                            "2026-02-23": "350000",
                            "2026-02-24": "350000",
                            "2026-02-25": "350000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-missing-sleeve-day",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    candidate_id="cand-full",
                    daily_net={
                        "2026-02-23": "1000",
                        "2026-02-24": "1000",
                        "2026-02-25": "1000",
                    },
                    cluster="missing-sleeve-a",
                    symbol="AAPL",
                ),
                bundle(
                    candidate_id="cand-partial",
                    daily_net={
                        "2026-02-23": "1000",
                        "2026-02-25": "1000",
                    },
                    cluster="missing-sleeve-b",
                    symbol="AMZN",
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_best_day_share=Decimal("0.50"),
                max_cluster_contribution_share=Decimal("0.60"),
                max_single_symbol_contribution_share=Decimal("0.60"),
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        scorecard = portfolio.objective_scorecard
        self.assertEqual(scorecard["daily_net_observed_day_count"], 3)
        self.assertEqual(scorecard["missing_daily_net_count"], 0)
        self.assertEqual(scorecard["missing_sleeve_daily_net_count"], 1)
        self.assertFalse(scorecard["oracle_passed"])
        self.assertIn(
            "missing_sleeve_daily_net_count_failed",
            scorecard["profit_target_oracle"]["blockers"],
        )
