from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.candidate_specs import compile_candidate_specs
from app.trading.discovery.evidence_bundles import (
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.hypothesis_cards import build_hypothesis_cards
from app.trading.discovery.mlx_training_data import (
    build_mlx_training_rows,
    rank_training_rows,
    train_mlx_ranker,
)


class TestMlxTrainingData(TestCase):
    def test_training_rows_build_from_evidence_bundles_and_rank_deterministically(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-1",
            claims=[
                {
                    "claim_id": "claim-1",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Momentum pullback ranking improves continuation entries.",
                    "confidence": "0.8",
                }
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("500"),
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=specs[0].candidate_spec_id,
                candidate={
                    "candidate_id": "cand-1",
                    "objective_scorecard": {
                        "net_pnl_per_day": "275",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.8",
                    },
                },
                dataset_snapshot_id="snapshot-1",
                result_path="/tmp/cand-1.json",
            )
        ]

        rows = build_mlx_training_rows(candidate_specs=specs, evidence_bundles=bundles)
        model = train_mlx_ranker(rows, backend_preference="numpy-fallback", steps=4)
        ranked = rank_training_rows(model=model, rows=rows)

        self.assertEqual(len(rows), 1)
        self.assertEqual(model.backend, "numpy-fallback")
        self.assertEqual(ranked[0].rank, 1)
