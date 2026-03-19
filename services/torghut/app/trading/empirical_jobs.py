"""Empirical workflow artifact assembly and status helpers for vNext promotion evidence."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import VNextEmpiricalJobRun
from .evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from .parity import (
    BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_SCHEMA_VERSION,
    FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION,
    FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS,
    FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS,
    FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION,
)

EMPIRICAL_JOB_TYPES: tuple[str, ...] = (
    "benchmark_parity",
    "foundation_router_parity",
    "janus_event_car",
    "janus_hgrm_reward",
)
AUTHORITATIVE_EMPIRICAL_PROVENANCE: frozenset[str] = frozenset(
    {
        ArtifactProvenance.HISTORICAL_MARKET_REPLAY.value,
        ArtifactProvenance.PAPER_RUNTIME_OBSERVED.value,
        ArtifactProvenance.LIVE_RUNTIME_OBSERVED.value,
    }
)


def _as_dict(value: object) -> dict[str, Any]:
    return dict(cast(Mapping[str, Any], value)) if isinstance(value, Mapping) else {}


def _as_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_string_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [text for item in cast(list[object] | tuple[object, ...], value) if (text := _as_text(item))]


def _lineage_is_complete(
    *,
    job_run_id: str,
    dataset_snapshot_ref: str,
    runtime_version_refs: Sequence[str],
    model_refs: Sequence[str],
) -> bool:
    return (
        bool(_as_text(job_run_id))
        and bool(_as_text(dataset_snapshot_ref))
        and bool(_as_string_list(runtime_version_refs))
        and bool(_as_string_list(model_refs))
    )


def empirical_artifact_truthfulness_reasons(payload: Mapping[str, object]) -> list[str]:
    reasons: list[str] = []
    authority = _as_dict(payload.get("artifact_authority"))
    if not authority:
        reasons.append("artifact_authority_missing")
    else:
        if _as_text(authority.get("provenance")) not in AUTHORITATIVE_EMPIRICAL_PROVENANCE:
            reasons.append("artifact_authority_provenance_invalid")
        if _as_text(authority.get("maturity")) != EvidenceMaturity.EMPIRICALLY_VALIDATED.value:
            reasons.append("artifact_authority_maturity_invalid")
        if not bool(authority.get("authoritative", False)):
            reasons.append("artifact_authority_not_authoritative")
        if bool(authority.get("placeholder", False)):
            reasons.append("artifact_authority_placeholder")

    if not bool(payload.get("promotion_authority_eligible", False)):
        reasons.append("promotion_authority_ineligible")

    lineage = _as_dict(payload.get("lineage"))
    if not _as_text(lineage.get("dataset_snapshot_ref")):
        reasons.append("lineage_dataset_snapshot_ref_missing")
    if not _as_text(lineage.get("job_run_id")):
        reasons.append("lineage_job_run_id_missing")
    if not _as_string_list(lineage.get("runtime_version_refs")):
        reasons.append("lineage_runtime_version_refs_missing")
    if not _as_string_list(lineage.get("model_refs")):
        reasons.append("lineage_model_refs_missing")
    return reasons


def artifact_is_truthful(payload: Mapping[str, object]) -> bool:
    return not empirical_artifact_truthfulness_reasons(payload)


def _payload_hash(payload: Mapping[str, object]) -> str:
    signed_payload = dict(payload)
    signed_payload.pop("artifact_hash", None)
    encoded = json.dumps(
        signed_payload,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _lineage_payload(
    *,
    job_run_id: str,
    dataset_snapshot_ref: str,
    runtime_version_refs: Sequence[str],
    model_refs: Sequence[str],
    extra: Mapping[str, object] | None = None,
) -> dict[str, object]:
    lineage: dict[str, object] = {
        "job_run_id": job_run_id,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "runtime_version_refs": [str(item) for item in runtime_version_refs if str(item).strip()],
        "model_refs": [str(item) for item in model_refs if str(item).strip()],
    }
    if extra:
        lineage.update(dict(extra))
    return lineage


def _empirical_contract(
    *,
    promotion_authority_eligible: bool,
    calibration_summary: Mapping[str, Any] | None = None,
    deviation_summary: Mapping[str, Any] | None = None,
    notes: str | None = None,
) -> dict[str, object]:
    return evidence_contract_payload(
        provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
        maturity=(
            EvidenceMaturity.EMPIRICALLY_VALIDATED
            if promotion_authority_eligible
            else EvidenceMaturity.CALIBRATED
        ),
        authoritative=promotion_authority_eligible,
        placeholder=False,
        calibration_summary=calibration_summary,
        deviation_summary=deviation_summary,
        notes=notes,
    )


def build_empirical_benchmark_parity_report(
    *,
    candidate_id: str,
    baseline_candidate_id: str,
    benchmark_runs: Sequence[Mapping[str, object]],
    scorecards: Mapping[str, Mapping[str, object]],
    degradation_summary: Mapping[str, object],
    dataset_snapshot_ref: str,
    job_run_id: str,
    runtime_version_refs: Sequence[str] = (),
    model_refs: Sequence[str] = (),
    now: datetime | None = None,
) -> dict[str, object]:
    created_at = (now or datetime.now(tz=timezone.utc)).astimezone(timezone.utc)
    normalized_runs = [dict(item) for item in benchmark_runs]
    normalized_scorecards = {
        str(name): dict(payload) for name, payload in scorecards.items()
    }
    required_families = set(BENCHMARK_PARITY_REQUIRED_FAMILIES)
    present_families = {
        str(item.get("family") or "").strip()
        for item in normalized_runs
    }
    missing_families = sorted(family for family in required_families if family not in present_families)
    scorecards_pass = all(
        str(item.get("status") or "").strip() == "pass"
        for item in normalized_scorecards.values()
    ) and not any(name not in normalized_scorecards for name in BENCHMARK_PARITY_REQUIRED_SCORECARDS)
    lineage_ready = _lineage_is_complete(
        job_run_id=job_run_id,
        dataset_snapshot_ref=dataset_snapshot_ref,
        runtime_version_refs=runtime_version_refs,
        model_refs=model_refs,
    )
    promotion_authority_eligible = scorecards_pass and not missing_families and lineage_ready
    report: dict[str, object] = {
        "schema_version": BENCHMARK_PARITY_SCHEMA_VERSION,
        "candidate_id": candidate_id,
        "baseline_candidate_id": baseline_candidate_id,
        "contract": {
            "schema_version": BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
            "required_families": list(BENCHMARK_PARITY_REQUIRED_FAMILIES),
            "required_scorecards": list(BENCHMARK_PARITY_REQUIRED_SCORECARDS),
            "required_scorecard_fields": {
                name: list(fields)
                for name, fields in BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS.items()
            },
            "required_run_fields": list(BENCHMARK_PARITY_REQUIRED_RUN_FIELDS),
            "hash_algorithm": "sha256",
            "generation_mode": "empirical_benchmark_parity_v1",
        },
        "benchmark_runs": normalized_runs,
        "scorecards": normalized_scorecards,
        "overall_parity_status": "pass" if promotion_authority_eligible else "degrade",
        "degradation_summary": dict(degradation_summary),
        "lineage": _lineage_payload(
            job_run_id=job_run_id,
            dataset_snapshot_ref=dataset_snapshot_ref,
            runtime_version_refs=runtime_version_refs,
            model_refs=model_refs,
            extra={"missing_families": missing_families},
        ),
        "promotion_authority_eligible": promotion_authority_eligible,
        "artifact_hash": "",
        "created_at_utc": created_at.isoformat(),
        "artifact_authority": _empirical_contract(
            promotion_authority_eligible=promotion_authority_eligible,
            calibration_summary={
                "required_scorecards_present": len(normalized_scorecards),
                "eligible_family_count": len(present_families),
            },
            deviation_summary=cast(Mapping[str, Any], degradation_summary),
            notes=(
                "Missing required benchmark families."
                if missing_families
                else "Empirical benchmark parity is missing runtime or model lineage refs."
                if not lineage_ready
                else "Empirical benchmark parity assembled from observed benchmark runs."
            ),
        ),
    }
    report["artifact_hash"] = _payload_hash(report)
    return report


def build_empirical_foundation_router_parity_report(
    *,
    candidate_id: str,
    router_policy_version: str,
    adapters: Sequence[str],
    slice_metrics: Mapping[str, object],
    calibration_metrics: Mapping[str, object],
    latency_metrics: Mapping[str, object],
    fallback_metrics: Mapping[str, object],
    drift_metrics: Mapping[str, object],
    dataset_snapshot_ref: str,
    job_run_id: str,
    runtime_version_refs: Sequence[str] = (),
    model_refs: Sequence[str] = (),
    overall_status: str = "pass",
    now: datetime | None = None,
) -> dict[str, object]:
    created_at = (now or datetime.now(tz=timezone.utc)).astimezone(timezone.utc)
    required_adapters = set(FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS)
    normalized_adapters = [str(item).strip() for item in adapters if str(item).strip()]
    missing_adapters = sorted(item for item in required_adapters if item not in normalized_adapters)
    lineage_ready = _lineage_is_complete(
        job_run_id=job_run_id,
        dataset_snapshot_ref=dataset_snapshot_ref,
        runtime_version_refs=runtime_version_refs,
        model_refs=model_refs,
    )
    promotion_authority_eligible = overall_status == "pass" and not missing_adapters and lineage_ready
    report: dict[str, object] = {
        "schema_version": FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION,
        "candidate_id": candidate_id,
        "router_policy_version": router_policy_version,
        "contract": {
            "schema_version": FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION,
            "required_adapters": list(FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS),
            "required_slice_metrics": list(FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS),
            "hash_algorithm": "sha256",
            "generation_mode": "empirical_foundation_router_parity_v1",
        },
        "adapters": normalized_adapters,
        "slice_metrics": dict(slice_metrics),
        "calibration_metrics": dict(calibration_metrics),
        "latency_metrics": dict(latency_metrics),
        "fallback_metrics": dict(fallback_metrics),
        "drift_metrics": dict(drift_metrics),
        "overall_status": overall_status if overall_status else "degrade",
        "lineage": _lineage_payload(
            job_run_id=job_run_id,
            dataset_snapshot_ref=dataset_snapshot_ref,
            runtime_version_refs=runtime_version_refs,
            model_refs=model_refs,
            extra={"missing_adapters": missing_adapters},
        ),
        "promotion_authority_eligible": promotion_authority_eligible,
        "created_at_utc": created_at.isoformat(),
        "artifact_hash": "",
        "artifact_authority": _empirical_contract(
            promotion_authority_eligible=promotion_authority_eligible,
            calibration_summary=cast(Mapping[str, Any], calibration_metrics),
            deviation_summary=cast(Mapping[str, Any], drift_metrics),
            notes=(
                "Missing required router adapters."
                if missing_adapters
                else "Empirical foundation router parity is missing runtime or model lineage refs."
                if not lineage_ready
                else "Empirical foundation router parity assembled from replayed adapter outputs."
            ),
        ),
    }
    report["artifact_hash"] = _payload_hash(report)
    return report


def promote_janus_payload_to_empirical(
    *,
    payload: Mapping[str, object],
    dataset_snapshot_ref: str,
    job_run_id: str,
    runtime_version_refs: Sequence[str] = (),
    model_refs: Sequence[str] = (),
    promotion_authority_eligible: bool,
    require_summary_field: bool = True,
) -> dict[str, object]:
    upgraded = dict(payload)
    lineage_ready = _lineage_is_complete(
        job_run_id=job_run_id,
        dataset_snapshot_ref=dataset_snapshot_ref,
        runtime_version_refs=runtime_version_refs,
        model_refs=model_refs,
    )
    resolved_promotion_authority_eligible = (
        promotion_authority_eligible
        and (not require_summary_field or bool(_as_dict(payload.get("summary"))))
        and lineage_ready
    )
    upgraded["lineage"] = _lineage_payload(
        job_run_id=job_run_id,
        dataset_snapshot_ref=dataset_snapshot_ref,
        runtime_version_refs=runtime_version_refs,
        model_refs=model_refs,
    )
    upgraded["promotion_authority_eligible"] = resolved_promotion_authority_eligible
    upgraded["artifact_authority"] = _empirical_contract(
        promotion_authority_eligible=resolved_promotion_authority_eligible,
        notes=(
            "Janus artifact is missing required truthfulness inputs or runtime/model lineage refs."
            if not resolved_promotion_authority_eligible
            else "Janus artifact assembled from replayed signal and decision windows."
        ),
    )
    return upgraded


def upsert_empirical_job_run(
    *,
    session: Session,
    run_id: str,
    candidate_id: str | None,
    job_name: str,
    job_type: str,
    job_run_id: str,
    status: str,
    authority: str,
    promotion_authority_eligible: bool,
    dataset_snapshot_ref: str | None,
    artifact_refs: Sequence[str],
    payload: Mapping[str, object],
) -> VNextEmpiricalJobRun:
    existing = session.execute(
        select(VNextEmpiricalJobRun).where(VNextEmpiricalJobRun.job_run_id == job_run_id)
    ).scalar_one_or_none()
    record = existing or VNextEmpiricalJobRun(
        run_id=run_id,
        candidate_id=candidate_id,
        job_name=job_name,
        job_type=job_type,
        job_run_id=job_run_id,
        status=status,
        authority=authority,
        promotion_authority_eligible=promotion_authority_eligible,
        dataset_snapshot_ref=dataset_snapshot_ref,
        artifact_refs=list(artifact_refs),
        payload_json=dict(payload),
    )
    record.run_id = run_id
    record.candidate_id = candidate_id
    record.job_name = job_name
    record.job_type = job_type
    record.status = status
    record.authority = authority
    record.promotion_authority_eligible = promotion_authority_eligible
    record.dataset_snapshot_ref = dataset_snapshot_ref
    record.artifact_refs = list(artifact_refs)
    record.payload_json = dict(payload)
    session.add(record)
    return record


def build_empirical_jobs_status(
    *,
    session: Session,
    stale_after_seconds: int,
) -> dict[str, object]:
    now = datetime.now(tz=timezone.utc)
    cutoff = now - timedelta(seconds=max(stale_after_seconds, 1))
    rows = session.execute(
        select(VNextEmpiricalJobRun).order_by(VNextEmpiricalJobRun.created_at.desc())
    ).scalars()
    latest_by_type: dict[str, VNextEmpiricalJobRun] = {}
    for row in rows:
        if row.job_type not in EMPIRICAL_JOB_TYPES or row.job_type in latest_by_type:
            continue
        latest_by_type[row.job_type] = row
        if len(latest_by_type) == len(EMPIRICAL_JOB_TYPES):
            break
    jobs: dict[str, object] = {}
    fresh_and_eligible = True
    eligible_jobs: list[str] = []
    missing_jobs: list[str] = []
    stale_jobs: list[str] = []
    ineligible_jobs: list[str] = []
    candidate_ids: set[str] = set()
    dataset_snapshot_refs: set[str] = set()
    for job_type in EMPIRICAL_JOB_TYPES:
        row = latest_by_type.get(job_type)
        if row is None:
            missing_jobs.append(job_type)
            ineligible_jobs.append(job_type)
            jobs[job_type] = {
                "status": "missing",
                "authority": "blocked",
                "promotion_authority_eligible": False,
                "stale": True,
                "truthful": False,
                "blocked_reasons": ["job_missing"],
            }
            fresh_and_eligible = False
            continue
        created_at_raw = row.created_at or now
        created_at = (
            created_at_raw.astimezone(timezone.utc)
            if created_at_raw.tzinfo is not None
            else created_at_raw.replace(tzinfo=timezone.utc)
        )
        payload = _as_dict(row.payload_json)
        truthful_reasons = empirical_artifact_truthfulness_reasons(payload)
        truthful = not truthful_reasons
        stale = created_at < cutoff or row.status not in {"completed", "success"}
        dataset_snapshot_ref = _as_text(row.dataset_snapshot_ref)
        candidate_id = _as_text(row.candidate_id)
        blocked_reasons = sorted(
            {
                *truthful_reasons,
                *(["job_stale"] if created_at < cutoff else []),
                *(["job_status_incomplete"] if row.status not in {"completed", "success"} else []),
                *(["row_authority_not_empirical"] if row.authority != "empirical" else []),
                *(
                    ["row_promotion_authority_ineligible"]
                    if not row.promotion_authority_eligible
                    else []
                ),
                *(
                    ["row_dataset_snapshot_ref_missing"]
                    if not _as_text(row.dataset_snapshot_ref)
                    else []
                ),
            }
        )
        if stale:
            stale_jobs.append(job_type)
        if candidate_id is not None:
            candidate_ids.add(candidate_id)
        if dataset_snapshot_ref is not None:
            dataset_snapshot_refs.add(dataset_snapshot_ref)
        job_ready = (
            not stale
            and truthful
            and bool(row.promotion_authority_eligible)
            and row.authority == "empirical"
            and dataset_snapshot_ref is not None
        )
        if job_ready:
            eligible_jobs.append(job_type)
        else:
            ineligible_jobs.append(job_type)
        jobs[job_type] = {
            "status": row.status,
            "authority": row.authority if truthful and row.authority == "empirical" else "blocked",
            "persisted_authority": row.authority,
            "promotion_authority_eligible": bool(row.promotion_authority_eligible) and truthful,
            "persisted_promotion_authority_eligible": bool(row.promotion_authority_eligible),
            "dataset_snapshot_ref": row.dataset_snapshot_ref,
            "candidate_id": row.candidate_id,
            "job_run_id": row.job_run_id,
            "created_at": created_at.isoformat(),
            "artifact_refs": list(cast(list[object], row.artifact_refs or [])),
            "stale": stale,
            "truthful": truthful,
            "blocked_reasons": blocked_reasons,
        }
        if (
            stale
            or not truthful
            or not row.promotion_authority_eligible
            or row.authority != "empirical"
        ):
            fresh_and_eligible = False
    status_blocked_reasons: list[str] = []
    if len(candidate_ids) > 1:
        fresh_and_eligible = False
        status_blocked_reasons.append("candidate_id_mismatch")
    if len(dataset_snapshot_refs) > 1:
        fresh_and_eligible = False
        status_blocked_reasons.append("dataset_snapshot_ref_mismatch")
    if missing_jobs:
        message = f"missing empirical jobs: {', '.join(sorted(missing_jobs))}"
    elif stale_jobs:
        message = f"stale empirical jobs: {', '.join(sorted(stale_jobs))}"
    elif ineligible_jobs:
        message = f"ineligible empirical jobs: {', '.join(sorted(ineligible_jobs))}"
    elif status_blocked_reasons:
        message = f"empirical job bundle invalid: {', '.join(status_blocked_reasons)}"
    else:
        message = "empirical jobs fresh"
    return {
        "ready": fresh_and_eligible,
        "status": "healthy" if fresh_and_eligible else "degraded",
        "authority": "empirical" if fresh_and_eligible else "blocked",
        "stale_after_seconds": stale_after_seconds,
        "message": message,
        "eligible_jobs": sorted(eligible_jobs),
        "missing_jobs": sorted(missing_jobs),
        "stale_jobs": sorted(stale_jobs),
        "ineligible_jobs": sorted(set(ineligible_jobs)),
        "candidate_ids": sorted(candidate_ids),
        "dataset_snapshot_refs": sorted(dataset_snapshot_refs),
        "blocked_reasons": status_blocked_reasons,
        "jobs": jobs,
    }


__all__ = [
    "EMPIRICAL_JOB_TYPES",
    "artifact_is_truthful",
    "build_empirical_benchmark_parity_report",
    "build_empirical_foundation_router_parity_report",
    "build_empirical_jobs_status",
    "empirical_artifact_truthfulness_reasons",
    "promote_janus_payload_to_empirical",
    "upsert_empirical_job_run",
]
