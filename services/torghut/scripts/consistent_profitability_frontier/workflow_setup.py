#!/usr/bin/env python3
"""Load immutable inputs for the consistent profitability frontier workflow."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Mapping, cast

import yaml

from app.trading.discovery.dataset_snapshot import (
    DatasetSnapshotReceipt,
    build_dataset_snapshot_receipt,
    ensure_fresh_snapshot,
)
from app.trading.discovery.family_templates import (
    FamilyTemplate,
    derive_family_template_id,
    load_family_template,
)
from app.trading.discovery.objectives import ObjectiveVetoPolicy
from app.trading.discovery.replay_tape import ReplayTape, load_replay_tape
from app.trading.reporting import ProfitabilityConstraintPolicy
from scripts.search_profitability_frontier import (
    _load_sweep_config,
    _resolve_recent_trading_days,
)

from scripts.consistent_profitability_frontier.candidate_generation import (
    _iter_strategy_override_candidates,
    _load_candidate_record_seeds,
)
from scripts.consistent_profitability_frontier.candidate_loading import (
    FrontierReplayWindows,
    _objective_veto_policy,
    _optional_int,
    _order_type_ablation_policy,
    _resolve_frontier_replay_windows,
    _snapshot_expected_days,
)
from scripts.consistent_profitability_frontier.cli_parsing import (
    _clickhouse_endpoint_preflight_failure,
    _resolved_clickhouse_password,
)
from scripts.consistent_profitability_frontier.common import (
    FullWindowConsistencyPolicy,
    OrderTypeAblationPolicy,
    _resolve_full_window,
)
from scripts.consistent_profitability_frontier.replay_data import (
    _build_replay_tape_snapshot_receipt,
    _load_replay_tape_rows,
    _replay_tape_trading_days,
    _resolve_prefetch_symbols,
)


@dataclass(frozen=True)
class FrontierRunSetup:
    clickhouse_password: str | None
    sweep_config: Mapping[str, Any]
    window: FrontierReplayWindows
    full_window_start: date
    full_window_end: date
    base_configmap: Mapping[str, Any]
    family: str
    strategy_name: str
    family_template: FamilyTemplate
    disable_other_strategies: bool
    parameter_grid: Mapping[str, Iterable[Any]]
    override_candidates: list[dict[str, Any]]
    seed_candidates: list[tuple[dict[str, Any], dict[str, Any]]]
    prefetch_symbols: tuple[str, ...]
    dataset_snapshot_receipt: DatasetSnapshotReceipt
    cached_rows: list[Any] | None
    replay_tape_validation: dict[str, Any] | None
    holdout_policy: ProfitabilityConstraintPolicy
    consistency_policy: FullWindowConsistencyPolicy
    order_type_ablation_policy: OrderTypeAblationPolicy
    max_train_screen_worst_day_loss: Decimal
    min_train_screen_net_per_day: Decimal
    min_train_screen_active_ratio: Decimal
    symbols: tuple[str, ...]
    objective_veto_policy: ObjectiveVetoPolicy
    collect_train_gate_diagnostics: bool


@dataclass(frozen=True)
class _ReplayWindowSetup:
    window: FrontierReplayWindows
    full_window_start: date
    full_window_end: date
    replay_tape_path: object | None
    replay_tape_manifest_path: Path | None
    loaded_replay_tape: ReplayTape | None
    explicit_expected_last_trading_day: date | None


@dataclass(frozen=True)
class _SweepFamilySetup:
    base_configmap: Mapping[str, Any]
    family: str
    strategy_name: str
    family_template: FamilyTemplate
    disable_other_strategies: bool
    parameter_grid: Mapping[str, Iterable[Any]]
    strategy_override_grid: Mapping[str, Any] | None
    override_candidates: list[dict[str, Any]]
    seed_candidates: list[tuple[dict[str, Any], dict[str, Any]]]
    symbols: tuple[str, ...]
    prefetch_symbols: tuple[str, ...]


@dataclass(frozen=True)
class _FrontierPolicies:
    holdout_policy: ProfitabilityConstraintPolicy
    consistency_policy: FullWindowConsistencyPolicy
    order_type_ablation_policy: OrderTypeAblationPolicy
    max_train_screen_worst_day_loss: Decimal
    min_train_screen_net_per_day: Decimal
    min_train_screen_active_ratio: Decimal
    objective_veto_policy: ObjectiveVetoPolicy
    collect_train_gate_diagnostics: bool


@dataclass(frozen=True)
class _SnapshotSetup:
    dataset_snapshot_receipt: DatasetSnapshotReceipt
    cached_rows: list[Any] | None
    replay_tape_validation: dict[str, Any] | None


def _optional_mapping(value: object, *, error: str) -> Mapping[str, Any]:
    if value is None:
        return {}
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    raise ValueError(error)


def _load_replay_window_setup(
    args: argparse.Namespace,
    clickhouse_password: str | None,
) -> _ReplayWindowSetup:
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
    return _ReplayWindowSetup(
        window=window,
        full_window_start=full_window_start,
        full_window_end=full_window_end,
        replay_tape_path=replay_tape_path,
        replay_tape_manifest_path=replay_tape_manifest_path,
        loaded_replay_tape=loaded_replay_tape,
        explicit_expected_last_trading_day=explicit_expected_last_trading_day,
    )


def _load_sweep_family_setup(
    args: argparse.Namespace,
    sweep_config: Mapping[str, Any],
) -> _SweepFamilySetup:
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
    return _SweepFamilySetup(
        base_configmap=cast(Mapping[str, Any], base_configmap),
        family=family,
        strategy_name=strategy_name,
        family_template=family_template,
        disable_other_strategies=disable_other_strategies,
        parameter_grid=cast(Mapping[str, Iterable[Any]], parameter_grid),
        strategy_override_grid=cast(Mapping[str, Any] | None, strategy_override_grid),
        override_candidates=override_candidates,
        seed_candidates=seed_candidates,
        symbols=symbols,
        prefetch_symbols=prefetch_symbols,
    )


def _load_frontier_policies(
    args: argparse.Namespace,
    sweep_config: Mapping[str, Any],
    family_setup: _SweepFamilySetup,
    replay_setup: _ReplayWindowSetup,
) -> _FrontierPolicies:
    constraints = _optional_mapping(
        sweep_config.get("constraints"),
        error="sweep_config_constraints_not_mapping",
    )
    consistency_constraints = _optional_mapping(
        sweep_config.get("consistency_constraints"),
        error="sweep_config_consistency_constraints_not_mapping",
    )
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
    objective_veto_policy = _objective_veto_policy(
        consistency_policy=consistency_policy,
        template_defaults=family_setup.family_template.default_hard_vetoes,
        trading_day_count=len(replay_setup.window.train_days)
        + len(replay_setup.window.holdout_days),
    )
    return _FrontierPolicies(
        holdout_policy=holdout_policy,
        consistency_policy=consistency_policy,
        order_type_ablation_policy=order_type_ablation_policy,
        max_train_screen_worst_day_loss=max_train_screen_worst_day_loss,
        min_train_screen_net_per_day=min_train_screen_net_per_day,
        min_train_screen_active_ratio=min_train_screen_active_ratio,
        objective_veto_policy=objective_veto_policy,
        collect_train_gate_diagnostics=bool(
            getattr(args, "collect_train_gate_diagnostics", False)
        ),
    )


def _load_snapshot_setup(
    args: argparse.Namespace,
    clickhouse_password: str | None,
    replay_setup: _ReplayWindowSetup,
    family_setup: _SweepFamilySetup,
) -> _SnapshotSetup:
    expected_last_trading_day = replay_setup.explicit_expected_last_trading_day or (
        replay_setup.full_window_end
        if str(args.full_window_end_date or "").strip()
        else None
    )
    expected_snapshot_days = _snapshot_expected_days(
        window=replay_setup.window,
        full_window_start=replay_setup.full_window_start,
        full_window_end=replay_setup.full_window_end,
        require_full_window_coverage=bool(
            str(args.full_window_start_date or "").strip()
            or str(args.full_window_end_date or "").strip()
        ),
    )
    cached_rows: list[Any] | None = None
    replay_tape_validation: dict[str, Any] | None = None
    if replay_setup.loaded_replay_tape is not None:
        cached_rows, replay_tape_validation = _load_replay_tape_rows(
            tape_path=Path(replay_setup.replay_tape_path).resolve(),
            manifest_path=replay_setup.replay_tape_manifest_path,
            start_date=replay_setup.full_window_start,
            end_date=replay_setup.full_window_end,
            symbols=family_setup.prefetch_symbols,
            allow_stale_tape=bool(getattr(args, "allow_stale_tape", False)),
            tape=replay_setup.loaded_replay_tape,
        )
        dataset_snapshot_receipt = _build_replay_tape_snapshot_receipt(
            validation=replay_tape_validation,
            rows=cached_rows,
            start_day=replay_setup.full_window_start,
            end_day=replay_setup.full_window_end,
            expected_last_trading_day=expected_last_trading_day
            or replay_setup.full_window_end,
            expected_trading_days=expected_snapshot_days,
            allow_stale_tape=bool(args.allow_stale_tape),
        )
    else:
        dataset_snapshot_receipt = build_dataset_snapshot_receipt(
            clickhouse_http_url=str(args.clickhouse_http_url),
            clickhouse_username=(str(args.clickhouse_username).strip() or None),
            clickhouse_password=clickhouse_password,
            start_day=replay_setup.full_window_start,
            end_day=replay_setup.full_window_end,
            expected_last_trading_day=expected_last_trading_day,
            expected_trading_days=expected_snapshot_days,
            allow_stale_tape=bool(args.allow_stale_tape),
        )
    return _SnapshotSetup(
        dataset_snapshot_receipt=dataset_snapshot_receipt,
        cached_rows=cached_rows,
        replay_tape_validation=replay_tape_validation,
    )


def load_frontier_run_setup(args: argparse.Namespace) -> FrontierRunSetup:
    clickhouse_preflight_failure = _clickhouse_endpoint_preflight_failure(args)
    if clickhouse_preflight_failure:
        raise RuntimeError(clickhouse_preflight_failure)

    clickhouse_password = _resolved_clickhouse_password(args)
    sweep_config = _load_sweep_config(args.sweep_config.resolve())
    replay_setup = _load_replay_window_setup(args, clickhouse_password)
    family_setup = _load_sweep_family_setup(args, sweep_config)
    policies = _load_frontier_policies(
        args,
        sweep_config,
        family_setup,
        replay_setup,
    )
    snapshot = _load_snapshot_setup(
        args,
        clickhouse_password,
        replay_setup,
        family_setup,
    )
    ensure_fresh_snapshot(
        snapshot.dataset_snapshot_receipt,
        allow_stale_tape=bool(args.allow_stale_tape),
    )
    return FrontierRunSetup(
        clickhouse_password=clickhouse_password,
        sweep_config=cast(Mapping[str, Any], sweep_config),
        window=replay_setup.window,
        full_window_start=replay_setup.full_window_start,
        full_window_end=replay_setup.full_window_end,
        base_configmap=family_setup.base_configmap,
        family=family_setup.family,
        strategy_name=family_setup.strategy_name,
        family_template=family_setup.family_template,
        disable_other_strategies=family_setup.disable_other_strategies,
        parameter_grid=family_setup.parameter_grid,
        override_candidates=family_setup.override_candidates,
        seed_candidates=family_setup.seed_candidates,
        prefetch_symbols=family_setup.prefetch_symbols,
        dataset_snapshot_receipt=snapshot.dataset_snapshot_receipt,
        cached_rows=snapshot.cached_rows,
        replay_tape_validation=snapshot.replay_tape_validation,
        holdout_policy=policies.holdout_policy,
        consistency_policy=policies.consistency_policy,
        order_type_ablation_policy=policies.order_type_ablation_policy,
        max_train_screen_worst_day_loss=policies.max_train_screen_worst_day_loss,
        min_train_screen_net_per_day=policies.min_train_screen_net_per_day,
        min_train_screen_active_ratio=policies.min_train_screen_active_ratio,
        symbols=family_setup.symbols,
        objective_veto_policy=policies.objective_veto_policy,
        collect_train_gate_diagnostics=policies.collect_train_gate_diagnostics,
    )


__all__ = ["FrontierRunSetup", "load_frontier_run_setup"]
