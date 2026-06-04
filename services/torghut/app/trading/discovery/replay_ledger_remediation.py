"""Turn exact replay ledger blockers into the next honest search actions."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, cast

EXACT_REPLAY_LEDGER_REMEDIATION_SCHEMA_VERSION = (
    "torghut.exact-replay-ledger-remediation.v1"
)

_RUNTIME_PROMOTION_EVIDENCE = (
    "runtime_closure_bundle_with_scheduler_v3_parity",
    "live_or_live_paper_runtime_ledger_rows_with_order_lifecycle",
    "post_cost_net_pnl_after_costs_over_policy_window",
    "promotion_readiness_json_with_no_blockers",
)
_RUNTIME_ACTIVITY_BLOCKERS = frozenset(
    {
        "runtime_decision_lifecycle_missing",
        "submitted_order_lifecycle_missing",
        "runtime_order_count_zero",
        "runtime_trade_count_zero",
        "runtime_fills_missing",
        "filled_notional_missing",
        "runtime_ledger_filled_notional_missing",
    }
)
_RUNTIME_CLOSURE_BLOCKERS = frozenset(
    {
        "closed_round_trip_missing",
        "runtime_ledger_open_position_count_missing",
        "unclosed_position",
    }
)
_EXECUTION_QUALITY_ACTIONS = {
    "order_type_mix_evidence_incomplete": (
        "collect_order_type_mix_evidence",
        "exact replay rows do not fully label market/limit order selection",
        ["record_selected_order_type", "preserve_order_type_on_fill_rows"],
    ),
    "fill_order_type_evidence_incomplete": (
        "preserve_fill_order_type_evidence",
        "fills cannot be attributed to market/limit order type choices",
        ["join_fills_to_submitted_order_type", "preserve_order_id_on_fills"],
    ),
    "execution_shortfall_evidence_incomplete": (
        "collect_route_tca_shortfall_evidence",
        "route TCA/shortfall is required before execution quality can influence collection",
        ["route_tca_bps", "execution_shortfall_bps", "arrival_shortfall_bps"],
    ),
    "limit_fill_probability_evidence_incomplete": (
        "collect_limit_fill_probability_evidence",
        "limit-order candidates need real fill-probability evidence",
        ["limit_fill_probability", "survival_fill_probability", "fill_probability"],
    ),
    "queue_position_survival_evidence_incomplete": (
        "collect_queue_position_survival_fill_curve_evidence",
        "queue-position/time-to-fill evidence is missing for limit-order candidates",
        ["queue_position", "queue_ahead_qty", "time_to_fill_seconds"],
    ),
    "price_improvement_evidence_incomplete": (
        "collect_limit_order_price_improvement_evidence",
        "passive order price improvement is unverified",
        ["price_improvement_bps", "realized_price_improvement_bps"],
    ),
    "nonfill_opportunity_cost_evidence_incomplete": (
        "collect_nonfill_opportunity_cost_evidence",
        "patient limit orders need missed-fill opportunity-cost evidence",
        ["nonfill_opportunity_cost_bps", "missed_fill_opportunity_cost_bps"],
    ),
    "limit_fill_rate_below_execution_quality_floor": (
        "tighten_or_downrank_low_fill_limit_policy",
        "observed limit-fill rate is below the execution-quality floor",
        ["raise_limit_fill_probability_floor", "compare_market_vs_limit_ablation"],
    ),
    "execution_shortfall_bps_above_quality_floor": (
        "downrank_high_shortfall_execution_policy",
        "realized shortfall is above the execution-quality floor",
        ["lower_market_order_share", "route_tca_ablation", "spread_state_filter"],
    ),
    "nonfill_opportunity_cost_bps_above_quality_floor": (
        "downrank_high_opportunity_cost_limit_policy",
        "missed-fill opportunity cost is above the execution-quality floor",
        ["cancel_replace_age_grid", "marketable_limit_fallback", "urgency_response"],
    ),
}


def build_replay_ledger_remediation_report(
    ranking_report: Mapping[str, Any],
) -> dict[str, Any]:
    """Build a deterministic next-step report from a replay ledger ranking report."""

    policy = _mapping(ranking_report.get("policy"))
    candidates = _candidate_mappings(ranking_report.get("candidates"))
    best_candidate = candidates[0] if candidates else None
    if best_candidate is None:
        return {
            "schema_version": EXACT_REPLAY_LEDGER_REMEDIATION_SCHEMA_VERSION,
            "status": "blocked_no_exact_replay_ledger_candidates",
            "promotion_allowed": False,
            "ranking_schema_version": _string(ranking_report.get("schema_version")),
            "candidate_id": None,
            "artifact_ref": None,
            "promotion_status": None,
            "promotion_blockers": ["exact_replay_ledger_candidate_missing"],
            "runtime_ledger_blockers": [],
            "required_evidence": list(_RUNTIME_PROMOTION_EVIDENCE),
            "metric_snapshot": _metric_snapshot({}, policy),
            "recommended_objective_adjustments": {
                "ranking_basis": "full_window_post_cost_net_pnl_per_day",
                "evidence_basis": "exact_replay_ledger_rows",
            },
            "recommended_search_actions": [
                {
                    "action": "produce_exact_replay_ledger_artifacts",
                    "reason": "no_rankable_runtime_ledger_rows_found",
                    "parameter_hints": [
                        "enable_exact_replay_ledger_output",
                        "inspect_experiment_result_refs",
                    ],
                }
            ],
            "blocker_remediations": [],
        }

    promotion_blockers = _string_list(best_candidate.get("promotion_blockers"))
    runtime_blockers = _string_list(best_candidate.get("runtime_ledger_blockers"))
    execution_quality_blockers = _string_list(
        best_candidate.get("execution_quality_blockers")
    )
    blockers = _dedupe([*promotion_blockers, *runtime_blockers])
    blocker_remediations = [
        _blocker_remediation(blocker, best_candidate=best_candidate, policy=policy)
        for blocker in blockers
    ]
    execution_quality_actions = [
        _execution_quality_remediation(blocker, best_candidate=best_candidate)
        for blocker in execution_quality_blockers
    ]
    status = (
        "blocked_pending_runtime_promotion_proof"
        if not _has_search_blockers(promotion_blockers, runtime_blockers)
        else "blocked_pending_search_remediation"
    )

    return {
        "schema_version": EXACT_REPLAY_LEDGER_REMEDIATION_SCHEMA_VERSION,
        "status": status,
        "promotion_allowed": False,
        "ranking_schema_version": _string(ranking_report.get("schema_version")),
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "artifact_ref": _string(best_candidate.get("artifact_ref")),
        "promotion_status": _string(best_candidate.get("promotion_status")),
        "promotion_blockers": promotion_blockers,
        "runtime_ledger_blockers": runtime_blockers,
        "execution_quality_blockers": execution_quality_blockers,
        "execution_quality": _mapping(best_candidate.get("execution_quality")),
        "required_evidence": list(_RUNTIME_PROMOTION_EVIDENCE),
        "metric_snapshot": _metric_snapshot(best_candidate, policy),
        "recommended_objective_adjustments": _recommended_objective_adjustments(
            blockers=promotion_blockers,
            policy=policy,
        ),
        "recommended_search_actions": _recommended_search_actions(
            blockers=blockers,
            best_candidate=best_candidate,
            policy=policy,
        )
        + execution_quality_actions,
        "blocker_remediations": blocker_remediations + execution_quality_actions,
    }


def _has_search_blockers(
    promotion_blockers: Sequence[str],
    runtime_blockers: Sequence[str],
) -> bool:
    non_search_blockers = {"replay_artifact_only_not_live"}
    return any(
        blocker not in non_search_blockers for blocker in promotion_blockers
    ) or bool(runtime_blockers)


def _recommended_objective_adjustments(
    *,
    blockers: Sequence[str],
    policy: Mapping[str, Any],
) -> dict[str, str]:
    adjustments: dict[str, str] = {
        "ranking_basis": "full_window_post_cost_net_pnl_per_day",
        "evidence_basis": "exact_replay_ledger_rows",
    }
    if "window_net_pnl_per_day_below_target" in blockers:
        adjustments["target_net_pnl_per_day"] = _string(
            policy.get("target_net_pnl_per_day")
        )
    if "avg_filled_notional_per_day_below_min" in blockers:
        adjustments["min_avg_filled_notional_per_day"] = _string(
            policy.get("min_avg_filled_notional_per_day")
        )
    if "best_day_share_above_max" in blockers:
        adjustments["max_best_day_share"] = _string(policy.get("max_best_day_share"))
    if "max_single_fill_notional_pct_equity_above_max" in blockers:
        adjustments["max_gross_exposure_pct_equity"] = _string(
            policy.get("max_gross_exposure_pct_equity")
        )
    if "window_weekday_count_below_min_observed_trading_days" in blockers:
        adjustments["min_window_weekday_count"] = _string(
            policy.get("min_window_weekday_count")
        )
    return {key: value for key, value in adjustments.items() if value != ""}


def _recommended_search_actions(
    *,
    blockers: Sequence[str],
    best_candidate: Mapping[str, Any],
    policy: Mapping[str, Any],
) -> list[dict[str, Any]]:
    if not blockers:
        return [
            {
                "action": "start_runtime_paper_validation",
                "reason": "exact_replay_policy_checks_passed_but_runtime_proof_missing",
                "parameter_hints": ["scheduler_v3_parity", "live_paper_runtime_ledger"],
            }
        ]
    return [
        _blocker_remediation(blocker, best_candidate=best_candidate, policy=policy)
        for blocker in blockers
    ]


def _blocker_remediation(
    blocker: str,
    *,
    best_candidate: Mapping[str, Any],
    policy: Mapping[str, Any],
) -> dict[str, Any]:
    if blocker == "replay_artifact_only_not_live":
        return {
            "blocker": blocker,
            "action": "run_runtime_closure_then_live_paper_ledger_validation",
            "reason": "replay_ledgers_are_research_evidence_not_promotion_authority",
            "parameter_hints": [
                "runtime_closure",
                "scheduler_v3_parity",
                "live_paper_runtime_ledger",
            ],
        }
    if blocker == "window_weekday_count_below_min_observed_trading_days":
        return {
            "blocker": blocker,
            "action": "extend_full_window_or_supply_longer_manifest_verified_tape",
            "reason": "ranked_candidate_window_is_too_short_for_policy",
            "observed": _string(best_candidate.get("window_weekday_count")),
            "threshold": _string(policy.get("min_window_weekday_count")),
            "parameter_hints": [
                "increase_full_window_days",
                "set_full_window_start_date_and_end_date",
                "materialize_replay_tape",
            ],
        }
    if blocker == "window_net_pnl_per_day_below_target":
        return {
            "blocker": blocker,
            "action": "bias_search_to_full_window_net_pnl_per_day_not_active_day_only",
            "reason": "candidate_does_not_reach_policy_daily_profit_after_costs",
            "observed": _string(best_candidate.get("window_net_pnl_per_day")),
            "threshold": _string(policy.get("target_net_pnl_per_day")),
            "required_multiplier": _required_multiplier(
                observed=best_candidate.get("window_net_pnl_per_day"),
                threshold=policy.get("target_net_pnl_per_day"),
            ),
            "parameter_hints": [
                "increase_candidate_breadth",
                "rank_by_window_net_pnl_per_day",
                "keep_post_cost_objective",
            ],
        }
    if blocker == "avg_filled_notional_per_day_below_min":
        return {
            "blocker": blocker,
            "action": "increase_tradeable_breadth_without_raising_single_fill_exposure",
            "reason": "candidate_does_not_generate_enough_daily_filled_notional",
            "observed": _string(
                best_candidate.get("avg_filled_notional_per_window_weekday")
            ),
            "threshold": _string(policy.get("min_avg_filled_notional_per_day")),
            "required_multiplier": _required_multiplier(
                observed=best_candidate.get("avg_filled_notional_per_window_weekday"),
                threshold=policy.get("min_avg_filled_notional_per_day"),
            ),
            "parameter_hints": [
                "expand_symbol_universe",
                "increase_top_n_candidates",
                "increase_proposal_batch_size",
                "keep_exposure_cap_active",
            ],
        }
    if blocker == "best_day_share_above_max":
        return {
            "blocker": blocker,
            "action": "penalize_single_day_pnl_concentration",
            "reason": "too_much_profit_comes_from_one_day",
            "observed": _string(best_candidate.get("best_day_share")),
            "threshold": _string(policy.get("max_best_day_share")),
            "parameter_hints": [
                "lower_best_day_share_weight",
                "increase_regime_diversity",
                "prefer_portfolio_sleeves",
            ],
        }
    if blocker == "max_single_fill_notional_pct_equity_above_max":
        return {
            "blocker": blocker,
            "action": "cap_per_fill_notional_before_scaling_notional",
            "reason": "single_fill_exposure_is_above_policy_limit",
            "observed": _string(
                best_candidate.get("max_single_fill_notional_pct_equity")
            ),
            "threshold": _string(policy.get("max_gross_exposure_pct_equity")),
            "parameter_hints": [
                "reduce_max_position_notional_pct_equity",
                "slice_orders",
                "do_not_scale_candidate_until_exposure_passes",
            ],
        }
    if blocker == "start_equity_missing_for_exposure_check":
        return {
            "blocker": blocker,
            "action": "rerun_ranking_with_start_equity",
            "reason": "exposure_gate_cannot_be_evaluated_without_equity",
            "parameter_hints": ["set_start_equity"],
        }
    if blocker in _RUNTIME_ACTIVITY_BLOCKERS:
        return {
            "blocker": blocker,
            "action": "increase_runtime_activity_without_raising_single_fill_exposure",
            "reason": "candidate_or_route_did_not_generate_enough_runtime_decisions_fills_or_notional",
            "observed": _string(
                best_candidate.get("avg_filled_notional_per_window_weekday")
                or best_candidate.get("filled_notional")
                or best_candidate.get("fill_count")
            ),
            "threshold": _string(policy.get("min_avg_filled_notional_per_day")),
            "required_multiplier": _required_multiplier(
                observed=best_candidate.get("avg_filled_notional_per_window_weekday")
                or best_candidate.get("filled_notional"),
                threshold=policy.get("min_avg_filled_notional_per_day"),
            ),
            "parameter_hints": [
                "increase_tradeable_breadth",
                "lower_entry_cooldown_within_bounds",
                "keep_single_fill_exposure_cap_active",
                "do_not_promote_without_runtime_fills",
            ],
        }
    if blocker in _RUNTIME_CLOSURE_BLOCKERS:
        return {
            "blocker": blocker,
            "action": "force_intraday_closure_for_followup_replay",
            "reason": "candidate_did_not_produce_closed_round_trips_required_for_runtime_ledger_authority",
            "observed": _string(
                best_candidate.get("closed_trade_count")
                or best_candidate.get("open_position_count")
            ),
            "threshold": "closed_trade_count>0 and open_position_count=0",
            "parameter_hints": [
                "add_numeric_exit_minute_before_close",
                "cap_max_hold_seconds",
                "require_closed_round_trips",
                "do_not_promote_open_positions",
            ],
        }
    return {
        "blocker": blocker,
        "action": "fix_runtime_ledger_or_policy_blocker_before_research_continues",
        "reason": "unmapped_replay_ledger_blocker",
        "parameter_hints": ["inspect_exact_replay_ledger_rows", "inspect_policy"],
    }


def _execution_quality_remediation(
    blocker: str,
    *,
    best_candidate: Mapping[str, Any],
) -> dict[str, Any]:
    action, reason, hints = _EXECUTION_QUALITY_ACTIONS.get(
        blocker,
        (
            "inspect_execution_quality_blocker",
            "execution-quality blocker has no specific remediation mapping yet",
            ["inspect_execution_quality"],
        ),
    )
    return {
        "blocker": blocker,
        "action": action,
        "reason": reason,
        "observed_penalty_bps": _string(
            best_candidate.get("execution_quality_penalty_bps")
        ),
        "adjusted_window_net_pnl_per_day": _string(
            best_candidate.get("execution_quality_adjusted_window_net_pnl_per_day")
        ),
        "authority": "research_ranking_only_final_promotion_still_requires_runtime_ledger",
        "parameter_hints": list(hints),
    }


def _metric_snapshot(
    best_candidate: Mapping[str, Any],
    policy: Mapping[str, Any],
) -> dict[str, str]:
    keys = {
        "target_net_pnl_per_day": policy.get("target_net_pnl_per_day"),
        "window_net_pnl_per_day": best_candidate.get("window_net_pnl_per_day"),
        "active_net_pnl_per_day": best_candidate.get("active_net_pnl_per_day"),
        "total_net_pnl_after_costs": best_candidate.get("total_net_pnl_after_costs"),
        "min_window_weekday_count": policy.get("min_window_weekday_count"),
        "window_weekday_count": best_candidate.get("window_weekday_count"),
        "min_avg_filled_notional_per_day": policy.get(
            "min_avg_filled_notional_per_day"
        ),
        "avg_filled_notional_per_window_weekday": best_candidate.get(
            "avg_filled_notional_per_window_weekday"
        ),
        "max_best_day_share": policy.get("max_best_day_share"),
        "best_day_share": best_candidate.get("best_day_share"),
        "max_gross_exposure_pct_equity": policy.get("max_gross_exposure_pct_equity"),
        "max_single_fill_notional_pct_equity": best_candidate.get(
            "max_single_fill_notional_pct_equity"
        ),
        "start_equity": policy.get("start_equity"),
    }
    return {key: _string(value) for key, value in keys.items() if _string(value)}


def _required_multiplier(*, observed: object, threshold: object) -> str | None:
    observed_decimal = _decimal(observed)
    threshold_decimal = _decimal(threshold)
    if observed_decimal is None or threshold_decimal is None or observed_decimal <= 0:
        return None
    return str(threshold_decimal / observed_decimal)


def _candidate_mappings(value: object) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    sequence = cast(Sequence[object], value)
    return tuple(
        cast(Mapping[str, Any], item) for item in sequence if isinstance(item, Mapping)
    )


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    sequence = cast(Sequence[object], value)
    return [parsed for item in sequence if (parsed := _string(item))]


def _dedupe(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _string(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _decimal(value: object) -> Decimal | None:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
