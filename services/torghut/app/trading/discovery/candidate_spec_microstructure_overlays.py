"""Microstructure mechanism overlays for candidate spec compilation."""

from __future__ import annotations

from .candidate_spec_mechanism_overlay_state import MechanismOverlayState


def _apply_cluster_lob_event_clustering_overlay(state: MechanismOverlayState) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    parameter_space = state.parameter_space
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "clusterlob",
            "clustered order",
            "clustered_order",
            "order arrival clustering",
            "arrival clustering",
            "event stream",
            "event-stream",
            "lob event",
            "hawkes",
            "order_arrival_intensity",
            "state_dependent_hawkes_intensity",
        )
    ):
        overlay_ids.append("cluster_lob_event_clustering")
        overlay_ids.append("hawkes_lob_event_replay_harness")
        overlay_contracts.append(
            {
                "overlay_id": "cluster_lob_event_clustering",
                "required_evidence": [
                    "clustered_order_events",
                    "event_cluster_stability",
                    "quote_quality_parity",
                ],
                "evidence_policy": "event_stream_required_not_ohlcv_only",
            }
        )
        overlay_contracts.append(
            {
                "overlay_id": "hawkes_lob_event_replay_harness",
                "source_papers": [
                    {
                        "source_id": "arxiv-2502.17417",
                        "url": "https://arxiv.org/abs/2502.17417",
                        "title": "Event-Based Limit Order Book Simulation under a Neural Hawkes Process: Application in Market-Making",
                        "mechanism": "twelve_event_neural_hawkes_lob_replay_fill_distribution_parity",
                    },
                    {
                        "source_id": "arxiv-2510.08085",
                        "url": "https://arxiv.org/abs/2510.08085",
                        "title": "A Deterministic Limit Order Book Simulator with Hawkes-Driven Order Flow",
                        "mechanism": "deterministic_marked_hawkes_lob_time_rescaling_goodness_of_fit",
                    },
                ],
                "required_evidence": [
                    "twelve_event_lob_taxonomy_coverage",
                    "interarrival_time_rescaling_diagnostics",
                    "hawkes_branching_ratio_stability",
                    "fill_distribution_real_data_parity",
                    "deterministic_replay_seed",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_event_taxonomy_and_hawkes_residual_stress"
                ),
                "evidence_policy": (
                    "hawkes_lob_event_replay_requires_real_event_tape_and_"
                    "diagnostic_residuals_not_ohlcv_or_synthetic_fill_authority"
                ),
            }
        )
        parameter_space["hawkes_lob_event_replay_harness"] = {
            "schema_version": "torghut.hawkes-lob-event-replay-harness.v1",
            "source_ids": ["arxiv-2502.17417", "arxiv-2510.08085"],
            "required_event_taxonomy": [
                "limit_add_bid",
                "limit_add_ask",
                "limit_cancel_bid",
                "limit_cancel_ask",
                "limit_delete_bid",
                "limit_delete_ask",
                "market_buy",
                "market_sell",
                "partial_fill_bid",
                "partial_fill_ask",
                "full_fill_bid",
                "full_fill_ask",
            ],
            "candidate_search_inputs": {
                "event_window_seconds_grid": ["1", "5", "15", "60"],
                "excitation_kernel_family_grid": [
                    "exponential",
                    "power_law",
                    "neural_lstm",
                ],
                "branching_ratio_cap_grid": ["0.85", "0.95", "0.98"],
                "time_rescaling_ks_pvalue_floor_grid": ["0.01", "0.05"],
                "fill_distribution_wasserstein_cap_grid": ["0.12", "0.20"],
            },
            "diagnostics_required": [
                "time_rescaling_ks_pvalue",
                "event_type_residual_autocorrelation",
                "branching_ratio",
                "fill_distribution_wasserstein_distance",
                "real_vs_replayed_event_mix_l1",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_exact_replay": True,
                "requires_real_lob_event_tape": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_hawkes_simulated_fills_as_authority": True,
            },
        }
        hard_vetoes.update(
            {
                "required_min_event_cluster_stability_score": "0.60",
                "required_max_event_stream_latency_ms": "250",
                "required_hawkes_lob_event_replay_harness": True,
                "required_lob_event_taxonomy_coverage": True,
                "required_min_lob_event_taxonomy_type_count": "8",
                "required_time_rescaling_diagnostics": True,
                "required_hawkes_branching_ratio_below_one": True,
                "required_fill_distribution_real_data_parity": True,
            }
        )
        promotion_contract.update(
            {
                "requires_lob_event_stream_parity": True,
                "requires_event_cluster_stability": True,
                "rejects_ohlcv_only_evidence": True,
                "requires_hawkes_lob_event_diagnostics": True,
                "requires_lob_event_taxonomy_coverage": True,
                "requires_fill_distribution_real_data_parity": True,
                "rejects_hawkes_simulated_fills_as_pnl_authority": True,
            }
        )


def _apply_mixed_market_limit_execution_policy_overlay(
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
            "market-versus-limit",
            "market versus limit",
            "market-vs-limit",
            "market and limit orders",
            "market limit order mix",
            "market-versus-limit order mix",
            "limit fill probability",
            "execution shortfall",
            "opportunity cost",
            "order type ablation",
            "price improvement",
            "broker route quality",
            "marketable limit",
            "passive limit",
            "patient limit order",
            "dynamic allocation between market and limit",
            "mixed-market-limit",
            "mixed market limit",
        )
    ):
        overlay_ids.append("mixed_market_limit_execution_policy")
        overlay_ids.append("logistic_normal_market_limit_allocation_grid")
        overlay_contracts.append(
            {
                "overlay_id": "mixed_market_limit_execution_policy",
                "required_evidence": [
                    "market_limit_order_mix",
                    "limit_fill_probability",
                    "execution_shortfall",
                    "order_type_ablation",
                    "opportunity_cost",
                    "price_improvement",
                    "route_tca",
                ],
                "rank_metric": "post_cost_net_pnl_after_fill_adjusted_execution",
                "evidence_policy": "market_limit_mix_requires_real_fill_evidence",
            }
        )
        overlay_contracts.append(
            {
                "overlay_id": "logistic_normal_market_limit_allocation_grid",
                "source_papers": [
                    {
                        "source_id": "arxiv-2507.06345",
                        "url": "https://arxiv.org/abs/2507.06345",
                        "title": "Reinforcement Learning for Trade Execution with Market and Limit Orders",
                        "mechanism": "multivariate_logistic_normal_market_limit_allocation_search",
                    },
                    {
                        "source_id": "arxiv-2502.17417",
                        "url": "https://arxiv.org/abs/2502.17417",
                        "title": "Event-Based Limit Order Book Simulation under a Neural Hawkes Process: Application in Market-Making",
                        "mechanism": "replay_fill_distribution_parity_for_market_limit_mix",
                    },
                ],
                "required_evidence": [
                    "market_limit_allocation_vector",
                    "allocation_entropy",
                    "limit_fill_probability",
                    "nonfill_opportunity_cost",
                    "tactical_imbalance_response",
                    "route_tca",
                    "order_lifecycle_fill_evidence",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_logistic_normal_allocation_shortfall_stress"
                ),
                "evidence_policy": (
                    "logistic_normal_allocation_grid_is_candidate_search_input_only_"
                    "and_requires_real_fill_evidence_for_promotion"
                ),
            }
        )
        parameter_space["logistic_normal_market_limit_allocation_grid"] = {
            "schema_version": "torghut.logistic-normal-market-limit-allocation-grid.v1",
            "source_ids": ["arxiv-2507.06345", "arxiv-2502.17417"],
            "allocation_dimensions": [
                "market_order_share",
                "best_limit_share",
                "passive_limit_share",
            ],
            "candidate_search_inputs": {
                "allocation_mean_grid": [
                    ["0.15", "0.70", "0.15"],
                    ["0.30", "0.55", "0.15"],
                    ["0.45", "0.40", "0.15"],
                ],
                "allocation_covariance_scale_grid": ["0.02", "0.08", "0.18"],
                "imbalance_response_slope_grid": ["0.0", "0.4", "0.8"],
                "urgency_response_slope_grid": ["0.2", "0.6", "1.0"],
                "limit_fill_probability_floor_grid": ["0.35", "0.50", "0.65"],
                "max_nonfill_opportunity_cost_bps_grid": ["4", "8", "12"],
            },
            "stress_inputs_required": [
                "spread_bps",
                "order_book_imbalance",
                "limit_fill_probability",
                "execution_shortfall_bps",
                "nonfill_opportunity_cost_bps",
                "route_tca_bps",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_exact_replay": True,
                "requires_order_lifecycle_fill_evidence": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_model_allocation_as_fill_authority": True,
            },
        }
        hard_vetoes.update(
            {
                "required_market_limit_order_mix_evidence": True,
                "required_limit_fill_probability_evidence": True,
                "required_logistic_normal_allocation_grid": True,
                "required_market_limit_allocation_vector": True,
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_opportunity_cost_evidence": True,
                "required_price_improvement_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            }
        )
        promotion_contract.update(
            {
                "requires_order_type_execution_quality": True,
                "requires_order_type_ablation": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
                "requires_opportunity_cost": True,
                "requires_price_improvement": True,
                "requires_logistic_normal_allocation_grid": True,
                "rejects_logistic_normal_allocation_without_fill_evidence": True,
                "execution_policy": "candidate_local_market_limit_mix",
            }
        )


def _apply_queue_position_survival_fill_curve_overlay(
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
            "kanformer",
            "queue-position",
            "queue position",
            "queue_position",
            "queue ratio",
            "queue_ratio",
            "time-to-fill",
            "time to fill",
            "time_to_fill",
            "survival analysis",
            "survival model",
            "survival_fill_curve",
            "fill survival",
            "fill_survival",
            "fill probability",
            "fill probabilities",
            "fill_probability",
            "limit fill probability",
            "limit_fill_probability",
            "nonfill opportunity cost",
            "nonfill_opportunity_cost",
            "right-censored",
            "right censored",
            "queue-reactive",
            "queue reactive",
            "mdqr",
            "multidimensional deep queue-reactive",
            "deep queue-reactive",
            "right-censored log-likelihood",
            "integrated brier score",
            "time-dependent auc",
            "time dependent auc",
            "fill calibration",
            "fill discrimination",
            "order submission latency",
            "submission latency",
            "ddqn execution",
            "double deep q-network",
            "counterfactual lob",
        )
    ):
        overlay_ids.append("queue_position_survival_fill_curve")
        overlay_ids.append("queue_reactive_survival_latency_grid")
        overlay_contracts.append(
            {
                "overlay_id": "queue_position_survival_fill_curve",
                "source_papers": [
                    {
                        "source_id": "arxiv-2512.05734",
                        "url": "https://arxiv.org/abs/2512.05734",
                        "title": "KANFormer for Predicting Fill Probabilities via Survival Analysis in Limit Order Books",
                        "mechanism": "queue_position_agent_lifecycle_survival_fill_probability_calibration",
                    },
                    {
                        "source_id": "arxiv-2504.00846",
                        "url": "https://arxiv.org/abs/2504.00846",
                        "title": "The effect of latency on optimal order execution policy",
                        "mechanism": "latency_limit_price_fill_probability_opportunity_cost_stress",
                    },
                ],
                "required_evidence": [
                    "queue_position",
                    "survival_fill_curve",
                    "time_to_fill_quantiles",
                    "limit_fill_probability",
                    "nonfill_opportunity_cost",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_queue_position_survival_fill_stress",
                "evidence_policy": "queue_position_fill_probability_requires_real_order_lifecycle_evidence",
            }
        )
        overlay_contracts.append(
            {
                "overlay_id": "queue_reactive_survival_latency_grid",
                "source_papers": [
                    {
                        "source_id": "arxiv-2501.08822",
                        "url": "https://arxiv.org/abs/2501.08822",
                        "title": "Deep Learning Meets Queue-Reactive: A Framework for Realistic Limit Order Book Simulation",
                        "mechanism": "multidimensional_deep_queue_reactive_lob_replay_parity_for_fill_stress",
                    },
                    {
                        "source_id": "arxiv-2511.15262",
                        "url": "https://arxiv.org/abs/2511.15262",
                        "title": "Reinforcement Learning in Queue-Reactive Models: Application to Optimal Execution",
                        "mechanism": "queue_reactive_counterfactual_execution_policy_benchmark_stress",
                    },
                    {
                        "source_id": "arxiv-2512.05734",
                        "url": "https://arxiv.org/abs/2512.05734",
                        "title": "KANFormer for Predicting Fill Probabilities via Survival Analysis in Limit Order Books",
                        "mechanism": "right_censored_time_to_fill_survival_probability_grid",
                    },
                    {
                        "source_id": "arxiv-2504.00846",
                        "url": "https://arxiv.org/abs/2504.00846",
                        "title": "The effect of latency on optimal order execution policy",
                        "mechanism": "order_submission_latency_fill_and_adverse_selection_stress",
                    },
                ],
                "required_evidence": [
                    "order_lifecycle_fill_labels",
                    "right_censored_time_to_fill_labels",
                    "queue_depth_state_vector",
                    "own_order_queue_position",
                    "survival_fill_curve",
                    "fill_probability_calibration_metrics",
                    "latency_distribution",
                    "missed_fill_opportunity_cost",
                    "queue_reactive_replay_parity",
                    "route_tca",
                    "runtime_ledger",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_queue_survival_latency_nonfill_stress"
                ),
                "evidence_policy": (
                    "queue_reactive_survival_grid_is_candidate_input_only_and_"
                    "requires_real_order_lifecycle_tca_runtime_ledger_authority"
                ),
            }
        )
        parameter_space["queue_reactive_survival_latency_grid"] = {
            "schema_version": "torghut.queue-reactive-survival-latency-grid.v1",
            "source_ids": [
                "arxiv-2501.08822",
                "arxiv-2511.15262",
                "arxiv-2512.05734",
                "arxiv-2504.00846",
            ],
            "candidate_search_inputs": {
                "survival_model_family_grid": [
                    "cox_baseline",
                    "kanformer",
                    "dilated_conv_transformer",
                ],
                "queue_reactive_model_family_grid": [
                    "state_dependent_queue_reactive",
                    "multidimensional_deep_queue_reactive",
                ],
                "queue_depth_level_count_grid": ["1", "3", "5", "10"],
                "time_to_fill_horizon_seconds_grid": ["1", "5", "15", "60", "300"],
                "latency_quantile_ms_grid": ["25", "50", "100", "250", "500"],
                "limit_price_offset_ticks_grid": ["0", "1", "2"],
                "nonfill_opportunity_cost_bps_grid": ["2", "5", "8", "12"],
                "cancel_replace_age_seconds_grid": ["1", "5", "15", "60"],
                "queue_position_feature_grid": [
                    "top_of_queue_fraction",
                    "estimated_shares_ahead",
                    "agent_level_lifecycle_state",
                ],
                "counterfactual_policy_benchmark_grid": [
                    "market_order",
                    "marketable_limit",
                    "passive_limit",
                    "cancel_replace",
                    "twap_child_order",
                ],
            },
            "stress_inputs_required": [
                "order_lifecycle_events",
                "queue_depth_state_vector",
                "own_order_queue_position",
                "right_censored_fill_labels",
                "time_to_fill_seconds",
                "limit_fill_probability",
                "submission_latency_ms",
                "missed_fill_opportunity_cost_bps",
                "adverse_selection_bps",
                "route_tca_bps",
                "runtime_ledger_post_cost_pnl",
            ],
            "diagnostics_required": [
                "right_censored_log_likelihood",
                "integrated_brier_score",
                "c_index",
                "time_dependent_auc",
                "fill_probability_calibration_error",
                "queue_reactive_event_mix_l1",
                "order_size_distribution_wasserstein",
                "latency_adjusted_fill_shortfall_bps",
                "missed_winner_vs_filled_loser_count",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_exact_replay": True,
                "requires_real_order_lifecycle_fill_labels": True,
                "requires_right_censored_labels": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_survival_model_fill_probability_as_fill_authority": True,
                "rejects_queue_reactive_counterfactual_pnl_as_profit_proof": True,
                "rejects_latency_free_fill_assumptions": True,
            },
        }
        hard_vetoes.update(
            {
                "required_queue_position_survival_fill_curve": True,
                "required_queue_reactive_survival_latency_grid": True,
                "required_min_queue_position_survival_sample_count": "60",
                "required_max_queue_position_nonfill_opportunity_cost_bps": "8",
                "required_time_to_fill_quantiles": True,
                "required_order_lifecycle_fill_evidence": True,
                "required_right_censored_time_to_fill_labels": True,
                "required_fill_probability_calibration_metrics": True,
                "required_max_fill_probability_calibration_error": "0.08",
                "required_min_fill_survival_c_index": "0.55",
                "required_latency_distribution": True,
                "required_latency_adjusted_fill_shortfall": True,
                "required_queue_reactive_replay_parity": True,
                "required_max_queue_reactive_event_mix_l1": "0.20",
            }
        )
        promotion_contract.update(
            {
                "requires_queue_position_survival_fill_curve": True,
                "requires_queue_reactive_survival_latency_grid": True,
                "requires_time_to_fill_quantiles": True,
                "requires_nonfill_opportunity_cost": True,
                "requires_order_lifecycle_fill_evidence": True,
                "requires_right_censored_time_to_fill_labels": True,
                "requires_fill_probability_calibration_metrics": True,
                "requires_latency_distribution": True,
                "requires_latency_adjusted_fill_shortfall": True,
                "requires_queue_reactive_replay_parity": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_queue_position_free_fill_assumptions": True,
                "rejects_survival_model_fill_probability_as_fill_authority": True,
                "rejects_queue_reactive_counterfactual_pnl_as_profit_proof": True,
                "rejects_latency_free_fill_assumptions": True,
                "execution_policy": "queue_position_survival_fill_curve",
            }
        )


def _apply_mpc_dynamic_execution_schedule_overlay(state: MechanismOverlayState) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "model predictive control",
            "model-predictive control",
            "mpc trade execution",
            "mpc execution",
            "mpc_execution",
            "dynamic execution schedule",
            "dynamic_execution_schedule",
            "execution schedule control",
            "execution_schedule_trace",
            "liquidity forecast",
            "liquidity_forecast",
            "inventory path",
            "inventory_path",
            "execution shortfall",
            "execution_shortfall",
        )
    ):
        overlay_ids.append("mpc_dynamic_execution_schedule")
        overlay_contracts.append(
            {
                "overlay_id": "mpc_dynamic_execution_schedule",
                "required_evidence": [
                    "execution_schedule_trace",
                    "liquidity_forecast",
                    "inventory_path",
                    "execution_shortfall",
                    "route_tca",
                    "latency_stress",
                    "market_impact_stress",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "post_cost_net_pnl_after_mpc_schedule_shortfall_stress",
                "evidence_policy": (
                    "dynamic_execution_schedule_requires_replay_shortfall_ablation"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_mpc_dynamic_execution_schedule": True,
                "required_execution_schedule_trace": True,
                "required_liquidity_forecast": True,
                "required_inventory_path_trace": True,
                "required_execution_shortfall_evidence": True,
                "required_mpc_schedule_shortfall_ablation_passed": True,
                "required_min_mpc_schedule_trace_sample_count": "60",
                "required_latency_stress": True,
                "required_market_impact_stress": True,
                "required_max_mpc_schedule_shortfall_bps": "8",
            }
        )
        promotion_contract.update(
            {
                "requires_mpc_dynamic_execution_schedule": True,
                "requires_execution_schedule_trace": True,
                "requires_liquidity_forecast": True,
                "requires_inventory_path_trace": True,
                "requires_execution_shortfall": True,
                "requires_route_tca": True,
                "requires_latency_stress": True,
                "requires_market_impact_stress": True,
                "rejects_static_schedule_free_mpc_claims": True,
                "rejects_dynamic_schedule_without_shortfall_ablation": True,
                "execution_policy": "mpc_dynamic_schedule_validation_only",
            }
        )


def apply_microstructure_mechanism_overlays(state: MechanismOverlayState) -> None:
    _apply_cluster_lob_event_clustering_overlay(state)
    _apply_mixed_market_limit_execution_policy_overlay(state)
    _apply_queue_position_survival_fill_curve_overlay(state)
    _apply_mpc_dynamic_execution_schedule_overlay(state)


__all__ = ["apply_microstructure_mechanism_overlays"]
