"""Gate policy matrix evaluator for Torghut v3 autonomous lanes."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, cast


GateStatus = Literal["pass", "fail"]
UncertaintyGateAction = Literal["pass", "degrade", "abstain", "fail"]
PromotionTarget = Literal["shadow", "paper", "live"]


def _empty_str_list() -> list[str]:
    return []


def _empty_artifact_refs() -> list[str]:
    return []


def _empty_dict() -> dict[str, Any]:
    return {}


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
    staleness_ms_p95: int
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

    def to_payload(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "promotion_target": self.promotion_target,
            "promotion_allowed": self.promotion_allowed,
            "recommended_mode": self.recommended_mode,
            "gates": [item.to_payload() for item in self.gates],
            "reasons": list(self.reasons),
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
    promotion_allowed = False

    if uncertainty_outcome.action in ("abstain", "fail"):
        promotion_allowed = False
        recommended_mode = "shadow"
    elif promotion_target == "shadow":
        promotion_allowed = all_required_pass
        recommended_mode = "shadow"
    elif promotion_target == "paper":
        promotion_allowed = all_required_pass
        recommended_mode = "paper" if all_required_pass else "shadow"
    elif promotion_target == "live":
        promotion_allowed = all_required_pass and gate5_pass
        if promotion_allowed:
            recommended_mode = "live"
        elif all_required_pass:
            recommended_mode = "paper"

    return GateEvaluationReport(
        policy_version=policy.policy_version,
        promotion_target=promotion_target,
        promotion_allowed=promotion_allowed,
        recommended_mode=recommended_mode,
        gates=gates,
        reasons=reasons,
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
    if inputs.staleness_ms_p95 > policy.gate0_max_staleness_ms:
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
    llm_error_ratio = _decimal(inputs.llm_metrics.get("error_ratio")) or Decimal("0")
    if llm_error_ratio > policy.gate3_max_llm_error_ratio:
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
    if (
        latency_ms_p95 is not None
        and latency_ms_p95 > Decimal(policy.gate3_max_forecast_latency_ms_p95)
    ):
        reasons.append("forecast_inference_latency_exceeds_threshold")
    calibration_score_min = _decimal(inputs.forecast_metrics.get("calibration_score_min"))
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

    return GateResult(
        gate_id="gate6_profitability_evidence",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def _gate7_uncertainty_calibration(
    inputs: GateInputs,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> tuple[GateResult, UncertaintyGateOutcome]:
    skipped = _gate7_skipped_result(policy, promotion_target)
    if skipped is not None:
        return skipped

    confidence = _dict_from_any(
        _dict_from_any(inputs.profitability_evidence).get("confidence_calibration")
    )
    coverage_error = _decimal(confidence.get("coverage_error"))
    shift_score = _decimal(confidence.get("shift_score"))
    avg_interval_width = _decimal(confidence.get("avg_interval_width"))
    target_coverage = _decimal(confidence.get("target_coverage"))
    observed_coverage = _decimal(confidence.get("observed_coverage"))
    recalibration_run_id_raw = confidence.get("recalibration_run_id")
    recalibration_run_id = (
        str(recalibration_run_id_raw).strip() if recalibration_run_id_raw else None
    )
    recalibration_artifact_ref = str(
        confidence.get("recalibration_artifact_ref", "")
    ).strip()
    reasons = _gate7_input_reasons(
        coverage_error=coverage_error,
        shift_score=shift_score,
        avg_interval_width=avg_interval_width,
        target_coverage=target_coverage,
        observed_coverage=observed_coverage,
        policy=policy,
    )
    action, reasons = _gate7_action_with_reasons(
        reasons=reasons,
        coverage_error=coverage_error,
        shift_score=shift_score,
        avg_interval_width=avg_interval_width,
        policy=policy,
    )

    if action in ("degrade", "abstain", "fail") and not recalibration_run_id:
        reasons.append("recalibration_run_id_missing")
    if action in ("degrade", "abstain", "fail") and not recalibration_artifact_ref:
        reasons.append("recalibration_artifact_missing")

    if action in ("degrade", "abstain", "fail"):
        reasons.append(f"uncertainty_gate_action_{action}")

    gate = GateResult(
        gate_id="gate7_uncertainty_calibration",
        status="pass" if action == "pass" else "fail",
        reasons=sorted(set(reasons)),
        artifact_refs=[recalibration_artifact_ref] if recalibration_artifact_ref else [],
    )
    outcome = UncertaintyGateOutcome(
        action=action,
        coverage_error=coverage_error,
        shift_score=shift_score,
        avg_interval_width=avg_interval_width,
        recalibration_run_id=recalibration_run_id,
    )
    return gate, outcome


def _gate2_base_reasons(inputs: GateInputs, policy: GatePolicyMatrix) -> list[str]:
    reasons: list[str] = []
    max_drawdown = _decimal(inputs.metrics.get("max_drawdown")) or Decimal("0")
    turnover_ratio = _decimal(inputs.metrics.get("turnover_ratio")) or Decimal("0")
    cost_bps = _decimal(inputs.metrics.get("cost_bps")) or Decimal("0")
    if max_drawdown > policy.gate2_max_drawdown:
        reasons.append("drawdown_exceeds_maximum")
    if turnover_ratio > policy.gate2_max_turnover_ratio:
        reasons.append("turnover_ratio_exceeds_maximum")
    if cost_bps > policy.gate2_max_cost_bps:
        reasons.append("cost_bps_exceeds_maximum")
    if inputs.fragility_score > policy.gate2_max_fragility_score:
        reasons.append("fragility_score_exceeds_maximum")
    fragility_rank = _fragility_state_rank(inputs.fragility_state)
    if fragility_rank > policy.gate2_max_fragility_state_rank:
        reasons.append("fragility_state_exceeds_maximum")
    if (
        policy.gate2_require_stability_mode_under_stress
        and fragility_rank >= _fragility_state_rank("stress")
        and not inputs.stability_mode_active
    ):
        reasons.append("fragility_stability_mode_inactive")
    return reasons


def _gate2_tca_reasons(inputs: GateInputs, policy: GatePolicyMatrix) -> list[str]:
    tca_order_count = int(inputs.tca_metrics.get("order_count", 0))
    if tca_order_count <= 0:
        return []
    reasons: list[str] = []
    avg_tca_slippage = _decimal(inputs.tca_metrics.get("avg_slippage_bps")) or Decimal(
        "0"
    )
    avg_tca_shortfall = _decimal(
        inputs.tca_metrics.get("avg_shortfall_notional")
    ) or Decimal("0")
    avg_tca_churn_ratio = _decimal(inputs.tca_metrics.get("avg_churn_ratio")) or Decimal(
        "0"
    )
    if avg_tca_slippage > policy.gate2_max_tca_slippage_bps:
        reasons.append("tca_slippage_exceeds_maximum")
    if avg_tca_shortfall > policy.gate2_max_tca_shortfall_notional:
        reasons.append("tca_shortfall_exceeds_maximum")
    if avg_tca_churn_ratio > policy.gate2_max_tca_churn_ratio:
        reasons.append("tca_churn_ratio_exceeds_maximum")
    return reasons


def _gate6_early_result(
    inputs: GateInputs,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> GateResult | None:
    if promotion_target == "shadow":
        return GateResult(gate_id="gate6_profitability_evidence", status="pass", reasons=[])
    if not policy.gate6_require_profitability_evidence:
        return GateResult(gate_id="gate6_profitability_evidence", status="pass", reasons=[])
    if not inputs.profitability_evidence:
        return GateResult(
            gate_id="gate6_profitability_evidence",
            status="fail",
            reasons=["profitability_evidence_missing"],
        )
    return None


def _gate6_schema_reasons(evidence: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    schema_version = str(evidence.get("schema_version", "")).strip()
    if schema_version != "profitability-evidence-v4":
        reasons.append("profitability_evidence_schema_invalid")
    benchmark = _dict_from_any(evidence.get("benchmark"))
    if str(benchmark.get("schema_version", "")).strip() != "profitability-benchmark-v4":
        reasons.append("profitability_benchmark_schema_invalid")
    validation = _dict_from_any(evidence.get("validation"))
    if not bool(validation.get("passed", False)):
        reasons.append("profitability_evidence_validation_failed")
    return reasons


def _gate6_threshold_reasons(
    evidence: dict[str, Any], policy: GatePolicyMatrix
) -> list[str]:
    reasons: list[str] = []
    risk_adjusted = _dict_from_any(evidence.get("risk_adjusted_metrics"))
    market_delta = _decimal(risk_adjusted.get("market_net_pnl_delta")) or Decimal("0")
    if market_delta < policy.gate6_min_market_net_pnl_delta:
        reasons.append("profitability_market_net_pnl_delta_below_threshold")
    regime_ratio = _decimal(risk_adjusted.get("regime_slice_pass_ratio")) or Decimal(
        "0"
    )
    if regime_ratio < policy.gate6_min_regime_slice_pass_ratio:
        reasons.append("profitability_regime_slice_ratio_below_threshold")
    return_over_drawdown = _decimal(risk_adjusted.get("return_over_drawdown")) or Decimal(
        "0"
    )
    if return_over_drawdown < policy.gate6_min_return_over_drawdown:
        reasons.append("profitability_return_over_drawdown_below_threshold")

    realism = _dict_from_any(evidence.get("cost_fill_realism"))
    cost_bps = _decimal(realism.get("cost_bps")) or Decimal("0")
    if cost_bps > policy.gate6_max_cost_bps:
        reasons.append("profitability_cost_bps_exceeds_threshold")

    confidence = _dict_from_any(evidence.get("confidence_calibration"))
    calibration_error = _decimal(confidence.get("calibration_error")) or Decimal("1")
    if calibration_error > policy.gate6_max_calibration_error:
        reasons.append("profitability_calibration_error_exceeds_threshold")
    return reasons


def _gate6_reproducibility_reasons(
    evidence: dict[str, Any], policy: GatePolicyMatrix
) -> list[str]:
    reproducibility = _dict_from_any(evidence.get("reproducibility"))
    artifact_hashes_raw = reproducibility.get("artifact_hashes")
    hash_count = 0
    if isinstance(artifact_hashes_raw, dict):
        artifact_hashes = cast(dict[str, Any], artifact_hashes_raw)
        hash_count = len(artifact_hashes)
    if hash_count < policy.gate6_min_reproducibility_hashes:
        return ["profitability_reproducibility_hashes_below_threshold"]
    return []


def _gate7_skipped_result(
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> tuple[GateResult, UncertaintyGateOutcome] | None:
    if policy.gate6_require_profitability_evidence and promotion_target != "shadow":
        return None
    outcome = UncertaintyGateOutcome(
        action="pass",
        coverage_error=Decimal("0"),
        shift_score=Decimal("0"),
        avg_interval_width=Decimal("0"),
        recalibration_run_id=None,
    )
    return GateResult(gate_id="gate7_uncertainty_calibration", status="pass"), outcome


def _gate7_input_reasons(
    *,
    coverage_error: Decimal | None,
    shift_score: Decimal | None,
    avg_interval_width: Decimal | None,
    target_coverage: Decimal | None,
    observed_coverage: Decimal | None,
    policy: GatePolicyMatrix,
) -> list[str]:
    reasons: list[str] = []
    if (
        coverage_error is None
        or shift_score is None
        or avg_interval_width is None
        or target_coverage is None
        or observed_coverage is None
    ):
        reasons.append("uncertainty_inputs_missing_or_invalid")
    elif (
        coverage_error < 0
        or shift_score < 0
        or shift_score > 1
        or avg_interval_width < 0
        or target_coverage < 0
        or target_coverage > 1
        or observed_coverage < 0
        or observed_coverage > 1
    ):
        reasons.append("uncertainty_inputs_out_of_range")
    if target_coverage is not None and target_coverage != policy.gate7_target_coverage:
        reasons.append("uncertainty_target_coverage_mismatch")
    return reasons


def _gate7_action_with_reasons(
    *,
    reasons: list[str],
    coverage_error: Decimal | None,
    shift_score: Decimal | None,
    avg_interval_width: Decimal | None,
    policy: GatePolicyMatrix,
) -> tuple[UncertaintyGateAction, list[str]]:
    derived_reasons = list(reasons)
    if derived_reasons:
        return "abstain", derived_reasons
    if coverage_error is None or shift_score is None or avg_interval_width is None:
        derived_reasons.append("uncertainty_inputs_missing_or_invalid")
        return "abstain", derived_reasons

    if shift_score >= policy.gate7_shift_score_fail:
        derived_reasons.append("regime_shift_score_fail_threshold_exceeded")
        return "fail", derived_reasons
    if (
        coverage_error > policy.gate7_max_coverage_error_abstain
        or shift_score >= policy.gate7_shift_score_abstain
        or avg_interval_width > policy.gate7_max_interval_width_degrade
    ):
        derived_reasons.append("uncertainty_abstain_threshold_exceeded")
        return "abstain", derived_reasons
    if (
        coverage_error > policy.gate7_max_coverage_error_degrade
        or shift_score >= policy.gate7_shift_score_degrade
        or avg_interval_width > policy.gate7_max_interval_width_pass
    ):
        derived_reasons.append("uncertainty_degrade_threshold_exceeded")
        return "degrade", derived_reasons
    if coverage_error > policy.gate7_max_coverage_error_pass:
        derived_reasons.append("coverage_error_slo_exceeded")
        return "degrade", derived_reasons
    return "pass", derived_reasons


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _decimal_or_default(value: Any, default: Decimal) -> Decimal:
    parsed = _decimal(value)
    if parsed is None:
        return default
    return parsed


def _dict_from_any(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], value)


def _fragility_state_rank(state: str) -> int:
    normalized = state.strip().lower()
    ranks = {"normal": 0, "elevated": 1, "stress": 2, "crisis": 3}
    return ranks.get(normalized, 1)


__all__ = [
    "GateEvaluationReport",
    "GateInputs",
    "GatePolicyMatrix",
    "GateResult",
    "PromotionTarget",
    "evaluate_gate_matrix",
]
