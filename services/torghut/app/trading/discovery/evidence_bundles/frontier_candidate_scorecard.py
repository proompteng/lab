"""Scorecard assembly for frontier candidate evidence bundles."""

from __future__ import annotations

from typing import Any, Mapping, Sequence, cast

from . import runtime_ledger_lineage_handoff_blockers as _lineage
from . import shared_context as _shared

ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS = (
    _shared.ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS
)
ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS = (
    _shared.ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS
)
BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS = (
    _shared.BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS
)
CONFORMAL_COST_BUFFER_SCORECARD_KEYS = _shared.CONFORMAL_COST_BUFFER_SCORECARD_KEYS
DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS = _shared.DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS
FILL_SURVIVAL_SCORECARD_KEYS = _shared.FILL_SURVIVAL_SCORECARD_KEYS
MARKET_IMPACT_SCORECARD_KEYS = _shared.MARKET_IMPACT_SCORECARD_KEYS
OFI_RESPONSE_HORIZON_SCORECARD_KEYS = _shared.OFI_RESPONSE_HORIZON_SCORECARD_KEYS
REPLAY_ACTIVITY_SCORECARD_KEYS = _shared.REPLAY_ACTIVITY_SCORECARD_KEYS
RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS = (
    _shared.RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS
)
STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS = (
    _shared.STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS
)
_decomposition_activity_counts = _lineage.decomposition_activity_counts
_symbol_contribution_shares = _lineage.decomposition_symbol_contribution_shares
_enrich_replay_stress_metrics = _lineage.enrich_scorecard_with_replay_stress_metrics
_scorecard_with_freshness_lineage = _lineage.scorecard_with_freshness_lineage
_frontier_replay_params = _shared.frontier_replay_params
_frontier_strategy_overrides = _shared.frontier_strategy_overrides
_mapping = _shared.mapping
_order_lifecycle_metrics = _shared.order_lifecycle_metrics
_order_type_ablation_metrics = _shared.order_type_ablation_metrics
_order_type_execution_metrics = _shared.order_type_execution_metrics
_string = _shared.string
_string_list = _shared.string_list

_PROMOTION_CONTRACT_SCORECARD_KEYS = (
    *BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS,
    *ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS,
    *OFI_RESPONSE_HORIZON_SCORECARD_KEYS,
    *ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS,
    *STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS,
    *CONFORMAL_COST_BUFFER_SCORECARD_KEYS,
)

_SCORECARD_SOURCE_KEY_GROUPS = (
    REPLAY_ACTIVITY_SCORECARD_KEYS,
    MARKET_IMPACT_SCORECARD_KEYS,
    CONFORMAL_COST_BUFFER_SCORECARD_KEYS,
    (*DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS, *FILL_SURVIVAL_SCORECARD_KEYS),
    RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS,
    BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS,
    ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS,
    OFI_RESPONSE_HORIZON_SCORECARD_KEYS,
    ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS,
    STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS,
)

_ORDER_TYPE_ABLATION_OVERRIDE_KEYS = {
    "order_type_ablation_artifact_ref",
    "order_type_ablation_sample_count",
    "order_type_ablation_passed",
    "order_type_ablation_selected_order_type",
    "order_type_opportunity_cost_bps",
    "order_type_opportunity_cost_evidence_present",
    "opportunity_cost_evidence_present",
    "limit_fill_probability_sample_count",
    "limit_fill_probability_evidence_present",
}

_RUNTIME_IDENTITY_KEYS = (
    "family_template_id",
    "runtime_family",
    "runtime_strategy_name",
    "execution_signature",
    "execution_profile_id",
    "execution_profile_index",
    "feedback_risk_profile_key",
    "feedback_shape_key",
    "universe_key",
    "signal_key",
)


def frontier_candidate_scorecard(
    *,
    candidate: Mapping[str, Any],
    result_path: str,
) -> dict[str, Any]:
    """Build the objective scorecard carried by a candidate evidence bundle."""

    full_window = _mapping(candidate.get("full_window"))
    summary = _mapping(candidate.get("summary"))
    sources = (candidate, summary, full_window)
    scorecard = _base_scorecard(candidate=candidate, full_window=full_window)
    _adaptive_stress, adaptive_patch = _adaptive_signal_falsification_context(candidate)
    _merge_scorecard_patch(
        scorecard,
        adaptive_patch,
        ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS,
    )
    _merge_candidate_source_key_groups(scorecard, sources)
    _merge_order_execution_metrics(scorecard, sources, result_path=result_path)
    _merge_decomposition_metrics(scorecard, candidate=candidate)
    _merge_full_window_series(scorecard, full_window=full_window)
    _merge_hard_vetoes(scorecard, candidate=candidate)
    _merge_promotion_contract_fields(scorecard, candidate=candidate)
    _merge_frontier_runtime_config(scorecard, candidate=candidate)
    _merge_runtime_identity(scorecard, candidate=candidate)
    _merge_replay_lineage(scorecard, candidate=candidate)
    scorecard = _enrich_replay_stress_metrics(
        scorecard=scorecard,
        full_window=full_window,
        result_path=result_path,
    )
    return _scorecard_with_freshness_lineage(
        scorecard=scorecard,
        candidate=candidate,
    )


def frontier_candidate_adaptive_signal_falsification_stress(
    candidate: Mapping[str, Any],
) -> dict[str, Any]:
    stress, _patch = _adaptive_signal_falsification_context(candidate)
    return stress


def frontier_candidate_stress_metrics(
    *,
    candidate: Mapping[str, Any],
    scorecard: Mapping[str, Any],
) -> tuple[Mapping[str, Any], ...]:
    stress_metrics = tuple(
        cast(Sequence[Mapping[str, Any]], candidate.get("stress_metrics") or ())
    )
    if stress_metrics:
        return stress_metrics
    return _default_frontier_replay_stress_metrics(scorecard)


def frontier_candidate_null_comparator(
    *,
    candidate: Mapping[str, Any],
    scorecard: Mapping[str, Any],
    adaptive_signal_falsification_stress: Mapping[str, Any],
) -> dict[str, Any]:
    return (
        _mapping(candidate.get("null_comparator"))
        or _mapping(adaptive_signal_falsification_stress.get("null_comparator_patch"))
        or {
            "baseline_outperformed": bool(
                float(str(scorecard.get("net_pnl_per_day") or 0)) > 0
            )
        }
    )


def _base_scorecard(
    *,
    candidate: Mapping[str, Any],
    full_window: Mapping[str, Any],
) -> dict[str, Any]:
    scorecard = _mapping(candidate.get("objective_scorecard"))
    if scorecard:
        return scorecard
    return {
        "net_pnl_per_day": _string(full_window.get("net_per_day")),
        "active_day_ratio": _string(full_window.get("active_day_ratio")),
        "positive_day_ratio": _string(full_window.get("positive_day_ratio")),
        "best_day_share": _string(full_window.get("best_day_share")),
        "max_drawdown": _string(full_window.get("max_drawdown")),
    }


def _adaptive_signal_falsification_context(
    candidate: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    stress = _mapping(
        candidate.get("fast_replay_adaptive_signal_falsification_stress")
        or candidate.get("adaptive_signal_falsification_stress")
    )
    patch = _mapping(
        candidate.get(
            "fast_replay_adaptive_signal_falsification_objective_scorecard_patch"
        )
        or stress.get("objective_scorecard_patch")
    )
    return stress, patch


def _merge_scorecard_patch(
    scorecard: dict[str, Any],
    patch: Mapping[str, Any],
    keys: Sequence[str],
) -> None:
    for key in keys:
        if key in patch:
            scorecard[key] = patch[key]


def _merge_candidate_source_key_groups(
    scorecard: dict[str, Any],
    sources: Sequence[Mapping[str, Any]],
) -> None:
    for keys in _SCORECARD_SOURCE_KEY_GROUPS:
        _merge_missing_source_values(scorecard, sources, keys)


def _merge_missing_source_values(
    scorecard: dict[str, Any],
    sources: Sequence[Mapping[str, Any]],
    keys: Sequence[str],
) -> None:
    for key in keys:
        if key in scorecard:
            continue
        for source in sources:
            if key in source:
                scorecard[key] = source[key]
                break


def _merge_order_execution_metrics(
    scorecard: dict[str, Any],
    sources: Sequence[Mapping[str, Any]],
    *,
    result_path: str,
) -> None:
    for source in sources:
        _merge_missing_metrics(scorecard, _order_type_execution_metrics(source))
        _merge_missing_metrics(scorecard, _order_lifecycle_metrics(source))
        _merge_order_type_ablation_metrics(scorecard, source)
    if scorecard.get("market_limit_order_mix_evidence_present"):
        scorecard.setdefault("order_type_execution_artifact_ref", result_path)
        scorecard.setdefault("market_limit_order_mix_artifact_ref", result_path)


def _merge_missing_metrics(
    scorecard: dict[str, Any],
    metrics: Mapping[str, Any],
) -> None:
    for key, value in metrics.items():
        scorecard.setdefault(key, value)


def _merge_order_type_ablation_metrics(
    scorecard: dict[str, Any],
    source: Mapping[str, Any],
) -> None:
    for key, value in _order_type_ablation_metrics(source).items():
        if key not in scorecard or key in _ORDER_TYPE_ABLATION_OVERRIDE_KEYS:
            scorecard[key] = value


def _merge_decomposition_metrics(
    scorecard: dict[str, Any],
    *,
    candidate: Mapping[str, Any],
) -> None:
    _merge_missing_metrics(scorecard, _decomposition_activity_counts(candidate))
    if "symbol_contribution_shares" in scorecard or "symbol" in scorecard:
        return
    symbol_shares = _symbol_contribution_shares(candidate)
    if symbol_shares:
        scorecard["symbol_contribution_shares"] = symbol_shares


def _merge_full_window_series(
    scorecard: dict[str, Any],
    *,
    full_window: Mapping[str, Any],
) -> None:
    for key in ("daily_net", "daily_filled_notional"):
        value = _mapping(full_window.get(key))
        if value and key not in scorecard:
            scorecard[key] = value
    if "trading_day_count" in full_window and "trading_day_count" not in scorecard:
        scorecard["trading_day_count"] = full_window["trading_day_count"]


def _merge_hard_vetoes(
    scorecard: dict[str, Any],
    *,
    candidate: Mapping[str, Any],
) -> None:
    hard_vetoes = _candidate_hard_vetoes(candidate.get("hard_vetoes"))
    if hard_vetoes and "hard_vetoes" not in scorecard:
        scorecard["hard_vetoes"] = list(hard_vetoes)


def _candidate_hard_vetoes(raw_hard_vetoes: object) -> tuple[str, ...]:
    if isinstance(raw_hard_vetoes, str):
        raw_values: Sequence[Any] = (raw_hard_vetoes,)
    else:
        raw_values = cast(Sequence[Any], raw_hard_vetoes or ())
    return tuple(item for item in (_string(value) for value in raw_values) if item)


def _merge_promotion_contract_fields(
    scorecard: dict[str, Any],
    *,
    candidate: Mapping[str, Any],
) -> None:
    for nested_contract in (
        _mapping(candidate.get("hard_vetoes")),
        _mapping(candidate.get("promotion_contract")),
    ):
        _merge_missing_source_values(
            scorecard,
            (nested_contract,),
            _PROMOTION_CONTRACT_SCORECARD_KEYS,
        )


def _merge_frontier_runtime_config(
    scorecard: dict[str, Any],
    *,
    candidate: Mapping[str, Any],
) -> None:
    replay_params = _frontier_replay_params(candidate)
    if replay_params and "runtime_params" not in scorecard:
        scorecard["runtime_params"] = replay_params
    strategy_overrides = _frontier_strategy_overrides(candidate)
    if strategy_overrides and "candidate_strategy_overrides" not in scorecard:
        scorecard["candidate_strategy_overrides"] = strategy_overrides
    _merge_strategy_override_fields(scorecard, strategy_overrides)


def _merge_strategy_override_fields(
    scorecard: dict[str, Any],
    strategy_overrides: Mapping[str, Any],
) -> None:
    universe_symbols = _string_list(strategy_overrides.get("universe_symbols"))
    if universe_symbols and "universe_symbols" not in scorecard:
        scorecard["universe_symbols"] = universe_symbols
    for key in ("max_notional_per_trade", "max_position_pct_equity"):
        if key not in scorecard and strategy_overrides.get(key) is not None:
            scorecard[key] = strategy_overrides[key]


def _merge_runtime_identity(
    scorecard: dict[str, Any],
    *,
    candidate: Mapping[str, Any],
) -> None:
    runtime_identity_fallbacks = {
        "runtime_family": _string(candidate.get("family")),
        "runtime_strategy_name": _string(candidate.get("strategy_name")),
    }
    for key in _RUNTIME_IDENTITY_KEYS:
        value = _string(candidate.get(key)) or runtime_identity_fallbacks.get(key, "")
        if value and key not in scorecard:
            scorecard[key] = value


def _merge_replay_lineage(
    scorecard: dict[str, Any],
    *,
    candidate: Mapping[str, Any],
) -> None:
    replay_lineage = _mapping(candidate.get("replay_lineage"))
    if replay_lineage and "replay_lineage" not in scorecard:
        scorecard["replay_lineage"] = replay_lineage
    replay_window_coverage = _mapping(
        scorecard.get("replay_window_coverage")
        or candidate.get("replay_window_coverage")
        or replay_lineage.get("replay_window_coverage")
    )
    if replay_window_coverage and "replay_window_coverage" not in scorecard:
        scorecard["replay_window_coverage"] = replay_window_coverage


def _default_frontier_replay_stress_metrics(
    scorecard: Mapping[str, Any],
) -> tuple[Mapping[str, Any], ...]:
    return (
        {
            "source": "frontier_replay",
            "stress_type": "market_impact",
            "model": scorecard.get("market_impact_stress_model"),
            "cost_bps": scorecard.get("market_impact_stress_cost_bps"),
            "net_pnl_per_day": scorecard.get("market_impact_stress_net_pnl_per_day"),
            "passed": scorecard.get("market_impact_stress_passed"),
            "artifact_ref": scorecard.get("market_impact_stress_artifact_ref"),
        },
        {
            "source": "frontier_replay",
            "stress_type": "delay_adjusted_depth",
            "model": scorecard.get("delay_adjusted_depth_stress_model"),
            "stress_ms": scorecard.get("delay_adjusted_depth_stress_ms"),
            "latency_grid_ms": scorecard.get("delay_adjusted_depth_latency_grid_ms"),
            "grid_max_stress_ms": scorecard.get(
                "delay_adjusted_depth_grid_max_stress_ms"
            ),
            "fillable_notional_per_day": scorecard.get(
                "delay_adjusted_depth_fillable_notional_per_day"
            ),
            "worst_grid_fillable_notional_per_day": scorecard.get(
                "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
            ),
            "worst_active_day_fillable_notional": scorecard.get(
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            ),
            "p10_active_day_fillable_notional": scorecard.get(
                "delay_adjusted_depth_p10_active_day_fillable_notional"
            ),
            "tail_coverage_passed": scorecard.get(
                "delay_adjusted_depth_tail_coverage_passed"
            ),
            "liquidity_missing_day_count": scorecard.get(
                "delay_adjusted_depth_liquidity_missing_day_count"
            ),
            "fillable_ratio": scorecard.get("delay_adjusted_depth_fillable_ratio"),
            "survival_adjusted_fillable_ratio": scorecard.get(
                "delay_adjusted_depth_survival_adjusted_fillable_ratio"
            ),
            "unfillable_notional_per_day": scorecard.get(
                "delay_adjusted_depth_unfillable_notional_per_day"
            ),
            "fill_survival_evidence_present": scorecard.get(
                "delay_adjusted_depth_fill_survival_evidence_present"
            ),
            "fill_survival_sample_count": scorecard.get(
                "delay_adjusted_depth_fill_survival_sample_count"
            ),
            "fill_survival_rate": scorecard.get(
                "delay_adjusted_depth_fill_survival_rate"
            ),
            "queue_ratio_p95": scorecard.get("delay_adjusted_depth_queue_ratio_p95"),
            "queue_ahead_depletion_evidence_present": scorecard.get(
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
            ),
            "queue_ahead_depletion_sample_count": scorecard.get(
                "delay_adjusted_depth_queue_ahead_depletion_sample_count"
            ),
            "net_pnl_per_day": scorecard.get(
                "delay_adjusted_depth_stress_net_pnl_per_day"
            ),
            "passed": scorecard.get("delay_adjusted_depth_stress_passed"),
            "artifact_ref": scorecard.get("delay_adjusted_depth_stress_artifact_ref"),
        },
        {
            "source": "frontier_replay",
            "stress_type": "implementation_uncertainty",
            "model": scorecard.get("implementation_uncertainty_model"),
            "model_count": scorecard.get("implementation_uncertainty_model_count"),
            "lower_net_pnl_per_day": scorecard.get(
                "implementation_uncertainty_lower_net_pnl_per_day"
            ),
            "upper_net_pnl_per_day": scorecard.get(
                "implementation_uncertainty_upper_net_pnl_per_day"
            ),
            "interval_width_per_day": scorecard.get(
                "implementation_uncertainty_interval_width_per_day"
            ),
            "scenarios": scorecard.get("implementation_uncertainty_scenarios"),
            "passed": scorecard.get("implementation_uncertainty_stability_passed"),
        },
    )


__all__ = (
    "frontier_candidate_adaptive_signal_falsification_stress",
    "frontier_candidate_null_comparator",
    "frontier_candidate_scorecard",
    "frontier_candidate_stress_metrics",
)
