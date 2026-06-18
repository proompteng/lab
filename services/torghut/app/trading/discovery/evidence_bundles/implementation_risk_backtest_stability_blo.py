"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

from typing import Any, Mapping


from .shared_context import (
    MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT,
    bool_value as _bool,
    decimal as _decimal,
    int_value as _int,
    string as _string,
    string_list as _string_list,
)
from .evidence_bundle_from_frontier_candidate import (
    has_artifact_ref as _has_artifact_ref,
    implementation_risk_backtest_stability_required as _implementation_risk_backtest_stability_required,
)


def implementation_risk_backtest_stability_blockers(
    scorecard: Mapping[str, Any],
) -> list[str]:
    if not _implementation_risk_backtest_stability_required(scorecard):
        return []

    blockers: list[str] = []
    engine_count = max(
        _int(scorecard.get("multi_engine_replay_engine_count")),
        _int(scorecard.get("implementation_engine_count")),
    )
    if not _bool(scorecard.get("multi_engine_replay_passed")):
        blockers.append("multi_engine_replay_missing_or_failed")
    if engine_count < 2:
        blockers.append("multi_engine_replay_engine_count_below_min")
    if not (
        _bool(scorecard.get("engine_sensitivity_report_present"))
        or _string(scorecard.get("engine_sensitivity_report_ref"))
        or _string(scorecard.get("engine_sensitivity_artifact_ref"))
    ):
        blockers.append("engine_sensitivity_report_missing")
    required_index = _decimal(
        scorecard.get("required_conclusion_stability_index") or "1"
    )
    observed_index = _decimal(scorecard.get("conclusion_stability_index"))
    if not _bool(scorecard.get("conclusion_stability_passed")):
        blockers.append("conclusion_stability_missing_or_failed")
    if observed_index < required_index:
        blockers.append("conclusion_stability_index_below_min")
    return blockers


def bootstrap_robust_optimization_required(scorecard: Mapping[str, Any]) -> bool:
    if any(
        _bool(scorecard.get(key))
        for key in (
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
        )
    ):
        return True
    hard_vetoes = {veto.lower() for veto in _string_list(scorecard.get("hard_vetoes"))}
    if hard_vetoes.intersection(
        {
            "required_bootstrap_robust_optimization",
            "required_bootstrap_confidence_interval",
            "required_utility_percentile_optimization",
            "required_selection_bias_stress",
            "required_parameter_instability_stress",
            "required_model_misspecification_stress",
            "required_distribution_free_confidence_intervals",
        }
    ):
        return True
    return bool(
        {
            marker.lower()
            for marker in _string_list(
                scorecard.get("bootstrap_robust_optimization_source_markers")
            )
        }.intersection(
            {
                "bootstrap_robust_optimization_arxiv_2510_12725_2025",
                "spurious_predictability_arxiv_2604_15531_2026",
            }
        )
    )


def bootstrap_robust_optimization_blockers(
    scorecard: Mapping[str, Any],
) -> list[str]:
    if not bootstrap_robust_optimization_required(scorecard):
        return []

    blockers: list[str] = []
    if not _bool(scorecard.get("bootstrap_robust_optimization_passed")):
        blockers.append("bootstrap_robust_optimization_missing_or_failed")
    if not _has_artifact_ref(
        scorecard,
        "bootstrap_robust_optimization_artifact_ref",
        "bootstrap_robust_optimization_artifact_refs",
    ):
        blockers.append("bootstrap_robust_optimization_artifact_missing")
    required_replicates = max(
        1,
        _int(scorecard.get("required_min_bootstrap_replicates") or 500),
    )
    observed_replicates = max(
        _int(scorecard.get("bootstrap_replicate_count")),
        _int(scorecard.get("bootstrap_robust_optimization_replicate_count")),
    )
    if observed_replicates < required_replicates:
        blockers.append("bootstrap_replicate_count_below_min")
    if not _bool(scorecard.get("bootstrap_confidence_interval_passed")):
        blockers.append("bootstrap_confidence_interval_missing_or_failed")
    if not _bool(scorecard.get("utility_percentile_optimization_passed")):
        blockers.append("utility_percentile_optimization_missing_or_failed")
    if _decimal(scorecard.get("bootstrap_percentile_robust_net_pnl_per_day")) <= 0:
        blockers.append("bootstrap_percentile_robust_net_pnl_non_positive")
    if not _bool(scorecard.get("selection_bias_stress_passed")):
        blockers.append("selection_bias_stress_missing_or_failed")
    if not _bool(scorecard.get("parameter_instability_stress_passed")):
        blockers.append("parameter_instability_stress_missing_or_failed")
    if not _bool(scorecard.get("model_misspecification_stress_passed")):
        blockers.append("model_misspecification_stress_missing_or_failed")
    if not _bool(scorecard.get("out_of_sample_generalization_passed")):
        blockers.append("out_of_sample_generalization_missing_or_failed")
    return blockers


def adaptive_signal_falsification_required(scorecard: Mapping[str, Any]) -> bool:
    if any(
        _bool(scorecard.get(key))
        for key in (
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
        )
    ):
        return True
    hard_vetoes = {veto.lower() for veto in _string_list(scorecard.get("hard_vetoes"))}
    if hard_vetoes.intersection(
        {
            "required_adaptive_signal_falsification",
            "required_negative_control_falsification",
            "required_label_permutation_test",
            "required_leakage_probe",
            "required_effective_multiplicity_adjustment",
            "required_min_null_model_sample_count",
            "required_max_effective_multiplicity_adjusted_p_value",
        }
    ):
        return True
    source_markers = {
        marker.lower()
        for marker in (
            *_string_list(
                scorecard.get("adaptive_signal_falsification_source_markers")
            ),
            *_string_list(
                scorecard.get("bootstrap_robust_optimization_source_markers")
            ),
        )
    }
    return bool(
        source_markers.intersection(
            {
                "spurious_predictability_arxiv_2604_15531_2026",
                "adaptive_signal_discovery_agent_nvidia_2026",
            }
        )
    )


def scorecard_or_null_comparator_value(
    *,
    scorecard: Mapping[str, Any],
    null_comparator: Mapping[str, Any],
    key: str,
) -> Any:
    if key in scorecard:
        return scorecard.get(key)
    return null_comparator.get(key)


def adaptive_signal_falsification_blockers(
    *,
    scorecard: Mapping[str, Any],
    null_comparator: Mapping[str, Any],
) -> list[str]:
    if not adaptive_signal_falsification_required(scorecard):
        return []

    blockers: list[str] = []
    if not null_comparator:
        blockers.append("adaptive_signal_null_comparator_missing")
    if not _bool(scorecard.get("adaptive_signal_falsification_passed")):
        blockers.append("adaptive_signal_falsification_missing_or_failed")
    if not _has_artifact_ref(
        scorecard,
        "adaptive_signal_falsification_artifact_ref",
        "adaptive_signal_falsification_artifact_refs",
    ):
        blockers.append("adaptive_signal_falsification_artifact_missing")
    if not _bool(null_comparator.get("baseline_outperformed")):
        blockers.append("adaptive_signal_baseline_not_outperformed")

    raw_null_delta = scorecard_or_null_comparator_value(
        scorecard=scorecard,
        null_comparator=null_comparator,
        key="candidate_vs_null_return_delta",
    )
    if raw_null_delta is None:
        blockers.append("candidate_vs_null_return_delta_missing")
    elif _decimal(raw_null_delta) <= 0:
        blockers.append("candidate_vs_null_return_delta_non_positive")

    raw_incumbent_delta = scorecard_or_null_comparator_value(
        scorecard=scorecard,
        null_comparator=null_comparator,
        key="candidate_vs_incumbent_return_delta",
    )
    if raw_incumbent_delta is None:
        blockers.append("candidate_vs_incumbent_return_delta_missing")
    elif _decimal(raw_incumbent_delta) < 0:
        blockers.append("candidate_vs_incumbent_return_delta_negative")

    required_sample_count = max(
        1,
        _int(scorecard.get("required_min_null_model_sample_count") or 100),
    )
    if _int(scorecard.get("null_model_sample_count")) < required_sample_count:
        blockers.append("null_model_sample_count_below_min")

    raw_adjusted_p_value = scorecard.get("effective_multiplicity_adjusted_p_value")
    required_max_p_value = _decimal(
        scorecard.get("required_max_effective_multiplicity_adjusted_p_value") or "0.05"
    )
    if raw_adjusted_p_value is None:
        blockers.append("effective_multiplicity_adjusted_p_value_missing")
    elif _decimal(raw_adjusted_p_value) > required_max_p_value:
        blockers.append("effective_multiplicity_adjusted_p_value_above_max")

    if not _bool(scorecard.get("negative_control_passed")):
        blockers.append("negative_control_missing_or_failed")
    if not _bool(scorecard.get("placebo_label_test_passed")):
        blockers.append("placebo_label_test_missing_or_failed")
    if not _bool(scorecard.get("label_permutation_test_passed")):
        blockers.append("label_permutation_test_missing_or_failed")
    if not _bool(scorecard.get("feature_permutation_stability_passed")):
        blockers.append("feature_permutation_stability_missing_or_failed")
    if not _bool(scorecard.get("leakage_probe_passed")):
        blockers.append("leakage_probe_missing_or_failed")
    if not _bool(scorecard.get("walk_forward_falsification_passed")):
        blockers.append("walk_forward_falsification_missing_or_failed")
    return blockers


def ofi_response_horizon_required(scorecard: Mapping[str, Any]) -> bool:
    if any(
        _bool(scorecard.get(key))
        for key in (
            "requires_ofi_response_horizon_selection",
            "required_ofi_response_horizon_selection",
            "requires_executable_quote_evidence",
            "required_executable_quote_evidence",
            "rejects_ohlcv_only_ofi_proxies",
        )
    ):
        return True
    hard_vetoes = {veto.lower() for veto in _string_list(scorecard.get("hard_vetoes"))}
    if hard_vetoes.intersection(
        {
            "required_min_ofi_response_sample_count",
            "required_min_ofi_response_stable_split_pass_rate",
            "required_max_ofi_response_best_split_share",
            "required_executable_quote_evidence",
        }
    ):
        return True
    return bool(
        {
            marker.lower()
            for marker in _string_list(
                scorecard.get("ofi_response_horizon_source_markers")
            )
        }.intersection(
            {
                "ofi_response_horizon_arxiv_2505_17388_2025",
                "intraday_ofi_macro_news_arxiv_2508_06788_2025",
            }
        )
    )


def route_tca_present(scorecard: Mapping[str, Any]) -> bool:
    return (
        _bool(scorecard.get("route_tca_evidence_present"))
        or _string(scorecard.get("route_tca_artifact_ref")) != ""
        or bool(_string_list(scorecard.get("route_tca_artifact_refs")))
    )


def ofi_response_horizon_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    if not ofi_response_horizon_required(scorecard):
        return []

    blockers: list[str] = []
    if not _bool(scorecard.get("ofi_response_horizon_passed")):
        blockers.append("ofi_response_horizon_missing_or_failed")
    if not _has_artifact_ref(
        scorecard,
        "ofi_response_horizon_artifact_ref",
        "ofi_response_horizon_artifact_refs",
    ):
        blockers.append("ofi_response_horizon_artifact_missing")
    required_sample_count = max(
        1,
        _int(scorecard.get("required_min_ofi_response_sample_count") or 120),
    )
    if _int(scorecard.get("ofi_response_sample_count")) < required_sample_count:
        blockers.append("ofi_response_sample_count_below_min")
    required_split_rate = _decimal(
        scorecard.get("required_min_ofi_response_stable_split_pass_rate") or "0.60"
    )
    if (
        _decimal(scorecard.get("ofi_response_stable_split_pass_rate"))
        < required_split_rate
    ):
        blockers.append("ofi_response_stable_split_pass_rate_below_min")
    max_best_split_share = _decimal(
        scorecard.get("required_max_ofi_response_best_split_share") or "0.35"
    )
    raw_best_split_share = scorecard.get("ofi_response_best_split_share")
    if raw_best_split_share is None:
        blockers.append("ofi_response_best_split_share_missing")
    elif _decimal(raw_best_split_share) > max_best_split_share:
        blockers.append("ofi_response_best_split_share_above_max")
    quote_sample_count = _int(scorecard.get("quote_evidence_sample_count"))
    if not (
        _bool(scorecard.get("executable_quote_evidence_present"))
        or _bool(scorecard.get("quote_evidence_present"))
        or quote_sample_count > 0
    ):
        blockers.append("executable_quote_evidence_missing")
    if not route_tca_present(scorecard):
        blockers.append("ofi_route_tca_evidence_missing")
    if _decimal(scorecard.get("post_cost_net_pnl_after_ofi_response_horizon")) <= 0:
        blockers.append("ofi_response_horizon_net_pnl_non_positive")
    return blockers


def alpha_decay_predictability_required(scorecard: Mapping[str, Any]) -> bool:
    if any(
        _bool(scorecard.get(key))
        for key in (
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
        )
    ):
        return True
    hard_vetoes = {veto.lower() for veto in _string_list(scorecard.get("hard_vetoes"))}
    if hard_vetoes.intersection(
        {
            "required_predictability_decay_stress",
            "required_horizon_decay_curve",
            "required_spread_adjusted_label_replay",
            "required_min_decay_stress_horizon_count",
            "required_min_tight_spread_regime_count",
            "required_min_high_volume_regime_count",
            "required_min_decay_stress_split_pass_rate",
            "required_max_decay_stress_best_split_share",
            "required_max_model_inference_latency_ms",
        }
    ):
        return True
    return bool(
        {
            marker.lower()
            for marker in _string_list(
                scorecard.get("alpha_decay_predictability_source_markers")
            )
        }.intersection(
            {
                "alpha_decay_predictability_arxiv_2601_02310_2026",
                "short_run_market_efficiency_ssrn_6608199_2026",
            }
        )
    )


def alpha_decay_predictability_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    if not alpha_decay_predictability_required(scorecard):
        return []

    blockers: list[str] = []
    if not _bool(scorecard.get("predictability_decay_stress_passed")):
        blockers.append("predictability_decay_stress_missing_or_failed")
    if not _has_artifact_ref(
        scorecard,
        "predictability_decay_stress_artifact_ref",
        "predictability_decay_stress_artifact_refs",
    ):
        blockers.append("predictability_decay_stress_artifact_missing")
    if not (
        _bool(scorecard.get("horizon_decay_curve_present"))
        or _bool(scorecard.get("predictability_horizon_decay_curve_present"))
    ):
        blockers.append("horizon_decay_curve_missing")
    if not (
        _bool(scorecard.get("spread_adjusted_label_replay_passed"))
        or _bool(scorecard.get("spread_adjusted_label_evidence_present"))
    ):
        blockers.append("spread_adjusted_label_replay_missing_or_failed")
    required_horizon_count = max(
        1,
        _int(scorecard.get("required_min_decay_stress_horizon_count") or 3),
    )
    if (
        _int(scorecard.get("predictability_decay_stress_horizon_count"))
        < required_horizon_count
    ):
        blockers.append("predictability_decay_horizon_count_below_min")
    required_tight_spread_count = max(
        1,
        _int(scorecard.get("required_min_tight_spread_regime_count") or 20),
    )
    if _int(scorecard.get("tight_spread_regime_count")) < required_tight_spread_count:
        blockers.append("tight_spread_regime_count_below_min")
    required_high_volume_count = max(
        1,
        _int(scorecard.get("required_min_high_volume_regime_count") or 20),
    )
    if _int(scorecard.get("high_volume_regime_count")) < required_high_volume_count:
        blockers.append("high_volume_regime_count_below_min")
    required_split_rate = _decimal(
        scorecard.get("required_min_decay_stress_split_pass_rate") or "0.60"
    )
    if (
        _decimal(scorecard.get("predictability_decay_stress_split_pass_rate"))
        < required_split_rate
    ):
        blockers.append("predictability_decay_split_pass_rate_below_min")
    max_best_split_share = _decimal(
        scorecard.get("required_max_decay_stress_best_split_share") or "0.35"
    )
    raw_best_split_share = scorecard.get("predictability_decay_stress_best_split_share")
    if raw_best_split_share is None:
        blockers.append("predictability_decay_best_split_share_missing")
    elif _decimal(raw_best_split_share) > max_best_split_share:
        blockers.append("predictability_decay_best_split_share_above_max")
    raw_latency_ms = scorecard.get("model_inference_latency_ms")
    max_latency_ms = _decimal(
        scorecard.get("required_max_model_inference_latency_ms") or "200"
    )
    if raw_latency_ms is None:
        blockers.append("model_inference_latency_missing")
    elif _decimal(raw_latency_ms) > max_latency_ms:
        blockers.append("model_inference_latency_above_max")
    if not route_tca_present(scorecard):
        blockers.append("predictability_decay_route_tca_evidence_missing")
    if (
        _decimal(
            scorecard.get("post_cost_net_pnl_after_predictability_decay_stress")
            or scorecard.get("predictability_decay_stress_net_pnl_per_day")
        )
        <= 0
    ):
        blockers.append("predictability_decay_net_pnl_non_positive")
    return blockers


def stochastic_liquidity_resilience_required(scorecard: Mapping[str, Any]) -> bool:
    if any(
        _bool(scorecard.get(key))
        for key in (
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
            "rejects_modeled_liquidity_resilience_as_profit_proof",
            "rejects_synthetic_depth_recovery_as_fill_authority",
        )
    ):
        return True
    hard_vetoes = {veto.lower() for veto in _string_list(scorecard.get("hard_vetoes"))}
    if hard_vetoes.intersection(
        {
            "required_stochastic_liquidity_resilience_execution_grid",
            "required_liquidity_regime_transition_trace",
            "required_stochastic_market_depth_state",
            "required_lob_shape_parameter_history",
            "required_resilience_decay_half_life",
            "required_depth_recovery_after_child_order",
            "required_execution_shortfall_by_liquidity_regime",
            "required_max_liquidity_regime_shortfall_bps",
        }
    ):
        return True
    return bool(
        {
            marker.lower()
            for marker in _string_list(
                scorecard.get("stochastic_liquidity_resilience_source_markers")
            )
        }.intersection(
            {
                "optimal_execution_liquidity_uncertainty_arxiv_2506_11813_2025",
                "stochastic_market_depth_ssrn_3798235_2025",
            }
        )
    )


def stochastic_liquidity_resilience_blockers(
    scorecard: Mapping[str, Any],
) -> list[str]:
    if not stochastic_liquidity_resilience_required(scorecard):
        return []

    blockers: list[str] = []
    if not _bool(scorecard.get("stochastic_liquidity_resilience_stress_passed")):
        blockers.append("stochastic_liquidity_resilience_missing_or_failed")
    if not _has_artifact_ref(
        scorecard,
        "stochastic_liquidity_resilience_stress_artifact_ref",
        "stochastic_liquidity_resilience_stress_artifact_refs",
    ):
        blockers.append("stochastic_liquidity_resilience_artifact_missing")
    transition_count = _int(scorecard.get("liquidity_regime_transition_count"))
    if not (
        _bool(scorecard.get("liquidity_regime_transition_trace_present"))
        or transition_count > 0
    ):
        blockers.append("liquidity_regime_transition_trace_missing")
    market_depth_count = max(
        _int(scorecard.get("stochastic_market_depth_state_count")),
        _int(scorecard.get("observed_depth_count")),
    )
    if not (
        _bool(scorecard.get("stochastic_market_depth_state_present"))
        or market_depth_count > 0
    ):
        blockers.append("stochastic_market_depth_state_missing")
    lob_shape_count = _int(scorecard.get("lob_shape_parameter_sample_count"))
    if not (
        _bool(scorecard.get("lob_shape_parameter_history_present"))
        or lob_shape_count > 0
    ):
        blockers.append("lob_shape_parameter_history_missing")
    raw_resilience_half_life = scorecard.get("median_resilience_half_life_seconds")
    if not (
        _bool(scorecard.get("resilience_decay_half_life_present"))
        or _decimal(raw_resilience_half_life) > 0
    ):
        blockers.append("resilience_decay_half_life_missing")
    depth_recovery_sample_count = _int(scorecard.get("depth_recovery_sample_count"))
    if not (
        _bool(scorecard.get("depth_recovery_after_child_order_present"))
        or depth_recovery_sample_count > 0
    ):
        blockers.append("depth_recovery_after_child_order_missing")
    shortfall_sample_count = max(
        _int(scorecard.get("execution_shortfall_by_liquidity_regime_sample_count")),
        _int(scorecard.get("observed_shortfall_count")),
    )
    if not (
        _bool(scorecard.get("execution_shortfall_by_liquidity_regime_present"))
        or shortfall_sample_count > 0
    ):
        blockers.append("execution_shortfall_by_liquidity_regime_missing")
    required_max_shortfall_bps = _decimal(
        scorecard.get("required_max_liquidity_regime_shortfall_bps") or "10"
    )
    if (
        _decimal(scorecard.get("shortfall_by_liquidity_regime_bps"))
        > required_max_shortfall_bps
    ):
        blockers.append("liquidity_regime_shortfall_above_max")
    if not route_tca_present(scorecard):
        blockers.append("liquidity_resilience_route_tca_evidence_missing")
    if (
        _decimal(
            scorecard.get(
                "post_cost_net_pnl_after_liquidity_regime_resilience_shortfall_stress"
            )
            or scorecard.get(
                "liquidity_regime_resilience_shortfall_stress_net_pnl_per_day"
            )
        )
        <= 0
    ):
        blockers.append("liquidity_resilience_net_pnl_non_positive")
    return blockers


def conformal_tail_risk_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    requires_cost_buffer = any(
        _bool(scorecard.get(key))
        for key in (
            "requires_conformal_var_cost_buffer",
            "required_regime_weighted_conformal_cost_buffer",
            "required_breakeven_transaction_cost_buffer",
        )
    )
    requires_conformal_tail_risk = _bool(
        scorecard.get("conformal_tail_risk_required")
    ) or any(
        _bool(scorecard.get(key))
        for key in (
            "requires_conformal_tail_risk",
            "required_conformal_tail_risk",
        )
    )
    requires_conformal_tail_risk = requires_conformal_tail_risk or requires_cost_buffer
    if not requires_conformal_tail_risk:
        return []

    blockers: list[str] = []
    sample_count = _int(scorecard.get("conformal_tail_risk_sample_count"))
    min_sample_count = max(
        1,
        _int(scorecard.get("required_min_conformal_tail_risk_sample_count"))
        or (MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT if requires_cost_buffer else 1),
    )
    if not _bool(scorecard.get("conformal_tail_risk_passed")):
        blockers.append("conformal_tail_risk_failed")
    if sample_count <= 0:
        blockers.append("conformal_tail_risk_sample_count_zero")
    if sample_count < min_sample_count:
        blockers.append("conformal_tail_risk_sample_count_below_min")
    adjusted_net_pnl = _decimal(
        scorecard.get("conformal_tail_risk_adjusted_net_pnl_per_day")
    )
    if adjusted_net_pnl <= 0:
        blockers.append("conformal_tail_risk_adjusted_net_pnl_non_positive")
    target_net_pnl = _decimal(
        scorecard.get("conformal_tail_risk_target_net_pnl_per_day")
        or scorecard.get("target_net_pnl_per_day")
    )
    if (
        requires_cost_buffer
        and target_net_pnl > 0
        and adjusted_net_pnl < target_net_pnl
    ):
        blockers.append("conformal_tail_risk_adjusted_net_pnl_below_target")
    if requires_cost_buffer:
        if not _bool(scorecard.get("breakeven_transaction_cost_buffer_passed")):
            blockers.append("breakeven_transaction_cost_buffer_missing_or_failed")
        if (
            max(
                _decimal(scorecard.get("breakeven_transaction_cost_buffer_bps")),
                _decimal(scorecard.get("transaction_cost_buffer_bps")),
            )
            <= 0
        ):
            blockers.append("breakeven_transaction_cost_buffer_bps_missing")
        if (
            _decimal(
                scorecard.get(
                    "post_cost_net_pnl_after_breakeven_transaction_cost_buffer"
                )
            )
            <= 0
        ):
            blockers.append("breakeven_transaction_cost_buffer_net_pnl_non_positive")
    if _bool(scorecard.get("required_seed_model_family_robustness")):
        if not _bool(scorecard.get("seed_robustness_passed")):
            blockers.append("seed_robustness_missing_or_failed")
        if _int(scorecard.get("seed_robustness_sample_count")) <= 0:
            blockers.append("seed_robustness_sample_count_zero")
        if not _bool(scorecard.get("model_family_robustness_passed")):
            blockers.append("model_family_robustness_missing_or_failed")
        if _int(scorecard.get("model_family_robustness_family_count")) < 2:
            blockers.append("model_family_robustness_family_count_below_min")
    return blockers


__all__: tuple[str, ...] = ()
