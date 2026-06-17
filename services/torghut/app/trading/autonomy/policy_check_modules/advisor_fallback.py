# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Advisor fallback SLO evidence validation."""

from __future__ import annotations

# ruff: noqa: F403,F405,F811
from .common import (
    ADVISOR_FALLBACK_SLO_CONTRACT_SCHEMA_VERSION,
    ADVISOR_FALLBACK_SLO_REQUIRED_REASONS,
    ADVISOR_FALLBACK_SLO_REQUIRED_SUMMARY_FIELDS,
    ADVISOR_FALLBACK_SLO_SCHEMA_VERSION,
    Any,
    Path,
    hashlib,
    json,
)
from .requirements import (
    advisor_fallback_slo_required_artifact_refs as _advisor_fallback_slo_required_artifact_refs,
    as_dict as _as_dict,
    coerce_evidence_bool as _coerce_evidence_bool,
    float_or_none as _float_or_none,
    int_or_none as _int_or_none,
    list_from_any as _list_from_any,
    load_json_if_exists as _load_json_if_exists,
    normalize_artifact_path as _normalize_artifact_path,
    requires_advisor_fallback_slo as _requires_advisor_fallback_slo,
)


def _evaluate_advisor_fallback_slo_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_advisor_fallback_slo(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    advisor_fallback = _as_dict(evidence.get("advisor_fallback_slo"))
    evidence_ref = str(advisor_fallback.get("artifact_ref") or "").strip()
    if not evidence_ref:
        reasons.append("advisor_fallback_slo_artifact_ref_missing")
        details.append({"reason": "advisor_fallback_slo_artifact_ref_missing"})

    required_artifacts = _advisor_fallback_slo_required_artifact_refs(policy_payload)
    artifact_ref = (evidence_ref or required_artifacts[0]).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append("advisor_fallback_slo_artifact_ref_invalid")
        details.append(
            {
                "reason": "advisor_fallback_slo_artifact_ref_invalid",
                "artifact_ref": artifact_ref,
            }
        )
        return reasons, details, refs

    refs.append(str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append("advisor_fallback_slo_artifact_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_artifact_missing",
                "artifact_ref": str(artifact_path),
            }
        )
        return reasons, details, refs

    artifact_hash = str(payload.get("artifact_hash", "")).strip()
    if not artifact_hash:
        reasons.append("advisor_fallback_slo_artifact_hash_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_artifact_hash_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        expected_hash = hashlib.sha256(
            json.dumps(
                {
                    key: value
                    for key, value in payload.items()
                    if key != "artifact_hash"
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        if artifact_hash != expected_hash:
            reasons.append("advisor_fallback_slo_artifact_hash_mismatch")
            details.append(
                {
                    "reason": "advisor_fallback_slo_artifact_hash_mismatch",
                    "artifact_ref": str(artifact_path),
                    "artifact_hash": artifact_hash,
                    "expected_artifact_hash": expected_hash,
                }
            )

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != ADVISOR_FALLBACK_SLO_SCHEMA_VERSION:
        reasons.append("advisor_fallback_slo_schema_version_invalid")
        details.append(
            {
                "reason": "advisor_fallback_slo_schema_version_invalid",
                "artifact_ref": str(artifact_path),
                "schema_version": schema_version,
                "expected_schema_version": ADVISOR_FALLBACK_SLO_SCHEMA_VERSION,
            }
        )

    evaluated_samples = _int_or_none(payload.get("evaluated_samples"))
    if evaluated_samples is None or evaluated_samples <= 0:
        reasons.append("advisor_fallback_slo_evaluated_samples_invalid")
        details.append(
            {
                "reason": "advisor_fallback_slo_evaluated_samples_invalid",
                "artifact_ref": str(artifact_path),
                "evaluated_samples": payload.get("evaluated_samples"),
            }
        )

    contract = _as_dict(payload.get("contract"))
    if not contract:
        reasons.append("advisor_fallback_slo_contract_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_contract_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    else:
        contract_schema = str(contract.get("schema_version", "")).strip()
        if contract_schema != ADVISOR_FALLBACK_SLO_CONTRACT_SCHEMA_VERSION:
            reasons.append("advisor_fallback_slo_contract_schema_version_invalid")
            details.append(
                {
                    "reason": "advisor_fallback_slo_contract_schema_version_invalid",
                    "artifact_ref": str(artifact_path),
                    "schema_version": contract_schema,
                    "expected_schema_version": ADVISOR_FALLBACK_SLO_CONTRACT_SCHEMA_VERSION,
                }
            )

        required_reasons = {
            str(item).strip()
            for item in _list_from_any(contract.get("required_reasons"))
            if str(item).strip()
        }
        if required_reasons != set(ADVISOR_FALLBACK_SLO_REQUIRED_REASONS):
            reasons.append("advisor_fallback_slo_required_reasons_invalid")
            details.append(
                {
                    "reason": "advisor_fallback_slo_required_reasons_invalid",
                    "artifact_ref": str(artifact_path),
                    "required_reasons": sorted(required_reasons),
                    "expected_required_reasons": sorted(
                        ADVISOR_FALLBACK_SLO_REQUIRED_REASONS
                    ),
                }
            )

        required_summary_fields = {
            str(item).strip()
            for item in _list_from_any(contract.get("required_summary_fields"))
            if str(item).strip()
        }
        if required_summary_fields != set(ADVISOR_FALLBACK_SLO_REQUIRED_SUMMARY_FIELDS):
            reasons.append("advisor_fallback_slo_required_summary_fields_invalid")
            details.append(
                {
                    "reason": "advisor_fallback_slo_required_summary_fields_invalid",
                    "artifact_ref": str(artifact_path),
                    "required_summary_fields": sorted(required_summary_fields),
                    "expected_required_summary_fields": sorted(
                        ADVISOR_FALLBACK_SLO_REQUIRED_SUMMARY_FIELDS
                    ),
                }
            )

    reason_counts = _as_dict(payload.get("fallback_reason_counts"))
    missing_reason_counts = [
        reason
        for reason in ADVISOR_FALLBACK_SLO_REQUIRED_REASONS
        if _int_or_none(reason_counts.get(reason)) is None
    ]
    if missing_reason_counts:
        reasons.append("advisor_fallback_slo_counts_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_counts_missing",
                "artifact_ref": str(artifact_path),
                "missing_reasons": sorted(missing_reason_counts),
            }
        )

    summary = _as_dict(payload.get("fallback_reason_rates"))
    timeout_rate = _float_or_none(summary.get("timeout_rate"))
    state_stale_rate = _float_or_none(summary.get("state_stale_rate"))
    advice_stale_rate = _float_or_none(summary.get("advice_stale_rate"))
    safe_fallback_rate = _float_or_none(summary.get("safe_fallback_rate"))
    deterministic_bypass = _coerce_evidence_bool(
        summary.get("deterministic_policy_bypass_detected")
    )
    slo_pass = _coerce_evidence_bool(summary.get("slo_pass"))

    max_timeout_rate = _float_or_none(
        policy_payload.get("promotion_advisor_fallback_max_timeout_rate")
    )
    if max_timeout_rate is None:
        max_timeout_rate = 0.005
    max_state_stale_rate = _float_or_none(
        policy_payload.get("promotion_advisor_fallback_max_state_stale_rate")
    )
    if max_state_stale_rate is None:
        max_state_stale_rate = 0.01
    max_advice_stale_rate = _float_or_none(
        policy_payload.get("promotion_advisor_fallback_max_advice_stale_rate")
    )
    if max_advice_stale_rate is None:
        max_advice_stale_rate = 0.01
    min_safe_fallback_rate = _float_or_none(
        policy_payload.get("promotion_advisor_fallback_min_safe_fallback_rate")
    )
    if min_safe_fallback_rate is None:
        min_safe_fallback_rate = 0.99

    if timeout_rate is None:
        reasons.append("advisor_fallback_slo_timeout_rate_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_timeout_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif timeout_rate > max_timeout_rate:
        reasons.append("advisor_fallback_slo_timeout_rate_exceeds_threshold")
        details.append(
            {
                "reason": "advisor_fallback_slo_timeout_rate_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "timeout_rate": timeout_rate,
                "maximum_timeout_rate": max_timeout_rate,
            }
        )

    if state_stale_rate is None:
        reasons.append("advisor_fallback_slo_state_stale_rate_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_state_stale_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif state_stale_rate > max_state_stale_rate:
        reasons.append("advisor_fallback_slo_state_stale_rate_exceeds_threshold")
        details.append(
            {
                "reason": "advisor_fallback_slo_state_stale_rate_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "state_stale_rate": state_stale_rate,
                "maximum_state_stale_rate": max_state_stale_rate,
            }
        )

    if advice_stale_rate is None:
        reasons.append("advisor_fallback_slo_advice_stale_rate_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_advice_stale_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif advice_stale_rate > max_advice_stale_rate:
        reasons.append("advisor_fallback_slo_advice_stale_rate_exceeds_threshold")
        details.append(
            {
                "reason": "advisor_fallback_slo_advice_stale_rate_exceeds_threshold",
                "artifact_ref": str(artifact_path),
                "advice_stale_rate": advice_stale_rate,
                "maximum_advice_stale_rate": max_advice_stale_rate,
            }
        )

    if safe_fallback_rate is None:
        reasons.append("advisor_fallback_slo_safe_fallback_rate_missing")
        details.append(
            {
                "reason": "advisor_fallback_slo_safe_fallback_rate_missing",
                "artifact_ref": str(artifact_path),
            }
        )
    elif safe_fallback_rate < min_safe_fallback_rate:
        reasons.append("advisor_fallback_slo_safe_fallback_rate_below_threshold")
        details.append(
            {
                "reason": "advisor_fallback_slo_safe_fallback_rate_below_threshold",
                "artifact_ref": str(artifact_path),
                "safe_fallback_rate": safe_fallback_rate,
                "minimum_safe_fallback_rate": min_safe_fallback_rate,
            }
        )

    if deterministic_bypass is True:
        reasons.append("advisor_fallback_slo_deterministic_policy_bypass_detected")
        details.append(
            {
                "reason": "advisor_fallback_slo_deterministic_policy_bypass_detected",
                "artifact_ref": str(artifact_path),
            }
        )

    if slo_pass is False:
        reasons.append("advisor_fallback_slo_not_pass")
        details.append(
            {
                "reason": "advisor_fallback_slo_not_pass",
                "artifact_ref": str(artifact_path),
            }
        )

    overall_status = str(payload.get("overall_status", "")).strip()
    if overall_status != "pass":
        reasons.append("advisor_fallback_slo_overall_status_not_pass")
        details.append(
            {
                "reason": "advisor_fallback_slo_overall_status_not_pass",
                "artifact_ref": str(artifact_path),
                "status": overall_status,
            }
        )

    return reasons, details, refs


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
evaluate_advisor_fallback_slo_evidence = _evaluate_advisor_fallback_slo_evidence
