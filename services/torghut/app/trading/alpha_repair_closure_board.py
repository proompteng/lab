"""Alpha repair closure board for routeable revenue reentry."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from .read_model_utils import (
    as_bool as _bool,
    as_int as _int,
    as_mapping as _mapping,
    as_sequence as _sequence,
    as_text as _text,
    first_mapping as _top_queue_item,
    is_alpha_readiness_repair as _is_alpha_repair,
    routeable_candidate_count as _routeable_candidate_count,
    stable_hash24 as _stable_hash,
    unique_text_list as _string_list,
)

ALPHA_REPAIR_CLOSURE_BOARD_SCHEMA_VERSION = "torghut.alpha-repair-closure-board.v1"
ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION = (
    "torghut.alpha-repair-closure-board-ref.v1"
)
ALPHA_CLOSURE_SETTLEMENT_MARKET_SCHEMA_VERSION = (
    "torghut.alpha-closure-settlement-market.v1"
)
ALPHA_CLOSURE_SETTLEMENT_RECEIPT_SCHEMA_VERSION = (
    "torghut.alpha-closure-settlement-receipt.v1"
)

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md"
)
_COMPANION_JANGAR_DESIGN_REF = (
    "docs/agents/designs/"
    "193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md"
)
_SETTLEMENT_MARKET_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md"
)
_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_ROLLBACK_TARGET = (
    "disable alpha_repair_closure_board emission and keep Torghut max_notional=0"
)
_SETTLEMENT_ROLLBACK_TARGET = (
    "disable alpha_closure_settlement_market and keep Torghut max_notional=0"
)
_FEATURE_REPLAY_HYPOTHESIS_ID = "H-MICRO-01"
_FEATURE_REPLAY_BLOCKERS = {
    "drift_checks_missing",
    "feature_rows_missing",
    "required_feature_set_unavailable",
}
_NO_DELTA_RELEASE_CONDITIONS = [
    "evidence_window_changes",
    "blocker_set_changes",
    "source_ref_changes",
    "required_receipt_changes",
]


def _append_unique(items: list[str], *values: object) -> list[str]:
    seen = set(items)
    for value in values:
        for candidate in _string_list(value) if _sequence(value) else [_text(value)]:
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            items.append(candidate)
    return items


def _account_window(
    *,
    evidence: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> tuple[str, str, str]:
    selected_receipt = _mapping(
        executable_alpha_repair_receipts.get("selected_receipt")
    )
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    account = (
        _text(selected_receipt.get("account_id"))
        or _text(repair_bid_settlement.get("account_id"))
        or "unknown"
    )
    window = (
        _text(selected_receipt.get("window"))
        or _text(repair_bid_settlement.get("session_id"))
        or "unknown"
    )
    trading_mode = (
        _text(selected_receipt.get("trading_mode"))
        or _text(repair_bid_settlement.get("trading_mode"))
        or "unknown"
    )
    return account, window, trading_mode


def _source_serving_refs(
    source_serving_metadata: Mapping[str, Any],
) -> dict[str, object]:
    build = _mapping(source_serving_metadata.get("build"))
    source_serving = _mapping(
        source_serving_metadata.get("source_serving_repair_receipt_ledger")
    )
    route_packet = _mapping(
        source_serving_metadata.get("route_evidence_clearinghouse_packet")
    )
    source_commit = (
        _text(source_serving.get("source_commit"))
        or _text(route_packet.get("source_commit"))
        or _text(build.get("commit"))
        or "unknown"
    )
    active_revision = (
        _text(source_serving.get("active_revision"))
        or _text(route_packet.get("torghut_revision"))
        or _text(build.get("active_revision"))
        or "unknown"
    )
    image_digest = _text(source_serving.get("image_digest")) or _text(
        build.get("image_digest")
    )
    source_serving_ref = (
        _text(source_serving.get("ledger_id"))
        or _text(source_serving.get("receipt_id"))
        or f"source-serving:{source_commit}:{active_revision}"
    )
    refs: dict[str, object] = {
        "source_commit": source_commit,
        "active_revision": active_revision,
        "source_serving_ref": source_serving_ref,
    }
    if image_digest:
        refs["image_digest"] = image_digest
    source_state = _text(source_serving.get("source_serving_state"))
    if source_state:
        refs["source_serving_state"] = source_state
    return refs


def _all_repair_receipts(
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    receipts: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for raw_receipt in [
        executable_alpha_repair_receipts.get("selected_receipt"),
        *_sequence(executable_alpha_repair_receipts.get("receipts")),
    ]:
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


def _receipt_reason_codes(receipt: Mapping[str, Any]) -> list[str]:
    reason_codes = _string_list(receipt.get("reason_codes"))
    settlement = _mapping(receipt.get("settlement"))
    if not reason_codes:
        reason_codes = _string_list(settlement.get("before_reason_codes"))
    return reason_codes


def _is_zero_notional_receipt(receipt: Mapping[str, Any]) -> bool:
    return _text(receipt.get("max_notional"), "0") in {"0", "0.0", "0.00"}


def _is_feature_replay_receipt(receipt: Mapping[str, Any]) -> bool:
    return bool(
        set(_receipt_reason_codes(receipt)).intersection(_FEATURE_REPLAY_BLOCKERS)
    )


def _closure_receipt_rank(
    receipt: Mapping[str, Any], selected_receipt_id: str
) -> tuple[int, str]:
    hypothesis_id = _text(receipt.get("hypothesis_id"))
    reason_codes = set(_receipt_reason_codes(receipt))
    lineage_ready = _text(receipt.get("lineage_status"), "ready") == "ready"
    feature_replay = bool(reason_codes.intersection(_FEATURE_REPLAY_BLOCKERS))
    if (
        hypothesis_id == _FEATURE_REPLAY_HYPOTHESIS_ID
        and lineage_ready
        and feature_replay
        and _is_zero_notional_receipt(receipt)
    ):
        return (0, hypothesis_id)
    if lineage_ready and feature_replay and _is_zero_notional_receipt(receipt):
        return (10, hypothesis_id)
    if _text(receipt.get("receipt_id")) == selected_receipt_id:
        return (20, hypothesis_id)
    return (50, hypothesis_id)


def _select_closure_receipt(
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> Mapping[str, Any]:
    receipts = _all_repair_receipts(executable_alpha_repair_receipts)
    if not receipts:
        return {}
    selected_receipt_id = _text(
        executable_alpha_repair_receipts.get("selected_receipt_id")
    )
    return sorted(
        receipts,
        key=lambda receipt: _closure_receipt_rank(receipt, selected_receipt_id),
    )[0]


def _build_repair_closure(
    *,
    generated: datetime,
    top_queue_item: Mapping[str, Any],
    selected_receipt: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
    evidence: Mapping[str, Any],
    capital: Mapping[str, Any],
    source_refs: Mapping[str, object],
    account: str,
    window: str,
) -> dict[str, object]:
    source_revenue_repair_ref = (
        _text(selected_receipt.get("source_revenue_repair_ref"))
        or _text(executable_alpha_repair_receipts.get("source_revenue_repair_ref"))
        or "torghut-revenue-repair-digest:unknown"
    )
    receipt_id = _text(selected_receipt.get("receipt_id"))
    capital_replay_board = _mapping(
        _mapping(evidence.get("alpha_readiness")).get("capital_replay_board")
    )
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    before_refs = [
        source_revenue_repair_ref,
        _text(capital_replay_board.get("board_id")),
        _text(repair_bid_settlement.get("ledger_id")),
        receipt_id,
    ]
    before_refs = [item for item in before_refs if item]
    reason_codes = _string_list(selected_receipt.get("reason_codes")) or [
        _text(top_queue_item.get("reason"), "hypothesis_not_promotion_eligible")
    ]
    routeable_before = _routeable_candidate_count(evidence)
    measured_delta = _int(selected_receipt.get("measured_delta"))
    if routeable_before <= 0:
        measured_delta = min(measured_delta, 0)
    dedupe_key = _stable_hash(
        "alpha-repair-closure-dedupe",
        {
            "account": account,
            "window": window,
            "queue_code": _text(top_queue_item.get("code")),
            "reason": _text(top_queue_item.get("reason")),
            "hypothesis_id": _text(selected_receipt.get("hypothesis_id")),
            "reason_codes": reason_codes,
            "source_commit": _text(source_refs.get("source_commit")),
        },
    )
    closure_id = "alpha-repair-closure:" + _stable_hash(
        "alpha-repair-closure",
        {
            "dedupe_key": dedupe_key,
            "receipt_id": receipt_id,
            "generated_at": generated.isoformat(),
        },
    )
    required_receipts = _string_list(top_queue_item.get("required_receipts"))
    required_output = _text(
        top_queue_item.get("required_output_receipt"),
        "torghut.executable-alpha-receipts.v1",
    )
    if required_output not in required_receipts:
        required_receipts.append(required_output)
    validation_commands = _string_list(selected_receipt.get("validation_commands"))
    no_delta_reason = (
        "routeable_candidate_count_unchanged" if measured_delta <= 0 else ""
    )
    return {
        "closure_id": closure_id,
        "queue_code": _text(top_queue_item.get("code"), "repair_alpha_readiness"),
        "reason_code": _text(
            top_queue_item.get("reason"), "hypothesis_not_promotion_eligible"
        ),
        "hypothesis_id": _text(selected_receipt.get("hypothesis_id")),
        "value_gate": _text(
            top_queue_item.get("value_gate"), "routeable_candidate_count"
        ),
        "priority": _int(top_queue_item.get("priority"), 70),
        "expected_unblock_value": _int(top_queue_item.get("expected_unblock_value"), 1),
        "required_output_receipt": required_output,
        "required_receipts": required_receipts,
        "before_refs": before_refs,
        "after_refs": [],
        "routeable_candidate_count_before": routeable_before,
        "measured_delta": measured_delta,
        "no_delta_reason": no_delta_reason,
        "validation_commands": validation_commands,
        "dedupe_key": dedupe_key,
        "max_notional": _text(capital.get("max_notional"), "0"),
        "capital_rule": _text(
            top_queue_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "rollback_target": _text(
            selected_receipt.get("rollback_target"), _ROLLBACK_TARGET
        ),
    }


def _no_delta_debt_from_closure(closure: Mapping[str, Any]) -> dict[str, object] | None:
    if _int(closure.get("measured_delta")) > 0:
        return None
    return {
        "debt_id": "alpha-repair-no-delta:"
        + _stable_hash(
            "alpha-repair-no-delta",
            {
                "closure_id": _text(closure.get("closure_id")),
                "dedupe_key": _text(closure.get("dedupe_key")),
                "reason_code": _text(closure.get("reason_code")),
            },
        ),
        "closure_id": closure.get("closure_id"),
        "dedupe_key": closure.get("dedupe_key"),
        "reason_code": closure.get("reason_code"),
        "value_gate": closure.get("value_gate"),
        "routeable_candidate_count_before": closure.get(
            "routeable_candidate_count_before"
        ),
        "measured_delta": closure.get("measured_delta"),
        "no_delta_reason": closure.get("no_delta_reason"),
        "release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
    }


def _selected_lot_class(selected_receipt: Mapping[str, Any]) -> str:
    if _is_feature_replay_receipt(selected_receipt):
        return "feature_lineage"
    return "promotion_custody"


def _required_after_receipts(
    top_queue_item: Mapping[str, Any], selected_receipt: Mapping[str, Any]
) -> list[str]:
    receipts = _string_list(selected_receipt.get("required_output_receipts"))
    receipts = _append_unique(
        receipts,
        top_queue_item.get("required_receipts"),
        top_queue_item.get("required_output_receipt"),
    )
    if _is_feature_replay_receipt(selected_receipt):
        receipts = _append_unique(
            receipts,
            "feature_replay_receipt",
            "drift_check_receipt",
            "required_feature_set_receipt",
        )
    return receipts


def _promotion_eligible_count(evidence: Mapping[str, Any]) -> int:
    return _int(
        _mapping(evidence.get("alpha_readiness")).get("promotion_eligible_total")
    )


def _settlement_status(
    *,
    board_status: str,
    selected_receipt: Mapping[str, Any],
    no_delta_used: int,
) -> str:
    if board_status in {"blocked", "held", "inactive"}:
        return board_status
    if not selected_receipt:
        return "blocked"
    if no_delta_used > 0:
        return "pending_no_delta"
    return "pending"


def _build_pending_settlement_receipt(
    *,
    market_id: str,
    closure: Mapping[str, Any],
    selected_receipt: Mapping[str, Any],
    evidence: Mapping[str, Any],
    fresh_until: datetime,
) -> dict[str, object]:
    reason_codes = _receipt_reason_codes(selected_receipt)
    routeable_before = _int(closure.get("routeable_candidate_count_before"))
    measured_delta = _int(closure.get("measured_delta"))
    routeable_after = max(0, routeable_before + measured_delta)
    no_delta_reason = _text(closure.get("no_delta_reason"))
    receipt_id = "alpha-closure-settlement-receipt:" + _stable_hash(
        "alpha-closure-settlement-receipt",
        {
            "market_id": market_id,
            "hypothesis_id": _text(selected_receipt.get("hypothesis_id")),
            "dedupe_key": _text(closure.get("dedupe_key")),
            "reason_codes": reason_codes,
        },
    )
    return {
        "schema_version": ALPHA_CLOSURE_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "market_id": market_id,
        "hypothesis_id": _text(selected_receipt.get("hypothesis_id")),
        "candidate_id": _text(selected_receipt.get("candidate_id")) or None,
        "strategy_id": _text(selected_receipt.get("strategy_id")) or None,
        "repair_class": "feature_replay_closure"
        if _is_feature_replay_receipt(selected_receipt)
        else _text(selected_receipt.get("repair_class"), "alpha_repair_closure"),
        "before_refs": _string_list(closure.get("before_refs")),
        "after_refs": [],
        "retired_reason_codes": [],
        "preserved_reason_codes": reason_codes,
        "introduced_reason_codes": [],
        "measured_delta": measured_delta,
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "promotion_eligible_before": _promotion_eligible_count(evidence),
        "promotion_eligible_after": _promotion_eligible_count(evidence),
        "no_delta_reason": no_delta_reason,
        "next_allowed_attempt_after": fresh_until.isoformat()
        if no_delta_reason
        else None,
        "validation_commands": _string_list(closure.get("validation_commands")),
        "max_notional": _text(closure.get("max_notional"), "0"),
        "capital_rule": _text(closure.get("capital_rule"), "zero_notional_repair_only"),
    }


def _build_settlement_market(
    *,
    generated: datetime,
    fresh_until: datetime,
    status: str,
    reason_codes: Sequence[str],
    top_queue_item: Mapping[str, Any],
    selected_receipt: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
    evidence: Mapping[str, Any],
    capital: Mapping[str, Any],
    source_refs: Mapping[str, object],
    closure: Mapping[str, Any] | None,
    account: str,
    window: str,
) -> dict[str, object]:
    source_revenue_repair_ref = (
        _text(selected_receipt.get("source_revenue_repair_ref"))
        or _text(executable_alpha_repair_receipts.get("source_revenue_repair_ref"))
        or "torghut-revenue-repair-digest:unknown"
    )
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    repair_outcome_dividend = _mapping(evidence.get("repair_outcome_dividend"))
    hypothesis_id = _text(selected_receipt.get("hypothesis_id"))
    active_dedupe_key = _text(_mapping(closure).get("dedupe_key"))
    market_id = "alpha-closure-settlement-market:" + _stable_hash(
        "alpha-closure-settlement-market",
        {
            "account": account,
            "window": window,
            "queue_code": _text(top_queue_item.get("code")),
            "hypothesis_id": hypothesis_id,
            "reason_codes": _receipt_reason_codes(selected_receipt),
            "source_commit": _text(source_refs.get("source_commit")),
        },
    )
    pending_receipt = (
        _build_pending_settlement_receipt(
            market_id=market_id,
            closure=closure,
            selected_receipt=selected_receipt,
            evidence=evidence,
            fresh_until=fresh_until,
        )
        if closure is not None and selected_receipt
        else None
    )
    no_delta_used = (
        1 if pending_receipt and pending_receipt.get("no_delta_reason") else 0
    )
    return {
        "schema_version": ALPHA_CLOSURE_SETTLEMENT_MARKET_SCHEMA_VERSION,
        "market_id": market_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _SETTLEMENT_MARKET_DESIGN_REF,
        "status": _settlement_status(
            board_status=status,
            selected_receipt=selected_receipt,
            no_delta_used=no_delta_used,
        ),
        "reason_codes": list(reason_codes),
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "source_repair_bid_settlement_ref": repair_bid_settlement.get("ledger_id"),
        "source_repair_outcome_dividend_ref": repair_outcome_dividend.get("ledger_id"),
        "account_id": account,
        "window": window,
        "selected_value_gate": _text(
            top_queue_item.get("value_gate"), "routeable_candidate_count"
        ),
        "selected_hypothesis_id": hypothesis_id,
        "selected_repair_class": "feature_replay_closure"
        if _is_feature_replay_receipt(selected_receipt)
        else _text(selected_receipt.get("repair_class"), "alpha_repair_closure"),
        "selected_lot_class": _selected_lot_class(selected_receipt),
        "required_output_receipt": ALPHA_CLOSURE_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
        "required_after_receipts": _required_after_receipts(
            top_queue_item, selected_receipt
        ),
        "before_blocker_codes": _receipt_reason_codes(selected_receipt),
        "no_delta_budget": {
            "max_attempts_per_dedupe_key": 1,
            "used_attempts": no_delta_used,
            "remaining_attempts": max(0, 1 - no_delta_used),
            "state": "consumed" if no_delta_used else "available",
            "release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
        },
        "active_dedupe_key": active_dedupe_key,
        "pending_settlement_receipt": pending_receipt,
        "max_notional": _text(capital.get("max_notional"), "0"),
        "capital_rule": _text(
            top_queue_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "rollback_target": _SETTLEMENT_ROLLBACK_TARGET,
    }


def _db_schema_current(db_check: Mapping[str, Any]) -> tuple[bool, list[str]]:
    if not db_check:
        return True, ["db_check_not_provided"]
    schema_current = _bool(db_check.get("schema_current"), default=False)
    if schema_current:
        return True, []
    return False, ["db_check_schema_not_current"]


def build_alpha_repair_closure_board(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    capital: Mapping[str, Any],
    evidence: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
    source_serving_metadata: Mapping[str, Any] | None = None,
    db_check: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Build the compact closure board for the live alpha-readiness repair lane."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    top_item = _top_queue_item(repair_queue)
    selected_receipt = _select_closure_receipt(executable_alpha_repair_receipts)
    source_refs = _source_serving_refs(source_serving_metadata or {})
    account, window, trading_mode = _account_window(
        evidence=evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
    )
    db_current, reason_codes = _db_schema_current(db_check or {})
    max_notional = _text(capital.get("max_notional"), "0")
    if max_notional not in {"0", "0.0", "0.00"}:
        reason_codes.append("capital_notional_nonzero")
    if not _is_alpha_repair(top_item):
        reason_codes.append("revenue_repair_top_item_not_alpha_readiness")
    if not selected_receipt:
        reason_codes.append("alpha_repair_receipt_missing")

    closure: dict[str, object] | None = None
    if selected_receipt and _is_alpha_repair(top_item):
        closure = _build_repair_closure(
            generated=generated,
            top_queue_item=top_item,
            selected_receipt=selected_receipt,
            executable_alpha_repair_receipts=executable_alpha_repair_receipts,
            evidence=evidence,
            capital=capital,
            source_refs=source_refs,
            account=account,
            window=window,
        )

    no_delta_debt: list[dict[str, object]] = []
    if closure is not None:
        debt = _no_delta_debt_from_closure(closure)
        if debt is not None:
            no_delta_debt.append(debt)

    status = "selected"
    if "revenue_repair_top_item_not_alpha_readiness" in reason_codes:
        status = "inactive"
    elif (
        "capital_notional_nonzero" in reason_codes
        or "alpha_repair_receipt_missing" in reason_codes
    ):
        status = "blocked"
    elif not db_current:
        status = "held"

    alpha_closure_settlement_market = _build_settlement_market(
        generated=generated,
        fresh_until=fresh_until,
        status=status,
        reason_codes=reason_codes,
        top_queue_item=top_item,
        selected_receipt=selected_receipt,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        evidence=evidence,
        capital=capital,
        source_refs=source_refs,
        closure=closure,
        account=account,
        window=window,
    )

    board_id = "alpha-repair-closure-board:" + _stable_hash(
        "alpha-repair-closure-board",
        {
            "account": account,
            "window": window,
            "queue_code": _text(top_item.get("code")),
            "reason": _text(top_item.get("reason")),
            "source_commit": source_refs.get("source_commit"),
            "closure": closure.get("closure_id") if closure else None,
        },
    )
    return {
        "schema_version": ALPHA_REPAIR_CLOSURE_BOARD_SCHEMA_VERSION,
        "board_id": board_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _DESIGN_REF,
        "jangar_cross_plane_closure_board_ref": _COMPANION_JANGAR_DESIGN_REF,
        "status": status,
        "reason_codes": reason_codes,
        "account_id": account,
        "window": window,
        "trading_mode": trading_mode,
        "business_state": business_state,
        "revenue_ready": revenue_ready,
        "top_queue_item_ref": {
            "code": _text(top_item.get("code")),
            "reason": _text(top_item.get("reason")),
            "value_gate": _text(top_item.get("value_gate")),
            "required_output_receipt": _text(top_item.get("required_output_receipt")),
        },
        "selected_value_gate": _text(
            top_item.get("value_gate"), "routeable_candidate_count"
        ),
        "routeable_candidate_count": _routeable_candidate_count(evidence),
        "max_notional": max_notional,
        "capital_rule": _text(
            top_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "source_serving_closure_ref": source_refs.get("source_serving_ref"),
        "source_serving": source_refs,
        "db_schema_current": db_current,
        "repair_closures": [closure] if closure is not None else [],
        "no_delta_debt": no_delta_debt,
        "alpha_closure_settlement_market": alpha_closure_settlement_market,
        "rollback_target": _ROLLBACK_TARGET,
    }


def compact_alpha_repair_closure_board(
    board: Mapping[str, Any] | None,
) -> dict[str, object]:
    """Return the Jangar-facing compact reference for status payloads."""

    payload = _mapping(board)
    if not payload:
        return {
            "schema_version": ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION,
            "status": "missing",
            "reason_codes": ["alpha_repair_closure_board_missing"],
        }
    closures: list[Mapping[str, Any]] = [
        _mapping(item) for item in _sequence(payload.get("repair_closures"))
    ]
    empty_closure: Mapping[str, Any] = {}
    top_closure = closures[0] if closures else empty_closure
    no_delta_debt = _sequence(payload.get("no_delta_debt"))
    settlement_market = _mapping(payload.get("alpha_closure_settlement_market"))
    no_delta_budget = _mapping(settlement_market.get("no_delta_budget"))
    return {
        "schema_version": ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION,
        "board_schema_version": payload.get("schema_version"),
        "board_id": payload.get("board_id"),
        "generated_at": payload.get("generated_at"),
        "fresh_until": payload.get("fresh_until"),
        "status": payload.get("status"),
        "reason_codes": _string_list(payload.get("reason_codes")),
        "top_closure_id": top_closure.get("closure_id"),
        "selected_value_gate": payload.get("selected_value_gate"),
        "required_output_receipt": top_closure.get("required_output_receipt")
        or _mapping(payload.get("top_queue_item_ref")).get("required_output_receipt"),
        "settlement_market_id": settlement_market.get("market_id"),
        "settlement_market_status": settlement_market.get("status"),
        "selected_hypothesis_id": settlement_market.get("selected_hypothesis_id")
        or top_closure.get("hypothesis_id"),
        "selected_repair_class": settlement_market.get("selected_repair_class"),
        "required_settlement_receipt": settlement_market.get("required_output_receipt"),
        "active_dedupe_key": settlement_market.get("active_dedupe_key")
        or top_closure.get("dedupe_key"),
        "no_delta_budget_state": no_delta_budget.get("state"),
        "no_delta_debt_count": len(no_delta_debt),
        "max_notional": payload.get("max_notional"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


__all__ = [
    "ALPHA_CLOSURE_SETTLEMENT_MARKET_SCHEMA_VERSION",
    "ALPHA_CLOSURE_SETTLEMENT_RECEIPT_SCHEMA_VERSION",
    "ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION",
    "ALPHA_REPAIR_CLOSURE_BOARD_SCHEMA_VERSION",
    "build_alpha_repair_closure_board",
    "compact_alpha_repair_closure_board",
]
