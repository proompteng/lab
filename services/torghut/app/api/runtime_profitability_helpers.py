"""Extracted Torghut API route and support functions."""

# pyright: reportUnusedImport=false
# ruff: noqa: F401,F403,F405
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import cast
from .proxy import capture_module_exports
from .vnext_helpers import (
    extract_gate_result as _extract_gate_result,
    load_json_artifact_payload as _load_json_artifact_payload,
    safe_int as _safe_int,
    to_str_map as _to_str_map,
)


def _load_runtime_profitability_gate_rollback_attribution(
    state: object,
) -> dict[str, object]:
    gate_artifact_path = str(getattr(state, "last_autonomy_gates", "") or "").strip()
    gate_payload = _load_json_artifact_payload(gate_artifact_path)
    actuation_artifact_path = str(
        getattr(state, "last_autonomy_actuation_intent", "") or ""
    ).strip()
    actuation_payload = _load_json_artifact_payload(actuation_artifact_path)
    gate6 = _extract_gate_result(
        cast(list[object], gate_payload.get("gates") or []),
        gate_id="gate6_profitability_evidence",
    )

    promotion_decision = _to_str_map(gate_payload.get("promotion_decision"))
    promotion_recommendation = _to_str_map(gate_payload.get("promotion_recommendation"))
    provenance = _to_str_map(gate_payload.get("provenance"))
    actuation_gates = _to_str_map(actuation_payload.get("gates"))
    actuation_root = _to_str_map(actuation_payload)
    actuation_audit = _to_str_map(actuation_payload.get("audit"))
    actuation_readiness = _to_str_map(actuation_audit.get("rollback_readiness_readout"))

    def _optional_trace_id(value: object) -> str | None:
        if value is None:
            return None
        trace_id = str(value).strip()
        return trace_id or None

    actuation_trace = _optional_trace_id(
        actuation_gates.get("gate_report_trace_id")
        or provenance.get("gate_report_trace_id")
    )
    actuation_recommendation_trace = _optional_trace_id(
        actuation_gates.get("recommendation_trace_id")
        or provenance.get("recommendation_trace_id")
    )

    actuation_artifact_refs_raw = actuation_payload.get("artifact_refs")
    actuation_artifact_refs = (
        [str(item) for item in cast(list[object], actuation_artifact_refs_raw)]
        if isinstance(actuation_artifact_refs_raw, list)
        else []
    )
    actuation_artifact_refs = [item for item in actuation_artifact_refs if item.strip()]

    rollback_evidence_path = str(
        getattr(state, "rollback_incident_evidence_path", "") or ""
    ).strip()
    rollback_payload = _load_json_artifact_payload(rollback_evidence_path)
    rollback_reasons_raw = rollback_payload.get("reasons")
    rollback_reasons = (
        [
            str(item)
            for item in cast(list[object], rollback_reasons_raw)
            if str(item).strip()
        ]
        if isinstance(rollback_reasons_raw, list)
        else []
    )
    rollback_verification = _to_str_map(rollback_payload.get("verification"))
    metrics = getattr(state, "metrics", None)
    return {
        "gate_report_artifact": gate_artifact_path or None,
        "gate_report_run_id": (
            str(
                actuation_payload.get("run_id") or gate_payload.get("run_id") or ""
            ).strip()
            or None
        ),
        "gate_report_trace_id": (
            actuation_trace
            if actuation_trace
            else _optional_trace_id(provenance.get("gate_report_trace_id"))
        ),
        "recommendation_trace_id": (
            actuation_recommendation_trace
            if actuation_recommendation_trace
            else _optional_trace_id(provenance.get("recommendation_trace_id"))
        ),
        "gate6_profitability_evidence": gate6,
        "promotion_decision": {
            "promotion_target": promotion_decision.get("promotion_target"),
            "recommended_mode": promotion_decision.get("recommended_mode"),
            "promotion_allowed": promotion_decision.get("promotion_allowed"),
            "reason_codes": promotion_decision.get("reason_codes"),
            "promotion_gate_artifact": promotion_decision.get(
                "promotion_gate_artifact"
            ),
            "recommendation_action": promotion_recommendation.get("action"),
        },
        "profitability_artifacts": {
            "benchmark": provenance.get("profitability_benchmark_artifact"),
            "evidence": provenance.get("profitability_evidence_artifact"),
            "validation": provenance.get("profitability_validation_artifact"),
        },
        "actuation_intent": {
            "artifact_path": actuation_artifact_path or None,
            "actuation_allowed": bool(actuation_root.get("actuation_allowed")),
            "recommendation_trace_id": (
                str(actuation_gates.get("recommendation_trace_id") or "").strip()
                or None
            ),
            "gate_report_trace_id": (
                str(actuation_gates.get("gate_report_trace_id") or "").strip() or None
            ),
            "promotion_target": actuation_root.get("promotion_target"),
            "recommended_mode": actuation_root.get("recommended_mode"),
            "confirmation_phrase_required": bool(
                actuation_root.get("confirmation_phrase_required")
            ),
            "rollback_readiness": {
                "kill_switch_dry_run_passed": bool(
                    actuation_readiness.get("kill_switch_dry_run_passed")
                ),
                "gitops_revert_dry_run_passed": bool(
                    actuation_readiness.get("gitops_revert_dry_run_passed")
                ),
                "strategy_disable_dry_run_passed": bool(
                    actuation_readiness.get("strategy_disable_dry_run_passed")
                ),
                "human_approved": bool(actuation_readiness.get("human_approved")),
                "rollback_target": actuation_readiness.get("rollback_target"),
                "dry_run_completed_at": actuation_readiness.get("dry_run_completed_at"),
                "missing_checks": actuation_audit.get(
                    "rollback_evidence_missing_checks"
                ),
                "evidence_links": sorted(set(actuation_artifact_refs)),
            },
        },
        "rollback": {
            "emergency_stop_active": bool(
                getattr(state, "emergency_stop_active", False)
            ),
            "emergency_stop_reason": getattr(state, "emergency_stop_reason", None),
            "incidents_total": _safe_int(getattr(state, "rollback_incidents_total", 0)),
            "incident_evidence_path": rollback_evidence_path or None,
            "incident_reason_codes": rollback_reasons,
            "incident_evidence_complete": rollback_verification.get(
                "incident_evidence_complete"
            ),
            "signal_continuity_promotion_block_total": _safe_int(
                getattr(metrics, "signal_continuity_promotion_block_total", 0)
            ),
        },
    }


load_runtime_profitability_gate_rollback_attribution = (
    _load_runtime_profitability_gate_rollback_attribution
)

__all__ = [
    "_load_runtime_profitability_gate_rollback_attribution",
    "load_runtime_profitability_gate_rollback_attribution",
]
capture_module_exports(globals(), __all__)
