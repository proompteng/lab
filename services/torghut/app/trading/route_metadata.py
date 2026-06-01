"""Shared helpers for normalizing execution route and fallback metadata."""

from __future__ import annotations

from typing import Any, Mapping, Optional


ROUTE_REPAIR_RECOMMENDATIONS: dict[str, str] = {
    "stale_quote": "refresh_quote_snapshot_and_recompute_route_fillability",
    "missing_bid_ask": "collect_bid_ask_quote_before_routeability_claim",
    "missing_executable_quote": "collect_bid_ask_quote_before_routeability_claim",
    "spread_bps_exceeded": "wait_for_tighter_executable_quote_before_routeability_claim",
    "session_closed": "wait_for_regular_session_open_then_refresh_route_probe",
    "market_session_closed": "wait_for_regular_session_open_then_refresh_route_probe",
    "pair_imbalance": "repair_pair_leg_balance_before_routeability_claim",
    "missing_target": "collect_target_notional_and_side_plan_before_probe",
    "blocked_submit": "keep_submit_disabled_and_collect_submit_gate_receipt",
    "simple_submit_disabled": "keep_submit_disabled_and_collect_submit_gate_receipt",
    "missing_close_flatten_handoff": "collect_close_flatten_handoff_receipt_before_reentry",
    "runtime_import_pending": "complete_runtime_import_reconciliation_before_authority",
}

_ROUTE_REPAIR_RECOMMENDATION_FRAGMENTS: tuple[tuple[str, str], ...] = (
    ("stale_quote", ROUTE_REPAIR_RECOMMENDATIONS["stale_quote"]),
    ("quote_stale", ROUTE_REPAIR_RECOMMENDATIONS["stale_quote"]),
    ("missing_bid_ask", ROUTE_REPAIR_RECOMMENDATIONS["missing_bid_ask"]),
    ("bid_ask_missing", ROUTE_REPAIR_RECOMMENDATIONS["missing_bid_ask"]),
    ("missing_executable_quote", ROUTE_REPAIR_RECOMMENDATIONS["missing_executable_quote"]),
    ("missing_bid", ROUTE_REPAIR_RECOMMENDATIONS["missing_bid_ask"]),
    ("missing_ask", ROUTE_REPAIR_RECOMMENDATIONS["missing_bid_ask"]),
    ("spread_bps_exceeded", ROUTE_REPAIR_RECOMMENDATIONS["spread_bps_exceeded"]),
    ("wide_quote", ROUTE_REPAIR_RECOMMENDATIONS["spread_bps_exceeded"]),
    ("wide_spread", ROUTE_REPAIR_RECOMMENDATIONS["spread_bps_exceeded"]),
    ("session_closed", ROUTE_REPAIR_RECOMMENDATIONS["session_closed"]),
    ("market_session_closed", ROUTE_REPAIR_RECOMMENDATIONS["market_session_closed"]),
    ("pair_imbalance", ROUTE_REPAIR_RECOMMENDATIONS["pair_imbalance"]),
    ("missing_target", ROUTE_REPAIR_RECOMMENDATIONS["missing_target"]),
    ("target_missing", ROUTE_REPAIR_RECOMMENDATIONS["missing_target"]),
    ("blocked_submit", ROUTE_REPAIR_RECOMMENDATIONS["blocked_submit"]),
    ("simple_submit_disabled", ROUTE_REPAIR_RECOMMENDATIONS["simple_submit_disabled"]),
    ("submit", ROUTE_REPAIR_RECOMMENDATIONS["blocked_submit"]),
    ("missing_close_flatten_handoff", ROUTE_REPAIR_RECOMMENDATIONS["missing_close_flatten_handoff"]),
    ("close_flatten_handoff_missing", ROUTE_REPAIR_RECOMMENDATIONS["missing_close_flatten_handoff"]),
    ("runtime_import_pending", ROUTE_REPAIR_RECOMMENDATIONS["runtime_import_pending"]),
    ("runtime_ledger_import_pending", ROUTE_REPAIR_RECOMMENDATIONS["runtime_import_pending"]),
    ("tca_stale", "refresh_execution_tca_and_quote_samples_before_routeability_claim"),
    ("execution_tca_stale", "refresh_execution_tca_and_quote_samples_before_routeability_claim"),
    ("slippage", "reduce_route_slippage_and_collect_fresh_tca_receipt"),
    ("route_universe", "refresh_route_universe_and_symbol_fillability_receipts"),
)


def route_repair_recommendation(reason: str | None) -> str:
    """Map route/fillability blockers to bounded collection-only repair work."""

    normalized = coerce_route_text(reason) or "unknown"
    lowered = normalized.lower()
    if lowered in ROUTE_REPAIR_RECOMMENDATIONS:
        return ROUTE_REPAIR_RECOMMENDATIONS[lowered]
    for token, recommendation in _ROUTE_REPAIR_RECOMMENDATION_FRAGMENTS:
        if token in lowered:
            return recommendation
    return "collect_source_backed_route_repair_receipt_before_authority"


def resolve_order_route_metadata(
    *,
    expected_adapter: Optional[str],
    execution_client: Any,
    order_response: Mapping[str, Any] | None,
) -> tuple[str, str, str | None, int]:
    """Resolve execution route provenance from expected adapter, client state, and order payload."""

    expected = _resolve_expected_adapter(
        expected_adapter=expected_adapter,
        execution_client=execution_client,
        order_response=order_response,
    )
    raw_actual = _resolve_actual_adapter(
        execution_client=execution_client,
        order_response=order_response,
        expected=expected,
    )
    if expected is None:
        expected = raw_actual

    fallback_reason = _resolve_fallback_reason(
        execution_client=execution_client,
        order_response=order_response,
    )
    fallback_count = _resolve_fallback_count(
        execution_client=execution_client,
        order_response=order_response,
    )
    fallback_reason, fallback_count = _normalize_fallback_fields(
        expected=expected,
        actual=raw_actual,
        fallback_reason=fallback_reason,
        fallback_count=fallback_count,
    )

    normalized_expected, normalized_actual, normalized_reason, normalized_count = normalize_route_provenance(
        expected_adapter=expected,
        actual_adapter=raw_actual,
        fallback_reason=fallback_reason,
        fallback_count=fallback_count,
    )
    return normalized_expected, normalized_actual, normalized_reason, normalized_count


def _resolve_expected_adapter(
    *,
    expected_adapter: Optional[str],
    execution_client: Any,
    order_response: Mapping[str, Any] | None,
) -> str | None:
    expected = coerce_route_text(expected_adapter)
    if expected is None and execution_client is not None:
        expected = coerce_route_text(getattr(execution_client, "name", None))
    if expected is None:
        expected = coerce_route_text(_coerce_order_field(order_response, "_execution_route_expected"))
    return expected


def _resolve_actual_adapter(
    *,
    execution_client: Any,
    order_response: Mapping[str, Any] | None,
    expected: str | None,
) -> str | None:
    raw_actual = coerce_route_text(_coerce_order_field(order_response, "_execution_route_actual"))
    if raw_actual is None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "_execution_adapter"))
    if raw_actual is None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "execution_actual_adapter"))
    if raw_actual is None and execution_client is not None:
        raw_actual = coerce_route_text(getattr(execution_client, "last_route", None))
    if raw_actual is None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "_execution_route_expected"))
    if raw_actual is None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "execution_expected_adapter"))
    if raw_actual is None:
        raw_actual = expected
    return raw_actual


def _resolve_fallback_reason(
    *,
    execution_client: Any,
    order_response: Mapping[str, Any] | None,
) -> str | None:
    fallback_reason = coerce_route_text(
        _coerce_order_field(order_response, "_execution_fallback_reason")
    )
    if fallback_reason is None:
        fallback_reason = coerce_route_text(_coerce_order_field(order_response, "_fallback_reason"))
    if fallback_reason is None and execution_client is not None:
        fallback_reason = coerce_route_text(
            getattr(execution_client, "last_fallback_reason", None)
        )
    return fallback_reason


def _resolve_fallback_count(
    *,
    execution_client: Any,
    order_response: Mapping[str, Any] | None,
) -> int | None:
    fallback_count = coerce_route_int(
        _coerce_order_field(order_response, "_execution_fallback_count")
    )
    if fallback_count is None and execution_client is not None:
        fallback_count = coerce_route_int(getattr(execution_client, "last_fallback_count", None))
    return fallback_count


def _normalize_fallback_fields(
    *,
    expected: str | None,
    actual: str | None,
    fallback_reason: str | None,
    fallback_count: int | None,
) -> tuple[str | None, int | None]:
    if fallback_count is None and expected and actual and expected != actual:
        fallback_count = 1
        if fallback_reason is None:
            fallback_reason = f"fallback_from_{expected}_to_{actual}"
    if fallback_count is not None and fallback_count <= 0 and fallback_reason is not None:
        fallback_count = 1
    return fallback_reason, fallback_count


def normalize_route_provenance(
    *,
    expected_adapter: str | None,
    actual_adapter: str | None,
    fallback_reason: str | None,
    fallback_count: int | None,
) -> tuple[str, str, str | None, int]:
    """Normalize route provenance so execution rows are always materialized with deterministic metadata."""

    expected = coerce_route_text(expected_adapter) or 'unknown'
    actual = coerce_route_text(actual_adapter) or expected
    count = 0 if fallback_count is None else max(0, int(fallback_count))
    reason = coerce_route_text(fallback_reason)
    if expected != actual and count <= 0:
        count = 1
    if count > 0 and reason is None:
        reason = f'fallback_from_{expected}_to_{actual}'
    if count == 0:
        reason = None
    return expected, actual, reason, count


def coerce_route_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text == "alpaca_fallback":
            return "alpaca"
        return text
    return None


def coerce_route_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _coerce_order_field(order_response: Mapping[str, Any] | None, key: str) -> Any:
    if order_response is None:
        return None
    return order_response.get(key)
