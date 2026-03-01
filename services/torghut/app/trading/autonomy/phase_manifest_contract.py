from __future__ import annotations

from typing import Any

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


def coerce_phase_status(raw: Any, *, default: str = "skip") -> str:
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
