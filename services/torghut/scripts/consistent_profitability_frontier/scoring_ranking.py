#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

import json
from collections import deque
from datetime import date
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


from app.trading.reporting import (
    ProfitabilityConstraintPolicy,
    summarize_replay_profitability,
)

from scripts.consistent_profitability_frontier.common import (
    _SECOND_OOS_WINDOW_ID as _SECOND_OOS_WINDOW_ID,
    FullWindowConsistencyPolicy as FullWindowConsistencyPolicy,
    OrderTypeAblationPolicy as OrderTypeAblationPolicy,
    _write_json_output as _write_json_output,
    _replay_tape_selection_metadata as _replay_tape_selection_metadata,
    _resolve_full_window as _resolve_full_window,
    _max_drawdown_from_daily_net as _max_drawdown_from_daily_net,
    _daily_filled_notional as _daily_filled_notional,
    _daily_liquidity_notional as _daily_liquidity_notional,
    _daily_decimal_metric as _daily_decimal_metric,
    _daily_int_metric as _daily_int_metric,
    _int_mapping as _int_mapping,
    _mapping as _mapping,
    _optional_decimal as _optional_decimal,
    _nonnegative_int_metric as _nonnegative_int_metric,
    _truthy_metric as _truthy_metric,
)
from scripts.consistent_profitability_frontier.ledger_order import (
    _order_lifecycle_metrics as _order_lifecycle_metrics,
    _order_type_execution_metrics as _order_type_execution_metrics,
    _normalized_order_type as _normalized_order_type,
    _selected_entry_order_type as _selected_entry_order_type,
    _forced_order_type_sample_count as _forced_order_type_sample_count,
    _payload_digest as _payload_digest,
    _artifact_run_dir_name as _artifact_run_dir_name,
    _order_type_ablation_artifact_dir as _order_type_ablation_artifact_dir,
    _frontier_ledger_text as _frontier_ledger_text,
    _frontier_ledger_datetime as _frontier_ledger_datetime,
    _frontier_exact_replay_bucket_range as _frontier_exact_replay_bucket_range,
    _frontier_exact_replay_rows as _frontier_exact_replay_rows,
    _frontier_exact_replay_bucket_has_authority as _frontier_exact_replay_bucket_has_authority,
    _frontier_exact_replay_bucket as _frontier_exact_replay_bucket,
    _exact_replay_ledger_artifact_update as _exact_replay_ledger_artifact_update,
    _order_type_replay_arm_summary as _order_type_replay_arm_summary,
    _order_type_ablation_payload as _order_type_ablation_payload,
)
from scripts.consistent_profitability_frontier.stress_metrics import (
    DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS as DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS,
    CONFORMAL_TAIL_RISK_ALPHA as CONFORMAL_TAIL_RISK_ALPHA,
    BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS as BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS,
    MARKET_IMPACT_STRESS_SOURCE_MARKERS as MARKET_IMPACT_STRESS_SOURCE_MARKERS,
    _p10 as _p10,
    _conformal_tail_loss_buffer as _conformal_tail_loss_buffer,
    _conformal_tail_risk_metrics as _conformal_tail_risk_metrics,
    _breakeven_transaction_cost_buffer_metrics as _breakeven_transaction_cost_buffer_metrics,
    _delay_depth_fillability as _delay_depth_fillability,
    _implementation_uncertainty_metrics as _implementation_uncertainty_metrics,
    _replay_stress_metrics as _replay_stress_metrics,
    _decimal_payload_metric as _decimal_payload_metric,
    _max_best_day_share_of_total_pnl as _max_best_day_share_of_total_pnl,
    _consistency_penalty as _consistency_penalty,
    _second_oos_summary as _second_oos_summary,
    _holdout_oos_passed as _holdout_oos_passed,
)
from scripts.consistent_profitability_frontier.frontier_payload import (
    _SAFE_EXACT_REPLAY_CANDIDATE_CAP as _SAFE_EXACT_REPLAY_CANDIDATE_CAP,
    _build_economic_shortlist as _build_economic_shortlist,
    _build_frontier_payload as _build_frontier_payload,
    _build_frontier_workflow_states as _build_frontier_workflow_states,
    _frontier_state_item as _frontier_state_item,
    _rank_scored_candidates as _rank_scored_candidates,
)
from scripts.consistent_profitability_frontier.paper_probation import (
    _PAPER_PROBATION_ACTIVITY_REPAIR_REASONS as _PAPER_PROBATION_ACTIVITY_REPAIR_REASONS,
    _PAPER_PROBATION_CAPITAL_REPAIR_REASONS as _PAPER_PROBATION_CAPITAL_REPAIR_REASONS,
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_LOSS_REPAIR_REASONS as _PAPER_PROBATION_LOSS_REPAIR_REASONS,
    _PAPER_PROBATION_QUEUE_SURVIVAL_REASONS as _PAPER_PROBATION_QUEUE_SURVIVAL_REASONS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH as _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _PAPER_PROBATION_TAIL_RISK_REASONS as _PAPER_PROBATION_TAIL_RISK_REASONS,
    _PAPER_PROBATION_TARGET_SCALE_QUANTUM as _PAPER_PROBATION_TARGET_SCALE_QUANTUM,
    _bounded_sim_handoff_metadata as _bounded_sim_handoff_metadata,
    _build_paper_probation_shortlist as _build_paper_probation_shortlist,
    _candidate_artifact_refs as _candidate_artifact_refs,
    _candidate_exact_replay_ledger_artifact_refs as _candidate_exact_replay_ledger_artifact_refs,
    _candidate_exact_replay_parity_ok as _candidate_exact_replay_parity_ok,
    _candidate_handoff_diagnostics as _candidate_handoff_diagnostics,
    _candidate_metric_decimal as _candidate_metric_decimal,
    _candidate_metric_value as _candidate_metric_value,
    _candidate_post_cost_proof_blockers as _candidate_post_cost_proof_blockers,
    _candidate_replay_tape_metadata_blockers as _candidate_replay_tape_metadata_blockers,
    _candidate_runtime_ledger_count as _candidate_runtime_ledger_count,
    _candidate_source_lineage_ok as _candidate_source_lineage_ok,
    _paper_probation_notional_scale as _paper_probation_notional_scale,
    _paper_probation_notional_scale_decimal as _paper_probation_notional_scale_decimal,
    _paper_probation_repair_actions as _paper_probation_repair_actions,
    _paper_probation_repair_plan as _paper_probation_repair_plan,
    _paper_probation_required_actions as _paper_probation_required_actions,
    _paper_probation_target_notional_scale as _paper_probation_target_notional_scale,
    _paper_probation_target_progress as _paper_probation_target_progress,
    _safe_decimal as _safe_decimal,
)
from scripts.consistent_profitability_frontier.repair_math import (
    _LOSS_REPAIR_CAPITAL_SAFETY_BUFFER as _LOSS_REPAIR_CAPITAL_SAFETY_BUFFER,
    _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE as _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE,
    _LOSS_REPAIR_MIN_SCALE_QUANTUM as _LOSS_REPAIR_MIN_SCALE_QUANTUM,
    _capital_repair_exposure_scale as _capital_repair_exposure_scale,
    _decimal_or_none as _decimal_or_none,
    _decimal_payload as _decimal_payload,
    _reduced_exposure as _reduced_exposure,
    _tightened_bps as _tightened_bps,
)

from scripts.consistent_profitability_frontier.candidate_loading import (
    _WorklistItem,
    _safe_exact_replay_candidate_budget,
    _stable_payload_hash,
)

_SAFE_EXACT_REPLAY_EXPLOITATION_SLOTS = 4

_SAFE_EXACT_REPLAY_EXPLORATION_SLOTS = 2


def _rolling_lower_bound(daily_net: Mapping[str, Decimal], *, window: int) -> Decimal:
    ordered = [daily_net[key] for key in sorted(daily_net)]
    if not ordered:
        return Decimal("0")
    if len(ordered) < window:
        return sum(ordered, Decimal("0")) / Decimal(len(ordered))
    values: list[Decimal] = []
    for index in range(len(ordered) - window + 1):
        sample = ordered[index : index + window]
        values.append(sum(sample, Decimal("0")) / Decimal(window))
    return min(values) if values else Decimal("0")


def _empty_replay_payload(*, start_date: date, end_date: date) -> dict[str, Any]:
    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "net_pnl": "0",
        "gross_pnl": "0",
        "total_cost": "0",
        "decision_count": 0,
        "filled_count": 0,
        "wins": 0,
        "losses": 0,
        "daily": {},
        "funnel": {"buckets": []},
    }


def _train_screen_failures(
    *,
    train_payload: Mapping[str, Any],
    holdout_policy: ProfitabilityConstraintPolicy,
    consistency_policy: FullWindowConsistencyPolicy,
    min_train_net_per_day: Decimal,
    min_train_active_ratio: Decimal,
    max_train_worst_day_loss: Decimal,
) -> list[str]:
    summary = summarize_replay_profitability(train_payload)
    failures: list[str] = []
    active_ratio = (
        Decimal(summary.active_days) / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    if holdout_policy.require_training_decisions and summary.decision_count <= 0:
        failures.append("train_no_decisions")
    if summary.active_days <= 0:
        failures.append("train_no_active_days")
    if active_ratio < min_train_active_ratio:
        failures.append("train_active_ratio_below_screen")
    if summary.net_per_day < min_train_net_per_day:
        failures.append("train_net_per_day_below_screen")
    if summary.worst_day_net < -max_train_worst_day_loss:
        failures.append("train_worst_day_loss_above_screen")
    if (
        consistency_policy.require_every_day_active
        and summary.trading_day_count > 0
        and summary.active_days == 0
    ):
        failures.append("train_every_day_active_impossible")
    return list(dict.fromkeys(failures))


def _positive_train_screen_candidate(train_payload: Mapping[str, Any]) -> bool:
    summary = summarize_replay_profitability(train_payload)
    return summary.decision_count > 0 and summary.net_per_day > Decimal("0")


def _train_screen_active_ratio(train_payload: Mapping[str, Any]) -> Decimal:
    summary = summarize_replay_profitability(train_payload)
    if summary.trading_day_count <= 0:
        return Decimal("0")
    return Decimal(summary.active_days) / Decimal(summary.trading_day_count)


def _train_screen_worst_day_loss(train_payload: Mapping[str, Any]) -> Decimal:
    summary = summarize_replay_profitability(train_payload)
    if summary.worst_day_net >= Decimal("0"):
        return Decimal("0")
    return abs(summary.worst_day_net)


def _rank_train_screen_survivors(
    survivors: Sequence[_WorklistItem],
) -> list[_WorklistItem]:
    ranked = list(survivors)
    ranked.sort(
        key=lambda item: (
            -summarize_replay_profitability(
                cast(Mapping[str, Any], item.deferred_train_payload or {})
            ).net_per_day,
            -_train_screen_active_ratio(
                cast(Mapping[str, Any], item.deferred_train_payload or {})
            ),
            _train_screen_worst_day_loss(
                cast(Mapping[str, Any], item.deferred_train_payload or {})
            ),
            int(item.deferred_candidate_index or 0),
        )
    )
    return ranked


def _exploration_payload_signature(item: _WorklistItem) -> str:
    payload = {
        "params": item.params_candidate,
        "strategy_overrides": item.strategy_overrides,
    }
    return json.dumps(payload, sort_keys=True, default=str)


def _exploration_distance(
    candidate: _WorklistItem,
    selected: Sequence[_WorklistItem],
) -> int:
    if not selected:
        return 0
    candidate_params = candidate.params_candidate
    candidate_overrides = candidate.strategy_overrides
    distances: list[int] = []
    for existing in selected:
        distance = 0
        for key in set(candidate_params) | set(existing.params_candidate):
            if candidate_params.get(key) != existing.params_candidate.get(key):
                distance += 1
        for key in set(candidate_overrides) | set(existing.strategy_overrides):
            if candidate_overrides.get(key) != existing.strategy_overrides.get(key):
                distance += 1
        distances.append(distance)
    return min(distances, default=0)


def _exploration_diversity_key(item: _WorklistItem) -> tuple[str, str, str]:
    symbols = item.strategy_overrides.get("universe_symbols")
    if isinstance(symbols, Sequence) and not isinstance(
        symbols, (str, bytes, bytearray)
    ):
        symbol_key = ",".join(
            sorted(str(symbol).upper() for symbol in symbols if str(symbol).strip())
        )
    else:
        symbol_key = str(symbols or "")
    params_payload = {
        key: value
        for key, value in item.params_candidate.items()
        if key
        in {
            "entry_threshold_bps",
            "exit_threshold_bps",
            "long_stop_loss_bps",
            "max_entries_per_session",
            "min_cross_section_continuation_rank",
            "min_cross_section_reversal_rank",
            "selection_mode",
            "short_stop_loss_bps",
            "signal_motif",
            "top_n",
        }
    }
    if not params_payload:
        params_payload = dict(item.params_candidate)
    params_key = _stable_payload_hash(params_payload)
    regime_payload = {
        key: item.strategy_overrides.get(key)
        for key in (
            "normalization_regime",
            "market_regime",
            "regime",
            "runtime_family",
            "strategy_family",
        )
        if key in item.strategy_overrides
    }
    nested_params = item.strategy_overrides.get("params")
    if isinstance(nested_params, Mapping):
        regime_payload.update(
            {
                key: nested_params.get(key)
                for key in ("selection_mode", "signal_motif", "rank_feature")
                if key in nested_params
            }
        )
    regime_key = _stable_payload_hash(regime_payload)
    return (params_key, symbol_key, regime_key)


def _select_exact_replay_train_survivors(
    ranked_survivors: Sequence[_WorklistItem],
    *,
    full_replay_candidate_budget: int,
) -> dict[str, str]:
    selected: list[_WorklistItem] = []
    reasons: dict[str, str] = {}
    budget = _safe_exact_replay_candidate_budget(full_replay_candidate_budget)
    exploitation_slots = min(_SAFE_EXACT_REPLAY_EXPLOITATION_SLOTS, budget)
    for survivor in ranked_survivors[:exploitation_slots]:
        selected.append(survivor)
        reasons[_exploration_payload_signature(survivor)] = (
            "exploitation_top_economic_rank"
        )
    exploration_slots = min(
        _SAFE_EXACT_REPLAY_EXPLORATION_SLOTS,
        max(0, budget - len(selected)),
    )
    remaining = [
        survivor
        for survivor in ranked_survivors[exploitation_slots:]
        if _exploration_payload_signature(survivor) not in reasons
    ]
    explored_diversity_keys: set[tuple[str, str, str]] = {
        _exploration_diversity_key(item) for item in selected
    }
    deferred_exploration: list[_WorklistItem] = []
    for _ in range(exploration_slots):
        if not remaining:
            break
        distinct_remaining = [
            (index, survivor)
            for index, survivor in enumerate(remaining)
            if _exploration_diversity_key(survivor) not in explored_diversity_keys
        ]
        if not distinct_remaining:
            deferred_exploration.extend(remaining)
            break
        best_index, best_survivor = max(
            distinct_remaining,
            key=lambda indexed: (
                _exploration_distance(indexed[1], selected),
                -indexed[0],
            ),
        )
        selected.append(best_survivor)
        reasons[_exploration_payload_signature(best_survivor)] = (
            "exploration_diversity_pick"
        )
        explored_diversity_keys.add(_exploration_diversity_key(best_survivor))
        del remaining[best_index]
    for survivor in deferred_exploration + remaining:
        exploration_selected_count = sum(
            1 for reason in reasons.values() if reason == "exploration_diversity_pick"
        )
        if exploration_selected_count >= exploration_slots:
            break
        if _exploration_payload_signature(survivor) in reasons:
            continue
        selected.append(survivor)
        reasons[_exploration_payload_signature(survivor)] = "exploration_diversity_pick"
    return reasons


def _enqueue_ranked_train_screen_survivors(
    *,
    worklist: deque[_WorklistItem],
    survivors: Sequence[_WorklistItem],
    full_replay_candidate_budget: int,
) -> None:
    ranked_survivors = _rank_train_screen_survivors(survivors)
    selected_reasons = _select_exact_replay_train_survivors(
        ranked_survivors,
        full_replay_candidate_budget=full_replay_candidate_budget,
    )
    queued: list[_WorklistItem] = []
    for rank, survivor in enumerate(ranked_survivors, start=1):
        selection_reason = selected_reasons.get(
            _exploration_payload_signature(survivor)
        )
        queued.append(
            _WorklistItem(
                params_candidate=dict(survivor.params_candidate),
                strategy_overrides=dict(survivor.strategy_overrides),
                candidate_record_seed=survivor.candidate_record_seed,
                symbol_prune_iteration=survivor.symbol_prune_iteration,
                loss_repair_iteration=survivor.loss_repair_iteration,
                consistency_repair_iteration=survivor.consistency_repair_iteration,
                pruned_symbol=survivor.pruned_symbol,
                repair_reason=survivor.repair_reason,
                parent_candidate_id=survivor.parent_candidate_id,
                deferred_candidate_index=survivor.deferred_candidate_index,
                deferred_candidate_key=survivor.deferred_candidate_key,
                deferred_train_payload=survivor.deferred_train_payload,
                deferred_full_replay_selected=selection_reason is not None,
                deferred_train_rank=rank,
                deferred_train_economic_rank=rank,
                deferred_full_replay_selection_reason=selection_reason,
            )
        )
    worklist.extendleft(reversed(queued))


__all__ = [
    "_rolling_lower_bound",
    "_empty_replay_payload",
    "_train_screen_failures",
    "_positive_train_screen_candidate",
    "_train_screen_active_ratio",
    "_train_screen_worst_day_loss",
    "_rank_train_screen_survivors",
    "_exploration_payload_signature",
    "_exploration_distance",
    "_exploration_diversity_key",
    "_select_exact_replay_train_survivors",
    "_enqueue_ranked_train_screen_survivors",
]
