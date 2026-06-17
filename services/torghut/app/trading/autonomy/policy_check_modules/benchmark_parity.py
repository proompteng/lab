"""Benchmark parity evidence validation."""

from __future__ import annotations

from .common import (
    Any,
    BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS,
    BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
    BENCHMARK_PARITY_SCHEMA_VERSION,
    Path,
    BenchmarkParityThresholds as _BenchmarkParityThresholds,
    hashlib,
    json,
)
from .requirements import (
    append_policy_issue as _append_policy_issue,
    as_dict as _as_dict,
    as_list_of_dicts as _as_list_of_dicts,
    benchmark_parity_artifact_candidates as _benchmark_parity_artifact_candidates,
    benchmark_parity_artifact_reference as _benchmark_parity_artifact_reference,
    coerce_evidence_bool as _coerce_evidence_bool,
    first_existing_artifact_path as _first_existing_artifact_path,
    float_or_none as _float_or_none,
    list_from_any as _list_from_any,
    load_json_if_exists as _load_json_if_exists,
    normalize_artifact_path as _normalize_artifact_path,
    requires_benchmark_parity as _requires_benchmark_parity,
)


def _evaluate_benchmark_parity_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_benchmark_parity(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []

    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    benchmark = _as_dict(evidence.get("benchmark_parity"))
    evidence_ref = str(benchmark.get("artifact_ref") or "").strip()
    artifact_ref = _benchmark_parity_artifact_reference(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
    )
    artifact_path = _resolve_benchmark_parity_artifact_path(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        artifact_root=artifact_root,
        artifact_ref=artifact_ref,
        evidence_ref=evidence_ref,
        reasons=reasons,
        details=details,
    )
    if artifact_path is None:
        return reasons, details, refs

    refs.append(evidence_ref or str(artifact_path))
    payload = _load_json_if_exists(artifact_path)
    if payload is None:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_artifact_invalid_json",
            artifact_ref=str(artifact_path),
        )
        return reasons, details, refs

    _validate_benchmark_parity_artifact_hash(payload, artifact_path, reasons, details)
    _validate_benchmark_parity_identity(payload, artifact_path, reasons, details)
    _validate_benchmark_parity_contract(payload, artifact_path, reasons, details)
    _validate_benchmark_parity_status(payload, artifact_path, reasons, details)

    scorecards = _as_dict(payload.get("scorecards"))
    _validate_benchmark_parity_scorecards(scorecards, artifact_path, reasons, details)

    benchmark_runs = _list_from_any(payload.get("benchmark_runs"))
    if not benchmark_runs:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_runs_missing",
            artifact_ref=str(artifact_path),
        )
        return reasons, details, refs

    thresholds = _benchmark_parity_thresholds(policy_payload)
    _validate_benchmark_parity_scorecard_drift(
        scorecards,
        artifact_path,
        thresholds,
        reasons,
        details,
    )
    families_seen = _validate_benchmark_parity_runs(
        benchmark_runs,
        artifact_path,
        thresholds,
        reasons,
        details,
    )
    _validate_benchmark_parity_family_coverage(
        families_seen,
        artifact_path,
        thresholds,
        reasons,
        details,
    )
    _validate_benchmark_parity_degradation_summary(
        payload,
        artifact_path,
        thresholds,
        reasons,
        details,
    )

    return reasons, details, refs


def _resolve_benchmark_parity_artifact_path(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    artifact_ref: str,
    evidence_ref: str,
    reasons: list[str],
    details: list[dict[str, object]],
) -> Path | None:
    artifact_candidates = _benchmark_parity_artifact_candidates(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
    )
    artifact_path = _first_existing_artifact_path(
        artifact_candidates,
        artifact_root=artifact_root,
    )
    if artifact_path is None and evidence_ref:
        artifact_path = _normalize_artifact_path(
            evidence_ref, artifact_root=artifact_root
        )
    if artifact_path is None:
        normalized_default_path = _normalize_artifact_path(
            artifact_ref, artifact_root=artifact_root
        )
        if normalized_default_path is not None:
            _append_policy_issue(
                reasons,
                details,
                "benchmark_parity_artifact_missing",
                artifact_ref=str(normalized_default_path),
            )
            return None
    if artifact_path is None:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_artifact_ref_invalid",
            artifact_ref=artifact_ref,
        )
    return artifact_path


def _validate_benchmark_parity_artifact_hash(
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
            "benchmark_parity_artifact_hash_missing",
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
            "benchmark_parity_artifact_hash_mismatch",
            artifact_ref=str(artifact_path),
            artifact_hash=str(payload.get("artifact_hash", "")),
            expected_artifact_hash=expected_hash,
        )


def _validate_benchmark_parity_identity(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    if not str(payload.get("candidate_id", "")).strip():
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_candidate_id_missing",
            artifact_ref=str(artifact_path),
        )

    if not str(payload.get("baseline_candidate_id", "")).strip():
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_baseline_candidate_id_missing",
            artifact_ref=str(artifact_path),
        )

    schema_version = str(payload.get("schema_version", "")).strip()
    if schema_version != BENCHMARK_PARITY_SCHEMA_VERSION:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_schema_version_invalid",
            artifact_ref=str(artifact_path),
            schema_version=schema_version,
            expected_schema_version=BENCHMARK_PARITY_SCHEMA_VERSION,
        )


def _validate_benchmark_parity_contract(
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
            "benchmark_parity_contract_missing",
            artifact_ref=str(artifact_path),
        )
        return

    _validate_benchmark_parity_contract_schema(
        contract, artifact_path, reasons, details
    )
    _validate_benchmark_parity_contract_sets(contract, artifact_path, reasons, details)


def _validate_benchmark_parity_contract_schema(
    contract: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    contract_schema_version = str(contract.get("schema_version", "")).strip()
    if contract_schema_version != BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_contract_schema_version_invalid",
            artifact_ref=str(artifact_path),
            schema_version=contract_schema_version,
            expected_schema_version=BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
        )

    hash_algorithm = str(contract.get("hash_algorithm", "")).strip().lower()
    if hash_algorithm != "sha256":
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_contract_hash_algorithm_invalid",
            artifact_ref=str(artifact_path),
            hash_algorithm=hash_algorithm,
            expected_hash_algorithm="sha256",
        )


def _validate_benchmark_parity_contract_sets(
    contract: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    required_families_contract = {
        str(item).strip().lower()
        for item in _list_from_any(contract.get("required_families"))
        if str(item).strip()
    }
    if required_families_contract != set(BENCHMARK_PARITY_REQUIRED_FAMILIES):
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_contract_required_families_invalid",
            artifact_ref=str(artifact_path),
            required_families=sorted(required_families_contract),
            expected_required_families=sorted(BENCHMARK_PARITY_REQUIRED_FAMILIES),
        )

    required_scorecards_contract = {
        str(item).strip().lower()
        for item in _list_from_any(contract.get("required_scorecards"))
        if str(item).strip()
    }
    if required_scorecards_contract != set(BENCHMARK_PARITY_REQUIRED_SCORECARDS):
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_contract_required_scorecards_invalid",
            artifact_ref=str(artifact_path),
            required_scorecards=sorted(required_scorecards_contract),
            expected_required_scorecards=sorted(BENCHMARK_PARITY_REQUIRED_SCORECARDS),
        )

    required_scorecard_fields_contract = {
        str(scorecard_name).strip(): tuple(
            str(field).strip()
            for field in _list_from_any(required_fields)
            if str(field).strip()
        )
        for scorecard_name, required_fields in _as_dict(
            contract.get("required_scorecard_fields")
        ).items()
        if str(scorecard_name).strip()
    }
    if required_scorecard_fields_contract != BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_contract_required_scorecard_fields_invalid",
            artifact_ref=str(artifact_path),
            required_scorecard_fields={
                name: list(fields)
                for name, fields in required_scorecard_fields_contract.items()
            },
            expected_required_scorecard_fields={
                name: list(fields)
                for name, fields in BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS.items()
            },
        )

    required_run_fields_contract = {
        str(item).strip()
        for item in _list_from_any(contract.get("required_run_fields"))
        if str(item).strip()
    }
    if required_run_fields_contract != set(BENCHMARK_PARITY_REQUIRED_RUN_FIELDS):
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_contract_required_run_fields_invalid",
            artifact_ref=str(artifact_path),
            required_run_fields=sorted(required_run_fields_contract),
            expected_required_run_fields=sorted(BENCHMARK_PARITY_REQUIRED_RUN_FIELDS),
        )


def _validate_benchmark_parity_status(
    payload: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    if str(payload.get("overall_parity_status", "")).strip() == "pass":
        return
    _append_policy_issue(
        reasons,
        details,
        "benchmark_parity_status_not_pass",
        artifact_ref=str(artifact_path),
        status=payload.get("overall_parity_status"),
    )


def _validate_benchmark_parity_scorecards(
    scorecards: dict[str, Any],
    artifact_path: Path,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    for scorecard_name in BENCHMARK_PARITY_REQUIRED_SCORECARDS:
        scorecard_payload = _as_dict(scorecards.get(scorecard_name))
        card_status = str(scorecard_payload.get("status", "")).strip()
        if not scorecard_payload:
            _append_policy_issue(
                reasons,
                details,
                "benchmark_parity_scorecard_missing",
                artifact_ref=str(artifact_path),
                scorecard=scorecard_name,
            )
        elif card_status != "pass":
            _append_policy_issue(
                reasons,
                details,
                "benchmark_parity_scorecard_not_pass",
                artifact_ref=str(artifact_path),
                scorecard=scorecard_name,
                status=card_status,
            )

        missing_required_scorecard_fields = [
            field
            for field in BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS.get(
                scorecard_name, ()
            )
            if field not in scorecard_payload
        ]
        if missing_required_scorecard_fields:
            _append_policy_issue(
                reasons,
                details,
                "benchmark_parity_scorecard_missing_required_fields",
                artifact_ref=str(artifact_path),
                scorecard=scorecard_name,
                missing_fields=missing_required_scorecard_fields,
            )


def _benchmark_parity_thresholds(
    policy_payload: dict[str, Any],
) -> _BenchmarkParityThresholds:
    max_confidence_degradation = _policy_float(
        policy_payload,
        "promotion_benchmark_parity_max_confidence_calibration_error_degradation",
        0.01,
    )
    return _BenchmarkParityThresholds(
        min_advisory_output_rate=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_min_advisory_output_rate",
            0.995,
        ),
        max_policy_violation_degradation=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_max_policy_violation_rate_degradation",
            0.0,
        ),
        max_fallback_rate=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_max_fallback_rate",
            0.01,
        ),
        max_timeout_rate=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_max_timeout_rate",
            0.005,
        ),
        max_adverse_regime_degradation=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_max_adverse_regime_decision_quality_degradation",
            0.01,
        ),
        max_risk_veto_degradation=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_max_risk_veto_alignment_degradation",
            0.01,
        ),
        max_confidence_degradation=max_confidence_degradation,
        max_scorecard_confidence_drift=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_max_scorecard_confidence_calibration_error_drift",
            max_confidence_degradation,
        ),
        min_family_coverage_ratio=_policy_float(
            policy_payload,
            "promotion_benchmark_parity_min_family_coverage_ratio",
            1.0,
        ),
    )


def _policy_float(
    policy_payload: dict[str, Any],
    key: str,
    default: float,
) -> float:
    value = _float_or_none(policy_payload.get(key))
    return default if value is None else value


def _validate_benchmark_parity_scorecard_drift(
    scorecards: dict[str, Any],
    artifact_path: Path,
    thresholds: _BenchmarkParityThresholds,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    forecast_scorecard = _as_dict(scorecards.get("forecast_quality"))
    forecast_confidence_error = _float_or_none(
        forecast_scorecard.get("confidence_calibration_error")
    )
    forecast_confidence_error_baseline = _float_or_none(
        forecast_scorecard.get("confidence_calibration_error_baseline")
    )
    if forecast_confidence_error is None or forecast_confidence_error_baseline is None:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_scorecard_confidence_calibration_error_fields_missing",
            artifact_ref=str(artifact_path),
        )
    elif (
        forecast_confidence_error - forecast_confidence_error_baseline
        > thresholds.max_scorecard_confidence_drift
    ):
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_scorecard_confidence_calibration_error_drift_exceeds_threshold",
            artifact_ref=str(artifact_path),
            actual_confidence_calibration_error=forecast_confidence_error,
            baseline_confidence_calibration_error=forecast_confidence_error_baseline,
            maximum_drift=thresholds.max_scorecard_confidence_drift,
        )


def _validate_benchmark_parity_runs(
    benchmark_runs: list[object],
    artifact_path: Path,
    thresholds: _BenchmarkParityThresholds,
    reasons: list[str],
    details: list[dict[str, object]],
) -> set[str]:
    families_seen = set[str]()
    for run in _as_list_of_dicts(benchmark_runs):
        family = str(run.get("family", "")).strip().lower()
        if family:
            families_seen.add(family)

        _validate_benchmark_parity_run_schema(
            run,
            artifact_path,
            family,
            reasons,
            details,
        )
        missing_required_run_fields = _missing_benchmark_parity_run_fields(run)
        if missing_required_run_fields:
            _append_policy_issue(
                reasons,
                details,
                "benchmark_parity_run_missing_required_fields",
                artifact_ref=str(artifact_path),
                family=family,
                missing_fields=missing_required_run_fields,
            )
            continue

        _validate_benchmark_parity_run_metrics(
            run,
            artifact_path,
            family,
            thresholds,
            reasons,
            details,
        )
    return families_seen


def _validate_benchmark_parity_run_schema(
    run: dict[str, Any],
    artifact_path: Path,
    family: str,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    run_schema_version = str(run.get("schema_version", "")).strip()
    if run_schema_version == BENCHMARK_PARITY_RUN_SCHEMA_VERSION:
        return
    _append_policy_issue(
        reasons,
        details,
        "benchmark_parity_run_schema_version_invalid",
        artifact_ref=str(artifact_path),
        family=family,
        schema_version=run_schema_version,
        expected_schema_version=BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
    )


def _missing_benchmark_parity_run_fields(run: dict[str, Any]) -> list[str]:
    missing_required_run_fields: list[str] = []
    for field in BENCHMARK_PARITY_REQUIRED_RUN_FIELDS:
        if field in {"dataset_ref", "window_ref", "family", "run_hash"}:
            if not str(run.get(field, "")).strip():
                missing_required_run_fields.append(field)
        else:
            value = run.get(field)
            if not isinstance(value, dict) or not value:
                missing_required_run_fields.append(field)
    return missing_required_run_fields


def _validate_benchmark_parity_run_metrics(
    run: dict[str, Any],
    artifact_path: Path,
    family: str,
    thresholds: _BenchmarkParityThresholds,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    metrics = _as_dict(run.get("metrics"))
    violations = _as_dict(run.get("policy_violations"))

    _append_missing_or_minimum_float_issue(
        reasons,
        details,
        value=_float_or_none(metrics.get("advisory_output_rate")),
        minimum=thresholds.min_advisory_output_rate,
        missing_reason="benchmark_parity_missing_advisory_output_rate",
        threshold_reason="benchmark_parity_advisory_output_rate_below_minimum",
        artifact_ref=str(artifact_path),
        family=family,
        actual_field="actual_advisory_output_rate",
        minimum_field="minimum_advisory_output_rate",
    )
    _append_missing_or_delta_issue(
        reasons,
        details,
        value=_float_or_none(violations.get("rate")),
        baseline=_float_or_none(violations.get("baseline_rate")),
        maximum_delta=thresholds.max_policy_violation_degradation,
        missing_reason="benchmark_parity_policy_violation_rate_missing",
        threshold_reason="benchmark_parity_policy_violation_rate_degraded",
        artifact_ref=str(artifact_path),
        family=family,
        actual_field="actual_rate",
        baseline_field="baseline_rate",
        maximum_field="max_degradation",
    )
    _append_missing_or_maximum_float_issue(
        reasons,
        details,
        value=_float_or_none(violations.get("fallback_rate")),
        maximum=thresholds.max_fallback_rate,
        missing_reason="benchmark_parity_fallback_rate_missing",
        threshold_reason="benchmark_parity_fallback_rate_exceeds_threshold",
        artifact_ref=str(artifact_path),
        family=family,
        actual_field="actual_fallback_rate",
        maximum_field="maximum_fallback_rate",
    )
    _append_missing_or_maximum_float_issue(
        reasons,
        details,
        value=_float_or_none(violations.get("timeout_rate")),
        maximum=thresholds.max_timeout_rate,
        missing_reason="benchmark_parity_timeout_rate_missing",
        threshold_reason="benchmark_parity_timeout_rate_exceeds_threshold",
        artifact_ref=str(artifact_path),
        family=family,
        actual_field="actual_timeout_rate",
        maximum_field="maximum_timeout_rate",
    )
    if (
        _coerce_evidence_bool(violations.get("deterministic_gate_compatible"))
        is not True
    ):
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_deterministic_gate_compatibility_failed",
            artifact_ref=str(artifact_path),
            family=family,
        )


def _append_missing_or_minimum_float_issue(
    reasons: list[str],
    details: list[dict[str, object]],
    *,
    value: float | None,
    minimum: float,
    missing_reason: str,
    threshold_reason: str,
    artifact_ref: str,
    family: str,
    actual_field: str,
    minimum_field: str,
) -> None:
    if value is None:
        _append_policy_issue(
            reasons,
            details,
            missing_reason,
            artifact_ref=artifact_ref,
            family=family,
        )
    elif value < minimum:
        _append_policy_issue(
            reasons,
            details,
            threshold_reason,
            artifact_ref=artifact_ref,
            family=family,
            **{actual_field: value, minimum_field: minimum},
        )


def _append_missing_or_maximum_float_issue(
    reasons: list[str],
    details: list[dict[str, object]],
    *,
    value: float | None,
    maximum: float,
    missing_reason: str,
    threshold_reason: str,
    artifact_ref: str,
    family: str,
    actual_field: str,
    maximum_field: str,
) -> None:
    if value is None:
        _append_policy_issue(
            reasons,
            details,
            missing_reason,
            artifact_ref=artifact_ref,
            family=family,
        )
    elif value > maximum:
        _append_policy_issue(
            reasons,
            details,
            threshold_reason,
            artifact_ref=artifact_ref,
            family=family,
            **{actual_field: value, maximum_field: maximum},
        )


def _append_missing_or_delta_issue(
    reasons: list[str],
    details: list[dict[str, object]],
    *,
    value: float | None,
    baseline: float | None,
    maximum_delta: float,
    missing_reason: str,
    threshold_reason: str,
    artifact_ref: str,
    family: str,
    actual_field: str,
    baseline_field: str,
    maximum_field: str,
) -> None:
    if value is None or baseline is None:
        _append_policy_issue(
            reasons,
            details,
            missing_reason,
            artifact_ref=artifact_ref,
            family=family,
        )
    elif value - baseline > maximum_delta:
        _append_policy_issue(
            reasons,
            details,
            threshold_reason,
            artifact_ref=artifact_ref,
            family=family,
            **{
                actual_field: value,
                baseline_field: baseline,
                maximum_field: maximum_delta,
            },
        )


def _validate_benchmark_parity_family_coverage(
    families_seen: set[str],
    artifact_path: Path,
    thresholds: _BenchmarkParityThresholds,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    required_families = set(BENCHMARK_PARITY_REQUIRED_FAMILIES)
    missing_families = sorted(required_families - families_seen)
    if missing_families:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_family_results_missing",
            artifact_ref=str(artifact_path),
            missing_families=missing_families,
        )
    unexpected_families = sorted(families_seen - required_families)
    if unexpected_families:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_family_results_unexpected",
            artifact_ref=str(artifact_path),
            unexpected_families=unexpected_families,
        )

    family_coverage_ratio = (
        (len(families_seen & required_families) / len(required_families))
        if required_families
        else 1.0
    )
    if family_coverage_ratio < thresholds.min_family_coverage_ratio:
        _append_policy_issue(
            reasons,
            details,
            "benchmark_parity_family_coverage_ratio_below_minimum",
            artifact_ref=str(artifact_path),
            coverage_ratio=family_coverage_ratio,
            minimum_coverage_ratio=thresholds.min_family_coverage_ratio,
        )


def _validate_benchmark_parity_degradation_summary(
    payload: dict[str, Any],
    artifact_path: Path,
    thresholds: _BenchmarkParityThresholds,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    degradation = _as_dict(payload.get("degradation_summary"))
    _append_degradation_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(degradation.get("adverse_regime_decision_quality")).get(
                "degradation"
            )
        ),
        maximum=thresholds.max_adverse_regime_degradation,
        missing_reason="benchmark_parity_adverse_regime_degradation_missing",
        threshold_reason="benchmark_parity_adverse_regime_degradation_exceeds_threshold",
        artifact_ref=str(artifact_path),
    )
    _append_degradation_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(degradation.get("risk_veto_alignment")).get("degradation")
        ),
        maximum=thresholds.max_risk_veto_degradation,
        missing_reason="benchmark_parity_risk_veto_degradation_missing",
        threshold_reason="benchmark_parity_risk_veto_degradation_exceeds_threshold",
        artifact_ref=str(artifact_path),
    )
    _append_degradation_issue(
        reasons,
        details,
        value=_float_or_none(
            _as_dict(degradation.get("confidence_calibration_error")).get("degradation")
        ),
        maximum=thresholds.max_confidence_degradation,
        missing_reason="benchmark_parity_confidence_calibration_error_degradation_missing",
        threshold_reason="benchmark_parity_confidence_calibration_error_degradation_exceeds_threshold",
        artifact_ref=str(artifact_path),
    )


def _append_degradation_issue(
    reasons: list[str],
    details: list[dict[str, object]],
    *,
    value: float | None,
    maximum: float,
    missing_reason: str,
    threshold_reason: str,
    artifact_ref: str,
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
            actual_degradation=value,
            maximum_degradation=maximum,
        )


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
evaluate_benchmark_parity_evidence = _evaluate_benchmark_parity_evidence
policy_float = _policy_float
