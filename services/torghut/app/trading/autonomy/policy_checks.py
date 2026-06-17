"""Promotion progression and rollback readiness policy checks for Torghut autonomy."""
# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false

from __future__ import annotations

import os

from .policy_check_modules.common import (
    Any,
    Path,
    PromotionPrerequisiteResult,
    RollbackReadinessResult,
    cast,
    datetime,
    timedelta,
    timezone,
)
from .policy_check_modules.requirements import (
    _as_dict,
    _benchmark_parity_artifact_candidates,
    _coerce_evidence_bool,
    _first_existing_artifact_path,
    _float_or_default,
    _float_or_none,
    _gates,
    _int_or_default,
    _list_of_strings,
    _observed_throughput,
    _parse_datetime,
    _promotion_rank,
    _required_artifacts_for_target,
    _required_rollback_checks,
    _required_throughput,
    _requires_advisor_fallback_slo,
    _requires_alpha_readiness_contract,
    _requires_benchmark_parity,
    _requires_contamination_registry,
    _requires_deeplob_bdlob_contract,
    _requires_expert_router_registry,
    _requires_foundation_router_parity,
    _requires_hmm_state_posterior,
    _requires_jangar_dependency_quorum,
    _requires_janus_evidence,
    _requires_profitability_evidence,
    _requires_shadow_live_deviation,
    _requires_simulation_calibration,
    _requires_stress_evidence,
)
from .policy_check_modules.profitability_manifest import (
    _append_benchmark_parity_evidence_reasons,
    _append_janus_evidence_reasons,
    _append_portfolio_optimizer_evidence_reasons,
    _append_profitability_evidence_reasons,
    _append_profitability_stage_manifest_reasons,
)
from .policy_check_modules.promotion_evidence import (
    _evaluate_alpha_readiness_summary as _evaluate_alpha_readiness_summary,
    _evaluate_promotion_evidence,
)

_PATCHABLE_OS_MODULE = os


def evaluate_promotion_prerequisites(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    promotion_target: str,
    artifact_root: Path,
    now: datetime | None = None,
) -> PromotionPrerequisiteResult:
    reasons: list[str] = []
    reason_details: list[dict[str, object]] = []
    if now is None:
        now = datetime.now(timezone.utc)
    require_profitability_manifest = bool(
        policy_payload.get("promotion_require_profitability_stage_manifest", False)
    )
    profitability_required = _requires_profitability_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    janus_required = _requires_janus_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    benchmark_parity_required = _requires_benchmark_parity(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    foundation_router_parity_required = _requires_foundation_router_parity(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    deeplob_bdlob_contract_required = _requires_deeplob_bdlob_contract(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    advisor_fallback_slo_required = _requires_advisor_fallback_slo(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    contamination_registry_required = _requires_contamination_registry(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    stress_required = _requires_stress_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    simulation_calibration_required = _requires_simulation_calibration(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    shadow_live_deviation_required = _requires_shadow_live_deviation(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    hmm_state_posterior_required = _requires_hmm_state_posterior(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    expert_router_registry_required = _requires_expert_router_registry(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    required_artifacts = _required_artifacts_for_target(
        policy_payload,
        promotion_target,
        include_profitability_artifacts=profitability_required,
        include_janus_artifacts=janus_required,
        include_benchmark_parity_artifacts=benchmark_parity_required,
        include_foundation_router_parity_artifacts=foundation_router_parity_required,
        include_deeplob_bdlob_artifacts=deeplob_bdlob_contract_required,
        include_advisor_fallback_slo_artifacts=advisor_fallback_slo_required,
        include_contamination_artifacts=contamination_registry_required,
        include_stress_artifacts=stress_required,
        include_simulation_calibration_artifacts=simulation_calibration_required,
        include_shadow_live_deviation_artifacts=shadow_live_deviation_required,
        include_hmm_state_posterior_artifacts=hmm_state_posterior_required,
        include_expert_router_artifacts=expert_router_registry_required,
        require_profitability_manifest=require_profitability_manifest,
    )
    missing_artifacts: list[str] = []
    benchmark_candidates = (
        _benchmark_parity_artifact_candidates(policy_payload, gate_report_payload)
        if benchmark_parity_required
        else []
    )
    existing_benchmark_path = (
        _first_existing_artifact_path(benchmark_candidates, artifact_root=artifact_root)
        if benchmark_candidates
        else None
    )
    for item in required_artifacts:
        if (
            item
            in {
                "gates/benchmark-parity-report-v1.json",
                "benchmarks/benchmark-parity-report-v1.json",
            }
            and existing_benchmark_path is not None
        ):
            continue
        if not (artifact_root / item).exists():
            missing_artifacts.append(item)
    artifact_refs = [str(artifact_root / item) for item in required_artifacts]
    throughput_requirements = _required_throughput(policy_payload)
    throughput_observed = _observed_throughput(
        gate_report_payload=gate_report_payload,
        candidate_state_payload=candidate_state_payload,
    )
    _append_missing_artifact_reasons(reasons, reason_details, missing_artifacts)
    _append_candidate_gate_reasons(
        reasons=reasons,
        reason_details=reason_details,
        gate_report_payload=gate_report_payload,
        candidate_state_payload=candidate_state_payload,
        promotion_target=promotion_target,
    )
    _append_required_gate_reasons(
        reasons=reasons,
        reason_details=reason_details,
        gate_report_payload=gate_report_payload,
        promotion_target=promotion_target,
    )
    _append_uncertainty_reasons(
        reasons=reasons,
        reason_details=reason_details,
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        promotion_target=promotion_target,
    )
    _append_throughput_reasons(
        reasons=reasons,
        reason_details=reason_details,
        throughput_requirements=throughput_requirements,
        throughput_observed=throughput_observed,
    )
    _append_run_id_mismatch_reasons(
        reasons=reasons,
        reason_details=reason_details,
        gate_report_payload=gate_report_payload,
        candidate_state_payload=candidate_state_payload,
    )
    _append_jangar_dependency_quorum_reasons(
        reasons=reasons,
        reason_details=reason_details,
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        candidate_state_payload=candidate_state_payload,
        promotion_target=promotion_target,
    )
    _append_alpha_readiness_reasons(
        reasons=reasons,
        reason_details=reason_details,
        policy_payload=policy_payload,
        candidate_state_payload=candidate_state_payload,
        promotion_target=promotion_target,
    )
    if profitability_required:
        _append_profitability_evidence_reasons(
            reasons=reasons,
            reason_details=reason_details,
            policy_payload=policy_payload,
            artifact_root=artifact_root,
        )
    if janus_required:
        _append_janus_evidence_reasons(
            reasons=reasons,
            reason_details=reason_details,
            policy_payload=policy_payload,
            artifact_root=artifact_root,
        )
    if benchmark_parity_required:
        _append_benchmark_parity_evidence_reasons(
            reasons=reasons,
            reason_details=reason_details,
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
        )
    if require_profitability_manifest:
        _append_profitability_stage_manifest_reasons(
            reasons=reasons,
            reason_details=reason_details,
            policy_payload=policy_payload,
            artifact_root=artifact_root,
        )
    if bool(
        policy_payload.get("promotion_require_portfolio_optimizer_evidence", False)
    ):
        _append_portfolio_optimizer_evidence_reasons(
            reasons=reasons,
            reason_details=reason_details,
            policy_payload=policy_payload,
            artifact_root=artifact_root,
        )

    evidence_reasons, evidence_details, evidence_refs = _evaluate_promotion_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        promotion_target=promotion_target,
        artifact_root=artifact_root,
        now=now,
    )
    if evidence_reasons:
        reasons.extend(evidence_reasons)
    if evidence_details:
        reason_details.extend(evidence_details)
    if evidence_refs:
        artifact_refs.extend(evidence_refs)

    return PromotionPrerequisiteResult(
        allowed=not reasons,
        reasons=sorted(set(reasons)),
        required_artifacts=required_artifacts,
        missing_artifacts=missing_artifacts,
        reason_details=reason_details,
        artifact_refs=sorted(set(artifact_refs)),
        required_throughput=throughput_requirements,
        observed_throughput=throughput_observed,
    )


def _append_missing_artifact_reasons(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    missing_artifacts: list[str],
) -> None:
    if not missing_artifacts:
        return
    reasons.append("required_artifacts_missing")
    reason_details.append(
        {
            "reason": "required_artifacts_missing",
            "missing_artifacts": list(missing_artifacts),
        }
    )


def _append_candidate_gate_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    promotion_target: str,
) -> None:
    if candidate_state_payload.get("paused", False):
        reasons.append("candidate_paused_for_review")
        reason_details.append({"reason": "candidate_paused_for_review"})
    if not bool(gate_report_payload.get("promotion_allowed", False)):
        reasons.append("gate_report_not_promotable")
        reason_details.append({"reason": "gate_report_not_promotable"})

    requested_rank = _promotion_rank(promotion_target)
    recommended_mode = str(gate_report_payload.get("recommended_mode", "shadow"))
    recommended_rank = _promotion_rank(recommended_mode)
    if recommended_rank < requested_rank:
        reasons.append("gate_recommended_mode_below_target")
        reason_details.append(
            {
                "reason": "gate_recommended_mode_below_target",
                "requested_target": promotion_target,
                "recommended_mode": recommended_mode,
            }
        )


def _append_required_gate_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    gate_report_payload: dict[str, Any],
    promotion_target: str,
) -> None:
    gate_index = {
        str(gate.get("gate_id", "")): gate for gate in _gates(gate_report_payload)
    }
    required_gates = [
        "gate0_data_integrity",
        "gate1_statistical_robustness",
        "gate2_risk_capacity",
    ]
    if promotion_target != "shadow":
        required_gates.append("gate7_uncertainty_calibration")

    for required_gate in required_gates:
        status = str(gate_index.get(required_gate, {}).get("status", "fail"))
        if status == "pass":
            continue
        reasons.append(f"{required_gate}_not_passed")
        reason_details.append(
            {
                "reason": f"{required_gate}_not_passed",
                "gate_id": required_gate,
                "status": status,
            }
        )


def _append_uncertainty_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    promotion_target: str,
) -> None:
    if promotion_target == "shadow":
        return
    uncertainty_action = str(
        gate_report_payload.get("uncertainty_gate_action", "abstain")
    ).strip()
    if uncertainty_action != "pass":
        reasons.append("uncertainty_gate_not_pass")
        reason_details.append(
            {
                "reason": "uncertainty_gate_not_pass",
                "uncertainty_gate_action": uncertainty_action,
            }
        )

    promotion_threshold = _float_or_none(
        policy_payload.get("promotion_uncertainty_max_coverage_error")
    )
    gate7_threshold = _float_or_none(
        policy_payload.get("gate7_max_coverage_error_pass")
    )
    if promotion_threshold is None and gate7_threshold is not None:
        max_coverage_error = gate7_threshold
    elif promotion_threshold is not None:
        max_coverage_error = promotion_threshold
    else:
        max_coverage_error = 0.03
    if (
        promotion_threshold is not None
        and gate7_threshold is not None
        and promotion_threshold != gate7_threshold
    ):
        reasons.append("uncertainty_policy_threshold_mismatch")
        reason_details.append(
            {
                "reason": "uncertainty_policy_threshold_mismatch",
                "promotion_uncertainty_max_coverage_error": promotion_threshold,
                "gate7_max_coverage_error_pass": gate7_threshold,
            }
        )
        max_coverage_error = min(max_coverage_error, gate7_threshold)
    coverage_error = _float_or_default(gate_report_payload.get("coverage_error"), 1.0)
    if coverage_error > max_coverage_error:
        reasons.append("uncertainty_calibration_slo_failed")
        reason_details.append(
            {
                "reason": "uncertainty_calibration_slo_failed",
                "coverage_error": coverage_error,
                "maximum": max_coverage_error,
            }
        )

    recalibration_run_id = str(
        gate_report_payload.get("recalibration_run_id", "")
    ).strip()
    if (
        uncertainty_action in {"degrade", "abstain", "fail"}
        and not recalibration_run_id
    ):
        reasons.append("uncertainty_recalibration_run_missing")
        reason_details.append({"reason": "uncertainty_recalibration_run_missing"})


def _append_throughput_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    throughput_requirements: dict[str, int],
    throughput_observed: dict[str, int | bool | str | None],
) -> None:
    if bool(throughput_observed.get("no_signal_window", False)):
        reasons.append("no_signal_window_detected")
        reason_details.append(
            {
                "reason": "no_signal_window_detected",
                "no_signal_reason": throughput_observed.get("no_signal_reason"),
            }
        )

    has_explicit_throughput = bool(
        throughput_observed.get("has_explicit_throughput", False)
    )
    if not has_explicit_throughput:
        return

    signal_count = _int_or_default(throughput_observed.get("signal_count"), 0)
    if signal_count < throughput_requirements["min_signal_count"]:
        reasons.append("signal_count_below_minimum_for_progression")
        reason_details.append(
            {
                "reason": "signal_count_below_minimum_for_progression",
                "signal_count": signal_count,
                "minimum_signal_count": throughput_requirements["min_signal_count"],
            }
        )

    decision_count = _int_or_default(throughput_observed.get("decision_count"), 0)
    if decision_count < throughput_requirements["min_decision_count"]:
        reasons.append("decision_count_below_minimum_for_progression")
        reason_details.append(
            {
                "reason": "decision_count_below_minimum_for_progression",
                "decision_count": decision_count,
                "minimum_decision_count": throughput_requirements["min_decision_count"],
            }
        )

    trade_count = _int_or_default(throughput_observed.get("trade_count"), 0)
    if trade_count < throughput_requirements["min_trade_count"]:
        reasons.append("trade_count_below_minimum_for_progression")
        reason_details.append(
            {
                "reason": "trade_count_below_minimum_for_progression",
                "trade_count": trade_count,
                "minimum_trade_count": throughput_requirements["min_trade_count"],
            }
        )


def _append_run_id_mismatch_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
) -> None:
    candidate_run_id = str(candidate_state_payload.get("runId", "")).strip()
    gate_run_id = str(gate_report_payload.get("run_id", "")).strip()
    if candidate_run_id == gate_run_id or not gate_run_id:
        return
    reasons.append("run_id_mismatch_between_state_and_gate_report")
    reason_details.append(
        {
            "reason": "run_id_mismatch_between_state_and_gate_report",
            "candidate_run_id": candidate_run_id,
            "gate_report_run_id": gate_run_id,
        }
    )


def _append_jangar_dependency_quorum_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    promotion_target: str,
) -> None:
    if not _requires_jangar_dependency_quorum(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return
    quorum_payload = _as_dict(candidate_state_payload.get("dependencyQuorum"))
    if not quorum_payload:
        quorum_payload = _as_dict(gate_report_payload.get("dependency_quorum"))
    if not quorum_payload:
        reasons.append("jangar_dependency_quorum_missing")
        reason_details.append(
            {
                "reason": "jangar_dependency_quorum_missing",
                "promotion_target": promotion_target,
            }
        )
        return
    decision = str(quorum_payload.get("decision") or "").strip()
    source_reasons = _list_of_strings(quorum_payload.get("reasons"))
    if decision == "allow":
        return
    if decision == "delay":
        reasons.append("jangar_dependency_quorum_delay")
        reason_details.append(
            {
                "reason": "jangar_dependency_quorum_delay",
                "promotion_target": promotion_target,
                "dependency_quorum": quorum_payload,
                "dependency_reasons": source_reasons,
            }
        )
        return
    reasons.append("jangar_dependency_quorum_blocked")
    reason_details.append(
        {
            "reason": "jangar_dependency_quorum_blocked",
            "promotion_target": promotion_target,
            "decision": decision or "unknown",
            "dependency_quorum": quorum_payload,
            "dependency_reasons": source_reasons,
        }
    )


def _append_alpha_readiness_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    promotion_target: str,
) -> None:
    if not _requires_alpha_readiness_contract(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return
    readiness_payload = _as_dict(candidate_state_payload.get("alphaReadiness"))
    if not readiness_payload:
        reasons.append("alpha_readiness_contract_missing")
        reason_details.append(
            {
                "reason": "alpha_readiness_contract_missing",
                "promotion_target": promotion_target,
            }
        )
        return
    if not bool(readiness_payload.get("registry_loaded", False)):
        reasons.append("alpha_readiness_registry_unavailable")
        reason_details.append(
            {
                "reason": "alpha_readiness_registry_unavailable",
                "promotion_target": promotion_target,
                "alpha_readiness": readiness_payload,
            }
        )
    registry_errors = _list_of_strings(readiness_payload.get("registry_errors"))
    if registry_errors:
        reasons.append("alpha_readiness_registry_errors_present")
        reason_details.append(
            {
                "reason": "alpha_readiness_registry_errors_present",
                "promotion_target": promotion_target,
                "registry_errors": registry_errors,
            }
        )
    if bool(
        policy_payload.get("promotion_alpha_readiness_require_registry_match", True)
    ):
        missing_strategy_families = _list_of_strings(
            readiness_payload.get("missing_strategy_families")
        )
        if missing_strategy_families:
            reasons.append("alpha_readiness_strategy_family_unmapped")
            reason_details.append(
                {
                    "reason": "alpha_readiness_strategy_family_unmapped",
                    "promotion_target": promotion_target,
                    "missing_strategy_families": missing_strategy_families,
                }
            )
    if not bool(readiness_payload.get("promotion_eligible", False)):
        reasons.append("alpha_readiness_not_promotion_eligible")
        reason_details.append(
            {
                "reason": "alpha_readiness_not_promotion_eligible",
                "promotion_target": promotion_target,
                "alpha_readiness": readiness_payload,
            }
        )


def evaluate_rollback_readiness(
    *,
    policy_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    now: datetime | None = None,
) -> RollbackReadinessResult:
    reasons: list[str] = []
    required_checks = _required_rollback_checks(policy_payload)
    rollback_raw = candidate_state_payload.get("rollbackReadiness")
    rollback: dict[str, Any]
    if isinstance(rollback_raw, dict):
        rollback = cast(dict[str, Any], rollback_raw)
    else:
        rollback = {}

    missing_checks = [
        name
        for name in required_checks
        if _coerce_evidence_bool(rollback.get(name)) is not True
    ]
    if missing_checks:
        reasons.append("rollback_checks_missing_or_failed")

    max_age_hours = int(policy_payload.get("rollback_dry_run_max_age_hours", 72))
    dry_run_completed_at = _parse_datetime(
        str(rollback.get("dryRunCompletedAt", "")).strip()
    )
    current = now or datetime.now(timezone.utc)
    if dry_run_completed_at is None:
        reasons.append("rollback_dry_run_timestamp_missing")
    else:
        if current - dry_run_completed_at > timedelta(hours=max_age_hours):
            reasons.append("rollback_dry_run_stale")

    if policy_payload.get("rollback_require_human_approval", True) and (
        _coerce_evidence_bool(rollback.get("humanApproved")) is not True
    ):
        reasons.append("rollback_human_approval_missing")

    if not str(rollback.get("rollbackTarget", "")).strip():
        reasons.append("rollback_target_missing")

    return RollbackReadinessResult(
        ready=not reasons,
        reasons=sorted(set(reasons)),
        required_checks=required_checks,
        missing_checks=missing_checks,
    )


__all__ = [
    "PromotionPrerequisiteResult",
    "RollbackReadinessResult",
    "evaluate_promotion_prerequisites",
    "evaluate_rollback_readiness",
]
