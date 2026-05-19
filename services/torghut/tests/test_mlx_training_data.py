from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.candidate_specs import CandidateSpec, compile_candidate_specs
from app.trading.discovery.evidence_bundles import (
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.hypothesis_cards import build_hypothesis_cards
import app.trading.discovery.mlx_training_data as mlx_training_data_module
from app.trading.discovery.mlx_training_data import (
    MlxRankerModel,
    MlxTrainingRow,
    build_mlx_training_rows,
    candidate_spec_capital_features,
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
    def test_training_feedback_helpers_handle_string_vetoes_and_scalar_sequences(
        self,
    ) -> None:
        self.assertEqual(
            mlx_training_data_module._hard_veto_count(
                {"hard_vetoes": "positive_day_ratio_below_oracle"}
            ),
            1.0,
        )
        self.assertEqual(
            mlx_training_data_module._hard_veto_count({"hard_vetoes": "  "}),
            0.0,
        )
        self.assertEqual(mlx_training_data_module._sequence_strings("NVDA"), ())
        self.assertEqual(
            mlx_training_data_module._sequence_strings(["NVDA", "", "AMD"]),
            ("NVDA", "AMD"),
        )

    def test_candidate_capital_features_include_runtime_slot_pressure(self) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-slot-pressure",
            hypothesis_id="H-SLOT",
            family_template_id="breakout_reclaim_v2",
            candidate_kind="configuration",
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
            feature_contract={},
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": "10000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "max_gross_exposure_pct_equity": "1.0",
                    "max_entries_per_session": "2",
                    "max_concurrent_positions": "4",
                    "entry_notional_max_multiplier": "1.5",
                },
            },
            objective={},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )

        features = candidate_spec_capital_features(spec)

        self.assertEqual(features["estimated_capital_slot_count"], 4.0)
        self.assertEqual(features["entry_notional_max_multiplier"], 1.5)
        self.assertGreater(features["estimated_max_gross_exposure_pct_equity"], 1.0)
        self.assertEqual(features["capital_feasible_flag"], 0.0)

    def test_candidate_capital_features_treat_session_entries_as_turnover(
        self,
    ) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-turnover-not-concurrency",
            hypothesis_id="H-TURNOVER",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="configuration",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={},
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": "15000",
                "max_position_pct_equity": "0.50",
                "params": {
                    "max_gross_exposure_pct_equity": "1.0",
                    "max_entries_per_session": "12",
                    "max_concurrent_positions": "1",
                    "top_n": "1",
                },
            },
            objective={},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )

        features = candidate_spec_capital_features(spec)

        self.assertEqual(features["max_entries_per_session"], 12.0)
        self.assertEqual(features["estimated_capital_slot_count"], 1.0)
        self.assertLessEqual(
            features["estimated_max_gross_exposure_pct_equity"],
            1.0,
        )
        self.assertEqual(features["capital_feasible_flag"], 1.0)

    def test_candidate_capital_features_infer_uncapped_universe_slots(self) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-uncapped-universe",
            hypothesis_id="H-UNCAPPED",
            family_template_id="momentum_pullback_v1",
            candidate_kind="configuration",
            runtime_family="momentum_pullback_consistent",
            runtime_strategy_name="momentum-pullback-long-v1",
            feature_contract={},
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": "30000",
                "max_position_pct_equity": "1",
                "params": {"max_gross_exposure_pct_equity": "1.0"},
                "universe_symbols": ["NVDA", "AVGO", "AMD"],
            },
            objective={},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )

        features = candidate_spec_capital_features(spec)

        self.assertEqual(features["inferred_universe_slot_floor"], 3.0)
        self.assertEqual(features["estimated_capital_slot_count"], 3.0)
        self.assertGreater(features["estimated_max_gross_exposure_pct_equity"], 1.0)
        self.assertEqual(features["capital_feasible_flag"], 0.0)

    def test_observed_replay_viability_penalty_marks_zero_activity_notional_gap(
        self,
    ) -> None:
        penalty = mlx_training_data_module._observed_replay_viability_penalty(
            {
                "active_day_ratio": "0",
                "positive_day_ratio": "0",
                "avg_filled_notional_per_day": "0",
                "net_pnl_per_day": "0",
            },
            required_min_daily_notional=0.0,
            target_net_pnl_per_day=500.0,
        )

        self.assertEqual(penalty, 2150.0)

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
                        "net_pnl_per_day": "500",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "negative_day_count": 0,
                        "best_day_share": "0.10",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "/tmp/impact.json",
                        "market_impact_liquidity_evidence_present": True,
                        "market_impact_stress_net_pnl_per_day": "500",
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                        "delay_adjusted_depth_fillable_notional_per_day": "300000",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "500",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "/tmp/oos.json",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1",
                        "double_oos_net_pnl_per_day": "500",
                        "double_oos_cost_shock_net_pnl_per_day": "500",
                    },
                },
                dataset_snapshot_id="snapshot-1",
                result_path="/tmp/cand-1.json",
            )
        ]

        rows = build_mlx_training_rows(candidate_specs=specs, evidence_bundles=bundles)
        model = train_mlx_ranker(rows, backend_preference="numpy-fallback", steps=10)
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
        self.assertEqual(result.selection_reason, "heuristic_negative_lift_fallback")
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

    def test_training_rows_penalize_flat_real_replay_evidence(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-FLAT",
            "family_template_id": "momentum_pullback_v1",
            "candidate_kind": "configuration",
            "runtime_family": "momentum_pullback_consistent",
            "runtime_strategy_name": "momentum-pullback-long-v1",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "1",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "300000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        flat = CandidateSpec(candidate_spec_id="spec-flat", **base_kwargs)
        active = CandidateSpec(
            candidate_spec_id="spec-active",
            **{**base_kwargs, "hypothesis_id": "H-ACTIVE"},
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=flat.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-flat",
                    "objective_scorecard": {
                        "net_pnl_per_day": "0",
                        "active_day_ratio": "0",
                        "positive_day_ratio": "0",
                        "avg_filled_notional_per_day": "0",
                        "hard_vetoes": [
                            "active_day_ratio_below_oracle",
                            "avg_filled_notional_per_day_below_oracle",
                        ],
                    },
                },
                dataset_snapshot_id="snapshot-flat",
                result_path="/tmp/cand-flat.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=active.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-active",
                    "objective_scorecard": {
                        "net_pnl_per_day": "25",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "0.8",
                        "avg_filled_notional_per_day": "350000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-active",
                result_path="/tmp/cand-active.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[flat, active],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}

        self.assertGreater(
            row_by_spec[flat.candidate_spec_id].to_payload()["features"][
                "history_observed_replay_viability_penalty"
            ],
            0.0,
        )
        self.assertLess(
            row_by_spec[flat.candidate_spec_id].target,
            row_by_spec[active.candidate_spec_id].target - 1000.0,
        )

    def test_training_rows_penalize_missing_execution_proof_feedback(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-PROOF",
            "family_template_id": "microstructure_continuation_matched_filter_v1",
            "candidate_kind": "configuration",
            "runtime_family": "intraday_tsmom_consistent",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "1",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "300000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        missing_proof = CandidateSpec(
            candidate_spec_id="spec-missing-proof", **base_kwargs
        )
        passing_proof = CandidateSpec(
            candidate_spec_id="spec-passing-proof",
            **{**base_kwargs, "hypothesis_id": "H-PROOF-PASSING"},
        )
        shared_scorecard = {
            "net_pnl_per_day": "520",
            "active_day_ratio": "1",
            "positive_day_ratio": "1",
            "negative_day_count": 0,
            "best_day_share": "0.20",
            "worst_day_loss": "0",
            "max_drawdown": "40",
            "avg_filled_notional_per_day": "350000",
            "hard_vetoes": [],
        }
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=missing_proof.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-missing-proof",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "market_impact_stress_passed": False,
                        "market_impact_liquidity_evidence_present": False,
                        "market_impact_stress_net_pnl_per_day": "200",
                        "delay_adjusted_depth_stress_passed": False,
                        "delay_adjusted_depth_stress_net_pnl_per_day": "150",
                        "delay_adjusted_depth_fillable_notional_per_day": "0",
                        "double_oos_passed": False,
                        "double_oos_independent_window_count": 0,
                        "double_oos_pass_rate": "0",
                        "double_oos_net_pnl_per_day": "100",
                        "double_oos_cost_shock_net_pnl_per_day": "50",
                    },
                },
                dataset_snapshot_id="snapshot-missing-proof",
                result_path="/tmp/cand-missing-proof.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=passing_proof.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-passing-proof",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "/tmp/market-impact.json",
                        "market_impact_stress_cost_bps": "6",
                        "market_impact_liquidity_evidence_present": True,
                        "market_impact_stress_net_pnl_per_day": "515",
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                        "delay_adjusted_depth_stress_ms": "250",
                        "delay_adjusted_depth_fillable_notional_per_day": "525000",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "510",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "/tmp/double-oos.json",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1",
                        "double_oos_net_pnl_per_day": "515",
                        "double_oos_cost_shock_net_pnl_per_day": "505",
                    },
                },
                dataset_snapshot_id="snapshot-passing-proof",
                result_path="/tmp/cand-passing-proof.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[missing_proof, passing_proof],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        missing_payload = row_by_spec[missing_proof.candidate_spec_id].to_payload()
        passing_payload = row_by_spec[passing_proof.candidate_spec_id].to_payload()

        self.assertEqual(
            missing_payload["features"]["history_market_impact_stress_passed"],
            0.0,
        )
        self.assertEqual(
            passing_payload["features"]["history_market_impact_stress_passed"],
            1.0,
        )
        self.assertGreater(
            missing_payload["features"]["history_double_oos_target_shortfall"],
            passing_payload["features"]["history_double_oos_target_shortfall"],
        )
        self.assertLess(
            row_by_spec[missing_proof.candidate_spec_id].target,
            row_by_spec[passing_proof.candidate_spec_id].target - 2000.0,
        )
