# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    FamilyAutoresearchPlan,
    MutationSpace,
    ProposalModelPolicy,
    ReplayBudget,
    ResearchClaim,
    ResearchSource,
    RuntimeClosurePolicy,
    SnapshotPolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
    SCHEMA_VERSION as _SCHEMA_VERSION,
    coerce_decimal as _coerce_decimal,
    current_grid_value as _current_grid_value,
    decimal_from_candidate as _decimal_from_candidate,
    dedupe_preserve_order as _dedupe_preserve_order,
    format_numeric_like as _format_numeric_like,
    json_clone as _json_clone,
    load_mutation_space as _load_mutation_space,
    load_runtime_closure_policy as _load_runtime_closure_policy,
    mapping as _mapping,
    resolve_program_path as _resolve_program_path,
    resolve_seed_sweep_path as _resolve_seed_sweep_path,
    stable_value_key as _stable_value_key,
    string as _string,
    string_list as _string_list,
)


@dataclass(frozen=True)
class _MutatedGridResult:
    values: dict[str, Any]
    mutated_keys: list[str]


@dataclass(frozen=True)
class _CandidateObjectiveMetrics:
    scorecard: Mapping[str, Any]
    full_window: Mapping[str, Any]
    net_pnl_per_day: Decimal
    active_day_ratio: Decimal
    positive_day_ratio: Decimal
    avg_daily_notional: Decimal
    best_day_share: Decimal
    worst_day_loss: Decimal
    max_drawdown: Decimal
    regime_slice_pass_rate: Decimal
    max_gross_exposure_pct_equity: Decimal
    min_cash: Decimal
    trading_day_count: int
    active_days: int
    start_equity: Decimal
    total_net_pnl: Decimal
    worst_day_loss_ok: bool
    max_drawdown_ok: bool


def load_strategy_autoresearch_program(
    path: Path,
    *,
    family_dir: Path | None = None,
) -> StrategyAutoresearchProgram:
    program_path = _resolve_program_path(path)
    raw_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
    if not isinstance(raw_payload, Mapping):
        raise ValueError("autoresearch_program_not_mapping")
    payload = cast(Mapping[str, Any], raw_payload)
    schema_version = _string(payload.get("schema_version"))
    if schema_version != _SCHEMA_VERSION:
        raise ValueError(f"autoresearch_program_schema_invalid:{schema_version}")

    objective = _load_strategy_objective(_mapping(payload.get("objective")))
    forbidden_mutations = _string_list(
        payload.get("forbidden_mutations")
        or ["runtime_code_path", "evaluator_logic", "live_strategy_config"]
    )
    parity_requirements = _string_list(
        payload.get("parity_requirements")
        or [
            "checked_in_runtime_family",
            "scheduler_v3_parity_replay",
            "scheduler_v3_approval_replay",
            "live_shadow_validation",
        ]
    )
    return StrategyAutoresearchProgram(
        program_id=_string(payload.get("program_id")) or program_path.stem,
        description=_string(payload.get("description")),
        objective=objective,
        snapshot_policy=_load_snapshot_policy(_mapping(payload.get("snapshot_policy"))),
        forbidden_mutations=forbidden_mutations,
        proposal_model_policy=_load_proposal_model_policy(
            _mapping(payload.get("proposal_model_policy"))
        ),
        replay_budget=_load_replay_budget(_mapping(payload.get("replay_budget"))),
        runtime_closure_policy=_load_runtime_closure_policy(
            _mapping(payload.get("runtime_closure_policy"))
        ),
        parity_requirements=parity_requirements,
        promotion_policy=_string(payload.get("promotion_policy")) or "research_only",
        ledger_policy=_mapping(payload.get("ledger_policy")) or {"append_only": True},
        research_sources=tuple(_load_research_sources(payload)),
        families=tuple(
            _load_family_autoresearch_plans(
                program_path=program_path,
                payload=payload,
                family_dir=family_dir,
            )
        ),
    )


def _load_strategy_objective(objective_payload: Mapping[str, Any]) -> StrategyObjective:
    return StrategyObjective(
        target_net_pnl_per_day=_coerce_decimal(
            objective_payload.get("target_net_pnl_per_day"),
            default="500",
        ),
        min_daily_net_pnl=_coerce_decimal(
            objective_payload.get("min_daily_net_pnl"),
            default="0",
        ),
        min_active_day_ratio=_coerce_decimal(
            objective_payload.get("min_active_day_ratio"),
            default="0.80",
        ),
        min_positive_day_ratio=_coerce_decimal(
            objective_payload.get("min_positive_day_ratio"),
            default="0.55",
        ),
        min_profit_factor=_coerce_decimal(
            objective_payload.get("min_profit_factor"),
            default="1.50",
        ),
        min_daily_notional=_coerce_decimal(
            objective_payload.get("min_daily_notional"),
            default="250000",
        ),
        max_best_day_share=_coerce_decimal(
            objective_payload.get("max_best_day_share"),
            default="0.40",
        ),
        max_worst_day_loss=_coerce_decimal(
            objective_payload.get("max_worst_day_loss"),
            default="500",
        ),
        max_drawdown=_coerce_decimal(
            objective_payload.get("max_drawdown"),
            default="1200",
        ),
        require_every_day_active=bool(
            objective_payload.get("require_every_day_active", False)
        ),
        min_regime_slice_pass_rate=_coerce_decimal(
            objective_payload.get("min_regime_slice_pass_rate"),
            default="0.35",
        ),
        stop_when_objective_met=bool(
            objective_payload.get("stop_when_objective_met", False)
        ),
        min_observed_trading_days=max(
            0,
            int(objective_payload.get("min_observed_trading_days", 0)),
        ),
        max_gross_exposure_pct_equity=_coerce_decimal(
            objective_payload.get("max_gross_exposure_pct_equity"),
            default="999999999",
        ),
        min_cash=_coerce_decimal(
            objective_payload.get("min_cash"),
            default="-999999999",
        ),
        default_start_equity=_coerce_decimal(
            objective_payload.get("default_start_equity"),
            default="31590.02",
        ),
        max_worst_day_loss_pct_equity=_coerce_decimal(
            objective_payload.get("max_worst_day_loss_pct_equity"),
            default="0.05",
        ),
        max_drawdown_pct_equity=_coerce_decimal(
            objective_payload.get("max_drawdown_pct_equity"),
            default="0.08",
        ),
        extended_max_worst_day_loss_pct_equity=_coerce_decimal(
            objective_payload.get("extended_max_worst_day_loss_pct_equity"),
            default="0.08",
        ),
        extended_max_drawdown_pct_equity=_coerce_decimal(
            objective_payload.get("extended_max_drawdown_pct_equity"),
            default="0.12",
        ),
        min_total_net_pnl_to_drawdown_ratio=_coerce_decimal(
            objective_payload.get("min_total_net_pnl_to_drawdown_ratio"),
            default="3.00",
        ),
        require_double_oos=bool(objective_payload.get("require_double_oos", True)),
        min_double_oos_independent_window_count=max(
            0,
            int(objective_payload.get("min_double_oos_independent_window_count", 2)),
        ),
        min_double_oos_pass_rate=_coerce_decimal(
            objective_payload.get("min_double_oos_pass_rate"),
            default="1.00",
        ),
        require_double_oos_cost_shock_above_target=bool(
            objective_payload.get("require_double_oos_cost_shock_above_target", True)
        ),
    )


def _load_snapshot_policy(snapshot_policy_payload: Mapping[str, Any]) -> SnapshotPolicy:
    return SnapshotPolicy(
        bar_interval=_string(snapshot_policy_payload.get("bar_interval")) or "PT1S",
        feature_set_id=_string(snapshot_policy_payload.get("feature_set_id"))
        or "torghut.mlx-autoresearch.v1",
        quote_quality_policy_id=_string(
            snapshot_policy_payload.get("quote_quality_policy_id")
        )
        or "scheduler_v3_default",
        symbol_policy=_string(snapshot_policy_payload.get("symbol_policy"))
        or "args_or_sweep",
        allow_prior_day_features=bool(
            snapshot_policy_payload.get("allow_prior_day_features", True)
        ),
        allow_cross_sectional_features=bool(
            snapshot_policy_payload.get("allow_cross_sectional_features", True)
        ),
    )


def _load_proposal_model_policy(
    proposal_model_payload: Mapping[str, Any],
) -> ProposalModelPolicy:
    return ProposalModelPolicy(
        enabled=bool(proposal_model_payload.get("enabled", True)),
        mode=_string(proposal_model_payload.get("mode")) or "ranking_only",
        backend_preference=_string(proposal_model_payload.get("backend_preference"))
        or "mlx",
        top_k=max(1, int(proposal_model_payload.get("top_k", 4))),
        exploration_slots=max(
            0, int(proposal_model_payload.get("exploration_slots", 1))
        ),
        minimum_history_rows=max(
            0, int(proposal_model_payload.get("minimum_history_rows", 3))
        ),
    )


def _load_replay_budget(replay_budget_payload: Mapping[str, Any]) -> ReplayBudget:
    return ReplayBudget(
        max_candidates_per_round=max(
            1, int(replay_budget_payload.get("max_candidates_per_round", 8))
        ),
        exploration_slots=max(
            0, int(replay_budget_payload.get("exploration_slots", 1))
        ),
        max_candidates_per_frontier_run=max(
            0,
            int(replay_budget_payload.get("max_candidates_per_frontier_run", 96)),
        ),
        staged_train_screen_multiplier=max(
            1,
            int(replay_budget_payload.get("staged_train_screen_multiplier", 1)),
        ),
    )


def _load_research_sources(payload: Mapping[str, Any]) -> list[ResearchSource]:
    research_sources: list[ResearchSource] = []
    raw_sources = payload.get("research_sources")
    if isinstance(raw_sources, list):
        raw_source_values = cast(list[Any], raw_sources)
        for raw_source in raw_source_values:
            if not isinstance(raw_source, Mapping):
                continue
            source_payload = cast(Mapping[str, Any], raw_source)
            source_id = _string(source_payload.get("source_id"))
            if not source_id:
                continue
            research_sources.append(
                ResearchSource(
                    source_id=source_id,
                    title=_string(source_payload.get("title")),
                    url=_string(source_payload.get("url")),
                    published_at=_string(source_payload.get("published_at")),
                    claims=tuple(_load_research_claims(source_payload)),
                )
            )
    return research_sources


def _load_research_claims(source_payload: Mapping[str, Any]) -> list[ResearchClaim]:
    claims: list[ResearchClaim] = []
    raw_claims = source_payload.get("claims")
    if not isinstance(raw_claims, list):
        return claims
    for raw_claim in cast(list[Any], raw_claims):
        if not isinstance(raw_claim, Mapping):
            continue
        claim = _research_claim_from_payload(cast(Mapping[str, Any], raw_claim))
        if claim is not None:
            claims.append(claim)
    return claims


def _research_claim_from_payload(
    claim_payload: Mapping[str, Any],
) -> ResearchClaim | None:
    claim_id = _string(claim_payload.get("claim_id"))
    if not claim_id:
        return None
    return ResearchClaim(
        claim_id=claim_id,
        summary=_string(claim_payload.get("summary")),
        implication=_string(claim_payload.get("implication")),
        claim_text=_string(claim_payload.get("claim_text")),
        claim_type=_string(claim_payload.get("claim_type")),
        data_requirements=_string_list(claim_payload.get("data_requirements")),
        asset_scope=_string(claim_payload.get("asset_scope")),
        horizon_scope=_string(claim_payload.get("horizon_scope")),
        expected_direction=_string(claim_payload.get("expected_direction")),
    )


def _load_family_autoresearch_plans(
    *,
    program_path: Path,
    payload: Mapping[str, Any],
    family_dir: Path | None,
) -> list[FamilyAutoresearchPlan]:
    resolved_family_dir = family_template_dir(family_dir)
    family_plans: list[FamilyAutoresearchPlan] = []
    raw_families = payload.get("families")
    if not isinstance(raw_families, list) or not raw_families:
        raise ValueError("autoresearch_program_missing_families")
    raw_family_values = cast(list[Any], raw_families)
    for raw_family in raw_family_values:
        if not isinstance(raw_family, Mapping):
            continue
        family_plans.append(
            _load_family_autoresearch_plan(
                program_path=program_path,
                resolved_family_dir=resolved_family_dir,
                family_payload=cast(Mapping[str, Any], raw_family),
            )
        )
    return family_plans


def _load_family_autoresearch_plan(
    *,
    program_path: Path,
    resolved_family_dir: Path,
    family_payload: Mapping[str, Any],
) -> FamilyAutoresearchPlan:
    template_id = _string(family_payload.get("family_template_id"))
    if not template_id:
        raise ValueError("autoresearch_family_template_missing")
    template = load_family_template(template_id, directory=resolved_family_dir)
    return FamilyAutoresearchPlan(
        family_template=template,
        seed_sweep_config=_resolve_seed_sweep_path(
            program_path=program_path,
            raw_path=_string(family_payload.get("seed_sweep_config")),
        ),
        max_iterations=max(1, int(family_payload.get("max_iterations", 2))),
        keep_top_candidates=max(1, int(family_payload.get("keep_top_candidates", 1))),
        frontier_top_n=max(1, int(family_payload.get("frontier_top_n", 5))),
        force_keep_top_candidate_if_all_vetoed=bool(
            family_payload.get("force_keep_top_candidate_if_all_vetoed", True)
        ),
        symbol_prune_iterations=max(
            0, int(family_payload.get("symbol_prune_iterations", 0))
        ),
        symbol_prune_candidates=max(
            1, int(family_payload.get("symbol_prune_candidates", 1))
        ),
        symbol_prune_min_universe_size=max(
            1, int(family_payload.get("symbol_prune_min_universe_size", 2))
        ),
        loss_repair_iterations=max(
            0, int(family_payload.get("loss_repair_iterations", 0))
        ),
        loss_repair_candidates=max(
            1, int(family_payload.get("loss_repair_candidates", 1))
        ),
        consistency_repair_iterations=max(
            0, int(family_payload.get("consistency_repair_iterations", 0))
        ),
        consistency_repair_candidates=max(
            1, int(family_payload.get("consistency_repair_candidates", 2))
        ),
        parameter_mutations=_load_mutation_spaces(
            _mapping(family_payload.get("parameter_mutations"))
        ),
        strategy_override_mutations=_load_mutation_spaces(
            _mapping(family_payload.get("strategy_override_mutations"))
        ),
    )


def _load_mutation_spaces(
    mutation_payloads: Mapping[str, Any],
) -> dict[str, MutationSpace]:
    return {
        key: _load_mutation_space(_mapping(value))
        for key, value in mutation_payloads.items()
    }


def apply_program_objective(
    *,
    sweep_config: Mapping[str, Any],
    objective: StrategyObjective,
    holdout_day_count: int,
    full_window_day_count: int | None = None,
) -> dict[str, Any]:
    payload = _json_clone(sweep_config)
    constraints = _mapping(payload.get("constraints"))
    consistency = _mapping(payload.get("consistency_constraints"))
    min_holdout_active_days = max(
        1,
        int(
            (
                objective.min_active_day_ratio * Decimal(max(1, holdout_day_count))
            ).to_integral_value(rounding=ROUND_CEILING)
        ),
    )
    constraints["holdout_target_net_per_day"] = str(objective.target_net_pnl_per_day)
    constraints["min_active_holdout_days"] = min_holdout_active_days
    consistency["target_net_per_day"] = str(objective.target_net_pnl_per_day)
    consistency["min_daily_net_pnl"] = str(objective.min_daily_net_pnl)
    consistency["min_active_ratio"] = str(objective.min_active_day_ratio)
    consistency["max_worst_day_loss"] = str(objective.max_worst_day_loss)
    consistency["max_drawdown"] = str(objective.max_drawdown)
    consistency["max_best_day_share_of_total_pnl"] = str(objective.max_best_day_share)
    consistency["min_avg_filled_notional_per_day"] = str(objective.min_daily_notional)
    if objective.min_observed_trading_days > 0:
        consistency["min_window_weekday_count"] = max(
            int(
                _coerce_decimal(
                    consistency.get("min_window_weekday_count"), default="0"
                ).to_integral_value(rounding=ROUND_CEILING)
            ),
            int(objective.min_observed_trading_days),
        )
    if full_window_day_count is not None:
        total_days = max(1, int(full_window_day_count))
        consistency["min_active_days"] = max(
            1,
            int(
                (
                    objective.min_active_day_ratio * Decimal(total_days)
                ).to_integral_value(rounding=ROUND_CEILING)
            ),
        )
        consistency["min_positive_days"] = max(
            1,
            int(
                (
                    objective.min_positive_day_ratio * Decimal(total_days)
                ).to_integral_value(rounding=ROUND_CEILING)
            ),
        )
    if objective.min_active_day_ratio > 0:
        consistency["min_avg_filled_notional_per_active_day"] = str(
            (objective.min_daily_notional / objective.min_active_day_ratio).quantize(
                Decimal("1")
            )
        )
    consistency["require_every_day_active"] = bool(objective.require_every_day_active)
    consistency["min_regime_slice_pass_rate"] = str(
        objective.min_regime_slice_pass_rate
    )
    consistency["max_gross_exposure_pct_equity"] = str(
        objective.max_gross_exposure_pct_equity
    )
    consistency["min_cash"] = str(objective.min_cash)
    consistency["default_start_equity"] = str(objective.default_start_equity)
    consistency["max_worst_day_loss_pct_equity"] = str(
        objective.max_worst_day_loss_pct_equity
    )
    consistency["max_drawdown_pct_equity"] = str(objective.max_drawdown_pct_equity)
    consistency["extended_max_worst_day_loss_pct_equity"] = str(
        objective.extended_max_worst_day_loss_pct_equity
    )
    consistency["extended_max_drawdown_pct_equity"] = str(
        objective.extended_max_drawdown_pct_equity
    )
    consistency["min_total_net_pnl_to_drawdown_ratio"] = str(
        objective.min_total_net_pnl_to_drawdown_ratio
    )
    payload["constraints"] = constraints
    payload["consistency_constraints"] = consistency
    return payload


def _resolved_mutation_values(
    *,
    key: str,
    current_values: Mapping[str, Any],
    sweep_grid: Mapping[str, Any],
    mutation: MutationSpace,
    family_template: FamilyTemplate,
) -> list[Any]:
    current_value = _current_grid_value(
        current_values=current_values,
        sweep_grid=sweep_grid,
        key=key,
    )
    values: list[Any] = []
    if mutation.include_current and current_value is not None:
        values.append(current_value)
    if mutation.mode == "explicit_values":
        values.extend(mutation.values)
        return _dedupe_preserve_order(values)
    if mutation.mode == "allowed_normalizations":
        values.extend(family_template.allowed_normalizations)
        return _dedupe_preserve_order(values)
    current_decimal = _decimal_from_candidate(current_value)
    if current_decimal is None:
        return _dedupe_preserve_order(values)
    numeric_values: list[Any] = []
    if mutation.include_current:
        numeric_values.append(
            _format_numeric_like(current_decimal, current_value=current_value)
        )
    for delta in mutation.deltas:
        next_value = current_decimal + delta
        if mutation.minimum is not None and next_value < mutation.minimum:
            continue
        if mutation.maximum is not None and next_value > mutation.maximum:
            continue
        numeric_values.append(
            _format_numeric_like(next_value, current_value=current_value)
        )
    return _dedupe_preserve_order(numeric_values)


def build_mutated_sweep_config(
    *,
    base_sweep_config: Mapping[str, Any],
    candidate_payload: Mapping[str, Any],
    family_plan: FamilyAutoresearchPlan,
) -> tuple[dict[str, Any], str]:
    payload = _json_clone(base_sweep_config)
    replay_config = _mapping(candidate_payload.get("replay_config"))
    parameters = _build_mutated_grid(
        current_values=_mapping(replay_config.get("params")),
        sweep_grid=_mapping(payload.get("parameters")),
        mutations=family_plan.parameter_mutations,
        family_template=family_plan.family_template,
    )
    strategy_overrides = _build_mutated_grid(
        current_values=_mapping(replay_config.get("strategy_overrides")),
        sweep_grid=_mapping(payload.get("strategy_overrides")),
        mutations=family_plan.strategy_override_mutations,
        family_template=family_plan.family_template,
    )
    mutated_keys = [*parameters.mutated_keys, *strategy_overrides.mutated_keys]
    payload["parameters"] = parameters.values
    payload["strategy_overrides"] = strategy_overrides.values
    parent_candidate_id = _string(candidate_payload.get("candidate_id"))
    description = (
        f"parent={parent_candidate_id}; mutate={','.join(sorted(set(mutated_keys)))}"
        if mutated_keys
        else f"parent={parent_candidate_id}; mutate=none"
    )
    return payload, description


def _build_mutated_grid(
    *,
    current_values: Mapping[str, Any],
    sweep_grid: Mapping[str, Any],
    mutations: Mapping[str, MutationSpace],
    family_template: FamilyTemplate,
) -> _MutatedGridResult:
    next_values: dict[str, Any] = {}
    mutated_keys: list[str] = []
    for key in sorted(set(sweep_grid) | set(current_values) | set(mutations)):
        values, mutated = _mutation_grid_values(
            key=key,
            current_values=current_values,
            sweep_grid=sweep_grid,
            mutation=mutations.get(key),
            family_template=family_template,
        )
        if not values:
            continue
        next_values[key] = values
        if mutated:
            mutated_keys.append(key)
    return _MutatedGridResult(values=next_values, mutated_keys=mutated_keys)


def _mutation_grid_values(
    *,
    key: str,
    current_values: Mapping[str, Any],
    sweep_grid: Mapping[str, Any],
    mutation: MutationSpace | None,
    family_template: FamilyTemplate,
) -> tuple[list[Any], bool]:
    if mutation is None:
        current_value = _current_grid_value(
            current_values=current_values,
            sweep_grid=sweep_grid,
            key=key,
        )
        return ([current_value], False) if current_value is not None else ([], False)
    values = _resolved_mutation_values(
        key=key,
        current_values=current_values,
        sweep_grid=sweep_grid,
        mutation=mutation,
        family_template=family_template,
    )
    if values:
        return values, True
    return _mutation_grid_values(
        key=key,
        current_values=current_values,
        sweep_grid=sweep_grid,
        mutation=None,
        family_template=family_template,
    )


def _objective_start_equity(
    scorecard: Mapping[str, Any],
    full_window: Mapping[str, Any],
    objective: StrategyObjective,
) -> Decimal:
    for payload in (scorecard, full_window):
        for key in (
            "start_equity",
            "account_start_equity",
            "execution_start_equity",
            "executable_replay_start_equity",
            "runtime_start_equity",
        ):
            value = _coerce_decimal(payload.get(key), default="0")
            if value > 0:
                return value
    return objective.default_start_equity


def _objective_total_net_pnl(
    *,
    scorecard: Mapping[str, Any],
    full_window: Mapping[str, Any],
    net_pnl_per_day: Decimal,
    trading_day_count: int,
) -> Decimal:
    daily_net_payload = _mapping(full_window.get("daily_net")) or _mapping(
        scorecard.get("daily_net")
    )
    if daily_net_payload:
        return sum(
            (
                _coerce_decimal(value, default="0")
                for value in daily_net_payload.values()
            ),
            Decimal("0"),
        )
    return net_pnl_per_day * Decimal(max(1, trading_day_count))


def _objective_drawdown_passes(
    *,
    observed: Decimal,
    start_equity: Decimal,
    normal_pct: Decimal,
    extended_pct: Decimal,
    absolute_cap: Decimal,
    total_net_pnl: Decimal,
    min_total_net_pnl_to_drawdown_ratio: Decimal,
) -> bool:
    normal_limit = max(Decimal("0"), start_equity * normal_pct)
    percent_limit = max(normal_limit, start_equity * extended_pct)
    extended_limit = (
        percent_limit if absolute_cap <= 0 else min(absolute_cap, percent_limit)
    )
    if observed <= normal_limit:
        return True
    if observed <= extended_limit and observed > 0:
        return (total_net_pnl / observed) >= min_total_net_pnl_to_drawdown_ratio
    return observed <= extended_limit


def candidate_meets_objective(
    candidate_payload: Mapping[str, Any],
    *,
    objective: StrategyObjective,
) -> bool:
    if list(candidate_payload.get("hard_vetoes") or []):
        return False
    metrics = _candidate_objective_metrics(candidate_payload, objective)
    if not _objective_observed_days_ok(metrics, objective):
        return False
    if not _objective_every_day_active_ok(metrics, objective):
        return False
    if not _objective_daily_net_pnl_ok(metrics, objective):
        return False
    return _objective_thresholds_ok(metrics, objective)


def _candidate_objective_metrics(
    candidate_payload: Mapping[str, Any],
    objective: StrategyObjective,
) -> _CandidateObjectiveMetrics:
    scorecard = _mapping(candidate_payload.get("objective_scorecard"))
    full_window = _mapping(candidate_payload.get("full_window"))
    net_pnl_per_day = _coerce_decimal(scorecard.get("net_pnl_per_day"), default="0")
    worst_day_loss = _coerce_decimal(
        scorecard.get("worst_day_loss"), default="999999999"
    )
    max_drawdown = _coerce_decimal(scorecard.get("max_drawdown"), default="999999999")
    trading_day_count = int(full_window.get("trading_day_count") or 0)
    start_equity = _objective_start_equity(scorecard, full_window, objective)
    total_net_pnl = _objective_total_net_pnl(
        scorecard=scorecard,
        full_window=full_window,
        net_pnl_per_day=net_pnl_per_day,
        trading_day_count=trading_day_count,
    )
    return _CandidateObjectiveMetrics(
        scorecard=scorecard,
        full_window=full_window,
        net_pnl_per_day=net_pnl_per_day,
        active_day_ratio=_coerce_decimal(
            scorecard.get("active_day_ratio"), default="0"
        ),
        positive_day_ratio=_coerce_decimal(
            scorecard.get("positive_day_ratio"), default="0"
        ),
        avg_daily_notional=_coerce_decimal(
            scorecard.get("avg_filled_notional_per_day"), default="0"
        ),
        best_day_share=_coerce_decimal(scorecard.get("best_day_share"), default="1"),
        worst_day_loss=worst_day_loss,
        max_drawdown=max_drawdown,
        regime_slice_pass_rate=_coerce_decimal(
            scorecard.get("regime_slice_pass_rate"), default="0"
        ),
        max_gross_exposure_pct_equity=_coerce_decimal(
            scorecard.get("max_gross_exposure_pct_equity")
            or full_window.get("max_gross_exposure_pct_equity"),
            default="0",
        ),
        min_cash=_coerce_decimal(
            scorecard.get("min_cash") or full_window.get("min_cash"), default="0"
        ),
        trading_day_count=trading_day_count,
        active_days=int(full_window.get("active_days") or 0),
        start_equity=start_equity,
        total_net_pnl=total_net_pnl,
        worst_day_loss_ok=_objective_drawdown_passes(
            observed=worst_day_loss,
            start_equity=start_equity,
            normal_pct=objective.max_worst_day_loss_pct_equity,
            extended_pct=objective.extended_max_worst_day_loss_pct_equity,
            absolute_cap=objective.max_worst_day_loss,
            total_net_pnl=total_net_pnl,
            min_total_net_pnl_to_drawdown_ratio=objective.min_total_net_pnl_to_drawdown_ratio,
        ),
        max_drawdown_ok=_objective_drawdown_passes(
            observed=max_drawdown,
            start_equity=start_equity,
            normal_pct=objective.max_drawdown_pct_equity,
            extended_pct=objective.extended_max_drawdown_pct_equity,
            absolute_cap=objective.max_drawdown,
            total_net_pnl=total_net_pnl,
            min_total_net_pnl_to_drawdown_ratio=objective.min_total_net_pnl_to_drawdown_ratio,
        ),
    )


def _objective_observed_days_ok(
    metrics: _CandidateObjectiveMetrics,
    objective: StrategyObjective,
) -> bool:
    if (
        objective.min_observed_trading_days > 0
        and metrics.trading_day_count < objective.min_observed_trading_days
    ):
        return False
    return True


def _objective_every_day_active_ok(
    metrics: _CandidateObjectiveMetrics,
    objective: StrategyObjective,
) -> bool:
    return not (
        objective.require_every_day_active
        and metrics.trading_day_count > 0
        and metrics.active_days != metrics.trading_day_count
    )


def _objective_daily_net_pnl_ok(
    metrics: _CandidateObjectiveMetrics,
    objective: StrategyObjective,
) -> bool:
    if objective.min_daily_net_pnl > 0:
        daily_net_payload = _mapping(metrics.full_window.get("daily_net")) or _mapping(
            metrics.scorecard.get("daily_net")
        )
        if not daily_net_payload:
            return False
        if (
            metrics.trading_day_count > 0
            and len(daily_net_payload) < metrics.trading_day_count
        ):
            return False
        if any(
            _coerce_decimal(value, default="-999999999") < objective.min_daily_net_pnl
            for value in daily_net_payload.values()
        ):
            return False
    return True


def _objective_thresholds_ok(
    metrics: _CandidateObjectiveMetrics,
    objective: StrategyObjective,
) -> bool:
    return all(
        (
            metrics.net_pnl_per_day >= objective.target_net_pnl_per_day,
            metrics.active_day_ratio >= objective.min_active_day_ratio,
            metrics.positive_day_ratio >= objective.min_positive_day_ratio,
            metrics.avg_daily_notional >= objective.min_daily_notional,
            metrics.best_day_share <= objective.max_best_day_share,
            metrics.worst_day_loss_ok,
            metrics.max_drawdown_ok,
            metrics.regime_slice_pass_rate >= objective.min_regime_slice_pass_rate,
            metrics.max_gross_exposure_pct_equity
            <= objective.max_gross_exposure_pct_equity,
            metrics.min_cash >= objective.min_cash,
        )
    )


def stable_payload_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def run_id(prefix: str = "strategy-autoresearch") -> str:
    return f"{prefix}-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"


__all__ = [name for name in globals() if not name.startswith("__")]
