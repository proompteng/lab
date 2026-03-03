"""Promotion progression and rollback readiness policy checks for Torghut autonomy."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
import math
from pathlib import Path
from typing import Any, cast

from ..parity import (
    BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
    BENCHMARK_PARITY_SCHEMA_VERSION,
)


_PROFITABILITY_STAGE_ORDER: tuple[str, ...] = (
    "research",
    "validation",
    "execution",
    "governance",
)

_PROFITABILITY_STAGE_REQUIRED_CHECKS: dict[str, tuple[str, ...]] = {
    "research": (
        "candidate_spec_present",
        "candidate_generation_manifest_present",
        "walkforward_results_present",
        "baseline_evaluation_report_present",
    ),
    "validation": (
        "evaluation_report_present",
        "profitability_benchmark_present",
        "profitability_evidence_present",
        "profitability_validation_present",
    ),
    "execution": (
        "walkforward_results_present",
        "evaluation_report_present",
        "gate_evaluation_present",
        "hmm_state_posterior_present",
        "expert_router_registry_present",
        "janus_event_car_present",
        "janus_hgrm_reward_present",
        "recalibration_report_present",
        "gate_matrix_approval",
        "drift_gate_approval",
    ),
    "governance": (
        "rollback_ready",
        "gate_report_present",
        "candidate_spec_present",
        "rollback_readiness_present",
        "risk_controls_attestable",
    ),
}


@dataclass(frozen=True)
class PromotionPrerequisiteResult:
    allowed: bool
    reasons: list[str]
    required_artifacts: list[str]
    missing_artifacts: list[str]
    reason_details: list[dict[str, object]]
    artifact_refs: list[str]
    required_throughput: dict[str, int]
    observed_throughput: dict[str, int | bool | str | None]

    def to_payload(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "reasons": list(self.reasons),
            "required_artifacts": list(self.required_artifacts),
            "missing_artifacts": list(self.missing_artifacts),
            "reason_details": [dict(item) for item in self.reason_details],
            "artifact_refs": list(self.artifact_refs),
            "required_throughput": dict(self.required_throughput),
            "observed_throughput": dict(self.observed_throughput),
        }


@dataclass(frozen=True)
class RollbackReadinessResult:
    ready: bool
    reasons: list[str]
    required_checks: list[str]
    missing_checks: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            "ready": self.ready,
            "reasons": list(self.reasons),
            "required_checks": list(self.required_checks),
            "missing_checks": list(self.missing_checks),
        }


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
    contamination_registry_required = _requires_contamination_registry(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    stress_required = _requires_stress_evidence(
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
        include_contamination_artifacts=contamination_registry_required,
        include_stress_artifacts=stress_required,
        include_hmm_state_posterior_artifacts=hmm_state_posterior_required,
        include_expert_router_artifacts=expert_router_registry_required,
        require_profitability_manifest=require_profitability_manifest,
    )
    missing_artifacts = [
        item for item in required_artifacts if not (artifact_root / item).exists()
    ]
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
    gate7_threshold = _float_or_none(policy_payload.get("gate7_max_coverage_error_pass"))
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

    recalibration_run_id = str(gate_report_payload.get("recalibration_run_id", "")).strip()
    if uncertainty_action in {"degrade", "abstain", "fail"} and not recalibration_run_id:
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


def _append_profitability_stage_manifest_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    manifest_relpath = str(
        policy_payload.get(
            "promotion_profitability_stage_manifest_artifact",
            "profitability/profitability-stage-manifest-v1.json",
        )
    )
    manifest_path = artifact_root / manifest_relpath
    manifest_payload = _load_json_if_exists(manifest_path)
    if manifest_payload is None:
        if manifest_path.exists():
            reasons.append("profitability_stage_manifest_invalid_json")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_invalid_json",
                    "artifact_ref": str(manifest_path),
                }
            )
        else:
            reasons.append("profitability_stage_manifest_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_missing",
                    "artifact_ref": str(manifest_path),
                }
            )
        return

    schema_version = str(manifest_payload.get("schema_version", "")).strip()
    if schema_version != "profitability-stage-manifest-v1":
        reasons.append("profitability_stage_manifest_schema_version_invalid")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_schema_version_invalid",
                "artifact_ref": str(manifest_path),
                "schema_version": schema_version,
            }
        )

    candidate_id = str(manifest_payload.get("candidate_id", "")).strip()
    if not candidate_id:
        reasons.append("profitability_stage_manifest_candidate_id_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_candidate_id_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    strategy_family = str(manifest_payload.get("strategy_family", "")).strip()
    if not strategy_family:
        reasons.append("profitability_stage_manifest_strategy_family_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_strategy_family_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    run_context = _as_dict(manifest_payload.get("run_context"))
    if not run_context:
        reasons.append("profitability_stage_manifest_run_context_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_run_context_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    elif not run_context.get("run_id"):
        reasons.append("profitability_stage_manifest_run_context_incomplete")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_run_context_incomplete",
                "artifact_ref": str(manifest_path),
            }
        )

    stages_raw = manifest_payload.get("stages")
    stages = _as_dict(stages_raw)
    if not stages:
        reasons.append("profitability_stage_manifest_stages_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_stages_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    else:
        stage_names = tuple(name for name in _PROFITABILITY_STAGE_ORDER if name in stages)
        required_stage_names = _PROFITABILITY_STAGE_ORDER
        if stage_names != required_stage_names:
            reasons.append("profitability_stage_manifest_stage_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_stage_missing",
                    "artifact_ref": str(manifest_path),
                    "stages_present": sorted(stages.keys()),
                }
            )
        if set(stages) != set(required_stage_names):
            reasons.append("profitability_stage_manifest_stage_set_invalid")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_stage_set_invalid",
                    "artifact_ref": str(manifest_path),
                    "expected_stages": list(required_stage_names),
                    "actual_stages": sorted(stages.keys()),
                }
            )
        for stage_name in required_stage_names:
            stage_payload = _as_dict(stages.get(stage_name))
            if not stage_payload:
                reasons.append("profitability_stage_manifest_stage_missing")
                reason_details.append(
                    {
                        "reason": "profitability_stage_manifest_stage_missing",
                        "artifact_ref": str(manifest_path),
                        "stage": stage_name,
                    }
                )
                continue

            status = str(stage_payload.get("status", "")).strip()
            if status not in {"pass", "fail"}:
                reasons.append("profitability_stage_manifest_stage_status_invalid")
                reason_details.append(
                    {
                        "reason": "profitability_stage_manifest_stage_status_invalid",
                        "artifact_ref": str(manifest_path),
                        "stage": stage_name,
                        "status": status,
                    }
                )
            for required_key in ("checks", "artifacts", "owner", "completed_at_utc"):
                if required_key not in stage_payload:
                    reasons.append("profitability_stage_manifest_stage_structure_invalid")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_stage_structure_invalid",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "required_key": required_key,
                        }
                    )
            checks_payload = _as_list_of_dicts(stage_payload.get("checks"))
            stage_checks: dict[str, str] = {}
            for item in checks_payload:
                check_name = str(item.get("check", "")).strip()
                if not check_name:
                    reasons.append("profitability_stage_manifest_stage_check_invalid")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_stage_check_invalid",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                        }
                    )
                    continue
                check_status = str(item.get("status", "")).strip()
                if check_status not in {"pass", "fail"}:
                    reasons.append("profitability_stage_manifest_stage_check_status_invalid")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_stage_check_status_invalid",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "check": check_name,
                        }
                    )
                    continue
                stage_checks[check_name] = check_status
            required_checks = list(
                _PROFITABILITY_STAGE_REQUIRED_CHECKS.get(stage_name, ())
            )
            if (
                stage_name == "execution"
                and not bool(
                    policy_payload.get("promotion_require_expert_router_registry", False)
                )
            ):
                required_checks = [
                    check
                    for check in required_checks
                    if check != "expert_router_registry_present"
                ]
            for required_check in required_checks:
                if required_check not in stage_checks:
                    reasons.append("profitability_stage_manifest_required_check_missing")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_required_check_missing",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "check": required_check,
                        }
                    )
                    continue
                if stage_checks[required_check] != "pass":
                    reasons.append("profitability_stage_manifest_required_check_failed")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_required_check_failed",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "check": required_check,
                        }
                    )
            artifacts = _as_dict(stage_payload.get("artifacts"))
            if not artifacts:
                continue
            for artifact_payload_raw in artifacts.values():
                artifact_payload = _as_dict(artifact_payload_raw)
                artifact_ref = str(
                    artifact_payload.get("path", "")
                ).strip()
                if not artifact_ref:
                    continue
                expected_sha = str(artifact_payload.get("sha256", "")).strip()
                artifact_file = artifact_root / artifact_ref
                if not artifact_file.exists():
                    reasons.append("profitability_stage_manifest_artifact_missing")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_artifact_missing",
                            "artifact_ref": str(artifact_file),
                            "stage": stage_name,
                        }
                    )
                    continue
                if (
                    artifact_file.suffix.lower() == ".json"
                    and _load_json_if_exists(artifact_file) is None
                ):
                    reasons.append("profitability_stage_manifest_artifact_invalid_json")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_artifact_invalid_json",
                            "artifact_ref": str(artifact_file),
                            "stage": stage_name,
                        }
                    )
                if expected_sha:
                    actual_sha = _sha256_path(artifact_file)
                    if expected_sha != actual_sha:
                        reasons.append("profitability_stage_manifest_artifact_hash_mismatch")
                        reason_details.append(
                            {
                                "reason": "profitability_stage_manifest_artifact_hash_mismatch",
                                "artifact_ref": str(artifact_file),
                                "stage": stage_name,
                                "expected_sha256": expected_sha,
                                "actual_sha256": actual_sha,
                            }
                        )

    if bool(
        policy_payload.get(
            "promotion_require_profitability_stage_replay_contract", False
        )
    ):
        _append_profitability_stage_manifest_replay_contract_reasons(
            reasons=reasons,
            reason_details=reason_details,
            manifest_payload=manifest_payload,
            manifest_path=manifest_path,
            stages=stages,
        )

    rollback_contract = manifest_payload.get("rollback_contract_ref")
    if not rollback_contract:
        reasons.append("profitability_stage_manifest_rollback_contract_ref_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_rollback_contract_ref_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    content_hash = str(manifest_payload.get("content_hash", "")).strip()
    if not content_hash:
        reasons.append("profitability_stage_manifest_content_hash_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_content_hash_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    else:
        content_hash_payload = dict(manifest_payload)
        content_hash_payload.pop("content_hash", None)
        expected_content_hash = _sha256_json(content_hash_payload)
        if content_hash != expected_content_hash:
            reasons.append("profitability_stage_manifest_content_hash_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_content_hash_mismatch",
                    "artifact_ref": str(manifest_path),
                    "content_hash": content_hash,
                    "expected_content_hash": expected_content_hash,
                }
            )

    overall_status = str(manifest_payload.get("overall_status", "")).strip()
    if overall_status not in {"pass", "fail"}:
        reasons.append("profitability_stage_manifest_overall_status_invalid")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_overall_status_invalid",
                "artifact_ref": str(manifest_path),
                "overall_status": overall_status,
            }
        )

    failure_reasons = _list_of_strings(manifest_payload.get("failure_reasons"))
    if overall_status == "fail":
        if not failure_reasons:
            reasons.append("profitability_stage_manifest_failure_reasons_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_failure_reasons_missing",
                    "artifact_ref": str(manifest_path),
                }
            )

    if overall_status in {"pass", "fail"} and stages:
        stage_statuses: list[bool] = []
        for stage_name in _PROFITABILITY_STAGE_ORDER:
            stage_payload = _as_dict(stages.get(stage_name))
            stage_statuses.append(str(stage_payload.get("status", "")).strip() == "pass")
        expected_overall_status = (
            "pass" if all(stage_statuses) else "fail"
        )
        if overall_status != expected_overall_status:
            reasons.append("profitability_stage_manifest_overall_status_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_overall_status_mismatch",
                    "artifact_ref": str(manifest_path),
                    "overall_status": overall_status,
                    "calculated_overall_status": expected_overall_status,
                }
            )
    ordered_stages = _PROFITABILITY_STAGE_ORDER
    failure_encountered = False
    for stage_name in ordered_stages:
        stage_payload = _as_dict(stages.get(stage_name))
        stage_status = str(stage_payload.get("status", "")).strip()
        if stage_status != "pass":
            failure_encountered = True
            continue
        if failure_encountered:
            reasons.append("profitability_stage_manifest_stage_transition_violation")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_stage_transition_violation",
                    "artifact_ref": str(manifest_path),
                    "stage": stage_name,
                }
            )
            break
    if overall_status == "fail":
        reasons.append("profitability_stage_manifest_stage_chain_not_passed")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_stage_chain_not_passed",
                "artifact_ref": str(manifest_path),
                "failure_reasons": failure_reasons,
            }
        )


def _append_profitability_stage_manifest_replay_contract_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    manifest_payload: dict[str, Any],
    manifest_path: Path,
    stages: dict[str, Any],
) -> None:
    replay_contract = _as_dict(manifest_payload.get("replay_contract"))
    if not replay_contract:
        reasons.append("profitability_stage_manifest_replay_contract_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_replay_contract_missing",
                "artifact_ref": str(manifest_path),
            }
        )
        return

    artifact_hashes_raw = _as_dict(replay_contract.get("artifact_hashes"))
    artifact_hashes = {
        str(key).strip(): str(value).strip()
        for key, value in artifact_hashes_raw.items()
        if str(key).strip() and str(value).strip()
    }
    if not artifact_hashes:
        reasons.append("profitability_stage_manifest_replay_artifact_hashes_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_replay_artifact_hashes_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    contract_hash = str(replay_contract.get("contract_hash", "")).strip()
    if not contract_hash:
        reasons.append("profitability_stage_manifest_replay_contract_hash_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_replay_contract_hash_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    else:
        expected_contract_hash = _sha256_json({"artifact_hashes": artifact_hashes})
        if contract_hash != expected_contract_hash:
            reasons.append("profitability_stage_manifest_replay_contract_hash_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_replay_contract_hash_mismatch",
                    "artifact_ref": str(manifest_path),
                    "contract_hash": contract_hash,
                    "expected_contract_hash": expected_contract_hash,
                }
            )

    expected_stage_artifact_hashes: dict[str, str] = {}
    for stage_name in _PROFITABILITY_STAGE_ORDER:
        stage_payload = _as_dict(stages.get(stage_name))
        stage_artifacts = _as_dict(stage_payload.get("artifacts"))
        for artifact_payload_raw in stage_artifacts.values():
            artifact_payload = _as_dict(artifact_payload_raw)
            artifact_ref = str(artifact_payload.get("path", "")).strip()
            expected_sha = str(artifact_payload.get("sha256", "")).strip()
            if not artifact_ref or not expected_sha:
                continue
            expected_stage_artifact_hashes[artifact_ref] = expected_sha

    for artifact_ref, expected_sha in sorted(expected_stage_artifact_hashes.items()):
        replay_sha = artifact_hashes.get(artifact_ref, "")
        if not replay_sha:
            reasons.append("profitability_stage_manifest_replay_artifact_hash_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_replay_artifact_hash_missing",
                    "artifact_ref": str(manifest_path),
                    "stage_artifact_ref": artifact_ref,
                }
            )
            continue
        if replay_sha != expected_sha:
            reasons.append("profitability_stage_manifest_replay_artifact_hash_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_replay_artifact_hash_mismatch",
                    "artifact_ref": str(manifest_path),
                    "stage_artifact_ref": artifact_ref,
                    "replay_sha256": replay_sha,
                    "expected_sha256": expected_sha,
                }
            )


def _append_profitability_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    evidence_validation_relpath = str(
        policy_payload.get(
            "promotion_profitability_validation_artifact",
            "gates/profitability-evidence-validation.json",
        )
    )
    evidence_validation_path = artifact_root / evidence_validation_relpath
    evidence_validation_payload = _load_json_if_exists(evidence_validation_path)
    if evidence_validation_payload is None:
        reasons.append("profitability_evidence_validation_missing")
        reason_details.append(
            {
                "reason": "profitability_evidence_validation_missing",
                "artifact_ref": str(evidence_validation_path),
            }
        )
    elif not bool(evidence_validation_payload.get("passed", False)):
        reasons.append("profitability_evidence_validation_failed")
        reason_details.append(
            {
                "reason": "profitability_evidence_validation_failed",
                "artifact_ref": str(evidence_validation_path),
                "validation_reasons": _list_of_strings(
                    evidence_validation_payload.get("reasons")
                ),
            }
        )

    benchmark_relpath = str(
        policy_payload.get(
            "promotion_profitability_benchmark_artifact",
            "gates/profitability-benchmark-v4.json",
        )
    )
    benchmark_path = artifact_root / benchmark_relpath
    benchmark_payload = _load_json_if_exists(benchmark_path)
    minimum_regime_slices = int(
        policy_payload.get("promotion_profitability_min_regime_slices", 1)
    )
    if benchmark_payload is None:
        reasons.append("profitability_benchmark_missing")
        reason_details.append(
            {
                "reason": "profitability_benchmark_missing",
                "artifact_ref": str(benchmark_path),
            }
        )
        return

    regime_slices = _regime_slice_count(benchmark_payload)
    if regime_slices < minimum_regime_slices:
        reasons.append("profitability_benchmark_regime_coverage_insufficient")
        reason_details.append(
            {
                "reason": "profitability_benchmark_regime_coverage_insufficient",
                "artifact_ref": str(benchmark_path),
                "actual_regime_slices": regime_slices,
                "minimum_regime_slices": minimum_regime_slices,
            }
        )


def _append_janus_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    event_path = artifact_root / str(
        policy_payload.get(
            "promotion_janus_event_car_artifact", "gates/janus-event-car-v1.json"
        )
    )
    event_payload = _load_json_if_exists(event_path)
    if event_payload is None:
        reasons.append("janus_event_car_artifact_missing")
        reason_details.append(
            {
                "reason": "janus_event_car_artifact_missing",
                "artifact_ref": str(event_path),
            }
        )
    else:
        if str(event_payload.get("schema_version", "")).strip() != "janus-event-car-v1":
            reasons.append("janus_event_car_schema_invalid")
            reason_details.append(
                {
                    "reason": "janus_event_car_schema_invalid",
                    "artifact_ref": str(event_path),
                    "expected": "janus-event-car-v1",
                }
            )
        event_count = _int_or_default(
            _as_dict(event_payload.get("summary")).get("event_count"),
            _list_count(event_payload.get("records")),
        )
        min_event_count = max(
            1, _int_or_default(policy_payload.get("promotion_min_janus_event_count"), 1)
        )
        if event_count < min_event_count:
            reasons.append("janus_event_car_count_below_minimum")
            reason_details.append(
                {
                    "reason": "janus_event_car_count_below_minimum",
                    "artifact_ref": str(event_path),
                    "actual_event_count": event_count,
                    "minimum_event_count": min_event_count,
                }
            )

    reward_path = artifact_root / str(
        policy_payload.get(
            "promotion_janus_hgrm_reward_artifact", "gates/janus-hgrm-reward-v1.json"
        )
    )
    reward_payload = _load_json_if_exists(reward_path)
    if reward_payload is None:
        reasons.append("janus_hgrm_reward_artifact_missing")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_artifact_missing",
                "artifact_ref": str(reward_path),
            }
        )
        return

    if str(reward_payload.get("schema_version", "")).strip() != "janus-hgrm-reward-v1":
        reasons.append("janus_hgrm_reward_schema_invalid")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_schema_invalid",
                "artifact_ref": str(reward_path),
                "expected": "janus-hgrm-reward-v1",
            }
        )
    reward_count = _int_or_default(
        _as_dict(reward_payload.get("summary")).get("reward_count"),
        _list_count(reward_payload.get("rewards")),
    )
    min_reward_count = max(
        1, _int_or_default(policy_payload.get("promotion_min_janus_reward_count"), 1)
    )
    if reward_count < min_reward_count:
        reasons.append("janus_hgrm_reward_count_below_minimum")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_count_below_minimum",
                "artifact_ref": str(reward_path),
                "actual_reward_count": reward_count,
                "minimum_reward_count": min_reward_count,
            }
        )


def _append_benchmark_parity_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    benchmark_payload = _as_dict(evidence.get("benchmark_parity"))
    evidence_ref = str(benchmark_payload.get("artifact_ref") or "").strip()
    artifact_ref = _benchmark_parity_artifact_reference(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
    )
    artifact_path = _normalize_artifact_path(
        artifact_ref,
        artifact_root=artifact_root,
    )
    if artifact_path is None:
        if evidence_ref:
            reasons.append("benchmark_parity_artifact_ref_invalid")
            reason_details.append(
                {
                    "reason": "benchmark_parity_artifact_ref_invalid",
                    "artifact_ref": evidence_ref,
                }
            )
        else:
            reasons.append("benchmark_parity_artifact_ref_invalid")
            reason_details.append(
                {
                    "reason": "benchmark_parity_artifact_ref_invalid",
                    "artifact_ref": artifact_ref,
                }
            )
        return
    parity_path = artifact_path
    if not parity_path.exists():
        reasons.append("benchmark_parity_artifact_missing")
        reason_details.append(
            {
                "reason": "benchmark_parity_artifact_missing",
                "artifact_ref": str(parity_path),
            }
        )
        return
    if _load_json_if_exists(parity_path) is None:
        reasons.append("benchmark_parity_artifact_invalid_json")
        reason_details.append(
            {
                "reason": "benchmark_parity_artifact_invalid_json",
                "artifact_ref": str(parity_path),
            }
        )


def _regime_slice_count(benchmark_payload: dict[str, Any]) -> int:
    regime_slices = 0
    for item in _list_from_any(benchmark_payload.get("slices")):
        if not isinstance(item, dict):
            continue
        payload = cast(dict[str, Any], item)
        if str(payload.get("slice_type", "")).strip() == "regime":
            regime_slices += 1
    return regime_slices


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


def _required_artifacts_for_target(
    policy_payload: dict[str, Any],
    promotion_target: str,
    *,
    include_profitability_artifacts: bool,
    include_janus_artifacts: bool,
    include_benchmark_parity_artifacts: bool,
    include_contamination_artifacts: bool,
    include_stress_artifacts: bool,
    include_hmm_state_posterior_artifacts: bool,
    include_expert_router_artifacts: bool,
    require_profitability_manifest: bool,
) -> list[str]:
    base_raw = policy_payload.get(
        "promotion_required_artifacts",
        [
            "research/candidate-spec.json",
            "backtest/evaluation-report.json",
            "gates/gate-evaluation.json",
        ],
    )
    base = _list_from_any(base_raw)
    required = [str(item) for item in base if isinstance(item, str)]
    patch_targets_raw = policy_payload.get(
        "promotion_require_patch_targets", ["paper", "live"]
    )
    patch_targets = _list_from_any(patch_targets_raw)
    if promotion_target in patch_targets:
        required.append("paper-candidate/strategy-configmap-patch.yaml")
    if include_profitability_artifacts:
        profitability_artifacts_raw = policy_payload.get(
            "promotion_profitability_required_artifacts",
            [
                "gates/profitability-evidence-v4.json",
                "gates/profitability-benchmark-v4.json",
                "gates/profitability-evidence-validation.json",
                "gates/recalibration-report.json",
            ],
        )
        profitability_artifacts = _list_from_any(profitability_artifacts_raw)
        for artifact in profitability_artifacts:
            if isinstance(artifact, str):
                required.append(artifact)
    if require_profitability_manifest:
        required.append(
            str(
                policy_payload.get(
                    "promotion_profitability_stage_manifest_artifact",
                    "profitability/profitability-stage-manifest-v1.json",
                )
            )
        )
    if include_janus_artifacts:
        janus_artifacts_raw = policy_payload.get(
            "promotion_janus_required_artifacts",
            [
                "gates/janus-event-car-v1.json",
                "gates/janus-hgrm-reward-v1.json",
            ],
        )
        janus_artifacts = _list_from_any(janus_artifacts_raw)
        for artifact in janus_artifacts:
            if isinstance(artifact, str):
                required.append(artifact)
    if include_benchmark_parity_artifacts:
        benchmark_artifacts = _benchmark_parity_required_artifact_refs(policy_payload)
        for artifact in benchmark_artifacts:
            required.append(artifact)
    if include_contamination_artifacts:
        contamination_artifacts = _contamination_registry_required_artifact_refs(
            policy_payload
        )
        for artifact in contamination_artifacts:
            required.append(artifact)
    if include_stress_artifacts:
        stress_artifacts_raw = policy_payload.get(
            "promotion_stress_required_artifacts",
            ["gates/stress-metrics-v1.json"],
        )
        stress_artifacts = _list_from_any(stress_artifacts_raw)
        for artifact in stress_artifacts:
            if isinstance(artifact, str):
                required.append(artifact)
    if include_hmm_state_posterior_artifacts:
        hmm_artifacts = _hmm_state_posterior_required_artifact_refs(policy_payload)
        for artifact in hmm_artifacts:
            required.append(artifact)
    if include_expert_router_artifacts:
        expert_router_artifacts = _expert_router_required_artifact_refs(policy_payload)
        for artifact in expert_router_artifacts:
            required.append(artifact)
    return sorted(set(required))


def _benchmark_parity_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    benchmark_artifacts_raw = policy_payload.get(
        "promotion_benchmark_required_artifacts",
        ["benchmarks/benchmark-parity-report-v1.json"],
    )
    benchmark_artifacts = [
        str(artifact).strip()
        for artifact in _list_from_any(benchmark_artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if benchmark_artifacts:
        return benchmark_artifacts

    legacy_artifact = str(
        policy_payload.get("promotion_benchmark_parity_artifact", "").strip()
    )
    if legacy_artifact:
        return [legacy_artifact]

    return ["benchmarks/benchmark-parity-report-v1.json"]


def _benchmark_parity_artifact_reference(
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
) -> str:
    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    benchmark_payload = _as_dict(evidence.get("benchmark_parity"))
    evidence_ref = str(benchmark_payload.get("artifact_ref") or "").strip()
    if evidence_ref:
        return evidence_ref

    required_artifacts = _benchmark_parity_required_artifact_refs(policy_payload)
    return required_artifacts[0]


def _contamination_registry_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    contamination_artifacts_raw = policy_payload.get(
        "promotion_contamination_required_artifacts",
        ["gates/contamination-leakage-report-v1.json"],
    )
    contamination_artifacts = [
        str(artifact).strip()
        for artifact in _list_from_any(contamination_artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if contamination_artifacts:
        return contamination_artifacts

    legacy_artifact = str(
        policy_payload.get("promotion_contamination_artifact", "").strip()
    )
    if legacy_artifact:
        return [legacy_artifact]
    return ["gates/contamination-leakage-report-v1.json"]


def _hmm_state_posterior_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_hmm_required_artifacts",
        ["gates/hmm-state-posterior-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in _list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["gates/hmm-state-posterior-v1.json"]


def _expert_router_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_expert_router_required_artifacts",
        ["gates/expert-router-registry-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in _list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["gates/expert-router-registry-v1.json"]


def _requires_hmm_state_posterior(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_hmm_state_posterior", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_hmm_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _requires_expert_router_registry(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_expert_router_registry", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_expert_router_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _requires_profitability_evidence(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("gate6_require_profitability_evidence", True)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_profitability_required_targets", ["paper", "live"]
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _requires_janus_evidence(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("gate6_require_janus_evidence", True)):
        return False
    if not bool(policy_payload.get("promotion_require_janus_evidence", True)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_janus_required_targets", ["paper", "live"]
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _requires_stress_evidence(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_stress_evidence", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_stress_required_targets", ["paper", "live"]
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _requires_contamination_registry(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_contamination_registry", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_contamination_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _required_rollback_checks(policy_payload: dict[str, Any]) -> list[str]:
    checks_raw = policy_payload.get(
        "rollback_required_checks",
        [
            "killSwitchDryRunPassed",
            "gitopsRevertDryRunPassed",
            "strategyDisableDryRunPassed",
        ],
    )
    checks = _list_from_any(checks_raw)
    return [str(item) for item in checks if isinstance(item, str)]


def _normalize_artifact_path(
    artifact_ref: str, *, artifact_root: Path
) -> Path | None:
    normalized_ref = str(artifact_ref).strip()
    if not normalized_ref:
        return None
    if "://" in normalized_ref and not normalized_ref.startswith("file://"):
        return None
    normalized_ref = normalized_ref.removeprefix("file://")

    candidate = Path(normalized_ref)
    if not candidate.is_absolute():
        candidate = artifact_root / candidate
    try:
        normalized_candidate = candidate.resolve()
    except OSError:
        return None
    try:
        normalized_root = artifact_root.resolve()
    except OSError:
        normalized_root = artifact_root
    if not normalized_candidate.is_relative_to(normalized_root):
        return None
    return normalized_candidate


def _required_throughput(policy_payload: dict[str, Any]) -> dict[str, int]:
    return {
        "min_signal_count": max(
            1, _int_or_default(policy_payload.get("promotion_min_signal_count"), 1)
        ),
        "min_decision_count": max(
            1, _int_or_default(policy_payload.get("promotion_min_decision_count"), 1)
        ),
        "min_trade_count": max(
            0, _int_or_default(policy_payload.get("promotion_min_trade_count"), 0)
        ),
    }


def _evaluate_promotion_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    promotion_target: str,
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    if promotion_target == "shadow":
        return reasons, details, refs

    evidence_raw = gate_report_payload.get("promotion_evidence")
    evidence = (
        cast(dict[str, Any], evidence_raw) if isinstance(evidence_raw, dict) else {}
    )
    fold_reasons, fold_details, fold_refs = _evaluate_fold_metrics_evidence(
        policy_payload=policy_payload,
        evidence=evidence,
        artifact_root=artifact_root,
        now=now,
    )
    reasons.extend(fold_reasons)
    details.extend(fold_details)
    refs.extend(fold_refs)

    stress_reasons, stress_details, stress_refs = _evaluate_stress_metrics_evidence(
        policy_payload=policy_payload,
        evidence=evidence,
        artifact_root=artifact_root,
        now=now,
    )
    if _requires_stress_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        reasons.extend(stress_reasons)
        details.extend(stress_details)
        refs.extend(stress_refs)

    janus_reasons, janus_details, janus_refs = _evaluate_janus_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
        evidence=evidence,
        artifact_root=artifact_root,
        now=now,
    )
    reasons.extend(janus_reasons)
    details.extend(janus_details)
    refs.extend(janus_refs)

    contamination_reasons, contamination_details, contamination_refs = (
        _evaluate_contamination_registry_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(contamination_reasons)
    details.extend(contamination_details)
    refs.extend(contamination_refs)

    hmm_reasons, hmm_details, hmm_refs = _evaluate_hmm_state_posterior_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        artifact_root=artifact_root,
        promotion_target=promotion_target,
    )
    reasons.extend(hmm_reasons)
    details.extend(hmm_details)
    refs.extend(hmm_refs)

    expert_router_reasons, expert_router_details, expert_router_refs = (
        _evaluate_expert_router_registry_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(expert_router_reasons)
    details.extend(expert_router_details)
    refs.extend(expert_router_refs)

    rationale_reasons, rationale_details = _evaluate_rationale_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        evidence=evidence,
        promotion_target=promotion_target,
    )
    reasons.extend(rationale_reasons)
    details.extend(rationale_details)

    benchmark_parity_reasons, benchmark_parity_details, benchmark_parity_refs = (
        _evaluate_benchmark_parity_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(benchmark_parity_reasons)
    details.extend(benchmark_parity_details)
    refs.extend(benchmark_parity_refs)

    parity_reasons, parity_details, parity_refs = (
        _evaluate_foundation_router_parity_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(parity_reasons)
    details.extend(parity_details)
    refs.extend(parity_refs)

    return sorted(set(reasons)), details, sorted(set(refs))


def _requires_foundation_router_parity(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    return bool(policy_payload.get("promotion_require_foundation_router_parity", False))


def _requires_benchmark_parity(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_benchmark_parity", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_benchmark_parity_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _evaluate_benchmark_parity_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_benchmark_parity(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    benchmark = _as_dict(evidence.get("benchmark_parity"))
    evidence_ref = str(benchmark.get("artifact_ref") or "").strip()
    artifact_ref = _benchmark_parity_artifact_reference(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
    )
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append("benchmark_parity_artifact_ref_invalid")
        details.append(
            {
                "reason": "benchmark_parity_artifact_ref_invalid",
                "artifact_ref": artifact_ref,
            }
        )
        return reasons, details, refs

    refs.append(evidence_ref or str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append("benchmark_parity_artifact_invalid_json")
        details.append(
            {
                "reason": "benchmark_parity_artifact_invalid_json",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    if not str(payload.get("artifact_hash", "")).strip():
        reasons.append("benchmark_parity_artifact_hash_missing")
        details.append(
            {
                "reason": "benchmark_parity_artifact_hash_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        expected_hash = hashlib.sha256(
            json.dumps(
                {key: value for key, value in payload.items() if key != "artifact_hash"},
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        if str(payload.get("artifact_hash", "")).strip() != expected_hash:
            reasons.append("benchmark_parity_artifact_hash_mismatch")
            details.append(
                {
                    "reason": "benchmark_parity_artifact_hash_mismatch",
                    "artifact_ref": str(artifact_path),
                    "artifact_hash": str(payload.get("artifact_hash", "")),
                    "expected_artifact_hash": expected_hash,
                }
            )

    candidate_id = str(payload.get("candidate_id", "")).strip()
    if not candidate_id:
        reasons.append("benchmark_parity_candidate_id_missing")
        details.append(
            {
                "reason": "benchmark_parity_candidate_id_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    baseline_candidate_id = str(payload.get("baseline_candidate_id", "")).strip()
    if not baseline_candidate_id:
        reasons.append("benchmark_parity_baseline_candidate_id_missing")
        details.append(
            {
                "reason": "benchmark_parity_baseline_candidate_id_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != BENCHMARK_PARITY_SCHEMA_VERSION:
        reasons.append("benchmark_parity_schema_version_invalid")
        details.append(
            {
                "reason": "benchmark_parity_schema_version_invalid",
                "artifact_ref": str(artifact_path),
                "schema_version": schema_version,
                "expected_schema_version": BENCHMARK_PARITY_SCHEMA_VERSION,
            }
        )

    contract = _as_dict(payload.get("contract"))
    if not contract:
        reasons.append("benchmark_parity_contract_missing")
        details.append(
            {
                "reason": "benchmark_parity_contract_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        contract_schema_version = str(contract.get("schema_version", "")).strip()
        if contract_schema_version != BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION:
            reasons.append("benchmark_parity_contract_schema_version_invalid")
            details.append(
                {
                    "reason": "benchmark_parity_contract_schema_version_invalid",
                    "artifact_ref": str(artifact_path),
                    "schema_version": contract_schema_version,
                    "expected_schema_version": BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
                }
            )

        required_families_contract = {
            str(item).strip().lower()
            for item in _list_from_any(contract.get("required_families"))
            if str(item).strip()
        }
        if required_families_contract != set(BENCHMARK_PARITY_REQUIRED_FAMILIES):
            reasons.append("benchmark_parity_contract_required_families_invalid")
            details.append(
                {
                    "reason": "benchmark_parity_contract_required_families_invalid",
                    "artifact_ref": str(artifact_path),
                    "required_families": sorted(required_families_contract),
                    "expected_required_families": sorted(
                        BENCHMARK_PARITY_REQUIRED_FAMILIES
                    ),
                }
            )

        required_scorecards_contract = {
            str(item).strip().lower()
            for item in _list_from_any(contract.get("required_scorecards"))
            if str(item).strip()
        }
        if required_scorecards_contract != set(BENCHMARK_PARITY_REQUIRED_SCORECARDS):
            reasons.append("benchmark_parity_contract_required_scorecards_invalid")
            details.append(
                {
                    "reason": "benchmark_parity_contract_required_scorecards_invalid",
                    "artifact_ref": str(artifact_path),
                    "required_scorecards": sorted(required_scorecards_contract),
                    "expected_required_scorecards": sorted(
                        BENCHMARK_PARITY_REQUIRED_SCORECARDS
                    ),
                }
            )

        required_scorecard_fields_contract = {
            str(scorecard_name).strip(): tuple(
                str(field).strip()
                for field in _list_from_any(required_fields)
                if str(field).strip()
            )
            for scorecard_name, required_fields in _as_dict(
                contract.get("required_scorecard_fields")
            ).items()
            if str(scorecard_name).strip()
        }
        if required_scorecard_fields_contract != BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS:
            reasons.append("benchmark_parity_contract_required_scorecard_fields_invalid")
            details.append(
                {
                    "reason": "benchmark_parity_contract_required_scorecard_fields_invalid",
                    "artifact_ref": str(artifact_path),
                    "required_scorecard_fields": {
                        name: list(fields)
                        for name, fields in required_scorecard_fields_contract.items()
                    },
                    "expected_required_scorecard_fields": {
                        name: list(fields)
                        for name, fields in BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS.items()
                    },
                }
            )

        required_run_fields_contract = {
            str(item).strip()
            for item in _list_from_any(contract.get("required_run_fields"))
            if str(item).strip()
        }
        if required_run_fields_contract != set(BENCHMARK_PARITY_REQUIRED_RUN_FIELDS):
            reasons.append("benchmark_parity_contract_required_run_fields_invalid")
            details.append(
                {
                    "reason": "benchmark_parity_contract_required_run_fields_invalid",
                    "artifact_ref": str(artifact_path),
                    "required_run_fields": sorted(required_run_fields_contract),
                    "expected_required_run_fields": sorted(
                        BENCHMARK_PARITY_REQUIRED_RUN_FIELDS
                    ),
                }
            )

        hash_algorithm = str(contract.get("hash_algorithm", "")).strip().lower()
        if hash_algorithm != "sha256":
            reasons.append("benchmark_parity_contract_hash_algorithm_invalid")
            details.append(
                {
                    "reason": "benchmark_parity_contract_hash_algorithm_invalid",
                    "artifact_ref": str(artifact_path),
                    "hash_algorithm": hash_algorithm,
                    "expected_hash_algorithm": "sha256",
                }
            )

    if str(payload.get("overall_parity_status", "")).strip() != "pass":
        reasons.append("benchmark_parity_status_not_pass")
        details.append(
            {
                "reason": "benchmark_parity_status_not_pass",
                "artifact_ref": str(artifact_path),
                "status": payload.get("overall_parity_status"),
            }
        )

    scorecards = _as_dict(payload.get("scorecards"))
    required_scorecards = tuple(
        (name, scorecards.get(name))
        for name in BENCHMARK_PARITY_REQUIRED_SCORECARDS
    )
    for scorecard_name, scorecard in required_scorecards:
        scorecard_payload = _as_dict(scorecard)
        card_status = str(scorecard_payload.get("status", "")).strip()
        if not scorecard_payload:
            reasons.append("benchmark_parity_scorecard_missing")
            details.append(
                {
                    "reason": "benchmark_parity_scorecard_missing",
                    "artifact_ref": str(artifact_path),
                    "scorecard": scorecard_name,
                }
            )
        elif card_status != "pass":
            reasons.append("benchmark_parity_scorecard_not_pass")
            details.append(
                {
                    "reason": "benchmark_parity_scorecard_not_pass",
                    "artifact_ref": str(artifact_path),
                    "scorecard": scorecard_name,
                    "status": card_status,
                }
            )
        missing_required_scorecard_fields = [
            field
            for field in BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS.get(
                scorecard_name, ()
            )
            if field not in scorecard_payload
        ]
        if missing_required_scorecard_fields:
            reasons.append("benchmark_parity_scorecard_missing_required_fields")
            details.append(
                {
                    "reason": "benchmark_parity_scorecard_missing_required_fields",
                    "artifact_ref": str(artifact_path),
                    "scorecard": scorecard_name,
                    "missing_fields": missing_required_scorecard_fields,
                }
            )

    benchmark_runs = _list_from_any(payload.get("benchmark_runs"))
    if not benchmark_runs:
        reasons.append("benchmark_parity_runs_missing")
        details.append(
            {
                "reason": "benchmark_parity_runs_missing",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    min_advisory_output_rate = _float_or_none(
        policy_payload.get("promotion_benchmark_parity_min_advisory_output_rate")
    )
    if min_advisory_output_rate is None:
        min_advisory_output_rate = 0.995
    max_policy_violation_degradation = _float_or_none(
        policy_payload.get(
            "promotion_benchmark_parity_max_policy_violation_rate_degradation"
        )
    )
    if max_policy_violation_degradation is None:
        max_policy_violation_degradation = 0.0
    max_fallback_rate = _float_or_none(
        policy_payload.get("promotion_benchmark_parity_max_fallback_rate")
    )
    if max_fallback_rate is None:
        max_fallback_rate = 0.01
    max_timeout_rate = _float_or_none(
        policy_payload.get("promotion_benchmark_parity_max_timeout_rate")
    )
    if max_timeout_rate is None:
        max_timeout_rate = 0.005
    max_adverse_regime_degradation = _float_or_none(
        policy_payload.get(
            "promotion_benchmark_parity_max_adverse_regime_decision_quality_degradation"
        )
    )
    if max_adverse_regime_degradation is None:
        max_adverse_regime_degradation = 0.01
    max_risk_veto_degradation = _float_or_none(
        policy_payload.get(
            "promotion_benchmark_parity_max_risk_veto_alignment_degradation"
        )
    )
    if max_risk_veto_degradation is None:
        max_risk_veto_degradation = 0.01
    max_confidence_degradation = _float_or_none(
        policy_payload.get(
            "promotion_benchmark_parity_max_confidence_calibration_error_degradation"
        )
    )
    if max_confidence_degradation is None:
        max_confidence_degradation = 0.01
    max_scorecard_confidence_drift = _float_or_none(
        policy_payload.get(
            "promotion_benchmark_parity_max_scorecard_confidence_calibration_error_drift"
        )
    )
    if max_scorecard_confidence_drift is None:
        max_scorecard_confidence_drift = max_confidence_degradation
    min_family_coverage_ratio = _float_or_none(
        policy_payload.get("promotion_benchmark_parity_min_family_coverage_ratio")
    )
    if min_family_coverage_ratio is None:
        min_family_coverage_ratio = 1.0

    forecast_scorecard = _as_dict(scorecards.get("forecast_quality"))
    forecast_confidence_error = _float_or_none(
        forecast_scorecard.get("confidence_calibration_error")
    )
    forecast_confidence_error_baseline = _float_or_none(
        forecast_scorecard.get("confidence_calibration_error_baseline")
    )
    if forecast_confidence_error is None or forecast_confidence_error_baseline is None:
        reasons.append(
            "benchmark_parity_scorecard_confidence_calibration_error_fields_missing"
        )
        details.append(
            {
                "reason": "benchmark_parity_scorecard_confidence_calibration_error_fields_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif (
        forecast_confidence_error - forecast_confidence_error_baseline
        > max_scorecard_confidence_drift
    ):
        reasons.append(
            "benchmark_parity_scorecard_confidence_calibration_error_drift_exceeds_threshold"
        )
        details.append(
            {
                "reason": "benchmark_parity_scorecard_confidence_calibration_error_drift_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_confidence_calibration_error": forecast_confidence_error,
                "baseline_confidence_calibration_error": forecast_confidence_error_baseline,
                "maximum_drift": max_scorecard_confidence_drift,
            }
        )

    families_seen = set[str]()
    required_families = set(BENCHMARK_PARITY_REQUIRED_FAMILIES)
    for run in _as_list_of_dicts(benchmark_runs):
        family = str(run.get("family", "")).strip().lower()
        if family:
            families_seen.add(family)

        run_schema_version = str(run.get("schema_version", "")).strip()
        if run_schema_version != BENCHMARK_PARITY_RUN_SCHEMA_VERSION:
            reasons.append("benchmark_parity_run_schema_version_invalid")
            details.append(
                {
                    "reason": "benchmark_parity_run_schema_version_invalid",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                    "schema_version": run_schema_version,
                    "expected_schema_version": BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
                }
            )

        missing_required_run_fields: list[str] = []
        for field in BENCHMARK_PARITY_REQUIRED_RUN_FIELDS:
            if field in {"dataset_ref", "window_ref", "family", "run_hash"}:
                if not str(run.get(field, "")).strip():
                    missing_required_run_fields.append(field)
            else:
                value = run.get(field)
                if not isinstance(value, dict) or not value:
                    missing_required_run_fields.append(field)
        if missing_required_run_fields:
            reasons.append("benchmark_parity_run_missing_required_fields")
            details.append(
                {
                    "reason": "benchmark_parity_run_missing_required_fields",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                    "missing_fields": missing_required_run_fields,
                }
            )
            continue

        metrics = _as_dict(run.get("metrics"))
        violations = _as_dict(run.get("policy_violations"))

        advisory_output_rate = _float_or_none(metrics.get("advisory_output_rate"))
        if advisory_output_rate is None:
            reasons.append("benchmark_parity_missing_advisory_output_rate")
            details.append(
                {
                    "reason": "benchmark_parity_missing_advisory_output_rate",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                }
            )
        elif advisory_output_rate < min_advisory_output_rate:
            reasons.append("benchmark_parity_advisory_output_rate_below_minimum")
            details.append(
                {
                    "reason": "benchmark_parity_advisory_output_rate_below_minimum",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                    "actual_advisory_output_rate": advisory_output_rate,
                    "minimum_advisory_output_rate": min_advisory_output_rate,
                }
            )

        policy_violation_rate = _float_or_none(violations.get("rate"))
        baseline_policy_violation_rate = _float_or_none(violations.get("baseline_rate"))
        if policy_violation_rate is None or baseline_policy_violation_rate is None:
            reasons.append("benchmark_parity_policy_violation_rate_missing")
            details.append(
                {
                    "reason": "benchmark_parity_policy_violation_rate_missing",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                }
            )
        elif policy_violation_rate - baseline_policy_violation_rate > max_policy_violation_degradation:
            reasons.append("benchmark_parity_policy_violation_rate_degraded")
            details.append(
                {
                    "reason": "benchmark_parity_policy_violation_rate_degraded",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                    "actual_rate": policy_violation_rate,
                    "baseline_rate": baseline_policy_violation_rate,
                    "max_degradation": max_policy_violation_degradation,
                }
            )

        fallback_rate = _float_or_none(violations.get("fallback_rate"))
        if fallback_rate is None:
            reasons.append("benchmark_parity_fallback_rate_missing")
            details.append(
                {
                    "reason": "benchmark_parity_fallback_rate_missing",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                }
            )
        elif fallback_rate > max_fallback_rate:
            reasons.append("benchmark_parity_fallback_rate_exceeds_threshold")
            details.append(
                {
                    "reason": "benchmark_parity_fallback_rate_exceeds_threshold",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                    "actual_fallback_rate": fallback_rate,
                    "maximum_fallback_rate": max_fallback_rate,
                }
            )

        timeout_rate = _float_or_none(violations.get("timeout_rate"))
        if timeout_rate is None:
            reasons.append("benchmark_parity_timeout_rate_missing")
            details.append(
                {
                    "reason": "benchmark_parity_timeout_rate_missing",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                }
            )
        elif timeout_rate > max_timeout_rate:
            reasons.append("benchmark_parity_timeout_rate_exceeds_threshold")
            details.append(
                {
                    "reason": "benchmark_parity_timeout_rate_exceeds_threshold",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                    "actual_timeout_rate": timeout_rate,
                    "maximum_timeout_rate": max_timeout_rate,
                }
            )

        if (
            _coerce_evidence_bool(
                violations.get("deterministic_gate_compatible")
            )
            is not True
        ):
            reasons.append("benchmark_parity_deterministic_gate_compatibility_failed")
            details.append(
                {
                    "reason": "benchmark_parity_deterministic_gate_compatibility_failed",
                    "artifact_ref": str(artifact_path),
                    "family": family,
                }
            )

    missing_families = sorted(required_families - families_seen)
    if missing_families:
        reasons.append("benchmark_parity_family_results_missing")
        details.append(
            {
                "reason": "benchmark_parity_family_results_missing",
                "artifact_ref": str(artifact_path),
                "missing_families": missing_families,
            }
        )
    unexpected_families = sorted(families_seen - required_families)
    if unexpected_families:
        reasons.append("benchmark_parity_family_results_unexpected")
        details.append(
            {
                "reason": "benchmark_parity_family_results_unexpected",
                "artifact_ref": str(artifact_path),
                "unexpected_families": unexpected_families,
            }
        )
    family_coverage_ratio = (
        (len(families_seen & required_families) / len(required_families))
        if required_families
        else 1.0
    )
    if family_coverage_ratio < min_family_coverage_ratio:
        reasons.append("benchmark_parity_family_coverage_ratio_below_minimum")
        details.append(
            {
                "reason": "benchmark_parity_family_coverage_ratio_below_minimum",
                "artifact_ref": str(artifact_path),
                "coverage_ratio": family_coverage_ratio,
                "minimum_coverage_ratio": min_family_coverage_ratio,
            }
        )

    degradation = _as_dict(payload.get("degradation_summary"))
    adverse_regime = _as_dict(degradation.get("adverse_regime_decision_quality"))
    risk_veto = _as_dict(degradation.get("risk_veto_alignment"))
    confidence_error = _as_dict(degradation.get("confidence_calibration_error"))

    adverse_regime_degradation = _float_or_none(adverse_regime.get("degradation"))
    if adverse_regime_degradation is None:
        reasons.append("benchmark_parity_adverse_regime_degradation_missing")
        details.append(
            {
                "reason": "benchmark_parity_adverse_regime_degradation_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif adverse_regime_degradation > max_adverse_regime_degradation:
        reasons.append("benchmark_parity_adverse_regime_degradation_exceeds_threshold")
        details.append(
            {
                "reason": "benchmark_parity_adverse_regime_degradation_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_degradation": adverse_regime_degradation,
                "maximum_degradation": max_adverse_regime_degradation,
            }
        )

    risk_veto_degradation = _float_or_none(risk_veto.get("degradation"))
    if risk_veto_degradation is None:
        reasons.append("benchmark_parity_risk_veto_degradation_missing")
        details.append(
            {
                "reason": "benchmark_parity_risk_veto_degradation_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif risk_veto_degradation > max_risk_veto_degradation:
        reasons.append("benchmark_parity_risk_veto_degradation_exceeds_threshold")
        details.append(
            {
                "reason": "benchmark_parity_risk_veto_degradation_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_degradation": risk_veto_degradation,
                "maximum_degradation": max_risk_veto_degradation,
            }
        )

    confidence_degradation = _float_or_none(confidence_error.get("degradation"))
    if confidence_degradation is None:
        reasons.append(
            "benchmark_parity_confidence_calibration_error_degradation_missing"
        )
        details.append(
            {
                "reason": "benchmark_parity_confidence_calibration_error_degradation_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif confidence_degradation > max_confidence_degradation:
        reasons.append(
            "benchmark_parity_confidence_calibration_error_degradation_exceeds_threshold"
        )
        details.append(
            {
                "reason": "benchmark_parity_confidence_calibration_error_degradation_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_degradation": confidence_degradation,
                "maximum_degradation": max_confidence_degradation,
            }
        )

    return reasons, details, refs


def _evaluate_foundation_router_parity_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_foundation_router_parity(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    foundation = _as_dict(evidence.get("foundation_router_parity"))
    evidence_ref = str(foundation.get("artifact_ref") or "").strip()
    if not evidence_ref:
        reasons.append("foundation_router_parity_artifact_ref_missing")
        details.append({"reason": "foundation_router_parity_artifact_ref_missing"})

    artifact_ref = (
        evidence_ref
        or str(
            policy_payload.get(
                "promotion_foundation_router_parity_artifact",
                "gates/foundation-router-parity-report-v1.json",
            )
        )
    ).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append("foundation_router_parity_artifact_ref_invalid")
        details.append(
            {
                "reason": "foundation_router_parity_artifact_ref_invalid",
                "artifact_ref": artifact_ref,
            }
        )
        return reasons, details, refs

    refs.append(str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append("foundation_router_parity_artifact_missing")
        details.append(
            {
                "reason": "foundation_router_parity_artifact_missing",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    overall_status = str(payload.get("overall_status", "")).strip()
    if overall_status != "pass":
        reasons.append("foundation_router_parity_overall_status_not_pass")
        details.append(
            {
                "reason": "foundation_router_parity_overall_status_not_pass",
                "artifact_ref": str(artifact_path),
                "status": overall_status,
            }
        )

    max_fallback_rate = _float_or_none(
        _as_dict(payload.get("fallback_metrics")).get("fallback_rate")
    )
    fallback_threshold = _float_or_none(
        policy_payload.get(
            "promotion_router_parity_max_fallback_rate",
            policy_payload.get("gate3_max_forecast_fallback_rate", 0.05),
        )
    )
    if max_fallback_rate is None:
        reasons.append("foundation_router_parity_fallback_rate_missing")
        details.append(
            {
                "reason": "foundation_router_parity_fallback_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif fallback_threshold is not None and max_fallback_rate > fallback_threshold:
        reasons.append("foundation_router_parity_fallback_rate_exceeds_threshold")
        details.append(
            {
                "reason": "foundation_router_parity_fallback_rate_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_fallback_rate": max_fallback_rate,
                "maximum_fallback_rate": fallback_threshold,
            }
        )

    calibration_min = _float_or_none(
        _as_dict(payload.get("calibration_metrics")).get("minimum")
    )
    min_calibration = _float_or_none(
        policy_payload.get(
            "promotion_router_parity_min_calibration_score",
            policy_payload.get("gate3_min_forecast_calibration_score", 0.85),
        )
    )
    if calibration_min is None:
        reasons.append("foundation_router_parity_calibration_minimum_missing")
        details.append(
            {
                "reason": "foundation_router_parity_calibration_minimum_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif min_calibration is not None and calibration_min < min_calibration:
        reasons.append("foundation_router_parity_calibration_minimum_below_threshold")
        details.append(
            {
                "reason": "foundation_router_parity_calibration_minimum_below_threshold",
                "artifact_ref": str(artifact_path),
                "actual_minimum_calibration": calibration_min,
                "minimum_required": min_calibration,
            }
        )

    drift_max = _float_or_none(_as_dict(payload.get("drift_metrics")).get("max"))
    max_drift = _float_or_none(
        policy_payload.get(
            "promotion_router_parity_max_drift",
            policy_payload.get("gate6_max_calibration_error", 0.45),
        )
    )
    if drift_max is None:
        reasons.append("foundation_router_parity_drift_max_missing")
        details.append(
            {
                "reason": "foundation_router_parity_drift_max_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif max_drift is not None and drift_max > max_drift:
        reasons.append("foundation_router_parity_drift_exceeds_threshold")
        details.append(
            {
                "reason": "foundation_router_parity_drift_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_max_drift": drift_max,
                "maximum_drift": max_drift,
            }
        )

    return reasons, details, refs


def _evaluate_janus_evidence(
    *,
    policy_payload: dict[str, Any],
    promotion_target: str,
    evidence: dict[str, Any],
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_janus_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []
    if not bool(policy_payload.get("promotion_require_janus_evidence", True)):
        return [], [], []
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    janus_raw = evidence.get("janus_q")
    janus = cast(dict[str, Any], janus_raw) if isinstance(janus_raw, dict) else {}
    if not janus:
        reasons.append("janus_q_evidence_missing")
        details.append({"reason": "janus_q_evidence_missing"})
        return reasons, details, refs

    event_raw = janus.get("event_car")
    event_car = cast(dict[str, Any], event_raw) if isinstance(event_raw, dict) else {}
    event_ref = str(event_car.get("artifact_ref") or "").strip()
    _append_evidence_artifact_reasons(
        reasons=reasons,
        reason_details=details,
        evidence_name="janus_event_car",
        artifact_root=artifact_root,
        raw_ref=event_ref,
        policy_payload=policy_payload,
        now=now,
    )
    event_count = _int_or_default(event_car.get("count"), 0)
    min_event_count = max(
        1, _int_or_default(policy_payload.get("promotion_min_janus_event_count"), 1)
    )
    if event_count < min_event_count:
        reasons.append("janus_event_car_evidence_insufficient")
        details.append(
            {
                "reason": "janus_event_car_evidence_insufficient",
                "actual_event_count": event_count,
                "minimum_event_count": min_event_count,
            }
        )
    if event_ref:
        refs.append(event_ref)

    reward_raw = janus.get("hgrm_reward")
    hgrm_reward = (
        cast(dict[str, Any], reward_raw) if isinstance(reward_raw, dict) else {}
    )
    reward_ref = str(hgrm_reward.get("artifact_ref") or "").strip()
    _append_evidence_artifact_reasons(
        reasons=reasons,
        reason_details=details,
        evidence_name="janus_hgrm_reward",
        artifact_root=artifact_root,
        raw_ref=reward_ref,
        policy_payload=policy_payload,
        now=now,
    )
    reward_count = _int_or_default(hgrm_reward.get("count"), 0)
    min_reward_count = max(
        1, _int_or_default(policy_payload.get("promotion_min_janus_reward_count"), 1)
    )
    if reward_count < min_reward_count:
        reasons.append("janus_hgrm_reward_evidence_insufficient")
        details.append(
            {
                "reason": "janus_hgrm_reward_evidence_insufficient",
                "actual_reward_count": reward_count,
                "minimum_reward_count": min_reward_count,
            }
        )
    if reward_ref:
        refs.append(reward_ref)

    if not bool(janus.get("evidence_complete", False)):
        reasons.append("janus_q_evidence_incomplete")
        details.append(
            {
                "reason": "janus_q_evidence_incomplete",
                "reasons": _list_of_strings(janus.get("reasons")),
            }
        )
    return reasons, details, refs


def _evaluate_contamination_registry_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_contamination_registry(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    contamination = _as_dict(evidence.get("contamination_registry"))
    evidence_ref = str(contamination.get("artifact_ref") or "").strip()
    required_artifacts = _contamination_registry_required_artifact_refs(policy_payload)
    artifact_ref = (evidence_ref or required_artifacts[0]).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append("contamination_registry_artifact_ref_invalid")
        details.append(
            {
                "reason": "contamination_registry_artifact_ref_invalid",
                "artifact_ref": artifact_ref,
            }
        )
        return reasons, details, refs

    refs.append(evidence_ref or str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append("contamination_registry_artifact_invalid_json")
        details.append(
            {
                "reason": "contamination_registry_artifact_invalid_json",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != "contamination-leakage-report-v1":
        reasons.append("contamination_registry_schema_version_invalid")
        details.append(
            {
                "reason": "contamination_registry_schema_version_invalid",
                "artifact_ref": str(artifact_path),
                "schema_version": schema_version,
                "expected_schema_version": "contamination-leakage-report-v1",
            }
        )

    status = str(payload.get("status", "")).strip()
    if status != "pass":
        reasons.append("contamination_registry_status_not_pass")
        details.append(
            {
                "reason": "contamination_registry_status_not_pass",
                "artifact_ref": str(artifact_path),
                "status": status,
            }
        )

    leakage_detected = _coerce_evidence_bool(payload.get("leakage_detected"))
    if leakage_detected is not False:
        reasons.append("contamination_registry_leakage_detected")
        details.append(
            {
                "reason": "contamination_registry_leakage_detected",
                "artifact_ref": str(artifact_path),
                "leakage_detected": payload.get("leakage_detected"),
            }
        )
    leakage_rate = _float_or_none(payload.get("leakage_rate"))
    max_leakage_rate = _float_or_none(
        policy_payload.get("promotion_contamination_max_leakage_rate")
    )
    if max_leakage_rate is None:
        max_leakage_rate = 0.0
    if leakage_rate is None:
        reasons.append("contamination_registry_leakage_rate_missing")
        details.append(
            {
                "reason": "contamination_registry_leakage_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif leakage_rate > max_leakage_rate:
        reasons.append("contamination_registry_leakage_rate_exceeds_threshold")
        details.append(
            {
                "reason": "contamination_registry_leakage_rate_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_leakage_rate": leakage_rate,
                "maximum_leakage_rate": max_leakage_rate,
            }
        )

    temporal_integrity = _as_dict(payload.get("temporal_integrity"))
    if (
        _coerce_evidence_bool(temporal_integrity.get("event_time_ordering_passed"))
        is not True
    ):
        reasons.append("contamination_registry_temporal_ordering_failed")
        details.append(
            {
                "reason": "contamination_registry_temporal_ordering_failed",
                "artifact_ref": str(artifact_path),
            }
        )
    if _coerce_evidence_bool(temporal_integrity.get("embargo_windows_enforced")) is not True:
        reasons.append("contamination_registry_embargo_controls_missing")
        details.append(
            {
                "reason": "contamination_registry_embargo_controls_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    source_lineage = _as_dict(payload.get("source_lineage"))
    if _coerce_evidence_bool(source_lineage.get("complete")) is not True:
        reasons.append("contamination_registry_source_lineage_incomplete")
        details.append(
            {
                "reason": "contamination_registry_source_lineage_incomplete",
                "artifact_ref": str(artifact_path),
            }
        )

    checks_index = {
        str(item.get("check", "")).strip(): str(item.get("status", "")).strip()
        for item in _as_list_of_dicts(payload.get("checks"))
    }
    required_checks_raw = policy_payload.get(
        "promotion_contamination_required_checks",
        [
            "temporal_ordering",
            "lineage_complete",
            "leakage_absent",
            "embargo_windows_enforced",
        ],
    )
    required_checks = [
        str(item).strip()
        for item in _list_from_any(required_checks_raw)
        if isinstance(item, str) and str(item).strip()
    ]
    for required_check in required_checks:
        status_value = checks_index.get(required_check)
        if status_value is None:
            reasons.append("contamination_registry_required_check_missing")
            details.append(
                {
                    "reason": "contamination_registry_required_check_missing",
                    "artifact_ref": str(artifact_path),
                    "check": required_check,
                }
            )
            continue
        if status_value != "pass":
            reasons.append("contamination_registry_required_check_failed")
            details.append(
                {
                    "reason": "contamination_registry_required_check_failed",
                    "artifact_ref": str(artifact_path),
                    "check": required_check,
                    "status": status_value,
                }
            )

    artifact_hash = str(payload.get("artifact_hash", "")).strip()
    if not artifact_hash:
        reasons.append("contamination_registry_artifact_hash_missing")
        details.append(
            {
                "reason": "contamination_registry_artifact_hash_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        expected_hash = _sha256_json(
            {key: value for key, value in payload.items() if key != "artifact_hash"}
        )
        if artifact_hash != expected_hash:
            reasons.append("contamination_registry_artifact_hash_mismatch")
            details.append(
                {
                    "reason": "contamination_registry_artifact_hash_mismatch",
                    "artifact_ref": str(artifact_path),
                    "artifact_hash": artifact_hash,
                    "expected_artifact_hash": expected_hash,
                }
            )

    return reasons, details, refs


def _evaluate_hmm_state_posterior_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_hmm_state_posterior(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    hmm_posterior = _as_dict(evidence.get("hmm_state_posterior"))
    evidence_ref = str(hmm_posterior.get("artifact_ref") or "").strip()
    if not evidence_ref:
        reasons.append("hmm_state_posterior_artifact_ref_missing")
        details.append({"reason": "hmm_state_posterior_artifact_ref_missing"})

    required_artifacts = _hmm_state_posterior_required_artifact_refs(policy_payload)
    artifact_ref = (evidence_ref or required_artifacts[0]).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append("hmm_state_posterior_artifact_ref_invalid")
        details.append(
            {
                "reason": "hmm_state_posterior_artifact_ref_invalid",
                "artifact_ref": artifact_ref,
            }
        )
        return reasons, details, refs

    refs.append(evidence_ref or str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append("hmm_state_posterior_artifact_invalid_json")
        details.append(
            {
                "reason": "hmm_state_posterior_artifact_invalid_json",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != "hmm-state-posterior-v1":
        reasons.append("hmm_state_posterior_schema_version_invalid")
        details.append(
            {
                "reason": "hmm_state_posterior_schema_version_invalid",
                "artifact_ref": str(artifact_path),
                "schema_version": schema_version,
            }
        )

    run_id = str(payload.get("run_id", "")).strip()
    if not run_id:
        reasons.append("hmm_state_posterior_run_id_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_run_id_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    candidate_id = str(payload.get("candidate_id", "")).strip()
    if not candidate_id:
        reasons.append("hmm_state_posterior_candidate_id_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_candidate_id_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    samples_total = _int_or_default(payload.get("samples_total"), -1)
    if samples_total < 0:
        reasons.append("hmm_state_posterior_samples_total_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_samples_total_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    authoritative_samples = _int_or_default(payload.get("authoritative_samples"), -1)
    if authoritative_samples < 0:
        reasons.append("hmm_state_posterior_authoritative_samples_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_authoritative_samples_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif samples_total >= 0 and authoritative_samples > samples_total:
        reasons.append("hmm_state_posterior_authoritative_samples_invalid")
        details.append(
            {
                "reason": "hmm_state_posterior_authoritative_samples_invalid",
                "artifact_ref": str(artifact_path),
                "samples_total": samples_total,
                "authoritative_samples": authoritative_samples,
            }
        )

    authoritative_ratio = _float_or_none(payload.get("authoritative_sample_ratio"))
    if authoritative_ratio is None:
        reasons.append("hmm_state_posterior_authoritative_ratio_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_authoritative_ratio_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        min_authoritative_ratio = _float_or_none(
            policy_payload.get("promotion_hmm_min_authoritative_sample_ratio")
        )
        if (
            min_authoritative_ratio is not None
            and authoritative_ratio < min_authoritative_ratio
        ):
            reasons.append("hmm_state_posterior_authoritative_ratio_below_threshold")
            details.append(
                {
                    "reason": "hmm_state_posterior_authoritative_ratio_below_threshold",
                    "artifact_ref": str(artifact_path),
                    "actual_ratio": authoritative_ratio,
                    "minimum_ratio": min_authoritative_ratio,
                }
            )

    transition_shock_samples = _int_or_default(payload.get("transition_shock_samples"), -1)
    if transition_shock_samples < 0:
        reasons.append("hmm_state_posterior_transition_shock_samples_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_transition_shock_samples_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif samples_total >= 0 and transition_shock_samples > samples_total:
        reasons.append("hmm_state_posterior_transition_shock_samples_invalid")
        details.append(
            {
                "reason": "hmm_state_posterior_transition_shock_samples_invalid",
                "artifact_ref": str(artifact_path),
                "samples_total": samples_total,
                "transition_shock_samples": transition_shock_samples,
            }
        )

    stale_or_defensive_samples = _int_or_default(
        payload.get("stale_or_defensive_samples"),
        -1,
    )
    if stale_or_defensive_samples < 0:
        reasons.append("hmm_state_posterior_stale_or_defensive_samples_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_stale_or_defensive_samples_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif samples_total >= 0 and stale_or_defensive_samples > samples_total:
        reasons.append("hmm_state_posterior_stale_or_defensive_samples_invalid")
        details.append(
            {
                "reason": "hmm_state_posterior_stale_or_defensive_samples_invalid",
                "artifact_ref": str(artifact_path),
                "samples_total": samples_total,
                "stale_or_defensive_samples": stale_or_defensive_samples,
            }
        )

    if samples_total > 0:
        max_transition_shock_ratio = _float_or_none(
            policy_payload.get("promotion_hmm_max_transition_shock_ratio")
        )
        if (
            max_transition_shock_ratio is not None
            and transition_shock_samples >= 0
            and (transition_shock_samples / samples_total) > max_transition_shock_ratio
        ):
            reasons.append("hmm_state_posterior_transition_shock_ratio_exceeds_threshold")
            details.append(
                {
                    "reason": "hmm_state_posterior_transition_shock_ratio_exceeds_threshold",
                    "artifact_ref": str(artifact_path),
                    "samples_total": samples_total,
                    "transition_shock_samples": transition_shock_samples,
                    "actual_ratio": transition_shock_samples / samples_total,
                    "maximum_ratio": max_transition_shock_ratio,
                }
            )

        max_stale_or_defensive_ratio = _float_or_none(
            policy_payload.get("promotion_hmm_max_stale_or_defensive_ratio")
        )
        if (
            max_stale_or_defensive_ratio is not None
            and stale_or_defensive_samples >= 0
            and (stale_or_defensive_samples / samples_total)
            > max_stale_or_defensive_ratio
        ):
            reasons.append(
                "hmm_state_posterior_stale_or_defensive_ratio_exceeds_threshold"
            )
            details.append(
                {
                    "reason": "hmm_state_posterior_stale_or_defensive_ratio_exceeds_threshold",
                    "artifact_ref": str(artifact_path),
                    "samples_total": samples_total,
                    "stale_or_defensive_samples": stale_or_defensive_samples,
                    "actual_ratio": stale_or_defensive_samples / samples_total,
                    "maximum_ratio": max_stale_or_defensive_ratio,
                }
            )

    source_lineage = _as_dict(payload.get("source_lineage"))
    walkforward_ref = str(
        source_lineage.get("walkforward_results_artifact_ref") or ""
    ).strip()
    gate_policy_ref = str(source_lineage.get("gate_policy_artifact_ref") or "").strip()
    if not walkforward_ref or not gate_policy_ref:
        reasons.append("hmm_state_posterior_source_lineage_incomplete")
        details.append(
            {
                "reason": "hmm_state_posterior_source_lineage_incomplete",
                "artifact_ref": str(artifact_path),
                "walkforward_results_artifact_ref": walkforward_ref,
                "gate_policy_artifact_ref": gate_policy_ref,
            }
        )

    posterior_mass = _as_dict(payload.get("posterior_mass_by_regime"))
    if not posterior_mass:
        reasons.append("hmm_state_posterior_distribution_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_distribution_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    artifact_hash = str(payload.get("artifact_hash", "")).strip()
    if not artifact_hash:
        reasons.append("hmm_state_posterior_artifact_hash_missing")
        details.append(
            {
                "reason": "hmm_state_posterior_artifact_hash_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        expected_hash = _sha256_json(
            {key: value for key, value in payload.items() if key != "artifact_hash"}
        )
        if artifact_hash != expected_hash:
            reasons.append("hmm_state_posterior_artifact_hash_mismatch")
            details.append(
                {
                    "reason": "hmm_state_posterior_artifact_hash_mismatch",
                    "artifact_ref": str(artifact_path),
                    "artifact_hash": artifact_hash,
                    "expected_artifact_hash": expected_hash,
                }
            )

    return reasons, details, refs


def _evaluate_expert_router_registry_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_expert_router_registry(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    expert_router = _as_dict(evidence.get("expert_router_registry"))
    evidence_ref = str(expert_router.get("artifact_ref") or "").strip()
    if not evidence_ref:
        reasons.append("expert_router_registry_artifact_ref_missing")
        details.append({"reason": "expert_router_registry_artifact_ref_missing"})

    required_artifacts = _expert_router_required_artifact_refs(policy_payload)
    artifact_ref = (evidence_ref or required_artifacts[0]).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append("expert_router_registry_artifact_ref_invalid")
        details.append(
            {
                "reason": "expert_router_registry_artifact_ref_invalid",
                "artifact_ref": artifact_ref,
            }
        )
        return reasons, details, refs

    refs.append(evidence_ref or str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append("expert_router_registry_artifact_invalid_json")
        details.append(
            {
                "reason": "expert_router_registry_artifact_invalid_json",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != "expert-router-registry-v1":
        reasons.append("expert_router_registry_schema_version_invalid")
        details.append(
            {
                "reason": "expert_router_registry_schema_version_invalid",
                "artifact_ref": str(artifact_path),
                "schema_version": schema_version,
                "expected_schema_version": "expert-router-registry-v1",
            }
        )

    if not str(payload.get("run_id", "")).strip():
        reasons.append("expert_router_registry_run_id_missing")
        details.append(
            {
                "reason": "expert_router_registry_run_id_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    if not str(payload.get("candidate_id", "")).strip():
        reasons.append("expert_router_registry_candidate_id_missing")
        details.append(
            {
                "reason": "expert_router_registry_candidate_id_missing",
                "artifact_ref": str(artifact_path),
            }
        )

    route_count = _int_or_default(payload.get("route_count"), -1)
    min_route_count = max(
        1, _int_or_default(policy_payload.get("promotion_expert_router_min_route_count"), 1)
    )
    if route_count < min_route_count:
        reasons.append("expert_router_registry_route_count_below_minimum")
        details.append(
            {
                "reason": "expert_router_registry_route_count_below_minimum",
                "artifact_ref": str(artifact_path),
                "actual_route_count": route_count,
                "minimum_route_count": min_route_count,
            }
        )

    fallback_rate = _float_or_none(payload.get("fallback_rate"))
    max_fallback_rate = _float_or_none(
        policy_payload.get("promotion_expert_router_max_fallback_rate")
    )
    if max_fallback_rate is None:
        max_fallback_rate = 0.05
    if fallback_rate is None:
        reasons.append("expert_router_registry_fallback_rate_missing")
        details.append(
            {
                "reason": "expert_router_registry_fallback_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif fallback_rate > max_fallback_rate:
        reasons.append("expert_router_registry_fallback_rate_exceeds_threshold")
        details.append(
            {
                "reason": "expert_router_registry_fallback_rate_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_fallback_rate": fallback_rate,
                "maximum_fallback_rate": max_fallback_rate,
            }
        )

    max_expert_weight = _float_or_none(payload.get("max_expert_weight"))
    max_concentration = _float_or_none(
        policy_payload.get("promotion_expert_router_max_expert_concentration")
    )
    if max_concentration is None:
        max_concentration = 0.85
    if max_expert_weight is None:
        reasons.append("expert_router_registry_max_expert_weight_missing")
        details.append(
            {
                "reason": "expert_router_registry_max_expert_weight_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif max_expert_weight > max_concentration:
        reasons.append("expert_router_registry_expert_concentration_exceeds_threshold")
        details.append(
            {
                "reason": "expert_router_registry_expert_concentration_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_max_expert_weight": max_expert_weight,
                "maximum_expert_weight": max_concentration,
            }
        )

    slo_feedback = _as_dict(payload.get("slo_feedback"))
    overall_status = str(slo_feedback.get("overall_status") or "").strip()
    if overall_status != "pass":
        reasons.append("expert_router_registry_slo_feedback_not_pass")
        details.append(
            {
                "reason": "expert_router_registry_slo_feedback_not_pass",
                "artifact_ref": str(artifact_path),
                "overall_status": overall_status,
                "slo_reasons": _list_of_strings(slo_feedback.get("reasons")),
            }
        )

    source_lineage = _as_dict(payload.get("source_lineage"))
    walkforward_ref = str(
        source_lineage.get("walkforward_results_artifact_ref") or ""
    ).strip()
    hmm_ref = str(source_lineage.get("hmm_state_posterior_artifact_ref") or "").strip()
    gate_policy_ref = str(source_lineage.get("gate_policy_artifact_ref") or "").strip()
    if not walkforward_ref or not hmm_ref or not gate_policy_ref:
        reasons.append("expert_router_registry_source_lineage_incomplete")
        details.append(
            {
                "reason": "expert_router_registry_source_lineage_incomplete",
                "artifact_ref": str(artifact_path),
                "walkforward_results_artifact_ref": walkforward_ref,
                "hmm_state_posterior_artifact_ref": hmm_ref,
                "gate_policy_artifact_ref": gate_policy_ref,
            }
        )

    artifact_hash = str(payload.get("artifact_hash", "")).strip()
    if not artifact_hash:
        reasons.append("expert_router_registry_artifact_hash_missing")
        details.append(
            {
                "reason": "expert_router_registry_artifact_hash_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        expected_hash = _sha256_json(
            {key: value for key, value in payload.items() if key != "artifact_hash"}
        )
        if artifact_hash != expected_hash:
            reasons.append("expert_router_registry_artifact_hash_mismatch")
            details.append(
                {
                    "reason": "expert_router_registry_artifact_hash_mismatch",
                    "artifact_ref": str(artifact_path),
                    "artifact_hash": artifact_hash,
                    "expected_artifact_hash": expected_hash,
                }
            )

    return reasons, details, refs


def _evaluate_fold_metrics_evidence(
    *,
    policy_payload: dict[str, Any],
    evidence: dict[str, Any],
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    fold_raw = evidence.get("fold_metrics")
    fold_metrics = cast(dict[str, Any], fold_raw) if isinstance(fold_raw, dict) else {}
    fold_ref = str(fold_metrics.get("artifact_ref") or "").strip()
    fold_count = _int_or_default(fold_metrics.get("count"), 0)
    min_fold_count = max(
        1,
        _int_or_default(policy_payload.get("promotion_min_fold_metrics_count"), 1),
    )
    if fold_count < min_fold_count:
        reasons.append("fold_metrics_evidence_insufficient")
        details.append(
            {
                "reason": "fold_metrics_evidence_insufficient",
                "actual_fold_count": fold_count,
                "minimum_fold_count": min_fold_count,
            }
        )
    if fold_ref:
        refs.append(fold_ref)
    return reasons, details, refs


def _evaluate_stress_metrics_evidence(
    *,
    policy_payload: dict[str, Any],
    evidence: dict[str, Any],
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    now = now or datetime.now(timezone.utc)
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    stress_raw = evidence.get("stress_metrics")
    stress_metrics = (
        cast(dict[str, Any], stress_raw) if isinstance(stress_raw, dict) else {}
    )
    stress_ref = str(stress_metrics.get("artifact_ref") or "").strip()
    _append_evidence_artifact_reasons(
        reasons=reasons,
        reason_details=details,
        evidence_name="stress_metrics",
        artifact_root=artifact_root,
        raw_ref=stress_ref,
        policy_payload=policy_payload,
        now=now,
    )
    stress_count = _int_or_default(stress_metrics.get("count"), 0)
    min_stress_count = max(
        1,
        _int_or_default(policy_payload.get("promotion_min_stress_case_count"), 4),
    )
    stress_ref = str(stress_metrics.get("artifact_ref") or "").strip()
    artifact_ref_path = None
    if stress_ref:
        artifact_ref_path = _normalize_artifact_path(stress_ref, artifact_root=artifact_root)
    if artifact_ref_path is None and stress_ref:
        reasons.append("stress_metrics_evidence_ref_not_trusted")
        details.append(
            {
                "reason": "stress_metrics_evidence_ref_not_trusted",
                "artifact_ref": stress_ref,
            }
        )
    if not stress_ref:
        reasons.append("stress_metrics_evidence_artifact_ref_missing")
        details.append({"reason": "stress_metrics_evidence_artifact_ref_missing"})
        stress_payload = None
    elif artifact_ref_path is None:
        stress_payload = None
    elif not artifact_ref_path.exists():
        reasons.append("stress_metrics_evidence_artifact_missing")
        details.append(
            {
                "reason": "stress_metrics_evidence_artifact_missing",
                "artifact_ref": stress_ref,
            }
        )
        stress_payload = None
    else:
        stress_payload = _load_json_if_exists(artifact_ref_path)
        if stress_payload is None:
            reasons.append("stress_metrics_evidence_artifact_invalid")
            details.append(
                {
                    "reason": "stress_metrics_evidence_artifact_invalid",
                    "artifact_ref": stress_ref,
                }
            )

    if stress_payload is not None:
        schema_version = str(stress_payload.get("schema_version") or "").strip()
        if schema_version and schema_version != "stress-metrics-v1":
            reasons.append("stress_metrics_evidence_schema_invalid")
            details.append(
                {
                    "reason": "stress_metrics_evidence_schema_invalid",
                    "artifact_ref": stress_ref,
                    "actual_schema_version": schema_version,
                    "expected_schema_version": "stress-metrics-v1",
                }
            )
        items = _list_from_any(stress_payload.get("items"))
        payload_count = _int_or_default(stress_payload.get("count"), len(items))
        if payload_count < min_stress_count:
            reasons.append("stress_metrics_evidence_insufficient")
            details.append(
                {
                    "reason": "stress_metrics_evidence_insufficient",
                    "actual_stress_case_count": payload_count,
                    "minimum_stress_case_count": min_stress_count,
                }
            )
        max_age_hours = max(
            1, _int_or_default(policy_payload.get("promotion_stress_max_age_hours"), 24)
        )
        generated_at = _parse_datetime(
            str(stress_payload.get("generated_at") or "").strip()
        )
        if generated_at is None:
            reasons.append("stress_metrics_evidence_generated_at_missing")
            details.append(
                {
                    "reason": "stress_metrics_evidence_generated_at_missing",
                    "artifact_ref": stress_ref,
                }
            )
        elif (now - generated_at).total_seconds() > max_age_hours * 3600:
            reasons.append("stress_metrics_evidence_stale")
            details.append(
                {
                    "reason": "stress_metrics_evidence_stale",
                    "artifact_ref": stress_ref,
                    "generated_at": str(stress_payload.get("generated_at") or ""),
                    "max_age_hours": max_age_hours,
                }
            )

    if stress_count < min_stress_count:
        reasons.append("stress_metrics_evidence_insufficient")
        details.append(
            {
                "reason": "stress_metrics_evidence_insufficient",
                "actual_stress_case_count": stress_count,
                "minimum_stress_case_count": min_stress_count,
            }
        )
    if stress_ref:
        refs.append(stress_ref)
    return reasons, details, refs


def _append_evidence_artifact_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    evidence_name: str,
    artifact_root: Path,
    raw_ref: str,
    policy_payload: dict[str, Any],
    now: datetime | None = None,
) -> None:
    artifact_ref = str(raw_ref or "").strip()
    if not artifact_ref:
        reasons.append(f"{evidence_name}_artifact_ref_missing")
        reason_details.append(
            {
                "reason": f"{evidence_name}_artifact_ref_missing",
                "artifact_name": evidence_name,
            }
        )
        return

    if artifact_ref.startswith("db:") or (
        "://" in artifact_ref and not artifact_ref.startswith("file://")
    ):
        reasons.append(f"{evidence_name}_artifact_ref_untrusted")
        reason_details.append(
            {
                "reason": f"{evidence_name}_artifact_ref_untrusted",
                "artifact_name": evidence_name,
                "artifact_ref": artifact_ref,
            }
        )
        return

    artifact_ref_for_path = artifact_ref.removeprefix("file://")
    candidate_path = Path(artifact_ref_for_path)
    if not candidate_path.is_absolute():
        candidate_path = artifact_root / candidate_path
    try:
        artifact_path = candidate_path.resolve()
    except (OSError, ValueError):
        reasons.append(f"{evidence_name}_artifact_ref_invalid")
        reason_details.append(
            {
                "reason": f"{evidence_name}_artifact_ref_invalid",
                "artifact_name": evidence_name,
                "artifact_ref": artifact_ref,
            }
        )
        return

    try:
        artifact_root_path = artifact_root.resolve()
    except OSError:
        reasons.append(f"{evidence_name}_artifact_ref_invalid")
        reason_details.append(
            {
                "reason": f"{evidence_name}_artifact_ref_invalid",
                "artifact_name": evidence_name,
                "artifact_ref": artifact_ref,
            }
        )
        return

    if not artifact_path.is_relative_to(artifact_root_path):
        reasons.append(f"{evidence_name}_artifact_ref_outside_artifact_root")
        reason_details.append(
            {
                "reason": f"{evidence_name}_artifact_ref_outside_artifact_root",
                "artifact_name": evidence_name,
                "artifact_ref": artifact_ref,
            }
        )
        return

    if not artifact_path.is_file():
        reasons.append(f"{evidence_name}_artifact_missing")
        reason_details.append(
            {
                "reason": f"{evidence_name}_artifact_missing",
                "artifact_name": evidence_name,
                "artifact_ref": artifact_ref,
                "artifact_path": str(artifact_path),
            }
        )
        return

    if _load_json_if_exists(artifact_path) is None:
        reasons.append(f"{evidence_name}_artifact_payload_invalid")
        reason_details.append(
            {
                "reason": f"{evidence_name}_artifact_payload_invalid",
                "artifact_name": evidence_name,
                "artifact_path": str(artifact_path),
            }
        )
        return

    max_age_seconds = _int_or_default(
        policy_payload.get("promotion_evidence_max_age_seconds"), 0
    )
    if max_age_seconds > 0 and now is not None:
        try:
            artifact_mtime = datetime.fromtimestamp(
                os.path.getmtime(artifact_path),
                tz=timezone.utc,
            )
        except OSError:
            reasons.append(f"{evidence_name}_artifact_ref_invalid")
            reason_details.append(
                {
                    "reason": f"{evidence_name}_artifact_ref_invalid",
                    "artifact_name": evidence_name,
                    "artifact_ref": artifact_ref,
                }
            )
            return
        age_seconds = (now - artifact_mtime).total_seconds()
        if age_seconds > max_age_seconds:
            reasons.append(f"{evidence_name}_artifact_stale")
            reason_details.append(
                {
                    "reason": f"{evidence_name}_artifact_stale",
                    "artifact_name": evidence_name,
                    "artifact_path": str(artifact_path),
                    "artifact_mtime": artifact_mtime.isoformat(),
                    "max_age_seconds": max_age_seconds,
                }
            )


def _evaluate_rationale_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    evidence: dict[str, Any],
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    if not bool(policy_payload.get("promotion_require_rationale", True)):
        return reasons, details

    rationale_raw = evidence.get("promotion_rationale")
    rationale = cast(dict[str, Any], rationale_raw) if isinstance(rationale_raw, dict) else {}
    reason_codes = _list_of_strings(rationale.get("reason_codes"))
    if not reason_codes:
        reason_codes = _list_of_strings(rationale.get("gate_reasons"))
    rationale_text = str(rationale.get("rationale_text") or "").strip()
    if not rationale:
        reasons.append("promotion_rationale_missing")
        details.append({"reason": "promotion_rationale_missing"})

    requested_target = str(rationale.get("requested_target") or "").strip()
    if requested_target and requested_target != promotion_target:
        reasons.append("promotion_rationale_target_mismatch")
        details.append(
            {
                "reason": "promotion_rationale_target_mismatch",
                "requested_target": promotion_target,
                "rationale_target": requested_target,
            }
        )

    recommended_mode = str(rationale.get("recommended_mode") or "").strip()
    if not recommended_mode:
        recommended_mode = str(rationale.get("gate_recommended_mode") or "").strip()
    gate_recommended_mode = str(gate_report_payload.get("recommended_mode", "")).strip()
    if (
        recommended_mode
        and gate_recommended_mode
        and recommended_mode != gate_recommended_mode
    ):
        reasons.append("promotion_rationale_recommended_mode_mismatch")
        details.append(
            {
                "reason": "promotion_rationale_recommended_mode_mismatch",
                "rationale_recommended_mode": recommended_mode,
                "gate_recommended_mode": gate_recommended_mode,
            }
        )

    if not reason_codes and not rationale_text:
        reasons.append("promotion_rationale_missing")
        details.append({"reason": "promotion_rationale_missing"})
    return reasons, details


def _observed_throughput(
    *,
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
) -> dict[str, int | bool | str | None]:
    throughput_raw = gate_report_payload.get("throughput")
    throughput = (
        cast(dict[str, Any], throughput_raw) if isinstance(throughput_raw, dict) else {}
    )
    metrics_raw = gate_report_payload.get("metrics")
    metrics = cast(dict[str, Any], metrics_raw) if isinstance(metrics_raw, dict) else {}

    signal_count = _int_or_default(throughput.get("signal_count"), 0)
    decision_count = _int_or_default(
        throughput.get("decision_count", metrics.get("decision_count")), 0
    )
    trade_count = _int_or_default(
        throughput.get("trade_count", metrics.get("trade_count")), 0
    )

    no_signal_reason = str(
        candidate_state_payload.get("noSignalReason")
        or throughput.get("no_signal_reason")
        or ""
    ).strip()
    no_signal_from_snapshot = (
        str(candidate_state_payload.get("datasetSnapshotRef") or "").strip()
        == "no_signal_window"
    )
    no_signal_window = no_signal_from_snapshot or bool(
        throughput.get("no_signal_window", False)
    )
    if no_signal_reason:
        no_signal_window = True

    return {
        "has_explicit_throughput": bool(throughput),
        "signal_count": signal_count,
        "decision_count": decision_count,
        "trade_count": trade_count,
        "no_signal_window": no_signal_window,
        "no_signal_reason": no_signal_reason or None,
    }


def _gates(gate_report_payload: dict[str, Any]) -> list[dict[str, Any]]:
    gates_raw = gate_report_payload.get("gates")
    gates_list = _list_from_any(gates_raw)
    gates: list[dict[str, Any]] = []
    for item in gates_list:
        if isinstance(item, dict):
            gates.append(cast(dict[str, Any], item))
    return gates


def _list_from_any(value: Any) -> list[object]:
    if not isinstance(value, list):
        return []
    return cast(list[object], value)


def _as_list_of_dicts(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    values = cast(list[object], value)
    result: list[dict[str, Any]] = []
    for item in values:
        if isinstance(item, dict):
            result.append(cast(dict[str, Any], item))
    return result


def _list_count(value: Any) -> int:
    if not isinstance(value, list):
        return 0
    return len(cast(list[object], value))


def _as_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], value)


def _list_of_strings(value: Any) -> list[str]:
    raw = _list_from_any(value)
    return [str(item) for item in raw if isinstance(item, str)]


def _load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return cast(dict[str, Any], payload)


def _sha256_path(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def _sha256_json(payload: object) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()


def _int_or_default(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return int(stripped)
            except ValueError:
                return default
    return default


def _coerce_evidence_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        return value != 0
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return True
    if normalized in {"false", "0", "no", "off", ""}:
        return False
    return None


def _float_or_default(value: Any, default: float) -> float:
    parsed = _float_or_none(value)
    if parsed is None:
        return default
    return parsed


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        parsed = float(value)
        if math.isfinite(parsed):
            return parsed
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                parsed = float(stripped)
            except ValueError:
                return None
            if math.isfinite(parsed):
                return parsed
            return None
    return None


def _promotion_rank(target: str) -> int:
    ranking = {"shadow": 1, "paper": 2, "live": 3}
    return ranking.get(target, 0)


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


__all__ = [
    "PromotionPrerequisiteResult",
    "RollbackReadinessResult",
    "evaluate_promotion_prerequisites",
    "evaluate_rollback_readiness",
]
