"""Deterministic portfolio sleeve optimizer for autoresearch candidates."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
)
from app.trading.discovery.objectives import deployable_lower_bound_net_pnl_per_day
from app.trading.discovery.profit_target_oracle import evaluate_profit_target_oracle
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.runtime_ledger import POST_COST_PNL_BASIS


from .shared_context import (
    CONFORMAL_TAIL_RISK_ALPHA,
    PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE,
    ACCEPTED_LEDGER_PNL_SOURCES as _ACCEPTED_LEDGER_PNL_SOURCES,
    active_ratio as _active_ratio,
    best_day_share as _best_day_share,
    conformal_tail_loss_buffer as _conformal_tail_loss_buffer,
    conformal_tail_risk_required as _conformal_tail_risk_required,
    decimal as _decimal,
    exact_replay_ledger_artifact_refs as _exact_replay_ledger_artifact_refs,
    exact_replay_ledger_fill_count as _exact_replay_ledger_fill_count,
    exact_replay_ledger_row_count as _exact_replay_ledger_row_count,
    executable_replay_artifact_ref as _executable_replay_artifact_ref,
    executable_replay_buying_power as _executable_replay_buying_power,
    executable_replay_max_notional as _executable_replay_max_notional,
    executable_replay_order_count as _executable_replay_order_count,
    executable_replay_passed as _executable_replay_passed,
    implementation_uncertainty_interval_width_per_day as _implementation_uncertainty_interval_width_per_day,
    implementation_uncertainty_lower_net_per_day as _implementation_uncertainty_lower_net_per_day,
    implementation_uncertainty_model_count as _implementation_uncertainty_model_count,
    implementation_uncertainty_required as _implementation_uncertainty_required,
    implementation_uncertainty_stability_passed as _implementation_uncertainty_stability_passed,
    implementation_uncertainty_upper_net_per_day as _implementation_uncertainty_upper_net_per_day,
    ledger_pnl_basis as _ledger_pnl_basis,
    ledger_pnl_source as _ledger_pnl_source,
    market_impact_liquidity_evidence_present as _market_impact_liquidity_evidence_present,
    market_impact_stress_artifact_ref as _market_impact_stress_artifact_ref,
    market_impact_stress_components as _market_impact_stress_components,
    market_impact_stress_cost_bps as _market_impact_stress_cost_bps,
    market_impact_stress_model as _market_impact_stress_model,
    market_impact_stress_net_per_day as _market_impact_stress_net_per_day,
    market_impact_stress_passed as _market_impact_stress_passed,
    max_drawdown as _max_drawdown,
    mean as _mean,
    net_per_day as _net_per_day,
    portfolio_daily_filled_notional as _portfolio_daily_filled_notional,
    portfolio_daily_net as _portfolio_daily_net,
    positive_ratio as _positive_ratio,
    scorecard as _scorecard,
    string as _string,
    trading_day_count as _trading_day_count,
    worst_day_loss as _worst_day_loss,
)
from .delay_adjusted_depth_stress_passed import (
    cluster_contribution_shares as _cluster_contribution_shares,
    delay_adjusted_depth_fillable_notional_per_day as _delay_adjusted_depth_fillable_notional_per_day,
    delay_adjusted_depth_liquidity_evidence_present as _delay_adjusted_depth_liquidity_evidence_present,
    delay_adjusted_depth_liquidity_missing_day_count as _delay_adjusted_depth_liquidity_missing_day_count,
    delay_adjusted_depth_p10_active_day_fillable_notional as _delay_adjusted_depth_p10_active_day_fillable_notional,
    delay_adjusted_depth_stress_artifact_ref as _delay_adjusted_depth_stress_artifact_ref,
    delay_adjusted_depth_stress_ms as _delay_adjusted_depth_stress_ms,
    delay_adjusted_depth_stress_net_per_day as _delay_adjusted_depth_stress_net_per_day,
    delay_adjusted_depth_stress_passed as _delay_adjusted_depth_stress_passed,
    delay_adjusted_depth_tail_coverage_passed as _delay_adjusted_depth_tail_coverage_passed,
    delay_adjusted_depth_worst_active_day_fillable_notional as _delay_adjusted_depth_worst_active_day_fillable_notional,
    double_oos_artifact_ref as _double_oos_artifact_ref,
    double_oos_cost_shock_net_per_day as _double_oos_cost_shock_net_per_day,
    double_oos_independent_window_count as _double_oos_independent_window_count,
    double_oos_net_per_day as _double_oos_net_per_day,
    double_oos_pass_rate as _double_oos_pass_rate,
    double_oos_passed as _double_oos_passed,
    fill_survival_evidence_present as _fill_survival_evidence_present,
    fill_survival_rate as _fill_survival_rate,
    fill_survival_sample_count as _fill_survival_sample_count,
    max_drawdown_from_daily as _max_drawdown_from_daily,
    max_pairwise_correlation as _max_pairwise_correlation,
    max_share as _max_share,
    missing_sleeve_daily_net_count as _missing_sleeve_daily_net_count,
    portfolio_max_gross_exposure_pct_equity as _portfolio_max_gross_exposure_pct_equity,
    portfolio_min_cash as _portfolio_min_cash,
    portfolio_negative_cash_observation_count as _portfolio_negative_cash_observation_count,
    portfolio_weighting_mode as _portfolio_weighting_mode,
    portfolio_weights as _portfolio_weights,
    queue_ahead_depletion_evidence_present as _queue_ahead_depletion_evidence_present,
    queue_ahead_depletion_sample_count as _queue_ahead_depletion_sample_count,
    queue_position_survival_evidence_present as _queue_position_survival_evidence_present,
    queue_position_survival_fill_rate as _queue_position_survival_fill_rate,
    queue_position_survival_queue_ratio_p95 as _queue_position_survival_queue_ratio_p95,
    queue_position_survival_sample_count as _queue_position_survival_sample_count,
    queue_position_survival_stress_net_per_day as _queue_position_survival_stress_net_per_day,
    symbol_contribution_shares as _symbol_contribution_shares,
)


def _portfolio_trading_day_count(
    selected: Sequence[CandidateEvidenceBundle],
    daily_net: Mapping[str, Decimal],
) -> int:
    expected = max((_trading_day_count(bundle) for bundle in selected), default=0)
    return max(expected, len(daily_net))


def _portfolio_scorecard(
    *,
    selected: Sequence[CandidateEvidenceBundle],
    target_net_pnl_per_day: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
) -> dict[str, Any]:
    weights = _portfolio_weights(selected, oracle_policy=oracle_policy)
    daily_net = _portfolio_daily_net(selected, oracle_policy=oracle_policy)
    trading_day_count = _portfolio_trading_day_count(selected, daily_net)
    missing_day_count = max(0, trading_day_count - len(daily_net))
    missing_sleeve_daily_net_count = _missing_sleeve_daily_net_count(
        selected, daily_net
    )
    values = [daily_net[day] for day in sorted(daily_net)] + (
        [Decimal("0")] * missing_day_count
    )
    net_per_day = _mean(values)
    conformal_tail_risk_buffer_per_day = _conformal_tail_loss_buffer(values)
    conformal_tail_risk_adjusted_net_pnl_per_day = (
        net_per_day - conformal_tail_risk_buffer_per_day
    )
    conformal_tail_risk_required = bool(selected) and (
        conformal_tail_risk_buffer_per_day > 0
        or any(_conformal_tail_risk_required(bundle) for bundle in selected)
    )
    conformal_tail_risk_passed = (
        bool(values)
        and conformal_tail_risk_adjusted_net_pnl_per_day >= target_net_pnl_per_day
    )
    active_day_ratio = (
        Decimal(sum(1 for value in values if value != 0)) / Decimal(len(values))
        if values
        else Decimal("0")
    )
    positive_day_ratio = (
        Decimal(sum(1 for value in values if value > 0)) / Decimal(len(values))
        if values
        else Decimal("0")
    )
    positive_total = sum((value for value in values if value > 0), Decimal("0"))
    best_day_share = (
        max(values, default=Decimal("0")) / positive_total
        if positive_total > 0
        else Decimal("0")
    )
    cluster_shares = _cluster_contribution_shares(selected, oracle_policy=oracle_policy)
    symbol_shares = _symbol_contribution_shares(selected, oracle_policy=oracle_policy)
    min_day = min(values, default=Decimal("0"))
    worst_day_loss = abs(min_day) if min_day < 0 else Decimal("0")
    daily_notional = _portfolio_daily_filled_notional(
        selected, oracle_policy=oracle_policy
    )
    notional_missing_day_count = max(0, trading_day_count - len(daily_notional))
    notional_values = [daily_notional[day] for day in sorted(daily_notional)] + (
        [Decimal("0")] * notional_missing_day_count
    )
    regime_pass_rates = [
        _decimal(_scorecard(bundle).get("regime_slice_pass_rate"))
        for bundle in selected
    ]
    posterior_lowers = [
        _decimal(_scorecard(bundle).get("posterior_edge_lower")) for bundle in selected
    ]
    shadow_statuses = {
        _string(_scorecard(bundle).get("shadow_parity_status")) for bundle in selected
    }
    executable_artifact_refs = [
        ref
        for ref in (_executable_replay_artifact_ref(bundle) for bundle in selected)
        if ref
    ]
    exact_replay_ledger_artifact_refs = list(
        dict.fromkeys(
            ref
            for bundle in selected
            for ref in _exact_replay_ledger_artifact_refs(bundle)
        )
    )
    exact_replay_ledger_row_count = sum(
        _exact_replay_ledger_row_count(bundle) for bundle in selected
    )
    exact_replay_ledger_fill_count = sum(
        _exact_replay_ledger_fill_count(bundle) for bundle in selected
    )
    all_selected_have_ledger_pnl_basis = bool(selected) and all(
        _ledger_pnl_basis(bundle) == POST_COST_PNL_BASIS for bundle in selected
    )
    all_selected_have_ledger_pnl_source = bool(selected) and all(
        _ledger_pnl_source(bundle) in _ACCEPTED_LEDGER_PNL_SOURCES
        for bundle in selected
    )
    executable_order_count = sum(
        _executable_replay_order_count(bundle) for bundle in selected
    )
    executable_buying_powers = [
        _executable_replay_buying_power(bundle) for bundle in selected
    ]
    executable_max_notionals = [
        _executable_replay_max_notional(bundle) for bundle in selected
    ]
    market_impact_artifact_refs = [
        ref
        for ref in (_market_impact_stress_artifact_ref(bundle) for bundle in selected)
        if ref
    ]
    market_impact_stress_net_pnl_per_day = sum(
        (
            _market_impact_stress_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_artifact_refs = [
        ref
        for ref in (
            _delay_adjusted_depth_stress_artifact_ref(bundle) for bundle in selected
        )
        if ref
    ]
    delay_depth_stress_net_pnl_per_day = sum(
        (
            _delay_adjusted_depth_stress_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_fillable_notional_per_day = sum(
        (
            _delay_adjusted_depth_fillable_notional_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_worst_active_day_fillable_notional = sum(
        (
            _delay_adjusted_depth_worst_active_day_fillable_notional(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    delay_depth_p10_active_day_fillable_notional = sum(
        (
            _delay_adjusted_depth_p10_active_day_fillable_notional(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    fill_survival_evidence_present = bool(selected) and all(
        _fill_survival_evidence_present(bundle) for bundle in selected
    )
    fill_survival_sample_count = sum(
        _fill_survival_sample_count(bundle) for bundle in selected
    )
    fill_survival_rate = min(
        (_fill_survival_rate(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    queue_position_survival_evidence_present = bool(selected) and all(
        _queue_position_survival_evidence_present(bundle) for bundle in selected
    )
    queue_position_survival_sample_count = sum(
        _queue_position_survival_sample_count(bundle) for bundle in selected
    )
    queue_position_survival_fill_rate = min(
        (_queue_position_survival_fill_rate(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    queue_position_survival_queue_ratio_p95 = max(
        (_queue_position_survival_queue_ratio_p95(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    queue_ahead_depletion_evidence_present = bool(selected) and all(
        _queue_ahead_depletion_evidence_present(bundle) for bundle in selected
    )
    queue_ahead_depletion_sample_count = sum(
        _queue_ahead_depletion_sample_count(bundle) for bundle in selected
    )
    queue_position_survival_stress_net_pnl_per_day = sum(
        (
            _queue_position_survival_stress_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    double_oos_artifact_refs = [
        ref for ref in (_double_oos_artifact_ref(bundle) for bundle in selected) if ref
    ]
    double_oos_independent_window_count = min(
        (_double_oos_independent_window_count(bundle) for bundle in selected),
        default=0,
    )
    double_oos_pass_rate = min(
        (_double_oos_pass_rate(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    double_oos_net_pnl_per_day = sum(
        (
            _double_oos_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    double_oos_cost_shock_net_pnl_per_day = sum(
        (
            _double_oos_cost_shock_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    market_impact_models = sorted(
        {
            model
            for model in (_market_impact_stress_model(bundle) for bundle in selected)
            if model
        }
    )
    market_impact_components_by_sleeve = {
        bundle.candidate_id: dict(_market_impact_stress_components(bundle))
        for bundle in selected
        if _market_impact_stress_components(bundle)
    }
    market_impact_max_cost_bps = max(
        (_market_impact_stress_cost_bps(bundle) for bundle in selected),
        default=Decimal("0"),
    )
    implementation_uncertainty_required = any(
        _implementation_uncertainty_required(bundle) for bundle in selected
    )
    implementation_uncertainty_model_count = sum(
        _implementation_uncertainty_model_count(bundle) for bundle in selected
    )
    implementation_uncertainty_lower_net_pnl_per_day = sum(
        (
            _implementation_uncertainty_lower_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    implementation_uncertainty_upper_net_pnl_per_day = sum(
        (
            _implementation_uncertainty_upper_net_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    implementation_uncertainty_interval_width_per_day = sum(
        (
            _implementation_uncertainty_interval_width_per_day(bundle) * weight
            for bundle, weight in zip(selected, weights, strict=True)
        ),
        Decimal("0"),
    )
    sleeve_promotion_blockers: dict[str, list[str]] = {}
    promotion_contract_blockers: list[str] = []
    promotion_contract_blocker_observations: list[str] = []
    for bundle in selected:
        blockers = [
            str(blocker)
            for blocker in (
                *evidence_bundle_blockers(bundle),
                *cast(
                    Sequence[Any],
                    bundle.promotion_readiness.get("blockers") or (),
                ),
            )
            if str(blocker)
        ]
        if blockers:
            unique_blockers = list(dict.fromkeys(blockers))
            sleeve_promotion_blockers[bundle.candidate_id] = unique_blockers
            promotion_contract_blocker_observations.extend(blockers)
            promotion_contract_blockers.extend(unique_blockers)
    promotion_contract_blockers = list(dict.fromkeys(promotion_contract_blockers))
    scorecard = {
        "net_pnl_per_day": str(net_per_day),
        "portfolio_post_cost_net_pnl_per_day": str(net_per_day),
        "portfolio_post_cost_net_pnl_basis": POST_COST_PNL_BASIS
        if all_selected_have_ledger_pnl_basis
        else "",
        "portfolio_post_cost_net_pnl_source": PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE
        if all_selected_have_ledger_pnl_source
        else "",
        "runtime_ledger_pnl_basis": POST_COST_PNL_BASIS
        if all_selected_have_ledger_pnl_basis
        else "",
        "runtime_ledger_pnl_source": PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE
        if all_selected_have_ledger_pnl_source
        else "",
        "target_net_pnl_per_day": str(target_net_pnl_per_day),
        "target_met": net_per_day >= target_net_pnl_per_day,
        "portfolio_weighting_mode": _portfolio_weighting_mode(
            selected, oracle_policy=oracle_policy
        ),
        "portfolio_sleeve_weights": {
            bundle.candidate_id: str(weight)
            for bundle, weight in zip(selected, weights, strict=True)
        },
        "active_day_ratio": str(active_day_ratio),
        "positive_day_ratio": str(positive_day_ratio),
        "min_daily_net_pnl": str(min_day),
        "worst_day_loss": str(worst_day_loss),
        "max_drawdown": str(_max_drawdown_from_daily(daily_net)),
        "max_gross_exposure_pct_equity": str(
            _portfolio_max_gross_exposure_pct_equity(
                selected, oracle_policy=oracle_policy
            )
        ),
        "min_cash": str(_portfolio_min_cash(selected, oracle_policy=oracle_policy)),
        "negative_cash_observation_count": _portfolio_negative_cash_observation_count(
            selected
        ),
        "best_day_share": str(best_day_share),
        "max_single_day_contribution_share": str(best_day_share),
        "cluster_contribution_shares": {
            cluster: str(share) for cluster, share in sorted(cluster_shares.items())
        },
        "max_cluster_contribution_share": str(_max_share(cluster_shares)),
        "symbol_contribution_shares": {
            symbol: str(share) for symbol, share in sorted(symbol_shares.items())
        },
        "max_single_symbol_contribution_share": str(_max_share(symbol_shares)),
        "avg_filled_notional_per_day": str(_mean(notional_values)),
        "trading_day_count": trading_day_count,
        "daily_net_observed_day_count": len(daily_net),
        "missing_daily_net_count": missing_day_count,
        "missing_sleeve_daily_net_count": missing_sleeve_daily_net_count,
        "regime_slice_pass_rate": str(_mean(regime_pass_rates)),
        "posterior_edge_lower": str(min(posterior_lowers, default=Decimal("0"))),
        "shadow_parity_status": "within_budget"
        if shadow_statuses == {"within_budget"}
        else "missing",
        "executable_replay_passed": bool(selected)
        and all(_executable_replay_passed(bundle) for bundle in selected),
        "executable_replay_order_count": executable_order_count,
        "executable_replay_artifact_refs": executable_artifact_refs,
        "executable_replay_artifact_ref": executable_artifact_refs[0]
        if executable_artifact_refs
        else "",
        "exact_replay_ledger_artifact_refs": exact_replay_ledger_artifact_refs,
        "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_refs[0]
        if exact_replay_ledger_artifact_refs
        else "",
        "exact_replay_ledger_artifact_row_count": exact_replay_ledger_row_count,
        "exact_replay_ledger_artifact_fill_count": exact_replay_ledger_fill_count,
        "executable_replay_account_buying_power": str(
            min(executable_buying_powers, default=Decimal("0"))
        ),
        "executable_replay_max_notional_per_trade": str(
            max(executable_max_notionals, default=Decimal("0"))
        ),
        "market_impact_stress_passed": bool(selected)
        and all(_market_impact_stress_passed(bundle) for bundle in selected),
        "market_impact_stress_artifact_refs": market_impact_artifact_refs,
        "market_impact_stress_artifact_ref": market_impact_artifact_refs[0]
        if market_impact_artifact_refs
        else "",
        "market_impact_stress_model": "portfolio_nonlinear_impact",
        "market_impact_stress_models": market_impact_models,
        "market_impact_stress_cost_bps": str(market_impact_max_cost_bps),
        "market_impact_stress_components": {
            "selected_models": market_impact_models,
            "max_selected_cost_bps": str(market_impact_max_cost_bps),
            "sleeves": market_impact_components_by_sleeve,
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
        },
        "nonlinear_market_impact_stress_passed": bool(selected)
        and all(_market_impact_stress_passed(bundle) for bundle in selected),
        "nonlinear_market_impact_stress_model": "portfolio_nonlinear_impact",
        "nonlinear_market_impact_stress_cost_bps": str(market_impact_max_cost_bps),
        "nonlinear_market_impact_stress_net_pnl_per_day": str(
            market_impact_stress_net_pnl_per_day
        ),
        "market_impact_liquidity_evidence_present": bool(selected)
        and all(
            _market_impact_liquidity_evidence_present(bundle) for bundle in selected
        ),
        "market_impact_stress_net_pnl_per_day": str(
            market_impact_stress_net_pnl_per_day
        ),
        "implementation_uncertainty_required": implementation_uncertainty_required,
        "implementation_uncertainty_model": "portfolio_impact_latency_cost_interval",
        "implementation_uncertainty_model_count": implementation_uncertainty_model_count,
        "implementation_uncertainty_stability_passed": bool(selected)
        and all(
            _implementation_uncertainty_stability_passed(bundle) for bundle in selected
        )
        and (
            not implementation_uncertainty_required
            or implementation_uncertainty_lower_net_pnl_per_day
            >= target_net_pnl_per_day
        ),
        "implementation_uncertainty_lower_net_pnl_per_day": str(
            implementation_uncertainty_lower_net_pnl_per_day
        ),
        "implementation_uncertainty_upper_net_pnl_per_day": str(
            implementation_uncertainty_upper_net_pnl_per_day
        ),
        "implementation_uncertainty_interval_width_per_day": str(
            implementation_uncertainty_interval_width_per_day
        ),
        "implementation_uncertainty_target_net_pnl_per_day": str(
            target_net_pnl_per_day
        ),
        "implementation_uncertainty_source_markers": [
            "lob_simulation_reality_gap_arxiv_2603_24137_2026",
            "order_flow_market_impact_volatility_arxiv_2601_23172_2026",
            "implementation_risk_backtesting_arxiv_2603_20319_2026",
        ],
        "conformal_tail_risk_required": conformal_tail_risk_required,
        "conformal_tail_risk_model": "portfolio_empirical_daily_loss_conformal_buffer",
        "conformal_tail_risk_alpha": str(CONFORMAL_TAIL_RISK_ALPHA),
        "conformal_tail_risk_sample_count": len(values),
        "conformal_tail_risk_buffer_per_day": str(conformal_tail_risk_buffer_per_day),
        "conformal_tail_risk_adjusted_net_pnl_per_day": str(
            conformal_tail_risk_adjusted_net_pnl_per_day
        ),
        "conformal_tail_risk_target_net_pnl_per_day": str(target_net_pnl_per_day),
        "conformal_tail_risk_passed": conformal_tail_risk_passed,
        "conformal_tail_risk_source_markers": [
            "regime_weighted_conformal_var_arxiv_2602_03903_2026"
        ],
        "delay_adjusted_depth_stress_passed": bool(selected)
        and all(_delay_adjusted_depth_stress_passed(bundle) for bundle in selected),
        "delay_adjusted_depth_liquidity_evidence_present": bool(selected)
        and all(
            _delay_adjusted_depth_liquidity_evidence_present(bundle)
            for bundle in selected
        ),
        "delay_adjusted_depth_liquidity_missing_day_count": sum(
            _delay_adjusted_depth_liquidity_missing_day_count(bundle)
            for bundle in selected
        ),
        "delay_adjusted_depth_tail_coverage_passed": bool(selected)
        and all(
            _delay_adjusted_depth_tail_coverage_passed(bundle) for bundle in selected
        ),
        "delay_adjusted_depth_fill_survival_evidence_present": fill_survival_evidence_present,
        "delay_adjusted_depth_fill_survival_sample_count": fill_survival_sample_count,
        "delay_adjusted_depth_fill_survival_rate": str(fill_survival_rate),
        "fill_survival_evidence_present": fill_survival_evidence_present,
        "fill_survival_sample_count": fill_survival_sample_count,
        "fill_survival_fill_rate": str(fill_survival_rate),
        "queue_position_survival_fill_curve_evidence_present": (
            queue_position_survival_evidence_present
        ),
        "queue_position_survival_sample_count": (queue_position_survival_sample_count),
        "queue_position_survival_fill_rate": str(queue_position_survival_fill_rate),
        "queue_position_survival_queue_ratio_p95": str(
            queue_position_survival_queue_ratio_p95
        ),
        "queue_position_survival_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_position_survival_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_ahead_depletion_sample_count": queue_ahead_depletion_sample_count,
        "delay_adjusted_depth_stress_artifact_refs": delay_depth_artifact_refs,
        "delay_adjusted_depth_stress_artifact_ref": delay_depth_artifact_refs[0]
        if delay_depth_artifact_refs
        else "",
        "delay_adjusted_depth_stress_model": "portfolio_latency_depth_haircut",
        "delay_adjusted_depth_stress_ms": str(
            max(
                (_delay_adjusted_depth_stress_ms(bundle) for bundle in selected),
                default=Decimal("0"),
            )
        ),
        "delay_adjusted_depth_latency_grid_ms": ["50", "150", "250"],
        "delay_adjusted_depth_grid_max_stress_ms": "250",
        "delay_adjusted_depth_fillable_notional_per_day": str(
            delay_depth_fillable_notional_per_day
        ),
        "delay_adjusted_depth_worst_active_day_fillable_notional": str(
            delay_depth_worst_active_day_fillable_notional
        ),
        "delay_adjusted_depth_p10_active_day_fillable_notional": str(
            delay_depth_p10_active_day_fillable_notional
        ),
        "delay_adjusted_depth_stress_net_pnl_per_day": str(
            delay_depth_stress_net_pnl_per_day
        ),
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": str(
            queue_position_survival_stress_net_pnl_per_day
        ),
        "double_oos_passed": bool(selected)
        and all(_double_oos_passed(bundle) for bundle in selected),
        "double_oos_artifact_refs": double_oos_artifact_refs,
        "double_oos_artifact_ref": double_oos_artifact_refs[0]
        if double_oos_artifact_refs
        else "",
        "double_oos_independent_window_count": double_oos_independent_window_count,
        "double_oos_pass_rate": str(double_oos_pass_rate),
        "double_oos_net_pnl_per_day": str(double_oos_net_pnl_per_day),
        "double_oos_cost_shock_net_pnl_per_day": str(
            double_oos_cost_shock_net_pnl_per_day
        ),
        "daily_net": {day: str(value) for day, value in sorted(daily_net.items())},
        "daily_filled_notional": {
            day: str(value) for day, value in sorted(daily_notional.items())
        },
        "sleeve_promotion_readiness_blockers": sleeve_promotion_blockers,
        "promotion_contract_blockers": promotion_contract_blockers,
        "validation_contract_pending_count": sum(
            1
            for blocker in promotion_contract_blocker_observations
            if blocker == "validation_contract_pending"
        ),
        "validation_live_paper_parity_pending_count": sum(
            1
            for blocker in promotion_contract_blocker_observations
            if blocker == "validation_live_paper_parity_pending"
        ),
        "synthetic_evidence_not_promotion_proof_count": sum(
            1
            for blocker in promotion_contract_blocker_observations
            if blocker == "synthetic_evidence_not_promotion_proof"
        ),
    }
    scorecard["profit_target_oracle"] = evaluate_profit_target_oracle(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        policy=oracle_policy,
    )
    scorecard["oracle_passed"] = bool(scorecard["profit_target_oracle"]["passed"])
    return scorecard


def _sleeve_score(bundle: CandidateEvidenceBundle) -> Decimal:
    scorecard = _scorecard(bundle)
    deployable_lower_bound = deployable_lower_bound_net_pnl_per_day(scorecard)
    return (
        (
            deployable_lower_bound
            if deployable_lower_bound is not None
            else _net_per_day(bundle)
        )
        + (_active_ratio(bundle) * Decimal("300"))
        + (_positive_ratio(bundle) * Decimal("150"))
        - (_worst_day_loss(bundle) * Decimal("0.50"))
        - (_max_drawdown(bundle) * Decimal("0.10"))
        - (_best_day_share(bundle) * Decimal("300"))
    )


def _scorecard_decimal(scorecard: Mapping[str, Any], field: str) -> Decimal:
    return _decimal(scorecard.get(field))


def _oracle_blocker_count(scorecard: Mapping[str, Any]) -> Decimal:
    oracle = scorecard.get("profit_target_oracle")
    if not isinstance(oracle, Mapping):
        return Decimal("0")
    oracle_mapping = cast(Mapping[Any, Any], oracle)
    blockers = oracle_mapping.get("blockers")
    if isinstance(blockers, Sequence) and not isinstance(blockers, str):
        return Decimal(len(cast(Sequence[Any], blockers)))
    return Decimal("0")


def _portfolio_selection_key(
    *,
    selected: Sequence[CandidateEvidenceBundle],
    scorecard: Mapping[str, Any],
) -> tuple[Decimal, ...]:
    # Once no portfolio fully passes the oracle, the next best promotion target is
    # the one with the smallest repair surface, not the one with the largest raw PnL.
    return (
        Decimal(1 if bool(scorecard.get("oracle_passed")) else 0),
        -_oracle_blocker_count(scorecard),
        Decimal(1 if bool(scorecard.get("target_met")) else 0),
        _scorecard_decimal(scorecard, "active_day_ratio"),
        _scorecard_decimal(scorecard, "positive_day_ratio"),
        _scorecard_decimal(scorecard, "min_daily_net_pnl"),
        (
            deployable_lower_bound_net_pnl_per_day(scorecard)
            or _scorecard_decimal(scorecard, "net_pnl_per_day")
        ),
        Decimal(1 if bool(scorecard.get("market_impact_stress_passed")) else 0),
        _scorecard_decimal(scorecard, "market_impact_stress_net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "market_impact_stress_cost_bps"),
        Decimal(1 if bool(scorecard.get("delay_adjusted_depth_stress_passed")) else 0),
        _scorecard_decimal(scorecard, "delay_adjusted_depth_stress_net_pnl_per_day"),
        _scorecard_decimal(scorecard, "delay_adjusted_depth_fillable_notional_per_day"),
        -_scorecard_decimal(scorecard, "delay_adjusted_depth_stress_ms"),
        Decimal(
            1
            if bool(scorecard.get("implementation_uncertainty_stability_passed"))
            else 0
        ),
        _scorecard_decimal(
            scorecard, "implementation_uncertainty_lower_net_pnl_per_day"
        ),
        -_scorecard_decimal(
            scorecard, "implementation_uncertainty_interval_width_per_day"
        ),
        Decimal(1 if bool(scorecard.get("conformal_tail_risk_passed")) else 0),
        _scorecard_decimal(scorecard, "conformal_tail_risk_adjusted_net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "conformal_tail_risk_buffer_per_day"),
        Decimal(1 if bool(scorecard.get("double_oos_passed")) else 0),
        _scorecard_decimal(scorecard, "double_oos_independent_window_count"),
        _scorecard_decimal(scorecard, "double_oos_pass_rate"),
        _scorecard_decimal(scorecard, "double_oos_net_pnl_per_day"),
        _scorecard_decimal(scorecard, "double_oos_cost_shock_net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "missing_sleeve_daily_net_count"),
        -_scorecard_decimal(scorecard, "best_day_share"),
        -_scorecard_decimal(scorecard, "max_single_symbol_contribution_share"),
        -_scorecard_decimal(scorecard, "max_cluster_contribution_share"),
        _scorecard_decimal(scorecard, "avg_filled_notional_per_day"),
        _scorecard_decimal(scorecard, "net_pnl_per_day"),
        -_scorecard_decimal(scorecard, "max_gross_exposure_pct_equity"),
        _scorecard_decimal(scorecard, "min_cash"),
        -_scorecard_decimal(scorecard, "negative_cash_observation_count"),
        -_scorecard_decimal(scorecard, "worst_day_loss"),
        -_scorecard_decimal(scorecard, "max_drawdown"),
        Decimal(len(selected)),
        sum((_sleeve_score(bundle) for bundle in selected), Decimal("0")),
    )


def _empty_selection_key() -> tuple[Decimal, ...]:
    return (
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
    )


def _portfolio_addition_rejection(
    *,
    bundle: CandidateEvidenceBundle,
    selected: Sequence[CandidateEvidenceBundle],
    requested_portfolio_size_min: int,
    max_allowed_correlation: Decimal,
) -> dict[str, Any] | None:
    max_correlation = _max_pairwise_correlation(bundle, selected)
    if selected and max_correlation > max_allowed_correlation:
        return {
            "candidate_id": bundle.candidate_id,
            "reason": "correlation_cap",
            "max_pairwise_correlation": str(max_correlation),
        }
    return None


def _record_unique_rejection(
    rejected: list[dict[str, Any]],
    seen_rejections: set[tuple[str, str]],
    rejection: Mapping[str, Any],
) -> None:
    key = (_string(rejection.get("candidate_id")), _string(rejection.get("reason")))
    if key in seen_rejections:
        return
    seen_rejections.add(key)
    rejected.append(dict(rejection))


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
empty_selection_key = _empty_selection_key
oracle_blocker_count = _oracle_blocker_count
portfolio_addition_rejection = _portfolio_addition_rejection
portfolio_scorecard = _portfolio_scorecard
portfolio_selection_key = _portfolio_selection_key
portfolio_trading_day_count = _portfolio_trading_day_count
record_unique_rejection = _record_unique_rejection
scorecard_decimal = _scorecard_decimal
sleeve_score = _sleeve_score
