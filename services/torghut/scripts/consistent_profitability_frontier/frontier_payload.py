"""Frontier ranking and payload assembly helpers."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
    rank_scorecards,
)
from app.trading.reporting import ProfitabilityConstraintPolicy
from scripts.search_profitability_frontier import _SWEEP_SCHEMA_VERSION

from scripts.consistent_profitability_frontier.common import (
    _SECOND_OOS_WINDOW_ID,
    FullWindowConsistencyPolicy,
    _mapping,
    _nonnegative_int_metric,
    _optional_decimal,
)
from scripts.consistent_profitability_frontier.paper_probation import (
    _build_paper_probation_shortlist,
    _candidate_exact_replay_ledger_artifact_refs,
    _candidate_metric_value,
    _candidate_runtime_ledger_count,
    _safe_decimal,
)

_SAFE_EXACT_REPLAY_CANDIDATE_CAP = 6


def _rank_scored_candidates(scored: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not scored:
        return []

    def promotion_grade_lower_bound(scorecard: Mapping[str, Any]) -> Decimal:
        lower_bound = deployable_lower_bound_net_pnl_per_day(scorecard)
        if lower_bound is None:
            return Decimal("0")
        if (
            deployable_lower_bound_missing_count(scorecard) > 0
            or deployable_proof_failed_gate_count(scorecard) > 0
        ):
            return Decimal("0")
        return lower_bound

    scorecards = {
        str(item["candidate_id"]): build_scorecard(
            candidate_id=str(item["candidate_id"]),
            trading_day_count=int(item["full_window"]["trading_day_count"]),
            net_pnl_per_day=Decimal(
                str(item["objective_scorecard"]["net_pnl_per_day"])
            ),
            active_days=int(
                Decimal(str(item["objective_scorecard"]["active_day_ratio"]))
                * Decimal(str(item["full_window"]["trading_day_count"]))
            ),
            positive_days=int(
                Decimal(str(item["objective_scorecard"]["positive_day_ratio"]))
                * Decimal(str(item["full_window"]["trading_day_count"]))
            ),
            avg_filled_notional_per_day=Decimal(
                str(item["objective_scorecard"]["avg_filled_notional_per_day"])
            ),
            avg_filled_notional_per_active_day=Decimal(
                str(item["objective_scorecard"]["avg_filled_notional_per_active_day"])
            ),
            worst_day_loss=Decimal(str(item["objective_scorecard"]["worst_day_loss"])),
            max_drawdown=Decimal(str(item["objective_scorecard"]["max_drawdown"])),
            best_day_share=Decimal(str(item["objective_scorecard"]["best_day_share"])),
            negative_day_count=int(item["objective_scorecard"]["negative_day_count"]),
            rolling_3d_lower_bound=Decimal(
                str(item["objective_scorecard"]["rolling_3d_lower_bound"])
            ),
            rolling_5d_lower_bound=Decimal(
                str(item["objective_scorecard"]["rolling_5d_lower_bound"])
            ),
            regime_slice_pass_rate=Decimal(
                str(item["objective_scorecard"]["regime_slice_pass_rate"])
            ),
            symbol_concentration_share=Decimal(
                str(item["objective_scorecard"]["symbol_concentration_share"])
            ),
            entry_family_contribution_share=Decimal(
                str(item["objective_scorecard"]["entry_family_contribution_share"])
            ),
            max_gross_exposure_pct_equity=Decimal(
                str(
                    item["objective_scorecard"].get(
                        "max_gross_exposure_pct_equity", "0"
                    )
                )
            ),
            min_cash=Decimal(str(item["objective_scorecard"].get("min_cash", "0"))),
            negative_cash_observation_count=int(
                item["objective_scorecard"].get("negative_cash_observation_count") or 0
            ),
            fill_survival_sample_count=max(
                _nonnegative_int_metric(
                    item["objective_scorecard"].get(
                        "delay_adjusted_depth_fill_survival_sample_count"
                    )
                ),
                _nonnegative_int_metric(
                    item["objective_scorecard"].get("fill_survival_sample_count")
                ),
                _nonnegative_int_metric(
                    item["objective_scorecard"].get(
                        "queue_position_survival_sample_count"
                    )
                ),
            ),
            fill_survival_rate=(
                _optional_decimal(
                    item["objective_scorecard"].get(
                        "delay_adjusted_depth_fill_survival_rate"
                    )
                )
                or _optional_decimal(
                    item["objective_scorecard"].get("fill_survival_fill_rate")
                )
                or _optional_decimal(
                    item["objective_scorecard"].get("queue_position_survival_fill_rate")
                )
                or Decimal("0")
            ),
            deployable_lower_bound_net_pnl_per_day=promotion_grade_lower_bound(
                cast(Mapping[str, Any], item["objective_scorecard"])
            ),
        )
        for item in scored
    }
    ranked_scorecards = rank_scorecards(
        scorecards.values(),
        veto_lookup={
            str(item["candidate_id"]): tuple(
                cast(list[str], item.get("hard_vetoes") or [])
            )
            for item in scored
        },
    )
    ranked_lookup = {item.candidate_id: item for item in ranked_scorecards}
    ranked_items = [dict(item) for item in scored]
    for item in ranked_items:
        ranked = ranked_lookup[str(item["candidate_id"])]
        original_scorecard = dict(cast(Mapping[str, Any], item["objective_scorecard"]))
        item["objective_scorecard"] = {
            **original_scorecard,
            **ranked.to_payload(),
            "deployable_lower_bound_missing_count": deployable_lower_bound_missing_count(
                original_scorecard
            ),
            "deployable_lower_bound_failed_gate_count": (
                deployable_proof_failed_gate_count(original_scorecard)
            ),
        }
        item["ranking"] = {
            "method": "pareto_frontier_v2",
            "pareto_tier": ranked.pareto_tier,
            "tie_breaker_score": str(ranked.tie_breaker_score),
            "vetoed": bool(ranked.veto_reasons),
        }
    ranked_items.sort(
        key=lambda item: (
            bool(item["ranking"]["vetoed"]),
            int(item["ranking"]["pareto_tier"]),
            -Decimal(str(item["ranking"]["tie_breaker_score"])),
            -Decimal(str(item["full_window"]["net_per_day"])),
        )
    )
    return ranked_items


def _build_economic_shortlist(
    ranked_items: Sequence[Mapping[str, Any]], *, top_n: int
) -> list[dict[str, Any]]:
    visible_items = [
        item
        for item in ranked_items
        if _safe_decimal(
            _candidate_metric_value(
                item,
                scorecard_key="net_pnl_per_day",
                full_window_key="net_per_day",
            )
        )
        != Decimal("0")
        or item.get("exact_replay_ledger_artifact_ref")
        or item.get("replay_artifact_refs")
    ]
    visible_items.sort(
        key=lambda item: (
            -_safe_decimal(
                _candidate_metric_value(
                    item,
                    scorecard_key="net_pnl_per_day",
                    full_window_key="net_per_day",
                )
            ),
            -_safe_decimal(
                _candidate_metric_value(
                    item,
                    scorecard_key="net_pnl",
                    full_window_key="net_pnl",
                )
            ),
            str(item.get("candidate_id") or ""),
        )
    )
    shortlist: list[dict[str, Any]] = []
    for item in visible_items[: max(1, int(top_n))]:
        ranking = _mapping(item.get("ranking"))
        hard_vetoes = [
            str(reason) for reason in cast(Sequence[Any], item.get("hard_vetoes") or ())
        ]
        shortlist.append(
            {
                "candidate_id": str(item.get("candidate_id") or ""),
                "strategy_name": str(item.get("strategy_name") or ""),
                "family": str(item.get("family") or ""),
                "net_pnl_per_day": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="net_pnl_per_day",
                        full_window_key="net_per_day",
                    )
                ),
                "net_pnl": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="net_pnl",
                        full_window_key="net_pnl",
                    )
                ),
                "active_day_ratio": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="active_day_ratio",
                        full_window_key="active_ratio",
                    )
                ),
                "positive_day_ratio": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="positive_day_ratio",
                        full_window_key="positive_day_ratio",
                    )
                ),
                "max_drawdown": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="max_drawdown",
                        full_window_key="max_drawdown",
                    )
                ),
                "worst_day_loss": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="worst_day_loss",
                        full_window_key="worst_day_loss",
                    )
                ),
                "max_gross_exposure_pct_equity": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="max_gross_exposure_pct_equity",
                        full_window_key="max_gross_exposure_pct_equity",
                    )
                ),
                "min_cash": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="min_cash",
                        full_window_key="min_cash",
                    )
                ),
                "exact_replay_ledger_artifact_ref": str(
                    item.get("exact_replay_ledger_artifact_ref") or ""
                ),
                "replay_artifact_refs": [
                    str(ref)
                    for ref in cast(
                        Sequence[Any], item.get("replay_artifact_refs") or ()
                    )
                ],
                "hard_vetoes": hard_vetoes,
                "vetoed": bool(ranking.get("vetoed") or hard_vetoes),
                "pareto_tier": ranking.get("pareto_tier"),
            }
        )
    return shortlist


def _frontier_state_item(item: Mapping[str, Any]) -> dict[str, Any]:
    screening = _mapping(item.get("screening"))
    staged_search = _mapping(item.get("staged_search"))
    ranking = _mapping(item.get("ranking"))
    return {
        "candidate_id": str(item.get("candidate_id") or ""),
        "strategy_name": str(item.get("strategy_name") or ""),
        "family": str(item.get("family") or ""),
        "stage": str(staged_search.get("stage") or ""),
        "screening_status": str(screening.get("status") or ""),
        "train_screen_survivor_rank": staged_search.get("train_screen_survivor_rank"),
        "exact_replay_selection_reason": staged_search.get(
            "full_replay_selection_reason"
        ),
        "net_pnl_per_day": str(
            _candidate_metric_value(
                item,
                scorecard_key="net_pnl_per_day",
                full_window_key="net_per_day",
            )
        ),
        "hard_vetoes": [
            str(reason) for reason in cast(Sequence[Any], item.get("hard_vetoes") or ())
        ],
        "vetoed": bool(ranking.get("vetoed") or item.get("hard_vetoes")),
    }


def _build_frontier_workflow_states(
    ranked_items: Sequence[Mapping[str, Any]],
    *,
    paper_probation_shortlist: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    preview_qualified = [
        _frontier_state_item(item)
        for item in ranked_items
        if str(_mapping(item.get("screening")).get("status") or "") == "passed"
    ]
    exact_replay_shortlist = [
        _frontier_state_item(item)
        for item in ranked_items
        if bool(
            _mapping(item.get("staged_search")).get(
                "full_replay_selected_after_train_rank"
            )
        )
        or str(_mapping(item.get("staged_search")).get("stage") or "") == "full_replay"
    ]
    exact_replay_qualified = [
        {
            **_frontier_state_item(item),
            "exact_replay_ledger_artifact_refs": (
                _candidate_exact_replay_ledger_artifact_refs(item)
            ),
        }
        for item in ranked_items
        if str(_mapping(item.get("staged_search")).get("stage") or "") == "full_replay"
        and _candidate_runtime_ledger_count(
            item,
            "exact_replay_ledger_artifact_row_count",
        )
        > 0
    ]
    return {
        "schema_version": "torghut.frontier-workflow-states.v1",
        "purpose": (
            "separate preview narrowing, capped exact replay, bounded SIM handoff, "
            "and absent promotion authority"
        ),
        "preview_qualified": preview_qualified,
        "exact_replay_shortlist": exact_replay_shortlist[
            :_SAFE_EXACT_REPLAY_CANDIDATE_CAP
        ],
        "exact_replay_qualified": exact_replay_qualified,
        "paper_probation_shortlisted": [
            dict(item) for item in paper_probation_shortlist
        ],
        "paper_probation_repair_queue": [
            {
                "candidate_id": str(item.get("candidate_id") or ""),
                "target_shortfall": str(item.get("target_shortfall") or "0"),
                "target_progress_ratio": str(item.get("target_progress_ratio") or "0"),
                "repair_plan": dict(_mapping(item.get("paper_probation_repair_plan"))),
            }
            for item in paper_probation_shortlist
            if not bool(item.get("paper_probation_allowed"))
            and bool(
                _mapping(item.get("paper_probation_repair_plan")).get(
                    "repairable_for_evidence_collection"
                )
            )
        ],
        "authority_proof": {
            "status": "absent",
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "proof_authority": False,
            "authority_blockers": [
                "source_backed_runtime_ledger_authority_required",
                "live_paper_probation_runtime_evidence_required",
                "runtime_ledger_to_broker_lineage_required",
                "unchanged_final_promotion_gates_required",
            ],
        },
    }


def _build_frontier_payload(
    *,
    scored: list[dict[str, Any]],
    family: str,
    strategy_name: str,
    family_template: Any,
    dataset_snapshot_receipt: Any,
    window: Any,
    full_window_start: date,
    full_window_end: date,
    holdout_policy: ProfitabilityConstraintPolicy,
    consistency_policy: FullWindowConsistencyPolicy,
    objective_veto_policy: ObjectiveVetoPolicy,
    top_n: int,
    status: str,
    pending_candidates: int,
    replay_tape_validation: Mapping[str, Any] | None = None,
    staged_search: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    ranked_items = _rank_scored_candidates(scored)
    economic_shortlist_items = _build_economic_shortlist(
        ranked_items,
        top_n=max(1, int(top_n)),
    )
    paper_probation_shortlist_items = _build_paper_probation_shortlist(
        ranked_items,
        top_n=max(3, int(top_n)),
        objective_veto_policy=objective_veto_policy,
        target_net_pnl_per_day=consistency_policy.target_net_per_day,
    )
    return {
        "schema_version": _SWEEP_SCHEMA_VERSION,
        "status": status,
        "family": family,
        "strategy_name": strategy_name,
        "family_template": family_template.to_payload(),
        "dataset_snapshot_receipt": dataset_snapshot_receipt.to_payload(),
        "window": {
            "train_days": [item.isoformat() for item in window.train_days],
            "holdout_days": [item.isoformat() for item in window.holdout_days],
            "second_oos_days": [item.isoformat() for item in window.second_oos_days],
            "full_window_start_date": full_window_start.isoformat(),
            "full_window_end_date": full_window_end.isoformat(),
        },
        "constraints": {
            "holdout": {
                "holdout_target_net_per_day": str(
                    holdout_policy.holdout_target_net_per_day
                ),
                "min_active_holdout_days": holdout_policy.min_active_holdout_days,
                "max_worst_holdout_day_loss": str(
                    holdout_policy.max_worst_holdout_day_loss
                ),
                "min_profit_factor": str(holdout_policy.min_profit_factor),
                "require_training_decisions": holdout_policy.require_training_decisions,
                "require_holdout_decisions": holdout_policy.require_holdout_decisions,
            },
            "second_oos": {
                "enabled": bool(window.second_oos_days),
                "window_id": _SECOND_OOS_WINDOW_ID,
                "min_independent_window_count": 2 if window.second_oos_days else 1,
                "target_net_per_day": str(consistency_policy.target_net_per_day),
            },
            "consistency": consistency_policy.to_payload(),
            "hard_vetoes": objective_veto_policy.to_payload(),
        },
        "ranking": {
            "method": "pareto_frontier_v2",
            "stale_override_used": dataset_snapshot_receipt.stale_override_used,
        },
        "replay_tape": dict(replay_tape_validation or {}),
        "progress": {
            "evaluated_candidates": len(scored),
            "pending_candidates": pending_candidates,
            "staged_search": dict(staged_search or {}),
        },
        "candidate_count": len(scored),
        "economic_shortlist": {
            "schema_version": "torghut.frontier-economic-shortlist.v1",
            "ranking_basis": "full_window_net_pnl_per_day_desc",
            "items": economic_shortlist_items,
        },
        "paper_probation_shortlist": {
            "schema_version": "torghut.frontier-paper-probation-shortlist.v1",
            "purpose": (
                "surface close positive candidates for controlled paper evidence "
                "collection without authorizing final promotion"
            ),
            "ranking_basis": "paper_readiness_then_target_shortfall_then_net_pnl",
            "items": paper_probation_shortlist_items,
        },
        "workflow_states": _build_frontier_workflow_states(
            ranked_items,
            paper_probation_shortlist=paper_probation_shortlist_items,
        ),
        "top": ranked_items[: max(1, int(top_n))],
    }


__all__ = [
    "_SAFE_EXACT_REPLAY_CANDIDATE_CAP",
    "_rank_scored_candidates",
    "_build_economic_shortlist",
    "_frontier_state_item",
    "_build_frontier_workflow_states",
    "_build_frontier_payload",
]
