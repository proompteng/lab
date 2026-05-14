"""Alpha repair closure board for routeable revenue reentry."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, cast

ALPHA_REPAIR_CLOSURE_BOARD_SCHEMA_VERSION = (
    "torghut.alpha-repair-closure-board.v1"
)
ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION = (
    "torghut.alpha-repair-closure-board-ref.v1"
)

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md"
)
_COMPANION_JANGAR_DESIGN_REF = (
    "docs/agents/designs/"
    "193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md"
)
_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_ROLLBACK_TARGET = (
    "disable alpha_repair_closure_board emission and keep Torghut max_notional=0"
)
_NO_DELTA_RELEASE_CONDITIONS = [
    "evidence_window_changes",
    "blocker_set_changes",
    "source_ref_changes",
    "required_receipt_changes",
]


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "allow", "allowed", "ok"}:
            return True
        if normalized in {"0", "false", "no", "off", "deny", "blocked", "hold"}:
            return False
    return default


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _string_list(value: object) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for item in _sequence(value):
        normalized = _text(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        items.append(normalized)
    return items


def _stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _top_queue_item(repair_queue: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    for item in repair_queue:
        payload = _mapping(item)
        if payload:
            return payload
    return {}


def _is_alpha_repair(item: Mapping[str, Any]) -> bool:
    return (
        _text(item.get("code")) == "repair_alpha_readiness"
        or _text(item.get("reason")) == "alpha_readiness_not_promotion_eligible"
    )


def _routeable_candidate_count(evidence: Mapping[str, Any]) -> int:
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    routeability_acceptance = _mapping(evidence.get("routeability_acceptance"))
    route_clearinghouse = _mapping(evidence.get("route_evidence_clearinghouse"))
    return max(
        _int(repair_bid_settlement.get("routeable_candidate_count")),
        _int(routeability_acceptance.get("accepted_routeable_candidate_count")),
        _int(route_clearinghouse.get("accepted_routeable_candidate_count")),
    )


def _account_window(
    *,
    evidence: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> tuple[str, str, str]:
    selected_receipt = _mapping(executable_alpha_repair_receipts.get("selected_receipt"))
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


def _source_serving_refs(source_serving_metadata: Mapping[str, Any]) -> dict[str, object]:
    build = _mapping(source_serving_metadata.get("build"))
    source_serving = _mapping(
        source_serving_metadata.get("source_serving_repair_receipt_ledger")
    )
    route_packet = _mapping(source_serving_metadata.get("route_evidence_clearinghouse_packet"))
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


def _selected_repair_receipt(
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
    capital_replay_board = _mapping(_mapping(evidence.get("alpha_readiness")).get("capital_replay_board"))
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    before_refs = [
        source_revenue_repair_ref,
        _text(capital_replay_board.get("board_id")),
        _text(repair_bid_settlement.get("ledger_id")),
        receipt_id,
    ]
    before_refs = [item for item in before_refs if item]
    reason_codes = _string_list(selected_receipt.get("reason_codes")) or [
        _text(top_queue_item.get("reason"), "alpha_readiness_not_promotion_eligible")
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
        "routeable_candidate_count_unchanged"
        if measured_delta <= 0
        else ""
    )
    return {
        "closure_id": closure_id,
        "queue_code": _text(top_queue_item.get("code"), "repair_alpha_readiness"),
        "reason_code": _text(
            top_queue_item.get("reason"), "alpha_readiness_not_promotion_eligible"
        ),
        "hypothesis_id": _text(selected_receipt.get("hypothesis_id")),
        "value_gate": _text(top_queue_item.get("value_gate"), "routeable_candidate_count"),
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
        "debt_id": "alpha-repair-no-delta:" + _stable_hash(
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
    selected_receipt = _selected_repair_receipt(executable_alpha_repair_receipts)
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
        "no_delta_debt_count": len(no_delta_debt),
        "max_notional": payload.get("max_notional"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


__all__ = [
    "ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION",
    "ALPHA_REPAIR_CLOSURE_BOARD_SCHEMA_VERSION",
    "build_alpha_repair_closure_board",
    "compact_alpha_repair_closure_board",
]
