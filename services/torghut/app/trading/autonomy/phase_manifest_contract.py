from __future__ import annotations

from datetime import datetime, timezone
from collections.abc import Iterable
from typing import Any, Mapping, Sequence, cast

AUTONOMY_PHASE_ORDER: tuple[str, ...] = (
    "gate-evaluation",
    "promotion-prerequisites",
    "rollback-readiness",
    "drift-gate",
    "paper-canary",
    "runtime-governance",
    "rollback-proof",
)
AUTONOMY_MANIFEST_STATUSES: tuple[str, ...] = (
    "pass",
    "skip",
    "skipped",
    "fail",
)
AUTONOMY_PASSING_MANIFEST_STATUSES: tuple[str, ...] = (
    "pass",
    "skip",
    "skipped",
)
AUTONOMY_PHASE_MANIFEST_SCHEMA_VERSION = "autonomy-phase-manifest-v1"
AUTONOMY_PHASE_MANIFEST_SLO_VERSION = "governance-slo-v1"
AUTONOMY_PHASE_SLO_GATE_IDS = {
    "gate-evaluation": (
        "slo_signal_count_minimum",
        "slo_decision_count_minimum",
    ),
    "promotion-prerequisites": (
        "slo_required_artifacts_present",
    ),
    "rollback-readiness": (
        "slo_required_rollback_checks_present",
    ),
    "drift-gate": (
        "slo_drift_gate_allowed",
    ),
    "paper-canary": (
        "slo_paper_canary_patch_present",
    ),
    "runtime-governance": (
        "slo_runtime_rollback_not_triggered",
    ),
    "rollback-proof": (
        "slo_rollback_evidence_required_when_triggered",
    ),
}


def required_slo_gate_ids(phase_name: str) -> tuple[str, ...]:
    return AUTONOMY_PHASE_SLO_GATE_IDS.get(_coerce_str(phase_name), tuple())


def _coerce_str(raw: Any, default: str = "") -> str:
    if not isinstance(raw, str):
        return default
    return raw.strip()


def coerce_phase_status(raw: Any, *, default: str = "fail") -> str:
    if raw is None:
        return default
    status = str(raw).strip().lower()
    return status if status in AUTONOMY_MANIFEST_STATUSES else default


def _coerce_manifest_artifact_context(
    execution_context: Mapping[str, Any],
) -> dict[str, str]:
    return {
        "repository": _coerce_str(execution_context.get("repository"), default="unknown"),
        "base": _coerce_str(execution_context.get("base"), default="unknown"),
        "head": _coerce_str(execution_context.get("head"), default="unknown"),
        "artifactPath": _coerce_str(
            execution_context.get("artifactPath"),
            default="unknown",
        ),
        "priorityId": _coerce_str(execution_context.get("priorityId")),
    }


def normalize_phase_transitions(phases: list[dict[str, Any]]) -> list[dict[str, str]]:
    transitions: list[dict[str, str]] = []
    for index in range(1, len(phases)):
        previous_phase = phases[index - 1]
        current_phase = phases[index]
        transitions.append(
            {
                "from": str(previous_phase.get("name", "")),
                "to": str(current_phase.get("name", "")),
                "status": coerce_phase_status(current_phase.get("status")),
            },
        )
    return transitions


def coerce_path_strings(values: Any) -> list[str]:
    if not isinstance(values, (list, tuple, set)):
        return []
    values_iterable = cast(Iterable[Any], values)
    return sorted(
        {
            _coerce_str(item)
            for item in values_iterable
            if _coerce_str(item)
        }
    )


def build_phase_manifest_payload(
    *,
    run_id: str,
    candidate_id: str,
    execution_context: Mapping[str, Any],
    requested_promotion_target: str,
    phase_payloads: Sequence[Mapping[str, Any]],
    runtime_governance: Mapping[str, Any],
    rollback_proof: Mapping[str, Any],
    observation_summary: Mapping[str, Any] | None,
    artifact_refs: Any,
    phase_timestamp: datetime | str,
    created_at: datetime | str | None = None,
    updated_at: datetime | None | str = None,
    status: str | None = None,
    schema_version: str = AUTONOMY_PHASE_MANIFEST_SCHEMA_VERSION,
    slo_contract_version: str = AUTONOMY_PHASE_MANIFEST_SLO_VERSION,
) -> dict[str, Any]:
    normalized_phases = normalize_phase_manifest_phases(
        phase_payloads,
        phase_timestamp=phase_timestamp,
    )
    normalized_status = (
        "pass" if status is None else coerce_phase_status(status, default="fail")
    )
    if status is None:
        normalized_status = (
            "pass"
            if all(
                coerce_phase_status(phase.get("status"), default="fail")
                in AUTONOMY_PASSING_MANIFEST_STATUSES
                for phase in normalized_phases
            )
            else "fail"
        )
    manifest_artifact_refs = coerce_path_strings(artifact_refs)
    for phase in normalized_phases:
        manifest_artifact_refs.extend(coerce_path_strings(phase.get("artifact_refs", [])))

    created_at_timestamp = (
        created_at.isoformat()
        if isinstance(created_at, datetime)
        else _coerce_str(created_at)
    ) or (
        phase_timestamp.isoformat()
        if isinstance(phase_timestamp, datetime)
        else _coerce_str(phase_timestamp)
    )
    updated_at_timestamp = (
        updated_at.isoformat()
        if isinstance(updated_at, datetime)
        else _coerce_str(updated_at)
    ) or (
        phase_timestamp.isoformat()
        if isinstance(phase_timestamp, datetime)
        else _coerce_str(phase_timestamp)
    )

    return {
        "schema_version": schema_version,
        "run_id": _coerce_str(run_id),
        "candidate_id": _coerce_str(candidate_id),
        "execution_context": _coerce_manifest_artifact_context(execution_context),
        "requested_promotion_target": str(requested_promotion_target),
        "created_at": created_at_timestamp,
        "updated_at": updated_at_timestamp,
        "phase_count": len(normalized_phases),
        "phase_transitions": normalize_phase_transitions(normalized_phases),
        "status": normalized_status,
        "observation_summary": observation_summary or {},
        "phases": normalized_phases,
        "runtime_governance": runtime_governance,
        "rollback_proof": rollback_proof,
        "artifact_refs": sorted(set(manifest_artifact_refs)),
        "slo_contract_version": slo_contract_version,
    }


def build_runtime_governance_phase(
    *,
    requested_promotion_target: str,
    observed_at: datetime | str,
    governance_status: str | None,
    drift_status: str,
    action_type: str,
    action_triggered: bool,
    rollback_triggered: bool,
    reasons: Any,
    artifact_refs: Any,
) -> dict[str, Any]:
    timestamp = (
        observed_at.isoformat()
        if isinstance(observed_at, datetime)
        else _coerce_str(observed_at)
    )
    if not timestamp:
        timestamp = datetime.now(timezone.utc).isoformat()

    normalized_reasons = coerce_path_strings(reasons)
    return {
        "name": "runtime-governance",
        "status": coerce_phase_status(governance_status, default="skipped"),
        "timestamp": timestamp,
        "observations": {
            "requested_promotion_target": requested_promotion_target,
            "drift_status": drift_status,
            "action_type": action_type or None,
            "action_triggered": bool(action_triggered),
            "rollback_triggered": bool(rollback_triggered),
        },
        "slo_gates": [
            {
                "id": "slo_runtime_rollback_not_triggered",
                "status": "pass" if not rollback_triggered else "fail",
                "threshold": False,
                "value": bool(rollback_triggered),
            },
        ],
        "required": {"required_items": ["drift_status", "rollback_triggered"]},
        "artifact_refs": coerce_path_strings(artifact_refs),
        "reasons": sorted(normalized_reasons),
    }


def build_rollback_proof_phase(
    *,
    observed_at: datetime | str,
    rollback_triggered: bool,
    rollback_incident_evidence_path: str | None,
    reasons: Any,
    artifact_refs: Any,
) -> dict[str, Any]:
    timestamp = (
        observed_at.isoformat()
        if isinstance(observed_at, datetime)
        else _coerce_str(observed_at)
    )
    if not timestamp:
        timestamp = datetime.now(timezone.utc).isoformat()

    evidence_path = _coerce_str(rollback_incident_evidence_path)
    trigger = bool(rollback_triggered)
    status = "pass"
    if trigger and not evidence_path:
        status = "fail"

    normalized_reasons = coerce_path_strings(reasons)
    merged_artifacts = coerce_path_strings(artifact_refs)
    if evidence_path and evidence_path not in merged_artifacts:
        merged_artifacts.append(evidence_path)

    return {
        "name": "rollback-proof",
        "status": status,
        "timestamp": timestamp,
        "slo_gates": [
            {
                "id": "slo_rollback_evidence_required_when_triggered",
                "status": "pass" if not trigger else ("pass" if evidence_path else "fail"),
                "threshold": True,
                "value": bool(evidence_path),
            },
        ],
        "observations": {
            "rollback_triggered": trigger,
            "rollback_incident_evidence_path": evidence_path,
            "rollback_incident_evidence": evidence_path,
        },
        "reasons": sorted(normalized_reasons),
        "artifact_refs": merged_artifacts,
    }


def build_runtime_and_rollback_governance_payloads(
    *,
    requested_promotion_target: str,
    observed_at: datetime | str,
    governance_status: str | None,
    drift_status: str,
    action_type: str,
    action_triggered: bool,
    rollback_triggered: bool,
    rollback_incident_evidence_path: str | None,
    reasons: Any,
    evidence_artifact_refs: Any,
) -> dict[str, Any]:
    normalized_reasons = coerce_path_strings(reasons)
    normalized_evidence_refs = coerce_path_strings(evidence_artifact_refs)
    normalized_drift_status = _coerce_str(drift_status, default="unknown")
    normalized_action_type = str(action_type or "").strip()
    normalized_rollback_triggered = bool(rollback_triggered)
    normalized_governance_status = coerce_phase_status(governance_status, default="skipped")
    normalized_incident_evidence_input = _coerce_str(rollback_incident_evidence_path)
    normalized_incident_evidence = (
        normalized_incident_evidence_input
        if normalized_rollback_triggered
        else ""
    )
    rollback_proof_evidence_refs = normalized_evidence_refs
    if not normalized_rollback_triggered and normalized_incident_evidence_input:
        rollback_proof_evidence_refs = [
            ref
            for ref in rollback_proof_evidence_refs
            if ref != normalized_incident_evidence_input
        ]
    runtime_phase = build_runtime_governance_phase(
        requested_promotion_target=requested_promotion_target,
        observed_at=observed_at,
        governance_status=normalized_governance_status,
        drift_status=normalized_drift_status,
        action_type=normalized_action_type,
        action_triggered=bool(action_triggered),
        rollback_triggered=normalized_rollback_triggered,
        reasons=normalized_reasons,
        artifact_refs=normalized_evidence_refs,
    )
    rollback_proof_phase = build_rollback_proof_phase(
        observed_at=observed_at,
        rollback_triggered=normalized_rollback_triggered,
        rollback_incident_evidence_path=normalized_incident_evidence,
        reasons=normalized_reasons,
        artifact_refs=rollback_proof_evidence_refs,
    )

    return {
        "runtime_phase": runtime_phase,
        "rollback_proof_phase": rollback_proof_phase,
        "runtime_governance": {
            "requested_promotion_target": requested_promotion_target,
            "drift_status": normalized_drift_status,
            "governance_status": normalized_governance_status,
            "rollback_triggered": normalized_rollback_triggered,
            "action_type": normalized_action_type or None,
            "action_triggered": bool(action_triggered),
            "rollback_incident_evidence_path": normalized_incident_evidence,
            "rollback_incident_evidence": normalized_incident_evidence,
            "artifact_refs": normalized_evidence_refs,
            "reasons": normalized_reasons,
            "status": runtime_phase.get("status"),
        },
        "rollback_proof": {
            "requested_promotion_target": requested_promotion_target,
            "rollback_triggered": normalized_rollback_triggered,
            "rollback_incident_evidence_path": normalized_incident_evidence,
            "rollback_incident_evidence": normalized_incident_evidence,
            "artifact_refs": rollback_proof_phase.get("artifact_refs", []),
            "reasons": normalized_reasons,
            "status": rollback_proof_phase.get("status"),
        },
    }


def normalize_phase_manifest_phases(
    phase_payloads: Sequence[Mapping[str, Any]],
    *,
    phase_timestamp: datetime | str,
) -> list[dict[str, Any]]:
    phase_time = (
        phase_timestamp.isoformat()
        if isinstance(phase_timestamp, datetime)
        else _coerce_str(phase_timestamp)
    )
    if not phase_time:
        phase_time = datetime.now(timezone.utc).isoformat()

    phase_lookup: dict[str, dict[str, Any]] = {}
    for phase in phase_payloads:
        name = _coerce_str(phase.get("name"))
        if not name:
            continue
        payload = dict(phase)
        payload["name"] = name
        phase_lookup[name] = payload

    ordered_phases: list[dict[str, Any]] = []
    for phase_name in AUTONOMY_PHASE_ORDER:
        phase_payload = phase_lookup.get(phase_name)
        if phase_payload is None:
            ordered_phases.append(
                {
                    "name": phase_name,
                    "status": "skipped",
                    "timestamp": phase_time,
                    "observations": {"note": "stage not evaluated"},
                    "slo_gates": [],
                    "artifact_refs": [],
                }
            )
            continue

        normalized_phase = dict(phase_payload)
        normalized_phase["name"] = phase_name
        normalized_phase["status"] = coerce_phase_status(
            normalized_phase.get("status"),
            default="skipped",
        )
        normalized_phase.setdefault("observations", {})
        phase_status = str(normalized_phase.get("status", "skipped"))
        existing_slo_gates = normalized_phase.get("slo_gates")
        normalized_slo_gates: list[Mapping[str, Any]] = []
        if isinstance(existing_slo_gates, list):
            for gate in cast(Sequence[object], existing_slo_gates):
                if isinstance(gate, Mapping):
                    normalized_slo_gates.append(cast(Mapping[str, Any], gate))
        normalized_phase["slo_gates"] = normalized_slo_gates
        normalized_slo_gate_ids: set[str] = set()
        for gate in normalized_slo_gates:
            gate_id = str(gate.get("id", "")).strip()
            if gate_id:
                normalized_slo_gate_ids.add(gate_id)
        required_gate_ids = required_slo_gate_ids(phase_name)
        for gate_id in required_gate_ids:
            if gate_id not in normalized_slo_gate_ids:
                normalized_phase["slo_gates"].append(
                    {
                        "id": gate_id,
                        "status": phase_status,
                        "threshold": None,
                        "value": None,
                    }
                )
        normalized_phase["artifact_refs"] = coerce_path_strings(
            normalized_phase.get("artifact_refs", [])
        )
        ordered_phases.append(normalized_phase)

    return ordered_phases
