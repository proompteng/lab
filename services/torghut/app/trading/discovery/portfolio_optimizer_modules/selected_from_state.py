# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Deterministic portfolio sleeve optimizer for autoresearch candidates."""

from __future__ import annotations

from decimal import Decimal, ROUND_CEILING
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_is_valid,
)
from app.trading.discovery.portfolio_candidates import (
    PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
    PortfolioCandidateSpec,
    portfolio_candidate_id_for_payload,
)
from app.trading.discovery.objectives import deployable_lower_bound_net_pnl_per_day
from app.trading.discovery.profit_target_oracle import evaluate_profit_target_oracle
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.runtime_ledger import POST_COST_PNL_BASIS

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    CONFORMAL_TAIL_RISK_ALPHA,
    MAX_ALLOWED_PAIRWISE_CORRELATION,
    PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES,
    PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE,
    PORTFOLIO_SEARCH_BEAM_WIDTH,
    PORTFOLIO_WEIGHTING_EDGE_RISK_GROSS_EXPOSURE_BUDGET,
    PORTFOLIO_WEIGHTING_EQUAL_COUNT,
    PORTFOLIO_WEIGHTING_GROSS_EXPOSURE_BUDGET,
    _ACCEPTED_LEDGER_PNL_SOURCES,
    _active_ratio,
    _artifact_refs_from_scorecard,
    _best_day_share,
    _boolish,
    _candidate_passes_minimums,
    _capital_safety_rejection,
    _conformal_tail_loss_buffer,
    _conformal_tail_risk_required,
    _correlation,
    _daily_filled_notional,
    _daily_net,
    _decimal,
    _diversified_candidate_order,
    _exact_replay_ledger_artifact_refs,
    _exact_replay_ledger_fill_count,
    _exact_replay_ledger_row_count,
    _executable_replay_artifact_ref,
    _executable_replay_buying_power,
    _executable_replay_max_notional,
    _executable_replay_order_count,
    _executable_replay_passed,
    _first_normalized_scorecard_text,
    _hard_vetoes,
    _implementation_uncertainty_interval_width_per_day,
    _implementation_uncertainty_lower_net_per_day,
    _implementation_uncertainty_model_count,
    _implementation_uncertainty_required,
    _implementation_uncertainty_stability_passed,
    _implementation_uncertainty_upper_net_per_day,
    _ledger_pnl_basis,
    _ledger_pnl_source,
    _mapping,
    _market_impact_liquidity_evidence_present,
    _market_impact_stress_artifact_ref,
    _market_impact_stress_components,
    _market_impact_stress_cost_bps,
    _market_impact_stress_model,
    _market_impact_stress_net_per_day,
    _market_impact_stress_passed,
    _max_drawdown,
    _max_gross_exposure_pct_equity,
    _mean,
    _min_cash,
    _negative_cash_observation_count,
    _net_per_day,
    _non_composable_hard_vetoes,
    _portfolio_daily_filled_notional,
    _portfolio_daily_net,
    _positive_ratio,
    _scorecard,
    _scorecard_primary_symbol,
    _scorecard_runtime_params,
    _scorecard_signal,
    _scorecard_sleeve_runtime_limits,
    _scorecard_universe_symbols,
    _string,
    _trading_day_count,
    _worst_day_loss,
)
from .delay_adjusted_depth_stress_passed import (
    _bundle_symbol_shares,
    _cluster_contribution_shares,
    _cluster_id,
    _contribution_shares,
    _delay_adjusted_depth_fillable_notional_per_day,
    _delay_adjusted_depth_liquidity_evidence_present,
    _delay_adjusted_depth_liquidity_missing_day_count,
    _delay_adjusted_depth_p10_active_day_fillable_notional,
    _delay_adjusted_depth_stress_artifact_ref,
    _delay_adjusted_depth_stress_ms,
    _delay_adjusted_depth_stress_net_per_day,
    _delay_adjusted_depth_stress_passed,
    _delay_adjusted_depth_tail_coverage_passed,
    _delay_adjusted_depth_worst_active_day_fillable_notional,
    _double_oos_artifact_ref,
    _double_oos_cost_shock_net_per_day,
    _double_oos_fold_metrics,
    _double_oos_independent_window_count,
    _double_oos_net_per_day,
    _double_oos_pass_rate,
    _double_oos_passed,
    _edge_risk_gross_exposure_budget_weights,
    _equal_weights,
    _fill_survival_evidence_present,
    _fill_survival_rate,
    _fill_survival_sample_count,
    _fold_passed,
    _gross_exposure_allocation_edge_net_per_day,
    _gross_exposure_allocation_priority,
    _gross_exposure_budget_weights,
    _max_drawdown_from_daily,
    _max_pairwise_correlation,
    _max_share,
    _missing_sleeve_daily_net_count,
    _portfolio_max_gross_exposure_pct_equity,
    _portfolio_min_cash,
    _portfolio_negative_cash_observation_count,
    _portfolio_weighting_mode,
    _portfolio_weights,
    _positive_net_contribution,
    _queue_ahead_depletion_evidence_present,
    _queue_ahead_depletion_sample_count,
    _queue_position_survival_evidence_present,
    _queue_position_survival_fill_rate,
    _queue_position_survival_queue_ratio_p95,
    _queue_position_survival_sample_count,
    _queue_position_survival_stress_net_per_day,
    _symbol_contribution_shares,
)
from .portfolio_trading_day_count import (
    _empty_selection_key,
    _oracle_blocker_count,
    _portfolio_addition_rejection,
    _portfolio_scorecard,
    _portfolio_selection_key,
    _portfolio_trading_day_count,
    _record_unique_rejection,
    _scorecard_decimal,
    _sleeve_score,
)


def _selected_from_state(
    ordered: Sequence[CandidateEvidenceBundle],
    state: tuple[int, ...],
) -> tuple[CandidateEvidenceBundle, ...]:
    return tuple(ordered[index] for index in state)


def _select_portfolio_bundles(
    *,
    ordered: Sequence[CandidateEvidenceBundle],
    rejected: list[dict[str, Any]],
    target_net_pnl_per_day: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
    requested_portfolio_size_min: int,
    requested_portfolio_size_max: int,
    max_allowed_correlation: Decimal,
) -> tuple[list[CandidateEvidenceBundle], dict[str, Any]] | None:
    if len(ordered) < requested_portfolio_size_min:
        return None

    seen_rejections = {
        (_string(item.get("candidate_id")), _string(item.get("reason")))
        for item in rejected
    }
    scorecard_cache: dict[tuple[int, ...], dict[str, Any]] = {}

    def state_scorecard(state: tuple[int, ...]) -> dict[str, Any]:
        cached = scorecard_cache.get(state)
        if cached is not None:
            return cached
        scorecard = _portfolio_scorecard(
            selected=_selected_from_state(ordered, state),
            target_net_pnl_per_day=target_net_pnl_per_day,
            oracle_policy=oracle_policy,
        )
        scorecard_cache[state] = scorecard
        return scorecard

    def state_sort_key(state: tuple[int, ...]) -> tuple[tuple[Decimal, ...], str]:
        selected = _selected_from_state(ordered, state)
        if not selected:
            quality_key = _empty_selection_key()
        else:
            quality_key = _portfolio_selection_key(
                selected=selected,
                scorecard=state_scorecard(state),
            )
        return (quality_key, "|".join(bundle.candidate_id for bundle in selected))

    beam: list[tuple[int, ...]] = [()]
    candidate_state_count = 0
    pruned_state_count = 0
    for bundle_index, bundle in enumerate(ordered):
        next_states = list(beam)
        for state in beam:
            if len(state) >= requested_portfolio_size_max:
                continue
            selected = _selected_from_state(ordered, state)
            rejection = _portfolio_addition_rejection(
                bundle=bundle,
                selected=selected,
                requested_portfolio_size_min=requested_portfolio_size_min,
                max_allowed_correlation=max_allowed_correlation,
            )
            if rejection is not None:
                _record_unique_rejection(rejected, seen_rejections, rejection)
                continue
            next_states.append((*state, bundle_index))
            candidate_state_count += 1
        unique_next_states = list(dict.fromkeys(next_states))
        unique_next_states.sort(key=state_sort_key, reverse=True)
        if len(unique_next_states) > PORTFOLIO_SEARCH_BEAM_WIDTH:
            pruned_state_count += len(unique_next_states) - PORTFOLIO_SEARCH_BEAM_WIDTH
        beam = unique_next_states[:PORTFOLIO_SEARCH_BEAM_WIDTH]

    finalists: list[tuple[tuple[tuple[Decimal, ...], str], tuple[int, ...]]] = []
    for state in beam:
        if len(state) < requested_portfolio_size_min:
            continue
        finalists.append((state_sort_key(state), state))
    if not finalists:
        return None
    finalists.sort(key=lambda item: item[0], reverse=True)
    selected_state = finalists[0][1]
    selected = list(_selected_from_state(ordered, selected_state))
    return selected, {
        "beam_width": PORTFOLIO_SEARCH_BEAM_WIDTH,
        "candidate_state_count": candidate_state_count,
        "portfolio_state_count": len(scorecard_cache),
        "pruned_state_count": pruned_state_count,
        "finalist_state_count": len(finalists),
        "search_input_count": len(ordered),
    }


def _portfolio_candidate_id(
    source_candidate_ids: Sequence[str], target: Decimal
) -> str:
    return portfolio_candidate_id_for_payload(
        {"source_candidate_ids": list(source_candidate_ids), "target": str(target)}
    )


def optimize_portfolio_candidate(
    *,
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    target_net_pnl_per_day: Decimal = Decimal("300"),
    oracle_policy: ProfitTargetOraclePolicy | None = None,
    portfolio_size_min: int = 2,
    portfolio_size_max: int = 8,
) -> PortfolioCandidateSpec | None:
    oracle_policy = oracle_policy or ProfitTargetOraclePolicy()
    requested_portfolio_size_min = max(1, int(portfolio_size_min))
    requested_portfolio_size_max = max(1, int(portfolio_size_max))
    invalid_evidence_rejections = [
        {
            "candidate_id": bundle.candidate_id,
            "reason": "invalid_evidence_bundle",
            "blockers": list(evidence_bundle_blockers(bundle)),
        }
        for bundle in evidence_bundles
        if not evidence_bundle_is_valid(bundle)
    ]
    hard_veto_rejections = [
        {
            "candidate_id": bundle.candidate_id,
            "reason": "frontier_non_composable_hard_veto",
            "hard_vetoes": list(_non_composable_hard_vetoes(bundle)),
        }
        for bundle in evidence_bundles
        if evidence_bundle_is_valid(bundle) and _non_composable_hard_vetoes(bundle)
    ]
    capital_safety_rejections = [
        rejection
        for rejection in (
            _capital_safety_rejection(bundle, oracle_policy=oracle_policy)
            for bundle in evidence_bundles
            if evidence_bundle_is_valid(bundle)
        )
        if rejection is not None
    ]
    eligible = [
        bundle
        for bundle in evidence_bundles
        if _candidate_passes_minimums(bundle, oracle_policy=oracle_policy)
    ]
    ordered = _diversified_candidate_order(
        sorted(
            eligible,
            key=lambda item: (
                _sleeve_score(item),
                _net_per_day(item),
                item.candidate_id,
            ),
            reverse=True,
        )
    )
    rejected: list[dict[str, Any]] = [
        *invalid_evidence_rejections,
        *hard_veto_rejections,
        *capital_safety_rejections,
    ]
    max_allowed_correlation = MAX_ALLOWED_PAIRWISE_CORRELATION
    selection_result = _select_portfolio_bundles(
        ordered=ordered,
        rejected=rejected,
        target_net_pnl_per_day=target_net_pnl_per_day,
        oracle_policy=oracle_policy,
        requested_portfolio_size_min=requested_portfolio_size_min,
        requested_portfolio_size_max=requested_portfolio_size_max,
        max_allowed_correlation=max_allowed_correlation,
    )
    if selection_result is None:
        return None
    selected, search_report = selection_result
    selected_clusters = {_cluster_id(bundle) for bundle in selected}

    source_candidate_ids = tuple(item.candidate_id for item in selected)
    objective_scorecard = _portfolio_scorecard(
        selected=selected,
        target_net_pnl_per_day=target_net_pnl_per_day,
        oracle_policy=oracle_policy,
    )
    max_drawdown = _decimal(objective_scorecard.get("max_drawdown"))
    sleeves: list[Mapping[str, Any]] = []
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    for sleeve_index, bundle in enumerate(selected, start=1):
        weight = weights[sleeve_index - 1]
        base_runtime_strategy_name = (
            _string(_scorecard(bundle).get("runtime_strategy_name"))
            or f"whitepaper-autoresearch-sleeve-{sleeve_index}"
        )
        sleeves.append(
            {
                "candidate_id": bundle.candidate_id,
                "candidate_spec_id": bundle.candidate_spec_id,
                "family_template_id": _string(
                    _scorecard(bundle).get("family_template_id")
                ),
                "runtime_family": _string(_scorecard(bundle).get("runtime_family")),
                "runtime_strategy_name": f"{base_runtime_strategy_name}-sleeve-{sleeve_index}",
                "weight": str(weight),
                "signal": _scorecard_signal(bundle),
                "params": dict(_scorecard_runtime_params(bundle)),
                "universe_symbols": _scorecard_universe_symbols(bundle),
                **_scorecard_sleeve_runtime_limits(bundle),
                "expected_net_pnl_per_day": str(_net_per_day(bundle) * weight),
                "source_expected_net_pnl_per_day": str(_net_per_day(bundle)),
                "risk_contribution": str(_max_drawdown(bundle) * weight),
                "source_risk_contribution": str(_max_drawdown(bundle)),
                "correlation_cluster": _string(
                    _scorecard(bundle).get("correlation_cluster")
                )
                or bundle.candidate_spec_id,
                "daily_net": {
                    day: str(value) for day, value in sorted(_daily_net(bundle).items())
                },
                "double_oos": {
                    "passed": _double_oos_passed(bundle),
                    "independent_window_count": _double_oos_independent_window_count(
                        bundle
                    ),
                    "pass_rate": str(_double_oos_pass_rate(bundle)),
                    "net_pnl_per_day": str(_double_oos_net_per_day(bundle)),
                    "cost_shock_net_pnl_per_day": str(
                        _double_oos_cost_shock_net_per_day(bundle)
                    ),
                    "artifact_ref": _double_oos_artifact_ref(bundle),
                },
                "promotion_status": bundle.promotion_readiness.get("status"),
            }
        )
    pairwise_correlations = [
        {
            "left_candidate_id": left.candidate_id,
            "right_candidate_id": right.candidate_id,
            "correlation": str(_correlation(_daily_net(left), _daily_net(right))),
        }
        for left_index, left in enumerate(selected)
        for right in selected[left_index + 1 :]
    ]
    optimizer_report = {
        "eligible_count": len(eligible),
        "selected_count": len(selected),
        "rejected_count": max(0, len(evidence_bundles) - len(selected)),
        "rejections": rejected,
        "pairwise_correlations": pairwise_correlations,
        "cluster_contribution_shares": objective_scorecard.get(
            "cluster_contribution_shares", {}
        ),
        "symbol_contribution_shares": objective_scorecard.get(
            "symbol_contribution_shares", {}
        ),
        "max_cluster_contribution_share": objective_scorecard.get(
            "max_cluster_contribution_share"
        ),
        "max_single_day_contribution_share": objective_scorecard.get(
            "max_single_day_contribution_share"
        ),
        "max_single_symbol_contribution_share": objective_scorecard.get(
            "max_single_symbol_contribution_share"
        ),
        "method": "deterministic_beam_promotion_ready_search_v2",
        "selection_priority": "oracle_passed_then_blocker_minimized_then_target_met",
        **search_report,
        "target_met": bool(objective_scorecard["target_met"]),
        "oracle_passed": bool(objective_scorecard["oracle_passed"]),
    }
    return PortfolioCandidateSpec(
        schema_version=PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
        portfolio_candidate_id=_portfolio_candidate_id(
            source_candidate_ids, target_net_pnl_per_day
        ),
        source_candidate_ids=source_candidate_ids,
        target_net_pnl_per_day=target_net_pnl_per_day,
        sleeves=tuple(sleeves),
        capital_budget={
            "mode": _portfolio_weighting_mode(selected, oracle_policy=oracle_policy),
            "max_sleeves": portfolio_size_max,
            "sleeve_weights": {
                bundle.candidate_id: str(weight)
                for bundle, weight in zip(selected, weights, strict=True)
            },
        },
        correlation_budget={
            "mode": "cluster_cap",
            "selected_cluster_count": len(selected_clusters),
            "max_allowed_pairwise_correlation": str(max_allowed_correlation),
            "max_cluster_contribution_share": objective_scorecard.get(
                "max_cluster_contribution_share"
            ),
            "max_single_symbol_contribution_share": objective_scorecard.get(
                "max_single_symbol_contribution_share"
            ),
            "cluster_contribution_shares": objective_scorecard.get(
                "cluster_contribution_shares", {}
            ),
            "symbol_contribution_shares": objective_scorecard.get(
                "symbol_contribution_shares", {}
            ),
        },
        drawdown_budget={"max_drawdown": str(max_drawdown)},
        evidence_refs=tuple(item.evidence_bundle_id for item in selected),
        objective_scorecard=objective_scorecard,
        optimizer_report=optimizer_report,
    )


__all__ = [name for name in globals() if not name.startswith("__")]
