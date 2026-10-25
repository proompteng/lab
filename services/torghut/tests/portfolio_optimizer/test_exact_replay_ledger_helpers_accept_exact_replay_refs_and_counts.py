from __future__ import annotations

from tests.portfolio_optimizer.support import (
    CandidateEvidenceBundle,
    Decimal,
    ProfitTargetOraclePolicy,
    _TestPortfolioOptimizerBase,
    _executable_scorecard_fields,
    candidate_passes_minimums,
    capital_safety_rejection,
    edge_risk_gross_exposure_budget_weights,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    exact_replay_ledger_artifact_refs,
    exact_replay_ledger_fill_count,
    exact_replay_ledger_row_count,
    gross_exposure_allocation_priority,
    negative_cash_observation_count,
    optimize_portfolio_candidate,
    oracle_blocker_count,
)


class TestExactReplayLedgerHelpersAcceptExactReplayRefsAndCounts(
    _TestPortfolioOptimizerBase
):
    def test_exact_replay_ledger_helpers_accept_exact_replay_refs_and_counts(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-ledger-list",
            candidate={
                "candidate_id": "cand-ledger-list",
                "objective_scorecard": {
                    "exact_replay_ledger_artifact_refs": [
                        "",
                        "s3://proof/exact-ledger.json",
                        "s3://proof/exact-ledger.json",
                    ],
                    "exact_replay_ledger_artifact_row_count": "7",
                    "exact_replay_ledger_artifact_fill_count": "6",
                },
            },
            dataset_snapshot_id="snapshot-ledger-list",
            result_path="/tmp/cand-ledger-list.json",
        )

        self.assertEqual(
            exact_replay_ledger_artifact_refs(bundle),
            [
                "s3://proof/exact-ledger.json",
            ],
        )
        self.assertEqual(
            exact_replay_ledger_row_count(bundle),
            7,
        )
        self.assertEqual(
            exact_replay_ledger_fill_count(bundle),
            6,
        )

    def test_exact_replay_ledger_helpers_reject_runtime_and_non_artifact_aliases(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-ledger-summary-alias",
            candidate={
                "candidate_id": "cand-ledger-summary-alias",
                "objective_scorecard": {
                    "runtime_ledger_artifact_ref": "s3://proof/runtime-ledger.json",
                    "runtime_ledger_artifact_refs": ["s3://proof/runtime-ledger.json"],
                    "runtime_ledger_artifact_row_count": "7",
                    "runtime_ledger_artifact_fill_count": "6",
                    "exact_replay_ledger_row_count": "7",
                    "runtime_ledger_row_count": "7",
                    "exact_replay_ledger_fill_count": "6",
                    "runtime_ledger_fill_count": "6",
                },
            },
            dataset_snapshot_id="snapshot-ledger-summary-alias",
            result_path="/tmp/cand-ledger-summary-alias.json",
        )

        self.assertEqual(
            exact_replay_ledger_artifact_refs(bundle),
            [],
        )
        self.assertNotIn(
            "s3://proof/runtime-ledger.json",
            bundle.replay_artifact_refs,
        )
        self.assertEqual(
            exact_replay_ledger_row_count(bundle),
            0,
        )
        self.assertEqual(
            exact_replay_ledger_fill_count(bundle),
            0,
        )

    def test_evidence_bundle_blockers_reject_nested_stale_replay_metadata(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-nested-stale",
            candidate={
                "candidate_id": "cand-nested-stale",
                "replay_tape": {
                    "status": "stale_override",
                    "stale_override_used": True,
                },
                "dataset_snapshot_receipt": {
                    "snapshot_id": "snapshot-stale",
                    "is_fresh": False,
                    "stale_override_used": True,
                },
                "objective_scorecard": {
                    "net_pnl_per_day": "600",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "best_day_share": "0.1",
                    **_executable_scorecard_fields("nested-stale"),
                },
            },
            dataset_snapshot_id="snapshot-nested-stale",
            result_path="/tmp/cand-nested-stale.json",
        )

        self.assertIn("stale_tape", evidence_bundle_blockers(bundle))
        self.assertTrue(bundle.objective_scorecard["stale_override_used"])
        self.assertEqual(
            bundle.objective_scorecard["tape_freshness_status"],
            "stale",
        )
        self.assertEqual(
            bundle.objective_scorecard["dataset_freshness_status"],
            "stale",
        )

    def test_oracle_blocker_count_treats_malformed_payloads_as_unblocked(
        self,
    ) -> None:
        self.assertEqual(
            oracle_blocker_count({}),
            Decimal("0"),
        )
        self.assertEqual(
            oracle_blocker_count(
                {"profit_target_oracle": {"blockers": "missing_daily_net"}}
            ),
            Decimal("0"),
        )

    def test_gross_exposure_allocation_priority_rejects_bad_edge_or_quality(
        self,
    ) -> None:
        def bundle(
            candidate_id: str,
            *,
            net_pnl_per_day: str,
            active_day_ratio: str = "1",
            positive_day_ratio: str = "1",
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "objective_scorecard": {
                        "net_pnl_per_day": net_pnl_per_day,
                        "active_day_ratio": active_day_ratio,
                        "positive_day_ratio": positive_day_ratio,
                        "worst_day_loss": "10",
                        "max_drawdown": "10",
                        "best_day_share": "0.2",
                    },
                },
                dataset_snapshot_id="snapshot-priority-zero",
                result_path=f"/tmp/{candidate_id}.json",
            )

        self.assertEqual(
            gross_exposure_allocation_priority(
                bundle("negative-edge", net_pnl_per_day="-1")
            ),
            Decimal("0"),
        )
        self.assertEqual(
            gross_exposure_allocation_priority(
                bundle("inactive", net_pnl_per_day="100", active_day_ratio="0")
            ),
            Decimal("0"),
        )

    def test_edge_risk_gross_exposure_budget_weights_covers_saturation_and_noop(
        self,
    ) -> None:
        saturated_weights = edge_risk_gross_exposure_budget_weights(
            (Decimal("0.1"), Decimal("1.0")),
            (Decimal("100"), Decimal("1")),
            max_gross_exposure_pct_equity=Decimal("0.6"),
            equal_scale=Decimal("0.6") / Decimal("1.1"),
        )

        self.assertIsNotNone(saturated_weights)
        assert saturated_weights is not None
        self.assertEqual(saturated_weights[0], Decimal("1"))
        self.assertLess(saturated_weights[1], Decimal("0.6") / Decimal("1.1"))
        self.assertLessEqual(
            (Decimal("0.1") * saturated_weights[0])
            + (Decimal("1.0") * saturated_weights[1]),
            Decimal("0.6"),
        )

        self.assertIsNone(
            edge_risk_gross_exposure_budget_weights(
                (Decimal("0.25"), Decimal("0.75")),
                (Decimal("1"), Decimal("3")),
                max_gross_exposure_pct_equity=Decimal("0.5"),
                equal_scale=Decimal("0.5"),
            )
        )

    def test_capital_safety_rejection_reasons_block_minimums(self) -> None:
        def bundle(
            candidate_id: str,
            scorecard_updates: dict[str, object],
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "objective_scorecard": {
                        "net_pnl_per_day": "250",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "0",
                        "negative_cash_observation_count": 0,
                        **scorecard_updates,
                    },
                },
                dataset_snapshot_id="snapshot-capital-safety",
                result_path=f"/tmp/{candidate_id}.json",
            )

        malformed_count = bundle(
            "bad-negative-cash-count",
            {"negative_cash_observation_count": "NaN"},
        )
        max_gross = bundle(
            "max-gross",
            {"max_gross_exposure_pct_equity": "1.1"},
        )
        min_cash = bundle("min-cash", {"min_cash": "-1"})
        observed_negative_cash = bundle(
            "observed-negative-cash",
            {"negative_cash_observation_count": 2},
        )
        zero_pnl = bundle("zero-pnl", {"net_pnl_per_day": "0"})

        self.assertEqual(
            negative_cash_observation_count(malformed_count),
            0,
        )
        self.assertEqual(
            capital_safety_rejection(max_gross)["reason"],
            "frontier_capital_violation",
        )
        self.assertEqual(
            capital_safety_rejection(min_cash)["reason"],
            "frontier_negative_cash",
        )
        self.assertEqual(
            capital_safety_rejection(observed_negative_cash)["reason"],
            "frontier_negative_cash_observed",
        )
        self.assertFalse(candidate_passes_minimums(max_gross))
        self.assertFalse(candidate_passes_minimums(zero_pnl))

    def test_capital_safety_rejection_uses_oracle_policy(self) -> None:
        def bundle(
            candidate_id: str,
            scorecard_updates: dict[str, object],
        ) -> CandidateEvidenceBundle:
            return evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"spec-{candidate_id}",
                candidate={
                    "candidate_id": candidate_id,
                    "objective_scorecard": {
                        "net_pnl_per_day": "250",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "max_gross_exposure_pct_equity": "0.8",
                        "min_cash": "100",
                        "negative_cash_observation_count": 0,
                        **scorecard_updates,
                    },
                },
                dataset_snapshot_id="snapshot-policy-capital-safety",
                result_path=f"/tmp/{candidate_id}.json",
            )

        strict_policy = ProfitTargetOraclePolicy(
            max_gross_exposure_pct_equity=Decimal("0.75"),
            min_cash=Decimal("250"),
            max_negative_cash_observation_count=0,
        )
        relaxed_policy = ProfitTargetOraclePolicy(
            max_gross_exposure_pct_equity=Decimal("1.25"),
            min_cash=Decimal("-25"),
            max_negative_cash_observation_count=1,
        )

        gross = bundle("policy-gross", {})
        cash = bundle(
            "policy-cash",
            {"max_gross_exposure_pct_equity": "0.5"},
        )
        negative_cash = bundle(
            "policy-negative-cash",
            {
                "max_gross_exposure_pct_equity": "0.5",
                "min_cash": "300",
                "negative_cash_observation_count": 1,
            },
        )

        self.assertEqual(
            capital_safety_rejection(gross, oracle_policy=strict_policy)["reason"],
            "frontier_capital_violation",
        )
        self.assertEqual(
            capital_safety_rejection(cash, oracle_policy=strict_policy)["reason"],
            "frontier_negative_cash",
        )
        self.assertEqual(
            capital_safety_rejection(negative_cash, oracle_policy=strict_policy)[
                "reason"
            ],
            "frontier_negative_cash_observed",
        )
        self.assertIsNone(capital_safety_rejection(gross, oracle_policy=relaxed_policy))
        self.assertTrue(
            candidate_passes_minimums(negative_cash, oracle_policy=relaxed_policy)
        )

    def test_portfolio_uses_gross_exposure_budget_for_reported_low_gross_sleeves(
        self,
    ) -> None:
        def bundle(
            candidate_id: str, symbol: str, cluster: str
        ) -> CandidateEvidenceBundle:
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
                        "correlation_cluster": cluster,
                        "symbol_contribution_shares": {symbol: "1.0"},
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
                dataset_snapshot_id="snapshot-gross-budget",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle("cand-half-gross-a", "AAPL", "half-gross-a"),
                bundle("cand-half-gross-b", "AMZN", "half-gross-b"),
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
        self.assertEqual(
            portfolio.objective_scorecard["portfolio_weighting_mode"],
            "gross_exposure_budget",
        )
        self.assertEqual(portfolio.objective_scorecard["net_pnl_per_day"], "600")
        self.assertEqual(
            portfolio.objective_scorecard["max_gross_exposure_pct_equity"],
            "1.0",
        )
        self.assertEqual(portfolio.capital_budget["mode"], "gross_exposure_budget")
        self.assertEqual(
            portfolio.capital_budget["sleeve_weights"],
            {"cand-half-gross-a": "1", "cand-half-gross-b": "1"},
        )
        self.assertEqual(
            [sleeve["weight"] for sleeve in portfolio.sleeves],
            ["1", "1"],
        )
        self.assertEqual(
            [sleeve["expected_net_pnl_per_day"] for sleeve in portfolio.sleeves],
            ["300", "300"],
        )
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])

    def test_portfolio_gross_exposure_budget_uses_oracle_policy_limit(
        self,
    ) -> None:
        def bundle(
            candidate_id: str, symbol: str, cluster: str
        ) -> CandidateEvidenceBundle:
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
                        "avg_filled_notional_per_day": "250000",
                        "regime_slice_pass_rate": "0.55",
                        "posterior_edge_lower": "0.01",
                        "shadow_parity_status": "within_budget",
                        "correlation_cluster": cluster,
                        "symbol_contribution_shares": {symbol: "1.0"},
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
                            "2026-02-23": "250000",
                            "2026-02-24": "250000",
                            "2026-02-25": "250000",
                            "2026-02-26": "250000",
                            "2026-02-27": "250000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-policy-gross-budget",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle("cand-policy-gross-a", "AAPL", "policy-gross-a"),
                bundle("cand-policy-gross-b", "AMZN", "policy-gross-b"),
            ],
            target_net_pnl_per_day=Decimal("400"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.50"),
                max_single_symbol_contribution_share=Decimal("0.50"),
                max_gross_exposure_pct_equity=Decimal("0.75"),
                min_avg_filled_notional_per_day=Decimal("300000"),
                min_observed_trading_days=5,
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertEqual(
            Decimal(str(portfolio.objective_scorecard["net_pnl_per_day"])),
            Decimal("450.00"),
        )
        self.assertEqual(
            portfolio.objective_scorecard["max_gross_exposure_pct_equity"],
            "0.750",
        )
        self.assertEqual(
            portfolio.capital_budget["sleeve_weights"],
            {"cand-policy-gross-a": "0.75", "cand-policy-gross-b": "0.75"},
        )
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertTrue(portfolio.objective_scorecard["oracle_passed"])

    def test_portfolio_gross_exposure_budget_overweights_better_edge_risk_sleeve(
        self,
    ) -> None:
        def bundle(
            candidate_id: str,
            symbol: str,
            cluster: str,
            *,
            net_pnl_per_day: str,
            worst_day_loss: str,
            max_drawdown: str,
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
                        "worst_day_loss": worst_day_loss,
                        "max_drawdown": max_drawdown,
                        "max_gross_exposure_pct_equity": "0.75",
                        "min_cash": "5000",
                        "negative_cash_observation_count": 0,
                        "best_day_share": "0.2",
                        "avg_filled_notional_per_day": "400000",
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
                            "2026-02-23": "400000",
                            "2026-02-24": "400000",
                            "2026-02-25": "400000",
                            "2026-02-26": "400000",
                            "2026-02-27": "400000",
                        },
                    },
                },
                dataset_snapshot_id="snapshot-edge-risk-gross-budget",
                result_path=f"/tmp/{candidate_id}.json",
            )

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=[
                bundle(
                    "cand-edge-risk-strong",
                    "AAPL",
                    "edge-risk-strong",
                    net_pnl_per_day="700",
                    worst_day_loss="25",
                    max_drawdown="40",
                ),
                bundle(
                    "cand-edge-risk-weak",
                    "AMZN",
                    "edge-risk-weak",
                    net_pnl_per_day="150",
                    worst_day_loss="150",
                    max_drawdown="300",
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(
                max_cluster_contribution_share=Decimal("0.99"),
                max_single_symbol_contribution_share=Decimal("0.99"),
                max_gross_exposure_pct_equity=Decimal("0.75"),
                min_observed_trading_days=5,
            ),
            portfolio_size_min=2,
            portfolio_size_max=2,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        weights = portfolio.capital_budget["sleeve_weights"]
        strong_weight = Decimal(str(weights["cand-edge-risk-strong"]))
        weak_weight = Decimal(str(weights["cand-edge-risk-weak"]))
        self.assertEqual(
            portfolio.objective_scorecard["portfolio_weighting_mode"],
            "edge_risk_gross_exposure_budget",
        )
        self.assertGreater(strong_weight, weak_weight)
        self.assertGreater(
            Decimal(str(portfolio.objective_scorecard["net_pnl_per_day"])),
            Decimal("425"),
        )
        self.assertLessEqual(
            Decimal(
                str(portfolio.objective_scorecard["max_gross_exposure_pct_equity"])
            ),
            Decimal("0.75"),
        )
        self.assertTrue(portfolio.objective_scorecard["target_met"])
