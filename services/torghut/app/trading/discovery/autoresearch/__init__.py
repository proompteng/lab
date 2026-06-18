"""Public exports for app.trading.discovery.autoresearch."""

from __future__ import annotations
from . import shared_context as _shared_context
from .load_strategy_autoresearch_program import (
    StrategyObjective,
    SnapshotPolicy,
    ProposalModelPolicy,
    ReplayBudget,
    RuntimeClosurePolicy,
    ResearchClaim,
    ResearchSource,
    MutationSpace,
    FamilyAutoresearchPlan,
    StrategyAutoresearchProgram,
    load_strategy_autoresearch_program,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    stable_payload_hash,
    run_id,
)

_decimal_from_candidate = getattr(_shared_context, "_decimal_from_candidate")
_format_numeric_like = getattr(_shared_context, "_format_numeric_like")
_load_mutation_space = getattr(_shared_context, "_load_mutation_space")
_resolve_seed_sweep_path = getattr(_shared_context, "_resolve_seed_sweep_path")
_stable_value_key = getattr(_shared_context, "_stable_value_key")
_string_list = getattr(_shared_context, "_string_list")

__all__ = [
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
    "load_strategy_autoresearch_program",
    "apply_program_objective",
    "build_mutated_sweep_config",
    "candidate_meets_objective",
    "stable_payload_hash",
    "run_id",
    "_decimal_from_candidate",
    "_format_numeric_like",
    "_load_mutation_space",
    "_resolve_seed_sweep_path",
    "_stable_value_key",
    "_string_list",
]
