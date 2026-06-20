#!/usr/bin/env python3
"""Build objective scorecards for consistent profitability frontier candidates."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.dataset_snapshot import DatasetSnapshotReceipt
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.family_templates import FamilyTemplate
from app.trading.discovery.objectives import (
    CandidateObjectiveScorecard,
    ObjectiveVetoPolicy,
    build_scorecard,
    evaluate_vetoes,
)
from app.trading.reporting import (
    ProfitabilityConstraintPolicy,
    ReplayProfitabilitySummary,
    summarize_replay_profitability,
)

from scripts.consistent_profitability_frontier.candidate_loading import (
    FrontierReplayWindows,
    _replay_window_coverage_payload,
)
from scripts.consistent_profitability_frontier.candidate_repairs import (
    _selected_normalization_regime,
)
from scripts.consistent_profitability_frontier.common import (
    FullWindowConsistencyPolicy,
    _daily_filled_notional,
    _max_drawdown_from_daily_net,
    _nonnegative_int_metric,
    _optional_decimal,
)
from scripts.consistent_profitability_frontier.handoff_diagnostics import (
    _symbol_contributions_from_replay_payload,
)
from scripts.consistent_profitability_frontier.ledger_order import (
    _order_lifecycle_metrics,
    _order_type_execution_metrics,
)
from scripts.consistent_profitability_frontier.scoring_ranking import (
    _rolling_lower_bound,
)
from scripts.consistent_profitability_frontier.stress_metrics import (
    _holdout_oos_passed,
    _max_best_day_share_of_total_pnl,
)


@dataclass(frozen=True)
class CandidateScorecardResult:
    symbol_contributions: Any
    hard_vetoes: list[str]


@dataclass(frozen=True)
class CandidateScorecardInput:
    args: argparse.Namespace
    candidate_payload: dict[str, Any]
    full_window_payload: Mapping[str, Any]
    full_window_summary: Mapping[str, Any]
    family_template: FamilyTemplate
    override_candidate: Mapping[str, Any]
    window: FrontierReplayWindows
    dataset_snapshot_receipt: DatasetSnapshotReceipt
    replay_tape_validation: Mapping[str, Any] | None
    replay_lineage: Mapping[str, Any]
    order_type_ablation_update: Mapping[str, Any]
    exact_replay_ledger_update: Mapping[str, Any]
    second_oos_summary: Mapping[str, Any] | None
    holdout_payload: Mapping[str, Any]
    holdout_policy: ProfitabilityConstraintPolicy
    train_screen_failures: Sequence[str]
    full_replay_skip_reasons: Sequence[str]
    consistency_policy: FullWindowConsistencyPolicy
    objective_veto_policy: ObjectiveVetoPolicy


@dataclass(frozen=True)
class _CandidateScorecardCore:
    symbol_contributions: Any
    normalization_regime: str
    decomposition: Any
    summary: ReplayProfitabilitySummary
    objective_scorecard: CandidateObjectiveScorecard
    hard_vetoes: list[str]


def _build_candidate_scorecard_core(
    inputs: CandidateScorecardInput,
) -> _CandidateScorecardCore:
    i = inputs
    symbol_contributions = _symbol_contributions_from_replay_payload(
        i.full_window_payload
    )
    if symbol_contributions:
        i.candidate_payload["symbol_contributions"] = symbol_contributions
    normalization_regime = _selected_normalization_regime(
        strategy_overrides=i.override_candidate,
        template_allowed_normalizations=i.family_template.allowed_normalizations,
    )
    decomposition = build_replay_decomposition(
        replay_payload=i.full_window_payload,
        family_id=i.family_template.family_id,
        normalization_regime=normalization_regime,
    )
    summary = summarize_replay_profitability(i.full_window_payload)
    total_filled_notional = sum(
        _daily_filled_notional(i.full_window_payload).values(),
        Decimal("0"),
    )
    positive_days = sum(1 for value in summary.daily_net.values() if value > 0)
    negative_days = sum(1 for value in summary.daily_net.values() if value < 0)
    fill_survival_sample_count = max(
        _nonnegative_int_metric(
            i.full_window_summary.get("delay_adjusted_depth_fill_survival_sample_count")
        ),
        _nonnegative_int_metric(
            i.full_window_summary.get("fill_survival_sample_count")
        ),
        _nonnegative_int_metric(
            i.full_window_summary.get("queue_position_survival_sample_count")
        ),
    )
    fill_survival_rate = (
        _optional_decimal(
            i.full_window_summary.get("delay_adjusted_depth_fill_survival_rate")
        )
        or _optional_decimal(i.full_window_summary.get("fill_survival_fill_rate"))
        or _optional_decimal(
            i.full_window_summary.get("queue_position_survival_fill_rate")
        )
        or Decimal("0")
    )
    objective_scorecard = build_scorecard(
        candidate_id=str(i.candidate_payload["candidate_id"]),
        trading_day_count=summary.trading_day_count,
        net_pnl_per_day=summary.net_per_day,
        active_days=summary.active_days,
        positive_days=positive_days,
        avg_filled_notional_per_day=(
            total_filled_notional / Decimal(summary.trading_day_count)
            if summary.trading_day_count > 0
            else Decimal("0")
        ),
        avg_filled_notional_per_active_day=(
            total_filled_notional / Decimal(summary.active_days)
            if summary.active_days > 0
            else Decimal("0")
        ),
        worst_day_loss=abs(summary.worst_day_net)
        if summary.worst_day_net < 0
        else Decimal("0"),
        max_drawdown=_max_drawdown_from_daily_net(summary.daily_net),
        best_day_share=_max_best_day_share_of_total_pnl(
            daily_net=summary.daily_net,
            total_net_pnl=summary.net_pnl,
        ),
        negative_day_count=negative_days,
        rolling_3d_lower_bound=_rolling_lower_bound(summary.daily_net, window=3),
        rolling_5d_lower_bound=_rolling_lower_bound(summary.daily_net, window=5),
        regime_slice_pass_rate=regime_slice_pass_rate(decomposition),
        symbol_concentration_share=max_symbol_concentration_share(decomposition),
        entry_family_contribution_share=max_family_contribution_share(decomposition),
        max_gross_exposure_pct_equity=Decimal(
            str(i.full_window_summary.get("max_gross_exposure_pct_equity", "0"))
        ),
        min_cash=Decimal(str(i.full_window_summary.get("min_cash", "0"))),
        negative_cash_observation_count=int(
            i.full_window_summary.get("negative_cash_observation_count") or 0
        ),
        fill_survival_sample_count=fill_survival_sample_count,
        fill_survival_rate=fill_survival_rate,
    )
    hard_vetoes = list(
        evaluate_vetoes(
            objective_scorecard,
            policy=i.objective_veto_policy,
            is_fresh=(
                i.dataset_snapshot_receipt.is_fresh or bool(i.args.allow_stale_tape)
            ),
        )
    )
    hard_vetoes.extend(i.train_screen_failures)
    hard_vetoes.extend(i.full_replay_skip_reasons)
    if i.second_oos_summary is not None:
        hard_vetoes.extend(
            str(reason)
            for reason in cast(Sequence[Any], i.second_oos_summary.get("reasons") or ())
        )
    if (
        i.consistency_policy.min_daily_net_pnl > 0
        and int(i.full_window_summary.get("daily_net_below_min_count") or 0) > 0
    ):
        hard_vetoes.append("daily_net_below_min")
    if (
        i.consistency_policy.min_window_weekday_count > 0
        and int(i.full_window_summary.get("trading_day_count") or 0)
        < i.consistency_policy.min_window_weekday_count
    ):
        hard_vetoes.append("window_weekday_count_below_min_observed_trading_days")
    if not bool(i.full_window_summary.get("conformal_tail_risk_passed")):
        hard_vetoes.append("conformal_tail_risk_below_target")
    if not bool(i.full_window_summary.get("breakeven_transaction_cost_buffer_passed")):
        hard_vetoes.append("breakeven_transaction_cost_buffer_below_target")
    if (
        objective_scorecard.symbol_concentration_share
        > i.consistency_policy.max_symbol_concentration_share
    ):
        hard_vetoes.append("symbol_concentration_above_max")
    if (
        objective_scorecard.entry_family_contribution_share
        > i.consistency_policy.max_entry_family_contribution_share
    ):
        hard_vetoes.append("entry_family_contribution_above_max")
    return _CandidateScorecardCore(
        symbol_contributions=symbol_contributions,
        normalization_regime=normalization_regime,
        decomposition=decomposition,
        summary=summary,
        objective_scorecard=objective_scorecard,
        hard_vetoes=hard_vetoes,
    )


def _candidate_objective_scorecard_payload(
    inputs: CandidateScorecardInput,
    core: _CandidateScorecardCore,
) -> dict[str, Any]:
    i = inputs
    objective_scorecard_payload = core.objective_scorecard.to_payload()
    replay_tape_validation_status = str(
        (i.replay_tape_validation or {}).get("status") or ""
    ).lower()
    tape_freshness_status = replay_tape_validation_status
    if replay_tape_validation_status in {"stale_override", "stale"}:
        tape_freshness_status = "stale"
    elif replay_tape_validation_status == "valid":
        tape_freshness_status = "fresh"
    objective_scorecard_payload.update(
        {
            "dataset_freshness_status": (
                "fresh" if i.dataset_snapshot_receipt.is_fresh else "stale"
            ),
            "stale_override_used": bool(i.dataset_snapshot_receipt.stale_override_used),
            "replay_tape_validation_status": replay_tape_validation_status,
            "tape_freshness_status": tape_freshness_status,
            "market_impact_liquidity_evidence_present": bool(
                i.full_window_summary.get("market_impact_liquidity_evidence_present")
            ),
            "market_impact_liquidity_day_count": int(
                i.full_window_summary.get("market_impact_liquidity_day_count") or 0
            ),
            "market_impact_liquidity_missing_day_count": int(
                i.full_window_summary.get("market_impact_liquidity_missing_day_count")
                or 0
            ),
            "market_impact_stress_passed": bool(
                i.full_window_summary.get("market_impact_stress_passed")
            ),
            "market_impact_stress_model": str(
                i.full_window_summary.get("market_impact_stress_model") or ""
            ),
            "market_impact_stress_cost_bps": str(
                i.full_window_summary.get("market_impact_stress_cost_bps") or "0"
            ),
            "market_impact_stress_net_pnl_per_day": str(
                i.full_window_summary.get("market_impact_stress_net_pnl_per_day") or "0"
            ),
            "market_impact_stress_components": dict(
                cast(
                    Mapping[str, Any],
                    i.full_window_summary.get("market_impact_stress_components") or {},
                )
            ),
            "nonlinear_market_impact_stress_passed": bool(
                i.full_window_summary.get("nonlinear_market_impact_stress_passed")
            ),
            "nonlinear_market_impact_stress_model": str(
                i.full_window_summary.get("nonlinear_market_impact_stress_model") or ""
            ),
            "nonlinear_market_impact_stress_cost_bps": str(
                i.full_window_summary.get("nonlinear_market_impact_stress_cost_bps")
                or "0"
            ),
            "nonlinear_market_impact_stress_net_pnl_per_day": str(
                i.full_window_summary.get(
                    "nonlinear_market_impact_stress_net_pnl_per_day"
                )
                or "0"
            ),
            "permanent_impact_decay_model": str(
                i.full_window_summary.get("permanent_impact_decay_model") or ""
            ),
            "delay_adjusted_depth_stress_passed": bool(
                i.full_window_summary.get("delay_adjusted_depth_stress_passed")
            ),
            "delay_adjusted_depth_stress_model": str(
                i.full_window_summary.get("delay_adjusted_depth_stress_model") or ""
            ),
            "delay_adjusted_depth_stress_ms": str(
                i.full_window_summary.get("delay_adjusted_depth_stress_ms") or "0"
            ),
            "delay_adjusted_depth_latency_grid_ms": list(
                cast(
                    Sequence[Any],
                    i.full_window_summary.get("delay_adjusted_depth_latency_grid_ms")
                    or (),
                )
            ),
            "delay_adjusted_depth_grid_max_stress_ms": str(
                i.full_window_summary.get("delay_adjusted_depth_grid_max_stress_ms")
                or "0"
            ),
            "delay_adjusted_depth_liquidity_evidence_present": bool(
                i.full_window_summary.get(
                    "delay_adjusted_depth_liquidity_evidence_present"
                )
            ),
            "delay_adjusted_depth_liquidity_missing_day_count": int(
                i.full_window_summary.get(
                    "delay_adjusted_depth_liquidity_missing_day_count"
                )
                or 0
            ),
            "delay_adjusted_depth_fillable_notional_per_day": str(
                i.full_window_summary.get(
                    "delay_adjusted_depth_fillable_notional_per_day"
                )
                or "0"
            ),
            "delay_adjusted_depth_worst_grid_fillable_notional_per_day": str(
                i.full_window_summary.get(
                    "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
                )
                or "0"
            ),
            "delay_adjusted_depth_worst_active_day_fillable_notional": str(
                i.full_window_summary.get(
                    "delay_adjusted_depth_worst_active_day_fillable_notional"
                )
                or "0"
            ),
            "delay_adjusted_depth_p10_active_day_fillable_notional": str(
                i.full_window_summary.get(
                    "delay_adjusted_depth_p10_active_day_fillable_notional"
                )
                or "0"
            ),
            "delay_adjusted_depth_tail_coverage_passed": bool(
                i.full_window_summary.get("delay_adjusted_depth_tail_coverage_passed")
            ),
            "delay_adjusted_depth_fillable_ratio": str(
                i.full_window_summary.get("delay_adjusted_depth_fillable_ratio") or "0"
            ),
            "delay_adjusted_depth_survival_adjusted_fillable_ratio": str(
                i.full_window_summary.get(
                    "delay_adjusted_depth_survival_adjusted_fillable_ratio"
                )
                or "0"
            ),
            "delay_adjusted_depth_unfillable_notional_per_day": str(
                i.full_window_summary.get(
                    "delay_adjusted_depth_unfillable_notional_per_day"
                )
                or "0"
            ),
            "delay_adjusted_depth_fill_survival_evidence_present": bool(
                i.full_window_summary.get(
                    "delay_adjusted_depth_fill_survival_evidence_present"
                )
            ),
            "delay_adjusted_depth_fill_survival_sample_count": int(
                i.full_window_summary.get(
                    "delay_adjusted_depth_fill_survival_sample_count"
                )
                or 0
            ),
            "delay_adjusted_depth_fill_survival_rate": str(
                i.full_window_summary.get("delay_adjusted_depth_fill_survival_rate")
                or ""
            ),
            "delay_adjusted_depth_queue_ratio_p95": str(
                i.full_window_summary.get("delay_adjusted_depth_queue_ratio_p95") or ""
            ),
            "queue_position_survival_fill_curve_evidence_present": bool(
                i.full_window_summary.get(
                    "queue_position_survival_fill_curve_evidence_present"
                )
            ),
            "queue_position_survival_sample_count": int(
                i.full_window_summary.get("queue_position_survival_sample_count") or 0
            ),
            "queue_position_survival_fill_rate": str(
                i.full_window_summary.get("queue_position_survival_fill_rate") or ""
            ),
            "queue_position_survival_queue_ratio_p95": str(
                i.full_window_summary.get("queue_position_survival_queue_ratio_p95")
                or ""
            ),
            "queue_position_survival_queue_ahead_depletion_evidence_present": bool(
                i.full_window_summary.get(
                    "queue_position_survival_queue_ahead_depletion_evidence_present"
                )
            ),
            "queue_position_survival_queue_ahead_depletion_sample_count": int(
                i.full_window_summary.get(
                    "queue_position_survival_queue_ahead_depletion_sample_count"
                )
                or 0
            ),
            "queue_position_survival_adjusted_fillable_ratio": str(
                i.full_window_summary.get(
                    "queue_position_survival_adjusted_fillable_ratio"
                )
                or "0"
            ),
            "queue_position_survival_nonfill_opportunity_cost_per_day": str(
                i.full_window_summary.get(
                    "queue_position_survival_nonfill_opportunity_cost_per_day"
                )
                or "0"
            ),
            "queue_position_survival_nonfill_opportunity_cost_bps": str(
                i.full_window_summary.get(
                    "queue_position_survival_nonfill_opportunity_cost_bps"
                )
                or "0"
            ),
            "queue_position_survival_stress_net_pnl_per_day": str(
                i.full_window_summary.get(
                    "queue_position_survival_stress_net_pnl_per_day"
                )
                or "0"
            ),
            "post_cost_net_pnl_after_queue_position_survival_fill_stress": str(
                i.full_window_summary.get(
                    "post_cost_net_pnl_after_queue_position_survival_fill_stress"
                )
                or i.full_window_summary.get(
                    "queue_position_survival_stress_net_pnl_per_day"
                )
                or "0"
            ),
            "queue_position_survival_source_marker": str(
                i.full_window_summary.get("queue_position_survival_source_marker") or ""
            ),
            "delay_adjusted_depth_stress_net_pnl_per_day": str(
                i.full_window_summary.get("delay_adjusted_depth_stress_net_pnl_per_day")
                or "0"
            ),
            "implementation_uncertainty_required": bool(
                i.full_window_summary.get("implementation_uncertainty_required")
            ),
            "implementation_uncertainty_model": str(
                i.full_window_summary.get("implementation_uncertainty_model") or ""
            ),
            "implementation_uncertainty_model_count": int(
                i.full_window_summary.get("implementation_uncertainty_model_count") or 0
            ),
            "implementation_uncertainty_stability_passed": bool(
                i.full_window_summary.get("implementation_uncertainty_stability_passed")
            ),
            "implementation_uncertainty_lower_net_pnl_per_day": str(
                i.full_window_summary.get(
                    "implementation_uncertainty_lower_net_pnl_per_day"
                )
                or "0"
            ),
            "implementation_uncertainty_upper_net_pnl_per_day": str(
                i.full_window_summary.get(
                    "implementation_uncertainty_upper_net_pnl_per_day"
                )
                or "0"
            ),
            "implementation_uncertainty_interval_width_per_day": str(
                i.full_window_summary.get(
                    "implementation_uncertainty_interval_width_per_day"
                )
                or "0"
            ),
            "implementation_uncertainty_target_net_pnl_per_day": str(
                i.full_window_summary.get(
                    "implementation_uncertainty_target_net_pnl_per_day"
                )
                or "0"
            ),
            "implementation_uncertainty_scenarios": dict(
                cast(
                    Mapping[str, Any],
                    i.full_window_summary.get("implementation_uncertainty_scenarios")
                    or {},
                )
            ),
            "implementation_uncertainty_source_markers": list(
                cast(
                    Sequence[Any],
                    i.full_window_summary.get(
                        "implementation_uncertainty_source_markers"
                    )
                    or (),
                )
            ),
            "conformal_tail_risk_required": bool(
                i.full_window_summary.get("conformal_tail_risk_required")
            ),
            "conformal_tail_risk_model": str(
                i.full_window_summary.get("conformal_tail_risk_model") or ""
            ),
            "conformal_tail_risk_alpha": str(
                i.full_window_summary.get("conformal_tail_risk_alpha") or "0"
            ),
            "conformal_tail_risk_sample_count": int(
                i.full_window_summary.get("conformal_tail_risk_sample_count") or 0
            ),
            "conformal_tail_risk_buffer_per_day": str(
                i.full_window_summary.get("conformal_tail_risk_buffer_per_day") or "0"
            ),
            "conformal_tail_risk_adjusted_net_pnl_per_day": str(
                i.full_window_summary.get(
                    "conformal_tail_risk_adjusted_net_pnl_per_day"
                )
                or "0"
            ),
            "conformal_tail_risk_target_net_pnl_per_day": str(
                i.full_window_summary.get("conformal_tail_risk_target_net_pnl_per_day")
                or "0"
            ),
            "conformal_tail_risk_passed": bool(
                i.full_window_summary.get("conformal_tail_risk_passed")
            ),
            "conformal_tail_risk_source_markers": list(
                cast(
                    Sequence[Any],
                    i.full_window_summary.get("conformal_tail_risk_source_markers")
                    or (),
                )
            ),
            "required_breakeven_transaction_cost_buffer": bool(
                i.full_window_summary.get("required_breakeven_transaction_cost_buffer")
            ),
            "required_seed_model_family_robustness": bool(
                i.full_window_summary.get("required_seed_model_family_robustness")
            ),
            "breakeven_transaction_cost_buffer_passed": bool(
                i.full_window_summary.get("breakeven_transaction_cost_buffer_passed")
            ),
            "breakeven_transaction_cost_buffer_bps": str(
                i.full_window_summary.get("breakeven_transaction_cost_buffer_bps")
                or "0"
            ),
            "transaction_cost_buffer_bps": str(
                i.full_window_summary.get("transaction_cost_buffer_bps") or "0"
            ),
            "transaction_cost_buffer_cost_per_day": str(
                i.full_window_summary.get("transaction_cost_buffer_cost_per_day") or "0"
            ),
            "post_cost_net_pnl_after_breakeven_transaction_cost_buffer": str(
                i.full_window_summary.get(
                    "post_cost_net_pnl_after_breakeven_transaction_cost_buffer"
                )
                or "0"
            ),
            "breakeven_transaction_cost_buffer_target_net_pnl_per_day": str(
                i.full_window_summary.get(
                    "breakeven_transaction_cost_buffer_target_net_pnl_per_day"
                )
                or "0"
            ),
            "breakeven_transaction_cost_buffer_source_markers": list(
                cast(
                    Sequence[Any],
                    i.full_window_summary.get(
                        "breakeven_transaction_cost_buffer_source_markers"
                    )
                    or (),
                )
            ),
            "seed_model_family_robustness_status": str(
                i.full_window_summary.get("seed_model_family_robustness_status") or ""
            ),
            "seed_robustness_passed": bool(
                i.full_window_summary.get("seed_robustness_passed")
            ),
            "seed_robustness_sample_count": int(
                i.full_window_summary.get("seed_robustness_sample_count") or 0
            ),
            "model_family_robustness_passed": bool(
                i.full_window_summary.get("model_family_robustness_passed")
            ),
            "model_family_robustness_family_count": int(
                i.full_window_summary.get("model_family_robustness_family_count") or 0
            ),
            "seed_model_family_robustness_source_markers": list(
                cast(
                    Sequence[Any],
                    i.full_window_summary.get(
                        "seed_model_family_robustness_source_markers"
                    )
                    or (),
                )
            ),
            "replay_lineage": i.replay_lineage,
            "replay_window_coverage": _replay_window_coverage_payload(i.replay_lineage),
            **_order_type_execution_metrics(i.full_window_summary),
            **_order_lifecycle_metrics(i.full_window_payload),
        }
    )
    objective_scorecard_payload.update(i.order_type_ablation_update)
    objective_scorecard_payload.update(i.exact_replay_ledger_update)
    if i.second_oos_summary is not None:
        holdout_oos_passed = _holdout_oos_passed(
            holdout_payload=i.holdout_payload,
            policy=i.holdout_policy,
        )
        second_oos_passed = bool(i.second_oos_summary.get("passed"))
        oos_pass_count = int(holdout_oos_passed) + int(second_oos_passed)
        objective_scorecard_payload.update(
            {
                "double_oos_passed": oos_pass_count == 2,
                "double_oos_independent_window_count": 2,
                "double_oos_pass_rate": str(Decimal(oos_pass_count) / Decimal("2")),
                "double_oos_net_pnl_per_day": str(
                    i.second_oos_summary.get("net_per_day", "0")
                ),
                "holdout_oos_passed": holdout_oos_passed,
                "second_oos_net_pnl_per_day": str(
                    i.second_oos_summary.get("net_per_day", "0")
                ),
                "second_oos_decision_count": int(
                    i.second_oos_summary.get("decision_count") or 0
                ),
                "second_oos_filled_count": int(
                    i.second_oos_summary.get("filled_count") or 0
                ),
                "second_oos_reasons": list(
                    cast(
                        Sequence[Any],
                        i.second_oos_summary.get("reasons") or (),
                    )
                ),
            }
        )
    return objective_scorecard_payload


def attach_candidate_objective_scorecard(
    inputs: CandidateScorecardInput,
) -> CandidateScorecardResult:
    core = _build_candidate_scorecard_core(inputs)
    inputs.candidate_payload["decomposition"] = core.decomposition.to_payload()
    inputs.candidate_payload["normalization_regime"] = core.normalization_regime
    inputs.candidate_payload["objective_scorecard"] = (
        _candidate_objective_scorecard_payload(inputs, core)
    )
    inputs.candidate_payload["hard_vetoes"] = sorted(dict.fromkeys(core.hard_vetoes))
    return CandidateScorecardResult(
        symbol_contributions=core.symbol_contributions,
        hard_vetoes=core.hard_vetoes,
    )


__all__ = [
    "CandidateScorecardInput",
    "CandidateScorecardResult",
    "attach_candidate_objective_scorecard",
]
