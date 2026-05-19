#!/usr/bin/env python3
"""Renew empirical promotion artifacts from the latest authoritative replay outputs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
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
    parser.add_argument(
        "--runtime-window-target",
        action="append",
        default=[],
        help=(
            "Repeatable comma-separated key=value runtime import target. "
            "Supported keys: hypothesis_id,candidate_id,strategy_family,"
            "strategy_name,account_label,observed_stage,source_dsn_env,"
            "dataset_snapshot_ref,source_manifest_ref,source_kind,"
            "delay_adjusted_depth_stress_report_ref."
        ),
    )
    parser.add_argument("--runtime-window-hypothesis-id", default="H-TSMOM-01")
    parser.add_argument("--runtime-window-candidate-id", default="")
    parser.add_argument(
        "--runtime-window-strategy-family",
        default="intraday_tsmom_consistent",
    )
    parser.add_argument(
        "--runtime-window-strategy-name",
        default="intraday-tsmom-profit-v3",
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
    parser.add_argument("--runtime-window-dataset-snapshot-ref", default="")
    parser.add_argument("--runtime-window-bucket-minutes", type=int, default=30)
    parser.add_argument("--runtime-window-sample-minutes", type=int, default=5)
    parser.add_argument(
        "--runtime-window-source-manifest-ref",
        default="config/trading/hypotheses/h-tsmom-01.json",
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


def _read_runtime_window_manifest(ref: str) -> dict[str, Any]:
    path_text = ref.strip()
    if not path_text:
        return {}
    path = Path(path_text)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _as_dict(payload)


def _runtime_manifest_entry_requirements(
    runtime_manifest: Mapping[str, Any],
) -> dict[str, Any]:
    return _as_dict(runtime_manifest.get("entry_requirements"))


def _runtime_manifest_requires_delay_depth_stress(
    runtime_manifest: Mapping[str, Any],
) -> bool:
    requirements = _runtime_manifest_entry_requirements(runtime_manifest)
    return bool(requirements.get("require_delay_adjusted_depth_stress"))


def _runtime_manifest_delay_depth_stress_report_ref(
    *,
    target: "RuntimeWindowImportTarget",
    runtime_manifest: Mapping[str, Any],
) -> str | None:
    return (
        _as_text(target.delay_adjusted_depth_stress_report_ref)
        or _as_text(runtime_manifest.get("delay_adjusted_depth_stress_report_ref"))
        or _as_text(runtime_manifest.get("delay_adjusted_depth_stress_report_path"))
    )


def _runtime_window_delay_depth_remediation(
    *,
    target: "RuntimeWindowImportTarget",
    runtime_manifest: Mapping[str, Any],
) -> dict[str, Any]:
    requirements = _runtime_manifest_entry_requirements(runtime_manifest)
    return {
        "blocker": "delay_adjusted_depth_stress_report_ref_missing",
        "hypothesis_id": target.hypothesis_id,
        "strategy_name": target.strategy_name,
        "source_manifest_ref": target.source_manifest_ref,
        "required_by": "entry_requirements.require_delay_adjusted_depth_stress",
        "min_checks": requirements.get("min_delay_adjusted_depth_stress_checks"),
        "max_age_minutes": requirements.get(
            "max_delay_adjusted_depth_stress_age_minutes"
        ),
        "remediation": (
            "generate a fresh runtime-closure delay-adjusted-depth-stress.json "
            "artifact for this candidate/window and pass it as "
            "delay_adjusted_depth_stress_report_ref in the runtime-window target "
            "or record it in the hypothesis manifest"
        ),
    }


@dataclass(frozen=True)
class RuntimeWindowImportTarget:
    hypothesis_id: str
    candidate_id: str
    observed_stage: str
    strategy_family: str
    source_dsn_env: str
    strategy_name: str
    account_label: str
    dataset_snapshot_ref: str
    source_manifest_ref: str
    source_kind: str
    delay_adjusted_depth_stress_report_ref: str


def _parse_runtime_window_target_spec(spec: str) -> dict[str, str]:
    text = spec.strip()
    if not text:
        return {}
    if text.startswith("{"):
        payload = json.loads(text)
        if not isinstance(payload, Mapping):
            raise RuntimeError("runtime_window_target_json_not_mapping")
        return {
            str(key).replace("-", "_"): str(value)
            for key, value in payload.items()
            if value is not None
        }
    parsed: dict[str, str] = {}
    for part in text.split(","):
        item = part.strip()
        if not item:
            continue
        if "=" not in item:
            raise RuntimeError(f"runtime_window_target_invalid:{item}")
        key, value = item.split("=", 1)
        normalized_key = key.strip().replace("-", "_")
        normalized_value = value.strip()
        if not normalized_key or not normalized_value:
            raise RuntimeError(f"runtime_window_target_invalid:{item}")
        parsed[normalized_key] = normalized_value
    return parsed


def _runtime_window_targets(
    args: argparse.Namespace,
) -> list[RuntimeWindowImportTarget]:
    specs = [str(item) for item in getattr(args, "runtime_window_target", []) or []]
    if not specs:
        specs = [""]
    targets: list[RuntimeWindowImportTarget] = []
    for spec in specs:
        payload = _parse_runtime_window_target_spec(spec)

        def value(key: str, legacy_name: str) -> str:
            return str(payload.get(key) or getattr(args, legacy_name, "") or "").strip()

        hypothesis_id = value("hypothesis_id", "runtime_window_hypothesis_id")
        strategy_family = value("strategy_family", "runtime_window_strategy_family")
        strategy_name = value("strategy_name", "runtime_window_strategy_name")
        if not hypothesis_id:
            raise RuntimeError("runtime_window_target_hypothesis_id_missing")
        if not strategy_family:
            raise RuntimeError("runtime_window_target_strategy_family_missing")
        if not strategy_name:
            raise RuntimeError("runtime_window_target_strategy_name_missing")
        targets.append(
            RuntimeWindowImportTarget(
                hypothesis_id=hypothesis_id,
                candidate_id=value("candidate_id", "runtime_window_candidate_id"),
                observed_stage=value("observed_stage", "runtime_window_observed_stage")
                or "paper",
                strategy_family=strategy_family,
                source_dsn_env=value("source_dsn_env", "runtime_window_source_dsn_env")
                or "DB_DSN",
                strategy_name=strategy_name,
                account_label=value("account_label", "runtime_window_account_label")
                or "TORGHUT_SIM",
                dataset_snapshot_ref=value(
                    "dataset_snapshot_ref",
                    "runtime_window_dataset_snapshot_ref",
                ),
                source_manifest_ref=value(
                    "source_manifest_ref",
                    "runtime_window_source_manifest_ref",
                ),
                source_kind=value("source_kind", "runtime_window_source_kind")
                or "paper_runtime_observed",
                delay_adjusted_depth_stress_report_ref=value(
                    "delay_adjusted_depth_stress_report_ref",
                    "runtime_window_delay_adjusted_depth_stress_report_ref",
                ),
            )
        )
    return targets


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
    window_start, window_end = _runtime_window_bounds(args, now)
    imports: list[dict[str, Any]] = []
    for target in _runtime_window_targets(args):
        imports.append(
            _run_runtime_window_import_target(
                args=args,
                target=target,
                manifest=manifest,
                run_id=run_id,
                manifest_path=manifest_path,
                window_start=window_start,
                window_end=window_end,
            )
        )
    if len(imports) == 1:
        return imports[0]
    proof_blockers = [
        blocker
        for item in imports
        for blocker in item.get("proof_blockers", [])
        if isinstance(blocker, Mapping)
    ]
    return {
        "status": "ok",
        "proof_status": "blocked" if proof_blockers else "ok",
        "proof_blockers": proof_blockers,
        "target_count": len(imports),
        "imports": imports,
    }


def _run_runtime_window_import_target(
    *,
    args: argparse.Namespace,
    target: RuntimeWindowImportTarget,
    manifest: Mapping[str, Any],
    run_id: str,
    manifest_path: Path,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, Any]:
    runtime_manifest = _read_runtime_window_manifest(target.source_manifest_ref)
    delay_depth_report_ref = _runtime_manifest_delay_depth_stress_report_ref(
        target=target,
        runtime_manifest=runtime_manifest,
    )
    proof_blockers: list[dict[str, Any]] = []
    if (
        _runtime_manifest_requires_delay_depth_stress(runtime_manifest)
        and delay_depth_report_ref is None
    ):
        proof_blockers.append(
            _runtime_window_delay_depth_remediation(
                target=target,
                runtime_manifest=runtime_manifest,
            )
        )
    candidate_id = (
        _as_text(target.candidate_id)
        or _as_text(runtime_manifest.get("candidate_id"))
        or _as_text(manifest.get("candidate_id"))
    )
    if candidate_id is None:
        raise RuntimeError("runtime_window_candidate_id_missing")
    command = [
        sys.executable,
        "scripts/import_hypothesis_runtime_windows.py",
        "--run-id",
        run_id,
        "--candidate-id",
        candidate_id,
        "--hypothesis-id",
        target.hypothesis_id,
        "--observed-stage",
        target.observed_stage,
        "--strategy-family",
        target.strategy_family,
        "--source-dsn-env",
        target.source_dsn_env,
        "--strategy-name",
        target.strategy_name,
        "--account-label",
        target.account_label,
        "--window-start",
        _utc_iso(window_start),
        "--window-end",
        _utc_iso(window_end),
        "--bucket-minutes",
        str(args.runtime_window_bucket_minutes),
        "--sample-minutes",
        str(args.runtime_window_sample_minutes),
        "--source-manifest-ref",
        target.source_manifest_ref,
        "--source-kind",
        target.source_kind,
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
    dataset_snapshot_ref = (
        _as_text(target.dataset_snapshot_ref)
        or _as_text(runtime_manifest.get("dataset_snapshot_ref"))
        or _as_text(manifest.get("dataset_snapshot_ref"))
    )
    if dataset_snapshot_ref is not None:
        command.extend(["--dataset-snapshot-ref", dataset_snapshot_ref])
    if delay_depth_report_ref is not None:
        command.extend(
            ["--delay-adjusted-depth-stress-report-ref", delay_depth_report_ref]
        )
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    return {
        "status": "ok",
        "command": " ".join(command[:2] + ["..."]),
        "window_start": _utc_iso(window_start),
        "window_end": _utc_iso(window_end),
        "hypothesis_id": target.hypothesis_id,
        "strategy_name": target.strategy_name,
        "account_label": target.account_label,
        "proof_status": "blocked" if proof_blockers else "ok",
        "proof_blockers": proof_blockers,
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
