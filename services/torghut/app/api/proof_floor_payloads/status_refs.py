"""Proof-floor reference payload helpers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

from ..common import (
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
    load_jangar_route_continuity_packet,
)

__all__ = (
    "build_jangar_reliability_settlement_ref_payload",
    "build_simple_lane_status_payload",
    "build_torghut_routeability_admission_ref",
    "build_torghut_stage_clearance_packet_ref_payload",
    "route_continuity_packet_for_proof_floor",
)


def build_simple_lane_status_payload() -> dict[str, object]:
    from ..health_checks import build_simple_lane_status_payload as build_payload

    return build_payload()


def route_continuity_packet_for_proof_floor(
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    registry = load_hypothesis_registry()
    if hypothesis_registry_requires_dependency_capability(
        registry,
        "jangar_dependency_quorum",
    ):
        return load_jangar_route_continuity_packet(action_class="paper_canary")

    continuity_ref = (
        str(proof_floor.get("generated_at") or "").strip()
        or str(proof_floor.get("torghut_revision") or "").strip()
        or "unknown"
    )
    return {
        "epoch_id": f"torghut-self-continuity:{continuity_ref}",
        "state": "present",
        "decision": "allow",
        "fresh_until": proof_floor.get("fresh_until"),
        "blocking_reasons": [],
        "source": "torghut_hypothesis_registry",
        "action_class": "paper_canary",
    }


def build_torghut_routeability_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_admission = dependency_quorum.get("routeability_admission")
    empty_admission: Mapping[str, Any] = {}
    admission: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_admission)
        if isinstance(raw_admission, Mapping)
        else empty_admission
    )
    decision = (
        str(
            admission.get("decision")
            or admission.get("state")
            or dependency_quorum.get("decision")
            or "missing"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            admission.get("state")
            or admission.get("status")
            or ("current" if decision == "allow" else "missing")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        admission.get("reason_codes")
        or admission.get("blocking_reasons")
        or dependency_quorum.get("reasons")
        or []
    )
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "admission_ref": f"jangar-routeability-admission:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "routeability_admission"
        if admission.get("admission_ref") or admission.get("id")
        else "dependency_quorum_proxy",
        "action_classes": ["torghut_observe", "paper_canary"],
        "generated_at": admission.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": admission.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def build_jangar_reliability_settlement_ref_payload(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    from .build_jangar_reliability_settlement_ref import (
        build_jangar_reliability_settlement_ref as build_ref,
    )

    return build_ref(dependency_quorum)


def build_torghut_stage_clearance_packet_ref_payload(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    from .build_jangar_reliability_settlement_ref import (
        build_torghut_stage_clearance_packet_ref as build_ref,
    )

    return build_ref(dependency_quorum)
