"""Gate policy matrix evaluator for Torghut v3 autonomous lanes."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from .gate_contracts import (
    GateEvaluationReport,
    GateInputs,
    GatePolicyMatrix,
    GateResult,
    GateStatus,
    PromotionTarget,
    UncertaintyGateAction,
    UncertaintyGateOutcome,
    empty_artifact_refs,
    empty_dict,
    empty_str_list,
)
from .gate7_uncertainty_calibration import (
    decimal as _decimal,
    gate2_base_reasons,
    gate2_tca_reasons,
    gate6_early_result,
    gate6_janus_q_reasons,
    gate6_reproducibility_reasons,
    gate6_schema_reasons,
    gate6_threshold_reasons,
    gate7_uncertainty_calibration,
)


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

    gates.append(gate0_data_integrity(inputs, policy))
    gates.append(gate1_statistical_robustness(inputs, policy))
    gates.append(gate2_risk_and_capacity(inputs, policy))
    gates.append(gate3_shadow_paper_quality(inputs, policy))
    gates.append(gate4_operational_readiness(inputs))
    gates.append(gate6_profitability_evidence(inputs, policy, promotion_target))
    uncertainty_gate, uncertainty_outcome = gate7_uncertainty_calibration(
        inputs, policy, promotion_target
    )
    gates.append(uncertainty_gate)
    gates.append(gate5_live_ramp_readiness(inputs, policy, promotion_target))

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


def gate0_data_integrity(inputs: GateInputs, policy: GatePolicyMatrix) -> GateResult:
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


def gate1_statistical_robustness(
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


def gate2_risk_and_capacity(inputs: GateInputs, policy: GatePolicyMatrix) -> GateResult:
    reasons = gate2_base_reasons(inputs, policy)
    reasons.extend(gate2_tca_reasons(inputs, policy))

    return GateResult(
        gate_id="gate2_risk_capacity",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


def gate3_shadow_paper_quality(
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


def gate4_operational_readiness(inputs: GateInputs) -> GateResult:
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


def gate5_live_ramp_readiness(
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


def gate6_profitability_evidence(
    inputs: GateInputs,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> GateResult:
    early_result = gate6_early_result(inputs, policy, promotion_target)
    if early_result is not None:
        return early_result
    evidence = inputs.profitability_evidence
    reasons: list[str] = []
    reasons.extend(gate6_schema_reasons(evidence))
    reasons.extend(gate6_threshold_reasons(evidence, policy))
    reasons.extend(gate6_reproducibility_reasons(evidence, policy))
    reasons.extend(gate6_janus_q_reasons(evidence, policy))

    return GateResult(
        gate_id="gate6_profitability_evidence",
        status="pass" if not reasons else "fail",
        reasons=reasons,
    )


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "GateEvaluationReport",
    "GateInputs",
    "GatePolicyMatrix",
    "GateResult",
    "GateStatus",
    "PromotionTarget",
    "UncertaintyGateAction",
    "UncertaintyGateOutcome",
    "empty_artifact_refs",
    "empty_dict",
    "empty_str_list",
    "evaluate_gate_matrix",
    "gate0_data_integrity",
    "gate1_statistical_robustness",
    "gate2_risk_and_capacity",
    "gate3_shadow_paper_quality",
    "gate4_operational_readiness",
    "gate5_live_ramp_readiness",
    "gate6_profitability_evidence",
)
