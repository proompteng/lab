# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Foundation-router parity evidence validation."""

from __future__ import annotations

# ruff: noqa: F403,F405,F811
from .common import (
    Any,
    FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION,
    FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS,
    FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS,
    FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION,
    Path,
)
from .requirements import (
    as_dict as _as_dict,
    float_or_none as _float_or_none,
    foundation_router_required_artifact_refs as _foundation_router_required_artifact_refs,
    list_from_any as _list_from_any,
    load_json_if_exists as _load_json_if_exists,
    normalize_artifact_path as _normalize_artifact_path,
    requires_foundation_router_parity as _requires_foundation_router_parity,
)


def _evaluate_foundation_router_parity_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_foundation_router_parity(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    foundation = _as_dict(evidence.get("foundation_router_parity"))
    evidence_ref = str(foundation.get("artifact_ref") or "").strip()
    if not evidence_ref:
        reasons.append("foundation_router_parity_artifact_ref_missing")
        details.append({"reason": "foundation_router_parity_artifact_ref_missing"})

    required_artifacts = _foundation_router_required_artifact_refs(policy_payload)
    artifact_ref = (evidence_ref or required_artifacts[0]).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append("foundation_router_parity_artifact_ref_invalid")
        details.append(
            {
                "reason": "foundation_router_parity_artifact_ref_invalid",
                "artifact_ref": artifact_ref,
            }
        )
        return reasons, details, refs

    refs.append(str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append("foundation_router_parity_artifact_missing")
        details.append(
            {
                "reason": "foundation_router_parity_artifact_missing",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION:
        reasons.append("foundation_router_parity_schema_version_invalid")
        details.append(
            {
                "reason": "foundation_router_parity_schema_version_invalid",
                "artifact_ref": str(artifact_path),
                "actual_schema_version": schema_version,
                "expected_schema_version": FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION,
            }
        )

    contract = _as_dict(payload.get("contract"))
    if not contract:
        reasons.append("foundation_router_parity_contract_missing")
        details.append(
            {
                "reason": "foundation_router_parity_contract_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        contract_schema = str(contract.get("schema_version", "")).strip()
        if contract_schema != FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION:
            reasons.append("foundation_router_parity_contract_schema_version_invalid")
            details.append(
                {
                    "reason": "foundation_router_parity_contract_schema_version_invalid",
                    "artifact_ref": str(artifact_path),
                    "actual_schema_version": contract_schema,
                    "expected_schema_version": FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION,
                }
            )

        required_adapters = {
            str(item).strip()
            for item in _list_from_any(contract.get("required_adapters"))
            if str(item).strip()
        }
        if required_adapters != set(FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS):
            reasons.append(
                "foundation_router_parity_contract_required_adapters_invalid"
            )
            details.append(
                {
                    "reason": "foundation_router_parity_contract_required_adapters_invalid",
                    "artifact_ref": str(artifact_path),
                    "actual_required_adapters": sorted(required_adapters),
                    "expected_required_adapters": sorted(
                        FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS
                    ),
                }
            )

        required_slice_metrics = {
            str(item).strip()
            for item in _list_from_any(contract.get("required_slice_metrics"))
            if str(item).strip()
        }
        if required_slice_metrics != set(
            FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS
        ):
            reasons.append(
                "foundation_router_parity_contract_required_slice_metrics_invalid"
            )
            details.append(
                {
                    "reason": "foundation_router_parity_contract_required_slice_metrics_invalid",
                    "artifact_ref": str(artifact_path),
                    "actual_required_slice_metrics": sorted(required_slice_metrics),
                    "expected_required_slice_metrics": sorted(
                        FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS
                    ),
                }
            )

    adapters = {
        str(item).strip()
        for item in _list_from_any(payload.get("adapters"))
        if str(item).strip()
    }
    if adapters != set(FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS):
        reasons.append("foundation_router_parity_adapters_invalid")
        details.append(
            {
                "reason": "foundation_router_parity_adapters_invalid",
                "artifact_ref": str(artifact_path),
                "actual_adapters": sorted(adapters),
                "expected_adapters": sorted(FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS),
            }
        )

    slice_metrics = _as_dict(payload.get("slice_metrics"))
    missing_slice_metrics = [
        key
        for key in FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS
        if not isinstance(slice_metrics.get(key), dict)
    ]
    if missing_slice_metrics:
        reasons.append("foundation_router_parity_slice_metrics_missing")
        details.append(
            {
                "reason": "foundation_router_parity_slice_metrics_missing",
                "artifact_ref": str(artifact_path),
                "missing_slice_metrics": sorted(missing_slice_metrics),
            }
        )

    overall_status = str(payload.get("overall_status", "")).strip()
    if overall_status != "pass":
        reasons.append("foundation_router_parity_overall_status_not_pass")
        details.append(
            {
                "reason": "foundation_router_parity_overall_status_not_pass",
                "artifact_ref": str(artifact_path),
                "status": overall_status,
            }
        )

    max_fallback_rate = _float_or_none(
        _as_dict(payload.get("fallback_metrics")).get("fallback_rate")
    )
    fallback_threshold = _float_or_none(
        policy_payload.get(
            "promotion_router_parity_max_fallback_rate",
            policy_payload.get("gate3_max_forecast_fallback_rate", 0.05),
        )
    )
    if max_fallback_rate is None:
        reasons.append("foundation_router_parity_fallback_rate_missing")
        details.append(
            {
                "reason": "foundation_router_parity_fallback_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif fallback_threshold is not None and max_fallback_rate > fallback_threshold:
        reasons.append("foundation_router_parity_fallback_rate_exceeds_threshold")
        details.append(
            {
                "reason": "foundation_router_parity_fallback_rate_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_fallback_rate": max_fallback_rate,
                "maximum_fallback_rate": fallback_threshold,
            }
        )

    latency_p95 = _float_or_none(_as_dict(payload.get("latency_metrics")).get("p95_ms"))
    max_latency_p95 = _float_or_none(
        policy_payload.get(
            "promotion_router_parity_max_latency_ms_p95",
            policy_payload.get("gate3_max_forecast_latency_ms_p95", 200),
        )
    )
    if latency_p95 is None:
        reasons.append("foundation_router_parity_latency_p95_missing")
        details.append(
            {
                "reason": "foundation_router_parity_latency_p95_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif max_latency_p95 is not None and latency_p95 > max_latency_p95:
        reasons.append("foundation_router_parity_latency_p95_exceeds_threshold")
        details.append(
            {
                "reason": "foundation_router_parity_latency_p95_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_latency_p95_ms": latency_p95,
                "maximum_latency_p95_ms": max_latency_p95,
            }
        )

    calibration_min = _float_or_none(
        _as_dict(payload.get("calibration_metrics")).get("minimum")
    )
    min_calibration = _float_or_none(
        policy_payload.get(
            "promotion_router_parity_min_calibration_score",
            policy_payload.get("gate3_min_forecast_calibration_score", 0.85),
        )
    )
    if calibration_min is None:
        reasons.append("foundation_router_parity_calibration_minimum_missing")
        details.append(
            {
                "reason": "foundation_router_parity_calibration_minimum_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif min_calibration is not None and calibration_min < min_calibration:
        reasons.append("foundation_router_parity_calibration_minimum_below_threshold")
        details.append(
            {
                "reason": "foundation_router_parity_calibration_minimum_below_threshold",
                "artifact_ref": str(artifact_path),
                "actual_minimum_calibration": calibration_min,
                "minimum_required": min_calibration,
            }
        )

    drift_max = _float_or_none(_as_dict(payload.get("drift_metrics")).get("max"))
    max_drift = _float_or_none(
        policy_payload.get(
            "promotion_router_parity_max_drift",
            policy_payload.get("gate6_max_calibration_error", 0.45),
        )
    )
    if drift_max is None:
        reasons.append("foundation_router_parity_drift_max_missing")
        details.append(
            {
                "reason": "foundation_router_parity_drift_max_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif max_drift is not None and drift_max > max_drift:
        reasons.append("foundation_router_parity_drift_exceeds_threshold")
        details.append(
            {
                "reason": "foundation_router_parity_drift_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "actual_max_drift": drift_max,
                "maximum_drift": max_drift,
            }
        )

    return reasons, details, refs


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
evaluate_foundation_router_parity_evidence = _evaluate_foundation_router_parity_evidence
