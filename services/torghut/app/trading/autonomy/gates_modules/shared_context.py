# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Gate policy matrix evaluator for Torghut v3 autonomous lanes."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, cast

# ruff: noqa: F401,F811,F821


GateStatus = Literal["pass", "fail"]

UncertaintyGateAction = Literal["pass", "degrade", "abstain", "fail"]

PromotionTarget = Literal["shadow", "paper", "live"]


def _empty_str_list() -> list[str]:
    return []


def _empty_artifact_refs() -> list[str]:
    return []


def _empty_dict() -> dict[str, Any]:
    return {}


def _decimal_or_default(value: Any, default: Decimal) -> Decimal:
    if value is None:
        return default
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return default


def _gate7_helpers() -> Any:
    import importlib

    return importlib.import_module(f"{__package__}.gate7_uncertainty_calibration")


def _decimal(value: Any) -> Decimal | None:
    return _gate7_helpers()._decimal(value)


def _gate2_base_reasons(*args: Any, **kwargs: Any) -> list[str]:
    return _gate7_helpers()._gate2_base_reasons(*args, **kwargs)


def _gate2_tca_reasons(*args: Any, **kwargs: Any) -> list[str]:
    return _gate7_helpers()._gate2_tca_reasons(*args, **kwargs)


def _gate6_early_result(*args: Any, **kwargs: Any) -> Any:
    return _gate7_helpers()._gate6_early_result(*args, **kwargs)


def _gate6_schema_reasons(*args: Any, **kwargs: Any) -> list[str]:
    return _gate7_helpers()._gate6_schema_reasons(*args, **kwargs)


def _gate6_threshold_reasons(*args: Any, **kwargs: Any) -> list[str]:
    return _gate7_helpers()._gate6_threshold_reasons(*args, **kwargs)


def _gate6_reproducibility_reasons(*args: Any, **kwargs: Any) -> list[str]:
    return _gate7_helpers()._gate6_reproducibility_reasons(*args, **kwargs)


def _gate6_janus_q_reasons(*args: Any, **kwargs: Any) -> list[str]:
    return _gate7_helpers()._gate6_janus_q_reasons(*args, **kwargs)


def _gate7_uncertainty_calibration(*args: Any, **kwargs: Any) -> Any:
    return _gate7_helpers()._gate7_uncertainty_calibration(*args, **kwargs)


@dataclass(frozen=True)
class GateResult:
    gate_id: str
    status: GateStatus
    reasons: list[str] = field(default_factory=_empty_str_list)
    artifact_refs: list[str] = field(default_factory=_empty_artifact_refs)

    def to_payload(self) -> dict[str, object]:
        return {
            "gate_id": self.gate_id,
            "status": self.status,
            "reasons": list(self.reasons),
            "artifact_refs": list(self.artifact_refs),
        }


@dataclass(frozen=True)
class GateInputs:
    feature_schema_version: str
    required_feature_null_rate: Decimal
    staleness_ms_p95: int | None
    symbol_coverage: int
    metrics: dict[str, Any]
    robustness: dict[str, Any]
    tca_metrics: dict[str, Any] = field(default_factory=_empty_dict)
    llm_metrics: dict[str, Any] = field(default_factory=_empty_dict)
    forecast_metrics: dict[str, Any] = field(default_factory=_empty_dict)
    profitability_evidence: dict[str, Any] = field(default_factory=_empty_dict)
    fragility_state: str = "elevated"
    fragility_score: Decimal = Decimal("0.5")
    stability_mode_active: bool = False
    fragility_inputs_valid: bool = True
    operational_ready: bool = True
    runbook_validated: bool = True
    kill_switch_dry_run_passed: bool = True
    rollback_dry_run_passed: bool = True
    approval_token: str | None = None


@dataclass(frozen=True)
class GatePolicyMatrix:
    policy_version: str = "v3-gates-1"
    required_feature_schema_version: str = "3.0.0"
    gate0_max_null_rate: Decimal = Decimal("0.01")
    gate0_max_staleness_ms: int = 120000
    gate0_min_symbol_coverage: int = 1

    gate1_min_decision_count: int = 1
    gate1_min_trade_count: int = 1
    gate1_min_net_pnl: Decimal = Decimal("0")
    gate1_max_negative_fold_ratio: Decimal = Decimal("0.5")
    gate1_max_net_pnl_cv: Decimal = Decimal("2.0")

    gate2_max_drawdown: Decimal = Decimal("250")
    gate2_max_turnover_ratio: Decimal = Decimal("8.0")
    gate2_max_cost_bps: Decimal = Decimal("35")
    gate2_max_tca_slippage_bps: Decimal = Decimal("25")
    gate2_max_tca_shortfall_notional: Decimal = Decimal("25")
    gate2_max_tca_churn_ratio: Decimal = Decimal("0.75")
    gate2_max_tca_realized_shortfall_bps: Decimal = Decimal("25")
    gate2_max_tca_divergence_bps: Decimal = Decimal("12")
    gate2_max_tca_calibration_error_bps: Decimal = Decimal("12")
    gate2_min_tca_expected_shortfall_coverage: Decimal = Decimal("0")
    gate2_max_fragility_score: Decimal = Decimal("0.85")
    gate2_max_fragility_state_rank: int = 2
    gate2_require_stability_mode_under_stress: bool = True

    gate3_max_llm_error_ratio: Decimal = Decimal("0.10")
    gate3_max_forecast_fallback_rate: Decimal = Decimal("0.05")
    gate3_max_forecast_latency_ms_p95: int = 200
    gate3_min_forecast_calibration_score: Decimal = Decimal("0.85")
    gate6_require_profitability_evidence: bool = True
    gate6_min_market_net_pnl_delta: Decimal = Decimal("0")
    gate6_min_regime_slice_pass_ratio: Decimal = Decimal("0.50")
    gate6_min_return_over_drawdown: Decimal = Decimal("0")
    gate6_max_cost_bps: Decimal = Decimal("35")
    gate6_max_calibration_error: Decimal = Decimal("0.45")
    gate6_min_reproducibility_hashes: int = 5
    gate6_require_janus_evidence: bool = True
    gate6_min_janus_event_count: int = 1
    gate6_min_janus_reward_count: int = 1
    gate7_target_coverage: Decimal = Decimal("0.90")
    gate7_max_coverage_error_pass: Decimal = Decimal("0.03")
    gate7_max_coverage_error_degrade: Decimal = Decimal("0.05")
    gate7_max_coverage_error_abstain: Decimal = Decimal("0.08")
    gate7_shift_score_degrade: Decimal = Decimal("0.60")
    gate7_shift_score_abstain: Decimal = Decimal("0.80")
    gate7_shift_score_fail: Decimal = Decimal("0.95")
    gate7_max_interval_width_pass: Decimal = Decimal("1.25")
    gate7_max_interval_width_degrade: Decimal = Decimal("1.75")

    gate5_live_enabled: bool = False
    gate5_require_approval_token: bool = True

    @classmethod
    def from_path(cls, path: Path) -> "GatePolicyMatrix":
        payload = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            policy_version=str(payload.get("policy_version", "v3-gates-1")),
            required_feature_schema_version=str(
                payload.get("required_feature_schema_version", "3.0.0")
            ),
            gate0_max_null_rate=_decimal_or_default(
                payload.get("gate0_max_null_rate"), Decimal("0.01")
            ),
            gate0_max_staleness_ms=int(payload.get("gate0_max_staleness_ms", 120000)),
            gate0_min_symbol_coverage=int(payload.get("gate0_min_symbol_coverage", 1)),
            gate1_min_decision_count=int(payload.get("gate1_min_decision_count", 1)),
            gate1_min_trade_count=int(payload.get("gate1_min_trade_count", 1)),
            gate1_min_net_pnl=_decimal_or_default(
                payload.get("gate1_min_net_pnl"), Decimal("0")
            ),
            gate1_max_negative_fold_ratio=_decimal_or_default(
                payload.get("gate1_max_negative_fold_ratio"),
                Decimal("0.5"),
            ),
            gate1_max_net_pnl_cv=_decimal_or_default(
                payload.get("gate1_max_net_pnl_cv"), Decimal("2.0")
            ),
            gate2_max_drawdown=_decimal_or_default(
                payload.get("gate2_max_drawdown"), Decimal("250")
            ),
            gate2_max_turnover_ratio=_decimal_or_default(
                payload.get("gate2_max_turnover_ratio"), Decimal("8.0")
            ),
            gate2_max_cost_bps=_decimal_or_default(
                payload.get("gate2_max_cost_bps"), Decimal("35")
            ),
            gate2_max_tca_slippage_bps=_decimal_or_default(
                payload.get("gate2_max_tca_slippage_bps"), Decimal("25")
            ),
            gate2_max_tca_shortfall_notional=_decimal_or_default(
                payload.get("gate2_max_tca_shortfall_notional"),
                Decimal("25"),
            ),
            gate2_max_tca_churn_ratio=_decimal_or_default(
                payload.get("gate2_max_tca_churn_ratio"), Decimal("0.75")
            ),
            gate2_max_tca_realized_shortfall_bps=_decimal_or_default(
                payload.get("gate2_max_tca_realized_shortfall_bps"), Decimal("25")
            ),
            gate2_max_tca_divergence_bps=_decimal_or_default(
                payload.get("gate2_max_tca_divergence_bps"), Decimal("12")
            ),
            gate2_max_tca_calibration_error_bps=_decimal_or_default(
                payload.get("gate2_max_tca_calibration_error_bps"),
                Decimal("12"),
            ),
            gate2_min_tca_expected_shortfall_coverage=_decimal_or_default(
                payload.get("gate2_min_tca_expected_shortfall_coverage"), Decimal("0")
            ),
            gate2_max_fragility_score=_decimal_or_default(
                payload.get("gate2_max_fragility_score"), Decimal("0.85")
            ),
            gate2_max_fragility_state_rank=int(
                payload.get("gate2_max_fragility_state_rank", 2)
            ),
            gate2_require_stability_mode_under_stress=bool(
                payload.get("gate2_require_stability_mode_under_stress", True)
            ),
            gate3_max_llm_error_ratio=_decimal_or_default(
                payload.get("gate3_max_llm_error_ratio"), Decimal("0.10")
            ),
            gate3_max_forecast_fallback_rate=_decimal_or_default(
                payload.get("gate3_max_forecast_fallback_rate"), Decimal("0.05")
            ),
            gate3_max_forecast_latency_ms_p95=int(
                payload.get("gate3_max_forecast_latency_ms_p95", 200)
            ),
            gate3_min_forecast_calibration_score=_decimal_or_default(
                payload.get("gate3_min_forecast_calibration_score"), Decimal("0.85")
            ),
            gate6_require_profitability_evidence=bool(
                payload.get("gate6_require_profitability_evidence", True)
            ),
            gate6_min_market_net_pnl_delta=_decimal_or_default(
                payload.get("gate6_min_market_net_pnl_delta"),
                Decimal("0"),
            ),
            gate6_min_regime_slice_pass_ratio=_decimal_or_default(
                payload.get("gate6_min_regime_slice_pass_ratio"),
                Decimal("0.50"),
            ),
            gate6_min_return_over_drawdown=_decimal_or_default(
                payload.get("gate6_min_return_over_drawdown"),
                Decimal("0"),
            ),
            gate6_max_cost_bps=_decimal_or_default(
                payload.get("gate6_max_cost_bps"), Decimal("35")
            ),
            gate6_max_calibration_error=_decimal_or_default(
                payload.get("gate6_max_calibration_error"),
                Decimal("0.45"),
            ),
            gate6_min_reproducibility_hashes=int(
                payload.get("gate6_min_reproducibility_hashes", 5)
            ),
            gate6_require_janus_evidence=bool(
                payload.get("gate6_require_janus_evidence", True)
            ),
            gate6_min_janus_event_count=int(
                payload.get("gate6_min_janus_event_count", 1)
            ),
            gate6_min_janus_reward_count=int(
                payload.get("gate6_min_janus_reward_count", 1)
            ),
            gate7_target_coverage=_decimal_or_default(
                payload.get("gate7_target_coverage"),
                Decimal("0.90"),
            ),
            gate7_max_coverage_error_pass=_decimal_or_default(
                payload.get("gate7_max_coverage_error_pass"),
                Decimal("0.03"),
            ),
            gate7_max_coverage_error_degrade=_decimal_or_default(
                payload.get("gate7_max_coverage_error_degrade"),
                Decimal("0.05"),
            ),
            gate7_max_coverage_error_abstain=_decimal_or_default(
                payload.get("gate7_max_coverage_error_abstain"),
                Decimal("0.08"),
            ),
            gate7_shift_score_degrade=_decimal_or_default(
                payload.get("gate7_shift_score_degrade"),
                Decimal("0.60"),
            ),
            gate7_shift_score_abstain=_decimal_or_default(
                payload.get("gate7_shift_score_abstain"),
                Decimal("0.80"),
            ),
            gate7_shift_score_fail=_decimal_or_default(
                payload.get("gate7_shift_score_fail"),
                Decimal("0.95"),
            ),
            gate7_max_interval_width_pass=_decimal_or_default(
                payload.get("gate7_max_interval_width_pass"),
                Decimal("1.25"),
            ),
            gate7_max_interval_width_degrade=_decimal_or_default(
                payload.get("gate7_max_interval_width_degrade"),
                Decimal("1.75"),
            ),
            gate5_live_enabled=bool(payload.get("gate5_live_enabled", False)),
            gate5_require_approval_token=bool(
                payload.get("gate5_require_approval_token", True)
            ),
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "required_feature_schema_version": self.required_feature_schema_version,
            "gate0_max_null_rate": str(self.gate0_max_null_rate),
            "gate0_max_staleness_ms": self.gate0_max_staleness_ms,
            "gate0_min_symbol_coverage": self.gate0_min_symbol_coverage,
            "gate1_min_decision_count": self.gate1_min_decision_count,
            "gate1_min_trade_count": self.gate1_min_trade_count,
            "gate1_min_net_pnl": str(self.gate1_min_net_pnl),
            "gate1_max_negative_fold_ratio": str(self.gate1_max_negative_fold_ratio),
            "gate1_max_net_pnl_cv": str(self.gate1_max_net_pnl_cv),
            "gate2_max_drawdown": str(self.gate2_max_drawdown),
            "gate2_max_turnover_ratio": str(self.gate2_max_turnover_ratio),
            "gate2_max_cost_bps": str(self.gate2_max_cost_bps),
            "gate2_max_tca_slippage_bps": str(self.gate2_max_tca_slippage_bps),
            "gate2_max_tca_shortfall_notional": str(
                self.gate2_max_tca_shortfall_notional
            ),
            "gate2_max_tca_churn_ratio": str(self.gate2_max_tca_churn_ratio),
            "gate2_max_tca_realized_shortfall_bps": str(
                self.gate2_max_tca_realized_shortfall_bps
            ),
            "gate2_max_tca_divergence_bps": str(self.gate2_max_tca_divergence_bps),
            "gate2_max_tca_calibration_error_bps": str(
                self.gate2_max_tca_calibration_error_bps
            ),
            "gate2_min_tca_expected_shortfall_coverage": str(
                self.gate2_min_tca_expected_shortfall_coverage
            ),
            "gate2_max_fragility_score": str(self.gate2_max_fragility_score),
            "gate2_max_fragility_state_rank": self.gate2_max_fragility_state_rank,
            "gate2_require_stability_mode_under_stress": self.gate2_require_stability_mode_under_stress,
            "gate3_max_llm_error_ratio": str(self.gate3_max_llm_error_ratio),
            "gate3_max_forecast_fallback_rate": str(
                self.gate3_max_forecast_fallback_rate
            ),
            "gate3_max_forecast_latency_ms_p95": self.gate3_max_forecast_latency_ms_p95,
            "gate3_min_forecast_calibration_score": str(
                self.gate3_min_forecast_calibration_score
            ),
            "gate6_require_profitability_evidence": self.gate6_require_profitability_evidence,
            "gate6_min_market_net_pnl_delta": str(self.gate6_min_market_net_pnl_delta),
            "gate6_min_regime_slice_pass_ratio": str(
                self.gate6_min_regime_slice_pass_ratio
            ),
            "gate6_min_return_over_drawdown": str(self.gate6_min_return_over_drawdown),
            "gate6_max_cost_bps": str(self.gate6_max_cost_bps),
            "gate6_max_calibration_error": str(self.gate6_max_calibration_error),
            "gate6_min_reproducibility_hashes": self.gate6_min_reproducibility_hashes,
            "gate6_require_janus_evidence": self.gate6_require_janus_evidence,
            "gate6_min_janus_event_count": self.gate6_min_janus_event_count,
            "gate6_min_janus_reward_count": self.gate6_min_janus_reward_count,
            "gate7_target_coverage": str(self.gate7_target_coverage),
            "gate7_max_coverage_error_pass": str(self.gate7_max_coverage_error_pass),
            "gate7_max_coverage_error_degrade": str(
                self.gate7_max_coverage_error_degrade
            ),
            "gate7_max_coverage_error_abstain": str(
                self.gate7_max_coverage_error_abstain
            ),
            "gate7_shift_score_degrade": str(self.gate7_shift_score_degrade),
            "gate7_shift_score_abstain": str(self.gate7_shift_score_abstain),
            "gate7_shift_score_fail": str(self.gate7_shift_score_fail),
            "gate7_max_interval_width_pass": str(self.gate7_max_interval_width_pass),
            "gate7_max_interval_width_degrade": str(
                self.gate7_max_interval_width_degrade
            ),
            "gate5_live_enabled": self.gate5_live_enabled,
            "gate5_require_approval_token": self.gate5_require_approval_token,
        }


@dataclass(frozen=True)
class GateEvaluationReport:
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
    evidence_collection_allowed: bool = False
    promotion_blockers: list[str] = field(default_factory=_empty_str_list)

    def to_payload(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "promotion_target": self.promotion_target,
            "promotion_allowed": self.promotion_allowed,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "evidence_collection_allowed": self.evidence_collection_allowed,
            "bounded_evidence_collection_authorized": self.evidence_collection_allowed,
            "authority_source": "autonomy_gate_status_only",
            "recommended_mode": self.recommended_mode,
            "gates": [item.to_payload() for item in self.gates],
            "reasons": list(self.reasons),
            "promotion_blockers": list(self.promotion_blockers),
            "uncertainty_gate_action": self.uncertainty_gate_action,
            "coverage_error": self.coverage_error,
            "conformal_interval_width": self.conformal_interval_width,
            "shift_score": self.shift_score,
            "recalibration_run_id": self.recalibration_run_id,
            "evaluated_at": self.evaluated_at.isoformat(),
            "code_version": self.code_version,
        }


@dataclass(frozen=True)
class UncertaintyGateOutcome:
    action: UncertaintyGateAction
    coverage_error: Decimal | None
    shift_score: Decimal | None
    avg_interval_width: Decimal | None
    recalibration_run_id: str | None


def evaluate_gate_matrix(
    inputs: GateInputs,
    *,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
    code_version: str,
    evaluated_at: datetime | None = None,
) -> GateEvaluationReport:
    now = evaluated_at or datetime.now(timezone.utc)
    gates: list[GateResult] = []

    gates.append(_gate0_data_integrity(inputs, policy))
    gates.append(_gate1_statistical_robustness(inputs, policy))
    gates.append(_gate2_risk_and_capacity(inputs, policy))
    gates.append(_gate3_shadow_paper_quality(inputs, policy))
    gates.append(_gate4_operational_readiness(inputs))
    gates.append(_gate6_profitability_evidence(inputs, policy, promotion_target))
    uncertainty_gate, uncertainty_outcome = _gate7_uncertainty_calibration(
        inputs, policy, promotion_target
    )
    gates.append(uncertainty_gate)
    gates.append(_gate5_live_ramp_readiness(inputs, policy, promotion_target))

    gate_index = {gate.gate_id: gate for gate in gates}
    all_required_pass = all(
        gate_index.get(gate_id, GateResult(gate_id=gate_id, status="fail")).status
        == "pass"
        for gate_id in (
            "gate0_data_integrity",
            "gate1_statistical_robustness",
            "gate2_risk_capacity",
            "gate3_shadow_paper_quality",
            "gate4_operational_readiness",
            "gate6_profitability_evidence",
            "gate7_uncertainty_calibration",
        )
    )
    gate5_pass = (
        gate_index.get(
            "gate5_live_ramp_readiness",
            GateResult(gate_id="gate5_live_ramp_readiness", status="fail"),
        ).status
        == "pass"
    )

    reasons = [reason for gate in gates for reason in gate.reasons]
    recommended_mode: PromotionTarget = "shadow"
    evidence_collection_allowed = False
    promotion_blockers = ["autonomy_gate_not_runtime_ledger_authority"]

    if uncertainty_outcome.action in ("abstain", "fail"):
        recommended_mode = "shadow"
    elif promotion_target == "shadow":
        evidence_collection_allowed = all_required_pass
        recommended_mode = "shadow"
    elif promotion_target == "paper":
        evidence_collection_allowed = all_required_pass
        recommended_mode = "paper" if all_required_pass else "shadow"
    elif promotion_target == "live":
        evidence_collection_allowed = all_required_pass and gate5_pass
        if all_required_pass:
            recommended_mode = "paper"

    return GateEvaluationReport(
        policy_version=policy.policy_version,
        promotion_target=promotion_target,
        promotion_allowed=False,
        evidence_collection_allowed=evidence_collection_allowed,
        recommended_mode=recommended_mode,
        gates=gates,
        reasons=reasons,
        promotion_blockers=promotion_blockers,
        uncertainty_gate_action=uncertainty_outcome.action,
        coverage_error=(
            str(uncertainty_outcome.coverage_error)
            if uncertainty_outcome.coverage_error is not None
            else None
        ),
        conformal_interval_width=(
            str(uncertainty_outcome.avg_interval_width)
            if uncertainty_outcome.avg_interval_width is not None
            else None
        ),
        shift_score=(
            str(uncertainty_outcome.shift_score)
            if uncertainty_outcome.shift_score is not None
            else None
        ),
        recalibration_run_id=uncertainty_outcome.recalibration_run_id,
        evaluated_at=now,
        code_version=code_version,
    )


def _gate0_data_integrity(inputs: GateInputs, policy: GatePolicyMatrix) -> GateResult:
    reasons: list[str] = []
    if inputs.feature_schema_version != policy.required_feature_schema_version:
        reasons.append("schema_version_incompatible")
    if inputs.required_feature_null_rate > policy.gate0_max_null_rate:
        reasons.append("required_feature_null_rate_exceeds_threshold")
    if inputs.staleness_ms_p95 is None:
        reasons.append("feature_staleness_missing")
    elif inputs.staleness_ms_p95 > policy.gate0_max_staleness_ms:
        reasons.append("feature_staleness_exceeds_budget")
    if inputs.symbol_coverage < policy.gate0_min_symbol_coverage:
        reasons.append("symbol_coverage_below_minimum")
    return GateResult(
        gate_id="gate0_data_integrity",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def _gate1_statistical_robustness(
    inputs: GateInputs, policy: GatePolicyMatrix
) -> GateResult:
    reasons: list[str] = []
    decision_count = int(inputs.metrics.get("decision_count", 0))
    trade_count = int(inputs.metrics.get("trade_count", 0))
    net_pnl = _decimal(inputs.metrics.get("net_pnl")) or Decimal("0")
    fold_count = int(inputs.robustness.get("fold_count", 0))
    negative_fold_count = int(inputs.robustness.get("negative_fold_count", 0))
    net_pnl_cv = _decimal(inputs.robustness.get("net_pnl_cv"))

    if decision_count < policy.gate1_min_decision_count:
        reasons.append("decision_count_below_minimum")
    if trade_count < policy.gate1_min_trade_count:
        reasons.append("trade_count_below_minimum")
    if net_pnl < policy.gate1_min_net_pnl:
        reasons.append("net_pnl_below_minimum")

    if fold_count > 0:
        negative_ratio = Decimal(negative_fold_count) / Decimal(fold_count)
        if negative_ratio > policy.gate1_max_negative_fold_ratio:
            reasons.append("negative_fold_ratio_exceeds_threshold")
    if net_pnl_cv is not None and net_pnl_cv > policy.gate1_max_net_pnl_cv:
        reasons.append("net_pnl_cv_exceeds_threshold")

    return GateResult(
        gate_id="gate1_statistical_robustness",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def _gate2_risk_and_capacity(
    inputs: GateInputs, policy: GatePolicyMatrix
) -> GateResult:
    reasons = _gate2_base_reasons(inputs, policy)
    reasons.extend(_gate2_tca_reasons(inputs, policy))

    return GateResult(
        gate_id="gate2_risk_capacity",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def _gate3_shadow_paper_quality(
    inputs: GateInputs, policy: GatePolicyMatrix
) -> GateResult:
    reasons: list[str] = []
    llm_error_ratio = _decimal(inputs.llm_metrics.get("error_ratio"))
    if llm_error_ratio is None:
        reasons.append("llm_error_ratio_missing")
    elif llm_error_ratio > policy.gate3_max_llm_error_ratio:
        reasons.append("llm_error_ratio_exceeds_threshold")
    fallback_rate = _decimal(inputs.forecast_metrics.get("fallback_rate"))
    if fallback_rate is None:
        reasons.append("forecast_fallback_rate_missing")
    if (
        fallback_rate is not None
        and fallback_rate > policy.gate3_max_forecast_fallback_rate
    ):
        reasons.append("forecast_fallback_rate_exceeds_threshold")
    latency_ms_p95 = _decimal(inputs.forecast_metrics.get("inference_latency_ms_p95"))
    if latency_ms_p95 is None:
        reasons.append("forecast_inference_latency_p95_missing")
    if latency_ms_p95 is not None and latency_ms_p95 > Decimal(
        policy.gate3_max_forecast_latency_ms_p95
    ):
        reasons.append("forecast_inference_latency_exceeds_threshold")
    calibration_score_min = _decimal(
        inputs.forecast_metrics.get("calibration_score_min")
    )
    if calibration_score_min is None:
        reasons.append("forecast_calibration_score_missing")
    if (
        calibration_score_min is not None
        and calibration_score_min < policy.gate3_min_forecast_calibration_score
    ):
        reasons.append("forecast_calibration_score_below_threshold")
    return GateResult(
        gate_id="gate3_shadow_paper_quality",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def _gate4_operational_readiness(inputs: GateInputs) -> GateResult:
    reasons: list[str] = []
    if not inputs.operational_ready:
        reasons.append("operational_readiness_incomplete")
    if not inputs.runbook_validated:
        reasons.append("runbook_not_validated")
    if not inputs.kill_switch_dry_run_passed:
        reasons.append("kill_switch_dry_run_failed")
    if not inputs.rollback_dry_run_passed:
        reasons.append("rollback_dry_run_failed")
    return GateResult(
        gate_id="gate4_operational_readiness",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def _gate5_live_ramp_readiness(
    inputs: GateInputs,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> GateResult:
    reasons: list[str] = []
    if promotion_target != "live":
        return GateResult(
            gate_id="gate5_live_ramp_readiness", status="pass", reasons=[]
        )

    if not policy.gate5_live_enabled:
        reasons.append("live_rollout_disabled_by_policy")
    if policy.gate5_require_approval_token and not inputs.approval_token:
        reasons.append("approval_token_missing")

    return GateResult(
        gate_id="gate5_live_ramp_readiness",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def _gate6_profitability_evidence(
    inputs: GateInputs,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> GateResult:
    early_result = _gate6_early_result(inputs, policy, promotion_target)
    if early_result is not None:
        return early_result
    evidence = inputs.profitability_evidence
    reasons: list[str] = []
    reasons.extend(_gate6_schema_reasons(evidence))
    reasons.extend(_gate6_threshold_reasons(evidence, policy))
    reasons.extend(_gate6_reproducibility_reasons(evidence, policy))
    reasons.extend(_gate6_janus_q_reasons(evidence, policy))

    return GateResult(
        gate_id="gate6_profitability_evidence",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


__all__ = (
    "GateStatus",
    "UncertaintyGateAction",
    "PromotionTarget",
    "GateResult",
    "GateInputs",
    "GatePolicyMatrix",
    "GateEvaluationReport",
    "UncertaintyGateOutcome",
    "evaluate_gate_matrix",
)

# Public aliases used by split modules.
empty_artifact_refs = _empty_artifact_refs
empty_dict = _empty_dict
empty_str_list = _empty_str_list
gate0_data_integrity = _gate0_data_integrity
gate1_statistical_robustness = _gate1_statistical_robustness
gate2_risk_and_capacity = _gate2_risk_and_capacity
gate3_shadow_paper_quality = _gate3_shadow_paper_quality
gate4_operational_readiness = _gate4_operational_readiness
gate5_live_ramp_readiness = _gate5_live_ramp_readiness
gate6_profitability_evidence = _gate6_profitability_evidence
