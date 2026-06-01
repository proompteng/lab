"""Route reacquisition board for zero-notional repair planning."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any, cast


SCHEMA_VERSION = "torghut.route-reacquisition-board.v1"
_CAPITAL_ALLOW_DECISIONS = {"allow"}


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


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


def _dimension_by_name(
    proof_floor_receipt: Mapping[str, Any],
) -> dict[str, Mapping[str, Any]]:
    dimensions: dict[str, Mapping[str, Any]] = {}
    for raw_dimension in _sequence(proof_floor_receipt.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        name = _text(dimension.get("dimension"))
        if name:
            dimensions[name] = dimension
    return dimensions


def _row_expected_unblock_value(record: Mapping[str, Any]) -> int:
    state = _text(record.get("state"))
    if state == "routeable":
        return 4
    if state == "probing":
        return 3
    if state == "blocked":
        return 2
    if state == "missing":
        return 1
    return 0


def _expected_cost_class(record: Mapping[str, Any]) -> str:
    state = _text(record.get("state"))
    action = _text(record.get("next_repair_action"))
    if state == "missing":
        return "medium_simulation_probe"
    if "slippage" in action:
        return "high_route_quality_repair"
    if state == "probing":
        return "low_receipt_settlement"
    if state == "routeable":
        return "low_maintenance"
    if state == "blocked":
        return "medium_route_evidence_repair"
    return "unknown"


def _expected_profit_effect(record: Mapping[str, Any]) -> str:
    state = _text(record.get("state"))
    filled = _int(record.get("filled_execution_count"))
    if state == "routeable":
        return "maintains_capital_candidate"
    if state == "probing":
        return "can_unlock_paper_candidate_after_receipts"
    if state == "missing":
        return "fills_route_evidence_gap"
    if filled >= 1000:
        return "repairs_high_activity_route"
    if state == "blocked":
        return "repairs_route_quality"
    return "none"


def _receipt_state(
    *, receipt_id: str | None, dimension_state: str
) -> dict[str, object]:
    return {
        "receipt_id": receipt_id,
        "state": "present" if receipt_id else dimension_state or "missing",
    }


def _jangar_continuity_packet(
    *,
    jangar_continuity: Mapping[str, Any] | None,
    jangar_broker_ref: str | None,
) -> dict[str, object]:
    payload = _mapping(jangar_continuity)
    epoch_id = _text(payload.get("epoch_id"), _text(jangar_broker_ref))
    decision = _text(
        payload.get("decision"),
        "allow" if epoch_id else "missing",
    )
    state = _text(
        payload.get("state"),
        "present" if epoch_id else "missing",
    )
    fresh_until = payload.get("fresh_until")
    blocking_reasons = [
        _text(item)
        for item in _sequence(payload.get("blocking_reasons"))
        if _text(item)
    ]
    if not epoch_id and "jangar_continuity_epoch_missing" not in blocking_reasons:
        blocking_reasons.append("jangar_continuity_epoch_missing")
    if decision not in _CAPITAL_ALLOW_DECISIONS and not blocking_reasons:
        blocking_reasons.append(f"jangar_continuity_{decision}")
    return {
        "epoch_id": epoch_id or None,
        "state": state,
        "decision": decision,
        "fresh_until": fresh_until,
        "blocking_reasons": blocking_reasons,
    }


def _continuity_allows_capital(continuity: Mapping[str, object]) -> bool:
    return (
        _text(continuity.get("state")) == "present"
        and _text(continuity.get("decision")) in _CAPITAL_ALLOW_DECISIONS
    )


def _required_receipts(
    *,
    record: Mapping[str, Any],
    dimensions: Mapping[str, Mapping[str, Any]],
    jangar_continuity: Mapping[str, object],
) -> dict[str, object]:
    tca_dimension = _mapping(dimensions.get("execution_tca"))
    market_context_dimension = _mapping(dimensions.get("market_context"))
    quant_dimension = _mapping(dimensions.get("quant_ingestion"))
    alpha_dimension = _mapping(dimensions.get("alpha_readiness"))
    hypothesis_ids = [
        _text(item) for item in _sequence(record.get("hypothesis_ids")) if _text(item)
    ]
    return {
        "route_repair_audit_receipt": {
            "receipt_id": record.get("audit_receipt_ref"),
            "state": "present" if record.get("audit_receipt_ref") else "missing",
            "promotion_authority": False,
        },
        "tca_route_receipt": {
            "last_computed_at": record.get("last_computed_at"),
            "state": _text(tca_dimension.get("state"), "missing"),
            "reason": _text(tca_dimension.get("reason")),
        },
        "market_context_receipt": _receipt_state(
            receipt_id=cast(str | None, record.get("market_context_receipt_id")),
            dimension_state=_text(market_context_dimension.get("state"), "missing"),
        ),
        "quant_pipeline_receipt": _receipt_state(
            receipt_id=cast(str | None, record.get("quant_pipeline_receipt_id")),
            dimension_state=_text(quant_dimension.get("state"), "missing"),
        ),
        "alpha_readiness_receipt": {
            "hypothesis_ids": sorted(set(hypothesis_ids)),
            "state": "present"
            if hypothesis_ids
            else _text(alpha_dimension.get("state"), "missing"),
        },
        "jangar_continuity_epoch": {
            "epoch_id": jangar_continuity.get("epoch_id"),
            "decision": jangar_continuity.get("decision"),
            "fresh_until": jangar_continuity.get("fresh_until"),
            "state": jangar_continuity.get("state"),
            "blocking_reasons": list(
                _sequence(jangar_continuity.get("blocking_reasons"))
            ),
        },
        "jangar_proof_packet": {
            "ref": jangar_continuity.get("epoch_id"),
            "state": jangar_continuity.get("state"),
        },
    }


def _board_row(
    *,
    record: Mapping[str, Any],
    account_label: str,
    dimensions: Mapping[str, Mapping[str, Any]],
    zero_notional_hold: bool,
    jangar_continuity: Mapping[str, object],
) -> dict[str, object]:
    symbol = _text(record.get("symbol"), "unknown")
    state = _text(record.get("state"), "unknown")
    reason = _text(record.get("reason"), "unknown")
    row_id = f"route-repair:{account_label or 'unknown'}:{symbol}:{state}:{reason}"
    return {
        "proof_packet_id": row_id,
        "symbol": symbol,
        "hypothesis_ids": [
            _text(item)
            for item in _sequence(record.get("hypothesis_ids"))
            if _text(item)
        ],
        "state": state,
        "current_blocker": reason,
        "repair_action": _text(record.get("next_repair_action")),
        "repair_recommendation": _text(record.get("repair_recommendation")),
        "source_metadata": dict(_mapping(record.get("source_metadata"))),
        "audit_receipt": dict(_mapping(record.get("audit_receipt"))),
        "audit_receipt_ref": record.get("audit_receipt_ref"),
        "promotion_authority": False,
        "capital_authority": "none",
        "expected_unblock_value": _row_expected_unblock_value(record),
        "expected_cost_class": _expected_cost_class(record),
        "expected_profit_effect": _expected_profit_effect(record),
        "required_receipts": _required_receipts(
            record=record,
            dimensions=dimensions,
            jangar_continuity=jangar_continuity,
        ),
        "max_notional": "0"
        if zero_notional_hold
        else _text(record.get("paper_probe_notional_limit"), "0"),
        "rollback_target": {
            "state": "blocked" if zero_notional_hold else state,
            "live_submit_enabled": False,
            "promotion_authority": False,
        },
    }


def _rank_row(row: Mapping[str, object]) -> tuple[int, int, str]:
    state = _text(row.get("state"))
    state_rank = {"probing": 0, "blocked": 1, "missing": 2, "routeable": 3}.get(
        state, 4
    )
    return (
        state_rank,
        -_int(row.get("expected_unblock_value")),
        _text(row.get("symbol")),
    )


def build_route_reacquisition_board(
    *,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_book: Mapping[str, Any] | None = None,
    active_revision: str | None = None,
    jangar_continuity: Mapping[str, Any] | None = None,
    jangar_broker_ref: str | None = None,
) -> dict[str, object]:
    """Build an observe-only route repair board from proof floor and route book.

    The board is not an authorization surface. It keeps notional at zero while
    the proof floor is repair-only, and only makes repair packets measurable.
    """

    route_book = route_reacquisition_book or _mapping(
        proof_floor_receipt.get("route_reacquisition_book")
    )
    dimensions = _dimension_by_name(proof_floor_receipt)
    account_label = _text(
        route_book.get("account_label"), _text(proof_floor_receipt.get("account_label"))
    )
    repair_only = (
        _text(proof_floor_receipt.get("route_state")) == "repair_only"
        or _text(proof_floor_receipt.get("capital_state")) == "zero_notional"
    )
    continuity = _jangar_continuity_packet(
        jangar_continuity=jangar_continuity,
        jangar_broker_ref=jangar_broker_ref,
    )
    continuity_allows_capital = _continuity_allows_capital(continuity)
    zero_notional_hold = repair_only or not continuity_allows_capital
    rows = sorted(
        [
            _board_row(
                record=_mapping(raw_record),
                account_label=account_label,
                dimensions=dimensions,
                zero_notional_hold=zero_notional_hold,
                jangar_continuity=continuity,
            )
            for raw_record in _sequence(route_book.get("records"))
            if _text(_mapping(raw_record).get("symbol"))
        ],
        key=_rank_row,
    )
    state_counts = Counter(_text(row.get("state")) for row in rows)
    expected_unblock_value = sum(
        _int(row.get("expected_unblock_value")) for row in rows
    )
    zero_notional_rows = sum(1 for row in rows if _text(row.get("max_notional")) == "0")
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": route_book.get("generated_at")
        or proof_floor_receipt.get("generated_at"),
        "account_label": account_label or None,
        "trading_mode": route_book.get("trading_mode"),
        "active_revision": active_revision
        or proof_floor_receipt.get("torghut_revision"),
        "jangar_broker_ref": continuity.get("epoch_id"),
        "jangar_continuity": continuity,
        "jangar_continuity_epoch_id": continuity.get("epoch_id"),
        "jangar_continuity_decision": continuity.get("decision"),
        "capital_state": proof_floor_receipt.get("capital_state"),
        "market_session_open": route_book.get("market_session_open"),
        "state": "repair_only" if repair_only else "candidate",
        "promotion_authority": False,
        "authority_semantics": "audit_only_until_source_backed_runtime_ledger_fill_proof",
        "capital_rule": "zero_notional_until_receipts_close"
        if repair_only
        else "zero_notional_until_jangar_continuity"
        if not continuity_allows_capital
        else "paper_probe_requires_receipt_chain",
        "blocking_reasons": list(_sequence(continuity.get("blocking_reasons")))
        if not continuity_allows_capital
        else [],
        "rows": rows,
        "summary": {
            "row_count": len(rows),
            "state_counts": dict(sorted(state_counts.items())),
            "zero_notional_row_count": zero_notional_rows,
            "expected_unblock_value": expected_unblock_value,
            "top_repair_symbols": [
                _text(row.get("symbol"))
                for row in rows
                if _text(row.get("state")) in {"probing", "blocked", "missing"}
            ][:5],
            "capital_eligible_symbol_count": 0
            if zero_notional_hold
            else state_counts.get("routeable", 0),
            "jangar_continuity_decision": continuity.get("decision"),
            "jangar_continuity_blocking_reasons": list(
                _sequence(continuity.get("blocking_reasons"))
            ),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "promotion_authority": False,
        },
    }


__all__ = ["build_route_reacquisition_board"]
