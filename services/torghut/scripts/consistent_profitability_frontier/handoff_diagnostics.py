#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

from collections import Counter
from decimal import Decimal
from typing import Any, Mapping, cast


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


def _symbol_contributions_from_replay_payload(
    payload: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    funnel = payload.get("funnel")
    if not isinstance(funnel, Mapping):
        return {}
    buckets = funnel.get("buckets")
    if not isinstance(buckets, list):
        return {}

    contributions: dict[str, dict[str, Any]] = {}
    for raw_bucket in buckets:
        if not isinstance(raw_bucket, Mapping):
            continue
        symbol = str(raw_bucket.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        bucket_net = Decimal(str(raw_bucket.get("net_pnl", "0")))
        bucket_cost = Decimal(str(raw_bucket.get("cost_total", "0")))
        bucket_filled = int(raw_bucket.get("filled_count", 0) or 0)
        bucket_day = str(raw_bucket.get("trading_day") or "").strip()
        aggregate = contributions.setdefault(
            symbol,
            {
                "net_pnl": Decimal("0"),
                "cost_total": Decimal("0"),
                "downside_pnl": Decimal("0"),
                "worst_day_net": Decimal("0"),
                "active_days": set(),
                "negative_days": set(),
                "filled_count": 0,
            },
        )
        aggregate["net_pnl"] += bucket_net
        aggregate["cost_total"] += bucket_cost
        aggregate["filled_count"] += bucket_filled
        if bucket_filled > 0 and bucket_day:
            aggregate["active_days"].add(bucket_day)
        if bucket_net < 0:
            aggregate["downside_pnl"] += -bucket_net
            if bucket_day:
                aggregate["negative_days"].add(bucket_day)
            if bucket_net < aggregate["worst_day_net"]:
                aggregate["worst_day_net"] = bucket_net

    result: dict[str, dict[str, Any]] = {}
    for symbol, aggregate in contributions.items():
        net_pnl = aggregate["net_pnl"]
        downside_pnl = aggregate["downside_pnl"]
        worst_day_net = aggregate["worst_day_net"]
        # Risk-sensitive marginal contribution: reward positive contribution, penalize
        # downside and especially severe one-day losses.
        contribution_score = net_pnl - downside_pnl - abs(worst_day_net)
        result[symbol] = {
            "net_pnl": str(net_pnl),
            "cost_total": str(aggregate["cost_total"]),
            "downside_pnl": str(downside_pnl),
            "worst_day_net": str(worst_day_net),
            "active_days": len(aggregate["active_days"]),
            "negative_days": len(aggregate["negative_days"]),
            "filled_count": aggregate["filled_count"],
            "contribution_score": str(contribution_score),
        }
    return dict(
        sorted(
            result.items(),
            key=lambda item: (
                Decimal(str(item[1]["contribution_score"])),
                Decimal(str(item[1]["net_pnl"])),
            ),
        )
    )


def _top_counter_payload(
    counter: Counter[str], *, limit: int = 10
) -> list[dict[str, Any]]:
    return [
        {"key": key, "count": count}
        for key, count in counter.most_common(max(1, limit))
    ]


def _counter_from_payload(value: Any) -> Counter[str]:
    counter: Counter[str] = Counter()
    if not isinstance(value, Mapping):
        return counter
    for key, raw_count in value.items():
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count > 0:
            counter[str(key)] += count
    return counter


def _near_miss_digest(raw_near_miss: Mapping[str, Any]) -> dict[str, Any]:
    thresholds = raw_near_miss.get("thresholds")
    threshold_digest: list[dict[str, Any]] = []
    if isinstance(thresholds, list):
        for item in thresholds[:3]:
            if not isinstance(item, Mapping):
                continue
            threshold_digest.append(
                {
                    "metric": str(item.get("metric") or ""),
                    "value": item.get("value"),
                    "threshold": item.get("threshold"),
                    "distance_to_pass": item.get("distance_to_pass"),
                }
            )
    return {
        "trading_day": raw_near_miss.get("trading_day"),
        "symbol": raw_near_miss.get("symbol"),
        "strategy_type": raw_near_miss.get("strategy_type"),
        "event_ts": raw_near_miss.get("event_ts"),
        "first_failed_gate": raw_near_miss.get("first_failed_gate"),
        "distance_score": raw_near_miss.get("distance_score"),
        "thresholds": threshold_digest,
    }


def _train_gate_diagnostics_from_replay_payload(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    funnel = payload.get("funnel")
    buckets = (
        cast(list[Any], funnel.get("buckets"))
        if isinstance(funnel, Mapping) and isinstance(funnel.get("buckets"), list)
        else []
    )
    aggregate = {
        "retained_rows": 0,
        "runtime_evaluable_rows": 0,
        "quote_valid_rows": 0,
        "strategy_evaluations": 0,
        "passed_trace_count": 0,
        "decision_count": int(payload.get("decision_count") or 0),
        "filled_count": int(payload.get("filled_count") or 0),
    }
    first_failed_gate_counts: Counter[str] = Counter()
    failing_threshold_counts: Counter[str] = Counter()
    gate_pass_counts: Counter[str] = Counter()
    post_gate_block_reason_counts: Counter[str] = Counter()
    for raw_bucket in buckets:
        if not isinstance(raw_bucket, Mapping):
            continue
        for key in (
            "retained_rows",
            "runtime_evaluable_rows",
            "quote_valid_rows",
            "strategy_evaluations",
            "passed_trace_count",
        ):
            try:
                aggregate[key] += int(raw_bucket.get(key) or 0)
            except (TypeError, ValueError):
                continue
        first_failed_gate_counts.update(
            _counter_from_payload(raw_bucket.get("first_failed_gate_counts"))
        )
        failing_threshold_counts.update(
            _counter_from_payload(raw_bucket.get("failing_threshold_counts"))
        )
        gate_pass_counts.update(
            _counter_from_payload(raw_bucket.get("gate_pass_counts"))
        )
        post_gate_block_reason_counts.update(
            _counter_from_payload(raw_bucket.get("post_gate_block_reason_counts"))
        )

    near_misses = payload.get("near_misses")
    near_miss_digest = [
        _near_miss_digest(item)
        for item in (near_misses if isinstance(near_misses, list) else [])[:20]
        if isinstance(item, Mapping)
    ]
    status = (
        "available"
        if aggregate["strategy_evaluations"] > 0
        else "no_runtime_trace_evaluations"
    )
    return {
        "schema_version": "torghut.frontier-train-gate-diagnostics.v1",
        "status": status,
        "aggregate": aggregate,
        "top_first_failed_gates": _top_counter_payload(first_failed_gate_counts),
        "top_failing_thresholds": _top_counter_payload(failing_threshold_counts),
        "top_gate_pass_counts": _top_counter_payload(gate_pass_counts),
        "top_post_gate_block_reasons": _top_counter_payload(
            post_gate_block_reason_counts
        ),
        "near_misses": near_miss_digest,
    }


__all__ = [
    "_symbol_contributions_from_replay_payload",
    "_top_counter_payload",
    "_counter_from_payload",
    "_near_miss_digest",
    "_train_gate_diagnostics_from_replay_payload",
]
