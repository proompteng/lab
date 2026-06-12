from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.candidate_specs.support import *


class TestCandidateSpecsPart3(_TestCandidateSpecsBase):
    def test_alpha_decay_claim_adds_predictability_stress_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-tkan-alpha-decay",
            claims=[
                {
                    "claim_id": "lob-alpha-decay",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "T-KAN limit order book forecasting shows alpha decay as "
                        "predictability declines over longer horizons and under "
                        "spread-adjusted labels."
                    ),
                    "data_requirements": [
                        "horizon_decay_curve",
                        "spread_adjusted_labels",
                        "tight_spread_regime_slices",
                        "high_volume_regime_slices",
                        "route_tca",
                    ],
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "alpha_decay_predictability_stress",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_predictability_decay_stress"])
        self.assertTrue(specs[0].hard_vetoes["required_horizon_decay_curve"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_decay_stress_horizon_count"],
            "3",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_max_model_inference_latency_ms"],
            "200",
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        decay_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "alpha_decay_predictability_stress"
        )
        self.assertEqual(
            decay_contract["rank_metric"],
            "post_cost_net_pnl_after_predictability_decay_stress",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_predictability_decay_stress"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_single_horizon_lob_alpha_promotion"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_classification_accuracy_without_costs"]
        )

    def test_conformal_var_claim_adds_regime_weighted_cost_buffer_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-regime-weighted-conformal-var",
            claims=[
                {
                    "claim_id": "regime-weighted-conformal-var-buffer",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Regime-weighted conformal VaR calibrates a tail risk buffer "
                        "from regime-similarity weights and tail exceedance errors."
                    ),
                    "data_requirements": [
                        "regime_similarity_weights",
                        "conformal_tail_risk",
                        "regime_tail_exceedance",
                        "var_forecast_error",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "breakeven-cost-buffer-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Promotion requires a breakeven transaction cost buffer, "
                        "seed robustness, and model-family robustness."
                    ),
                    "data_requirements": [
                        "breakeven_transaction_cost_buffer",
                        "transaction_cost_buffer",
                        "transaction_cost_stress",
                        "post_cost_net_pnl",
                        "seed_robustness",
                        "model_family_robustness",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "regime_weighted_conformal_cost_buffer",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_conformal_tail_risk"])
        self.assertTrue(
            specs[0].hard_vetoes["required_regime_weighted_conformal_cost_buffer"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_conformal_tail_risk_sample_count"],
            "20",
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_breakeven_transaction_cost_buffer"]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_conformal_var_cost_buffer"]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_seed_model_family_robustness"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_unbuffered_tail_risk_promotion"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        conformal_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "regime_weighted_conformal_cost_buffer"
        )
        self.assertEqual(
            conformal_contract["rank_metric"],
            "conformal_tail_risk_adjusted_net_pnl_per_day",
        )
        self.assertEqual(
            conformal_contract["evidence_policy"],
            "regime_weighted_conformal_buffer_is_ranking_stress_not_promotion_proof",
        )

    def test_bootstrap_robust_optimization_claim_adds_stability_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-bootstrap-robust-optimization",
            claims=[
                {
                    "claim_id": "bootstrap-robust-optimization",
                    "claim_type": "strategy_mechanism",
                    "claim_text": (
                        "Non-parametric bootstrap robust optimization treats utility "
                        "as a random variable and uses percentile-based optimization "
                        "to reduce overfitting and selection bias."
                    ),
                    "data_requirements": [
                        "bootstrap_confidence_interval",
                        "utility_percentile",
                        "resampled_strategy_optimization",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "bootstrap-stability-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Validation requires parameter instability stress, model "
                        "misspecification stress, and out-of-sample generalization."
                    ),
                    "data_requirements": [
                        "parameter_instability_stress",
                        "selection_bias_stress",
                        "model_misspecification_stress",
                        "out_of_sample_generalization",
                    ],
                    "confidence": "0.78",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "bootstrap_robust_optimization_stability",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_bootstrap_robust_optimization"])
        self.assertTrue(specs[0].hard_vetoes["required_bootstrap_confidence_interval"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_bootstrap_replicates"], "500"
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_utility_percentile_optimization"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_point_estimate_only_optimization"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        bootstrap_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "bootstrap_robust_optimization_stability"
        )
        self.assertEqual(
            bootstrap_contract["rank_metric"],
            "bootstrap_percentile_robust_net_pnl_per_day",
        )
        self.assertIn("selection_bias_stress", bootstrap_contract["required_evidence"])

    def test_risk_aware_trading_portfolio_claim_adds_portfolio_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-risk-aware-trading-portfolio-optimization",
            claims=[
                {
                    "claim_id": "ratpo-risk-pnl-optimizer",
                    "claim_type": "portfolio_construction",
                    "claim_text": (
                        "Risk-aware trading portfolio optimization uses a RATS "
                        "algorithm over unique eligible instruments and an eligible "
                        "optimization strategy to improve market risk and PnL."
                    ),
                    "data_requirements": [
                        "risk_aware_trading_portfolio_optimization",
                        "market_risk_var",
                        "pnl_objective",
                        "eligible_instrument_universe",
                        "transaction_cost_stress",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "ratpo-risk-limit-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Risk-aware trading swarm outputs require market sensitivity "
                        "constraints, capital charge stress, and risk limit compliance."
                    ),
                    "data_requirements": [
                        "market_sensitivity_constraints",
                        "capital_charge_stress",
                        "risk_limit_compliance",
                        "portfolio_replay",
                    ],
                    "confidence": "0.75",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "risk_aware_trading_portfolio_optimization",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_risk_aware_portfolio_optimization"]
        )
        self.assertTrue(specs[0].hard_vetoes["required_market_risk_var"])
        self.assertTrue(specs[0].hard_vetoes["required_market_sensitivity_constraints"])
        self.assertTrue(specs[0].hard_vetoes["required_capital_charge_stress"])
        self.assertTrue(specs[0].hard_vetoes["required_risk_limit_compliance"])
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_risk_only_objective_without_post_cost_pnl"
            ]
        )
        self.assertTrue(specs[0].promotion_contract["rejects_optimizer_only_promotion"])
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        ratpo_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "risk_aware_trading_portfolio_optimization"
        )
        self.assertEqual(
            ratpo_contract["rank_metric"],
            "risk_adjusted_post_cost_net_pnl_per_day",
        )
        self.assertEqual(
            ratpo_contract["evidence_policy"],
            "risk_aware_portfolio_optimizer_is_prefilter_not_promotion_proof",
        )
        self.assertIn(
            "market_sensitivity_constraints", ratpo_contract["required_evidence"]
        )

    def test_double_selection_factor_claim_adds_validation_only_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-double-selection-factor-screen",
            claims=[
                {
                    "claim_id": "short-term-trading-factor-screen",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Double-selection LASSO identifies short-term trading "
                        "factors after high-dimensional controls."
                    ),
                    "data_requirements": [
                        "short_term_trading_factors",
                        "cross_sectional_ranks",
                        "realized_volatility",
                    ],
                    "confidence": "0.70",
                },
                {
                    "claim_id": "alpha191-us-incremental-explanatory-power",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "High-dimensional factor screens require train holdout split "
                        "and multiple-testing controls before executable sleeves."
                    ),
                    "data_requirements": [
                        "train_holdout_split",
                        "factor_rank_panel",
                        "multiple_testing_controls",
                    ],
                    "confidence": "0.72",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "double_selection_factor_screen",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_double_selection_factor_screen"])
        self.assertTrue(specs[0].hard_vetoes["required_cross_sectional_rank_panel"])
        self.assertTrue(specs[0].hard_vetoes["required_train_holdout_split"])
        self.assertTrue(specs[0].hard_vetoes["required_multiple_testing_controls"])
        self.assertTrue(
            specs[0].promotion_contract["rejects_factor_screen_only_promotion"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_in_sample_factor_selection"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        factor_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "double_selection_factor_screen"
        )
        self.assertEqual(
            factor_contract["rank_metric"],
            "double_selection_factor_post_cost_net_pnl_per_day",
        )
        self.assertEqual(
            factor_contract["evidence_policy"],
            "double_selection_factor_screen_is_prefilter_not_promotion_proof",
        )

    def test_latent_crumbling_quote_claim_adds_veto_grid(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-latent-crumbling-quote-regime",
            claims=[
                {
                    "claim_id": "latent-crumbling-quote-regime-detector",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "Early detection of latent microstructure regimes uses a "
                        "stable to latent build-up to stress model with MAX "
                        "aggregation, rising-edge triggers, and adaptive thresholds. "
                        "When quotes crumble, calibrated crumbling quote probability "
                        "distinguishes mechanical liquidity erosion from repricing."
                    ),
                    "data_requirements": [
                        "point_in_time_lob_feature_panel",
                        "latent_build_up_regime_trace",
                        "max_channel_aggregation_trace",
                        "rising_edge_trigger_trace",
                        "adaptive_threshold_trace",
                        "early_warning_lead_time",
                        "crumbling_quote_probability",
                        "mechanical_liquidity_erosion_probability",
                        "execution_veto_ablation",
                        "route_tca",
                    ],
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        first = specs[0]
        self.assertEqual(
            first.family_template_id,
            "microstructure_continuation_matched_filter_v1",
        )
        self.assertIn(
            "latent_crumbling_quote_regime",
            first.feature_contract["family_selection"]["reasons"],
        )
        self.assertIn(
            "crumbling_quote_liquidity_erosion",
            first.parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            "latent_crumbling_quote_regime_grid",
            first.parameter_space["mechanism_overlay_ids"],
        )
        grid = first.parameter_space["latent_crumbling_quote_regime_grid"]
        self.assertEqual(
            grid["schema_version"],
            "torghut.latent-crumbling-quote-regime-grid.v1",
        )
        self.assertEqual(
            grid["source_ids"],
            ["arxiv-2604.20949", "arxiv-2604.21993"],
        )
        self.assertIn(
            "crumbling_probability_veto_grid",
            grid["candidate_search_inputs"],
        )
        self.assertIn("route_tca_bps", grid["stress_inputs_required"])
        self.assertIn(
            "reactive_baseline_lead_time_delta",
            grid["diagnostics_required"],
        )
        self.assertFalse(grid["proof_neutrality"]["proof_authority"])
        self.assertTrue(grid["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            grid["proof_neutrality"]["rejects_early_warning_score_as_profit_proof"]
        )
        self.assertTrue(
            first.hard_vetoes["required_latent_crumbling_quote_regime_grid"]
        )
        self.assertTrue(first.hard_vetoes["required_early_warning_lead_time"])
        self.assertEqual(
            first.hard_vetoes["required_min_early_warning_mean_lead_time_ticks"],
            "1",
        )
        self.assertTrue(
            first.promotion_contract["requires_latent_crumbling_quote_regime_grid"]
        )
        self.assertTrue(first.promotion_contract["requires_runtime_ledger"])
        self.assertTrue(
            first.promotion_contract[
                "rejects_agent_based_crumbling_labels_as_live_authority"
            ]
        )
        self.assertEqual(
            first.strategy_overrides["params"]["microstructure_stress_veto_profile"],
            "latent_crumbling_quote",
        )
        self.assertEqual(
            first.strategy_overrides["params"]["crumbling_quote_live_authority"],
            "disabled_candidate_only",
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        crumbling_contract = next(
            item
            for item in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if item["overlay_id"] == "crumbling_quote_liquidity_erosion"
        )
        self.assertEqual(
            crumbling_contract["source_papers"][0]["source_id"], "arxiv-2604.21993"
        )
        latent_contract = next(
            item
            for item in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if item["overlay_id"] == "latent_crumbling_quote_regime_grid"
        )
        self.assertEqual(
            latent_contract["source_papers"][0]["source_id"], "arxiv-2604.20949"
        )
        self.assertEqual(
            latent_contract["rank_metric"],
            "post_cost_net_pnl_after_latent_crumbling_quote_veto_stress",
        )
        self.assertIn("runtime_ledger", latent_contract["required_evidence"])

    def test_attention_factor_stat_arb_claim_adds_pairs_grid(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-attention-factor-stat-arb-pairs",
            claims=[
                {
                    "claim_id": "attention-factor-stat-arb-pair-selection",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Attention Factors for statistical arbitrage jointly identify "
                        "similar assets, residual portfolios, weak factors, and "
                        "mispricing signals. Hierarchical pair trading separates pair "
                        "selection from low-level execution with trajectory-level and "
                        "episode-level feedback."
                    ),
                    "data_requirements": [
                        "point_in_time_factor_embeddings",
                        "attention_factor_residual_portfolios",
                        "similar_asset_pair_selection_trace",
                        "mispricing_signal_trace",
                        "pair_selection_execution_ablation",
                        "trajectory_episode_feedback_log",
                        "transaction_cost_stress",
                        "route_tca",
                    ],
                    "confidence": "0.79",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        first = specs[0]
        self.assertEqual(first.family_template_id, "microbar_cross_sectional_pairs_v1")
        self.assertIn(
            "attention_factor_stat_arb_pairs",
            first.feature_contract["family_selection"]["reasons"],
        )
        self.assertIn(
            "attention_factor_stat_arb_pairs_grid",
            first.parameter_space["mechanism_overlay_ids"],
        )
        grid = first.parameter_space["attention_factor_stat_arb_pairs_grid"]
        self.assertEqual(
            grid["schema_version"],
            "torghut.attention-factor-stat-arb-pairs-grid.v1",
        )
        self.assertEqual(
            grid["source_ids"],
            ["arxiv-2510.11616", "arxiv-2605.01954"],
        )
        self.assertIn(
            "weak_factor_retention_quantile_grid",
            grid["candidate_search_inputs"],
        )
        self.assertIn(
            "hierarchical_feedback_ranker",
            grid["candidate_search_inputs"]["pair_selector_policy_grid"],
        )
        self.assertIn("mispricing_zscore", grid["stress_inputs_required"])
        self.assertIn(
            "pair_selector_execution_ablation_delta_bps",
            grid["diagnostics_required"],
        )
        self.assertFalse(grid["proof_neutrality"]["promotion_authority"])
        self.assertTrue(
            grid["proof_neutrality"][
                "rejects_llm_pair_selection_as_promotion_authority"
            ]
        )
        self.assertTrue(
            first.hard_vetoes["required_attention_factor_stat_arb_pairs_grid"]
        )
        self.assertTrue(first.hard_vetoes["required_point_in_time_factor_embeddings"])
        self.assertEqual(
            first.hard_vetoes["required_max_best_pair_contribution_share"], "0.35"
        )
        self.assertTrue(
            first.promotion_contract["requires_attention_factor_stat_arb_pairs_grid"]
        )
        self.assertTrue(
            first.promotion_contract[
                "rejects_attention_factor_backtest_as_profit_proof"
            ]
        )
        self.assertEqual(
            first.strategy_overrides["params"]["stat_arb_factor_profile"],
            "attention_factor_residual",
        )
        self.assertEqual(
            first.strategy_overrides["params"]["llm_pair_selection_authority"],
            "disabled_candidate_only",
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        contract = next(
            item
            for item in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if item["overlay_id"] == "attention_factor_stat_arb_pairs_grid"
        )
        self.assertEqual(contract["source_papers"][0]["source_id"], "arxiv-2510.11616")
        self.assertEqual(
            contract["rank_metric"],
            "post_cost_net_pnl_after_attention_factor_pair_ablation_stress",
        )
        self.assertIn("runtime_ledger", contract["required_evidence"])

    def test_validation_only_lob_stress_does_not_portfolio_fanout(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-tlob-validation-only",
            claims=[
                {
                    "claim_id": "tlob-alpha-decay-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "TLOB dual attention limit order book forecasting shows "
                        "predictability decay under tight spreads and high-volume "
                        "algorithmic activity."
                    ),
                    "data_requirements": [
                        "horizon_decay_curve",
                        "spread_adjusted_labels",
                        "tight_spread_regime_slices",
                        "high_volume_regime_slices",
                        "route_tca",
                    ],
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        family_ids = {spec.family_template_id for spec in specs}
        family_reasons = {
            reason
            for spec in specs
            for reason in spec.feature_contract["family_selection"]["reasons"]
        }

        self.assertIn("intraday_tsmom_v2", family_ids)
        self.assertIn("microbar_cross_sectional_pairs_v1", family_ids)
        self.assertLessEqual(
            len(family_ids),
            candidate_specs_module._MAX_FAMILIES_PER_HYPOTHESIS,
        )
        self.assertNotIn("portfolio_sleeve_diversification", family_reasons)
        self.assertTrue(
            all(
                "alpha_decay_predictability_stress"
                in spec.parameter_space["mechanism_overlay_ids"]
                for spec in specs
            )
        )

    def test_ohlcv_only_claim_adds_falsification_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-ohlcv-falsification",
            claims=[
                {
                    "claim_id": "ohlcv-alpha",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "OHLCV-derived intraday momentum can look attractive in "
                        "naive backtests."
                    ),
                    "confidence": "0.75",
                },
                {
                    "claim_id": "ohlcv-only-falsification",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "OHLCV-only signals require systematic falsification with "
                        "executable quote, route/TCA, and walk-forward replay evidence."
                    ),
                    "data_requirements": [
                        "executable_quote_evidence",
                        "route_tca",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.80",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "ohlcv_only_falsification",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_ohlcv_only_promotion_evidence"]
        )
        self.assertTrue(specs[0].promotion_contract["requires_walk_forward_replay"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_ohlcv_falsification_trade_count"],
            "120",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_ohlcv_stable_split_pass_rate"],
            "0.60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_executable_quote_evidence"])
        self.assertTrue(specs[0].promotion_contract["requires_minimum_trade_count"])
        self.assertTrue(
            specs[0].promotion_contract["rejects_naive_gross_ohlcv_backtests"]
        )
