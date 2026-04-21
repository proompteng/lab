from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.candidate_specs import (
    compile_candidate_specs,
    candidate_spec_from_payload,
)
from app.trading.discovery.evidence_bundles import (
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.hypothesis_cards import (
    build_hypothesis_cards,
    hypothesis_card_from_payload,
)
from app.trading.discovery.mlx_training_data import (
    build_mlx_training_rows,
    rank_training_rows,
    train_mlx_ranker,
)
from app.trading.discovery.portfolio_optimizer import optimize_portfolio_candidate


class TestWhitepaperAutoresearchArtifacts(TestCase):
    def test_hypothesis_and_candidate_specs_round_trip(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday trading signals.",
                    "asset_scope": "us_equities_intraday",
                    "horizon_scope": "intraday",
                    "expected_direction": "positive",
                    "confidence": "0.82",
                }
            ],
        )

        self.assertEqual(len(cards), 1)
        reloaded_card = hypothesis_card_from_payload(cards[0].to_payload())
        self.assertEqual(reloaded_card.hypothesis_id, cards[0].hypothesis_id)
        self.assertIn("order_flow_imbalance", reloaded_card.required_features)

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        self.assertEqual(len(specs), 1)
        self.assertEqual(
            specs[0].family_template_id, "microbar_cross_sectional_pairs_v1"
        )
        self.assertEqual(specs[0].objective["target_net_pnl_per_day"], "500")

        reloaded_spec = candidate_spec_from_payload(specs[0].to_payload())
        self.assertEqual(reloaded_spec.candidate_spec_id, specs[0].candidate_spec_id)
        self.assertEqual(
            reloaded_spec.to_vnext_experiment_payload()["family_template_id"],
            "microbar_cross_sectional_pairs_v1",
        )

    def test_evidence_training_rows_and_portfolio_optimizer(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Trade-flow order flow clustering creates a transferable intraday signal.",
                    "confidence": "0.82",
                },
                {
                    "claim_id": "claim-momentum",
                    "claim_type": "feature_recipe",
                    "claim_text": "Momentum pullback ranking improves continuation entries.",
                    "confidence": "0.76",
                },
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"{spec.candidate_spec_id}-{index}",
                candidate={
                    "candidate_id": f"cand-{index}",
                    "objective_scorecard": {
                        "net_pnl_per_day": str(300 - (index * 25)),
                        "active_day_ratio": "0.92",
                        "positive_day_ratio": "0.64",
                        "worst_day_loss": "150",
                        "max_drawdown": "400",
                        "best_day_share": "0.18",
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path=f"/tmp/result-{index}.json",
            )
            for index, spec in enumerate([specs[0], specs[0]], start=1)
        ]

        rows = build_mlx_training_rows(candidate_specs=specs, evidence_bundles=bundles)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].feature_names[0], "family_code")

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("500"),
            portfolio_size_min=2,
            portfolio_size_max=4,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertEqual(len(portfolio.sleeves), 2)

    def test_mlx_ranker_learns_and_scores_training_rows(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Trade-flow order flow clustering creates a transferable intraday signal.",
                    "confidence": "0.82",
                }
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        high_spec = specs[0]
        low_spec = candidate_spec_from_payload(
            {
                **high_spec.to_payload(),
                "candidate_spec_id": f"{high_spec.candidate_spec_id}-low",
                "hypothesis_id": f"{high_spec.hypothesis_id}-low",
            }
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=high_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "high",
                    "objective_scorecard": {
                        "net_pnl_per_day": "500",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.8",
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/high.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=low_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "low",
                    "objective_scorecard": {
                        "net_pnl_per_day": "50",
                        "active_day_ratio": "0.5",
                        "positive_day_ratio": "0.4",
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/low.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[high_spec, low_spec],
            evidence_bundles=bundles,
        )
        model = train_mlx_ranker(rows, backend_preference="numpy-fallback", steps=128)
        ranked = rank_training_rows(model=model, rows=rows)

        self.assertEqual(model.schema_version, "torghut.mlx-ranker.v1")
        self.assertEqual(model.backend, "numpy-fallback")
        self.assertEqual(model.row_count, 2)
        self.assertEqual(ranked[0].candidate_spec_id, high_spec.candidate_spec_id)
        self.assertGreater(ranked[0].score, ranked[1].score)

    def test_portfolio_optimizer_uses_daily_vectors_and_correlation_cap(self) -> None:
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-a",
                candidate={
                    "candidate_id": "cand-a",
                    "objective_scorecard": {
                        "net_pnl_per_day": "300",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "200",
                            "2026-02-24": "400",
                            "2026-02-25": "300",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/a.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-b",
                candidate={
                    "candidate_id": "cand-b",
                    "objective_scorecard": {
                        "net_pnl_per_day": "270",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "100",
                            "2026-02-24": "350",
                            "2026-02-25": "360",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/b.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-c",
                candidate={
                    "candidate_id": "cand-c",
                    "objective_scorecard": {
                        "net_pnl_per_day": "260",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "180",
                            "2026-02-24": "360",
                            "2026-02-25": "270",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/c.json",
            ),
        ]

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("700"),
            portfolio_size_min=2,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertEqual(portfolio.source_candidate_ids, ("cand-a", "cand-b"))
        self.assertEqual(portfolio.objective_scorecard["net_pnl_per_day"], "570")
        self.assertEqual(portfolio.objective_scorecard["worst_day_loss"], "0")
        self.assertEqual(
            portfolio.objective_scorecard["daily_net"],
            {
                "2026-02-23": "300",
                "2026-02-24": "750",
                "2026-02-25": "660",
            },
        )
        rejection_reasons = [
            item["reason"] for item in portfolio.optimizer_report["rejections"]
        ]
        self.assertIn("correlation_cap", rejection_reasons)
