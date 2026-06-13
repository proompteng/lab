"""Public exports for app.trading.discovery.autoresearch_modules."""

from __future__ import annotations

from importlib import import_module

_impl = import_module(f"{__name__}.part_02_load_strategy_autoresearch_program")

_SCHEMA_VERSION = getattr(_impl, "_SCHEMA_VERSION")
_mapping = getattr(_impl, "_mapping")
_string = getattr(_impl, "_string")
_string_list = getattr(_impl, "_string_list")
_coerce_decimal = getattr(_impl, "_coerce_decimal")
_json_clone = getattr(_impl, "_json_clone")
_stable_value_key = getattr(_impl, "_stable_value_key")
_dedupe_preserve_order = getattr(_impl, "_dedupe_preserve_order")
_current_grid_value = getattr(_impl, "_current_grid_value")
_decimal_from_candidate = getattr(_impl, "_decimal_from_candidate")
_format_numeric_like = getattr(_impl, "_format_numeric_like")
StrategyObjective = getattr(_impl, "StrategyObjective")
SnapshotPolicy = getattr(_impl, "SnapshotPolicy")
ProposalModelPolicy = getattr(_impl, "ProposalModelPolicy")
ReplayBudget = getattr(_impl, "ReplayBudget")
RuntimeClosurePolicy = getattr(_impl, "RuntimeClosurePolicy")
ResearchClaim = getattr(_impl, "ResearchClaim")
ResearchSource = getattr(_impl, "ResearchSource")
MutationSpace = getattr(_impl, "MutationSpace")
FamilyAutoresearchPlan = getattr(_impl, "FamilyAutoresearchPlan")
StrategyAutoresearchProgram = getattr(_impl, "StrategyAutoresearchProgram")
_load_mutation_space = getattr(_impl, "_load_mutation_space")
_resolve_program_path = getattr(_impl, "_resolve_program_path")
_resolve_seed_sweep_path = getattr(_impl, "_resolve_seed_sweep_path")
_load_runtime_closure_policy = getattr(_impl, "_load_runtime_closure_policy")
load_strategy_autoresearch_program = getattr(
    _impl, "load_strategy_autoresearch_program"
)
apply_program_objective = getattr(_impl, "apply_program_objective")
_resolved_mutation_values = getattr(_impl, "_resolved_mutation_values")
build_mutated_sweep_config = getattr(_impl, "build_mutated_sweep_config")
_objective_start_equity = getattr(_impl, "_objective_start_equity")
_objective_total_net_pnl = getattr(_impl, "_objective_total_net_pnl")
_objective_drawdown_passes = getattr(_impl, "_objective_drawdown_passes")
candidate_meets_objective = getattr(_impl, "candidate_meets_objective")
stable_payload_hash = getattr(_impl, "stable_payload_hash")
run_id = getattr(_impl, "run_id")

__all__ = [
    "_SCHEMA_VERSION",
    "_mapping",
    "_string",
    "_string_list",
    "_coerce_decimal",
    "_json_clone",
    "_stable_value_key",
    "_dedupe_preserve_order",
    "_current_grid_value",
    "_decimal_from_candidate",
    "_format_numeric_like",
    "StrategyObjective",
    "SnapshotPolicy",
    "ProposalModelPolicy",
    "ReplayBudget",
    "RuntimeClosurePolicy",
    "ResearchClaim",
    "ResearchSource",
    "MutationSpace",
    "FamilyAutoresearchPlan",
    "StrategyAutoresearchProgram",
    "_load_mutation_space",
    "_resolve_program_path",
    "_resolve_seed_sweep_path",
    "_load_runtime_closure_policy",
    "load_strategy_autoresearch_program",
    "apply_program_objective",
    "_resolved_mutation_values",
    "build_mutated_sweep_config",
    "_objective_start_equity",
    "_objective_total_net_pnl",
    "_objective_drawdown_passes",
    "candidate_meets_objective",
    "stable_payload_hash",
    "run_id",
]

del _impl
