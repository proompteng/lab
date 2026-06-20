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
import scripts.consistent_profitability_frontier.replay_data as replay_data_module
from scripts.local_intraday_tsmom_replay import run_replay
from scripts.search_profitability_frontier import (
    _SWEEP_SCHEMA_VERSION,
    _build_replay_config,
    _load_sweep_config,
    _resolve_recent_trading_days,
    apply_candidate_to_configmap,
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
    apply_candidate_to_configmap_with_overrides as _base_apply_candidate_to_configmap_with_overrides,
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


def apply_candidate_to_configmap_with_overrides(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    candidate_params: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    disable_other_strategies: bool,
) -> dict[str, Any]:
    original_apply_candidate = replay_data_module.apply_candidate_to_configmap
    replay_data_module.apply_candidate_to_configmap = apply_candidate_to_configmap
    try:
        return _base_apply_candidate_to_configmap_with_overrides(
            configmap_payload=configmap_payload,
            strategy_name=strategy_name,
            candidate_params=candidate_params,
            strategy_overrides=strategy_overrides,
            disable_other_strategies=disable_other_strategies,
        )
    finally:
        replay_data_module.apply_candidate_to_configmap = original_apply_candidate


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
    clickhouse_preflight_failure = _clickhouse_endpoint_preflight_failure(args)
    if clickhouse_preflight_failure:
        raise RuntimeError(clickhouse_preflight_failure)

    clickhouse_password = _resolved_clickhouse_password(args)
    sweep_config = _load_sweep_config(args.sweep_config.resolve())
    second_oos_day_count = max(0, int(getattr(args, "second_oos_days", 0) or 0))
    replay_tape_path = getattr(args, "replay_tape_path", None)
    replay_tape_manifest_path = (
        Path(args.replay_tape_manifest).resolve()
        if getattr(args, "replay_tape_manifest", None) is not None
        else None
    )
    loaded_replay_tape: ReplayTape | None = None
    explicit_expected_last_trading_day = (
        date.fromisoformat(str(args.expected_last_trading_day))
        if str(args.expected_last_trading_day or "").strip()
        else None
    )
    recent_day_ceiling = explicit_expected_last_trading_day
    if recent_day_ceiling is None and str(args.full_window_end_date or "").strip():
        recent_day_ceiling = date.fromisoformat(str(args.full_window_end_date))
    if replay_tape_path is not None:
        loaded_replay_tape = load_replay_tape(
            Path(replay_tape_path).resolve(),
            manifest_path=replay_tape_manifest_path,
        )
        recent_days = _replay_tape_trading_days(loaded_replay_tape)
    else:
        recent_days = _resolve_recent_trading_days(
            clickhouse_http_url=str(args.clickhouse_http_url),
            clickhouse_username=(str(args.clickhouse_username).strip() or None),
            clickhouse_password=clickhouse_password,
            limit=(
                max(1, int(args.train_days))
                + max(1, int(args.holdout_days))
                + second_oos_day_count
            ),
            latest_trading_day=recent_day_ceiling,
        )
    window = _resolve_frontier_replay_windows(
        recent_days,
        train_days=max(1, int(args.train_days)),
        holdout_days=max(1, int(args.holdout_days)),
        second_oos_days=second_oos_day_count,
    )
    full_window_start, full_window_end = _resolve_full_window(
        args=args,
        train_days=window.train_days,
        holdout_days=window.holdout_days,
    )
    if window.second_oos_days and not str(args.full_window_end_date or "").strip():
        full_window_end = window.second_oos_end or full_window_end

    base_configmap = yaml.safe_load(
        args.strategy_configmap.resolve().read_text(encoding="utf-8")
    )
    if not isinstance(base_configmap, dict):
        raise ValueError("base_strategy_configmap_not_mapping")

    family = str(sweep_config.get("family") or "").strip()
    strategy_name = str(sweep_config.get("strategy_name") or "").strip()
    if not family or not strategy_name:
        raise ValueError("sweep_config_missing_family_or_strategy_name")
    family_template = load_family_template(
        derive_family_template_id(
            explicit_id=str(sweep_config.get("family_template_id") or "").strip()
            or None,
            family=family,
        ),
        directory=args.family_template_dir,
    )
    disable_other_strategies = bool(sweep_config.get("disable_other_strategies", True))

    parameter_grid = sweep_config.get("parameters")
    if not isinstance(parameter_grid, Mapping):
        raise ValueError("sweep_config_parameters_not_mapping")
    strategy_override_grid = sweep_config.get("strategy_overrides")
    if strategy_override_grid is not None and not isinstance(
        strategy_override_grid, Mapping
    ):
        raise ValueError("sweep_config_strategy_overrides_not_mapping")

    constraints_value = sweep_config.get("constraints")
    if constraints_value is None:
        constraints: Mapping[str, Any] = {}
    elif isinstance(constraints_value, Mapping):
        constraints = cast(Mapping[str, Any], constraints_value)
    else:
        raise ValueError("sweep_config_constraints_not_mapping")

    consistency_value = sweep_config.get("consistency_constraints")
    if consistency_value is None:
        consistency_constraints: Mapping[str, Any] = {}
    elif isinstance(consistency_value, Mapping):
        consistency_constraints = cast(Mapping[str, Any], consistency_value)
    else:
        raise ValueError("sweep_config_consistency_constraints_not_mapping")

    holdout_policy = ProfitabilityConstraintPolicy(
        holdout_target_net_per_day=Decimal(
            str(constraints.get("holdout_target_net_per_day", "200"))
        ),
        min_active_holdout_days=int(constraints.get("min_active_holdout_days", 2)),
        max_worst_holdout_day_loss=Decimal(
            str(constraints.get("max_worst_holdout_day_loss", "200"))
        ),
        min_profit_factor=Decimal(str(constraints.get("min_profit_factor", "1.2"))),
        require_training_decisions=bool(
            constraints.get("require_training_decisions", True)
        ),
        require_holdout_decisions=bool(
            constraints.get("require_holdout_decisions", True)
        ),
    )
    consistency_policy = FullWindowConsistencyPolicy(
        target_net_per_day=Decimal(
            str(consistency_constraints.get("target_net_per_day", "200"))
        ),
        min_daily_net_pnl=Decimal(
            str(consistency_constraints.get("min_daily_net_pnl", "0"))
        ),
        # Widened full-window evaluations intentionally omit count-based activity thresholds
        # because train+holdout counts are not authoritative for the larger window.
        min_active_days=_optional_int(
            consistency_constraints.get("min_active_days"), default=0
        ),
        min_active_ratio=Decimal(
            str(consistency_constraints.get("min_active_ratio", "0"))
        ),
        min_positive_days=int(consistency_constraints.get("min_positive_days", 0)),
        max_worst_day_loss=Decimal(
            str(consistency_constraints.get("max_worst_day_loss", "250"))
        ),
        max_negative_days=int(consistency_constraints.get("max_negative_days", 2)),
        max_drawdown=Decimal(str(consistency_constraints.get("max_drawdown", "600"))),
        max_best_day_share_of_total_pnl=Decimal(
            str(consistency_constraints.get("max_best_day_share_of_total_pnl", "1"))
        ),
        min_avg_filled_notional_per_day=Decimal(
            str(consistency_constraints.get("min_avg_filled_notional_per_day", "0"))
        ),
        min_avg_filled_notional_per_active_day=Decimal(
            str(
                consistency_constraints.get(
                    "min_avg_filled_notional_per_active_day", "0"
                )
            )
        ),
        require_every_day_active=bool(
            consistency_constraints.get("require_every_day_active", True)
        ),
        min_regime_slice_pass_rate=Decimal(
            str(consistency_constraints.get("min_regime_slice_pass_rate", "0"))
        ),
        max_symbol_concentration_share=Decimal(
            str(consistency_constraints.get("max_symbol_concentration_share", "1"))
        ),
        max_entry_family_contribution_share=Decimal(
            str(consistency_constraints.get("max_entry_family_contribution_share", "1"))
        ),
        max_gross_exposure_pct_equity=Decimal(
            str(
                consistency_constraints.get(
                    "max_gross_exposure_pct_equity", "999999999"
                )
            )
        ),
        min_cash=Decimal(str(consistency_constraints.get("min_cash", "-999999999"))),
        min_window_weekday_count=_optional_int(
            consistency_constraints.get("min_window_weekday_count"),
            default=0,
        ),
    )
    order_type_ablation_policy = _order_type_ablation_policy(sweep_config)
    max_train_screen_worst_day_loss = Decimal(
        str(
            getattr(args, "max_train_screen_worst_day_loss", "")
            or consistency_policy.max_worst_day_loss
        )
    )
    min_train_screen_net_per_day = Decimal(
        str(getattr(args, "min_train_screen_net_per_day", "0") or "0")
    )
    min_train_screen_active_ratio = Decimal(
        str(getattr(args, "min_train_screen_active_ratio", "0.50") or "0.50")
    )
    symbols = tuple(
        symbol.strip().upper()
        for symbol in str(args.symbols or "").split(",")
        if symbol.strip()
    )
    override_candidates = _iter_strategy_override_candidates(
        cast(Mapping[str, Iterable[Any]] | None, strategy_override_grid)
    )
    seed_candidates = _load_candidate_record_seeds(
        paths=cast(Iterable[Path], getattr(args, "candidate_record", [])),
        strategy_name=strategy_name,
    )
    prefetch_symbols = _resolve_prefetch_symbols(
        cli_symbols=symbols,
        override_candidates=override_candidates,
        configmap_payload=base_configmap,
        strategy_name=strategy_name,
    )
    expected_last_trading_day = explicit_expected_last_trading_day or (
        full_window_end if str(args.full_window_end_date or "").strip() else None
    )
    expected_snapshot_days = _snapshot_expected_days(
        window=window,
        full_window_start=full_window_start,
        full_window_end=full_window_end,
        require_full_window_coverage=bool(
            str(args.full_window_start_date or "").strip()
            or str(args.full_window_end_date or "").strip()
        ),
    )
    cached_rows: list[Any] | None = None
    replay_tape_validation: dict[str, Any] | None = None
    if loaded_replay_tape is not None:
        cached_rows, replay_tape_validation = _load_replay_tape_rows(
            tape_path=Path(replay_tape_path).resolve(),
            manifest_path=replay_tape_manifest_path,
            start_date=full_window_start,
            end_date=full_window_end,
            symbols=prefetch_symbols,
            allow_stale_tape=bool(getattr(args, "allow_stale_tape", False)),
            tape=loaded_replay_tape,
        )
        dataset_snapshot_receipt = _build_replay_tape_snapshot_receipt(
            validation=replay_tape_validation,
            rows=cached_rows,
            start_day=full_window_start,
            end_day=full_window_end,
            expected_last_trading_day=expected_last_trading_day or full_window_end,
            expected_trading_days=expected_snapshot_days,
            allow_stale_tape=bool(args.allow_stale_tape),
        )
    else:
        dataset_snapshot_receipt = build_dataset_snapshot_receipt(
            clickhouse_http_url=str(args.clickhouse_http_url),
            clickhouse_username=(str(args.clickhouse_username).strip() or None),
            clickhouse_password=clickhouse_password,
            start_day=full_window_start,
            end_day=full_window_end,
            expected_last_trading_day=expected_last_trading_day,
            expected_trading_days=expected_snapshot_days,
            allow_stale_tape=bool(args.allow_stale_tape),
        )
    ensure_fresh_snapshot(
        dataset_snapshot_receipt,
        allow_stale_tape=bool(args.allow_stale_tape),
    )
    objective_veto_policy = _objective_veto_policy(
        consistency_policy=consistency_policy,
        template_defaults=family_template.default_hard_vetoes,
        trading_day_count=len(window.train_days) + len(window.holdout_days),
    )
    collect_train_gate_diagnostics = bool(
        getattr(args, "collect_train_gate_diagnostics", False)
    )

    scored: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(
        prefix="torghut-consistent-profitability-frontier-"
    ) as tmpdir:
        root = Path(tmpdir)
        order_type_ablation_artifact_dir = _order_type_ablation_artifact_dir(
            args=args,
            root=root,
        )
        order_type_ablation_evaluated = 0
        if cached_rows is None and args.prefetch_full_window_rows:
            cached_rows = _prefetch_signal_rows(
                strategy_configmap_path=args.strategy_configmap.resolve(),
                clickhouse_http_url=str(args.clickhouse_http_url),
                clickhouse_username=(str(args.clickhouse_username).strip() or None),
                clickhouse_password=clickhouse_password,
                start_date=full_window_start,
                end_date=full_window_end,
                start_equity=Decimal(str(args.start_equity)),
                chunk_minutes=max(1, int(args.chunk_minutes)),
                symbols=prefetch_symbols,
                progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
            )
        candidate_index = 0
        candidate_budget = _safe_exact_replay_candidate_budget(
            getattr(
                args, "max_candidates_to_evaluate", _SAFE_EXACT_REPLAY_CANDIDATE_CAP
            )
        )
        staged_search = _staged_search_budget_payload(
            args=args,
            candidate_budget=candidate_budget,
        )
        train_screen_candidate_budget = int(
            staged_search["train_screen_candidate_budget"]
        )
        full_replay_candidate_budget = int(
            staged_search["full_replay_candidate_budget"]
        )
        staged_train_survivor_ranking_enabled = bool(staged_search["enabled"])
        train_screen_candidates_started = 0
        full_replay_candidates_started = 0
        train_screen_only_candidates = 0
        full_replay_budget_discarded_candidates = 0
        proof_only_full_window_replay_captures = 0
        deferred_train_survivors: list[_WorklistItem] = []
        deferred_train_survivors_enqueued = False
        initial_candidates = _iter_initial_worklist_candidates(
            parameter_grid=parameter_grid,
            override_candidates=override_candidates,
            seed_candidates=seed_candidates,
        )
        initial_candidates_exhausted = False
        worklist: deque[_WorklistItem] = deque()
        seen_candidate_keys: set[str] = set()
        cache_context: contextlib.AbstractContextManager[None]
        cache_context = (
            _cached_signal_rows_patch(cached_rows)
            if cached_rows is not None
            else contextlib.nullcontext()
        )
        with cache_context:
            budget_exhausted = False
            while True:
                fresh_train_budget_exhausted = (
                    train_screen_candidate_budget > 0
                    and train_screen_candidates_started >= train_screen_candidate_budget
                )
                if (
                    staged_train_survivor_ranking_enabled
                    and not deferred_train_survivors_enqueued
                    and (
                        fresh_train_budget_exhausted
                        or (initial_candidates_exhausted and not worklist)
                    )
                ):
                    _enqueue_ranked_train_screen_survivors(
                        worklist=worklist,
                        survivors=deferred_train_survivors,
                        full_replay_candidate_budget=full_replay_candidate_budget,
                    )
                    deferred_train_survivors_enqueued = True
                    budget_exhausted = fresh_train_budget_exhausted

                allow_fresh_train_candidate = (
                    not staged_train_survivor_ranking_enabled
                    or not fresh_train_budget_exhausted
                )
                seed_initial_candidate = (
                    allow_fresh_train_candidate
                    and not initial_candidates_exhausted
                    and (not worklist or len(scored) % 2 == 0)
                )
                if seed_initial_candidate:
                    try:
                        next_initial = next(initial_candidates)
                    except StopIteration:
                        initial_candidates_exhausted = True
                    else:
                        if worklist:
                            worklist.appendleft(next_initial)
                        else:
                            worklist.append(next_initial)
                if not worklist:
                    break
                if (
                    staged_train_survivor_ranking_enabled
                    and fresh_train_budget_exhausted
                    and deferred_train_survivors_enqueued
                    and worklist[0].deferred_train_payload is None
                ):
                    budget_exhausted = True
                    break
                if (
                    not staged_train_survivor_ranking_enabled
                    and train_screen_candidate_budget > 0
                    and train_screen_candidates_started >= train_screen_candidate_budget
                ):
                    budget_exhausted = True
                    break
                worklist_item = worklist.popleft()
                params_candidate = worklist_item.params_candidate
                override_candidate = worklist_item.strategy_overrides
                deferred_train_survivor = (
                    worklist_item.deferred_train_payload is not None
                )
                candidate_key = (
                    str(worklist_item.deferred_candidate_key)
                    if deferred_train_survivor
                    and worklist_item.deferred_candidate_key is not None
                    else _candidate_search_key(
                        params_candidate=params_candidate,
                        strategy_overrides=override_candidate,
                    )
                )
                if deferred_train_survivor:
                    current_candidate_index = int(
                        worklist_item.deferred_candidate_index or candidate_index + 1
                    )
                else:
                    if candidate_key in seen_candidate_keys:
                        continue
                    seen_candidate_keys.add(candidate_key)
                    candidate_index += 1
                    current_candidate_index = candidate_index
                candidate_symbols = _candidate_symbols(
                    cli_symbols=symbols,
                    strategy_overrides=override_candidate,
                )
                candidate_configmap = apply_candidate_to_configmap_with_overrides(
                    configmap_payload=base_configmap,
                    strategy_name=strategy_name,
                    candidate_params=params_candidate,
                    strategy_overrides=override_candidate,
                    disable_other_strategies=disable_other_strategies,
                )
                candidate_configmap_path = (
                    root / f"candidate-{current_candidate_index:04d}.yaml"
                )
                candidate_configmap_path.write_text(
                    yaml.safe_dump(candidate_configmap, sort_keys=False),
                    encoding="utf-8",
                )

                if deferred_train_survivor:
                    train_payload = dict(
                        cast(Mapping[str, Any], worklist_item.deferred_train_payload)
                    )
                    train_screen_failures: list[str] = []
                else:
                    train_payload = run_replay(
                        _build_replay_config(
                            strategy_configmap_path=candidate_configmap_path,
                            clickhouse_http_url=str(args.clickhouse_http_url),
                            clickhouse_username=(
                                str(args.clickhouse_username).strip() or None
                            ),
                            clickhouse_password=clickhouse_password,
                            start_date=window.train_start,
                            end_date=window.train_end,
                            start_equity=Decimal(str(args.start_equity)),
                            chunk_minutes=max(1, int(args.chunk_minutes)),
                            symbols=candidate_symbols,
                            progress_log_interval_seconds=max(
                                1, int(args.progress_log_seconds)
                            ),
                            capture_trace_funnel=collect_train_gate_diagnostics,
                        )
                    )
                    train_screen_candidates_started += 1
                    train_screen_failures = (
                        _train_screen_failures(
                            train_payload=train_payload,
                            holdout_policy=holdout_policy,
                            consistency_policy=consistency_policy,
                            min_train_net_per_day=min_train_screen_net_per_day,
                            min_train_active_ratio=min_train_screen_active_ratio,
                            max_train_worst_day_loss=max_train_screen_worst_day_loss,
                        )
                        if bool(getattr(args, "train_screening", True))
                        else []
                    )
                    if (
                        staged_train_survivor_ranking_enabled
                        and not train_screen_failures
                    ):
                        deferred_train_survivors.append(
                            _WorklistItem(
                                params_candidate=dict(params_candidate),
                                strategy_overrides=dict(override_candidate),
                                candidate_record_seed=worklist_item.candidate_record_seed,
                                symbol_prune_iteration=(
                                    worklist_item.symbol_prune_iteration
                                ),
                                loss_repair_iteration=(
                                    worklist_item.loss_repair_iteration
                                ),
                                consistency_repair_iteration=(
                                    worklist_item.consistency_repair_iteration
                                ),
                                pruned_symbol=worklist_item.pruned_symbol,
                                repair_reason=worklist_item.repair_reason,
                                parent_candidate_id=worklist_item.parent_candidate_id,
                                deferred_candidate_index=current_candidate_index,
                                deferred_candidate_key=candidate_key,
                                deferred_train_payload=train_payload,
                            )
                        )
                        continue
                full_replay_budget_exhausted = (
                    not worklist_item.deferred_full_replay_selected
                    if deferred_train_survivor
                    else (
                        not train_screen_failures
                        and full_replay_candidate_budget > 0
                        and full_replay_candidates_started
                        >= full_replay_candidate_budget
                    )
                )
                full_replay_skip_reasons = (
                    ["full_replay_candidate_budget_exhausted"]
                    if full_replay_budget_exhausted
                    else []
                )
                holdout_replay_skipped = bool(
                    train_screen_failures or full_replay_skip_reasons
                )
                full_window_replay_skipped = bool(
                    train_screen_failures or full_replay_skip_reasons
                )
                proof_only_full_window_replay_captured = False
                proof_only_full_window_reason = ""
                if holdout_replay_skipped:
                    if train_screen_failures:
                        train_screen_only_candidates += 1
                    if full_replay_skip_reasons:
                        full_replay_budget_discarded_candidates += 1
                        budget_exhausted = True
                    second_oos_start = window.second_oos_start
                    second_oos_end = window.second_oos_end
                    holdout_payload = _empty_replay_payload(
                        start_date=window.holdout_start,
                        end_date=window.holdout_end,
                    )
                    second_oos_payload = (
                        _empty_replay_payload(
                            start_date=second_oos_start,
                            end_date=second_oos_end,
                        )
                        if second_oos_start is not None and second_oos_end is not None
                        else None
                    )
                    capture_rejected_seed_ledger = (
                        bool(
                            getattr(
                                args,
                                "capture_rejected_seed_full_window_ledger",
                                False,
                            )
                        )
                        and worklist_item.candidate_record_seed
                        and bool(train_screen_failures)
                    )
                    top_rejected_capture_budget = max(
                        0,
                        int(
                            getattr(
                                args,
                                "capture_positive_rejected_full_window_ledgers",
                                0,
                            )
                            or 0
                        ),
                    )
                    capture_ranked_rejected_ledger = (
                        proof_only_full_window_replay_captures
                        < top_rejected_capture_budget
                        and _positive_train_screen_candidate(train_payload)
                    )
                    if capture_rejected_seed_ledger or capture_ranked_rejected_ledger:
                        full_replay_candidates_started += 1
                        proof_only_full_window_replay_captures += 1
                        proof_only_full_window_replay_captured = True
                        full_window_replay_skipped = False
                        proof_only_full_window_reason = (
                            "train_screen_rejected_candidate_record_seed"
                            if capture_rejected_seed_ledger
                            else (
                                "full_replay_budget_exhausted_positive_train_screen"
                                if full_replay_skip_reasons
                                else "positive_train_screen_reject"
                            )
                        )
                        full_window_payload = run_replay(
                            _build_replay_config(
                                strategy_configmap_path=candidate_configmap_path,
                                clickhouse_http_url=str(args.clickhouse_http_url),
                                clickhouse_username=(
                                    str(args.clickhouse_username).strip() or None
                                ),
                                clickhouse_password=clickhouse_password,
                                start_date=full_window_start,
                                end_date=full_window_end,
                                start_equity=Decimal(str(args.start_equity)),
                                chunk_minutes=max(1, int(args.chunk_minutes)),
                                symbols=candidate_symbols,
                                progress_log_interval_seconds=max(
                                    1, int(args.progress_log_seconds)
                                ),
                                capture_trace_funnel=collect_train_gate_diagnostics,
                                capture_exact_replay_ledger=True,
                            )
                        )
                    else:
                        full_window_payload = train_payload
                else:
                    full_replay_candidates_started += 1
                    holdout_payload = run_replay(
                        _build_replay_config(
                            strategy_configmap_path=candidate_configmap_path,
                            clickhouse_http_url=str(args.clickhouse_http_url),
                            clickhouse_username=(
                                str(args.clickhouse_username).strip() or None
                            ),
                            clickhouse_password=clickhouse_password,
                            start_date=window.holdout_start,
                            end_date=window.holdout_end,
                            start_equity=Decimal(str(args.start_equity)),
                            chunk_minutes=max(1, int(args.chunk_minutes)),
                            symbols=candidate_symbols,
                            progress_log_interval_seconds=max(
                                1, int(args.progress_log_seconds)
                            ),
                            capture_trace_funnel=collect_train_gate_diagnostics,
                        )
                    )
                    second_oos_payload = None
                    if window.second_oos_days:
                        second_oos_start = window.second_oos_start
                        second_oos_end = window.second_oos_end
                        if second_oos_start is None or second_oos_end is None:
                            raise ValueError("second_oos_window_missing")
                        second_oos_payload = run_replay(
                            _build_replay_config(
                                strategy_configmap_path=candidate_configmap_path,
                                clickhouse_http_url=str(args.clickhouse_http_url),
                                clickhouse_username=(
                                    str(args.clickhouse_username).strip() or None
                                ),
                                clickhouse_password=clickhouse_password,
                                start_date=second_oos_start,
                                end_date=second_oos_end,
                                start_equity=Decimal(str(args.start_equity)),
                                chunk_minutes=max(1, int(args.chunk_minutes)),
                                symbols=candidate_symbols,
                                progress_log_interval_seconds=max(
                                    1, int(args.progress_log_seconds)
                                ),
                                capture_trace_funnel=collect_train_gate_diagnostics,
                            )
                        )
                    full_window_payload = run_replay(
                        _build_replay_config(
                            strategy_configmap_path=candidate_configmap_path,
                            clickhouse_http_url=str(args.clickhouse_http_url),
                            clickhouse_username=(
                                str(args.clickhouse_username).strip() or None
                            ),
                            clickhouse_password=clickhouse_password,
                            start_date=full_window_start,
                            end_date=full_window_end,
                            start_equity=Decimal(str(args.start_equity)),
                            chunk_minutes=max(1, int(args.chunk_minutes)),
                            symbols=candidate_symbols,
                            progress_log_interval_seconds=max(
                                1, int(args.progress_log_seconds)
                            ),
                            capture_trace_funnel=collect_train_gate_diagnostics,
                            capture_exact_replay_ledger=True,
                        )
                    )

                base_result = score_replay_profitability_candidate(
                    family=family,
                    strategy_name=strategy_name,
                    replay_config={
                        "candidate_index": current_candidate_index,
                        "params": params_candidate,
                        "strategy_overrides": override_candidate,
                        "train_start_date": window.train_start.isoformat(),
                        "train_end_date": window.train_end.isoformat(),
                        "holdout_start_date": window.holdout_start.isoformat(),
                        "holdout_end_date": window.holdout_end.isoformat(),
                        "full_window_start_date": full_window_start.isoformat(),
                        "full_window_end_date": full_window_end.isoformat(),
                    },
                    train_payload=train_payload,
                    holdout_payload=holdout_payload,
                    policy=holdout_policy,
                )
                consistency_penalty, full_window_summary = _consistency_penalty(
                    full_window_payload=full_window_payload,
                    policy=consistency_policy,
                )
                second_oos_penalty = Decimal("0")
                second_oos_summary: dict[str, Any] | None = None
                if second_oos_payload is not None:
                    second_oos_penalty, second_oos_summary = _second_oos_summary(
                        second_oos_payload=second_oos_payload,
                        policy=consistency_policy,
                    )
                adjusted_score = (
                    base_result.score
                    + Decimal(full_window_summary["net_per_day"])
                    - consistency_penalty
                    - second_oos_penalty
                )
                candidate_payload = base_result.to_payload()
                exact_replay_ledger_update: dict[str, Any] = {}
                order_type_ablation_update: dict[str, Any] = {}
                if (
                    order_type_ablation_policy.enabled
                    and not full_window_replay_skipped
                    and not proof_only_full_window_replay_captured
                    and order_type_ablation_evaluated
                    < order_type_ablation_policy.max_candidates
                ):
                    order_type_arm_payloads: dict[str, Mapping[str, Any]] = {}
                    for forced_order_type in ("market", "limit"):
                        arm_configmap = apply_candidate_to_configmap_with_overrides(
                            configmap_payload=base_configmap,
                            strategy_name=strategy_name,
                            candidate_params={
                                **params_candidate,
                                "entry_order_type": forced_order_type,
                            },
                            strategy_overrides=override_candidate,
                            disable_other_strategies=disable_other_strategies,
                        )
                        arm_configmap_path = (
                            root
                            / f"candidate-{current_candidate_index:04d}-order-type-{forced_order_type}.yaml"
                        )
                        arm_configmap_path.write_text(
                            yaml.safe_dump(arm_configmap, sort_keys=False),
                            encoding="utf-8",
                        )
                        order_type_arm_payloads[forced_order_type] = run_replay(
                            _build_replay_config(
                                strategy_configmap_path=arm_configmap_path,
                                clickhouse_http_url=str(args.clickhouse_http_url),
                                clickhouse_username=(
                                    str(args.clickhouse_username).strip() or None
                                ),
                                clickhouse_password=clickhouse_password,
                                start_date=full_window_start,
                                end_date=full_window_end,
                                start_equity=Decimal(str(args.start_equity)),
                                chunk_minutes=max(1, int(args.chunk_minutes)),
                                symbols=candidate_symbols,
                                progress_log_interval_seconds=max(
                                    1, int(args.progress_log_seconds)
                                ),
                            )
                        )
                    artifact_payload, order_type_ablation_update = (
                        _order_type_ablation_payload(
                            candidate_index=current_candidate_index,
                            candidate_id=str(candidate_payload["candidate_id"]),
                            policy=order_type_ablation_policy,
                            candidate_params=params_candidate,
                            strategy_overrides=override_candidate,
                            market_payload=order_type_arm_payloads["market"],
                            limit_payload=order_type_arm_payloads["limit"],
                            start_date=full_window_start,
                            end_date=full_window_end,
                        )
                    )
                    artifact_path = (
                        order_type_ablation_artifact_dir
                        / f"candidate-{current_candidate_index:04d}-order-type-ablation.json"
                    )
                    artifact_ref = str(artifact_path)
                    artifact_payload["artifact_ref"] = artifact_ref
                    _write_json_output(artifact_path, artifact_payload)
                    order_type_ablation_update["order_type_ablation_artifact_ref"] = (
                        artifact_ref
                    )
                    candidate_payload["order_type_ablation"] = {
                        "artifact_ref": artifact_ref,
                        "passed": artifact_payload["passed"],
                        "sample_count": artifact_payload["sample_count"],
                        "selected_order_type": artifact_payload["selected_order_type"],
                        "opportunity_cost_bps": artifact_payload[
                            "opportunity_cost_bps"
                        ],
                    }
                    order_type_ablation_evaluated += 1
                candidate_payload["full_window"] = full_window_summary
                if second_oos_summary is not None:
                    candidate_payload["second_oos"] = second_oos_summary
                candidate_payload["consistency_penalty"] = str(consistency_penalty)
                if second_oos_summary is not None:
                    candidate_payload["second_oos_penalty"] = str(second_oos_penalty)
                candidate_payload["adjusted_score"] = str(adjusted_score)
                candidate_payload["search_iteration"] = worklist_item.search_iteration
                candidate_payload["symbol_prune_iteration"] = (
                    worklist_item.symbol_prune_iteration
                )
                candidate_payload["loss_repair_iteration"] = (
                    worklist_item.loss_repair_iteration
                )
                candidate_payload["consistency_repair_iteration"] = (
                    worklist_item.consistency_repair_iteration
                )
                candidate_payload["family_template_id"] = family_template.family_id
                candidate_payload["dataset_snapshot_id"] = (
                    dataset_snapshot_receipt.snapshot_id
                )
                candidate_payload["dataset_snapshot_receipt"] = (
                    dataset_snapshot_receipt.to_payload()
                )
                if replay_tape_validation is not None:
                    candidate_payload["replay_tape"] = dict(replay_tape_validation)
                replay_lineage = _candidate_replay_lineage_payload(
                    candidate_configmap_path=candidate_configmap_path,
                    candidate_search_key=candidate_key,
                    dataset_snapshot_id=dataset_snapshot_receipt.snapshot_id,
                    train_payload=train_payload,
                    holdout_payload=holdout_payload,
                    full_window_payload=full_window_payload,
                    second_oos_payload=second_oos_payload,
                    window=window,
                    full_window_start=full_window_start,
                    full_window_end=full_window_end,
                    holdout_replay_skipped=holdout_replay_skipped,
                    full_window_replay_skipped=full_window_replay_skipped,
                )
                candidate_payload["replay_lineage"] = replay_lineage
                candidate_evaluation_key = _candidate_evaluation_key_payload(
                    candidate_search_key=candidate_key,
                    params_candidate=params_candidate,
                    strategy_overrides=override_candidate,
                    replay_lineage=replay_lineage,
                    replay_tape_validation=replay_tape_validation,
                    window=window,
                    full_window_start=full_window_start,
                    full_window_end=full_window_end,
                    full_window_summary=full_window_summary,
                )
                candidate_payload["candidate_evaluation_key"] = (
                    candidate_evaluation_key["candidate_evaluation_key"]
                )
                candidate_payload["candidate_evaluation_key_payload"] = (
                    candidate_evaluation_key
                )
                exact_replay_ledger_update = _exact_replay_ledger_artifact_update(
                    args=args,
                    root=root,
                    candidate_index=current_candidate_index,
                    candidate_id=str(candidate_payload["candidate_id"]),
                    full_window_payload=full_window_payload,
                    dataset_snapshot_id=dataset_snapshot_receipt.snapshot_id,
                    replay_lineage=replay_lineage,
                    candidate_evaluation_key=candidate_evaluation_key,
                    replay_tape_validation=replay_tape_validation,
                    candidate_search_key=candidate_key,
                    candidate_symbols=candidate_symbols,
                    full_window_start=full_window_start,
                    full_window_end=full_window_end,
                    proof_only_reason=(
                        proof_only_full_window_reason
                        if proof_only_full_window_replay_captured
                        else ""
                    ),
                )
                if exact_replay_ledger_update:
                    artifact_ref = str(
                        exact_replay_ledger_update["exact_replay_ledger_artifact_ref"]
                    )
                    candidate_payload.update(exact_replay_ledger_update)
                    candidate_payload["replay_artifact_refs"] = list(
                        dict.fromkeys(
                            [
                                *cast(
                                    Sequence[Any],
                                    candidate_payload.get("replay_artifact_refs") or (),
                                ),
                                artifact_ref,
                            ]
                        )
                    )
                candidate_payload["screening"] = {
                    "schema_version": "torghut.frontier-train-screen.v1",
                    "enabled": bool(getattr(args, "train_screening", True)),
                    "status": "rejected" if train_screen_failures else "passed",
                    "stage": "train",
                    "reasons": train_screen_failures,
                    "min_train_net_per_day": str(min_train_screen_net_per_day),
                    "min_train_active_ratio": str(min_train_screen_active_ratio),
                    "max_train_worst_day_loss": str(max_train_screen_worst_day_loss),
                    "holdout_replay_skipped": holdout_replay_skipped,
                    "full_window_replay_skipped": full_window_replay_skipped,
                    "full_replay_skip_reasons": full_replay_skip_reasons,
                    "proof_only_full_window_replay_captured": (
                        proof_only_full_window_replay_captured
                    ),
                    "second_oos_replay_skipped": bool(
                        (train_screen_failures or full_replay_skip_reasons)
                        and window.second_oos_days
                    ),
                }
                candidate_payload["staged_search"] = {
                    "schema_version": "torghut.frontier-candidate-staged-search.v1",
                    "stage": (
                        (
                            "full_replay_budget_exhausted_full_window_proof"
                            if full_replay_skip_reasons
                            else "train_screen_rejected_full_window_proof"
                        )
                        if proof_only_full_window_replay_captured
                        else (
                            "train_screen_passed_full_replay_budget_exhausted"
                            if full_replay_skip_reasons
                            else "train_screen_only"
                            if holdout_replay_skipped
                            else "full_replay"
                        )
                    ),
                    "train_screen_multiplier": int(
                        staged_search["train_screen_multiplier"]
                    ),
                    "full_replay_candidate_budget": full_replay_candidate_budget,
                    "full_replay_candidates_started": full_replay_candidates_started,
                    "full_replay_budget_discarded_candidates": (
                        full_replay_budget_discarded_candidates
                    ),
                    "proof_only_full_window_replay_captures": (
                        proof_only_full_window_replay_captures
                    ),
                    "candidate_record_seed": worklist_item.candidate_record_seed,
                    "ranked_train_screen_survivor": deferred_train_survivor,
                    "train_screen_survivor_rank": worklist_item.deferred_train_rank,
                    "full_replay_selected_after_train_rank": bool(
                        worklist_item.deferred_full_replay_selected
                    ),
                    "train_screen_economic_rank": (
                        worklist_item.deferred_train_economic_rank
                    ),
                    "full_replay_selection_reason": (
                        worklist_item.deferred_full_replay_selection_reason
                    ),
                    "safe_exact_replay_candidate_cap": (
                        _SAFE_EXACT_REPLAY_CANDIDATE_CAP
                    ),
                    "safe_local_exact_replay_worker_cap": (
                        _SAFE_LOCAL_EXACT_REPLAY_WORKERS
                    ),
                    "cluster_fanout_allowed": False,
                    "promotion_writes_allowed": False,
                }
                if worklist_item.pruned_symbol is not None:
                    candidate_payload["pruned_symbol"] = worklist_item.pruned_symbol
                if worklist_item.repair_reason is not None:
                    if worklist_item.repair_reason.startswith("consistency_"):
                        candidate_payload["consistency_repair_reason"] = (
                            worklist_item.repair_reason
                        )
                    else:
                        candidate_payload["loss_repair_reason"] = (
                            worklist_item.repair_reason
                        )
                if worklist_item.parent_candidate_id is not None:
                    candidate_payload["parent_candidate_id"] = (
                        worklist_item.parent_candidate_id
                    )
                symbol_contributions = _symbol_contributions_from_replay_payload(
                    full_window_payload
                )
                if symbol_contributions:
                    candidate_payload["symbol_contributions"] = symbol_contributions
                normalization_regime = _selected_normalization_regime(
                    strategy_overrides=override_candidate,
                    template_allowed_normalizations=family_template.allowed_normalizations,
                )
                decomposition = build_replay_decomposition(
                    replay_payload=full_window_payload,
                    family_id=family_template.family_id,
                    normalization_regime=normalization_regime,
                )
                summary = summarize_replay_profitability(full_window_payload)
                total_filled_notional = sum(
                    _daily_filled_notional(full_window_payload).values(),
                    Decimal("0"),
                )
                positive_days = sum(
                    1 for value in summary.daily_net.values() if value > 0
                )
                negative_days = sum(
                    1 for value in summary.daily_net.values() if value < 0
                )
                fill_survival_sample_count = max(
                    _nonnegative_int_metric(
                        full_window_summary.get(
                            "delay_adjusted_depth_fill_survival_sample_count"
                        )
                    ),
                    _nonnegative_int_metric(
                        full_window_summary.get("fill_survival_sample_count")
                    ),
                    _nonnegative_int_metric(
                        full_window_summary.get("queue_position_survival_sample_count")
                    ),
                )
                fill_survival_rate = (
                    _optional_decimal(
                        full_window_summary.get(
                            "delay_adjusted_depth_fill_survival_rate"
                        )
                    )
                    or _optional_decimal(
                        full_window_summary.get("fill_survival_fill_rate")
                    )
                    or _optional_decimal(
                        full_window_summary.get("queue_position_survival_fill_rate")
                    )
                    or Decimal("0")
                )
                objective_scorecard = build_scorecard(
                    candidate_id=str(candidate_payload["candidate_id"]),
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
                    rolling_3d_lower_bound=_rolling_lower_bound(
                        summary.daily_net, window=3
                    ),
                    rolling_5d_lower_bound=_rolling_lower_bound(
                        summary.daily_net, window=5
                    ),
                    regime_slice_pass_rate=regime_slice_pass_rate(decomposition),
                    symbol_concentration_share=max_symbol_concentration_share(
                        decomposition
                    ),
                    entry_family_contribution_share=max_family_contribution_share(
                        decomposition
                    ),
                    max_gross_exposure_pct_equity=Decimal(
                        str(
                            full_window_summary.get(
                                "max_gross_exposure_pct_equity", "0"
                            )
                        )
                    ),
                    min_cash=Decimal(str(full_window_summary.get("min_cash", "0"))),
                    negative_cash_observation_count=int(
                        full_window_summary.get("negative_cash_observation_count") or 0
                    ),
                    fill_survival_sample_count=fill_survival_sample_count,
                    fill_survival_rate=fill_survival_rate,
                )
                hard_vetoes = list(
                    evaluate_vetoes(
                        objective_scorecard,
                        policy=objective_veto_policy,
                        is_fresh=(
                            dataset_snapshot_receipt.is_fresh
                            or bool(args.allow_stale_tape)
                        ),
                    )
                )
                hard_vetoes.extend(train_screen_failures)
                hard_vetoes.extend(full_replay_skip_reasons)
                if second_oos_summary is not None:
                    hard_vetoes.extend(
                        str(reason)
                        for reason in cast(
                            Sequence[Any], second_oos_summary.get("reasons") or ()
                        )
                    )
                if (
                    consistency_policy.min_daily_net_pnl > 0
                    and int(full_window_summary.get("daily_net_below_min_count") or 0)
                    > 0
                ):
                    hard_vetoes.append("daily_net_below_min")
                if (
                    consistency_policy.min_window_weekday_count > 0
                    and int(full_window_summary.get("trading_day_count") or 0)
                    < consistency_policy.min_window_weekday_count
                ):
                    hard_vetoes.append(
                        "window_weekday_count_below_min_observed_trading_days"
                    )
                if not bool(full_window_summary.get("conformal_tail_risk_passed")):
                    hard_vetoes.append("conformal_tail_risk_below_target")
                if not bool(
                    full_window_summary.get("breakeven_transaction_cost_buffer_passed")
                ):
                    hard_vetoes.append("breakeven_transaction_cost_buffer_below_target")
                if (
                    objective_scorecard.symbol_concentration_share
                    > consistency_policy.max_symbol_concentration_share
                ):
                    hard_vetoes.append("symbol_concentration_above_max")
                if (
                    objective_scorecard.entry_family_contribution_share
                    > consistency_policy.max_entry_family_contribution_share
                ):
                    hard_vetoes.append("entry_family_contribution_above_max")
                candidate_payload["decomposition"] = decomposition.to_payload()
                candidate_payload["normalization_regime"] = normalization_regime
                objective_scorecard_payload = objective_scorecard.to_payload()
                replay_tape_validation_status = str(
                    (replay_tape_validation or {}).get("status") or ""
                ).lower()
                tape_freshness_status = replay_tape_validation_status
                if replay_tape_validation_status in {"stale_override", "stale"}:
                    tape_freshness_status = "stale"
                elif replay_tape_validation_status == "valid":
                    tape_freshness_status = "fresh"
                objective_scorecard_payload.update(
                    {
                        "dataset_freshness_status": (
                            "fresh" if dataset_snapshot_receipt.is_fresh else "stale"
                        ),
                        "stale_override_used": bool(
                            dataset_snapshot_receipt.stale_override_used
                        ),
                        "replay_tape_validation_status": replay_tape_validation_status,
                        "tape_freshness_status": tape_freshness_status,
                        "market_impact_liquidity_evidence_present": bool(
                            full_window_summary.get(
                                "market_impact_liquidity_evidence_present"
                            )
                        ),
                        "market_impact_liquidity_day_count": int(
                            full_window_summary.get("market_impact_liquidity_day_count")
                            or 0
                        ),
                        "market_impact_liquidity_missing_day_count": int(
                            full_window_summary.get(
                                "market_impact_liquidity_missing_day_count"
                            )
                            or 0
                        ),
                        "market_impact_stress_passed": bool(
                            full_window_summary.get("market_impact_stress_passed")
                        ),
                        "market_impact_stress_model": str(
                            full_window_summary.get("market_impact_stress_model") or ""
                        ),
                        "market_impact_stress_cost_bps": str(
                            full_window_summary.get("market_impact_stress_cost_bps")
                            or "0"
                        ),
                        "market_impact_stress_net_pnl_per_day": str(
                            full_window_summary.get(
                                "market_impact_stress_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "market_impact_stress_components": dict(
                            cast(
                                Mapping[str, Any],
                                full_window_summary.get(
                                    "market_impact_stress_components"
                                )
                                or {},
                            )
                        ),
                        "nonlinear_market_impact_stress_passed": bool(
                            full_window_summary.get(
                                "nonlinear_market_impact_stress_passed"
                            )
                        ),
                        "nonlinear_market_impact_stress_model": str(
                            full_window_summary.get(
                                "nonlinear_market_impact_stress_model"
                            )
                            or ""
                        ),
                        "nonlinear_market_impact_stress_cost_bps": str(
                            full_window_summary.get(
                                "nonlinear_market_impact_stress_cost_bps"
                            )
                            or "0"
                        ),
                        "nonlinear_market_impact_stress_net_pnl_per_day": str(
                            full_window_summary.get(
                                "nonlinear_market_impact_stress_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "permanent_impact_decay_model": str(
                            full_window_summary.get("permanent_impact_decay_model")
                            or ""
                        ),
                        "delay_adjusted_depth_stress_passed": bool(
                            full_window_summary.get(
                                "delay_adjusted_depth_stress_passed"
                            )
                        ),
                        "delay_adjusted_depth_stress_model": str(
                            full_window_summary.get("delay_adjusted_depth_stress_model")
                            or ""
                        ),
                        "delay_adjusted_depth_stress_ms": str(
                            full_window_summary.get("delay_adjusted_depth_stress_ms")
                            or "0"
                        ),
                        "delay_adjusted_depth_latency_grid_ms": list(
                            cast(
                                Sequence[Any],
                                full_window_summary.get(
                                    "delay_adjusted_depth_latency_grid_ms"
                                )
                                or (),
                            )
                        ),
                        "delay_adjusted_depth_grid_max_stress_ms": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_grid_max_stress_ms"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_liquidity_evidence_present": bool(
                            full_window_summary.get(
                                "delay_adjusted_depth_liquidity_evidence_present"
                            )
                        ),
                        "delay_adjusted_depth_liquidity_missing_day_count": int(
                            full_window_summary.get(
                                "delay_adjusted_depth_liquidity_missing_day_count"
                            )
                            or 0
                        ),
                        "delay_adjusted_depth_fillable_notional_per_day": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_fillable_notional_per_day"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_worst_grid_fillable_notional_per_day": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_worst_active_day_fillable_notional": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_worst_active_day_fillable_notional"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_p10_active_day_fillable_notional": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_p10_active_day_fillable_notional"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_tail_coverage_passed": bool(
                            full_window_summary.get(
                                "delay_adjusted_depth_tail_coverage_passed"
                            )
                        ),
                        "delay_adjusted_depth_fillable_ratio": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_fillable_ratio"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_survival_adjusted_fillable_ratio": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_survival_adjusted_fillable_ratio"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_unfillable_notional_per_day": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_unfillable_notional_per_day"
                            )
                            or "0"
                        ),
                        "delay_adjusted_depth_fill_survival_evidence_present": bool(
                            full_window_summary.get(
                                "delay_adjusted_depth_fill_survival_evidence_present"
                            )
                        ),
                        "delay_adjusted_depth_fill_survival_sample_count": int(
                            full_window_summary.get(
                                "delay_adjusted_depth_fill_survival_sample_count"
                            )
                            or 0
                        ),
                        "delay_adjusted_depth_fill_survival_rate": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_fill_survival_rate"
                            )
                            or ""
                        ),
                        "delay_adjusted_depth_queue_ratio_p95": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_queue_ratio_p95"
                            )
                            or ""
                        ),
                        "queue_position_survival_fill_curve_evidence_present": bool(
                            full_window_summary.get(
                                "queue_position_survival_fill_curve_evidence_present"
                            )
                        ),
                        "queue_position_survival_sample_count": int(
                            full_window_summary.get(
                                "queue_position_survival_sample_count"
                            )
                            or 0
                        ),
                        "queue_position_survival_fill_rate": str(
                            full_window_summary.get("queue_position_survival_fill_rate")
                            or ""
                        ),
                        "queue_position_survival_queue_ratio_p95": str(
                            full_window_summary.get(
                                "queue_position_survival_queue_ratio_p95"
                            )
                            or ""
                        ),
                        "queue_position_survival_queue_ahead_depletion_evidence_present": bool(
                            full_window_summary.get(
                                "queue_position_survival_queue_ahead_depletion_evidence_present"
                            )
                        ),
                        "queue_position_survival_queue_ahead_depletion_sample_count": int(
                            full_window_summary.get(
                                "queue_position_survival_queue_ahead_depletion_sample_count"
                            )
                            or 0
                        ),
                        "queue_position_survival_adjusted_fillable_ratio": str(
                            full_window_summary.get(
                                "queue_position_survival_adjusted_fillable_ratio"
                            )
                            or "0"
                        ),
                        "queue_position_survival_nonfill_opportunity_cost_per_day": str(
                            full_window_summary.get(
                                "queue_position_survival_nonfill_opportunity_cost_per_day"
                            )
                            or "0"
                        ),
                        "queue_position_survival_nonfill_opportunity_cost_bps": str(
                            full_window_summary.get(
                                "queue_position_survival_nonfill_opportunity_cost_bps"
                            )
                            or "0"
                        ),
                        "queue_position_survival_stress_net_pnl_per_day": str(
                            full_window_summary.get(
                                "queue_position_survival_stress_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": str(
                            full_window_summary.get(
                                "post_cost_net_pnl_after_queue_position_survival_fill_stress"
                            )
                            or full_window_summary.get(
                                "queue_position_survival_stress_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "queue_position_survival_source_marker": str(
                            full_window_summary.get(
                                "queue_position_survival_source_marker"
                            )
                            or ""
                        ),
                        "delay_adjusted_depth_stress_net_pnl_per_day": str(
                            full_window_summary.get(
                                "delay_adjusted_depth_stress_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "implementation_uncertainty_required": bool(
                            full_window_summary.get(
                                "implementation_uncertainty_required"
                            )
                        ),
                        "implementation_uncertainty_model": str(
                            full_window_summary.get("implementation_uncertainty_model")
                            or ""
                        ),
                        "implementation_uncertainty_model_count": int(
                            full_window_summary.get(
                                "implementation_uncertainty_model_count"
                            )
                            or 0
                        ),
                        "implementation_uncertainty_stability_passed": bool(
                            full_window_summary.get(
                                "implementation_uncertainty_stability_passed"
                            )
                        ),
                        "implementation_uncertainty_lower_net_pnl_per_day": str(
                            full_window_summary.get(
                                "implementation_uncertainty_lower_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "implementation_uncertainty_upper_net_pnl_per_day": str(
                            full_window_summary.get(
                                "implementation_uncertainty_upper_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "implementation_uncertainty_interval_width_per_day": str(
                            full_window_summary.get(
                                "implementation_uncertainty_interval_width_per_day"
                            )
                            or "0"
                        ),
                        "implementation_uncertainty_target_net_pnl_per_day": str(
                            full_window_summary.get(
                                "implementation_uncertainty_target_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "implementation_uncertainty_scenarios": dict(
                            cast(
                                Mapping[str, Any],
                                full_window_summary.get(
                                    "implementation_uncertainty_scenarios"
                                )
                                or {},
                            )
                        ),
                        "implementation_uncertainty_source_markers": list(
                            cast(
                                Sequence[Any],
                                full_window_summary.get(
                                    "implementation_uncertainty_source_markers"
                                )
                                or (),
                            )
                        ),
                        "conformal_tail_risk_required": bool(
                            full_window_summary.get("conformal_tail_risk_required")
                        ),
                        "conformal_tail_risk_model": str(
                            full_window_summary.get("conformal_tail_risk_model") or ""
                        ),
                        "conformal_tail_risk_alpha": str(
                            full_window_summary.get("conformal_tail_risk_alpha") or "0"
                        ),
                        "conformal_tail_risk_sample_count": int(
                            full_window_summary.get("conformal_tail_risk_sample_count")
                            or 0
                        ),
                        "conformal_tail_risk_buffer_per_day": str(
                            full_window_summary.get(
                                "conformal_tail_risk_buffer_per_day"
                            )
                            or "0"
                        ),
                        "conformal_tail_risk_adjusted_net_pnl_per_day": str(
                            full_window_summary.get(
                                "conformal_tail_risk_adjusted_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "conformal_tail_risk_target_net_pnl_per_day": str(
                            full_window_summary.get(
                                "conformal_tail_risk_target_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "conformal_tail_risk_passed": bool(
                            full_window_summary.get("conformal_tail_risk_passed")
                        ),
                        "conformal_tail_risk_source_markers": list(
                            cast(
                                Sequence[Any],
                                full_window_summary.get(
                                    "conformal_tail_risk_source_markers"
                                )
                                or (),
                            )
                        ),
                        "required_breakeven_transaction_cost_buffer": bool(
                            full_window_summary.get(
                                "required_breakeven_transaction_cost_buffer"
                            )
                        ),
                        "required_seed_model_family_robustness": bool(
                            full_window_summary.get(
                                "required_seed_model_family_robustness"
                            )
                        ),
                        "breakeven_transaction_cost_buffer_passed": bool(
                            full_window_summary.get(
                                "breakeven_transaction_cost_buffer_passed"
                            )
                        ),
                        "breakeven_transaction_cost_buffer_bps": str(
                            full_window_summary.get(
                                "breakeven_transaction_cost_buffer_bps"
                            )
                            or "0"
                        ),
                        "transaction_cost_buffer_bps": str(
                            full_window_summary.get("transaction_cost_buffer_bps")
                            or "0"
                        ),
                        "transaction_cost_buffer_cost_per_day": str(
                            full_window_summary.get(
                                "transaction_cost_buffer_cost_per_day"
                            )
                            or "0"
                        ),
                        "post_cost_net_pnl_after_breakeven_transaction_cost_buffer": str(
                            full_window_summary.get(
                                "post_cost_net_pnl_after_breakeven_transaction_cost_buffer"
                            )
                            or "0"
                        ),
                        "breakeven_transaction_cost_buffer_target_net_pnl_per_day": str(
                            full_window_summary.get(
                                "breakeven_transaction_cost_buffer_target_net_pnl_per_day"
                            )
                            or "0"
                        ),
                        "breakeven_transaction_cost_buffer_source_markers": list(
                            cast(
                                Sequence[Any],
                                full_window_summary.get(
                                    "breakeven_transaction_cost_buffer_source_markers"
                                )
                                or (),
                            )
                        ),
                        "seed_model_family_robustness_status": str(
                            full_window_summary.get(
                                "seed_model_family_robustness_status"
                            )
                            or ""
                        ),
                        "seed_robustness_passed": bool(
                            full_window_summary.get("seed_robustness_passed")
                        ),
                        "seed_robustness_sample_count": int(
                            full_window_summary.get("seed_robustness_sample_count") or 0
                        ),
                        "model_family_robustness_passed": bool(
                            full_window_summary.get("model_family_robustness_passed")
                        ),
                        "model_family_robustness_family_count": int(
                            full_window_summary.get(
                                "model_family_robustness_family_count"
                            )
                            or 0
                        ),
                        "seed_model_family_robustness_source_markers": list(
                            cast(
                                Sequence[Any],
                                full_window_summary.get(
                                    "seed_model_family_robustness_source_markers"
                                )
                                or (),
                            )
                        ),
                        "replay_lineage": replay_lineage,
                        "replay_window_coverage": _replay_window_coverage_payload(
                            replay_lineage
                        ),
                        **_order_type_execution_metrics(full_window_summary),
                        **_order_lifecycle_metrics(full_window_payload),
                    }
                )
                objective_scorecard_payload.update(order_type_ablation_update)
                objective_scorecard_payload.update(exact_replay_ledger_update)
                if second_oos_summary is not None:
                    holdout_oos_passed = _holdout_oos_passed(
                        holdout_payload=holdout_payload,
                        policy=holdout_policy,
                    )
                    second_oos_passed = bool(second_oos_summary.get("passed"))
                    oos_pass_count = int(holdout_oos_passed) + int(second_oos_passed)
                    objective_scorecard_payload.update(
                        {
                            "double_oos_passed": oos_pass_count == 2,
                            "double_oos_independent_window_count": 2,
                            "double_oos_pass_rate": str(
                                Decimal(oos_pass_count) / Decimal("2")
                            ),
                            "double_oos_net_pnl_per_day": str(
                                second_oos_summary.get("net_per_day", "0")
                            ),
                            "holdout_oos_passed": holdout_oos_passed,
                            "second_oos_net_pnl_per_day": str(
                                second_oos_summary.get("net_per_day", "0")
                            ),
                            "second_oos_decision_count": int(
                                second_oos_summary.get("decision_count") or 0
                            ),
                            "second_oos_filled_count": int(
                                second_oos_summary.get("filled_count") or 0
                            ),
                            "second_oos_reasons": list(
                                cast(
                                    Sequence[Any],
                                    second_oos_summary.get("reasons") or (),
                                )
                            ),
                        }
                    )
                candidate_payload["objective_scorecard"] = objective_scorecard_payload
                candidate_payload["hard_vetoes"] = sorted(dict.fromkeys(hard_vetoes))
                if collect_train_gate_diagnostics:
                    candidate_payload["train_gate_diagnostics"] = (
                        _train_gate_diagnostics_from_replay_payload(train_payload)
                    )
                    if not holdout_replay_skipped:
                        candidate_payload["holdout_gate_diagnostics"] = (
                            _train_gate_diagnostics_from_replay_payload(holdout_payload)
                        )
                    if second_oos_payload is not None:
                        candidate_payload["second_oos_gate_diagnostics"] = (
                            _train_gate_diagnostics_from_replay_payload(
                                second_oos_payload
                            )
                        )
                    if not full_window_replay_skipped:
                        candidate_payload["full_window_gate_diagnostics"] = (
                            _train_gate_diagnostics_from_replay_payload(
                                full_window_payload
                            )
                        )
                if cached_rows is not None:
                    candidate_payload["prefetched_row_count"] = len(cached_rows)
                    candidate_payload["prefetched_symbols"] = list(prefetch_symbols)
                scored.append(candidate_payload)
                if worklist_item.symbol_prune_iteration < max(
                    0, int(args.symbol_prune_iterations)
                ):
                    for (
                        removed_symbol,
                        next_override,
                    ) in _generate_symbol_prune_children(
                        cli_symbols=symbols,
                        strategy_overrides=override_candidate,
                        configmap_payload=base_configmap,
                        strategy_name=strategy_name,
                        symbol_contributions=symbol_contributions,
                        branch_count=max(1, int(args.symbol_prune_candidates)),
                        min_universe_size=max(
                            1, int(args.symbol_prune_min_universe_size)
                        ),
                    ):
                        worklist.append(
                            _WorklistItem(
                                params_candidate=dict(params_candidate),
                                strategy_overrides=next_override,
                                symbol_prune_iteration=worklist_item.symbol_prune_iteration
                                + 1,
                                loss_repair_iteration=worklist_item.loss_repair_iteration,
                                consistency_repair_iteration=worklist_item.consistency_repair_iteration,
                                pruned_symbol=removed_symbol,
                                parent_candidate_id=str(
                                    candidate_payload["candidate_id"]
                                ),
                            )
                        )
                if worklist_item.loss_repair_iteration < max(
                    0, int(getattr(args, "loss_repair_iterations", 0))
                ):
                    for (
                        repair_reason,
                        next_params,
                        next_override,
                    ) in _generate_loss_repair_children(
                        params_candidate=params_candidate,
                        strategy_overrides=override_candidate,
                        candidate_configmap=candidate_configmap,
                        strategy_name=strategy_name,
                        hard_vetoes=hard_vetoes,
                        full_window_summary=full_window_summary,
                        branch_count=max(
                            1, int(getattr(args, "loss_repair_candidates", 1))
                        ),
                        policy_required_max_gross_exposure_pct_equity=(
                            objective_veto_policy.required_max_gross_exposure_pct_equity
                        ),
                        policy_required_min_cash=objective_veto_policy.required_min_cash,
                    ):
                        worklist.append(
                            _WorklistItem(
                                params_candidate=next_params,
                                strategy_overrides=next_override,
                                symbol_prune_iteration=worklist_item.symbol_prune_iteration,
                                loss_repair_iteration=worklist_item.loss_repair_iteration
                                + 1,
                                consistency_repair_iteration=worklist_item.consistency_repair_iteration,
                                repair_reason=repair_reason,
                                parent_candidate_id=str(
                                    candidate_payload["candidate_id"]
                                ),
                            )
                        )
                if worklist_item.consistency_repair_iteration < max(
                    0, int(getattr(args, "consistency_repair_iterations", 0))
                ):
                    for (
                        consistency_reason,
                        next_params,
                        next_override,
                    ) in _generate_consistency_repair_children(
                        params_candidate=params_candidate,
                        strategy_overrides=override_candidate,
                        candidate_configmap=candidate_configmap,
                        strategy_name=strategy_name,
                        hard_vetoes=hard_vetoes,
                        full_window_summary=full_window_summary,
                        branch_count=max(
                            1, int(getattr(args, "consistency_repair_candidates", 1))
                        ),
                    ):
                        worklist.append(
                            _WorklistItem(
                                params_candidate=next_params,
                                strategy_overrides=next_override,
                                symbol_prune_iteration=worklist_item.symbol_prune_iteration,
                                loss_repair_iteration=worklist_item.loss_repair_iteration,
                                consistency_repair_iteration=worklist_item.consistency_repair_iteration
                                + 1,
                                repair_reason=consistency_reason,
                                parent_candidate_id=str(
                                    candidate_payload["candidate_id"]
                                ),
                            )
                        )
                if args.json_output is not None:
                    partial_payload = _build_frontier_payload(
                        scored=scored,
                        family=family,
                        strategy_name=strategy_name,
                        family_template=family_template,
                        dataset_snapshot_receipt=dataset_snapshot_receipt,
                        window=window,
                        full_window_start=full_window_start,
                        full_window_end=full_window_end,
                        holdout_policy=holdout_policy,
                        consistency_policy=consistency_policy,
                        objective_veto_policy=objective_veto_policy,
                        top_n=max(1, int(args.top_n)),
                        status="running",
                        pending_candidates=len(worklist)
                        + (0 if initial_candidates_exhausted else 1),
                        replay_tape_validation=replay_tape_validation,
                        staged_search=_staged_search_budget_payload(
                            args=args,
                            candidate_budget=candidate_budget,
                            train_screen_candidates_started=train_screen_candidates_started,
                            full_replay_candidates_started=full_replay_candidates_started,
                            train_screen_only_candidates=train_screen_only_candidates,
                            full_replay_budget_discarded_candidates=full_replay_budget_discarded_candidates,
                            proof_only_full_window_replay_captures=proof_only_full_window_replay_captures,
                        ),
                    )
                    _write_json_output(args.json_output, partial_payload)

    payload = _build_frontier_payload(
        scored=scored,
        family=family,
        strategy_name=strategy_name,
        family_template=family_template,
        dataset_snapshot_receipt=dataset_snapshot_receipt,
        window=window,
        full_window_start=full_window_start,
        full_window_end=full_window_end,
        holdout_policy=holdout_policy,
        consistency_policy=consistency_policy,
        objective_veto_policy=objective_veto_policy,
        top_n=max(1, int(args.top_n)),
        status="candidate_budget_exhausted"
        if budget_exhausted
        and (
            worklist
            or not initial_candidates_exhausted
            or full_replay_budget_discarded_candidates > 0
        )
        else "completed",
        pending_candidates=len(worklist) + (0 if initial_candidates_exhausted else 1),
        replay_tape_validation=replay_tape_validation,
        staged_search=_staged_search_budget_payload(
            args=args,
            candidate_budget=candidate_budget,
            train_screen_candidates_started=train_screen_candidates_started,
            full_replay_candidates_started=full_replay_candidates_started,
            train_screen_only_candidates=train_screen_only_candidates,
            full_replay_budget_discarded_candidates=full_replay_budget_discarded_candidates,
            proof_only_full_window_replay_captures=proof_only_full_window_replay_captures,
        ),
    )
    if args.json_output is not None:
        _write_json_output(args.json_output, payload)
    return payload


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
