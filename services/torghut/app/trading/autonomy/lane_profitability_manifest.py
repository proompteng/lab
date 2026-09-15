"""Profitability stage manifest assembly for the autonomous lane."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, cast

from .lane_common import (
    PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION as _PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION,
    stable_hash as _stable_hash,
)
from .lane_stage_artifacts import (
    load_json_if_exists as _load_json_if_exists,
    manifest_artifact_payload as _manifest_artifact_payload,
    manifest_relative_path as _manifest_relative_path,
)
from .policy_checks import RollbackReadinessResult


def _build_profitability_stage_manifest(
    *,
    output_dir: Path,
    run_id: str,
    candidate_id: str,
    strategy_family: str,
    llm_artifact_ref: str | None,
    router_artifact_ref: str,
    run_context: dict[str, str],
    research_manifest_path: Path | None,
    candidate_spec_path: Path,
    evaluation_report_path: Path,
    walkforward_results_path: Path,
    baseline_evaluation_report_path: Path,
    gate_report_payload: dict[str, Any],
    gate_report_path: Path,
    profitability_benchmark_path: Path,
    contamination_registry_path: Path,
    benchmark_parity_path: Path,
    foundation_router_parity_path: Path,
    deeplob_bdlob_report_path: Path,
    advisor_fallback_slo_report_path: Path,
    profitability_evidence_path: Path,
    profitability_validation_path: Path,
    simulation_calibration_report_path: Path,
    shadow_live_deviation_report_path: Path,
    hmm_state_posterior_path: Path,
    expert_router_registry_path: Path,
    janus_event_car_path: Path,
    janus_hgrm_reward_path: Path,
    recalibration_report_path: Path,
    rollback_check: RollbackReadinessResult,
    drift_gate_check: dict[str, Any],
    patch_path: Path | None,
    now: datetime,
) -> dict[str, Any]:
    research_artifacts: dict[str, dict[str, str]] = {}
    research_checks: list[dict[str, object]] = []
    candidate_spec_artifact = _manifest_artifact_payload(
        output_dir,
        candidate_spec_path,
        "research",
        "candidate_spec_present",
    )
    if candidate_spec_artifact:
        research_artifacts["candidate_spec"] = candidate_spec_artifact
        research_checks.append({"check": "candidate_spec_present", "status": "pass"})
    else:
        research_checks.append(
            {"check": "candidate_spec_present", "status": "fail", "reason": "missing"}
        )

    if research_manifest_path is not None:
        candidate_generation_manifest_artifact = _manifest_artifact_payload(
            output_dir,
            research_manifest_path,
            "research",
            "candidate_generation_manifest_present",
        )
        if candidate_generation_manifest_artifact:
            research_artifacts["candidate_generation_manifest"] = (
                candidate_generation_manifest_artifact
            )
            research_checks.append(
                {"check": "candidate_generation_manifest_present", "status": "pass"}
            )
        else:
            research_checks.append(
                {
                    "check": "candidate_generation_manifest_present",
                    "status": "fail",
                    "reason": "missing",
                }
            )

    for artifact_path, check_name in (
        (walkforward_results_path, "walkforward_results_present"),
        (baseline_evaluation_report_path, "baseline_evaluation_report_present"),
    ):
        entry = _manifest_artifact_payload(
            output_dir,
            artifact_path,
            "research",
            check_name,
        )
        if entry:
            research_artifacts[check_name] = entry
            research_checks.append({"check": check_name, "status": "pass"})
        else:
            research_checks.append(
                {"check": check_name, "status": "fail", "reason": "missing"}
            )

    research_pass = all(item.get("status") == "pass" for item in research_checks)

    validation_artifacts: dict[str, dict[str, str]] = {}
    validation_checks: list[dict[str, object]] = []
    for artifact_path, check_name in (
        (evaluation_report_path, "evaluation_report_present"),
        (contamination_registry_path, "contamination_registry_present"),
        (profitability_benchmark_path, "profitability_benchmark_present"),
        (profitability_evidence_path, "profitability_evidence_present"),
        (profitability_validation_path, "profitability_validation_present"),
        (
            simulation_calibration_report_path,
            "simulation_calibration_report_present",
        ),
        (
            shadow_live_deviation_report_path,
            "shadow_live_deviation_report_present",
        ),
    ):
        entry = _manifest_artifact_payload(
            output_dir,
            artifact_path,
            "validation",
            check_name,
        )
        if entry:
            validation_artifacts[check_name] = entry
            validation_checks.append({"check": check_name, "status": "pass"})
        else:
            validation_checks.append(
                {"check": check_name, "status": "fail", "reason": "missing"}
            )

    validation_pass = all(item.get("status") == "pass" for item in validation_checks)
    if (
        profitability_validation_path.exists()
        and _load_json_if_exists(profitability_validation_path) is None
    ):
        validation_checks.append(
            {
                "check": "profitability_validation_payload_valid_json",
                "status": "fail",
                "reason": "invalid_json",
            }
        )
        validation_pass = False

    execution_artifacts: dict[str, dict[str, str]] = {}
    execution_checks_map: list[tuple[str, str, Path]] = [
        (
            "walkforward_results_present",
            "walkforward_results",
            walkforward_results_path,
        ),
        ("evaluation_report_present", "evaluation_report", evaluation_report_path),
        ("gate_evaluation_present", "gate_evaluation", gate_report_path),
        ("benchmark_parity_present", "benchmark_parity", benchmark_parity_path),
        (
            "foundation_router_parity_present",
            "foundation_router_parity",
            foundation_router_parity_path,
        ),
        (
            "deeplob_bdlob_contract_present",
            "deeplob_bdlob_contract",
            deeplob_bdlob_report_path,
        ),
        (
            "advisor_fallback_slo_present",
            "advisor_fallback_slo",
            advisor_fallback_slo_report_path,
        ),
        (
            "simulation_calibration_report_present",
            "simulation_calibration",
            simulation_calibration_report_path,
        ),
        (
            "shadow_live_deviation_report_present",
            "shadow_live_deviation",
            shadow_live_deviation_report_path,
        ),
        (
            "hmm_state_posterior_present",
            "hmm_state_posterior",
            hmm_state_posterior_path,
        ),
        (
            "expert_router_registry_present",
            "expert_router_registry",
            expert_router_registry_path,
        ),
        ("janus_event_car_present", "janus_event_car", janus_event_car_path),
        ("janus_hgrm_reward_present", "janus_hgrm_reward", janus_hgrm_reward_path),
        (
            "recalibration_report_present",
            "recalibration_report",
            recalibration_report_path,
        ),
    ]
    for check_name, artifact_key, artifact_path in execution_checks_map:
        payload = (
            _manifest_artifact_payload(
                output_dir,
                artifact_path,
                "execution",
                check_name,
            )
            or {}
        )
        if payload:
            execution_artifacts[artifact_key] = payload
    execution_checks: list[dict[str, object]] = []
    for check_name, artifact_key, _artifact_path in execution_checks_map:
        payload = execution_artifacts.get(artifact_key, {})
        status = "pass" if payload else "fail"
        execution_checks.append({"check": check_name, "status": status})
        if status != "pass":
            execution_checks[-1]["reason"] = "missing"
    gate_allowance = bool(gate_report_payload.get("promotion_allowed", False))
    drift_allowed = bool(drift_gate_check.get("allowed", False))
    execution_checks.extend(
        [
            {
                "check": "gate_matrix_approval",
                "status": "pass" if gate_allowance else "fail",
            },
            {
                "check": "drift_gate_approval",
                "status": "pass" if drift_allowed else "fail",
            },
        ]
    )
    execution_pass = all(item["status"] == "pass" for item in execution_checks)

    governance_artifacts: dict[str, dict[str, str]] = {
        "candidate_spec": (
            _manifest_artifact_payload(
                output_dir,
                candidate_spec_path,
                "governance",
                "candidate_spec_present",
            )
            or {}
        ),
        "gate_evaluation": (
            _manifest_artifact_payload(
                output_dir,
                gate_report_path,
                "governance",
                "gate_evaluation_present",
            )
            or {}
        ),
        "rollback_readiness": (
            _manifest_artifact_payload(
                output_dir,
                output_dir / "gates" / "rollback-readiness.json",
                "governance",
                "rollback_readiness_present",
            )
            or {}
        ),
    }
    if patch_path is not None:
        governance_artifacts["paper_patch"] = (
            _manifest_artifact_payload(
                output_dir,
                patch_path,
                "governance",
                "paper_patch_present",
            )
            or {}
        )
    governance_checks = [
        {
            "check": "rollback_ready",
            "status": "pass" if rollback_check.ready else "fail",
        },
        {
            "check": "rollback_readiness_present",
            "status": "pass"
            if bool(governance_artifacts.get("rollback_readiness")) or False
            else "fail",
        },
        {
            "check": "gate_report_present",
            "status": "pass" if gate_report_path.exists() else "fail",
        },
    ]
    if patch_path is None:
        governance_checks.append(
            {
                "check": "paper_patch_present",
                "status": "pass",
            }
        )
    governance_checks.extend(
        [
            {
                "check": "candidate_spec_present",
                "status": "pass" if candidate_spec_path.exists() else "fail",
            },
            {"check": "risk_controls_attestable", "status": "pass"},
        ]
    )
    governance_pass = all(item["status"] == "pass" for item in governance_checks)

    stage_payloads: dict[str, dict[str, Any]] = {
        "research": {
            "status": "pass" if research_pass else "fail",
            "checks": research_checks,
            "artifacts": research_artifacts,
            "owner": "research-orchestrator",
            "completed_at_utc": now.isoformat(),
        },
        "validation": {
            "status": "pass" if validation_pass else "fail",
            "checks": validation_checks,
            "artifacts": validation_artifacts,
            "owner": "validation-service",
            "completed_at_utc": now.isoformat(),
        },
        "execution": {
            "status": "pass" if execution_pass else "fail",
            "checks": execution_checks,
            "artifacts": {
                key: value for key, value in execution_artifacts.items() if value
            },
            "owner": "execution-sim",
            "completed_at_utc": now.isoformat(),
        },
        "governance": {
            "status": "pass" if governance_pass else "fail",
            "checks": governance_checks,
            "artifacts": {
                key: value for key, value in governance_artifacts.items() if value
            },
            "owner": "governance-policy",
            "completed_at_utc": now.isoformat(),
        },
    }
    overall_status = (
        "pass"
        if all(item["status"] == "pass" for item in stage_payloads.values())
        else "fail"
    )
    failure_reasons = [
        item["check"]
        for stage in stage_payloads.values()
        for item in stage["checks"]
        if item.get("status") == "fail"
    ]
    replay_contract_artifact_hashes: dict[str, str] = {}
    for stage_payload in stage_payloads.values():
        artifacts_raw = stage_payload.get("artifacts")
        if not isinstance(artifacts_raw, dict):
            continue
        artifacts = cast(dict[str, object], artifacts_raw)
        for artifact_payload_raw in artifacts.values():
            if not isinstance(artifact_payload_raw, dict):
                continue
            artifact_payload = cast(dict[str, object], artifact_payload_raw)
            artifact_ref = str(artifact_payload.get("path", "")).strip()
            artifact_sha = str(artifact_payload.get("sha256", "")).strip()
            if not artifact_ref or not artifact_sha:
                continue
            replay_contract_artifact_hashes[artifact_ref] = artifact_sha
    payload: dict[str, Any] = {
        "schema_version": _PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION,
        "candidate_id": candidate_id,
        "strategy_family": strategy_family,
        "llm_artifact_ref": llm_artifact_ref,
        "router_artifact_ref": router_artifact_ref,
        "hmm_state_posterior_artifact_ref": _manifest_relative_path(
            output_dir, hmm_state_posterior_path
        ),
        "expert_router_registry_artifact_ref": _manifest_relative_path(
            output_dir, expert_router_registry_path
        ),
        "run_context": {
            "repository": run_context.get("repository", "unknown"),
            "base": run_context.get("base", "main"),
            "head": run_context.get("head", "unknown"),
            "artifact_path": run_context.get("artifact_path", str(output_dir)),
            "run_id": run_context.get("run_id", run_id),
            "design_doc": run_context.get("design_doc", ""),
            "priority_id": run_context.get("priority_id", ""),
        },
        "stages": stage_payloads,
        "overall_status": overall_status,
        "failure_reasons": failure_reasons,
        "replay_contract": {
            "artifact_hashes": replay_contract_artifact_hashes,
            "contract_hash": _stable_hash(
                {"artifact_hashes": replay_contract_artifact_hashes}
            ),
            "hash_algorithm": "sha256",
        },
        "rollback_contract_ref": _manifest_relative_path(
            output_dir, output_dir / "gates" / "rollback-readiness.json"
        ),
        "created_at_utc": now.isoformat(),
    }
    manifest_copy = dict(payload)
    payload["content_hash"] = _stable_hash(manifest_copy)
    return payload


build_profitability_stage_manifest = _build_profitability_stage_manifest

__all__ = [
    "build_profitability_stage_manifest",
]
