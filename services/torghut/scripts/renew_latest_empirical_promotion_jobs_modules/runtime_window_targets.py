# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
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

# ruff: noqa: F401,F403,F405,F811,F821

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
    _as_dict,
    _as_sequence,
    _as_text,
    _as_text_list,
    _nonnegative_int,
    _normalized_sim_backed_source_account_label,
    _parse_args,
    _parse_dt,
    _read_runtime_window_manifest,
    _runtime_manifest_delay_depth_stress_report_ref,
    _runtime_manifest_entry_requirements,
    _runtime_manifest_requires_delay_depth_stress,
    _runtime_version_ref,
    _runtime_window_delay_depth_remediation,
    _runtime_window_target_is_paper_route_collection,
    _runtime_window_target_plan_import_blocked_result,
    _utc_iso,
)
from .parse_runtime_window_target_spec import (
    _extend_unique_text_items,
    _hpairs_source_proof_census_attachment_blockers,
    _hpairs_source_proof_census_status,
    _latest_closed_runtime_window_target_plan_from_payload,
    _parse_runtime_window_target_spec,
    _read_json_mapping,
    _read_runtime_window_target_plan,
    _runtime_window_audit_target_blocker_matches,
    _runtime_window_gate_allows_source_collection_merge,
    _runtime_window_import_audit_blockers,
    _runtime_window_plan_target_items,
    _runtime_window_source_collection_target_allowed,
    _runtime_window_source_collection_target_has_materializable_lineage,
    _runtime_window_target_plan_from_payload,
    _runtime_window_target_plan_is_source_collection_only,
    _runtime_window_target_plan_positive_mapping_count,
    _runtime_window_target_plan_source_collection_targets,
    _runtime_window_target_plan_target_key,
    _runtime_window_target_plan_target_truthy,
    _runtime_window_target_plan_with_import_audit_blockers,
    _runtime_window_target_plan_with_live_gate_source_collection,
    _runtime_window_target_plan_without_paper_route_source_collection_only,
    _target_strategy_names,
    _target_text,
)
from .raise_if_runtime_window_target_plan_import import (
    _canonical_runtime_strategy_name,
    _latest_autoresearch_runtime_window_targets,
    _looks_like_uuid_text,
    _raise_if_runtime_window_target_plan_import_blocked,
    _read_runtime_window_target_plan_url,
    _read_runtime_window_target_plan_url_once,
    _registry_runtime_window_targets,
    _runtime_family_harnesses,
    _runtime_window_autoresearch_statuses,
    _runtime_window_plan_targets,
    _runtime_window_target_artifact_refs,
    _runtime_window_target_identity,
    _runtime_window_target_metadata,
    _runtime_window_target_plan_has_targets,
    _runtime_window_target_plan_ref_count,
    _runtime_window_target_plan_transient_empty_reason,
    _runtime_window_target_plan_url_error_retryable,
    _runtime_window_targets_from_autoresearch_epochs,
    _runtime_window_targets_from_plan,
    _strategy_lookup_names,
    _strategy_name_from_strategy_id,
)


def _runtime_window_targets(
    args: argparse.Namespace,
) -> list[RuntimeWindowImportTarget]:
    specs = [str(item) for item in getattr(args, "runtime_window_target", []) or []]
    plan_targets = _runtime_window_plan_targets(args)
    plan_required = bool(getattr(args, "runtime_window_target_plan_required", False))
    if plan_required:
        plan_ref_count = _runtime_window_target_plan_ref_count(args)
        if plan_ref_count <= 0:
            raise RuntimeError("runtime_window_target_plan_required_without_ref")
        if not plan_targets:
            raise RuntimeError("runtime_window_target_plan_required_but_empty")
    plan_exclusive = bool(getattr(args, "runtime_window_target_plan_exclusive", False))
    fallback_enabled = not plan_exclusive
    autoresearch_targets = (
        _latest_autoresearch_runtime_window_targets(args) if fallback_enabled else []
    )
    registry_targets = (
        _registry_runtime_window_targets(args) if fallback_enabled else []
    )
    if (
        not specs
        and not plan_targets
        and not autoresearch_targets
        and not registry_targets
    ):
        if plan_exclusive:
            return []
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
                target_dsn_env=value("target_dsn_env", "runtime_window_target_dsn_env"),
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
                dependency_quorum_decision=value(
                    "dependency_quorum_decision",
                    "runtime_window_dependency_quorum_decision",
                ),
                continuity_ok=value("continuity_ok", "runtime_window_continuity_ok"),
                drift_ok=value("drift_ok", "runtime_window_drift_ok"),
                window_start=value("window_start", "runtime_window_start"),
                window_end=value("window_end", "runtime_window_end"),
                artifact_refs=_runtime_window_target_artifact_refs(payload),
                target_metadata=_runtime_window_target_metadata(payload),
                source_account_label=value(
                    "source_account_label",
                    "runtime_window_source_account_label",
                ),
            )
        )
    seen_hypothesis_ids = {target.hypothesis_id for target in targets}
    explicit_target_keys = {
        _runtime_window_target_identity(target) for target in targets
    }
    for target in (*plan_targets, *autoresearch_targets):
        target_key = _runtime_window_target_identity(target)
        if target_key in explicit_target_keys:
            continue
        targets.append(target)
        seen_hypothesis_ids.add(target.hypothesis_id)
    for target in registry_targets:
        if target.hypothesis_id in seen_hypothesis_ids:
            continue
        targets.append(target)
        seen_hypothesis_ids.add(target.hypothesis_id)
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


def _regular_session_for_timestamp(value: datetime) -> tuple[datetime, datetime]:
    zone = ZoneInfo(US_EQUITIES_TIMEZONE)
    local_value = value.astimezone(zone)
    session_date = local_value.date()
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


def _runtime_window_target_plan_bounds(
    target: RuntimeWindowImportTarget,
) -> tuple[datetime, datetime] | None:
    start_arg = str(target.window_start or "").strip()
    end_arg = str(target.window_end or "").strip()
    if bool(start_arg) != bool(end_arg):
        raise RuntimeError(
            "runtime_window_target_plan_bounds_require_start_and_end:"
            f"{target.hypothesis_id}:{target.candidate_id}"
        )
    if not start_arg or not end_arg:
        return None
    start = _parse_dt(start_arg)
    end = _parse_dt(end_arg)
    if end <= start:
        raise RuntimeError(
            "runtime_window_target_plan_end_must_be_after_start:"
            f"{target.hypothesis_id}:{target.candidate_id}"
        )
    return start, end


def _explicit_runtime_window_bounds(
    args: argparse.Namespace,
) -> tuple[datetime, datetime] | None:
    start_arg = str(getattr(args, "runtime_window_start", "") or "").strip()
    end_arg = str(getattr(args, "runtime_window_end", "") or "").strip()
    if bool(start_arg) != bool(end_arg):
        raise RuntimeError("runtime_window_bounds_require_start_and_end")
    if not start_arg or not end_arg:
        return None
    start = _parse_dt(start_arg)
    end = _parse_dt(end_arg)
    if end <= start:
        raise RuntimeError("runtime_window_end_must_be_after_start")
    return start, end


def _source_strategy_name_candidates(
    *,
    target: RuntimeWindowImportTarget,
    runtime_manifest: Mapping[str, Any],
) -> list[str]:
    candidates: list[str] = []
    for raw in (
        target.strategy_name,
        _as_text(runtime_manifest.get("strategy_name")),
        _as_text(runtime_manifest.get("strategy_id")),
    ):
        text = str(raw or "").strip()
        if not text:
            continue
        variants = [
            text,
            text.split("@", 1)[0],
            text.replace("_", "-"),
            text.split("@", 1)[0].replace("_", "-"),
        ]
        for variant in variants:
            normalized = variant.strip()
            if normalized and normalized not in candidates:
                candidates.append(normalized)
    return candidates


def _latest_source_activity_window(
    *,
    target: RuntimeWindowImportTarget,
    runtime_manifest: Mapping[str, Any],
) -> tuple[datetime, datetime] | None:
    dsn = os.getenv(target.source_dsn_env, "").strip()
    if not dsn:
        return None
    strategy_names = _source_strategy_name_candidates(
        target=target,
        runtime_manifest=runtime_manifest,
    )
    if not strategy_names:
        return None
    source_account_label = target.source_account_label or target.account_label
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select min(d.created_at), max(d.created_at)
                from trade_decisions d
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.status = any(%s)
                """,
                (
                    strategy_names,
                    source_account_label,
                    list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                ),
            )
            row = cur.fetchone()
            earliest = row[0] if row else None
            latest = row[1] if row else None
    if earliest is None or latest is None:
        return None
    if earliest.tzinfo is None:
        earliest = earliest.replace(tzinfo=timezone.utc)
    if latest.tzinfo is None:
        latest = latest.replace(tzinfo=timezone.utc)
    window_start, _ = _regular_session_for_timestamp(earliest.astimezone(timezone.utc))
    _, window_end = _regular_session_for_timestamp(latest.astimezone(timezone.utc))
    return window_start, window_end


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


def _load_latest_empirical_job_rows(session: Session) -> list[VNextEmpiricalJobRun]:
    """Load only the latest row for each empirical job type.

    The renewal job only needs the most recent row per job type; reading the
    full empirical job history can materialize years of JSON payloads in the
    CronJob container.
    """

    rows: list[VNextEmpiricalJobRun] = []
    for job_type in EMPIRICAL_JOB_TYPES:
        row = session.scalars(
            select(VNextEmpiricalJobRun)
            .where(VNextEmpiricalJobRun.job_type == job_type)
            .order_by(
                VNextEmpiricalJobRun.created_at.desc(),
                VNextEmpiricalJobRun.id.desc(),
            )
            .limit(1)
        ).first()
        if row is not None:
            rows.append(row)
    return rows


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
    explicit_window = _explicit_runtime_window_bounds(args)
    default_window_start, default_window_end = (
        explicit_window or _runtime_window_bounds(args, now)
    )
    targets = _runtime_window_targets(args)
    imports: list[dict[str, Any]] = []
    for target in targets:
        imports.append(
            _run_runtime_window_import_target(
                args=args,
                target=target,
                manifest=manifest,
                run_id=run_id,
                manifest_path=manifest_path,
                window_start=default_window_start,
                window_end=default_window_end,
                now=now,
                allow_source_activity_window=explicit_window is None,
            )
        )
    offline_replay_triage = _offline_replay_triage_for_deferred_imports(
        args=args,
        imports=imports,
        now=now,
    )
    if len(imports) == 1:
        payload = dict(imports[0])
        if offline_replay_triage is not None:
            payload["offline_replay_triage"] = offline_replay_triage
        return payload
    proof_blockers = [
        blocker
        for item in imports
        for blocker in item.get("proof_blockers", [])
        if isinstance(blocker, Mapping)
    ]
    payload = {
        "status": "ok",
        "proof_status": "blocked" if proof_blockers else "ok",
        "proof_blockers": proof_blockers,
        "target_count": len(imports),
        "imports": imports,
    }
    if offline_replay_triage is not None:
        payload["offline_replay_triage"] = offline_replay_triage
    return payload


def _runtime_window_import_is_paper_route(item: Mapping[str, Any]) -> bool:
    source_kind = _as_text(item.get("source_kind")) or ""
    if "paper_route" in source_kind:
        return True
    metadata = _as_dict(item.get("target_metadata"))
    return any(str(key).startswith("paper_route_") for key in metadata)


def _offline_replay_artifact_refs(item: Mapping[str, Any]) -> list[str]:
    refs: list[str] = []

    def append_ref(value: Any) -> None:
        ref = _as_text(value)
        if ref is not None and ref not in refs:
            refs.append(ref)

    metadata = _as_dict(item.get("target_metadata"))
    for key in (
        "runtime_ledger_artifact_ref",
        "exact_replay_ledger_artifact_ref",
        "runtime_ledger_bucket_ref",
    ):
        append_ref(metadata.get(key))
    for key in ("runtime_ledger_artifact_refs", "exact_replay_ledger_artifact_refs"):
        for ref in _as_text_list(metadata.get(key)):
            append_ref(ref)
    for ref in _as_text_list(item.get("artifact_refs")):
        append_ref(ref)
    return refs


def _offline_replay_exact_artifact_refs(item: Mapping[str, Any]) -> list[str]:
    refs: list[str] = []
    metadata = _as_dict(item.get("target_metadata"))
    ref = _as_text(metadata.get("exact_replay_ledger_artifact_ref"))
    if ref is not None:
        refs.append(ref)
    for ref in _as_text_list(metadata.get("exact_replay_ledger_artifact_refs")):
        if ref not in refs:
            refs.append(ref)
    return refs


def _offline_replay_triage_source_kind(item: Mapping[str, Any]) -> str:
    source_kind = _as_text(item.get("source_kind")) or ""
    exact_refs = _offline_replay_exact_artifact_refs(item)
    if source_kind == "simulation_exact_replay_runtime_ledger" or exact_refs:
        return "simulation_exact_replay_runtime_ledger"
    return source_kind or "research_handoff"


def _offline_replay_triage_candidate_from_import(
    item: Mapping[str, Any],
) -> dict[str, Any]:
    metadata = _as_dict(item.get("target_metadata"))
    candidate: dict[str, Any] = {
        "authority": "non_authoritative_research_triage",
        "promotion_allowed": False,
        "excluded_from_runtime_window_import_proof": True,
        "source_kind": _offline_replay_triage_source_kind(item),
        "hypothesis_id": _as_text(item.get("hypothesis_id")) or "",
        "candidate_id": _as_text(item.get("candidate_id")) or "",
        "strategy_name": _as_text(item.get("strategy_name")) or "",
        "account_label": _as_text(item.get("account_label")) or "",
        "window_start": _as_text(item.get("window_start")) or "",
        "window_end": _as_text(item.get("window_end")) or "",
        "deferred_reason": _as_text(item.get("reason")) or "",
        "source_artifact_refs": _offline_replay_artifact_refs(item),
        "exact_replay_ledger_artifact_refs": _offline_replay_exact_artifact_refs(item),
    }
    selection = {
        key: metadata[key]
        for key in (
            "candidate_selection",
            "selected_by",
            "selection_reason",
            "replay_selection_reason",
            "probation_reason",
            "promotion_gate",
        )
        if key in metadata
    }
    if selection:
        candidate["selection"] = selection
    blockers: list[str] = []
    for key in (
        "runtime_ledger_target_metadata_blockers",
        "runtime_window_import_health_gate_blockers",
        "runtime_window_import_promotion_blockers",
        "final_promotion_blockers",
        "candidate_blockers",
    ):
        for blocker in _as_text_list(metadata.get(key)):
            if blocker not in blockers:
                blockers.append(blocker)
    if blockers:
        candidate["research_blockers"] = blockers
    handoff = metadata.get("paper_route_runtime_import_handoff") or metadata.get(
        "handoff"
    )
    if handoff:
        candidate["handoff"] = handoff
    return candidate


def _offline_replay_triage_candidate_from_ranking(
    candidate: Mapping[str, Any],
    *,
    source_ref: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "authority": "non_authoritative_research_triage",
        "promotion_allowed": False,
        "excluded_from_runtime_window_import_proof": True,
        "source_kind": "simulation_exact_replay_runtime_ledger",
        "source_artifact_ref": source_ref,
    }
    for key in (
        "candidate_id",
        "artifact_ref",
        "promotion_status",
        "window_start",
        "window_end",
        "window_net_pnl_per_day",
        "active_net_pnl_per_day",
        "total_net_pnl_after_costs",
        "window_weekday_count",
        "avg_filled_notional_per_window_weekday",
        "best_day_share",
        "max_single_fill_notional_pct_equity",
        "execution_quality_penalty_bps",
        "execution_quality_penalty_amount",
        "execution_quality_adjusted_window_net_pnl_per_day",
    ):
        value = candidate.get(key)
        if value not in (None, ""):
            payload[key] = value
    for key in (
        "promotion_blockers",
        "runtime_ledger_blockers",
        "execution_quality_blockers",
    ):
        values = _as_text_list(candidate.get(key))
        if values:
            payload[key] = values
    execution_quality = _as_dict(candidate.get("execution_quality"))
    if execution_quality:
        payload["execution_quality"] = execution_quality
    return payload


def _offline_replay_triage_from_artifact_payload(
    *,
    payload: Mapping[str, Any],
    source_ref: str,
) -> dict[str, Any] | None:
    schema_version = _as_text(payload.get("schema_version")) or ""
    if schema_version == "torghut.replay-runtime-window-handoff.v1":
        ranking = _as_dict(payload.get("ranking"))
        candidates = _offline_replay_triage_candidates_from_ranking(
            ranking=ranking,
            source_ref=source_ref,
        )
        best_candidate = _as_dict(payload.get("best_exact_replay_ledger_candidate"))
        if best_candidate and not candidates:
            candidates = [
                _offline_replay_triage_candidate_from_ranking(
                    best_candidate,
                    source_ref=source_ref,
                )
            ]
        return {
            "source_ref": source_ref,
            "schema_version": schema_version,
            "source": _as_text(payload.get("source"))
            or "exact_replay_ledger_runtime_window_handoff",
            "candidate_count": len(candidates),
            "candidates": candidates,
        }
    if schema_version == "torghut.exact-replay-ledger-ranking.v1":
        candidates = _offline_replay_triage_candidates_from_ranking(
            ranking=payload,
            source_ref=source_ref,
        )
        return {
            "source_ref": source_ref,
            "schema_version": schema_version,
            "source": "exact_replay_ledger_ranking",
            "candidate_count": len(candidates),
            "candidates": candidates,
        }
    candidate_board = _as_dict(payload.get("candidate_board"))
    if candidate_board:
        best_candidate = _as_dict(
            candidate_board.get("best_exact_replay_ledger_candidate")
        )
        candidates = (
            [
                _offline_replay_triage_candidate_from_ranking(
                    best_candidate,
                    source_ref=source_ref,
                )
            ]
            if best_candidate
            else []
        )
        return {
            "source_ref": source_ref,
            "schema_version": _as_text(candidate_board.get("schema_version"))
            or "candidate_board",
            "source": "autoresearch_candidate_board",
            "candidate_count": len(candidates),
            "candidates": candidates,
        }
    return None


__all__ = [name for name in globals() if not name.startswith("__")]
