"""Shared helpers for normalizing execution route and fallback metadata."""

from __future__ import annotations

from typing import Any, Mapping, Optional


def resolve_order_route_metadata(
    *,
    expected_adapter: Optional[str],
    execution_client: Any,
    order_response: Mapping[str, Any] | None,
) -> tuple[str, str, str | None, int]:
    """Resolve execution route provenance from expected adapter, client state, and order payload."""

    expected = coerce_route_text(expected_adapter)
    if expected is None and execution_client is not None:
        expected = coerce_route_text(getattr(execution_client, "name", None))

    raw_actual = coerce_route_text(_coerce_order_field(order_response, "_execution_route_actual"))
    if raw_actual is None and order_response is not None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "_execution_adapter"))
    if raw_actual is None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "execution_actual_adapter"))
    if raw_actual is None and execution_client is not None:
        raw_actual = coerce_route_text(getattr(execution_client, "last_route", None))

    if expected is None:
        expected = coerce_route_text(_coerce_order_field(order_response, "_execution_route_expected"))
    if expected is None:
        expected = raw_actual

    if raw_actual is None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "_execution_route_expected"))
    if raw_actual is None:
        raw_actual = coerce_route_text(_coerce_order_field(order_response, "execution_expected_adapter"))
    if raw_actual is None:
        raw_actual = expected

    fallback_reason = coerce_route_text(_coerce_order_field(order_response, "_execution_fallback_reason"))
    if fallback_reason is None:
        fallback_reason = coerce_route_text(_coerce_order_field(order_response, "_fallback_reason"))

    fallback_count = coerce_route_int(_coerce_order_field(order_response, "_execution_fallback_count"))

    if fallback_count is None and expected and raw_actual and expected != raw_actual:
        fallback_count = 1
        if fallback_reason is None:
            fallback_reason = f"fallback_from_{expected}_to_{raw_actual}"

    if fallback_count is not None and fallback_count <= 0 and fallback_reason is not None:
        fallback_count = 1

    normalized_expected, normalized_actual, normalized_reason, normalized_count = normalize_route_provenance(
        expected_adapter=expected,
        actual_adapter=raw_actual,
        fallback_reason=fallback_reason,
        fallback_count=fallback_count,
    )
    return normalized_expected, normalized_actual, normalized_reason, normalized_count


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
