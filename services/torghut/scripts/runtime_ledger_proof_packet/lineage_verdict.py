"""Lineage, status-gate, and verdict helpers for proof packet assembly."""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from typing import Any

from scripts.runtime_ledger_proof_packet.common import (
    CAPITAL_PROMOTION_STATUS_BLOCKER_PREFIXES,
    CAPITAL_PROMOTION_STATUS_BLOCKERS,
    RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER,
    _mapping,
    _sequence,
    _text,
    _text_list,
)
from scripts.runtime_ledger_proof_packet.hpairs import _extend_unique
from scripts.runtime_ledger_proof_packet.paper_route import (
    _runtime_window_import_items,
)


def _first_identity(
    *,
    paper_targets: Sequence[Mapping[str, Any]],
    runtime_import: Mapping[str, Any],
    completion_gate: Mapping[str, Any],
) -> dict[str, object]:
    candidates: list[Mapping[str, Any]] = []
    candidates.extend(paper_targets)
    candidates.extend(_runtime_window_import_items(runtime_import))
    if completion_gate:
        candidates.append(completion_gate)
    identity: dict[str, object] = {}
    for key in (
        "candidate_id",
        "hypothesis_id",
        "observed_stage",
        "strategy_family",
        "strategy_name",
        "account_label",
        "window_start",
        "window_end",
    ):
        for candidate in candidates:
            value = _text(candidate.get(key))
            if value:
                identity[key] = value
                break
    return identity


def _first_env_text(names: Sequence[str]) -> str:
    for name in names:
        value = _text(os.getenv(name))
        if value:
            return value
    return ""


def _normalize_image_digest(value: object) -> str:
    text = _text(value)
    marker = "sha256:"
    if marker not in text:
        return ""
    return text[text.index(marker) :]


def _commit_refs_match(left: str, right: str) -> bool:
    if not left or not right:
        return True
    return left == right or left.startswith(right) or right.startswith(left)


def _assembly_code_lineage() -> dict[str, Any]:
    code_commit = _first_env_text(
        (
            "TORGHUT_COMMIT",
            "TORGHUT_IMAGE_COMMIT",
            "GIT_COMMIT",
            "SOURCE_COMMIT",
            "CODE_COMMIT",
            "COMMIT_SHA",
        )
    )
    image_digest = _first_env_text(
        (
            "TORGHUT_IMAGE_DIGEST",
            "IMAGE_DIGEST",
            "CONTAINER_IMAGE_DIGEST",
            "K_REVISION_IMAGE_DIGEST",
        )
    )
    image = _first_env_text(("TORGHUT_IMAGE", "CONTAINER_IMAGE", "IMAGE"))
    return {
        "commit": code_commit,
        "image": image,
        "image_digest": image_digest,
        "commit_available": bool(code_commit),
        "image_digest_available": bool(image_digest),
    }


def _status_build_code_lineage(status: Mapping[str, Any]) -> dict[str, Any]:
    build = _mapping(status.get("build"))
    return {
        "version": _text(build.get("version")),
        "commit": _text(build.get("commit")),
        "image_digest": _text(build.get("image_digest")),
        "active_revision": _text(build.get("active_revision")),
        "commit_available": bool(_text(build.get("commit"))),
        "image_digest_available": bool(_text(build.get("image_digest"))),
    }


def _runtime_code_parity(status: Mapping[str, Any]) -> dict[str, Any]:
    status_code = _status_build_code_lineage(status)
    assembly_code = _assembly_code_lineage()
    status_digest = _normalize_image_digest(status_code.get("image_digest"))
    assembly_digest = _normalize_image_digest(assembly_code.get("image_digest"))
    status_commit = _text(status_code.get("commit"))
    assembly_commit = _text(assembly_code.get("commit"))
    blockers: list[str] = []
    if status_digest and assembly_digest and status_digest != assembly_digest:
        blockers.append("proof_packet_assembly_image_digest_mismatch")
    if (
        status_commit
        and assembly_commit
        and not _commit_refs_match(status_commit, assembly_commit)
    ):
        blockers.append("proof_packet_assembly_commit_mismatch")
    return {
        "schema_version": "torghut.runtime-ledger-proof-packet-code-parity.v1",
        "live_status_build": status_code,
        "assembly_runtime": assembly_code,
        "image_digest_parity_checked": bool(status_digest and assembly_digest),
        "commit_parity_checked": bool(status_commit and assembly_commit),
        "blockers": blockers,
    }


def _runtime_ledger_immutable_lineage(
    *,
    identity: Mapping[str, object],
    paper_targets: Sequence[Mapping[str, Any]],
    runtime_import: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
    ledger_refs: Sequence[str],
    unbacked_refs: Sequence[str],
    materialization_summary: Mapping[str, Any],
) -> dict[str, Any]:
    source_row_ids: list[str] = []
    source_refs: list[str] = []
    strategy_ledger_refs: list[str] = []
    bucket_ids: list[str] = []
    metric_window_ids: list[str] = []
    promotion_decision_ids: list[str] = []
    _extend_unique(strategy_ledger_refs, list(ledger_refs))

    def collect_from(source: Mapping[str, Any]) -> None:
        for key in (
            "trade_decision_id",
            "trade_decision_ids",
            "execution_id",
            "execution_ids",
            "execution_order_event_id",
            "execution_order_event_ids",
            "runtime_ledger_execution_order_event_id",
            "runtime_ledger_execution_order_event_ids",
            "execution_tca_metric_id",
            "execution_tca_metric_ids",
            "runtime_ledger_execution_tca_metric_id",
            "runtime_ledger_execution_tca_metric_ids",
            "source_window_id",
            "source_window_ids",
            "runtime_ledger_source_window_id",
            "runtime_ledger_source_window_ids",
            "source_row_id",
            "source_row_ids",
            "source_execution_row_ids",
            "runtime_ledger_source_row_ids",
            "runtime_ledger_source_execution_row_ids",
        ):
            _extend_unique(source_row_ids, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(source_row_ids, [text])
        for key in (
            "source_ref",
            "source_refs",
            "source_window_ref",
            "source_window_refs",
            "runtime_ledger_source_ref",
            "runtime_ledger_source_refs",
            "runtime_ledger_source_window_refs",
            "source_manifest_ref",
        ):
            _extend_unique(source_refs, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(source_refs, [text])
        for key in (
            "runtime_ledger_bucket_id",
            "runtime_ledger_bucket_ids",
            "evidence_grade_runtime_ledger_bucket_ids",
        ):
            _extend_unique(bucket_ids, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(bucket_ids, [text])
        for key in (
            "runtime_ledger_bucket_ref",
            "runtime_ledger_bucket_refs",
            "strategy_runtime_ledger_bucket_ref",
            "strategy_runtime_ledger_bucket_refs",
            "evidence_grade_runtime_ledger_bucket_ref",
            "evidence_grade_runtime_ledger_bucket_refs",
        ):
            _extend_unique(strategy_ledger_refs, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(strategy_ledger_refs, [text])
        for key in (
            "metric_window_id",
            "metric_window_ids",
            "metric_window_ref",
            "metric_window_refs",
        ):
            _extend_unique(metric_window_ids, _text_list(source.get(key)))
            if not _sequence(source.get(key)):
                text = _text(source.get(key))
                if text:
                    _extend_unique(metric_window_ids, [text])
        promotion_decision_id = _text(source.get("promotion_decision_id"))
        if promotion_decision_id:
            _extend_unique(promotion_decision_ids, [promotion_decision_id])
        _extend_unique(
            promotion_decision_ids,
            _text_list(source.get("promotion_decision_refs")),
        )

    for target in paper_targets:
        collect_from(target)
    for item in _runtime_window_import_items(runtime_import):
        collect_from(item)
        summary = _mapping(item.get("summary"))
        collect_from(summary)
        collect_from(_mapping(summary.get("runtime_observation")))
        collect_from(_mapping(summary.get("runtime_window_import_readback")))
        materialization_target = _mapping(summary.get("runtime_materialization_target"))
        collect_from(materialization_target)
        collect_from(_mapping(materialization_target.get("readback")))
    collect_from(runtime_summary)
    for key in ("materialized_targets", "unmaterialized_targets"):
        for target in _sequence(materialization_summary.get(key)):
            materialized_target = _mapping(target)
            collect_from(materialized_target)
            collect_from(_mapping(materialized_target.get("readback")))
            tigerbeetle = _mapping(materialized_target.get("tigerbeetle"))
            _extend_unique(source_refs, _text_list(tigerbeetle.get("source_refs")))
            for bucket_ref in _sequence(tigerbeetle.get("runtime_ledger_buckets")):
                collect_from(_mapping(bucket_ref))

    runtime_strategy = _text(
        identity.get("runtime_strategy_name") or identity.get("strategy_name")
    )
    code = _assembly_code_lineage()
    return {
        "schema_version": "torghut.runtime-ledger-proof-packet-lineage.v1",
        "hypothesis_id": _text(identity.get("hypothesis_id")),
        "candidate_id": _text(identity.get("candidate_id")),
        "runtime_strategy": runtime_strategy,
        "strategy_family": _text(identity.get("strategy_family")),
        "account_label": _text(identity.get("account_label")),
        "stage": _text(identity.get("observed_stage")),
        "window_start": _text(identity.get("window_start")),
        "window_end": _text(identity.get("window_end")),
        "source_row_ids": source_row_ids,
        "source_refs": source_refs,
        "strategy_runtime_ledger_bucket_refs": strategy_ledger_refs,
        "unbacked_metric_window_refs": list(unbacked_refs),
        "runtime_ledger_bucket_ids": bucket_ids,
        "metric_window_ids": metric_window_ids,
        "promotion_decision_ids": promotion_decision_ids,
        "counts": {
            "source_row_id_count": len(source_row_ids),
            "source_ref_count": len(source_refs),
            "strategy_runtime_ledger_bucket_ref_count": len(strategy_ledger_refs),
            "unbacked_metric_window_ref_count": len(unbacked_refs),
            "runtime_ledger_bucket_id_count": len(bucket_ids),
            "metric_window_id_count": len(metric_window_ids),
            "promotion_decision_id_count": len(promotion_decision_ids),
        },
        "code": code,
    }


def _status_blockers(status: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    gate = (
        _mapping(status.get("live_submission_gate"))
        or _mapping(status.get("live_gate"))
        or _mapping(status.get("submission_gate"))
    )
    if gate:
        _extend_unique(blockers, _text_list(gate.get("blocked_reasons")))
        _extend_unique(blockers, _text_list(gate.get("blocking_reasons")))
        if gate.get("allowed") is False:
            _extend_unique(
                blockers,
                [_text(gate.get("reason"), "live_submission_gate_not_allowed")],
            )
    proof_floor = _mapping(status.get("proof_floor"))
    _extend_unique(blockers, _text_list(proof_floor.get("blocking_reasons")))
    return blockers


def _is_capital_promotion_status_blocker(blocker: str) -> bool:
    if blocker in CAPITAL_PROMOTION_STATUS_BLOCKERS:
        return True
    return any(
        blocker.startswith(prefix)
        for prefix in CAPITAL_PROMOTION_STATUS_BLOCKER_PREFIXES
    )


def _status_gate_blocker_summary(status: Mapping[str, Any]) -> dict[str, list[str]]:
    raw_blockers = _status_blockers(status)
    capital_blockers = [
        blocker
        for blocker in raw_blockers
        if _is_capital_promotion_status_blocker(blocker)
    ]
    proof_blockers = [
        blocker for blocker in raw_blockers if blocker not in capital_blockers
    ]
    return {
        "raw_blockers": raw_blockers,
        "proof_blockers": proof_blockers,
        "capital_promotion_blockers": capital_blockers,
    }


def _required_actions(blockers: Sequence[str], *, verdict: str) -> list[str]:
    actions: list[str] = []
    if verdict == "waiting_for_runtime_window":
        for blocker in blockers:
            if blocker in {
                "paper_route_session_window_not_open",
                "paper_route_session_window_not_closed",
                "paper_route_import_not_ready",
            }:
                _extend_unique(actions, ["wait_for_regular_session_runtime_window"])
            elif blocker == "paper_route_session_settlement_pending":
                _extend_unique(actions, ["wait_for_paper_route_settlement_grace"])
        if actions:
            return actions
    for blocker in blockers:
        if blocker in {
            "paper_route_session_window_not_open",
            "paper_route_session_window_not_closed",
        }:
            _extend_unique(actions, ["wait_for_regular_session_runtime_window"])
        elif blocker == "paper_route_session_settlement_pending":
            _extend_unique(actions, ["wait_for_paper_route_settlement_grace"])
        elif blocker in {
            "runtime_window_import_missing",
            "runtime_window_import_runtime_ledger_materialization_missing",
            "runtime_ledger_bucket_missing",
            "paper_route_runtime_ledger_import_pending",
        }:
            _extend_unique(
                actions, ["run_runtime_window_import_from_paper_route_target_plan"]
            )
        elif blocker in {
            "runtime_ledger_net_pnl_below_target",
            "runtime_ledger_daily_net_pnl_below_target",
            "runtime_ledger_mean_daily_net_pnl_after_costs_below_floor",
            "runtime_ledger_median_daily_net_pnl_after_costs_below_floor",
            "runtime_ledger_p10_daily_net_pnl_after_costs_below_floor",
            "runtime_ledger_worst_day_net_pnl_after_costs_below_floor",
        }:
            _extend_unique(
                actions, ["collect_or_improve_post_cost_runtime_profit_evidence"]
            )
        elif blocker in {
            "runtime_ledger_drawdown_pct_equity_missing",
            "runtime_ledger_drawdown_pct_equity_above_limit",
            "runtime_ledger_best_day_share_missing",
            "runtime_ledger_best_day_share_above_limit",
            "runtime_ledger_symbol_concentration_share_missing",
            "runtime_ledger_symbol_concentration_share_above_limit",
            "runtime_ledger_max_intraday_drawdown_missing",
            "runtime_ledger_max_intraday_drawdown_above_limit",
        }:
            _extend_unique(
                actions,
                ["improve_runtime_ledger_drawdown_concentration_or_position_sizing"],
            )
        elif blocker == RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER:
            _extend_unique(actions, ["rerun_proof_packet_in_authority_mode"])
        elif blocker in {
            "proof_packet_assembly_image_digest_mismatch",
            "proof_packet_assembly_commit_mismatch",
        }:
            _extend_unique(
                actions, ["rerun_runtime_window_import_on_current_torghut_image"]
            )
        elif blocker.startswith("runtime_ledger_") or blocker in {
            "filled_notional_missing",
            "closed_round_trip_missing",
            "submitted_order_lifecycle_missing",
            "runtime_decision_lifecycle_missing",
        }:
            _extend_unique(
                actions, ["repair_runtime_ledger_lifecycle_cost_or_lineage_evidence"]
            )
        elif blocker in {
            "runtime_ledger_trading_days_below_target",
        }:
            _extend_unique(actions, ["collect_more_runtime_ledger_trading_days"])
        elif blocker in {
            "paper_route_source_activity_missing",
            "strategy_name_missing",
            "source_decisions_missing",
            "source_executions_missing",
            "source_tca_missing",
        } or blocker.startswith("source_"):
            _extend_unique(
                actions, ["inspect_paper_route_source_activity_before_import"]
            )
        elif blocker == "runtime_window_import_audit_missing":
            _extend_unique(actions, ["inspect_paper_route_evidence_audit"])
        elif blocker in {"simple_submit_disabled", "live_submission_gate_not_allowed"}:
            _extend_unique(
                actions, ["keep_promotion_blocked_until_live_gate_and_proof_floor_pass"]
            )
        elif blocker in {
            "runtime_window_import_health_gate_missing",
            "dependency_quorum_not_allow",
            "continuity_not_ok",
            "drift_not_ok",
            "drift_checks_not_ok",
        } or blocker.startswith("runtime_window_import_health_gate"):
            _extend_unique(actions, ["repair_runtime_window_import_health_gate"])
    if not actions and verdict != "promotion_authority_allowed":
        actions.append("inspect_packet_checks_and_repair_failed_proof_dimension")
    return actions


__all__ = (
    "_first_identity",
    "_first_env_text",
    "_normalize_image_digest",
    "_commit_refs_match",
    "_assembly_code_lineage",
    "_status_build_code_lineage",
    "_runtime_code_parity",
    "_runtime_ledger_immutable_lineage",
    "_status_blockers",
    "_is_capital_promotion_status_blocker",
    "_status_gate_blocker_summary",
    "_required_actions",
)
