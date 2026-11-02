"""Core Janus, contamination, HMM, and expert-router evidence validation."""

from __future__ import annotations

from .common import (
    Any,
    Path,
    Sequence,
    cast,
    dataclass,
    datetime,
)
from .evidence_artifacts import (
    ArtifactEvaluation as _ArtifactEvaluation,
    append_detail as _append_detail,
    append_evidence_artifact_reasons as _append_evidence_artifact_reasons,
    load_required_evidence_artifact as _load_required_evidence_artifact,
    require_float_max_field as _require_float_max_field,
    require_min_int_field as _require_min_int_field,
    require_schema_version as _require_schema_version,
    require_status as _require_status,
)
from .requirements import (
    as_dict as _as_dict,
    as_list_of_dicts as _as_list_of_dicts,
    coerce_evidence_bool as _coerce_evidence_bool,
    contamination_registry_required_artifact_refs as _contamination_registry_required_artifact_refs,
    expert_router_required_artifact_refs as _expert_router_required_artifact_refs,
    float_or_none as _float_or_none,
    hmm_state_posterior_required_artifact_refs as _hmm_state_posterior_required_artifact_refs,
    int_or_default as _int_or_default,
    list_from_any as _list_from_any,
    list_of_strings as _list_of_strings,
    requires_contamination_registry as _requires_contamination_registry,
    requires_expert_router_registry as _requires_expert_router_registry,
    requires_hmm_state_posterior as _requires_hmm_state_posterior,
    requires_janus_evidence as _requires_janus_evidence,
    sha256_json as _sha256_json,
)


@dataclass(frozen=True)
class _JanusEvidenceSpec:
    component_key: str
    evidence_name: str
    min_count_policy_key: str
    insufficient_reason: str
    actual_key: str
    minimum_key: str


def _append_janus_component_evidence(
    *,
    reasons: list[str],
    details: list[dict[str, object]],
    refs: list[str],
    janus: dict[str, Any],
    spec: _JanusEvidenceSpec,
    policy_payload: dict[str, Any],
    artifact_root: Path,
    now: datetime | None,
) -> None:
    component_raw = janus.get(spec.component_key)
    component = (
        cast(dict[str, Any], component_raw) if isinstance(component_raw, dict) else {}
    )
    artifact_ref = str(component.get("artifact_ref") or "").strip()
    _append_evidence_artifact_reasons(
        reasons=reasons,
        reason_details=details,
        evidence_name=spec.evidence_name,
        artifact_root=artifact_root,
        raw_ref=artifact_ref,
        policy_payload=policy_payload,
        now=now,
    )
    count = _int_or_default(component.get("count"), 0)
    minimum = max(1, _int_or_default(policy_payload.get(spec.min_count_policy_key), 1))
    if count < minimum:
        _append_detail(
            reasons,
            details,
            spec.insufficient_reason,
            **{spec.actual_key: count, spec.minimum_key: minimum},
        )
    if artifact_ref:
        refs.append(artifact_ref)


def _artifact_evaluation_from_gate_report(
    *,
    gate_report_payload: dict[str, Any],
    evidence_key: str,
    policy_payload: dict[str, Any],
    required_artifacts: Sequence[str],
    artifact_root: Path,
    invalid_ref_reason: str,
    invalid_json_reason: str,
    missing_ref_reason: str | None = None,
) -> _ArtifactEvaluation:
    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    payload = _as_dict(evidence.get(evidence_key))
    evidence_ref = str(payload.get("artifact_ref") or "").strip()
    return _load_required_evidence_artifact(
        evidence_ref=evidence_ref,
        required_artifacts=required_artifacts,
        artifact_root=artifact_root,
        missing_reason=missing_ref_reason,
        invalid_ref_reason=invalid_ref_reason,
        invalid_json_reason=invalid_json_reason,
    )


def _require_artifact_hash(
    evaluation: _ArtifactEvaluation,
    *,
    missing_reason: str,
    mismatch_reason: str,
) -> None:
    if evaluation.payload is None:
        return
    artifact_hash = str(evaluation.payload.get("artifact_hash", "")).strip()
    if not artifact_hash:
        evaluation.add(missing_reason)
        return
    expected_hash = _sha256_json(
        {
            key: value
            for key, value in evaluation.payload.items()
            if key != "artifact_hash"
        }
    )
    if artifact_hash != expected_hash:
        evaluation.add(
            mismatch_reason,
            artifact_hash=artifact_hash,
            expected_artifact_hash=expected_hash,
        )


def _required_policy_checks(policy_payload: dict[str, Any], key: str) -> list[str]:
    checks_raw = policy_payload.get(
        key,
        [
            "temporal_ordering",
            "lineage_complete",
            "leakage_absent",
            "embargo_windows_enforced",
        ],
    )
    return [
        str(item).strip()
        for item in _list_from_any(checks_raw)
        if isinstance(item, str) and str(item).strip()
    ]


def _validate_contamination_leakage(
    evaluation: _ArtifactEvaluation,
    policy_payload: dict[str, Any],
) -> None:
    if evaluation.payload is None:
        return
    leakage_detected = _coerce_evidence_bool(evaluation.payload.get("leakage_detected"))
    if leakage_detected is not False:
        evaluation.add(
            "contamination_registry_leakage_detected",
            leakage_detected=evaluation.payload.get("leakage_detected"),
        )

    max_leakage_rate = _float_or_none(
        policy_payload.get("promotion_contamination_max_leakage_rate")
    )
    if max_leakage_rate is None:
        max_leakage_rate = 0.0
    _require_float_max_field(
        evaluation,
        field="leakage_rate",
        maximum=max_leakage_rate,
        missing_reason="contamination_registry_leakage_rate_missing",
        threshold_reason="contamination_registry_leakage_rate_exceeds_threshold",
        actual_key="actual_leakage_rate",
        maximum_key="maximum_leakage_rate",
    )


def _validate_contamination_integrity(evaluation: _ArtifactEvaluation) -> None:
    if evaluation.payload is None:
        return
    temporal_integrity = _as_dict(evaluation.payload.get("temporal_integrity"))
    if (
        _coerce_evidence_bool(temporal_integrity.get("event_time_ordering_passed"))
        is not True
    ):
        evaluation.add("contamination_registry_temporal_ordering_failed")
    if (
        _coerce_evidence_bool(temporal_integrity.get("embargo_windows_enforced"))
        is not True
    ):
        evaluation.add("contamination_registry_embargo_controls_missing")

    source_lineage = _as_dict(evaluation.payload.get("source_lineage"))
    if _coerce_evidence_bool(source_lineage.get("complete")) is not True:
        evaluation.add("contamination_registry_source_lineage_incomplete")


def _validate_contamination_required_checks(
    evaluation: _ArtifactEvaluation,
    policy_payload: dict[str, Any],
) -> None:
    if evaluation.payload is None:
        return
    checks_index = {
        str(item.get("check", "")).strip(): str(item.get("status", "")).strip()
        for item in _as_list_of_dicts(evaluation.payload.get("checks"))
    }
    for required_check in _required_policy_checks(
        policy_payload,
        "promotion_contamination_required_checks",
    ):
        status_value = checks_index.get(required_check)
        if status_value is None:
            evaluation.add(
                "contamination_registry_required_check_missing",
                check=required_check,
            )
            continue
        if status_value != "pass":
            evaluation.add(
                "contamination_registry_required_check_failed",
                check=required_check,
                status=status_value,
            )


def _validate_hmm_identity(evaluation: _ArtifactEvaluation) -> None:
    if evaluation.payload is None:
        return
    if not str(evaluation.payload.get("run_id", "")).strip():
        evaluation.add("hmm_state_posterior_run_id_missing")
    if not str(evaluation.payload.get("candidate_id", "")).strip():
        evaluation.add("hmm_state_posterior_candidate_id_missing")


def _hmm_required_int(
    evaluation: _ArtifactEvaluation,
    *,
    field: str,
    missing_reason: str,
) -> int:
    value = _int_or_default(
        None if evaluation.payload is None else evaluation.payload.get(field),
        -1,
    )
    if value < 0:
        evaluation.add(missing_reason)
    return value


def _validate_hmm_sample_counts(
    evaluation: _ArtifactEvaluation,
) -> tuple[int, int, int]:
    samples_total = _hmm_required_int(
        evaluation,
        field="samples_total",
        missing_reason="hmm_state_posterior_samples_total_missing",
    )
    authoritative_samples = _hmm_required_int(
        evaluation,
        field="authoritative_samples",
        missing_reason="hmm_state_posterior_authoritative_samples_missing",
    )
    if samples_total >= 0 and authoritative_samples > samples_total:
        evaluation.add(
            "hmm_state_posterior_authoritative_samples_invalid",
            samples_total=samples_total,
            authoritative_samples=authoritative_samples,
        )

    transition_shock_samples = _hmm_required_int(
        evaluation,
        field="transition_shock_samples",
        missing_reason="hmm_state_posterior_transition_shock_samples_missing",
    )
    if samples_total >= 0 and transition_shock_samples > samples_total:
        evaluation.add(
            "hmm_state_posterior_transition_shock_samples_invalid",
            samples_total=samples_total,
            transition_shock_samples=transition_shock_samples,
        )

    stale_or_defensive_samples = _hmm_required_int(
        evaluation,
        field="stale_or_defensive_samples",
        missing_reason="hmm_state_posterior_stale_or_defensive_samples_missing",
    )
    if samples_total >= 0 and stale_or_defensive_samples > samples_total:
        evaluation.add(
            "hmm_state_posterior_stale_or_defensive_samples_invalid",
            samples_total=samples_total,
            stale_or_defensive_samples=stale_or_defensive_samples,
        )
    return samples_total, transition_shock_samples, stale_or_defensive_samples


def _validate_hmm_authoritative_ratio(
    evaluation: _ArtifactEvaluation,
    policy_payload: dict[str, Any],
) -> None:
    if evaluation.payload is None:
        return
    authoritative_ratio = _float_or_none(
        evaluation.payload.get("authoritative_sample_ratio")
    )
    if authoritative_ratio is None:
        evaluation.add("hmm_state_posterior_authoritative_ratio_missing")
        return

    minimum = _float_or_none(
        policy_payload.get("promotion_hmm_min_authoritative_sample_ratio")
    )
    if minimum is not None and authoritative_ratio < minimum:
        evaluation.add(
            "hmm_state_posterior_authoritative_ratio_below_threshold",
            actual_ratio=authoritative_ratio,
            minimum_ratio=minimum,
        )


def _validate_hmm_sample_ratios(
    evaluation: _ArtifactEvaluation,
    policy_payload: dict[str, Any],
    *,
    samples_total: int,
    transition_shock_samples: int,
    stale_or_defensive_samples: int,
) -> None:
    if samples_total <= 0:
        return
    max_transition_ratio = _float_or_none(
        policy_payload.get("promotion_hmm_max_transition_shock_ratio")
    )
    if (
        max_transition_ratio is not None
        and transition_shock_samples >= 0
        and (transition_shock_samples / samples_total) > max_transition_ratio
    ):
        evaluation.add(
            "hmm_state_posterior_transition_shock_ratio_exceeds_threshold",
            samples_total=samples_total,
            transition_shock_samples=transition_shock_samples,
            actual_ratio=transition_shock_samples / samples_total,
            maximum_ratio=max_transition_ratio,
        )

    max_defensive_ratio = _float_or_none(
        policy_payload.get("promotion_hmm_max_stale_or_defensive_ratio")
    )
    if (
        max_defensive_ratio is not None
        and stale_or_defensive_samples >= 0
        and (stale_or_defensive_samples / samples_total) > max_defensive_ratio
    ):
        evaluation.add(
            "hmm_state_posterior_stale_or_defensive_ratio_exceeds_threshold",
            samples_total=samples_total,
            stale_or_defensive_samples=stale_or_defensive_samples,
            actual_ratio=stale_or_defensive_samples / samples_total,
            maximum_ratio=max_defensive_ratio,
        )


def _validate_hmm_lineage_and_distribution(evaluation: _ArtifactEvaluation) -> None:
    if evaluation.payload is None:
        return
    source_lineage = _as_dict(evaluation.payload.get("source_lineage"))
    walkforward_ref = str(
        source_lineage.get("walkforward_results_artifact_ref") or ""
    ).strip()
    gate_policy_ref = str(source_lineage.get("gate_policy_artifact_ref") or "").strip()
    if not walkforward_ref or not gate_policy_ref:
        evaluation.add(
            "hmm_state_posterior_source_lineage_incomplete",
            walkforward_results_artifact_ref=walkforward_ref,
            gate_policy_artifact_ref=gate_policy_ref,
        )

    posterior_mass = _as_dict(evaluation.payload.get("posterior_mass_by_regime"))
    if not posterior_mass:
        evaluation.add("hmm_state_posterior_distribution_missing")


def _validate_expert_identity_and_routes(
    evaluation: _ArtifactEvaluation,
    policy_payload: dict[str, Any],
) -> None:
    if evaluation.payload is None:
        return
    if not str(evaluation.payload.get("run_id", "")).strip():
        evaluation.add("expert_router_registry_run_id_missing")
    if not str(evaluation.payload.get("candidate_id", "")).strip():
        evaluation.add("expert_router_registry_candidate_id_missing")

    minimum = max(
        1,
        _int_or_default(
            policy_payload.get("promotion_expert_router_min_route_count"),
            1,
        ),
    )
    _require_min_int_field(
        evaluation,
        field="route_count",
        minimum=minimum,
        reason="expert_router_registry_route_count_below_minimum",
        actual_key="actual_route_count",
        minimum_key="minimum_route_count",
    )


def _validate_expert_rates(
    evaluation: _ArtifactEvaluation,
    policy_payload: dict[str, Any],
) -> None:
    max_fallback_rate = _float_or_none(
        policy_payload.get("promotion_expert_router_max_fallback_rate")
    )
    if max_fallback_rate is None:
        max_fallback_rate = 0.05
    _require_float_max_field(
        evaluation,
        field="fallback_rate",
        maximum=max_fallback_rate,
        missing_reason="expert_router_registry_fallback_rate_missing",
        threshold_reason="expert_router_registry_fallback_rate_exceeds_threshold",
        actual_key="actual_fallback_rate",
        maximum_key="maximum_fallback_rate",
    )

    max_concentration = _float_or_none(
        policy_payload.get("promotion_expert_router_max_expert_concentration")
    )
    if max_concentration is None:
        max_concentration = 0.85
    _require_float_max_field(
        evaluation,
        field="max_expert_weight",
        maximum=max_concentration,
        missing_reason="expert_router_registry_max_expert_weight_missing",
        threshold_reason="expert_router_registry_expert_concentration_exceeds_threshold",
        actual_key="actual_max_expert_weight",
        maximum_key="maximum_expert_weight",
    )


def _validate_expert_slo_feedback(evaluation: _ArtifactEvaluation) -> None:
    if evaluation.payload is None:
        return
    slo_feedback = _as_dict(evaluation.payload.get("slo_feedback"))
    overall_status = str(slo_feedback.get("overall_status") or "").strip()
    if overall_status != "pass":
        evaluation.add(
            "expert_router_registry_slo_feedback_not_pass",
            overall_status=overall_status,
            slo_reasons=_list_of_strings(slo_feedback.get("reasons")),
        )


def _validate_expert_lineage(evaluation: _ArtifactEvaluation) -> None:
    if evaluation.payload is None:
        return
    source_lineage = _as_dict(evaluation.payload.get("source_lineage"))
    walkforward_ref = str(
        source_lineage.get("walkforward_results_artifact_ref") or ""
    ).strip()
    hmm_ref = str(source_lineage.get("hmm_state_posterior_artifact_ref") or "").strip()
    gate_policy_ref = str(source_lineage.get("gate_policy_artifact_ref") or "").strip()
    if not walkforward_ref or not hmm_ref or not gate_policy_ref:
        evaluation.add(
            "expert_router_registry_source_lineage_incomplete",
            walkforward_results_artifact_ref=walkforward_ref,
            hmm_state_posterior_artifact_ref=hmm_ref,
            gate_policy_artifact_ref=gate_policy_ref,
        )


def evaluate_janus_evidence(
    *,
    policy_payload: dict[str, Any],
    promotion_target: str,
    evidence: dict[str, Any],
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_janus_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []
    if not bool(policy_payload.get("promotion_require_janus_evidence", True)):
        return [], [], []
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    janus_raw = evidence.get("janus_q")
    janus = cast(dict[str, Any], janus_raw) if isinstance(janus_raw, dict) else {}
    if not janus:
        reasons.append("janus_q_evidence_missing")
        details.append({"reason": "janus_q_evidence_missing"})
        return reasons, details, refs

    _append_janus_component_evidence(
        reasons=reasons,
        details=details,
        refs=refs,
        janus=janus,
        spec=_JanusEvidenceSpec(
            component_key="event_car",
            evidence_name="janus_event_car",
            min_count_policy_key="promotion_min_janus_event_count",
            insufficient_reason="janus_event_car_evidence_insufficient",
            actual_key="actual_event_count",
            minimum_key="minimum_event_count",
        ),
        policy_payload=policy_payload,
        artifact_root=artifact_root,
        now=now,
    )

    _append_janus_component_evidence(
        reasons=reasons,
        details=details,
        refs=refs,
        janus=janus,
        spec=_JanusEvidenceSpec(
            component_key="hgrm_reward",
            evidence_name="janus_hgrm_reward",
            min_count_policy_key="promotion_min_janus_reward_count",
            insufficient_reason="janus_hgrm_reward_evidence_insufficient",
            actual_key="actual_reward_count",
            minimum_key="minimum_reward_count",
        ),
        policy_payload=policy_payload,
        artifact_root=artifact_root,
        now=now,
    )

    if not bool(janus.get("evidence_complete", False)):
        reasons.append("janus_q_evidence_incomplete")
        details.append(
            {
                "reason": "janus_q_evidence_incomplete",
                "reasons": _list_of_strings(janus.get("reasons")),
            }
        )
    return reasons, details, refs


def evaluate_contamination_registry_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_contamination_registry(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    evaluation = _artifact_evaluation_from_gate_report(
        gate_report_payload=gate_report_payload,
        evidence_key="contamination_registry",
        policy_payload=policy_payload,
        required_artifacts=_contamination_registry_required_artifact_refs(
            policy_payload
        ),
        artifact_root=artifact_root,
        invalid_ref_reason="contamination_registry_artifact_ref_invalid",
        invalid_json_reason="contamination_registry_artifact_invalid_json",
    )
    if evaluation.payload is None:
        return evaluation.result()

    _require_schema_version(
        evaluation,
        expected="contamination-leakage-report-v1",
        reason="contamination_registry_schema_version_invalid",
        expected_key="expected_schema_version",
    )
    _require_status(
        evaluation,
        expected="pass",
        reason="contamination_registry_status_not_pass",
    )
    _validate_contamination_leakage(evaluation, policy_payload)
    _validate_contamination_integrity(evaluation)
    _validate_contamination_required_checks(evaluation, policy_payload)
    _require_artifact_hash(
        evaluation,
        missing_reason="contamination_registry_artifact_hash_missing",
        mismatch_reason="contamination_registry_artifact_hash_mismatch",
    )
    return evaluation.result()


def evaluate_hmm_state_posterior_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_hmm_state_posterior(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    evaluation = _artifact_evaluation_from_gate_report(
        gate_report_payload=gate_report_payload,
        evidence_key="hmm_state_posterior",
        policy_payload=policy_payload,
        required_artifacts=_hmm_state_posterior_required_artifact_refs(policy_payload),
        artifact_root=artifact_root,
        invalid_ref_reason="hmm_state_posterior_artifact_ref_invalid",
        invalid_json_reason="hmm_state_posterior_artifact_invalid_json",
        missing_ref_reason="hmm_state_posterior_artifact_ref_missing",
    )
    if evaluation.payload is None:
        return evaluation.result()

    _require_schema_version(
        evaluation,
        expected="hmm-state-posterior-v1",
        reason="hmm_state_posterior_schema_version_invalid",
    )
    _validate_hmm_identity(evaluation)
    samples_total, transition_shock_samples, stale_or_defensive_samples = (
        _validate_hmm_sample_counts(evaluation)
    )
    _validate_hmm_authoritative_ratio(evaluation, policy_payload)
    _validate_hmm_sample_ratios(
        evaluation,
        policy_payload,
        samples_total=samples_total,
        transition_shock_samples=transition_shock_samples,
        stale_or_defensive_samples=stale_or_defensive_samples,
    )
    _validate_hmm_lineage_and_distribution(evaluation)
    _require_artifact_hash(
        evaluation,
        missing_reason="hmm_state_posterior_artifact_hash_missing",
        mismatch_reason="hmm_state_posterior_artifact_hash_mismatch",
    )
    return evaluation.result()


def evaluate_expert_router_registry_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    if not _requires_expert_router_registry(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    ):
        return [], [], []

    evaluation = _artifact_evaluation_from_gate_report(
        gate_report_payload=gate_report_payload,
        evidence_key="expert_router_registry",
        policy_payload=policy_payload,
        required_artifacts=_expert_router_required_artifact_refs(policy_payload),
        artifact_root=artifact_root,
        invalid_ref_reason="expert_router_registry_artifact_ref_invalid",
        invalid_json_reason="expert_router_registry_artifact_invalid_json",
        missing_ref_reason="expert_router_registry_artifact_ref_missing",
    )
    if evaluation.payload is None:
        return evaluation.result()

    _require_schema_version(
        evaluation,
        expected="expert-router-registry-v1",
        reason="expert_router_registry_schema_version_invalid",
        expected_key="expected_schema_version",
    )
    _validate_expert_identity_and_routes(evaluation, policy_payload)
    _validate_expert_rates(evaluation, policy_payload)
    _validate_expert_slo_feedback(evaluation)
    _validate_expert_lineage(evaluation)
    _require_artifact_hash(
        evaluation,
        missing_reason="expert_router_registry_artifact_hash_missing",
        mismatch_reason="expert_router_registry_artifact_hash_mismatch",
    )
    return evaluation.result()
