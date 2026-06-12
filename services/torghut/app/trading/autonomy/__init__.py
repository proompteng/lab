"""Torghut v3 autonomous runtime and gate modules."""
# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false

from .gates import (
    GateEvaluationReport,
    GateInputs,
    GatePolicyMatrix,
    PromotionTarget,
    evaluate_gate_matrix,
)
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
from .policy_contract import (
    REQUIRED_RUNTIME_GATE_POLICY_KEYS,
    assert_runtime_gate_policy_contract,
    load_runtime_gate_policy,
    required_key_errors,
)
from .evidence import EvidenceContinuityCheckReport, evaluate_evidence_continuity
from .drift import (
    DriftActionDecision,
    DriftDetectionReport,
    DriftPromotionEvidence,
    DriftSignal,
    DriftThresholds,
    DriftTriggerPolicy,
    decide_drift_action,
    detect_drift,
    evaluate_live_promotion_evidence,
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
    "AutonomousLaneResult",
    "GateEvaluationReport",
    "GateInputs",
    "GatePolicyMatrix",
    "LegacyMacdRsiPlugin",
    "PromotionTarget",
    "PromotionPrerequisiteResult",
    "REQUIRED_RUNTIME_GATE_POLICY_KEYS",
    "RuntimeEvaluationResult",
    "RollbackReadinessResult",
    "StrategyContext",
    "StrategyIntent",
    "StrategyPlugin",
    "StrategyPluginRegistry",
    "StrategyRuntime",
    "StrategyRuntimeConfig",
    "default_runtime_registry",
    "EvidenceContinuityCheckReport",
    "DriftActionDecision",
    "DriftDetectionReport",
    "DriftPromotionEvidence",
    "DriftSignal",
    "DriftThresholds",
    "DriftTriggerPolicy",
    "decide_drift_action",
    "detect_drift",
    "evaluate_live_promotion_evidence",
    "evaluate_gate_matrix",
    "evaluate_evidence_continuity",
    "assert_runtime_gate_policy_contract",
    "load_runtime_strategy_config",
    "load_runtime_gate_policy",
    "evaluate_promotion_prerequisites",
    "evaluate_rollback_readiness",
    "required_key_errors",
    "upsert_autonomy_no_signal_run",
    "run_autonomous_lane",
]
