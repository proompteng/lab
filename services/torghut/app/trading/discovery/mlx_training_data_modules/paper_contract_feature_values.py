# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Training-row and ranker helpers for the MLX autoresearch proposal model."""

from __future__ import annotations

import hashlib
import importlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.capital_budget import estimate_capital_budget
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)

# ruff: noqa: F401,F811,F821

from .shared_context import (
    MLX_RANKER_SCHEMA_VERSION,
    MlxRankBucketLift,
    MlxRankedCandidate,
    MlxRankedRowsPolicyResult,
    MlxRankerModel,
    MlxTrainingRow,
    MECHANISM_OVERLAY_FEATURE_NAMES as _MECHANISM_OVERLAY_FEATURE_NAMES,
    MECHANISM_OVERLAY_IDS as _MECHANISM_OVERLAY_IDS,
    PAPER_CONTRACT_FEATURE_NAMES as _PAPER_CONTRACT_FEATURE_NAMES,
    TorchArrayBackend as _TorchArrayBackend,
    artifact_present as _artifact_present,
    average_claim_confidence as _average_claim_confidence,
    bool_feature as _bool_feature,
    claim_type_count as _claim_type_count,
    daily_target_shortfall as _daily_target_shortfall,
    float_value as _float,
    format_float as _format_float,
    hard_veto_count as _hard_veto_count,
    import_array_backend as _import_array_backend,
    import_torch_array_backend as _import_torch_array_backend,
    mapping as _mapping,
    mapping_sequence as _mapping_sequence,
    mean as _mean,
    mechanism_overlay_ids as _mechanism_overlay_ids,
    params as _params,
    positive_or_default as _positive_or_default,
    requirement_present as _requirement_present,
    sequence_length as _sequence_length,
    sequence_strings as _sequence_strings,
    stable_hash as _stable_hash,
    strategy_universe_size as _strategy_universe_size,
    strings as _strings,
    truthy_contract_key_count as _truthy_contract_key_count,
    truthy_feature as _truthy_feature,
    unique_string_count as _unique_string_count,
    unique_strings as _unique_strings,
)


def _paper_contract_feature_values(spec: CandidateSpec) -> Mapping[str, float]:
    source_claims = _mapping_sequence(spec.feature_contract.get("source_claims"))
    validation_requirements = _mapping_sequence(
        spec.feature_contract.get("validation_requirements")
    )
    mechanism_overlays = _mapping_sequence(
        spec.feature_contract.get("mechanism_overlays")
    )
    overlay_ids = _mechanism_overlay_ids(spec)
    contract_requirements = (
        _unique_strings(source_claims, "data_requirements")
        | _unique_strings(validation_requirements, "data_requirements")
        | _unique_strings(mechanism_overlays, "required_evidence")
    )
    mechanism_required_evidence_count = _unique_string_count(
        mechanism_overlays, "required_evidence"
    )
    feature_values = {
        "paper_source_claim_count": float(len(source_claims)),
        "paper_signal_claim_count": _claim_type_count(
            source_claims,
            {
                "feature_recipe",
                "signal_mechanism",
                "strategy_mechanism",
                "portfolio_construction",
            },
        ),
        "paper_execution_claim_count": _claim_type_count(
            source_claims, {"execution_assumption"}
        ),
        "paper_validation_claim_count": _claim_type_count(
            source_claims, {"validation_requirement"}
        ),
        "paper_risk_claim_count": _claim_type_count(
            source_claims, {"risk_constraint", "market_regime"}
        ),
        "paper_avg_claim_confidence": _average_claim_confidence(source_claims),
        "paper_source_data_requirement_count": _unique_string_count(
            source_claims, "data_requirements"
        ),
        "paper_validation_requirement_count": float(len(validation_requirements)),
        "paper_validation_data_requirement_count": _unique_string_count(
            validation_requirements, "data_requirements"
        ),
        "paper_mechanism_overlay_count": float(len(overlay_ids)),
        "paper_mechanism_required_evidence_count": mechanism_required_evidence_count,
        "paper_requires_route_tca": _requirement_present(
            contract_requirements, ("route_tca",)
        ),
        "paper_requires_live_paper_parity": _requirement_present(
            contract_requirements, ("live_paper_parity",)
        ),
        "paper_requires_lob_event_stream": _requirement_present(
            contract_requirements,
            ("lob_event_stream", "lob_events", "clustered_order_events"),
        ),
        "paper_requires_fill_outcomes": _requirement_present(
            contract_requirements,
            ("fill_outcomes", "order_lifecycle_fill_evidence"),
        ),
        "paper_requires_execution_shortfall": _requirement_present(
            contract_requirements, ("execution_shortfall",)
        ),
        "paper_requires_implementation_uncertainty": _requirement_present(
            contract_requirements,
            (
                "implementation_uncertainty_interval",
                "implementation_uncertainty_stability",
                "multi_engine_replay",
            ),
        ),
        "paper_requires_rejected_signal_labels": _requirement_present(
            contract_requirements,
            ("rejected_signal_log", "outcome_labels", "counterfactual_return"),
        ),
        "paper_requires_executable_quote": _requirement_present(
            contract_requirements,
            ("executable_quote", "executable_quote_evidence"),
        ),
        "paper_requires_conformal_tail_risk": _requirement_present(
            contract_requirements,
            (
                "conformal_tail_risk",
                "conformal_var",
                "conformal_risk_control",
                "regime_weighted_conformal_var",
            ),
        ),
        "paper_requires_regime_tail_exceedance": _requirement_present(
            contract_requirements,
            (
                "regime_tail_exceedance",
                "tail_exceedance",
                "regime_similarity_weights",
            ),
        ),
        "paper_requires_breakeven_cost_buffer": _requirement_present(
            contract_requirements,
            (
                "breakeven_transaction_cost_buffer",
                "breakeven_cost_buffer",
                "transaction_cost_buffer",
                "cost_buffer",
            ),
        ),
        "paper_requires_seed_model_family_robustness": _requirement_present(
            contract_requirements,
            (
                "seed_robustness",
                "multi_seed_replay",
                "model_family_robustness",
                "seed_model_family_robustness",
            ),
        ),
        "paper_requires_regime_conditioning": _requirement_present(
            contract_requirements,
            (
                "regime_state",
                "regime_conditioned_policy",
                "regime_conditioning",
                "volatility_liquidity_regime",
            ),
        ),
        "paper_requires_trade_space_trust_region": _requirement_present(
            contract_requirements,
            (
                "trade_space_trust_region",
                "inventory_flow_trust_region",
                "kl_trust_region",
            ),
        ),
        "paper_requires_turnover_budget": _requirement_present(
            contract_requirements,
            ("turnover_budget", "turnover_bounds", "inaction_bands"),
        ),
        "paper_requires_cost_misspecification_stress": _requirement_present(
            contract_requirements,
            (
                "cost_misspecification_stress",
                "cost_level_grid",
                "transaction_cost_stress",
            ),
        ),
        "paper_requires_liquidity_proxy_cost_calibration": _requirement_present(
            contract_requirements,
            (
                "liquidity_proxy_cost_calibration",
                "liquidity_proxy",
                "proportional_cost_model",
                "impact_cost_model",
            ),
        ),
        "paper_requires_scenario_level_inference": _requirement_present(
            contract_requirements,
            (
                "scenario_level_inference",
                "multiple_testing_correction",
                "bootstrap_confidence_interval",
            ),
        ),
        "paper_requires_adaptive_factor_screener": _requirement_present(
            contract_requirements,
            (
                "adaptive_factor_screener",
                "regime_adaptive_factor_ensemble",
                "factor_pool_expansion",
            ),
        ),
        "paper_requires_continuous_factor_mining": _requirement_present(
            contract_requirements,
            (
                "continuous_factor_mining",
                "factor_pool_expansion",
                "continuous_candidate_refresh",
            ),
        ),
        "paper_requires_risk_constrained_execution_loop": _requirement_present(
            contract_requirements,
            (
                "risk_constrained_execution",
                "adaptive_factor_to_execution_loop",
                "factor_to_execution_loop",
            ),
        ),
        "paper_requires_portfolio_replay": _requirement_present(
            contract_requirements,
            (
                "portfolio_replay",
                "portfolio_weight_trace",
                "eligible_optimization_strategy",
            ),
        ),
        "paper_requires_market_risk_var": _requirement_present(
            contract_requirements,
            (
                "market_risk_var",
                "portfolio_var",
                "var_forecast_error",
            ),
        ),
        "paper_requires_market_sensitivity_constraints": _requirement_present(
            contract_requirements,
            (
                "market_sensitivity_constraints",
                "market_sensitivities",
                "risk_limit_compliance",
            ),
        ),
        "paper_requires_capital_charge_stress": _requirement_present(
            contract_requirements,
            (
                "capital_charge_stress",
                "capital_charge",
                "economic_capital_stress",
            ),
        ),
        "paper_requires_risk_limit_compliance": _requirement_present(
            contract_requirements,
            (
                "risk_limit_compliance",
                "market_sensitivity_constraints",
                "capital_charge_stress",
            ),
        ),
        "paper_requires_factor_rank_panel": _requirement_present(
            contract_requirements,
            (
                "factor_rank_panel",
                "cross_sectional_ranks",
                "short_term_trading_factors",
            ),
        ),
        "paper_requires_train_holdout_split": _requirement_present(
            contract_requirements,
            (
                "train_holdout_split",
                "walk_forward_replay",
                "out_of_sample_generalization",
            ),
        ),
        "paper_requires_multiple_testing_controls": _requirement_present(
            contract_requirements,
            (
                "multiple_testing_controls",
                "multiple_testing_correction",
                "selection_bias_stress",
            ),
        ),
        "paper_requires_bootstrap_confidence_interval": _requirement_present(
            contract_requirements,
            (
                "bootstrap_confidence_interval",
                "bootstrap_confidence_intervals",
                "resampled_confidence_interval",
            ),
        ),
        "paper_requires_utility_percentile_optimization": _requirement_present(
            contract_requirements,
            (
                "utility_percentile",
                "percentile_based_optimization",
                "utility_percentile_optimization",
            ),
        ),
        "paper_requires_selection_bias_stress": _requirement_present(
            contract_requirements,
            (
                "selection_bias_stress",
                "selection_bias",
                "overfitting_stress",
            ),
        ),
        "paper_requires_parameter_instability_stress": _requirement_present(
            contract_requirements,
            (
                "parameter_instability_stress",
                "parameter_instability",
                "model_misspecification_stress",
            ),
        ),
        "paper_requires_crumbling_quote_probability": _requirement_present(
            contract_requirements,
            (
                "crumbling_quote_probability",
                "quote_crumble_probability",
                "crumbling_quote_calibration",
            ),
        ),
        "paper_requires_mechanical_liquidity_erosion": _requirement_present(
            contract_requirements,
            (
                "mechanical_liquidity_erosion",
                "mechanical_liquidity_withdrawal",
                "liquidity_withdrawal_probability",
            ),
        ),
        "paper_promotion_requires_count": _truthy_contract_key_count(
            spec.promotion_contract, "requires_"
        ),
        "paper_promotion_rejects_count": _truthy_contract_key_count(
            spec.promotion_contract, "rejects_"
        ),
    }
    for overlay_id, feature_name in zip(
        _MECHANISM_OVERLAY_IDS,
        _MECHANISM_OVERLAY_FEATURE_NAMES,
        strict=True,
    ):
        feature_values[feature_name] = 1.0 if overlay_id in overlay_ids else 0.0
    return feature_values


def _capital_rank_count_floor(
    *, strategy_overrides: Mapping[str, Any], params: Mapping[str, Any]
) -> int:
    for key in (
        "max_concurrent_positions",
        "max_pair_legs",
        "top_n",
        "rank_count",
    ):
        if _float(params.get(key)) > 0:
            return 1
    if _float(params.get("max_entries_per_session")) > 0:
        return 1
    return max(1, len(_sequence_strings(strategy_overrides.get("universe_symbols"))))


def candidate_spec_capital_features(spec: CandidateSpec) -> Mapping[str, float]:
    overrides = _mapping(spec.strategy_overrides)
    params = _mapping(overrides.get("params"))
    rank_count_floor = _capital_rank_count_floor(
        strategy_overrides=overrides,
        params=params,
    )
    features = estimate_capital_budget(
        strategy_overrides=overrides,
        params=params,
        rank_count_floor=rank_count_floor,
    ).to_feature_payload()
    features["max_entries_per_session"] = _positive_or_default(
        _float(params.get("max_entries_per_session")),
        1.0,
    )
    entry_notional_multiplier = _positive_or_default(
        _float(features.get("entry_notional_max_multiplier")),
        1.0,
    )
    features["inferred_universe_slot_floor"] = float(rank_count_floor)
    features["configured_daily_notional_capacity"] = (
        _float(features.get("max_notional_per_trade"))
        * features["max_entries_per_session"]
        * entry_notional_multiplier
        * float(rank_count_floor)
    )
    return features


def capital_budget_penalty(features: Mapping[str, float]) -> float:
    return (
        _float(features.get("capital_budget_overage_ratio")) * 125.0
        + max(0.0, _float(features.get("max_position_pct_equity")) - 1.0) * 35.0
        + max(0.0, _float(features.get("max_notional_pct_start_equity")) - 1.0) * 35.0
    )


def configured_daily_notional_capacity_penalty(
    *, configured_daily_notional_required_ratio: float
) -> float:
    if configured_daily_notional_required_ratio <= 0.0:
        return 750.0
    return max(0.0, 1.0 - configured_daily_notional_required_ratio) * 750.0


def observed_capital_penalty(scorecard: Mapping[str, Any]) -> float:
    return (
        max(0.0, _float(scorecard.get("max_gross_exposure_pct_equity")) - 1.0) * 500.0
        + max(0.0, -_float(scorecard.get("min_cash"))) / 100.0
        + _float(scorecard.get("negative_cash_observation_count")) * 20.0
    )


def _observed_replay_viability_penalty(
    scorecard: Mapping[str, Any],
    *,
    required_min_daily_notional: float,
    target_net_pnl_per_day: float,
) -> float:
    if not scorecard:
        return 0.0

    active_day_ratio = _float(scorecard.get("active_day_ratio"))
    positive_day_ratio = _float(scorecard.get("positive_day_ratio"))
    has_filled_notional = "avg_filled_notional_per_day" in scorecard
    avg_filled_notional_per_day = _float(scorecard.get("avg_filled_notional_per_day"))
    net_pnl_per_day = _float(scorecard.get("net_pnl_per_day"))
    no_activity_penalty = (
        500.0
        if active_day_ratio <= 0.0
        and has_filled_notional
        and avg_filled_notional_per_day <= 0.0
        else 0.0
    )
    notional_shortfall_ratio = 0.0
    if required_min_daily_notional > 0.0 and has_filled_notional:
        notional_shortfall_ratio = max(
            0.0,
            (required_min_daily_notional - avg_filled_notional_per_day)
            / required_min_daily_notional,
        )
    elif (
        active_day_ratio <= 0.0
        and has_filled_notional
        and avg_filled_notional_per_day <= 0.0
    ):
        notional_shortfall_ratio = 1.0

    return (
        no_activity_penalty
        + max(0.0, 1.0 - active_day_ratio) * 600.0
        + max(0.0, 1.0 - positive_day_ratio) * 450.0
        + notional_shortfall_ratio * 500.0
        + _float(scorecard.get("negative_day_count")) * 125.0
        + max(0.0, target_net_pnl_per_day - net_pnl_per_day) * 0.20
    )


def _net_pnl_per_100k_filled_notional(scorecard: Mapping[str, Any]) -> float:
    avg_filled_notional_per_day = _float(scorecard.get("avg_filled_notional_per_day"))
    if avg_filled_notional_per_day <= 0.0:
        return 0.0
    return (
        _float(scorecard.get("net_pnl_per_day"))
        / avg_filled_notional_per_day
        * 100_000.0
    )


def _post_cost_efficiency_penalty(scorecard: Mapping[str, Any]) -> float:
    if not scorecard:
        return 0.0
    avg_filled_notional_per_day = _float(scorecard.get("avg_filled_notional_per_day"))
    if avg_filled_notional_per_day <= 0.0:
        return 0.0
    net_pnl_per_day = _float(scorecard.get("net_pnl_per_day"))
    net_pnl_per_100k = _net_pnl_per_100k_filled_notional(scorecard)
    if net_pnl_per_day <= 0.0:
        return min(5_000.0, 250.0 + abs(net_pnl_per_100k) * 2.0)
    return max(0.0, 1.0 - net_pnl_per_100k) * 25.0


def _proof_target_shortfall(
    scorecard: Mapping[str, Any],
    *,
    target_net_pnl_per_day: float,
    keys: Sequence[str],
) -> float:
    observed = [_float(scorecard.get(key)) for key in keys if key in scorecard]
    if not observed:
        return target_net_pnl_per_day if scorecard else 0.0
    return max(0.0, target_net_pnl_per_day - min(observed))


def _deployable_lower_bound_net_pnl_per_day(scorecard: Mapping[str, Any]) -> float:
    value = deployable_lower_bound_net_pnl_per_day(scorecard)
    return float(value) if value is not None else 0.0


def _deployable_lower_bound_missing_count(scorecard: Mapping[str, Any]) -> float:
    return float(deployable_lower_bound_missing_count(scorecard))


def _deployable_lower_bound_failed_gate_count(scorecard: Mapping[str, Any]) -> float:
    return float(deployable_proof_failed_gate_count(scorecard))


def _deployable_lower_bound_target_shortfall(
    scorecard: Mapping[str, Any], *, target_net_pnl_per_day: float
) -> float:
    if not scorecard:
        return 0.0
    return max(
        0.0,
        target_net_pnl_per_day - _deployable_lower_bound_net_pnl_per_day(scorecard),
    )


def _deployable_lower_bound_proof_penalty(scorecard: Mapping[str, Any]) -> float:
    if not scorecard:
        return 0.0
    return (
        _deployable_lower_bound_missing_count(scorecard) * 1_000.0
        + _deployable_lower_bound_failed_gate_count(scorecard) * 1_000.0
    )


def _historical_proof_penalty(
    scorecard: Mapping[str, Any],
    *,
    target_net_pnl_per_day: float,
) -> float:
    if not scorecard:
        return 0.0

    market_impact_shortfall = _proof_target_shortfall(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        keys=("market_impact_stress_net_pnl_per_day",),
    )
    delay_depth_shortfall = _proof_target_shortfall(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        keys=("delay_adjusted_depth_stress_net_pnl_per_day",),
    )
    double_oos_shortfall = _proof_target_shortfall(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        keys=("double_oos_cost_shock_net_pnl_per_day", "double_oos_net_pnl_per_day"),
    )
    delay_fillable_notional = _float(
        scorecard.get("delay_adjusted_depth_fillable_notional_per_day")
    )

    return (
        (1.0 - _truthy_feature(scorecard.get("market_impact_stress_passed"))) * 500.0
        + (
            1.0
            - _artifact_present(
                scorecard,
                singular="market_impact_stress_artifact_ref",
                plural="market_impact_stress_artifact_refs",
            )
        )
        * 250.0
        + (
            1.0
            - _truthy_feature(scorecard.get("market_impact_liquidity_evidence_present"))
        )
        * 250.0
        + market_impact_shortfall * 0.15
        + (1.0 - _truthy_feature(scorecard.get("delay_adjusted_depth_stress_passed")))
        * 500.0
        + (
            1.0
            - _artifact_present(
                scorecard,
                singular="delay_adjusted_depth_stress_artifact_ref",
                plural="delay_adjusted_depth_stress_artifact_refs",
            )
        )
        * 250.0
        + (500.0 if delay_fillable_notional <= 0.0 else 0.0)
        + delay_depth_shortfall * 0.15
        + (1.0 - _truthy_feature(scorecard.get("double_oos_passed"))) * 500.0
        + (
            1.0
            - _artifact_present(
                scorecard,
                singular="double_oos_artifact_ref",
                plural="double_oos_artifact_refs",
            )
        )
        * 250.0
        + max(0.0, 2.0 - _float(scorecard.get("double_oos_independent_window_count")))
        * 250.0
        + max(0.0, 1.0 - _float(scorecard.get("double_oos_pass_rate"))) * 500.0
        + double_oos_shortfall * 0.15
    )


def _family_code(family_template_id: str) -> float:
    families = {
        "breakout_reclaim_v2": 1.0,
        "washout_rebound_v2": 2.0,
        "momentum_pullback_v1": 3.0,
        "mean_reversion_rebound_v1": 4.0,
        "microbar_cross_sectional_pairs_v1": 5.0,
        "microstructure_continuation_matched_filter_v1": 6.0,
        "opening_drive_leader_reclaim_v1": 7.0,
        "intraday_tsmom_v2": 8.0,
        "late_day_continuation_v1": 9.0,
        "end_of_day_reversal_v1": 10.0,
        "mean_reversion_exhaustion_short_v1": 11.0,
    }
    return families.get(family_template_id, 0.0)


def _std(values: Sequence[float], *, mean: float) -> float:
    if len(values) < 2:
        return 1.0
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    scale = variance**0.5
    return scale if scale > 1e-9 else 1.0


def _scalar_float(value: Any) -> float:
    item_method = getattr(value, "item", None)
    if callable(item_method):
        item_value = cast(Any, item_method())
        return float(item_value)
    return float(value)


# Public aliases used by split-module consumers.
capital_rank_count_floor = _capital_rank_count_floor
deployable_lower_bound_failed_gate_count = _deployable_lower_bound_failed_gate_count
deployable_lower_bound_proof_penalty = _deployable_lower_bound_proof_penalty
deployable_lower_bound_target_shortfall = _deployable_lower_bound_target_shortfall
family_code = _family_code
historical_proof_penalty = _historical_proof_penalty
net_pnl_per_100k_filled_notional = _net_pnl_per_100k_filled_notional
observed_replay_viability_penalty = _observed_replay_viability_penalty
paper_contract_feature_values = _paper_contract_feature_values
post_cost_efficiency_penalty = _post_cost_efficiency_penalty
proof_target_shortfall = _proof_target_shortfall
scalar_float = _scalar_float
std = _std
__all__ = [name for name in globals() if not name.startswith("__")]
