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

US_EQUITIES_TIMEZONE = "America/New_York"
US_EQUITIES_OPEN = time(9, 30)
US_EQUITIES_CLOSE = time(16, 0)
EXECUTION_ELIGIBLE_DECISION_STATUSES = (
    "submitted",
    "filled",
    "partially_filled",
)
DEFAULT_AUTORESEARCH_RUNTIME_WINDOW_STATUSES = (
    "ok",
    "no_profit_target_candidate",
    "selection_only",
)
RUNTIME_WINDOW_TARGET_METADATA_KEYS = (
    "candidate_spec_id",
    "candidate_selection",
    "runtime_ledger_artifact_refs",
    "runtime_ledger_artifact_ref",
    "exact_replay_ledger_artifact_refs",
    "exact_replay_ledger_artifact_ref",
    "runtime_ledger_artifact_row_count",
    "runtime_ledger_artifact_fill_count",
    "runtime_ledger_target_metadata_blockers",
    "runtime_ledger_bucket_ref",
    "dependency_quorum_decision",
    "continuity_ok",
    "drift_ok",
    "runtime_window_import_health_gate",
    "runtime_window_import_health_gate_blockers",
    "runtime_window_import_promotion_blockers",
    "strategy_id",
    "runtime_strategy_name",
    "source_strategy_name",
    "source_runtime_strategy_name",
    "strategy_lookup_names",
    "window_start",
    "window_end",
    "max_notional",
    "replay_selection_reason",
    "paper_contract_candidate",
    "paper_contract_selected_for_replay",
    "paper_contract_prior_score",
    "paper_mechanism_overlay_ids",
    "paper_required_evidence_tokens",
    "paper_required_evidence_count",
    "paper_probation_authorized",
    "paper_probation_authorization_scope",
    "source_collection_authorized",
    "source_collection_authorization_scope",
    "source_collection_reason_codes",
    "bounded_evidence_collection_authorized",
    "bounded_evidence_collection_scope",
    "bounded_evidence_collection_max_notional",
    "evidence_collection_stage",
    "probation_allowed",
    "probation_reason",
    "selection_reason",
    "selected_by",
    "probation_lower_bound_net_pnl_per_day",
    "probation_target_shortfall",
    "promotion_allowed",
    "final_promotion_authorized",
    "final_promotion_allowed",
    "final_promotion_blockers",
    "candidate_blockers",
    "paper_route_probe_symbols",
    "paper_route_probe_symbol_count",
    "paper_route_probe_next_session_max_notional",
    "paper_route_probe_effective_max_notional",
    "paper_route_probe_window_start",
    "paper_route_probe_window_end",
    "paper_route_session_readiness_state",
    "paper_route_session_import_ready",
    "paper_route_session_import_blockers",
    "paper_route_runtime_window_import_not_before",
    "paper_route_runtime_import_handoff",
    "source_decision_mode",
    "profit_proof_eligible",
    "handoff",
    "promotion_gate",
)
RUNTIME_WINDOW_TARGET_PLAN_DEFERRED_REASONS = frozenset(
    (
        "runtime_window_target_plan_window_not_closed",
        "runtime_window_target_plan_window_settlement_pending",
    )
)
OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT = 5


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
        "--runtime-window-import-audit-only",
        action="store_true",
        help=(
            "Run planned runtime-window imports in read-only audit mode. "
            "This never authorizes promotion because no governance/runtime rows are persisted."
        ),
    )
    parser.add_argument(
        "--runtime-window-targets-from-registry",
        action="store_true",
        help=(
            "Import runtime windows for every hypothesis manifest that can be "
            "mapped to a runtime strategy. Explicit --runtime-window-target "
            "entries remain supported and take precedence on duplicate "
            "hypothesis_id values."
        ),
    )
    parser.add_argument(
        "--runtime-window-hypothesis-dir",
        default="config/trading/hypotheses",
    )
    parser.add_argument(
        "--runtime-window-family-dir",
        default="config/trading/families",
    )
    parser.add_argument(
        "--runtime-window-target",
        action="append",
        default=[],
        help=(
            "Repeatable comma-separated key=value runtime import target. "
            "Supported keys: hypothesis_id,candidate_id,strategy_family,"
            "strategy_name,account_label,source_account_label,observed_stage,"
            "source_dsn_env,target_dsn_env,dataset_snapshot_ref,source_manifest_ref,"
            "source_kind,delay_adjusted_depth_stress_report_ref."
        ),
    )
    parser.add_argument(
        "--runtime-window-source-account-label",
        default="",
        help=(
            "Optional source account label used only for source DB activity queries. "
            "The target account_label remains the materialized runtime-ledger label."
        ),
    )
    parser.add_argument(
        "--runtime-window-target-plan-ref",
        action="append",
        default=[],
        help=(
            "Repeatable path to a candidate-board/runtime-window-import-plan JSON "
            "artifact. Explicit --runtime-window-target entries take precedence "
            "over duplicate hypothesis_id values."
        ),
    )
    parser.add_argument(
        "--runtime-window-target-plan-url",
        action="append",
        default=[],
        help=(
            "Repeatable URL returning either a runtime-window import plan or a "
            "/trading/status payload with live_submission_gate."
            "runtime_ledger_paper_probation_import_plan, or a "
            "/trading/paper-route-evidence payload with "
            "next_paper_route_runtime_window_targets."
        ),
    )
    parser.add_argument(
        "--runtime-window-target-plan-url-timeout-seconds",
        type=float,
        default=5.0,
    )
    parser.add_argument(
        "--runtime-window-target-plan-url-attempts",
        type=int,
        default=1,
        help=(
            "Bounded attempts for runtime-window target plan URL reads. Retries "
            "transport failures and transient empty paper-route evidence while "
            "preserving required/exclusive fail-closed semantics."
        ),
    )
    parser.add_argument(
        "--runtime-window-target-plan-url-retry-backoff-seconds",
        type=float,
        default=0.25,
    )
    parser.add_argument(
        "--runtime-window-target-plan-exclusive",
        action="store_true",
        help=(
            "When a runtime-window target plan ref/url yields at least one target, "
            "skip latest-autoresearch and registry fallback targets for this run."
        ),
    )
    parser.add_argument(
        "--runtime-window-target-plan-required",
        action="store_true",
        help=(
            "Fail closed when runtime-window target plan refs/urls are missing or "
            "produce no targets instead of falling back to autoresearch or registry "
            "targets."
        ),
    )
    parser.add_argument(
        "--runtime-window-target-plan-settlement-seconds",
        type=int,
        default=0,
        help=(
            "For target-plan windows, defer runtime-window import until this many "
            "seconds after the target window end so fills, costs, and order lifecycle "
            "rows can land before proof import."
        ),
    )
    parser.add_argument(
        "--runtime-window-targets-from-latest-autoresearch",
        action="store_true",
        help=(
            "Import runtime-window targets from the latest persisted whitepaper "
            "autoresearch candidate board before falling back to hypothesis "
            "registry targets."
        ),
    )
    parser.add_argument(
        "--runtime-window-autoresearch-status",
        action="append",
        default=[],
        help=(
            "Repeatable autoresearch epoch status eligible for latest candidate "
            "board import. Defaults to ok, no_profit_target_candidate, and "
            "selection_only."
        ),
    )
    parser.add_argument(
        "--runtime-window-autoresearch-scan-limit", type=int, default=20
    )
    parser.add_argument("--runtime-window-hypothesis-id", default="H-PAIRS-01")
    parser.add_argument(
        "--runtime-window-candidate-id", default="c88421d619759b2cfaa6f4d0"
    )
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
    parser.add_argument("--runtime-window-target-dsn-env", default="")
    parser.add_argument("--runtime-window-start", default="")
    parser.add_argument("--runtime-window-end", default="")
    parser.add_argument("--runtime-window-dataset-snapshot-ref", default="")
    parser.add_argument("--runtime-window-bucket-minutes", type=int, default=30)
    parser.add_argument("--runtime-window-sample-minutes", type=int, default=5)
    parser.add_argument(
        "--runtime-window-source-manifest-ref",
        default="config/trading/hypotheses/h-pairs-01.json",
    )
    parser.add_argument(
        "--runtime-window-source-kind", default="paper_runtime_observed"
    )
    parser.add_argument("--runtime-window-dependency-quorum-decision", default="")
    parser.add_argument("--runtime-window-continuity-ok", default="")
    parser.add_argument("--runtime-window-drift-ok", default="")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _as_dict(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _as_sequence(value: Any) -> Sequence[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value
    return ()


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_text_list(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [text for item in value if (text := str(item).strip())]


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
    dependency_quorum_decision: str = ""
    continuity_ok: str = ""
    drift_ok: str = ""
    window_start: str = ""
    window_end: str = ""
    artifact_refs: tuple[str, ...] = ()
    target_metadata: Mapping[str, Any] | None = None
    source_account_label: str = ""
    target_dsn_env: str = ""


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


def _read_json_mapping(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _as_dict(payload)


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


def _runtime_window_target_plan_from_payload(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    direct_plan = _as_dict(payload.get("runtime_window_import_plan"))
    if direct_plan:
        return direct_plan
    paper_route_plan = _as_dict(payload.get("next_paper_route_runtime_window_targets"))
    if (
        str(payload.get("schema_version") or "").strip()
        == "torghut.paper-route-evidence.v1"
        and paper_route_plan
    ):
        return paper_route_plan
    gate = _as_dict(payload.get("live_submission_gate"))
    gate_plan = _as_dict(gate.get("runtime_ledger_paper_probation_import_plan"))
    if gate_plan:
        return gate_plan
    top_level_gate_plan = _as_dict(
        payload.get("runtime_ledger_paper_probation_import_plan")
    )
    if top_level_gate_plan:
        return top_level_gate_plan
    if paper_route_plan:
        return paper_route_plan
    return _as_dict(payload)


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
) -> tuple[str, str, str, str, str, str, str]:
    return (
        target.hypothesis_id,
        target.candidate_id,
        target.strategy_name,
        target.target_dsn_env,
        target.source_account_label,
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
                window_start=value("window_start", "runtime_window_start"),
                window_end=value("window_end", "runtime_window_end"),
                source_account_label=value(
                    "source_account_label",
                    "runtime_window_source_account_label",
                ),
            )
        )
    explicit_hypothesis_ids = {target.hypothesis_id for target in targets}
    seen_hypothesis_ids = set(explicit_hypothesis_ids)
    seen_target_keys = {_runtime_window_target_identity(target) for target in targets}
    for target in (*plan_targets, *autoresearch_targets):
        if target.hypothesis_id in explicit_hypothesis_ids:
            continue
        target_key = _runtime_window_target_identity(target)
        if target_key in seen_target_keys:
            continue
        targets.append(target)
        seen_target_keys.add(target_key)
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
                    target.account_label,
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
    for key in ("exact_replay_ledger_artifact_ref", "runtime_ledger_artifact_ref"):
        ref = _as_text(metadata.get(key))
        if ref is not None and ref not in refs:
            refs.append(ref)
    for key in ("exact_replay_ledger_artifact_refs", "runtime_ledger_artifact_refs"):
        for ref in _as_text_list(metadata.get(key)):
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
    ):
        value = candidate.get(key)
        if value not in (None, ""):
            payload[key] = value
    for key in ("promotion_blockers", "runtime_ledger_blockers"):
        values = _as_text_list(candidate.get(key))
        if values:
            payload[key] = values
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


def _offline_replay_triage_candidates_from_ranking(
    *,
    ranking: Mapping[str, Any],
    source_ref: str,
) -> list[dict[str, Any]]:
    raw_candidates = ranking.get("candidates")
    if not isinstance(raw_candidates, Sequence) or isinstance(
        raw_candidates,
        (str, bytes, bytearray),
    ):
        return []
    candidates: list[dict[str, Any]] = []
    for raw_candidate in raw_candidates[:OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT]:
        candidate = _as_dict(raw_candidate)
        if not candidate:
            continue
        candidates.append(
            _offline_replay_triage_candidate_from_ranking(
                candidate,
                source_ref=source_ref,
            )
        )
    return candidates


def _offline_replay_triage_source_reports(
    imports: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []
    seen_refs: set[str] = set()
    for item in imports:
        for ref in _offline_replay_artifact_refs(item):
            if ref in seen_refs:
                continue
            seen_refs.add(ref)
            path = Path(ref)
            if not path.exists() or not path.is_file():
                continue
            report = _offline_replay_triage_from_artifact_payload(
                payload=_read_json_mapping(path),
                source_ref=ref,
            )
            if report is not None:
                reports.append(report)
    return reports


def _offline_replay_triage_for_deferred_imports(
    *,
    args: argparse.Namespace,
    imports: Sequence[Mapping[str, Any]],
    now: datetime,
) -> dict[str, Any] | None:
    if not bool(getattr(args, "runtime_window_target_plan_exclusive", False)):
        return None
    if not imports:
        return None
    deferred_reasons = [
        _as_text(item.get("reason")) or ""
        for item in imports
        if _as_text(item.get("status")) == "deferred"
    ]
    if len(deferred_reasons) != len(imports):
        return None
    if any(
        reason not in RUNTIME_WINDOW_TARGET_PLAN_DEFERRED_REASONS
        for reason in deferred_reasons
    ):
        return None
    if not any(_runtime_window_import_is_paper_route(item) for item in imports):
        return None
    import_candidates = [
        _offline_replay_triage_candidate_from_import(item)
        for item in imports[:OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT]
    ]
    source_reports = _offline_replay_triage_source_reports(imports)
    report_candidates: list[dict[str, Any]] = []
    for report in source_reports:
        for candidate in report.get("candidates", []):
            if isinstance(candidate, Mapping):
                report_candidates.append(dict(candidate))
            if len(report_candidates) >= OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT:
                break
        if len(report_candidates) >= OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT:
            break
    source_kind = (
        "simulation_exact_replay_runtime_ledger"
        if any(
            candidate.get("source_kind") == "simulation_exact_replay_runtime_ledger"
            for candidate in (*import_candidates, *report_candidates)
        )
        else "research_handoff"
    )
    return {
        "schema_version": "torghut.offline-replay-triage.v1",
        "status": "informational",
        "authority": "non_authoritative_research_triage",
        "promotion_allowed": False,
        "promotion_authority": "blocked",
        "excluded_from_runtime_window_import_proof": True,
        "source_kind": source_kind,
        "reason": "authoritative_runtime_window_imports_deferred",
        "generated_at": _utc_iso(now),
        "deferred_reasons": sorted(set(deferred_reasons)),
        "authoritative_import_target_count": len(imports),
        "proof_status_effect": "none",
        "promotion_authority_effect": "none",
        "runtime_window_import_proof_effect": "none",
        "lifecycle_count_effect": "none",
        "doc29_live_scale_gate_effect": "none",
        "post_cost_pnl_target_gate_effect": "none",
        "candidates": import_candidates,
        "source_reports": source_reports,
        "source_report_candidates": report_candidates,
    }


def _runtime_window_import_payload_proof_blockers(
    *,
    payload: Mapping[str, Any],
    target: RuntimeWindowImportTarget,
    candidate_id: str,
    window_start: datetime,
    window_end: datetime,
) -> list[dict[str, Any]]:
    blockers = [
        dict(blocker)
        for blocker in payload.get("proof_blockers", [])
        if isinstance(blocker, Mapping)
    ]
    if blockers:
        return blockers

    seen: set[str] = set()

    def add_blocker(reason: str) -> None:
        code = str(reason or "").strip()
        if not code or code in seen:
            return
        seen.add(code)
        blockers.append(
            {
                "blocker": code,
                "hypothesis_id": target.hypothesis_id,
                "candidate_id": candidate_id,
                "observed_stage": target.observed_stage,
                "window_start": _utc_iso(window_start),
                "window_end": _utc_iso(window_end),
                "remediation": (
                    "Inspect the runtime-window import summary and repair route, TCA, "
                    "fill, cost, lineage, or post-cost ledger evidence before promotion."
                ),
            }
        )

    evidence_reasons = _as_text_list(payload.get("evidence_blocking_reasons"))
    runtime_observation = _as_dict(payload.get("runtime_observation"))
    source_activity_diagnostic_blockers = _as_text_list(
        payload.get("source_activity_diagnostic_blockers")
    )
    if not source_activity_diagnostic_blockers and runtime_observation:
        source_activity_diagnostic_blockers = _as_text_list(
            runtime_observation.get("source_activity_diagnostic_blockers")
        )
    if evidence_reasons:
        for reason in evidence_reasons:
            add_blocker(reason)
    elif source_activity_diagnostic_blockers:
        for reason in source_activity_diagnostic_blockers:
            add_blocker(reason)
    elif payload.get("promotion_allowed") is False:
        if "evidence_blocking_reasons" not in payload:
            reasons = _as_text_list(payload.get("promotion_blocking_reasons"))
            for reason in reasons or ["runtime_window_import_not_promotion_allowed"]:
                add_blocker(reason)
    elif "promotion_allowed" not in payload:
        legacy_decision = _as_text(payload.get("promotion_decision"))
        if legacy_decision is not None and legacy_decision.lower() != "allowed":
            add_blocker("runtime_window_import_promotion_decision_not_allowed")
        else:
            add_blocker("runtime_window_import_promotion_allowed_missing")

    if not runtime_observation:
        add_blocker("runtime_observation_missing")
    elif runtime_observation.get("authoritative") is not True:
        add_blocker(
            _as_text(runtime_observation.get("authority_reason"))
            or "runtime_observation_not_authoritative"
        )

    return blockers


def _runtime_window_import_health_gate_args(
    *,
    target: RuntimeWindowImportTarget,
    runtime_manifest: Mapping[str, Any],
) -> tuple[str, str, str]:
    dependency_quorum_decision = (
        _as_text(target.dependency_quorum_decision)
        or _as_text(runtime_manifest.get("dependency_quorum_decision"))
        or ""
    )
    continuity_ok = (
        _as_text(target.continuity_ok)
        or _as_text(runtime_manifest.get("continuity_ok"))
        or ""
    )
    drift_ok = (
        _as_text(target.drift_ok) or _as_text(runtime_manifest.get("drift_ok")) or ""
    )
    return dependency_quorum_decision, continuity_ok, drift_ok


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
    runtime_manifest = _read_runtime_window_manifest(target.source_manifest_ref)
    window_selection = "explicit_or_default"
    target_plan_window = _runtime_window_target_plan_bounds(target)
    if target_plan_window is not None:
        window_start, window_end = target_plan_window
        window_selection = "target_plan_window"
    elif allow_source_activity_window:
        source_activity_window = _latest_source_activity_window(
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
    audit_only = bool(getattr(args, "runtime_window_import_audit_only", False))
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
        "source_activity_diagnostics": source_activity_diagnostics,
        "source_activity_diagnostic_blockers": source_activity_diagnostic_blockers,
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
