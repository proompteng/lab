#!/usr/bin/env python3
"""Renew empirical promotion artifacts from the latest authoritative replay outputs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

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

US_EQUITIES_TIMEZONE = "America/New_York"
US_EQUITIES_OPEN = time(9, 30)
US_EQUITIES_CLOSE = time(16, 0)


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
    parser.add_argument("--runtime-window-import", action="store_true")
    parser.add_argument("--runtime-window-hypothesis-id", default="H-PAIRS-01")
    parser.add_argument(
        "--runtime-window-strategy-family",
        default="microbar_cross_sectional_pairs",
    )
    parser.add_argument(
        "--runtime-window-strategy-name",
        default="microbar-cross-sectional-pairs-v1",
    )
    parser.add_argument("--runtime-window-account-label", default="TORGHUT_SIM")
    parser.add_argument(
        "--runtime-window-observed-stage",
        default="paper",
        choices=("paper", "live"),
    )
    parser.add_argument("--runtime-window-source-dsn-env", default="DB_DSN")
    parser.add_argument("--runtime-window-start", default="")
    parser.add_argument("--runtime-window-end", default="")
    parser.add_argument("--runtime-window-bucket-minutes", type=int, default=30)
    parser.add_argument("--runtime-window-sample-minutes", type=int, default=5)
    parser.add_argument(
        "--runtime-window-source-manifest-ref",
        default="config/trading/hypotheses/h-pairs-01.json",
    )
    parser.add_argument(
        "--runtime-window-source-kind", default="paper_runtime_observed"
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


def _utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _latest_completed_regular_session(now: datetime) -> tuple[datetime, datetime]:
    zone = ZoneInfo(US_EQUITIES_TIMEZONE)
    local_now = now.astimezone(zone)
    session_date = local_now.date()
    if (
        local_now.weekday() >= 5
        or local_now.timetz().replace(tzinfo=None) < US_EQUITIES_CLOSE
    ):
        session_date -= timedelta(days=1)
    while session_date.weekday() >= 5:
        session_date -= timedelta(days=1)
    start = datetime.combine(session_date, US_EQUITIES_OPEN, tzinfo=zone)
    end = datetime.combine(session_date, US_EQUITIES_CLOSE, tzinfo=zone)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def _runtime_window_bounds(
    args: argparse.Namespace, now: datetime
) -> tuple[datetime, datetime]:
    start_arg = str(getattr(args, "runtime_window_start", "") or "").strip()
    end_arg = str(getattr(args, "runtime_window_end", "") or "").strip()
    if bool(start_arg) != bool(end_arg):
        raise RuntimeError("runtime_window_bounds_require_start_and_end")
    if start_arg and end_arg:
        start = _parse_dt(start_arg)
        end = _parse_dt(end_arg)
        if end <= start:
            raise RuntimeError("runtime_window_end_must_be_after_start")
        return start, end
    return _latest_completed_regular_session(now)


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


def _run_runtime_window_import(
    *,
    args: argparse.Namespace,
    manifest: Mapping[str, Any],
    run_id: str,
    manifest_path: Path,
    now: datetime,
) -> dict[str, Any] | None:
    if not bool(getattr(args, "runtime_window_import", False)):
        return None
    candidate_id = _as_text(manifest.get("candidate_id"))
    if candidate_id is None:
        raise RuntimeError("runtime_window_candidate_id_missing")
    window_start, window_end = _runtime_window_bounds(args, now)
    command = [
        sys.executable,
        "scripts/import_hypothesis_runtime_windows.py",
        "--run-id",
        run_id,
        "--candidate-id",
        candidate_id,
        "--hypothesis-id",
        args.runtime_window_hypothesis_id,
        "--observed-stage",
        args.runtime_window_observed_stage,
        "--strategy-family",
        args.runtime_window_strategy_family,
        "--source-dsn-env",
        args.runtime_window_source_dsn_env,
        "--strategy-name",
        args.runtime_window_strategy_name,
        "--account-label",
        args.runtime_window_account_label,
        "--window-start",
        _utc_iso(window_start),
        "--window-end",
        _utc_iso(window_end),
        "--bucket-minutes",
        str(args.runtime_window_bucket_minutes),
        "--sample-minutes",
        str(args.runtime_window_sample_minutes),
        "--source-manifest-ref",
        args.runtime_window_source_manifest_ref,
        "--source-kind",
        args.runtime_window_source_kind,
        "--artifact-ref",
        str(manifest_path),
        "--dependency-quorum-decision",
        "allow",
        "--continuity-ok",
        "true",
        "--drift-ok",
        "true",
        "--json",
    ]
    dataset_snapshot_ref = _as_text(manifest.get("dataset_snapshot_ref"))
    if dataset_snapshot_ref is not None:
        command.extend(["--dataset-snapshot-ref", dataset_snapshot_ref])
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    return {
        "status": "ok",
        "command": " ".join(command[:2] + ["..."]),
        "window_start": _utc_iso(window_start),
        "window_end": _utc_iso(window_end),
        "hypothesis_id": args.runtime_window_hypothesis_id,
        "strategy_name": args.runtime_window_strategy_name,
        "account_label": args.runtime_window_account_label,
        "summary": payload,
    }


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
    runtime_window_import = _run_runtime_window_import(
        args=args,
        manifest=manifest,
        run_id=run_id,
        manifest_path=manifest_path,
        now=now,
    )
    payload = {
        "status": "ok",
        "run_id": run_id,
        "manifest_path": str(manifest_path),
        "output_dir": str(output_dir),
        "empirical_promotion": json.loads(result.stdout),
        "runtime_window_import": runtime_window_import,
    }
    print(
        json.dumps(payload, separators=(",", ":"))
        if args.json
        else json.dumps(payload, indent=2)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
