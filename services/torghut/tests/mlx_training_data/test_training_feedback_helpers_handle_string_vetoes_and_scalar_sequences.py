from __future__ import annotations

from app.trading.discovery.mlx_training_data.paper_contract_feature_values import (
    observed_replay_viability_penalty,
)
from app.trading.discovery.mlx_training_data.shared_context import (
    hard_veto_count,
    sequence_strings,
)

from tests.mlx_training_data.support import (
    CandidateSpec,
    Decimal,
    _TestMlxTrainingDataBase,
    _capital_profile,
    build_hypothesis_cards,
    build_mlx_training_rows,
    candidate_spec_capital_features,
    compile_candidate_specs,
    evidence_bundle_from_frontier_candidate,
    rank_training_rows,
    train_mlx_ranker,
)


class TestTrainingFeedbackHelpersHandleStringVetoesAndScalarSequences(
    _TestMlxTrainingDataBase
):
    def test_training_feedback_helpers_handle_string_vetoes_and_scalar_sequences(
        self,
    ) -> None:
        self.assertEqual(
            hard_veto_count({"hard_vetoes": "positive_day_ratio_below_oracle"}),
            1.0,
        )
        self.assertEqual(hard_veto_count({"hard_vetoes": "  "}), 0.0)
        self.assertEqual(sequence_strings("NVDA"), ())
        self.assertEqual(
            sequence_strings(["NVDA", "", "AMD"]),
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
        penalty = observed_replay_viability_penalty(
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

    def test_training_rows_encode_bootstrap_robust_optimization_contract(
        self,
    ) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-bootstrap-robust",
            hypothesis_id="H-BOOTSTRAP-ROBUST",
            family_template_id="intraday_tsmom_v2",
            candidate_kind="configuration",
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "bootstrap-robust-optimization",
                        "claim_type": "strategy_mechanism",
                        "confidence": "0.78",
                        "data_requirements": [
                            "bootstrap_confidence_interval",
                            "utility_percentile",
                            "resampled_strategy_optimization",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "bootstrap-stability-validation",
                        "data_requirements": [
                            "parameter_instability_stress",
                            "selection_bias_stress",
                            "model_misspecification_stress",
                            "out_of_sample_generalization",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "bootstrap_robust_optimization_stability",
                        "required_evidence": [
                            "bootstrap_confidence_interval",
                            "utility_percentile",
                            "selection_bias_stress",
                            "parameter_instability_stress",
                            "model_misspecification_stress",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["bootstrap_robust_optimization_stability"]
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
                "requires_bootstrap_robust_optimization": True,
                "requires_bootstrap_confidence_intervals": True,
                "requires_utility_percentile_optimization": True,
                "rejects_point_estimate_only_optimization": True,
            },
        )
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-bootstrap-robust",
                "objective_scorecard": {
                    "net_pnl_per_day": "650",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.70",
                    "bootstrap_percentile_robust_net_pnl_per_day": "520",
                },
            },
            dataset_snapshot_id="snapshot-bootstrap-robust",
            result_path="/tmp/cand-bootstrap-robust.json",
        )

        rows = build_mlx_training_rows(
            candidate_specs=[spec], evidence_bundles=[bundle]
        )
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_bootstrap_robust_optimization_stability"],
            1.0,
        )
        self.assertEqual(features["paper_requires_bootstrap_confidence_interval"], 1.0)
        self.assertEqual(
            features["paper_requires_utility_percentile_optimization"], 1.0
        )
        self.assertEqual(features["paper_requires_selection_bias_stress"], 1.0)
        self.assertEqual(features["paper_requires_parameter_instability_stress"], 1.0)

    def test_training_rows_encode_risk_aware_trading_portfolio_contract(
        self,
    ) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-ratpo",
            hypothesis_id="H-RATPO",
            family_template_id="intraday_tsmom_v2",
            candidate_kind="configuration",
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "ratpo-risk-pnl-optimizer",
                        "claim_type": "portfolio_construction",
                        "confidence": "0.76",
                        "data_requirements": [
                            "risk_aware_trading_portfolio_optimization",
                            "market_risk_var",
                            "pnl_objective",
                            "eligible_instrument_universe",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "ratpo-risk-limit-validation",
                        "data_requirements": [
                            "market_sensitivity_constraints",
                            "capital_charge_stress",
                            "risk_limit_compliance",
                            "portfolio_replay",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "risk_aware_trading_portfolio_optimization",
                        "required_evidence": [
                            "portfolio_replay",
                            "market_risk_var",
                            "market_sensitivity_constraints",
                            "capital_charge_stress",
                            "risk_limit_compliance",
                            "post_cost_net_pnl",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["risk_aware_trading_portfolio_optimization"]
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
                "requires_risk_aware_portfolio_optimization": True,
                "requires_market_risk_var": True,
                "requires_market_sensitivity_constraints": True,
                "requires_capital_charge_stress": True,
                "rejects_optimizer_only_promotion": True,
            },
        )
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-ratpo",
                "objective_scorecard": {
                    "net_pnl_per_day": "700",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.72",
                    "risk_adjusted_post_cost_net_pnl_per_day": "560",
                },
            },
            dataset_snapshot_id="snapshot-ratpo",
            result_path="/tmp/cand-ratpo.json",
        )

        rows = build_mlx_training_rows(
            candidate_specs=[spec], evidence_bundles=[bundle]
        )
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_risk_aware_trading_portfolio_optimization"],
            1.0,
        )
        self.assertEqual(features["paper_requires_portfolio_replay"], 1.0)
        self.assertEqual(features["paper_requires_market_risk_var"], 1.0)
        self.assertEqual(features["paper_requires_market_sensitivity_constraints"], 1.0)
        self.assertEqual(features["paper_requires_capital_charge_stress"], 1.0)
        self.assertEqual(features["paper_requires_risk_limit_compliance"], 1.0)
