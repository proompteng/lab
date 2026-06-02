"""Build runtime-window handoff plans from exact replay ledger evidence."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from .replay_ledger_ranker import (
    ReplayLedgerRankingPolicy,
    build_replay_ledger_ranking_report,
)
from .replay_ledger_remediation import build_replay_ledger_remediation_report

REPLAY_RUNTIME_WINDOW_HANDOFF_SCHEMA_VERSION = (
    "torghut.replay-runtime-window-handoff.v1"
)
RUNTIME_WINDOW_IMPORT_PLAN_SCHEMA_VERSION = "torghut.runtime-window-import-plan.v1"
CANDIDATE_BOARD_SCHEMA_VERSION = "torghut.strategy-autoresearch-candidate-board.v1"


def build_replay_runtime_window_handoff(
    *,
    ledger_paths: Sequence[Path],
    policy: ReplayLedgerRankingPolicy,
    hypothesis_id: str,
    source_manifest_ref: str,
    run_id: str = "",
    frontier_payload: Mapping[str, Any] | None = None,
    strategy_family: str = "",
    strategy_name: str = "",
    account_label: str = "TORGHUT_REPLAY",
    observed_stage: str = "paper",
    source_kind: str = "simulation_exact_replay_runtime_ledger",
    dataset_snapshot_ref: str = "",
    limit: int = 20,
) -> dict[str, Any]:
    """Return a non-promotional runtime-window import plan for ranked ledgers."""

    frontier = _mapping(frontier_payload)
    ranking_report = build_replay_ledger_ranking_report(
        ledger_paths,
        policy=policy,
        limit=limit,
    )
    remediation_report = build_replay_ledger_remediation_report(ranking_report)
    candidates = _candidate_mappings(ranking_report.get("candidates"))
    best_candidate = candidates[0] if candidates else None
    inferred_family, inferred_strategy = _infer_runtime_harness(frontier)
    target_strategy_family = _text(strategy_family) or inferred_family
    target_strategy_name = _text(strategy_name) or inferred_strategy
    target_dataset_snapshot_ref = _text(
        dataset_snapshot_ref
    ) or _infer_dataset_snapshot_ref(frontier)
    runtime_plan = _build_runtime_window_import_plan(
        best_candidate=best_candidate,
        remediation_report=remediation_report,
        ranking_policy=policy.to_payload(),
        hypothesis_id=_text(hypothesis_id) or "",
        source_manifest_ref=_text(source_manifest_ref) or "",
        run_id=_text(run_id) or "",
        strategy_family=target_strategy_family,
        strategy_name=target_strategy_name,
        account_label=_text(account_label) or "TORGHUT_REPLAY",
        observed_stage=_text(observed_stage) or "paper",
        source_kind=_text(source_kind) or "simulation_exact_replay_runtime_ledger",
        dataset_snapshot_ref=target_dataset_snapshot_ref,
    )
    candidate_board = {
        "schema_version": CANDIDATE_BOARD_SCHEMA_VERSION,
        "current_answer": "no_promotion_ready_candidate",
        "promotion_allowed": False,
        "best_research_candidate": None,
        "best_exact_replay_ledger_candidate": dict(best_candidate)
        if best_candidate is not None
        else None,
        "exact_replay_ledger_remediation": remediation_report,
        "runtime_window_import_plan": runtime_plan,
    }
    return {
        "schema_version": REPLAY_RUNTIME_WINDOW_HANDOFF_SCHEMA_VERSION,
        "promotion_allowed": False,
        "source": "exact_replay_ledger_runtime_window_handoff",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hypothesis_id": _text(hypothesis_id) or "",
        "source_manifest_ref": _text(source_manifest_ref) or "",
        "ranking": ranking_report,
        "exact_replay_ledger_remediation": remediation_report,
        "best_exact_replay_ledger_candidate": dict(best_candidate)
        if best_candidate is not None
        else None,
        "runtime_window_import_plan": runtime_plan,
        "candidate_board": candidate_board,
    }


def _build_runtime_window_import_plan(
    *,
    best_candidate: Mapping[str, Any] | None,
    remediation_report: Mapping[str, Any],
    ranking_policy: Mapping[str, Any],
    hypothesis_id: str,
    source_manifest_ref: str,
    run_id: str,
    strategy_family: str,
    strategy_name: str,
    account_label: str,
    observed_stage: str,
    source_kind: str,
    dataset_snapshot_ref: str,
) -> dict[str, Any]:
    promotion_blockers = _string_list(remediation_report.get("promotion_blockers"))
    runtime_ledger_blockers = _string_list(
        remediation_report.get("runtime_ledger_blockers")
    )
    artifact_ref = (
        _text(best_candidate.get("artifact_ref")) if best_candidate is not None else ""
    )
    candidate_id = (
        _text(best_candidate.get("candidate_id")) if best_candidate is not None else ""
    )
    metadata_blockers = _target_metadata_blockers(
        promotion_blockers=promotion_blockers,
        runtime_ledger_blockers=runtime_ledger_blockers,
    )
    blockers = _plan_blockers(
        best_candidate=best_candidate,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        source_manifest_ref=source_manifest_ref,
        strategy_family=strategy_family,
        strategy_name=strategy_name,
        artifact_ref=artifact_ref,
        promotion_blockers=promotion_blockers,
        runtime_ledger_blockers=runtime_ledger_blockers,
    )
    targets: list[dict[str, Any]] = []
    if best_candidate is not None and not any(
        item["blocker"] != "exact_replay_search_blockers_remaining" for item in blockers
    ):
        search_blockers = _search_blockers(
            promotion_blockers=promotion_blockers,
            runtime_ledger_blockers=runtime_ledger_blockers,
        )
        probation_allowed = not search_blockers
        artifact_counts = _exact_replay_ledger_artifact_counts(artifact_ref)
        replay_window_metadata = _target_replay_window_metadata(
            best_candidate=best_candidate,
            ranking_policy=ranking_policy,
        )
        window_start = _text(best_candidate.get("window_start"))
        window_end = _text(best_candidate.get("window_end"))
        target: dict[str, Any] = {
            "run_id": run_id or f"replay-runtime-window-{candidate_id}",
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_id,
            "observed_stage": observed_stage,
            "strategy_family": strategy_family,
            "strategy_name": strategy_name,
            "account_label": account_label,
            "source_kind": source_kind,
            "source_manifest_ref": source_manifest_ref,
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "artifact_refs": [artifact_ref],
            "exact_replay_ledger_artifact_refs": [artifact_ref],
            "exact_replay_ledger_artifact_ref": artifact_ref,
            "window_start": window_start,
            "window_end": window_end,
            **replay_window_metadata,
            "candidate_selection": "exact_replay_ledger_best_candidate",
            "selected_by": "replay_runtime_window_handoff_ranking",
            "selection_reason": _text(remediation_report.get("status")),
            "paper_probation_authorized": probation_allowed,
            "paper_probation_authorization_scope": "evidence_collection_only",
            "evidence_collection_stage": "paper",
            "probation_allowed": probation_allowed,
            "probation_reason": "exact_replay_policy_checks_passed"
            if probation_allowed
            else "exact_replay_search_blockers_remaining",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "final_promotion_blockers": metadata_blockers,
            "runtime_ledger_target_metadata_blockers": metadata_blockers,
            "handoff": "runtime_window_import_from_exact_replay_ledger",
            "promotion_gate": "runtime_ledger_live_or_live_paper_required",
        }
        if artifact_counts["row_count"] is not None:
            target["exact_replay_ledger_artifact_row_count"] = artifact_counts[
                "row_count"
            ]
        if artifact_counts["fill_count"] is not None:
            target["exact_replay_ledger_artifact_fill_count"] = artifact_counts[
                "fill_count"
            ]
        targets.append(target)
    return {
        "schema_version": RUNTIME_WINDOW_IMPORT_PLAN_SCHEMA_VERSION,
        "source": "exact_replay_ledger_runtime_window_handoff",
        "purpose": (
            "handoff exact replay-ledger winners into bounded paper/runtime-window "
            "evidence collection without authorizing final promotion"
        ),
        "promotion_allowed": False,
        "targets": targets,
        "blockers": blockers,
    }


def _plan_blockers(
    *,
    best_candidate: Mapping[str, Any] | None,
    candidate_id: str,
    hypothesis_id: str,
    source_manifest_ref: str,
    strategy_family: str,
    strategy_name: str,
    artifact_ref: str,
    promotion_blockers: Sequence[str],
    runtime_ledger_blockers: Sequence[str],
) -> list[dict[str, Any]]:
    blockers: list[dict[str, Any]] = []
    if best_candidate is None:
        blockers.append(
            {
                "blocker": "exact_replay_ledger_candidate_missing",
                "remediation": "produce_exact_replay_ledger_artifacts",
            }
        )
        return blockers
    missing_metadata = [
        name
        for name, value in (
            ("hypothesis_id", hypothesis_id),
            ("source_manifest_ref", source_manifest_ref),
            ("strategy_family", strategy_family),
            ("strategy_name", strategy_name),
        )
        if not value
    ]
    if missing_metadata:
        blockers.append(
            {
                "blocker": "runtime_window_plan_metadata_missing",
                "candidate_id": candidate_id,
                "missing_fields": missing_metadata,
                "remediation": "provide_hypothesis_manifest_and_runtime_harness",
            }
        )
    if not artifact_ref:
        blockers.append(
            {
                "blocker": "exact_replay_ledger_artifact_ref_missing",
                "candidate_id": candidate_id,
                "remediation": "enable_exact_replay_ledger_artifact_output",
            }
        )
    search_blockers = _search_blockers(
        promotion_blockers=promotion_blockers,
        runtime_ledger_blockers=runtime_ledger_blockers,
    )
    if search_blockers:
        blockers.append(
            {
                "blocker": "exact_replay_search_blockers_remaining",
                "candidate_id": candidate_id,
                "blocking_reasons": search_blockers,
                "remediation": (
                    "keep search remediation active; runtime-window target is "
                    "evidence collection only and cannot authorize promotion"
                ),
            }
        )
    return blockers


def _target_metadata_blockers(
    *,
    promotion_blockers: Sequence[str],
    runtime_ledger_blockers: Sequence[str],
) -> list[str]:
    return _dedupe(
        [
            *promotion_blockers,
            *runtime_ledger_blockers,
            "paper_probation_evidence_collection_only",
        ]
    )


def _target_replay_window_metadata(
    *,
    best_candidate: Mapping[str, Any],
    ranking_policy: Mapping[str, Any],
) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for source_key, target_key in (
        ("window_weekday_count", "replay_window_weekday_count"),
        ("active_day_count", "replay_active_day_count"),
        ("positive_day_count", "replay_positive_day_count"),
        ("negative_day_count", "replay_negative_day_count"),
        ("window_net_pnl_per_day", "replay_window_net_pnl_per_day"),
        ("active_net_pnl_per_day", "replay_active_net_pnl_per_day"),
        ("total_net_pnl_after_costs", "replay_total_net_pnl_after_costs"),
        (
            "avg_filled_notional_per_window_weekday",
            "replay_avg_filled_notional_per_window_weekday",
        ),
        ("best_day_share", "replay_best_day_share"),
        ("candidate_identity_hash", "replay_candidate_identity_hash"),
        ("cost_lineage_hash", "replay_cost_lineage_hash"),
        ("fills_with_adv_notional", "replay_fills_with_adv_notional"),
        ("fills_with_participation_rate", "replay_fills_with_participation_rate"),
        (
            "fills_with_capacity_warning_contract",
            "replay_fills_with_capacity_warning_contract",
        ),
    ):
        if (value := best_candidate.get(source_key)) is not None:
            metadata[target_key] = value
    for source_key, target_key in (
        ("candidate_identity", "replay_candidate_identity"),
        ("cost_lineage", "replay_cost_lineage"),
        ("capacity_warning_counts", "replay_capacity_warning_counts"),
    ):
        if isinstance(value := best_candidate.get(source_key), Mapping):
            metadata[target_key] = dict(cast(Mapping[str, Any], value))
    for source_key, target_key in (
        ("min_window_weekday_count", "replay_min_window_weekday_count"),
        ("target_net_pnl_per_day", "replay_target_net_pnl_per_day"),
        (
            "min_avg_filled_notional_per_day",
            "replay_min_avg_filled_notional_per_day",
        ),
        ("max_best_day_share", "replay_max_best_day_share"),
        ("max_gross_exposure_pct_equity", "replay_max_gross_exposure_pct_equity"),
        ("start_equity", "replay_start_equity"),
    ):
        if (value := ranking_policy.get(source_key)) is not None:
            metadata[target_key] = value
    return metadata


def _search_blockers(
    *,
    promotion_blockers: Sequence[str],
    runtime_ledger_blockers: Sequence[str],
) -> list[str]:
    return [
        blocker
        for blocker in _dedupe([*promotion_blockers, *runtime_ledger_blockers])
        if blocker != "replay_artifact_only_not_live"
    ]


def _infer_runtime_harness(frontier: Mapping[str, Any]) -> tuple[str, str]:
    family_template = _mapping(frontier.get("family_template"))
    runtime_harness = _mapping(family_template.get("runtime_harness"))
    return (
        _text(runtime_harness.get("family")) or _text(frontier.get("family")),
        _text(runtime_harness.get("strategy_name"))
        or _text(frontier.get("strategy_name")),
    )


def _infer_dataset_snapshot_ref(frontier: Mapping[str, Any]) -> str:
    receipt = _mapping(frontier.get("dataset_snapshot_receipt"))
    replay_tape = _mapping(frontier.get("replay_tape"))
    return (
        _text(receipt.get("snapshot_id"))
        or _text(replay_tape.get("dataset_snapshot_ref"))
        or ""
    )


def _exact_replay_ledger_artifact_counts(artifact_ref: str) -> dict[str, int | None]:
    payload = _load_json_mapping(artifact_ref)
    rows = _runtime_ledger_rows(payload)
    row_count = _int_or_none(payload.get("row_count")) or (len(rows) if rows else None)
    fill_count = (
        _int_or_none(payload.get("fill_row_count"))
        or _int_or_none(payload.get("filled_row_count"))
        or (
            sum(
                1
                for row in rows
                if _event_type(row)
                in {"fill", "filled", "partial_fill", "partially_filled"}
            )
            if rows
            else None
        )
    )
    return {"row_count": row_count, "fill_count": fill_count}


def _runtime_ledger_rows(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    for key in ("runtime_ledger_rows", "ledger_rows", "rows", "events"):
        rows = payload.get(key)
        if isinstance(rows, Sequence) and not isinstance(rows, (str, bytes, bytearray)):
            row_items = cast(Sequence[Any], rows)
            return [
                cast(Mapping[str, Any], row)
                for row in row_items
                if isinstance(row, Mapping)
            ]
    return []


def _event_type(row: Mapping[str, Any]) -> str:
    return str(
        row.get("event_type") or row.get("runtime_ledger_event_type") or ""
    ).lower()


def _load_json_mapping(path_text: str) -> dict[str, Any]:
    if not path_text:
        return {}
    path = Path(path_text)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _mapping(payload)


def _candidate_mappings(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    items = cast(Sequence[Any], value)
    return [
        cast(Mapping[str, Any], item) for item in items if isinstance(item, Mapping)
    ]


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    items = cast(Sequence[Any], value)
    result: list[str] = []
    for item in items:
        text = _text(item)
        if text:
            result.append(text)
    return result


def _text(value: Any) -> str:
    text = str(value or "").strip()
    return text


def _int_or_none(value: Any) -> int | None:
    try:
        parsed = int(Decimal(str(value)))
    except Exception:
        return None
    return max(0, parsed)


def _dedupe(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = _text(value)
        if text and text not in result:
            result.append(text)
    return result
