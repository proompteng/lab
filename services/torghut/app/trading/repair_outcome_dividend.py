"""Repair outcome dividend ledger for zero-notional repair lots."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, cast


REPAIR_OUTCOME_DIVIDEND_LEDGER_SCHEMA_VERSION = (
    "torghut.repair-outcome-dividend-ledger.v1"
)

_FRESHNESS_SECONDS = 60
_ZERO_NOTIONAL = "0"
_DOC_REFS = [
    "docs/torghut/design-system/v6/193-torghut-repair-outcome-dividend-ledger-and-capital-reentry-frontier-2026-05-13.md",
    "docs/torghut/design-system/v6/194-torghut-quant-plan-closeout-and-repair-only-handoff-2026-05-13.md",
    "swarm-validation-contract:every-run-cites-governing-requirement",
]
_VALUE_GATES = [
    "post_cost_daily_net_pnl",
    "routeable_candidate_count",
    "zero_notional_or_stale_evidence_rate",
    "fill_tca_or_slippage_quality",
    "capital_gate_safety",
]
_TERMINAL_STATE_ALIASES = {
    "complete": "succeeded",
    "completed": "succeeded",
    "ok": "succeeded",
    "success": "succeeded",
    "successful": "succeeded",
    "error": "failed",
    "errored": "failed",
    "cancelled": "superseded",
    "canceled": "superseded",
    "timeout": "timed_out",
}
_TERMINAL_STATES = {"pending", "succeeded", "failed", "timed_out", "superseded"}


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


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "allow", "allowed", "ok"}:
            return True
        if normalized in {"0", "false", "no", "off", "block", "blocked", "hold"}:
            return False
    return default


def _int(value: object, default: int = 0) -> int:
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return default


def _unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _strings(value: object) -> list[str]:
    return _unique([_text(item) for item in _sequence(value)])


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _fresh(value: datetime) -> str:
    return (value + timedelta(seconds=_FRESHNESS_SECONDS)).isoformat()


def _lot_id(lot: Mapping[str, Any]) -> str:
    return _text(lot.get("lot_id"))


def _expected_reason_codes(lot: Mapping[str, Any]) -> list[str]:
    reasons = _strings(lot.get("raw_reason_codes"))
    if reasons:
        return reasons
    expected_delta = _text(lot.get("expected_gate_delta"))
    if expected_delta.startswith("retire_"):
        return [expected_delta.removeprefix("retire_")]
    return []


def _dispatch_ticket_id(
    *,
    account_label: str,
    window: str,
    lot: Mapping[str, Any],
    settlement_ledger_id: object,
) -> str:
    return _stable_ref(
        "repair-outcome-dispatch-ticket",
        {
            "account_label": account_label,
            "window": window,
            "lot_id": _lot_id(lot),
            "lot_class": lot.get("lot_class"),
            "settlement_ledger_id": settlement_ledger_id,
        },
    )


def _terminal_state(receipt: Mapping[str, Any]) -> str:
    raw = _text(
        receipt.get("terminal_state")
        or receipt.get("status")
        or receipt.get("state")
        or receipt.get("outcome"),
        "pending",
    ).lower()
    normalized = _TERMINAL_STATE_ALIASES.get(raw, raw)
    return normalized if normalized in _TERMINAL_STATES else "pending"


def _receipt_index(
    receipts: Sequence[Mapping[str, object]] | None,
) -> dict[str, Mapping[str, object]]:
    by_lot: dict[str, Mapping[str, object]] = {}
    for receipt in receipts or ():
        lot_id = _text(
            receipt.get("repair_lot_id")
            or receipt.get("lot_id")
            or receipt.get("source_lot_ref")
        )
        if lot_id:
            by_lot[lot_id] = receipt
    return by_lot


def _pending_receipt(
    *,
    account_label: str,
    window: str,
    lot: Mapping[str, Any],
    generated_at: datetime,
    settlement_ledger: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    repair_receipt_frontier: Mapping[str, Any],
) -> dict[str, object]:
    lot_id = _lot_id(lot)
    dispatch_ticket_id = _dispatch_ticket_id(
        account_label=account_label,
        window=window,
        lot=lot,
        settlement_ledger_id=settlement_ledger.get("ledger_id"),
    )
    expected_reasons = _expected_reason_codes(lot)
    receipt_id = _stable_ref(
        "repair-outcome-receipt",
        {
            "lot_id": lot_id,
            "dispatch_ticket_id": dispatch_ticket_id,
            "receipt_schema": lot.get("required_output_receipt"),
            "expected_reason_codes": expected_reasons,
        },
    )
    return {
        "receipt_id": receipt_id,
        "repair_lot_id": lot_id,
        "dispatch_ticket_id": dispatch_ticket_id,
        "launched_agentrun_ref": lot.get("launched_agentrun_ref"),
        "lot_class": lot.get("lot_class"),
        "value_gate": lot.get("target_value_gate"),
        "expected_reason_code_delta": expected_reasons,
        "terminal_state": "pending",
        "outcome": "pending",
        "receipt_schema": lot.get("required_output_receipt"),
        "receipt_ref": None,
        "retired_reason_codes": [],
        "preserved_reason_codes": expected_reasons,
        "evidence_before_ref": settlement_ledger.get("ledger_id"),
        "evidence_after_ref": repair_receipt_frontier.get("frontier_id")
        or freshness_carry_ledger.get("ledger_id"),
        "measured_delta": {
            "state": "pending",
            "retired_reason_code_count": 0,
            "preserved_reason_code_count": len(expected_reasons),
            "routeable_candidate_delta": 0,
        },
        "dividend": "pending",
        "next_action": "hold",
        "max_notional": _ZERO_NOTIONAL,
        "rollback_target": "preserve open escrow, keep the repair lot queued, and keep max_notional=0",
        "generated_at": generated_at.isoformat(),
        "fresh_until": _fresh(generated_at),
    }


def _classified_receipt(
    *,
    lot: Mapping[str, Any],
    receipt: Mapping[str, object],
    generated_at: datetime,
    settlement_ledger: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    repair_receipt_frontier: Mapping[str, Any],
) -> dict[str, object]:
    lot_id = _lot_id(lot)
    expected_schema = _text(lot.get("required_output_receipt"))
    receipt_schema = _text(
        receipt.get("schema_version") or receipt.get("receipt_schema")
    )
    terminal_state = _terminal_state(receipt)
    expected_reasons = _expected_reason_codes(lot)
    retired_reason_codes = _strings(
        receipt.get("retired_reason_codes")
        or receipt.get("stale_reasons_retired")
        or receipt.get("reason_codes_retired")
    )
    preserved_reason_codes = _strings(
        receipt.get("preserved_reason_codes")
        or receipt.get("blocked_reasons")
        or receipt.get("stale_reasons_remaining")
    )
    if not preserved_reason_codes:
        preserved_reason_codes = [
            reason for reason in expected_reasons if reason not in retired_reason_codes
        ]
    invalid = bool(
        expected_schema and receipt_schema and receipt_schema != expected_schema
    )
    if terminal_state == "pending":
        outcome = "pending"
        dividend = "pending"
        next_action = "hold"
    elif invalid or not receipt_schema:
        outcome = "invalid_receipt"
        dividend = "invalid"
        next_action = "burn_credit"
    elif terminal_state in {"failed", "timed_out"}:
        outcome = "degraded"
        dividend = "negative"
        next_action = "burn_credit"
    elif retired_reason_codes:
        outcome = "retired_reason_codes"
        dividend = "positive"
        next_action = "release_credit"
    else:
        outcome = "no_delta"
        dividend = "zero"
        next_action = "roll_forward"

    receipt_id = _text(receipt.get("receipt_id")) or _stable_ref(
        "repair-outcome-receipt",
        {
            "lot_id": lot_id,
            "receipt_schema": receipt_schema or expected_schema,
            "terminal_state": terminal_state,
            "retired_reason_codes": retired_reason_codes,
            "preserved_reason_codes": preserved_reason_codes,
        },
    )
    return {
        "receipt_id": receipt_id,
        "repair_lot_id": lot_id,
        "dispatch_ticket_id": receipt.get("dispatch_ticket_id")
        or _stable_ref(
            "repair-outcome-dispatch-ticket",
            {"lot_id": lot_id, "receipt_id": receipt_id},
        ),
        "launched_agentrun_ref": receipt.get("launched_agentrun_ref"),
        "lot_class": receipt.get("lot_class") or lot.get("lot_class"),
        "value_gate": receipt.get("value_gate") or lot.get("target_value_gate"),
        "expected_reason_code_delta": expected_reasons,
        "terminal_state": terminal_state,
        "outcome": outcome,
        "receipt_schema": receipt_schema or expected_schema or "unknown",
        "receipt_ref": receipt.get("receipt_ref") or receipt_id,
        "retired_reason_codes": retired_reason_codes,
        "preserved_reason_codes": preserved_reason_codes,
        "evidence_before_ref": receipt.get("evidence_before_ref")
        or settlement_ledger.get("ledger_id"),
        "evidence_after_ref": receipt.get("evidence_after_ref")
        or repair_receipt_frontier.get("frontier_id")
        or freshness_carry_ledger.get("ledger_id"),
        "measured_delta": {
            "state": outcome,
            "retired_reason_code_count": len(retired_reason_codes),
            "preserved_reason_code_count": len(preserved_reason_codes),
            "routeable_candidate_delta": _int(
                receipt.get("routeable_candidate_delta")
                or _mapping(receipt.get("measured_delta")).get(
                    "routeable_candidate_delta"
                )
            ),
        },
        "dividend": dividend,
        "next_action": next_action,
        "max_notional": _ZERO_NOTIONAL,
        "rollback_target": receipt.get("rollback_target")
        or receipt.get("rollback_path")
        or "keep max_notional=0 and preserve the outcome receipt for audit",
        "generated_at": receipt.get("generated_at") or generated_at.isoformat(),
        "fresh_until": receipt.get("fresh_until") or _fresh(generated_at),
    }


def _open_escrow(receipt: Mapping[str, object]) -> dict[str, object]:
    return {
        "escrow_id": _stable_ref(
            "repair-outcome-escrow",
            {
                "repair_lot_id": receipt.get("repair_lot_id"),
                "dispatch_ticket_id": receipt.get("dispatch_ticket_id"),
                "receipt_schema": receipt.get("receipt_schema"),
            },
        ),
        "dispatch_ticket_id": receipt.get("dispatch_ticket_id"),
        "repair_lot_id": receipt.get("repair_lot_id"),
        "expected_output_receipt": receipt.get("receipt_schema"),
        "expected_reason_code_delta": _strings(
            receipt.get("expected_reason_code_delta")
        ),
        "launched_agentrun_ref": receipt.get("launched_agentrun_ref"),
        "terminal_state": receipt.get("terminal_state"),
        "outcome": receipt.get("outcome"),
        "retired_reason_codes": _strings(receipt.get("retired_reason_codes")),
        "preserved_reason_codes": _strings(receipt.get("preserved_reason_codes")),
        "next_action": receipt.get("next_action"),
        "max_notional": _ZERO_NOTIONAL,
    }


def _eligible_lots(
    repair_bid_settlement_ledger: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    lots: list[Mapping[str, Any]] = []
    for raw_lot in _sequence(repair_bid_settlement_ledger.get("compacted_lots")):
        lot = _mapping(raw_lot)
        if lot:
            lots.append(lot)
    return lots


def build_repair_outcome_dividend_ledger(
    *,
    account_label: str,
    window: str,
    trading_mode: str,
    repair_bid_settlement_ledger: Mapping[str, Any],
    repair_receipt_frontier: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    repair_outcome_receipts: Sequence[Mapping[str, object]] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build observe-mode outcome accounting without changing capital authority."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    settlement = _mapping(repair_bid_settlement_ledger)
    frontier = _mapping(repair_receipt_frontier)
    freshness = _mapping(freshness_carry_ledger)
    outcome_by_lot = _receipt_index(repair_outcome_receipts)
    receipts: list[dict[str, object]] = []
    for lot in _eligible_lots(settlement):
        lot_id = _lot_id(lot)
        if not lot_id:
            continue
        existing = outcome_by_lot.get(lot_id)
        if existing:
            receipts.append(
                _classified_receipt(
                    lot=lot,
                    receipt=existing,
                    generated_at=generated_at,
                    settlement_ledger=settlement,
                    freshness_carry_ledger=freshness,
                    repair_receipt_frontier=frontier,
                )
            )
        elif _bool(lot.get("dispatchable")):
            receipts.append(
                _pending_receipt(
                    account_label=account_label,
                    window=window,
                    lot=lot,
                    generated_at=generated_at,
                    settlement_ledger=settlement,
                    freshness_carry_ledger=freshness,
                    repair_receipt_frontier=frontier,
                )
            )

    open_escrows = [
        _open_escrow(receipt)
        for receipt in receipts
        if _text(receipt.get("terminal_state")) == "pending"
    ]
    no_delta_lots = [
        _text(receipt.get("repair_lot_id"))
        for receipt in receipts
        if _text(receipt.get("outcome")) == "no_delta"
    ]
    retired_reason_codes = _unique(
        [
            reason
            for receipt in receipts
            for reason in _strings(receipt.get("retired_reason_codes"))
        ]
    )
    preserved_reason_codes = _unique(
        [
            reason
            for receipt in receipts
            for reason in _strings(receipt.get("preserved_reason_codes"))
        ]
    )
    positive_receipts = [
        receipt for receipt in receipts if _text(receipt.get("dividend")) == "positive"
    ]
    negative_receipts = [
        receipt for receipt in receipts if _text(receipt.get("dividend")) == "negative"
    ]
    routeable_candidate_count = _int(settlement.get("routeable_candidate_count"))
    ledger_id = _stable_ref(
        "repair-outcome-dividend-ledger",
        {
            "account_label": account_label,
            "window": window,
            "repair_bid_settlement_ledger": settlement.get("ledger_id"),
            "repair_receipt_frontier": frontier.get("frontier_id"),
            "receipt_ids": [_text(receipt.get("receipt_id")) for receipt in receipts],
        },
    )
    return {
        "schema_version": REPAIR_OUTCOME_DIVIDEND_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": _fresh(generated_at),
        "account": account_label,
        "window": window,
        "trading_mode": trading_mode,
        "governing_design_refs": list(_DOC_REFS),
        "capital_stage": "shadow",
        "capital_state": "zero_notional",
        "max_notional": _ZERO_NOTIONAL,
        "live_submit_enabled": False,
        "source_repair_bid_settlement_ledger_id": settlement.get("ledger_id"),
        "repair_receipt_frontier_ref": frontier.get("frontier_id"),
        "freshness_carry_ledger_ref": freshness.get("ledger_id"),
        "route_warrant_ref": route_warrant_exchange.get("warrant_id")
        or route_warrant_exchange.get("exchange_id"),
        "live_submission_gate_ref": live_submission_gate.get("gate_id")
        or live_submission_gate.get("reason"),
        "outcome_receipts": receipts,
        "open_escrows": open_escrows,
        "no_delta_lots": no_delta_lots,
        "retired_reason_codes": retired_reason_codes,
        "preserved_reason_codes": preserved_reason_codes,
        "next_repair_frontier": {
            "source_frontier_ref": frontier.get("frontier_id"),
            "selected_lot_ids": _strings(settlement.get("selected_lot_ids")),
            "dispatchable_lot_ids": _strings(settlement.get("dispatchable_lot_ids")),
            "held_lot_ids": _strings(settlement.get("held_lot_ids")),
            "credit_release_lot_ids": [
                _text(receipt.get("repair_lot_id")) for receipt in positive_receipts[:1]
            ],
            "no_delta_lot_ids": no_delta_lots,
            "routeable_candidate_count": routeable_candidate_count,
            "max_notional": _ZERO_NOTIONAL,
        },
        "summary": {
            "outcome_receipt_count": len(receipts),
            "open_escrow_count": len(open_escrows),
            "no_delta_lot_count": len(no_delta_lots),
            "positive_dividend_count": len(positive_receipts),
            "negative_dividend_count": len(negative_receipts),
            "repair_receipt_binding_count": len(receipts),
            "retired_reason_code_count": len(retired_reason_codes),
            "preserved_reason_code_count": len(preserved_reason_codes),
            "routeable_candidate_count": routeable_candidate_count,
            "max_notional": _ZERO_NOTIONAL,
            "value_gates": list(_VALUE_GATES),
        },
        "rollback_target": {
            "repair_outcome_dividend_ledger_enabled": False,
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "fallback_payload": "torghut.repair-bid-settlement-ledger.v1",
            "preserve_outcome_receipts": True,
        },
    }


__all__ = [
    "REPAIR_OUTCOME_DIVIDEND_LEDGER_SCHEMA_VERSION",
    "build_repair_outcome_dividend_ledger",
]
