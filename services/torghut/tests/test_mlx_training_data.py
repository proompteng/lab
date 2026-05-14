from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.candidate_specs import compile_candidate_specs
from app.trading.discovery.evidence_bundles import (
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.hypothesis_cards import build_hypothesis_cards
from app.trading.discovery.mlx_training_data import (
    MlxRankerModel,
    MlxTrainingRow,
    build_mlx_training_rows,
    rank_training_rows,
    rank_training_rows_with_lift_policy,
    train_mlx_ranker,
)


def _capital_profile(spec: object) -> object:
    strategy_overrides = getattr(spec, "strategy_overrides", {})
    params = (
        strategy_overrides.get("params")
        if isinstance(strategy_overrides, dict)
        else None
    )
    return params.get("capital_profile") if isinstance(params, dict) else None


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
        evidenced_spec = next(
            spec
            for spec in specs
            if _capital_profile(spec) == "initial_equity_cash_constrained_1x"
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=evidenced_spec.candidate_spec_id,
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

        self.assertEqual(len(rows), len(specs))
        self.assertEqual(model.backend, "numpy-fallback")
        self.assertEqual(ranked[0].rank, 1)
        self.assertEqual(ranked[0].candidate_spec_id, evidenced_spec.candidate_spec_id)

    def test_negative_rank_bucket_lift_demotes_to_heuristic_order(self) -> None:
        rows = [
            MlxTrainingRow(
                candidate_spec_id="aaa-strong",
                feature_names=("signal",),
                feature_values=(0.0,),
                target=500.0,
            ),
            MlxTrainingRow(
                candidate_spec_id="zzz-weak",
                feature_names=("signal",),
                feature_values=(0.0,),
                target=-100.0,
            ),
        ]
        tie_model = MlxRankerModel(
            schema_version="torghut.mlx-ranker.v1",
            model_id="mlx-ranker-v1-test",
            backend="numpy-fallback",
            feature_names=("signal",),
            feature_means=(0.0,),
            feature_scales=(1.0,),
            target_mean=0.0,
            target_scale=1.0,
            weights=(0.0,),
            bias=0.0,
            row_count=2,
            training_loss=0.0,
            trained_at="2026-04-21T00:00:00+00:00",
        )

        result = rank_training_rows_with_lift_policy(model=tie_model, rows=rows)

        self.assertEqual(result.model_status, "demoted_to_heuristic")
        self.assertEqual(
            result.selection_reason, "heuristic_negative_lift_fallback"
        )
        self.assertLess(result.rank_bucket_lift.lift, 0)
        self.assertEqual(result.ranked_rows[0].candidate_spec_id, "aaa-strong")
        self.assertEqual(result.ranked_rows[0].score, 500.0)

    def test_training_rows_penalize_capital_infeasible_specs(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-capital-features",
            claims=[
                {
                    "claim_id": "claim-capital-features",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering improves intraday continuation.",
                    "confidence": "0.82",
                }
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        over_budget = next(
            spec
            for spec in specs
            if _capital_profile(spec) != "initial_equity_cash_constrained_1x"
        )
        feasible = next(
            spec
            for spec in specs
            if _capital_profile(spec) == "initial_equity_cash_constrained_1x"
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": f"cand-{index}",
                    "objective_scorecard": {
                        "net_pnl_per_day": "500",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                    },
                },
                dataset_snapshot_id="snapshot-capital",
                result_path=f"/tmp/cand-{index}.json",
            )
            for index, spec in enumerate((over_budget, feasible), start=1)
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[over_budget, feasible],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        over_payload = row_by_spec[over_budget.candidate_spec_id].to_payload()
        feasible_payload = row_by_spec[feasible.candidate_spec_id].to_payload()

        self.assertGreater(
            over_payload["features"]["capital_budget_overage_ratio"], 0.0
        )
        self.assertEqual(over_payload["features"]["capital_feasible_flag"], 0.0)
        self.assertEqual(feasible_payload["features"]["capital_feasible_flag"], 1.0)
        self.assertLess(
            row_by_spec[over_budget.candidate_spec_id].target,
            row_by_spec[feasible.candidate_spec_id].target,
        )
