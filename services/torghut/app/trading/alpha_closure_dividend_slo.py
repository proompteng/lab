"""Compact alpha closure dividend SLO (standalone internal)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, cast


ALPHA_CLOSURE_DIVIDEND_SLO_SCHEMA_VERSION = "torghut.alpha-closure-dividend-slo.v1"

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "203-torghut-alpha-closure-dividend-slo-and-consumer-evidence-carry-2026-05-14.md"
)
_ZERO_NOTIONAL_VALUES = {"0", "0.0", "0.00", "0.0000"}
_ROLLBACK_TARGET = (
    "disable alpha_closure_dividend_slo emission and keep Torghut max_notional=0"
)


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


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


def _string_list(value: object) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in _sequence(value):
        normalized = _text(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _append_unique(items: list[str], *values: object) -> list[str]:
    seen = set(items)
    for value in values:
        candidates = _string_list(value) if _sequence(value) else [_text(value)]
        for candidate in candidates:
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            items.append(candidate)
    return items


def _stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _parse_datetime(value: object) -> datetime | None:
    raw = _text(value)
    if not raw:
        return None
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _is_zero_notional(value: object) -> bool:
    normalized = _text(value)
    if normalized in _ZERO_NOTIONAL_VALUES:
        return True
    try:
        return float(normalized) == 0
    except ValueError:
        return False


def _closure_market(board: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(board.get("alpha_closure_settlement_market"))


def _pending_receipt(market: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(market.get("pending_settlement_receipt"))


def _no_delta_budget(market: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(market.get("no_delta_budget"))


def _first_closure(board: Mapping[str, Any]) -> Mapping[str, Any]:
    for raw_closure in _sequence(board.get("repair_closures")):
        closure = _mapping(raw_closure)
        if closure:
            return closure
    return {}


def _state_from_inputs(
    *,
    reason_codes: Sequence[str],
    measured_delta: int,
    retired_reason_codes: Sequence[str],
    preserved_reason_codes: Sequence[str],
    no_delta_budget_state: str,
    no_delta_debt_count: int,
) -> str:
    reason_set = set(reason_codes)
    if reason_set.intersection(
        {
            "alpha_closure_board_missing",
            "alpha_closure_settlement_market_missing",
            "alpha_closure_required_settlement_receipt_missing",
            "alpha_closure_capital_not_zero_notional",
            "alpha_closure_capital_rule_not_zero_notional",
        }
    ):
        return "invalid"
    if "alpha_closure_dividend_slo_stale" in reason_set:
        return "stale"
    if measured_delta > 0 or retired_reason_codes:
        return "paid"
    if (
        preserved_reason_codes
        or no_delta_budget_state == "consumed"
        or no_delta_debt_count > 0
    ):
        return "no_delta"
    return "pending"


def build_alpha_closure_dividend_slo(
    *,
    generated_at: datetime,
    alpha_repair_closure_board: Mapping[str, Any] | None,
    alpha_repair_dividend_ledger: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Build the compact dividend SLO (standalone internal)."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    board = _mapping(alpha_repair_closure_board)
    ledger = _mapping(alpha_repair_dividend_ledger)
    market = _closure_market(board)
    receipt = _pending_receipt(market)
    closure = _first_closure(board)
    no_delta_budget = _no_delta_budget(market)

    routeable_before = _int(
        receipt.get("routeable_candidate_count_before"),
        _int(ledger.get("routeable_candidate_count_before")),
    )
    routeable_after = _int(
        receipt.get("routeable_candidate_count_after"),
        _int(ledger.get("routeable_candidate_count_after"), routeable_before),
    )
    measured_delta = _int(
        receipt.get("measured_delta"),
        _int(ledger.get("measured_delta"), routeable_after - routeable_before),
    )
    retired_reason_codes = _string_list(
        receipt.get("retired_reason_codes")
    ) or _string_list(ledger.get("retired_reason_codes"))
    preserved_reason_codes = (
        _string_list(receipt.get("preserved_reason_codes"))
        or _string_list(ledger.get("preserved_reason_codes"))
        or _string_list(closure.get("before_reason_codes"))
    )
    introduced_reason_codes = _string_list(
        receipt.get("introduced_reason_codes")
    ) or _string_list(ledger.get("introduced_reason_codes"))
    no_delta_debt_count = len(_sequence(board.get("no_delta_debt")))
    if no_delta_debt_count == 0:
        no_delta_debt_count = _int(ledger.get("no_delta_debt_count"))
    no_delta_budget_state = _text(
        no_delta_budget.get("state"), _text(ledger.get("no_delta_budget_state"))
    )
    max_notional = _text(
        market.get("max_notional"),
        _text(board.get("max_notional"), _text(ledger.get("max_notional"), "0")),
    )
    capital_rule = _text(
        market.get("capital_rule"),
        _text(
            board.get("capital_rule"),
            _text(ledger.get("capital_rule"), "zero_notional_repair_only"),
        ),
    )
    fresh_until = (
        _text(board.get("fresh_until"))
        or _text(market.get("fresh_until"))
        or _text(ledger.get("fresh_until"))
        or generated.isoformat()
    )
    fresh_until_dt = _parse_datetime(fresh_until)

    reason_codes: list[str] = []
    if not board:
        reason_codes.append("alpha_closure_board_missing")
    if board and not market:
        reason_codes.append("alpha_closure_settlement_market_missing")
    if fresh_until_dt is not None and fresh_until_dt <= generated:
        reason_codes.append("alpha_closure_dividend_slo_stale")
    if not _text(market.get("required_output_receipt")):
        reason_codes.append("alpha_closure_required_settlement_receipt_missing")
    if not _is_zero_notional(max_notional):
        reason_codes.append("alpha_closure_capital_not_zero_notional")
    if capital_rule != "zero_notional_repair_only":
        reason_codes.append("alpha_closure_capital_rule_not_zero_notional")

    dividend_state = _state_from_inputs(
        reason_codes=reason_codes,
        measured_delta=measured_delta,
        retired_reason_codes=retired_reason_codes,
        preserved_reason_codes=preserved_reason_codes,
        no_delta_budget_state=no_delta_budget_state,
        no_delta_debt_count=no_delta_debt_count,
    )
    if dividend_state == "no_delta":
        reason_codes = _append_unique(
            reason_codes,
            "alpha_closure_no_delta_active",
            "alpha_closure_no_delta_budget_consumed"
            if no_delta_budget_state == "consumed"
            else "",
            "alpha_closure_no_delta_debt_active" if no_delta_debt_count > 0 else "",
        )

    selected_hypothesis_id = (
        _text(market.get("selected_hypothesis_id"))
        or _text(receipt.get("hypothesis_id"))
        or _text(ledger.get("selected_hypothesis_id"))
        or _text(closure.get("hypothesis_id"))
    )
    source_revenue_repair_ref = (
        _text(market.get("source_revenue_repair_ref"))
        or _text(ledger.get("source_revenue_repair_ref"))
        or "torghut-revenue-repair-digest:unknown"
    )
    slo_id = "alpha-closure-dividend-slo:" + _stable_hash(
        "alpha-closure-dividend-slo",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "source_board_ref": _text(board.get("board_id")),
            "source_settlement_market_ref": _text(market.get("market_id")),
            "selected_hypothesis_id": selected_hypothesis_id,
            "dividend_state": dividend_state,
            "routeable_before": routeable_before,
            "routeable_after": routeable_after,
        },
    )
    validation_commands = _append_unique(
        _string_list(receipt.get("validation_commands")),
        ledger.get("validation_commands"),
        closure.get("validation_commands"),
        "uv run --frozen pytest services/torghut/tests/test_alpha_closure_dividend_slo.py",
    )

    return {
        "schema_version": ALPHA_CLOSURE_DIVIDEND_SLO_SCHEMA_VERSION,
        "slo_id": slo_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until,
        "governing_design_ref": _DESIGN_REF,
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "source_board_ref": _text(board.get("board_id")) or None,
        "source_settlement_market_ref": _text(market.get("market_id")) or None,
        "selected_hypothesis_id": selected_hypothesis_id or None,
        "selected_value_gate": _text(
            market.get("selected_value_gate"),
            _text(board.get("selected_value_gate"), "routeable_candidate_count"),
        ),
        "selected_repair_class": _text(
            market.get("selected_repair_class"),
            _text(ledger.get("selected_repair_class"), "alpha_readiness"),
        ),
        "required_settlement_receipt": _text(market.get("required_output_receipt"))
        or None,
        "active_dedupe_key": _text(market.get("active_dedupe_key"))
        or _text(ledger.get("no_delta_release_key"))
        or None,
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "measured_delta": measured_delta,
        "dividend_state": dividend_state,
        "retired_reason_codes": retired_reason_codes,
        "preserved_reason_codes": preserved_reason_codes,
        "introduced_reason_codes": introduced_reason_codes,
        "no_delta_budget_state": no_delta_budget_state or None,
        "no_delta_debt_count": no_delta_debt_count,
        "release_conditions": _append_unique(
            _string_list(no_delta_budget.get("release_conditions")),
            ledger.get("no_delta_release_conditions"),
        ),
        "next_allowed_attempt_after": _text(
            receipt.get("next_allowed_attempt_after"),
            _text(ledger.get("next_allowed_attempt_after")),
        )
        or None,
        "validation_commands": validation_commands,
        "enforcement_mode": "observe",
        "max_notional": max_notional,
        "capital_rule": capital_rule,
        "reason_codes": reason_codes,
        "rollback_target": _ROLLBACK_TARGET,
    }


__all__ = [
    "ALPHA_CLOSURE_DIVIDEND_SLO_SCHEMA_VERSION",
    "build_alpha_closure_dividend_slo",
]
