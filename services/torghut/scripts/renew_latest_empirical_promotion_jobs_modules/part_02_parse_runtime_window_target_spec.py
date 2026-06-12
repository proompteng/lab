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

from .part_01_statements_37 import *


def _parse_runtime_window_target_spec(spec: str) -> dict[str, Any]:
    text = spec.strip()
    if not text:
        return {}
    if text.startswith("{"):
        payload = json.loads(text)
        if not isinstance(payload, Mapping):
            raise RuntimeError("runtime_window_target_json_not_mapping")
        return {
            str(key).replace("-", "_"): value
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


def _read_json_mapping(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _as_dict(payload)


def _hpairs_source_proof_census_status(
    census: Mapping[str, Any] | None,
) -> dict[str, Any]:
    payload = _as_dict(census)
    if not payload:
        return {
            "schema_version": HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
            "present": False,
            "non_authority_status_only": True,
            "authority_source": False,
            "promotion_allowed": False,
            "final_authority_ok": False,
            "runtime_authority_final_ok": False,
            "census_ready": False,
            "blockers": [],
            "attachment_blockers": ["hpairs_source_proof_census_missing"],
            "blocker_ladder": [],
            "next_blocker": {
                "step": "hpairs_source_proof_census",
                "status": "missing",
                "blocker_codes": ["hpairs_source_proof_census_missing"],
                "next_action": "attach a fresh read-only H-PAIRS source-proof census artifact",
            },
        }
    verdict = _as_dict(payload.get("verdict"))
    runtime_authority = _as_dict(payload.get("runtime_authority"))
    blockers = _as_text_list(payload.get("blockers"))
    blockers.extend(
        item
        for item in _as_text_list(runtime_authority.get("blockers"))
        if item not in blockers
    )
    attachment_blockers = _hpairs_source_proof_census_attachment_blockers(payload)
    blockers = _extend_unique_text_items(blockers, attachment_blockers)
    next_blocker = _as_dict(verdict.get("next_blocker"))
    runtime_authority_final_ok = bool(runtime_authority.get("final_authority_ok"))
    census_ready = bool(verdict.get("authority_candidate_ready")) and not blockers
    return {
        "schema_version": HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
        "present": True,
        "non_authority_status_only": True,
        "authority_source": False,
        "source_schema_version": payload.get("schema_version"),
        "identity": _as_dict(payload.get("identity")),
        "window": _as_dict(payload.get("window")),
        "classification": verdict.get("classification"),
        "authority_candidate_ready": bool(verdict.get("authority_candidate_ready")),
        "promotion_allowed": False,
        "final_authority_ok": False,
        "runtime_authority_final_ok": runtime_authority_final_ok,
        "census_ready": census_ready,
        "blockers": blockers,
        "attachment_blockers": attachment_blockers,
        "missing_requirement_categories": _as_dict(
            payload.get("missing_requirement_categories")
        ),
        "missing_source_ref_categories": _as_dict(
            payload.get("missing_source_ref_categories")
        ),
        "blocker_ladder": list(_as_sequence(payload.get("blocker_ladder"))),
        "next_blocker": dict(next_blocker) if next_blocker else None,
        "next_action": verdict.get("next_action"),
        "totals": _as_dict(payload.get("totals")),
    }


def _hpairs_source_proof_census_attachment_blockers(
    payload: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if (
        _as_text(payload.get("schema_version"))
        != "torghut.hpairs-source-proof-census.v1"
    ):
        blockers.append("hpairs_source_proof_census_schema_mismatch")
    source = _as_dict(payload.get("source"))
    if source.get("read_only") is not True:
        blockers.append("hpairs_source_proof_census_not_read_only")
    if source.get("writes_proof") is not False:
        blockers.append("hpairs_source_proof_census_writes_proof")
    if source.get("modifies_rows") is not False:
        blockers.append("hpairs_source_proof_census_modifies_rows")
    if source.get("replay_outputs_count_as_runtime_proof") is not False:
        blockers.append("hpairs_source_proof_census_replay_outputs_claim_runtime_proof")
    if source.get("synthetic_proof_created") is not False:
        blockers.append("hpairs_source_proof_census_synthetic_proof_created")
    return blockers


def _read_runtime_window_target_plan(ref: str) -> dict[str, Any]:
    path = Path(ref.strip())
    if not path.exists():
        raise RuntimeError(f"runtime_window_target_plan_ref_missing:{path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"runtime_window_target_plan_ref_invalid:{path}") from exc
    data = _as_dict(payload)
    if not data:
        raise RuntimeError(f"runtime_window_target_plan_ref_invalid:{path}")
    plan = _runtime_window_target_plan_from_payload(data)
    return plan


def _runtime_window_plan_target_items(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    targets = plan.get("targets")
    if not isinstance(targets, Sequence) or isinstance(
        targets, (str, bytes, bytearray)
    ):
        return []
    return [_as_dict(item) for item in targets if _as_dict(item)]


def _runtime_window_target_plan_target_key(
    target: Mapping[str, Any],
) -> tuple[str, str, str, str, str, str, str, str]:
    return (
        str(target.get("hypothesis_id") or "").strip(),
        str(target.get("candidate_id") or "").strip(),
        str(
            target.get("strategy_name")
            or target.get("runtime_strategy_name")
            or target.get("strategy_id")
            or ""
        ).strip(),
        str(target.get("account_label") or "").strip(),
        str(target.get("source_account_label") or "").strip(),
        str(target.get("source_kind") or "").strip(),
        str(target.get("window_start") or "").strip(),
        str(target.get("window_end") or "").strip(),
    )


def _runtime_window_target_plan_target_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def _runtime_window_target_plan_positive_mapping_count(
    value: object,
    *,
    allowed_keys: frozenset[str] | None = None,
) -> bool:
    if not isinstance(value, Mapping):
        return False
    for raw_key, raw_count in value.items():
        if allowed_keys is not None and str(raw_key or "").strip() not in allowed_keys:
            continue
        try:
            if int(str(raw_count or "0")) > 0:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _runtime_window_source_collection_target_has_materializable_lineage(
    target: Mapping[str, Any],
) -> bool:
    for key in (
        "source_window_ids",
        "runtime_ledger_source_window_ids",
        "execution_order_event_ids",
        "runtime_ledger_execution_order_event_ids",
        "execution_ids",
        "trade_decision_ids",
        "source_offsets",
    ):
        if _as_sequence(target.get(key)):
            return True
        if _as_text(target.get(key)) is not None:
            return True
    if _as_text(target.get("source_materialization")) is not None:
        return True
    if _as_text(target.get("authority_class")) is not None:
        return True
    for key in ("source_row_counts", "runtime_ledger_source_row_counts"):
        if _runtime_window_target_plan_positive_mapping_count(
            target.get(key),
            allowed_keys=MATERIALIZABLE_SOURCE_ROW_COUNT_KEYS,
        ):
            return True
    source_refs = [
        ref
        for ref in _as_text_list(target.get("source_refs"))
        if "strategy_runtime_ledger_buckets" not in ref
    ]
    source_ref = _as_text(target.get("source_ref"))
    if source_ref and "strategy_runtime_ledger_buckets" not in source_ref:
        source_refs.append(source_ref)
    return bool(source_refs)


def _runtime_window_source_collection_target_allowed(
    target: Mapping[str, Any],
) -> bool:
    account_label = _as_text(target.get("account_label"))
    source_account_label = _as_text(target.get("source_account_label")) or account_label
    if (
        account_label == "TORGHUT_REPLAY"
        and source_account_label == "TORGHUT_REPLAY"
        and _as_text(target.get("source_dsn_env")) == "DB_DSN"
        and not _runtime_window_source_collection_target_has_materializable_lineage(
            target
        )
    ):
        return False
    return True


def _runtime_window_target_plan_is_source_collection_only(
    plan: Mapping[str, Any],
) -> bool:
    source = str(plan.get("source") or "").strip()
    if source in SOURCE_COLLECTION_ONLY_PLAN_SOURCES:
        return True
    targets = _runtime_window_plan_target_items(plan)
    return bool(targets) and all(
        str(target.get("source_kind") or "").strip()
        == "runtime_ledger_source_collection_candidate"
        for target in targets
    )


def _runtime_window_target_plan_without_paper_route_source_collection_only(
    plan: Mapping[str, Any],
    *,
    paper_route_evidence_payload: bool,
) -> dict[str, Any]:
    candidate_plan = _as_dict(plan)
    if (
        paper_route_evidence_payload
        and _runtime_window_target_plan_is_source_collection_only(candidate_plan)
    ):
        return {}
    return candidate_plan


def _runtime_window_target_plan_source_collection_targets(
    gate_plan: Mapping[str, Any],
) -> list[dict[str, Any]]:
    targets = []
    for target in _runtime_window_plan_target_items(gate_plan):
        source_kind = str(target.get("source_kind") or "").strip()
        handoff = str(target.get("handoff") or "").strip()
        selected_by = str(target.get("selected_by") or "").strip()
        if (
            _runtime_window_target_plan_target_truthy(
                target.get("source_collection_authorized")
            )
            or source_kind == "runtime_ledger_source_collection_candidate"
            or handoff == "runtime_ledger_source_collection_import"
            or selected_by == "runtime_ledger_source_collection"
        ):
            if _runtime_window_source_collection_target_allowed(target):
                targets.append(target)
    return targets


def _runtime_window_gate_allows_source_collection_merge(
    *,
    gate: Mapping[str, Any],
    gate_plan: Mapping[str, Any],
) -> bool:
    blocked_reasons = {
        str(reason or "").strip()
        for reason in _as_sequence(gate.get("blocked_reasons"))
        if str(reason or "").strip()
    }
    if "runtime_ledger_source_collection_pending" in blocked_reasons:
        return True
    try:
        source_collection_target_count = int(
            gate_plan.get("source_collection_target_count") or 0
        )
    except (TypeError, ValueError):
        source_collection_target_count = 0
    if source_collection_target_count <= 0:
        return False
    reason = str(gate.get("reason") or "").strip()
    return reason == "non_live_mode"


def _runtime_window_target_plan_with_live_gate_source_collection(
    *,
    payload: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> dict[str, Any]:
    merged_plan = dict(plan)
    paper_route_evidence_payload = (
        str(payload.get("schema_version") or "").strip()
        == "torghut.paper-route-evidence.v1"
    )
    if (
        paper_route_evidence_payload
        and not _runtime_window_target_plan_is_source_collection_only(merged_plan)
    ):
        return merged_plan
    if (
        str(merged_plan.get("purpose") or "").strip()
        == "latest_closed_session_paper_route_runtime_window_import"
    ):
        return merged_plan
    gate = _as_dict(payload.get("live_submission_gate"))
    gate_plan = _as_dict(gate.get("runtime_ledger_paper_probation_import_plan"))
    source_collection_targets = _runtime_window_target_plan_source_collection_targets(
        gate_plan
    )
    if not source_collection_targets:
        return merged_plan

    if not _runtime_window_gate_allows_source_collection_merge(
        gate=gate,
        gate_plan=gate_plan,
    ):
        return merged_plan

    existing_targets = _runtime_window_plan_target_items(merged_plan)
    existing_keys = {
        _runtime_window_target_plan_target_key(target) for target in existing_targets
    }
    prepended_targets: list[dict[str, Any]] = []
    for target in source_collection_targets:
        key = _runtime_window_target_plan_target_key(target)
        if key in existing_keys:
            continue
        existing_keys.add(key)
        enriched_target = dict(target)
        enriched_target.setdefault(
            "source_collection_authorization_scope",
            "source_window_evidence_collection_only",
        )
        prepended_targets.append(enriched_target)
    if not prepended_targets:
        return merged_plan

    merged_targets = [*prepended_targets, *existing_targets]
    try:
        existing_source_collection_count = int(
            merged_plan.get("source_collection_target_count") or 0
        )
    except (TypeError, ValueError):
        existing_source_collection_count = 0
    merged_plan["targets"] = merged_targets
    merged_plan["target_count"] = len(merged_targets)
    merged_plan["source_collection_target_count"] = (
        len(prepended_targets) + existing_source_collection_count
    )
    merged_plan["paper_route_target_count"] = len(existing_targets)
    merged_plan["merged_live_submission_gate_source_collection"] = True
    merged_plan["source"] = "paper_route_target_plan_with_live_gate_source_collection"
    return merged_plan


def _latest_closed_runtime_window_target_plan_from_payload(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    plan = _as_dict(payload.get("latest_closed_paper_route_runtime_window_targets"))
    if not _runtime_window_plan_target_items(plan):
        return {}

    selection = _as_dict(payload.get("latest_closed_runtime_window_import_selection"))
    selection_state = str(selection.get("state") or "").strip()
    selection_selected = (
        _runtime_window_target_plan_target_truthy(selection.get("selected"))
        or selection_state == "selected"
    )
    if not selection_selected:
        return {}
    if not _runtime_window_target_plan_target_truthy(
        selection.get("clean_window_importable")
    ):
        return {}
    if not _runtime_window_target_plan_target_truthy(
        selection.get("source_backed_evidence_present")
    ):
        return {}

    session_readiness = _as_dict(plan.get("session_readiness"))
    runtime_handoff = _as_dict(plan.get("runtime_window_import_handoff"))
    import_ready = _runtime_window_target_plan_target_truthy(
        session_readiness.get("import_ready")
    ) or _runtime_window_target_plan_target_truthy(runtime_handoff.get("import_ready"))
    if not import_ready:
        return {}
    return plan


def _runtime_window_target_plan_from_payload(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    proofs_plan = paper_route_target_plan_from_payload(payload)
    if (
        str(payload.get("schema_version") or "").strip() == "torghut.proofs.v1"
        and proofs_plan
    ):
        return proofs_plan

    paper_route_evidence_payload = (
        str(payload.get("schema_version") or "").strip()
        == "torghut.paper-route-evidence.v1"
    )
    paper_route_plan = (
        _runtime_window_target_plan_without_paper_route_source_collection_only(
            _as_dict(payload.get("next_paper_route_runtime_window_targets")),
            paper_route_evidence_payload=paper_route_evidence_payload,
        )
    )
    clean_after_discard_plan = (
        _runtime_window_target_plan_without_paper_route_source_collection_only(
            _as_dict(
                payload.get(
                    "next_clean_paper_route_runtime_window_targets_after_discard"
                )
            ),
            paper_route_evidence_payload=paper_route_evidence_payload,
        )
    )
    latest_closed_plan = (
        _runtime_window_target_plan_without_paper_route_source_collection_only(
            _latest_closed_runtime_window_target_plan_from_payload(payload),
            paper_route_evidence_payload=paper_route_evidence_payload,
        )
    )
    direct_plan = (
        _runtime_window_target_plan_without_paper_route_source_collection_only(
            _as_dict(payload.get("runtime_window_import_plan")),
            paper_route_evidence_payload=paper_route_evidence_payload,
        )
    )
    if paper_route_evidence_payload:
        plan = next(
            (
                candidate_plan
                for candidate_plan in (
                    latest_closed_plan,
                    direct_plan,
                    clean_after_discard_plan,
                    paper_route_plan,
                )
                if _runtime_window_plan_target_items(candidate_plan)
            ),
            {},
        )
    else:
        plan = latest_closed_plan
    source_runtime_window_plan = _as_dict(
        payload.get("source_runtime_window_import_plan")
    )
    if (
        not plan
        and not paper_route_evidence_payload
        and _runtime_window_plan_target_items(source_runtime_window_plan)
    ):
        plan = source_runtime_window_plan
    if not plan:
        if direct_plan:
            plan = direct_plan
        else:
            gate = _as_dict(payload.get("live_submission_gate"))
            gate_plan = (
                _runtime_window_target_plan_without_paper_route_source_collection_only(
                    _as_dict(gate.get("runtime_ledger_paper_probation_import_plan")),
                    paper_route_evidence_payload=paper_route_evidence_payload,
                )
            )
            if gate_plan:
                plan = gate_plan
            else:
                top_level_gate_plan = _runtime_window_target_plan_without_paper_route_source_collection_only(
                    _as_dict(payload.get("runtime_ledger_paper_probation_import_plan")),
                    paper_route_evidence_payload=paper_route_evidence_payload,
                )
                if top_level_gate_plan:
                    plan = top_level_gate_plan
                elif paper_route_plan:
                    plan = paper_route_plan
                else:
                    plan = _runtime_window_target_plan_without_paper_route_source_collection_only(
                        payload,
                        paper_route_evidence_payload=paper_route_evidence_payload,
                    )
    plan = _runtime_window_target_plan_with_live_gate_source_collection(
        payload=payload,
        plan=plan,
    )
    plan = _runtime_window_target_plan_with_import_audit_blockers(
        payload=payload,
        plan=plan,
    )
    _raise_if_runtime_window_target_plan_import_blocked(payload, plan=plan)
    return plan


def _extend_unique_text_items(
    existing: Any,
    additions: Sequence[str],
) -> list[str]:
    values: list[str] = []
    if isinstance(existing, str):
        text = existing.strip()
        if text:
            values.append(text)
    elif isinstance(existing, Sequence) and not isinstance(
        existing, (bytes, bytearray)
    ):
        values.extend(str(item).strip() for item in existing if str(item).strip())
    values.extend(item for item in additions if item)
    return list(dict.fromkeys(values))


def _runtime_window_import_audit_blockers(audit: Mapping[str, Any]) -> list[str]:
    state = str(audit.get("state") or "").strip()
    blockers = _extend_unique_text_items((), _as_text_list(audit.get("blockers")))
    if not blockers and state in RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES:
        blockers.append(state)
    return blockers


def _target_text(payload: Mapping[str, Any], key: str) -> str:
    return str(payload.get(key) or "").strip()


def _target_strategy_names(payload: Mapping[str, Any]) -> set[str]:
    names = {
        _target_text(payload, "strategy_name"),
        _target_text(payload, "runtime_strategy_name"),
        _target_text(payload, "source_strategy_name"),
        _target_text(payload, "source_runtime_strategy_name"),
    }
    for item in _as_sequence(payload.get("strategy_lookup_names")):
        text = str(item).strip()
        if text:
            names.add(text)
    return {item for item in names if item}


def _runtime_window_audit_target_blocker_matches(
    *,
    target_blocker: Mapping[str, Any],
    target: Mapping[str, Any],
) -> bool:
    comparable_keys = (
        "hypothesis_id",
        "candidate_id",
        "account_label",
        "source_kind",
        "window_start",
        "window_end",
    )
    compared = False
    for key in comparable_keys:
        blocker_value = _target_text(target_blocker, key)
        if not blocker_value:
            continue
        compared = True
        if blocker_value != _target_text(target, key):
            return False

    blocker_strategy_names = _target_strategy_names(target_blocker)
    if blocker_strategy_names:
        compared = True
        if not blocker_strategy_names.intersection(_target_strategy_names(target)):
            return False
    return compared


def _runtime_window_target_plan_with_import_audit_blockers(
    *,
    payload: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> dict[str, Any]:
    audit = _as_dict(payload.get("runtime_window_import_audit"))
    if not audit:
        return dict(plan)
    state = str(audit.get("state") or "").strip()
    if state not in RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES:
        return dict(plan)
    raw_targets = plan.get("targets")
    if not isinstance(raw_targets, Sequence) or isinstance(
        raw_targets, (str, bytes, bytearray)
    ):
        return dict(plan)

    audit_blockers = _runtime_window_import_audit_blockers(audit)
    target_blockers = [
        blocker
        for item in _as_sequence(audit.get("target_blockers"))
        if (blocker := _as_dict(item))
    ]
    next_action = _as_text(audit.get("next_action"))
    annotated_targets: list[Any] = []
    for raw_target in raw_targets:
        target = _as_dict(raw_target)
        if not target:
            annotated_targets.append(raw_target)
            continue
        matched_blockers: list[str] = []
        for target_blocker in target_blockers:
            if _runtime_window_audit_target_blocker_matches(
                target_blocker=target_blocker,
                target=target,
            ):
                matched_blockers.extend(
                    _runtime_window_import_audit_blockers(target_blocker)
                )
        combined_blockers = list(dict.fromkeys([*audit_blockers, *matched_blockers]))
        if combined_blockers:
            for key in (
                "runtime_ledger_target_metadata_blockers",
                "runtime_window_import_health_gate_blockers",
                "candidate_blockers",
            ):
                target[key] = _extend_unique_text_items(
                    target.get(key), combined_blockers
                )
            target["runtime_window_import_audit_blockers"] = _extend_unique_text_items(
                target.get("runtime_window_import_audit_blockers"),
                audit_blockers,
            )
            if matched_blockers:
                target["runtime_window_import_audit_target_blockers"] = (
                    _extend_unique_text_items(
                        target.get("runtime_window_import_audit_target_blockers"),
                        matched_blockers,
                    )
                )
        target["runtime_window_import_audit_state"] = state
        if next_action is not None:
            target["runtime_window_import_audit_next_action"] = next_action
        annotated_targets.append(target)

    annotated_plan = dict(plan)
    annotated_plan["targets"] = annotated_targets
    return annotated_plan


__all__ = [name for name in globals() if not name.startswith("__")]
