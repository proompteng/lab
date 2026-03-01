from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

AUTONOMY_PHASE_ORDER: tuple[str, ...] = (
    "gate-evaluation",
    "promotion-prerequisites",
    "rollback-readiness",
    "drift-gate",
    "paper-canary",
    "runtime-governance",
    "rollback-proof",
)
AUTONOMY_PHASE_STATUS_DEFAULT = "skip"
AUTONOMY_PHASE_SLO_GATES: dict[str, tuple[dict[str, Any], ...]] = cast(
    dict[str, tuple[dict[str, Any], ...]],
    {
        "gate-evaluation": (
            {"id": "slo_signal_count_minimum", "status": "pass", "threshold": 1},
            {"id": "slo_decision_count_minimum", "status": "pass", "threshold": 1},
            {"id": "slo_gate_evaluations_present"},
        ),
    "promotion-prerequisites": (
        {"id": "slo_required_artifacts_present", "status": "pass", "threshold": 0},
    ),
    "rollback-readiness": (
        {
            "id": "slo_required_rollback_checks_present",
            "status": "pass",
            "threshold": 0,
        },
    ),
    "drift-gate": ({"id": "slo_drift_gate_allowed", "status": "pass", "threshold": True},),
    "paper-canary": (
        {
            "id": "slo_paper_canary_patch_present",
            "status": "pass",
            "threshold": "patch exists for paper target",
        },
    ),
    "runtime-governance": (
        {"id": "slo_runtime_rollback_not_triggered", "status": "pass", "threshold": False},
    ),
    "rollback-proof": (
        {
            "id": "slo_rollback_evidence_required_when_triggered",
            "status": "pass",
            "threshold": True,
        },
    ),
    },
)
AUTONOMY_MANIFEST_STATUSES: tuple[str, ...] = (
    "pass",
    "skip",
    "skipped",
    "fail",
)


def coerce_phase_status(raw: Any, *, default: str = "fail") -> str:
    if raw is None:
        return default
    status = str(raw).strip().lower()
    return status if status in AUTONOMY_MANIFEST_STATUSES else default


def get_phase_slo_gate_ids(phase_name: str) -> tuple[str, ...]:
    gates = AUTONOMY_PHASE_SLO_GATES.get(phase_name, ())
    return tuple(str(gate.get("id", "")) for gate in gates if str(gate.get("id", "")))


def build_ordered_phase_summaries(
    phase_payloads: Sequence[Mapping[str, Any]] | Mapping[str, Any],
    *,
    phase_timestamp: str,
    default_status: str = AUTONOMY_PHASE_STATUS_DEFAULT,
) -> list[dict[str, Any]]:
    if isinstance(phase_payloads, Mapping):
        raw_payloads = [dict(phase_payloads)]
    else:
        raw_payloads = [dict(payload) for payload in phase_payloads]

    canonical_payloads: dict[str, dict[str, Any]] = {}
    for payload in raw_payloads:
        phase_name = str(payload.get("name", "")).strip()
        if not phase_name:
            continue
        canonical_payloads[phase_name] = payload

    ordered_payloads: list[dict[str, Any]] = []
    for phase_name in AUTONOMY_PHASE_ORDER:
        source_payload = canonical_payloads.get(phase_name)
        if source_payload is None:
            ordered_payloads.append(
                {
                    "name": phase_name,
                    "status": default_status,
                    "timestamp": phase_timestamp,
                    "observations": {"note": "stage not evaluated"},
                    "slo_gates": [
                        {
                            **dict(gate),
                            "status": str(gate.get("status", default_status)).strip()
                            or default_status,
                        }
                        for gate in AUTONOMY_PHASE_SLO_GATES.get(phase_name, ())
                    ],
                    "artifact_refs": [],
                }
            )
            continue
        normalized_payload = dict(source_payload)
        normalized_payload["name"] = phase_name
        normalized_payload["status"] = coerce_phase_status(
            normalized_payload.get("status"), default=default_status
        )
        normalized_payload.setdefault("timestamp", phase_timestamp)
        normalized_payload.setdefault("slo_gates", [])
        normalized_payload.setdefault("artifact_refs", [])
        ordered_payloads.append(normalized_payload)

    return ordered_payloads


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
            }
        )
    return transitions
