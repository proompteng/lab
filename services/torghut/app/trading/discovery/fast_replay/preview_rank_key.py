"""Preview-only vectorized scoring over manifest-verified replay tapes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast


from .shared_context import (
    FastReplayPreviewRow,
)


def _float_or_none(value: Any) -> float | None:
    from .extract_price import float_or_none as impl

    return impl(value)


def _mapping(value: Any) -> Mapping[str, Any]:
    from .extract_price import mapping as impl

    return impl(value)


def _row_exact_replay_selection_blocked(row: FastReplayPreviewRow) -> bool:
    from .frontier_selection_blockers_for_row import (
        row_exact_replay_selection_blocked as impl,
    )

    return impl(row)


def _preview_rank_key(
    row: FastReplayPreviewRow,
) -> tuple[bool, float, float, float, str]:
    prefilter_score = _float_or_none(
        row.microstructure_prefilter.get("prefilter_score")
    )
    return (
        row.selection_reason == "insufficient_replay_tape_rows"
        or _row_explicitly_non_hpairs(row),
        -_risk_adjusted_robust_rank_score(row),
        -float(row.preview_score),
        -(prefilter_score if prefilter_score is not None else float(row.preview_score)),
        row.candidate_spec_id,
    )


def _risk_adjusted_robust_rank_score(row: FastReplayPreviewRow) -> float:
    return (
        float(row.robust_lower_percentile_post_cost_utility_bps)
        - float(row.macro_stress_veto_score) * 25.0
        - float(row.square_root_impact_capacity_penalty_bps) * 0.15
        - _execution_schedule_rank_penalty_bps(row) * 0.08
        - _order_book_observability_rank_penalty_bps(row) * 0.07
        - _order_transition_rank_penalty_bps(row) * 0.06
        - _order_flow_entropy_regime_rank_penalty_bps(row) * 0.05
        - _lead_lag_cross_asset_rank_penalty_bps(row) * 0.05
        - _queue_survival_fill_rank_penalty_bps(row) * 0.07
        - _feed_lag_liquidity_rank_penalty_bps(row) * 0.06
        - _lob_reality_gap_rank_penalty_bps(row) * 0.05
        - _alpha_decay_predictability_rank_penalty_bps(row) * 0.05
        - _counterfactual_regime_rank_penalty_bps(row) * 0.04
        - _nonlinear_impact_execution_rank_penalty_bps(row) * 0.04
        - _option_gamma_flow_rank_penalty_bps(row) * 0.04
        - _intraday_jump_burst_rank_penalty_bps(row) * 0.04
        - _intraday_price_path_asymmetry_rank_penalty_bps(row) * 0.03
        - _rough_flow_volatility_rank_penalty_bps(row) * 0.04
        - _institutional_mechanism_fidelity_rank_penalty_bps(row) * 0.04
        - _signal_adaptive_execution_resilience_rank_penalty_bps(row) * 0.04
        - _stochastic_liquidity_resilience_rank_penalty_bps(row) * 0.04
        - _microstructure_regime_tokenization_rank_penalty_bps(row) * 0.04
        - _cost_aware_forecast_filter_rank_penalty_bps(row) * 0.04
        - _adaptive_market_limit_allocation_rank_penalty_bps(row) * 0.04
        - _metaorder_adverse_selection_rank_penalty_bps(row) * 0.04
        - _hawkes_transient_impact_rank_penalty_bps(row) * 0.05
        - _ofi_response_horizon_rank_penalty_bps(row) * 0.05
        - _bootstrap_robust_optimization_rank_penalty_bps(row) * 0.05
        - float(row.conformal_tail_risk_penalty_bps) * 0.10
    )


def _execution_schedule_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.execution_schedule_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _order_book_observability_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(
        row.order_book_observability_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _order_transition_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.order_transition_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _order_flow_entropy_regime_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.order_flow_entropy_regime_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _lead_lag_cross_asset_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.lead_lag_cross_asset_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _queue_survival_fill_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.queue_survival_fill_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _feed_lag_liquidity_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.feed_lag_liquidity_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _lob_reality_gap_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.lob_reality_gap_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _alpha_decay_predictability_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.alpha_decay_predictability_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _counterfactual_regime_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(
        row.counterfactual_regime_replay_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _nonlinear_impact_execution_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(
        row.nonlinear_impact_execution_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _option_gamma_flow_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.option_gamma_flow_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _intraday_jump_burst_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(row.intraday_jump_burst_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _intraday_price_path_asymmetry_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.intraday_price_path_asymmetry_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _rough_flow_volatility_rank_penalty_bps(row: FastReplayPreviewRow) -> float:
    ranking_features = _mapping(
        row.rough_flow_volatility_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _institutional_mechanism_fidelity_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.institutional_mechanism_fidelity_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _signal_adaptive_execution_resilience_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.signal_adaptive_execution_resilience_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _stochastic_liquidity_resilience_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.stochastic_liquidity_resilience_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _microstructure_regime_tokenization_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.microstructure_regime_tokenization_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _cost_aware_forecast_filter_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.cost_aware_forecast_filter_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _adaptive_market_limit_allocation_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.adaptive_market_limit_allocation_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _metaorder_adverse_selection_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.metaorder_adverse_selection_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _hawkes_transient_impact_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.hawkes_transient_impact_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _ofi_response_horizon_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(row.ofi_response_horizon_stress.get("ranking_features"))
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _bootstrap_robust_optimization_rank_penalty_bps(
    row: FastReplayPreviewRow,
) -> float:
    ranking_features = _mapping(
        row.bootstrap_robust_optimization_stress.get("ranking_features")
    )
    return _float_or_none(ranking_features.get("replay_rank_penalty_bps")) or 0.0


def _row_explicitly_non_hpairs(row: FastReplayPreviewRow) -> bool:
    value = row.microstructure_prefilter.get("is_hpairs_candidate")
    return isinstance(value, bool) and not value


def _mark_frontier_duplicates(
    ranked_rows: Sequence[FastReplayPreviewRow],
) -> list[FastReplayPreviewRow]:
    grouped_ids: dict[str, list[str]] = {}
    representative_by_key: dict[str, str] = {}
    for row in ranked_rows:
        key = _frontier_dedupe_key(row)
        grouped_ids.setdefault(key, []).append(row.candidate_spec_id)
        representative_by_key.setdefault(key, row.candidate_spec_id)

    deduped_rows: list[FastReplayPreviewRow] = []
    for row in ranked_rows:
        key = _frontier_dedupe_key(row)
        group = tuple(grouped_ids[key])
        representative = representative_by_key[key]
        if len(group) <= 1:
            deduped_rows.append(
                _row_with_frontier_dedupe(
                    row=row,
                    frontier_dedupe_status="unique",
                    duplicate_of_candidate_spec_id=None,
                    duplicate_candidate_spec_ids=(),
                )
            )
        elif row.candidate_spec_id == representative:
            deduped_rows.append(
                _row_with_frontier_dedupe(
                    row=row,
                    frontier_dedupe_status="representative",
                    duplicate_of_candidate_spec_id=None,
                    duplicate_candidate_spec_ids=tuple(
                        candidate_spec_id
                        for candidate_spec_id in group
                        if candidate_spec_id != row.candidate_spec_id
                    ),
                )
            )
        else:
            deduped_rows.append(
                _row_with_frontier_dedupe(
                    row=row,
                    frontier_dedupe_status="duplicate_filtered",
                    duplicate_of_candidate_spec_id=representative,
                    duplicate_candidate_spec_ids=tuple(
                        candidate_spec_id
                        for candidate_spec_id in group
                        if candidate_spec_id != row.candidate_spec_id
                    ),
                )
            )
    return deduped_rows


def _frontier_dedupe_key(row: FastReplayPreviewRow) -> str:
    return (
        row.exact_replay_frontier_key
        or row.candidate_frontier_hash
        or row.candidate_spec_id
    )


def _row_frontier_duplicate_filtered(row: FastReplayPreviewRow) -> bool:
    return row.frontier_dedupe_status == "duplicate_filtered"


def _select_frontier_buckets(
    *,
    ranked_rows: Sequence[FastReplayPreviewRow],
    exploitation_count: int,
    exploration_count: int,
    exact_replay_candidate_cap: int,
) -> dict[str, str]:
    eligible = [
        row
        for row in ranked_rows
        if row.selection_reason != "insufficient_replay_tape_rows"
        and not _row_explicitly_non_hpairs(row)
        and not _row_frontier_duplicate_filtered(row)
        and not _row_exact_replay_selection_blocked(row)
    ]
    selected: dict[str, str] = {}
    for row in eligible[:exploitation_count]:
        if len(selected) >= exact_replay_candidate_cap:
            break
        selected[row.candidate_spec_id] = "exploitation"
    exploration_pool = sorted(
        (row for row in eligible if row.candidate_spec_id not in selected),
        key=lambda row: (-float(row.exploration_score), row.candidate_spec_id),
    )
    explored_diversity_keys: set[tuple[str, ...]] = set()
    deferred_exploration: list[FastReplayPreviewRow] = []
    for row in exploration_pool:
        if (
            len(selected) >= exact_replay_candidate_cap
            or len([bucket for bucket in selected.values() if bucket == "exploration"])
            >= exploration_count
        ):
            break
        diversity_key = _row_exploration_diversity_key(row)
        if diversity_key in explored_diversity_keys:
            deferred_exploration.append(row)
            continue
        selected[row.candidate_spec_id] = "exploration"
        explored_diversity_keys.add(diversity_key)
    for row in deferred_exploration:
        if (
            len(selected) >= exact_replay_candidate_cap
            or len([bucket for bucket in selected.values() if bucket == "exploration"])
            >= exploration_count
        ):
            break
        selected[row.candidate_spec_id] = "exploration"
    if not selected:
        for row in eligible:
            selected[row.candidate_spec_id] = "exploitation_backfill"
            break
    return selected


def _row_exploration_diversity_key(row: FastReplayPreviewRow) -> tuple[str, ...]:
    lineage = row.candidate_lineage
    symbols = lineage.get("symbol_universe")
    if isinstance(symbols, Sequence) and not isinstance(
        symbols, (str, bytes, bytearray)
    ):
        raw_symbols = cast(Sequence[object], symbols)
        symbol_key = ",".join(str(symbol).upper() for symbol in raw_symbols)
    else:
        symbol_key = str(symbols or row.candidate_spec_id)
    return (
        str(lineage.get("family_template_id") or "unknown_family"),
        str(lineage.get("runtime_strategy_name") or "unknown_strategy"),
        symbol_key,
    )


def _row_with_rank_and_selection(
    *, row: FastReplayPreviewRow, rank: int, frontier_bucket: str
) -> FastReplayPreviewRow:
    selected = frontier_bucket != "not_selected"
    selection_reason = row.selection_reason
    if selected:
        selection_reason = f"fast_replay_frontier_{frontier_bucket}_selected"
    elif _row_frontier_duplicate_filtered(row):
        selection_reason = "fast_replay_frontier_duplicate_filtered"
    elif _row_exact_replay_selection_blocked(row):
        selection_reason = "fast_replay_frontier_lineage_blocked"
    elif _row_explicitly_non_hpairs(row):
        selection_reason = "fast_replay_frontier_non_hpairs_skipped"
    elif row.selection_reason != "insufficient_replay_tape_rows":
        selection_reason = "fast_replay_frontier_budget_exhausted_skipped"
    return FastReplayPreviewRow(
        candidate_spec_id=row.candidate_spec_id,
        rank=rank,
        preview_score=row.preview_score,
        selected=selected,
        selection_reason=selection_reason,
        matched_row_count=row.matched_row_count,
        matched_symbol_count=row.matched_symbol_count,
        requested_symbol_count=row.requested_symbol_count,
        trading_day_count=row.trading_day_count,
        signed_return_bps=row.signed_return_bps,
        avg_abs_return_bps=row.avg_abs_return_bps,
        median_spread_bps=row.median_spread_bps,
        activity_score=row.activity_score,
        coverage_score=row.coverage_score,
        ofi_pressure_score=row.ofi_pressure_score,
        microprice_bias_bps=row.microprice_bias_bps,
        spread_tail_bps=row.spread_tail_bps,
        return_tail_abs_bps=row.return_tail_abs_bps,
        impact_liquidity_penalty_bps=row.impact_liquidity_penalty_bps,
        cluster_lob_activity_score=row.cluster_lob_activity_score,
        ofi_decay_alignment_score=row.ofi_decay_alignment_score,
        liquidity_regime_score=row.liquidity_regime_score,
        macro_stress_veto_score=row.macro_stress_veto_score,
        conformal_tail_risk_penalty_bps=row.conformal_tail_risk_penalty_bps,
        square_root_impact_capacity_penalty_bps=row.square_root_impact_capacity_penalty_bps,
        exploration_score=row.exploration_score,
        frontier_bucket=frontier_bucket,
        microstructure_prefilter=dict(row.microstructure_prefilter),
        clusterlob_order_flow_features=dict(row.clusterlob_order_flow_features),
        execution_schedule_stress=dict(row.execution_schedule_stress),
        order_book_observability_stress=dict(row.order_book_observability_stress),
        order_transition_stress=dict(row.order_transition_stress),
        order_flow_entropy_regime_stress=dict(row.order_flow_entropy_regime_stress),
        lead_lag_cross_asset_stress=dict(row.lead_lag_cross_asset_stress),
        queue_survival_fill_stress=dict(row.queue_survival_fill_stress),
        feed_lag_liquidity_stress=dict(row.feed_lag_liquidity_stress),
        lob_reality_gap_stress=dict(row.lob_reality_gap_stress),
        alpha_decay_predictability_stress=dict(row.alpha_decay_predictability_stress),
        counterfactual_regime_replay_stress=dict(
            row.counterfactual_regime_replay_stress
        ),
        nonlinear_impact_execution_stress=dict(row.nonlinear_impact_execution_stress),
        option_gamma_flow_stress=dict(row.option_gamma_flow_stress),
        intraday_jump_burst_stress=dict(row.intraday_jump_burst_stress),
        intraday_price_path_asymmetry_stress=dict(
            row.intraday_price_path_asymmetry_stress
        ),
        rough_flow_volatility_stress=dict(row.rough_flow_volatility_stress),
        institutional_mechanism_fidelity_stress=dict(
            row.institutional_mechanism_fidelity_stress
        ),
        signal_adaptive_execution_resilience_stress=dict(
            row.signal_adaptive_execution_resilience_stress
        ),
        stochastic_liquidity_resilience_stress=dict(
            row.stochastic_liquidity_resilience_stress
        ),
        microstructure_regime_tokenization_stress=dict(
            row.microstructure_regime_tokenization_stress
        ),
        cost_aware_forecast_filter_stress=dict(row.cost_aware_forecast_filter_stress),
        adaptive_market_limit_allocation_stress=dict(
            row.adaptive_market_limit_allocation_stress
        ),
        metaorder_adverse_selection_stress=dict(row.metaorder_adverse_selection_stress),
        hawkes_transient_impact_stress=dict(row.hawkes_transient_impact_stress),
        ofi_response_horizon_stress=dict(row.ofi_response_horizon_stress),
        bootstrap_robust_optimization_stress=dict(
            row.bootstrap_robust_optimization_stress
        ),
        adaptive_signal_falsification_stress=dict(
            row.adaptive_signal_falsification_stress
        ),
        proof_semantics_label=row.proof_semantics_label,
        candidate_frontier_hash=row.candidate_frontier_hash,
        exact_replay_frontier_key=row.exact_replay_frontier_key,
        frontier_dedupe_status=row.frontier_dedupe_status,
        duplicate_of_candidate_spec_id=row.duplicate_of_candidate_spec_id,
        duplicate_candidate_spec_ids=row.duplicate_candidate_spec_ids,
        candidate_lineage=dict(row.candidate_lineage),
        replay_tape_cache_identity=dict(row.replay_tape_cache_identity),
        robust_lower_percentile_post_cost_utility_bps=(
            row.robust_lower_percentile_post_cost_utility_bps
        ),
        bootstrap_lower_percentile_post_cost_utility_bps=(
            row.bootstrap_lower_percentile_post_cost_utility_bps
        ),
    )


def _row_with_frontier_dedupe(
    *,
    row: FastReplayPreviewRow,
    frontier_dedupe_status: str,
    duplicate_of_candidate_spec_id: str | None,
    duplicate_candidate_spec_ids: tuple[str, ...],
) -> FastReplayPreviewRow:
    selection_reason = row.selection_reason
    if frontier_dedupe_status == "duplicate_filtered":
        selection_reason = "fast_replay_frontier_duplicate_filtered"
    return FastReplayPreviewRow(
        candidate_spec_id=row.candidate_spec_id,
        rank=row.rank,
        preview_score=row.preview_score,
        selected=False,
        selection_reason=selection_reason,
        matched_row_count=row.matched_row_count,
        matched_symbol_count=row.matched_symbol_count,
        requested_symbol_count=row.requested_symbol_count,
        trading_day_count=row.trading_day_count,
        signed_return_bps=row.signed_return_bps,
        avg_abs_return_bps=row.avg_abs_return_bps,
        median_spread_bps=row.median_spread_bps,
        activity_score=row.activity_score,
        coverage_score=row.coverage_score,
        ofi_pressure_score=row.ofi_pressure_score,
        microprice_bias_bps=row.microprice_bias_bps,
        spread_tail_bps=row.spread_tail_bps,
        return_tail_abs_bps=row.return_tail_abs_bps,
        impact_liquidity_penalty_bps=row.impact_liquidity_penalty_bps,
        cluster_lob_activity_score=row.cluster_lob_activity_score,
        ofi_decay_alignment_score=row.ofi_decay_alignment_score,
        liquidity_regime_score=row.liquidity_regime_score,
        macro_stress_veto_score=row.macro_stress_veto_score,
        conformal_tail_risk_penalty_bps=row.conformal_tail_risk_penalty_bps,
        square_root_impact_capacity_penalty_bps=row.square_root_impact_capacity_penalty_bps,
        exploration_score=row.exploration_score,
        frontier_bucket=row.frontier_bucket,
        microstructure_prefilter=dict(row.microstructure_prefilter),
        clusterlob_order_flow_features=dict(row.clusterlob_order_flow_features),
        execution_schedule_stress=dict(row.execution_schedule_stress),
        order_book_observability_stress=dict(row.order_book_observability_stress),
        order_transition_stress=dict(row.order_transition_stress),
        order_flow_entropy_regime_stress=dict(row.order_flow_entropy_regime_stress),
        lead_lag_cross_asset_stress=dict(row.lead_lag_cross_asset_stress),
        queue_survival_fill_stress=dict(row.queue_survival_fill_stress),
        feed_lag_liquidity_stress=dict(row.feed_lag_liquidity_stress),
        lob_reality_gap_stress=dict(row.lob_reality_gap_stress),
        alpha_decay_predictability_stress=dict(row.alpha_decay_predictability_stress),
        counterfactual_regime_replay_stress=dict(
            row.counterfactual_regime_replay_stress
        ),
        nonlinear_impact_execution_stress=dict(row.nonlinear_impact_execution_stress),
        option_gamma_flow_stress=dict(row.option_gamma_flow_stress),
        intraday_jump_burst_stress=dict(row.intraday_jump_burst_stress),
        intraday_price_path_asymmetry_stress=dict(
            row.intraday_price_path_asymmetry_stress
        ),
        rough_flow_volatility_stress=dict(row.rough_flow_volatility_stress),
        institutional_mechanism_fidelity_stress=dict(
            row.institutional_mechanism_fidelity_stress
        ),
        signal_adaptive_execution_resilience_stress=dict(
            row.signal_adaptive_execution_resilience_stress
        ),
        stochastic_liquidity_resilience_stress=dict(
            row.stochastic_liquidity_resilience_stress
        ),
        microstructure_regime_tokenization_stress=dict(
            row.microstructure_regime_tokenization_stress
        ),
        cost_aware_forecast_filter_stress=dict(row.cost_aware_forecast_filter_stress),
        adaptive_market_limit_allocation_stress=dict(
            row.adaptive_market_limit_allocation_stress
        ),
        metaorder_adverse_selection_stress=dict(row.metaorder_adverse_selection_stress),
        hawkes_transient_impact_stress=dict(row.hawkes_transient_impact_stress),
        ofi_response_horizon_stress=dict(row.ofi_response_horizon_stress),
        bootstrap_robust_optimization_stress=dict(
            row.bootstrap_robust_optimization_stress
        ),
        adaptive_signal_falsification_stress=dict(
            row.adaptive_signal_falsification_stress
        ),
        proof_semantics_label=row.proof_semantics_label,
        candidate_frontier_hash=row.candidate_frontier_hash,
        exact_replay_frontier_key=row.exact_replay_frontier_key,
        frontier_dedupe_status=frontier_dedupe_status,
        duplicate_of_candidate_spec_id=duplicate_of_candidate_spec_id,
        duplicate_candidate_spec_ids=duplicate_candidate_spec_ids,
        candidate_lineage=dict(row.candidate_lineage),
        replay_tape_cache_identity=dict(row.replay_tape_cache_identity),
        robust_lower_percentile_post_cost_utility_bps=(
            row.robust_lower_percentile_post_cost_utility_bps
        ),
        bootstrap_lower_percentile_post_cost_utility_bps=(
            row.bootstrap_lower_percentile_post_cost_utility_bps
        ),
    )


# Public aliases used by split-module consumers.
adaptive_market_limit_allocation_rank_penalty_bps = (
    _adaptive_market_limit_allocation_rank_penalty_bps
)
alpha_decay_predictability_rank_penalty_bps = (
    _alpha_decay_predictability_rank_penalty_bps
)
bootstrap_robust_optimization_rank_penalty_bps = (
    _bootstrap_robust_optimization_rank_penalty_bps
)
cost_aware_forecast_filter_rank_penalty_bps = (
    _cost_aware_forecast_filter_rank_penalty_bps
)
counterfactual_regime_rank_penalty_bps = _counterfactual_regime_rank_penalty_bps
execution_schedule_rank_penalty_bps = _execution_schedule_rank_penalty_bps
feed_lag_liquidity_rank_penalty_bps = _feed_lag_liquidity_rank_penalty_bps
frontier_dedupe_key = _frontier_dedupe_key
hawkes_transient_impact_rank_penalty_bps = _hawkes_transient_impact_rank_penalty_bps
institutional_mechanism_fidelity_rank_penalty_bps = (
    _institutional_mechanism_fidelity_rank_penalty_bps
)
intraday_jump_burst_rank_penalty_bps = _intraday_jump_burst_rank_penalty_bps
intraday_price_path_asymmetry_rank_penalty_bps = (
    _intraday_price_path_asymmetry_rank_penalty_bps
)
lead_lag_cross_asset_rank_penalty_bps = _lead_lag_cross_asset_rank_penalty_bps
lob_reality_gap_rank_penalty_bps = _lob_reality_gap_rank_penalty_bps
mark_frontier_duplicates = _mark_frontier_duplicates
metaorder_adverse_selection_rank_penalty_bps = (
    _metaorder_adverse_selection_rank_penalty_bps
)
microstructure_regime_tokenization_rank_penalty_bps = (
    _microstructure_regime_tokenization_rank_penalty_bps
)
nonlinear_impact_execution_rank_penalty_bps = (
    _nonlinear_impact_execution_rank_penalty_bps
)
ofi_response_horizon_rank_penalty_bps = _ofi_response_horizon_rank_penalty_bps
option_gamma_flow_rank_penalty_bps = _option_gamma_flow_rank_penalty_bps
order_book_observability_rank_penalty_bps = _order_book_observability_rank_penalty_bps
order_flow_entropy_regime_rank_penalty_bps = _order_flow_entropy_regime_rank_penalty_bps
order_transition_rank_penalty_bps = _order_transition_rank_penalty_bps
preview_rank_key = _preview_rank_key
queue_survival_fill_rank_penalty_bps = _queue_survival_fill_rank_penalty_bps
risk_adjusted_robust_rank_score = _risk_adjusted_robust_rank_score
rough_flow_volatility_rank_penalty_bps = _rough_flow_volatility_rank_penalty_bps
row_explicitly_non_hpairs = _row_explicitly_non_hpairs
row_exploration_diversity_key = _row_exploration_diversity_key
row_frontier_duplicate_filtered = _row_frontier_duplicate_filtered
row_with_frontier_dedupe = _row_with_frontier_dedupe
row_with_rank_and_selection = _row_with_rank_and_selection
select_frontier_buckets = _select_frontier_buckets
signal_adaptive_execution_resilience_rank_penalty_bps = (
    _signal_adaptive_execution_resilience_rank_penalty_bps
)
stochastic_liquidity_resilience_rank_penalty_bps = (
    _stochastic_liquidity_resilience_rank_penalty_bps
)

adaptive_market_limit_allocation_rank_penalty_bps_split_export = (
    _adaptive_market_limit_allocation_rank_penalty_bps
)
alpha_decay_predictability_rank_penalty_bps_split_export = (
    _alpha_decay_predictability_rank_penalty_bps
)
bootstrap_robust_optimization_rank_penalty_bps_split_export = (
    _bootstrap_robust_optimization_rank_penalty_bps
)
cost_aware_forecast_filter_rank_penalty_bps_split_export = (
    _cost_aware_forecast_filter_rank_penalty_bps
)
counterfactual_regime_rank_penalty_bps_split_export = (
    _counterfactual_regime_rank_penalty_bps
)
execution_schedule_rank_penalty_bps_split_export = _execution_schedule_rank_penalty_bps
feed_lag_liquidity_rank_penalty_bps_split_export = _feed_lag_liquidity_rank_penalty_bps
frontier_dedupe_key_split_export = _frontier_dedupe_key
hawkes_transient_impact_rank_penalty_bps_split_export = (
    _hawkes_transient_impact_rank_penalty_bps
)
institutional_mechanism_fidelity_rank_penalty_bps_split_export = (
    _institutional_mechanism_fidelity_rank_penalty_bps
)
intraday_jump_burst_rank_penalty_bps_split_export = (
    _intraday_jump_burst_rank_penalty_bps
)
intraday_price_path_asymmetry_rank_penalty_bps_split_export = (
    _intraday_price_path_asymmetry_rank_penalty_bps
)
lead_lag_cross_asset_rank_penalty_bps_split_export = (
    _lead_lag_cross_asset_rank_penalty_bps
)
lob_reality_gap_rank_penalty_bps_split_export = _lob_reality_gap_rank_penalty_bps
mark_frontier_duplicates_split_export = _mark_frontier_duplicates
metaorder_adverse_selection_rank_penalty_bps_split_export = (
    _metaorder_adverse_selection_rank_penalty_bps
)
microstructure_regime_tokenization_rank_penalty_bps_split_export = (
    _microstructure_regime_tokenization_rank_penalty_bps
)
nonlinear_impact_execution_rank_penalty_bps_split_export = (
    _nonlinear_impact_execution_rank_penalty_bps
)
ofi_response_horizon_rank_penalty_bps_split_export = (
    _ofi_response_horizon_rank_penalty_bps
)
option_gamma_flow_rank_penalty_bps_split_export = _option_gamma_flow_rank_penalty_bps
order_book_observability_rank_penalty_bps_split_export = (
    _order_book_observability_rank_penalty_bps
)
order_flow_entropy_regime_rank_penalty_bps_split_export = (
    _order_flow_entropy_regime_rank_penalty_bps
)
order_transition_rank_penalty_bps_split_export = _order_transition_rank_penalty_bps
preview_rank_key_split_export = _preview_rank_key
queue_survival_fill_rank_penalty_bps_split_export = (
    _queue_survival_fill_rank_penalty_bps
)
risk_adjusted_robust_rank_score_split_export = _risk_adjusted_robust_rank_score
rough_flow_volatility_rank_penalty_bps_split_export = (
    _rough_flow_volatility_rank_penalty_bps
)
row_explicitly_non_hpairs_split_export = _row_explicitly_non_hpairs
row_exploration_diversity_key_split_export = _row_exploration_diversity_key
row_frontier_duplicate_filtered_split_export = _row_frontier_duplicate_filtered
row_with_frontier_dedupe_split_export = _row_with_frontier_dedupe
row_with_rank_and_selection_split_export = _row_with_rank_and_selection
select_frontier_buckets_split_export = _select_frontier_buckets
signal_adaptive_execution_resilience_rank_penalty_bps_split_export = (
    _signal_adaptive_execution_resilience_rank_penalty_bps
)
stochastic_liquidity_resilience_rank_penalty_bps_split_export = (
    _stochastic_liquidity_resilience_rank_penalty_bps
)
__all__ = (
    "adaptive_market_limit_allocation_rank_penalty_bps",
    "alpha_decay_predictability_rank_penalty_bps",
    "bootstrap_robust_optimization_rank_penalty_bps",
    "cost_aware_forecast_filter_rank_penalty_bps",
    "counterfactual_regime_rank_penalty_bps",
    "execution_schedule_rank_penalty_bps",
    "feed_lag_liquidity_rank_penalty_bps",
    "frontier_dedupe_key",
    "hawkes_transient_impact_rank_penalty_bps",
    "institutional_mechanism_fidelity_rank_penalty_bps",
    "intraday_jump_burst_rank_penalty_bps",
    "intraday_price_path_asymmetry_rank_penalty_bps",
    "lead_lag_cross_asset_rank_penalty_bps",
    "lob_reality_gap_rank_penalty_bps",
    "mark_frontier_duplicates",
    "metaorder_adverse_selection_rank_penalty_bps",
    "microstructure_regime_tokenization_rank_penalty_bps",
    "nonlinear_impact_execution_rank_penalty_bps",
    "ofi_response_horizon_rank_penalty_bps",
    "option_gamma_flow_rank_penalty_bps",
    "order_book_observability_rank_penalty_bps",
    "order_flow_entropy_regime_rank_penalty_bps",
    "order_transition_rank_penalty_bps",
    "preview_rank_key",
    "queue_survival_fill_rank_penalty_bps",
    "risk_adjusted_robust_rank_score",
    "rough_flow_volatility_rank_penalty_bps",
    "row_explicitly_non_hpairs",
    "row_exploration_diversity_key",
    "row_frontier_duplicate_filtered",
    "row_with_frontier_dedupe",
    "row_with_rank_and_selection",
    "select_frontier_buckets",
    "signal_adaptive_execution_resilience_rank_penalty_bps",
    "stochastic_liquidity_resilience_rank_penalty_bps",
    "adaptive_market_limit_allocation_rank_penalty_bps_split_export",
    "alpha_decay_predictability_rank_penalty_bps_split_export",
    "bootstrap_robust_optimization_rank_penalty_bps_split_export",
    "cost_aware_forecast_filter_rank_penalty_bps_split_export",
    "counterfactual_regime_rank_penalty_bps_split_export",
    "execution_schedule_rank_penalty_bps_split_export",
    "feed_lag_liquidity_rank_penalty_bps_split_export",
    "frontier_dedupe_key_split_export",
    "hawkes_transient_impact_rank_penalty_bps_split_export",
    "institutional_mechanism_fidelity_rank_penalty_bps_split_export",
    "intraday_jump_burst_rank_penalty_bps_split_export",
    "intraday_price_path_asymmetry_rank_penalty_bps_split_export",
    "lead_lag_cross_asset_rank_penalty_bps_split_export",
    "lob_reality_gap_rank_penalty_bps_split_export",
    "mark_frontier_duplicates_split_export",
    "metaorder_adverse_selection_rank_penalty_bps_split_export",
    "microstructure_regime_tokenization_rank_penalty_bps_split_export",
    "nonlinear_impact_execution_rank_penalty_bps_split_export",
    "ofi_response_horizon_rank_penalty_bps_split_export",
    "option_gamma_flow_rank_penalty_bps_split_export",
    "order_book_observability_rank_penalty_bps_split_export",
    "order_flow_entropy_regime_rank_penalty_bps_split_export",
    "order_transition_rank_penalty_bps_split_export",
    "preview_rank_key_split_export",
    "queue_survival_fill_rank_penalty_bps_split_export",
    "risk_adjusted_robust_rank_score_split_export",
    "rough_flow_volatility_rank_penalty_bps_split_export",
    "row_explicitly_non_hpairs_split_export",
    "row_exploration_diversity_key_split_export",
    "row_frontier_duplicate_filtered_split_export",
    "row_with_frontier_dedupe_split_export",
    "row_with_rank_and_selection_split_export",
    "select_frontier_buckets_split_export",
    "signal_adaptive_execution_resilience_rank_penalty_bps_split_export",
    "stochastic_liquidity_resilience_rank_penalty_bps_split_export",
)
