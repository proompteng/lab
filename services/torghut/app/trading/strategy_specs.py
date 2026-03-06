"""Typed strategy and experiment specs for Torghut vNext compilation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, cast


_SUPPORTED_STRATEGY_TYPES: frozenset[str] = frozenset(
    {
        'legacy_macd_rsi',
        'intraday_tsmom_v1',
    }
)


@dataclass(frozen=True)
class StrategySpecV2:
    strategy_id: str
    semantic_version: str
    universe: dict[str, Any]
    feature_view_spec_ref: str
    dataset_eligibility: dict[str, Any]
    model_ref: str | None
    deterministic_rule_ref: str | None
    signal_to_probability_transform: str
    sizing_policy_ref: str
    risk_profile_ref: str
    execution_policy_ref: str
    rebalance_cadence: str
    promotion_policy_ref: str
    replay_dependencies: list[str]
    runtime_parameters: dict[str, Any]
    source: str = 'spec_v2'

    def to_payload(self) -> dict[str, Any]:
        return {
            'strategy_id': self.strategy_id,
            'semantic_version': self.semantic_version,
            'universe': dict(self.universe),
            'feature_view_spec_ref': self.feature_view_spec_ref,
            'dataset_eligibility': dict(self.dataset_eligibility),
            'model_ref': self.model_ref,
            'deterministic_rule_ref': self.deterministic_rule_ref,
            'signal_to_probability_transform': self.signal_to_probability_transform,
            'sizing_policy_ref': self.sizing_policy_ref,
            'risk_profile_ref': self.risk_profile_ref,
            'execution_policy_ref': self.execution_policy_ref,
            'rebalance_cadence': self.rebalance_cadence,
            'promotion_policy_ref': self.promotion_policy_ref,
            'replay_dependencies': list(self.replay_dependencies),
            'runtime_parameters': dict(self.runtime_parameters),
            'source': self.source,
        }


@dataclass(frozen=True)
class ExperimentSpec:
    experiment_id: str
    hypothesis: str
    parent_experiment_ids: list[str]
    target_universe: dict[str, Any]
    dataset_snapshot_request: dict[str, Any]
    feature_view_spec_ref: str
    model_family: str
    training_protocol: dict[str, Any]
    validation_protocol: dict[str, Any]
    acceptance_criteria: dict[str, Any]
    ablations: list[dict[str, Any]]
    stress_scenarios: list[str]
    llm_provenance: dict[str, Any]
    lineage: dict[str, Any]
    research_memory: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            'experiment_id': self.experiment_id,
            'hypothesis': self.hypothesis,
            'parent_experiment_ids': list(self.parent_experiment_ids),
            'target_universe': dict(self.target_universe),
            'dataset_snapshot_request': dict(self.dataset_snapshot_request),
            'feature_view_spec_ref': self.feature_view_spec_ref,
            'model_family': self.model_family,
            'training_protocol': dict(self.training_protocol),
            'validation_protocol': dict(self.validation_protocol),
            'acceptance_criteria': dict(self.acceptance_criteria),
            'ablations': [dict(item) for item in self.ablations],
            'stress_scenarios': list(self.stress_scenarios),
            'llm_provenance': dict(self.llm_provenance),
            'lineage': dict(self.lineage),
            'research_memory': dict(self.research_memory),
        }


@dataclass(frozen=True)
class CompiledStrategySpec:
    strategy_spec: StrategySpecV2
    evaluator_config: dict[str, Any]
    shadow_runtime_config: dict[str, Any]
    live_runtime_config: dict[str, Any]
    promotion_metadata: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            'strategy_spec': self.strategy_spec.to_payload(),
            'evaluator_config': dict(self.evaluator_config),
            'shadow_runtime_config': dict(self.shadow_runtime_config),
            'live_runtime_config': dict(self.live_runtime_config),
            'promotion_metadata': dict(self.promotion_metadata),
        }


def compile_strategy_spec_v2(spec: StrategySpecV2) -> CompiledStrategySpec:
    strategy_type = _resolved_strategy_type(spec)
    evaluator_config = {
        'strategy_id': spec.strategy_id,
        'strategy_type': strategy_type,
        'semantic_version': spec.semantic_version,
        'feature_view_spec_ref': spec.feature_view_spec_ref,
        'dataset_eligibility': dict(spec.dataset_eligibility),
        'replay_dependencies': list(spec.replay_dependencies),
        'runtime_parameters': dict(spec.runtime_parameters),
    }
    shared_runtime = {
        'strategy_id': spec.strategy_id,
        'strategy_type': strategy_type,
        'version': spec.semantic_version,
        'params': dict(spec.runtime_parameters),
        'base_timeframe': str(spec.universe.get('base_timeframe', '1Min')),
        'enabled': True,
        'compiler_source': spec.source,
        'strategy_spec': spec.to_payload(),
    }
    shadow_runtime_config = {
        **shared_runtime,
        'mode': 'shadow',
    }
    live_runtime_config = {
        **shared_runtime,
        'mode': 'live',
    }
    promotion_metadata = {
        'promotion_policy_ref': spec.promotion_policy_ref,
        'risk_profile_ref': spec.risk_profile_ref,
        'execution_policy_ref': spec.execution_policy_ref,
        'sizing_policy_ref': spec.sizing_policy_ref,
        'signal_to_probability_transform': spec.signal_to_probability_transform,
        'replay_dependencies': list(spec.replay_dependencies),
    }
    return CompiledStrategySpec(
        strategy_spec=spec,
        evaluator_config=evaluator_config,
        shadow_runtime_config=shadow_runtime_config,
        live_runtime_config=live_runtime_config,
        promotion_metadata=promotion_metadata,
    )


def build_strategy_spec_v2(
    *,
    strategy_id: str,
    strategy_type: str,
    semantic_version: str,
    params: Mapping[str, Any] | None = None,
    base_timeframe: str = '1Min',
    universe_symbols: list[str] | None = None,
    source: str = 'spec_v2',
) -> StrategySpecV2:
    normalized_strategy_type = _normalize_strategy_type(strategy_type)
    normalized_params = dict(params or {})
    symbols = [str(item) for item in (universe_symbols or []) if str(item).strip()]
    feature_ref = _feature_view_spec_ref(normalized_strategy_type)
    model_ref, deterministic_rule_ref = _model_and_rule_refs(normalized_strategy_type)
    return StrategySpecV2(
        strategy_id=strategy_id,
        semantic_version=semantic_version or _default_version(normalized_strategy_type),
        universe={
            'base_timeframe': base_timeframe or '1Min',
            'symbols': symbols,
            'strategy_type': normalized_strategy_type,
        },
        feature_view_spec_ref=feature_ref,
        dataset_eligibility={
            'source': 'historical_market_replay',
            'min_history_bars': 240,
            'base_timeframe': base_timeframe or '1Min',
        },
        model_ref=model_ref,
        deterministic_rule_ref=deterministic_rule_ref,
        signal_to_probability_transform='deterministic-confidence-v1',
        sizing_policy_ref='torghut-sizing/default-v1',
        risk_profile_ref='torghut-risk/default-v1',
        execution_policy_ref='torghut-execution/default-v1',
        rebalance_cadence=base_timeframe or '1Min',
        promotion_policy_ref='torghut-promotion/vnext-default-v1',
        replay_dependencies=[
            'backtest/walkforward-results.json',
            'reports/evaluation-report.json',
            'gates/gate-evaluation.json',
        ],
        runtime_parameters=normalized_params,
        source=source,
    )


def build_compiled_strategy_artifacts(
    *,
    strategy_id: str,
    strategy_type: str,
    semantic_version: str,
    params: Mapping[str, Any] | None = None,
    base_timeframe: str = '1Min',
    universe_symbols: list[str] | None = None,
    source: str = 'spec_v2',
) -> CompiledStrategySpec:
    spec = build_strategy_spec_v2(
        strategy_id=strategy_id,
        strategy_type=strategy_type,
        semantic_version=semantic_version,
        params=params,
        base_timeframe=base_timeframe,
        universe_symbols=universe_symbols,
        source=source,
    )
    return compile_strategy_spec_v2(spec)


def build_experiment_spec_from_strategy(
    *,
    experiment_id: str,
    hypothesis: str,
    strategy_spec: StrategySpecV2,
    parent_experiment_ids: list[str] | None = None,
    llm_provenance: Mapping[str, Any] | None = None,
    lineage: Mapping[str, Any] | None = None,
    research_memory: Mapping[str, Any] | None = None,
) -> ExperimentSpec:
    return ExperimentSpec(
        experiment_id=experiment_id,
        hypothesis=hypothesis,
        parent_experiment_ids=list(parent_experiment_ids or []),
        target_universe=dict(strategy_spec.universe),
        dataset_snapshot_request={
            'source': strategy_spec.dataset_eligibility.get('source'),
            'base_timeframe': strategy_spec.dataset_eligibility.get('base_timeframe'),
        },
        feature_view_spec_ref=strategy_spec.feature_view_spec_ref,
        model_family=_resolved_strategy_type(strategy_spec),
        training_protocol={
            'family': _resolved_strategy_type(strategy_spec),
            'semantic_version': strategy_spec.semantic_version,
        },
        validation_protocol={
            'walkforward': True,
            'stress_windows': ['spread', 'volatility', 'liquidity', 'halt'],
        },
        acceptance_criteria={
            'promotion_policy_ref': strategy_spec.promotion_policy_ref,
            'risk_profile_ref': strategy_spec.risk_profile_ref,
        },
        ablations=[
            {
                'name': 'no_feature_ablation',
                'drop_features': [],
            }
        ],
        stress_scenarios=['spread', 'volatility', 'liquidity', 'halt'],
        llm_provenance=dict(llm_provenance or {'mode': 'none'}),
        lineage=dict(lineage or {'source': 'strategy_spec_v2'}),
        research_memory=dict(
            research_memory
            or {
                'summary': f'{strategy_spec.strategy_id}:{strategy_spec.semantic_version}',
                'source': strategy_spec.source,
            }
        ),
    )


def strategy_type_supports_spec_v2(strategy_type: str) -> bool:
    return _normalize_strategy_type(strategy_type) in _SUPPORTED_STRATEGY_TYPES


def load_strategy_spec_v2_payload(value: Any) -> StrategySpecV2:
    payload = cast(dict[str, Any], value) if isinstance(value, dict) else {}
    return StrategySpecV2(
        strategy_id=str(payload.get('strategy_id', '')).strip() or 'unknown-strategy',
        semantic_version=str(payload.get('semantic_version', '')).strip() or '1.0.0',
        universe=cast(dict[str, Any], payload.get('universe', {}))
        if isinstance(payload.get('universe'), dict)
        else {},
        feature_view_spec_ref=str(payload.get('feature_view_spec_ref', '')).strip() or 'features/unknown',
        dataset_eligibility=cast(dict[str, Any], payload.get('dataset_eligibility', {}))
        if isinstance(payload.get('dataset_eligibility'), dict)
        else {},
        model_ref=_nullable_text(payload.get('model_ref')),
        deterministic_rule_ref=_nullable_text(payload.get('deterministic_rule_ref')),
        signal_to_probability_transform=str(
            payload.get('signal_to_probability_transform', 'deterministic-confidence-v1')
        ),
        sizing_policy_ref=str(payload.get('sizing_policy_ref', 'torghut-sizing/default-v1')),
        risk_profile_ref=str(payload.get('risk_profile_ref', 'torghut-risk/default-v1')),
        execution_policy_ref=str(
            payload.get('execution_policy_ref', 'torghut-execution/default-v1')
        ),
        rebalance_cadence=str(payload.get('rebalance_cadence', '1Min')),
        promotion_policy_ref=str(
            payload.get('promotion_policy_ref', 'torghut-promotion/vnext-default-v1')
        ),
        replay_dependencies=[
            str(item)
            for item in cast(list[Any], payload.get('replay_dependencies', []))
            if str(item).strip()
        ],
        runtime_parameters=cast(dict[str, Any], payload.get('runtime_parameters', {}))
        if isinstance(payload.get('runtime_parameters'), dict)
        else {},
        source=str(payload.get('source', 'spec_v2')),
    )


def _normalize_strategy_type(strategy_type: str) -> str:
    normalized = strategy_type.strip().lower()
    if normalized in {'intraday_tsmom', 'tsmom_intraday'}:
        return 'intraday_tsmom_v1'
    if normalized in {'static', ''}:
        return 'legacy_macd_rsi'
    return normalized


def _resolved_strategy_type(spec: StrategySpecV2) -> str:
    if spec.deterministic_rule_ref:
        return _normalize_strategy_type(spec.deterministic_rule_ref.rsplit('/', 1)[-1])
    if spec.model_ref:
        return _normalize_strategy_type(spec.model_ref.rsplit('/', 1)[-1])
    return _normalize_strategy_type(str(spec.universe.get('strategy_type', 'legacy_macd_rsi')))


def _model_and_rule_refs(strategy_type: str) -> tuple[str | None, str | None]:
    if strategy_type == 'intraday_tsmom_v1':
        return None, 'rules/intraday_tsmom_v1'
    return None, 'rules/legacy_macd_rsi'


def _feature_view_spec_ref(strategy_type: str) -> str:
    if strategy_type == 'intraday_tsmom_v1':
        return 'features/intraday-momentum-v1'
    return 'features/legacy-macd-rsi-v1'


def _default_version(strategy_type: str) -> str:
    if strategy_type == 'intraday_tsmom_v1':
        return '1.1.0'
    return '1.0.0'


def _nullable_text(value: Any) -> str | None:
    text = str(value or '').strip()
    return text or None


__all__ = [
    'CompiledStrategySpec',
    'ExperimentSpec',
    'StrategySpecV2',
    'build_compiled_strategy_artifacts',
    'build_experiment_spec_from_strategy',
    'build_strategy_spec_v2',
    'compile_strategy_spec_v2',
    'load_strategy_spec_v2_payload',
    'strategy_type_supports_spec_v2',
]
