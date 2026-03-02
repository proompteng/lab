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


def _coerce_str(raw: Any, default: str = "") -> str:
    if not isinstance(raw, str):
        return default
    return raw.strip()


def coerce_phase_status(raw: Any, *, default: str = "fail") -> str:
    if raw is None:
        return default
    status = str(raw).strip().lower()
    return status if status in AUTONOMY_MANIFEST_STATUSES else default


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
        normalized_phase.setdefault("slo_gates", [])
        normalized_phase["artifact_refs"] = coerce_path_strings(
            normalized_phase.get("artifact_refs", [])
        )
        ordered_phases.append(normalized_phase)

    return ordered_phases
