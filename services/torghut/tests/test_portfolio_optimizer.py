from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.evidence_bundles import (
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.portfolio_candidates import (
    portfolio_candidate_from_payload,
)
from app.trading.discovery.portfolio_optimizer import optimize_portfolio_candidate


class TestPortfolioOptimizer(TestCase):
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

    def test_invalid_portfolio_candidate_payload_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "portfolio_candidate_schema_invalid"):
            portfolio_candidate_from_payload({"schema_version": "bad"})

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
