"""Execution research mechanism overlays for candidate spec compilation."""

from __future__ import annotations

from .candidate_spec_mechanism_overlay_state import MechanismOverlayState


def _apply_stochastic_liquidity_resilience_execution_grid_overlay(
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
            "liquidity uncertainty",
            "liquidity_uncertainty",
            "stochastic liquidity",
            "stochastic_liquidity",
            "stochastic market depth",
            "stochastic_market_depth",
            "market depth and resilience",
            "market-depth resilience",
            "limit-order book shape",
            "limit order book shape",
            "lob shape",
            "regime-switching liquidity",
            "regime switching liquidity",
            "liquidity regime switching",
            "liquidity resilience",
            "stochastic volume effect",
            "volume effect governing recovery",
        )
    ):
        overlay_ids.append("stochastic_liquidity_resilience_execution_grid")
        overlay_contracts.append(
            {
                "overlay_id": "stochastic_liquidity_resilience_execution_grid",
                "source_papers": [
                    {
                        "source_id": "arxiv-2506.11813",
                        "url": "https://arxiv.org/abs/2506.11813",
                        "title": "Optimal Execution under Liquidity Uncertainty",
                        "mechanism": "regime_switching_liquidity_resilience_and_lob_shape_execution_boundaries",
                    },
                    {
                        "source_id": "ssrn-3798235",
                        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3798235",
                        "title": "Constrained Optimal Execution Problem in Limit Order Book Market with Stochastic Market Depth",
                        "mechanism": "markov_chain_stochastic_market_depth_shape_constrained_execution",
                    },
                ],
                "required_evidence": [
                    "liquidity_regime_transition_trace",
                    "stochastic_market_depth_state",
                    "lob_shape_parameter_history",
                    "resilience_decay_half_life",
                    "depth_recovery_after_child_order",
                    "execution_shortfall_by_liquidity_regime",
                    "route_tca",
                    "runtime_ledger",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_liquidity_regime_resilience_shortfall_stress"
                ),
                "evidence_policy": (
                    "stochastic_liquidity_resilience_grid_is_candidate_input_only_"
                    "and_requires_real_depth_recovery_route_tca_runtime_ledger_proof"
                ),
            }
        )
        parameter_space["stochastic_liquidity_resilience_execution_grid"] = {
            "schema_version": (
                "torghut.stochastic-liquidity-resilience-execution-grid.v1"
            ),
            "source_ids": ["arxiv-2506.11813", "ssrn-3798235"],
            "candidate_search_inputs": {
                "liquidity_regime_count_grid": ["2", "3", "4"],
                "regime_transition_probability_grid": ["0.02", "0.05", "0.10"],
                "lob_shape_family_grid": [
                    "block",
                    "linear",
                    "power_law",
                    "empirical_piecewise",
                ],
                "resilience_half_life_seconds_grid": ["5", "30", "120", "600"],
                "stochastic_volume_effect_scale_grid": ["0.25", "0.50", "1.00"],
                "max_child_participation_rate_grid": ["0.01", "0.03", "0.05"],
                "execution_boundary_buffer_bps_grid": ["2", "5", "10"],
            },
            "stress_inputs_required": [
                "bid_depth",
                "ask_depth",
                "depth_recovery_after_trade",
                "spread_bps",
                "child_order_participation_rate",
                "execution_shortfall_bps",
                "route_tca_bps",
            ],
            "diagnostics_required": [
                "liquidity_regime_transition_count",
                "depth_shape_fit_error",
                "resilience_half_life_estimate_seconds",
                "impact_recovery_residual_bps",
                "shortfall_by_liquidity_regime",
            ],
            "proof_neutrality": {
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "requires_exact_replay": True,
                "requires_real_lob_depth_history": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_modeled_resilience_as_realized_pnl_authority": True,
                "rejects_synthetic_depth_recovery_as_fill_authority": True,
            },
        }
        hard_vetoes.update(
            {
                "required_stochastic_liquidity_resilience_execution_grid": True,
                "required_liquidity_regime_transition_trace": True,
                "required_stochastic_market_depth_state": True,
                "required_lob_shape_parameter_history": True,
                "required_resilience_decay_half_life": True,
                "required_depth_recovery_after_child_order": True,
                "required_execution_shortfall_by_liquidity_regime": True,
                "required_max_liquidity_regime_shortfall_bps": "10",
            }
        )
        promotion_contract.update(
            {
                "requires_stochastic_liquidity_resilience_execution_grid": True,
                "requires_liquidity_regime_transition_trace": True,
                "requires_stochastic_market_depth_state": True,
                "requires_lob_shape_parameter_history": True,
                "requires_depth_recovery_after_child_order": True,
                "requires_execution_shortfall_by_liquidity_regime": True,
                "requires_route_tca": True,
                "requires_runtime_ledger": True,
                "rejects_modeled_liquidity_resilience_as_profit_proof": True,
                "rejects_synthetic_depth_recovery_as_fill_authority": True,
                "execution_liquidity_policy": (
                    "stochastic_liquidity_resilience_validation_only"
                ),
            }
        )


def _apply_alpha_decay_predictability_stress_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "alpha decay",
            "alpha_decay",
            "predictability decay",
            "predictability_decay",
            "declined over time",
            "market efficiency",
            "short-run market efficiency",
            "t-kan",
            "tkan",
            "temporal kolmogorov",
            "tlob",
            "dual attention",
            "horizon bias",
            "horizon_bias",
            "spread-adjusted labels",
            "spread adjusted labels",
            "algorithmic activity",
            "tight spreads",
            "heavier trading",
            "high-volume regimes",
            "high volume regimes",
        )
    ):
        overlay_ids.append("alpha_decay_predictability_stress")
        overlay_contracts.append(
            {
                "overlay_id": "alpha_decay_predictability_stress",
                "required_evidence": [
                    "horizon_decay_curve",
                    "spread_adjusted_labels",
                    "tight_spread_regime_slices",
                    "high_volume_regime_slices",
                    "inference_latency",
                    "walk_forward_replay",
                    "route_tca",
                ],
                "rank_metric": "post_cost_net_pnl_after_predictability_decay_stress",
                "evidence_policy": "short_horizon_lob_alpha_requires_decay_and_cost_stress",
            }
        )
        hard_vetoes.update(
            {
                "required_predictability_decay_stress": True,
                "required_horizon_decay_curve": True,
                "required_spread_adjusted_label_replay": True,
                "required_min_decay_stress_horizon_count": "3",
                "required_min_tight_spread_regime_count": "20",
                "required_min_high_volume_regime_count": "20",
                "required_min_decay_stress_split_pass_rate": "0.60",
                "required_max_decay_stress_best_split_share": "0.35",
                "required_max_model_inference_latency_ms": "200",
            }
        )
        promotion_contract.update(
            {
                "requires_predictability_decay_stress": True,
                "requires_horizon_decay_curve": True,
                "requires_spread_adjusted_label_replay": True,
                "requires_tight_spread_and_high_volume_slices": True,
                "requires_model_latency_budget": True,
                "requires_route_tca": True,
                "rejects_single_horizon_lob_alpha_promotion": True,
                "rejects_classification_accuracy_without_costs": True,
            }
        )


def _apply_friction_aware_regime_conditioned_policy_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "fr-lux",
            "friction-aware",
            "friction aware",
            "regime-conditioned",
            "regime conditioned",
            "volatility-liquidity regime",
            "volatility liquidity regime",
            "trade-space trust region",
            "trade space trust region",
            "inventory flow trust region",
            "turnover budget",
            "turnover bounds",
            "inaction band",
            "convex frictions",
            "cost misspecification",
            "liquidity proxy",
            "liquidity proxies",
        )
    ):
        overlay_ids.append("friction_aware_regime_conditioned_policy")
        overlay_contracts.append(
            {
                "overlay_id": "friction_aware_regime_conditioned_policy",
                "required_evidence": [
                    "regime_state",
                    "regime_conditioned_policy",
                    "proportional_cost_model",
                    "impact_cost_model",
                    "liquidity_proxy_cost_calibration",
                    "trade_space_trust_region",
                    "turnover_budget",
                    "cost_misspecification_stress",
                    "scenario_level_inference",
                    "post_cost_net_pnl",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_regime_conditioned_friction_stress",
                "evidence_policy": (
                    "friction_aware_regime_conditioned_policy_is_replay_ranking_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_friction_aware_regime_conditioning": True,
                "required_proportional_and_impact_cost_model": True,
                "required_liquidity_proxy_cost_calibration": True,
                "required_trade_space_trust_region": True,
                "required_turnover_budget": True,
                "required_cost_misspecification_stress": True,
                "required_scenario_level_inference": True,
                "required_live_paper_parity": True,
            }
        )
        promotion_contract.update(
            {
                "requires_regime_conditioned_policy": True,
                "requires_proportional_and_impact_cost_model": True,
                "requires_liquidity_proxy_cost_calibration": True,
                "requires_trade_space_trust_region": True,
                "requires_turnover_budget": True,
                "requires_cost_misspecification_stress": True,
                "requires_scenario_level_inference": True,
                "requires_live_paper_parity": True,
                "rejects_cost_blind_policy_optimization": True,
                "rejects_single_regime_cost_backtest": True,
                "risk_policy": "friction_aware_regime_conditioned_policy_validation_only",
            }
        )


def _apply_adaptive_factor_to_execution_loop_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "alphacrafter",
            "adaptive factor-to-execution",
            "factor-to-execution",
            "adaptive factor screener",
            "continuous factor mining",
            "factor pool expansion",
            "regime-adaptive factor",
            "regime adaptive factor",
            "risk-constrained execution",
            "risk constrained execution",
            "continuous candidate refresh",
            "miner screener trader",
            "factor discovery loop",
            "closed-loop cross-sectional trading",
        )
    ):
        overlay_ids.append("adaptive_factor_to_execution_loop")
        overlay_contracts.append(
            {
                "overlay_id": "adaptive_factor_to_execution_loop",
                "required_evidence": [
                    "continuous_factor_mining",
                    "factor_pool_expansion",
                    "adaptive_factor_screener",
                    "regime_adaptive_factor_ensemble",
                    "risk_constrained_execution",
                    "portfolio_replay",
                    "walk_forward_replay",
                    "transaction_cost_stress",
                    "post_cost_net_pnl",
                    "runtime_ledger_profit_proof",
                ],
                "rank_metric": "adaptive_factor_loop_post_cost_net_pnl_per_day",
                "evidence_policy": (
                    "adaptive_factor_loop_is_search_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_adaptive_factor_to_execution_loop": True,
                "required_continuous_factor_mining": True,
                "required_adaptive_factor_screener": True,
                "required_regime_adaptive_factor_ensemble": True,
                "required_risk_constrained_execution": True,
                "required_post_cost_replay": True,
            }
        )
        promotion_contract.update(
            {
                "requires_adaptive_factor_to_execution_loop": True,
                "requires_continuous_factor_mining": True,
                "requires_adaptive_factor_screener": True,
                "requires_regime_adaptive_factor_ensemble": True,
                "requires_risk_constrained_execution": True,
                "requires_portfolio_replay": True,
                "requires_post_cost_net_pnl": True,
                "requires_runtime_ledger_profit_proof": True,
                "rejects_agentic_search_only_promotion": True,
                "rejects_factor_screen_only_promotion": True,
                "rejects_static_one_shot_factor_mining": True,
                "risk_policy": "adaptive_factor_to_execution_loop_validation_only",
            }
        )


def _apply_regime_weighted_conformal_cost_buffer_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "regime-weighted conformal",
            "regime weighted conformal",
            "regime_weighted_conformal",
            "conformal var",
            "conformal_var",
            "conformal value-at-risk",
            "conformal risk control",
            "conformal_risk_control",
            "conformal tail risk",
            "conformal_tail_risk",
            "tail risk buffer",
            "breakeven cost buffer",
            "breakeven transaction-cost",
            "breakeven_transaction_cost",
            "transaction cost buffer",
            "regime-similarity weight",
            "regime similarity weight",
            "tail exceedance",
            "tail_exceedance",
        )
    ):
        overlay_ids.append("regime_weighted_conformal_cost_buffer")
        overlay_contracts.append(
            {
                "overlay_id": "regime_weighted_conformal_cost_buffer",
                "required_evidence": [
                    "regime_weighted_conformal_var",
                    "conformal_tail_risk",
                    "regime_tail_exceedance",
                    "regime_similarity_weights",
                    "breakeven_transaction_cost_buffer",
                    "transaction_cost_stress",
                    "seed_robustness",
                    "model_family_robustness",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "conformal_tail_risk_adjusted_net_pnl_per_day",
                "evidence_policy": (
                    "regime_weighted_conformal_buffer_is_ranking_stress_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_conformal_tail_risk": True,
                "required_regime_weighted_conformal_cost_buffer": True,
                "required_min_conformal_tail_risk_sample_count": "20",
                "required_regime_tail_exceedance_report": True,
                "required_breakeven_transaction_cost_buffer": True,
                "required_seed_model_family_robustness": True,
                "required_conformal_tail_risk_adjusted_net_above_target": True,
            }
        )
        promotion_contract.update(
            {
                "requires_conformal_tail_risk": True,
                "requires_conformal_var_cost_buffer": True,
                "requires_regime_tail_exceedance_report": True,
                "requires_breakeven_transaction_cost_buffer": True,
                "requires_seed_model_family_robustness": True,
                "requires_walk_forward_replay": True,
                "rejects_unbuffered_tail_risk_promotion": True,
                "rejects_single_seed_conformal_var_proof": True,
                "risk_policy": "regime_weighted_conformal_cost_buffer_validation_only",
            }
        )


def _apply_risk_aware_trading_portfolio_optimization_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "risk-aware trading portfolio optimization",
            "risk aware trading portfolio optimization",
            "risk-aware trading swarm",
            "risk_aware_trading_swarm",
            "ratpo",
            "rats algorithm",
            "eligible optimization strategy",
            "unique eligible instrument",
            "unique eligible instruments",
            "market sensitivity constraints",
            "market sensitivities",
            "capital charge",
            "portfolio objective value",
            "market risk and pnl",
            "market risk and profit",
        )
    ):
        overlay_ids.append("risk_aware_trading_portfolio_optimization")
        overlay_contracts.append(
            {
                "overlay_id": "risk_aware_trading_portfolio_optimization",
                "required_evidence": [
                    "portfolio_replay",
                    "market_risk_var",
                    "pnl_objective",
                    "eligible_instrument_universe",
                    "eligible_optimization_strategy",
                    "market_sensitivity_constraints",
                    "capital_charge_stress",
                    "transaction_cost_stress",
                    "risk_limit_compliance",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "risk_adjusted_post_cost_net_pnl_per_day",
                "evidence_policy": (
                    "risk_aware_portfolio_optimizer_is_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_risk_aware_portfolio_optimization": True,
                "required_portfolio_replay": True,
                "required_market_risk_var": True,
                "required_market_sensitivity_constraints": True,
                "required_capital_charge_stress": True,
                "required_risk_limit_compliance": True,
                "required_transaction_cost_stress": True,
            }
        )
        promotion_contract.update(
            {
                "requires_risk_aware_portfolio_optimization": True,
                "requires_portfolio_replay": True,
                "requires_market_risk_var": True,
                "requires_market_sensitivity_constraints": True,
                "requires_capital_charge_stress": True,
                "requires_risk_limit_compliance": True,
                "requires_post_cost_net_pnl": True,
                "rejects_risk_only_objective_without_post_cost_pnl": True,
                "rejects_optimizer_only_promotion": True,
                "risk_policy": "risk_aware_portfolio_optimization_validation_only",
            }
        )


def _apply_double_selection_factor_screen_overlay(state: MechanismOverlayState) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "double-selection lasso",
            "double selection lasso",
            "double_selection_lasso",
            "high-dimensional factor",
            "high dimensional factor",
            "short-term trading factor",
            "short term trading factor",
            "short_term_trading_factors",
            "alpha191",
            "factor_rank_panel",
            "factor screen",
            "factor-screen",
            "multiple-testing controls",
            "multiple_testing_controls",
            "train_holdout_split",
        )
    ):
        overlay_ids.append("double_selection_factor_screen")
        overlay_contracts.append(
            {
                "overlay_id": "double_selection_factor_screen",
                "required_evidence": [
                    "short_term_trading_factors",
                    "cross_sectional_ranks",
                    "factor_rank_panel",
                    "train_holdout_split",
                    "multiple_testing_controls",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                    "runtime_ledger_profit_proof",
                ],
                "rank_metric": "double_selection_factor_post_cost_net_pnl_per_day",
                "evidence_policy": (
                    "double_selection_factor_screen_is_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_double_selection_factor_screen": True,
                "required_short_term_trading_factors": True,
                "required_cross_sectional_rank_panel": True,
                "required_train_holdout_split": True,
                "required_multiple_testing_controls": True,
                "required_post_cost_replay": True,
            }
        )
        promotion_contract.update(
            {
                "requires_double_selection_factor_screen": True,
                "requires_cross_sectional_rank_panel": True,
                "requires_train_holdout_split": True,
                "requires_multiple_testing_controls": True,
                "requires_post_cost_net_pnl": True,
                "requires_runtime_ledger_profit_proof": True,
                "rejects_factor_screen_only_promotion": True,
                "rejects_in_sample_factor_selection": True,
                "risk_policy": "double_selection_factor_screen_validation_only",
            }
        )


def apply_execution_research_mechanism_overlays(state: MechanismOverlayState) -> None:
    _apply_stochastic_liquidity_resilience_execution_grid_overlay(state)
    _apply_alpha_decay_predictability_stress_overlay(state)
    _apply_friction_aware_regime_conditioned_policy_overlay(state)
    _apply_adaptive_factor_to_execution_loop_overlay(state)
    _apply_regime_weighted_conformal_cost_buffer_overlay(state)
    _apply_risk_aware_trading_portfolio_optimization_overlay(state)
    _apply_double_selection_factor_screen_overlay(state)


__all__ = ["apply_execution_research_mechanism_overlays"]
