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
        self.assertEqual(features["configured_daily_notional_capacity"], 180000.0)
        self.assertLessEqual(
            features["estimated_max_gross_exposure_pct_equity"],
            1.0,
        )
        self.assertEqual(features["capital_feasible_flag"], 1.0)

    def test_candidate_capital_features_apply_entry_notional_multiplier_to_daily_capacity(
        self,
    ) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-half-entry-notional",
            hypothesis_id="H-HALF-ENTRY",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="configuration",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={},
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": "30000",
                "max_position_pct_equity": "0.50",
                "params": {
                    "entry_notional_max_multiplier": "0.5",
                    "max_entries_per_session": "10",
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

        self.assertEqual(features["entry_notional_max_multiplier"], 0.5)
        self.assertEqual(features["configured_daily_notional_capacity"], 150000.0)
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
                        "net_pnl_per_day": "3000",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "negative_day_count": 0,
                        "best_day_share": "0.10",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "/tmp/impact.json",
                        "market_impact_liquidity_evidence_present": True,
                        "market_impact_stress_net_pnl_per_day": "3000",
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                        "delay_adjusted_depth_fillable_notional_per_day": "300000",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "3000",
                        "delay_adjusted_depth_fill_survival_evidence_present": True,
                        "delay_adjusted_depth_fill_survival_sample_count": 12,
                        "delay_adjusted_depth_fill_survival_rate": "0.85",
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 12,
                        "queue_position_survival_fill_rate": "0.85",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 12,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 12,
                        "queue_ahead_depletion_evidence_present": True,
                        "queue_ahead_depletion_sample_count": 12,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "3000",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "/tmp/oos.json",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1",
                        "double_oos_net_pnl_per_day": "3000",
                        "double_oos_cost_shock_net_pnl_per_day": "3000",
                        "implementation_uncertainty_stability_passed": True,
                        "implementation_uncertainty_lower_net_pnl_per_day": "3000",
                        "conformal_tail_risk_passed": True,
                        "conformal_tail_risk_adjusted_net_pnl_per_day": "3000",
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

    def test_training_rows_encode_market_limit_execution_policy(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-market-limit-execution",
            claims=[
                {
                    "claim_id": "mixed-market-limit-execution-policy",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Market and limit order mix with limit fill probability "
                        "should control execution shortfall."
                    ),
                    "data_requirements": [
                        "market_limit_order_mix",
                        "limit_fill_probability",
                        "execution_shortfall",
                    ],
                    "confidence": "0.74",
                }
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("500"),
        )

        rows = build_mlx_training_rows(candidate_specs=specs, evidence_bundles=[])
        first_row = rows[0].to_payload()["features"]

        self.assertEqual(first_row["entry_order_type_prefer_limit"], 1.0)
        self.assertEqual(first_row["market_order_spread_bps_max"], 6.0)

    def test_training_rows_encode_whitepaper_mechanism_contract_features(
        self,
    ) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-paper-contract",
            hypothesis_id="H-PAPER-CONTRACT",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="configuration",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "claim-fill-survival",
                        "claim_type": "execution_assumption",
                        "confidence": "0.70",
                        "data_requirements": [
                            "queue_position",
                            "time_to_fill_quantiles",
                        ],
                    },
                    {
                        "claim_id": "claim-sim-reality-gap",
                        "claim_type": "validation_requirement",
                        "confidence": "0.80",
                        "data_requirements": [
                            "simulation_live_parity_metrics",
                            "fill_outcomes",
                        ],
                    },
                    {
                        "claim_id": "claim-ofi-response",
                        "claim_type": "signal_mechanism",
                        "confidence": "0.90",
                        "data_requirements": [
                            "order_flow_imbalance",
                            "microprice_bias",
                        ],
                    },
                ],
                "validation_requirements": [
                    {
                        "claim_id": "claim-sim-reality-gap",
                        "data_requirements": [
                            "live_paper_parity",
                            "route_tca",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "simulation_reality_gap_implementation_risk",
                        "required_evidence": [
                            "simulation_live_parity_metrics",
                            "fill_outcomes",
                            "route_tca",
                        ],
                    },
                    {
                        "overlay_id": "queue_position_survival_fill_curve",
                        "required_evidence": [
                            "queue_position",
                            "survival_fill_curve",
                        ],
                    },
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": [
                    "simulation_reality_gap_implementation_risk",
                    "queue_position_survival_fill_curve",
                    "ofi_lob_continuation_response",
                ]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_min_daily_notional": "250000"},
            expected_failure_modes=(),
            promotion_contract={
                "requires_simulation_live_parity_metrics": True,
                "requires_fill_outcomes": True,
                "rejects_synthetic_lob_fillability_as_capital_gate": True,
            },
        )

        rows = build_mlx_training_rows(candidate_specs=[spec], evidence_bundles=[])
        features = rows[0].to_payload()["features"]

        self.assertEqual(features["paper_source_claim_count"], 3.0)
        self.assertEqual(features["paper_signal_claim_count"], 1.0)
        self.assertEqual(features["paper_execution_claim_count"], 1.0)
        self.assertEqual(features["paper_validation_claim_count"], 1.0)
        self.assertAlmostEqual(features["paper_avg_claim_confidence"], 0.8)
        self.assertEqual(features["paper_source_data_requirement_count"], 6.0)
        self.assertEqual(features["paper_validation_requirement_count"], 1.0)
        self.assertEqual(features["paper_validation_data_requirement_count"], 2.0)
        self.assertEqual(features["paper_mechanism_overlay_count"], 3.0)
        self.assertEqual(features["paper_mechanism_required_evidence_count"], 5.0)
        self.assertEqual(features["paper_requires_route_tca"], 1.0)
        self.assertEqual(features["paper_requires_live_paper_parity"], 1.0)
        self.assertEqual(features["paper_requires_fill_outcomes"], 1.0)
        self.assertEqual(features["paper_requires_executable_quote"], 0.0)
        self.assertEqual(features["paper_promotion_requires_count"], 2.0)
        self.assertEqual(features["paper_promotion_rejects_count"], 1.0)
        self.assertEqual(
            features["paper_overlay_simulation_reality_gap_implementation_risk"],
            1.0,
        )
        self.assertEqual(
            features["paper_overlay_queue_position_survival_fill_curve"],
            1.0,
        )
        self.assertEqual(features["paper_overlay_ofi_lob_continuation_response"], 1.0)
        self.assertEqual(
            features["paper_overlay_mixed_market_limit_execution_policy"], 0.0
        )

    def test_training_rows_encode_conformal_cost_buffer_contract_and_evidence(
        self,
    ) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-conformal-buffer",
            hypothesis_id="H-CONFORMAL-BUFFER",
            family_template_id="intraday_tsmom_v2",
            candidate_kind="configuration",
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "regime-weighted-conformal-var-buffer",
                        "claim_type": "risk_constraint",
                        "confidence": "0.76",
                        "data_requirements": [
                            "regime_similarity_weights",
                            "conformal_tail_risk",
                            "regime_tail_exceedance",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "breakeven-cost-buffer-validation",
                        "data_requirements": [
                            "breakeven_transaction_cost_buffer",
                            "transaction_cost_buffer",
                            "seed_robustness",
                            "model_family_robustness",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "regime_weighted_conformal_cost_buffer",
                        "required_evidence": [
                            "regime_weighted_conformal_var",
                            "conformal_tail_risk",
                            "regime_tail_exceedance",
                            "breakeven_transaction_cost_buffer",
                            "seed_robustness",
                            "model_family_robustness",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["regime_weighted_conformal_cost_buffer"]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_min_daily_notional": "250000"},
            expected_failure_modes=(),
            promotion_contract={
                "requires_conformal_tail_risk": True,
                "requires_conformal_var_cost_buffer": True,
                "requires_seed_model_family_robustness": True,
                "rejects_unbuffered_tail_risk_promotion": True,
            },
        )
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-conformal-buffer",
                "objective_scorecard": {
                    "net_pnl_per_day": "650",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.70",
                    "conformal_tail_risk_required": True,
                    "conformal_tail_risk_passed": True,
                    "conformal_tail_risk_sample_count": 24,
                    "conformal_tail_risk_buffer_per_day": "125",
                    "conformal_tail_risk_adjusted_net_pnl_per_day": "525",
                },
            },
            dataset_snapshot_id="snapshot-conformal-buffer",
            result_path="/tmp/cand-conformal-buffer.json",
        )

        rows = build_mlx_training_rows(
            candidate_specs=[spec], evidence_bundles=[bundle]
        )
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_regime_weighted_conformal_cost_buffer"],
            1.0,
        )
        self.assertEqual(features["paper_requires_conformal_tail_risk"], 1.0)
        self.assertEqual(features["paper_requires_regime_tail_exceedance"], 1.0)
        self.assertEqual(features["paper_requires_breakeven_cost_buffer"], 1.0)
        self.assertEqual(
            features["paper_requires_seed_model_family_robustness"],
            1.0,
        )
        self.assertEqual(features["history_conformal_tail_risk_required"], 1.0)
        self.assertEqual(features["history_conformal_tail_risk_passed"], 1.0)
        self.assertEqual(features["history_conformal_tail_risk_sample_count"], 24.0)
        self.assertEqual(features["history_conformal_tail_risk_buffer_per_day"], 125.0)
        self.assertEqual(
            features["history_conformal_tail_risk_adjusted_net_pnl_per_day"],
            525.0,
        )
        self.assertEqual(
            features["history_conformal_tail_risk_target_shortfall"],
            0.0,
        )

    def test_training_rows_encode_friction_aware_regime_contract(self) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-frlux",
            hypothesis_id="H-FRLUX",
            family_template_id="intraday_tsmom_v2",
            candidate_kind="configuration",
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "friction-aware-regime-conditioned-policy",
                        "claim_type": "feature_recipe",
                        "confidence": "0.76",
                        "data_requirements": [
                            "regime_state",
                            "regime_conditioned_policy",
                            "proportional_cost_model",
                            "impact_cost_model",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "frlux-validation",
                        "data_requirements": [
                            "trade_space_trust_region",
                            "turnover_budget",
                            "cost_misspecification_stress",
                            "liquidity_proxy_cost_calibration",
                            "scenario_level_inference",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "friction_aware_regime_conditioned_policy",
                        "required_evidence": [
                            "regime_state",
                            "regime_conditioned_policy",
                            "trade_space_trust_region",
                            "turnover_budget",
                            "cost_misspecification_stress",
                            "liquidity_proxy_cost_calibration",
                            "scenario_level_inference",
                            "live_paper_parity",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["friction_aware_regime_conditioned_policy"]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_min_daily_notional": "250000"},
            expected_failure_modes=(),
            promotion_contract={
                "requires_regime_conditioned_policy": True,
                "requires_turnover_budget": True,
                "requires_cost_misspecification_stress": True,
                "rejects_cost_blind_policy_optimization": True,
            },
        )

        rows = build_mlx_training_rows(candidate_specs=[spec], evidence_bundles=[])
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_friction_aware_regime_conditioned_policy"],
            1.0,
        )
        self.assertEqual(features["paper_requires_regime_conditioning"], 1.0)
        self.assertEqual(features["paper_requires_trade_space_trust_region"], 1.0)
        self.assertEqual(features["paper_requires_turnover_budget"], 1.0)
        self.assertEqual(features["paper_requires_cost_misspecification_stress"], 1.0)
        self.assertEqual(
            features["paper_requires_liquidity_proxy_cost_calibration"], 1.0
        )
        self.assertEqual(features["paper_requires_scenario_level_inference"], 1.0)
        self.assertEqual(features["paper_requires_live_paper_parity"], 1.0)
        self.assertEqual(features["paper_promotion_requires_count"], 3.0)
        self.assertEqual(features["paper_promotion_rejects_count"], 1.0)

    def test_training_rows_encode_crumbling_quote_overlay_contract(self) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-crumbling-quotes",
            hypothesis_id="H-CRUMBLING-QUOTES",
            family_template_id="microstructure_continuation_matched_filter_v1",
            candidate_kind="configuration",
            runtime_family="microstructure_continuation",
            runtime_strategy_name="microstructure-continuation-matched-filter-v1",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "crumbling-quote-probability",
                        "claim_type": "execution_assumption",
                        "confidence": "0.78",
                        "data_requirements": [
                            "crumbling_quote_probability",
                            "mechanical_liquidity_erosion",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "crumbling-route-tca-validation",
                        "data_requirements": [
                            "executable_quote",
                            "route_tca",
                            "live_paper_parity",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "crumbling_quote_liquidity_erosion",
                        "required_evidence": [
                            "crumbling_quote_probability",
                            "mechanical_liquidity_erosion",
                            "lob_event_stream",
                            "executable_quote",
                            "route_tca",
                            "live_paper_parity",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["crumbling_quote_liquidity_erosion"]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_crumbling_quote_probability": True},
            expected_failure_modes=(),
            promotion_contract={
                "requires_crumbling_quote_probability": True,
                "requires_mechanical_liquidity_erosion_probability": True,
                "requires_live_paper_parity": True,
                "rejects_crumbling_quote_simulation_as_promotion_proof": True,
            },
        )

        rows = build_mlx_training_rows(candidate_specs=[spec], evidence_bundles=[])
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_crumbling_quote_liquidity_erosion"],
            1.0,
        )
        self.assertEqual(features["paper_requires_crumbling_quote_probability"], 1.0)
        self.assertEqual(
            features["paper_requires_mechanical_liquidity_erosion"],
            1.0,
        )
        self.assertEqual(features["paper_requires_executable_quote"], 1.0)
        self.assertEqual(features["paper_requires_route_tca"], 1.0)
        self.assertEqual(features["paper_requires_live_paper_parity"], 1.0)
        self.assertEqual(features["paper_promotion_requires_count"], 3.0)
        self.assertEqual(features["paper_promotion_rejects_count"], 1.0)

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
            schema_version=mlx_training_data_module.MLX_RANKER_SCHEMA_VERSION,
            model_id="mlx-ranker-v2-test",
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

    def test_training_rows_penalize_negative_post_cost_efficiency(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-COST-EFFICIENCY",
            "family_template_id": "microbar_cross_sectional_pairs_v1",
            "candidate_kind": "configuration",
            "runtime_family": "microbar_cross_sectional_pairs",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "feedback_daily_coverage_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "25000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        cost_killed = CandidateSpec(candidate_spec_id="spec-cost-killed", **base_kwargs)
        efficient = CandidateSpec(
            candidate_spec_id="spec-efficient",
            **{**base_kwargs, "hypothesis_id": "H-COST-EFFICIENT"},
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=cost_killed.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-cost-killed",
                    "objective_scorecard": {
                        "net_pnl_per_day": "-50",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "0",
                        "negative_day_count": 2,
                        "avg_filled_notional_per_day": "25000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-cost-killed",
                result_path="/tmp/cand-cost-killed.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=efficient.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-efficient",
                    "objective_scorecard": {
                        "net_pnl_per_day": "50",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "avg_filled_notional_per_day": "25000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-efficient",
                result_path="/tmp/cand-efficient.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[cost_killed, efficient],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        cost_killed_features = row_by_spec[cost_killed.candidate_spec_id].to_payload()[
            "features"
        ]
        efficient_features = row_by_spec[efficient.candidate_spec_id].to_payload()[
            "features"
        ]

        self.assertEqual(
            cost_killed_features["history_net_pnl_per_100k_filled_notional"],
            -200.0,
        )
        self.assertGreater(
            cost_killed_features["history_post_cost_efficiency_penalty"],
            efficient_features["history_post_cost_efficiency_penalty"],
        )
        self.assertLess(
            row_by_spec[cost_killed.candidate_spec_id].target,
            row_by_spec[efficient.candidate_spec_id].target - 500.0,
        )

    def test_training_rows_penalize_configured_daily_notional_shortfall(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-CAPACITY",
            "family_template_id": "breakout_reclaim_v2",
            "candidate_kind": "configuration",
            "runtime_family": "breakout_continuation_consistent",
            "runtime_strategy_name": "breakout-continuation-long-v1",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_position_pct_equity": "0.25",
                "params": {
                    "max_entries_per_session": "2",
                    "top_n": "1",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "300000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        low_capacity = CandidateSpec(
            candidate_spec_id="spec-low-capacity",
            **{
                **base_kwargs,
                "strategy_overrides": {
                    **base_kwargs["strategy_overrides"],
                    "max_notional_per_trade": "10000",
                },
            },
        )
        full_capacity = CandidateSpec(
            candidate_spec_id="spec-full-capacity",
            **{
                **base_kwargs,
                "hypothesis_id": "H-CAPACITY-FULL",
                "strategy_overrides": {
                    **base_kwargs["strategy_overrides"],
                    "max_notional_per_trade": "30000",
                    "params": {
                        **base_kwargs["strategy_overrides"]["params"],
                        "max_entries_per_session": "10",
                    },
                },
            },
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": f"cand-{spec.candidate_spec_id}",
                    "objective_scorecard": {
                        "net_pnl_per_day": "25",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "avg_filled_notional_per_day": "300000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id=f"snapshot-{spec.candidate_spec_id}",
                result_path=f"/tmp/{spec.candidate_spec_id}.json",
            )
            for spec in (low_capacity, full_capacity)
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[low_capacity, full_capacity],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        low_payload = row_by_spec[low_capacity.candidate_spec_id].to_payload()
        full_payload = row_by_spec[full_capacity.candidate_spec_id].to_payload()

        self.assertEqual(
            low_payload["features"]["configured_daily_notional_required_ratio"],
            20000.0 / 300000.0,
        )
        self.assertEqual(
            full_payload["features"]["configured_daily_notional_required_ratio"],
            1.0,
        )
        self.assertLess(
            row_by_spec[low_capacity.candidate_spec_id].target,
            row_by_spec[full_capacity.candidate_spec_id].target - 650.0,
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
                        "implementation_uncertainty_stability_passed": False,
                        "implementation_uncertainty_lower_net_pnl_per_day": "25",
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
                        "market_impact_stress_model": "almgren_chriss_proxy",
                        "market_impact_stress_cost_bps": "6",
                        "market_impact_stress_components": {
                            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                            "selected_model": "almgren_chriss_proxy",
                            "selected_cost_bps": "6",
                        },
                        "nonlinear_market_impact_stress_passed": True,
                        "nonlinear_market_impact_stress_model": "almgren_chriss_proxy",
                        "nonlinear_market_impact_stress_cost_bps": "6",
                        "nonlinear_market_impact_stress_net_pnl_per_day": "515",
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
                        "implementation_uncertainty_stability_passed": True,
                        "implementation_uncertainty_lower_net_pnl_per_day": "502",
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

    def test_training_target_prefers_deployable_lower_bound_over_optimistic_net(
        self,
    ) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-LOWER-BOUND",
            "family_template_id": "intraday_tsmom_v2",
            "candidate_kind": "configuration",
            "runtime_family": "intraday_tsmom_consistent",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "feedback_daily_coverage_cash_constrained_1x",
                    "max_entries_per_session": "12",
                    "max_gross_exposure_pct_equity": "1.0",
                    "top_n": "1",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "250000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        optimistic = CandidateSpec(
            candidate_spec_id="spec-optimistic-high-net",
            **base_kwargs,
        )
        raw_only = CandidateSpec(
            candidate_spec_id="spec-raw-only-high-net",
            **{**base_kwargs, "hypothesis_id": "H-LOWER-BOUND-RAW-ONLY"},
        )
        robust = CandidateSpec(
            candidate_spec_id="spec-robust-lower-bound",
            **{**base_kwargs, "hypothesis_id": "H-LOWER-BOUND-ROBUST"},
        )
        shared_scorecard = {
            "active_day_ratio": "1",
            "positive_day_ratio": "1",
            "negative_day_count": 0,
            "best_day_share": "0.10",
            "worst_day_loss": "0",
            "max_drawdown": "25",
            "avg_filled_notional_per_day": "300000",
            "hard_vetoes": [],
            "market_impact_stress_passed": True,
            "market_impact_stress_artifact_ref": "/tmp/impact.json",
            "market_impact_liquidity_evidence_present": True,
            "delay_adjusted_depth_stress_passed": True,
            "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
            "delay_adjusted_depth_fillable_notional_per_day": "300000",
            "double_oos_passed": True,
            "double_oos_artifact_ref": "/tmp/oos.json",
            "double_oos_independent_window_count": 2,
            "double_oos_pass_rate": "1",
            "implementation_uncertainty_stability_passed": True,
        }
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=optimistic.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-optimistic",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "net_pnl_per_day": "1500",
                        "market_impact_stress_net_pnl_per_day": "320",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "280",
                        "double_oos_net_pnl_per_day": "260",
                        "double_oos_cost_shock_net_pnl_per_day": "240",
                        "implementation_uncertainty_lower_net_pnl_per_day": "220",
                    },
                },
                dataset_snapshot_id="snapshot-optimistic",
                result_path="/tmp/cand-optimistic.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=robust.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-robust",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "net_pnl_per_day": "620",
                        "market_impact_stress_net_pnl_per_day": "610",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "600",
                        "double_oos_net_pnl_per_day": "595",
                        "double_oos_cost_shock_net_pnl_per_day": "590",
                        "implementation_uncertainty_lower_net_pnl_per_day": "580",
                    },
                },
                dataset_snapshot_id="snapshot-robust",
                result_path="/tmp/cand-robust.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=raw_only.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-raw-only",
                    "objective_scorecard": {
                        "net_pnl_per_day": "2500",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "best_day_share": "0.10",
                        "worst_day_loss": "0",
                        "max_drawdown": "25",
                        "avg_filled_notional_per_day": "300000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-raw-only",
                result_path="/tmp/cand-raw-only.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[optimistic, robust, raw_only],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        optimistic_payload = row_by_spec[optimistic.candidate_spec_id].to_payload()
        robust_payload = row_by_spec[robust.candidate_spec_id].to_payload()
        raw_only_payload = row_by_spec[raw_only.candidate_spec_id].to_payload()

        self.assertEqual(
            optimistic_payload["features"][
                "history_deployable_lower_bound_net_pnl_per_day"
            ],
            220.0,
        )
        self.assertEqual(
            robust_payload["features"][
                "history_deployable_lower_bound_net_pnl_per_day"
            ],
            580.0,
        )
        self.assertLess(
            row_by_spec[optimistic.candidate_spec_id].target,
            row_by_spec[robust.candidate_spec_id].target,
        )
        self.assertGreater(
            raw_only_payload["features"][
                "history_deployable_lower_bound_missing_count"
            ],
            0.0,
        )
        self.assertLess(
            row_by_spec[raw_only.candidate_spec_id].target,
            row_by_spec[robust.candidate_spec_id].target,
        )
