#!/usr/bin/env python3
"""Renew empirical promotion artifacts from the latest authoritative replay outputs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import yaml
from sqlalchemy import select

from app.db import SessionLocal
from app.models import VNextEmpiricalJobRun
from app.trading.empirical_jobs import (
    EMPIRICAL_JOB_TYPES,
    empirical_artifact_truthfulness_reasons,
)
from app.trading.empirical_manifest import (
    normalize_empirical_promotion_manifest,
    validate_empirical_promotion_manifest,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Re-run empirical promotion assembly against the latest authoritative "
            "replay outputs, preserving source lineage in the renewal manifest."
        ),
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--strategy-spec-ref",
        default="microbar_volume_continuation_long_top2_chip_v1@paper",
    )
    parser.add_argument(
        "--run-id-prefix", default="sim-2026-05-05-chip-4c330ce9-r1-renew"
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _as_dict(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _runtime_version_ref() -> str:
    digest = _as_text(os.getenv("TORGHUT_IMAGE_DIGEST")) or _as_text(
        os.getenv("BUILD_IMAGE_DIGEST")
    )
    if digest and digest.startswith("sha256:"):
        return f"services/torghut@{digest}"
    return digest or "services/torghut@unknown"


def _latest_authoritative_rows(
    rows: Sequence[VNextEmpiricalJobRun],
) -> dict[str, VNextEmpiricalJobRun]:
    latest: dict[str, VNextEmpiricalJobRun] = {}
    for row in rows:
        if row.job_type not in EMPIRICAL_JOB_TYPES or row.job_type in latest:
            continue
        payload = _as_dict(row.payload_json)
        truthful_reasons = empirical_artifact_truthfulness_reasons(payload)
        if (
            row.status != "completed"
            or row.authority != "empirical"
            or not row.promotion_authority_eligible
            or truthful_reasons
        ):
            raise RuntimeError(
                "latest_empirical_job_not_authoritative:"
                f"{row.job_type}:{row.status}:{row.authority}:{','.join(truthful_reasons)}"
            )
        latest[row.job_type] = row
        if len(latest) == len(EMPIRICAL_JOB_TYPES):
            break
    missing = [job_type for job_type in EMPIRICAL_JOB_TYPES if job_type not in latest]
    if missing:
        raise RuntimeError(f"latest_empirical_jobs_missing:{','.join(missing)}")
    return latest


def build_renewal_manifest(
    *,
    latest: Mapping[str, VNextEmpiricalJobRun],
    run_id: str,
    strategy_spec_ref: str,
    runtime_version_ref: str,
) -> dict[str, Any]:
    benchmark = _as_dict(latest["benchmark_parity"].payload_json)
    foundation = _as_dict(latest["foundation_router_parity"].payload_json)
    event = _as_dict(latest["janus_event_car"].payload_json)
    reward = _as_dict(latest["janus_hgrm_reward"].payload_json)
    lineage = _as_dict(benchmark.get("lineage"))
    candidate_id = _as_text(latest["benchmark_parity"].candidate_id)
    dataset_snapshot_ref = _as_text(latest["benchmark_parity"].dataset_snapshot_ref)
    if candidate_id is None or dataset_snapshot_ref is None:
        raise RuntimeError("latest_empirical_job_lineage_missing")

    manifest = normalize_empirical_promotion_manifest(
        {
            "schema_version": "torghut-empirical-promotion-manifest-v1",
            "run_id": run_id,
            "candidate_id": candidate_id,
            "baseline_candidate_id": benchmark.get("baseline_candidate_id")
            or "baseline",
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "artifact_prefix": f"empirical/{run_id}",
            "strategy_spec_ref": strategy_spec_ref,
            "benchmark_parity": {
                "benchmark_runs": benchmark.get("benchmark_runs") or [],
                "scorecards": benchmark.get("scorecards") or {},
                "degradation_summary": benchmark.get("degradation_summary") or {},
            },
            "foundation_router_parity": {
                "router_policy_version": foundation.get("router_policy_version")
                or "forecast_router_policy_v1",
                "adapters": foundation.get("adapters") or [],
                "slice_metrics": foundation.get("slice_metrics") or {},
                "calibration_metrics": foundation.get("calibration_metrics") or {},
                "latency_metrics": foundation.get("latency_metrics") or {},
                "fallback_metrics": foundation.get("fallback_metrics") or {},
                "drift_metrics": foundation.get("drift_metrics") or {},
                "overall_status": foundation.get("overall_status") or "pass",
            },
            "janus_event_car": {
                key: value
                for key, value in event.items()
                if key
                not in {"artifact_authority", "lineage", "promotion_authority_eligible"}
            },
            "janus_hgrm_reward": {
                key: value
                for key, value in reward.items()
                if key
                not in {"artifact_authority", "lineage", "promotion_authority_eligible"}
            },
            "model_refs": lineage.get("model_refs")
            or ["rules/chip-paper-microbar-composite"],
            "runtime_version_refs": [runtime_version_ref],
            "authority": {
                "generated_from_simulation_outputs": True,
                "source_artifacts": {
                    "source_empirical_job_run_ids": {
                        job_type: latest[job_type].job_run_id
                        for job_type in EMPIRICAL_JOB_TYPES
                    },
                    "source_created_at": {
                        job_type: latest[job_type].created_at.isoformat()
                        for job_type in EMPIRICAL_JOB_TYPES
                    },
                    "renewal_reason": (
                        "re-run empirical promotion assembly against latest authoritative "
                        "replay outputs using the deployed runtime image"
                    ),
                },
            },
            "promotion_authority_eligible": True,
        }
    )
    validation_errors = validate_empirical_promotion_manifest(manifest)
    if validation_errors:
        raise RuntimeError(
            "invalid_renewal_manifest:" + ",".join(sorted(set(validation_errors)))
        )
    return manifest


def main() -> int:
    args = _parse_args()
    now = datetime.now(tz=timezone.utc)
    run_id = f"{args.run_id_prefix}-{now.strftime('%Y%m%dT%H%M%SZ')}"
    output_dir = Path(args.output_dir) / run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "empirical-promotion-manifest.yaml"

    with SessionLocal() as session:
        rows = (
            session.execute(
                select(VNextEmpiricalJobRun).order_by(
                    VNextEmpiricalJobRun.created_at.desc()
                )
            )
            .scalars()
            .all()
        )
        manifest = build_renewal_manifest(
            latest=_latest_authoritative_rows(rows),
            run_id=run_id,
            strategy_spec_ref=args.strategy_spec_ref,
            runtime_version_ref=_runtime_version_ref(),
        )

    manifest_path.write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8"
    )
    command = [
        sys.executable,
        "scripts/run_empirical_promotion_jobs.py",
        "--manifest",
        str(manifest_path),
        "--output-dir",
        str(output_dir),
        "--json",
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    payload = {
        "status": "ok",
        "run_id": run_id,
        "manifest_path": str(manifest_path),
        "output_dir": str(output_dir),
        "empirical_promotion": json.loads(result.stdout),
    }
    print(
        json.dumps(payload, separators=(",", ":"))
        if args.json
        else json.dumps(payload, indent=2)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
