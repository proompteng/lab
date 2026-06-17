#!/usr/bin/env python3
"""Renew empirical promotion artifacts from the latest authoritative replay outputs."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence


from .shared_context import (
    OFFLINE_REPLAY_TRIAGE_CANDIDATE_LIMIT,
    RUNTIME_WINDOW_TARGET_PLAN_DEFERRED_REASONS,
    RuntimeWindowImportTarget,
    as_dict as _as_dict,
    as_sequence as _as_sequence,
    as_text as _as_text,
    as_text_list as _as_text_list,
    nonnegative_int as _nonnegative_int,
    utc_iso as _utc_iso,
)
from .parse_runtime_window_target_spec import (
    read_json_mapping as _read_json_mapping,
    runtime_window_source_collection_target_has_materializable_lineage as _runtime_window_source_collection_target_has_materializable_lineage,
)
from .runtime_window_targets import (
    offline_replay_artifact_refs as _offline_replay_artifact_refs,
    offline_replay_triage_candidate_from_import as _offline_replay_triage_candidate_from_import,
    offline_replay_triage_candidate_from_ranking as _offline_replay_triage_candidate_from_ranking,
    offline_replay_triage_from_artifact_payload as _offline_replay_triage_from_artifact_payload,
    runtime_window_import_is_paper_route as _runtime_window_import_is_paper_route,
)


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


def _runtime_window_import_ladder_step(
    step: str,
    *,
    blockers: Sequence[str],
    step_blockers: frozenset[str],
    present: bool,
    observed: Mapping[str, Any],
    next_action: str,
) -> dict[str, Any]:
    blocker_codes = sorted(
        dict.fromkeys(blocker for blocker in blockers if blocker in step_blockers)
    )
    if blocker_codes:
        status = "blocked"
    elif present:
        status = "pass"
    else:
        status = "missing"
    return {
        "step": step,
        "status": status,
        "observed": dict(observed),
        "blocker_codes": blocker_codes,
        "next_action": next_action if status != "pass" else None,
    }


def _runtime_window_import_next_blocker(
    ladder: Sequence[Mapping[str, Any]],
) -> dict[str, Any] | None:
    for step in ladder:
        if step.get("status") != "pass":
            return {
                "step": step.get("step"),
                "status": step.get("status"),
                "blocker_codes": list(_as_sequence(step.get("blocker_codes"))),
                "next_action": step.get("next_action"),
            }
    return None


def _runtime_window_import_blocker_ladder(
    *,
    payload: Mapping[str, Any],
    target: RuntimeWindowImportTarget,
    candidate_id: str,
    window_start: datetime,
    window_end: datetime,
    proof_blockers: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    runtime_observation = _as_dict(payload.get("runtime_observation"))
    diagnostics = _as_dict(payload.get("source_activity_diagnostics"))
    if not diagnostics and runtime_observation:
        diagnostics = _as_dict(runtime_observation.get("source_activity_diagnostics"))
    materialization = _as_dict(payload.get("runtime_ledger_materialization"))
    if not materialization and runtime_observation:
        materialization = _as_dict(runtime_observation)
    blocker_codes = [
        text
        for blocker in proof_blockers
        if isinstance(blocker, Mapping)
        if (text := _as_text(blocker.get("blocker"))) is not None
    ]
    for key in (
        "source_activity_diagnostic_blockers",
        "evidence_blocking_reasons",
        "promotion_blocking_reasons",
    ):
        blocker_codes.extend(_as_text_list(payload.get(key)))
        blocker_codes.extend(_as_text_list(runtime_observation.get(key)))
    for key in (
        "runtime_ledger_materialization_blockers",
        "runtime_ledger_profit_proof_blockers",
        "runtime_ledger_target_metadata_blockers",
    ):
        blocker_codes.extend(_as_text_list(payload.get(key)))
        blocker_codes.extend(_as_text_list(runtime_observation.get(key)))
        blocker_codes.extend(_as_text_list(materialization.get(key)))
    blocker_codes = list(dict.fromkeys(blocker_codes))

    decision_count = max(
        _nonnegative_int(payload.get("decision_count")),
        _nonnegative_int(diagnostics.get("decision_rows_after_lineage_filter")),
        _nonnegative_int(diagnostics.get("decision_rows_before_lineage_filter")),
    )
    execution_count = max(
        _nonnegative_int(payload.get("execution_count")),
        _nonnegative_int(payload.get("trade_count")),
        _nonnegative_int(diagnostics.get("execution_rows_after_lineage_filter")),
        _nonnegative_int(diagnostics.get("execution_rows_before_lineage_filter")),
    )
    order_event_count = max(
        _nonnegative_int(payload.get("order_count")),
        _nonnegative_int(diagnostics.get("order_lifecycle_rows_after_lineage_filter")),
        _nonnegative_int(diagnostics.get("order_lifecycle_rows_before_lineage_filter")),
        _nonnegative_int(diagnostics.get("order_feed_fill_lifecycle_count")),
        _nonnegative_int(diagnostics.get("fill_lifecycle_event_count")),
    )
    tca_row_count = max(
        _nonnegative_int(payload.get("tca_row_count")),
        _nonnegative_int(diagnostics.get("execution_tca_rows_after_lineage_filter")),
        _nonnegative_int(materialization.get("runtime_ledger_tca_row_count")),
        _nonnegative_int(runtime_observation.get("runtime_ledger_tca_row_count")),
        _nonnegative_int(diagnostics.get("runtime_ledger_source_bucket_tca_row_count")),
    )
    source_bucket_count = max(
        _nonnegative_int(diagnostics.get("runtime_ledger_source_bucket_count")),
        _nonnegative_int(runtime_observation.get("runtime_ledger_source_bucket_count")),
        _nonnegative_int(
            materialization.get("runtime_ledger_tca_runtime_bucket_row_count")
        ),
        _nonnegative_int(
            materialization.get(
                "runtime_ledger_source_execution_materialized_bucket_count"
            )
        ),
    )
    source_materialized_count = max(
        _nonnegative_int(
            runtime_observation.get(
                "runtime_ledger_source_execution_materialized_bucket_count"
            )
        ),
        _nonnegative_int(
            materialization.get(
                "runtime_ledger_source_execution_materialized_bucket_count"
            )
        ),
    )
    source_profit_proof_count = max(
        _nonnegative_int(
            diagnostics.get("runtime_ledger_source_bucket_profit_proof_count")
        ),
        _nonnegative_int(
            runtime_observation.get("runtime_ledger_tca_profit_proof_count")
        ),
        _nonnegative_int(runtime_observation.get("runtime_ledger_profit_proof_count")),
        _nonnegative_int(materialization.get("runtime_ledger_tca_profit_proof_count")),
    )
    runtime_profit_proof_present = (
        runtime_observation.get("runtime_ledger_profit_proof_present") is True
        or source_profit_proof_count > 0
    )
    source_activity_present = (
        decision_count > 0
        or execution_count > 0
        or order_event_count > 0
        or source_bucket_count > 0
        or tca_row_count > 0
    )
    common_observed = {
        "hypothesis_id": target.hypothesis_id,
        "candidate_id": candidate_id,
        "observed_stage": target.observed_stage,
        "source_kind": target.source_kind,
        "account_label": target.account_label,
        "source_account_label": target.source_account_label or target.account_label,
        "window_start": _utc_iso(window_start),
        "window_end": _utc_iso(window_end),
    }
    return [
        _runtime_window_import_ladder_step(
            "source_activity_present",
            blockers=blocker_codes,
            step_blockers=frozenset(
                (
                    "runtime_window_source_activity_missing",
                    "strategy_account_symbol_window_source_activity_missing",
                    "source_lineage_filter_excluded_activity",
                )
            ),
            present=source_activity_present,
            observed={
                **common_observed,
                "decision_count": decision_count,
                "execution_count": execution_count,
                "order_event_count": order_event_count,
                "tca_row_count": tca_row_count,
                "runtime_ledger_source_bucket_count": source_bucket_count,
            },
            next_action="collect source decisions, executions, order events, TCA, or source-backed runtime-ledger buckets for this target window",
        ),
        _runtime_window_import_ladder_step(
            "decisions_present",
            blockers=blocker_codes,
            step_blockers=frozenset(
                (
                    "source_decisions_missing",
                    "runtime_ledger_trade_decision_refs_missing",
                )
            ),
            present=decision_count > 0,
            observed={**common_observed, "decision_count": decision_count},
            next_action="route the target through paper/live decision generation until durable TradeDecision refs exist",
        ),
        _runtime_window_import_ladder_step(
            "executions_present",
            blockers=blocker_codes,
            step_blockers=frozenset(
                (
                    "source_executions_missing",
                    "execution_rows_missing_for_matched_decisions",
                    "runtime_ledger_execution_refs_missing",
                )
            ),
            present=execution_count > 0,
            observed={**common_observed, "execution_count": execution_count},
            next_action="submit or repair paper/live orders until execution rows are linked to the target decisions",
        ),
        _runtime_window_import_ladder_step(
            "order_event_refs_present",
            blockers=blocker_codes,
            step_blockers=frozenset(
                (
                    "order_feed_fill_lifecycle_missing",
                    "runtime_ledger_execution_order_event_refs_missing",
                    "order_feed_unlinked_fill_lifecycle_present",
                )
            ),
            present=order_event_count > 0,
            observed={**common_observed, "order_event_count": order_event_count},
            next_action="repair order-feed lifecycle rows and link fill events to executions before import authority review",
        ),
        _runtime_window_import_ladder_step(
            "tca_costs_present",
            blockers=blocker_codes,
            step_blockers=frozenset(
                (
                    "source_tca_missing",
                    "execution_tca_rows_missing",
                    "runtime_ledger_execution_tca_refs_missing",
                    "runtime_ledger_explicit_costs_missing",
                )
            ),
            present=tca_row_count > 0,
            observed={**common_observed, "tca_row_count": tca_row_count},
            next_action="record execution TCA and explicit broker cost rows before post-cost profitability proof",
        ),
        _runtime_window_import_ladder_step(
            "runtime_ledger_source_materialization_present",
            blockers=blocker_codes,
            step_blockers=frozenset(
                (
                    "runtime_ledger_source_bucket_missing",
                    "runtime_ledger_source_materialization_missing",
                    "runtime_ledger_source_refs_missing",
                    "runtime_ledger_source_window_missing",
                    "runtime_ledger_source_window_ids_missing",
                    "runtime_ledger_source_offsets_missing",
                    "runtime_ledger_authority_class_missing",
                )
            ),
            present=source_bucket_count > 0 and source_materialized_count > 0,
            observed={
                **common_observed,
                "runtime_ledger_source_bucket_count": source_bucket_count,
                "runtime_ledger_source_materialized_bucket_count": (
                    source_materialized_count
                ),
                "runtime_ledger_materialization_blockers": _as_text_list(
                    materialization.get("runtime_ledger_materialization_blockers")
                ),
            },
            next_action="materialize source refs, source windows, offsets, order-event refs, and authority class into runtime-ledger buckets",
        ),
        _runtime_window_import_ladder_step(
            "runtime_ledger_profit_proof_present",
            blockers=blocker_codes,
            step_blockers=frozenset(
                (
                    "runtime_ledger_source_bucket_profit_proof_missing",
                    "runtime_ledger_pnl_basis_missing",
                    "runtime_without_runtime_ledger_profit_proof",
                    "runtime_observation_not_authoritative",
                    "runtime_window_import_not_promotion_allowed",
                )
            ),
            present=runtime_profit_proof_present
            and runtime_observation.get("authoritative") is True,
            observed={
                **common_observed,
                "runtime_ledger_profit_proof_present": runtime_profit_proof_present,
                "runtime_ledger_source_bucket_profit_proof_count": (
                    source_profit_proof_count
                ),
                "authoritative": runtime_observation.get("authoritative"),
                "authority_reason": runtime_observation.get("authority_reason"),
                "promotion_authority": runtime_observation.get("promotion_authority"),
            },
            next_action="rerun import only after source-backed runtime-ledger buckets satisfy post-cost proof authority",
        ),
    ]


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


def _runtime_window_import_needs_source_window_repair(
    target: RuntimeWindowImportTarget,
) -> bool:
    target_metadata = _as_dict(target.target_metadata)
    return (
        target.source_kind == "runtime_ledger_source_collection_candidate"
        and _as_text(target_metadata.get("source_collection_next_action"))
        == "materialize_runtime_ledger_source_window_refs"
    )


def _run_runtime_window_source_window_repair(
    *,
    target: RuntimeWindowImportTarget,
    window_start: datetime,
    window_end: datetime,
    audit_only: bool,
) -> dict[str, Any] | None:
    if not _runtime_window_import_needs_source_window_repair(target):
        return None
    source_account_label = target.source_account_label or target.account_label
    command = [
        sys.executable,
        "scripts/repair_order_feed_source_windows.py",
        "--dsn-env",
        target.source_dsn_env,
        "--account-label",
        source_account_label,
        "--window-start",
        _utc_iso(window_start),
        "--window-end",
        _utc_iso(window_end),
        "--batch-size",
        "5000",
        "--max-batches",
        "2",
        "--backfill-execution-events",
        "--json",
    ]
    if (
        target.source_account_label
        and target.source_account_label != target.account_label
    ):
        command.extend(["--canonical-account-label", target.account_label])
    if not audit_only:
        command.append("--apply")
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError("runtime_window_source_window_repair_payload_not_mapping")
    payload = dict(payload)
    payload["command"] = " ".join(command[:2] + ["..."])
    return payload


def _runtime_window_source_collection_materialization_blocked_result(
    *,
    target: RuntimeWindowImportTarget,
    candidate_id: str,
    manifest_path: Path,
    window_start: datetime,
    window_end: datetime,
    window_selection: str,
) -> dict[str, Any] | None:
    if target.source_kind != "runtime_ledger_source_collection_candidate":
        return None
    if _runtime_window_import_needs_source_window_repair(target):
        return None
    target_metadata = _as_dict(target.target_metadata)
    if _runtime_window_source_collection_target_has_materializable_lineage(
        target_metadata
    ):
        return None
    reason_codes = _as_text_list(target_metadata.get("source_collection_reason_codes"))
    blocker_codes = list(
        dict.fromkeys(
            [
                "runtime_ledger_source_collection_materialization_missing",
                *reason_codes,
            ]
        )
    )
    next_action = (
        _as_text(target_metadata.get("source_collection_next_action"))
        or "materialize_runtime_ledger_source_window_refs"
    )
    proof_blockers = [
        {
            "blocker": blocker,
            "hypothesis_id": target.hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": target.observed_stage,
            "window_start": _utc_iso(window_start),
            "window_end": _utc_iso(window_end),
            "source_collection_next_action": next_action,
            "remediation": (
                "Materialize concrete source refs, source window ids, execution ids, "
                "or order-event/TCA source counts before runtime-window import."
            ),
        }
        for blocker in blocker_codes
    ]
    return {
        "status": "blocked",
        "reason": "runtime_ledger_source_collection_materialization_required",
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


# Public aliases used by split-module consumers.
offline_replay_triage_candidates_from_ranking = (
    _offline_replay_triage_candidates_from_ranking
)
offline_replay_triage_for_deferred_imports = _offline_replay_triage_for_deferred_imports
offline_replay_triage_source_reports = _offline_replay_triage_source_reports
run_runtime_window_source_window_repair = _run_runtime_window_source_window_repair
runtime_window_import_blocker_ladder = _runtime_window_import_blocker_ladder
runtime_window_import_health_gate_args = _runtime_window_import_health_gate_args
runtime_window_import_ladder_step = _runtime_window_import_ladder_step
runtime_window_import_needs_source_window_repair = (
    _runtime_window_import_needs_source_window_repair
)
runtime_window_import_next_blocker = _runtime_window_import_next_blocker
runtime_window_import_payload_proof_blockers = (
    _runtime_window_import_payload_proof_blockers
)
runtime_window_source_collection_materialization_blocked_result = (
    _runtime_window_source_collection_materialization_blocked_result
)

__all__ = (
    "offline_replay_triage_candidates_from_ranking",
    "offline_replay_triage_for_deferred_imports",
    "offline_replay_triage_source_reports",
    "run_runtime_window_source_window_repair",
    "runtime_window_import_blocker_ladder",
    "runtime_window_import_health_gate_args",
    "runtime_window_import_ladder_step",
    "runtime_window_import_needs_source_window_repair",
    "runtime_window_import_next_blocker",
    "runtime_window_import_payload_proof_blockers",
    "runtime_window_source_collection_materialization_blocked_result",
)
