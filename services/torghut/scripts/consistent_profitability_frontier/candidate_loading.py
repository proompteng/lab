#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence, cast


from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
)
from app.trading.session_context import iter_regular_equities_session_dates
from app.trading.reporting import (
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

_SAFE_EXACT_REPLAY_EXPLOITATION_SLOTS = 4

_SAFE_EXACT_REPLAY_EXPLORATION_SLOTS = 2

_SAFE_LOCAL_EXACT_REPLAY_WORKERS = 2

_DEFAULT_STAGED_TRAIN_SCREEN_MULTIPLIER = 3


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


__all__ = [
    "_WorklistItem",
    "FrontierReplayWindows",
    "_optional_int",
    "_order_type_ablation_policy",
    "_safe_exact_replay_candidate_budget",
    "_staged_search_budget_payload",
    "_stable_payload_hash",
    "_replay_lineage_window_payload",
    "_candidate_replay_lineage_payload",
    "_replay_window_coverage_payload",
    "_resolve_frontier_replay_windows",
    "_business_days",
    "_snapshot_expected_days",
    "_objective_veto_policy",
]
