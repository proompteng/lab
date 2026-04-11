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

from app.trading.discovery.family_templates import FamilyTemplate, family_template_dir, load_family_template

_SCHEMA_VERSION = 'torghut.strategy-autoresearch.v1'


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping_value = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping_value.items()}


def _string(value: Any) -> str:
    return str(value or '').strip()


def _string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    raw_values = cast(list[Any], value)
    resolved: list[str] = []
    for item in raw_values:
        normalized = _string(item)
        if normalized:
            resolved.append(normalized)
    return tuple(resolved)


def _coerce_decimal(value: Any, *, default: str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int | float):
        return Decimal(str(value))
    text = _string(value)
    return Decimal(text or default)


def _json_clone(payload: Mapping[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(payload))


def _stable_value_key(value: Any) -> str:
    if isinstance(value, list | dict):
        return json.dumps(value, sort_keys=True, separators=(',', ':'))
    return str(value)


def _dedupe_preserve_order(values: list[Any]) -> list[Any]:
    seen: set[str] = set()
    ordered: list[Any] = []
    for value in values:
        stable_key = _stable_value_key(value)
        if stable_key in seen:
            continue
        seen.add(stable_key)
        ordered.append(value)
    return ordered


def _current_grid_value(
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


def _decimal_from_candidate(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return _coerce_decimal(value, default='')
    except (InvalidOperation, ValueError):
        return None


def _format_numeric_like(value: Decimal, *, current_value: Any) -> str:
    current_text = _string(current_value)
    if current_text and '.' not in current_text:
        return str(int(value))
    if current_text and '.' in current_text:
        decimals = len(current_text.split('.', 1)[1])
        return f'{value:.{decimals}f}'
    text = format(value, 'f')
    if '.' in text:
        return text.rstrip('0').rstrip('.') or '0'
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

    def to_payload(self) -> dict[str, Any]:
        return {
            'target_net_pnl_per_day': str(self.target_net_pnl_per_day),
            'min_active_day_ratio': str(self.min_active_day_ratio),
            'min_positive_day_ratio': str(self.min_positive_day_ratio),
            'min_daily_notional': str(self.min_daily_notional),
            'max_best_day_share': str(self.max_best_day_share),
            'max_worst_day_loss': str(self.max_worst_day_loss),
            'max_drawdown': str(self.max_drawdown),
            'require_every_day_active': self.require_every_day_active,
            'min_regime_slice_pass_rate': str(self.min_regime_slice_pass_rate),
            'stop_when_objective_met': self.stop_when_objective_met,
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
            'bar_interval': self.bar_interval,
            'feature_set_id': self.feature_set_id,
            'quote_quality_policy_id': self.quote_quality_policy_id,
            'symbol_policy': self.symbol_policy,
            'allow_prior_day_features': self.allow_prior_day_features,
            'allow_cross_sectional_features': self.allow_cross_sectional_features,
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
            'enabled': self.enabled,
            'mode': self.mode,
            'backend_preference': self.backend_preference,
            'top_k': self.top_k,
            'exploration_slots': self.exploration_slots,
            'minimum_history_rows': self.minimum_history_rows,
        }


@dataclass(frozen=True)
class ReplayBudget:
    max_candidates_per_round: int
    exploration_slots: int

    def to_payload(self) -> dict[str, Any]:
        return {
            'max_candidates_per_round': self.max_candidates_per_round,
            'exploration_slots': self.exploration_slots,
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
            'enabled': self.enabled,
            'execute_parity_replay': self.execute_parity_replay,
            'execute_approval_replay': self.execute_approval_replay,
            'parity_window': self.parity_window,
            'approval_window': self.approval_window,
            'shadow_validation_mode': self.shadow_validation_mode,
            'promotion_target': self.promotion_target,
        }


@dataclass(frozen=True)
class ResearchClaim:
    claim_id: str
    summary: str
    implication: str

    def to_payload(self) -> dict[str, str]:
        return {
            'claim_id': self.claim_id,
            'summary': self.summary,
            'implication': self.implication,
        }


@dataclass(frozen=True)
class ResearchSource:
    source_id: str
    title: str
    url: str
    published_at: str
    claims: tuple[ResearchClaim, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            'source_id': self.source_id,
            'title': self.title,
            'url': self.url,
            'published_at': self.published_at,
            'claims': [item.to_payload() for item in self.claims],
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
            'mode': self.mode,
            'include_current': self.include_current,
        }
        if self.values:
            payload['values'] = list(self.values)
        if self.deltas:
            payload['deltas'] = [str(item) for item in self.deltas]
        if self.minimum is not None:
            payload['minimum'] = str(self.minimum)
        if self.maximum is not None:
            payload['maximum'] = str(self.maximum)
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
    parameter_mutations: Mapping[str, MutationSpace]
    strategy_override_mutations: Mapping[str, MutationSpace]

    def to_payload(self) -> dict[str, Any]:
        return {
            'family_template_id': self.family_template.family_id,
            'seed_sweep_config': str(self.seed_sweep_config),
            'max_iterations': self.max_iterations,
            'keep_top_candidates': self.keep_top_candidates,
            'frontier_top_n': self.frontier_top_n,
            'force_keep_top_candidate_if_all_vetoed': self.force_keep_top_candidate_if_all_vetoed,
            'symbol_prune_iterations': self.symbol_prune_iterations,
            'symbol_prune_candidates': self.symbol_prune_candidates,
            'symbol_prune_min_universe_size': self.symbol_prune_min_universe_size,
            'parameter_mutations': {
                key: value.to_payload() for key, value in self.parameter_mutations.items()
            },
            'strategy_override_mutations': {
                key: value.to_payload() for key, value in self.strategy_override_mutations.items()
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
    schema_version: str = _SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            'schema_version': self.schema_version,
            'program_id': self.program_id,
            'description': self.description,
            'objective': self.objective.to_payload(),
            'snapshot_policy': self.snapshot_policy.to_payload(),
            'forbidden_mutations': list(self.forbidden_mutations),
            'proposal_model_policy': self.proposal_model_policy.to_payload(),
            'replay_budget': self.replay_budget.to_payload(),
            'runtime_closure_policy': self.runtime_closure_policy.to_payload(),
            'parity_requirements': list(self.parity_requirements),
            'promotion_policy': self.promotion_policy,
            'ledger_policy': dict(self.ledger_policy),
            'research_sources': [item.to_payload() for item in self.research_sources],
            'families': [item.to_payload() for item in self.families],
        }


def _load_mutation_space(payload: Mapping[str, Any]) -> MutationSpace:
    mode = _string(payload.get('mode'))
    if mode not in {'explicit_values', 'numeric_step', 'allowed_normalizations'}:
        raise ValueError(f'autoresearch_mutation_mode_invalid:{mode or "missing"}')
    values = _string_list(payload.get('values'))
    delta_values: tuple[Decimal, ...] = ()
    raw_deltas = payload.get('deltas')
    if isinstance(raw_deltas, list):
        raw_delta_values = cast(list[Any], raw_deltas)
        delta_values = tuple(_coerce_decimal(item, default='0') for item in raw_delta_values)
    minimum = None
    if payload.get('minimum') is not None:
        minimum = _coerce_decimal(payload.get('minimum'), default='0')
    maximum = None
    if payload.get('maximum') is not None:
        maximum = _coerce_decimal(payload.get('maximum'), default='0')
    return MutationSpace(
        mode=mode,
        values=values,
        deltas=delta_values,
        minimum=minimum,
        maximum=maximum,
        include_current=bool(payload.get('include_current', True)),
    )


def _resolve_program_path(path: Path) -> Path:
    return path.resolve()


def _resolve_seed_sweep_path(*, program_path: Path, raw_path: str) -> Path:
    candidate = Path(raw_path)
    if candidate.is_absolute():
        return candidate
    return (program_path.parent / candidate).resolve()


def _load_runtime_closure_policy(payload: Mapping[str, Any]) -> RuntimeClosurePolicy:
    parity_window = _string(payload.get('parity_window')) or 'full_window'
    approval_window = _string(payload.get('approval_window')) or 'holdout'
    if parity_window not in {'train', 'holdout', 'full_window'}:
        raise ValueError(f'autoresearch_runtime_closure_parity_window_invalid:{parity_window}')
    if approval_window not in {'train', 'holdout', 'full_window'}:
        raise ValueError(f'autoresearch_runtime_closure_approval_window_invalid:{approval_window}')
    shadow_validation_mode = (
        _string(payload.get('shadow_validation_mode')) or 'require_live_evidence'
    )
    if shadow_validation_mode not in {'require_live_evidence', 'skip'}:
        raise ValueError(
            f'autoresearch_runtime_closure_shadow_validation_mode_invalid:{shadow_validation_mode}'
        )
    promotion_target = _string(payload.get('promotion_target')) or 'shadow'
    if promotion_target not in {'shadow', 'paper', 'live'}:
        raise ValueError(f'autoresearch_runtime_closure_promotion_target_invalid:{promotion_target}')
    return RuntimeClosurePolicy(
        enabled=bool(payload.get('enabled', False)),
        execute_parity_replay=bool(payload.get('execute_parity_replay', True)),
        execute_approval_replay=bool(payload.get('execute_approval_replay', True)),
        parity_window=parity_window,
        approval_window=approval_window,
        shadow_validation_mode=shadow_validation_mode,
        promotion_target=promotion_target,
    )


def load_strategy_autoresearch_program(
    path: Path,
    *,
    family_dir: Path | None = None,
) -> StrategyAutoresearchProgram:
    program_path = _resolve_program_path(path)
    raw_payload = yaml.safe_load(program_path.read_text(encoding='utf-8'))
    if not isinstance(raw_payload, Mapping):
        raise ValueError('autoresearch_program_not_mapping')
    payload = cast(Mapping[str, Any], raw_payload)
    schema_version = _string(payload.get('schema_version'))
    if schema_version != _SCHEMA_VERSION:
        raise ValueError(f'autoresearch_program_schema_invalid:{schema_version}')

    objective_payload = _mapping(payload.get('objective'))
    objective = StrategyObjective(
        target_net_pnl_per_day=_coerce_decimal(
            objective_payload.get('target_net_pnl_per_day'),
            default='500',
        ),
        min_active_day_ratio=_coerce_decimal(
            objective_payload.get('min_active_day_ratio'),
            default='0.80',
        ),
        min_positive_day_ratio=_coerce_decimal(
            objective_payload.get('min_positive_day_ratio'),
            default='0.55',
        ),
        min_daily_notional=_coerce_decimal(
            objective_payload.get('min_daily_notional'),
            default='250000',
        ),
        max_best_day_share=_coerce_decimal(
            objective_payload.get('max_best_day_share'),
            default='0.40',
        ),
        max_worst_day_loss=_coerce_decimal(
            objective_payload.get('max_worst_day_loss'),
            default='500',
        ),
        max_drawdown=_coerce_decimal(
            objective_payload.get('max_drawdown'),
            default='1200',
        ),
        require_every_day_active=bool(objective_payload.get('require_every_day_active', False)),
        min_regime_slice_pass_rate=_coerce_decimal(
            objective_payload.get('min_regime_slice_pass_rate'),
            default='0.35',
        ),
        stop_when_objective_met=bool(objective_payload.get('stop_when_objective_met', False)),
    )
    snapshot_policy_payload = _mapping(payload.get('snapshot_policy'))
    snapshot_policy = SnapshotPolicy(
        bar_interval=_string(snapshot_policy_payload.get('bar_interval')) or 'PT1S',
        feature_set_id=_string(snapshot_policy_payload.get('feature_set_id')) or 'torghut.mlx-autoresearch.v1',
        quote_quality_policy_id=_string(snapshot_policy_payload.get('quote_quality_policy_id'))
        or 'scheduler_v3_default',
        symbol_policy=_string(snapshot_policy_payload.get('symbol_policy')) or 'args_or_sweep',
        allow_prior_day_features=bool(snapshot_policy_payload.get('allow_prior_day_features', True)),
        allow_cross_sectional_features=bool(snapshot_policy_payload.get('allow_cross_sectional_features', True)),
    )
    proposal_model_payload = _mapping(payload.get('proposal_model_policy'))
    proposal_model_policy = ProposalModelPolicy(
        enabled=bool(proposal_model_payload.get('enabled', True)),
        mode=_string(proposal_model_payload.get('mode')) or 'ranking_only',
        backend_preference=_string(proposal_model_payload.get('backend_preference')) or 'mlx',
        top_k=max(1, int(proposal_model_payload.get('top_k', 4))),
        exploration_slots=max(0, int(proposal_model_payload.get('exploration_slots', 1))),
        minimum_history_rows=max(0, int(proposal_model_payload.get('minimum_history_rows', 3))),
    )
    replay_budget_payload = _mapping(payload.get('replay_budget'))
    replay_budget = ReplayBudget(
        max_candidates_per_round=max(1, int(replay_budget_payload.get('max_candidates_per_round', 8))),
        exploration_slots=max(0, int(replay_budget_payload.get('exploration_slots', 1))),
    )
    runtime_closure_policy = _load_runtime_closure_policy(_mapping(payload.get('runtime_closure_policy')))
    forbidden_mutations = _string_list(
        payload.get('forbidden_mutations')
        or ['runtime_code_path', 'evaluator_logic', 'live_strategy_config']
    )
    parity_requirements = _string_list(
        payload.get('parity_requirements')
        or [
            'checked_in_runtime_family',
            'scheduler_v3_parity_replay',
            'scheduler_v3_approval_replay',
            'live_shadow_validation',
        ]
    )
    promotion_policy = _string(payload.get('promotion_policy')) or 'research_only'
    ledger_policy = _mapping(payload.get('ledger_policy')) or {'append_only': True}

    research_sources: list[ResearchSource] = []
    raw_sources = payload.get('research_sources')
    if isinstance(raw_sources, list):
        raw_source_values = cast(list[Any], raw_sources)
        for raw_source in raw_source_values:
            if not isinstance(raw_source, Mapping):
                continue
            source_payload = cast(Mapping[str, Any], raw_source)
            claims: list[ResearchClaim] = []
            raw_claims = source_payload.get('claims')
            if isinstance(raw_claims, list):
                raw_claim_values = cast(list[Any], raw_claims)
                for raw_claim in raw_claim_values:
                    if not isinstance(raw_claim, Mapping):
                        continue
                    claim_payload = cast(Mapping[str, Any], raw_claim)
                    claim_id = _string(claim_payload.get('claim_id'))
                    if not claim_id:
                        continue
                    claims.append(
                        ResearchClaim(
                            claim_id=claim_id,
                            summary=_string(claim_payload.get('summary')),
                            implication=_string(claim_payload.get('implication')),
                        )
                    )
            source_id = _string(source_payload.get('source_id'))
            if not source_id:
                continue
            research_sources.append(
                ResearchSource(
                    source_id=source_id,
                    title=_string(source_payload.get('title')),
                    url=_string(source_payload.get('url')),
                    published_at=_string(source_payload.get('published_at')),
                    claims=tuple(claims),
                )
            )

    resolved_family_dir = family_template_dir(family_dir)
    family_plans: list[FamilyAutoresearchPlan] = []
    raw_families = payload.get('families')
    if not isinstance(raw_families, list) or not raw_families:
        raise ValueError('autoresearch_program_missing_families')
    raw_family_values = cast(list[Any], raw_families)
    for raw_family in raw_family_values:
        if not isinstance(raw_family, Mapping):
            continue
        family_payload = cast(Mapping[str, Any], raw_family)
        template_id = _string(family_payload.get('family_template_id'))
        if not template_id:
            raise ValueError('autoresearch_family_template_missing')
        template = load_family_template(template_id, directory=resolved_family_dir)
        seed_sweep_config = _resolve_seed_sweep_path(
            program_path=program_path,
            raw_path=_string(family_payload.get('seed_sweep_config')),
        )
        parameter_mutations = {
            key: _load_mutation_space(_mapping(value))
            for key, value in _mapping(family_payload.get('parameter_mutations')).items()
        }
        strategy_override_mutations = {
            key: _load_mutation_space(_mapping(value))
            for key, value in _mapping(family_payload.get('strategy_override_mutations')).items()
        }
        family_plans.append(
            FamilyAutoresearchPlan(
                family_template=template,
                seed_sweep_config=seed_sweep_config,
                max_iterations=max(1, int(family_payload.get('max_iterations', 2))),
                keep_top_candidates=max(1, int(family_payload.get('keep_top_candidates', 1))),
                frontier_top_n=max(1, int(family_payload.get('frontier_top_n', 5))),
                force_keep_top_candidate_if_all_vetoed=bool(
                    family_payload.get('force_keep_top_candidate_if_all_vetoed', True)
                ),
                symbol_prune_iterations=max(0, int(family_payload.get('symbol_prune_iterations', 0))),
                symbol_prune_candidates=max(1, int(family_payload.get('symbol_prune_candidates', 1))),
                symbol_prune_min_universe_size=max(1, int(family_payload.get('symbol_prune_min_universe_size', 2))),
                parameter_mutations=parameter_mutations,
                strategy_override_mutations=strategy_override_mutations,
            )
        )

    return StrategyAutoresearchProgram(
        program_id=_string(payload.get('program_id')) or program_path.stem,
        description=_string(payload.get('description')),
        objective=objective,
        snapshot_policy=snapshot_policy,
        forbidden_mutations=forbidden_mutations,
        proposal_model_policy=proposal_model_policy,
        replay_budget=replay_budget,
        runtime_closure_policy=runtime_closure_policy,
        parity_requirements=parity_requirements,
        promotion_policy=promotion_policy,
        ledger_policy=ledger_policy,
        research_sources=tuple(research_sources),
        families=tuple(family_plans),
    )


def apply_program_objective(
    *,
    sweep_config: Mapping[str, Any],
    objective: StrategyObjective,
    train_day_count: int,
    holdout_day_count: int,
    full_window_day_count: int | None = None,
) -> dict[str, Any]:
    payload = _json_clone(sweep_config)
    constraints = _mapping(payload.get('constraints'))
    consistency = _mapping(payload.get('consistency_constraints'))
    min_holdout_active_days = max(
        1,
        int(
            (
                objective.min_active_day_ratio * Decimal(max(1, holdout_day_count))
            ).to_integral_value(rounding=ROUND_CEILING)
        ),
    )
    constraints['holdout_target_net_per_day'] = str(objective.target_net_pnl_per_day)
    constraints['min_active_holdout_days'] = min_holdout_active_days
    consistency['target_net_per_day'] = str(objective.target_net_pnl_per_day)
    consistency['min_active_ratio'] = str(objective.min_active_day_ratio)
    consistency['max_worst_day_loss'] = str(objective.max_worst_day_loss)
    consistency['max_drawdown'] = str(objective.max_drawdown)
    consistency['max_best_day_share_of_total_pnl'] = str(objective.max_best_day_share)
    consistency['min_avg_filled_notional_per_day'] = str(objective.min_daily_notional)
    if full_window_day_count is not None:
        total_days = max(1, int(full_window_day_count))
        consistency['min_active_days'] = max(
            1,
            int((objective.min_active_day_ratio * Decimal(total_days)).to_integral_value(rounding=ROUND_CEILING)),
        )
        consistency['min_positive_days'] = max(
            1,
            int((objective.min_positive_day_ratio * Decimal(total_days)).to_integral_value(rounding=ROUND_CEILING)),
        )
    if objective.min_active_day_ratio > 0:
        consistency['min_avg_filled_notional_per_active_day'] = str(
            (objective.min_daily_notional / objective.min_active_day_ratio).quantize(Decimal('1'))
        )
    consistency['require_every_day_active'] = bool(objective.require_every_day_active)
    consistency['min_regime_slice_pass_rate'] = str(objective.min_regime_slice_pass_rate)
    payload['constraints'] = constraints
    payload['consistency_constraints'] = consistency
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
    if mutation.mode == 'explicit_values':
        values.extend(mutation.values)
        return _dedupe_preserve_order(values)
    if mutation.mode == 'allowed_normalizations':
        values.extend(family_template.allowed_normalizations)
        return _dedupe_preserve_order(values)
    current_decimal = _decimal_from_candidate(current_value)
    if current_decimal is None:
        return _dedupe_preserve_order(values)
    numeric_values: list[Any] = []
    if mutation.include_current:
        numeric_values.append(_format_numeric_like(current_decimal, current_value=current_value))
    for delta in mutation.deltas:
        next_value = current_decimal + delta
        if mutation.minimum is not None and next_value < mutation.minimum:
            continue
        if mutation.maximum is not None and next_value > mutation.maximum:
            continue
        numeric_values.append(_format_numeric_like(next_value, current_value=current_value))
    return _dedupe_preserve_order(numeric_values)


def build_mutated_sweep_config(
    *,
    base_sweep_config: Mapping[str, Any],
    candidate_payload: Mapping[str, Any],
    family_plan: FamilyAutoresearchPlan,
) -> tuple[dict[str, Any], str]:
    payload = _json_clone(base_sweep_config)
    replay_config = _mapping(candidate_payload.get('replay_config'))
    current_params = _mapping(replay_config.get('params'))
    current_overrides = _mapping(replay_config.get('strategy_overrides'))
    parameter_grid = _mapping(payload.get('parameters'))
    strategy_override_grid = _mapping(payload.get('strategy_overrides'))

    mutated_keys: list[str] = []
    next_parameters: dict[str, Any] = {}
    parameter_keys = set(parameter_grid) | set(current_params) | set(family_plan.parameter_mutations)
    for key in sorted(parameter_keys):
        mutation = family_plan.parameter_mutations.get(key)
        if mutation is None:
            current_value = _current_grid_value(
                current_values=current_params,
                sweep_grid=parameter_grid,
                key=key,
            )
            if current_value is None:
                continue
            next_parameters[key] = [current_value]
            continue
        values = _resolved_mutation_values(
            key=key,
            current_values=current_params,
            sweep_grid=parameter_grid,
            mutation=mutation,
            family_template=family_plan.family_template,
        )
        if not values:
            current_value = _current_grid_value(
                current_values=current_params,
                sweep_grid=parameter_grid,
                key=key,
            )
            if current_value is None:
                continue
            next_parameters[key] = [current_value]
            continue
        next_parameters[key] = values
        mutated_keys.append(key)

    next_strategy_overrides: dict[str, Any] = {}
    override_keys = set(strategy_override_grid) | set(current_overrides) | set(family_plan.strategy_override_mutations)
    for key in sorted(override_keys):
        mutation = family_plan.strategy_override_mutations.get(key)
        if mutation is None:
            current_value = _current_grid_value(
                current_values=current_overrides,
                sweep_grid=strategy_override_grid,
                key=key,
            )
            if current_value is None:
                continue
            next_strategy_overrides[key] = [current_value]
            continue
        values = _resolved_mutation_values(
            key=key,
            current_values=current_overrides,
            sweep_grid=strategy_override_grid,
            mutation=mutation,
            family_template=family_plan.family_template,
        )
        if not values:
            current_value = _current_grid_value(
                current_values=current_overrides,
                sweep_grid=strategy_override_grid,
                key=key,
            )
            if current_value is None:
                continue
            next_strategy_overrides[key] = [current_value]
            continue
        next_strategy_overrides[key] = values
        mutated_keys.append(key)

    payload['parameters'] = next_parameters
    payload['strategy_overrides'] = next_strategy_overrides
    parent_candidate_id = _string(candidate_payload.get('candidate_id'))
    description = (
        f'parent={parent_candidate_id}; mutate={",".join(sorted(set(mutated_keys)))}'
        if mutated_keys
        else f'parent={parent_candidate_id}; mutate=none'
    )
    return payload, description


def candidate_meets_objective(
    candidate_payload: Mapping[str, Any],
    *,
    objective: StrategyObjective,
) -> bool:
    if list(candidate_payload.get('hard_vetoes') or []):
        return False
    scorecard = _mapping(candidate_payload.get('objective_scorecard'))
    full_window = _mapping(candidate_payload.get('full_window'))
    net_pnl_per_day = _coerce_decimal(scorecard.get('net_pnl_per_day'), default='0')
    active_day_ratio = _coerce_decimal(scorecard.get('active_day_ratio'), default='0')
    positive_day_ratio = _coerce_decimal(scorecard.get('positive_day_ratio'), default='0')
    avg_daily_notional = _coerce_decimal(scorecard.get('avg_filled_notional_per_day'), default='0')
    best_day_share = _coerce_decimal(scorecard.get('best_day_share'), default='1')
    worst_day_loss = _coerce_decimal(scorecard.get('worst_day_loss'), default='999999999')
    max_drawdown = _coerce_decimal(scorecard.get('max_drawdown'), default='999999999')
    regime_slice_pass_rate = _coerce_decimal(scorecard.get('regime_slice_pass_rate'), default='0')
    trading_day_count = int(full_window.get('trading_day_count') or 0)
    active_days = int(full_window.get('active_days') or 0)
    if objective.require_every_day_active and trading_day_count > 0 and active_days != trading_day_count:
        return False
    return all(
        (
            net_pnl_per_day >= objective.target_net_pnl_per_day,
            active_day_ratio >= objective.min_active_day_ratio,
            positive_day_ratio >= objective.min_positive_day_ratio,
            avg_daily_notional >= objective.min_daily_notional,
            best_day_share <= objective.max_best_day_share,
            worst_day_loss <= objective.max_worst_day_loss,
            max_drawdown <= objective.max_drawdown,
            regime_slice_pass_rate >= objective.min_regime_slice_pass_rate,
        )
    )


def stable_payload_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def run_id(prefix: str = 'strategy-autoresearch') -> str:
    return f'{prefix}-{datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")}'
