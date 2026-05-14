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
    }


class TestPortfolioOptimizer(TestCase):
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

    def test_portfolio_candidate_round_trips_from_optimizer_payload(self) -> None:
        daily_profiles = [
            ("210", "220", "230", "240", "250"),
            ("240", "230", "220", "210", "200"),
            ("230", "210", "250", "220", "240"),
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
                            "2026-02-23": "250",
                            "2026-02-24": "260",
                            "2026-02-25": "270",
                            "2026-02-26": "280",
                            "2026-02-27": "315",
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
                    net_pnl_per_day="200",
                    symbol="AAPL",
                    cluster="clean-a",
                ),
                bundle(
                    candidate_id="cand-clean-b",
                    net_pnl_per_day="200",
                    symbol="AMZN",
                    cluster="clean-b",
                ),
                bundle(
                    candidate_id="cand-clean-c",
                    net_pnl_per_day="200",
                    symbol="GOOGL",
                    cluster="clean-c",
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(max_best_day_share=Decimal("0.40")),
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
                        "net_pnl_per_day": "190",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.67",
                        "worst_day_loss": "40",
                        "max_drawdown": "40",
                        "max_gross_exposure_pct_equity": "0.25",
                        "min_cash": "12000",
                        "negative_cash_observation_count": 0,
                        "best_day_share": "0.80",
                        "avg_filled_notional_per_day": "120000",
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
                            "2026-02-23": "120000",
                            "2026-02-24": "120000",
                            "2026-02-25": "120000",
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
                    daily_net=("300", "-40", "310"),
                ),
                bundle(
                    candidate_id="cand-offset-b",
                    symbol="AMZN",
                    cluster="offset-b",
                    daily_net=("-40", "310", "300"),
                ),
                bundle(
                    candidate_id="cand-offset-c",
                    symbol="GOOGL",
                    cluster="offset-c",
                    daily_net=("310", "300", "-40"),
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
            oracle_policy=ProfitTargetOraclePolicy(max_best_day_share=Decimal("0.40")),
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
                    net_pnl_per_day="200",
                    symbol="AAPL",
                    cluster="diverse-a",
                ),
                bundle(
                    candidate_id="cand-diverse-b",
                    net_pnl_per_day="200",
                    symbol="AMZN",
                    cluster="diverse-b",
                ),
                bundle(
                    candidate_id="cand-diverse-c",
                    net_pnl_per_day="200",
                    symbol="GOOGL",
                    cluster="diverse-c",
                ),
            ],
            target_net_pnl_per_day=Decimal("500"),
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
            "deterministic_beam_oracle_search_v1",
        )
        self.assertGreater(portfolio.optimizer_report["finalist_state_count"], 1)
