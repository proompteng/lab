# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
#!/usr/bin/env python3
"""Renew empirical promotion artifacts from the latest authoritative replay outputs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time as wall_time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

import psycopg
import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import AutoresearchEpoch, VNextEmpiricalJobRun
from app.trading.empirical_jobs import (
    EMPIRICAL_JOB_TYPES,
    empirical_artifact_truthfulness_reasons,
)
from app.trading.empirical_manifest import (
    normalize_empirical_promotion_manifest,
    validate_empirical_promotion_manifest,
)
from app.trading.paper_route_target_plan import paper_route_target_plan_from_payload

# ruff: noqa: F401

from .shared_context import (
    DEFAULT_AUTORESEARCH_RUNTIME_WINDOW_STATUSES,
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
    MATERIALIZABLE_SOURCE_ROW_COUNT_KEYS,
    OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT,
    PAPER_ROUTE_REPLAY_ACCOUNT_LABEL,
    PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
    RUNTIME_WINDOW_TARGET_METADATA_KEYS,
    RUNTIME_WINDOW_TARGET_PLAN_DEFERRED_REASONS,
    RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES,
    RuntimeWindowImportTarget,
    SIM_BACKED_PAPER_ROUTE_SOURCE_KINDS,
    SIM_DB_DSN_ENV,
    SOURCE_COLLECTION_ONLY_PLAN_SOURCES,
    US_EQUITIES_CLOSE,
    US_EQUITIES_OPEN,
    US_EQUITIES_TIMEZONE,
    as_dict as _as_dict,
    as_sequence as _as_sequence,
    as_text as _as_text,
    as_text_list as _as_text_list,
    nonnegative_int as _nonnegative_int,
    normalized_sim_backed_source_account_label as _normalized_sim_backed_source_account_label,
    parse_args as _parse_args,
    parse_dt as _parse_dt,
    read_runtime_window_manifest as _read_runtime_window_manifest,
    runtime_manifest_delay_depth_stress_report_ref as _runtime_manifest_delay_depth_stress_report_ref,
    runtime_manifest_entry_requirements as _runtime_manifest_entry_requirements,
    runtime_manifest_requires_delay_depth_stress as _runtime_manifest_requires_delay_depth_stress,
    runtime_version_ref as _runtime_version_ref,
    runtime_window_delay_depth_remediation as _runtime_window_delay_depth_remediation,
    runtime_window_target_is_paper_route_collection as _runtime_window_target_is_paper_route_collection,
    runtime_window_target_plan_import_blocked_result as _runtime_window_target_plan_import_blocked_result,
    utc_iso as _utc_iso,
)
from .parse_runtime_window_target_spec import (
    extend_unique_text_items as _extend_unique_text_items,
    hpairs_source_proof_census_attachment_blockers as _hpairs_source_proof_census_attachment_blockers,
    hpairs_source_proof_census_status as _hpairs_source_proof_census_status,
    latest_closed_runtime_window_target_plan_from_payload as _latest_closed_runtime_window_target_plan_from_payload,
    parse_runtime_window_target_spec as _parse_runtime_window_target_spec,
    read_json_mapping as _read_json_mapping,
    read_runtime_window_target_plan as _read_runtime_window_target_plan,
    runtime_window_audit_target_blocker_matches as _runtime_window_audit_target_blocker_matches,
    runtime_window_gate_allows_source_collection_merge as _runtime_window_gate_allows_source_collection_merge,
    runtime_window_import_audit_blockers as _runtime_window_import_audit_blockers,
    runtime_window_plan_target_items as _runtime_window_plan_target_items,
    runtime_window_source_collection_target_allowed as _runtime_window_source_collection_target_allowed,
    runtime_window_source_collection_target_has_materializable_lineage as _runtime_window_source_collection_target_has_materializable_lineage,
    runtime_window_target_plan_from_payload as _runtime_window_target_plan_from_payload,
    runtime_window_target_plan_is_source_collection_only as _runtime_window_target_plan_is_source_collection_only,
    runtime_window_target_plan_positive_mapping_count as _runtime_window_target_plan_positive_mapping_count,
    runtime_window_target_plan_source_collection_targets as _runtime_window_target_plan_source_collection_targets,
    runtime_window_target_plan_target_key as _runtime_window_target_plan_target_key,
    runtime_window_target_plan_target_truthy as _runtime_window_target_plan_target_truthy,
    runtime_window_target_plan_with_import_audit_blockers as _runtime_window_target_plan_with_import_audit_blockers,
    runtime_window_target_plan_with_live_gate_source_collection as _runtime_window_target_plan_with_live_gate_source_collection,
    runtime_window_target_plan_without_paper_route_source_collection_only as _runtime_window_target_plan_without_paper_route_source_collection_only,
    target_strategy_names as _target_strategy_names,
    target_text as _target_text,
)
from .raise_if_runtime_window_target_plan_import import (
    canonical_runtime_strategy_name as _canonical_runtime_strategy_name,
    latest_autoresearch_runtime_window_targets as _latest_autoresearch_runtime_window_targets,
    looks_like_uuid_text as _looks_like_uuid_text,
    raise_if_runtime_window_target_plan_import_blocked as _raise_if_runtime_window_target_plan_import_blocked,
    read_runtime_window_target_plan_url as _read_runtime_window_target_plan_url,
    read_runtime_window_target_plan_url_once as _read_runtime_window_target_plan_url_once,
    registry_runtime_window_targets as _registry_runtime_window_targets,
    runtime_family_harnesses as _runtime_family_harnesses,
    runtime_window_autoresearch_statuses as _runtime_window_autoresearch_statuses,
    runtime_window_plan_targets as _runtime_window_plan_targets,
    runtime_window_target_artifact_refs as _runtime_window_target_artifact_refs,
    runtime_window_target_identity as _runtime_window_target_identity,
    runtime_window_target_metadata as _runtime_window_target_metadata,
    runtime_window_target_plan_has_targets as _runtime_window_target_plan_has_targets,
    runtime_window_target_plan_ref_count as _runtime_window_target_plan_ref_count,
    runtime_window_target_plan_transient_empty_reason as _runtime_window_target_plan_transient_empty_reason,
    runtime_window_target_plan_url_error_retryable as _runtime_window_target_plan_url_error_retryable,
    runtime_window_targets_from_autoresearch_epochs as _runtime_window_targets_from_autoresearch_epochs,
    runtime_window_targets_from_plan as _runtime_window_targets_from_plan,
    strategy_lookup_names as _strategy_lookup_names,
    strategy_name_from_strategy_id as _strategy_name_from_strategy_id,
)
from .runtime_window_targets import (
    explicit_runtime_window_bounds as _explicit_runtime_window_bounds,
    latest_authoritative_rows as _latest_authoritative_rows,
    latest_completed_regular_session as _latest_completed_regular_session,
    latest_source_activity_window as _latest_source_activity_window,
    load_latest_empirical_job_rows as _load_latest_empirical_job_rows,
    offline_replay_artifact_refs as _offline_replay_artifact_refs,
    offline_replay_exact_artifact_refs as _offline_replay_exact_artifact_refs,
    offline_replay_triage_candidate_from_import as _offline_replay_triage_candidate_from_import,
    offline_replay_triage_candidate_from_ranking as _offline_replay_triage_candidate_from_ranking,
    offline_replay_triage_from_artifact_payload as _offline_replay_triage_from_artifact_payload,
    offline_replay_triage_source_kind as _offline_replay_triage_source_kind,
    regular_session_for_timestamp as _regular_session_for_timestamp,
    run_runtime_window_import as _run_runtime_window_import,
    runtime_window_bounds as _runtime_window_bounds,
    runtime_window_import_is_paper_route as _runtime_window_import_is_paper_route,
    runtime_window_target_plan_bounds as _runtime_window_target_plan_bounds,
    runtime_window_targets as _runtime_window_targets,
    source_strategy_name_candidates as _source_strategy_name_candidates,
    build_renewal_manifest,
)
from .offline_replay_triage_candidates_from_rank import (
    offline_replay_triage_candidates_from_ranking as _offline_replay_triage_candidates_from_ranking,
    offline_replay_triage_for_deferred_imports as _offline_replay_triage_for_deferred_imports,
    offline_replay_triage_source_reports as _offline_replay_triage_source_reports,
    run_runtime_window_source_window_repair as _run_runtime_window_source_window_repair,
    runtime_window_import_blocker_ladder as _runtime_window_import_blocker_ladder,
    runtime_window_import_health_gate_args as _runtime_window_import_health_gate_args,
    runtime_window_import_ladder_step as _runtime_window_import_ladder_step,
    runtime_window_import_needs_source_window_repair as _runtime_window_import_needs_source_window_repair,
    runtime_window_import_next_blocker as _runtime_window_import_next_blocker,
    runtime_window_import_payload_proof_blockers as _runtime_window_import_payload_proof_blockers,
    runtime_window_source_collection_materialization_blocked_result as _runtime_window_source_collection_materialization_blocked_result,
)


def _renewal_root_export(name: str, fallback: Any) -> Any:
    root_module = sys.modules.get("scripts.renew_latest_empirical_promotion_jobs")
    if root_module is None:
        return fallback
    return getattr(root_module, name, fallback)


def _run_runtime_window_import_target(
    *,
    args: argparse.Namespace,
    target: RuntimeWindowImportTarget,
    manifest: Mapping[str, Any],
    run_id: str,
    manifest_path: Path,
    window_start: datetime,
    window_end: datetime,
    now: datetime,
    allow_source_activity_window: bool = False,
) -> dict[str, Any]:
    read_runtime_window_manifest = _renewal_root_export(
        "_read_runtime_window_manifest",
        _read_runtime_window_manifest,
    )
    runtime_manifest = read_runtime_window_manifest(target.source_manifest_ref)
    window_selection = "explicit_or_default"
    target_plan_window = _runtime_window_target_plan_bounds(target)
    if target_plan_window is not None:
        window_start, window_end = target_plan_window
        window_selection = "target_plan_window"
    elif allow_source_activity_window:
        latest_source_activity_window = _renewal_root_export(
            "_latest_source_activity_window",
            _latest_source_activity_window,
        )
        source_activity_window = latest_source_activity_window(
            target=target,
            runtime_manifest=runtime_manifest,
        )
        if source_activity_window is not None:
            window_start, window_end = source_activity_window
            window_selection = "source_execution_activity_span"
        else:
            window_selection = "latest_completed_regular_session_no_source_activity"
    proof_blockers: list[dict[str, Any]] = []
    candidate_id = (
        _as_text(target.candidate_id)
        or _as_text(runtime_manifest.get("candidate_id"))
        or _as_text(manifest.get("candidate_id"))
    )
    if candidate_id is None:
        raise RuntimeError("runtime_window_candidate_id_missing")
    target_plan_settlement_seconds = int(
        getattr(args, "runtime_window_target_plan_settlement_seconds", 0) or 0
    )
    if target_plan_settlement_seconds < 0:
        raise RuntimeError("runtime_window_target_plan_settlement_seconds_negative")
    target_plan_ready_at = window_end + timedelta(
        seconds=target_plan_settlement_seconds
    )
    if target_plan_window is not None and (
        window_end > now or target_plan_ready_at > now
    ):
        if window_end > now:
            blocker_type = "runtime_window_target_plan_window_not_closed"
            remediation = "wait_until_target_plan_window_closes_before_runtime_import"
        else:
            blocker_type = "runtime_window_target_plan_window_settlement_pending"
            remediation = "wait_until_target_plan_window_settlement_grace_elapses_before_runtime_import"
        proof_blockers.append(
            {
                "type": blocker_type,
                "hypothesis_id": target.hypothesis_id,
                "candidate_id": candidate_id,
                "window_start": _utc_iso(window_start),
                "window_end": _utc_iso(window_end),
                "now": _utc_iso(now),
                "settlement_seconds": target_plan_settlement_seconds,
                "settlement_ready_at": _utc_iso(target_plan_ready_at),
                "remediation": remediation,
            }
        )
        return {
            "status": "deferred",
            "reason": blocker_type,
            "window_start": _utc_iso(window_start),
            "window_end": _utc_iso(window_end),
            "window_selection": window_selection,
            "hypothesis_id": target.hypothesis_id,
            "candidate_id": candidate_id,
            "strategy_name": target.strategy_name,
            "account_label": target.account_label,
            "source_account_label": target.source_account_label or target.account_label,
            "source_kind": target.source_kind,
            "artifact_refs": [str(manifest_path), *target.artifact_refs],
            "target_metadata": dict(target.target_metadata or {}),
            "proof_status": "deferred",
            "proof_blockers": proof_blockers,
            "summary": None,
        }
    blocked_result = _runtime_window_target_plan_import_blocked_result(
        target=target,
        candidate_id=candidate_id,
        manifest_path=manifest_path,
        window_start=window_start,
        window_end=window_end,
        window_selection=window_selection,
    )
    if blocked_result is not None:
        return blocked_result
    source_collection_materialization_blocked = (
        _runtime_window_source_collection_materialization_blocked_result(
            target=target,
            candidate_id=candidate_id,
            manifest_path=manifest_path,
            window_start=window_start,
            window_end=window_end,
            window_selection=window_selection,
        )
    )
    if source_collection_materialization_blocked is not None:
        return source_collection_materialization_blocked
    delay_depth_report_ref = _runtime_manifest_delay_depth_stress_report_ref(
        target=target,
        runtime_manifest=runtime_manifest,
    )
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
    dependency_quorum_decision, continuity_ok, drift_ok = (
        _runtime_window_import_health_gate_args(
            target=target,
            runtime_manifest=runtime_manifest,
        )
    )
    audit_only = bool(getattr(args, "runtime_window_import_audit_only", False))
    source_window_repair = _run_runtime_window_source_window_repair(
        target=target,
        window_start=window_start,
        window_end=window_end,
        audit_only=audit_only,
    )
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
        "--source-account-label",
        target.source_account_label or target.account_label,
        "--artifact-ref",
        str(manifest_path),
        "--dependency-quorum-decision",
        dependency_quorum_decision,
        "--continuity-ok",
        continuity_ok,
        "--drift-ok",
        drift_ok,
        "--json",
    ]
    if target.target_dsn_env:
        command.extend(["--target-dsn-env", target.target_dsn_env])
    if audit_only:
        command.append("--audit-only")
    for artifact_ref in target.artifact_refs:
        command.extend(["--artifact-ref", artifact_ref])
    if target.target_metadata:
        command.extend(
            [
                "--target-metadata-json",
                json.dumps(dict(target.target_metadata), sort_keys=True),
            ]
        )
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
    if not isinstance(payload, Mapping):
        raise RuntimeError("runtime_window_import_payload_not_mapping")
    payload = dict(payload)
    if source_window_repair is not None:
        payload["source_window_repair"] = source_window_repair
    runtime_observation = _as_dict(payload.get("runtime_observation"))
    source_activity_diagnostics = _as_dict(payload.get("source_activity_diagnostics"))
    if not source_activity_diagnostics and runtime_observation:
        source_activity_diagnostics = _as_dict(
            runtime_observation.get("source_activity_diagnostics")
        )
    source_activity_diagnostic_blockers = _as_text_list(
        payload.get("source_activity_diagnostic_blockers")
    )
    if not source_activity_diagnostic_blockers and runtime_observation:
        source_activity_diagnostic_blockers = _as_text_list(
            runtime_observation.get("source_activity_diagnostic_blockers")
        )
    payload_proof_blockers = _runtime_window_import_payload_proof_blockers(
        payload=payload,
        target=target,
        candidate_id=candidate_id,
        window_start=window_start,
        window_end=window_end,
    )
    proof_blockers.extend(payload_proof_blockers)
    if audit_only:
        proof_blockers.append(
            {
                "blocker": "runtime_window_import_audit_only_no_persistence",
                "hypothesis_id": target.hypothesis_id,
                "candidate_id": candidate_id,
                "observed_stage": target.observed_stage,
                "window_start": _utc_iso(window_start),
                "window_end": _utc_iso(window_end),
                "remediation": (
                    "Use the audit counts to repair source, execution, TCA, or "
                    "runtime-ledger materialization, then rerun the normal "
                    "runtime-window import before promotion."
                ),
            }
        )
    blocker_ladder = _runtime_window_import_blocker_ladder(
        payload=payload,
        target=target,
        candidate_id=candidate_id,
        window_start=window_start,
        window_end=window_end,
        proof_blockers=proof_blockers,
    )
    next_blocker = _runtime_window_import_next_blocker(blocker_ladder)
    return {
        "status": "audit_only" if audit_only else "ok",
        "command": " ".join(command[:2] + ["..."]),
        "window_start": _utc_iso(window_start),
        "window_end": _utc_iso(window_end),
        "window_selection": window_selection,
        "hypothesis_id": target.hypothesis_id,
        "candidate_id": candidate_id,
        "strategy_name": target.strategy_name,
        "account_label": target.account_label,
        "source_account_label": target.source_account_label or target.account_label,
        "source_dsn_env": target.source_dsn_env,
        "target_dsn_env": target.target_dsn_env,
        "source_kind": target.source_kind,
        "artifact_refs": [str(manifest_path), *target.artifact_refs],
        "target_metadata": dict(target.target_metadata or {}),
        "source_window_repair": source_window_repair,
        "source_activity_diagnostics": source_activity_diagnostics,
        "source_activity_diagnostic_blockers": source_activity_diagnostic_blockers,
        "proof_status": "blocked" if proof_blockers else "ok",
        "proof_blockers": proof_blockers,
        "blocker_ladder": blocker_ladder,
        "next_blocker": next_blocker,
        "summary": payload,
    }


def main() -> int:
    args = _parse_args()
    now = datetime.now(tz=timezone.utc)
    run_id = f"{args.run_id_prefix}-{now.strftime('%Y%m%dT%H%M%SZ')}"
    output_dir = Path(args.output_dir) / run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "empirical-promotion-manifest.yaml"
    hpairs_source_proof_census_file = getattr(
        args, "hpairs_source_proof_census_file", None
    )
    hpairs_source_proof_census = (
        _read_json_mapping(hpairs_source_proof_census_file)
        if hpairs_source_proof_census_file is not None
        else None
    )
    hpairs_source_proof_census_status = _hpairs_source_proof_census_status(
        hpairs_source_proof_census
    )

    with SessionLocal() as session:
        manifest = build_renewal_manifest(
            latest=_latest_authoritative_rows(_load_latest_empirical_job_rows(session)),
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
        "promotion_allowed": False,
        "final_authority_ok": False,
        "hpairs_source_proof_census_runtime_authority_final_ok": bool(
            hpairs_source_proof_census_status.get("runtime_authority_final_ok")
        ),
        "hpairs_source_proof_census": hpairs_source_proof_census_status,
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


# Public aliases used by split-module consumers.
run_runtime_window_import_target = _run_runtime_window_import_target

__all__ = (
    "main",
    "run_runtime_window_import_target",
)
