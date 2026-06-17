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


def _raise_if_runtime_window_target_plan_import_blocked(
    payload: Mapping[str, Any],
    *,
    plan: Mapping[str, Any],
) -> None:
    audit = _as_dict(payload.get("runtime_window_import_audit"))
    if not audit:
        return
    state = str(audit.get("state") or "").strip()
    if state not in RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES:
        return
    if _runtime_window_target_plan_has_targets(plan):
        return
    blockers = [
        str(item).strip()
        for item in _as_sequence(audit.get("blockers"))
        if str(item).strip()
    ]
    blocker_text = ",".join(blockers) if blockers else "unknown"
    raise RuntimeError(
        f"runtime_window_target_plan_import_blocked:{state}:{blocker_text}"
    )


def _runtime_window_target_plan_has_targets(plan: Mapping[str, Any]) -> bool:
    targets = plan.get("targets")
    return (
        isinstance(targets, Sequence)
        and not isinstance(targets, (str, bytes, bytearray))
        and len(targets) > 0
    )


def _runtime_window_target_plan_transient_empty_reason(
    *,
    payload: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> str | None:
    if _runtime_window_target_plan_has_targets(plan):
        return None
    reason_values: list[object] = []
    summary = _as_dict(payload.get("summary"))
    reason_values.extend(_as_sequence(summary.get("blockers")))
    audit = _as_dict(payload.get("runtime_window_import_audit"))
    reason_values.append(audit.get("state"))
    reason_values.extend(_as_sequence(audit.get("blockers")))
    gate = _as_dict(payload.get("live_submission_gate"))
    reason_values.append(gate.get("paper_route_target_plan_error"))
    gate_plan = _as_dict(gate.get("runtime_ledger_paper_probation_import_plan"))
    for skipped in _as_sequence(gate_plan.get("skipped_targets")):
        skipped_map = _as_dict(skipped)
        reason_values.append(skipped_map.get("reason"))
        reason_values.extend(
            _as_sequence(skipped_map.get("missing_or_blocking_fields"))
        )

    transient_prefixes = (
        "paper_route_target_plan_fetch_failed",
        "paper_route_target_plan_http_status",
        "paper_probation_import_plan_missing",
        "external_paper_route_target_plan_unavailable",
    )
    for raw_reason in reason_values:
        reason = str(raw_reason or "").strip()
        if not reason:
            continue
        if reason.startswith(transient_prefixes) or "timed out" in reason.lower():
            return reason
    return None


def _runtime_window_target_plan_url_error_retryable(error: RuntimeError) -> bool:
    text = str(error)
    return "runtime_window_target_plan_url_fetch_failed" in text


def _read_runtime_window_target_plan_url_once(
    ref: str,
    *,
    timeout_seconds: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    url = ref.strip()
    if not url:
        raise RuntimeError("runtime_window_target_plan_url_empty")
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(
            request, timeout=max(timeout_seconds, 0.1)
        ) as response:
            raw = response.read(5_000_001)
    except (OSError, TimeoutError, urllib.error.URLError) as exc:
        raise RuntimeError(
            f"runtime_window_target_plan_url_fetch_failed:{url}"
        ) from exc
    if len(raw) > 5_000_000:
        raise RuntimeError(f"runtime_window_target_plan_url_too_large:{url}")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"runtime_window_target_plan_url_invalid:{url}") from exc
    data = _as_dict(payload)
    if not data:
        raise RuntimeError(f"runtime_window_target_plan_url_invalid:{url}")
    return _runtime_window_target_plan_from_payload(data), data


def _read_runtime_window_target_plan_url(
    ref: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    max_attempts = max(int(attempts), 1)
    last_plan: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        try:
            plan, payload = _read_runtime_window_target_plan_url_once(
                ref,
                timeout_seconds=timeout_seconds,
            )
            last_plan = plan
            transient_empty_reason = _runtime_window_target_plan_transient_empty_reason(
                payload=payload,
                plan=plan,
            )
            if transient_empty_reason and attempt < max_attempts:
                wall_time.sleep(max(float(retry_backoff_seconds), 0.0))
                continue
            return plan
        except RuntimeError as exc:
            if (
                attempt < max_attempts
                and _runtime_window_target_plan_url_error_retryable(exc)
            ):
                wall_time.sleep(max(float(retry_backoff_seconds), 0.0))
                continue
            raise
    return last_plan


def _runtime_family_harnesses(family_dir: str) -> dict[str, dict[str, str]]:
    root = Path(family_dir)
    if not root.exists():
        return {}
    harnesses: dict[str, dict[str, str]] = {}
    for path in sorted(root.glob("*.yaml")):
        try:
            payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        data = _as_dict(payload)
        family_id = _as_text(data.get("family_id")) or path.stem
        harness = _as_dict(data.get("runtime_harness"))
        family = _as_text(harness.get("family"))
        strategy_name = _as_text(harness.get("strategy_name"))
        if family and strategy_name:
            harnesses[family_id] = {
                "strategy_family": family,
                "strategy_name": strategy_name,
            }
    return harnesses


def _strategy_name_from_strategy_id(strategy_id: str) -> str | None:
    base = strategy_id.split("@", 1)[0].strip()
    return base.replace("_", "-") if base else None


def _looks_like_uuid_text(value: object) -> bool:
    text = _as_text(value)
    if text is None:
        return False
    parts = text.split("-")
    if [len(part) for part in parts] != [8, 4, 4, 4, 12]:
        return False
    return all(
        part and all(char in "0123456789abcdefABCDEF" for char in part)
        for part in parts
    )


def _strategy_lookup_names(*values: object) -> list[str]:
    names: list[str] = []
    for value in values:
        raw_items: Sequence[object]
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            raw_items = value
        else:
            raw_items = (value,)
        for raw_item in raw_items:
            text = _as_text(raw_item)
            if text is not None and text not in names:
                names.append(text)
    return names


def _canonical_runtime_strategy_name(
    *,
    strategy_name: object,
    runtime_strategy_name: object,
    strategy_id: object,
    strategy_lookup_names: object,
) -> str | None:
    strategy_id_text = _as_text(strategy_id)
    derived_name = (
        _strategy_name_from_strategy_id(strategy_id_text)
        if strategy_id_text is not None
        else None
    )
    preferred = _strategy_lookup_names(
        runtime_strategy_name,
        strategy_name,
        derived_name,
        strategy_lookup_names,
    )
    for name in preferred:
        if not _looks_like_uuid_text(name):
            return name
    return preferred[0] if preferred else None


def _registry_runtime_window_targets(
    args: argparse.Namespace,
) -> list[RuntimeWindowImportTarget]:
    if not bool(getattr(args, "runtime_window_targets_from_registry", False)):
        return []
    hypothesis_dir = Path(str(getattr(args, "runtime_window_hypothesis_dir", "")))
    if not hypothesis_dir.exists():
        raise RuntimeError(f"runtime_window_hypothesis_dir_missing:{hypothesis_dir}")
    family_harnesses = _runtime_family_harnesses(
        str(getattr(args, "runtime_window_family_dir", ""))
    )
    targets: list[RuntimeWindowImportTarget] = []
    for path in sorted(hypothesis_dir.glob("*.json")):
        manifest = _read_json_mapping(path)
        hypothesis_id = _as_text(manifest.get("hypothesis_id"))
        candidate_id = _as_text(manifest.get("candidate_id"))
        strategy_family = _as_text(manifest.get("strategy_family"))
        strategy_id = _as_text(manifest.get("strategy_id"))
        strategy_name = _as_text(manifest.get("strategy_name"))
        if strategy_id:
            family_harness = family_harnesses.get(strategy_id.split("@", 1)[0])
            if family_harness:
                strategy_family = family_harness["strategy_family"]
                strategy_name = family_harness["strategy_name"]
        strategy_name = strategy_name or (
            _strategy_name_from_strategy_id(strategy_id) if strategy_id else None
        )
        if (
            not hypothesis_id
            or not candidate_id
            or not strategy_family
            or not strategy_name
        ):
            continue
        targets.append(
            RuntimeWindowImportTarget(
                hypothesis_id=hypothesis_id,
                candidate_id=candidate_id,
                observed_stage=str(
                    getattr(args, "runtime_window_observed_stage", "") or "paper"
                ).strip()
                or "paper",
                strategy_family=strategy_family,
                source_dsn_env=str(
                    getattr(args, "runtime_window_source_dsn_env", "") or "DB_DSN"
                ).strip()
                or "DB_DSN",
                target_dsn_env=str(
                    getattr(args, "runtime_window_target_dsn_env", "") or ""
                ).strip(),
                strategy_name=strategy_name,
                account_label=str(
                    getattr(args, "runtime_window_account_label", "") or "TORGHUT_SIM"
                ).strip()
                or "TORGHUT_SIM",
                dataset_snapshot_ref=_as_text(manifest.get("dataset_snapshot_ref"))
                or "",
                source_manifest_ref=str(path),
                source_kind=str(
                    getattr(args, "runtime_window_source_kind", "")
                    or "paper_runtime_observed"
                ).strip()
                or "paper_runtime_observed",
                delay_adjusted_depth_stress_report_ref="",
                dependency_quorum_decision=str(
                    getattr(args, "runtime_window_dependency_quorum_decision", "") or ""
                ).strip(),
                continuity_ok=str(
                    getattr(args, "runtime_window_continuity_ok", "") or ""
                ).strip(),
                drift_ok=str(
                    getattr(args, "runtime_window_drift_ok", "") or ""
                ).strip(),
                window_start="",
                window_end="",
                source_account_label=str(
                    getattr(args, "runtime_window_source_account_label", "") or ""
                ).strip(),
            )
        )
    return targets


def _runtime_window_plan_targets(
    args: argparse.Namespace,
) -> list[RuntimeWindowImportTarget]:
    file_refs = [
        str(item).strip()
        for item in getattr(args, "runtime_window_target_plan_ref", []) or []
        if str(item).strip()
    ]
    url_refs = [
        str(item).strip()
        for item in getattr(args, "runtime_window_target_plan_url", []) or []
        if str(item).strip()
    ]
    targets: list[RuntimeWindowImportTarget] = []
    for ref in file_refs:
        plan = _read_runtime_window_target_plan(ref)
        targets.extend(_runtime_window_targets_from_plan(plan=plan, ref=ref, args=args))
    timeout_seconds = float(
        getattr(args, "runtime_window_target_plan_url_timeout_seconds", 5.0) or 5.0
    )
    url_attempts = int(getattr(args, "runtime_window_target_plan_url_attempts", 1) or 1)
    raw_retry_backoff_seconds = getattr(
        args,
        "runtime_window_target_plan_url_retry_backoff_seconds",
        0.25,
    )
    retry_backoff_seconds = (
        0.25 if raw_retry_backoff_seconds is None else float(raw_retry_backoff_seconds)
    )
    for ref in url_refs:
        plan = _read_runtime_window_target_plan_url(
            ref,
            timeout_seconds=timeout_seconds,
            attempts=url_attempts,
            retry_backoff_seconds=retry_backoff_seconds,
        )
        targets.extend(_runtime_window_targets_from_plan(plan=plan, ref=ref, args=args))
    return targets


def _runtime_window_target_plan_ref_count(args: argparse.Namespace) -> int:
    file_refs = [
        str(item).strip()
        for item in getattr(args, "runtime_window_target_plan_ref", []) or []
        if str(item).strip()
    ]
    url_refs = [
        str(item).strip()
        for item in getattr(args, "runtime_window_target_plan_url", []) or []
        if str(item).strip()
    ]
    return len(file_refs) + len(url_refs)


def _runtime_window_targets_from_plan(
    *,
    plan: Mapping[str, Any],
    ref: str,
    args: argparse.Namespace,
) -> list[RuntimeWindowImportTarget]:
    raw_targets = plan.get("targets")
    if not isinstance(raw_targets, Sequence) or isinstance(
        raw_targets, (str, bytes, bytearray)
    ):
        raise RuntimeError(f"runtime_window_target_plan_targets_missing:{ref}")
    targets: list[RuntimeWindowImportTarget] = []
    seen_target_keys: set[tuple[object, ...]] = set()
    for index, raw_target in enumerate(raw_targets):
        payload = _as_dict(raw_target)

        def value(key: str, legacy_name: str) -> str:
            return str(payload.get(key) or getattr(args, legacy_name, "") or "").strip()

        hypothesis_id = value("hypothesis_id", "runtime_window_hypothesis_id")
        candidate_id = value("candidate_id", "runtime_window_candidate_id")
        strategy_family = value("strategy_family", "runtime_window_strategy_family")
        raw_strategy_name = value("strategy_name", "runtime_window_strategy_name")
        strategy_name = (
            _canonical_runtime_strategy_name(
                strategy_name=raw_strategy_name,
                runtime_strategy_name=payload.get("runtime_strategy_name"),
                strategy_id=payload.get("strategy_id"),
                strategy_lookup_names=payload.get("strategy_lookup_names"),
            )
            or raw_strategy_name
        )
        missing = [
            field
            for field, item in (
                ("hypothesis_id", hypothesis_id),
                ("candidate_id", candidate_id),
                ("strategy_family", strategy_family),
                ("strategy_name", strategy_name),
            )
            if not item
        ]
        if missing:
            raise RuntimeError(
                "runtime_window_target_plan_target_invalid:"
                f"{ref}:{index}:{','.join(missing)}"
            )
        target = RuntimeWindowImportTarget(
            hypothesis_id=hypothesis_id,
            candidate_id=candidate_id,
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
            window_start=str(payload.get("window_start") or "").strip(),
            window_end=str(payload.get("window_end") or "").strip(),
            artifact_refs=_runtime_window_target_artifact_refs(payload),
            target_metadata=_runtime_window_target_metadata(payload),
            source_account_label=value(
                "source_account_label",
                "runtime_window_source_account_label",
            ),
        )
        target_key = (
            target.hypothesis_id,
            target.candidate_id,
            target.observed_stage,
            target.strategy_family,
            target.source_dsn_env,
            target.target_dsn_env,
            target.strategy_name,
            target.account_label,
            target.source_account_label,
            target.dataset_snapshot_ref,
            target.source_manifest_ref,
            target.source_kind,
            target.window_start,
            target.window_end,
            tuple(target.target_metadata.get("paper_route_probe_symbols", ()))
            if target.target_metadata
            else (),
        )
        if target_key in seen_target_keys:
            continue
        seen_target_keys.add(target_key)
        targets.append(target)
    return targets


def _runtime_window_target_artifact_refs(payload: Mapping[str, Any]) -> tuple[str, ...]:
    refs: list[str] = []
    for key in (
        "artifact_refs",
        "runtime_ledger_artifact_refs",
        "exact_replay_ledger_artifact_refs",
    ):
        raw_refs = payload.get(key)
        if not isinstance(raw_refs, Sequence) or isinstance(
            raw_refs, (str, bytes, bytearray)
        ):
            continue
        for item in raw_refs:
            ref = _as_text(item)
            if ref is not None and ref not in refs:
                refs.append(ref)
    for key in ("runtime_ledger_artifact_ref", "exact_replay_ledger_artifact_ref"):
        ref = _as_text(payload.get(key))
        if ref is not None and ref not in refs:
            refs.append(ref)
    return tuple(refs)


def _runtime_window_target_metadata(payload: Mapping[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for key in RUNTIME_WINDOW_TARGET_METADATA_KEYS:
        if key not in payload:
            continue
        value = payload.get(key)
        if value is None or value == "":
            continue
        metadata[key] = value
    if bool(metadata.get("paper_probation_authorized")):
        metadata.setdefault(
            "paper_probation_authorization_scope", "evidence_collection_only"
        )
        metadata.setdefault("evidence_collection_stage", "paper")
        metadata.setdefault("promotion_allowed", False)
        metadata.setdefault("final_promotion_authorized", False)
        metadata.setdefault("final_promotion_allowed", False)
    if bool(metadata.get("source_collection_authorized")):
        metadata.setdefault(
            "source_collection_authorization_scope",
            "source_window_evidence_collection_only",
        )
        metadata.setdefault("evidence_collection_stage", "paper")
        metadata.setdefault("promotion_allowed", False)
        metadata.setdefault("final_promotion_authorized", False)
        metadata.setdefault("final_promotion_allowed", False)
    return metadata


def _runtime_window_target_identity(
    target: RuntimeWindowImportTarget,
) -> tuple[str, str, str, str, str, str, str, str, str, str, str, str, str]:
    return (
        target.hypothesis_id,
        target.observed_stage,
        target.strategy_family,
        target.source_dsn_env,
        target.strategy_name,
        target.account_label,
        target.target_dsn_env,
        target.source_account_label,
        target.dataset_snapshot_ref,
        target.source_manifest_ref,
        target.source_kind,
        target.window_start,
        target.window_end,
    )


def _runtime_window_autoresearch_statuses(args: argparse.Namespace) -> set[str]:
    statuses = {
        str(item).strip()
        for item in getattr(args, "runtime_window_autoresearch_status", []) or []
        if str(item).strip()
    }
    return statuses or set(DEFAULT_AUTORESEARCH_RUNTIME_WINDOW_STATUSES)


def _runtime_window_targets_from_autoresearch_epochs(
    *,
    args: argparse.Namespace,
    epochs: Sequence[Any],
) -> list[RuntimeWindowImportTarget]:
    eligible_statuses = _runtime_window_autoresearch_statuses(args)
    for epoch in epochs:
        if str(getattr(epoch, "status", "") or "").strip() not in eligible_statuses:
            continue
        summary = _as_dict(getattr(epoch, "summary_json", None))
        candidate_board = _as_dict(summary.get("candidate_board"))
        plan = _as_dict(candidate_board.get("runtime_window_import_plan"))
        if not plan or "targets" not in plan:
            continue
        targets = _runtime_window_targets_from_plan(
            plan=plan,
            ref=f"autoresearch_epoch:{getattr(epoch, 'epoch_id', 'unknown')}",
            args=args,
        )
        if targets:
            return targets
    return []


def _latest_autoresearch_runtime_window_targets(
    args: argparse.Namespace,
) -> list[RuntimeWindowImportTarget]:
    if not bool(
        getattr(args, "runtime_window_targets_from_latest_autoresearch", False)
    ):
        return []
    scan_limit = max(
        1,
        int(getattr(args, "runtime_window_autoresearch_scan_limit", 20) or 20),
    )
    statuses = _runtime_window_autoresearch_statuses(args)
    with SessionLocal() as session:
        rows = (
            session.execute(
                select(AutoresearchEpoch)
                .where(AutoresearchEpoch.status.in_(statuses))
                .order_by(
                    AutoresearchEpoch.completed_at.desc().nulls_last(),
                    AutoresearchEpoch.created_at.desc(),
                )
                .limit(scan_limit)
            )
            .scalars()
            .all()
        )
    return _runtime_window_targets_from_autoresearch_epochs(args=args, epochs=rows)


__all__ = [name for name in globals() if not name.startswith("__")]
