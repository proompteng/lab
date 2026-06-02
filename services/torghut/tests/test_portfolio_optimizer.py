from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

import app.trading.discovery.portfolio_optimizer as portfolio_optimizer_module
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.portfolio_candidates import (
    portfolio_candidate_from_payload,
)
from app.trading.discovery.portfolio_optimizer import optimize_portfolio_candidate
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy


def _executable_scorecard_fields(index: int | str = 0) -> dict[str, object]:
    return {
        "executable_replay_passed": True,
        "executable_replay_artifact_ref": f"/tmp/executable-replay-{index}.json",
        "executable_replay_order_count": 5,
        "executable_replay_account_buying_power": "20000",
        "executable_replay_max_notional_per_trade": "10000",
        "exact_replay_ledger_artifact_ref": f"/tmp/exact-replay-ledger-{index}.json",
        "exact_replay_ledger_artifact_row_count": 5,
        "exact_replay_ledger_artifact_fill_count": 5,
        "portfolio_post_cost_net_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "portfolio_post_cost_net_pnl_source": "runtime_ledger",
        "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "runtime_ledger_pnl_source": "runtime_ledger",
        "market_impact_stress_passed": True,
        "market_impact_stress_artifact_ref": f"/tmp/market-impact-stress-{index}.json",
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
        "market_impact_stress_components": {
            "square_root_cost_bps": "6",
            "almgren_chriss_temporary_impact_bps": "4",
            "almgren_chriss_permanent_impact_bps": "1",
            "almgren_chriss_cost_bps": "5",
            "selected_cost_bps": "6",
            "selected_model": "square_root",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
        },
        "nonlinear_market_impact_stress_passed": True,
        "nonlinear_market_impact_stress_model": "square_root",
        "nonlinear_market_impact_stress_cost_bps": "6",
        "nonlinear_market_impact_stress_net_pnl_per_day": "535",
        "permanent_impact_decay_model": "exponential_decay_proxy",
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_artifact_ref": f"/tmp/delay-adjusted-depth-stress-{index}.json",
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
        "delay_adjusted_depth_fill_survival_evidence_present": True,
        "delay_adjusted_depth_fill_survival_sample_count": 5,
        "delay_adjusted_depth_fill_survival_rate": "0.85",
        "queue_position_survival_fill_curve_evidence_present": True,
        "queue_position_survival_sample_count": 5,
        "queue_position_survival_fill_rate": "0.85",
        "queue_position_survival_queue_ratio_p95": "0.25",
        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
        "queue_position_survival_queue_ahead_depletion_sample_count": 5,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 5,
        "queue_ahead_depletion_evidence_present": True,
        "queue_ahead_depletion_sample_count": 5,
        "fill_survival_evidence_present": True,
        "fill_survival_sample_count": 5,
        "fill_survival_fill_rate": "0.85",
        "delay_adjusted_depth_stress_net_pnl_per_day": "520",
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "520",
        "double_oos_passed": True,
        "double_oos_artifact_ref": f"/tmp/double-oos-{index}.json",
        "double_oos_independent_window_count": 2,
        "double_oos_pass_rate": "1",
        "double_oos_net_pnl_per_day": "535",
        "double_oos_cost_shock_net_pnl_per_day": "515",
    }


class TestPortfolioOptimizer(TestCase):
    def test_exact_replay_ledger_helpers_accept_list_refs_and_runtime_artifact_counts(
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
                    "runtime_ledger_artifact_refs": ["s3://proof/runtime-ledger.json"],
                    "runtime_ledger_artifact_row_count": "7",
                    "runtime_ledger_artifact_fill_count": "6",
                },
            },
            dataset_snapshot_id="snapshot-ledger-list",
            result_path="/tmp/cand-ledger-list.json",
        )

        self.assertEqual(
            portfolio_optimizer_module._exact_replay_ledger_artifact_refs(bundle),
            [
                "s3://proof/exact-ledger.json",
                "s3://proof/runtime-ledger.json",
            ],
        )
        self.assertEqual(
            portfolio_optimizer_module._exact_replay_ledger_row_count(bundle),
            7,
        )
        self.assertEqual(
            portfolio_optimizer_module._exact_replay_ledger_fill_count(bundle),
            6,
        )

    def test_exact_replay_ledger_helpers_reject_non_artifact_count_aliases(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-ledger-summary-alias",
            candidate={
                "candidate_id": "cand-ledger-summary-alias",
                "objective_scorecard": {
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
            portfolio_optimizer_module._exact_replay_ledger_row_count(bundle),
            0,
        )
        self.assertEqual(
            portfolio_optimizer_module._exact_replay_ledger_fill_count(bundle),
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
            portfolio_optimizer_module._oracle_blocker_count({}),
            Decimal("0"),
        )
        self.assertEqual(
            portfolio_optimizer_module._oracle_blocker_count(
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
            portfolio_optimizer_module._gross_exposure_allocation_priority(
                bundle("negative-edge", net_pnl_per_day="-1")
            ),
            Decimal("0"),
        )
        self.assertEqual(
            portfolio_optimizer_module._gross_exposure_allocation_priority(
                bundle("inactive", net_pnl_per_day="100", active_day_ratio="0")
            ),
            Decimal("0"),
        )

    def test_edge_risk_gross_exposure_budget_weights_covers_saturation_and_noop(
        self,
    ) -> None:
        saturated_weights = (
            portfolio_optimizer_module._edge_risk_gross_exposure_budget_weights(
                (Decimal("0.1"), Decimal("1.0")),
                (Decimal("100"), Decimal("1")),
                max_gross_exposure_pct_equity=Decimal("0.6"),
                equal_scale=Decimal("0.6") / Decimal("1.1"),
            )
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
            portfolio_optimizer_module._edge_risk_gross_exposure_budget_weights(
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
            portfolio_optimizer_module._negative_cash_observation_count(
                malformed_count
            ),
            0,
        )
        self.assertEqual(
            portfolio_optimizer_module._capital_safety_rejection(max_gross)["reason"],
            "frontier_capital_violation",
        )
        self.assertEqual(
            portfolio_optimizer_module._capital_safety_rejection(min_cash)["reason"],
            "frontier_negative_cash",
        )
        self.assertEqual(
            portfolio_optimizer_module._capital_safety_rejection(
                observed_negative_cash
            )["reason"],
            "frontier_negative_cash_observed",
        )
        self.assertFalse(
            portfolio_optimizer_module._candidate_passes_minimums(max_gross)
        )
        self.assertFalse(
            portfolio_optimizer_module._candidate_passes_minimums(zero_pnl)
        )

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
            portfolio_optimizer_module._capital_safety_rejection(
                gross, oracle_policy=strict_policy
            )["reason"],
            "frontier_capital_violation",
        )
        self.assertEqual(
            portfolio_optimizer_module._capital_safety_rejection(
                cash, oracle_policy=strict_policy
            )["reason"],
            "frontier_negative_cash",
        )
        self.assertEqual(
            portfolio_optimizer_module._capital_safety_rejection(
                negative_cash, oracle_policy=strict_policy
            )["reason"],
            "frontier_negative_cash_observed",
        )
        self.assertIsNone(
            portfolio_optimizer_module._capital_safety_rejection(
                gross, oracle_policy=relaxed_policy
            )
        )
        self.assertTrue(
            portfolio_optimizer_module._candidate_passes_minimums(
                negative_cash, oracle_policy=relaxed_policy
            )
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
