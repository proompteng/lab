"""Neutral proof health checks."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

from .schemas import HealthPayload
from .targets import ProofTarget, mapping_value


def build_health_payload(
    *,
    live_submission_gate: Mapping[str, Any],
    target: ProofTarget,
) -> HealthPayload:
    source_reasons = _text_items(live_submission_gate.get("blocked_reasons"))
    source_reasons.extend(_text_items(live_submission_gate.get("reason_codes")))
    import_health_gate = mapping_value(
        target.raw.get("runtime_window_import_health_gate")
    )
    source_reasons.extend(_text_items(import_health_gate.get("blockers")))
    dependency_quorum_ok = not _contains_any(
        source_reasons,
        ("dependency_quorum_not_allow", "dependency_quorum_blocked"),
    )
    continuity_ok = not _contains_any(
        source_reasons,
        ("continuity_not_ok", "continuity_failure"),
    )
    drift_ok = not _contains_any(source_reasons, ("drift_blocker", "drift_not_ok"))
    blockers: list[str] = []
    if not dependency_quorum_ok:
        blockers.append("dependency_quorum_blocked")
    if not continuity_ok:
        blockers.append("continuity_failure")
    if not drift_ok:
        blockers.append("drift_blocker")
    return {
        "dependency_quorum_ok": dependency_quorum_ok,
        "continuity_ok": continuity_ok,
        "drift_ok": drift_ok,
        "blockers": blockers,
    }


def _text_items(value: object) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return [
            str(item).strip()
            for item in cast(Sequence[object], value)
            if str(item).strip()
        ]
    return []


def _contains_any(values: Sequence[str], needles: Sequence[str]) -> bool:
    normalized = " ".join(value.lower() for value in values)
    return any(needle.lower() in normalized for needle in needles)
