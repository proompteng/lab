from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, Mapping, Sequence, cast


CONSUMER_EVIDENCE_SCHEMA_VERSION = "torghut.consumer-evidence-receipt.v1"


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    return (
        cast(Sequence[object], value)
        if isinstance(value, Sequence) and not isinstance(value, str)
        else ()
    )


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _unique(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _first_text(value: object) -> str | None:
    for item in _sequence(value):
        text = _text(item)
        if text:
            return text
    return None


def _dimension(proof_floor: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    for raw_dimension in _sequence(proof_floor.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) == name:
            return dimension
    return {}


def _forecast_registry_state(forecast_service_status: Mapping[str, Any]) -> str:
    status = _text(forecast_service_status.get("status"), "unknown").lower()
    authority = _text(forecast_service_status.get("authority"), "unknown").lower()
    eligible_models = _sequence(
        forecast_service_status.get("promotion_authority_eligible_models")
    )
    if status in {"healthy", "ok", "ready"} and authority in {"empirical", "ready"}:
        return "ready"
    if eligible_models:
        return "shadow_ready"
    if status in {"disabled", "not_required"}:
        return "disabled"
    return status or "unknown"


def _paper_readiness_state(proof_floor: Mapping[str, Any]) -> str:
    route_state = _text(proof_floor.get("route_state"), "unknown")
    capital_state = _text(proof_floor.get("capital_state"), "unknown")
    max_notional = _decimal(proof_floor.get("max_notional"))
    if (
        route_state == "paper_candidate"
        and capital_state == "paper_allowed"
        and (max_notional is None or max_notional > 0)
    ):
        return "ready"
    if route_state == "observe_only":
        return "observe_only"
    return "blocked"


def _live_readiness_state(proof_floor: Mapping[str, Any]) -> str:
    route_state = _text(proof_floor.get("route_state"), "unknown")
    capital_state = _text(proof_floor.get("capital_state"), "unknown")
    max_notional = _decimal(proof_floor.get("max_notional"))
    if (
        route_state in {"live_micro_candidate", "live_scale_candidate"}
        and capital_state == "live_allowed"
        and (max_notional is None or max_notional > 0)
    ):
        return "ready"
    if route_state == "observe_only":
        return "observe_only"
    return "blocked"


def _reason_codes(
    *,
    forecast_service_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> list[str]:
    reasons: list[str] = []
    empirical_status = _text(empirical_jobs_status.get("status"), "unknown").lower()
    if empirical_jobs_status.get("ready") is not True or empirical_status not in {
        "healthy",
        "ok",
        "ready",
    }:
        reasons.append(f"empirical_jobs_{empirical_status or 'unknown'}")

    forecast_state = _forecast_registry_state(forecast_service_status)
    if forecast_state not in {"ready", "shadow_ready", "disabled", "not_required"}:
        reasons.append(f"forecast_registry_{forecast_state}")

    if live_submission_gate.get("allowed") is not True:
        reasons.append(
            _text(live_submission_gate.get("reason"), "live_submission_gate_closed")
        )

    for reason in _sequence(proof_floor.get("blocking_reasons")):
        reasons.append(_text(reason))

    tca_dimension = _dimension(proof_floor, "execution_tca")
    tca_state = _text(tca_dimension.get("state"))
    tca_reason = _text(tca_dimension.get("reason"))
    if tca_state and tca_state != "pass":
        reasons.append(tca_reason or f"execution_tca_{tca_state}")

    route_state = _text(proof_floor.get("route_state"))
    if route_state == "repair_only" and not reasons:
        reasons.append("proof_floor_repair_only")

    return _unique(reasons)


def _receipt_id(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"torghut-consumer-evidence:{sha256(encoded.encode()).hexdigest()[:16]}"


def build_torghut_consumer_evidence_receipt(
    *,
    forecast_service_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    now: datetime | None = None,
    freshness_seconds: int = 60,
) -> dict[str, object]:
    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    fresh_until = generated_at + timedelta(seconds=max(1, freshness_seconds))
    empirical_status = _text(empirical_jobs_status.get("status"), "unknown").lower()
    tca_dimension = _dimension(proof_floor, "execution_tca")
    reason_codes = _reason_codes(
        forecast_service_status=forecast_service_status,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
    )
    payload_for_id = {
        "schema_version": CONSUMER_EVIDENCE_SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "candidate_id": _first_text(empirical_jobs_status.get("candidate_ids")),
        "dataset_snapshot_ref": _first_text(
            empirical_jobs_status.get("dataset_snapshot_refs")
        ),
        "empirical_jobs_state": empirical_status,
        "forecast_registry_state": _forecast_registry_state(forecast_service_status),
        "tca_state": _text(tca_dimension.get("state"), "unknown"),
        "paper_readiness_state": _paper_readiness_state(proof_floor),
        "live_readiness_state": _live_readiness_state(proof_floor),
        "max_notional": _text(proof_floor.get("max_notional"), "0"),
        "reason_codes": reason_codes,
    }

    return {
        **payload_for_id,
        "receipt_id": _receipt_id(payload_for_id),
        "fresh_until": fresh_until.isoformat(),
        "database_witness_state": "jangar_owned",
        "proof_floor_ref": _text(proof_floor.get("schema_version")),
        "proof_floor_generated_at": proof_floor.get("generated_at"),
    }


__all__ = [
    "CONSUMER_EVIDENCE_SCHEMA_VERSION",
    "build_torghut_consumer_evidence_receipt",
]
