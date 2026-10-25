"""Artifact validators for the Torghut quant readiness verifier."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast

_MODEL_RISK_EVIDENCE_SCHEMA_VERSION = "torghut.model-risk-evidence.v1"


def _parse_iso8601_timestamp(raw: str, *, field_name: str) -> datetime:
    normalized = raw.strip()
    if not normalized:
        raise ValueError(f"{field_name}_missing")
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{field_name}_invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field_name}_missing_timezone")
    return parsed.astimezone(timezone.utc)


def _load_json_object(path: Path, *, invalid_reason: str) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(invalid_reason)
    return cast(dict[str, Any], payload)


def _require_keys(
    payload: Mapping[str, Any],
    required_keys: tuple[str, ...],
    *,
    missing_reason_prefix: str,
) -> None:
    missing = [key for key in required_keys if key not in payload]
    if missing:
        raise ValueError(f"{missing_reason_prefix}:{','.join(missing)}")


def _require_mapping(
    payload: Mapping[str, Any],
    key: str,
    *,
    invalid_reason: str,
) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise ValueError(invalid_reason)
    return cast(dict[str, Any], value)


def _require_text(
    payload: Mapping[str, Any],
    key: str,
    *,
    missing_reason: str,
) -> str:
    value = str(payload.get(key, "")).strip()
    if not value:
        raise ValueError(missing_reason)
    return value


def _require_true(
    payload: Mapping[str, Any],
    key: str,
    *,
    failed_reason: str,
) -> None:
    if not bool(payload.get(key, False)):
        raise ValueError(failed_reason)


def _load_gate_trace(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("gate_report_payload_invalid")
    payload_map = cast(dict[str, Any], payload)
    provenance = payload_map.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("gate_report_missing_provenance")
    provenance_map = cast(dict[str, Any], provenance)
    gate_trace = str(provenance_map.get("gate_report_trace_id", "")).strip()
    recommendation_trace = str(
        provenance_map.get("recommendation_trace_id", "")
    ).strip()
    if not gate_trace:
        raise ValueError("gate_report_trace_id_missing")
    if not recommendation_trace:
        raise ValueError("recommendation_trace_id_missing")
    return {
        "gate_report_trace_id": gate_trace,
        "recommendation_trace_id": recommendation_trace,
    }


def _load_profitability_proof(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("profitability_proof_invalid")
    payload_map = cast(dict[str, Any], payload)
    required_root_keys = (
        "hypothesis",
        "window_days",
        "statistics",
        "risk_controls",
    )
    missing = [key for key in required_root_keys if key not in payload_map]
    if missing:
        raise ValueError(f"profitability_proof_missing_keys:{','.join(missing)}")

    raw_statistics = payload_map.get("statistics")
    if not isinstance(raw_statistics, dict):
        raise ValueError("profitability_proof_statistics_invalid")
    statistics = cast(dict[str, Any], raw_statistics)

    effect_size = statistics.get("effect_size")
    if not isinstance(effect_size, (int, float)):
        raise ValueError("profitability_proof_effect_size_invalid")

    sample_size = payload_map.get("sample_size")
    if not isinstance(sample_size, int) or sample_size < 1:
        raise ValueError("profitability_proof_sample_size_invalid")

    p_value = statistics.get("p_value")
    if not isinstance(p_value, (int, float)) or not 0 <= float(p_value) <= 1:
        raise ValueError("profitability_proof_p_value_invalid")

    raw_risk_controls = payload_map.get("risk_controls")
    if not isinstance(raw_risk_controls, dict):
        raise ValueError("profitability_proof_risk_controls_invalid")
    risk_controls = cast(dict[str, Any], raw_risk_controls)

    drawdown_delta = risk_controls.get("max_drawdown_delta")
    if not isinstance(drawdown_delta, (int, float)):
        raise ValueError("profitability_proof_risk_controls_drawdown_invalid")

    window_days = payload_map.get("window_days")
    if not isinstance(window_days, (int, float)) or window_days <= 0:
        raise ValueError("profitability_proof_window_days_invalid")

    hypothesis = str(payload_map.get("hypothesis", "")).strip()
    if not hypothesis:
        raise ValueError("profitability_proof_hypothesis_missing")

    return {
        "hypothesis": hypothesis,
        "sample_size": sample_size,
        "window_days": float(window_days),
        "effect_size": float(effect_size),
        "p_value": float(p_value),
        "drawdown_delta": float(drawdown_delta),
        "risk_controls": risk_controls,
    }


def _load_incident_evidence(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("incident_payload_invalid")
    payload_map = cast(dict[str, Any], payload)
    required_keys = (
        "triggered_at",
        "reasons",
        "rollback_hooks",
        "safety_snapshot",
        "provenance",
        "verification",
    )
    missing = [key for key in required_keys if key not in payload_map]
    if missing:
        raise ValueError(f"incident_payload_missing_keys:{','.join(missing)}")
    rollback_hooks = payload_map.get("rollback_hooks")
    if not isinstance(rollback_hooks, dict):
        raise ValueError("incident_payload_rollback_hooks_invalid")
    reasons = payload_map.get("reasons")
    if not isinstance(reasons, list) or not reasons:
        raise ValueError("incident_payload_reasons_invalid")
    if not bool(rollback_hooks.get("order_submission_blocked", False)):
        raise ValueError("incident_payload_order_block_missing")
    verification = payload_map.get("verification")
    if not isinstance(verification, dict):
        raise ValueError("incident_payload_verification_invalid")
    if not bool(verification.get("incident_evidence_complete", False)):
        raise ValueError("incident_payload_verification_failed")
    return payload_map


def _load_control_plane_contract(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("control_plane_contract_invalid")
    payload_map = cast(dict[str, Any], payload)
    required_keys = (
        "contract_version",
        "signal_continuity_state",
        "signal_continuity_alert_active",
        "signal_continuity_promotion_block_total",
        "last_autonomy_recommendation_trace_id",
        "domain_telemetry_event_total",
        "domain_telemetry_dropped_total",
        "alpha_readiness_hypotheses_total",
        "alpha_readiness_shadow_total",
        "alpha_readiness_blocked_total",
        "alpha_readiness_dependency_quorum_decision",
    )
    missing = [key for key in required_keys if key not in payload_map]
    if missing:
        raise ValueError(f"control_plane_contract_missing_keys:{','.join(missing)}")
    if payload_map.get("contract_version") != "torghut.quant-producer.v1":
        raise ValueError("control_plane_contract_version_invalid")
    telemetry_events = payload_map.get("domain_telemetry_event_total")
    if not isinstance(telemetry_events, dict):
        raise ValueError("control_plane_contract_domain_telemetry_events_invalid")
    telemetry_drops = payload_map.get("domain_telemetry_dropped_total")
    if not isinstance(telemetry_drops, dict):
        raise ValueError("control_plane_contract_domain_telemetry_dropped_invalid")
    dependency_quorum_decision = str(
        payload_map.get("alpha_readiness_dependency_quorum_decision", "")
    ).strip()
    if dependency_quorum_decision not in {"allow", "delay", "block", "unknown"}:
        raise ValueError(
            "control_plane_contract_alpha_readiness_dependency_quorum_invalid"
        )
    return payload_map


def _validate_model_risk_generated_at(
    payload: Mapping[str, Any],
    *,
    now: datetime,
    max_age_hours: int,
) -> tuple[datetime, float]:
    generated_at_raw = payload.get("generated_at")
    if not isinstance(generated_at_raw, str):
        raise ValueError("model_risk_evidence_package_generated_at_invalid")
    generated_at = _parse_iso8601_timestamp(
        generated_at_raw,
        field_name="model_risk_evidence_package_generated_at",
    )
    age_hours = (now - generated_at).total_seconds() / 3600.0
    if age_hours < 0:
        raise ValueError("model_risk_evidence_package_generated_at_future")
    if age_hours > max(1, int(max_age_hours)):
        raise ValueError("model_risk_evidence_package_stale")
    return generated_at, age_hours


def _model_risk_promotion_summary(payload: Mapping[str, Any]) -> dict[str, str]:
    promotion = _require_mapping(
        payload,
        "promotion",
        invalid_reason="model_risk_evidence_package_promotion_invalid",
    )
    return {
        "promotion_gate_report_trace_id": _require_text(
            promotion,
            "gate_report_trace_id",
            missing_reason="model_risk_evidence_package_gate_trace_missing",
        ),
        "promotion_recommendation_trace_id": _require_text(
            promotion,
            "recommendation_trace_id",
            missing_reason="model_risk_evidence_package_recommendation_trace_missing",
        ),
    }


def _model_risk_rollback_summary(payload: Mapping[str, Any]) -> dict[str, str]:
    rollback = _require_mapping(
        payload,
        "rollback",
        invalid_reason="model_risk_evidence_package_rollback_invalid",
    )
    _require_true(
        rollback,
        "incident_evidence_complete",
        failed_reason="model_risk_evidence_package_rollback_incomplete",
    )
    return {
        "rollback_incident_evidence_path": _require_text(
            rollback,
            "incident_evidence_path",
            missing_reason="model_risk_evidence_package_rollback_incident_path_missing",
        )
    }


def _model_risk_drift_summary(payload: Mapping[str, Any]) -> dict[str, str]:
    drift = _require_mapping(
        payload,
        "drift",
        invalid_reason="model_risk_evidence_package_drift_invalid",
    )
    _require_true(
        drift,
        "evidence_continuity_passed",
        failed_reason="model_risk_evidence_package_drift_not_passed",
    )
    return {
        "drift_evidence_continuity_report_path": _require_text(
            drift,
            "evidence_continuity_report_path",
            missing_reason="model_risk_evidence_package_drift_report_missing",
        )
    }


def _model_risk_runbook_summary(payload: Mapping[str, Any]) -> dict[str, str]:
    runbook = _require_mapping(
        payload,
        "runbook_drill",
        invalid_reason="model_risk_evidence_package_runbook_invalid",
    )
    rehearsal_at_raw = _require_text(
        runbook,
        "rehearsal_at",
        missing_reason="model_risk_evidence_package_runbook_rehearsal_missing",
    )
    _parse_iso8601_timestamp(
        rehearsal_at_raw,
        field_name="model_risk_evidence_package_rehearsal_at",
    )
    _require_true(
        runbook,
        "emergency_stop_rehearsed",
        failed_reason="model_risk_evidence_package_runbook_rehearsal_not_passed",
    )
    return {"runbook_rehearsal_at": rehearsal_at_raw}


def _model_risk_legacy_summary(payload: Mapping[str, Any]) -> dict[str, str]:
    legacy_disposition = _require_mapping(
        payload,
        "legacy_gap_disposition",
        invalid_reason="model_risk_evidence_package_legacy_disposition_invalid",
    )
    _require_true(
        legacy_disposition,
        "signed_disposition_complete",
        failed_reason="model_risk_evidence_package_legacy_disposition_incomplete",
    )
    return {
        "legacy_mapping_path": _require_text(
            legacy_disposition,
            "mapping_path",
            missing_reason="model_risk_evidence_package_legacy_mapping_missing",
        )
    }


def _load_model_risk_evidence_package(
    path: Path,
    *,
    now: datetime,
    max_age_hours: int,
) -> dict[str, Any]:
    payload_map = _load_json_object(
        path,
        invalid_reason="model_risk_evidence_package_invalid",
    )
    required_keys = (
        "schema_version",
        "generated_at",
        "promotion",
        "rollback",
        "drift",
        "runbook_drill",
        "legacy_gap_disposition",
    )
    _require_keys(
        payload_map,
        required_keys,
        missing_reason_prefix="model_risk_evidence_package_missing_keys",
    )
    schema_version = str(payload_map.get("schema_version", "")).strip()
    if schema_version != _MODEL_RISK_EVIDENCE_SCHEMA_VERSION:
        raise ValueError("model_risk_evidence_package_schema_version_invalid")
    generated_at, age_hours = _validate_model_risk_generated_at(
        payload_map,
        now=now,
        max_age_hours=max_age_hours,
    )

    return {
        "schema_version": schema_version,
        "generated_at": generated_at.isoformat(),
        "age_hours": round(age_hours, 4),
        **_model_risk_promotion_summary(payload_map),
        **_model_risk_rollback_summary(payload_map),
        **_model_risk_drift_summary(payload_map),
        **_model_risk_runbook_summary(payload_map),
        **_model_risk_legacy_summary(payload_map),
    }
