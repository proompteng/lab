"""Route reacquisition book for proof-floor repair work."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast


SCHEMA_VERSION = "torghut.route-reacquisition-book.v1"
_PAPER_ROUTE_PROBE_REASONS = {
    "execution_tca_route_universe_empty",
    "execution_tca_symbol_missing",
    "route_tca_passed_but_dependency_receipts_block_capital",
    "tca_evidence_stale",
}
_PAPER_ROUTE_PROBE_STATES = {"missing", "probing"}


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


def _positive_amount_text(value: object) -> str | None:
    amount = _float(value)
    if amount is None or amount <= 0:
        return None
    rendered = _text(value)
    return rendered if rendered else str(amount)


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
        if reason == "route_tca_passed_but_dependency_receipts_block_capital":
            return "collect_paper_runtime_ledger_receipts_before_capital"
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
    payload: dict[str, object] = {
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
    for key in (
        "avg_realized_shortfall_bps",
        "route_adverse_slippage_bps",
        "route_slippage_basis",
    ):
        value = symbol_payload.get(key)
        if value is not None:
            payload[key] = value
    return payload


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
    payload: dict[str, object] = {
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
    for key in (
        "avg_realized_shortfall_bps",
        "route_adverse_slippage_bps",
        "route_slippage_basis",
    ):
        value = record.get(key)
        if value is not None:
            payload[key] = value
    paper_route_probe = _mapping(record.get("paper_route_probe"))
    if paper_route_probe and bool(paper_route_probe.get("eligible")):
        payload["paper_route_probe"] = dict(paper_route_probe)
    return payload


def _paper_route_probe_eligible(record: Mapping[str, object]) -> bool:
    return (
        _text(record.get("state")) in _PAPER_ROUTE_PROBE_STATES
        and _text(record.get("reason")) in _PAPER_ROUTE_PROBE_REASONS
    )


def _paper_route_probe_blockers(
    *,
    trading_mode: str,
    market_session_open: bool | None,
    enabled: bool,
    configured_limit: str | None,
    eligible_symbol_count: int,
) -> list[str]:
    blockers: list[str] = []
    if trading_mode != "paper":
        blockers.append("not_paper_mode")
    if not enabled:
        blockers.append("paper_route_probe_disabled")
    if configured_limit is None:
        blockers.append("paper_route_probe_max_notional_invalid")
    if market_session_open is not True:
        blockers.append(
            "market_session_closed"
            if market_session_open is False
            else "market_session_unknown"
        )
    if eligible_symbol_count <= 0:
        blockers.append("paper_route_probe_candidate_missing")
    return blockers


def build_route_reacquisition_book(
    *,
    proof_floor_receipt: Mapping[str, Any],
    trading_mode: str,
    market_session_open: bool | None,
    paper_route_probe_enabled: bool = False,
    paper_route_probe_max_notional: object | None = None,
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

    configured_probe_limit = _positive_amount_text(paper_route_probe_max_notional)
    eligible_probe_symbols = [
        _text(item.get("symbol"))
        for item in records
        if _paper_route_probe_eligible(item)
    ]
    probe_blockers = _paper_route_probe_blockers(
        trading_mode=trading_mode,
        market_session_open=market_session_open,
        enabled=paper_route_probe_enabled,
        configured_limit=configured_probe_limit,
        eligible_symbol_count=len(eligible_probe_symbols),
    )
    probe_active = not probe_blockers
    effective_probe_limit = configured_probe_limit if probe_active else "0"
    next_session_probe_limit = (
        configured_probe_limit
        if paper_route_probe_enabled and configured_probe_limit is not None
        else "0"
    )
    active_probe_symbols = eligible_probe_symbols if probe_active else []
    for record in records:
        eligible = _paper_route_probe_eligible(record)
        record["paper_route_probe"] = {
            "eligible": eligible,
            "active": probe_active and eligible,
            "notional_limit": effective_probe_limit if eligible else "0",
            "next_session_notional_limit": next_session_probe_limit
            if eligible
            else "0",
            "blocking_reasons": probe_blockers if eligible else [],
            "capital_authority": "none",
        }

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
            "paper_route_probe_eligible_symbols": eligible_probe_symbols,
            "paper_route_probe_active_symbols": active_probe_symbols,
            "expected_unblock_value": expected_unblock_value,
        },
        "paper_route_probe": {
            "configured_enabled": paper_route_probe_enabled,
            "configured_max_notional": configured_probe_limit or "0",
            "active": probe_active,
            "effective_max_notional": effective_probe_limit,
            "next_session_max_notional": next_session_probe_limit,
            "eligible_symbol_count": len(eligible_probe_symbols),
            "eligible_symbols": eligible_probe_symbols,
            "active_symbols": active_probe_symbols,
            "blocking_reasons": probe_blockers,
            "capital_authority": "none",
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
