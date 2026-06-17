from __future__ import annotations
from scripts.renew_latest_empirical_promotion_jobs_modules import (
    argparse,
    json,
    os,
    subprocess,
    sys,
    wall_time,
    urllib,
    dataclass,
    datetime,
    time,
    timedelta,
    timezone,
    Path,
    Any,
    Mapping,
    Sequence,
    ZoneInfo,
    psycopg,
    yaml,
    select,
    Session,
    SessionLocal,
    AutoresearchEpoch,
    VNextEmpiricalJobRun,
    EMPIRICAL_JOB_TYPES,
    empirical_artifact_truthfulness_reasons,
    normalize_empirical_promotion_manifest,
    validate_empirical_promotion_manifest,
    paper_route_target_plan_from_payload,
    US_EQUITIES_TIMEZONE,
    US_EQUITIES_OPEN,
    US_EQUITIES_CLOSE,
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    DEFAULT_AUTORESEARCH_RUNTIME_WINDOW_STATUSES,
    RUNTIME_WINDOW_TARGET_METADATA_KEYS,
    SOURCE_COLLECTION_ONLY_PLAN_SOURCES,
    MATERIALIZABLE_SOURCE_ROW_COUNT_KEYS,
    RUNTIME_WINDOW_TARGET_PLAN_DEFERRED_REASONS,
    RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES,
    PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
    PAPER_ROUTE_REPLAY_ACCOUNT_LABEL,
    SIM_DB_DSN_ENV,
    SIM_BACKED_PAPER_ROUTE_SOURCE_KINDS,
    OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT,
    HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
    RuntimeWindowImportTarget,
    build_renewal_manifest,
    latest_authoritative_rows as _latest_authoritative_rows,
    latest_autoresearch_runtime_window_targets as _latest_autoresearch_runtime_window_targets,
    load_latest_empirical_job_rows as _load_latest_empirical_job_rows,
    parse_args as _parse_args,
    registry_runtime_window_targets as _registry_runtime_window_targets,
    runtime_version_ref as _runtime_version_ref,
    runtime_window_targets as _runtime_window_targets,
)
from scripts.renew_latest_empirical_promotion_jobs_modules.offline_replay_triage_candidates_from_rank import (
    offline_replay_triage_candidates_from_ranking as _offline_replay_triage_candidates_from_ranking,
    offline_replay_triage_for_deferred_imports as _offline_replay_triage_for_deferred_imports,
    run_runtime_window_source_window_repair as _run_runtime_window_source_window_repair,
    runtime_window_import_blocker_ladder as _runtime_window_import_blocker_ladder,
    runtime_window_import_health_gate_args as _runtime_window_import_health_gate_args,
    runtime_window_import_next_blocker as _runtime_window_import_next_blocker,
    runtime_window_import_payload_proof_blockers as _runtime_window_import_payload_proof_blockers,
)
from scripts.renew_latest_empirical_promotion_jobs_modules.parse_runtime_window_target_spec import (
    extend_unique_text_items as _extend_unique_text_items,
    hpairs_source_proof_census_status as _hpairs_source_proof_census_status,
    read_json_mapping as _read_json_mapping,
    runtime_window_audit_target_blocker_matches as _runtime_window_audit_target_blocker_matches,
    runtime_window_gate_allows_source_collection_merge as _runtime_window_gate_allows_source_collection_merge,
    runtime_window_import_audit_blockers as _runtime_window_import_audit_blockers,
    runtime_window_source_collection_target_allowed as _runtime_window_source_collection_target_allowed,
    runtime_window_source_collection_target_has_materializable_lineage,
    runtime_window_target_plan_from_payload as _runtime_window_target_plan_from_payload,
    runtime_window_target_plan_positive_mapping_count as _runtime_window_target_plan_positive_mapping_count,
    runtime_window_target_plan_with_import_audit_blockers as _runtime_window_target_plan_with_import_audit_blockers,
)
from scripts.renew_latest_empirical_promotion_jobs_modules.raise_if_runtime_window_target_plan_import import (
    read_runtime_window_target_plan_url as _read_runtime_window_target_plan_url,
    runtime_window_target_plan_import_blocked_result as _runtime_window_target_plan_import_blocked_result,
    runtime_window_target_metadata as _runtime_window_target_metadata,
    runtime_window_plan_targets as _runtime_window_plan_targets,
    runtime_window_targets_from_autoresearch_epochs as _runtime_window_targets_from_autoresearch_epochs,
    runtime_window_targets_from_plan as _runtime_window_targets_from_plan,
)
from scripts.renew_latest_empirical_promotion_jobs_modules.run_runtime_window_import_target import (
    run_runtime_window_import_target as _run_runtime_window_import_target,
)
from scripts.renew_latest_empirical_promotion_jobs_modules.runtime_window_targets import (
    latest_completed_regular_session as _latest_completed_regular_session,
    latest_source_activity_window as _latest_source_activity_window,
    offline_replay_exact_artifact_refs as _offline_replay_exact_artifact_refs,
    offline_replay_triage_from_artifact_payload as _offline_replay_triage_from_artifact_payload,
    run_runtime_window_import as _run_runtime_window_import,
    runtime_window_target_plan_bounds as _runtime_window_target_plan_bounds,
)
from scripts.renew_latest_empirical_promotion_jobs_modules.shared_context import (
    as_text_list as _as_text_list,
    read_runtime_window_manifest as _read_runtime_window_manifest,
)

_runtime_window_source_collection_target_has_materializable_lineage = (
    runtime_window_source_collection_target_has_materializable_lineage
)


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


__all__ = [
    "argparse",
    "json",
    "os",
    "subprocess",
    "sys",
    "wall_time",
    "urllib",
    "dataclass",
    "datetime",
    "time",
    "timedelta",
    "timezone",
    "Path",
    "Any",
    "Mapping",
    "Sequence",
    "ZoneInfo",
    "psycopg",
    "yaml",
    "select",
    "Session",
    "SessionLocal",
    "AutoresearchEpoch",
    "VNextEmpiricalJobRun",
    "EMPIRICAL_JOB_TYPES",
    "empirical_artifact_truthfulness_reasons",
    "normalize_empirical_promotion_manifest",
    "validate_empirical_promotion_manifest",
    "paper_route_target_plan_from_payload",
    "US_EQUITIES_TIMEZONE",
    "US_EQUITIES_OPEN",
    "US_EQUITIES_CLOSE",
    "EXECUTION_ELIGIBLE_DECISION_STATUSES",
    "DEFAULT_AUTORESEARCH_RUNTIME_WINDOW_STATUSES",
    "RUNTIME_WINDOW_TARGET_METADATA_KEYS",
    "SOURCE_COLLECTION_ONLY_PLAN_SOURCES",
    "MATERIALIZABLE_SOURCE_ROW_COUNT_KEYS",
    "RUNTIME_WINDOW_TARGET_PLAN_DEFERRED_REASONS",
    "RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES",
    "PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL",
    "PAPER_ROUTE_REPLAY_ACCOUNT_LABEL",
    "SIM_DB_DSN_ENV",
    "SIM_BACKED_PAPER_ROUTE_SOURCE_KINDS",
    "OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT",
    "HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION",
    "RuntimeWindowImportTarget",
    "build_renewal_manifest",
    "main",
    "_extend_unique_text_items",
    "_latest_authoritative_rows",
    "_latest_autoresearch_runtime_window_targets",
    "_latest_completed_regular_session",
    "_load_latest_empirical_job_rows",
    "_parse_args",
    "_registry_runtime_window_targets",
    "_runtime_version_ref",
    "_runtime_window_targets",
    "_hpairs_source_proof_census_status",
    "_latest_source_activity_window",
    "_as_text_list",
    "_offline_replay_exact_artifact_refs",
    "_offline_replay_triage_candidates_from_ranking",
    "_offline_replay_triage_for_deferred_imports",
    "_offline_replay_triage_from_artifact_payload",
    "_read_json_mapping",
    "_read_runtime_window_target_plan_url",
    "_read_runtime_window_manifest",
    "_run_runtime_window_import",
    "_run_runtime_window_import_target",
    "_run_runtime_window_source_window_repair",
    "_runtime_window_import_blocker_ladder",
    "_runtime_window_import_health_gate_args",
    "_runtime_window_import_next_blocker",
    "_runtime_window_import_payload_proof_blockers",
    "_runtime_window_audit_target_blocker_matches",
    "_runtime_window_gate_allows_source_collection_merge",
    "_runtime_window_import_audit_blockers",
    "_runtime_window_plan_targets",
    "_runtime_window_source_collection_target_allowed",
    "_runtime_window_source_collection_target_has_materializable_lineage",
    "_runtime_window_target_plan_bounds",
    "_runtime_window_target_plan_from_payload",
    "_runtime_window_target_plan_import_blocked_result",
    "_runtime_window_target_plan_positive_mapping_count",
    "_runtime_window_target_plan_with_import_audit_blockers",
    "_runtime_window_target_metadata",
    "_runtime_window_targets_from_autoresearch_epochs",
    "_runtime_window_targets_from_plan",
]
if __name__ == "__main__":
    raise SystemExit(main())
