from __future__ import annotations

from tests.portfolio_optimizer.support import (
    CandidateEvidenceBundle,
    Decimal,
    ProfitTargetOraclePolicy,
    _TestPortfolioOptimizerBase,
    _executable_scorecard_fields,
    evidence_bundle_from_frontier_candidate,
    optimize_portfolio_candidate,
)


class TestPortfolioAggregatesMarketImpactStressIntoOracle(_TestPortfolioOptimizerBase):
    def test_portfolio_aggregates_market_impact_stress_into_oracle(
        self,
    ) -> None:
        def bundle(
            candidate_id: str, symbol: str, stress_net: str
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
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
                        "max_single_day_contribution_share": "0.2",
                        "max_cluster_contribution_share": "0.34",
                        "max_single_symbol_contribution_share": "0.25",
                        "avg_filled_notional_per_day": "250000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "symbol_contribution_shares": {symbol: "1.0"},
                        **_executable_scorecard_fields(candidate_id),
                        "market_impact_stress_net_pnl_per_day": stress_net,
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "300",
                            "2026-02-24": "300",
                            "2026-02-25": "300",
                            "2026-02-26": "300",
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "250000",
                            "2026-02-24": "250000",
                            "2026-02-25": "250000",
                            "2026-02-26": "250000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-impact-stress",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle("impact-a", "AAPL", "290"),
                bundle("impact-b", "AMZN", "285"),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.50"),
                max_single_symbol_contribution_share=Decimal("0.50"),
                min_observed_trading_days=4,
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertEqual(
            portfolio.objective_scorecard["market_impact_stress_model"],
            "portfolio_nonlinear_impact",
        )
        self.assertEqual(
            portfolio.objective_scorecard["market_impact_stress_models"],
            ["square_root"],
        )
        self.assertEqual(
            portfolio.objective_scorecard["exact_replay_ledger_artifact_refs"],
            [
                "/tmp/exact-replay-ledger-impact-a.json",
                "/tmp/exact-replay-ledger-impact-b.json",
            ],
        )
        self.assertEqual(
            portfolio.objective_scorecard["exact_replay_ledger_artifact_row_count"],
            10,
        )
        self.assertEqual(
            portfolio.objective_scorecard["exact_replay_ledger_artifact_fill_count"],
            10,
        )
        self.assertEqual(
            portfolio.objective_scorecard["portfolio_post_cost_net_pnl_basis"],
            "realized_strategy_pnl_after_explicit_costs",
        )
        self.assertEqual(
            portfolio.objective_scorecard["portfolio_post_cost_net_pnl_source"],
            "exact_replay_runtime_ledger",
        )
        self.assertEqual(
            portfolio.objective_scorecard["market_impact_stress_components"][
                "max_selected_cost_bps"
            ],
            "6",
        )
        self.assertEqual(
            portfolio.objective_scorecard["market_impact_stress_net_pnl_per_day"],
            "575",
        )
        self.assertEqual(
            portfolio.objective_scorecard[
                "implementation_uncertainty_lower_net_pnl_per_day"
            ],
            "1030",
        )
        self.assertTrue(
            portfolio.objective_scorecard["implementation_uncertainty_stability_passed"]
        )
        self.assertFalse(portfolio.objective_scorecard["conformal_tail_risk_required"])
        self.assertTrue(portfolio.objective_scorecard["conformal_tail_risk_passed"])
        self.assertEqual(
            portfolio.objective_scorecard[
                "conformal_tail_risk_adjusted_net_pnl_per_day"
            ],
            "600",
        )
        self.assertEqual(
            portfolio.objective_scorecard[
                "delay_adjusted_depth_stress_net_pnl_per_day"
            ],
            "1040",
        )
        self.assertEqual(
            portfolio.objective_scorecard[
                "delay_adjusted_depth_fillable_notional_per_day"
            ],
            "1050000",
        )
        self.assertTrue(
            portfolio.objective_scorecard[
                "delay_adjusted_depth_fill_survival_evidence_present"
            ]
        )
        self.assertEqual(
            portfolio.objective_scorecard[
                "delay_adjusted_depth_fill_survival_sample_count"
            ],
            10,
        )
        self.assertEqual(
            portfolio.objective_scorecard["delay_adjusted_depth_fill_survival_rate"],
            "0.85",
        )
        self.assertTrue(
            portfolio.objective_scorecard[
                "queue_position_survival_fill_curve_evidence_present"
            ]
        )
        self.assertEqual(
            portfolio.objective_scorecard["queue_position_survival_sample_count"],
            10,
        )
        self.assertTrue(
            portfolio.objective_scorecard[
                "queue_position_survival_queue_ahead_depletion_evidence_present"
            ]
        )
        self.assertEqual(
            portfolio.objective_scorecard[
                "queue_position_survival_queue_ahead_depletion_sample_count"
            ],
            10,
        )
        self.assertEqual(
            portfolio.objective_scorecard[
                "post_cost_net_pnl_after_queue_position_survival_fill_stress"
            ],
            "1040",
        )
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])

    def test_portfolio_oracle_rejects_implementation_uncertainty_lower_bound(
        self,
    ) -> None:
        def bundle(candidate_id: str, symbol: str) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
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
                        "max_single_day_contribution_share": "0.2",
                        "max_cluster_contribution_share": "0.34",
                        "max_single_symbol_contribution_share": "0.25",
                        "avg_filled_notional_per_day": "250000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "symbol_contribution_shares": {symbol: "1.0"},
                        **_executable_scorecard_fields(candidate_id),
                        "implementation_uncertainty_stability_passed": False,
                        "implementation_uncertainty_lower_net_pnl_per_day": "245",
                        "implementation_uncertainty_interval_width_per_day": "90",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "300",
                            "2026-02-24": "300",
                            "2026-02-25": "300",
                            "2026-02-26": "300",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-implementation-uncertainty",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle("implementation-risk-a", "AAPL"),
                bundle("implementation-risk-b", "AMZN"),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.50"),
                max_single_symbol_contribution_share=Decimal("0.50"),
                min_observed_trading_days=4,
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertEqual(
            portfolio.objective_scorecard[
                "implementation_uncertainty_lower_net_pnl_per_day"
            ],
            "490",
        )
        self.assertIn(
            "implementation_uncertainty_lower_net_pnl_per_day_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )

    def test_portfolio_oracle_rejects_conformal_tail_risk_adjusted_net_below_target(
        self,
    ) -> None:
        def bundle(
            candidate_id: str,
            symbol: str,
            daily_net: tuple[str, str, str, str, str],
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "objective_scorecard": {
                        "net_pnl_per_day": "1000",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.8",
                        "worst_day_loss": "1500",
                        "max_drawdown": "1500",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "5000",
                        "negative_cash_observation_count": 0,
                        "best_day_share": "0.25",
                        "max_single_day_contribution_share": "0.25",
                        "max_cluster_contribution_share": "0.34",
                        "max_single_symbol_contribution_share": "0.25",
                        "avg_filled_notional_per_day": "250000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
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
                    },
                },
                dataset_snapshot_id="snapshot-conformal-tail-risk",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    "tail-risk-a",
                    "AAPL",
                    ("1625", "1625", "1625", "-1500", "1625"),
                ),
                bundle(
                    "tail-risk-b",
                    "AMZN",
                    ("100", "3000", "300", "-1500", "3100"),
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
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertEqual(
            portfolio.objective_scorecard["conformal_tail_risk_buffer_per_day"],
            "3000",
        )
        self.assertEqual(
            portfolio.objective_scorecard[
                "conformal_tail_risk_adjusted_net_pnl_per_day"
            ],
            "-1000",
        )
        self.assertIn(
            "conformal_tail_risk_adjusted_net_pnl_per_day_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )

    def test_portfolio_blocks_missing_sleeve_market_impact_liquidity_evidence(
        self,
    ) -> None:
        def bundle(
            candidate_id: str, liquidity_present: bool
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
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
                        "max_single_day_contribution_share": "0.2",
                        "max_cluster_contribution_share": "0.34",
                        "max_single_symbol_contribution_share": "0.25",
                        "avg_filled_notional_per_day": "250000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "symbol_contribution_shares": {candidate_id: "1.0"},
                        **_executable_scorecard_fields(candidate_id),
                        "market_impact_liquidity_evidence_present": liquidity_present,
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "300",
                            "2026-02-24": "300",
                            "2026-02-25": "300",
                            "2026-02-26": "300",
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "250000",
                            "2026-02-24": "250000",
                            "2026-02-25": "250000",
                            "2026-02-26": "250000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-impact-liquidity",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle("impact-liq-a", True),
                bundle("impact-liq-b", False),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.80"),
                max_single_symbol_contribution_share=Decimal("0.80"),
                min_observed_trading_days=4,
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertFalse(
            portfolio.objective_scorecard["market_impact_liquidity_evidence_present"]
        )
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertIn(
            "market_impact_liquidity_evidence_present_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )

    def test_portfolio_aggregates_double_oos_fold_metrics_into_oracle(
        self,
    ) -> None:
        def bundle(candidate_id: str, symbol: str) -> CandidateEvidenceBundle:
            executable_fields = {
                key: value
                for key, value in _executable_scorecard_fields(candidate_id).items()
                if not key.startswith("double_oos")
            }
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
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
                        "max_single_day_contribution_share": "0.2",
                        "max_cluster_contribution_share": "0.34",
                        "max_single_symbol_contribution_share": "0.25",
                        "avg_filled_notional_per_day": "250000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "symbol_contribution_shares": {symbol: "1.0"},
                        **executable_fields,
                    },
                    "fold_metrics": [
                        {
                            "source": "double_oos_walkforward_arxiv_2602_10785_2026",
                            "fold_id": f"{candidate_id}-oos-a",
                            "passed": True,
                            "net_pnl_per_day": "265",
                            "cost_shock_net_pnl_per_day": "255",
                            "artifact_ref": f"/tmp/{candidate_id}-oos-a.json",
                        },
                        {
                            "source": "double_oos_walkforward_arxiv_2602_10785_2026",
                            "fold_id": f"{candidate_id}-oos-b",
                            "passed": True,
                            "net_pnl_per_day": "270",
                            "cost_shock_net_pnl_per_day": "260",
                            "artifact_ref": f"/tmp/{candidate_id}-oos-b.json",
                        },
                    ],
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "300",
                            "2026-02-24": "300",
                            "2026-02-25": "300",
                            "2026-02-26": "300",
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "250000",
                            "2026-02-24": "250000",
                            "2026-02-25": "250000",
                            "2026-02-26": "250000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-double-oos-folds",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle("double-oos-a", "AAPL"),
                bundle("double-oos-b", "AMZN"),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.50"),
                max_single_symbol_contribution_share=Decimal("0.50"),
                min_observed_trading_days=4,
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertTrue(portfolio.objective_scorecard["double_oos_passed"])
        self.assertEqual(
            portfolio.objective_scorecard["double_oos_independent_window_count"], 2
        )
        self.assertEqual(portfolio.objective_scorecard["double_oos_pass_rate"], "1")
        self.assertEqual(
            portfolio.objective_scorecard["double_oos_net_pnl_per_day"], "530"
        )
        self.assertEqual(
            portfolio.objective_scorecard["double_oos_cost_shock_net_pnl_per_day"],
            "510",
        )
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])
        self.assertTrue(
            all(sleeve["double_oos"]["passed"] for sleeve in portfolio.sleeves)
        )

    def test_portfolio_oracle_blocks_failed_double_oos_fold_metrics(self) -> None:
        executable_fields = {
            key: value
            for key, value in _executable_scorecard_fields("failed-oos").items()
            if not key.startswith("double_oos")
        }
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-failed-double-oos",
            candidate={
                "candidate_id": "failed-double-oos",
                "objective_scorecard": {
                    "net_pnl_per_day": "600",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "max_gross_exposure_pct_equity": "0.5",
                    "min_cash": "5000",
                    "negative_cash_observation_count": 0,
                    "best_day_share": "0.2",
                    "max_single_day_contribution_share": "0.2",
                    "max_cluster_contribution_share": "0.34",
                    "max_single_symbol_contribution_share": "0.25",
                    "avg_filled_notional_per_day": "500000",
                    "regime_slice_pass_rate": "0.55",
                    "posterior_edge_lower": "0.01",
                    "shadow_parity_status": "within_budget",
                    **executable_fields,
                },
                "fold_metrics": [
                    {
                        "source": "double_oos_walkforward_arxiv_2602_10785_2026",
                        "fold_id": "failed-oos-a",
                        "passed": True,
                        "net_pnl_per_day": "600",
                        "cost_shock_net_pnl_per_day": "600",
                        "artifact_ref": "/tmp/failed-oos-a.json",
                    },
                    {
                        "source": "double_oos_walkforward_arxiv_2602_10785_2026",
                        "fold_id": "failed-oos-b",
                        "passed": False,
                        "net_pnl_per_day": "480",
                        "cost_shock_net_pnl_per_day": "460",
                        "artifact_ref": "/tmp/failed-oos-b.json",
                    },
                ],
                "full_window": {
                    "daily_net": {
                        "2026-02-23": "600",
                        "2026-02-24": "600",
                        "2026-02-25": "600",
                    },
                    "daily_filled_notional": {
                        "2026-02-23": "500000",
                        "2026-02-24": "500000",
                        "2026-02-25": "500000",
                    },
                },
            },
            dataset_snapshot_id="snapshot-failed-double-oos",
            result_path="/tmp/failed-double-oos.json",
        )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[bundle],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(min_observed_trading_days=3),
            portfolio_size_min=1,
            portfolio_size_max=1,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        blockers = portfolio.objective_scorecard["profit_target_oracle"]["blockers"]
        self.assertIn("double_oos_passed_failed", blockers)
        self.assertIn("double_oos_pass_rate_failed", blockers)
        self.assertIn("double_oos_net_pnl_per_day_failed", blockers)
        self.assertIn("double_oos_cost_shock_net_pnl_per_day_failed", blockers)

    def test_portfolio_oracle_blocks_missing_stress_evidence(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-impact-missing",
            candidate={
                "candidate_id": "impact-missing",
                "objective_scorecard": {
                    "net_pnl_per_day": "600",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "max_gross_exposure_pct_equity": "0.5",
                    "min_cash": "5000",
                    "negative_cash_observation_count": 0,
                    "best_day_share": "0.2",
                    "max_single_day_contribution_share": "0.2",
                    "max_cluster_contribution_share": "0.34",
                    "max_single_symbol_contribution_share": "0.25",
                    "avg_filled_notional_per_day": "500000",
                    "regime_slice_pass_rate": "0.55",
                    "posterior_edge_lower": "0.01",
                    "shadow_parity_status": "within_budget",
                    "executable_replay_passed": True,
                    "executable_replay_artifact_ref": "/tmp/executable-replay.json",
                    "executable_replay_order_count": 5,
                    "executable_replay_account_buying_power": "20000",
                    "executable_replay_max_notional_per_trade": "10000",
                },
                "full_window": {
                    "daily_net": {
                        "2026-02-23": "600",
                        "2026-02-24": "600",
                        "2026-02-25": "600",
                    },
                    "daily_filled_notional": {
                        "2026-02-23": "500000",
                        "2026-02-24": "500000",
                        "2026-02-25": "500000",
                    },
                },
            },
            dataset_snapshot_id="snapshot-impact-missing",
            result_path="/tmp/impact-missing.json",
        )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[bundle],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(min_observed_trading_days=3),
            portfolio_size_min=1,
            portfolio_size_max=1,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertFalse(portfolio.objective_scorecard["oracle_passed"])
        self.assertIn(
            "market_impact_stress_passed_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )
        self.assertIn(
            "delay_adjusted_depth_stress_passed_failed",
            portfolio.objective_scorecard["profit_target_oracle"]["blockers"],
        )
