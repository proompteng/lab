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

# ruff: noqa: F401,F811,F821


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
    "exact_replay_ledger_artifact_row_count",
    "exact_replay_ledger_artifact_fill_count",
    "runtime_ledger_target_metadata_blockers",
    "runtime_ledger_bucket_ref",
    "dependency_quorum_decision",
    "continuity_ok",
    "drift_ok",
    "runtime_window_import_health_gate",
    "runtime_window_import_health_gate_blockers",
    "runtime_window_import_promotion_blockers",
    "runtime_window_import_audit_state",
    "runtime_window_import_audit_next_action",
    "runtime_window_import_audit_blockers",
    "runtime_window_import_audit_target_blockers",
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
    "source_collection_priority",
    "source_collection_profit_target_candidate",
    "source_collection_profit_target_net_pnl_after_costs",
    "source_collection_filled_notional",
    "source_collection_net_strategy_pnl_after_costs",
    "source_collection_post_cost_expectancy_bps",
    "source_collection_next_action",
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
    "source_window_start",
    "source_window_end",
    "source_refs",
    "runtime_ledger_source_refs",
    "source_ref",
    "source_row_counts",
    "runtime_ledger_source_row_counts",
    "source_window_ids",
    "runtime_ledger_source_window_ids",
    "source_window_id",
    "runtime_ledger_source_window_id",
    "source_window_refs",
    "runtime_ledger_source_window_refs",
    "trade_decision_ids",
    "runtime_ledger_trade_decision_ids",
    "execution_ids",
    "runtime_ledger_execution_ids",
    "execution_tca_metric_ids",
    "runtime_ledger_execution_tca_metric_ids",
    "execution_order_event_ids",
    "runtime_ledger_execution_order_event_ids",
    "source_offsets",
    "runtime_ledger_source_offsets",
    "source_materialization",
    "source_materializations",
    "runtime_ledger_source_materialization",
    "runtime_ledger_source_materializations",
    "authority_class",
    "authority_classes",
    "runtime_ledger_authority_class",
    "runtime_ledger_authority_classes",
    "authority_reason",
    "authority_reasons",
    "runtime_ledger_authority_reason",
    "runtime_ledger_authority_reasons",
    "pnl_derivation",
    "runtime_ledger_pnl_derivation",
    "cost_basis_counts",
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

SOURCE_COLLECTION_ONLY_PLAN_SOURCES = frozenset(
    {
        "paper_route_observed_strategy_source_collection",
        "paper_route_prioritized_source_collection",
    }
)

MATERIALIZABLE_SOURCE_ROW_COUNT_KEYS = frozenset(
    {
        "trade_decisions",
        "executions",
        "execution_tca_metrics",
        "execution_order_events",
        "order_feed_source_windows",
    }
)

RUNTIME_WINDOW_TARGET_PLAN_DEFERRED_REASONS = frozenset(
    (
        "runtime_window_target_plan_window_not_closed",
        "runtime_window_target_plan_window_settlement_pending",
    )
)

RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES = frozenset(
    (
        "import_due_account_contamination_detected",
        "import_due_account_state_not_clean",
        "import_due_source_activity_missing",
    )
)

PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL = "TORGHUT_SIM"

PAPER_ROUTE_REPLAY_ACCOUNT_LABEL = "TORGHUT_REPLAY"

SIM_DB_DSN_ENV = "SIM_DB_DSN"

SIM_BACKED_PAPER_ROUTE_SOURCE_KINDS = frozenset(
    (
        "paper_route_probe_runtime_observed",
        "runtime_ledger_source_collection_candidate",
    )
)

OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT = 5

HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION = (
    "torghut.hpairs-source-proof-census-status.v1"
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
            "entries remain supported and take precedence on duplicate target "
            "scopes."
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
            "source_kind,dependency_quorum_decision,continuity_ok,drift_ok,"
            "delay_adjusted_depth_stress_report_ref,artifact_refs, and target "
            "metadata keys accepted by runtime-window target plans."
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
            "over duplicate target scopes."
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
            "/trading/proofs payload."
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
        "--hpairs-source-proof-census-file",
        type=Path,
        default=None,
        help=(
            "Optional read-only audit_hpairs_source_proof_census.py JSON artifact "
            "to attach as non-authority renewal status evidence."
        ),
    )
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


def _nonnegative_int(value: Any) -> int:
    try:
        return max(int(str(value or "0")), 0)
    except (TypeError, ValueError):
        return 0


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


def _normalized_sim_backed_source_account_label(
    *,
    account_label: str,
    source_account_label: str,
    source_dsn_env: str,
    source_kind: str,
) -> str:
    resolved = source_account_label or account_label
    if (
        account_label == PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL
        and resolved == PAPER_ROUTE_REPLAY_ACCOUNT_LABEL
        and source_dsn_env == SIM_DB_DSN_ENV
        and source_kind.strip() in SIM_BACKED_PAPER_ROUTE_SOURCE_KINDS
    ):
        return account_label
    return resolved


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

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source_account_label",
            _normalized_sim_backed_source_account_label(
                account_label=self.account_label,
                source_account_label=self.source_account_label,
                source_dsn_env=self.source_dsn_env,
                source_kind=self.source_kind,
            ),
        )


def _runtime_window_target_plan_import_blocked_result(
    *,
    target: RuntimeWindowImportTarget,
    candidate_id: str,
    manifest_path: Path,
    window_start: datetime,
    window_end: datetime,
    window_selection: str,
) -> dict[str, Any] | None:
    target_metadata = _as_dict(target.target_metadata)
    state = _as_text(target_metadata.get("runtime_window_import_audit_state"))
    if state not in RUNTIME_WINDOW_TARGET_PLAN_IMPORT_BLOCKED_STATES:
        return None
    if not _runtime_window_target_is_paper_route_collection(
        target=target, target_metadata=target_metadata
    ):
        return None

    blockers = [state]
    for key in (
        "runtime_window_import_audit_blockers",
        "runtime_window_import_audit_target_blockers",
        "runtime_ledger_target_metadata_blockers",
        "runtime_window_import_health_gate_blockers",
        "candidate_blockers",
    ):
        blockers.extend(_as_text_list(target_metadata.get(key)))
    blocker_codes = list(dict.fromkeys(blockers))
    remediation_by_state = {
        "import_due_account_contamination_detected": (
            "Discard this paper window for proof, isolate the paper account, and "
            "collect a fresh clean session before runtime-ledger import."
        ),
        "import_due_account_state_not_clean": (
            "Reset or flatten the paper account, persist a clean pre-session "
            "snapshot, and collect a fresh clean session before runtime-ledger import."
        ),
        "import_due_source_activity_missing": (
            "Repair target-plan/source activity collection and collect a fresh "
            "source-backed session before runtime-ledger import."
        ),
    }
    remediation = remediation_by_state.get(
        state,
        "Repair the target-plan import audit blockers before runtime-ledger import.",
    )
    proof_blockers = [
        {
            "blocker": blocker,
            "hypothesis_id": target.hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": target.observed_stage,
            "window_start": _utc_iso(window_start),
            "window_end": _utc_iso(window_end),
            "runtime_window_import_audit_state": state,
            "remediation": remediation,
        }
        for blocker in blocker_codes
    ]
    return {
        "status": "blocked",
        "reason": f"runtime_window_target_plan_import_blocked:{state}",
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
        "target_metadata": target_metadata,
        "proof_status": "blocked",
        "proof_blockers": proof_blockers,
        "summary": None,
    }


def _runtime_window_target_is_paper_route_collection(
    *,
    target: RuntimeWindowImportTarget,
    target_metadata: Mapping[str, Any],
) -> bool:
    source_kind = target.source_kind.strip().lower().replace("-", "_")
    handoff = str(target_metadata.get("handoff") or "").strip()
    return (
        source_kind.startswith("paper_route")
        or handoff == "next_paper_route_runtime_window_import"
        or bool(target_metadata.get("paper_probation_authorized"))
        or bool(_as_text_list(target_metadata.get("paper_route_probe_symbols")))
    )


# Public aliases used by split-module consumers.
as_dict = _as_dict
as_sequence = _as_sequence
as_text = _as_text
as_text_list = _as_text_list
nonnegative_int = _nonnegative_int
normalized_sim_backed_source_account_label = _normalized_sim_backed_source_account_label
parse_args = _parse_args
parse_dt = _parse_dt
read_runtime_window_manifest = _read_runtime_window_manifest
runtime_manifest_delay_depth_stress_report_ref = (
    _runtime_manifest_delay_depth_stress_report_ref
)
runtime_manifest_entry_requirements = _runtime_manifest_entry_requirements
runtime_manifest_requires_delay_depth_stress = (
    _runtime_manifest_requires_delay_depth_stress
)
runtime_version_ref = _runtime_version_ref
runtime_window_delay_depth_remediation = _runtime_window_delay_depth_remediation
runtime_window_target_is_paper_route_collection = (
    _runtime_window_target_is_paper_route_collection
)
runtime_window_target_plan_import_blocked_result = (
    _runtime_window_target_plan_import_blocked_result
)
utc_iso = _utc_iso

__all__ = (
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
    "as_dict",
    "as_sequence",
    "as_text",
    "as_text_list",
    "nonnegative_int",
    "normalized_sim_backed_source_account_label",
    "parse_args",
    "parse_dt",
    "read_runtime_window_manifest",
    "runtime_manifest_delay_depth_stress_report_ref",
    "runtime_manifest_entry_requirements",
    "runtime_manifest_requires_delay_depth_stress",
    "runtime_version_ref",
    "runtime_window_delay_depth_remediation",
    "runtime_window_target_is_paper_route_collection",
    "runtime_window_target_plan_import_blocked_result",
    "utc_iso",
)
