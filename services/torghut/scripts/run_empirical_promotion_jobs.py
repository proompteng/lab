#!/usr/bin/env python3
"""Assemble empirical parity and Janus evidence, upload artifacts, and persist job freshness."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import yaml

from app.db import SessionLocal
from app.trading.empirical_jobs import (
    build_empirical_benchmark_parity_report,
    build_empirical_foundation_router_parity_report,
    promote_janus_payload_to_empirical,
    upsert_empirical_job_run,
)
from app.whitepapers.workflow import CephS3Client


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Assemble empirical promotion artifacts from replayed or observed job payloads.",
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _load_manifest(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise RuntimeError("manifest must be a mapping")
    return {str(key): value for key, value in payload.items()}


def _as_dict(value: Any) -> dict[str, Any]:
    return {str(key): item for key, item in value.items()} if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _job_run_id(run_id: str, job_type: str, explicit: str | None = None) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{run_id}:{job_type}:{timestamp}"


def _ceph_client_from_env() -> tuple[CephS3Client | None, str]:
    endpoint = os.getenv("TORGHUT_EMPIRICAL_CEPH_ENDPOINT", "").strip()
    bucket_host = os.getenv("TORGHUT_EMPIRICAL_CEPH_BUCKET_HOST", "").strip()
    bucket_port = os.getenv("TORGHUT_EMPIRICAL_CEPH_BUCKET_PORT", "").strip()
    access_key = os.getenv("TORGHUT_EMPIRICAL_CEPH_ACCESS_KEY", "").strip() or os.getenv(
        "AWS_ACCESS_KEY_ID",
        "",
    ).strip()
    secret_key = os.getenv("TORGHUT_EMPIRICAL_CEPH_SECRET_KEY", "").strip() or os.getenv(
        "AWS_SECRET_ACCESS_KEY",
        "",
    ).strip()
    bucket = os.getenv("TORGHUT_EMPIRICAL_CEPH_BUCKET", "").strip() or os.getenv(
        "BUCKET_NAME",
        "",
    ).strip() or "torghut-empirical-artifacts"
    if not endpoint and bucket_host:
        scheme = "https" if os.getenv("TORGHUT_EMPIRICAL_CEPH_USE_TLS", "").strip() == "true" else "http"
        endpoint = f"{scheme}://{bucket_host}"
        if bucket_port:
            endpoint = f"{endpoint}:{bucket_port}"
    if not endpoint or not access_key or not secret_key:
        return None, bucket
    return (
        CephS3Client(
            endpoint=endpoint,
            access_key=access_key,
            secret_key=secret_key,
            region=os.getenv("TORGHUT_EMPIRICAL_CEPH_REGION", "us-east-1").strip() or "us-east-1",
            timeout_seconds=max(int(os.getenv("TORGHUT_EMPIRICAL_CEPH_TIMEOUT_SECONDS", "20") or "20"), 1),
        ),
        bucket,
    )


def _write_artifact(
    *,
    output_dir: Path,
    relative_path: str,
    payload: Mapping[str, object],
    client: CephS3Client | None,
    bucket: str,
    prefix: str,
) -> str:
    path = output_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, indent=2).encode("utf-8")
    path.write_bytes(encoded)
    if client is None:
        return str(path)
    key = "/".join(
        part.strip("/")
        for part in (prefix, relative_path)
        if part.strip("/")
    )
    result = client.put_object(
        bucket=bucket,
        key=key,
        body=encoded,
        content_type="application/json",
    )
    return str(result.get("uri") or path)


def _build_janus_summary(
    *,
    event_car_payload: dict[str, Any],
    hgrm_reward_payload: dict[str, Any],
    event_car_artifact_ref: str,
    hgrm_reward_artifact_ref: str,
    dataset_snapshot_ref: str,
    job_run_id: str,
    runtime_version_refs: list[str],
    model_refs: list[str],
) -> dict[str, object]:
    event_summary = _as_dict(event_car_payload.get("summary"))
    reward_summary = _as_dict(hgrm_reward_payload.get("summary"))
    event_count = int(event_summary.get("event_count") or len(_as_list(event_car_payload.get("events"))) or 0)
    reward_count = int(reward_summary.get("reward_count") or len(_as_list(hgrm_reward_payload.get("rewards"))) or 0)
    mapped_count = int(reward_summary.get("event_mapped_count") or reward_count or 0)
    evidence_complete = event_count > 0 and reward_count > 0 and mapped_count >= reward_count
    summary: dict[str, object] = {
        "schema_version": "janus-q-evidence-v1",
        "status": "pass" if evidence_complete else "degrade",
        "reasons": [] if evidence_complete else ["janus_empirical_inputs_incomplete"],
        "promotion_authority_eligible": evidence_complete,
        "event_car": {
            "schema_version": str(event_car_payload.get("schema_version") or "").strip() or "janus-event-car-v1",
            "event_count": event_count,
            "manifest_hash": event_car_payload.get("manifest_hash"),
            "artifact_ref": event_car_artifact_ref,
            "artifact_authority": event_car_payload.get("artifact_authority"),
        },
        "hgrm_reward": {
            "schema_version": str(hgrm_reward_payload.get("schema_version") or "").strip()
            or "janus-hgrm-reward-v1",
            "reward_count": reward_count,
            "direction_gate_pass_ratio": reward_summary.get("direction_gate_pass_ratio", "0"),
            "manifest_hash": hgrm_reward_payload.get("manifest_hash"),
            "artifact_ref": hgrm_reward_artifact_ref,
            "artifact_authority": hgrm_reward_payload.get("artifact_authority"),
        },
    }
    return promote_janus_payload_to_empirical(
        payload=summary,
        dataset_snapshot_ref=dataset_snapshot_ref,
        job_run_id=job_run_id,
        runtime_version_refs=runtime_version_refs,
        model_refs=model_refs,
        promotion_authority_eligible=evidence_complete,
    )


def main() -> int:
    args = _parse_args()
    manifest = _load_manifest(Path(args.manifest))
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    run_id = str(manifest.get("run_id") or "").strip()
    if not run_id:
        raise RuntimeError("manifest missing run_id")
    candidate_id = str(manifest.get("candidate_id") or "").strip() or None
    baseline_candidate_id = str(manifest.get("baseline_candidate_id") or "").strip()
    dataset_snapshot_ref = str(manifest.get("dataset_snapshot_ref") or "").strip()
    runtime_version_refs = [str(item).strip() for item in _as_list(manifest.get("runtime_version_refs")) if str(item).strip()]
    model_refs = [str(item).strip() for item in _as_list(manifest.get("model_refs")) if str(item).strip()]
    artifact_prefix = str(manifest.get("artifact_prefix") or f"empirical/{run_id}").strip("/")

    client, bucket = _ceph_client_from_env()
    summary: dict[str, object] = {
        "run_id": run_id,
        "candidate_id": candidate_id,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "artifacts": {},
        "jobs": {},
    }
    artifacts_summary = _as_dict(summary.get("artifacts"))
    jobs_summary = _as_dict(summary.get("jobs"))
    summary["artifacts"] = artifacts_summary
    summary["jobs"] = jobs_summary

    with SessionLocal() as session:
        benchmark_manifest = _as_dict(manifest.get("benchmark_parity"))
        if benchmark_manifest:
            benchmark_job_run_id = _job_run_id(
                run_id,
                "benchmark_parity",
                str(benchmark_manifest.get("job_run_id") or ""),
            )
            benchmark_payload = build_empirical_benchmark_parity_report(
                candidate_id=candidate_id or f"cand-{run_id}",
                baseline_candidate_id=baseline_candidate_id or "baseline",
                benchmark_runs=[
                    _as_dict(item) for item in _as_list(benchmark_manifest.get("benchmark_runs"))
                ],
                scorecards={
                    str(name): _as_dict(payload)
                    for name, payload in _as_dict(benchmark_manifest.get("scorecards")).items()
                    if isinstance(payload, Mapping)
                },
                degradation_summary=_as_dict(benchmark_manifest.get("degradation_summary")),
                dataset_snapshot_ref=dataset_snapshot_ref,
                job_run_id=benchmark_job_run_id,
                runtime_version_refs=runtime_version_refs,
                model_refs=model_refs,
            )
            benchmark_ref = _write_artifact(
                output_dir=output_dir,
                relative_path="gates/benchmark-parity-report-v1.json",
                payload=benchmark_payload,
                client=client,
                bucket=bucket,
                prefix=artifact_prefix,
            )
            upsert_empirical_job_run(
                session=session,
                run_id=run_id,
                candidate_id=candidate_id,
                job_name="benchmark parity",
                job_type="benchmark_parity",
                job_run_id=benchmark_job_run_id,
                status="completed" if bool(benchmark_payload.get("promotion_authority_eligible")) else "degraded",
                authority=(
                    "empirical"
                    if bool(_as_dict(benchmark_payload.get("artifact_authority")).get("authoritative"))
                    else "blocked"
                ),
                promotion_authority_eligible=bool(benchmark_payload.get("promotion_authority_eligible")),
                dataset_snapshot_ref=dataset_snapshot_ref or None,
                artifact_refs=[benchmark_ref],
                payload=benchmark_payload,
            )
            artifacts_summary["benchmark_parity"] = benchmark_ref
            jobs_summary["benchmark_parity"] = {
                "job_run_id": benchmark_job_run_id,
                "eligible": bool(benchmark_payload.get("promotion_authority_eligible")),
            }

        foundation_manifest = _as_dict(manifest.get("foundation_router_parity"))
        if foundation_manifest:
            foundation_job_run_id = _job_run_id(
                run_id,
                "foundation_router_parity",
                str(foundation_manifest.get("job_run_id") or ""),
            )
            foundation_payload = build_empirical_foundation_router_parity_report(
                candidate_id=candidate_id or f"cand-{run_id}",
                router_policy_version=str(
                    foundation_manifest.get("router_policy_version") or "forecast_router_policy_v1"
                ).strip(),
                adapters=[str(item) for item in _as_list(foundation_manifest.get("adapters"))],
                slice_metrics=_as_dict(foundation_manifest.get("slice_metrics")),
                calibration_metrics=_as_dict(foundation_manifest.get("calibration_metrics")),
                latency_metrics=_as_dict(foundation_manifest.get("latency_metrics")),
                fallback_metrics=_as_dict(foundation_manifest.get("fallback_metrics")),
                drift_metrics=_as_dict(foundation_manifest.get("drift_metrics")),
                overall_status=str(foundation_manifest.get("overall_status") or "pass").strip() or "pass",
                dataset_snapshot_ref=dataset_snapshot_ref,
                job_run_id=foundation_job_run_id,
                runtime_version_refs=runtime_version_refs,
                model_refs=model_refs,
            )
            foundation_ref = _write_artifact(
                output_dir=output_dir,
                relative_path="router/foundation-router-parity-report-v1.json",
                payload=foundation_payload,
                client=client,
                bucket=bucket,
                prefix=artifact_prefix,
            )
            upsert_empirical_job_run(
                session=session,
                run_id=run_id,
                candidate_id=candidate_id,
                job_name="foundation router parity",
                job_type="foundation_router_parity",
                job_run_id=foundation_job_run_id,
                status="completed" if bool(foundation_payload.get("promotion_authority_eligible")) else "degraded",
                authority=(
                    "empirical"
                    if bool(_as_dict(foundation_payload.get("artifact_authority")).get("authoritative"))
                    else "blocked"
                ),
                promotion_authority_eligible=bool(foundation_payload.get("promotion_authority_eligible")),
                dataset_snapshot_ref=dataset_snapshot_ref or None,
                artifact_refs=[foundation_ref],
                payload=foundation_payload,
            )
            artifacts_summary["foundation_router_parity"] = foundation_ref
            jobs_summary["foundation_router_parity"] = {
                "job_run_id": foundation_job_run_id,
                "eligible": bool(foundation_payload.get("promotion_authority_eligible")),
            }

        janus_manifest = _as_dict(manifest.get("janus_q"))
        if janus_manifest:
            janus_job_run_id = _job_run_id(
                run_id,
                "janus_event_car",
                str(janus_manifest.get("job_run_id") or ""),
            )
            event_payload = promote_janus_payload_to_empirical(
                payload=_as_dict(janus_manifest.get("event_car")),
                dataset_snapshot_ref=dataset_snapshot_ref,
                job_run_id=janus_job_run_id,
                runtime_version_refs=runtime_version_refs,
                model_refs=model_refs,
                promotion_authority_eligible=bool(
                    _as_dict(janus_manifest.get("event_car")).get("summary")
                ),
            )
            reward_payload = promote_janus_payload_to_empirical(
                payload=_as_dict(janus_manifest.get("hgrm_reward")),
                dataset_snapshot_ref=dataset_snapshot_ref,
                job_run_id=janus_job_run_id,
                runtime_version_refs=runtime_version_refs,
                model_refs=model_refs,
                promotion_authority_eligible=bool(
                    _as_dict(janus_manifest.get("hgrm_reward")).get("summary")
                ),
            )
            event_ref = _write_artifact(
                output_dir=output_dir,
                relative_path="gates/janus-event-car-v1.json",
                payload=event_payload,
                client=client,
                bucket=bucket,
                prefix=artifact_prefix,
            )
            reward_ref = _write_artifact(
                output_dir=output_dir,
                relative_path="gates/janus-hgrm-reward-v1.json",
                payload=reward_payload,
                client=client,
                bucket=bucket,
                prefix=artifact_prefix,
            )
            summary_payload = _build_janus_summary(
                event_car_payload=event_payload,
                hgrm_reward_payload=reward_payload,
                event_car_artifact_ref=event_ref,
                hgrm_reward_artifact_ref=reward_ref,
                dataset_snapshot_ref=dataset_snapshot_ref,
                job_run_id=janus_job_run_id,
                runtime_version_refs=runtime_version_refs,
                model_refs=model_refs,
            )
            summary_ref = _write_artifact(
                output_dir=output_dir,
                relative_path="gates/janus-q-evidence-v1.json",
                payload=summary_payload,
                client=client,
                bucket=bucket,
                prefix=artifact_prefix,
            )
            for job_type, job_name, payload, artifact_ref in (
                ("janus_event_car", "janus event car", event_payload, event_ref),
                ("janus_hgrm_reward", "janus hgrm reward", reward_payload, reward_ref),
            ):
                upsert_empirical_job_run(
                    session=session,
                    run_id=run_id,
                    candidate_id=candidate_id,
                    job_name=job_name,
                    job_type=job_type,
                    job_run_id=f"{janus_job_run_id}:{job_type}",
                    status="completed"
                    if bool(payload.get("promotion_authority_eligible"))
                    else "degraded",
                    authority=(
                        "empirical"
                        if bool(_as_dict(payload.get("artifact_authority")).get("authoritative"))
                        else "blocked"
                    ),
                    promotion_authority_eligible=bool(payload.get("promotion_authority_eligible")),
                    dataset_snapshot_ref=dataset_snapshot_ref or None,
                    artifact_refs=[artifact_ref, summary_ref],
                    payload=payload,
                )
            artifacts_summary["janus_event_car"] = event_ref
            artifacts_summary["janus_hgrm_reward"] = reward_ref
            artifacts_summary["janus_q"] = summary_ref
            jobs_summary["janus_q"] = {
                "job_run_id": janus_job_run_id,
                "eligible": bool(summary_payload.get("promotion_authority_eligible")),
            }

        session.commit()

    summary_path = output_dir / "empirical-job-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(summary, separators=(",", ":")))
    else:
        print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
