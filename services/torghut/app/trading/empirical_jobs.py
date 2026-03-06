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
    promotion_authority_eligible = scorecards_pass and not missing_families and bool(dataset_snapshot_ref.strip())
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
    promotion_authority_eligible = (
        overall_status == "pass"
        and not missing_adapters
        and bool(dataset_snapshot_ref.strip())
    )
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
) -> dict[str, object]:
    upgraded = dict(payload)
    upgraded["lineage"] = _lineage_payload(
        job_run_id=job_run_id,
        dataset_snapshot_ref=dataset_snapshot_ref,
        runtime_version_refs=runtime_version_refs,
        model_refs=model_refs,
    )
    upgraded["promotion_authority_eligible"] = promotion_authority_eligible
    upgraded["artifact_authority"] = _empirical_contract(
        promotion_authority_eligible=promotion_authority_eligible,
        notes="Janus artifact assembled from replayed signal and decision windows.",
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
    for job_type in EMPIRICAL_JOB_TYPES:
        row = latest_by_type.get(job_type)
        if row is None:
            jobs[job_type] = {
                "status": "missing",
                "authority": "blocked",
                "promotion_authority_eligible": False,
                "stale": True,
            }
            fresh_and_eligible = False
            continue
        created_at_raw = row.created_at or now
        created_at = (
            created_at_raw.astimezone(timezone.utc)
            if created_at_raw.tzinfo is not None
            else created_at_raw.replace(tzinfo=timezone.utc)
        )
        stale = created_at < cutoff or row.status not in {"completed", "success"}
        jobs[job_type] = {
            "status": row.status,
            "authority": row.authority,
            "promotion_authority_eligible": bool(row.promotion_authority_eligible),
            "dataset_snapshot_ref": row.dataset_snapshot_ref,
            "job_run_id": row.job_run_id,
            "created_at": created_at.isoformat(),
            "artifact_refs": list(cast(list[object], row.artifact_refs or [])),
            "stale": stale,
        }
        if stale or not row.promotion_authority_eligible or row.authority != "empirical":
            fresh_and_eligible = False
    return {
        "status": "healthy" if fresh_and_eligible else "degraded",
        "authority": "empirical" if fresh_and_eligible else "blocked",
        "stale_after_seconds": stale_after_seconds,
        "jobs": jobs,
    }


__all__ = [
    "EMPIRICAL_JOB_TYPES",
    "build_empirical_benchmark_parity_report",
    "build_empirical_foundation_router_parity_report",
    "build_empirical_jobs_status",
    "promote_janus_payload_to_empirical",
    "upsert_empirical_job_run",
]
