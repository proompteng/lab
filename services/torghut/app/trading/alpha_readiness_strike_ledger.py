"""Alpha-readiness strike ledger projection for zero-notional repair admission."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast


ALPHA_READINESS_STRIKE_LEDGER_SCHEMA_VERSION = (
    "torghut.alpha-readiness-strike-ledger.v1"
)
PROMOTION_CUSTODY_RECEIPT_SCHEMA_VERSION = (
    "torghut.promotion-custody-decision-receipt.v1"
)

_FRESHNESS_SECONDS = 60
_ROLLBACK_TARGET = (
    "disable alpha-readiness strike ledger and keep Torghut max_notional=0"
)
_REPAIR_ECONOMICS_HOLD_REASONS = {
    "selection_limit_exceeded",
    "dispatch_limit_exceeded",
}
_GUARDED_ACTION_CLASSES = ["paper_canary", "live_micro_canary", "live_scale"]


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _int(value: object, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return default


def _zero_notional(value: object) -> bool:
    try:
        return Decimal(str(value)) == 0
    except (InvalidOperation, ValueError):
        return False


def _strings(value: object) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for item in _sequence(value):
        text = _text(item)
        if text and text not in seen:
            values.append(text)
            seen.add(text)
    return values


def _ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _promotion_custody_lot(
    repair_bid_settlement_ledger: Mapping[str, Any],
) -> Mapping[str, Any]:
    for raw_lot in _sequence(repair_bid_settlement_ledger.get("compacted_lots")):
        lot = _mapping(raw_lot)
        if _text(lot.get("lot_class")) == "promotion_custody":
            return lot
    return {}


def _candidate_replays(evidence: Mapping[str, Any]) -> list[dict[str, object]]:
    alpha = _mapping(evidence.get("alpha_readiness"))
    replay_board = _mapping(alpha.get("capital_replay_board"))
    replays: list[dict[str, object]] = []
    for raw_replay in _sequence(replay_board.get("top_zero_notional_replays"))[:3]:
        replay = _mapping(raw_replay)
        if not replay:
            continue
        replays.append(
            {
                "replay_id": replay.get("replay_id"),
                "hypothesis_id": replay.get("hypothesis_id"),
                "target_symbols": _strings(replay.get("target_symbols")),
                "before_refs": {
                    "capital_replay_board_ref": replay_board.get("board_id"),
                    "executable_alpha_receipt_ref": None,
                },
                "required_after_refs": _strings(replay.get("required_after_refs")),
                "acceptance_gate": "routeable_candidate_count_after_increases",
                "falsification_rules": [
                    "capital_state_must_remain_zero_notional",
                    "live_submission_must_remain_disabled",
                    "preserve_reason_codes_when_no_routeable_candidate_advances",
                ],
                "max_runtime_seconds": 1200,
                "max_notional": _text(replay.get("max_notional"), "0"),
                "expected_value_gate_delta": "retire_hypothesis_not_promotion_eligible",
            }
        )
    return replays


def _selected_blocker(repair_queue: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    return repair_queue[0] if repair_queue else {}


def _routeable_candidate_top_blocker(blocker: Mapping[str, Any]) -> bool:
    return (
        _text(blocker.get("value_gate")) == "routeable_candidate_count"
        or _text(blocker.get("code")) == "repair_alpha_readiness"
    )


def build_alpha_readiness_strike_ledger(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    repair_bid_settlement_ledger: Mapping[str, Any],
    capital: Mapping[str, Any],
    evidence: Mapping[str, Any],
) -> dict[str, object]:
    """Build a bounded promotion-custody strike packet from revenue repair evidence."""

    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_FRESHNESS_SECONDS)
    top_blocker = _selected_blocker(repair_queue)
    promotion_lot = _promotion_custody_lot(repair_bid_settlement_ledger)
    ledger_max_notional = repair_bid_settlement_ledger.get("max_notional", "0")
    capital_max_notional = capital.get("max_notional", "0")
    lot_max_notional = promotion_lot.get("max_notional", "0")
    dedupe_key = _text(promotion_lot.get("dedupe_key"))
    active_dedupe_keys = set(
        _strings(repair_bid_settlement_ledger.get("active_dedupe_keys"))
    )
    hold_reason_codes = _strings(promotion_lot.get("hold_reason_codes"))
    non_economic_holds = [
        reason
        for reason in hold_reason_codes
        if reason not in _REPAIR_ECONOMICS_HOLD_REASONS
    ]

    reason_codes: list[str] = []
    if revenue_ready:
        reason_codes.append("revenue_already_ready")
    if business_state != "repair_only":
        reason_codes.append(f"business_state_{business_state or 'unknown'}")
    if not _routeable_candidate_top_blocker(top_blocker):
        reason_codes.append("revenue_repair_top_gate_not_routeable_candidate_count")
    if not promotion_lot:
        reason_codes.append("promotion_custody_lot_missing")
    if not _zero_notional(ledger_max_notional):
        reason_codes.append("repair_bid_settlement_notional_nonzero")
    if not _zero_notional(capital_max_notional):
        reason_codes.append("capital_notional_nonzero")
    if promotion_lot and not _zero_notional(lot_max_notional):
        reason_codes.append("promotion_custody_lot_notional_nonzero")
    if dedupe_key and dedupe_key in active_dedupe_keys:
        reason_codes.append("dedupe_key_active")
    if non_economic_holds:
        reason_codes.extend(non_economic_holds)

    slot_state = "inactive"
    if promotion_lot:
        slot_state = "dispatchable" if not reason_codes else "held"
    if any(reason.endswith("_nonzero") for reason in reason_codes):
        slot_state = "blocked"

    promotion_lot_id = _text(promotion_lot.get("lot_id")) or None
    digest_ref = _ref(
        "torghut-revenue-repair-digest",
        {
            "generated_at": generated.isoformat(),
            "top_blocker": dict(top_blocker),
            "repair_bid_settlement_ledger_id": repair_bid_settlement_ledger.get(
                "ledger_id"
            ),
            "business_state": business_state,
        },
    )
    slot_id = _ref(
        "alpha-readiness-strike-slot",
        {
            "lot_id": promotion_lot_id,
            "dedupe_key": dedupe_key,
            "slot_state": slot_state,
            "top_blocker": dict(top_blocker),
        },
    )
    ledger_id = _ref(
        "alpha-readiness-strike-ledger",
        {
            "account_id": repair_bid_settlement_ledger.get("account_id"),
            "window": repair_bid_settlement_ledger.get("session_id"),
            "promotion_lot_id": promotion_lot_id,
            "slot_state": slot_state,
            "digest_ref": digest_ref,
        },
    )

    strike_slots: list[dict[str, object]] = []
    if promotion_lot:
        strike_slots.append(
            {
                "slot_id": slot_id,
                "lot_id": promotion_lot_id,
                "source_repair_bid_ids": _strings(promotion_lot.get("source_bid_ids")),
                "lot_class": "promotion_custody",
                "target_value_gate": "routeable_candidate_count",
                "admission_reason": "revenue_queue_top_gate",
                "preempted_lot_class": "lower_revenue_priority_repair",
                "dedupe_key": dedupe_key,
                "ttl_seconds": _int(promotion_lot.get("ttl_seconds"), 900),
                "max_runtime_seconds": _int(
                    promotion_lot.get("max_runtime_seconds"), 1200
                ),
                "state": slot_state,
                "required_output_receipt": PROMOTION_CUSTODY_RECEIPT_SCHEMA_VERSION,
                "capital_rule": "zero_notional_repair_only",
                "max_notional": "0",
                "hold_reason_codes": reason_codes,
            }
        )

    required_after_receipts = [
        PROMOTION_CUSTODY_RECEIPT_SCHEMA_VERSION,
        *_strings(top_blocker.get("required_receipts")),
    ]

    return {
        "schema_version": ALPHA_READINESS_STRIKE_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "account_id": _text(repair_bid_settlement_ledger.get("account_id"), "unknown"),
        "window": _text(repair_bid_settlement_ledger.get("session_id"), "unknown"),
        "trading_mode": _text(
            repair_bid_settlement_ledger.get("trading_mode"), "unknown"
        ),
        "capital_stage": _text(capital.get("capital_stage"), "unknown"),
        "max_notional": "0",
        "status": slot_state,
        "revenue_repair_digest_ref": digest_ref,
        "selected_business_blocker": dict(top_blocker),
        "routeable_candidate_count_before": _int(
            repair_bid_settlement_ledger.get("routeable_candidate_count")
        ),
        "zero_notional_or_stale_evidence_rate_before": evidence.get(
            "routeability_acceptance", {}
        ).get("zero_notional_or_stale_evidence_rate")
        if isinstance(evidence.get("routeability_acceptance"), Mapping)
        else None,
        "promotion_custody_lot_ref": promotion_lot_id,
        "strike_slots": strike_slots,
        "candidate_replays": _candidate_replays(evidence),
        "required_after_receipts": required_after_receipts,
        "guarded_action_classes": _GUARDED_ACTION_CLASSES,
        "reason_codes": reason_codes,
        "rollback_target": _ROLLBACK_TARGET,
    }
