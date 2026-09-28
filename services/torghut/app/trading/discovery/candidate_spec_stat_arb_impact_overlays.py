"""Statistical-arbitrage and impact mechanism overlays for candidate specs."""

from __future__ import annotations

from .candidate_spec_mechanism_overlay_state import MechanismOverlayState


def _apply_attention_factor_stat_arb_pairs_grid_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    parameter_space = state.parameter_space
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "attention factors",
            "attention factor",
            "attention_factor",
            "conditional latent factor",
            "conditional latent factors",
            "weak factors",
            "residual portfolio",
            "residual portfolios",
            "statistical arbitrage",
            "stat arb",
            "stat-arb",
            "mispricing",
            "similar assets",
            "jointly identify similar assets",
            "hierarchical pair trading",
            "hierarchical pairs trading",
            "pair selector",
            "pair selection",
            "language-driven hierarchical reinforcement learning",
            "trajectory-level feedback",
            "episode-level feedback",
            "prompt updates",
            "delayed feedback",
        )
    ):
        overlay_ids.append("attention_factor_stat_arb_pairs_grid")
        overlay_contracts.append(
            {
                "overlay_id": "attention_factor_stat_arb_pairs_grid",
                "source_papers": [
                    {
                        "source_id": "arxiv-2510.11616",
                        "url": "https://arxiv.org/abs/2510.11616",
                        "title": "Attention Factors for Statistical Arbitrage",
                        "mechanism": (
                            "joint_factor_similarity_mispricing_and_after_cost_"
                            "stat_arb_policy_search"
                        ),
                    },
                    {
                        "source_id": "arxiv-2605.01954",
                        "url": "https://arxiv.org/abs/2605.01954",
                        "title": (
                            "Moira: Language-driven Hierarchical Reinforcement "
                            "Learning for Pair Trading"
                        ),
                        "mechanism": (
                            "separate_pair_selection_abstraction_from_low_level_"
                            "execution_with_episode_feedback_audits"
                        ),
                    },
                ],
                "required_evidence": [
                    "point_in_time_factor_embeddings",
                    "attention_factor_residual_portfolios",
                    "similar_asset_pair_selection_trace",
                    "mispricing_signal_trace",
                    "pair_selection_execution_ablation",
                    "trajectory_episode_feedback_log",
                    "transaction_cost_stress",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                    "route_tca",
                    "runtime_ledger",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_attention_factor_pair_ablation_stress"
                ),
                "evidence_policy": (
                    "attention_factor_pairs_grid_is_candidate_input_only_and_"
                    "requires_point_in_time_replay_route_tca_runtime_ledger_proof"
                ),
            }
        )
        parameter_space["attention_factor_stat_arb_pairs_grid"] = {
            "schema_version": "torghut.attention-factor-stat-arb-pairs-grid.v1",
            "source_ids": ["arxiv-2510.11616", "arxiv-2605.01954"],
            "candidate_search_inputs": {
                "factor_embedding_family_grid": [
                    "sector_industry_one_hot",
                    "fundamental_characteristic_embedding",
                    "price_volume_microstructure_embedding",
                ],
                "attention_factor_count_grid": ["4", "8", "16", "32"],
                "weak_factor_retention_quantile_grid": ["0.50", "0.70", "0.90"],
                "residual_signal_model_grid": [
                    "zscore_reversion",
                    "temporal_cnn",
                    "sequence_transformer",
                ],
                "pair_selector_policy_grid": [
                    "nearest_residual_factor",
                    "attention_similarity_topk",
                    "hierarchical_feedback_ranker",
                ],
                "pair_top_k_grid": ["2", "4", "8"],
                "entry_mispricing_zscore_grid": ["1.5", "2.0", "2.5"],
                "exit_mispricing_zscore_grid": ["0.0", "0.5", "1.0"],
                "pair_leg_hold_seconds_grid": ["900", "1800", "3600", "7200"],
                "transaction_cost_buffer_bps_grid": ["2", "4", "8"],
            },
            "stress_inputs_required": [
                "point_in_time_factor_features",
                "factor_embedding_snapshot_id",
                "residual_portfolio_returns",
                "pair_similarity_score",
                "mispricing_zscore",
                "pair_leg_order_flow",
                "execution_shortfall_bps",
                "route_tca_bps",
                "runtime_ledger_post_cost_pnl",
            ],
            "diagnostics_required": [
                "pair_selection_turnover",
                "factor_residual_leakage_check",
                "weak_factor_ablation_delta_bps",
                "pair_selector_execution_ablation_delta_bps",
                "train_holdout_pair_overlap_ratio",
                "best_pair_contribution_share",
                "episode_feedback_replay_trace_coverage",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_point_in_time_features": True,
                "requires_walk_forward_replay": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_llm_pair_selection_as_promotion_authority": True,
                "rejects_attention_factor_backtest_as_profit_proof": True,
                "rejects_textual_feedback_as_runtime_ledger_authority": True,
            },
        }
        hard_vetoes.update(
            {
                "required_attention_factor_stat_arb_pairs_grid": True,
                "required_point_in_time_factor_embeddings": True,
                "required_attention_factor_residual_portfolios": True,
                "required_similar_asset_pair_selection_trace": True,
                "required_mispricing_signal_trace": True,
                "required_pair_selection_execution_ablation": True,
                "required_transaction_cost_stress": True,
                "required_walk_forward_replay": True,
                "required_max_best_pair_contribution_share": "0.35",
                "required_max_train_holdout_pair_overlap_ratio": "0.50",
                "required_min_episode_feedback_trace_coverage": "0.90",
            }
        )
        promotion_contract.update(
            {
                "requires_attention_factor_stat_arb_pairs_grid": True,
                "requires_point_in_time_factor_embeddings": True,
                "requires_attention_factor_residual_portfolios": True,
                "requires_pair_selection_execution_ablation": True,
                "requires_transaction_cost_stress": True,
                "requires_walk_forward_replay": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_llm_pair_selection_as_promotion_authority": True,
                "rejects_attention_factor_backtest_as_profit_proof": True,
                "pairs_policy": "attention_factor_stat_arb_validation_only",
            }
        )


def _apply_bootstrap_robust_optimization_stability_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "non-parametric bootstrap",
            "nonparametric bootstrap",
            "bootstrap robust optimization",
            "bootstrap robustness",
            "bootstrap confidence interval",
            "bootstrap confidence intervals",
            "resampled confidence interval",
            "resampled confidence intervals",
            "utility percentile",
            "percentile-based optimization",
            "percentile based optimization",
            "utility as a random variable",
            "selection bias",
            "overfitting and selection bias",
            "parameter instability",
            "model misspecification",
            "distribution-free robust optimization",
            "distribution free robust optimization",
        )
    ):
        overlay_ids.append("bootstrap_robust_optimization_stability")
        overlay_contracts.append(
            {
                "overlay_id": "bootstrap_robust_optimization_stability",
                "required_evidence": [
                    "bootstrap_confidence_interval",
                    "utility_percentile",
                    "resampled_strategy_optimization",
                    "parameter_instability_stress",
                    "selection_bias_stress",
                    "model_misspecification_stress",
                    "out_of_sample_generalization",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "bootstrap_percentile_robust_net_pnl_per_day",
                "evidence_policy": (
                    "bootstrap_robust_optimization_is_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_bootstrap_robust_optimization": True,
                "required_bootstrap_confidence_interval": True,
                "required_utility_percentile_optimization": True,
                "required_selection_bias_stress": True,
                "required_parameter_instability_stress": True,
                "required_model_misspecification_stress": True,
                "required_distribution_free_confidence_intervals": True,
                "required_min_bootstrap_replicates": "500",
            }
        )
        promotion_contract.update(
            {
                "requires_bootstrap_robust_optimization": True,
                "requires_bootstrap_confidence_intervals": True,
                "requires_utility_percentile_optimization": True,
                "requires_selection_bias_stress": True,
                "requires_parameter_instability_stress": True,
                "requires_model_misspecification_stress": True,
                "requires_walk_forward_replay": True,
                "rejects_point_estimate_only_optimization": True,
                "rejects_in_sample_selection_bias": True,
                "risk_policy": "bootstrap_robust_optimization_validation_only",
            }
        )


def _apply_crumbling_quote_liquidity_erosion_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    parameter_space = state.parameter_space
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "crumbling quote",
            "crumbling quotes",
            "crumbling_quote",
            "quote crumble",
            "quote_crumble",
            "quote erosion",
            "quote_erosion",
            "mechanical liquidity erosion",
            "mechanical_liquidity_erosion",
            "mechanical liquidity withdrawal",
            "liquidity withdrawal",
            "liquidity_withdrawal",
            "transient mechanical liquidity",
            "transient liquidity erosion",
            "latent microstructure",
            "latent microstructure regime",
            "microstructure regime",
            "latent build-up",
            "latent_build_up",
            "stable latent stress",
            "stable to latent",
            "early-warning",
            "early warning",
            "rising-edge",
            "rising edge",
            "adaptive threshold",
            "max aggregation",
        )
    ):
        overlay_ids.append("crumbling_quote_liquidity_erosion")
        overlay_ids.append("latent_crumbling_quote_regime_grid")
        overlay_contracts.append(
            {
                "overlay_id": "crumbling_quote_liquidity_erosion",
                "source_papers": [
                    {
                        "source_id": "arxiv-2604.21993",
                        "url": "https://arxiv.org/abs/2604.21993",
                        "title": "When Quotes Crumble: Detecting Transient Mechanical Liquidity Erosion in Limit Order Books",
                        "mechanism": (
                            "calibrated_crumbling_quote_probability_from_lob_features_"
                            "distinguishes_mechanical_liquidity_withdrawal_from_repricing"
                        ),
                    },
                    {
                        "source_id": "arxiv-2604.20949",
                        "url": "https://arxiv.org/abs/2604.20949",
                        "title": "Early Detection of Latent Microstructure Regimes in Limit Order Books",
                        "mechanism": (
                            "stable_latent_build_up_stress_detector_with_positive_"
                            "lead_time_before_reactive_ofi_volatility_baselines"
                        ),
                    },
                ],
                "required_evidence": [
                    "crumbling_quote_probability",
                    "mechanical_liquidity_erosion",
                    "latent_build_up_regime_trace",
                    "early_warning_lead_time",
                    "rising_edge_trigger_trace",
                    "lob_event_stream",
                    "executable_quote",
                    "route_tca",
                    "live_paper_parity",
                    "adverse_selection_stress",
                ],
                "rank_metric": "post_cost_net_pnl_after_crumbling_quote_liquidity_stress",
                "evidence_policy": (
                    "crumbling_quote_probability_is_validation_only_until_live_paper_route_tca"
                ),
            }
        )
        overlay_contracts.append(
            {
                "overlay_id": "latent_crumbling_quote_regime_grid",
                "source_papers": [
                    {
                        "source_id": "arxiv-2604.20949",
                        "url": "https://arxiv.org/abs/2604.20949",
                        "title": "Early Detection of Latent Microstructure Regimes in Limit Order Books",
                        "mechanism": (
                            "max_aggregated_complementary_signal_channels_with_"
                            "rising_edge_adaptive_thresholds_for_positive_lead_time"
                        ),
                    },
                    {
                        "source_id": "arxiv-2604.21993",
                        "url": "https://arxiv.org/abs/2604.21993",
                        "title": "When Quotes Crumble: Detecting Transient Mechanical Liquidity Erosion in Limit Order Books",
                        "mechanism": (
                            "calibrated_quote_erosion_probability_and_temporal_feature_"
                            "ablation_for_mechanical_liquidity_withdrawal_detection"
                        ),
                    },
                ],
                "required_evidence": [
                    "point_in_time_lob_feature_panel",
                    "latent_build_up_regime_trace",
                    "crumbling_quote_probability",
                    "mechanical_liquidity_erosion_probability",
                    "max_channel_aggregation_trace",
                    "rising_edge_trigger_trace",
                    "adaptive_threshold_trace",
                    "early_warning_lead_time",
                    "reactive_baseline_comparison",
                    "execution_veto_ablation",
                    "route_tca",
                    "runtime_ledger",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_latent_crumbling_quote_veto_stress"
                ),
                "evidence_policy": (
                    "latent_crumbling_quote_grid_is_candidate_veto_search_input_"
                    "only_and_requires_live_paper_route_tca_runtime_ledger_authority"
                ),
            }
        )
        parameter_space["latent_crumbling_quote_regime_grid"] = {
            "schema_version": "torghut.latent-crumbling-quote-regime-grid.v1",
            "source_ids": ["arxiv-2604.20949", "arxiv-2604.21993"],
            "candidate_search_inputs": {
                "early_warning_horizon_seconds_grid": ["1", "5", "15", "30", "60"],
                "channel_aggregation_grid": [
                    "max_complementary_channels",
                    "weighted_max_order_flow_quote_depth",
                    "calibrated_neural_crumbling_probability",
                ],
                "rising_edge_slope_window_seconds_grid": ["1", "5", "15"],
                "adaptive_threshold_quantile_grid": ["0.90", "0.95", "0.98"],
                "crumbling_probability_veto_grid": ["0.35", "0.50", "0.65"],
                "latent_build_up_persistence_ticks_grid": ["2", "5", "10"],
                "quote_depth_erosion_bps_grid": ["5", "10", "20"],
                "execution_response_grid": [
                    "veto_entry",
                    "prefer_passive_limit",
                    "cancel_replace_delay",
                    "size_halve",
                ],
            },
            "stress_inputs_required": [
                "point_in_time_lob_features",
                "quote_depth_erosion",
                "mechanical_liquidity_withdrawal_label_or_proxy",
                "latent_build_up_regime_proxy",
                "order_flow_imbalance",
                "short_horizon_volatility",
                "executable_quote_snapshot",
                "route_tca_bps",
                "runtime_ledger_post_cost_pnl",
            ],
            "diagnostics_required": [
                "early_warning_mean_lead_time_ticks",
                "early_warning_precision",
                "early_warning_coverage",
                "crumbling_probability_calibration_error",
                "reactive_baseline_lead_time_delta",
                "temporal_feature_ablation_delta_auc",
                "execution_veto_false_positive_rate",
                "missed_stress_entry_rate",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_exact_replay": True,
                "requires_point_in_time_lob_features": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_agent_based_crumbling_labels_as_live_authority": True,
                "rejects_early_warning_score_as_profit_proof": True,
                "rejects_veto_backtest_as_runtime_ledger_authority": True,
            },
        }
        hard_vetoes.update(
            {
                "required_crumbling_quote_liquidity_erosion": True,
                "required_latent_crumbling_quote_regime_grid": True,
                "required_crumbling_quote_probability": True,
                "required_mechanical_liquidity_erosion_probability": True,
                "required_latent_build_up_regime_trace": True,
                "required_early_warning_lead_time": True,
                "required_rising_edge_trigger_trace": True,
                "required_adaptive_threshold_trace": True,
                "required_min_crumbling_quote_sample_count": "60",
                "required_min_latent_regime_sample_count": "60",
                "required_max_crumbling_quote_probability": "0.90",
                "required_min_early_warning_precision": "0.80",
                "required_min_early_warning_mean_lead_time_ticks": "1",
                "required_max_execution_veto_false_positive_rate": "0.25",
                "required_route_tca": True,
                "required_live_paper_parity": True,
            }
        )
        promotion_contract.update(
            {
                "requires_crumbling_quote_liquidity_erosion": True,
                "requires_latent_crumbling_quote_regime_grid": True,
                "requires_crumbling_quote_probability": True,
                "requires_mechanical_liquidity_erosion_probability": True,
                "requires_latent_build_up_regime_trace": True,
                "requires_early_warning_lead_time": True,
                "requires_reactive_baseline_comparison": True,
                "requires_execution_veto_ablation": True,
                "requires_lob_event_stream": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "requires_live_paper_parity": True,
                "requires_adverse_selection_stress": True,
                "rejects_crumbling_quote_simulation_as_promotion_proof": True,
                "rejects_early_warning_score_as_profit_proof": True,
                "rejects_agent_based_crumbling_labels_as_live_authority": True,
                "risk_policy": "crumbling_quote_liquidity_erosion_validation_only",
            }
        )


def _apply_nonlinear_market_impact_tca_overlay(state: MechanismOverlayState) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "nonlinear impact",
            "nonlinear_impact",
            "square-root",
            "square root",
            "power-law market impact",
            "power law market impact",
            "almgren",
            "route/tca",
            "route_tca",
            "market impact stress",
            "impact stress",
        )
    ):
        overlay_ids.append("nonlinear_market_impact_tca")
        overlay_contracts.append(
            {
                "overlay_id": "nonlinear_market_impact_tca",
                "required_evidence": [
                    "route_tca",
                    "nonlinear_impact_curve",
                    "realized_slippage_bps",
                    "turnover",
                ],
                "rank_metric": "post_cost_net_pnl_after_nonlinear_impact",
            }
        )
        hard_vetoes.update(
            {
                "required_min_route_tca_sample_count": "60",
                "required_max_realized_slippage_bps": "8",
                "required_impact_stress_model": "square_root_or_power_law",
            }
        )
        promotion_contract.update(
            {
                "requires_route_tca": True,
                "requires_nonlinear_impact_curve": True,
                "requires_impact_stress_replay": True,
                "ranking_cost_model": "post_cost_nonlinear_impact",
            }
        )


def _apply_transient_impact_hawkes_propagator_grid_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    parameter_space = state.parameter_space
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "transient impact",
            "transient price impact",
            "transient market impact",
            "propagator model",
            "propagator impact",
            "nonlinear propagator",
            "power-law decay",
            "power law decay",
            "exponential decay kernel",
            "impact decay kernel",
            "impact_kernel",
            "self-exciting order flow",
            "self exciting order flow",
            "bivariate hawkes",
            "mutually exciting hawkes",
            "samuelson effect",
            "gate closure",
            "n-player execution",
            "n trader execution",
            "predatory execution",
            "execution predator",
            "cost of anarchy",
            "block-trade regularization",
            "block trade regularization",
            "fredholm",
        )
    ):
        overlay_ids.append("transient_impact_hawkes_propagator_grid")
        overlay_contracts.append(
            {
                "overlay_id": "transient_impact_hawkes_propagator_grid",
                "source_papers": [
                    {
                        "source_id": "arxiv-2504.10282",
                        "url": "https://arxiv.org/abs/2504.10282",
                        "title": "Optimal Execution in Intraday Energy Markets under Hawkes Processes with Transient Impact",
                        "mechanism": "bivariate_hawkes_order_flow_with_transient_impact_schedule_stress",
                    },
                    {
                        "source_id": "arxiv-2503.04323",
                        "url": "https://arxiv.org/abs/2503.04323",
                        "title": "Fredholm Approach to Nonlinear Propagator Models",
                        "mechanism": "nonlinear_propagator_alpha_signal_execution_under_exponential_and_power_law_decay",
                    },
                    {
                        "source_id": "arxiv-2501.09638",
                        "url": "https://arxiv.org/abs/2501.09638",
                        "title": "Optimal Execution among N Traders with Transient Price Impact",
                        "mechanism": "n_trader_transient_impact_predator_and_block_regularization_stress",
                    },
                ],
                "required_evidence": [
                    "transient_impact_kernel_fit",
                    "impact_decay_residuals",
                    "hawkes_self_cross_excitation_matrix",
                    "execution_trajectory_trace",
                    "twap_vwap_benchmark_shortfall",
                    "alpha_signal_trace",
                    "predator_cost_of_anarchy_stress",
                    "route_tca",
                    "runtime_ledger",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_transient_impact_hawkes_predator_stress"
                ),
                "evidence_policy": (
                    "transient_impact_propagator_grid_is_candidate_input_only_"
                    "and_requires_real_route_tca_kernel_fit_runtime_ledger_proof"
                ),
            }
        )
        parameter_space["transient_impact_hawkes_propagator_grid"] = {
            "schema_version": "torghut.transient-impact-hawkes-propagator-grid.v1",
            "source_ids": [
                "arxiv-2504.10282",
                "arxiv-2503.04323",
                "arxiv-2501.09638",
            ],
            "candidate_search_inputs": {
                "impact_decay_kernel_family_grid": [
                    "exponential",
                    "power_law",
                    "multi_exponential",
                ],
                "impact_decay_half_life_seconds_grid": ["5", "30", "120", "600"],
                "impact_concavity_exponent_grid": ["0.35", "0.50", "0.65", "1.00"],
                "hawkes_self_excitation_grid": ["0.10", "0.30", "0.55"],
                "hawkes_cross_excitation_grid": ["0.05", "0.20", "0.40"],
                "trajectory_benchmark_grid": [
                    "twap",
                    "vwap",
                    "front_loaded",
                    "back_loaded",
                ],
                "predator_count_grid": ["0", "1", "3", "5"],
                "block_trade_regularization_bps_grid": ["0", "1", "3", "6"],
                "alpha_signal_half_life_seconds_grid": ["30", "120", "600"],
            },
            "stress_inputs_required": [
                "signed_order_flow",
                "hawkes_event_arrivals",
                "child_order_schedule",
                "realized_impact_bps",
                "impact_decay_after_child_order",
                "alpha_signal_return",
                "route_tca_bps",
                "runtime_ledger_post_cost_pnl",
            ],
            "diagnostics_required": [
                "impact_kernel_fit_error_bps",
                "hawkes_branching_ratio",
                "self_cross_excitation_l1",
                "twap_shortfall_bps",
                "vwap_shortfall_bps",
                "predator_cost_of_anarchy_bps",
                "price_manipulation_screen_passed",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_exact_replay": True,
                "requires_real_order_flow": True,
                "requires_real_impact_decay_fit": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_modeled_transient_impact_as_profit_proof": True,
                "rejects_hawkes_generated_order_flow_as_fill_authority": True,
                "rejects_predator_stress_as_runtime_ledger_authority": True,
            },
        }
        hard_vetoes.update(
            {
                "required_transient_impact_hawkes_propagator_grid": True,
                "required_transient_impact_kernel_fit": True,
                "required_impact_decay_residuals": True,
                "required_hawkes_self_cross_excitation_matrix": True,
                "required_execution_trajectory_trace": True,
                "required_twap_vwap_benchmark_shortfall": True,
                "required_predator_cost_of_anarchy_stress": True,
                "required_price_manipulation_screen_passed": True,
                "required_max_transient_impact_fit_error_bps": "8",
                "required_max_predator_cost_of_anarchy_bps": "10",
            }
        )
        promotion_contract.update(
            {
                "requires_transient_impact_hawkes_propagator_grid": True,
                "requires_transient_impact_kernel_fit": True,
                "requires_impact_decay_residuals": True,
                "requires_hawkes_self_cross_excitation_matrix": True,
                "requires_execution_trajectory_trace": True,
                "requires_twap_vwap_benchmark_shortfall": True,
                "requires_predator_cost_of_anarchy_stress": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_modeled_transient_impact_as_profit_proof": True,
                "rejects_hawkes_generated_order_flow_as_fill_authority": True,
                "execution_impact_policy": (
                    "transient_impact_hawkes_propagator_validation_only"
                ),
            }
        )


def _apply_multi_asset_cross_impact_execution_grid_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    parameter_space = state.parameter_space
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "cross-impact",
            "cross impact",
            "cross_effects",
            "cross-effects",
            "cross effects",
            "cross-hedging",
            "cross hedging",
            "multi-asset optimal trade execution",
            "multi asset optimal trade execution",
            "matrix-valued price impact",
            "matrix valued price impact",
            "matrix-valued impact",
            "matrix valued impact",
            "obizhaeva-wang",
            "signed trade flow feedback",
            "signed_trade_flow_feedback",
            "spread and volume imbalance",
            "volume imbalance state",
        )
    ):
        overlay_ids.append("multi_asset_cross_impact_execution_grid")
        overlay_contracts.append(
            {
                "overlay_id": "multi_asset_cross_impact_execution_grid",
                "source_papers": [
                    {
                        "source_id": "arxiv-2503.05594",
                        "url": "https://arxiv.org/abs/2503.05594",
                        "title": (
                            "Multi-asset optimal trade execution with stochastic "
                            "cross-effects: An Obizhaeva-Wang-type framework"
                        ),
                        "mechanism": (
                            "matrix_valued_stochastic_price_impact_resilience_and_"
                            "cross_hedging_execution_stress"
                        ),
                    },
                    {
                        "source_id": "arxiv-2603.24137",
                        "url": "https://arxiv.org/abs/2603.24137",
                        "title": "Bridging the Reality Gap in Limit Order Book Simulation",
                        "mechanism": (
                            "spread_volume_imbalance_state_projection_with_"
                            "signed_flow_power_law_feedback_replay_parity"
                        ),
                    },
                    {
                        "source_id": "arxiv-2506.05755",
                        "url": "https://arxiv.org/abs/2506.05755",
                        "title": (
                            "FlowOE: Imitation Learning with Flow Policy from Ensemble "
                            "RL Experts for Optimal Execution under Heston Volatility "
                            "and Concave Market Impacts"
                        ),
                        "mechanism": (
                            "adaptive_execution_expert_grid_under_concave_impact_and_"
                            "volatility_stress"
                        ),
                    },
                ],
                "required_evidence": [
                    "pair_leg_order_flow_covariance",
                    "cross_impact_matrix_fit",
                    "impact_resilience_matrix_fit",
                    "cross_hedge_leg_ablation",
                    "signed_trade_flow_decay_feedback",
                    "spread_volume_imbalance_state_projection",
                    "execution_shortfall_by_leg",
                    "route_tca",
                    "runtime_ledger",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_cross_impact_resilience_stress"
                ),
                "evidence_policy": (
                    "multi_asset_cross_impact_grid_is_candidate_input_only_and_"
                    "requires_real_pair_leg_order_flow_route_tca_runtime_ledger_proof"
                ),
            }
        )
        parameter_space["multi_asset_cross_impact_execution_grid"] = {
            "schema_version": "torghut.multi-asset-cross-impact-execution-grid.v1",
            "source_ids": [
                "arxiv-2503.05594",
                "arxiv-2603.24137",
                "arxiv-2506.05755",
            ],
            "candidate_search_inputs": {
                "impact_matrix_structure_grid": [
                    "diagonal_baseline",
                    "sector_block_psd",
                    "factor_low_rank_psd",
                    "full_psd_shrinkage",
                ],
                "resilience_matrix_structure_grid": [
                    "diagonal",
                    "sector_block",
                    "factor_low_rank",
                ],
                "cross_impact_shrinkage_grid": ["0.25", "0.50", "0.75"],
                "cross_hedge_leg_notional_cap_pct_grid": ["0", "10", "25", "50"],
                "pair_leg_execution_mode_grid": [
                    "synchronous",
                    "lead_lag_hedged",
                    "resilience_staggered",
                ],
                "signed_flow_decay_kernel_grid": [
                    "exponential",
                    "power_law",
                    "multi_exponential",
                ],
                "signed_flow_feedback_half_life_seconds_grid": [
                    "5",
                    "30",
                    "120",
                    "600",
                ],
                "cross_impact_penalty_bps_grid": ["1", "3", "6", "10"],
                "flowoe_expert_policy_grid": [
                    "almgren_chriss",
                    "twap",
                    "vwap",
                    "impact_resilience",
                ],
            },
            "stress_inputs_required": [
                "pair_leg_signed_order_flow",
                "pair_leg_return_covariance",
                "cross_impact_matrix_bps",
                "impact_resilience_matrix",
                "spread_volume_imbalance_state",
                "signed_trade_flow_decay_kernel",
                "child_order_schedule_by_leg",
                "execution_shortfall_bps_by_leg",
                "route_tca_bps",
                "runtime_ledger_post_cost_pnl",
            ],
            "diagnostics_required": [
                "impact_matrix_positive_semidefinite",
                "cross_impact_fit_error_bps",
                "resilience_fit_error_bps",
                "cross_hedge_ablation_delta_bps",
                "price_manipulation_screen_passed",
                "signed_flow_feedback_residual_bps",
                "shortfall_dispersion_by_leg_bps",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_exact_replay": True,
                "requires_real_pair_leg_order_flow": True,
                "requires_real_cross_impact_fit": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_cross_impact_model_as_profit_proof": True,
                "rejects_cross_hedge_ablation_as_fill_authority": True,
                "rejects_flowoe_expert_policy_as_live_authority": True,
            },
        }
        hard_vetoes.update(
            {
                "required_multi_asset_cross_impact_execution_grid": True,
                "required_pair_leg_order_flow_covariance": True,
                "required_cross_impact_matrix_fit": True,
                "required_impact_resilience_matrix_fit": True,
                "required_cross_hedge_leg_ablation": True,
                "required_signed_trade_flow_decay_feedback": True,
                "required_spread_volume_imbalance_state_projection": True,
                "required_positive_semidefinite_impact_matrix": True,
                "required_price_manipulation_screen_passed": True,
                "required_max_cross_impact_fit_error_bps": "8",
                "required_max_shortfall_dispersion_by_leg_bps": "10",
            }
        )
        promotion_contract.update(
            {
                "requires_multi_asset_cross_impact_execution_grid": True,
                "requires_pair_leg_order_flow_covariance": True,
                "requires_cross_impact_matrix_fit": True,
                "requires_impact_resilience_matrix_fit": True,
                "requires_cross_hedge_leg_ablation": True,
                "requires_signed_trade_flow_decay_feedback": True,
                "requires_spread_volume_imbalance_state_projection": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_cross_impact_model_as_profit_proof": True,
                "rejects_cross_hedge_ablation_as_fill_authority": True,
                "execution_impact_policy": (
                    "multi_asset_cross_impact_resilience_validation_only"
                ),
            }
        )


def apply_stat_arb_impact_mechanism_overlays(state: MechanismOverlayState) -> None:
    _apply_attention_factor_stat_arb_pairs_grid_overlay(state)
    _apply_bootstrap_robust_optimization_stability_overlay(state)
    _apply_crumbling_quote_liquidity_erosion_overlay(state)
    _apply_nonlinear_market_impact_tca_overlay(state)
    _apply_transient_impact_hawkes_propagator_grid_overlay(state)
    _apply_multi_asset_cross_impact_execution_grid_overlay(state)


__all__ = ["apply_stat_arb_impact_mechanism_overlays"]
