"""Alpha-readiness settlement conveyor for zero-notional routeable reentry."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from .read_model_utils import (
    append_unique_text as _append_unique,
    as_int as _int,
    as_mapping as _mapping,
    as_sequence as _sequence,
    as_text as _text,
    first_mapping as _top_queue_item,
    is_alpha_readiness_repair as _is_alpha_repair,
    routeable_candidate_count as _routeable_candidate_count,
    stable_hash24 as _stable_hash,
    unique_text_list as _string_list,
    zero_notional_or_stale_evidence_rate as _zero_notional_or_stale_evidence_rate,
)

ALPHA_READINESS_SETTLEMENT_CONVEYOR_SCHEMA_VERSION = (
    "torghut.alpha-readiness-settlement-conveyor.v1"
)
ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION = (
    "torghut.alpha-readiness-settlement-conveyor-ref.v1"
)
ALPHA_READINESS_SETTLEMENT_RECEIPT_SCHEMA_VERSION = (
    "torghut.alpha-readiness-settlement-receipt.v1"
)

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md"
)
_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_ROLLBACK_TARGET = (
    "stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0"
)
_ZERO_NOTIONAL_VALUES = {"0", "0.0", "0.00", "0.0000"}
_H_MICRO = "H-MICRO-01"
_NO_DELTA_RELEASE_CONDITIONS = [
    "source_ref_changes",
    "evidence_window_changes",
    "blocker_set_changes",
    "required_receipt_changes",
]
_FEATURE_OR_DRIFT_BLOCKERS = {
    "drift_checks_missing",
    "feature_rows_missing",
    "required_feature_set_unavailable",
    "forecast_registry_degraded",
}
_POST_COST_BLOCKERS = {
    "post_cost_expectancy_non_positive",
    "post_cost_expectancy_missing",
}
_EMPIRICAL_BLOCKERS = {
    "empirical_jobs_degraded",
    "empirical_jobs_not_ready",
    "job_ineligible:benchmark_parity",
    "job_ineligible:foundation_router_parity",
    "job_ineligible:janus_event_car",
    "job_ineligible:janus_hgrm_reward",
    "job_stale:benchmark_parity",
    "job_stale:foundation_router_parity",
    "job_stale:janus_event_car",
    "job_stale:janus_hgrm_reward",
}
_SCHEMA_LINEAGE_BLOCKERS = {
    "schema_lineage_missing",
    "strategy_hypothesis_lineage_missing",
    "required_feature_set_unavailable",
}
_REJECTION_DRAG_BLOCKERS = {"rejection_drag_high", "rejection_drag_unmeasured"}


def _source_commit(
    source_serving_metadata: Mapping[str, Any],
    alpha_evidence_foundry: Mapping[str, Any],
) -> str:
    build = _mapping(source_serving_metadata.get("build"))
    source_serving = _mapping(
        source_serving_metadata.get("source_serving_repair_receipt_ledger")
    )
    route_packet = _mapping(
        source_serving_metadata.get("route_evidence_clearinghouse_packet")
    )
    return (
        _text(alpha_evidence_foundry.get("source_commit"))
        or _text(source_serving.get("source_commit"))
        or _text(route_packet.get("source_commit"))
        or _text(build.get("commit"))
        or "unknown"
    )


def _active_revision(
    source_serving_metadata: Mapping[str, Any],
    alpha_evidence_foundry: Mapping[str, Any],
) -> str:
    build = _mapping(source_serving_metadata.get("build"))
    source_serving = _mapping(
        source_serving_metadata.get("source_serving_repair_receipt_ledger")
    )
    route_packet = _mapping(
        source_serving_metadata.get("route_evidence_clearinghouse_packet")
    )
    return (
        _text(alpha_evidence_foundry.get("active_revision"))
        or _text(source_serving.get("active_revision"))
        or _text(route_packet.get("torghut_revision"))
        or _text(build.get("active_revision"))
        or "unknown"
    )


def _alpha_evidence_receipts(
    alpha_evidence_foundry: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    receipts: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for raw_receipt in _sequence(alpha_evidence_foundry.get("receipts")):
        receipt = _mapping(raw_receipt)
        if not receipt:
            continue
        receipt_key = _text(receipt.get("receipt_id")) or _text(
            receipt.get("hypothesis_id")
        )
        if receipt_key and receipt_key in seen:
            continue
        if receipt_key:
            seen.add(receipt_key)
        receipts.append(receipt)
    return receipts


def _reason_codes(receipt: Mapping[str, Any]) -> list[str]:
    return (
        _string_list(receipt.get("preserved_reason_codes"))
        or _string_list(receipt.get("before_reason_codes"))
        or _string_list(receipt.get("reason_codes"))
    )


def _required_receipts(
    top_item: Mapping[str, Any],
    receipt: Mapping[str, Any],
    closure_board: Mapping[str, Any],
) -> list[str]:
    required = _string_list(receipt.get("required_after_receipts"))
    market = _mapping(closure_board.get("alpha_closure_settlement_market"))
    required = _append_unique(
        required,
        market.get("required_after_receipts"),
        top_item.get("required_receipts"),
        top_item.get("required_output_receipt"),
        ALPHA_READINESS_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
    )
    return required


def _funded_receipts(
    required_receipts: Sequence[str],
    receipt: Mapping[str, Any],
) -> list[str]:
    after_refs = _string_list(receipt.get("after_refs"))
    funded: list[str] = []
    for required in required_receipts:
        required_prefix = required.split(":", 1)[0]
        if any(required == ref or required_prefix in ref for ref in after_refs):
            funded.append(required)
    return funded


def _missing_receipts(
    required_receipts: Sequence[str],
    funded_receipts: Sequence[str],
) -> list[str]:
    funded = set(funded_receipts)
    return [receipt for receipt in required_receipts if receipt not in funded]


def _blocker_digest(reason_codes: Sequence[str]) -> str:
    return _stable_hash(
        "alpha-readiness-blocker-digest", {"reason_codes": list(reason_codes)}
    )


def _required_receipt_digest(required_receipts: Sequence[str]) -> str:
    return _stable_hash(
        "alpha-readiness-required-receipt-digest",
        {"required_receipts": list(required_receipts)},
    )


def _no_delta_release_key(
    *,
    account_id: str,
    window: str,
    source_commit: str,
    source_revenue_repair_ref: str,
    receipt: Mapping[str, Any],
    reason_codes: Sequence[str],
    required_receipts: Sequence[str],
) -> str:
    return _stable_hash(
        "alpha-readiness-no-delta-release-key",
        {
            "account_id": account_id,
            "window": window,
            "source_commit": source_commit,
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "hypothesis_id": _text(receipt.get("hypothesis_id")),
            "repair_class": _text(receipt.get("repair_class"), "alpha_readiness"),
            "blocker_digest": _blocker_digest(reason_codes),
            "required_receipt_digest": _required_receipt_digest(required_receipts),
        },
    )


def _score_lane(
    receipt: Mapping[str, Any],
    *,
    reason_codes: Sequence[str],
    no_delta_active: bool,
) -> int:
    reason_set = set(reason_codes)
    score = 10
    if _text(receipt.get("hypothesis_id")) == _H_MICRO:
        score += 80
    if reason_set.intersection(_FEATURE_OR_DRIFT_BLOCKERS):
        score += 25
    if reason_set.intersection(_POST_COST_BLOCKERS):
        score -= 30
    if reason_set.intersection(_SCHEMA_LINEAGE_BLOCKERS):
        score -= 5
    if no_delta_active:
        score -= 10
    if _text(receipt.get("max_notional"), "0") not in _ZERO_NOTIONAL_VALUES:
        score -= 100
    return score


def _state_from_reasons(
    reason_codes: set[str], blockers: set[str], missing: str
) -> str:
    if reason_codes.intersection(blockers):
        return missing
    return "current"


def _evidence_window_state(receipt: Mapping[str, Any]) -> str:
    if _text(receipt.get("no_delta_reason")):
        return "no_delta"
    if _text(receipt.get("ladder_state")):
        return _text(receipt.get("ladder_state"))
    return _text(receipt.get("evidence_window_status"), "current")


def _lane_scores(
    *,
    receipts: Sequence[Mapping[str, Any]],
    top_item: Mapping[str, Any],
    closure_board: Mapping[str, Any],
    source_commit: str,
    source_revenue_repair_ref: str,
    account_id: str,
    window: str,
) -> list[dict[str, object]]:
    lanes: list[dict[str, object]] = []
    for receipt in receipts:
        reason_codes = _reason_codes(receipt)
        required_receipts = _required_receipts(top_item, receipt, closure_board)
        measured_delta = _int(receipt.get("measured_routeable_candidate_delta"))
        no_delta_active = measured_delta <= 0
        release_key = _no_delta_release_key(
            account_id=account_id,
            window=window,
            source_commit=source_commit,
            source_revenue_repair_ref=source_revenue_repair_ref,
            receipt=receipt,
            reason_codes=reason_codes,
            required_receipts=required_receipts,
        )
        score = _score_lane(
            receipt,
            reason_codes=reason_codes,
            no_delta_active=no_delta_active,
        )
        lanes.append(
            {
                "hypothesis_id": _text(receipt.get("hypothesis_id")),
                "candidate_id": _text(receipt.get("candidate_id")) or None,
                "strategy_id": _text(receipt.get("strategy_id")) or None,
                "lane_id": _text(receipt.get("lane_id")) or None,
                "strategy_family": _text(receipt.get("strategy_family")) or None,
                "lane_score": score,
                "score_reason_codes": [
                    "lineage_ready_feature_replay"
                    if _text(receipt.get("hypothesis_id")) == _H_MICRO
                    else "alpha_readiness_candidate",
                    "active_no_delta_lease" if no_delta_active else "positive_delta",
                ],
                "before_reason_codes": reason_codes,
                "required_receipts": required_receipts,
                "no_delta_release_key": release_key,
                "repeat_launch_decision": "deny" if no_delta_active else "allow",
                "measured_routeable_candidate_delta": measured_delta,
                "max_notional": _text(receipt.get("max_notional"), "0"),
            }
        )
    return sorted(
        lanes,
        key=lambda lane: (
            -_int(lane.get("lane_score")),
            _text(lane.get("hypothesis_id")),
        ),
    )


def _build_no_delta_leases(
    *,
    receipts: Sequence[Mapping[str, Any]],
    lane_scores: Sequence[Mapping[str, Any]],
) -> list[dict[str, object]]:
    scores_by_hypothesis = {
        _text(score.get("hypothesis_id")): score for score in lane_scores
    }
    leases: list[dict[str, object]] = []
    for receipt in receipts:
        if _int(receipt.get("measured_routeable_candidate_delta")) > 0:
            continue
        hypothesis_id = _text(receipt.get("hypothesis_id"))
        lane_score = _mapping(scores_by_hypothesis.get(hypothesis_id))
        release_key = _text(lane_score.get("no_delta_release_key"))
        lease_id = "alpha-readiness-no-delta-lease:" + _stable_hash(
            "alpha-readiness-no-delta-lease",
            {
                "receipt_id": _text(receipt.get("receipt_id")),
                "hypothesis_id": hypothesis_id,
                "release_key": release_key,
            },
        )
        leases.append(
            {
                "lease_id": lease_id,
                "source_receipt_id": receipt.get("receipt_id"),
                "hypothesis_id": hypothesis_id,
                "candidate_id": receipt.get("candidate_id"),
                "strategy_id": receipt.get("strategy_id"),
                "lane_id": receipt.get("lane_id"),
                "value_gate": receipt.get("target_value_gate"),
                "preserved_reason_codes": _reason_codes(receipt),
                "measured_routeable_candidate_delta": receipt.get(
                    "measured_routeable_candidate_delta"
                ),
                "no_delta_reason": receipt.get("no_delta_reason"),
                "no_delta_release_key": release_key,
                "release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
                "repeat_launch_decision": "deny",
                "max_notional": _text(receipt.get("max_notional"), "0"),
            }
        )
    return leases


def _receipt_for_selected_lane(
    receipts: Sequence[Mapping[str, Any]],
    selected_lane: Mapping[str, Any],
) -> Mapping[str, Any]:
    selected_hypothesis = _text(selected_lane.get("hypothesis_id"))
    for receipt in receipts:
        if _text(receipt.get("hypothesis_id")) == selected_hypothesis:
            return receipt
    return {}


def _settlement_state(
    *,
    status: str,
    selected_receipt: Mapping[str, Any],
    measured_delta: int,
    routeable_before: int,
) -> str:
    if status in {"observing", "blocked", "quarantined"}:
        return status
    if not selected_receipt:
        return "blocked"
    if measured_delta > 0:
        return "paid"
    if routeable_before > 0 and measured_delta == 0:
        return "blocked"
    return "no_delta"


def _build_settlement_receipt(
    *,
    conveyor_id: str,
    selected_lane: Mapping[str, Any],
    selected_receipt: Mapping[str, Any],
    status: str,
    routeable_before: int,
) -> dict[str, object] | None:
    if not selected_lane or not selected_receipt:
        return None
    reason_codes = _reason_codes(selected_receipt)
    reason_set = set(reason_codes)
    required_receipts = _string_list(selected_lane.get("required_receipts"))
    funded_receipts = _append_unique(
        _funded_receipts(required_receipts, selected_receipt),
        ALPHA_READINESS_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
    )
    missing_receipts = _missing_receipts(
        required_receipts,
        funded_receipts,
    )
    measured_delta = _int(selected_lane.get("measured_routeable_candidate_delta"))
    routeable_after = max(0, routeable_before + measured_delta)
    settlement_state = _settlement_state(
        status=status,
        selected_receipt=selected_receipt,
        measured_delta=measured_delta,
        routeable_before=routeable_before,
    )
    receipt_id = "alpha-readiness-settlement-receipt:" + _stable_hash(
        "alpha-readiness-settlement-receipt",
        {
            "conveyor_id": conveyor_id,
            "hypothesis_id": _text(selected_lane.get("hypothesis_id")),
            "release_key": _text(selected_lane.get("no_delta_release_key")),
            "settlement_state": settlement_state,
        },
    )
    return {
        "schema_version": ALPHA_READINESS_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "conveyor_id": conveyor_id,
        "hypothesis_id": selected_lane.get("hypothesis_id"),
        "candidate_id": selected_lane.get("candidate_id"),
        "strategy_id": selected_lane.get("strategy_id"),
        "lane_id": selected_lane.get("lane_id"),
        "strategy_family": selected_lane.get("strategy_family"),
        "settlement_state": settlement_state,
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "measured_routeable_candidate_delta": measured_delta,
        "retired_reason_codes": _string_list(
            selected_receipt.get("retired_reason_codes")
        ),
        "preserved_reason_codes": reason_codes,
        "new_reason_codes": _string_list(selected_receipt.get("new_reason_codes")),
        "funded_receipts": funded_receipts,
        "missing_receipts": missing_receipts,
        "evidence_window_id": selected_receipt.get("receipt_id"),
        "evidence_window_state": _evidence_window_state(selected_receipt),
        "schema_lineage_state": _state_from_reasons(
            reason_set,
            _SCHEMA_LINEAGE_BLOCKERS,
            "missing",
        ),
        "empirical_jobs_state": _state_from_reasons(
            reason_set,
            _EMPIRICAL_BLOCKERS,
            "stale",
        ),
        "post_cost_expectancy_state": _state_from_reasons(
            reason_set,
            _POST_COST_BLOCKERS,
            "blocked",
        ),
        "drift_state": _state_from_reasons(
            reason_set,
            _FEATURE_OR_DRIFT_BLOCKERS,
            "missing",
        ),
        "rejection_drag_state": _state_from_reasons(
            reason_set,
            _REJECTION_DRAG_BLOCKERS,
            "measured_high",
        ),
        "no_delta_release_key": selected_lane.get("no_delta_release_key"),
        "no_delta_release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
        "repeat_launch_decision": selected_lane.get("repeat_launch_decision"),
        "max_notional": selected_lane.get("max_notional"),
    }


def _account_window_mode(
    *,
    selected_receipt: Mapping[str, Any],
    alpha_evidence_foundry: Mapping[str, Any],
    closure_board: Mapping[str, Any],
    evidence: Mapping[str, Any],
) -> tuple[str, str, str]:
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    account = (
        _text(selected_receipt.get("account_id"))
        or _text(closure_board.get("account_id"))
        or _text(repair_bid_settlement.get("account_id"))
        or "unknown"
    )
    window = (
        _text(selected_receipt.get("window"))
        or _text(closure_board.get("window"))
        or _text(repair_bid_settlement.get("session_id"))
        or "unknown"
    )
    trading_mode = (
        _text(selected_receipt.get("trading_mode"))
        or _text(closure_board.get("trading_mode"))
        or _text(repair_bid_settlement.get("trading_mode"))
        or _text(alpha_evidence_foundry.get("trading_mode"))
        or "unknown"
    )
    return account, window, trading_mode


def build_alpha_readiness_settlement_conveyor(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    capital: Mapping[str, Any],
    evidence: Mapping[str, Any],
    alpha_evidence_foundry: Mapping[str, Any],
    alpha_repair_closure_board: Mapping[str, Any],
    source_serving_metadata: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Build the bounded alpha-readiness settlement lane from current evidence."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    source_metadata = source_serving_metadata or {}
    top_item = _top_queue_item(repair_queue)
    routeable_before = _routeable_candidate_count(evidence)
    max_notional = _text(capital.get("max_notional"), "0")
    source_commit = _source_commit(source_metadata, alpha_evidence_foundry)
    active_revision = _active_revision(source_metadata, alpha_evidence_foundry)
    source_revenue_repair_ref = _text(
        alpha_evidence_foundry.get("source_revenue_repair_ref"),
        "torghut-revenue-repair-digest:unknown",
    )
    receipts = _alpha_evidence_receipts(alpha_evidence_foundry)
    empty_receipt: Mapping[str, Any] = {}
    selected_for_account: Mapping[str, Any] = receipts[0] if receipts else empty_receipt
    account_id, window, trading_mode = _account_window_mode(
        selected_receipt=selected_for_account,
        alpha_evidence_foundry=alpha_evidence_foundry,
        closure_board=alpha_repair_closure_board,
        evidence=evidence,
    )

    reason_codes: list[str] = []
    if revenue_ready:
        reason_codes.append("revenue_already_ready")
    if business_state != "repair_only":
        reason_codes.append(f"business_state_{business_state or 'unknown'}")
    if not _is_alpha_repair(top_item):
        reason_codes.append("revenue_repair_top_item_not_alpha_readiness")
    if max_notional not in _ZERO_NOTIONAL_VALUES:
        reason_codes.append("capital_notional_nonzero")
    if not alpha_evidence_foundry:
        reason_codes.append("alpha_evidence_foundry_missing")
    if alpha_evidence_foundry and _text(alpha_evidence_foundry.get("status")) not in {
        "selected",
        "held",
    }:
        reason_codes.append(
            "alpha_evidence_foundry_"
            + _text(alpha_evidence_foundry.get("status"), "unknown")
        )
    if _is_alpha_repair(top_item) and not receipts:
        reason_codes.append("alpha_readiness_settlement_receipts_missing")

    lanes = _lane_scores(
        receipts=receipts,
        top_item=top_item,
        closure_board=alpha_repair_closure_board,
        source_commit=source_commit,
        source_revenue_repair_ref=source_revenue_repair_ref,
        account_id=account_id,
        window=window,
    )
    selected_lane = lanes[0] if lanes else {}
    selected_receipt = _receipt_for_selected_lane(receipts, selected_lane)
    active_no_delta_leases = _build_no_delta_leases(
        receipts=receipts,
        lane_scores=lanes,
    )
    if selected_lane and _text(selected_lane.get("repeat_launch_decision")) == "deny":
        reason_codes.append("active_no_delta_lease")

    status = "selecting"
    if "revenue_repair_top_item_not_alpha_readiness" in reason_codes:
        status = "observing"
    elif "capital_notional_nonzero" in reason_codes:
        status = "quarantined"
    elif not selected_lane:
        status = "blocked"
    elif _text(selected_lane.get("repeat_launch_decision")) == "deny":
        status = "no_delta"
    else:
        status = "settling"

    conveyor_id = "alpha-readiness-settlement-conveyor:" + _stable_hash(
        "alpha-readiness-settlement-conveyor",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "source_commit": source_commit,
            "selected_hypothesis_id": _text(selected_lane.get("hypothesis_id")),
            "release_key": _text(selected_lane.get("no_delta_release_key")),
        },
    )
    settlement_receipt = _build_settlement_receipt(
        conveyor_id=conveyor_id,
        selected_lane=selected_lane,
        selected_receipt=selected_receipt,
        status=status,
        routeable_before=routeable_before,
    )
    settlement = _mapping(settlement_receipt)
    routeable_after = _int(
        settlement.get("routeable_candidate_count_after"),
        routeable_before,
    )
    measured_delta = _int(
        settlement.get("measured_routeable_candidate_delta"),
        0,
    )
    required_receipts = _string_list(selected_lane.get("required_receipts"))
    validation_commands = _string_list(selected_receipt.get("validation_commands"))
    validation_commands = _append_unique(
        validation_commands,
        "uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py",
    )

    return {
        "schema_version": ALPHA_READINESS_SETTLEMENT_CONVEYOR_SCHEMA_VERSION,
        "conveyor_id": conveyor_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _DESIGN_REF,
        "status": status,
        "settlement_state": settlement.get("settlement_state", status),
        "reason_codes": reason_codes,
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "source_alpha_evidence_foundry_ref": alpha_evidence_foundry.get("foundry_id"),
        "source_alpha_repair_closure_board_ref": alpha_repair_closure_board.get(
            "board_id"
        ),
        "source_commit": source_commit,
        "active_revision": active_revision,
        "account_id": account_id,
        "window": window,
        "trading_mode": trading_mode,
        "business_state": business_state,
        "revenue_ready": revenue_ready,
        "selected_queue_code": _text(top_item.get("code")),
        "selected_value_gate": _text(
            top_item.get("value_gate"), "routeable_candidate_count"
        ),
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "accepted_routeable_candidate_count": _int(
            _mapping(evidence.get("routeability_acceptance")).get(
                "accepted_routeable_candidate_count"
            )
        ),
        "measured_routeable_candidate_delta": measured_delta,
        "zero_notional_or_stale_evidence_rate": _zero_notional_or_stale_evidence_rate(
            evidence
        ),
        "routeability_acceptance_ref": _mapping(
            evidence.get("routeability_acceptance")
        ).get("ledger_id"),
        "capital_state": _text(capital.get("capital_state"), "zero_notional"),
        "capital_rule": _text(
            top_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "max_notional": max_notional,
        "selected_lane": selected_lane,
        "lane_scores": lanes,
        "active_no_delta_leases": active_no_delta_leases,
        "required_receipts": required_receipts,
        "required_output_receipt": ALPHA_READINESS_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
        "settlement_receipt": settlement_receipt,
        "validation_commands": validation_commands,
        "rollback_target": _ROLLBACK_TARGET,
    }


def compact_alpha_readiness_settlement_conveyor(
    conveyor: Mapping[str, Any] | None,
) -> dict[str, object]:
    """Return the compact Jangar-facing alpha-readiness settlement ref."""

    payload = _mapping(conveyor)
    if not payload:
        return {
            "schema_version": ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION,
            "status": "missing",
            "reason_codes": ["alpha_readiness_settlement_conveyor_missing"],
        }
    selected_lane = _mapping(payload.get("selected_lane"))
    settlement_receipt = _mapping(payload.get("settlement_receipt"))
    validation_commands = _string_list(payload.get("validation_commands"))
    return {
        "schema_version": ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION,
        "conveyor_schema_version": payload.get("schema_version"),
        "conveyor_id": payload.get("conveyor_id"),
        "generated_at": payload.get("generated_at"),
        "fresh_until": payload.get("fresh_until"),
        "status": payload.get("status"),
        "settlement_state": payload.get("settlement_state"),
        "reason_codes": _string_list(payload.get("reason_codes")),
        "selected_hypothesis_id": selected_lane.get("hypothesis_id"),
        "selected_value_gate": payload.get("selected_value_gate"),
        "routeable_candidate_count_before": payload.get(
            "routeable_candidate_count_before"
        ),
        "routeable_candidate_count_after": payload.get(
            "routeable_candidate_count_after"
        ),
        "measured_routeable_candidate_delta": payload.get(
            "measured_routeable_candidate_delta"
        ),
        "active_no_delta_lease_count": len(
            _sequence(payload.get("active_no_delta_leases"))
        ),
        "required_receipt": payload.get("required_output_receipt"),
        "validation_command": validation_commands[0] if validation_commands else None,
        "no_delta_release_key": selected_lane.get("no_delta_release_key")
        or settlement_receipt.get("no_delta_release_key"),
        "repeat_launch_decision": selected_lane.get("repeat_launch_decision")
        or settlement_receipt.get("repeat_launch_decision"),
        "max_notional": payload.get("max_notional"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


__all__ = [
    "ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION",
    "ALPHA_READINESS_SETTLEMENT_CONVEYOR_SCHEMA_VERSION",
    "ALPHA_READINESS_SETTLEMENT_RECEIPT_SCHEMA_VERSION",
    "build_alpha_readiness_settlement_conveyor",
    "compact_alpha_readiness_settlement_conveyor",
]
