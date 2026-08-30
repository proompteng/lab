#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _mapping,
    _string,
    _list_of_mappings,
)

from scripts.whitepaper_autoresearch_runner.proposal_training import (
    _recent_trading_days_shortfall,
    _stale_tape_diagnostics,
)


def _candidate_search_remediation(
    *,
    failure_reason: str,
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    replay_timeout_seconds: int,
    max_frontier_candidates_per_spec: int,
    current_top_k: int = 16,
    current_exploration_slots: int = 8,
    current_portfolio_size_min: int = 2,
    current_max_candidates: int = 64,
    current_max_total_frontier_candidates: int = 0,
    current_train_days: int = 6,
    current_holdout_days: int = 3,
    current_second_oos_days: int = 2,
) -> dict[str, Any]:
    failure_counts: dict[str, int] = {}
    for row in _list_of_mappings(list(false_positive_table)):
        for reason in cast(Sequence[Any], row.get("failure_reasons") or ()):
            reason_text = _string(reason)
            if reason_text:
                failure_counts[reason_text] = failure_counts.get(reason_text, 0) + 1

    partial_scorecards = [
        dict(bundle.objective_scorecard) for bundle in evidence_bundles
    ]
    selected_rows = [
        row
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if bool(row.get("selected_for_replay"))
    ]
    selected_but_missing = [
        row
        for row in _list_of_mappings(list(false_positive_table))
        if row.get("evidence_status") == "missing"
    ]
    selection_budget = _mapping(candidate_selection.get("budget"))

    def budget_int(name: str, default: int = 0) -> int:
        try:
            return int(selection_budget.get(name, default) or default)
        except (TypeError, ValueError):
            return default

    observed_selection_budget = {
        "compiled_candidate_count": budget_int("compiled_candidate_count"),
        "unique_execution_signature_count": budget_int(
            "unique_execution_signature_count"
        ),
        "eligible_candidate_count": budget_int("eligible_candidate_count"),
        "pre_replay_feedback_blocked_candidate_count": budget_int(
            "pre_replay_feedback_blocked_candidate_count"
        ),
        "pre_replay_nonpositive_synthetic_candidate_count": budget_int(
            "pre_replay_nonpositive_synthetic_candidate_count"
        ),
        "pre_replay_blocked_candidate_count": budget_int(
            "pre_replay_blocked_candidate_count"
        ),
        "selected_count": budget_int("selected_count", len(selected_rows)),
        "max_candidates": budget_int("max_candidates", current_max_candidates),
        "top_k": budget_int("top_k", current_top_k),
        "exploration_slots": budget_int(
            "exploration_slots_effective",
            budget_int("exploration_slots", current_exploration_slots),
        ),
    }
    unique_execution_signature_count = observed_selection_budget[
        "unique_execution_signature_count"
    ]
    candidate_surface_exhausted = (
        unique_execution_signature_count > 0
        and observed_selection_budget["selected_count"]
        >= unique_execution_signature_count
        and observed_selection_budget["max_candidates"]
        >= unique_execution_signature_count
        and observed_selection_budget["top_k"]
        + observed_selection_budget["exploration_slots"]
        >= unique_execution_signature_count
    )
    replayable_candidate_surface_exhausted = (
        observed_selection_budget["eligible_candidate_count"] > 0
        and observed_selection_budget["selected_count"]
        >= observed_selection_budget["eligible_candidate_count"]
        and observed_selection_budget["max_candidates"]
        >= observed_selection_budget["eligible_candidate_count"]
        and observed_selection_budget["top_k"]
        + observed_selection_budget["exploration_slots"]
        >= observed_selection_budget["eligible_candidate_count"]
    )
    next_actions: list[dict[str, Any]] = []
    recent_day_shortfall = _recent_trading_days_shortfall(failure_reason)
    recent_day_diagnostics: dict[str, Any] | None = None
    if recent_day_shortfall is not None:
        signal_recent_days_query = (
            "SELECT toDate(event_ts) AS trading_day, count() AS rows, "
            "min(event_ts) AS first_event_ts, max(event_ts) AS last_event_ts "
            "FROM torghut.ta_signals WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day ORDER BY trading_day DESC LIMIT 20"
        )
        signal_microbar_coverage_query = (
            "SELECT table_name, countDistinct(trading_day) AS days, "
            "min(trading_day) AS first_day, max(trading_day) AS last_day, sum(rows) AS rows "
            "FROM ("
            "SELECT 'ta_signals' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_signals WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day UNION ALL "
            "SELECT 'ta_microbars' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_microbars WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day"
            ") GROUP BY table_name ORDER BY table_name"
        )
        signal_microbar_day_gap_query = (
            "SELECT trading_day, "
            "sumIf(rows, table_name = 'ta_signals') AS signal_rows, "
            "sumIf(rows, table_name = 'ta_microbars') AS microbar_rows "
            "FROM ("
            "SELECT 'ta_signals' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_signals WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day UNION ALL "
            "SELECT 'ta_microbars' AS table_name, toDate(event_ts) AS trading_day, count() AS rows "
            "FROM torghut.ta_microbars WHERE source = 'ta' AND window_size = 'PT1S' "
            "GROUP BY trading_day"
            ") GROUP BY trading_day ORDER BY trading_day DESC LIMIT 40"
        )
        recent_day_diagnostics = {
            **recent_day_shortfall,
            "required_window": {
                "train_days": max(1, int(current_train_days)),
                "holdout_days": max(1, int(current_holdout_days)),
                "second_oos_days": max(0, int(current_second_oos_days)),
            },
            "clickhouse_recent_days_query": signal_recent_days_query,
            "clickhouse_signal_microbar_coverage_query": signal_microbar_coverage_query,
            "clickhouse_signal_microbar_day_gap_query": signal_microbar_day_gap_query,
            "clickhouse_coverage_probe_queries": {
                "ta_signals_recent_days": signal_recent_days_query,
                "signal_microbar_coverage": signal_microbar_coverage_query,
                "signal_microbar_day_gap": signal_microbar_day_gap_query,
            },
        }
        next_actions.append(
            {
                "priority": 1,
                "action": "inspect_or_backfill_recent_ta_signal_days",
                "reason": (
                    "real replay cannot build the requested train/holdout/double-OOS "
                    "window from available TA PT1S signal days"
                ),
                "recent_trading_days": recent_day_diagnostics,
                "recommended_operator_probe": recent_day_diagnostics[
                    "clickhouse_recent_days_query"
                ],
                "recommended_coverage_probe": recent_day_diagnostics[
                    "clickhouse_signal_microbar_coverage_query"
                ],
                "recommended_day_gap_probe": recent_day_diagnostics[
                    "clickhouse_signal_microbar_day_gap_query"
                ],
                "recommended_archive_probe": (
                    "python services/torghut/scripts/archive_recent_kafka_trading_days.py "
                    "--archive-root $ARCHIVE_ROOT --scan-root $HISTORICAL_RUN_ROOT --json"
                ),
            }
        )
    stale_tape = _stale_tape_diagnostics(failure_reason)
    if stale_tape is not None:
        next_actions.append(
            {
                "priority": 1,
                "action": "inspect_or_backfill_latest_ta_signal_day",
                "reason": (
                    "real replay freshness gate rejected the tape because the latest "
                    "available TA day is older than the expected last trading day"
                ),
                "stale_tape": stale_tape,
                "recommended_operator_probe": (
                    "SELECT source, window_size, countDistinct(toDate(event_ts)) AS days, "
                    "min(toDate(event_ts)) AS first_day, max(toDate(event_ts)) AS last_day, "
                    "count() AS rows FROM torghut.ta_signals GROUP BY source, window_size "
                    "ORDER BY days DESC, rows DESC"
                ),
                "diagnostic_replay_note": (
                    "For a read-only stale-tape diagnostic replay, pass "
                    "--expected-last-trading-day "
                    f"{stale_tape['available_end_day']} instead of using live freshness proof."
                ),
            }
        )
    if (
        observed_selection_budget["selected_count"] <= 0
        and observed_selection_budget["pre_replay_feedback_blocked_candidate_count"] > 0
    ):
        next_actions.append(
            {
                "priority": 1,
                "action": "expand_or_mutate_strategy_surface_after_feedback_blocks_all_candidates",
                "reason": (
                    "pre-replay feedback vetoed every eligible execution profile; "
                    "the next epoch needs new sleeves or materially different execution signatures"
                ),
                "observed_selection_budget": observed_selection_budget,
                "recommended_code_change": (
                    "mutate strategy templates, sleeves, or execution/risk profiles before replaying "
                    "the same blocked signatures again"
                ),
            }
        )
    if (
        observed_selection_budget["selected_count"] <= 0
        and observed_selection_budget[
            "pre_replay_nonpositive_synthetic_candidate_count"
        ]
        > 0
    ):
        next_actions.append(
            {
                "priority": 2,
                "action": "expand_or_mutate_strategy_surface_after_negative_mlx_prior",
                "reason": (
                    "the pre-replay model assigned nonpositive expected value to every synthetic-prior "
                    "candidate; wider replay would only spend budget on unpromising candidates"
                ),
                "observed_selection_budget": observed_selection_budget,
                "recommended_code_change": (
                    "add new candidate families, sleeves, or feature/risk variants that can earn a "
                    "positive pre-replay expected value before real replay"
                ),
            }
        )
    if next_actions:
        next_actions.sort(key=lambda row: int(row.get("priority") or 10**6))
        return {
            "schema_version": "torghut.whitepaper-autoresearch-remediation.v1",
            "failure_reason": failure_reason,
            "partial_evidence_bundle_count": len(evidence_bundles),
            "selected_for_replay_count": len(selected_rows),
            "selected_missing_evidence_count": len(selected_but_missing),
            "failure_reason_counts": dict(sorted(failure_counts.items())),
            "partial_scorecards": partial_scorecards,
            "candidate_surface_exhausted": candidate_surface_exhausted,
            "replayable_candidate_surface_exhausted": replayable_candidate_surface_exhausted,
            "observed_selection_budget": observed_selection_budget,
            "recent_trading_days": recent_day_diagnostics,
            "stale_tape": stale_tape,
            "next_actions": next_actions,
        }
    if "TimeoutError:real_replay_timeout_seconds" in failure_reason:
        current_per_spec = max(1, int(max_frontier_candidates_per_spec))
        retry_per_spec = (
            max(1, min(4, current_per_spec // 4)) if current_per_spec > 2 else 1
        )
        next_actions.append(
            {
                "priority": 1,
                "action": "shrink_per_spec_frontier_or_extend_timeout",
                "reason": "real replay timed out before all selected candidate specs emitted evidence",
                "recommended_flags": {
                    "--max-frontier-candidates-per-spec": str(retry_per_spec),
                    "--real-replay-timeout-seconds": str(
                        max(replay_timeout_seconds * 2, 900)
                        if replay_timeout_seconds > 0
                        else 900
                    ),
                },
            }
        )
    if selected_but_missing:
        next_actions.append(
            {
                "priority": 2,
                "action": "replay_missing_selected_specs_individually",
                "reason": "some high-ranked specs were selected but did not produce replay evidence",
                "candidate_spec_ids": [
                    _string(row.get("candidate_spec_id"))
                    for row in selected_but_missing[:8]
                    if _string(row.get("candidate_spec_id"))
                ],
            }
        )
    promotion_proof_failures = (
        "shadow_parity_status_not_within_budget",
        "executable_replay_not_passed",
        "executable_replay_artifact_missing",
        "executable_replay_order_count_below_oracle",
        "executable_replay_account_buying_power_missing",
        "executable_replay_max_notional_missing",
        "executable_replay_notional_exceeds_buying_power",
        "market_impact_stress_passed_failed",
        "market_impact_stress_artifact_present_failed",
        "market_impact_liquidity_evidence_present_failed",
        "market_impact_stress_model_failed",
        "market_impact_stress_cost_bps_failed",
        "market_impact_stress_net_pnl_per_day_failed",
        "delay_adjusted_depth_stress_passed_failed",
        "delay_adjusted_depth_stress_artifact_present_failed",
        "delay_adjusted_depth_stress_model_failed",
        "delay_adjusted_depth_stress_ms_failed",
        "delay_adjusted_depth_fillable_notional_per_day_failed",
        "delay_adjusted_depth_stress_net_pnl_per_day_failed",
        "double_oos_passed_failed",
        "double_oos_artifact_present_failed",
        "double_oos_independent_window_count_failed",
        "double_oos_pass_rate_failed",
        "double_oos_net_pnl_per_day_failed",
        "double_oos_cost_shock_net_pnl_per_day_failed",
    )
    proof_failure_counts = {
        reason: count
        for reason, count in failure_counts.items()
        if reason in promotion_proof_failures
    }
    non_proof_failure_counts = {
        reason: count
        for reason, count in failure_counts.items()
        if reason not in promotion_proof_failures
    }
    if proof_failure_counts:
        proof_action: dict[str, Any] = {
            "priority": 3 if not non_proof_failure_counts else 7,
            "action": "complete_runtime_closure_double_oos_and_shadow_evidence",
            "reason": (
                "replayed candidates are missing runtime-closure double-OOS, cost-stressed, executable replay, or shadow evidence required by the oracle"
                if not non_proof_failure_counts
                else "runtime-closure double-OOS and promotion evidence is required, but current candidates still fail profit or risk gates"
            ),
            "blocking_failure_counts": proof_failure_counts,
            "required_scorecard_fields": [
                "shadow_parity_status",
                "executable_replay_passed",
                "executable_replay_artifact_ref",
                "executable_replay_order_count",
                "executable_replay_account_buying_power",
                "executable_replay_max_notional_per_trade",
                "market_impact_stress_passed",
                "market_impact_stress_artifact_ref",
                "market_impact_liquidity_evidence_present",
                "market_impact_stress_model",
                "market_impact_stress_cost_bps",
                "market_impact_stress_net_pnl_per_day",
                "delay_adjusted_depth_stress_passed",
                "delay_adjusted_depth_stress_artifact_ref",
                "delay_adjusted_depth_stress_model",
                "delay_adjusted_depth_stress_ms",
                "delay_adjusted_depth_fillable_notional_per_day",
                "delay_adjusted_depth_stress_net_pnl_per_day",
                "double_oos_passed",
                "double_oos_artifact_ref",
                "double_oos_independent_window_count",
                "double_oos_pass_rate",
                "double_oos_net_pnl_per_day",
                "double_oos_cost_shock_net_pnl_per_day",
            ],
        }
        if non_proof_failure_counts:
            proof_action["deferred_until"] = (
                "portfolio_profit_and_risk_oracle_failures_clear"
            )
            proof_action["blocked_by_non_proof_failure_counts"] = dict(
                sorted(non_proof_failure_counts.items())
            )
        next_actions.append(proof_action)
    if any(
        reason in failure_counts
        for reason in (
            "active_day_ratio_below_oracle",
            "positive_day_ratio_below_oracle",
        )
    ):
        if candidate_surface_exhausted or replayable_candidate_surface_exhausted:
            selected_families = sorted(
                {
                    _string(row.get("family_template_id"))
                    for row in selected_rows
                    if _string(row.get("family_template_id"))
                }
            )
            next_actions.append(
                {
                    "priority": 4,
                    "action": "expand_execution_profile_surface",
                    "reason": (
                        (
                            "candidate selection replayed every currently eligible execution signature; "
                            "pre-replay feedback, capital, or expected-value gates blocked the rest"
                        )
                        if replayable_candidate_surface_exhausted
                        and not candidate_surface_exhausted
                        else (
                            "candidate selection replayed every unique execution signature; "
                            "max-candidates, top-k, and exploration-slots are no longer binding"
                        )
                    ),
                    "observed_selection_budget": observed_selection_budget,
                    "target_family_template_ids": selected_families,
                    "recommended_code_change": (
                        "add risk-diversified execution profiles, sleeves, or family mappings "
                        "before spending another epoch on wider selection flags"
                    ),
                }
            )
        else:
            next_top_k = min(
                max(1, current_max_candidates),
                max(16, current_top_k + max(4, current_exploration_slots)),
            )
            next_exploration_slots = min(
                max(1, current_max_candidates),
                max(8, current_exploration_slots + max(4, current_exploration_slots)),
            )
            next_max_candidates = max(
                current_max_candidates,
                next_top_k + next_exploration_slots,
                min(128, current_max_candidates + 32),
            )
            recommended_flags = {
                "--max-candidates": str(next_max_candidates),
                "--top-k": str(next_top_k),
                "--exploration-slots": str(next_exploration_slots),
                "--portfolio-size-min": str(max(3, current_portfolio_size_min)),
            }
            if current_max_total_frontier_candidates > 0:
                recommended_flags["--max-total-frontier-candidates"] = str(
                    max(
                        current_max_total_frontier_candidates,
                        min(128, current_max_total_frontier_candidates * 2),
                    )
                )
            next_actions.append(
                {
                    "priority": 4,
                    "action": "increase_breadth_and_portfolio_diversity",
                    "reason": "replayed candidates had flat or non-positive days",
                    "recommended_flags": recommended_flags,
                }
            )
    if any(
        reason in failure_counts
        for reason in (
            "non_positive_net_pnl_per_day",
            "worst_day_loss_above_oracle",
            "max_drawdown_above_oracle",
        )
    ):
        next_actions.append(
            {
                "priority": 5,
                "action": "pivot_family_mix_away_from_failed_exposures",
                "reason": "partial replay evidence failed profit or risk gates",
                "recommended_review_fields": [
                    "family_template_id",
                    "runtime_strategy_name",
                    "daily_net",
                    "symbol_contribution_shares",
                ],
            }
        )
    if best_false_negative_table:
        next_actions.append(
            {
                "priority": 6,
                "action": "expand_exploration_for_unreplayed_high_ranked_specs",
                "reason": "ranked specs were not replayed because of budget",
                "candidate_spec_ids": [
                    _string(row.get("candidate_spec_id"))
                    for row in _list_of_mappings(list(best_false_negative_table))[:8]
                    if _string(row.get("candidate_spec_id"))
                ],
            }
        )
    if not next_actions:
        next_actions.append(
            {
                "priority": 1,
                "action": "inspect_partial_artifacts_before_next_epoch",
                "reason": "failure did not match a known replay remediation pattern",
            }
        )

    next_actions.sort(key=lambda row: int(row.get("priority") or 10**6))
    return {
        "schema_version": "torghut.whitepaper-autoresearch-remediation.v1",
        "failure_reason": failure_reason,
        "partial_evidence_bundle_count": len(evidence_bundles),
        "selected_for_replay_count": len(selected_rows),
        "selected_missing_evidence_count": len(selected_but_missing),
        "failure_reason_counts": dict(sorted(failure_counts.items())),
        "partial_scorecards": partial_scorecards,
        "candidate_surface_exhausted": candidate_surface_exhausted,
        "replayable_candidate_surface_exhausted": replayable_candidate_surface_exhausted,
        "observed_selection_budget": observed_selection_budget,
        "recent_trading_days": recent_day_diagnostics,
        "stale_tape": stale_tape,
        "next_actions": next_actions,
    }


__all__ = [
    "_candidate_search_remediation",
]
