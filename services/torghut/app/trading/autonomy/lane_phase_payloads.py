"""Phase-manifest and actuation payload helpers for the autonomous lane."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, cast

from ..models import SignalEnvelope
from ..reporting import PromotionRecommendation
from .gates import GateEvaluationReport, PromotionTarget
from .lane_common import (
    ACTUATION_CONFIRMATION_PHRASE as _ACTUATION_CONFIRMATION_PHRASE,
    ACTUATION_INTENT_SCHEMA_VERSION as _ACTUATION_INTENT_SCHEMA_VERSION,
    LANE_AUTONOMY_PHASE_ORDER as _AUTONOMY_PHASE_ORDER,
    V6_08_GOVERNING_DESIGN_DOC as _V6_08_GOVERNING_DESIGN_DOC,
)
from .phase_manifest_contract import coerce_phase_status, normalize_phase_transitions


def _prepare_lane_output_dirs(output_dir: Path) -> tuple[Path, Path, Path, Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    research_dir = output_dir / "research"
    backtest_dir = output_dir / "backtest"
    gates_dir = output_dir / "gates"
    paper_dir = output_dir / "paper-candidate"
    rollout_dir = output_dir / "rollout"
    for path in (research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir):
        path.mkdir(parents=True, exist_ok=True)
    return research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir


def _normalize_governance_inputs(
    governance_inputs: Mapping[str, Any] | None,
) -> dict[str, Any]:
    raw: Mapping[str, Any] = (
        governance_inputs if isinstance(governance_inputs, Mapping) else {}
    )
    execution_context_raw = raw.get("execution_context", {})
    execution_context: Mapping[str, Any] = (
        cast(Mapping[str, Any], execution_context_raw)
        if isinstance(execution_context_raw, Mapping)
        else {}
    )
    runtime_raw = raw.get("runtime_governance", {})
    runtime: Mapping[str, Any] = (
        cast(Mapping[str, Any], runtime_raw) if isinstance(runtime_raw, Mapping) else {}
    )
    rollback_raw = raw.get("rollback_proof", {})
    rollback: Mapping[str, Any] = (
        cast(Mapping[str, Any], rollback_raw)
        if isinstance(rollback_raw, Mapping)
        else {}
    )
    return {
        "execution_context": {
            "repository": _coerce_str(
                execution_context.get("repository"), default="unknown"
            ),
            "base": _coerce_str(execution_context.get("base"), default="unknown"),
            "head": _coerce_str(execution_context.get("head"), default="unknown"),
            "artifactPath": _coerce_str(
                execution_context.get("artifactPath"),
                default="",
            ),
            "priorityId": _coerce_str(
                execution_context.get("priorityId"),
                default="",
            ),
            "designDoc": _coerce_str(
                execution_context.get("designDoc"),
                default="",
            ),
        },
        "runtime_governance": cast(Mapping[str, Any], runtime),
        "rollback_proof": cast(Mapping[str, Any], rollback),
    }


def _coalesce_governance_context(
    *,
    governance_inputs: Mapping[str, Any] | None,
    governance_repository: str | None,
    governance_base: str | None,
    governance_head: str | None,
    governance_artifact_path: str | None,
    design_doc: str | None,
    priority_id: str | None,
    now: datetime,
) -> dict[str, Any]:
    raw: Mapping[str, Any] = (
        governance_inputs if isinstance(governance_inputs, Mapping) else {}
    )
    execution_context_raw = raw.get("execution_context", {})
    execution_context: Mapping[str, Any] = (
        cast(Mapping[str, Any], execution_context_raw)
        if isinstance(execution_context_raw, Mapping)
        else {}
    )
    runtime_raw = raw.get("runtime_governance", {})
    runtime: Mapping[str, Any] = (
        cast(Mapping[str, Any], runtime_raw) if isinstance(runtime_raw, Mapping) else {}
    )
    rollback_raw = raw.get("rollback_proof", {})
    rollback: Mapping[str, Any] = (
        cast(Mapping[str, Any], rollback_raw)
        if isinstance(rollback_raw, Mapping)
        else {}
    )

    fallback_head = _coerce_str(execution_context.get("head")) or (
        f"agentruns/torghut-autonomy-{now.strftime('%Y%m%dT%H%M%S')}"
    )
    resolved_repository = _coerce_str(governance_repository)
    if not resolved_repository:
        resolved_repository = _coerce_str(execution_context.get("repository"))
    if not resolved_repository:
        resolved_repository = "proompteng/lab"
    resolved_base = _coerce_str(governance_base)
    if not resolved_base:
        resolved_base = _coerce_str(execution_context.get("base"))
    if not resolved_base:
        resolved_base = "main"

    return {
        "execution_context": {
            "repository": resolved_repository,
            "base": resolved_base,
            "head": _coerce_str(
                governance_head or _coerce_str(fallback_head),
                default="unknown",
            ),
            "artifactPath": (
                _coerce_str(governance_artifact_path)
                or _coerce_str(execution_context.get("artifactPath"))
            ),
            "priorityId": (
                priority_id
                if priority_id
                else _coerce_str(execution_context.get("priorityId"))
            ),
            "designDoc": (
                (
                    design_doc
                    if design_doc is not None
                    else _coerce_str(execution_context.get("designDoc"))
                )
                or _V6_08_GOVERNING_DESIGN_DOC
            ),
        },
        "runtime_governance": cast(Mapping[str, Any], runtime),
        "rollback_proof": cast(Mapping[str, Any], rollback),
    }


def _build_phase_manifest(
    *,
    run_id: str,
    candidate_id: str,
    evaluated_at: datetime,
    output_dir: Path,
    signals: list[SignalEnvelope],
    requested_promotion_target: PromotionTarget,
    gate_report: GateEvaluationReport,
    gate_report_payload: dict[str, Any],
    gate_report_path: Path,
    promotion_check: Any,
    rollback_check: Any,
    drift_gate_check: dict[str, Any],
    patch_path: Path | None,
    recommended_mode: str,
    promotion_reasons: list[str],
    governance_inputs: Mapping[str, Any] | None,
    drift_promotion_evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    phase_timestamp = evaluated_at.isoformat()
    governance = _normalize_governance_inputs(governance_inputs)
    execution_context = cast(Mapping[str, Any], governance["execution_context"])
    artifact_path = _coerce_str(
        execution_context.get("artifactPath"),
        default=str(output_dir),
    )
    runtime_governance = cast(Mapping[str, Any], governance["runtime_governance"])
    rollback_proof = cast(Mapping[str, Any], governance["rollback_proof"])
    gate_status = "pass" if gate_report.promotion_allowed else "fail"
    prerequisite_status = "pass" if promotion_check.allowed else "fail"
    rollback_ready_status = "pass" if rollback_check.ready else "fail"
    drift_gate_status = (
        "pass" if bool(drift_gate_check.get("allowed", False)) else "fail"
    )
    canary_status = (
        "pass"
        if patch_path is not None
        else ("fail" if requested_promotion_target == "paper" else "skipped")
    )
    canary_slo_status = (
        "pass"
        if patch_path is not None
        else ("fail" if requested_promotion_target == "paper" else "skipped")
    )
    gate_payload_gates = gate_report_payload.get("gates")
    gate_entries = (
        cast(list[object], gate_payload_gates)
        if isinstance(gate_payload_gates, list)
        else []
    )
    slo_gates = _coerce_gate_phase_gates(gate_entries)
    throughput_payload = cast(
        Mapping[str, Any], gate_report_payload.get("throughput", {})
    )
    signal_count = _coerce_int(throughput_payload.get("signal_count"), default=0)
    decision_count = _coerce_int(throughput_payload.get("decision_count"), default=0)
    drift_refs_raw = drift_gate_check.get("artifact_refs")
    drift_artifacts = _coerce_path_strings(
        drift_refs_raw if isinstance(drift_refs_raw, list) else []
    )
    runtime_gate_status = coerce_phase_status(
        runtime_governance.get("governance_status", "skipped")
    )
    runtime_refs_raw = runtime_governance.get("artifact_refs")
    runtime_artifact_refs = _coerce_path_strings(
        runtime_refs_raw if isinstance(runtime_refs_raw, list) else []
    )
    rollback_triggered = bool(
        runtime_governance.get("rollback_triggered", False)
        or rollback_proof.get("rollback_triggered", False)
    )
    rollback_proof_path = _coerce_str(
        rollback_proof.get("rollback_incident_evidence_path"), default=""
    )
    if not rollback_proof_path:
        rollback_proof_path = _coerce_str(
            rollback_proof.get("rollback_incident_evidence"), default=""
        )
    rollback_proof_status = (
        "pass"
        if (not rollback_triggered)
        else ("pass" if rollback_proof_path else "fail")
    )
    drift_evidence: Mapping[str, Any] = drift_promotion_evidence or {}
    drift_evidence_refs_raw = drift_evidence.get("evidence_artifact_refs")
    drift_evidence_refs = (
        cast(list[object], drift_evidence_refs_raw)
        if isinstance(drift_evidence_refs_raw, list)
        else []
    )
    drift_gate_artifacts = sorted(
        {str(item) for item in drift_evidence_refs if str(item).strip()}
    )

    phase_summaries: list[dict[str, Any]] = [
        {
            "name": "gate-evaluation",
            "status": gate_status,
            "timestamp": phase_timestamp,
            "slo_gates": slo_gates
            + [
                {
                    "id": "slo_signal_count_minimum",
                    "status": "pass" if signal_count >= 1 else "fail",
                    "threshold": 1,
                    "value": signal_count,
                },
                {
                    "id": "slo_decision_count_minimum",
                    "status": "pass" if decision_count >= 1 else "fail",
                    "threshold": 1,
                    "value": decision_count,
                },
            ],
            "observations": {
                "recommended_mode": recommended_mode,
                "promotion_reasons": promotion_reasons,
                "throughput": throughput_payload,
            },
            "required": {
                "signal_count": 1,
                "decision_count": 1,
                "trade_count": 0,
            },
            "artifact_refs": [
                str(gate_report_path),
                str(output_dir / "gates" / "promotion-evidence-gate.json"),
            ],
        },
        {
            "name": "promotion-prerequisites",
            "status": prerequisite_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_required_artifacts_present",
                    "status": "pass"
                    if not promotion_check.missing_artifacts
                    else "fail",
                    "threshold": len(promotion_check.required_artifacts),
                    "value": len(promotion_check.artifact_refs),
                }
            ],
            "observations": {
                "artifact_requirements": list(promotion_check.required_artifacts),
                "missing_artifacts": list(promotion_check.missing_artifacts),
                "throughput_required": dict(promotion_check.required_throughput),
                "throughput_observed": dict(promotion_check.observed_throughput),
            },
            "reasons": list(promotion_check.reasons),
            "artifact_refs": [str(path) for path in promotion_check.artifact_refs],
            "artifact_paths": {
                "promotion_check": str(
                    output_dir / "gates" / "promotion-prerequisites.json"
                ),
                "promotion_gate": str(
                    output_dir / "gates" / "promotion-evidence-gate.json"
                ),
            },
        },
        {
            "name": "rollback-readiness",
            "status": rollback_ready_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_required_rollback_checks_present",
                    "status": "pass" if not rollback_check.missing_checks else "fail",
                    "threshold": len(rollback_check.required_checks),
                    "value": len(rollback_check.missing_checks),
                }
            ],
            "observations": {
                "required_checks": list(rollback_check.required_checks),
                "missing_checks": list(rollback_check.missing_checks),
            },
            "reasons": list(rollback_check.reasons),
            "artifact_refs": [str(output_dir / "gates" / "rollback-readiness.json")],
        },
        {
            "name": "drift-gate",
            "status": drift_gate_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_drift_gate_allowed",
                    "status": "pass" if drift_gate_check.get("allowed") else "fail",
                    "threshold": True,
                    "value": bool(drift_gate_check.get("allowed", False)),
                }
            ],
            "observations": {
                "eligible_for_live_promotion": bool(
                    drift_gate_check.get("eligible_for_live_promotion", False)
                ),
                "drift_artifacts": drift_gate_artifacts,
            },
            "artifact_refs": drift_artifacts,
            "reasons": list(drift_gate_check.get("reasons", [])),
        },
        {
            "name": "paper-canary",
            "status": canary_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_paper_canary_patch_present",
                    "status": canary_slo_status,
                    "threshold": "patch exists for paper target",
                    "value": str(patch_path) if patch_path else None,
                }
            ],
            "observations": {
                "target": requested_promotion_target,
                "patch_path": str(patch_path) if patch_path else None,
            },
            "artifact_refs": ([str(patch_path)] if patch_path else []),
        },
        {
            "name": "runtime-governance",
            "status": runtime_gate_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_runtime_rollback_not_triggered",
                    "status": "pass" if not rollback_triggered else "fail",
                    "threshold": False,
                    "value": rollback_triggered,
                }
            ],
            "observations": {
                "requested_promotion_target": requested_promotion_target,
                "drift_status": str(runtime_governance.get("drift_status", "unknown")),
                "action_type": str(runtime_governance.get("action_type", "")) or None,
                "action_triggered": bool(
                    runtime_governance.get("action_triggered", False)
                ),
                "rollback_triggered": rollback_triggered,
            },
            "required": {"required_items": ["drift_status", "rollback_triggered"]},
            "artifact_refs": runtime_artifact_refs,
            "reasons": list(runtime_governance.get("reasons", [])),
        },
        {
            "name": "rollback-proof",
            "status": rollback_proof_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_rollback_evidence_required_when_triggered",
                    "status": (
                        "pass"
                        if rollback_proof_path and rollback_triggered
                        else "pass"
                        if not rollback_triggered
                        else "fail"
                    ),
                    "threshold": True,
                    "value": bool(rollback_proof_path),
                }
            ],
            "observations": {
                "rollback_triggered": rollback_triggered,
                "rollback_incident_evidence_path": rollback_proof_path or "",
                "rollback_incident_evidence": rollback_proof_path or "",
            },
            "artifact_refs": [rollback_proof_path] if rollback_proof_path else [],
            "reasons": list(rollback_proof.get("reasons", [])),
        },
    ]

    overall_pass = all(
        coerce_phase_status(phase.get("status"), default="fail")
        in {"pass", "skipped", "skip"}
        for phase in phase_summaries
    )

    phase_artifact_refs = sorted(
        {
            str(item)
            for phase in phase_summaries
            for item in cast(list[Any], phase.get("artifact_refs", []))
            if str(item).strip()
        }
    )
    evidence_paths = sorted(
        {
            str(output_dir / "gates" / "profitability-benchmark-v4.json"),
            str(output_dir / "gates" / "profitability-evidence-v4.json"),
            str(output_dir / "gates" / "profitability-evidence-validation.json"),
            str(output_dir / "gates" / "benchmark-parity-report-v1.json"),
            str(output_dir / "gates" / "janus-event-car-v1.json"),
            str(output_dir / "gates" / "janus-hgrm-reward-v1.json"),
            str(output_dir / "gates" / "promotion-evidence-gate.json"),
            str(output_dir / "gates" / "promotion-prerequisites.json"),
            str(output_dir / "gates" / "rollback-readiness.json"),
            str(output_dir / "research" / "candidate-spec.json"),
            str(output_dir / "backtest" / "evaluation-report.json"),
            str(output_dir / "backtest" / "walkforward-results.json"),
            str(output_dir / "rollout" / "phase-manifest.json"),
        }
    )
    phase_transitions = normalize_phase_transitions(
        phase_summaries,
    )

    canonical_phase_payloads = {
        str(phase.get("name", "")).strip(): dict(phase)
        for phase in phase_summaries
        if str(phase.get("name", "")).strip() in _AUTONOMY_PHASE_ORDER
    }
    ordered_phase_summaries: list[dict[str, Any]] = []
    for expected_name in _AUTONOMY_PHASE_ORDER:
        phase_payload = canonical_phase_payloads.get(expected_name)
        if phase_payload is None:
            ordered_phase_summaries.append(
                {
                    "name": expected_name,
                    "status": "skip",
                    "timestamp": phase_timestamp,
                    "observations": {"note": "stage not evaluated"},
                    "slo_gates": [],
                    "artifact_refs": [],
                }
            )
            continue

        normalized_phase = dict(phase_payload)
        normalized_phase["name"] = expected_name
        normalized_phase["status"] = coerce_phase_status(
            normalized_phase.get("status"), default="skip"
        )
        normalized_phase["artifact_refs"] = _coerce_path_strings(
            normalized_phase.get("artifact_refs", [])
        )
        normalized_phase.setdefault("slo_gates", [])
        ordered_phase_summaries.append(normalized_phase)

    phase_summaries = ordered_phase_summaries
    phase_transitions = normalize_phase_transitions(phase_summaries)
    normalized_runtime_governance = dict(runtime_governance)
    normalized_runtime_governance["rollback_triggered"] = rollback_triggered
    normalized_runtime_governance["rollback_incident_evidence_path"] = (
        rollback_proof_path
    )
    normalized_runtime_governance["rollback_incident_evidence"] = rollback_proof_path
    normalized_rollback_proof = dict(rollback_proof)
    normalized_rollback_proof["rollback_triggered"] = rollback_triggered
    normalized_rollback_proof["rollback_incident_evidence_path"] = rollback_proof_path
    normalized_rollback_proof["rollback_incident_evidence"] = rollback_proof_path

    return {
        "schema_version": "autonomy-phase-manifest-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "execution_context": {
            "repository": execution_context.get("repository", "unknown"),
            "base": execution_context.get("base", "unknown"),
            "head": execution_context.get("head", "unknown"),
            "artifactPath": artifact_path,
            "priorityId": execution_context.get("priorityId", ""),
        },
        "requested_promotion_target": requested_promotion_target,
        "created_at": phase_timestamp,
        "updated_at": phase_timestamp,
        "phase_count": len(phase_summaries),
        "phase_transitions": phase_transitions,
        "status": "pass" if overall_pass else "fail",
        "observation_summary": {
            "signal_count": len(signals),
            "has_signals": bool(signals),
            "paper_canary_targeted": requested_promotion_target == "paper",
            "live_targeted": requested_promotion_target == "live",
        },
        "phases": phase_summaries,
        "runtime_governance": normalized_runtime_governance,
        "rollback_proof": normalized_rollback_proof,
        "artifact_refs": sorted(
            {
                artifact_ref
                for artifact_ref in [*phase_artifact_refs, *evidence_paths]
                if str(artifact_ref).strip()
            }
        ),
        "slo_contract_version": "governance-slo-v1",
    }


def _coerce_str(raw: Any, default: str = "") -> str:
    if not isinstance(raw, str):
        return default
    return raw.strip() or default


def _coerce_int(raw: Any, default: int = 0) -> int:
    if isinstance(raw, bool):
        return int(raw)
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw)
    if isinstance(raw, str):
        try:
            return int(raw)
        except ValueError:
            return default
    return default


def _coerce_path_strings(values: Any) -> list[str]:
    if not isinstance(values, (list, tuple, set)):
        return []
    value_items = cast(Iterable[object], values)
    return sorted({_coerce_str(value) for value in value_items if _coerce_str(value)})


def _coerce_gate_phase_gates(raw_gates: Any) -> list[dict[str, Any]]:
    gates: list[dict[str, Any]] = []
    if not isinstance(raw_gates, list):
        return gates
    for item in cast(list[object], raw_gates):
        if not isinstance(item, dict):
            continue
        payload = cast(dict[str, Any], item)
        gate_id = str(payload.get("gate_id", "")).strip()
        if not gate_id:
            continue
        status = str(payload.get("status", "fail")).strip()
        gates.append(
            {
                "id": gate_id,
                "status": status if status else "fail",
                "reasons": payload.get("reasons", []),
                "value": payload.get("value"),
                "threshold": payload.get("threshold"),
            }
        )
    return gates


def _build_actuation_intent_payload(
    *,
    run_id: str,
    candidate_id: str,
    generated_at: datetime,
    recommendation_trace_id: str,
    gate_report_trace_id: str,
    promotion_target: str,
    recommended_mode: str,
    actuation_allowed: bool,
    promotion_check: dict[str, Any],
    rollback_check: dict[str, object],
    candidate_state_payload: dict[str, Any],
    gate_report_path: Path,
    rollback_check_path: Path,
    candidate_spec_path: Path,
    candidate_generation_manifest_path: Path,
    evaluation_manifest_path: Path,
    recommendation_manifest_path: Path,
    profitability_manifest_path: Path,
    promotion_recommendation_path: Path,
    evaluation_report_path: Path,
    walk_results_path: Path,
    paper_patch_path: Path | None,
    patch_required: bool,
    profitability_benchmark_path: Path,
    profitability_evidence_path: Path,
    profitability_validation_path: Path,
    simulation_calibration_report_path: Path,
    shadow_live_deviation_report_path: Path,
    benchmark_parity_path: Path,
    foundation_router_parity_path: Path,
    deeplob_bdlob_report_path: Path,
    advisor_fallback_slo_report_path: Path,
    janus_event_car_path: Path,
    janus_hgrm_reward_path: Path,
    recalibration_report_path: Path,
    promotion_gate_path: Path,
    promotion_recommendation: PromotionRecommendation,
    recommendations: list[str],
    governance_repository: str,
    governance_base: str,
    governance_head: str,
    governance_artifact_path: str,
    priority_id: str | None,
    governance_change: str,
    governance_reason: str,
    stage_lineage_payload: dict[str, Any],
    replay_artifact_hashes: dict[str, str],
    candidate_hash: str,
) -> dict[str, Any]:
    raw_missing_checks = cast(object, rollback_check.get("missing_checks"))
    rollback_missing_checks = (
        list(cast(list[object], raw_missing_checks))
        if isinstance(raw_missing_checks, list)
        else []
    )
    rollback_evidence_links: list[str] = []
    rollback_evidence_links.extend(
        [
            str(candidate_spec_path),
            str(gate_report_path),
            str(evaluation_report_path),
            str(walk_results_path),
            str(promotion_gate_path),
            str(candidate_generation_manifest_path),
            str(evaluation_manifest_path),
            str(recommendation_manifest_path),
            str(profitability_manifest_path),
            str(promotion_recommendation_path),
            str(profitability_benchmark_path),
            str(benchmark_parity_path),
            str(foundation_router_parity_path),
            str(deeplob_bdlob_report_path),
            str(advisor_fallback_slo_report_path),
            str(profitability_evidence_path),
            str(profitability_validation_path),
            str(simulation_calibration_report_path),
            str(shadow_live_deviation_report_path),
            str(janus_event_car_path),
            str(janus_hgrm_reward_path),
            str(recalibration_report_path),
            str(rollback_check_path),
        ]
    )
    if paper_patch_path is not None:
        rollback_evidence_links.append(str(paper_patch_path))
    rollback_evidence_links.extend(
        [str(item) for item in promotion_check.get("artifact_refs", [])]
    )
    candidate_state_readiness = _candidate_state_readiness_payload(
        candidate_state_payload
    )
    return {
        "schema_version": _ACTUATION_INTENT_SCHEMA_VERSION,
        "run_id": run_id,
        "candidate_id": candidate_id,
        "generated_at": generated_at.isoformat(),
        "generated_for": "autonomous-lane",
        "promotion_target": promotion_target,
        "recommended_mode": recommended_mode,
        "governance": {
            "repository": governance_repository,
            "base": governance_base,
            "head": governance_head,
            "artifact_path": governance_artifact_path,
            "change": governance_change,
            "reason": governance_reason,
            "priority_id": priority_id,
        },
        "actuation_allowed": actuation_allowed,
        "confirmation_phrase_required": promotion_target == "live",
        "confirmation_phrase": (
            _ACTUATION_CONFIRMATION_PHRASE if promotion_target == "live" else None
        ),
        "gates": {
            "recommendation_trace_id": recommendation_trace_id,
            "gate_report_trace_id": gate_report_trace_id,
            "promotion_allowed": promotion_recommendation.eligible,
            "promotion_action": promotion_recommendation.action,
            "recommendation_reasons": recommendations,
        },
        "candidate_hash": candidate_hash,
        "artifact_refs": sorted(
            {item for item in rollback_evidence_links if item.strip()}
        ),
        "audit": {
            "candidate_state_payload": candidate_state_payload,
            "promotion_check": promotion_check,
            "rollback_check": rollback_check,
            "stage_lineage": stage_lineage_payload,
            "replay_artifact_hashes": replay_artifact_hashes,
            "patch_required": patch_required,
            "patch_available": paper_patch_path is not None,
            "rollback_readiness_readout": {
                "kill_switch_dry_run_passed": bool(
                    candidate_state_readiness.get("killSwitchDryRunPassed")
                ),
                "gitops_revert_dry_run_passed": bool(
                    candidate_state_readiness.get("gitopsRevertDryRunPassed")
                ),
                "strategy_disable_dry_run_passed": bool(
                    candidate_state_readiness.get("strategyDisableDryRunPassed")
                ),
                "human_approved": bool(candidate_state_readiness.get("humanApproved")),
                "rollback_target": str(
                    candidate_state_readiness.get("rollbackTarget") or ""
                ),
                "dry_run_completed_at": str(
                    candidate_state_readiness.get("dryRunCompletedAt") or ""
                ),
            },
            "rollback_evidence_missing_checks": rollback_missing_checks,
        },
    }


def _candidate_state_readiness_payload(
    candidate_state_payload: dict[str, Any],
) -> dict[str, Any]:
    candidate_state_readiness_raw = candidate_state_payload.get("rollbackReadiness", {})
    return (
        cast(dict[str, Any], candidate_state_readiness_raw)
        if isinstance(candidate_state_readiness_raw, dict)
        else {}
    )


prepare_lane_output_dirs = _prepare_lane_output_dirs
normalize_governance_inputs = _normalize_governance_inputs
coalesce_governance_context = _coalesce_governance_context
build_phase_manifest = _build_phase_manifest
coerce_str = _coerce_str
coerce_int = _coerce_int
coerce_path_strings = _coerce_path_strings
coerce_gate_phase_gates = _coerce_gate_phase_gates
build_actuation_intent_payload = _build_actuation_intent_payload
candidate_state_readiness_payload = _candidate_state_readiness_payload

__all__ = [
    "prepare_lane_output_dirs",
    "normalize_governance_inputs",
    "coalesce_governance_context",
    "build_phase_manifest",
    "coerce_str",
    "coerce_int",
    "coerce_path_strings",
    "coerce_gate_phase_gates",
    "build_actuation_intent_payload",
    "candidate_state_readiness_payload",
]
