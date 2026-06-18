"""Candidate spec compilation from typed whitepaper hypotheses."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence, cast

from app.trading.discovery.factor_acceptance import build_factor_acceptance_artifact
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.replay_tape import (
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    build_hpairs_replay_tape_feature_schema_hash,
    hpairs_replay_tape_feature_versions,
)
from .candidate_spec_profiles import (
    AI_ACCELERATOR_UNIVERSE_PROFILE as _AI_ACCELERATOR_UNIVERSE_PROFILE,
    BASE_FAMILY_EXECUTION_PROFILES as _BASE_FAMILY_EXECUTION_PROFILES,
    BREAKOUT_UNIVERSE_PROFILES as _BREAKOUT_UNIVERSE_PROFILES,
    BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE as _BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
    DEFAULT_PROFILE_COUNT as _DEFAULT_PROFILE_COUNT,
    FAMILY_EXECUTION_PROFILES as _FAMILY_EXECUTION_PROFILES,
    FAMILY_RUNTIME as _FAMILY_RUNTIME,
    FAMILY_TIEBREAK as _FAMILY_TIEBREAK,
    H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES as _H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES,
    LARGE_CAP_UNIVERSE_PROFILES as _LARGE_CAP_UNIVERSE_PROFILES,
    LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE as _LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE,
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    MAX_FAMILIES_PER_HYPOTHESIS as _MAX_FAMILIES_PER_HYPOTHESIS,
    PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES as _PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES,
    PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_SLEEVE_FAMILY_ORDER as _PORTFOLIO_SLEEVE_FAMILY_ORDER,
    PORTFOLIO_SLEEVE_FAMILY_TARGET as _PORTFOLIO_SLEEVE_FAMILY_TARGET,
    PORTFOLIO_TARGET_NET_PNL_PER_DAY as _PORTFOLIO_TARGET_NET_PNL_PER_DAY,
    REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES as _REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES,
    RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE,
    RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE_PROFILE as _RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE,
    REVERSAL_UNIVERSE_PROFILES as _REVERSAL_UNIVERSE_PROFILES,
    TSMOM_UNIVERSE_PROFILES as _TSMOM_UNIVERSE_PROFILES,
)
from .candidate_spec_common import (
    mapping as _mapping,
    stable_hash as _stable_hash,
    stable_int as _stable_int,
    string as _string,
    string_sequence as _string_sequence,
)
from .candidate_spec_profile_variants import (
    adverse_selection_feedback_escape_profile as _adverse_selection_feedback_escape_profile,
    capital_constrained_execution_profiles as _capital_constrained_execution_profiles,
    capital_limited_profile_values as _capital_limited_profile_values,
    cash_constrain_profile as _cash_constrain_profile,
    clamped_profile_decimal as _clamped_profile_decimal,
    consistency_guard_feedback_escape_profile as _consistency_guard_feedback_escape_profile,
    daily_coverage_feedback_escape_profile as _daily_coverage_feedback_escape_profile,
    decimal_profile_param as _decimal_profile_param,
    drop_fragile_prev_close_positive_gate as _drop_fragile_prev_close_positive_gate,
    execution_profile_id as _execution_profile_id,
    execution_profile_index as _execution_profile_index,
    execution_profile_indexes as _execution_profile_indexes,
    execution_profiles_for_target as _execution_profiles_for_target,
    format_profile_budget as _format_profile_budget,
    int_profile_param as _int_profile_param,
    notional_throughput_feedback_escape_profile as _notional_throughput_feedback_escape_profile,
    portfolio_feedback_escape_execution_profiles as _portfolio_feedback_escape_execution_profiles,
    profile_rank_count_floor as _profile_rank_count_floor,
    strategy_overrides_for_profile as _strategy_overrides_for_profile,
    symbol_diversification_feedback_escape_profile as _symbol_diversification_feedback_escape_profile,
    turnover_coverage_feedback_escape_profile as _turnover_coverage_feedback_escape_profile,
)


CANDIDATE_SPEC_SCHEMA_VERSION = "torghut.candidate-spec.v1"


def _universe_symbol_override(symbols: Sequence[str]) -> tuple[str, ...]:
    cleaned: list[str] = []
    seen: set[str] = set()
    allowed = set(_RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE)
    for symbol in symbols:
        normalized = str(symbol).strip().upper()
        if not normalized or normalized in seen or normalized not in allowed:
            continue
        cleaned.append(normalized)
        seen.add(normalized)
    return tuple(cleaned)


def _list_of_mappings(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    return tuple(
        _mapping(item) for item in cast(Sequence[Any], value) if _mapping(item)
    )


def _hypothesis_haystack(card: HypothesisCard) -> str:
    return " ".join(
        [
            card.mechanism,
            card.asset_scope,
            card.horizon_scope,
            " ".join(card.required_features),
            " ".join(card.entry_motifs),
            " ".join(card.exit_motifs),
            " ".join(card.expected_regimes),
            " ".join(card.failure_modes),
            " ".join(card.source_claim_ids),
        ]
    ).lower()


def _has_rejected_signal_outcome_calibration(card: HypothesisCard) -> bool:
    haystack = _hypothesis_haystack(card)
    return any(
        token in haystack
        for token in (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
        )
    )


def _normalization_candidates_for_card(card: HypothesisCard) -> tuple[str, ...]:
    haystack = _hypothesis_haystack(card)
    candidates = ["price_scaled", "trading_value_scaled"]
    if any(
        token in haystack
        for token in (
            "market cap",
            "market-cap",
            "market_cap",
            "matched filter",
            "matched-filter",
            "matched_filter",
            "scale-invariant",
            "scale invariant",
        )
    ):
        candidates.append("market_cap_scaled")
    if any(
        token in haystack
        for token in (
            "opening",
            "session segment",
            "session_segment",
            "timezone",
            "time-of-day",
            "time of day",
        )
    ):
        candidates.append("opening_window_scaled")
    return tuple(dict.fromkeys(candidates))


def _requires_synthetic_validation_only_policy(card: HypothesisCard) -> bool:
    validation_requirements = _list_of_mappings(
        card.implementation_constraints.get("validation_requirements")
    )
    haystack = " ".join(
        " ".join(
            (
                str(item.get("claim_type") or ""),
                str(item.get("claim_text") or ""),
                " ".join(_string_sequence(item.get("data_requirements"))),
            )
        ).lower()
        for item in validation_requirements
    )
    return any(
        token in haystack
        for token in (
            "synthetic",
            "generated",
            "simulation",
            "simulated",
            "stress",
            "live_paper_parity",
        )
    )


def _is_validation_or_execution_constraint_only(card: HypothesisCard) -> bool:
    source_claims = _list_of_mappings(
        card.implementation_constraints.get("source_claims")
    )
    claim_types = {
        str(item.get("claim_type") or "").strip().lower()
        for item in source_claims
        if str(item.get("claim_type") or "").strip()
    }
    if not claim_types:
        return False
    signal_claim_types = {
        "feature_recipe",
        "signal_mechanism",
        "strategy_mechanism",
        "portfolio_construction",
    }
    if claim_types & signal_claim_types:
        return False
    return claim_types <= {
        "execution_assumption",
        "market_regime",
        "risk_constraint",
        "validation_requirement",
    }


def _paper_mechanism_haystack(card: HypothesisCard) -> str:
    validation_requirements = _list_of_mappings(
        card.implementation_constraints.get("validation_requirements")
    )
    validation_text = " ".join(
        " ".join(
            (
                str(item.get("claim_id") or ""),
                str(item.get("claim_type") or ""),
                str(item.get("claim_text") or ""),
                " ".join(_string_sequence(item.get("data_requirements"))),
            )
        )
        for item in validation_requirements
    )
    return f"{_hypothesis_haystack(card)} {validation_text}".lower()


def _requires_factor_acceptance_harness(card: HypothesisCard) -> bool:
    haystack = _paper_mechanism_haystack(card)
    return any(
        token in haystack
        for token in (
            "rankic",
            "rank ic",
            "rank-ir",
            "rank ir",
            "information coefficient",
            "factor mining",
            "factor discovery",
            "factor screener",
            "alpha factor",
            "signal discovery",
            "llm signal",
            "quantitative signal discovery",
            "adaptive factor",
            "chain-of-alpha",
            "alphacrafter",
            "alpha-r1",
            "r&d-agent-quant",
            "rd-agent-quant",
            "factorminer",
        )
    )


def _factor_acceptance_dependencies(
    card: HypothesisCard, strategy_overrides: Mapping[str, Any]
) -> tuple[str, ...]:
    params = _mapping(strategy_overrides.get("params"))
    dependencies: list[str] = []
    for key in ("rank_feature", "gate_feature"):
        value = _string(params.get(key))
        if value:
            dependencies.append(value)
    dependencies.extend(card.required_features)
    return tuple(dict.fromkeys(item for item in dependencies if item))


def _factor_acceptance_expression(strategy_overrides: Mapping[str, Any]) -> str:
    params = _mapping(strategy_overrides.get("params"))
    rank_feature = _string(params.get("rank_feature"))
    gate_feature = _string(params.get("gate_feature"))
    if rank_feature and gate_feature:
        return f"{rank_feature}|gated_by:{gate_feature}"
    if rank_feature:
        return rank_feature
    return "candidate_family_score"


def _apply_factor_acceptance_harness(
    *,
    card: HypothesisCard,
    feature_contract: dict[str, Any],
    parameter_space: dict[str, Any],
    strategy_overrides: Mapping[str, Any],
    hard_vetoes: dict[str, Any],
    promotion_contract: dict[str, Any],
) -> None:
    if not _requires_factor_acceptance_harness(card):
        return
    artifact = build_factor_acceptance_artifact(
        factor_expression=_factor_acceptance_expression(strategy_overrides),
        source_idea="2025_2026_signal_discovery_rankic_acceptance_harness",
        allowed_feature_dependencies=_factor_acceptance_dependencies(
            card, strategy_overrides
        ),
        train_window={"source": "runtime_replay_required"},
        test_window={"source": "holdout_or_live_paper_required"},
        sample_count=0,
        candidate_count=1,
    )
    feature_contract["factor_acceptance_artifact"] = artifact
    feature_contract["factor_acceptance_policy"] = (
        "deterministic_rankic_rankir_cost_stress_fail_closed"
    )
    overlay_ids = [
        str(item)
        for item in cast(
            Sequence[Any], parameter_space.get("mechanism_overlay_ids") or []
        )
    ]
    if "rankic_factor_acceptance_harness" not in overlay_ids:
        overlay_ids.append("rankic_factor_acceptance_harness")
    parameter_space["mechanism_overlay_ids"] = overlay_ids
    hard_vetoes.update(
        {
            "required_factor_acceptance_artifact": True,
            "required_factor_acceptance_status": "accepted",
            "required_factor_acceptance_min_rank_ic": artifact["thresholds"][
                "min_rank_ic"
            ],
            "required_factor_acceptance_min_rank_ir": artifact["thresholds"][
                "min_rank_ir"
            ],
            "required_factor_acceptance_max_deflated_p_value": artifact["thresholds"][
                "max_deflated_p_value"
            ],
            "required_factor_acceptance_min_sample_count": artifact["thresholds"][
                "min_sample_count"
            ],
            "required_factor_acceptance_cost_stressed_positive": True,
        }
    )
    promotion_contract.update(
        {
            "requires_factor_acceptance_artifact": True,
            "requires_feature_dependency_parity": True,
            "requires_rankic_rankir_holdout_acceptance": True,
            "requires_multiple_testing_penalty": True,
            "requires_cost_stressed_factor_expectancy": True,
            "rejects_llm_generated_factor_without_deterministic_acceptance": True,
            "rejects_factor_acceptance_as_live_promotion_proof": True,
        }
    )


def _mechanism_overlays_for_card(card: HypothesisCard) -> dict[str, Any]:
    haystack = _paper_mechanism_haystack(card)
    overlay_ids: list[str] = []
    overlay_contracts: list[dict[str, Any]] = []
    parameter_space: dict[str, Any] = {}
    hard_vetoes: dict[str, Any] = {}
    promotion_contract: dict[str, Any] = {}

    def has_any(tokens: Sequence[str]) -> bool:
        return any(token in haystack for token in tokens)

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

    if has_any(
        (
            "reality gap",
            "simulation reality",
            "sim-to-live",
            "simulation-to-live",
            "simulation parity",
            "simulation_parity",
            "synthetic lob",
            "lob simulation",
            "limit-order-book simulation",
            "limit order book simulation",
            "fill outcomes",
            "fill_outcomes",
            "adverse-selection",
            "adverse selection",
            "adverse_selection_stress",
        )
    ):
        overlay_ids.append("simulation_reality_gap_implementation_risk")
        overlay_contracts.append(
            {
                "overlay_id": "simulation_reality_gap_implementation_risk",
                "required_evidence": [
                    "simulation_live_parity_metrics",
                    "lob_event_stream",
                    "fill_outcomes",
                    "route_tca",
                    "live_paper_parity",
                    "adverse_selection_stress",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_simulation_reality_gap_stress"
                ),
                "evidence_policy": (
                    "synthetic_lob_fillability_requires_live_paper_parity"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_simulation_live_parity_metrics": True,
                "required_lob_event_stream": True,
                "required_fill_outcome_evidence": True,
                "required_replay_harness_implementation_trace": True,
                "required_min_simulation_parity_sample_count": "120",
                "required_max_simulation_live_fill_error_bps": "8",
                "required_max_adverse_selection_error_bps": "8",
            }
        )
        promotion_contract.update(
            {
                "requires_simulation_live_parity_metrics": True,
                "requires_lob_event_stream": True,
                "requires_fill_outcomes": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "requires_adverse_selection_stress": True,
                "requires_replay_harness_implementation_trace": True,
                "requires_implementation_uncertainty_stability": True,
                "rejects_synthetic_lob_fillability_as_capital_gate": True,
                "rejects_simulated_fillability_without_route_tca": True,
            }
        )

    if has_any(
        (
            "implementation risk",
            "implementation-risk",
            "engine sensitivity",
            "engine_sensitivity",
            "implementation uncertainty",
            "implementation_uncertainty_interval",
            "conclusion stability",
            "conclusion_stability",
            "divergence amplification",
            "divergence_amplification",
            "multi-engine replay",
            "multi_engine_replay",
            "backtest engine",
            "portfolio backtesting",
        )
    ):
        overlay_ids.append("implementation_risk_backtest_stability")
        overlay_contracts.append(
            {
                "overlay_id": "implementation_risk_backtest_stability",
                "required_evidence": [
                    "multi_engine_replay",
                    "engine_sensitivity",
                    "implementation_uncertainty_interval",
                    "conclusion_stability",
                    "transaction_cost_stress",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": "implementation_uncertainty_lower_net_pnl_per_day",
                "evidence_policy": (
                    "promotion_requires_stable_conclusion_across_replay_engines"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_multi_engine_replay": True,
                "required_min_implementation_uncertainty_model_count": "2",
                "required_implementation_uncertainty_lower_bound_above_target": True,
                "required_conclusion_stability_index": "1.00",
                "required_replay_harness_implementation_trace": True,
            }
        )
        promotion_contract.update(
            {
                "requires_implementation_uncertainty_stability": True,
                "requires_implementation_risk_backtest_stability": True,
                "requires_multi_engine_replay": True,
                "requires_engine_sensitivity_report": True,
                "requires_conclusion_stability": True,
                "rejects_single_engine_backtest_proof": True,
                "rejects_flat_cost_only_implementation_proof": True,
            }
        )

    if has_any(
        (
            "finrl-x",
            "finrl x",
            "deployment-consistent",
            "deployment consistent",
            "deployment consistency",
            "weight-centric",
            "weight centric",
            "broker execution",
            "broker-integrated execution",
            "backtesting and broker execution",
            "data processing, strategy construction, backtesting",
            "unified protocol",
            "downstream execution semantics",
            "replay paper live",
            "replay-paper-live",
            "signal payload parity",
            "signal_payload_parity",
            "order sizing parity",
            "order_sizing_parity",
            "route constraint parity",
            "route_constraint_parity",
            "broker_execution_semantics",
            "portfolio risk overlay parity",
            "portfolio_risk_overlay_parity",
        )
    ):
        overlay_ids.append("replay_paper_live_semantic_parity")
        overlay_contracts.append(
            {
                "overlay_id": "replay_paper_live_semantic_parity",
                "required_evidence": [
                    "signal_payload_parity",
                    "order_sizing_parity",
                    "route_constraint_parity",
                    "broker_execution_semantics",
                    "portfolio_weight_trace",
                    "portfolio_risk_overlay_parity",
                    "live_paper_parity",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": "post_cost_net_pnl_after_semantic_parity",
                "evidence_policy": (
                    "promotion_requires_same_replay_paper_live_execution_semantics"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_replay_paper_live_semantic_parity": True,
                "required_signal_payload_parity": True,
                "required_order_sizing_parity": True,
                "required_route_constraint_parity": True,
                "required_broker_execution_semantics_trace": True,
                "required_portfolio_risk_overlay_parity": True,
                "required_replay_harness_implementation_trace": True,
                "required_adapter_behavior_drift_count": "0",
            }
        )
        promotion_contract.update(
            {
                "requires_replay_paper_live_semantic_parity": True,
                "requires_signal_payload_parity": True,
                "requires_order_sizing_parity": True,
                "requires_route_constraint_parity": True,
                "requires_broker_execution_semantics": True,
                "requires_portfolio_risk_overlay_parity": True,
                "requires_live_paper_parity": True,
                "rejects_adapter_only_execution_behavior": True,
                "rejects_backtest_only_strategy_protocol": True,
            }
        )

    if has_any(
        (
            "intraday volume",
            "volume forecasting",
            "volume forecast",
            "vwap",
            "volume weighted average price",
            "volume-weighted average price",
            "u-shape",
            "u shaped",
            "u-shaped",
            "volume periodicity",
            "periodic volume",
            "morning afternoon volume",
            "execution schedule",
        )
    ):
        overlay_ids.append("intraday_volume_periodicity_execution")
        overlay_contracts.append(
            {
                "overlay_id": "intraday_volume_periodicity_execution",
                "required_evidence": [
                    "intraday_volume_forecast",
                    "clock_bucket_vwap_tracking_error",
                    "fillable_notional_by_clock_bucket",
                    "route_tca",
                ],
                "rank_metric": "post_cost_net_pnl_after_volume_periodicity_capacity",
                "evidence_policy": "capacity_must_follow_intraday_volume_profile",
            }
        )
        hard_vetoes.update(
            {
                "required_intraday_volume_forecast": True,
                "required_min_clock_bucket_capacity_sample_count": "60",
                "required_max_vwap_tracking_error_bps": "12",
                "required_min_volume_periodicity_capacity_ratio": "1.00",
            }
        )
        promotion_contract.update(
            {
                "requires_intraday_volume_forecast": True,
                "requires_clock_bucket_capacity": True,
                "requires_vwap_tracking_error": True,
                "requires_route_tca": True,
                "rejects_pooled_all_day_capacity_assumptions": True,
            }
        )

    if has_any(
        (
            "macro announcement",
            "macro_announcement",
            "macroeconomic announcement",
            "macroeconomic news",
            "macro news",
            "public information",
            "incremental information",
            "dvar",
            "difference in abnormal return variance",
            "event/non-event",
            "event non-event",
        )
    ):
        overlay_ids.append("macro_announcement_dvar_momentum")
        overlay_contracts.append(
            {
                "overlay_id": "macro_announcement_dvar_momentum",
                "required_evidence": [
                    "macro_announcement_calendar",
                    "dvar_incremental_information",
                    "event_non_event_holdout_replay",
                    "relative_volume",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_macro_event_holdout",
                "evidence_policy": "macro_momentum_requires_event_non_event_replay",
            }
        )
        hard_vetoes.update(
            {
                "required_macro_announcement_calendar": True,
                "required_dvar_incremental_information": True,
                "required_event_non_event_holdout_replay": True,
                "required_min_macro_event_window_count": "20",
                "required_min_macro_non_event_holdout_count": "60",
                "required_min_macro_event_split_pass_rate": "0.60",
                "required_max_macro_event_best_day_share": "0.25",
                "required_min_route_tca_sample_count": "60",
            }
        )
        promotion_contract.update(
            {
                "requires_macro_announcement_calendar": True,
                "requires_dvar_incremental_information": True,
                "requires_event_non_event_holdout_replay": True,
                "requires_relative_volume_confirmation": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "rejects_pooled_macro_and_non_macro_replay": True,
            }
        )

    if has_any(
        (
            "order-flow imbalance",
            "order flow imbalance",
            "order_flow_imbalance",
            "ofi",
            "ofi memory",
            "ofi_memory",
            "response-ratio",
            "response ratio",
            "lob response",
            "lob_response",
            "horizon-dependent",
            "horizon dependent",
        )
    ):
        overlay_ids.append("ofi_lob_continuation_response")
        overlay_contracts.append(
            {
                "overlay_id": "ofi_lob_continuation_response",
                "required_evidence": [
                    "order_flow_imbalance",
                    "microprice_bias",
                    "forecast_horizon",
                    "route_tca",
                    "walk_forward_replay",
                ],
                "rank_metric": "post_cost_net_pnl_after_ofi_response_horizon",
                "evidence_policy": "ofi_response_requires_executable_lob_or_quote_evidence",
            }
        )
        hard_vetoes.update(
            {
                "required_min_ofi_response_sample_count": "120",
                "required_min_ofi_response_stable_split_pass_rate": "0.60",
                "required_max_ofi_response_best_split_share": "0.35",
                "required_executable_quote_evidence": True,
            }
        )
        promotion_contract.update(
            {
                "requires_ofi_response_horizon_selection": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "rejects_ohlcv_only_ofi_proxies": True,
            }
        )

    if has_any(
        (
            "order-flow filtration",
            "order flow filtration",
            "structural filters",
            "structural filter",
            "parent orders",
            "parent order",
            "parent_order",
            "order lifetime",
            "order_lifetime",
            "modification count",
            "modification timing",
            "filtered obi",
            "filtered orderbook imbalance",
            "filtered_orderbook_imbalance",
            "transient orders",
        )
    ):
        overlay_ids.append("order_flow_filtration_parent_trade_obi")
        overlay_contracts.append(
            {
                "overlay_id": "order_flow_filtration_parent_trade_obi",
                "required_evidence": [
                    "parent_order_trade_linkage",
                    "order_lifetime_filter",
                    "order_modification_count",
                    "filtered_orderbook_imbalance",
                    "route_tca",
                    "walk_forward_replay",
                ],
                "rank_metric": "post_cost_net_pnl_after_filtered_parent_order_obi",
                "evidence_policy": (
                    "parent_trade_obi_requires_structural_order_filter_evidence"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_parent_order_trade_linkage": True,
                "required_min_filtered_obi_sample_count": "120",
                "required_min_filtered_obi_stable_split_pass_rate": "0.60",
                "required_max_filtered_obi_best_split_share": "0.35",
            }
        )
        promotion_contract.update(
            {
                "requires_parent_order_trade_linkage": True,
                "requires_structural_order_flow_filters": True,
                "requires_filtered_orderbook_imbalance_replay": True,
                "rejects_unfiltered_obi_only_promotion": True,
            }
        )

    if has_any(
        (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual training",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
            "veto calibration",
            "vetoes discard",
            "discard profitable",
        )
    ):
        overlay_ids.append("rejected_signal_outcome_calibration")
        overlay_contracts.append(
            {
                "overlay_id": "rejected_signal_outcome_calibration",
                "required_evidence": [
                    "rejected_signal_log",
                    "outcome_labels",
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_rejected_signal_replay",
                "evidence_policy": (
                    "rejected_events_require_labeled_counterfactual_outcomes"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_min_rejected_signal_outcome_label_count": "120",
                "required_min_rejected_signal_reason_coverage": "0.80",
                "required_max_rejected_signal_outcome_pending_ratio": "0.05",
                "required_rejected_signal_counterfactual_fields": [
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                ],
                "required_rejected_signal_outcome_persistence_state": "ok",
            }
        )
        promotion_contract.update(
            {
                "requires_rejected_signal_outcome_learning": True,
                "requires_rejected_signal_outcome_labels": True,
                "requires_rejected_signal_reason_coverage": True,
                "requires_rejected_signal_counterfactual_replay": True,
                "requires_counterfactual_executable_quote": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "rejects_pending_rejected_signal_outcome_labels": True,
                "rejects_unlabeled_reject_relaxation": True,
                "promotion_impact": "repair_only_until_labeled",
            }
        )

    if has_any(
        (
            "delay-adjusted depth",
            "delay adjusted depth",
            "execution delay",
            "execution_delay",
            "market depth",
            "market_depth",
            "depth state",
            "depth_state",
            "latency stress",
            "latency_stress",
            "fillable",
            "fillability",
            "limit_fill_probability",
        )
    ):
        overlay_ids.append("delay_adjusted_depth_stress")
        overlay_contracts.append(
            {
                "overlay_id": "delay_adjusted_depth_stress",
                "required_evidence": [
                    "depth_proxy",
                    "execution_delay",
                    "fill_model",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_delay_adjusted_depth_stress",
                "evidence_policy": "no_delay_fill_assumptions_are_not_promotion_proof",
            }
        )
        hard_vetoes.update(
            {
                "required_delay_adjusted_depth_stress": True,
                "required_max_route_latency_ms": "250",
                "required_min_delay_depth_sample_count": "60",
            }
        )
        promotion_contract.update(
            {
                "requires_delay_adjusted_depth_stress": True,
                "requires_execution_delay_replay": True,
                "requires_depth_proxy_fill_model": True,
                "requires_route_tca": True,
                "rejects_no_delay_fill_assumptions": True,
            }
        )

    if has_any(
        (
            "ohlcv-only",
            "ohlcv only",
            "ohlcv_derived",
            "ohlcv-derived",
            "bar-only",
            "bar only",
            "systematic falsification",
        )
    ):
        overlay_ids.append("ohlcv_only_falsification")
        overlay_contracts.append(
            {
                "overlay_id": "ohlcv_only_falsification",
                "required_evidence": [
                    "walk_forward_replay",
                    "executable_quote_evidence",
                    "route_tca",
                    "live_paper_parity",
                ],
                "evidence_policy": "ohlcv_only_is_falsification_not_promotion_proof",
            }
        )
        hard_vetoes.update(
            {
                "required_min_ohlcv_falsification_trade_count": "120",
                "required_min_ohlcv_walk_forward_split_count": "4",
                "required_min_ohlcv_stable_split_pass_rate": "0.60",
                "required_max_ohlcv_best_split_share": "0.35",
                "required_min_route_tca_sample_count": "60",
                "required_executable_quote_evidence": True,
            }
        )
        promotion_contract.update(
            {
                "rejects_ohlcv_only_promotion_evidence": True,
                "requires_walk_forward_replay": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "requires_minimum_trade_count": True,
                "requires_multi_year_stability_check": True,
                "rejects_naive_gross_ohlcv_backtests": True,
                "positive_control_policy": (
                    "gap_continuation_only_until_post_cost_live_paper_proof"
                ),
            }
        )

    if not overlay_ids:
        return {}
    parameter_space_payload = dict(parameter_space)
    parameter_space_payload["mechanism_overlay_ids"] = overlay_ids
    return {
        "feature_contract": {
            "mechanism_overlays": overlay_contracts,
        },
        "parameter_space": parameter_space_payload,
        "hard_vetoes": hard_vetoes,
        "promotion_contract": promotion_contract,
    }


def _apply_mechanism_overlay_strategy_params(
    strategy_overrides: Mapping[str, Any],
    mechanism_overlays: Mapping[str, Any],
) -> dict[str, Any]:
    overlay_ids = set(
        _string_sequence(
            _mapping(mechanism_overlays.get("parameter_space")).get(
                "mechanism_overlay_ids"
            )
        )
    )
    if not (
        {
            "mixed_market_limit_execution_policy",
            "crumbling_quote_liquidity_erosion",
            "latent_crumbling_quote_regime_grid",
            "friction_aware_regime_conditioned_policy",
            "multi_asset_cross_impact_execution_grid",
            "attention_factor_stat_arb_pairs_grid",
        }
        & overlay_ids
    ):
        return dict(strategy_overrides)
    next_overrides = dict(strategy_overrides)
    params = _mapping(next_overrides.get("params"))
    if "mixed_market_limit_execution_policy" in overlay_ids:
        params.setdefault("entry_order_type", "prefer_limit")
        params.setdefault("market_order_spread_bps_max", "6")
    if "crumbling_quote_liquidity_erosion" in overlay_ids:
        params.setdefault("entry_order_type", "prefer_limit")
        params.setdefault("market_order_spread_bps_max", "6")
        params.setdefault("max_recent_quote_invalid_ratio", "0.12")
        params.setdefault("max_recent_quote_jump_bps", "40")
    if "latent_crumbling_quote_regime_grid" in overlay_ids:
        params.setdefault(
            "microstructure_stress_veto_profile", "latent_crumbling_quote"
        )
        params.setdefault("crumbling_quote_live_authority", "disabled_candidate_only")
    if "friction_aware_regime_conditioned_policy" in overlay_ids:
        params.setdefault("cost_model_profile", "proportional_plus_impact")
        params.setdefault("turnover_budget_profile", "trade_space_trust_region")
        params.setdefault("regime_conditioning_profile", "volatility_liquidity")
    if "multi_asset_cross_impact_execution_grid" in overlay_ids:
        params.setdefault(
            "cross_impact_stress_profile", "multi_asset_matrix_resilience"
        )
        params.setdefault("cross_impact_search_scope", "pair_leg_execution_cost")
        params.setdefault("cross_hedge_live_authority", "disabled_candidate_only")
    if "attention_factor_stat_arb_pairs_grid" in overlay_ids:
        params.setdefault("stat_arb_factor_profile", "attention_factor_residual")
        params.setdefault("pair_selection_scope", "candidate_replay_only")
        params.setdefault("llm_pair_selection_authority", "disabled_candidate_only")
    next_overrides["params"] = params
    return next_overrides


def _family_scores_for_hypothesis(
    card: HypothesisCard,
) -> list[tuple[str, int, tuple[str, ...]]]:
    haystack = _hypothesis_haystack(card)
    scores = {family_template_id: 0 for family_template_id in _FAMILY_RUNTIME}
    reasons: dict[str, list[str]] = {
        family_template_id: [] for family_template_id in _FAMILY_RUNTIME
    }

    def bump(family_template_id: str, score: int, reason: str) -> None:
        scores[family_template_id] += score
        if reason not in reasons[family_template_id]:
            reasons[family_template_id].append(reason)

    def has_any(tokens: Sequence[str]) -> bool:
        return any(token in haystack for token in tokens)

    if has_any(
        (
            "scale-invariant",
            "normalization",
            "matched-filter",
            "matched_filter",
            "representation",
            "portable lob",
            "portable_lob",
            "feature stability",
            "feature_stability",
            "shap",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "representation_or_normalization",
        )
        bump("microbar_cross_sectional_pairs_v1", 2, "microstructure_representation")
    if has_any(
        (
            "kanformer",
            "queue-position",
            "queue position",
            "queue_position",
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
            "nonfill opportunity cost",
            "nonfill_opportunity_cost",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "queue_position_survival_fill_curve",
        )
        bump(
            "microbar_cross_sectional_pairs_v1", 3, "queue_position_survival_fill_curve"
        )

    if has_any(
        (
            "alpha decay",
            "alpha_decay",
            "predictability decay",
            "predictability_decay",
            "declined over time",
            "short-run market efficiency",
            "market efficiency",
            "t-kan",
            "tkan",
            "temporal kolmogorov",
            "tlob",
            "dual attention",
            "horizon bias",
            "spread-adjusted",
            "algorithmic activity",
            "tight spreads",
            "heavier trading",
            "high-volume regimes",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            5,
            "alpha_decay_predictability_stress",
        )
        bump("intraday_tsmom_v2", 3, "alpha_decay_predictability_stress")
        bump(
            "microbar_cross_sectional_pairs_v1",
            3,
            "alpha_decay_predictability_stress",
        )

    if has_any(
        (
            "crumbling quote",
            "crumbling quotes",
            "quote crumble",
            "quote erosion",
            "mechanical liquidity erosion",
            "mechanical liquidity withdrawal",
            "latent microstructure",
            "latent microstructure regime",
            "latent build-up",
            "latent_build_up",
            "early-warning",
            "early warning",
            "rising-edge",
            "rising edge",
            "adaptive threshold",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            7,
            "latent_crumbling_quote_regime",
        )
        bump("intraday_tsmom_v2", 3, "latent_crumbling_quote_regime")
        bump("microbar_cross_sectional_pairs_v1", 3, "latent_crumbling_quote_regime")

    if has_any(
        (
            "order flow",
            "order-flow",
            "order_flow",
            "trade-flow",
            "trade flow",
            "ofi",
            "imbalance",
            "lob",
            "limit order book",
            "signed order flow",
            "signed_order_flow",
            "core flow",
            "core_flow",
            "filtered orderbook imbalance",
            "filtered_orderbook_imbalance",
            "parent order",
            "parent_order",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "order_flow_or_lob_signal")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "order_flow_or_lob_signal",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            3,
            "order_flow_or_lob_signal",
        )
    if has_any(
        (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
            "veto calibration",
            "vetoes discard",
            "discard profitable",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "rejected_signal_outcome_calibration",
        )
        bump(
            "microbar_cross_sectional_pairs_v1",
            4,
            "rejected_signal_outcome_calibration",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            4,
            "rejected_signal_outcome_calibration",
        )
    if has_any(
        (
            "cluster",
            "clustered",
            "self-exciting",
            "hawkes",
            "order arrival",
            "arrival clustering",
        )
    ):
        bump("intraday_tsmom_v2", 5, "clustered_arrival_regime")
        bump(
            "microstructure_continuation_matched_filter_v1",
            3,
            "clustered_arrival_regime",
        )
        bump("microbar_cross_sectional_pairs_v1", 2, "clustered_arrival_regime")
    if has_any(
        (
            "cross-impact",
            "cross impact",
            "cross-effects",
            "cross effects",
            "cross-hedging",
            "cross hedging",
            "multi-asset optimal trade execution",
            "multi asset optimal trade execution",
            "matrix-valued price impact",
            "matrix valued price impact",
            "obizhaeva-wang",
        )
    ):
        bump(
            "microbar_cross_sectional_pairs_v1",
            8,
            "multi_asset_cross_impact_pairs_execution",
        )
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "multi_asset_cross_impact_pairs_execution",
        )
        bump(
            "intraday_tsmom_v2",
            2,
            "multi_asset_cross_impact_pairs_execution",
        )
    impact_ranking_only = has_any(
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
    )
    if has_any(
        (
            "liquidity",
            "execution",
            "shortfall",
            "spread",
            "market-maker",
            "market maker",
            "market impact",
            "market-impact",
            "power-law",
            "power law",
            "square-root",
            "square root",
            "nonlinear impact",
            "nonlinear_impact",
            "maker-taker",
            "maker taker",
        )
    ):
        if impact_ranking_only:
            bump(
                "microstructure_continuation_matched_filter_v1",
                6,
                "nonlinear_impact_route_tca_constraint",
            )
            bump(
                "microbar_cross_sectional_pairs_v1",
                3,
                "nonlinear_impact_route_tca_constraint",
            )
            bump(
                "intraday_tsmom_v2",
                2,
                "nonlinear_impact_route_tca_constraint",
            )
        else:
            bump(
                "mean_reversion_rebound_v1",
                4,
                "liquidity_response_or_execution_stress",
            )
            bump("washout_rebound_v2", 3, "liquidity_response_or_execution_stress")
            bump(
                "mean_reversion_exhaustion_short_v1",
                2,
                "liquidity_response_or_execution_stress",
            )
            bump(
                "microstructure_continuation_matched_filter_v1",
                3,
                "liquidity_response_or_execution_stress",
            )
    if has_any(
        (
            "volatility",
            "regime",
            "latent regime",
            "regime persistence",
            "stress window",
            "nearly unstable",
            "hidden markov",
            "hmm",
            "entropy",
            "fragility",
            "latent build-up",
            "latent_build_up",
            "rising-edge",
            "rising edge",
            "adaptive threshold",
            "forecast horizon",
            "forecast_horizon",
            "horizon-dependent",
            "horizon dependent",
            "regime-dependent",
            "regime dependent",
            "ofi memory",
            "ofi_memory",
            "response-ratio",
            "response ratio",
            "macro news",
            "macro-news",
            "macroeconomic news",
            "price-flow dynamics",
            "price flow dynamics",
            "flow impact",
            "flow_impact",
        )
    ):
        bump("intraday_tsmom_v2", 6, "volatility_or_regime_state")
        bump("momentum_pullback_v1", 2, "volatility_or_regime_state")
        bump("opening_drive_leader_reclaim_v1", 2, "volatility_or_regime_state")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "volatility_or_regime_state",
        )
    if has_any(
        (
            "adverse selection",
            "adverse-selection",
            "toxicity",
            "toxic",
            "absorption",
            "passive buy",
            "passive-buy",
            "fill-side",
            "fill side",
            "quote attribution",
            "quote-attribution",
            "information value",
            "price-flow covariance",
            "price flow covariance",
            "kyle",
            "lambda",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            5,
            "adverse_selection_or_liquidity_toxicity",
        )
        bump("mean_reversion_rebound_v1", 3, "adverse_selection_or_liquidity_toxicity")
        bump(
            "mean_reversion_exhaustion_short_v1",
            3,
            "adverse_selection_or_liquidity_toxicity",
        )
        bump(
            "microbar_cross_sectional_pairs_v1",
            2,
            "adverse_selection_or_liquidity_toxicity",
        )
    if has_any(
        (
            "factor dsl",
            "factor_dsl",
            "factor program",
            "factor_program",
            "append-only experiment trace",
            "append_only_experiment_trace",
            "hypothesis search",
            "constrained llm",
            "fixed splits",
            "fixed-split",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "constrained_factor_search")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "constrained_factor_search",
        )
        bump("intraday_tsmom_v2", 3, "constrained_factor_search")
    if has_any(
        (
            "attention factors",
            "attention factor",
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
            "hierarchical pair trading",
            "hierarchical pairs trading",
            "pair selector",
            "pair selection",
        )
    ):
        bump(
            "microbar_cross_sectional_pairs_v1",
            9,
            "attention_factor_stat_arb_pairs",
        )
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "attention_factor_stat_arb_pairs",
        )
        bump("intraday_tsmom_v2", 2, "attention_factor_stat_arb_pairs")
    if has_any(("momentum", "trend", "pullback", "trend persistence")):
        bump("momentum_pullback_v1", 5, "momentum_or_pullback")
        bump("intraday_tsmom_v2", 4, "momentum_or_pullback")
        bump("opening_drive_leader_reclaim_v1", 3, "momentum_or_pullback")
    if has_any(
        (
            "weighted microprice",
            "microprice momentum",
            "multi-window",
            "multi-level order book",
            "multi level order book",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "microprice_or_multi_level_order_book",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            3,
            "microprice_or_multi_level_order_book",
        )
        bump("breakout_reclaim_v2", 2, "microprice_or_multi_level_order_book")
    if has_any(
        (
            "late-day",
            "late day",
            "late-session",
            "late session",
            "final half-hour",
            "end-of-day",
            "end of day",
            "eod",
            "closing",
            "into the close",
            "macro announcement",
            "announcement",
            "portfolio adjustment",
            "vwap exit",
            "ladder exit",
        )
    ):
        bump("late_day_continuation_v1", 6, "late_session_or_announcement_momentum")
        bump("end_of_day_reversal_v1", 4, "late_session_or_announcement_momentum")
        bump("intraday_tsmom_v2", 2, "late_session_or_announcement_momentum")
        bump("momentum_pullback_v1", 2, "late_session_or_announcement_momentum")
    if has_any(
        (
            "final 30",
            "final half-hour",
            "end-of-day reversal",
            "end of day reversal",
            "eod reversal",
            "intraday loser",
            "intraday losers",
            "late-session loser",
            "late session loser",
            "closing-window",
            "closing window",
            "close reversion",
        )
    ):
        bump("end_of_day_reversal_v1", 7, "closing_window_reversal")
    if has_any(
        (
            "breakout",
            "continuation",
            "reclaim",
            "leader",
            "opening range breakout",
            "orb",
            "stocks in play",
            "overactive stocks",
        )
    ):
        bump("breakout_reclaim_v2", 5, "continuation_or_reclaim")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "continuation_or_reclaim",
        )
    if has_any(
        (
            "first half-hour",
            "first half hour",
            "first 30",
            "morning momentum",
            "opening drive",
            "opening-drive",
            "opening range",
            "opening-range",
            "opening range breakout",
            "opening window",
            "open window",
            "leader reclaim",
            "stocks in play",
            "unusually high daily volume",
            "macro announcement",
            "announcement",
            "information discreteness",
        )
    ):
        bump("opening_drive_leader_reclaim_v1", 7, "morning_or_announcement_momentum")
        bump("late_day_continuation_v1", 3, "morning_or_announcement_momentum")
        bump("intraday_tsmom_v2", 2, "morning_or_announcement_momentum")
    if has_any(("washout", "reversal", "rebound", "mean reversion", "dislocation")):
        bump("washout_rebound_v2", 5, "reversal_or_rebound")
        bump("mean_reversion_rebound_v1", 5, "reversal_or_rebound")
        bump("mean_reversion_exhaustion_short_v1", 3, "reversal_or_rebound")
        bump("end_of_day_reversal_v1", 4, "reversal_or_rebound")
    if has_any(
        (
            "short-side",
            "short side",
            "short sleeve",
            "short-selling",
            "short selling",
            "short fade",
            "fade",
            "exhaustion",
            "overbought",
            "offer pressure",
            "weakness",
            "downside",
            "upside extension",
        )
    ):
        bump("mean_reversion_exhaustion_short_v1", 7, "short_exhaustion_fade")
    if has_any(("relative_volume", "relative volume", "turnover")):
        bump("intraday_tsmom_v2", 2, "relative_volume_or_turnover")
        bump("breakout_reclaim_v2", 2, "relative_volume_or_turnover")
    if has_any(
        (
            "intraday volume",
            "volume forecasting",
            "volume forecast",
            "volume periodicity",
            "periodic volume",
            "vwap",
            "volume weighted average price",
            "volume-weighted average price",
            "u-shape",
            "u shaped",
            "u-shaped",
        )
    ):
        bump("opening_drive_leader_reclaim_v1", 10, "volume_periodicity_execution")
        bump("late_day_continuation_v1", 8, "volume_periodicity_execution")
        bump("intraday_tsmom_v2", 7, "volume_periodicity_execution")
        bump("breakout_reclaim_v2", 6, "volume_periodicity_execution")

    if not any(scores.values()):
        bump("microbar_cross_sectional_pairs_v1", 1, "default_executable_microbar")

    return sorted(
        (
            (family_template_id, score, tuple(reasons[family_template_id]))
            for family_template_id, score in scores.items()
            if score > 0
        ),
        key=lambda item: (-item[1], _FAMILY_TIEBREAK.get(item[0], 10**6), item[0]),
    )


def _families_for_hypothesis(
    card: HypothesisCard, *, target_net_pnl_per_day: Decimal = Decimal("300")
) -> tuple[tuple[str, int, tuple[str, ...]], ...]:
    scored = _family_scores_for_hypothesis(card)
    rejected_signal_rescue = _has_rejected_signal_outcome_calibration(card)
    if rejected_signal_rescue or _is_validation_or_execution_constraint_only(card):
        family_limit = _MAX_FAMILIES_PER_HYPOTHESIS
    else:
        family_limit = (
            _PORTFOLIO_SLEEVE_FAMILY_TARGET
            if target_net_pnl_per_day >= _PORTFOLIO_TARGET_NET_PNL_PER_DAY
            else _MAX_FAMILIES_PER_HYPOTHESIS
        )
    selected = list(scored[:family_limit])
    if family_limit <= _MAX_FAMILIES_PER_HYPOTHESIS:
        return tuple(selected)

    selected_family_ids = {family_template_id for family_template_id, _, _ in selected}
    for family_template_id in _PORTFOLIO_SLEEVE_FAMILY_ORDER:
        if len(selected) >= family_limit:
            break
        if family_template_id in selected_family_ids:
            continue
        selected.append(
            (
                family_template_id,
                0,
                ("portfolio_sleeve_diversification",),
            )
        )
        selected_family_ids.add(family_template_id)
    return tuple(selected)


@dataclass(frozen=True)
class CandidateSpec:
    schema_version: Literal["torghut.candidate-spec.v1"]
    candidate_spec_id: str
    hypothesis_id: str
    family_template_id: str
    candidate_kind: Literal[
        "family", "sleeve", "portfolio", "algorithm", "configuration"
    ]
    runtime_family: str
    runtime_strategy_name: str
    feature_contract: Mapping[str, Any]
    parameter_space: Mapping[str, Any]
    strategy_overrides: Mapping[str, Any]
    objective: Mapping[str, Any]
    hard_vetoes: Mapping[str, Any]
    expected_failure_modes: tuple[str, ...]
    promotion_contract: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "candidate_spec_id": self.candidate_spec_id,
            "hypothesis_id": self.hypothesis_id,
            "family_template_id": self.family_template_id,
            "candidate_kind": self.candidate_kind,
            "runtime_family": self.runtime_family,
            "runtime_strategy_name": self.runtime_strategy_name,
            "feature_contract": dict(self.feature_contract),
            "parameter_space": dict(self.parameter_space),
            "strategy_overrides": dict(self.strategy_overrides),
            "objective": dict(self.objective),
            "hard_vetoes": dict(self.hard_vetoes),
            "expected_failure_modes": list(self.expected_failure_modes),
            "promotion_contract": dict(self.promotion_contract),
            "candidate_authority": "discovery_probation_input_only",
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        }

    def to_vnext_experiment_payload(
        self, *, experiment_id: str | None = None
    ) -> dict[str, Any]:
        return {
            "experiment_id": experiment_id or f"{self.candidate_spec_id}-exp",
            "family_template_id": self.family_template_id,
            "hypothesis": self.feature_contract.get("mechanism"),
            "paper_claim_links": list(
                cast(Sequence[str], self.feature_contract.get("source_claim_ids") or [])
            ),
            "dataset_snapshot_policy": {
                "source": "historical_market_replay",
                "window_size": "PT1S",
            },
            "template_overrides": dict(self.strategy_overrides),
            "feature_variants": list(
                cast(
                    Sequence[str],
                    self.feature_contract.get("normalization_candidates") or [],
                )
            ),
            "veto_controller_variants": [],
            "selection_objectives": dict(self.objective),
            "hard_vetoes": dict(self.hard_vetoes),
            "expected_failure_modes": list(self.expected_failure_modes),
            "promotion_contract": dict(self.promotion_contract),
            "candidate_spec": self.to_payload(),
        }


def candidate_spec_id_for_payload(payload: Mapping[str, Any]) -> str:
    return f"spec-{_stable_hash(payload)[:24]}"


def compile_candidate_specs(
    *,
    hypothesis_cards: Sequence[HypothesisCard],
    target_net_pnl_per_day: Decimal = Decimal("300"),
    universe_symbols: Sequence[str] = (),
) -> list[CandidateSpec]:
    specs: list[CandidateSpec] = []
    explicit_universe_symbols = _universe_symbol_override(universe_symbols)
    for card in hypothesis_cards:
        include_false_negative_rescue = _has_rejected_signal_outcome_calibration(card)
        for family_rank, (
            family_template_id,
            family_score,
            family_reasons,
        ) in enumerate(
            _families_for_hypothesis(
                card, target_net_pnl_per_day=target_net_pnl_per_day
            ),
            start=1,
        ):
            runtime_family, runtime_strategy_name = _FAMILY_RUNTIME[family_template_id]
            for execution_profile_index in _execution_profile_indexes(
                card=card,
                family_template_id=family_template_id,
                family_rank=family_rank,
                target_net_pnl_per_day=target_net_pnl_per_day,
                include_false_negative_rescue=include_false_negative_rescue,
            ):
                execution_profile_id = _execution_profile_id(
                    family_template_id=family_template_id,
                    profile_index=execution_profile_index,
                )
                strategy_overrides = _strategy_overrides_for_profile(
                    family_template_id=family_template_id,
                    profile_index=execution_profile_index,
                    target_net_pnl_per_day=target_net_pnl_per_day,
                    include_false_negative_rescue=include_false_negative_rescue,
                )
                if explicit_universe_symbols:
                    strategy_overrides = {
                        **strategy_overrides,
                        "universe_symbols": list(explicit_universe_symbols),
                    }
                feature_contract: dict[str, Any] = {
                    "source_run_id": card.source_run_id,
                    "source_claim_ids": list(card.source_claim_ids),
                    "mechanism": card.mechanism,
                    "asset_scope": card.asset_scope,
                    "horizon_scope": card.horizon_scope,
                    "expected_direction": card.expected_direction,
                    "required_features": list(card.required_features),
                    "entry_motifs": list(card.entry_motifs),
                    "exit_motifs": list(card.exit_motifs),
                    "expected_regimes": list(card.expected_regimes),
                    "normalization_candidates": list(
                        _normalization_candidates_for_card(card)
                    ),
                    "family_selection": {
                        "rank": family_rank,
                        "score": family_score,
                        "reasons": list(family_reasons),
                    },
                    "execution_profile": {
                        "profile_id": execution_profile_id,
                        "profile_index": execution_profile_index,
                    },
                }
                claim_relation_blockers = _list_of_mappings(
                    card.implementation_constraints.get("claim_relation_blockers")
                )
                if claim_relation_blockers:
                    feature_contract["claim_relation_blockers"] = [
                        dict(item) for item in claim_relation_blockers
                    ]
                validation_requirements = _list_of_mappings(
                    card.implementation_constraints.get("validation_requirements")
                )
                if validation_requirements:
                    feature_contract["validation_requirements"] = [
                        dict(item) for item in validation_requirements
                    ]
                source_claims = _list_of_mappings(
                    card.implementation_constraints.get("source_claims")
                )
                if source_claims:
                    feature_contract["source_claims"] = [
                        dict(item) for item in source_claims
                    ]
                objective = {
                    "target_net_pnl_per_day": str(target_net_pnl_per_day),
                    "require_positive_day_ratio": "0.60",
                }
                hard_vetoes = {
                    "required_min_active_day_ratio": "0.90",
                    "required_min_daily_notional": "300000",
                    "required_max_best_day_share": "0.25",
                    "required_max_worst_day_loss": "350",
                    "required_max_drawdown": "900",
                    "required_min_regime_slice_pass_rate": "0.45",
                }
                parameter_space: dict[str, Any] = {
                    "mode": "bounded_grid",
                    "source": "whitepaper_autoresearch",
                    "family_selection_rank": family_rank,
                    "execution_profile_id": execution_profile_id,
                    "execution_profile_index": execution_profile_index,
                    "parameter_override_keys": sorted(
                        str(key)
                        for key in _mapping(strategy_overrides.get("params")).keys()
                    ),
                }
                promotion_contract: dict[str, Any] = {
                    "source": "whitepaper_autoresearch_profit_target",
                    "target_net_pnl_per_day": str(target_net_pnl_per_day),
                    "requires_scheduler_v3_parity_replay": True,
                    "requires_scheduler_v3_approval_replay": True,
                    "requires_shadow_validation": True,
                    "promotion_policy": "research_only",
                }
                if family_template_id == "microbar_cross_sectional_pairs_v1":
                    feature_contract["hpairs_microstructure_prefilter_contract"] = {
                        "schema_version": "torghut.hpairs-microstructure-prefilter-contract.v1",
                        "clusterlob_adapter": "consume_lob_or_microbar_order_flow_fields_only",
                        "fallback_policy": (
                            "deterministic_microbar_order_flow_fallback_with_explicit_blockers"
                        ),
                        "horizon_ofi_microbars": [3, 12, 36],
                        "macro_window_concentration_metadata": True,
                        "impact_capacity_lineage": (
                            "square_root_power_law_prefilter_only_requires_source_backed_adv"
                        ),
                        "ranking_authority": "candidate_discovery_prefilter_only",
                    }
                    feature_contract["hpairs_replay_tape_feature_contract"] = {
                        "schema_version": "torghut.hpairs-replay-tape-candidate-contract.v1",
                        "feature_schema_version": HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
                        "feature_schema_hash": build_hpairs_replay_tape_feature_schema_hash(),
                        "feature_versions": hpairs_replay_tape_feature_versions(),
                        "clusterlob_buckets": (
                            "deterministic_clustered_event_quote_behavior_metadata"
                        ),
                        "ofi_memory_regime_slices": [
                            "instant",
                            "short",
                            "medium",
                            "long",
                        ],
                        "ranking_authority": "candidate_discovery_prefilter_only",
                        "promotion_authority": False,
                        "runtime_ledger_authority": False,
                    }
                    parameter_space["hpairs_microstructure_prefilter"] = {
                        "enabled": True,
                        "bounded_frontier_handoff": True,
                        "proof_source": "prefilter_only",
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                    promotion_contract.update(
                        {
                            "hpairs_microstructure_prefilter_is_not_promotion_proof": True,
                            "hpairs_microstructure_prefilter_requires_exact_replay": True,
                            "hpairs_microstructure_prefilter_requires_runtime_ledger": True,
                        }
                    )
                if validation_requirements:
                    promotion_contract["validation_requirement_claim_ids"] = [
                        str(item.get("claim_id"))
                        for item in validation_requirements
                        if str(item.get("claim_id") or "").strip()
                    ]
                if _requires_synthetic_validation_only_policy(card):
                    promotion_contract.update(
                        {
                            "requires_historical_replay": True,
                            "requires_live_paper_parity": True,
                            "synthetic_evidence_policy": (
                                "validation_only_not_promotion_proof"
                            ),
                        }
                    )
                mechanism_overlays = _mechanism_overlays_for_card(card)
                strategy_overrides = _apply_mechanism_overlay_strategy_params(
                    strategy_overrides,
                    mechanism_overlays,
                )
                feature_contract.update(
                    _mapping(mechanism_overlays.get("feature_contract"))
                )
                parameter_space.update(
                    _mapping(mechanism_overlays.get("parameter_space"))
                )
                hard_vetoes.update(_mapping(mechanism_overlays.get("hard_vetoes")))
                promotion_contract.update(
                    _mapping(mechanism_overlays.get("promotion_contract"))
                )
                _apply_factor_acceptance_harness(
                    card=card,
                    feature_contract=feature_contract,
                    parameter_space=parameter_space,
                    strategy_overrides=strategy_overrides,
                    hard_vetoes=hard_vetoes,
                    promotion_contract=promotion_contract,
                )
                replay_guidance_profile = _string(
                    _mapping(strategy_overrides.get("params")).get(
                        "replay_ledger_guidance_profile"
                    )
                )
                if replay_guidance_profile:
                    parameter_space.update(
                        {
                            "replay_ledger_guided_candidate_expansion": True,
                            "replay_ledger_guidance_profile": replay_guidance_profile,
                        }
                    )
                    promotion_contract.update(
                        {
                            "requires_runtime_ledger_profit_proof": True,
                            "requires_source_backed_runtime_ledger": True,
                            "replay_ledger_guided_search_is_not_promotion_proof": True,
                        }
                    )
                base_payload = {
                    "hypothesis_id": card.hypothesis_id,
                    "family_template_id": family_template_id,
                    "feature_contract": feature_contract,
                    "parameter_space": parameter_space,
                    "strategy_overrides": strategy_overrides,
                    "objective": objective,
                }
                specs.append(
                    CandidateSpec(
                        schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
                        candidate_spec_id=candidate_spec_id_for_payload(base_payload),
                        hypothesis_id=card.hypothesis_id,
                        family_template_id=family_template_id,
                        candidate_kind="sleeve",
                        runtime_family=runtime_family,
                        runtime_strategy_name=runtime_strategy_name,
                        feature_contract=feature_contract,
                        parameter_space=parameter_space,
                        strategy_overrides=strategy_overrides,
                        objective=objective,
                        hard_vetoes=hard_vetoes,
                        expected_failure_modes=card.failure_modes,
                        promotion_contract=promotion_contract,
                    )
                )
    return specs


def candidate_spec_from_payload(payload: Mapping[str, Any]) -> CandidateSpec:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != CANDIDATE_SPEC_SCHEMA_VERSION:
        raise ValueError(f"candidate_spec_schema_invalid:{schema_version}")
    return CandidateSpec(
        schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
        candidate_spec_id=_string(payload.get("candidate_spec_id")),
        hypothesis_id=_string(payload.get("hypothesis_id")),
        family_template_id=_string(payload.get("family_template_id")),
        candidate_kind=cast(Any, _string(payload.get("candidate_kind")) or "sleeve"),
        runtime_family=_string(payload.get("runtime_family")),
        runtime_strategy_name=_string(payload.get("runtime_strategy_name")),
        feature_contract=_mapping(payload.get("feature_contract")),
        parameter_space=_mapping(payload.get("parameter_space")),
        strategy_overrides=_mapping(payload.get("strategy_overrides")),
        objective=_mapping(payload.get("objective")),
        hard_vetoes=_mapping(payload.get("hard_vetoes")),
        expected_failure_modes=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("expected_failure_modes") or [])
        ),
        promotion_contract=_mapping(payload.get("promotion_contract")),
    )


__all__ = [
    "annotations",
    "json",
    "dataclass",
    "Decimal",
    "Any",
    "Literal",
    "Mapping",
    "Sequence",
    "cast",
    "build_factor_acceptance_artifact",
    "HypothesisCard",
    "HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION",
    "build_hpairs_replay_tape_feature_schema_hash",
    "hpairs_replay_tape_feature_versions",
    "LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE",
    "RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE",
    "CANDIDATE_SPEC_SCHEMA_VERSION",
    "_FAMILY_RUNTIME",
    "_FAMILY_TIEBREAK",
    "_MAX_FAMILIES_PER_HYPOTHESIS",
    "_PORTFOLIO_TARGET_NET_PNL_PER_DAY",
    "_PORTFOLIO_SLEEVE_FAMILY_TARGET",
    "_PORTFOLIO_SLEEVE_FAMILY_ORDER",
    "_DEFAULT_PROFILE_COUNT",
    "_RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE",
    "_AI_ACCELERATOR_UNIVERSE_PROFILE",
    "_LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE",
    "_BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE",
    "_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE",
    "_PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE",
    "_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE",
    "_LARGE_CAP_UNIVERSE_PROFILES",
    "_BREAKOUT_UNIVERSE_PROFILES",
    "_REVERSAL_UNIVERSE_PROFILES",
    "_TSMOM_UNIVERSE_PROFILES",
    "_FAMILY_EXECUTION_PROFILES",
    "_BASE_FAMILY_EXECUTION_PROFILES",
    "_REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES",
    "_PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES",
    "_H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES",
    "_stable_hash",
    "_stable_int",
    "_string",
    "_mapping",
    "_string_sequence",
    "_format_profile_budget",
    "_profile_rank_count_floor",
    "_capital_limited_profile_values",
    "_decimal_profile_param",
    "_int_profile_param",
    "_clamped_profile_decimal",
    "_cash_constrain_profile",
    "_drop_fragile_prev_close_positive_gate",
    "_daily_coverage_feedback_escape_profile",
    "_consistency_guard_feedback_escape_profile",
    "_turnover_coverage_feedback_escape_profile",
    "_notional_throughput_feedback_escape_profile",
    "_adverse_selection_feedback_escape_profile",
    "_symbol_diversification_feedback_escape_profile",
    "_portfolio_feedback_escape_execution_profiles",
    "_capital_constrained_execution_profiles",
    "_universe_symbol_override",
    "_list_of_mappings",
    "_hypothesis_haystack",
    "_has_rejected_signal_outcome_calibration",
    "_normalization_candidates_for_card",
    "_requires_synthetic_validation_only_policy",
    "_is_validation_or_execution_constraint_only",
    "_paper_mechanism_haystack",
    "_requires_factor_acceptance_harness",
    "_factor_acceptance_dependencies",
    "_factor_acceptance_expression",
    "_apply_factor_acceptance_harness",
    "_mechanism_overlays_for_card",
    "_apply_mechanism_overlay_strategy_params",
    "_family_scores_for_hypothesis",
    "_families_for_hypothesis",
    "_execution_profile_index",
    "_execution_profile_indexes",
    "_execution_profile_id",
    "_execution_profiles_for_target",
    "_strategy_overrides_for_profile",
    "CandidateSpec",
    "candidate_spec_id_for_payload",
    "compile_candidate_specs",
    "candidate_spec_from_payload",
]
