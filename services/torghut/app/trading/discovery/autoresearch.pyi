from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
# ruff: noqa: F401,F811,F821
from typing import Any
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

_SCHEMA_VERSION: Any

def _mapping(*args: Any, **kwargs: Any) -> Any: ...
def _string(*args: Any, **kwargs: Any) -> Any: ...
def _string_list(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_decimal(*args: Any, **kwargs: Any) -> Any: ...
def _json_clone(*args: Any, **kwargs: Any) -> Any: ...
def _stable_value_key(*args: Any, **kwargs: Any) -> Any: ...
def _dedupe_preserve_order(*args: Any, **kwargs: Any) -> Any: ...
def _current_grid_value(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_from_candidate(*args: Any, **kwargs: Any) -> Any: ...
def _format_numeric_like(*args: Any, **kwargs: Any) -> Any: ...

class StrategyObjective:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    min_observed_trading_days: int
    min_daily_net_pnl: Decimal
    min_profit_factor: Decimal
    max_gross_exposure_pct_equity: Decimal
    min_cash: Decimal
    default_start_equity: Decimal
    max_worst_day_loss_pct_equity: Decimal
    max_drawdown_pct_equity: Decimal
    extended_max_worst_day_loss_pct_equity: Decimal
    extended_max_drawdown_pct_equity: Decimal
    min_total_net_pnl_to_drawdown_ratio: Decimal
    require_double_oos: bool
    min_double_oos_independent_window_count: int
    min_double_oos_pass_rate: Decimal
    require_double_oos_cost_shock_above_target: bool
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class SnapshotPolicy:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    bar_interval: str
    feature_set_id: str
    quote_quality_policy_id: str
    symbol_policy: str
    allow_prior_day_features: bool
    allow_cross_sectional_features: bool
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class ProposalModelPolicy:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    enabled: bool
    mode: str
    backend_preference: str
    top_k: int
    exploration_slots: int
    minimum_history_rows: int
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class ReplayBudget:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    max_candidates_per_round: int
    exploration_slots: int
    max_candidates_per_frontier_run: int
    staged_train_screen_multiplier: int
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class RuntimeClosurePolicy:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    enabled: bool
    execute_parity_replay: bool
    execute_approval_replay: bool
    parity_window: str
    approval_window: str
    shadow_validation_mode: str
    promotion_target: str
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class ResearchClaim:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    claim_id: str
    summary: str
    implication: str
    claim_text: str
    claim_type: str
    data_requirements: tuple[str, ...]
    asset_scope: str
    horizon_scope: str
    expected_direction: str
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class ResearchSource:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    source_id: str
    title: str
    url: str
    published_at: str
    claims: tuple[ResearchClaim, ...]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class MutationSpace:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    mode: str
    values: tuple[str, ...]
    deltas: tuple[Decimal, ...]
    minimum: Decimal | None
    maximum: Decimal | None
    include_current: bool
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class FamilyAutoresearchPlan:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class StrategyAutoresearchProgram:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    schema_version: str
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

def _load_mutation_space(*args: Any, **kwargs: Any) -> Any: ...
def _resolve_program_path(*args: Any, **kwargs: Any) -> Any: ...
def _resolve_seed_sweep_path(*args: Any, **kwargs: Any) -> Any: ...
def _load_runtime_closure_policy(*args: Any, **kwargs: Any) -> Any: ...
def load_strategy_autoresearch_program(*args: Any, **kwargs: Any) -> Any: ...
def apply_program_objective(*args: Any, **kwargs: Any) -> Any: ...
def _resolved_mutation_values(*args: Any, **kwargs: Any) -> Any: ...
def build_mutated_sweep_config(*args: Any, **kwargs: Any) -> Any: ...
def _objective_start_equity(*args: Any, **kwargs: Any) -> Any: ...
def _objective_total_net_pnl(*args: Any, **kwargs: Any) -> Any: ...
def _objective_drawdown_passes(*args: Any, **kwargs: Any) -> Any: ...
def candidate_meets_objective(*args: Any, **kwargs: Any) -> Any: ...
def stable_payload_hash(*args: Any, **kwargs: Any) -> Any: ...
def run_id(*args: Any, **kwargs: Any) -> Any: ...
