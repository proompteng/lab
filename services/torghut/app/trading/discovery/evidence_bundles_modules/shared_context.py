# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast

# ruff: noqa: F401,F811,F821


EVIDENCE_BUNDLE_SCHEMA_VERSION = "torghut.candidate-evidence-bundle.v1"

VALID_COST_CALIBRATION_STATUSES = frozenset({"calibrated", "provisional"})

MARKET_IMPACT_STRESS_COST_BPS = Decimal("1")

DELAY_ADJUSTED_DEPTH_STRESS_MS = Decimal("50")

DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS = (
    Decimal("50"),
    Decimal("150"),
    Decimal("250"),
)

DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS = Decimal("1")

MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT = 20

REPLAY_ACTIVITY_SCORECARD_KEYS = (
    "decision_count",
    "trade_decision_count",
    "paper_decision_count",
    "runtime_decision_count",
    "orders_submitted_count",
    "submitted_order_count",
    "filled_count",
    "fill_count",
    "filled_order_count",
    "avg_filled_notional_per_day",
    "daily_filled_notional",
    "decision_count_by_order_type",
    "filled_count_by_order_type",
    "limit_fill_rate",
    "market_limit_order_mix_sample_count",
    "market_limit_order_mix_evidence_present",
    "market_limit_order_mix_passed",
    "limit_fill_probability_sample_count",
    "limit_fill_probability_evidence_present",
    "requires_market_limit_order_type_validation",
    "market_limit_order_type_validation_required",
    "order_type_ablation_required",
    "order_type_ablation_sample_count",
    "order_type_ablation_passed",
    "market_limit_execution_policy_passed",
    "order_type_ablation_selected_order_type",
    "order_type_opportunity_cost_bps",
    "order_type_opportunity_cost_evidence_present",
    "order_type_execution_source_markers",
    "route_tca_artifact_ref",
    "route_tca_artifact_refs",
    "route_tca_evidence_present",
    "order_type_execution_artifact_ref",
    "order_type_execution_artifact_refs",
    "order_type_ablation_artifact_ref",
    "order_type_ablation_artifact_refs",
    "execution_shortfall_evidence_present",
    "price_improvement_evidence_present",
    "opportunity_cost_evidence_present",
)

MARKET_IMPACT_SCORECARD_KEYS = (
    "market_impact_stress_passed",
    "market_impact_stress_artifact_ref",
    "market_impact_stress_model",
    "market_impact_stress_cost_bps",
    "market_impact_stress_net_pnl_per_day",
    "market_impact_stress_components",
    "nonlinear_market_impact_stress_passed",
    "nonlinear_market_impact_stress_model",
    "nonlinear_market_impact_stress_cost_bps",
    "nonlinear_market_impact_stress_net_pnl_per_day",
    "permanent_impact_decay_model",
    "implementation_uncertainty_required",
    "implementation_uncertainty_model",
    "implementation_uncertainty_model_count",
    "implementation_uncertainty_stability_passed",
    "implementation_uncertainty_lower_net_pnl_per_day",
    "implementation_uncertainty_upper_net_pnl_per_day",
    "implementation_uncertainty_interval_width_per_day",
    "implementation_uncertainty_target_net_pnl_per_day",
    "implementation_uncertainty_scenarios",
    "implementation_uncertainty_source_markers",
    "requires_implementation_risk_backtest_stability",
    "implementation_risk_backtest_stability_required",
    "requires_multi_engine_replay",
    "required_multi_engine_replay",
    "multi_engine_replay_passed",
    "multi_engine_replay_engine_count",
    "implementation_engine_count",
    "requires_engine_sensitivity_report",
    "engine_sensitivity_report_present",
    "engine_sensitivity_report_ref",
    "engine_sensitivity_artifact_ref",
    "requires_conclusion_stability",
    "conclusion_stability_passed",
    "conclusion_stability_index",
    "required_conclusion_stability_index",
    "conformal_tail_risk_required",
    "conformal_tail_risk_model",
    "conformal_tail_risk_alpha",
    "conformal_tail_risk_sample_count",
    "conformal_tail_risk_buffer_per_day",
    "conformal_tail_risk_adjusted_net_pnl_per_day",
    "conformal_tail_risk_target_net_pnl_per_day",
    "conformal_tail_risk_passed",
    "conformal_tail_risk_source_markers",
)

CONFORMAL_COST_BUFFER_SCORECARD_KEYS = (
    "requires_conformal_tail_risk",
    "required_conformal_tail_risk",
    "requires_conformal_var_cost_buffer",
    "required_regime_weighted_conformal_cost_buffer",
    "required_breakeven_transaction_cost_buffer",
    "required_seed_model_family_robustness",
    "required_min_conformal_tail_risk_sample_count",
    "breakeven_transaction_cost_buffer_passed",
    "breakeven_transaction_cost_buffer_bps",
    "transaction_cost_buffer_bps",
    "post_cost_net_pnl_after_breakeven_transaction_cost_buffer",
    "seed_robustness_passed",
    "seed_robustness_sample_count",
    "model_family_robustness_passed",
    "model_family_robustness_family_count",
)

DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS = (
    "delay_adjusted_depth_stress_passed",
    "delay_adjusted_depth_stress_model",
    "delay_adjusted_depth_stress_ms",
    "delay_adjusted_depth_latency_grid_ms",
    "delay_adjusted_depth_grid_max_stress_ms",
    "delay_adjusted_depth_liquidity_evidence_present",
    "delay_adjusted_depth_liquidity_missing_day_count",
    "delay_adjusted_depth_fillable_notional_per_day",
    "delay_adjusted_depth_worst_grid_fillable_notional_per_day",
    "delay_adjusted_depth_worst_active_day_fillable_notional",
    "delay_adjusted_depth_p10_active_day_fillable_notional",
    "delay_adjusted_depth_tail_coverage_passed",
    "delay_adjusted_depth_fillable_ratio",
    "delay_adjusted_depth_survival_adjusted_fillable_ratio",
    "delay_adjusted_depth_unfillable_notional_per_day",
    "delay_adjusted_depth_stress_net_pnl_per_day",
    "delay_adjusted_depth_fill_survival_evidence_present",
    "delay_adjusted_depth_fill_survival_sample_count",
    "delay_adjusted_depth_fill_survival_rate",
    "delay_adjusted_depth_queue_ratio_p95",
    "delay_adjusted_depth_queue_ahead_depletion_evidence_present",
    "delay_adjusted_depth_queue_ahead_depletion_sample_count",
    "queue_position_survival_fill_curve_evidence_present",
    "queue_position_survival_sample_count",
    "queue_position_survival_fill_rate",
    "queue_position_survival_queue_ratio_p95",
    "queue_position_survival_queue_ahead_depletion_evidence_present",
    "queue_position_survival_queue_ahead_depletion_sample_count",
    "queue_position_survival_adjusted_fillable_ratio",
    "queue_position_survival_nonfill_opportunity_cost_per_day",
    "queue_position_survival_nonfill_opportunity_cost_bps",
    "queue_position_survival_stress_net_pnl_per_day",
    "post_cost_net_pnl_after_queue_position_survival_fill_stress",
    "queue_position_survival_source_marker",
)

FILL_SURVIVAL_SCORECARD_KEYS = (
    "order_lifecycle",
    "fill_survival_evidence_present",
    "fill_survival_sample_count",
    "fill_survival_fill_rate",
    "fill_time_ms_avg",
    "fill_time_ms_p50",
    "fill_time_ms_p95",
    "pending_age_ms_p95",
    "max_censored_pending_age_ms",
    "spread_bps_avg_at_order",
    "spread_bps_p95_at_order",
    "depth_notional_min_at_order",
    "depth_notional_avg_at_order",
    "queue_touch_qty_avg",
    "queue_touch_notional_avg",
    "order_qty_to_touch_qty_ratio_p95",
    "queue_ahead_depletion_evidence_present",
    "queue_ahead_depletion_sample_count",
    "queue_ahead_depletion_rate",
    "queue_ahead_qty_p95",
    "queue_ahead_depleted_qty_p50",
    "queue_ahead_depleted_qty_p95",
    "queue_ahead_depletion_time_ms_p50",
    "queue_ahead_depletion_time_ms_p95",
    "fill_probability_by_latency_bucket",
    "fill_probability_by_latency_threshold_ms",
    "post_cost_survivorship",
    "post_cost_survival_rate",
    "gross_positive_killed_by_cost_count",
)

RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS = (
    "runtime_ledger_lineage_materialization_handoff",
)

BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS = (
    "requires_bootstrap_robust_optimization",
    "required_bootstrap_robust_optimization",
    "requires_bootstrap_confidence_intervals",
    "required_bootstrap_confidence_interval",
    "requires_utility_percentile_optimization",
    "required_utility_percentile_optimization",
    "requires_selection_bias_stress",
    "required_selection_bias_stress",
    "requires_parameter_instability_stress",
    "required_parameter_instability_stress",
    "requires_model_misspecification_stress",
    "required_model_misspecification_stress",
    "required_min_bootstrap_replicates",
    "bootstrap_robust_optimization_passed",
    "bootstrap_robust_optimization_artifact_ref",
    "bootstrap_robust_optimization_artifact_refs",
    "bootstrap_confidence_interval_passed",
    "bootstrap_replicate_count",
    "bootstrap_robust_optimization_replicate_count",
    "utility_percentile_optimization_passed",
    "bootstrap_percentile_robust_net_pnl_per_day",
    "selection_bias_stress_passed",
    "parameter_instability_stress_passed",
    "model_misspecification_stress_passed",
    "out_of_sample_generalization_passed",
    "bootstrap_robust_optimization_source_markers",
)

ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS = (
    "requires_adaptive_signal_falsification",
    "required_adaptive_signal_falsification",
    "requires_negative_control_falsification",
    "required_negative_control_falsification",
    "requires_label_permutation_test",
    "required_label_permutation_test",
    "requires_leakage_probe",
    "required_leakage_probe",
    "requires_effective_multiplicity_adjustment",
    "required_effective_multiplicity_adjustment",
    "rejects_adaptive_specification_search_as_profit_proof",
    "rejects_in_sample_factor_generation_without_falsification",
    "required_min_null_model_sample_count",
    "required_max_effective_multiplicity_adjusted_p_value",
    "adaptive_signal_falsification_passed",
    "adaptive_signal_falsification_artifact_ref",
    "adaptive_signal_falsification_artifact_refs",
    "negative_control_passed",
    "placebo_label_test_passed",
    "label_permutation_test_passed",
    "feature_permutation_stability_passed",
    "leakage_probe_passed",
    "walk_forward_falsification_passed",
    "null_model_sample_count",
    "effective_multiplicity_adjusted_p_value",
    "candidate_vs_null_return_delta",
    "candidate_vs_incumbent_return_delta",
    "adaptive_signal_falsification_source_markers",
)

OFI_RESPONSE_HORIZON_SCORECARD_KEYS = (
    "requires_ofi_response_horizon_selection",
    "required_ofi_response_horizon_selection",
    "required_min_ofi_response_sample_count",
    "required_min_ofi_response_stable_split_pass_rate",
    "required_max_ofi_response_best_split_share",
    "requires_executable_quote_evidence",
    "required_executable_quote_evidence",
    "rejects_ohlcv_only_ofi_proxies",
    "ofi_response_horizon_passed",
    "ofi_response_horizon_artifact_ref",
    "ofi_response_horizon_artifact_refs",
    "ofi_response_sample_count",
    "ofi_response_stable_split_pass_rate",
    "ofi_response_best_split_share",
    "executable_quote_evidence_present",
    "quote_evidence_present",
    "quote_evidence_sample_count",
    "post_cost_net_pnl_after_ofi_response_horizon",
    "ofi_response_horizon_source_markers",
)

ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS = (
    "requires_predictability_decay_stress",
    "required_predictability_decay_stress",
    "requires_horizon_decay_curve",
    "required_horizon_decay_curve",
    "requires_spread_adjusted_label_replay",
    "required_spread_adjusted_label_replay",
    "requires_tight_spread_and_high_volume_slices",
    "requires_model_latency_budget",
    "rejects_single_horizon_lob_alpha_promotion",
    "rejects_classification_accuracy_without_costs",
    "required_min_decay_stress_horizon_count",
    "required_min_tight_spread_regime_count",
    "required_min_high_volume_regime_count",
    "required_min_decay_stress_split_pass_rate",
    "required_max_decay_stress_best_split_share",
    "required_max_model_inference_latency_ms",
    "predictability_decay_stress_passed",
    "predictability_decay_stress_artifact_ref",
    "predictability_decay_stress_artifact_refs",
    "horizon_decay_curve_present",
    "predictability_horizon_decay_curve_present",
    "spread_adjusted_label_replay_passed",
    "spread_adjusted_label_evidence_present",
    "predictability_decay_stress_horizon_count",
    "tight_spread_regime_count",
    "high_volume_regime_count",
    "predictability_decay_stress_split_pass_rate",
    "predictability_decay_stress_best_split_share",
    "model_inference_latency_ms",
    "post_cost_net_pnl_after_predictability_decay_stress",
    "predictability_decay_stress_net_pnl_per_day",
    "alpha_decay_predictability_source_markers",
)

STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS = (
    "requires_stochastic_liquidity_resilience_execution_grid",
    "required_stochastic_liquidity_resilience_execution_grid",
    "requires_liquidity_regime_transition_trace",
    "required_liquidity_regime_transition_trace",
    "requires_stochastic_market_depth_state",
    "required_stochastic_market_depth_state",
    "requires_lob_shape_parameter_history",
    "required_lob_shape_parameter_history",
    "requires_depth_recovery_after_child_order",
    "required_depth_recovery_after_child_order",
    "requires_execution_shortfall_by_liquidity_regime",
    "required_execution_shortfall_by_liquidity_regime",
    "required_resilience_decay_half_life",
    "required_max_liquidity_regime_shortfall_bps",
    "rejects_modeled_liquidity_resilience_as_profit_proof",
    "rejects_synthetic_depth_recovery_as_fill_authority",
    "stochastic_liquidity_resilience_stress_passed",
    "stochastic_liquidity_resilience_stress_artifact_ref",
    "stochastic_liquidity_resilience_stress_artifact_refs",
    "liquidity_regime_transition_trace_present",
    "liquidity_regime_transition_count",
    "stochastic_market_depth_state_present",
    "stochastic_market_depth_state_count",
    "observed_depth_count",
    "lob_shape_parameter_history_present",
    "lob_shape_parameter_sample_count",
    "resilience_decay_half_life_present",
    "median_resilience_half_life_seconds",
    "depth_recovery_after_child_order_present",
    "depth_recovery_sample_count",
    "execution_shortfall_by_liquidity_regime_present",
    "execution_shortfall_by_liquidity_regime_sample_count",
    "observed_shortfall_count",
    "shortfall_by_liquidity_regime_bps",
    "post_cost_net_pnl_after_liquidity_regime_resilience_shortfall_stress",
    "liquidity_regime_resilience_shortfall_stress_net_pnl_per_day",
    "stochastic_liquidity_resilience_source_markers",
)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


def _int(value: Any) -> int:
    try:
        return int(float(str(value or 0)))
    except (TypeError, ValueError):
        return 0


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, Decimal):
        return value != 0
    if isinstance(value, (int, float)):
        return value != 0
    normalized = str(value).strip().lower()
    if normalized in {"", "0", "false", "f", "no", "n", "off", "none", "null"}:
        return False
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    return bool(value)


def _decimal_mapping_total(mapping: Mapping[str, Any]) -> Decimal:
    total = Decimal("0")
    for value in mapping.values():
        total += _decimal(value)
    return total


def _int_mapping(value: Any) -> dict[str, int]:
    if not isinstance(value, Mapping):
        return {}
    counts: dict[str, int] = {}
    for key, item in cast(Mapping[Any, Any], value).items():
        count = _int(item)
        normalized_key = _string(key).lower()
        if normalized_key:
            counts[normalized_key] = count
    return counts


def _frontier_replay_config(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(candidate.get("replay_config"))


def _frontier_replay_params(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(_frontier_replay_config(candidate).get("params"))


def _frontier_strategy_overrides(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(_frontier_replay_config(candidate).get("strategy_overrides"))


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    return [
        normalized
        for normalized in (_string(item) for item in cast(Sequence[Any], value))
        if normalized
    ]


def _order_type_execution_metrics(source: Mapping[str, Any]) -> dict[str, Any]:
    decision_counts = _int_mapping(source.get("decision_count_by_order_type"))
    filled_counts = _int_mapping(source.get("filled_count_by_order_type"))
    market_decision_count = max(0, decision_counts.get("market", 0))
    limit_decision_count = max(0, decision_counts.get("limit", 0))
    market_limit_sample_count = market_decision_count + limit_decision_count
    metrics: dict[str, Any] = {}
    if decision_counts:
        metrics["decision_count_by_order_type"] = decision_counts
    if filled_counts:
        metrics["filled_count_by_order_type"] = filled_counts
    if "limit_fill_rate" in source:
        metrics["limit_fill_rate"] = _string(source.get("limit_fill_rate") or "0")
    if market_limit_sample_count > 0:
        metrics["market_limit_order_mix_sample_count"] = market_limit_sample_count
        metrics["market_limit_order_mix_evidence_present"] = True
    if market_decision_count > 0 and limit_decision_count > 0:
        metrics["market_limit_order_mix_passed"] = True
    if limit_decision_count > 0:
        metrics["limit_fill_probability_sample_count"] = limit_decision_count
        metrics["limit_fill_probability_evidence_present"] = (
            "limit_fill_rate" in source or filled_counts.get("limit", 0) > 0
        )
    return metrics


def _order_lifecycle_metrics(source: Mapping[str, Any]) -> dict[str, Any]:
    lifecycle = _mapping(source.get("order_lifecycle"))
    if not lifecycle:
        return {}

    sample_count = max(
        _int(lifecycle.get("fill_survival_sample_count")),
        _int(lifecycle.get("submitted_order_count")),
    )
    if "fill_survival_evidence_present" in lifecycle:
        evidence_present = _bool(lifecycle.get("fill_survival_evidence_present"))
    else:
        evidence_present = sample_count > 0
    fill_rate = lifecycle.get("fill_survival_fill_rate") or lifecycle.get("fill_rate")
    queue_ahead_depletion_sample_count = max(
        _int(lifecycle.get("queue_ahead_depletion_sample_count")),
        _int(lifecycle.get("queue_depletion_sample_count")),
    )
    queue_ahead_depletion_evidence_present = _bool(
        lifecycle.get("queue_ahead_depletion_evidence_present")
    ) or (
        queue_ahead_depletion_sample_count > 0
        and (
            lifecycle.get("queue_ahead_depletion_rate") is not None
            or lifecycle.get("queue_ahead_depleted_qty_p50") is not None
            or lifecycle.get("queue_ahead_depletion_time_ms_p50") is not None
        )
    )

    metrics: dict[str, Any] = {
        "order_lifecycle": lifecycle,
        "fill_survival_evidence_present": evidence_present,
        "fill_survival_sample_count": sample_count,
        "queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_ahead_depletion_sample_count": queue_ahead_depletion_sample_count,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
    }
    if fill_rate is not None:
        metrics["fill_survival_fill_rate"] = _string(fill_rate)
        metrics["delay_adjusted_depth_fill_survival_rate"] = _string(fill_rate)
    if sample_count > 0:
        metrics["delay_adjusted_depth_fill_survival_sample_count"] = sample_count
        metrics["delay_adjusted_depth_fill_survival_evidence_present"] = (
            evidence_present
        )

    for key in (
        "fill_time_ms_avg",
        "fill_time_ms_p50",
        "fill_time_ms_p95",
        "pending_age_ms_p95",
        "max_censored_pending_age_ms",
        "spread_bps_avg_at_order",
        "spread_bps_p95_at_order",
        "depth_notional_min_at_order",
        "depth_notional_avg_at_order",
        "queue_touch_qty_avg",
        "queue_touch_notional_avg",
        "order_qty_to_touch_qty_ratio_p95",
        "queue_ahead_depletion_rate",
        "queue_ahead_qty_p95",
        "queue_ahead_depleted_qty_p50",
        "queue_ahead_depleted_qty_p95",
        "queue_ahead_depletion_time_ms_p50",
        "queue_ahead_depletion_time_ms_p95",
        "fill_probability_by_latency_bucket",
        "fill_probability_by_latency_threshold_ms",
        "post_cost_survivorship",
    ):
        if key in lifecycle:
            metrics[key] = lifecycle[key]

    queue_ratio_p95 = _string(lifecycle.get("order_qty_to_touch_qty_ratio_p95"))
    if queue_ratio_p95:
        metrics["delay_adjusted_depth_queue_ratio_p95"] = queue_ratio_p95

    survivorship = _mapping(lifecycle.get("post_cost_survivorship"))
    if survivorship:
        survival_rate = _string(survivorship.get("post_cost_survival_rate"))
        if survival_rate:
            metrics["post_cost_survival_rate"] = survival_rate
        metrics["gross_positive_killed_by_cost_count"] = _int(
            survivorship.get("gross_positive_killed_by_cost_count")
        )

    return metrics


def _order_type_ablation_metrics(source: Mapping[str, Any]) -> dict[str, Any]:
    raw_ablation = source.get("order_type_ablation")
    if not isinstance(raw_ablation, Mapping):
        return {}
    ablation = cast(Mapping[str, Any], raw_ablation)
    metrics: dict[str, Any] = {}
    artifact_ref = _string(
        ablation.get("artifact_ref") or ablation.get("order_type_ablation_artifact_ref")
    )
    if artifact_ref:
        metrics["order_type_ablation_artifact_ref"] = artifact_ref
    sample_count = _int(
        ablation.get("sample_count") or ablation.get("order_type_ablation_sample_count")
    )
    if sample_count > 0:
        metrics["order_type_ablation_sample_count"] = sample_count
        metrics["market_limit_order_mix_sample_count"] = sample_count
        metrics["market_limit_order_mix_evidence_present"] = True
    if "passed" in ablation:
        passed = bool(ablation.get("passed"))
        metrics["order_type_ablation_passed"] = passed
        metrics["market_limit_execution_policy_passed"] = passed
    selected_order_type = _string(
        ablation.get("selected_order_type")
        or ablation.get("order_type_ablation_selected_order_type")
    )
    if selected_order_type:
        metrics["order_type_ablation_selected_order_type"] = selected_order_type
    opportunity_cost_bps = _string(
        ablation.get("opportunity_cost_bps")
        or ablation.get("order_type_opportunity_cost_bps")
    )
    if opportunity_cost_bps:
        metrics["order_type_opportunity_cost_bps"] = opportunity_cost_bps
        metrics["order_type_opportunity_cost_evidence_present"] = True
        metrics["opportunity_cost_evidence_present"] = True
    limit_sample_count = _int(
        ablation.get("limit_sample_count")
        or ablation.get("limit_fill_probability_sample_count")
    )
    if limit_sample_count > 0:
        metrics["limit_fill_probability_sample_count"] = limit_sample_count
        metrics["limit_fill_probability_evidence_present"] = True
    return metrics


def _artifact_refs_from_scorecard(scorecard: Mapping[str, Any]) -> tuple[str, ...]:
    refs: list[str] = []
    for key in (
        "route_tca_artifact_ref",
        "order_type_execution_artifact_ref",
        "market_limit_order_mix_artifact_ref",
        "order_type_ablation_artifact_ref",
        "market_impact_stress_artifact_ref",
        "delay_adjusted_depth_stress_artifact_ref",
        "exact_replay_ledger_artifact_ref",
        "adaptive_signal_falsification_artifact_ref",
    ):
        ref = _string(scorecard.get(key))
        if ref:
            refs.append(ref)
    for key in (
        "route_tca_artifact_refs",
        "order_type_execution_artifact_refs",
        "market_limit_order_mix_artifact_refs",
        "order_type_ablation_artifact_refs",
        "exact_replay_ledger_artifact_refs",
        "adaptive_signal_falsification_artifact_refs",
    ):
        raw_refs = scorecard.get(key)
        if isinstance(raw_refs, str):
            ref = _string(raw_refs)
            if ref:
                refs.append(ref)
            continue
        for raw_ref in cast(Sequence[Any], raw_refs or ()):
            ref = _string(raw_ref)
            if ref:
                refs.append(ref)
    return tuple(dict.fromkeys(refs))


def _runtime_ledger_lineage_handoff(
    *,
    scorecard: Mapping[str, Any],
    promotion_readiness: Mapping[str, Any],
) -> dict[str, Any]:
    return _mapping(
        scorecard.get("runtime_ledger_lineage_materialization_handoff")
    ) or _mapping(
        promotion_readiness.get("runtime_ledger_lineage_materialization_handoff")
    )


# Public aliases used by split-module consumers.
bool_value = _bool

__all__ = (
    "EVIDENCE_BUNDLE_SCHEMA_VERSION",
    "VALID_COST_CALIBRATION_STATUSES",
    "MARKET_IMPACT_STRESS_COST_BPS",
    "DELAY_ADJUSTED_DEPTH_STRESS_MS",
    "DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS",
    "DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS",
    "MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT",
    "REPLAY_ACTIVITY_SCORECARD_KEYS",
    "MARKET_IMPACT_SCORECARD_KEYS",
    "CONFORMAL_COST_BUFFER_SCORECARD_KEYS",
    "DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS",
    "FILL_SURVIVAL_SCORECARD_KEYS",
    "RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS",
    "BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS",
    "ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS",
    "OFI_RESPONSE_HORIZON_SCORECARD_KEYS",
    "ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS",
    "STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS",
    "bool_value",
)

# Public aliases used by split modules.
artifact_refs_from_scorecard = _artifact_refs_from_scorecard
decimal = _decimal
decimal_mapping_total = _decimal_mapping_total
frontier_replay_config = _frontier_replay_config
frontier_replay_params = _frontier_replay_params
frontier_strategy_overrides = _frontier_strategy_overrides
int_value = _int
int_mapping = _int_mapping
mapping = _mapping
order_lifecycle_metrics = _order_lifecycle_metrics
order_type_ablation_metrics = _order_type_ablation_metrics
order_type_execution_metrics = _order_type_execution_metrics
runtime_ledger_lineage_handoff = _runtime_ledger_lineage_handoff
stable_hash = _stable_hash
string = _string
string_list = _string_list
