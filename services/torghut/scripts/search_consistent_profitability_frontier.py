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


@dataclass(frozen=True)
class _WorklistItem:
    params_candidate: dict[str, Any]
    strategy_overrides: dict[str, Any]
    candidate_record_seed: bool = False
    symbol_prune_iteration: int = 0
    loss_repair_iteration: int = 0
    consistency_repair_iteration: int = 0
    pruned_symbol: str | None = None
    repair_reason: str | None = None
    parent_candidate_id: str | None = None
    deferred_candidate_index: int | None = None
    deferred_candidate_key: str | None = None
    deferred_train_payload: Mapping[str, Any] | None = None
    deferred_full_replay_selected: bool = False
    deferred_train_rank: int | None = None
    deferred_train_economic_rank: int | None = None
    deferred_full_replay_selection_reason: str | None = None

    @property
    def search_iteration(self) -> int:
        return (
            self.symbol_prune_iteration
            + self.loss_repair_iteration
            + self.consistency_repair_iteration
        )


@dataclass(frozen=True)
class FrontierReplayWindows:
    train_days: tuple[date, ...]
    holdout_days: tuple[date, ...]
    second_oos_days: tuple[date, ...] = ()

    @property
    def train_start(self) -> date:
        return self.train_days[0]

    @property
    def train_end(self) -> date:
        return self.train_days[-1]

    @property
    def holdout_start(self) -> date:
        return self.holdout_days[0]

    @property
    def holdout_end(self) -> date:
        return self.holdout_days[-1]

    @property
    def second_oos_start(self) -> date | None:
        return self.second_oos_days[0] if self.second_oos_days else None

    @property
    def second_oos_end(self) -> date | None:
        return self.second_oos_days[-1] if self.second_oos_days else None

    @property
    def expected_days(self) -> tuple[date, ...]:
        return self.train_days + self.holdout_days + self.second_oos_days


def _optional_int(value: Any, *, default: int) -> int:
    if value is None:
        return default
    return int(value)


def _order_type_ablation_policy(
    sweep_config: Mapping[str, Any],
) -> OrderTypeAblationPolicy:
    raw_value = sweep_config.get("order_type_ablation")
    if raw_value is None:
        return OrderTypeAblationPolicy(
            enabled=False,
            max_candidates=0,
            min_sample_count=60,
            max_opportunity_cost_bps=Decimal("8"),
        )
    if not isinstance(raw_value, Mapping):
        raise ValueError("sweep_config_order_type_ablation_not_mapping")
    value = cast(Mapping[str, Any], raw_value)
    return OrderTypeAblationPolicy(
        enabled=bool(value.get("enabled", False)),
        max_candidates=max(0, int(value.get("max_candidates", 1) or 0)),
        min_sample_count=max(0, int(value.get("min_sample_count", 60) or 0)),
        max_opportunity_cost_bps=Decimal(
            str(value.get("max_opportunity_cost_bps", "8"))
        ),
    )


def _safe_exact_replay_candidate_budget(raw_value: Any) -> int:
    try:
        requested = int(raw_value)
    except (TypeError, ValueError):
        requested = _SAFE_EXACT_REPLAY_CANDIDATE_CAP
    if requested <= 0:
        return _SAFE_EXACT_REPLAY_CANDIDATE_CAP
    return min(requested, _SAFE_EXACT_REPLAY_CANDIDATE_CAP)


def _staged_search_budget_payload(
    *,
    args: argparse.Namespace,
    candidate_budget: int,
    train_screen_candidates_started: int = 0,
    full_replay_candidates_started: int = 0,
    train_screen_only_candidates: int = 0,
    full_replay_budget_discarded_candidates: int = 0,
    proof_only_full_window_replay_captures: int = 0,
) -> dict[str, Any]:
    train_screening_enabled = bool(getattr(args, "train_screening", True))
    train_screen_multiplier = max(
        1,
        int(
            getattr(
                args,
                "staged_train_screen_multiplier",
                _DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER,
            )
            or 1
        ),
    )
    full_replay_budget = max(0, int(candidate_budget))
    exploitation_slots = min(
        _SAFE_EXACT_REPLAY_EXPLOITATION_SLOTS,
        full_replay_budget,
    )
    exploration_slots = min(
        _SAFE_EXACT_REPLAY_EXPLORATION_SLOTS,
        max(0, full_replay_budget - exploitation_slots),
    )
    train_screen_budget = (
        full_replay_budget * train_screen_multiplier
        if train_screening_enabled and full_replay_budget > 0
        else full_replay_budget
    )
    return {
        "schema_version": "torghut.frontier-staged-search-budget.v1",
        "enabled": bool(
            train_screening_enabled
            and train_screen_multiplier > 1
            and full_replay_budget > 0
        ),
        "train_screening_enabled": train_screening_enabled,
        "train_screen_multiplier": train_screen_multiplier,
        "train_screen_candidate_budget": train_screen_budget,
        "full_replay_candidate_budget": full_replay_budget,
        "safe_exact_replay_candidate_cap": _SAFE_EXACT_REPLAY_CANDIDATE_CAP,
        "safe_local_exact_replay_worker_cap": _SAFE_LOCAL_EXACT_REPLAY_WORKERS,
        "cluster_fanout_allowed": False,
        "promotion_writes_allowed": False,
        "selection_policy": {
            "schema_version": "torghut.frontier-exact-replay-shortlist-policy.v1",
            "mode": "bounded_preview_to_exact_replay",
            "candidate_cap": full_replay_budget,
            "exploitation_slots": exploitation_slots,
            "exploration_slots": exploration_slots,
            "ranking_basis": (
                "top four economic train-screen survivors by post-cost consistency "
                "score first, then up to two deterministic exploration picks with "
                "distinct parameter/symbol/regime keys when available"
            ),
        },
        "train_screen_candidates_started": max(0, int(train_screen_candidates_started)),
        "full_replay_candidates_started": max(0, int(full_replay_candidates_started)),
        "train_screen_only_candidates": max(0, int(train_screen_only_candidates)),
        "full_replay_budget_discarded_candidates": max(
            0, int(full_replay_budget_discarded_candidates)
        ),
        "positive_rejected_full_window_ledger_capture_budget": max(
            0,
            int(getattr(args, "capture_positive_rejected_full_window_ledgers", 0) or 0),
        ),
        "proof_only_full_window_replay_captures": max(
            0, int(proof_only_full_window_replay_captures)
        ),
    }


def _frontier_error_payload(exc: Exception) -> dict[str, Any]:
    message = str(exc)
    payload: dict[str, Any] = {
        "schema_version": "torghut.consistent-profitability-frontier-error.v1",
        "status": "error",
        "error_type": type(exc).__name__,
        "error": message,
    }
    if message.startswith("clickhouse_endpoint_"):
        payload["remediation"] = [
            "Run the frontier harness from an in-cluster pod.",
            "Set TA_CLICKHOUSE_URL or CLICKHOUSE_HTTP_URL to a reachable ClickHouse HTTP endpoint.",
            "Pass --clickhouse-http-url for a local port-forward or HTTP endpoint.",
            "Pass --replay-tape-path with a manifest-verified replay tape when ClickHouse is intentionally offline.",
        ]
    return payload


def _clickhouse_host_requires_dns_preflight(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return host.endswith(".svc") or host.endswith(".svc.cluster.local")


def _clickhouse_endpoint_preflight_failure(args: argparse.Namespace) -> str:
    if getattr(args, "replay_tape_path", None) is not None:
        return ""
    url = str(getattr(args, "clickhouse_http_url", "") or "").strip()
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if not host:
        return (
            "clickhouse_endpoint_invalid_url:"
            f"url={url or '<empty>'}; set TA_CLICKHOUSE_URL, CLICKHOUSE_HTTP_URL, "
            "or pass --clickhouse-http-url to a reachable ClickHouse HTTP endpoint"
        )
    if not _clickhouse_host_requires_dns_preflight(url):
        return ""
    port = parsed.port or (443 if parsed.scheme == "https" else 8123)
    try:
        socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        return (
            "clickhouse_endpoint_unreachable:"
            f"host={host};port={port};error={exc}; "
            "the default Kubernetes service DNS is only reachable in-cluster. "
            "Run from a cluster pod, set TA_CLICKHOUSE_URL or CLICKHOUSE_HTTP_URL, "
            "or pass --clickhouse-http-url to a local port-forward/HTTP endpoint."
        )
    return ""


def _stable_payload_hash(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _replay_lineage_window_payload(
    *,
    window_id: str,
    replay_payload: Mapping[str, Any] | None,
    start_date: date | None,
    end_date: date | None,
    skipped: bool,
) -> dict[str, Any]:
    if replay_payload is None:
        return {
            "window_id": window_id,
            "start_date": start_date.isoformat() if start_date is not None else "",
            "end_date": end_date.isoformat() if end_date is not None else "",
            "skipped": True,
            "trading_day_count": 0,
            "decision_count": 0,
            "filled_count": 0,
            "payload_sha256": "",
            "daily_net_sha256": "",
            "daily_filled_notional_sha256": "",
            "daily_liquidity_notional_sha256": "",
        }
    summary = summarize_replay_profitability(replay_payload)
    daily_net = {day: str(value) for day, value in summary.daily_net.items()}
    daily_filled_notional = {
        day: str(value) for day, value in _daily_filled_notional(replay_payload).items()
    }
    daily_liquidity_notional = {
        day: str(value)
        for day, value in _daily_liquidity_notional(replay_payload).items()
    }
    return {
        "window_id": window_id,
        "start_date": start_date.isoformat() if start_date is not None else "",
        "end_date": end_date.isoformat() if end_date is not None else "",
        "skipped": skipped,
        "trading_day_count": summary.trading_day_count,
        "decision_count": summary.decision_count,
        "filled_count": summary.filled_count,
        "payload_sha256": _stable_payload_hash(replay_payload) if not skipped else "",
        "daily_net_sha256": _stable_payload_hash(daily_net) if not skipped else "",
        "daily_filled_notional_sha256": _stable_payload_hash(daily_filled_notional)
        if not skipped
        else "",
        "daily_liquidity_notional_sha256": _stable_payload_hash(
            daily_liquidity_notional
        )
        if not skipped
        else "",
    }


def _candidate_replay_lineage_payload(
    *,
    candidate_configmap_path: Path,
    candidate_search_key: str,
    dataset_snapshot_id: str,
    train_payload: Mapping[str, Any],
    holdout_payload: Mapping[str, Any],
    full_window_payload: Mapping[str, Any],
    second_oos_payload: Mapping[str, Any] | None,
    window: FrontierReplayWindows,
    full_window_start: date,
    full_window_end: date,
    holdout_replay_skipped: bool,
    full_window_replay_skipped: bool,
) -> dict[str, Any]:
    windows = {
        "train": _replay_lineage_window_payload(
            window_id="train",
            replay_payload=train_payload,
            start_date=window.train_start,
            end_date=window.train_end,
            skipped=False,
        ),
        "holdout": _replay_lineage_window_payload(
            window_id="holdout",
            replay_payload=holdout_payload,
            start_date=window.holdout_start,
            end_date=window.holdout_end,
            skipped=holdout_replay_skipped,
        ),
        "full_window": _replay_lineage_window_payload(
            window_id="full_window",
            replay_payload=full_window_payload,
            start_date=full_window_start,
            end_date=full_window_end,
            skipped=full_window_replay_skipped,
        ),
    }
    if window.second_oos_days:
        windows[_SECOND_OOS_WINDOW_ID] = _replay_lineage_window_payload(
            window_id=_SECOND_OOS_WINDOW_ID,
            replay_payload=second_oos_payload,
            start_date=window.second_oos_start,
            end_date=window.second_oos_end,
            skipped=second_oos_payload is None
            or bool(
                isinstance(second_oos_payload, Mapping)
                and second_oos_payload.get("skipped")
            ),
        )
    expected_windows = list(windows)
    missing_windows = [
        name
        for name, payload in windows.items()
        if bool(payload.get("skipped"))
        or int(payload.get("trading_day_count") or 0) <= 0
    ]
    configmap_bytes = candidate_configmap_path.read_bytes()
    lineage_payload: dict[str, Any] = {
        "schema_version": "torghut.frontier-replay-lineage.v1",
        "candidate_configmap_ref": str(candidate_configmap_path),
        "candidate_configmap_sha256": hashlib.sha256(configmap_bytes).hexdigest(),
        "candidate_search_key": candidate_search_key,
        "dataset_snapshot_id": dataset_snapshot_id,
        "expected_windows": expected_windows,
        "present_windows": [
            name for name in expected_windows if name not in set(missing_windows)
        ],
        "missing_windows": missing_windows,
        "windows": windows,
    }
    lineage_payload["lineage_hash"] = _stable_payload_hash(lineage_payload)
    return lineage_payload


def _replay_window_coverage_payload(
    replay_lineage: Mapping[str, Any],
) -> dict[str, Any]:
    windows = replay_lineage.get("windows")
    window_count = len(windows) if isinstance(windows, Mapping) else 0
    return {
        "schema_version": "torghut.replay-window-coverage.v1",
        "lineage_hash": str(replay_lineage.get("lineage_hash") or ""),
        "expected_windows": list(
            cast(Sequence[Any], replay_lineage.get("expected_windows") or ())
        ),
        "present_windows": list(
            cast(Sequence[Any], replay_lineage.get("present_windows") or ())
        ),
        "missing_windows": list(
            cast(Sequence[Any], replay_lineage.get("missing_windows") or ())
        ),
        "window_count": window_count,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Search replay configs using holdout profitability plus full-window consistency.",
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=replay_mod.default_strategy_configmap_path(),
    )
    parser.add_argument(
        "--sweep-config",
        type=Path,
        default=Path("config/trading/profitability-frontier-consistent-tsmom.yaml"),
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default=os.environ.get(
            "TA_CLICKHOUSE_URL",
            "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        ),
    )
    parser.add_argument(
        "--clickhouse-username",
        default=os.environ.get(
            "TA_CLICKHOUSE_USERNAME",
            os.environ.get("CLICKHOUSE_USERNAME", "torghut"),
        ),
    )
    parser.add_argument(
        "--clickhouse-password",
        default=os.environ.get(
            "TA_CLICKHOUSE_PASSWORD",
            os.environ.get("CLICKHOUSE_PASSWORD", ""),
        ),
    )
    parser.add_argument(
        "--clickhouse-password-env",
        default="",
        help="Environment variable that contains the ClickHouse password; ignored when --clickhouse-password is set.",
    )
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default="")
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument(
        "--second-oos-days",
        type=int,
        default=0,
        help=(
            "Optional independent forward OOS replay days after holdout. "
            "When set, candidates must pass this separate window before they can be ranked as clean."
        ),
    )
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument(
        "--expected-last-trading-day",
        default="",
        help="Optional ISO date freshness witness. If omitted, recent sweeps expect the latest completed trading day.",
    )
    parser.add_argument(
        "--allow-stale-tape",
        action="store_true",
        help="Persist and continue even when the latest expected trading day is missing from PT1S tape.",
    )
    parser.add_argument(
        "--family-template-dir",
        type=Path,
        default=family_template_dir(),
    )
    parser.add_argument(
        "--prefetch-full-window-rows",
        action="store_true",
        help="Fetch full-window replay rows once and reuse them for every candidate replay.",
    )
    parser.add_argument(
        "--replay-tape-path",
        type=Path,
        help=(
            "Optional manifest-verified replay tape to reuse for exact scheduler-v3 replays. "
            "This replaces ClickHouse reads only; it does not make preview evidence promotable."
        ),
    )
    parser.add_argument(
        "--replay-tape-manifest",
        type=Path,
        help="Optional replay tape manifest path. Defaults to <replay-tape-path>.manifest.json.",
    )
    parser.add_argument("--top-n", type=int, default=10)
    parser.add_argument(
        "--max-candidates-to-evaluate",
        type=int,
        default=_SAFE_EXACT_REPLAY_CANDIDATE_CAP,
        help=(
            "Safe exact full-window replay candidate cap. Values <= 0 or above "
            f"{_SAFE_EXACT_REPLAY_CANDIDATE_CAP} resolve to the bounded default/cap; "
            "fast train preview may evaluate more candidates before this top shortlist."
        ),
    )
    parser.add_argument(
        "--staged-train-screen-multiplier",
        type=int,
        default=_DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER,
        help=(
            "When train screening is enabled, allow this multiple of the expensive "
            "full-replay budget to be evaluated through the cheap train screen."
        ),
    )
    parser.add_argument(
        "--candidate-record",
        type=Path,
        action="append",
        default=[],
        help=(
            "Optional checked-in candidate record JSON to seed before the sweep grid. "
            "This replays known candidate params exactly before exploring variants."
        ),
    )
    parser.add_argument(
        "--capture-rejected-seed-full-window-ledger",
        action="store_true",
        help=(
            "For checked-in candidate-record seeds rejected by the train screen, "
            "still run a full-window exact replay ledger capture as proof-only evidence. "
            "The candidate remains train-screen rejected and non-promotable."
        ),
    )
    parser.add_argument(
        "--capture-positive-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=0,
        help=(
            "Capture up to N proof-only full-window exact replay ledgers for "
            "positive train-screen rejects or candidates that pass the train "
            "screen after the full-replay budget is exhausted. Candidates remain "
            "blocked by their train/budget vetoes and non-promotable."
        ),
    )
    parser.add_argument(
        "--capture-top-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=argparse.SUPPRESS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--json-output", type=Path)
    parser.add_argument(
        "--symbol-prune-iterations",
        type=int,
        default=0,
        help="Greedily generate child candidates by removing downside-contributing symbols from replay attribution.",
    )
    parser.add_argument(
        "--symbol-prune-candidates",
        type=int,
        default=1,
        help="How many worst-contributing symbols to branch on per pruning step.",
    )
    parser.add_argument(
        "--symbol-prune-min-universe-size",
        type=int,
        default=2,
        help="Do not prune below this many symbols in the candidate universe.",
    )
    parser.add_argument(
        "--loss-repair-iterations",
        type=int,
        default=0,
        help=(
            "Generate bounded child candidates that tighten loss controls and exposure "
            "after drawdown or worst-day-loss vetoes."
        ),
    )
    parser.add_argument(
        "--loss-repair-candidates",
        type=int,
        default=1,
        help="How many loss/drawdown repair children to branch on per failed candidate.",
    )
    parser.add_argument(
        "--consistency-repair-iterations",
        type=int,
        default=0,
        help=(
            "Generate bounded child candidates that increase activity or breadth "
            "after positive capital-safe candidates fail consistency gates."
        ),
    )
    parser.add_argument(
        "--consistency-repair-candidates",
        type=int,
        default=2,
        help="How many consistency repair children to branch on per positive near-miss.",
    )
    parser.add_argument(
        "--train-screening",
        dest="train_screening",
        action="store_true",
        help="Skip holdout/full-window replay for candidates that fail the cheap train screen.",
    )
    parser.add_argument(
        "--no-train-screening",
        dest="train_screening",
        action="store_false",
        help="Disable cheap train-screen early rejection and always run all replay windows.",
    )
    parser.set_defaults(train_screening=True)
    parser.add_argument(
        "--min-train-screen-net-per-day",
        default="0",
        help="Minimum train net PnL/day required before holdout/full-window replay.",
    )
    parser.add_argument(
        "--min-train-screen-active-ratio",
        default="0.50",
        help="Minimum active train-day ratio required before holdout/full-window replay.",
    )
    parser.add_argument(
        "--max-train-screen-worst-day-loss",
        default="",
        help="Optional max train worst-day loss before holdout/full-window replay. Defaults to the consistency max worst-day loss.",
    )
    parser.add_argument(
        "--collect-train-gate-diagnostics",
        action="store_true",
        help="Capture aggregate train-window gate failure diagnostics in frontier candidates.",
    )
    return parser.parse_args()


def _resolve_frontier_replay_windows(
    recent_days: Iterable[date],
    *,
    train_days: int,
    holdout_days: int,
    second_oos_days: int,
) -> FrontierReplayWindows:
    ordered = sorted(dict.fromkeys(recent_days))
    train_count = max(1, int(train_days))
    holdout_count = max(1, int(holdout_days))
    second_count = max(0, int(second_oos_days))
    required = train_count + holdout_count + second_count
    if len(ordered) < required:
        raise ValueError(f"insufficient_recent_trading_days:{len(ordered)}<{required}")
    selected = ordered[-required:]
    train_slice = tuple(selected[:train_count])
    holdout_slice = tuple(selected[train_count : train_count + holdout_count])
    second_slice = tuple(selected[train_count + holdout_count :])
    return FrontierReplayWindows(
        train_days=train_slice,
        holdout_days=holdout_slice,
        second_oos_days=second_slice,
    )


def _business_days(start_day: date, end_day: date) -> tuple[date, ...]:
    return iter_regular_equities_session_dates(start_day, end_day)


def _snapshot_expected_days(
    *,
    window: FrontierReplayWindows,
    full_window_start: date,
    full_window_end: date,
    require_full_window_coverage: bool,
) -> tuple[date, ...]:
    if not require_full_window_coverage:
        return window.expected_days
    return tuple(
        sorted(
            {
                *window.expected_days,
                *_business_days(full_window_start, full_window_end),
            }
        )
    )


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


def _objective_veto_policy(
    *,
    consistency_policy: FullWindowConsistencyPolicy,
    template_defaults: Mapping[str, Any],
    trading_day_count: int,
) -> ObjectiveVetoPolicy:
    required_min_active_day_ratio = consistency_policy.min_active_ratio
    if (
        required_min_active_day_ratio <= 0
        and trading_day_count > 0
        and consistency_policy.min_active_days > 0
    ):
        required_min_active_day_ratio = min(
            Decimal("1"),
            Decimal(consistency_policy.min_active_days) / Decimal(trading_day_count),
        )
    return ObjectiveVetoPolicy(
        required_min_active_day_ratio=max(
            required_min_active_day_ratio,
            Decimal(str(template_defaults.get("required_min_active_day_ratio", "0"))),
        ),
        required_min_daily_notional=max(
            consistency_policy.min_avg_filled_notional_per_day,
            Decimal(str(template_defaults.get("required_min_daily_notional", "0"))),
        ),
        required_max_best_day_share=min(
            consistency_policy.max_best_day_share_of_total_pnl,
            Decimal(str(template_defaults.get("required_max_best_day_share", "1"))),
        ),
        required_max_worst_day_loss=min(
            consistency_policy.max_worst_day_loss,
            Decimal(
                str(
                    template_defaults.get(
                        "required_max_worst_day_loss",
                        str(consistency_policy.max_worst_day_loss),
                    )
                )
            ),
        ),
        required_max_drawdown=min(
            consistency_policy.max_drawdown,
            Decimal(
                str(
                    template_defaults.get(
                        "required_max_drawdown", str(consistency_policy.max_drawdown)
                    )
                )
            ),
        ),
        required_min_regime_slice_pass_rate=max(
            consistency_policy.min_regime_slice_pass_rate,
            Decimal(
                str(template_defaults.get("required_min_regime_slice_pass_rate", "0"))
            ),
        ),
        required_max_gross_exposure_pct_equity=min(
            consistency_policy.max_gross_exposure_pct_equity,
            Decimal(
                str(
                    template_defaults.get(
                        "required_max_gross_exposure_pct_equity",
                        str(consistency_policy.max_gross_exposure_pct_equity),
                    )
                )
            ),
        ),
        required_min_cash=max(
            consistency_policy.min_cash,
            Decimal(
                str(
                    template_defaults.get(
                        "required_min_cash", str(consistency_policy.min_cash)
                    )
                )
            ),
        ),
        required_min_fill_survival_sample_count=max(
            1,
            _nonnegative_int_metric(
                template_defaults.get("required_min_fill_survival_sample_count")
            ),
        ),
        required_min_fill_survival_rate=max(
            Decimal("0"),
            Decimal(str(template_defaults.get("required_min_fill_survival_rate", "0"))),
        ),
    )


def _iter_strategy_override_candidates(
    strategy_override_grid: Mapping[str, Iterable[Any]] | None,
) -> list[dict[str, Any]]:
    if strategy_override_grid is None:
        return [{}]
    return list(_iter_parameter_candidates(strategy_override_grid))


def _candidate_record_seed(
    *,
    path: Path,
    strategy_name: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"candidate_record_not_mapping:{path}")
    raw_strategy = payload.get("candidate_strategy")
    if not isinstance(raw_strategy, Mapping):
        raise ValueError(f"candidate_record_missing_candidate_strategy:{path}")
    record_strategy_name = str(raw_strategy.get("strategy_name") or "").strip()
    if record_strategy_name and record_strategy_name != strategy_name:
        raise ValueError(
            f"candidate_record_strategy_mismatch:{path}:{record_strategy_name}!={strategy_name}"
        )

    params: dict[str, Any] = {}
    raw_params = raw_strategy.get("params")
    if isinstance(raw_params, Mapping):
        params.update({str(key): value for key, value in raw_params.items()})

    overrides: dict[str, Any] = {}
    for key in (
        "universe_symbols",
        "max_notional_per_trade",
        "max_position_pct_equity",
    ):
        value = raw_strategy.get(key)
        if value is not None:
            overrides[key] = value

    if not params and not overrides:
        raise ValueError(f"candidate_record_empty_candidate_strategy:{path}")
    return params, overrides


def _load_candidate_record_seeds(
    *,
    paths: Iterable[Path],
    strategy_name: str,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    return [
        _candidate_record_seed(path=Path(path), strategy_name=strategy_name)
        for path in paths
    ]


def _parameter_grid_items(
    parameter_grid: Mapping[str, Iterable[Any]],
) -> list[tuple[str, list[Any]]]:
    items: list[tuple[str, list[Any]]] = []
    for key, values in parameter_grid.items():
        if isinstance(values, (str, bytes)):
            raise ValueError(f"parameter_values_not_sequence:{key}")
        if isinstance(values, Mapping):
            raise ValueError(f"parameter_values_not_sequence:{key}")
        if not isinstance(values, Iterable):
            raise ValueError(f"parameter_values_not_iterable:{key}")
        items.append((str(key), list(values)))
    return items


def _parameter_exploration_priority(name: str) -> int:
    lowered = name.lower()
    if lowered in {
        "rank_feature",
        "rank_count",
        "selection_mode",
        "signal_motif",
        "top_n",
    } or any(
        token in lowered
        for token in (
            "entry_minute",
            "exit_minute",
            "entry_window",
        )
    ):
        return 0
    if any(
        token in lowered
        for token in ("imbalance", "microprice", "recent_above", "spread", "quote")
    ):
        return 1
    if any(
        token in lowered
        for token in (
            "cross_section",
            "session_open",
            "opening_window",
            "range_position",
            "price_vs_vwap",
            "price_vs_opening",
            "price_above_ema",
            "entry_start",
            "entry_end",
        )
    ):
        return 2
    if any(
        token in lowered
        for token in ("bullish_hist", "bull_rsi", "vol_floor", "vol_ceil")
    ):
        return 3
    if any(
        token in lowered
        for token in ("universe_symbols", "max_notional", "position_pct")
    ):
        return 4
    if any(
        token in lowered
        for token in (
            "stop",
            "trailing",
            "flatten",
            "cooldown",
            "max_entries",
            "max_concurrent",
        )
    ):
        return 5
    return 6


def _candidate_payload_key(candidate: Mapping[str, Any]) -> str:
    return json.dumps(candidate, sort_keys=True, default=str)


def _iter_parameter_candidates(
    parameter_grid: Mapping[str, Iterable[Any]],
) -> Iterator[dict[str, Any]]:
    items = _parameter_grid_items(parameter_grid)
    if not items:
        yield {}
        return
    base_candidate = {name: values[0] for name, values in items if values}
    seen_candidates: set[str] = set()

    def emit(candidate: Mapping[str, Any]) -> dict[str, Any] | None:
        key = _candidate_payload_key(candidate)
        if key in seen_candidates:
            return None
        seen_candidates.add(key)
        return dict(candidate)

    emitted = emit(base_candidate)
    if emitted is not None:
        yield emitted

    priority_items = sorted(
        enumerate(items),
        key=lambda item: (_parameter_exploration_priority(item[1][0]), item[0]),
    )
    for _index, (name, values) in priority_items:
        for value in values[1:]:
            candidate = dict(base_candidate)
            candidate[name] = value
            emitted = emit(candidate)
            if emitted is not None:
                yield emitted

    names = [name for name, _ in items]
    value_sets = [values for _, values in items]
    for combination in itertools.product(*value_sets):
        candidate = {
            name: value for name, value in zip(names, combination, strict=True)
        }
        emitted = emit(candidate)
        if emitted is not None:
            yield emitted


def _iter_initial_worklist_candidates(
    *,
    parameter_grid: Mapping[str, Iterable[Any]],
    override_candidates: Iterable[Mapping[str, Any]],
    seed_candidates: Iterable[tuple[Mapping[str, Any], Mapping[str, Any]]] = (),
) -> Iterator[_WorklistItem]:
    for params_candidate, override_candidate in seed_candidates:
        yield _WorklistItem(
            params_candidate=dict(params_candidate),
            strategy_overrides=dict(override_candidate),
            candidate_record_seed=True,
        )
    for override_candidate in override_candidates:
        for params_candidate in _iter_parameter_candidates(parameter_grid):
            yield _WorklistItem(
                params_candidate=dict(params_candidate),
                strategy_overrides=dict(override_candidate),
            )


def _candidate_symbols(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
) -> tuple[str, ...]:
    if cli_symbols:
        return cli_symbols
    override_symbols = strategy_overrides.get("universe_symbols")
    if not isinstance(override_symbols, (list, tuple)):
        return ()
    values = tuple(
        str(item).strip().upper() for item in override_symbols if str(item).strip()
    )
    return values


def _strategy_universe_symbols(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    data = configmap_payload.get("data")
    if not isinstance(data, Mapping):
        return ()
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        return ()
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, Mapping):
        return ()
    strategies = catalog.get("strategies")
    if not isinstance(strategies, list):
        return ()
    for item in strategies:
        if not isinstance(item, Mapping):
            continue
        if str(item.get("name") or "").strip() != strategy_name:
            continue
        raw_symbols = item.get("universe_symbols")
        if not isinstance(raw_symbols, (list, tuple)):
            return ()
        return tuple(
            str(symbol).strip().upper() for symbol in raw_symbols if str(symbol).strip()
        )
    return ()


def _candidate_universe_symbols(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    override_symbols = _candidate_symbols(
        cli_symbols=cli_symbols,
        strategy_overrides=strategy_overrides,
    )
    if override_symbols:
        return override_symbols
    if cli_symbols:
        return cli_symbols
    return _strategy_universe_symbols(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
    )


def _candidate_search_key(
    *,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
) -> str:
    def _normalize(value: Any) -> Any:
        if isinstance(value, Mapping):
            return {
                str(key): _normalize(val)
                for key, val in sorted(value.items(), key=lambda item: str(item[0]))
            }
        if isinstance(value, tuple):
            return [_normalize(item) for item in value]
        if isinstance(value, list):
            return [_normalize(item) for item in value]
        return value

    return json.dumps(
        {
            "params": _normalize(params_candidate),
            "strategy_overrides": _normalize(
                {
                    str(key): value
                    for key, value in strategy_overrides.items()
                    if str(key) not in _LOCAL_ONLY_OVERRIDE_KEYS
                }
            ),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _candidate_evaluation_key_payload(
    *,
    candidate_search_key: str,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    replay_lineage: Mapping[str, Any],
    replay_tape_validation: Mapping[str, Any] | None,
    window: FrontierReplayWindows,
    full_window_start: date,
    full_window_end: date,
    full_window_summary: Mapping[str, Any],
) -> dict[str, Any]:
    validation = dict(replay_tape_validation or {})
    payload: dict[str, Any] = {
        "schema_version": "torghut.candidate-evaluation-key.v1",
        "candidate_search_key": candidate_search_key,
        "candidate_params_sha256": _stable_payload_hash(params_candidate),
        "strategy_overrides_sha256": _stable_payload_hash(
            {
                str(key): value
                for key, value in strategy_overrides.items()
                if str(key) not in _LOCAL_ONLY_OVERRIDE_KEYS
            }
        ),
        "effective_strategy_config_sha256": str(
            replay_lineage.get("candidate_configmap_sha256") or ""
        ),
        "dataset_snapshot_id": str(replay_lineage.get("dataset_snapshot_id") or ""),
        "replay_lineage_hash": str(replay_lineage.get("lineage_hash") or ""),
        "replay_tape": _replay_tape_selection_metadata(validation),
        "replay_window_spec": {
            "train_start": window.train_start.isoformat(),
            "train_end": window.train_end.isoformat(),
            "holdout_start": window.holdout_start.isoformat(),
            "holdout_end": window.holdout_end.isoformat(),
            "second_oos_start": (
                window.second_oos_start.isoformat()
                if window.second_oos_start is not None
                else ""
            ),
            "second_oos_end": (
                window.second_oos_end.isoformat()
                if window.second_oos_end is not None
                else ""
            ),
            "full_window_start": full_window_start.isoformat(),
            "full_window_end": full_window_end.isoformat(),
        },
        "cost_model_signature": {
            "market_impact_stress_model": str(
                full_window_summary.get("market_impact_stress_model") or ""
            ),
            "market_impact_stress_cost_bps": str(
                full_window_summary.get("market_impact_stress_cost_bps") or "0"
            ),
            "delay_adjusted_depth_stress_model": str(
                full_window_summary.get("delay_adjusted_depth_stress_model") or ""
            ),
            "delay_adjusted_depth_stress_ms": str(
                full_window_summary.get("delay_adjusted_depth_stress_ms") or "0"
            ),
            "implementation_uncertainty_model": str(
                full_window_summary.get("implementation_uncertainty_model") or ""
            ),
        },
        "proof_basis_version": "post_cost_replay_net_pnl_with_cost_stress.v1",
    }
    payload["candidate_evaluation_key"] = _stable_payload_hash(payload)
    return payload


def _resolve_prefetch_symbols(
    *,
    cli_symbols: tuple[str, ...],
    override_candidates: Iterable[Mapping[str, Any]],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    if cli_symbols:
        return cli_symbols
    ordered: list[str] = []
    seen: set[str] = set()
    for candidate in override_candidates:
        for symbol in _candidate_symbols(cli_symbols=(), strategy_overrides=candidate):
            if symbol in seen:
                continue
            seen.add(symbol)
            ordered.append(symbol)
    if ordered:
        return tuple(ordered)
    return _strategy_universe_symbols(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
    )


def _prefetch_signal_rows(
    *,
    strategy_configmap_path: Path,
    clickhouse_http_url: str,
    clickhouse_username: str | None,
    clickhouse_password: str | None,
    start_date: date,
    end_date: date,
    start_equity: Decimal,
    chunk_minutes: int,
    symbols: tuple[str, ...],
    progress_log_interval_seconds: int,
) -> list[Any]:
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=strategy_configmap_path,
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=chunk_minutes,
        flatten_eod=True,
        start_equity=start_equity,
        symbols=symbols,
        progress_log_interval_seconds=progress_log_interval_seconds,
    )
    rows = list(replay_mod._iter_signal_rows(config))
    rows.sort(key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    return rows


def _cached_iter_signal_rows_factory(
    rows: list[Any],
) -> Callable[[replay_mod.ReplayConfig], Iterator[Any]]:
    rows_by_day: dict[date, list[tuple[int, Any]]] = {}
    rows_by_day_symbol: dict[date, dict[str, list[tuple[int, Any]]]] = {}
    for index, row in enumerate(rows):
        signal_day = row.event_ts.date()
        indexed_row = (index, row)
        rows_by_day.setdefault(signal_day, []).append(indexed_row)
        rows_by_day_symbol.setdefault(signal_day, {}).setdefault(
            str(row.symbol).upper(), []
        ).append(indexed_row)

    def _iter_signal_rows(config: replay_mod.ReplayConfig) -> Iterator[Any]:
        selected_symbols = (
            {symbol.upper() for symbol in config.symbols} if config.symbols else None
        )
        if config.start_date > config.end_date:
            return
        for day_offset in range((config.end_date - config.start_date).days + 1):
            signal_day = config.start_date + timedelta(days=day_offset)
            if selected_symbols is None:
                for _, row in rows_by_day.get(signal_day, ()):
                    yield row
                continue
            day_symbols = rows_by_day_symbol.get(signal_day)
            if not day_symbols:
                continue
            symbol_rows = [
                iter(day_symbols[symbol])
                for symbol in selected_symbols
                if symbol in day_symbols
            ]
            for _, row in heapq.merge(*symbol_rows, key=lambda item: item[0]):
                yield row

    return _iter_signal_rows


@contextlib.contextmanager
def _cached_signal_rows_patch(rows: list[Any]) -> Iterator[None]:
    with patch.object(
        replay_mod,
        "_iter_signal_rows",
        _cached_iter_signal_rows_factory(rows),
    ):
        yield


def _load_replay_tape_rows(
    *,
    tape_path: Path,
    manifest_path: Path | None,
    start_date: date,
    end_date: date,
    symbols: tuple[str, ...],
    allow_stale_tape: bool,
    tape: ReplayTape | None = None,
) -> tuple[list[Any], dict[str, Any]]:
    loaded_tape = tape or load_replay_tape(tape_path, manifest_path=manifest_path)
    validation = validate_tape_freshness(
        loaded_tape.manifest,
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
        allow_stale_tape=allow_stale_tape,
    )
    rows = slice_tape_by_window(
        loaded_tape.rows,
        start_date=start_date,
        end_date=end_date,
    )
    rows = slice_tape_by_symbols(rows, symbols=symbols)
    validation["tape_path"] = str(tape_path)
    validation["manifest_path"] = str(manifest_path) if manifest_path else ""
    validation["selected_row_count"] = len(rows)
    validation["selected_symbols"] = sorted({row.symbol.upper() for row in rows})
    validation["source_query_digest"] = loaded_tape.manifest.source_query_digest
    validation["manifest_start_date"] = loaded_tape.manifest.start_date.isoformat()
    validation["manifest_end_date"] = loaded_tape.manifest.end_date.isoformat()
    validation["row_symbols"] = list(loaded_tape.manifest.row_symbols)
    validation["source_table_versions"] = dict(
        loaded_tape.manifest.source_table_versions
    )
    validation["artifact_refs"] = dict(loaded_tape.manifest.artifact_refs)
    return list(rows), validation


def _replay_tape_trading_days(tape: ReplayTape) -> tuple[date, ...]:
    return tuple(
        sorted({row.event_ts.astimezone(timezone.utc).date() for row in tape.rows})
    )


def _build_replay_tape_snapshot_receipt(
    *,
    validation: Mapping[str, Any],
    rows: Sequence[Any],
    start_day: date,
    end_day: date,
    expected_last_trading_day: date,
    expected_trading_days: Sequence[date],
    allow_stale_tape: bool,
) -> DatasetSnapshotReceipt:
    observed_days = _replay_tape_row_days(rows)
    observed_day_set = set(observed_days)
    missing_days = tuple(
        day for day in expected_trading_days if day not in observed_day_set
    )
    latest_observed_day = observed_days[-1] if observed_days else start_day
    is_fresh = (
        str(validation.get("status") or "") == "valid"
        and latest_observed_day >= expected_last_trading_day
        and not missing_days
    )
    snapshot_id = str(validation.get("dataset_snapshot_ref") or "").strip()
    if not snapshot_id:
        snapshot_id = f"replay-tape-{str(validation.get('content_sha256') or '')[:24]}"
    return DatasetSnapshotReceipt(
        snapshot_id=snapshot_id,
        source="replay_tape",
        window_size="PT1S",
        start_day=start_day,
        end_day=end_day,
        expected_last_trading_day=expected_last_trading_day,
        is_fresh=is_fresh,
        missing_days=missing_days,
        row_count=len(rows),
        stale_override_used=bool(validation.get("stale_override_used"))
        or (allow_stale_tape and not is_fresh),
        witnesses=(
            DatasetWitness(
                name="replay_tape_manifest",
                payload={
                    "dataset_snapshot_ref": str(
                        validation.get("dataset_snapshot_ref") or ""
                    ),
                    "content_sha256": str(validation.get("content_sha256") or ""),
                    "source_query_digest": str(
                        validation.get("source_query_digest") or ""
                    ),
                    "manifest_start_date": str(
                        validation.get("manifest_start_date") or ""
                    ),
                    "manifest_end_date": str(validation.get("manifest_end_date") or ""),
                    "row_count": int(validation.get("row_count") or 0),
                    "trading_day_count": int(validation.get("trading_day_count") or 0),
                    "requested_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("requested_trading_days") or [],
                        )
                    ),
                    "observed_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("observed_trading_days") or [],
                        )
                    ),
                    "missing_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("missing_trading_days") or [],
                        )
                    ),
                    "row_count_by_trading_day": dict(
                        cast(
                            Mapping[str, Any],
                            validation.get("row_count_by_trading_day") or {},
                        )
                    ),
                    "missing_symbol_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("missing_symbol_trading_days") or [],
                        )
                    ),
                    "row_count_by_symbol_trading_day": dict(
                        cast(
                            Mapping[str, Any],
                            validation.get("row_count_by_symbol_trading_day") or {},
                        )
                    ),
                    "coverage_status": str(validation.get("coverage_status") or ""),
                    "source_table_versions": dict(
                        cast(
                            Mapping[str, Any],
                            validation.get("source_table_versions") or {},
                        )
                    ),
                    "artifact_refs": dict(
                        cast(Mapping[str, Any], validation.get("artifact_refs") or {})
                    ),
                },
            ),
            DatasetWitness(
                name="replay_tape_selected_rows",
                payload={
                    "row_count": len(rows),
                    "observed_days": [item.isoformat() for item in observed_days],
                    "missing_days": [item.isoformat() for item in missing_days],
                    "selected_symbols": list(
                        cast(Sequence[Any], validation.get("selected_symbols") or [])
                    ),
                    "status": str(validation.get("status") or ""),
                    "reasons": list(
                        cast(Sequence[Any], validation.get("reasons") or [])
                    ),
                },
            ),
        ),
    )


def _replay_tape_row_days(rows: Iterable[Any]) -> tuple[date, ...]:
    return tuple(sorted({row.event_ts.astimezone(timezone.utc).date() for row in rows}))


def apply_candidate_to_configmap_with_overrides(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    candidate_params: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    disable_other_strategies: bool,
) -> dict[str, Any]:
    candidate_params = dict(candidate_params)
    if disable_other_strategies:
        candidate_params.setdefault("position_isolation_mode", "per_strategy")
    root = apply_candidate_to_configmap(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
        candidate_params=candidate_params,
        disable_other_strategies=disable_other_strategies,
    )
    if not strategy_overrides:
        return root

    data = root.get("data")
    if not isinstance(data, dict):
        raise ValueError("strategy_configmap_missing_data")
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        raise ValueError("strategy_configmap_missing_strategies_yaml")
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, dict):
        raise ValueError("strategy_catalog_not_mapping")
    strategies = catalog.get("strategies")
    if not isinstance(strategies, list):
        raise ValueError("strategy_catalog_missing_strategies")

    matched = False
    for item in strategies:
        if not isinstance(item, dict):
            continue
        item_name = str(item.get("name") or "").strip()
        if item_name != strategy_name:
            continue
        matched = True
        for key, value in strategy_overrides.items():
            if key == "params":
                raise ValueError("strategy_override_key_reserved:params")
            if key in _LOCAL_ONLY_OVERRIDE_KEYS:
                continue
            item[key] = value
        break
    if not matched:
        raise ValueError(f"strategy_not_found:{strategy_name}")

    data["strategies.yaml"] = yaml.safe_dump(catalog, sort_keys=False)
    return root


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


def _generate_symbol_prune_children(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    symbol_contributions: Mapping[str, Mapping[str, Any]],
    branch_count: int,
    min_universe_size: int,
) -> list[tuple[str, dict[str, Any]]]:
    if cli_symbols:
        return []
    universe = list(
        _candidate_universe_symbols(
            cli_symbols=cli_symbols,
            strategy_overrides=strategy_overrides,
            configmap_payload=configmap_payload,
            strategy_name=strategy_name,
        )
    )
    if len(universe) <= max(1, min_universe_size):
        return []

    ranked_symbols = [symbol for symbol in symbol_contributions if symbol in universe]
    children: list[tuple[str, dict[str, Any]]] = []
    for symbol in ranked_symbols[: max(1, branch_count)]:
        pruned_universe = [item for item in universe if item != symbol]
        if len(pruned_universe) < max(1, min_universe_size):
            continue
        next_override = dict(strategy_overrides)
        next_override["universe_symbols"] = pruned_universe
        children.append((symbol, next_override))
    return children


def _strategy_item_from_configmap(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    data = configmap_payload.get("data")
    if not isinstance(data, Mapping):
        return {}, {}
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        return {}, {}
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, Mapping):
        return {}, {}
    strategies = catalog.get("strategies")
    if not isinstance(strategies, list):
        return {}, {}
    for item in strategies:
        if not isinstance(item, Mapping):
            continue
        if str(item.get("name") or "").strip() != strategy_name:
            continue
        params = item.get("params")
        return item, params if isinstance(params, Mapping) else {}
    return {}, {}


def _loss_repair_trigger_reason(
    *,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
) -> str | None:
    for raw_reason in hard_vetoes:
        reason = str(raw_reason)
        if reason in _LOSS_REPAIR_TRIGGER_REASONS:
            return reason
        if reason.endswith(_LOSS_REPAIR_TRIGGER_SUFFIXES):
            return reason
    try:
        daily_net_below_min_count = int(
            full_window_summary.get("daily_net_below_min_count") or 0
        )
    except (TypeError, ValueError):
        daily_net_below_min_count = 0
    if daily_net_below_min_count > 0:
        return "daily_net_below_min"
    return None


def _apply_loss_control_tightening(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
) -> bool:
    changed = False
    for key, floor in _LOSS_REPAIR_BPS_FLOORS.items():
        if key not in params and key not in strategy_params:
            continue
        tightened = _tightened_bps(
            params.get(key, strategy_params.get(key)), floor=floor
        )
        if tightened is not None:
            params[key] = tightened
            changed = True

    for key in _LOSS_REPAIR_EXIT_LIMIT_KEYS:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current <= 1:
            continue
        params[key] = "1"
        changed = True

    for key in _LOSS_REPAIR_LOCKOUT_KEYS:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current < 0:
            continue
        repaired = min(
            Decimal("14400"),
            max(Decimal("1800"), current * Decimal("2")),
        ).quantize(Decimal("1"))
        if repaired > current:
            params[key] = _decimal_payload(repaired)
            changed = True
    return changed


def _apply_exposure_clamp(
    *,
    params: dict[str, Any],
    overrides: dict[str, Any],
    strategy_item: Mapping[str, Any],
    strategy_params: Mapping[str, Any],
    scale: Decimal = _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE,
) -> bool:
    changed = False
    for key in _LOSS_REPAIR_PARAM_EXPOSURE_KEYS:
        if key not in params and key not in strategy_params:
            continue
        reduced = _reduced_exposure(
            params.get(key, strategy_params.get(key)), scale=scale
        )
        if reduced is not None:
            params[key] = reduced
            changed = True

    for key in _LOSS_REPAIR_STRATEGY_EXPOSURE_KEYS:
        if key not in overrides and key not in strategy_item:
            continue
        reduced = _reduced_exposure(
            overrides.get(key, strategy_item.get(key)), scale=scale
        )
        if reduced is not None:
            overrides[key] = reduced
            changed = True
    return changed


def _generate_loss_repair_children(
    *,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    candidate_configmap: Mapping[str, Any],
    strategy_name: str,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
    branch_count: int,
    policy_required_max_gross_exposure_pct_equity: Decimal | None = None,
    policy_required_min_cash: Decimal | None = None,
) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    trigger_reason = _loss_repair_trigger_reason(
        hard_vetoes=hard_vetoes,
        full_window_summary=full_window_summary,
    )
    if trigger_reason is None:
        return []

    strategy_item, strategy_params = _strategy_item_from_configmap(
        configmap_payload=candidate_configmap,
        strategy_name=strategy_name,
    )
    parent_key = _candidate_search_key(
        params_candidate=params_candidate,
        strategy_overrides=strategy_overrides,
    )
    exposure_repair_scale = _capital_repair_exposure_scale(
        full_window_summary,
        policy_required_max_gross_exposure_pct_equity=policy_required_max_gross_exposure_pct_equity,
        policy_required_min_cash=policy_required_min_cash,
    )
    children: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    seen: set[str] = {parent_key}

    def add_child(label: str, *, tighten_losses: bool, clamp_exposure: bool) -> None:
        if len(children) >= max(1, branch_count):
            return
        next_params = dict(params_candidate)
        next_overrides = dict(strategy_overrides)
        changed = False
        if tighten_losses:
            changed = (
                _apply_loss_control_tightening(
                    params=next_params,
                    strategy_params=strategy_params,
                )
                or changed
            )
        if clamp_exposure:
            changed = (
                _apply_exposure_clamp(
                    params=next_params,
                    overrides=next_overrides,
                    strategy_item=strategy_item,
                    strategy_params=strategy_params,
                    scale=exposure_repair_scale,
                )
                or changed
            )
        if not changed:
            return
        child_key = _candidate_search_key(
            params_candidate=next_params,
            strategy_overrides=next_overrides,
        )
        if child_key in seen:
            return
        seen.add(child_key)
        children.append((f"{label}:{trigger_reason}", next_params, next_overrides))

    add_child("loss_controls_and_exposure", tighten_losses=True, clamp_exposure=True)
    add_child("loss_controls", tighten_losses=True, clamp_exposure=False)
    add_child("exposure_clamp", tighten_losses=False, clamp_exposure=True)
    return children


def _positive_capital_safe_summary(full_window_summary: Mapping[str, Any]) -> bool:
    net_per_day = _decimal_or_none(
        full_window_summary.get("net_per_day")
        or full_window_summary.get("net_pnl_per_day")
    )
    max_gross = _decimal_or_none(
        full_window_summary.get("max_gross_exposure_pct_equity")
    )
    min_cash = _decimal_or_none(full_window_summary.get("min_cash"))
    if net_per_day is None or max_gross is None or min_cash is None:
        return False
    if net_per_day <= 0 or max_gross > 1 or min_cash < 0:
        return False
    try:
        negative_cash_count = int(
            full_window_summary.get("negative_cash_observation_count") or 0
        )
    except (TypeError, ValueError):
        negative_cash_count = 1
    return negative_cash_count <= 0


def _consistency_repair_trigger_reason(
    *,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
) -> str | None:
    reasons = [str(raw_reason) for raw_reason in hard_vetoes]
    if any(reason in _CONSISTENCY_REPAIR_UNSAFE_REASONS for reason in reasons):
        return None
    if not _positive_capital_safe_summary(full_window_summary):
        return None
    for reason in reasons:
        if reason in _CONSISTENCY_REPAIR_TRIGGER_REASONS:
            return reason
    return None


def _increment_integer_candidate_param(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
    keys: Sequence[str],
) -> bool:
    for key in keys:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current < 1:
            continue
        params[key] = _decimal_payload(current.to_integral_value() + 1)
        return True
    return False


def _halve_positive_integer_candidate_param(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
    keys: Sequence[str],
) -> bool:
    for key in keys:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current <= 1:
            continue
        repaired = max(Decimal("1"), (current / Decimal("2")).quantize(Decimal("1")))
        params[key] = _decimal_payload(repaired)
        return True
    return False


def _relax_signal_threshold_candidate_param(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
    keys: Sequence[str],
) -> bool:
    relaxed_count = 0
    for key in keys:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current <= 0:
            continue
        if current <= Decimal("1"):
            repaired = max(
                _CONSISTENCY_REPAIR_MIN_RANK_THRESHOLD,
                (current - _CONSISTENCY_REPAIR_RANK_STEP).quantize(Decimal("0.01")),
            )
        else:
            repaired = (current * _CONSISTENCY_REPAIR_THRESHOLD_SCALE).quantize(
                Decimal("0.01")
            )
        if repaired >= current:
            continue
        params[key] = _decimal_payload(repaired)
        relaxed_count += 1
        if relaxed_count >= _CONSISTENCY_REPAIR_MAX_SIGNAL_THRESHOLD_RELAXATIONS:
            break
    return relaxed_count > 0


def _generate_consistency_repair_children(
    *,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    candidate_configmap: Mapping[str, Any],
    strategy_name: str,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
    branch_count: int,
) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    trigger_reason = _consistency_repair_trigger_reason(
        hard_vetoes=hard_vetoes,
        full_window_summary=full_window_summary,
    )
    if trigger_reason is None:
        return []

    _, strategy_params = _strategy_item_from_configmap(
        configmap_payload=candidate_configmap,
        strategy_name=strategy_name,
    )
    parent_key = _candidate_search_key(
        params_candidate=params_candidate,
        strategy_overrides=strategy_overrides,
    )
    children: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    seen: set[str] = {parent_key}

    def add_child(label: str, mutator: Callable[[dict[str, Any]], bool]) -> None:
        if len(children) >= max(1, branch_count):
            return
        next_params = dict(params_candidate)
        next_overrides = dict(strategy_overrides)
        if not mutator(next_params):
            return
        child_key = _candidate_search_key(
            params_candidate=next_params,
            strategy_overrides=next_overrides,
        )
        if child_key in seen:
            return
        seen.add(child_key)
        children.append((f"{label}:{trigger_reason}", next_params, next_overrides))

    add_child(
        "consistency_signal_thresholds",
        lambda next_params: _relax_signal_threshold_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_SIGNAL_THRESHOLD_KEYS,
        ),
    )
    add_child(
        "consistency_breadth",
        lambda next_params: _increment_integer_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_BREADTH_KEYS,
        ),
    )
    add_child(
        "consistency_entries",
        lambda next_params: _increment_integer_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_ENTRY_KEYS,
        ),
    )
    add_child(
        "consistency_cooldown",
        lambda next_params: _halve_positive_integer_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_COOLDOWN_KEYS,
        ),
    )
    return children


def _selected_normalization_regime(
    *,
    strategy_overrides: Mapping[str, Any],
    template_allowed_normalizations: tuple[str, ...],
) -> str | None:
    override = str(strategy_overrides.get("normalization_regime") or "").strip()
    if override:
        return override
    return (
        template_allowed_normalizations[0] if template_allowed_normalizations else None
    )


def _resolved_clickhouse_password(args: argparse.Namespace) -> str | None:
    direct_password = str(getattr(args, "clickhouse_password", "") or "").strip()
    if direct_password:
        return direct_password
    password_env = str(getattr(args, "clickhouse_password_env", "") or "").strip()
    if not password_env:
        return None
    return os.environ.get(password_env) or None


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
    "annotations",
    "argparse",
    "contextlib",
    "heapq",
    "hashlib",
    "itertools",
    "json",
    "os",
    "socket",
    "sys",
    "tempfile",
    "Counter",
    "deque",
    "dataclass",
    "date",
    "datetime",
    "time",
    "timedelta",
    "timezone",
    "Decimal",
    "InvalidOperation",
    "ROUND_CEILING",
    "ROUND_DOWN",
    "Path",
    "Any",
    "Callable",
    "Iterable",
    "Iterator",
    "Mapping",
    "Sequence",
    "cast",
    "urlparse",
    "patch",
    "yaml",
    "DatasetSnapshotReceipt",
    "DatasetWitness",
    "build_dataset_snapshot_receipt",
    "ensure_fresh_snapshot",
    "build_replay_decomposition",
    "max_family_contribution_share",
    "max_symbol_concentration_share",
    "regime_slice_pass_rate",
    "derive_family_template_id",
    "family_template_dir",
    "load_family_template",
    "ObjectiveVetoPolicy",
    "build_scorecard",
    "deployable_lower_bound_missing_count",
    "deployable_lower_bound_net_pnl_per_day",
    "deployable_proof_failed_gate_count",
    "evaluate_vetoes",
    "rank_scorecards",
    "ReplayTape",
    "load_replay_tape",
    "slice_tape_by_symbols",
    "slice_tape_by_window",
    "validate_tape_freshness",
    "iter_regular_equities_session_dates",
    "POST_COST_PNL_BASIS",
    "RuntimeLedgerBucket",
    "build_runtime_ledger_buckets",
    "ProfitabilityConstraintPolicy",
    "score_replay_profitability_candidate",
    "summarize_replay_profitability",
    "replay_mod",
    "run_replay",
    "_SWEEP_SCHEMA_VERSION",
    "_build_replay_config",
    "_load_sweep_config",
    "_resolve_recent_trading_days",
    "apply_candidate_to_configmap",
    "_LOCAL_ONLY_OVERRIDE_KEYS",
    "_SECOND_OOS_WINDOW_ID",
    "_SAFE_EXACT_REPLAY_CANDIDATE_CAP",
    "_SAFE_EXACT_REPLAY_EXPLOITATION_SLOTS",
    "_SAFE_EXACT_REPLAY_EXPLORATION_SLOTS",
    "_SAFE_LOCAL_EXACT_REPLAY_WORKERS",
    "_DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER",
    "_LOSS_REPAIR_TRIGGER_REASONS",
    "_LOSS_REPAIR_TRIGGER_SUFFIXES",
    "_LOSS_REPAIR_BPS_FLOORS",
    "_LOSS_REPAIR_EXIT_LIMIT_KEYS",
    "_LOSS_REPAIR_LOCKOUT_KEYS",
    "_LOSS_REPAIR_PARAM_EXPOSURE_KEYS",
    "_LOSS_REPAIR_STRATEGY_EXPOSURE_KEYS",
    "_LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE",
    "_LOSS_REPAIR_CAPITAL_SAFETY_BUFFER",
    "_LOSS_REPAIR_MIN_SCALE_QUANTUM",
    "_CONSISTENCY_REPAIR_TRIGGER_REASONS",
    "_CONSISTENCY_REPAIR_UNSAFE_REASONS",
    "_PAPER_PROBATION_CAPITAL_REPAIR_REASONS",
    "_PAPER_PROBATION_LOSS_REPAIR_REASONS",
    "_PAPER_PROBATION_ACTIVITY_REPAIR_REASONS",
    "_PAPER_PROBATION_TAIL_RISK_REASONS",
    "_PAPER_PROBATION_QUEUE_SURVIVAL_REASONS",
    "_PAPER_PROBATION_TARGET_SCALE_QUANTUM",
    "_PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS",
    "_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH",
    "_CONSISTENCY_REPAIR_ENTRY_KEYS",
    "_CONSISTENCY_REPAIR_BREADTH_KEYS",
    "_CONSISTENCY_REPAIR_COOLDOWN_KEYS",
    "_CONSISTENCY_REPAIR_SIGNAL_THRESHOLD_KEYS",
    "_CONSISTENCY_REPAIR_RANK_STEP",
    "_CONSISTENCY_REPAIR_MIN_RANK_THRESHOLD",
    "_CONSISTENCY_REPAIR_THRESHOLD_SCALE",
    "_CONSISTENCY_REPAIR_MAX_SIGNAL_THRESHOLD_RELAXATIONS",
    "_WorklistItem",
    "FullWindowConsistencyPolicy",
    "OrderTypeAblationPolicy",
    "FrontierReplayWindows",
    "_optional_int",
    "_order_type_ablation_policy",
    "_write_json_output",
    "_safe_exact_replay_candidate_budget",
    "_staged_search_budget_payload",
    "_frontier_error_payload",
    "_clickhouse_host_requires_dns_preflight",
    "_clickhouse_endpoint_preflight_failure",
    "_stable_payload_hash",
    "_replay_lineage_window_payload",
    "_candidate_replay_lineage_payload",
    "_replay_window_coverage_payload",
    "_parse_args",
    "_resolve_frontier_replay_windows",
    "_business_days",
    "_snapshot_expected_days",
    "_rolling_lower_bound",
    "_objective_veto_policy",
    "_iter_strategy_override_candidates",
    "_candidate_record_seed",
    "_load_candidate_record_seeds",
    "_parameter_grid_items",
    "_parameter_exploration_priority",
    "_candidate_payload_key",
    "_iter_parameter_candidates",
    "_iter_initial_worklist_candidates",
    "_candidate_symbols",
    "_strategy_universe_symbols",
    "_candidate_universe_symbols",
    "_candidate_search_key",
    "_candidate_evaluation_key_payload",
    "_replay_tape_selection_metadata",
    "_resolve_prefetch_symbols",
    "_prefetch_signal_rows",
    "_cached_iter_signal_rows_factory",
    "_cached_signal_rows_patch",
    "_load_replay_tape_rows",
    "_replay_tape_trading_days",
    "_build_replay_tape_snapshot_receipt",
    "_replay_tape_row_days",
    "apply_candidate_to_configmap_with_overrides",
    "_resolve_full_window",
    "_max_drawdown_from_daily_net",
    "_daily_filled_notional",
    "_daily_liquidity_notional",
    "_daily_decimal_metric",
    "_daily_int_metric",
    "_int_mapping",
    "_mapping",
    "_optional_decimal",
    "_nonnegative_int_metric",
    "_truthy_metric",
    "_order_lifecycle_metrics",
    "_order_type_execution_metrics",
    "_normalized_order_type",
    "_selected_entry_order_type",
    "_forced_order_type_sample_count",
    "_payload_digest",
    "_artifact_run_dir_name",
    "_order_type_ablation_artifact_dir",
    "_frontier_ledger_text",
    "_frontier_ledger_datetime",
    "_frontier_exact_replay_bucket_range",
    "_frontier_exact_replay_rows",
    "_frontier_exact_replay_bucket_has_authority",
    "_frontier_exact_replay_bucket",
    "_exact_replay_ledger_artifact_update",
    "_order_type_replay_arm_summary",
    "_order_type_ablation_payload",
    "DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS",
    "CONFORMAL_TAIL_RISK_ALPHA",
    "BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS",
    "MARKET_IMPACT_STRESS_SOURCE_MARKERS",
    "_p10",
    "_conformal_tail_loss_buffer",
    "_conformal_tail_risk_metrics",
    "_breakeven_transaction_cost_buffer_metrics",
    "_delay_depth_fillability",
    "_implementation_uncertainty_metrics",
    "_replay_stress_metrics",
    "_decimal_payload_metric",
    "_max_best_day_share_of_total_pnl",
    "_consistency_penalty",
    "_second_oos_summary",
    "_holdout_oos_passed",
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
    "_symbol_contributions_from_replay_payload",
    "_top_counter_payload",
    "_counter_from_payload",
    "_near_miss_digest",
    "_train_gate_diagnostics_from_replay_payload",
    "_generate_symbol_prune_children",
    "_strategy_item_from_configmap",
    "_decimal_or_none",
    "_decimal_payload",
    "_tightened_bps",
    "_reduced_exposure",
    "_capital_repair_exposure_scale",
    "_loss_repair_trigger_reason",
    "_apply_loss_control_tightening",
    "_apply_exposure_clamp",
    "_generate_loss_repair_children",
    "_positive_capital_safe_summary",
    "_consistency_repair_trigger_reason",
    "_increment_integer_candidate_param",
    "_halve_positive_integer_candidate_param",
    "_relax_signal_threshold_candidate_param",
    "_generate_consistency_repair_children",
    "_rank_scored_candidates",
    "_safe_decimal",
    "_candidate_metric_value",
    "_build_economic_shortlist",
    "_candidate_artifact_refs",
    "_candidate_exact_replay_ledger_artifact_refs",
    "_candidate_runtime_ledger_count",
    "_paper_probation_required_actions",
    "_paper_probation_notional_scale_decimal",
    "_paper_probation_notional_scale",
    "_paper_probation_target_notional_scale",
    "_candidate_metric_decimal",
    "_candidate_source_lineage_ok",
    "_candidate_replay_tape_metadata_blockers",
    "_candidate_post_cost_proof_blockers",
    "_candidate_exact_replay_parity_ok",
    "_candidate_handoff_diagnostics",
    "_bounded_sim_handoff_metadata",
    "_paper_probation_repair_actions",
    "_paper_probation_target_progress",
    "_paper_probation_repair_plan",
    "_build_paper_probation_shortlist",
    "_frontier_state_item",
    "_build_frontier_workflow_states",
    "_build_frontier_payload",
    "_selected_normalization_regime",
    "_resolved_clickhouse_password",
    "run_consistent_profitability_frontier",
    "main",
    "cli_main",
]
