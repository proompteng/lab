"""Alpha repair dividend accounting for routeable-candidate evidence."""

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
    parse_datetime_utc as _parse_datetime,
    routeable_candidate_count as _routeable_candidate_count,
    stable_hash24 as _stable_hash,
    unique_text_list as _string_list,
)

ALPHA_REPAIR_DIVIDEND_LEDGER_SCHEMA_VERSION = "torghut.alpha-repair-dividend-ledger.v1"
ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION = (
    "torghut.alpha-repair-dividend-ledger-ref.v1"
)

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md"
)
_COMPANION_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md"
)
_RECORDER_SCHEMA = "torghut.alpha-repair-dividend-ledger.v1"
_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_ZERO_NOTIONAL_VALUES = {"0", "0.0", "0.00", "0.0000"}
_ROLLBACK_TARGET = (
    "stop emitting alpha_repair_dividend_ledger, keep revenue-repair diagnostics, "
    "and keep Torghut max_notional=0"
)
_NO_DELTA_RELEASE_CONDITIONS = [
    "source_ref_changes",
    "evidence_window_changes",
    "blocker_set_changes",
    "required_receipt_changes",
]


def _source_revenue_repair_ref(
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
    alpha_evidence_foundry: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> str:
    return (
        _text(alpha_readiness_settlement_conveyor.get("source_revenue_repair_ref"))
        or _text(alpha_evidence_foundry.get("source_revenue_repair_ref"))
        or _text(executable_alpha_repair_receipts.get("source_revenue_repair_ref"))
        or "torghut-revenue-repair-digest:unknown"
    )


def _receipt_ids(payload: Mapping[str, Any], field_name: str) -> list[str]:
    ids: list[str] = []
    for raw_receipt in _sequence(payload.get(field_name)):
        receipt = _mapping(raw_receipt)
        receipt_id = _text(receipt.get("receipt_id"))
        if receipt_id:
            ids.append(receipt_id)
    return ids


def _selected_executable_receipt(
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> Mapping[str, Any]:
    selected = _mapping(executable_alpha_repair_receipts.get("selected_receipt"))
    if selected:
        return selected
    for raw_receipt in _sequence(executable_alpha_repair_receipts.get("receipts")):
        receipt = _mapping(raw_receipt)
        if receipt:
            return receipt
    return {}


def _closure_market(
    alpha_repair_closure_board: Mapping[str, Any],
) -> Mapping[str, Any]:
    return _mapping(alpha_repair_closure_board.get("alpha_closure_settlement_market"))


def _pending_closure_receipt(
    alpha_repair_closure_board: Mapping[str, Any],
) -> Mapping[str, Any]:
    return _mapping(
        _closure_market(alpha_repair_closure_board).get("pending_settlement_receipt")
    )


def _release_key(
    *,
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
    selected_lane: Mapping[str, Any],
    settlement_receipt: Mapping[str, Any],
    source_revenue_repair_ref: str,
    selected_hypothesis_id: str,
    preserved_reason_codes: Sequence[str],
    required_receipts: Sequence[str],
) -> str:
    explicit = _text(selected_lane.get("no_delta_release_key")) or _text(
        settlement_receipt.get("no_delta_release_key")
    )
    if explicit:
        return explicit
    return _stable_hash(
        "alpha-repair-dividend-release-key",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "source_commit": _text(
                alpha_readiness_settlement_conveyor.get("source_commit")
            ),
            "hypothesis_id": selected_hypothesis_id,
            "preserved_reason_codes": list(preserved_reason_codes),
            "required_receipts": list(required_receipts),
        },
    )


def _dividend_state(
    *,
    reason_codes: Sequence[str],
    settlement_state: str,
    measured_delta: int,
    repeat_launch_decision: str,
) -> str:
    reason_set = set(reason_codes)
    if "alpha_readiness_settlement_conveyor_stale" in reason_set:
        return "stale"
    blocked_reasons = {
        "alpha_readiness_settlement_conveyor_missing",
        "alpha_repair_settlement_receipt_missing",
        "capital_notional_nonzero",
        "revenue_repair_top_item_not_alpha_readiness",
        "selected_value_gate_not_routeable_candidate_count",
    }
    if reason_set.intersection(blocked_reasons):
        return "blocked"
    if measured_delta > 0 or settlement_state == "paid":
        return "paid"
    if repeat_launch_decision == "deny" or settlement_state == "no_delta":
        return "no_delta"
    return "pending"


def _launch_decision(dividend_state: str) -> str:
    if dividend_state == "paid":
        return "allow"
    if dividend_state == "pending":
        return "hold"
    return "deny"


def _hypothesis_dividends(
    *,
    lanes: Sequence[object],
    selected_hypothesis_id: str,
    source_revenue_repair_ref: str,
) -> list[dict[str, object]]:
    dividends: list[dict[str, object]] = []
    for raw_lane in lanes:
        lane = _mapping(raw_lane)
        if not lane:
            continue
        measured_delta = _int(lane.get("measured_routeable_candidate_delta"))
        repeat_launch_decision = _text(lane.get("repeat_launch_decision"), "hold")
        state = "paid" if measured_delta > 0 else "no_delta"
        if repeat_launch_decision not in {"allow", "deny"}:
            state = "pending"
        hypothesis_id = _text(lane.get("hypothesis_id"))
        dividends.append(
            {
                "hypothesis_id": hypothesis_id,
                "candidate_id": lane.get("candidate_id"),
                "strategy_id": lane.get("strategy_id"),
                "lane_id": lane.get("lane_id"),
                "dividend_state": state,
                "selected": hypothesis_id == selected_hypothesis_id,
                "selected_value_gate": "routeable_candidate_count",
                "measured_delta": measured_delta,
                "preserved_reason_codes": _string_list(lane.get("before_reason_codes")),
                "no_delta_release_key": lane.get("no_delta_release_key")
                or _stable_hash(
                    "alpha-repair-lane-release-key",
                    {
                        "source_revenue_repair_ref": source_revenue_repair_ref,
                        "hypothesis_id": hypothesis_id,
                        "reason_codes": _string_list(lane.get("before_reason_codes")),
                    },
                ),
                "repeat_launch_decision": repeat_launch_decision,
                "max_notional": _text(lane.get("max_notional"), "0"),
            }
        )
    return dividends


def build_alpha_repair_dividend_ledger(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    capital: Mapping[str, Any],
    evidence: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
    executable_alpha_settlement_slots: Mapping[str, Any],
    alpha_evidence_foundry: Mapping[str, Any],
    alpha_repair_closure_board: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
) -> dict[str, object]:
    """Build observe-mode alpha repair dividend accounting (standalone internal)."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    top_item = _top_queue_item(repair_queue)
    selected_lane = _mapping(alpha_readiness_settlement_conveyor.get("selected_lane"))
    settlement_receipt = _mapping(
        alpha_readiness_settlement_conveyor.get("settlement_receipt")
    )
    selected_executable_receipt = _selected_executable_receipt(
        executable_alpha_repair_receipts
    )
    closure_market = _closure_market(alpha_repair_closure_board)
    pending_closure_receipt = _pending_closure_receipt(alpha_repair_closure_board)

    source_revenue_repair_ref = _source_revenue_repair_ref(
        alpha_readiness_settlement_conveyor,
        alpha_evidence_foundry,
        executable_alpha_repair_receipts,
    )
    selected_hypothesis_id = (
        _text(selected_lane.get("hypothesis_id"))
        or _text(settlement_receipt.get("hypothesis_id"))
        or _text(selected_executable_receipt.get("hypothesis_id"))
        or _text(closure_market.get("selected_hypothesis_id"))
    )
    selected_value_gate = (
        _text(alpha_readiness_settlement_conveyor.get("selected_value_gate"))
        or _text(top_item.get("value_gate"))
        or "routeable_candidate_count"
    )
    routeable_before = _int(
        alpha_readiness_settlement_conveyor.get("routeable_candidate_count_before"),
        _routeable_candidate_count(evidence),
    )
    routeable_after = _int(
        alpha_readiness_settlement_conveyor.get("routeable_candidate_count_after"),
        routeable_before,
    )
    measured_delta = _int(
        alpha_readiness_settlement_conveyor.get("measured_routeable_candidate_delta"),
        routeable_after - routeable_before,
    )
    max_notional = (
        _text(capital.get("max_notional"))
        or _text(alpha_readiness_settlement_conveyor.get("max_notional"))
        or _text(top_item.get("max_notional"))
        or "0"
    )
    preserved_reason_codes = (
        _string_list(settlement_receipt.get("preserved_reason_codes"))
        or _string_list(pending_closure_receipt.get("preserved_reason_codes"))
        or _string_list(selected_lane.get("before_reason_codes"))
    )
    retired_reason_codes = _string_list(settlement_receipt.get("retired_reason_codes"))
    introduced_reason_codes = _string_list(settlement_receipt.get("new_reason_codes"))
    required_receipts = _append_unique(
        _string_list(alpha_readiness_settlement_conveyor.get("required_receipts")),
        settlement_receipt.get("missing_receipts"),
        selected_lane.get("required_receipts"),
        top_item.get("required_receipts"),
        top_item.get("required_output_receipt"),
    )
    validation_commands = _append_unique(
        _string_list(alpha_readiness_settlement_conveyor.get("validation_commands")),
        settlement_receipt.get("validation_commands"),
        pending_closure_receipt.get("validation_commands"),
        "uv run --frozen pytest services/torghut/tests/test_alpha_repair_dividend_ledger.py",
    )
    no_delta_release_key = _release_key(
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
        selected_lane=selected_lane,
        settlement_receipt=settlement_receipt,
        source_revenue_repair_ref=source_revenue_repair_ref,
        selected_hypothesis_id=selected_hypothesis_id,
        preserved_reason_codes=preserved_reason_codes,
        required_receipts=required_receipts,
    )

    reason_codes: list[str] = []
    if revenue_ready:
        reason_codes.append("revenue_already_ready")
    if business_state != "repair_only":
        reason_codes.append(f"business_state_{business_state or 'unknown'}")
    if not _is_alpha_repair(top_item):
        reason_codes.append("revenue_repair_top_item_not_alpha_readiness")
    if selected_value_gate != "routeable_candidate_count":
        reason_codes.append("selected_value_gate_not_routeable_candidate_count")
    if max_notional not in _ZERO_NOTIONAL_VALUES:
        reason_codes.append("capital_notional_nonzero")
    if not alpha_readiness_settlement_conveyor:
        reason_codes.append("alpha_readiness_settlement_conveyor_missing")
    if alpha_readiness_settlement_conveyor and not settlement_receipt:
        reason_codes.append("alpha_repair_settlement_receipt_missing")
    conveyor_fresh_until = _parse_datetime(
        alpha_readiness_settlement_conveyor.get("fresh_until")
    )
    if conveyor_fresh_until is not None and conveyor_fresh_until <= generated:
        reason_codes.append("alpha_readiness_settlement_conveyor_stale")
    if (
        alpha_readiness_settlement_conveyor
        and _text(alpha_readiness_settlement_conveyor.get("status")) == "no_delta"
    ):
        reason_codes.append("active_no_delta_release_key")

    settlement_state = _text(
        alpha_readiness_settlement_conveyor.get("settlement_state"),
        _text(settlement_receipt.get("settlement_state"), "pending"),
    )
    repeat_launch_decision = (
        _text(selected_lane.get("repeat_launch_decision"))
        or _text(settlement_receipt.get("repeat_launch_decision"))
        or "hold"
    )
    dividend_state = _dividend_state(
        reason_codes=reason_codes,
        settlement_state=settlement_state,
        measured_delta=measured_delta,
        repeat_launch_decision=repeat_launch_decision,
    )
    launch_decision = _launch_decision(dividend_state)
    ledger_id = "alpha-repair-dividend-ledger:" + _stable_hash(
        "alpha-repair-dividend-ledger",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "selected_hypothesis_id": selected_hypothesis_id,
            "no_delta_release_key": no_delta_release_key,
            "dividend_state": dividend_state,
            "routeable_before": routeable_before,
            "routeable_after": routeable_after,
        },
    )
    hypothesis_dividends = _hypothesis_dividends(
        lanes=_sequence(alpha_readiness_settlement_conveyor.get("lane_scores")),
        selected_hypothesis_id=selected_hypothesis_id,
        source_revenue_repair_ref=source_revenue_repair_ref,
    )
    if not hypothesis_dividends and selected_hypothesis_id:
        hypothesis_dividends.append(
            {
                "hypothesis_id": selected_hypothesis_id,
                "candidate_id": selected_lane.get("candidate_id")
                or settlement_receipt.get("candidate_id"),
                "strategy_id": selected_lane.get("strategy_id")
                or settlement_receipt.get("strategy_id"),
                "lane_id": selected_lane.get("lane_id")
                or settlement_receipt.get("lane_id"),
                "dividend_state": dividend_state,
                "selected": True,
                "selected_value_gate": selected_value_gate,
                "measured_delta": measured_delta,
                "preserved_reason_codes": preserved_reason_codes,
                "no_delta_release_key": no_delta_release_key,
                "repeat_launch_decision": repeat_launch_decision,
                "max_notional": max_notional,
            }
        )

    return {
        "schema_version": ALPHA_REPAIR_DIVIDEND_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _DESIGN_REF,
        "companion_design_ref": _COMPANION_DESIGN_REF,
        "enforcement_mode": "observe",
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "source_repair_bid_refs": _string_list(
            repair_bid_settlement_ledger.get("selected_lot_ids")
        ),
        "source_repair_bid_settlement_ref": repair_bid_settlement_ledger.get(
            "ledger_id"
        ),
        "source_executable_alpha_repair_receipts_ref": executable_alpha_repair_receipts.get(
            "selected_receipt_id"
        )
        or executable_alpha_repair_receipts.get("source_revenue_repair_ref"),
        "source_executable_alpha_settlement_slots_ref": executable_alpha_settlement_slots.get(
            "selected_slot_id"
        )
        or executable_alpha_settlement_slots.get("source_revenue_repair_ref"),
        "source_alpha_evidence_foundry_ref": alpha_evidence_foundry.get("foundry_id"),
        "source_alpha_repair_closure_board_ref": alpha_repair_closure_board.get(
            "board_id"
        ),
        "source_alpha_readiness_settlement_conveyor_ref": alpha_readiness_settlement_conveyor.get(
            "conveyor_id"
        ),
        "account_id": alpha_readiness_settlement_conveyor.get("account_id")
        or closure_market.get("account_id")
        or repair_bid_settlement_ledger.get("account_id"),
        "window": alpha_readiness_settlement_conveyor.get("window")
        or closure_market.get("window")
        or repair_bid_settlement_ledger.get("session_id"),
        "trading_mode": alpha_readiness_settlement_conveyor.get("trading_mode")
        or closure_market.get("trading_mode")
        or repair_bid_settlement_ledger.get("trading_mode"),
        "business_state": business_state,
        "revenue_ready": revenue_ready,
        "status": dividend_state,
        "dividend_state": dividend_state,
        "reason_codes": reason_codes,
        "selected_queue_code": _text(top_item.get("code")),
        "selected_value_gate": selected_value_gate,
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "accepted_routeable_candidate_count": _int(
            _mapping(evidence.get("routeability_acceptance")).get(
                "accepted_routeable_candidate_count"
            )
        ),
        "measured_delta": measured_delta,
        "selected_hypothesis_id": selected_hypothesis_id,
        "selected_strategy_id": selected_lane.get("strategy_id")
        or settlement_receipt.get("strategy_id")
        or selected_executable_receipt.get("strategy_id"),
        "selected_repair_class": closure_market.get("selected_repair_class")
        or selected_executable_receipt.get("repair_class")
        or "alpha_readiness",
        "required_output_receipt": top_item.get("required_output_receipt")
        or executable_alpha_repair_receipts.get("required_output_receipt"),
        "required_receipts": required_receipts,
        "executable_alpha_receipt_refs": _append_unique(
            _receipt_ids(executable_alpha_repair_receipts, "receipts"),
            selected_executable_receipt.get("receipt_id"),
            settlement_receipt.get("evidence_window_id"),
        ),
        "preserved_reason_codes": preserved_reason_codes,
        "retired_reason_codes": retired_reason_codes,
        "introduced_reason_codes": introduced_reason_codes,
        "no_delta_release_key": no_delta_release_key,
        "no_delta_release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
        "next_allowed_attempt_after": pending_closure_receipt.get(
            "next_allowed_attempt_after"
        )
        or alpha_readiness_settlement_conveyor.get("fresh_until"),
        "hypothesis_dividends": hypothesis_dividends,
        "internal_custody": {
            "required_recorder_schema": _RECORDER_SCHEMA,
            "enforcement_mode": "observe",
            "allowed_action_class": "dispatch_repair"
            if launch_decision == "allow"
            else None,
            "launch_decision": launch_decision,
            "launch_decision_reason": "no_delta_release_key_active"
            if dividend_state == "no_delta"
            else dividend_state,
            "denied_action_classes": [
                "paper_canary",
                "live_micro_canary",
                "live_scale",
            ],
        },
        "validation_commands": validation_commands,
        "capital_state": _text(capital.get("capital_state"), "zero_notional"),
        "capital_rule": _text(
            top_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "max_notional": max_notional,
        "rollback_target": _ROLLBACK_TARGET,
    }


def compact_alpha_repair_dividend_ledger(
    ledger: Mapping[str, Any] | None,
) -> dict[str, object]:
    """Return the compact alpha repair dividend ledger ref (standalone internal)."""

    payload = _mapping(ledger)
    if not payload:
        return {
            "schema_version": ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION,
            "status": "missing",
            "reason_codes": ["alpha_repair_dividend_ledger_missing"],
        }
    validation_commands = _string_list(payload.get("validation_commands"))
    internal_custody = _mapping(payload.get("internal_custody"))
    return {
        "schema_version": ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION,
        "ledger_schema_version": payload.get("schema_version"),
        "ledger_id": payload.get("ledger_id"),
        "generated_at": payload.get("generated_at"),
        "fresh_until": payload.get("fresh_until"),
        "status": payload.get("status"),
        "dividend_state": payload.get("dividend_state"),
        "reason_codes": _string_list(payload.get("reason_codes")),
        "selected_hypothesis_id": payload.get("selected_hypothesis_id"),
        "selected_value_gate": payload.get("selected_value_gate"),
        "routeable_candidate_count_before": payload.get(
            "routeable_candidate_count_before"
        ),
        "routeable_candidate_count_after": payload.get(
            "routeable_candidate_count_after"
        ),
        "measured_delta": payload.get("measured_delta"),
        "no_delta_release_key": payload.get("no_delta_release_key"),
        "launch_decision": internal_custody.get("launch_decision"),
        "required_recorder_schema": internal_custody.get("required_recorder_schema"),
        "validation_command": validation_commands[0] if validation_commands else None,
        "enforcement_mode": payload.get("enforcement_mode"),
        "max_notional": payload.get("max_notional"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


__all__ = [
    "ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION",
    "ALPHA_REPAIR_DIVIDEND_LEDGER_SCHEMA_VERSION",
    "build_alpha_repair_dividend_ledger",
    "compact_alpha_repair_dividend_ledger",
]
