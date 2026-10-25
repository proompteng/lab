#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

import argparse
import contextlib
import heapq
import hashlib
import itertools
import json
import os
import socket
import sys
import tempfile
from collections import Counter, deque
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_DOWN
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence, cast
from urllib.parse import urlparse
from unittest.mock import patch

import yaml

from app.trading.discovery.dataset_snapshot import (
    DatasetSnapshotReceipt,
    DatasetWitness,
    build_dataset_snapshot_receipt,
    ensure_fresh_snapshot,
)
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.family_templates import (
    derive_family_template_id,
    family_template_dir,
    load_family_template,
)
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
    evaluate_vetoes,
    rank_scorecards,
)
from app.trading.discovery.replay_tape import (
    ReplayTape,
    load_replay_tape,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
from app.trading.session_context import iter_regular_equities_session_dates
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from app.trading.reporting import (
    ProfitabilityConstraintPolicy,
    score_replay_profitability_candidate,
    summarize_replay_profitability,
)
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.local_intraday_tsmom_replay import run_replay
from scripts.search_profitability_frontier import (
    _SWEEP_SCHEMA_VERSION,
    _build_replay_config,
    _load_sweep_config,
    _resolve_recent_trading_days,
    apply_candidate_to_configmap,
)

from scripts.consistent_profitability_frontier.common import (
    _SECOND_OOS_WINDOW_ID,
    FullWindowConsistencyPolicy,
    OrderTypeAblationPolicy,
    _write_json_output,
    _replay_tape_selection_metadata,
    _resolve_full_window,
    _max_drawdown_from_daily_net,
    _daily_filled_notional,
    _daily_liquidity_notional,
    _daily_decimal_metric,
    _daily_int_metric,
    _int_mapping,
    _mapping,
    _optional_decimal,
    _nonnegative_int_metric,
    _truthy_metric,
)
from scripts.consistent_profitability_frontier.ledger_order import (
    _order_lifecycle_metrics,
    _order_type_execution_metrics,
    _normalized_order_type,
    _selected_entry_order_type,
    _forced_order_type_sample_count,
    _payload_digest,
    _artifact_run_dir_name,
    _order_type_ablation_artifact_dir,
    _frontier_ledger_text,
    _frontier_ledger_datetime,
    _frontier_exact_replay_bucket_range,
    _frontier_exact_replay_rows,
    _frontier_exact_replay_bucket_has_authority,
    _frontier_exact_replay_bucket,
    _exact_replay_ledger_artifact_update,
    _order_type_replay_arm_summary,
    _order_type_ablation_payload,
)
from scripts.consistent_profitability_frontier.stress_metrics import (
    DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS,
    CONFORMAL_TAIL_RISK_ALPHA,
    BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS,
    MARKET_IMPACT_STRESS_SOURCE_MARKERS,
    _p10,
    _conformal_tail_loss_buffer,
    _conformal_tail_risk_metrics,
    _breakeven_transaction_cost_buffer_metrics,
    _delay_depth_fillability,
    _implementation_uncertainty_metrics,
    _replay_stress_metrics,
    _decimal_payload_metric,
    _max_best_day_share_of_total_pnl,
    _consistency_penalty,
    _second_oos_summary,
    _holdout_oos_passed,
)
from scripts.consistent_profitability_frontier.frontier_payload import (
    _SAFE_EXACT_REPLAY_CANDIDATE_CAP,
    _build_economic_shortlist,
    _build_frontier_payload,
    _build_frontier_workflow_states,
    _frontier_state_item,
    _rank_scored_candidates,
)
from scripts.consistent_profitability_frontier.paper_probation import (
    _PAPER_PROBATION_ACTIVITY_REPAIR_REASONS,
    _PAPER_PROBATION_CAPITAL_REPAIR_REASONS,
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_LOSS_REPAIR_REASONS,
    _PAPER_PROBATION_QUEUE_SURVIVAL_REASONS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _PAPER_PROBATION_TAIL_RISK_REASONS,
    _PAPER_PROBATION_TARGET_SCALE_QUANTUM,
    _bounded_sim_handoff_metadata,
    _build_paper_probation_shortlist,
    _candidate_artifact_refs,
    _candidate_exact_replay_ledger_artifact_refs,
    _candidate_exact_replay_parity_ok,
    _candidate_handoff_diagnostics,
    _candidate_metric_decimal,
    _candidate_metric_value,
    _candidate_post_cost_proof_blockers,
    _candidate_replay_tape_metadata_blockers,
    _candidate_runtime_ledger_count,
    _candidate_source_lineage_ok,
    _paper_probation_notional_scale,
    _paper_probation_notional_scale_decimal,
    _paper_probation_repair_actions,
    _paper_probation_repair_plan,
    _paper_probation_required_actions,
    _paper_probation_target_notional_scale,
    _paper_probation_target_progress,
    _safe_decimal,
)
from scripts.consistent_profitability_frontier.repair_math import (
    _LOSS_REPAIR_CAPITAL_SAFETY_BUFFER,
    _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE,
    _LOSS_REPAIR_MIN_SCALE_QUANTUM,
    _capital_repair_exposure_scale,
    _decimal_or_none,
    _decimal_payload,
    _reduced_exposure,
    _tightened_bps,
)

from scripts.consistent_profitability_frontier.cli_parsing import (
    _parse_args,
    _clickhouse_host_requires_dns_preflight,
    _clickhouse_endpoint_preflight_failure,
    _resolved_clickhouse_password,
    _frontier_error_payload,
)

from scripts.consistent_profitability_frontier.candidate_loading import (
    _WorklistItem,
    FrontierReplayWindows,
    _optional_int,
    _order_type_ablation_policy,
    _safe_exact_replay_candidate_budget,
    _staged_search_budget_payload,
    _stable_payload_hash,
    _replay_lineage_window_payload,
    _candidate_replay_lineage_payload,
    _replay_window_coverage_payload,
    _resolve_frontier_replay_windows,
    _business_days,
    _snapshot_expected_days,
    _objective_veto_policy,
)

from scripts.consistent_profitability_frontier.candidate_generation import (
    _iter_strategy_override_candidates,
    _candidate_record_seed,
    _load_candidate_record_seeds,
    _parameter_grid_items,
    _parameter_exploration_priority,
    _candidate_payload_key,
    _iter_parameter_candidates,
    _iter_initial_worklist_candidates,
    _candidate_symbols,
    _strategy_universe_symbols,
    _candidate_universe_symbols,
    _candidate_search_key,
    _candidate_evaluation_key_payload,
)

from scripts.consistent_profitability_frontier.replay_data import (
    _resolve_prefetch_symbols,
    _prefetch_signal_rows,
    _cached_iter_signal_rows_factory,
    _cached_signal_rows_patch,
    _load_replay_tape_rows,
    _replay_tape_trading_days,
    _build_replay_tape_snapshot_receipt,
    _replay_tape_row_days,
    apply_candidate_to_configmap_with_overrides,
)

from scripts.consistent_profitability_frontier.scoring_ranking import (
    _rolling_lower_bound,
    _empty_replay_payload,
    _train_screen_failures,
    _positive_train_screen_candidate,
    _train_screen_active_ratio,
    _train_screen_worst_day_loss,
    _rank_train_screen_survivors,
    _exploration_payload_signature,
    _exploration_distance,
    _exploration_diversity_key,
    _select_exact_replay_train_survivors,
    _enqueue_ranked_train_screen_survivors,
)

from scripts.consistent_profitability_frontier.handoff_diagnostics import (
    _symbol_contributions_from_replay_payload,
    _top_counter_payload,
    _counter_from_payload,
    _near_miss_digest,
    _train_gate_diagnostics_from_replay_payload,
)

from scripts.consistent_profitability_frontier.candidate_repairs import (
    _generate_symbol_prune_children,
    _strategy_item_from_configmap,
    _loss_repair_trigger_reason,
    _apply_loss_control_tightening,
    _apply_exposure_clamp,
    _generate_loss_repair_children,
    _positive_capital_safe_summary,
    _consistency_repair_trigger_reason,
    _increment_integer_candidate_param,
    _halve_positive_integer_candidate_param,
    _relax_signal_threshold_candidate_param,
    _generate_consistency_repair_children,
    _selected_normalization_regime,
)

from scripts.consistent_profitability_frontier.workflow_orchestration import (
    run_consistent_profitability_frontier as _run_consistent_profitability_frontier,
)

_LOCAL_ONLY_OVERRIDE_KEYS = frozenset({"normalization_regime"})

_SAFE_EXACT_REPLAY_EXPLOITATION_SLOTS = 4

_SAFE_EXACT_REPLAY_EXPLORATION_SLOTS = 2

_SAFE_LOCAL_EXACT_REPLAY_WORKERS = 2

_DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER = 3

_LOSS_REPAIR_TRIGGER_REASONS = frozenset(
    {
        "train_worst_day_loss_above_screen",
        "worst_day_loss_above_max",
        "max_drawdown_above_max",
        "conformal_tail_risk_below_target",
        "daily_net_below_min",
        "gross_exposure_pct_equity_above_max",
        "min_cash_below_min",
    }
)

_LOSS_REPAIR_TRIGGER_SUFFIXES = (
    "_worst_day_loss_above_max",
    "_max_drawdown_above_max",
)

_LOSS_REPAIR_BPS_FLOORS = {
    "long_stop_loss_bps": Decimal("4"),
    "short_stop_loss_bps": Decimal("4"),
    "long_trailing_stop_drawdown_bps": Decimal("3"),
    "short_trailing_stop_drawdown_bps": Decimal("3"),
    "negative_exit_loss_bps": Decimal("4"),
    "max_session_negative_exit_bps": Decimal("4"),
}

_LOSS_REPAIR_EXIT_LIMIT_KEYS = (
    "max_stop_loss_exits_per_session",
    "max_negative_exits_per_session",
)

_LOSS_REPAIR_LOCKOUT_KEYS = (
    "stop_loss_lockout_seconds",
    "negative_exit_lockout_seconds",
)

_LOSS_REPAIR_PARAM_EXPOSURE_KEYS = ("max_gross_exposure_pct_equity",)

_LOSS_REPAIR_STRATEGY_EXPOSURE_KEYS = (
    "max_notional_per_trade",
    "max_position_pct_equity",
)

_CONSISTENCY_REPAIR_TRIGGER_REASONS = frozenset(
    {
        "active_day_ratio_below_min",
        "avg_daily_notional_below_min",
        "best_day_share_above_max",
        "second_oos_net_per_day_below_target",
    }
)

_CONSISTENCY_REPAIR_UNSAFE_REASONS = frozenset(
    {
        "gross_exposure_pct_equity_above_max",
        "min_cash_below_min",
        "negative_cash_observation_count_above_max",
    }
)

_CONSISTENCY_REPAIR_ENTRY_KEYS = (
    "max_entries_per_session",
    "max_entries_per_day",
)

_CONSISTENCY_REPAIR_BREADTH_KEYS = ("top_n",)

_CONSISTENCY_REPAIR_COOLDOWN_KEYS = (
    "entry_cooldown_seconds",
    "signal_cooldown_seconds",
)

_CONSISTENCY_REPAIR_SIGNAL_THRESHOLD_KEYS = (
    "min_cross_section_continuation_rank",
    "min_cross_section_reversal_rank",
    "min_cross_section_opening_window_return_rank",
    "isolated_same_day_min_session_open_rank",
    "isolated_same_day_min_opening_window_return_rank",
    "isolated_same_day_min_continuation_rank",
    "min_cross_section_continuation_breadth",
    "min_recent_above_opening_window_close_ratio",
    "min_recent_above_opening_range_high_ratio",
    "min_recent_above_vwap_w5m_ratio",
    "min_recent_microprice_bias_bps",
    "min_recent_imbalance_pressure",
    "min_imbalance_pressure",
)

_CONSISTENCY_REPAIR_RANK_STEP = Decimal("0.05")

_CONSISTENCY_REPAIR_MIN_RANK_THRESHOLD = Decimal("0.01")

_CONSISTENCY_REPAIR_THRESHOLD_SCALE = Decimal("0.80")

_CONSISTENCY_REPAIR_MAX_SIGNAL_THRESHOLD_RELAXATIONS = 2


def run_consistent_profitability_frontier(args: argparse.Namespace) -> dict[str, Any]:
    return _run_consistent_profitability_frontier(args)


def main() -> int:
    args = _parse_args()
    try:
        payload = run_consistent_profitability_frontier(args)
    except (RuntimeError, ValueError) as exc:
        payload = _frontier_error_payload(exc)
        if args.json_output:
            _write_json_output(args.json_output, payload)
        print(str(exc), file=sys.stderr)
        return 1
    if args.json_output:
        _write_json_output(args.json_output, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cli_main() -> int:
    return main()


if __name__ == "__main__":
    raise SystemExit(cli_main())

__all__ = [
    "Any",
    "BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS",
    "CONFORMAL_TAIL_RISK_ALPHA",
    "Callable",
    "Counter",
    "DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS",
    "DatasetSnapshotReceipt",
    "DatasetWitness",
    "Decimal",
    "FrontierReplayWindows",
    "FullWindowConsistencyPolicy",
    "InvalidOperation",
    "Iterable",
    "Iterator",
    "MARKET_IMPACT_STRESS_SOURCE_MARKERS",
    "Mapping",
    "ObjectiveVetoPolicy",
    "OrderTypeAblationPolicy",
    "POST_COST_PNL_BASIS",
    "Path",
    "ProfitabilityConstraintPolicy",
    "ROUND_CEILING",
    "ROUND_DOWN",
    "ReplayTape",
    "RuntimeLedgerBucket",
    "Sequence",
    "_CONSISTENCY_REPAIR_BREADTH_KEYS",
    "_CONSISTENCY_REPAIR_COOLDOWN_KEYS",
    "_CONSISTENCY_REPAIR_ENTRY_KEYS",
    "_CONSISTENCY_REPAIR_MAX_SIGNAL_THRESHOLD_RELAXATIONS",
    "_CONSISTENCY_REPAIR_MIN_RANK_THRESHOLD",
    "_CONSISTENCY_REPAIR_RANK_STEP",
    "_CONSISTENCY_REPAIR_SIGNAL_THRESHOLD_KEYS",
    "_CONSISTENCY_REPAIR_THRESHOLD_SCALE",
    "_CONSISTENCY_REPAIR_TRIGGER_REASONS",
    "_CONSISTENCY_REPAIR_UNSAFE_REASONS",
    "_DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER",
    "_LOCAL_ONLY_OVERRIDE_KEYS",
    "_LOSS_REPAIR_BPS_FLOORS",
    "_LOSS_REPAIR_CAPITAL_SAFETY_BUFFER",
    "_LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE",
    "_LOSS_REPAIR_EXIT_LIMIT_KEYS",
    "_LOSS_REPAIR_LOCKOUT_KEYS",
    "_LOSS_REPAIR_MIN_SCALE_QUANTUM",
    "_LOSS_REPAIR_PARAM_EXPOSURE_KEYS",
    "_LOSS_REPAIR_STRATEGY_EXPOSURE_KEYS",
    "_LOSS_REPAIR_TRIGGER_REASONS",
    "_LOSS_REPAIR_TRIGGER_SUFFIXES",
    "_PAPER_PROBATION_ACTIVITY_REPAIR_REASONS",
    "_PAPER_PROBATION_CAPITAL_REPAIR_REASONS",
    "_PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS",
    "_PAPER_PROBATION_LOSS_REPAIR_REASONS",
    "_PAPER_PROBATION_QUEUE_SURVIVAL_REASONS",
    "_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH",
    "_PAPER_PROBATION_TAIL_RISK_REASONS",
    "_PAPER_PROBATION_TARGET_SCALE_QUANTUM",
    "_SAFE_EXACT_REPLAY_CANDIDATE_CAP",
    "_SAFE_EXACT_REPLAY_EXPLOITATION_SLOTS",
    "_SAFE_EXACT_REPLAY_EXPLORATION_SLOTS",
    "_SAFE_LOCAL_EXACT_REPLAY_WORKERS",
    "_SECOND_OOS_WINDOW_ID",
    "_SWEEP_SCHEMA_VERSION",
    "_WorklistItem",
    "_apply_exposure_clamp",
    "_apply_loss_control_tightening",
    "_artifact_run_dir_name",
    "_bounded_sim_handoff_metadata",
    "_breakeven_transaction_cost_buffer_metrics",
    "_build_economic_shortlist",
    "_build_frontier_payload",
    "_build_frontier_workflow_states",
    "_build_paper_probation_shortlist",
    "_build_replay_config",
    "_build_replay_tape_snapshot_receipt",
    "_business_days",
    "_cached_iter_signal_rows_factory",
    "_cached_signal_rows_patch",
    "_candidate_artifact_refs",
    "_candidate_evaluation_key_payload",
    "_candidate_exact_replay_ledger_artifact_refs",
    "_candidate_exact_replay_parity_ok",
    "_candidate_handoff_diagnostics",
    "_candidate_metric_decimal",
    "_candidate_metric_value",
    "_candidate_payload_key",
    "_candidate_post_cost_proof_blockers",
    "_candidate_record_seed",
    "_candidate_replay_lineage_payload",
    "_candidate_replay_tape_metadata_blockers",
    "_candidate_runtime_ledger_count",
    "_candidate_search_key",
    "_candidate_source_lineage_ok",
    "_candidate_symbols",
    "_candidate_universe_symbols",
    "_capital_repair_exposure_scale",
    "_clickhouse_endpoint_preflight_failure",
    "_clickhouse_host_requires_dns_preflight",
    "_conformal_tail_loss_buffer",
    "_conformal_tail_risk_metrics",
    "_consistency_penalty",
    "_consistency_repair_trigger_reason",
    "_counter_from_payload",
    "_daily_decimal_metric",
    "_daily_filled_notional",
    "_daily_int_metric",
    "_daily_liquidity_notional",
    "_decimal_or_none",
    "_decimal_payload",
    "_decimal_payload_metric",
    "_delay_depth_fillability",
    "_empty_replay_payload",
    "_enqueue_ranked_train_screen_survivors",
    "_exact_replay_ledger_artifact_update",
    "_exploration_distance",
    "_exploration_diversity_key",
    "_exploration_payload_signature",
    "_forced_order_type_sample_count",
    "_frontier_error_payload",
    "_frontier_exact_replay_bucket",
    "_frontier_exact_replay_bucket_has_authority",
    "_frontier_exact_replay_bucket_range",
    "_frontier_exact_replay_rows",
    "_frontier_ledger_datetime",
    "_frontier_ledger_text",
    "_frontier_state_item",
    "_generate_consistency_repair_children",
    "_generate_loss_repair_children",
    "_generate_symbol_prune_children",
    "_halve_positive_integer_candidate_param",
    "_holdout_oos_passed",
    "_implementation_uncertainty_metrics",
    "_increment_integer_candidate_param",
    "_int_mapping",
    "_iter_initial_worklist_candidates",
    "_iter_parameter_candidates",
    "_iter_strategy_override_candidates",
    "_load_candidate_record_seeds",
    "_load_replay_tape_rows",
    "_load_sweep_config",
    "_loss_repair_trigger_reason",
    "_mapping",
    "_max_best_day_share_of_total_pnl",
    "_max_drawdown_from_daily_net",
    "_near_miss_digest",
    "_nonnegative_int_metric",
    "_normalized_order_type",
    "_objective_veto_policy",
    "_optional_decimal",
    "_optional_int",
    "_order_lifecycle_metrics",
    "_order_type_ablation_artifact_dir",
    "_order_type_ablation_payload",
    "_order_type_ablation_policy",
    "_order_type_execution_metrics",
    "_order_type_replay_arm_summary",
    "_p10",
    "_paper_probation_notional_scale",
    "_paper_probation_notional_scale_decimal",
    "_paper_probation_repair_actions",
    "_paper_probation_repair_plan",
    "_paper_probation_required_actions",
    "_paper_probation_target_notional_scale",
    "_paper_probation_target_progress",
    "_parameter_exploration_priority",
    "_parameter_grid_items",
    "_parse_args",
    "_payload_digest",
    "_positive_capital_safe_summary",
    "_positive_train_screen_candidate",
    "_prefetch_signal_rows",
    "_rank_scored_candidates",
    "_rank_train_screen_survivors",
    "_reduced_exposure",
    "_relax_signal_threshold_candidate_param",
    "_replay_lineage_window_payload",
    "_replay_stress_metrics",
    "_replay_tape_row_days",
    "_replay_tape_selection_metadata",
    "_replay_tape_trading_days",
    "_replay_window_coverage_payload",
    "_resolve_frontier_replay_windows",
    "_resolve_full_window",
    "_resolve_prefetch_symbols",
    "_resolve_recent_trading_days",
    "_resolved_clickhouse_password",
    "_rolling_lower_bound",
    "_safe_decimal",
    "_safe_exact_replay_candidate_budget",
    "_second_oos_summary",
    "_select_exact_replay_train_survivors",
    "_selected_entry_order_type",
    "_selected_normalization_regime",
    "_snapshot_expected_days",
    "_stable_payload_hash",
    "_staged_search_budget_payload",
    "_strategy_item_from_configmap",
    "_strategy_universe_symbols",
    "_symbol_contributions_from_replay_payload",
    "_tightened_bps",
    "_top_counter_payload",
    "_train_gate_diagnostics_from_replay_payload",
    "_train_screen_active_ratio",
    "_train_screen_failures",
    "_train_screen_worst_day_loss",
    "_truthy_metric",
    "_write_json_output",
    "apply_candidate_to_configmap",
    "apply_candidate_to_configmap_with_overrides",
    "argparse",
    "build_dataset_snapshot_receipt",
    "build_replay_decomposition",
    "build_runtime_ledger_buckets",
    "build_scorecard",
    "cast",
    "cli_main",
    "contextlib",
    "dataclass",
    "date",
    "datetime",
    "deployable_lower_bound_missing_count",
    "deployable_lower_bound_net_pnl_per_day",
    "deployable_proof_failed_gate_count",
    "deque",
    "derive_family_template_id",
    "ensure_fresh_snapshot",
    "evaluate_vetoes",
    "family_template_dir",
    "hashlib",
    "heapq",
    "iter_regular_equities_session_dates",
    "itertools",
    "json",
    "load_family_template",
    "load_replay_tape",
    "main",
    "max_family_contribution_share",
    "max_symbol_concentration_share",
    "os",
    "patch",
    "rank_scorecards",
    "regime_slice_pass_rate",
    "replay_mod",
    "run_consistent_profitability_frontier",
    "run_replay",
    "score_replay_profitability_candidate",
    "slice_tape_by_symbols",
    "slice_tape_by_window",
    "socket",
    "summarize_replay_profitability",
    "sys",
    "tempfile",
    "time",
    "timedelta",
    "timezone",
    "urlparse",
    "validate_tape_freshness",
    "yaml",
]
