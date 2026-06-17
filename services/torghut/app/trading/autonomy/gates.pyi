from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
# ruff: noqa: F401,F811,F821
from typing import Any
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, cast

GateStatus: Any
UncertaintyGateAction: Any
PromotionTarget: Any

def _empty_str_list(*args: Any, **kwargs: Any) -> Any: ...
def _empty_artifact_refs(*args: Any, **kwargs: Any) -> Any: ...
def _empty_dict(*args: Any, **kwargs: Any) -> Any: ...

class GateResult:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    gate_id: str
    status: GateStatus
    reasons: list[str]
    artifact_refs: list[str]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class GateInputs:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    feature_schema_version: str
    required_feature_null_rate: Decimal
    staleness_ms_p95: int | None
    symbol_coverage: int
    metrics: dict[str, Any]
    robustness: dict[str, Any]
    tca_metrics: dict[str, Any]
    llm_metrics: dict[str, Any]
    forecast_metrics: dict[str, Any]
    profitability_evidence: dict[str, Any]
    fragility_state: str
    fragility_score: Decimal
    stability_mode_active: bool
    fragility_inputs_valid: bool
    operational_ready: bool
    runbook_validated: bool
    kill_switch_dry_run_passed: bool
    rollback_dry_run_passed: bool
    approval_token: str | None

class GatePolicyMatrix:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    policy_version: str
    required_feature_schema_version: str
    gate0_max_null_rate: Decimal
    gate0_max_staleness_ms: int
    gate0_min_symbol_coverage: int
    gate1_min_decision_count: int
    gate1_min_trade_count: int
    gate1_min_net_pnl: Decimal
    gate1_max_negative_fold_ratio: Decimal
    gate1_max_net_pnl_cv: Decimal
    gate2_max_drawdown: Decimal
    gate2_max_turnover_ratio: Decimal
    gate2_max_cost_bps: Decimal
    gate2_max_tca_slippage_bps: Decimal
    gate2_max_tca_shortfall_notional: Decimal
    gate2_max_tca_churn_ratio: Decimal
    gate2_max_tca_realized_shortfall_bps: Decimal
    gate2_max_tca_divergence_bps: Decimal
    gate2_max_tca_calibration_error_bps: Decimal
    gate2_min_tca_expected_shortfall_coverage: Decimal
    gate2_max_fragility_score: Decimal
    gate2_max_fragility_state_rank: int
    gate2_require_stability_mode_under_stress: bool
    gate3_max_llm_error_ratio: Decimal
    gate3_max_forecast_fallback_rate: Decimal
    gate3_max_forecast_latency_ms_p95: int
    gate3_min_forecast_calibration_score: Decimal
    gate6_require_profitability_evidence: bool
    gate6_min_market_net_pnl_delta: Decimal
    gate6_min_regime_slice_pass_ratio: Decimal
    gate6_min_return_over_drawdown: Decimal
    gate6_max_cost_bps: Decimal
    gate6_max_calibration_error: Decimal
    gate6_min_reproducibility_hashes: int
    gate6_require_janus_evidence: bool
    gate6_min_janus_event_count: int
    gate6_min_janus_reward_count: int
    gate7_target_coverage: Decimal
    gate7_max_coverage_error_pass: Decimal
    gate7_max_coverage_error_degrade: Decimal
    gate7_max_coverage_error_abstain: Decimal
    gate7_shift_score_degrade: Decimal
    gate7_shift_score_abstain: Decimal
    gate7_shift_score_fail: Decimal
    gate7_max_interval_width_pass: Decimal
    gate7_max_interval_width_degrade: Decimal
    gate5_live_enabled: bool
    gate5_require_approval_token: bool
    def from_path(*args: Any, **kwargs: Any) -> Any: ...
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class GateEvaluationReport:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    policy_version: str
    promotion_target: PromotionTarget
    promotion_allowed: bool
    recommended_mode: PromotionTarget
    gates: list[GateResult]
    reasons: list[str]
    uncertainty_gate_action: UncertaintyGateAction
    coverage_error: str | None
    conformal_interval_width: str | None
    shift_score: str | None
    recalibration_run_id: str | None
    evaluated_at: datetime
    code_version: str
    evidence_collection_allowed: bool
    promotion_blockers: list[str]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class UncertaintyGateOutcome:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    action: UncertaintyGateAction
    coverage_error: Decimal | None
    shift_score: Decimal | None
    avg_interval_width: Decimal | None
    recalibration_run_id: str | None

def evaluate_gate_matrix(*args: Any, **kwargs: Any) -> Any: ...
def _gate0_data_integrity(*args: Any, **kwargs: Any) -> Any: ...
def _gate1_statistical_robustness(*args: Any, **kwargs: Any) -> Any: ...
def _gate2_risk_and_capacity(*args: Any, **kwargs: Any) -> Any: ...
def _gate3_shadow_paper_quality(*args: Any, **kwargs: Any) -> Any: ...
def _gate4_operational_readiness(*args: Any, **kwargs: Any) -> Any: ...
def _gate5_live_ramp_readiness(*args: Any, **kwargs: Any) -> Any: ...
def _gate6_profitability_evidence(*args: Any, **kwargs: Any) -> Any: ...
def _gate7_uncertainty_calibration(*args: Any, **kwargs: Any) -> Any: ...
def _gate2_base_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _gate2_tca_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _gate6_early_result(*args: Any, **kwargs: Any) -> Any: ...
def _gate6_schema_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _gate6_threshold_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _gate6_reproducibility_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _gate6_janus_q_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _gate7_skipped_result(*args: Any, **kwargs: Any) -> Any: ...
def _gate7_input_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _gate7_action_with_reasons(*args: Any, **kwargs: Any) -> Any: ...
def _decimal(*args: Any, **kwargs: Any) -> Any: ...
def _abs_decimal(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_or_default(*args: Any, **kwargs: Any) -> Any: ...
def _dict_from_any(*args: Any, **kwargs: Any) -> Any: ...
def _int_or_default(*args: Any, **kwargs: Any) -> Any: ...
def _fragility_state_rank(*args: Any, **kwargs: Any) -> Any: ...

__all__: Any
