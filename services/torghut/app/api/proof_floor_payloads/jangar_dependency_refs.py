"""Jangar dependency reference payloads for proof-floor API responses."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast


def build_jangar_contract_graduation_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    reasons = [
        str(item).strip()
        for item in cast(Sequence[object], dependency_quorum.get("reasons") or [])
        if str(item).strip()
    ]
    return {
        "contract_ref": "docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md",
        "state": "current" if decision == "allow" else "missing",
        "decision": decision,
        "reasons": reasons,
        "generated_at": dependency_quorum.get("generated_at"),
    }


def build_jangar_material_verdict_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "unknown").strip().lower()
    raw_reasons: object = dependency_quorum.get("reasons")
    reason_items: Sequence[object] = (
        cast(Sequence[object], raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    reasons = [str(item).strip() for item in reason_items if str(item).strip()]
    ref_suffix = decision if not reasons else f"{decision}:{','.join(sorted(reasons))}"
    return {
        "verdict_ref": f"jangar-material-verdict:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "action_classes": ["paper_canary", "live_micro_canary", "live_scale"],
        "generated_at": dependency_quorum.get("generated_at"),
    }


def build_jangar_execution_trust_admission_ref(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    raw_execution_trust = dependency_quorum.get("execution_trust")
    empty_execution_trust: Mapping[str, Any] = {}
    execution_trust: Mapping[str, Any] = (
        cast(Mapping[str, Any], raw_execution_trust)
        if isinstance(raw_execution_trust, Mapping)
        else empty_execution_trust
    )
    decision = (
        str(
            execution_trust.get("decision")
            or execution_trust.get("state")
            or dependency_quorum.get("decision")
            or "unknown"
        )
        .strip()
        .lower()
    )
    state = (
        str(
            execution_trust.get("state")
            or execution_trust.get("status")
            or ("current" if decision == "allow" else "degraded")
        )
        .strip()
        .lower()
    )
    raw_reasons: object = (
        execution_trust.get("reason_codes")
        or execution_trust.get("blocking_reasons")
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
        "admission_ref": f"jangar-execution-trust:dependency-quorum:{ref_suffix}",
        "decision": decision,
        "state": state,
        "reason_codes": reasons,
        "source": "dependency_quorum_proxy",
        "generated_at": execution_trust.get("generated_at")
        or dependency_quorum.get("generated_at"),
        "fresh_until": execution_trust.get("fresh_until")
        or dependency_quorum.get("fresh_until"),
    }


def consumer_evidence_jangar_continuity_packet(
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    material_ref = build_jangar_material_verdict_ref(dependency_quorum)
    decision = str(material_ref.get("decision") or "unknown")
    allow = decision == "allow"
    return {
        "epoch_id": material_ref["verdict_ref"],
        "state": "present" if allow else "missing",
        "decision": "allow" if allow else "hold",
        "fresh_until": dependency_quorum.get("fresh_until"),
        "blocking_reasons": [] if allow else [f"jangar_material_verdict_{decision}"],
        "action_class": "paper_canary",
    }


__all__ = (
    "build_jangar_contract_graduation_ref",
    "build_jangar_material_verdict_ref",
    "build_jangar_execution_trust_admission_ref",
    "consumer_evidence_jangar_continuity_packet",
)
