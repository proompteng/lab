# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Simulation, shadow-live, fold, stress, and rationale evidence validation."""

from __future__ import annotations

from .common import (
    Any,
    Path,
    Sequence,
    cast,
    dataclass,
    datetime,
    os,
    timezone,
)
from .requirements import (
    as_dict as _as_dict,
    float_or_none as _float_or_none,
    int_or_default as _int_or_default,
    list_from_any as _list_from_any,
    list_of_strings as _list_of_strings,
    load_json_if_exists as _load_json_if_exists,
    normalize_artifact_path as _normalize_artifact_path,
    parse_datetime as _parse_datetime,
    requires_shadow_live_deviation as _requires_shadow_live_deviation,
    requires_simulation_calibration as _requires_simulation_calibration,
    shadow_live_deviation_required_artifact_refs as _shadow_live_deviation_required_artifact_refs,
    simulation_calibration_required_artifact_refs as _simulation_calibration_required_artifact_refs,
)


@dataclass
class _ArtifactEvaluation:
    reasons: list[str]
    details: list[dict[str, object]]
    refs: list[str]
    artifact_ref: str
    artifact_path: Path | None
    payload: dict[str, Any] | None

    @property
    def detail_ref(self) -> str:
        if self.artifact_path is not None:
            return str(self.artifact_path)
        return self.artifact_ref

    def add(self, reason: str, **detail: object) -> None:
        self.reasons.append(reason)
        self.details.append(
            {
                "reason": reason,
                "artifact_ref": self.detail_ref,
                **detail,
            }
        )

    def result(self) -> tuple[list[str], list[dict[str, object]], list[str]]:
        return self.reasons, self.details, self.refs


def _load_required_evidence_artifact(
    *,
    evidence_ref: str,
    required_artifacts: Sequence[str],
    artifact_root: Path,
    missing_reason: str | None,
    invalid_ref_reason: str,
    invalid_json_reason: str,
) -> _ArtifactEvaluation:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    if not evidence_ref and missing_reason is not None:
        reasons.append(missing_reason)
        details.append({"reason": missing_reason})

    artifact_ref = (evidence_ref or required_artifacts[0]).strip()
    artifact_path = _normalize_artifact_path(artifact_ref, artifact_root=artifact_root)
    if artifact_path is None:
        reasons.append(invalid_ref_reason)
        details.append({"reason": invalid_ref_reason, "artifact_ref": artifact_ref})
        return _ArtifactEvaluation(
            reasons=reasons,
            details=details,
            refs=refs,
            artifact_ref=artifact_ref,
            artifact_path=None,
            payload=None,
        )

    refs.append(evidence_ref or str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        reasons.append(invalid_json_reason)
        details.append(
            {"reason": invalid_json_reason, "artifact_ref": str(artifact_path)}
        )
    return _ArtifactEvaluation(
        reasons=reasons,
        details=details,
        refs=refs,
        artifact_ref=artifact_ref,
        artifact_path=artifact_path,
        payload=payload,
    )


def _require_schema_version(
    evaluation: _ArtifactEvaluation,
    *,
    expected: str,
    reason: str,
    expected_key: str | None = None,
) -> None:
    if evaluation.payload is None:
        return
    schema_version = str(evaluation.payload.get("schema_version", "")).strip()
    if schema_version == expected:
        return
    detail: dict[str, object] = {"schema_version": schema_version}
    if expected_key is not None:
        detail[expected_key] = expected
    evaluation.add(reason, **detail)


def _require_status(
    evaluation: _ArtifactEvaluation,
    *,
    expected: str,
    reason: str,
    field: str = "status",
    detail_key: str = "status",
) -> None:
    if evaluation.payload is None:
        return
    status = str(evaluation.payload.get(field, "")).strip()
    if status != expected:
        evaluation.add(reason, **{detail_key: status})


def _require_min_int_field(
    evaluation: _ArtifactEvaluation,
    *,
    field: str,
    minimum: int,
    reason: str,
    actual_key: str,
    minimum_key: str,
) -> int:
    value = _int_or_default(
        None if evaluation.payload is None else evaluation.payload.get(field),
        -1,
    )
    if value < minimum:
        evaluation.add(reason, **{actual_key: value, minimum_key: minimum})
    return value


def _require_float_min_field(
    evaluation: _ArtifactEvaluation,
    *,
    field: str,
    minimum: float,
    missing_reason: str,
    threshold_reason: str,
    actual_key: str,
    minimum_key: str,
) -> None:
    value = _float_or_none(
        None if evaluation.payload is None else evaluation.payload.get(field)
    )
    if value is None:
        evaluation.add(missing_reason)
    elif value < minimum:
        evaluation.add(threshold_reason, **{actual_key: value, minimum_key: minimum})


def _require_float_max_field(
    evaluation: _ArtifactEvaluation,
    *,
    field: str,
    maximum: float,
    missing_reason: str,
    threshold_reason: str,
    actual_key: str,
    maximum_key: str,
) -> None:
    value = _float_or_none(
        None if evaluation.payload is None else evaluation.payload.get(field)
    )
    if value is None:
        evaluation.add(missing_reason)
    elif value > maximum:
        evaluation.add(threshold_reason, **{actual_key: value, maximum_key: maximum})


def _append_detail(
    reasons: list[str],
    details: list[dict[str, object]],
    reason: str,
    **detail: object,
) -> None:
    reasons.append(reason)
    details.append({"reason": reason, **detail})


def _append_named_evidence_reason(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    evidence_name: str,
    suffix: str,
    **detail: object,
) -> None:
    reason = f"{evidence_name}_{suffix}"
    _append_detail(
        reasons,
        reason_details,
        reason,
        artifact_name=evidence_name,
        **detail,
    )


def _evaluate_simulation_calibration_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_simulation_calibration(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    calibration = _as_dict(evidence.get("simulation_calibration"))
    evidence_ref = str(calibration.get("artifact_ref") or "").strip()

    evaluation = _load_required_evidence_artifact(
        evidence_ref=evidence_ref,
        required_artifacts=_simulation_calibration_required_artifact_refs(
            policy_payload
        ),
        artifact_root=artifact_root,
        missing_reason="simulation_calibration_artifact_ref_missing",
        invalid_ref_reason="simulation_calibration_artifact_ref_invalid",
        invalid_json_reason="simulation_calibration_artifact_invalid_json",
    )
    if evaluation.payload is None:
        return evaluation.result()

    _require_schema_version(
        evaluation,
        expected="simulation-calibration-report-v1",
        reason="simulation_calibration_schema_version_invalid",
    )
    _require_status(
        evaluation,
        expected="calibrated",
        reason="simulation_calibration_status_not_calibrated",
    )

    minimum_order_count = max(
        1,
        _int_or_default(
            policy_payload.get("promotion_simulation_calibration_min_order_count"),
            1,
        ),
    )
    _require_min_int_field(
        evaluation,
        field="order_count",
        minimum=minimum_order_count,
        reason="simulation_calibration_order_count_below_minimum",
        actual_key="actual_order_count",
        minimum_key="minimum_order_count",
    )

    minimum_coverage = _float_or_none(
        policy_payload.get(
            "promotion_simulation_calibration_min_expected_shortfall_coverage"
        )
    )
    if minimum_coverage is None:
        minimum_coverage = 0.5
    _require_float_min_field(
        evaluation,
        field="expected_shortfall_coverage",
        minimum=minimum_coverage,
        missing_reason="simulation_calibration_expected_shortfall_coverage_missing",
        threshold_reason="simulation_calibration_expected_shortfall_coverage_below_threshold",
        actual_key="actual_coverage",
        minimum_key="minimum_coverage",
    )

    max_avg_calibration_error_bps = _float_or_none(
        policy_payload.get(
            "promotion_simulation_calibration_max_avg_calibration_error_bps"
        )
    )
    if max_avg_calibration_error_bps is None:
        max_avg_calibration_error_bps = 25.0
    _require_float_max_field(
        evaluation,
        field="avg_calibration_error_bps",
        maximum=max_avg_calibration_error_bps,
        missing_reason="simulation_calibration_avg_calibration_error_bps_missing",
        threshold_reason="simulation_calibration_avg_calibration_error_bps_exceeds_threshold",
        actual_key="actual_avg_calibration_error_bps",
        maximum_key="maximum_avg_calibration_error_bps",
    )

    _require_status(
        evaluation,
        expected="pass",
        reason="simulation_calibration_confidence_gate_action_not_pass",
        field="confidence_gate_action",
        detail_key="confidence_gate_action",
    )

    return evaluation.result()


def _evaluate_shadow_live_deviation_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_shadow_live_deviation(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    deviation = _as_dict(evidence.get("shadow_live_deviation"))
    evidence_ref = str(deviation.get("artifact_ref") or "").strip()

    evaluation = _load_required_evidence_artifact(
        evidence_ref=evidence_ref,
        required_artifacts=_shadow_live_deviation_required_artifact_refs(
            policy_payload
        ),
        artifact_root=artifact_root,
        missing_reason="shadow_live_deviation_artifact_ref_missing",
        invalid_ref_reason="shadow_live_deviation_artifact_ref_invalid",
        invalid_json_reason="shadow_live_deviation_artifact_invalid_json",
    )
    if evaluation.payload is None:
        return evaluation.result()

    _require_schema_version(
        evaluation,
        expected="shadow-live-deviation-report-v1",
        reason="shadow_live_deviation_schema_version_invalid",
    )
    _require_status(
        evaluation,
        expected="within_budget",
        reason="shadow_live_deviation_status_not_within_budget",
    )

    minimum_order_count = max(
        1,
        _int_or_default(
            policy_payload.get("promotion_shadow_live_deviation_min_order_count"),
            1,
        ),
    )
    _require_min_int_field(
        evaluation,
        field="order_count",
        minimum=minimum_order_count,
        reason="shadow_live_deviation_order_count_below_minimum",
        actual_key="actual_order_count",
        minimum_key="minimum_order_count",
    )

    max_avg_abs_slippage_bps = _float_or_none(
        policy_payload.get("promotion_shadow_live_deviation_max_avg_abs_slippage_bps")
    )
    if max_avg_abs_slippage_bps is None:
        max_avg_abs_slippage_bps = 20.0
    _require_float_max_field(
        evaluation,
        field="avg_abs_slippage_bps",
        maximum=max_avg_abs_slippage_bps,
        missing_reason="shadow_live_deviation_avg_abs_slippage_bps_missing",
        threshold_reason="shadow_live_deviation_avg_abs_slippage_bps_exceeds_threshold",
        actual_key="actual_avg_abs_slippage_bps",
        maximum_key="maximum_avg_abs_slippage_bps",
    )

    max_avg_abs_divergence_bps = _float_or_none(
        policy_payload.get("promotion_shadow_live_deviation_max_avg_abs_divergence_bps")
    )
    if max_avg_abs_divergence_bps is None:
        max_avg_abs_divergence_bps = 15.0
    _require_float_max_field(
        evaluation,
        field="avg_abs_divergence_bps",
        maximum=max_avg_abs_divergence_bps,
        missing_reason="shadow_live_deviation_avg_abs_divergence_bps_missing",
        threshold_reason="shadow_live_deviation_avg_abs_divergence_bps_exceeds_threshold",
        actual_key="actual_avg_abs_divergence_bps",
        maximum_key="maximum_avg_abs_divergence_bps",
    )

    return evaluation.result()


def _load_fold_metrics_effective_count(
    *,
    reasons: list[str],
    details: list[dict[str, object]],
    fold_ref: str,
    fold_count: int,
    min_fold_count: int,
    artifact_root: Path,
) -> int:
    if not fold_ref or fold_count >= min_fold_count:
        return fold_count

    fold_payload_path = _normalize_artifact_path(fold_ref, artifact_root=artifact_root)
    fold_payload = (
        None if fold_payload_path is None else _load_json_if_exists(fold_payload_path)
    )
    if fold_payload is None:
        _append_detail(
            reasons,
            details,
            "fold_metrics_evidence_artifact_invalid",
            artifact_ref=fold_ref,
        )
        return fold_count

    schema_version = str(fold_payload.get("schema_version", "")).strip()
    if schema_version and schema_version != "fold-metrics-v1":
        _append_detail(
            reasons,
            details,
            "fold_metrics_evidence_schema_invalid",
            artifact_ref=fold_ref,
            actual_schema_version=schema_version,
            expected_schema_version="fold-metrics-v1",
        )
    payload_count = _int_or_default(
        fold_payload.get("count"),
        len(_list_from_any(fold_payload.get("items"))),
    )
    if payload_count > 0:
        return payload_count
    return fold_count


def _evaluate_fold_metrics_evidence(
    *,
    policy_payload: dict[str, Any],
    evidence: dict[str, Any],
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    fold_raw = evidence.get("fold_metrics")
    fold_metrics = cast(dict[str, Any], fold_raw) if isinstance(fold_raw, dict) else {}
    fold_ref = str(fold_metrics.get("artifact_ref") or "").strip()
    min_fold_count = max(
        1,
        _int_or_default(policy_payload.get("promotion_min_fold_metrics_count"), 1),
    )
    fold_count = _int_or_default(fold_metrics.get("count"), 0)
    if fold_count < min_fold_count:
        _append_evidence_artifact_reasons(
            reasons=reasons,
            reason_details=details,
            evidence_name="fold_metrics",
            artifact_root=artifact_root,
            raw_ref=fold_ref,
            policy_payload=policy_payload,
            now=now,
        )
    if fold_ref:
        refs.append(fold_ref)

    effective_fold_count = _load_fold_metrics_effective_count(
        reasons=reasons,
        details=details,
        fold_ref=fold_ref,
        fold_count=fold_count,
        min_fold_count=min_fold_count,
        artifact_root=artifact_root,
    )

    if effective_fold_count < min_fold_count:
        _append_detail(
            reasons,
            details,
            "fold_metrics_evidence_insufficient",
            actual_fold_count=effective_fold_count,
            minimum_fold_count=min_fold_count,
        )

    return reasons, details, refs


def _load_stress_metrics_payload(
    *,
    reasons: list[str],
    details: list[dict[str, object]],
    stress_ref: str,
    artifact_root: Path,
) -> dict[str, Any] | None:
    if not stress_ref:
        _append_detail(reasons, details, "stress_metrics_evidence_artifact_ref_missing")
        return None

    artifact_ref_path = _normalize_artifact_path(
        stress_ref, artifact_root=artifact_root
    )
    if artifact_ref_path is None:
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_ref_not_trusted",
            artifact_ref=stress_ref,
        )
        return None
    if not artifact_ref_path.exists():
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_artifact_missing",
            artifact_ref=stress_ref,
        )
        return None

    stress_payload = _load_json_if_exists(artifact_ref_path)
    if stress_payload is None:
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_artifact_invalid",
            artifact_ref=stress_ref,
        )
    return stress_payload


def _validate_stress_metrics_payload(
    *,
    reasons: list[str],
    details: list[dict[str, object]],
    stress_payload: dict[str, Any],
    stress_ref: str,
    min_stress_count: int,
    max_age_hours: int,
    now: datetime,
) -> None:
    schema_version = str(stress_payload.get("schema_version") or "").strip()
    if schema_version and schema_version != "stress-metrics-v1":
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_schema_invalid",
            artifact_ref=stress_ref,
            actual_schema_version=schema_version,
            expected_schema_version="stress-metrics-v1",
        )
    payload_count = _int_or_default(
        stress_payload.get("count"),
        len(_list_from_any(stress_payload.get("items"))),
    )
    if payload_count < min_stress_count:
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_insufficient",
            actual_stress_case_count=payload_count,
            minimum_stress_case_count=min_stress_count,
        )
    _append_stress_generated_at_reasons(
        reasons=reasons,
        details=details,
        stress_payload=stress_payload,
        stress_ref=stress_ref,
        max_age_hours=max_age_hours,
        now=now,
    )


def _append_stress_generated_at_reasons(
    *,
    reasons: list[str],
    details: list[dict[str, object]],
    stress_payload: dict[str, Any],
    stress_ref: str,
    max_age_hours: int,
    now: datetime,
) -> None:
    generated_at_raw = str(stress_payload.get("generated_at") or "").strip()
    generated_at = _parse_datetime(generated_at_raw)
    if generated_at is None:
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_generated_at_missing",
            artifact_ref=stress_ref,
        )
    elif (now - generated_at).total_seconds() > max_age_hours * 3600:
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_stale",
            artifact_ref=stress_ref,
            generated_at=generated_at_raw,
            max_age_hours=max_age_hours,
        )


def _evaluate_stress_metrics_evidence(
    *,
    policy_payload: dict[str, Any],
    evidence: dict[str, Any],
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    now = now or datetime.now(timezone.utc)
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    stress_raw = evidence.get("stress_metrics")
    stress_metrics = (
        cast(dict[str, Any], stress_raw) if isinstance(stress_raw, dict) else {}
    )
    stress_ref = str(stress_metrics.get("artifact_ref") or "").strip()
    _append_evidence_artifact_reasons(
        reasons=reasons,
        reason_details=details,
        evidence_name="stress_metrics",
        artifact_root=artifact_root,
        raw_ref=stress_ref,
        policy_payload=policy_payload,
        now=now,
    )
    stress_count = _int_or_default(stress_metrics.get("count"), 0)
    min_stress_count = max(
        1,
        _int_or_default(policy_payload.get("promotion_min_stress_case_count"), 4),
    )
    stress_payload = _load_stress_metrics_payload(
        reasons=reasons,
        details=details,
        stress_ref=stress_ref,
        artifact_root=artifact_root,
    )

    if stress_payload is not None:
        max_age_hours = max(
            1, _int_or_default(policy_payload.get("promotion_stress_max_age_hours"), 24)
        )
        _validate_stress_metrics_payload(
            reasons=reasons,
            details=details,
            stress_payload=stress_payload,
            stress_ref=stress_ref,
            min_stress_count=min_stress_count,
            max_age_hours=max_age_hours,
            now=now,
        )

    if stress_count < min_stress_count:
        _append_detail(
            reasons,
            details,
            "stress_metrics_evidence_insufficient",
            actual_stress_case_count=stress_count,
            minimum_stress_case_count=min_stress_count,
        )
    if stress_ref:
        refs.append(stress_ref)
    return reasons, details, refs


def _resolve_named_evidence_artifact_path(
    *,
    artifact_ref: str,
    artifact_root: Path,
) -> tuple[Path | None, str | None]:
    if not artifact_ref:
        return None, "artifact_ref_missing"
    if artifact_ref.startswith("db:") or (
        "://" in artifact_ref and not artifact_ref.startswith("file://")
    ):
        return None, "artifact_ref_untrusted"

    artifact_ref_for_path = artifact_ref.removeprefix("file://")
    candidate_path = Path(artifact_ref_for_path)
    if not candidate_path.is_absolute():
        candidate_path = artifact_root / candidate_path
    try:
        artifact_path = candidate_path.resolve()
    except (OSError, ValueError):
        return None, "artifact_ref_invalid"

    try:
        artifact_root_path = artifact_root.resolve()
    except OSError:
        return None, "artifact_ref_invalid"

    if not artifact_path.is_relative_to(artifact_root_path):
        return None, "artifact_ref_outside_artifact_root"
    return artifact_path, None


def _append_artifact_age_reason(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    evidence_name: str,
    artifact_ref: str,
    artifact_path: Path,
    policy_payload: dict[str, Any],
    now: datetime | None,
) -> None:
    max_age_seconds = _int_or_default(
        policy_payload.get("promotion_evidence_max_age_seconds"), 0
    )
    if max_age_seconds <= 0 or now is None:
        return

    try:
        artifact_mtime = datetime.fromtimestamp(
            os.path.getmtime(artifact_path),
            tz=timezone.utc,
        )
    except OSError:
        _append_named_evidence_reason(
            reasons=reasons,
            reason_details=reason_details,
            evidence_name=evidence_name,
            suffix="artifact_ref_invalid",
            artifact_ref=artifact_ref,
        )
        return

    if (now - artifact_mtime).total_seconds() > max_age_seconds:
        _append_named_evidence_reason(
            reasons=reasons,
            reason_details=reason_details,
            evidence_name=evidence_name,
            suffix="artifact_stale",
            artifact_path=str(artifact_path),
            artifact_mtime=artifact_mtime.isoformat(),
            max_age_seconds=max_age_seconds,
        )


def _append_evidence_artifact_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    evidence_name: str,
    artifact_root: Path,
    raw_ref: str,
    policy_payload: dict[str, Any],
    now: datetime | None = None,
) -> None:
    artifact_ref = str(raw_ref or "").strip()
    artifact_path, error_suffix = _resolve_named_evidence_artifact_path(
        artifact_ref=artifact_ref,
        artifact_root=artifact_root,
    )
    if error_suffix is not None or artifact_path is None:
        detail = {} if not artifact_ref else {"artifact_ref": artifact_ref}
        _append_named_evidence_reason(
            reasons=reasons,
            reason_details=reason_details,
            evidence_name=evidence_name,
            suffix=error_suffix or "artifact_ref_invalid",
            **detail,
        )
        return

    if not artifact_path.is_file():
        _append_named_evidence_reason(
            reasons=reasons,
            reason_details=reason_details,
            evidence_name=evidence_name,
            suffix="artifact_missing",
            artifact_ref=artifact_ref,
            artifact_path=str(artifact_path),
        )
        return

    if _load_json_if_exists(artifact_path) is None:
        _append_named_evidence_reason(
            reasons=reasons,
            reason_details=reason_details,
            evidence_name=evidence_name,
            suffix="artifact_payload_invalid",
            artifact_path=str(artifact_path),
        )
        return

    _append_artifact_age_reason(
        reasons=reasons,
        reason_details=reason_details,
        evidence_name=evidence_name,
        artifact_ref=artifact_ref,
        artifact_path=artifact_path,
        policy_payload=policy_payload,
        now=now,
    )


def _evaluate_rationale_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    evidence: dict[str, Any],
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    if not bool(policy_payload.get("promotion_require_rationale", True)):
        return reasons, details

    rationale_raw = evidence.get("promotion_rationale")
    rationale = (
        cast(dict[str, Any], rationale_raw) if isinstance(rationale_raw, dict) else {}
    )
    reason_codes = _list_of_strings(rationale.get("reason_codes"))
    if not reason_codes:
        reason_codes = _list_of_strings(rationale.get("gate_reasons"))
    rationale_text = str(rationale.get("rationale_text") or "").strip()
    if not rationale:
        reasons.append("promotion_rationale_missing")
        details.append({"reason": "promotion_rationale_missing"})

    requested_target = str(rationale.get("requested_target") or "").strip()
    if requested_target and requested_target != promotion_target:
        reasons.append("promotion_rationale_target_mismatch")
        details.append(
            {
                "reason": "promotion_rationale_target_mismatch",
                "requested_target": promotion_target,
                "rationale_target": requested_target,
            }
        )

    recommended_mode = str(rationale.get("recommended_mode") or "").strip()
    if not recommended_mode:
        recommended_mode = str(rationale.get("gate_recommended_mode") or "").strip()
    gate_recommended_mode = str(gate_report_payload.get("recommended_mode", "")).strip()
    if (
        recommended_mode
        and gate_recommended_mode
        and recommended_mode != gate_recommended_mode
    ):
        reasons.append("promotion_rationale_recommended_mode_mismatch")
        details.append(
            {
                "reason": "promotion_rationale_recommended_mode_mismatch",
                "rationale_recommended_mode": recommended_mode,
                "gate_recommended_mode": gate_recommended_mode,
            }
        )

    if not reason_codes and not rationale_text:
        reasons.append("promotion_rationale_missing")
        details.append({"reason": "promotion_rationale_missing"})
    return reasons, details


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
append_detail = _append_detail
append_evidence_artifact_reasons = _append_evidence_artifact_reasons
ArtifactEvaluation = _ArtifactEvaluation
evaluate_fold_metrics_evidence = _evaluate_fold_metrics_evidence
evaluate_rationale_evidence = _evaluate_rationale_evidence
evaluate_shadow_live_deviation_evidence = _evaluate_shadow_live_deviation_evidence
evaluate_simulation_calibration_evidence = _evaluate_simulation_calibration_evidence
evaluate_stress_metrics_evidence = _evaluate_stress_metrics_evidence
load_required_evidence_artifact = _load_required_evidence_artifact
require_float_max_field = _require_float_max_field
require_min_int_field = _require_min_int_field
require_schema_version = _require_schema_version
require_status = _require_status
