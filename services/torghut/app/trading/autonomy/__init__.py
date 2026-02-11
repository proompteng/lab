"""Torghut v3 autonomous runtime and gate modules."""

from .gates import GateEvaluationReport, GateInputs, GatePolicyMatrix, PromotionTarget, evaluate_gate_matrix
from .lane import AutonomousLaneResult, load_runtime_strategy_config, run_autonomous_lane
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
    'RuntimeEvaluationResult',
    'StrategyContext',
    'StrategyIntent',
    'StrategyPlugin',
    'StrategyPluginRegistry',
    'StrategyRuntime',
    'StrategyRuntimeConfig',
    'default_runtime_registry',
    'evaluate_gate_matrix',
    'load_runtime_strategy_config',
    'run_autonomous_lane',
]
