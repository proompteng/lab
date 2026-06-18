"""Profitability manifest and prerequisite evidence checks."""

from __future__ import annotations

from .common import (
    Any,
    NON_AUTHORITATIVE_PROVENANCE,
    Path,
    PROFITABILITY_STAGE_ORDER as _PROFITABILITY_STAGE_ORDER,
    PROFITABILITY_STAGE_REQUIRED_CHECKS as _PROFITABILITY_STAGE_REQUIRED_CHECKS,
    contract_from_artifact_payload,
    parse_evidence_contract,
    urlparse,
)
from .requirements import (
    as_dict as _as_dict,
    as_list_of_dicts as _as_list_of_dicts,
    benchmark_parity_artifact_candidates as _benchmark_parity_artifact_candidates,
    benchmark_parity_artifact_reference as _benchmark_parity_artifact_reference,
    int_or_default as _int_or_default,
    list_count as _list_count,
    list_of_strings as _list_of_strings,
    load_json_if_exists as _load_json_if_exists,
    normalize_artifact_path as _normalize_artifact_path,
    regime_slice_count as _regime_slice_count,
    sha256_json as _sha256_json,
    sha256_path as _sha256_path,
)


def _append_profitability_stage_manifest_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    manifest_relpath = str(
        policy_payload.get(
            "promotion_profitability_stage_manifest_artifact",
            "profitability/profitability-stage-manifest-v1.json",
        )
    )
    manifest_path = artifact_root / manifest_relpath
    manifest_payload = _load_json_if_exists(manifest_path)
    if manifest_payload is None:
        if manifest_path.exists():
            reasons.append("profitability_stage_manifest_invalid_json")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_invalid_json",
                    "artifact_ref": str(manifest_path),
                }
            )
        else:
            reasons.append("profitability_stage_manifest_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_missing",
                    "artifact_ref": str(manifest_path),
                }
            )
        return

    schema_version = str(manifest_payload.get("schema_version", "")).strip()
    if schema_version != "profitability-stage-manifest-v1":
        reasons.append("profitability_stage_manifest_schema_version_invalid")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_schema_version_invalid",
                "artifact_ref": str(manifest_path),
                "schema_version": schema_version,
            }
        )

    candidate_id = str(manifest_payload.get("candidate_id", "")).strip()
    if not candidate_id:
        reasons.append("profitability_stage_manifest_candidate_id_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_candidate_id_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    strategy_family = str(manifest_payload.get("strategy_family", "")).strip()
    if not strategy_family:
        reasons.append("profitability_stage_manifest_strategy_family_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_strategy_family_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    run_context = _as_dict(manifest_payload.get("run_context"))
    if not run_context:
        reasons.append("profitability_stage_manifest_run_context_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_run_context_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    elif not run_context.get("run_id"):
        reasons.append("profitability_stage_manifest_run_context_incomplete")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_run_context_incomplete",
                "artifact_ref": str(manifest_path),
            }
        )
    elif not str(run_context.get("design_doc", "")).strip():
        reasons.append("profitability_stage_manifest_design_doc_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_design_doc_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    else:
        design_doc = str(run_context.get("design_doc", "")).strip()
        if not _is_valid_design_doc_reference(design_doc):
            reasons.append("profitability_stage_manifest_design_doc_invalid")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_design_doc_invalid",
                    "artifact_ref": str(manifest_path),
                    "design_doc": design_doc,
                }
            )

    stages_raw = manifest_payload.get("stages")
    stages = _as_dict(stages_raw)
    if not stages:
        reasons.append("profitability_stage_manifest_stages_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_stages_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    else:
        stage_names = tuple(
            name for name in _PROFITABILITY_STAGE_ORDER if name in stages
        )
        required_stage_names = _PROFITABILITY_STAGE_ORDER
        if stage_names != required_stage_names:
            reasons.append("profitability_stage_manifest_stage_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_stage_missing",
                    "artifact_ref": str(manifest_path),
                    "stages_present": sorted(stages.keys()),
                }
            )
        if set(stages) != set(required_stage_names):
            reasons.append("profitability_stage_manifest_stage_set_invalid")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_stage_set_invalid",
                    "artifact_ref": str(manifest_path),
                    "expected_stages": list(required_stage_names),
                    "actual_stages": sorted(stages.keys()),
                }
            )
        for stage_name in required_stage_names:
            stage_payload = _as_dict(stages.get(stage_name))
            if not stage_payload:
                reasons.append("profitability_stage_manifest_stage_missing")
                reason_details.append(
                    {
                        "reason": "profitability_stage_manifest_stage_missing",
                        "artifact_ref": str(manifest_path),
                        "stage": stage_name,
                    }
                )
                continue

            status = str(stage_payload.get("status", "")).strip()
            if status not in {"pass", "fail"}:
                reasons.append("profitability_stage_manifest_stage_status_invalid")
                reason_details.append(
                    {
                        "reason": "profitability_stage_manifest_stage_status_invalid",
                        "artifact_ref": str(manifest_path),
                        "stage": stage_name,
                        "status": status,
                    }
                )
            for required_key in ("checks", "artifacts", "owner", "completed_at_utc"):
                if required_key not in stage_payload:
                    reasons.append(
                        "profitability_stage_manifest_stage_structure_invalid"
                    )
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_stage_structure_invalid",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "required_key": required_key,
                        }
                    )
            checks_payload = _as_list_of_dicts(stage_payload.get("checks"))
            stage_checks: dict[str, str] = {}
            for item in checks_payload:
                check_name = str(item.get("check", "")).strip()
                if not check_name:
                    reasons.append("profitability_stage_manifest_stage_check_invalid")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_stage_check_invalid",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                        }
                    )
                    continue
                check_status = str(item.get("status", "")).strip()
                if check_status not in {"pass", "fail"}:
                    reasons.append(
                        "profitability_stage_manifest_stage_check_status_invalid"
                    )
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_stage_check_status_invalid",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "check": check_name,
                        }
                    )
                    continue
                stage_checks[check_name] = check_status
            required_checks = list(
                _PROFITABILITY_STAGE_REQUIRED_CHECKS.get(stage_name, ())
            )
            if stage_name == "execution" and not bool(
                policy_payload.get("promotion_require_expert_router_registry", False)
            ):
                required_checks = [
                    check
                    for check in required_checks
                    if check != "expert_router_registry_present"
                ]
            for required_check in required_checks:
                if required_check not in stage_checks:
                    reasons.append(
                        "profitability_stage_manifest_required_check_missing"
                    )
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_required_check_missing",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "check": required_check,
                        }
                    )
                    continue
                if stage_checks[required_check] != "pass":
                    reasons.append("profitability_stage_manifest_required_check_failed")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_required_check_failed",
                            "artifact_ref": str(manifest_path),
                            "stage": stage_name,
                            "check": required_check,
                        }
                    )
            artifacts = _as_dict(stage_payload.get("artifacts"))
            if not artifacts:
                continue
            for artifact_payload_raw in artifacts.values():
                artifact_payload = _as_dict(artifact_payload_raw)
                artifact_ref = str(artifact_payload.get("path", "")).strip()
                if not artifact_ref:
                    continue
                expected_sha = str(artifact_payload.get("sha256", "")).strip()
                artifact_file = artifact_root / artifact_ref
                if not artifact_file.exists():
                    reasons.append("profitability_stage_manifest_artifact_missing")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_artifact_missing",
                            "artifact_ref": str(artifact_file),
                            "stage": stage_name,
                        }
                    )
                    continue
                authority_payload = _as_dict(artifact_payload.get("artifact_authority"))
                if not authority_payload:
                    authority_payload = contract_from_artifact_payload(
                        _load_json_if_exists(artifact_file)
                    )
                if stage_name in {"validation", "execution"}:
                    if not authority_payload:
                        reasons.append(
                            "profitability_stage_manifest_artifact_authority_missing"
                        )
                        reason_details.append(
                            {
                                "reason": "profitability_stage_manifest_artifact_authority_missing",
                                "artifact_ref": str(artifact_file),
                                "stage": stage_name,
                            }
                        )
                    else:
                        normalized_contract = parse_evidence_contract(authority_payload)
                        provenance = str(
                            normalized_contract.get("provenance", "")
                        ).strip()
                        if provenance in {
                            item.value for item in NON_AUTHORITATIVE_PROVENANCE
                        }:
                            reasons.append(
                                "profitability_stage_manifest_artifact_non_authoritative"
                            )
                            reason_details.append(
                                {
                                    "reason": "profitability_stage_manifest_artifact_non_authoritative",
                                    "artifact_ref": str(artifact_file),
                                    "stage": stage_name,
                                    "provenance": provenance,
                                    "maturity": normalized_contract.get("maturity"),
                                }
                            )
                        if not bool(normalized_contract.get("authoritative", False)):
                            reasons.append(
                                "profitability_stage_manifest_artifact_authoritative_flag_false"
                            )
                            reason_details.append(
                                {
                                    "reason": "profitability_stage_manifest_artifact_authoritative_flag_false",
                                    "artifact_ref": str(artifact_file),
                                    "stage": stage_name,
                                    "provenance": provenance,
                                }
                            )
                if (
                    artifact_file.suffix.lower() == ".json"
                    and _load_json_if_exists(artifact_file) is None
                ):
                    reasons.append("profitability_stage_manifest_artifact_invalid_json")
                    reason_details.append(
                        {
                            "reason": "profitability_stage_manifest_artifact_invalid_json",
                            "artifact_ref": str(artifact_file),
                            "stage": stage_name,
                        }
                    )
                if expected_sha:
                    actual_sha = _sha256_path(artifact_file)
                    if expected_sha != actual_sha:
                        reasons.append(
                            "profitability_stage_manifest_artifact_hash_mismatch"
                        )
                        reason_details.append(
                            {
                                "reason": "profitability_stage_manifest_artifact_hash_mismatch",
                                "artifact_ref": str(artifact_file),
                                "stage": stage_name,
                                "expected_sha256": expected_sha,
                                "actual_sha256": actual_sha,
                            }
                        )

    if bool(
        policy_payload.get(
            "promotion_require_profitability_stage_replay_contract", False
        )
    ):
        _append_profitability_stage_manifest_replay_contract_reasons(
            reasons=reasons,
            reason_details=reason_details,
            manifest_payload=manifest_payload,
            manifest_path=manifest_path,
            stages=stages,
        )

    rollback_contract = manifest_payload.get("rollback_contract_ref")
    if not rollback_contract:
        reasons.append("profitability_stage_manifest_rollback_contract_ref_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_rollback_contract_ref_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    content_hash = str(manifest_payload.get("content_hash", "")).strip()
    if not content_hash:
        reasons.append("profitability_stage_manifest_content_hash_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_content_hash_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    else:
        content_hash_payload = dict(manifest_payload)
        content_hash_payload.pop("content_hash", None)
        expected_content_hash = _sha256_json(content_hash_payload)
        if content_hash != expected_content_hash:
            reasons.append("profitability_stage_manifest_content_hash_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_content_hash_mismatch",
                    "artifact_ref": str(manifest_path),
                    "content_hash": content_hash,
                    "expected_content_hash": expected_content_hash,
                }
            )

    overall_status = str(manifest_payload.get("overall_status", "")).strip()
    if overall_status not in {"pass", "fail"}:
        reasons.append("profitability_stage_manifest_overall_status_invalid")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_overall_status_invalid",
                "artifact_ref": str(manifest_path),
                "overall_status": overall_status,
            }
        )

    failure_reasons = _list_of_strings(manifest_payload.get("failure_reasons"))
    if overall_status == "fail":
        if not failure_reasons:
            reasons.append("profitability_stage_manifest_failure_reasons_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_failure_reasons_missing",
                    "artifact_ref": str(manifest_path),
                }
            )

    if overall_status in {"pass", "fail"} and stages:
        stage_statuses: list[bool] = []
        for stage_name in _PROFITABILITY_STAGE_ORDER:
            stage_payload = _as_dict(stages.get(stage_name))
            stage_statuses.append(
                str(stage_payload.get("status", "")).strip() == "pass"
            )
        expected_overall_status = "pass" if all(stage_statuses) else "fail"
        if overall_status != expected_overall_status:
            reasons.append("profitability_stage_manifest_overall_status_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_overall_status_mismatch",
                    "artifact_ref": str(manifest_path),
                    "overall_status": overall_status,
                    "calculated_overall_status": expected_overall_status,
                }
            )
    ordered_stages = _PROFITABILITY_STAGE_ORDER
    failure_encountered = False
    for stage_name in ordered_stages:
        stage_payload = _as_dict(stages.get(stage_name))
        stage_status = str(stage_payload.get("status", "")).strip()
        if stage_status != "pass":
            failure_encountered = True
            continue
        if failure_encountered:
            reasons.append("profitability_stage_manifest_stage_transition_violation")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_stage_transition_violation",
                    "artifact_ref": str(manifest_path),
                    "stage": stage_name,
                }
            )
            break
    if overall_status == "fail":
        reasons.append("profitability_stage_manifest_stage_chain_not_passed")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_stage_chain_not_passed",
                "artifact_ref": str(manifest_path),
                "failure_reasons": failure_reasons,
            }
        )


def _append_portfolio_optimizer_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    evidence_relpath = str(
        policy_payload.get(
            "promotion_portfolio_optimizer_evidence_artifact",
            "promotion/portfolio-optimizer-evidence.json",
        )
    )
    evidence_path = artifact_root / evidence_relpath
    evidence_payload = _load_json_if_exists(evidence_path)
    if evidence_payload is None:
        reason = (
            "portfolio_optimizer_evidence_invalid_json"
            if evidence_path.exists()
            else "portfolio_optimizer_evidence_missing"
        )
        reasons.append(reason)
        reason_details.append({"reason": reason, "artifact_ref": str(evidence_path)})
        return

    schema_version = str(evidence_payload.get("schema_version", "")).strip()
    if schema_version != "torghut.portfolio-optimizer-evidence.v1":
        reasons.append("portfolio_optimizer_evidence_schema_invalid")
        reason_details.append(
            {
                "reason": "portfolio_optimizer_evidence_schema_invalid",
                "artifact_ref": str(evidence_path),
                "schema_version": schema_version,
            }
        )
    if not str(evidence_payload.get("portfolio_candidate_id", "")).strip():
        reasons.append("portfolio_optimizer_evidence_candidate_id_missing")
        reason_details.append(
            {
                "reason": "portfolio_optimizer_evidence_candidate_id_missing",
                "artifact_ref": str(evidence_path),
            }
        )
    if _int_or_default(evidence_payload.get("sleeve_count"), 0) < 2:
        reasons.append("portfolio_optimizer_evidence_sleeve_count_insufficient")
        reason_details.append(
            {
                "reason": "portfolio_optimizer_evidence_sleeve_count_insufficient",
                "artifact_ref": str(evidence_path),
                "sleeve_count": _int_or_default(
                    evidence_payload.get("sleeve_count"), 0
                ),
            }
        )
    if not _as_dict(evidence_payload.get("optimizer_report")):
        reasons.append("portfolio_optimizer_report_missing")
        reason_details.append(
            {
                "reason": "portfolio_optimizer_report_missing",
                "artifact_ref": str(evidence_path),
            }
        )
    if not _as_dict(evidence_payload.get("objective_scorecard")):
        reasons.append("portfolio_optimizer_scorecard_missing")
        reason_details.append(
            {
                "reason": "portfolio_optimizer_scorecard_missing",
                "artifact_ref": str(evidence_path),
            }
        )
    if not bool(evidence_payload.get("target_met", False)):
        reasons.append("portfolio_optimizer_target_not_met")
        reason_details.append(
            {
                "reason": "portfolio_optimizer_target_not_met",
                "artifact_ref": str(evidence_path),
            }
        )
    if not bool(evidence_payload.get("oracle_passed", False)):
        reasons.append("portfolio_optimizer_oracle_not_passed")
        reason_details.append(
            {
                "reason": "portfolio_optimizer_oracle_not_passed",
                "artifact_ref": str(evidence_path),
            }
        )


def _is_valid_design_doc_reference(value: str) -> bool:
    value = value.strip()
    if not value:
        return False
    if value.startswith(("docs/", "./docs/")) and value.lower().endswith(".md"):
        return True

    parsed = urlparse(value)
    if (
        parsed.scheme.lower() in {"http", "https"}
        and parsed.netloc
        and parsed.path
        and parsed.path.lower().endswith(".md")
    ):
        return True

    return False


def _append_profitability_stage_manifest_replay_contract_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    manifest_payload: dict[str, Any],
    manifest_path: Path,
    stages: dict[str, Any],
) -> None:
    replay_contract = _as_dict(manifest_payload.get("replay_contract"))
    if not replay_contract:
        reasons.append("profitability_stage_manifest_replay_contract_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_replay_contract_missing",
                "artifact_ref": str(manifest_path),
            }
        )
        return

    artifact_hashes_raw = _as_dict(replay_contract.get("artifact_hashes"))
    artifact_hashes = {
        str(key).strip(): str(value).strip()
        for key, value in artifact_hashes_raw.items()
        if str(key).strip() and str(value).strip()
    }
    if not artifact_hashes:
        reasons.append("profitability_stage_manifest_replay_artifact_hashes_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_replay_artifact_hashes_missing",
                "artifact_ref": str(manifest_path),
            }
        )

    contract_hash = str(replay_contract.get("contract_hash", "")).strip()
    if not contract_hash:
        reasons.append("profitability_stage_manifest_replay_contract_hash_missing")
        reason_details.append(
            {
                "reason": "profitability_stage_manifest_replay_contract_hash_missing",
                "artifact_ref": str(manifest_path),
            }
        )
    else:
        expected_contract_hash = _sha256_json({"artifact_hashes": artifact_hashes})
        if contract_hash != expected_contract_hash:
            reasons.append("profitability_stage_manifest_replay_contract_hash_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_replay_contract_hash_mismatch",
                    "artifact_ref": str(manifest_path),
                    "contract_hash": contract_hash,
                    "expected_contract_hash": expected_contract_hash,
                }
            )

    expected_stage_artifact_hashes: dict[str, str] = {}
    for stage_name in _PROFITABILITY_STAGE_ORDER:
        stage_payload = _as_dict(stages.get(stage_name))
        stage_artifacts = _as_dict(stage_payload.get("artifacts"))
        for artifact_payload_raw in stage_artifacts.values():
            artifact_payload = _as_dict(artifact_payload_raw)
            artifact_ref = str(artifact_payload.get("path", "")).strip()
            expected_sha = str(artifact_payload.get("sha256", "")).strip()
            if not artifact_ref or not expected_sha:
                continue
            expected_stage_artifact_hashes[artifact_ref] = expected_sha

    for artifact_ref, expected_sha in sorted(expected_stage_artifact_hashes.items()):
        replay_sha = artifact_hashes.get(artifact_ref, "")
        if not replay_sha:
            reasons.append("profitability_stage_manifest_replay_artifact_hash_missing")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_replay_artifact_hash_missing",
                    "artifact_ref": str(manifest_path),
                    "stage_artifact_ref": artifact_ref,
                }
            )
            continue
        if replay_sha != expected_sha:
            reasons.append("profitability_stage_manifest_replay_artifact_hash_mismatch")
            reason_details.append(
                {
                    "reason": "profitability_stage_manifest_replay_artifact_hash_mismatch",
                    "artifact_ref": str(manifest_path),
                    "stage_artifact_ref": artifact_ref,
                    "replay_sha256": replay_sha,
                    "expected_sha256": expected_sha,
                }
            )


def _append_profitability_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    evidence_validation_relpath = str(
        policy_payload.get(
            "promotion_profitability_validation_artifact",
            "gates/profitability-evidence-validation.json",
        )
    )
    evidence_validation_path = artifact_root / evidence_validation_relpath
    evidence_validation_payload = _load_json_if_exists(evidence_validation_path)
    if evidence_validation_payload is None:
        reasons.append("profitability_evidence_validation_missing")
        reason_details.append(
            {
                "reason": "profitability_evidence_validation_missing",
                "artifact_ref": str(evidence_validation_path),
            }
        )
    elif not bool(evidence_validation_payload.get("passed", False)):
        reasons.append("profitability_evidence_validation_failed")
        reason_details.append(
            {
                "reason": "profitability_evidence_validation_failed",
                "artifact_ref": str(evidence_validation_path),
                "validation_reasons": _list_of_strings(
                    evidence_validation_payload.get("reasons")
                ),
            }
        )

    benchmark_relpath = str(
        policy_payload.get(
            "promotion_profitability_benchmark_artifact",
            "gates/profitability-benchmark-v4.json",
        )
    )
    benchmark_path = artifact_root / benchmark_relpath
    benchmark_payload = _load_json_if_exists(benchmark_path)
    minimum_regime_slices = int(
        policy_payload.get("promotion_profitability_min_regime_slices", 1)
    )
    if benchmark_payload is None:
        reasons.append("profitability_benchmark_missing")
        reason_details.append(
            {
                "reason": "profitability_benchmark_missing",
                "artifact_ref": str(benchmark_path),
            }
        )
        return

    regime_slices = _regime_slice_count(benchmark_payload)
    if regime_slices < minimum_regime_slices:
        reasons.append("profitability_benchmark_regime_coverage_insufficient")
        reason_details.append(
            {
                "reason": "profitability_benchmark_regime_coverage_insufficient",
                "artifact_ref": str(benchmark_path),
                "actual_regime_slices": regime_slices,
                "minimum_regime_slices": minimum_regime_slices,
            }
        )


def _append_janus_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    event_path = artifact_root / str(
        policy_payload.get(
            "promotion_janus_event_car_artifact", "gates/janus-event-car-v1.json"
        )
    )
    event_payload = _load_json_if_exists(event_path)
    if event_payload is None:
        reasons.append("janus_event_car_artifact_missing")
        reason_details.append(
            {
                "reason": "janus_event_car_artifact_missing",
                "artifact_ref": str(event_path),
            }
        )
    else:
        if str(event_payload.get("schema_version", "")).strip() != "janus-event-car-v1":
            reasons.append("janus_event_car_schema_invalid")
            reason_details.append(
                {
                    "reason": "janus_event_car_schema_invalid",
                    "artifact_ref": str(event_path),
                    "expected": "janus-event-car-v1",
                }
            )
        event_count = _int_or_default(
            _as_dict(event_payload.get("summary")).get("event_count"),
            _list_count(event_payload.get("records")),
        )
        min_event_count = max(
            1, _int_or_default(policy_payload.get("promotion_min_janus_event_count"), 1)
        )
        if event_count < min_event_count:
            reasons.append("janus_event_car_count_below_minimum")
            reason_details.append(
                {
                    "reason": "janus_event_car_count_below_minimum",
                    "artifact_ref": str(event_path),
                    "actual_event_count": event_count,
                    "minimum_event_count": min_event_count,
                }
            )

    reward_path = artifact_root / str(
        policy_payload.get(
            "promotion_janus_hgrm_reward_artifact", "gates/janus-hgrm-reward-v1.json"
        )
    )
    reward_payload = _load_json_if_exists(reward_path)
    if reward_payload is None:
        reasons.append("janus_hgrm_reward_artifact_missing")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_artifact_missing",
                "artifact_ref": str(reward_path),
            }
        )
        return

    if str(reward_payload.get("schema_version", "")).strip() != "janus-hgrm-reward-v1":
        reasons.append("janus_hgrm_reward_schema_invalid")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_schema_invalid",
                "artifact_ref": str(reward_path),
                "expected": "janus-hgrm-reward-v1",
            }
        )
    reward_count = _int_or_default(
        _as_dict(reward_payload.get("summary")).get("reward_count"),
        _list_count(reward_payload.get("rewards")),
    )
    min_reward_count = max(
        1, _int_or_default(policy_payload.get("promotion_min_janus_reward_count"), 1)
    )
    if reward_count < min_reward_count:
        reasons.append("janus_hgrm_reward_count_below_minimum")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_count_below_minimum",
                "artifact_ref": str(reward_path),
                "actual_reward_count": reward_count,
                "minimum_reward_count": min_reward_count,
            }
        )


def _append_benchmark_parity_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    evidence = _as_dict(gate_report_payload.get("promotion_evidence"))
    benchmark_payload = _as_dict(evidence.get("benchmark_parity"))
    evidence_ref = str(benchmark_payload.get("artifact_ref") or "").strip()
    artifact_ref = _benchmark_parity_artifact_reference(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
    )
    candidate_paths = [
        _normalize_artifact_path(candidate_ref, artifact_root=artifact_root)
        for candidate_ref in _benchmark_parity_artifact_candidates(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
        )
    ]
    artifact_path = next(
        (path for path in candidate_paths if path is not None and path.exists()), None
    )
    if artifact_path is None and evidence_ref:
        artifact_path = _normalize_artifact_path(
            evidence_ref, artifact_root=artifact_root
        )
    if artifact_path is None:
        if evidence_ref:
            reasons.append("benchmark_parity_artifact_ref_invalid")
            reason_details.append(
                {
                    "reason": "benchmark_parity_artifact_ref_invalid",
                    "artifact_ref": evidence_ref,
                }
            )
        else:
            reasons.append("benchmark_parity_artifact_ref_invalid")
            reason_details.append(
                {
                    "reason": "benchmark_parity_artifact_ref_invalid",
                    "artifact_ref": artifact_ref,
                }
            )
        return
    parity_path = artifact_path
    if not parity_path.exists():
        reasons.append("benchmark_parity_artifact_missing")
        reason_details.append(
            {
                "reason": "benchmark_parity_artifact_missing",
                "artifact_ref": str(parity_path),
            }
        )
        return
    if _load_json_if_exists(parity_path) is None:
        reasons.append("benchmark_parity_artifact_invalid_json")
        reason_details.append(
            {
                "reason": "benchmark_parity_artifact_invalid_json",
                "artifact_ref": str(parity_path),
            }
        )


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
append_benchmark_parity_evidence_reasons = _append_benchmark_parity_evidence_reasons
append_janus_evidence_reasons = _append_janus_evidence_reasons
append_portfolio_optimizer_evidence_reasons = (
    _append_portfolio_optimizer_evidence_reasons
)
append_profitability_evidence_reasons = _append_profitability_evidence_reasons
append_profitability_stage_manifest_reasons = (
    _append_profitability_stage_manifest_reasons
)
