# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""DeepLOB and BDLOB contract evidence validation."""

from __future__ import annotations

# ruff: noqa: F403,F405,F811
from .common import *
from .requirements import *

from .benchmark_parity import _policy_float


def _evaluate_deeplob_bdlob_contract_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_deeplob_bdlob_contract(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    artifact_path = _resolve_deeplob_bdlob_artifact_path(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        artifact_root=artifact_root,
        reasons=reasons,
        details=details,
    )
    if artifact_path is None:
        return reasons, details, refs

    refs.append(str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_artifact_missing",
            artifact_ref=str(artifact_path),
        )
        return reasons, details, refs

    _validate_deeplob_bdlob_artifact_hash(payload, artifact_path, reasons, details)
    _validate_deeplob_bdlob_identity(payload, artifact_path, reasons, details)
    _validate_deeplob_bdlob_contract(payload, artifact_path, reasons, details)
    _validate_deeplob_bdlob_artifact_sets(payload, artifact_path, reasons, details)
    _validate_deeplob_bdlob_status(payload, artifact_path, reasons, details)
    _validate_deeplob_bdlob_metric_thresholds(
        payload,
        artifact_path,
        _deeplob_bdlob_thresholds(policy_payload),
        reasons,
        details,
    )
    _validate_deeplob_bdlob_boolean_gates(payload, artifact_path, reasons, details)

    return reasons, details, refs


def _resolve_deeplob_bdlob_artifact_path(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> Path | None:
    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    deeplob_bdlob = _as_dict(evidence.get("deeplob_bdlob_contract"))
    evidence_ref = str(deeplob_bdlob.get("artifact_ref") or "").strip()
    if not evidence_ref:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_artifact_ref_missing",
        )

    required_artifacts = _deeplob_bdlob_required_artifact_refs(policy_payload)
    artifact_ref = (evidence_ref or required_artifacts[0]).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is not None:
        return artifact_path

    _append_policy_issue(
        reasons,
        details,
        "deeplob_bdlob_contract_artifact_ref_invalid",
        artifact_ref=artifact_ref,
    )
    return None


def _validate_deeplob_bdlob_artifact_hash(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    artifact_hash = str(payload.get("artifact_hash", "")).strip()
    if not artifact_hash:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_artifact_hash_missing",
            artifact_ref=str(artifact_path),
        )
        return

    expected_hash = hashlib.sha256(
        json.dumps(
            {key: value for key, value in payload.items() if key != "artifact_hash"},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    if artifact_hash != expected_hash:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_artifact_hash_mismatch",
            artifact_ref=str(artifact_path),
            artifact_hash=artifact_hash,
            expected_artifact_hash=expected_hash,
        )


def _validate_deeplob_bdlob_identity(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    candidate_id = str(payload.get("candidate_id", "")).strip()
    if not candidate_id:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_candidate_id_missing",
            artifact_ref=str(artifact_path),
        )

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != DEEPLOB_BDLOB_SCHEMA_VERSION:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_schema_version_invalid",
            artifact_ref=str(artifact_path),
            schema_version=schema_version,
            expected_schema_version=DEEPLOB_BDLOB_SCHEMA_VERSION,
        )


def _validate_deeplob_bdlob_contract(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    contract = _as_dict(payload.get("contract"))
    if not contract:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_metadata_missing",
            artifact_ref=str(artifact_path),
        )
        return

    _validate_deeplob_bdlob_contract_schema(contract, artifact_path, reasons, details)
    _validate_deeplob_bdlob_contract_sets(contract, artifact_path, reasons, details)


def _validate_deeplob_bdlob_contract_schema(
    contract: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    contract_schema = str(contract.get("schema_version", "")).strip()
    if contract_schema != DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_schema_metadata_version_invalid",
            artifact_ref=str(artifact_path),
            schema_version=contract_schema,
            expected_schema_version=DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION,
        )

    hash_algorithm = str(contract.get("hash_algorithm", "")).strip().lower()
    if hash_algorithm != "sha256":
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_hash_algorithm_invalid",
            artifact_ref=str(artifact_path),
            hash_algorithm=hash_algorithm,
        )


def _validate_deeplob_bdlob_contract_sets(
    contract: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    required_supporting_artifacts = {
        str(item).strip()
        for item in _list_from_any(contract.get("required_supporting_artifacts"))
        if str(item).strip()
    }
    if required_supporting_artifacts != set(
        DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS
    ):
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_required_supporting_artifacts_invalid",
            artifact_ref=str(artifact_path),
            required_supporting_artifacts=sorted(required_supporting_artifacts),
            expected_supporting_artifacts=sorted(
                DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS
            ),
        )

    required_summary_fields = {
        str(item).strip()
        for item in _list_from_any(contract.get("required_summary_fields"))
        if str(item).strip()
    }
    if required_summary_fields != set(DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS):
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_required_summary_fields_invalid",
            artifact_ref=str(artifact_path),
            required_summary_fields=sorted(required_summary_fields),
            expected_summary_fields=sorted(DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS),
        )


def _validate_deeplob_bdlob_artifact_sets(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    supporting_artifacts = {
        str(item).strip()
        for item in _list_from_any(payload.get("supporting_artifacts"))
        if str(item).strip()
    }
    missing_supporting_artifacts = sorted(
        set(DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS) - supporting_artifacts
    )
    if missing_supporting_artifacts:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_supporting_artifacts_missing",
            artifact_ref=str(artifact_path),
            missing_supporting_artifacts=missing_supporting_artifacts,
        )

    missing_summary_fields = sorted(
        [
            field
            for field in DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS
            if not isinstance(payload.get(field), dict)
        ]
    )
    if missing_summary_fields:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_summary_fields_missing",
            artifact_ref=str(artifact_path),
            missing_summary_fields=missing_summary_fields,
        )


def _validate_deeplob_bdlob_status(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    overall_status = str(payload.get("overall_status", "")).strip()
    if overall_status != "pass":
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_overall_status_not_pass",
            artifact_ref=str(artifact_path),
            status=overall_status,
        )


def _deeplob_bdlob_thresholds(
    policy_payload: dict[str, Any],
) -> _DeeplobBdlobThresholds:
    return _DeeplobBdlobThresholds(
        min_feature_quality_pass_rate=_policy_float(
            policy_payload,
            "promotion_deeplob_bdlob_min_feature_quality_pass_rate",
            0.99,
        ),
        min_prediction_quality_score=_policy_float(
            policy_payload,
            "promotion_deeplob_bdlob_min_prediction_quality_score",
            0.85,
        ),
        min_cost_adjusted_edge_bps=_policy_float(
            policy_payload,
            "promotion_deeplob_bdlob_min_cost_adjusted_edge_bps",
            0.0,
        ),
        max_slippage_divergence_bps=_policy_float(
            policy_payload,
            "promotion_deeplob_bdlob_max_slippage_divergence_bps",
            1.0,
        ),
        min_fallback_reliability=_policy_float(
            policy_payload,
            "promotion_deeplob_bdlob_min_fallback_reliability",
            0.99,
        ),
    )


def _validate_deeplob_bdlob_metric_thresholds(
    payload: dict[str, Any],
    artifact_path: Path,
    thresholds: _DeeplobBdlobThresholds,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    _append_artifact_minimum_metric_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(payload.get("feature_quality_summary")).get("pass_rate")
        ),
        minimum=thresholds.min_feature_quality_pass_rate,
        missing_reason="deeplob_bdlob_contract_feature_quality_pass_rate_missing",
        threshold_reason="deeplob_bdlob_contract_feature_quality_pass_rate_below_threshold",
        artifact_ref=str(artifact_path),
        actual_field="feature_quality_pass_rate",
        minimum_field="minimum_feature_quality_pass_rate",
    )
    _append_artifact_minimum_metric_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(payload.get("prediction_quality_summary")).get("score")
        ),
        minimum=thresholds.min_prediction_quality_score,
        missing_reason="deeplob_bdlob_contract_prediction_quality_score_missing",
        threshold_reason="deeplob_bdlob_contract_prediction_quality_score_below_threshold",
        artifact_ref=str(artifact_path),
        actual_field="prediction_quality_score",
        minimum_field="minimum_prediction_quality_score",
    )
    _append_artifact_minimum_metric_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(payload.get("cost_adjusted_outcomes")).get("edge_bps")
        ),
        minimum=thresholds.min_cost_adjusted_edge_bps,
        missing_reason="deeplob_bdlob_contract_cost_adjusted_edge_missing",
        threshold_reason="deeplob_bdlob_contract_cost_adjusted_edge_below_threshold",
        artifact_ref=str(artifact_path),
        actual_field="cost_adjusted_edge_bps",
        minimum_field="minimum_cost_adjusted_edge_bps",
    )
    _append_artifact_maximum_metric_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(payload.get("execution_impact_summary")).get(
                "slippage_divergence_bps"
            )
        ),
        maximum=thresholds.max_slippage_divergence_bps,
        missing_reason="deeplob_bdlob_contract_slippage_divergence_missing",
        threshold_reason="deeplob_bdlob_contract_slippage_divergence_exceeds_threshold",
        artifact_ref=str(artifact_path),
        actual_field="slippage_divergence_bps",
        maximum_field="maximum_slippage_divergence_bps",
    )
    _append_artifact_minimum_metric_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(payload.get("fallback_summary")).get("reliability")
        ),
        minimum=thresholds.min_fallback_reliability,
        missing_reason="deeplob_bdlob_contract_fallback_reliability_missing",
        threshold_reason="deeplob_bdlob_contract_fallback_reliability_below_threshold",
        artifact_ref=str(artifact_path),
        actual_field="fallback_reliability",
        minimum_field="minimum_fallback_reliability",
    )


def _append_artifact_minimum_metric_issue(
    reasons: list[str],
    details: list[dict[str, object]],
    *,
    value: float | None,
    minimum: float,
    missing_reason: str,
    threshold_reason: str,
    artifact_ref: str,
    actual_field: str,
    minimum_field: str,
) -> None:
    if value is None:
        _append_policy_issue(
            reasons,
            details,
            missing_reason,
            artifact_ref=artifact_ref,
        )
    elif value < minimum:
        _append_policy_issue(
            reasons,
            details,
            threshold_reason,
            artifact_ref=artifact_ref,
            **{actual_field: value, minimum_field: minimum},
        )


def _append_artifact_maximum_metric_issue(
    reasons: list[str],
    details: list[dict[str, object]],
    *,
    value: float | None,
    maximum: float,
    missing_reason: str,
    threshold_reason: str,
    artifact_ref: str,
    actual_field: str,
    maximum_field: str,
) -> None:
    if value is None:
        _append_policy_issue(
            reasons,
            details,
            missing_reason,
            artifact_ref=artifact_ref,
        )
    elif value > maximum:
        _append_policy_issue(
            reasons,
            details,
            threshold_reason,
            artifact_ref=artifact_ref,
            **{actual_field: value, maximum_field: maximum},
        )


def _validate_deeplob_bdlob_boolean_gates(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    deterministic_gate_compatible = _coerce_evidence_bool(
        _as_dict(payload.get("execution_impact_summary")).get(
            "deterministic_gate_compatible"
        )
    )
    if deterministic_gate_compatible is not True:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_deterministic_gate_compatibility_failed",
            artifact_ref=str(artifact_path),
        )

    fallback_slo_pass = _coerce_evidence_bool(
        _as_dict(payload.get("fallback_summary")).get("slo_pass")
    )
    if fallback_slo_pass is False:
        _append_policy_issue(
            reasons,
            details,
            "deeplob_bdlob_contract_fallback_slo_not_pass",
            artifact_ref=str(artifact_path),
        )


__all__ = [name for name in globals() if not name.startswith("__")]
