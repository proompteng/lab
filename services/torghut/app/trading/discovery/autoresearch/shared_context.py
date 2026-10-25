"""Autoresearch-style outer loop helpers for strategy discovery."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

from app.trading.discovery.family_templates import (
    FamilyTemplate,
    family_template_dir,
    load_family_template,
)


SCHEMA_VERSION = "torghut.strategy-autoresearch.v1"


def mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping_value = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping_value.items()}


def string(value: Any) -> str:
    return str(value or "").strip()


def string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    raw_values = cast(list[Any], value)
    resolved: list[str] = []
    for item in raw_values:
        normalized = string(item)
        if normalized:
            resolved.append(normalized)
    return tuple(resolved)


def coerce_decimal(value: Any, *, default: str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int | float):
        return Decimal(str(value))
    text = string(value)
    return Decimal(text or default)


def json_clone(payload: Mapping[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(payload))


def stable_value_key(value: Any) -> str:
    if isinstance(value, list | dict):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def dedupe_preserve_order(values: list[Any]) -> list[Any]:
    seen: set[str] = set()
    ordered: list[Any] = []
    for value in values:
        stable_key = stable_value_key(value)
        if stable_key in seen:
            continue
        seen.add(stable_key)
        ordered.append(value)
    return ordered


def current_grid_value(
    *,
    current_values: Mapping[str, Any],
    sweep_grid: Mapping[str, Any],
    key: str,
) -> Any:
    if key in current_values:
        return current_values[key]
    raw_grid = sweep_grid.get(key)
    if isinstance(raw_grid, list) and raw_grid:
        return cast(list[Any], raw_grid)[0]
    return None


def decimal_from_candidate(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return coerce_decimal(value, default="")
    except (InvalidOperation, ValueError):
        return None


def format_numeric_like(value: Decimal, *, current_value: Any) -> str:
    current_text = string(current_value)
    if current_text and "." not in current_text:
        return str(int(value))
    if current_text and "." in current_text:
        decimals = len(current_text.split(".", 1)[1])
        return f"{value:.{decimals}f}"
    text = format(value, "f")
    if "." in text:
        return text.rstrip("0").rstrip(".") or "0"
    return text


@dataclass(frozen=True)
class StrategyObjective:
    target_net_pnl_per_day: Decimal
    min_active_day_ratio: Decimal
    min_positive_day_ratio: Decimal
    min_daily_notional: Decimal
    max_best_day_share: Decimal
    max_worst_day_loss: Decimal
    max_drawdown: Decimal
    require_every_day_active: bool
    min_regime_slice_pass_rate: Decimal
    stop_when_objective_met: bool
    min_observed_trading_days: int = 0
    min_daily_net_pnl: Decimal = Decimal("0")
    min_profit_factor: Decimal = Decimal("1.50")
    max_gross_exposure_pct_equity: Decimal = Decimal("999999999")
    min_cash: Decimal = Decimal("-999999999")
    default_start_equity: Decimal = Decimal("31590.02")
    max_worst_day_loss_pct_equity: Decimal = Decimal("0.05")
    max_drawdown_pct_equity: Decimal = Decimal("0.08")
    extended_max_worst_day_loss_pct_equity: Decimal = Decimal("0.08")
    extended_max_drawdown_pct_equity: Decimal = Decimal("0.12")
    min_total_net_pnl_to_drawdown_ratio: Decimal = Decimal("3.00")
    require_double_oos: bool = True
    min_double_oos_independent_window_count: int = 2
    min_double_oos_pass_rate: Decimal = Decimal("1.00")
    require_double_oos_cost_shock_above_target: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "target_net_pnl_per_day": str(self.target_net_pnl_per_day),
            "min_daily_net_pnl": str(self.min_daily_net_pnl),
            "min_active_day_ratio": str(self.min_active_day_ratio),
            "min_positive_day_ratio": str(self.min_positive_day_ratio),
            "min_profit_factor": str(self.min_profit_factor),
            "min_daily_notional": str(self.min_daily_notional),
            "max_best_day_share": str(self.max_best_day_share),
            "max_worst_day_loss": str(self.max_worst_day_loss),
            "max_drawdown": str(self.max_drawdown),
            "require_every_day_active": self.require_every_day_active,
            "min_regime_slice_pass_rate": str(self.min_regime_slice_pass_rate),
            "stop_when_objective_met": self.stop_when_objective_met,
            "min_observed_trading_days": self.min_observed_trading_days,
            "max_gross_exposure_pct_equity": str(self.max_gross_exposure_pct_equity),
            "min_cash": str(self.min_cash),
            "default_start_equity": str(self.default_start_equity),
            "max_worst_day_loss_pct_equity": str(self.max_worst_day_loss_pct_equity),
            "max_drawdown_pct_equity": str(self.max_drawdown_pct_equity),
            "extended_max_worst_day_loss_pct_equity": str(
                self.extended_max_worst_day_loss_pct_equity
            ),
            "extended_max_drawdown_pct_equity": str(
                self.extended_max_drawdown_pct_equity
            ),
            "min_total_net_pnl_to_drawdown_ratio": str(
                self.min_total_net_pnl_to_drawdown_ratio
            ),
            "require_double_oos": self.require_double_oos,
            "min_double_oos_independent_window_count": self.min_double_oos_independent_window_count,
            "min_double_oos_pass_rate": str(self.min_double_oos_pass_rate),
            "require_double_oos_cost_shock_above_target": self.require_double_oos_cost_shock_above_target,
        }


@dataclass(frozen=True)
class SnapshotPolicy:
    bar_interval: str
    feature_set_id: str
    quote_quality_policy_id: str
    symbol_policy: str
    allow_prior_day_features: bool
    allow_cross_sectional_features: bool

    def to_payload(self) -> dict[str, Any]:
        return {
            "bar_interval": self.bar_interval,
            "feature_set_id": self.feature_set_id,
            "quote_quality_policy_id": self.quote_quality_policy_id,
            "symbol_policy": self.symbol_policy,
            "allow_prior_day_features": self.allow_prior_day_features,
            "allow_cross_sectional_features": self.allow_cross_sectional_features,
        }


@dataclass(frozen=True)
class ProposalModelPolicy:
    enabled: bool
    mode: str
    backend_preference: str
    top_k: int
    exploration_slots: int
    minimum_history_rows: int

    def to_payload(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "backend_preference": self.backend_preference,
            "top_k": self.top_k,
            "exploration_slots": self.exploration_slots,
            "minimum_history_rows": self.minimum_history_rows,
        }


@dataclass(frozen=True)
class ReplayBudget:
    max_candidates_per_round: int
    exploration_slots: int
    max_candidates_per_frontier_run: int
    staged_train_screen_multiplier: int = 1

    def to_payload(self) -> dict[str, Any]:
        return {
            "max_candidates_per_round": self.max_candidates_per_round,
            "exploration_slots": self.exploration_slots,
            "max_candidates_per_frontier_run": self.max_candidates_per_frontier_run,
            "staged_train_screen_multiplier": self.staged_train_screen_multiplier,
        }


@dataclass(frozen=True)
class RuntimeClosurePolicy:
    enabled: bool
    execute_parity_replay: bool
    execute_approval_replay: bool
    parity_window: str
    approval_window: str
    shadow_validation_mode: str
    promotion_target: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "execute_parity_replay": self.execute_parity_replay,
            "execute_approval_replay": self.execute_approval_replay,
            "parity_window": self.parity_window,
            "approval_window": self.approval_window,
            "shadow_validation_mode": self.shadow_validation_mode,
            "promotion_target": self.promotion_target,
        }


@dataclass(frozen=True)
class ResearchClaim:
    claim_id: str
    summary: str
    implication: str
    claim_text: str = ""
    claim_type: str = ""
    data_requirements: tuple[str, ...] = ()
    asset_scope: str = ""
    horizon_scope: str = ""
    expected_direction: str = ""

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "claim_id": self.claim_id,
            "summary": self.summary,
            "implication": self.implication,
        }
        if self.claim_text:
            payload["claim_text"] = self.claim_text
        if self.claim_type:
            payload["claim_type"] = self.claim_type
        if self.data_requirements:
            payload["data_requirements"] = list(self.data_requirements)
        if self.asset_scope:
            payload["asset_scope"] = self.asset_scope
        if self.horizon_scope:
            payload["horizon_scope"] = self.horizon_scope
        if self.expected_direction:
            payload["expected_direction"] = self.expected_direction
        return payload


@dataclass(frozen=True)
class ResearchSource:
    source_id: str
    title: str
    url: str
    published_at: str
    claims: tuple[ResearchClaim, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "title": self.title,
            "url": self.url,
            "published_at": self.published_at,
            "claims": [item.to_payload() for item in self.claims],
        }


@dataclass(frozen=True)
class MutationSpace:
    mode: str
    values: tuple[str, ...] = ()
    deltas: tuple[Decimal, ...] = ()
    minimum: Decimal | None = None
    maximum: Decimal | None = None
    include_current: bool = True

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "mode": self.mode,
            "include_current": self.include_current,
        }
        if self.values:
            payload["values"] = list(self.values)
        if self.deltas:
            payload["deltas"] = [str(item) for item in self.deltas]
        if self.minimum is not None:
            payload["minimum"] = str(self.minimum)
        if self.maximum is not None:
            payload["maximum"] = str(self.maximum)
        return payload


@dataclass(frozen=True)
class FamilyAutoresearchPlan:
    family_template: FamilyTemplate
    seed_sweep_config: Path
    max_iterations: int
    keep_top_candidates: int
    frontier_top_n: int
    force_keep_top_candidate_if_all_vetoed: bool
    symbol_prune_iterations: int
    symbol_prune_candidates: int
    symbol_prune_min_universe_size: int
    loss_repair_iterations: int
    loss_repair_candidates: int
    consistency_repair_iterations: int
    consistency_repair_candidates: int
    parameter_mutations: Mapping[str, MutationSpace]
    strategy_override_mutations: Mapping[str, MutationSpace]

    def to_payload(self) -> dict[str, Any]:
        return {
            "family_template_id": self.family_template.family_id,
            "seed_sweep_config": str(self.seed_sweep_config),
            "max_iterations": self.max_iterations,
            "keep_top_candidates": self.keep_top_candidates,
            "frontier_top_n": self.frontier_top_n,
            "force_keep_top_candidate_if_all_vetoed": self.force_keep_top_candidate_if_all_vetoed,
            "symbol_prune_iterations": self.symbol_prune_iterations,
            "symbol_prune_candidates": self.symbol_prune_candidates,
            "symbol_prune_min_universe_size": self.symbol_prune_min_universe_size,
            "loss_repair_iterations": self.loss_repair_iterations,
            "loss_repair_candidates": self.loss_repair_candidates,
            "consistency_repair_iterations": self.consistency_repair_iterations,
            "consistency_repair_candidates": self.consistency_repair_candidates,
            "parameter_mutations": {
                key: value.to_payload()
                for key, value in self.parameter_mutations.items()
            },
            "strategy_override_mutations": {
                key: value.to_payload()
                for key, value in self.strategy_override_mutations.items()
            },
        }


@dataclass(frozen=True)
class StrategyAutoresearchProgram:
    program_id: str
    description: str
    objective: StrategyObjective
    snapshot_policy: SnapshotPolicy
    forbidden_mutations: tuple[str, ...]
    proposal_model_policy: ProposalModelPolicy
    replay_budget: ReplayBudget
    runtime_closure_policy: RuntimeClosurePolicy
    parity_requirements: tuple[str, ...]
    promotion_policy: str
    ledger_policy: Mapping[str, Any]
    research_sources: tuple[ResearchSource, ...]
    families: tuple[FamilyAutoresearchPlan, ...]
    schema_version: str = SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "program_id": self.program_id,
            "description": self.description,
            "objective": self.objective.to_payload(),
            "snapshot_policy": self.snapshot_policy.to_payload(),
            "forbidden_mutations": list(self.forbidden_mutations),
            "proposal_model_policy": self.proposal_model_policy.to_payload(),
            "replay_budget": self.replay_budget.to_payload(),
            "runtime_closure_policy": self.runtime_closure_policy.to_payload(),
            "parity_requirements": list(self.parity_requirements),
            "promotion_policy": self.promotion_policy,
            "ledger_policy": dict(self.ledger_policy),
            "research_sources": [item.to_payload() for item in self.research_sources],
            "families": [item.to_payload() for item in self.families],
        }


def load_mutation_space(payload: Mapping[str, Any]) -> MutationSpace:
    mode = string(payload.get("mode"))
    if mode not in {"explicit_values", "numeric_step", "allowed_normalizations"}:
        raise ValueError(f"autoresearch_mutation_mode_invalid:{mode or 'missing'}")
    values = string_list(payload.get("values"))
    delta_values: tuple[Decimal, ...] = ()
    raw_deltas = payload.get("deltas")
    if isinstance(raw_deltas, list):
        raw_delta_values = cast(list[Any], raw_deltas)
        delta_values = tuple(
            coerce_decimal(item, default="0") for item in raw_delta_values
        )
    minimum = None
    if payload.get("minimum") is not None:
        minimum = coerce_decimal(payload.get("minimum"), default="0")
    maximum = None
    if payload.get("maximum") is not None:
        maximum = coerce_decimal(payload.get("maximum"), default="0")
    return MutationSpace(
        mode=mode,
        values=values,
        deltas=delta_values,
        minimum=minimum,
        maximum=maximum,
        include_current=bool(payload.get("include_current", True)),
    )


def resolve_program_path(path: Path) -> Path:
    return path.resolve()


def resolve_seed_sweep_path(*, program_path: Path, raw_path: str) -> Path:
    candidate = Path(raw_path)
    if candidate.is_absolute():
        return candidate
    return (program_path.parent / candidate).resolve()


def load_runtime_closure_policy(payload: Mapping[str, Any]) -> RuntimeClosurePolicy:
    parity_window = string(payload.get("parity_window")) or "full_window"
    approval_window = string(payload.get("approval_window")) or "holdout"
    if parity_window not in {"train", "holdout", "full_window"}:
        raise ValueError(
            f"autoresearch_runtime_closure_parity_window_invalid:{parity_window}"
        )
    if approval_window not in {"train", "holdout", "full_window"}:
        raise ValueError(
            f"autoresearch_runtime_closure_approval_window_invalid:{approval_window}"
        )
    shadow_validation_mode = (
        string(payload.get("shadow_validation_mode")) or "require_live_evidence"
    )
    if shadow_validation_mode not in {"require_live_evidence", "skip"}:
        raise ValueError(
            f"autoresearch_runtime_closure_shadow_validation_mode_invalid:{shadow_validation_mode}"
        )
    promotion_target = string(payload.get("promotion_target")) or "shadow"
    if promotion_target not in {"shadow", "paper", "live"}:
        raise ValueError(
            f"autoresearch_runtime_closure_promotion_target_invalid:{promotion_target}"
        )
    return RuntimeClosurePolicy(
        enabled=bool(payload.get("enabled", False)),
        execute_parity_replay=bool(payload.get("execute_parity_replay", True)),
        execute_approval_replay=bool(payload.get("execute_approval_replay", True)),
        parity_window=parity_window,
        approval_window=approval_window,
        shadow_validation_mode=shadow_validation_mode,
        promotion_target=promotion_target,
    )


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "Decimal",
    "FamilyAutoresearchPlan",
    "FamilyTemplate",
    "InvalidOperation",
    "Mapping",
    "MutationSpace",
    "Path",
    "ProposalModelPolicy",
    "ROUND_CEILING",
    "ReplayBudget",
    "ResearchClaim",
    "ResearchSource",
    "RuntimeClosurePolicy",
    "SCHEMA_VERSION",
    "SnapshotPolicy",
    "StrategyAutoresearchProgram",
    "StrategyObjective",
    "UTC",
    "SCHEMA_VERSION",
    "coerce_decimal",
    "current_grid_value",
    "decimal_from_candidate",
    "dedupe_preserve_order",
    "format_numeric_like",
    "json_clone",
    "load_mutation_space",
    "load_runtime_closure_policy",
    "mapping",
    "resolve_program_path",
    "resolve_seed_sweep_path",
    "stable_value_key",
    "string",
    "string_list",
    "annotations",
    "cast",
    "coerce_decimal",
    "current_grid_value",
    "dataclass",
    "datetime",
    "decimal_from_candidate",
    "dedupe_preserve_order",
    "family_template_dir",
    "format_numeric_like",
    "hashlib",
    "json",
    "json_clone",
    "load_family_template",
    "load_mutation_space",
    "load_runtime_closure_policy",
    "mapping",
    "resolve_program_path",
    "resolve_seed_sweep_path",
    "stable_value_key",
    "string",
    "string_list",
    "yaml",
)
