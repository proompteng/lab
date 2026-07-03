"""Profitability manifest and prerequisite evidence checks."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .common import (
    NON_AUTHORITATIVE_PROVENANCE,
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


@dataclass
class _ValidationContext:
    """Mutable validation state collected during manifest inspection."""

    reasons: list[str]
    reason_details: list[dict[str, object]]


def _add_reason(ctx: _ValidationContext, reason: str, detail: dict[str, object]) -> None:
    ctx.reasons.append(reason)
    ctx.reason_details.append(detail)


def _add_manifest_reason(ctx: _ValidationContext, reason: str, artifact_ref: str, **fields: object) -> None:
    detail: dict[str, object] = {"reason": reason, "artifact_ref": artifact_ref}
    detail.update(fields)
    _add_reason(ctx, reason, detail)


# ---------------------------------------------------------------------------
# Top-level manifest field validators
# ---------------------------------------------------------------------------

def _validate_manifest_top_level(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    manifest_path: Path,
) -> None:
    """Validate manifest schema version, IDs, run context, and content hash."""

    schema_version = str(manifest_payload.get("schema_version", "")).strip()
    if schema_version != "profitability-stage-manifest-v1":
        _add_manifest_reason(ctx, "profitability_stage_manifest_schema_version_invalid", str(manifest_path), schema_version=schema_version)

    candidate_id = str(manifest_payload.get("candidate_id", "")).strip()
    if not candidate_id:
        _add_manifest_reason(ctx, "profitability_stage_manifest_candidate_id_missing", str(manifest_path))

    strategy_family = str(manifest_payload.get("strategy_family", "")).strip()
    if not strategy_family:
        _add_manifest_reason(ctx, "profitability_stage_manifest_strategy_family_missing", str(manifest_path))

    _validate_run_context(ctx, manifest_payload, manifest_path)
    _validate_content_hash(ctx, manifest_payload, manifest_path)


def _validate_run_context(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    manifest_path: Path,
) -> None:
    run_context = _as_dict(manifest_payload.get("run_context"))
    if not run_context:
        _add_manifest_reason(ctx, "profitability_stage_manifest_run_context_missing", str(manifest_path))
    elif not run_context.get("run_id"):
        _add_manifest_reason(ctx, "profitability_stage_manifest_run_context_incomplete", str(manifest_path))
    elif not str(run_context.get("design_doc", "")).strip():
        _add_manifest_reason(ctx, "profitability_stage_manifest_design_doc_missing", str(manifest_path))
    else:
        design_doc = str(run_context.get("design_doc", "")).strip()
        if not _is_valid_design_doc_reference(design_doc):
            _add_manifest_reason(ctx, "profitability_stage_manifest_design_doc_invalid", str(manifest_path), design_doc=design_doc)


def _validate_content_hash(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    manifest_path: Path,
) -> None:
    content_hash = str(manifest_payload.get("content_hash", "")).strip()
    if not content_hash:
        _add_manifest_reason(ctx, "profitability_stage_manifest_content_hash_missing", str(manifest_path))
    else:
        content_hash_payload = dict(manifest_payload)
        content_hash_payload.pop("content_hash", None)
        expected_content_hash = _sha256_json(content_hash_payload)
        if content_hash != expected_content_hash:
            _add_manifest_reason(ctx, "profitability_stage_manifest_content_hash_mismatch", str(manifest_path), content_hash=content_hash, expected_content_hash=expected_content_hash)


# ---------------------------------------------------------------------------
# Stages validation
# ---------------------------------------------------------------------------

def _validate_stages(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    manifest_path: Path,
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> dict[str, Any] | None:
    """Validate stages presence, order, status, checks, and artifacts. Returns stages dict."""
    stages_raw = manifest_payload.get("stages")
    stages = _as_dict(stages_raw)
    if not stages:
        _add_manifest_reason(ctx, "profitability_stage_manifest_stages_missing", str(manifest_path))
        return None

    _validate_stage_names(ctx, stages, manifest_path)
    _validate_stage_payloads(ctx, stages, manifest_path)
    _validate_stage_checks(ctx, stages, manifest_path, policy_payload)
    _validate_stage_artifacts(ctx, stages, manifest_path, policy_payload, artifact_root)
    return stages


def _validate_stage_names(ctx: _ValidationContext, stages: dict[str, Any], manifest_path: Path) -> None:
    stage_names = tuple(name for name in _PROFITABILITY_STAGE_ORDER if name in stages)
    if stage_names != _PROFITABILITY_STAGE_ORDER:
        _add_manifest_reason(ctx, "profitability_stage_manifest_stage_missing", str(manifest_path), stages_present=sorted(stages.keys()))
    if set(stages) != set(_PROFITABILITY_STAGE_ORDER):
        _add_manifest_reason(ctx, "profitability_stage_manifest_stage_set_invalid", str(manifest_path), expected_stages=list(_PROFITABILITY_STAGE_ORDER), actual_stages=sorted(stages.keys()))


def _validate_stage_payloads(ctx: _ValidationContext, stages: dict[str, Any], manifest_path: Path) -> None:
    for stage_name in _PROFITABILITY_STAGE_ORDER:
        stage_payload = _as_dict(stages.get(stage_name))
        if not stage_payload:
            _add_manifest_reason(ctx, "profitability_stage_manifest_stage_missing", str(manifest_path), stage=stage_name)
            continue

        status = str(stage_payload.get("status", "")).strip()
        if status not in {"pass", "fail"}:
            _add_manifest_reason(ctx, "profitability_stage_manifest_stage_status_invalid", str(manifest_path), stage=stage_name, status=status)

        for required_key in ("checks", "artifacts", "owner", "completed_at_utc"):
            if required_key not in stage_payload:
                _add_manifest_reason(ctx, "profitability_stage_manifest_stage_structure_invalid", str(manifest_path), stage=stage_name, required_key=required_key)


def _validate_stage_checks(
    ctx: _ValidationContext,
    stages: dict[str, Any],
    manifest_path: Path,
    policy_payload: dict[str, Any],
) -> None:
    for stage_name in _PROFITABILITY_STAGE_ORDER:
        stage_payload = _as_dict(stages.get(stage_name))
        if not stage_payload:
            continue

        required_checks = list(_PROFITABILITY_STAGE_REQUIRED_CHECKS.get(stage_name, ()))
        if stage_name == "execution" and not bool(policy_payload.get("promotion_require_expert_router_registry", False)):
            required_checks = [check for check in required_checks if check != "expert_router_registry_present"]

        checks_payload = _as_list_of_dicts(stage_payload.get("checks"))
        stage_checks: dict[str, str] = {}

        for item in checks_payload:
            check_name = str(item.get("check", "")).strip()
            if not check_name:
                _add_manifest_reason(ctx, "profitability_stage_manifest_stage_check_invalid", str(manifest_path), stage=stage_name)
                continue
            check_status = str(item.get("status", "")).strip()
            if check_status not in {"pass", "fail"}:
                _add_manifest_reason(ctx, "profitability_stage_manifest_stage_check_status_invalid", str(manifest_path), stage=stage_name, check=check_name)
                continue
            stage_checks[check_name] = check_status

        for required_check in required_checks:
            if required_check not in stage_checks:
                _add_manifest_reason(ctx, "profitability_stage_manifest_required_check_missing", str(manifest_path), stage=stage_name, check=required_check)
                continue
            if stage_checks[required_check] != "pass":
                _add_manifest_reason(ctx, "profitability_stage_manifest_required_check_failed", str(manifest_path), stage=stage_name, check=required_check)


def _validate_stage_artifacts(
    ctx: _ValidationContext,
    stages: dict[str, Any],
    manifest_path: Path,
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    for stage_name in _PROFITABILITY_STAGE_ORDER:
        stage_payload = _as_dict(stages.get(stage_name))
        if not stage_payload:
            continue
        artifacts = _as_dict(stage_payload.get("artifacts"))
        if not artifacts:
            continue

        for artifact_payload_raw in artifacts.values():
            artifact_payload = _as_dict(artifact_payload_raw)
            artifact_ref = str(artifact_payload.get("path", "")).strip()
            if not artifact_ref:
                continue
            _validate_single_artifact(ctx, artifact_payload, artifact_ref, manifest_path, stage_name, stage_name in {"validation", "execution"}, policy_payload, artifact_root)


def _validate_single_artifact(
    ctx: _ValidationContext,
    artifact_payload: dict[str, Any],
    artifact_ref: str,
    manifest_path: Path,
    stage_name: str,
    require_authority: bool,
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    artifact_file = artifact_root / artifact_ref
    if not artifact_file.exists():
        _add_manifest_reason(ctx, "profitability_stage_manifest_artifact_missing", str(artifact_file), stage=stage_name)
        return

    authority_payload = _as_dict(artifact_payload.get("artifact_authority"))
    if not authority_payload:
        authority_payload = contract_from_artifact_payload(_load_json_if_exists(artifact_file))

    if require_authority:
        if not authority_payload:
            _add_manifest_reason(ctx, "profitability_stage_manifest_artifact_authority_missing", str(artifact_file), stage=stage_name)
        else:
            _validate_artifact_authority(ctx, authority_payload, artifact_file, stage_name, manifest_path)

    if artifact_file.suffix.lower() == ".json" and _load_json_if_exists(artifact_file) is None:
        _add_manifest_reason(ctx, "profitability_stage_manifest_artifact_invalid_json", str(artifact_file), stage=stage_name)

    expected_sha = str(artifact_payload.get("sha256", "")).strip()
    if expected_sha:
        actual_sha = _sha256_path(artifact_file)
        if expected_sha != actual_sha:
            _add_manifest_reason(ctx, "profitability_stage_manifest_artifact_hash_mismatch", str(artifact_file), stage=stage_name, expected_sha256=expected_sha, actual_sha256=actual_sha)


def _validate_artifact_authority(
    ctx: _ValidationContext,
    authority_payload: dict[str, Any],
    artifact_file: Path,
    stage_name: str,
    manifest_path: Path,
) -> None:
    normalized_contract = parse_evidence_contract(authority_payload)
    provenance = str(normalized_contract.get("provenance", "")).strip()
    if provenance in {item.value for item in NON_AUTHORITATIVE_PROVENANCE}:
        _add_manifest_reason(ctx, "profitability_stage_manifest_artifact_non_authoritative", str(artifact_file), stage=stage_name, provenance=provenance, maturity=normalized_contract.get("maturity"))
    if not bool(normalized_contract.get("authoritative", False)):
        _add_manifest_reason(ctx, "profitability_stage_manifest_artifact_authoritative_flag_false", str(artifact_file), stage=stage_name, provenance=provenance)


# ---------------------------------------------------------------------------
# Overall manifest validation
# ---------------------------------------------------------------------------

def _validate_overall_manifest(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    manifest_path: Path,
    stages: dict[str, Any] | None,
) -> None:
    """Validate rollback_contract_ref, overall_status, failure_reasons, stage transitions."""

    rollback_contract = manifest_payload.get("rollback_contract_ref")
    if not rollback_contract:
        _add_manifest_reason(ctx, "profitability_stage_manifest_rollback_contract_ref_missing", str(manifest_path))

    _validate_overall_status(ctx, manifest_payload, manifest_path, stages)
    _validate_stage_transition(ctx, manifest_payload, stages, manifest_path)


def _validate_overall_status(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    manifest_path: Path,
    stages: dict[str, Any] | None,
) -> None:
    overall_status = str(manifest_payload.get("overall_status", "")).strip()
    if overall_status not in {"pass", "fail"}:
        _add_manifest_reason(ctx, "profitability_stage_manifest_overall_status_invalid", str(manifest_path), overall_status=overall_status)

    failure_reasons = _list_of_strings(manifest_payload.get("failure_reasons"))
    if overall_status == "fail" and not failure_reasons:
        _add_manifest_reason(ctx, "profitability_stage_manifest_failure_reasons_missing", str(manifest_path))

    if overall_status in {"pass", "fail"} and stages:
        stage_statuses: list[bool] = []
        for stage_name in _PROFITABILITY_STAGE_ORDER:
            stage_payload = _as_dict(stages.get(stage_name))
            stage_statuses.append(str(stage_payload.get("status", "")).strip() == "pass")
        expected_overall_status = "pass" if all(stage_statuses) else "fail"
        if overall_status != expected_overall_status:
            _add_manifest_reason(ctx, "profitability_stage_manifest_overall_status_mismatch", str(manifest_path), overall_status=overall_status, calculated_overall_status=expected_overall_status)


def _validate_stage_transition(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    stages: dict[str, Any] | None,
    manifest_path: Path,
) -> None:
    if not stages:
        return

    ordered_stages = _PROFITABILITY_STAGE_ORDER
    failure_encountered = False
    for stage_name in ordered_stages:
        stage_payload = _as_dict(stages.get(stage_name))
        stage_status = str(stage_payload.get("status", "")).strip()
        if stage_status != "pass":
            failure_encountered = True
            continue
        if failure_encountered:
            _add_manifest_reason(ctx, "profitability_stage_manifest_stage_transition_violation", str(manifest_path), stage=stage_name)
            break

    failure_reasons = _list_of_strings(manifest_payload.get("failure_reasons"))
    if str(manifest_payload.get("overall_status", "")).strip() == "fail":
        _add_manifest_reason(ctx, "profitability_stage_manifest_stage_chain_not_passed", str(manifest_path), failure_reasons=failure_reasons)


# ---------------------------------------------------------------------------
# Replay contract validation (conditional)
# ---------------------------------------------------------------------------

def _validate_replay_contract(
    ctx: _ValidationContext,
    manifest_payload: dict[str, Any],
    manifest_path: Path,
    stages: dict[str, Any],
) -> None:
    replay_contract = _as_dict(manifest_payload.get("replay_contract"))
    if not replay_contract:
        _add_manifest_reason(ctx, "profitability_stage_manifest_replay_contract_missing", str(manifest_path))
        return

    _validate_replay_artifact_hashes(ctx, replay_contract, manifest_path, stages)
    _validate_replay_contract_hash(ctx, replay_contract, manifest_path, stages)


def _validate_replay_artifact_hashes(
    ctx: _ValidationContext,
    replay_contract: dict[str, Any],
    manifest_path: Path,
    stages: dict[str, Any],
) -> None:
    artifact_hashes_raw = _as_dict(replay_contract.get("artifact_hashes"))
    artifact_hashes = {str(key).strip(): str(value).strip() for key, value in artifact_hashes_raw.items() if str(key).strip() and str(value).strip()}
    if not artifact_hashes:
        _add_manifest_reason(ctx, "profitability_stage_manifest_replay_artifact_hashes_missing", str(manifest_path))
        return

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
            _add_manifest_reason(ctx, "profitability_stage_manifest_replay_artifact_hash_missing", str(manifest_path), stage_artifact_ref=artifact_ref)
        elif replay_sha != expected_sha:
            _add_manifest_reason(ctx, "profitability_stage_manifest_replay_artifact_hash_mismatch", str(manifest_path), stage_artifact_ref=artifact_ref, replay_sha256=replay_sha, expected_sha256=expected_sha)


def _validate_replay_contract_hash(
    ctx: _ValidationContext,
    replay_contract: dict[str, Any],
    manifest_path: Path,
    stages: dict[str, Any],
) -> None:
    contract_hash = str(replay_contract.get("contract_hash", "")).strip()
    if not contract_hash:
        _add_manifest_reason(ctx, "profitability_stage_manifest_replay_contract_hash_missing", str(manifest_path))
    else:
        artifact_hashes_raw = _as_dict(replay_contract.get("artifact_hashes"))
        artifact_hashes = {str(key).strip(): str(value).strip() for key, value in artifact_hashes_raw.items() if str(key).strip() and str(value).strip()}
        expected_contract_hash = _sha256_json({"artifact_hashes": artifact_hashes})
        if contract_hash != expected_contract_hash:
            _add_manifest_reason(ctx, "profitability_stage_manifest_replay_contract_hash_mismatch", str(manifest_path), contract_hash=contract_hash, expected_contract_hash=expected_contract_hash)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def append_profitability_stage_manifest_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    manifest_relpath = str(policy_payload.get("promotion_profitability_stage_manifest_artifact", "profitability/profitability-stage-manifest-v1.json"))
    manifest_path = artifact_root / manifest_relpath
    manifest_payload = _load_json_if_exists(manifest_path)

    if manifest_payload is None:
        reason = "profitability_stage_manifest_invalid_json" if manifest_path.exists() else "profitability_stage_manifest_missing"
        reasons.append(reason)
        reason_details.append({"reason": reason, "artifact_ref": str(manifest_path)})
        return

    ctx = _ValidationContext(reasons=reasons, reason_details=reason_details)
    _validate_manifest_top_level(ctx, manifest_payload, manifest_path)
    stages = _validate_stages(ctx, manifest_payload, manifest_path, policy_payload, artifact_root)

    if bool(policy_payload.get("promotion_require_profitability_stage_replay_contract", False)) and stages:
        _validate_replay_contract(ctx, manifest_payload, manifest_path, stages)

    _validate_overall_manifest(ctx, manifest_payload, manifest_path, stages)


def append_portfolio_optimizer_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    evidence_relpath = str(policy_payload.get("promotion_portfolio_optimizer_evidence_artifact", "promotion/portfolio-optimizer-evidence.json"))
    evidence_path = artifact_root / evidence_relpath
    evidence_payload = _load_json_if_exists(evidence_path)

    if evidence_payload is None:
        reason = "portfolio_optimizer_evidence_invalid_json" if evidence_path.exists() else "portfolio_optimizer_evidence_missing"
        reasons.append(reason)
        reason_details.append({"reason": reason, "artifact_ref": str(evidence_path)})
        return

    _validate_portfolio_optimizer_evidence(reasons, reason_details, evidence_payload, str(evidence_path))


def _validate_portfolio_optimizer_evidence(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    evidence_payload: dict[str, Any],
    artifact_ref: str,
) -> None:
    schema_version = str(evidence_payload.get("schema_version", "")).strip()
    if schema_version != "torghut.portfolio-optimizer-evidence.v1":
        reasons.append("portfolio_optimizer_evidence_schema_invalid")
        reason_details.append({"reason": "portfolio_optimizer_evidence_schema_invalid", "artifact_ref": artifact_ref, "schema_version": schema_version})

    if not str(evidence_payload.get("portfolio_candidate_id", "")).strip():
        reasons.append("portfolio_optimizer_evidence_candidate_id_missing")
        reason_details.append({"reason": "portfolio_optimizer_evidence_candidate_id_missing", "artifact_ref": artifact_ref})

    if _int_or_default(evidence_payload.get("sleeve_count"), 0) < 2:
        reasons.append("portfolio_optimizer_evidence_sleeve_count_insufficient")
        reason_details.append({"reason": "portfolio_optimizer_evidence_sleeve_count_insufficient", "artifact_ref": artifact_ref, "sleeve_count": _int_or_default(evidence_payload.get("sleeve_count"), 0)})

    if not _as_dict(evidence_payload.get("optimizer_report")):
        reasons.append("portfolio_optimizer_report_missing")
        reason_details.append({"reason": "portfolio_optimizer_report_missing", "artifact_ref": artifact_ref})

    if not _as_dict(evidence_payload.get("objective_scorecard")):
        reasons.append("portfolio_optimizer_scorecard_missing")
        reason_details.append({"reason": "portfolio_optimizer_scorecard_missing", "artifact_ref": artifact_ref})

    if not bool(evidence_payload.get("target_met", False)):
        reasons.append("portfolio_optimizer_target_not_met")
        reason_details.append({"reason": "portfolio_optimizer_target_not_met", "artifact_ref": artifact_ref})

    if not bool(evidence_payload.get("oracle_passed", False)):
        reasons.append("portfolio_optimizer_oracle_not_passed")
        reason_details.append({"reason": "portfolio_optimizer_oracle_not_passed", "artifact_ref": artifact_ref})


def _is_valid_design_doc_reference(value: str) -> bool:
    value = value.strip()
    if not value:
        return False
    if value.startswith(("docs/", "./docs/")) and value.lower().endswith(".md"):
        return True

    parsed = urlparse(value)
    if parsed.scheme.lower() in {"http", "https"} and parsed.netloc and parsed.path and parsed.path.lower().endswith(".md"):
        return True

    return False


def append_profitability_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    _validate_profitability_validation_evidence(reasons, reason_details, policy_payload, artifact_root)
    _validate_profitability_benchmark_evidence(reasons, reason_details, policy_payload, artifact_root)


def _validate_profitability_validation_evidence(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    evidence_validation_relpath = str(policy_payload.get("promotion_profitability_validation_artifact", "gates/profitability-evidence-validation.json"))
    evidence_validation_path = artifact_root / evidence_validation_relpath
    evidence_validation_payload = _load_json_if_exists(evidence_validation_path)

    if evidence_validation_payload is None:
        reasons.append("profitability_evidence_validation_missing")
        reason_details.append({"reason": "profitability_evidence_validation_missing", "artifact_ref": str(evidence_validation_path)})
    elif not bool(evidence_validation_payload.get("passed", False)):
        reasons.append("profitability_evidence_validation_failed")
        reason_details.append({
            "reason": "profitability_evidence_validation_failed",
            "artifact_ref": str(evidence_validation_path),
            "validation_reasons": _list_of_strings(evidence_validation_payload.get("reasons")),
        })


def _validate_profitability_benchmark_evidence(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    benchmark_relpath = str(policy_payload.get("promotion_profitability_benchmark_artifact", "gates/profitability-benchmark-v4.json"))
    benchmark_path = artifact_root / benchmark_relpath
    benchmark_payload = _load_json_if_exists(benchmark_path)
    minimum_regime_slices = int(policy_payload.get("promotion_profitability_min_regime_slices", 1))

    if benchmark_payload is None:
        reasons.append("profitability_benchmark_missing")
        reason_details.append({"reason": "profitability_benchmark_missing", "artifact_ref": str(benchmark_path)})
        return

    regime_slices = _regime_slice_count(benchmark_payload)
    if regime_slices < minimum_regime_slices:
        reasons.append("profitability_benchmark_regime_coverage_insufficient")
        reason_details.append({
            "reason": "profitability_benchmark_regime_coverage_insufficient",
            "artifact_ref": str(benchmark_path),
            "actual_regime_slices": regime_slices,
            "minimum_regime_slices": minimum_regime_slices,
        })


def append_janus_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    _validate_janus_event_car(reasons, reason_details, policy_payload, artifact_root)
    _validate_janus_hgrm_reward(reasons, reason_details, policy_payload, artifact_root)


def _validate_janus_event_car(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    event_path = artifact_root / str(policy_payload.get("promotion_janus_event_car_artifact", "gates/janus-event-car-v1.json"))
    event_payload = _load_json_if_exists(event_path)

    if event_payload is None:
        reasons.append("janus_event_car_artifact_missing")
        reason_details.append({"reason": "janus_event_car_artifact_missing", "artifact_ref": str(event_path)})
    else:
        _validate_janus_schema(reasons, reason_details, event_payload, event_path, "janus-event-car-v1")
        event_count = _int_or_default(_as_dict(event_payload.get("summary")).get("event_count"), _list_count(event_payload.get("records")))
        min_event_count = max(1, _int_or_default(policy_payload.get("promotion_min_janus_event_count"), 1))
        if event_count < min_event_count:
            reasons.append("janus_event_car_count_below_minimum")
            reason_details.append({
                "reason": "janus_event_car_count_below_minimum",
                "artifact_ref": str(event_path),
                "actual_event_count": event_count,
                "minimum_event_count": min_event_count,
            })


def _validate_janus_hgrm_reward(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    reward_path = artifact_root / str(policy_payload.get("promotion_janus_hgrm_reward_artifact", "gates/janus-hgrm-reward-v1.json"))
    reward_payload = _load_json_if_exists(reward_path)

    if reward_payload is None:
        reasons.append("janus_hgrm_reward_artifact_missing")
        reason_details.append({"reason": "janus_hgrm_reward_artifact_missing", "artifact_ref": str(reward_path)})
        return

    _validate_janus_schema(reasons, reason_details, reward_payload, reward_path, "janus-hgrm-reward-v1")
    reward_count = _int_or_default(_as_dict(reward_payload.get("summary")).get("reward_count"), _list_count(reward_payload.get("rewards")))
    min_reward_count = max(1, _int_or_default(policy_payload.get("promotion_min_janus_reward_count"), 1))
    if reward_count < min_reward_count:
        reasons.append("janus_hgrm_reward_count_below_minimum")
        reason_details.append({
            "reason": "janus_hgrm_reward_count_below_minimum",
            "artifact_ref": str(reward_path),
            "actual_reward_count": reward_count,
            "minimum_reward_count": min_reward_count,
        })


def _validate_janus_schema(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    payload: dict[str, Any],
    path: Path,
    expected_schema: str,
) -> None:
    if str(payload.get("schema_version", "")).strip() != expected_schema:
        reasons.append("janus_schema_invalid")
        reason_details.append({"reason": "janus_schema_invalid", "artifact_ref": str(path), "expected": expected_schema})


def append_benchmark_parity_evidence_reasons(
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
    artifact_ref = _benchmark_parity_artifact_reference(policy_payload=policy_payload, gate_report_payload=gate_report_payload)
    candidate_paths = [_normalize_artifact_path(candidate_ref, artifact_root=artifact_root) for candidate_ref in _benchmark_parity_artifact_candidates(policy_payload=policy_payload, gate_report_payload=gate_report_payload)]
    artifact_path = next((path for path in candidate_paths if path is not None and path.exists()), None)
    if artifact_path is None and evidence_ref:
        artifact_path = _normalize_artifact_path(evidence_ref, artifact_root=artifact_root)

    if artifact_path is None:
        _add_manifest_reason(_ValidationContext(reasons, reason_details), "benchmark_parity_artifact_ref_invalid", str(evidence_ref if evidence_ref else artifact_ref))
        return

    _validate_benchmark_artifact_path(reasons, reason_details, artifact_path, evidence_ref, artifact_ref)


def _validate_benchmark_artifact_path(reasons: list[str], reason_details: list[dict[str, object]], artifact_path: Path, evidence_ref: str, artifact_ref: str) -> None:
    if not artifact_path.exists():
        reasons.append("benchmark_parity_artifact_missing")
        reason_details.append({"reason": "benchmark_parity_artifact_missing", "artifact_ref": str(artifact_path)})
        return

    if _load_json_if_exists(artifact_path) is None:
        reasons.append("benchmark_parity_artifact_invalid_json")
        reason_details.append({"reason": "benchmark_parity_artifact_invalid_json", "artifact_ref": str(artifact_path)})
