"""Torghut v3 autonomous runtime and gate modules."""

from .gates import GateEvaluationReport, GateInputs, GatePolicyMatrix, PromotionTarget, evaluate_gate_matrix
from .lane import (
    AutonomousLaneResult,
    load_runtime_strategy_config,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from .policy_checks import (
    PromotionPrerequisiteResult,
    RollbackReadinessResult,
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from .runtime import (
    LegacyMacdRsiPlugin,
    RuntimeEvaluationResult,
    StrategyContext,
    StrategyIntent,
    StrategyPlugin,
    StrategyPluginRegistry,
    StrategyRuntime,
    StrategyRuntimeConfig,
    default_runtime_registry,
)

__all__ = [
    'AutonomousLaneResult',
    'GateEvaluationReport',
    'GateInputs',
    'GatePolicyMatrix',
    'LegacyMacdRsiPlugin',
    'PromotionTarget',
    'PromotionPrerequisiteResult',
    'RuntimeEvaluationResult',
    'RollbackReadinessResult',
    'StrategyContext',
    'StrategyIntent',
    'StrategyPlugin',
    'StrategyPluginRegistry',
    'StrategyRuntime',
    'StrategyRuntimeConfig',
    'default_runtime_registry',
    'evaluate_gate_matrix',
    'load_runtime_strategy_config',
    'evaluate_promotion_prerequisites',
    'evaluate_rollback_readiness',
    'upsert_autonomy_no_signal_run',
    'run_autonomous_lane',
]
