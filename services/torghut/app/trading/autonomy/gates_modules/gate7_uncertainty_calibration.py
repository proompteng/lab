# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Gate policy matrix evaluator for Torghut v3 autonomous lanes."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, cast

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    GateEvaluationReport,
    GateInputs,
    GatePolicyMatrix,
    GateResult,
    GateStatus,
    PromotionTarget,
    UncertaintyGateAction,
    UncertaintyGateOutcome,
    empty_artifact_refs as _empty_artifact_refs,
    empty_dict as _empty_dict,
    empty_str_list as _empty_str_list,
    gate0_data_integrity as _gate0_data_integrity,
    gate1_statistical_robustness as _gate1_statistical_robustness,
    gate2_risk_and_capacity as _gate2_risk_and_capacity,
    gate3_shadow_paper_quality as _gate3_shadow_paper_quality,
    gate4_operational_readiness as _gate4_operational_readiness,
    gate5_live_ramp_readiness as _gate5_live_ramp_readiness,
    gate6_profitability_evidence as _gate6_profitability_evidence,
    evaluate_gate_matrix,
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
        artifact_refs=[recalibration_artifact_ref]
        if recalibration_artifact_ref
        else [],
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
    if not inputs.fragility_inputs_valid:
        return ["fragility_inputs_invalid"]
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
    order_count_raw = inputs.tca_metrics.get("order_count")
    if order_count_raw is None:
        return ["tca_order_count_missing"]

    try:
        tca_order_count = int(order_count_raw)
    except (TypeError, ValueError):
        return ["tca_order_count_invalid"]

    if tca_order_count <= 0:
        return ["tca_order_count_below_minimum"]

    reasons: list[str] = []
    avg_tca_slippage = _abs_decimal(inputs.tca_metrics.get("avg_abs_slippage_bps"))
    if avg_tca_slippage is None:
        avg_tca_slippage = _abs_decimal(inputs.tca_metrics.get("avg_slippage_bps"))
    if avg_tca_slippage is None:
        reasons.append("tca_slippage_missing")
    elif avg_tca_slippage > policy.gate2_max_tca_slippage_bps:
        reasons.append("tca_slippage_exceeds_maximum")

    avg_tca_shortfall = _abs_decimal(
        inputs.tca_metrics.get("avg_shortfall_notional_abs")
    )
    if avg_tca_shortfall is None:
        avg_tca_shortfall = _abs_decimal(
            inputs.tca_metrics.get("avg_shortfall_notional")
        )
    if avg_tca_shortfall is None:
        reasons.append("tca_shortfall_missing")
    elif avg_tca_shortfall > policy.gate2_max_tca_shortfall_notional:
        reasons.append("tca_shortfall_exceeds_maximum")

    expected_shortfall_coverage = _decimal(
        inputs.tca_metrics.get("expected_shortfall_coverage")
    )
    expected_shortfall_sample_count = _int_or_default(
        inputs.tca_metrics.get("expected_shortfall_sample_count"),
        0,
    )
    avg_tca_realized_shortfall = _abs_decimal(
        inputs.tca_metrics.get("avg_realized_shortfall_bps_abs")
    )
    if avg_tca_realized_shortfall is None:
        avg_tca_realized_shortfall = _abs_decimal(
            inputs.tca_metrics.get("avg_realized_shortfall_bps")
        ) or Decimal("0")
    if avg_tca_realized_shortfall > policy.gate2_max_tca_realized_shortfall_bps:
        reasons.append("tca_realized_shortfall_bps_exceeds_maximum")

    avg_tca_divergence = _abs_decimal(inputs.tca_metrics.get("avg_divergence_bps_abs"))
    if avg_tca_divergence is None:
        avg_tca_divergence = _abs_decimal(
            inputs.tca_metrics.get("avg_divergence_bps")
        ) or Decimal("0")
    if avg_tca_divergence > policy.gate2_max_tca_divergence_bps:
        reasons.append("tca_divergence_bps_exceeds_maximum")

    avg_tca_calibration_error = _decimal(
        inputs.tca_metrics.get("avg_calibration_error_bps")
    )
    if avg_tca_calibration_error is None:
        if expected_shortfall_sample_count > 0:
            reasons.append("tca_calibration_error_missing")
    elif avg_tca_calibration_error > policy.gate2_max_tca_calibration_error_bps:
        reasons.append("tca_calibration_error_exceeds_maximum")

    if policy.gate2_min_tca_expected_shortfall_coverage > 0:
        if expected_shortfall_sample_count <= 0 or expected_shortfall_coverage is None:
            reasons.append("tca_expected_shortfall_calibration_coverage_missing")
        elif (
            expected_shortfall_coverage
            < policy.gate2_min_tca_expected_shortfall_coverage
        ):
            reasons.append(
                "tca_expected_shortfall_calibration_coverage_below_threshold"
            )

    avg_tca_churn_ratio = _decimal(inputs.tca_metrics.get("avg_churn_ratio"))
    if avg_tca_churn_ratio is None:
        reasons.append("tca_churn_ratio_missing")
    elif avg_tca_churn_ratio > policy.gate2_max_tca_churn_ratio:
        reasons.append("tca_churn_ratio_exceeds_maximum")
    return reasons


def _gate6_early_result(
    inputs: GateInputs,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> GateResult | None:
    if promotion_target == "shadow":
        return GateResult(
            gate_id="gate6_profitability_evidence", status="pass", reasons=[]
        )
    if not policy.gate6_require_profitability_evidence:
        return GateResult(
            gate_id="gate6_profitability_evidence", status="pass", reasons=[]
        )
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
    return_over_drawdown = _decimal(
        risk_adjusted.get("return_over_drawdown")
    ) or Decimal("0")
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


def _gate6_janus_q_reasons(
    evidence: dict[str, Any], policy: GatePolicyMatrix
) -> list[str]:
    if not policy.gate6_require_janus_evidence:
        return []
    reasons: list[str] = []
    janus_q = _dict_from_any(evidence.get("janus_q"))
    if str(janus_q.get("schema_version", "")).strip() != "janus-q-evidence-v1":
        reasons.append("janus_q_evidence_schema_invalid")
        return reasons
    if not bool(janus_q.get("evidence_complete", False)):
        reasons.append("janus_q_evidence_incomplete")

    event_car = _dict_from_any(janus_q.get("event_car"))
    if str(event_car.get("schema_version", "")).strip() != "janus-event-car-v1":
        reasons.append("janus_event_car_schema_invalid")
    event_count = _int_or_default(event_car.get("event_count"), 0)
    if event_count < policy.gate6_min_janus_event_count:
        reasons.append("janus_event_car_count_below_threshold")

    hgrm_reward = _dict_from_any(janus_q.get("hgrm_reward"))
    if str(hgrm_reward.get("schema_version", "")).strip() != "janus-hgrm-reward-v1":
        reasons.append("janus_hgrm_reward_schema_invalid")
    reward_count = _int_or_default(hgrm_reward.get("reward_count"), 0)
    if reward_count < policy.gate6_min_janus_reward_count:
        reasons.append("janus_hgrm_reward_count_below_threshold")
    return reasons


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
        if not value.is_finite():
            return None
        return value
    try:
        parsed = Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
    if not parsed.is_finite():
        return None
    return parsed


def _abs_decimal(value: Any) -> Decimal | None:
    parsed = _decimal(value)
    if parsed is None:
        return None
    return abs(parsed)


def _decimal_or_default(value: Any, default: Decimal) -> Decimal:
    parsed = _decimal(value)
    if parsed is None:
        return default
    return parsed


def _dict_from_any(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], value)


def _int_or_default(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default


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


__all__ = [name for name in globals() if not name.startswith("__")]
