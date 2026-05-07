"""Route reacquisition book for proof-floor repair work."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast


SCHEMA_VERSION = "torghut.route-reacquisition-book.v1"


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


def _float(value: object) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _dimension(
    proof_floor_receipt: Mapping[str, Any], dimension_name: str
) -> Mapping[str, Any]:
    for raw_dimension in _sequence(proof_floor_receipt.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) == dimension_name:
            return dimension
    return {}


def _source_ref(dimension: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(dimension.get("source_ref"))


def _state_is_pass(dimension: Mapping[str, Any]) -> bool:
    return _text(dimension.get("state")) in {"pass", "informational"}


def _receipt_id(source_ref: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = _text(source_ref.get(key))
        if value:
            return value
    return None


def _hypothesis_ids(source_ref: Mapping[str, Any]) -> list[str]:
    ids: list[str] = []
    for key in ("hypothesis_ids", "candidate_ids"):
        for value in _sequence(source_ref.get(key)):
            normalized = _text(value)
            if normalized:
                ids.append(normalized)
    return sorted(set(ids))


def _next_action(*, state: str, reason: str) -> str:
    if state == "missing":
        return "create_simulation_probe_before_capital"
    if state == "blocked" and "slippage" in reason:
        return "reduce_execution_slippage_before_route_reentry"
    if state == "blocked":
        return "repair_route_evidence_before_paper_probe"
    if state == "probing":
        return "settle_market_context_quant_and_alpha_receipts_before_paper_probe"
    if state == "routeable":
        return "maintain_route_tca_and_wait_for_capital_gate"
    return "retire_symbol_until_evidence_returns"


def _record_from_symbol(
    *,
    symbol_payload: Mapping[str, Any],
    account_label: str | None,
    state: str,
    reason: str,
    tca_source_ref: Mapping[str, Any],
    market_context_source_ref: Mapping[str, Any],
    quant_source_ref: Mapping[str, Any],
    alpha_source_ref: Mapping[str, Any],
) -> dict[str, object]:
    symbol = _text(symbol_payload.get("symbol"))
    filled_execution_count = _int(
        symbol_payload.get("filled_execution_count"),
        _int(symbol_payload.get("order_count")),
    )
    return {
        "symbol": symbol,
        "account_label": account_label,
        "state": state,
        "reason": reason,
        "avg_abs_slippage_bps": symbol_payload.get("avg_abs_slippage_bps"),
        "max_abs_slippage_bps": symbol_payload.get("max_abs_slippage_bps"),
        "slippage_guardrail_bps": tca_source_ref.get("slippage_guardrail_bps"),
        "filled_execution_count": filled_execution_count,
        "unsettled_execution_count": _int(
            tca_source_ref.get("unsettled_execution_count")
        ),
        "last_computed_at": symbol_payload.get("last_computed_at"),
        "market_context_receipt_id": _receipt_id(
            market_context_source_ref,
            "receipt_id",
            "last_receipt_id",
            "repair_cell_receipt_id",
        ),
        "quant_pipeline_receipt_id": _receipt_id(
            quant_source_ref,
            "receipt_id",
            "last_receipt_id",
            "quant_pipeline_receipt_id",
        ),
        "hypothesis_ids": _hypothesis_ids(alpha_source_ref),
        "paper_probe_notional_limit": "0",
        "rollback_trigger": reason,
        "next_repair_action": _next_action(state=state, reason=reason),
    }


def _missing_record(
    *,
    symbol: str,
    account_label: str | None,
    tca_source_ref: Mapping[str, Any],
    market_context_source_ref: Mapping[str, Any],
    quant_source_ref: Mapping[str, Any],
    alpha_source_ref: Mapping[str, Any],
) -> dict[str, object]:
    return _record_from_symbol(
        symbol_payload={
            "symbol": symbol,
            "order_count": 0,
            "avg_abs_slippage_bps": None,
            "max_abs_slippage_bps": None,
            "last_computed_at": None,
        },
        account_label=account_label,
        state="missing",
        reason="execution_tca_symbol_missing",
        tca_source_ref=tca_source_ref,
        market_context_source_ref=market_context_source_ref,
        quant_source_ref=quant_source_ref,
        alpha_source_ref=alpha_source_ref,
    )


def _repair_candidate_rank(record: Mapping[str, object]) -> tuple[int, float, int, str]:
    state = _text(record.get("state"))
    state_rank = {"blocked": 0, "missing": 1, "retired": 2}.get(state, 3)
    slippage = _float(record.get("avg_abs_slippage_bps"))
    filled = _int(record.get("filled_execution_count"))
    return (
        state_rank,
        slippage if slippage is not None else float("inf"),
        -filled,
        _text(record.get("symbol")),
    )


def _repair_candidate(record: Mapping[str, object], *, rank: int) -> dict[str, object]:
    return {
        "rank": rank,
        "symbol": _text(record.get("symbol")),
        "state": _text(record.get("state")),
        "reason": _text(record.get("reason")),
        "avg_abs_slippage_bps": record.get("avg_abs_slippage_bps"),
        "slippage_guardrail_bps": record.get("slippage_guardrail_bps"),
        "filled_execution_count": _int(record.get("filled_execution_count")),
        "paper_probe_notional_limit": "0",
        "next_repair_action": _text(record.get("next_repair_action")),
    }


def build_route_reacquisition_book(
    *,
    proof_floor_receipt: Mapping[str, Any],
    trading_mode: str,
    market_session_open: bool | None,
) -> dict[str, object]:
    """Build a symbol-level route repair book from proof-floor source refs.

    The book is diagnostic and repair-oriented. It never authorizes live submit
    or notional by itself; it makes the next revenue repair explicit.
    """

    tca_dimension = _dimension(proof_floor_receipt, "execution_tca")
    market_context_dimension = _dimension(proof_floor_receipt, "market_context")
    quant_dimension = _dimension(proof_floor_receipt, "quant_ingestion")
    alpha_dimension = _dimension(proof_floor_receipt, "alpha_readiness")

    tca_source_ref = _source_ref(tca_dimension)
    market_context_source_ref = _source_ref(market_context_dimension)
    quant_source_ref = _source_ref(quant_dimension)
    alpha_source_ref = _source_ref(alpha_dimension)
    symbol_routes = _mapping(tca_source_ref.get("symbol_routes"))
    account_label = cast(str | None, proof_floor_receipt.get("account_label"))
    generated_at = proof_floor_receipt.get("generated_at")

    market_context_pass = _state_is_pass(market_context_dimension)
    quant_pass = _state_is_pass(quant_dimension)
    alpha_pass = _state_is_pass(alpha_dimension)
    unsettled_count = _int(tca_source_ref.get("unsettled_execution_count"))
    dependency_pass = (
        market_context_pass and quant_pass and alpha_pass and unsettled_count <= 0
    )

    records: list[dict[str, object]] = []
    for raw_symbol in _sequence(symbol_routes.get("routeable_symbols")):
        symbol_payload = _mapping(raw_symbol)
        if not _text(symbol_payload.get("symbol")):
            continue
        state = "routeable" if dependency_pass else "probing"
        reason = (
            "route_tca_passed"
            if dependency_pass
            else "route_tca_passed_but_dependency_receipts_block_capital"
        )
        records.append(
            _record_from_symbol(
                symbol_payload=symbol_payload,
                account_label=account_label,
                state=state,
                reason=reason,
                tca_source_ref=tca_source_ref,
                market_context_source_ref=market_context_source_ref,
                quant_source_ref=quant_source_ref,
                alpha_source_ref=alpha_source_ref,
            )
        )
    for raw_symbol in _sequence(symbol_routes.get("blocked_symbols")):
        symbol_payload = _mapping(raw_symbol)
        if not _text(symbol_payload.get("symbol")):
            continue
        records.append(
            _record_from_symbol(
                symbol_payload=symbol_payload,
                account_label=account_label,
                state="blocked",
                reason=_text(tca_dimension.get("reason"), "execution_tca_blocked"),
                tca_source_ref=tca_source_ref,
                market_context_source_ref=market_context_source_ref,
                quant_source_ref=quant_source_ref,
                alpha_source_ref=alpha_source_ref,
            )
        )
    for raw_symbol in _sequence(symbol_routes.get("missing_symbols")):
        symbol = _text(raw_symbol)
        if not symbol:
            continue
        records.append(
            _missing_record(
                symbol=symbol,
                account_label=account_label,
                tca_source_ref=tca_source_ref,
                market_context_source_ref=market_context_source_ref,
                quant_source_ref=quant_source_ref,
                alpha_source_ref=alpha_source_ref,
            )
        )

    counts = {
        "routeable": sum(1 for item in records if item["state"] == "routeable"),
        "probing": sum(1 for item in records if item["state"] == "probing"),
        "blocked": sum(1 for item in records if item["state"] == "blocked"),
        "missing": sum(1 for item in records if item["state"] == "missing"),
        "retired": sum(1 for item in records if item["state"] == "retired"),
    }
    candidate_symbols = [
        _text(item.get("symbol"))
        for item in records
        if _text(item.get("state")) in {"routeable", "probing"}
    ]
    repair_source_records = sorted(
        (
            record
            for record in records
            if _text(record.get("state")) in {"blocked", "missing"}
        ),
        key=_repair_candidate_rank,
    )
    repair_candidates = [
        _repair_candidate(record, rank=index + 1)
        for index, record in enumerate(repair_source_records)
    ]
    expected_unblock_value = (
        counts["blocked"] * 2
        + counts["missing"]
        + counts["probing"] * 3
        + counts["routeable"] * 4
    )
    live_mode = trading_mode == "live"
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "account_label": account_label,
        "trading_mode": trading_mode,
        "market_session_open": market_session_open,
        "state": "repair_only"
        if _text(proof_floor_receipt.get("route_state")) == "repair_only"
        else "candidate",
        "capital_rule": "live_zero_notional_unchanged"
        if live_mode
        else "paper_probe_requires_receipt_chain",
        "records": records,
        "summary": {
            "scope_symbols": list(_sequence(symbol_routes.get("scope_symbols"))),
            "scope_symbol_count": _int(symbol_routes.get("scope_symbol_count")),
            "routeable_symbol_count": counts["routeable"],
            "probing_symbol_count": counts["probing"],
            "blocked_symbol_count": counts["blocked"],
            "missing_symbol_count": counts["missing"],
            "retired_symbol_count": counts["retired"],
            "candidate_symbols": candidate_symbols,
            "repair_candidate_count": len(repair_candidates),
            "repair_candidate_symbols": [
                _text(item.get("symbol")) for item in repair_candidates
            ],
            "repair_candidates": repair_candidates,
            "expected_unblock_value": expected_unblock_value,
        },
        "source_refs": {
            "proof_floor_generated_at": generated_at,
            "proof_floor_route_state": proof_floor_receipt.get("route_state"),
            "proof_floor_capital_state": proof_floor_receipt.get("capital_state"),
            "execution_tca_reason": tca_dimension.get("reason"),
            "market_context_state": market_context_dimension.get("state"),
            "quant_ingestion_state": quant_dimension.get("state"),
            "alpha_readiness_state": alpha_dimension.get("state"),
        },
        "rollback_target": {
            "paper_probe_notional_limit": "0",
            "live_submit_enabled": False,
        },
    }


__all__ = ["build_route_reacquisition_book"]
