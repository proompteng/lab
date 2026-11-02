"""Broker-neutral execution adapters for trading order flow."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any


def float_to_order_text(value: float) -> str:
    normalized = max(float(value), 0.0)
    rendered = f"{normalized:.8f}".rstrip("0").rstrip(".")
    if not rendered:
        return "0"
    return rendered


def decimal_to_order_text(value: Decimal) -> str:
    normalized = abs(value)
    rendered = format(normalized, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if not rendered:
        return "0"
    return rendered


def signed_decimal_to_text(value: Decimal) -> str:
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered in {"", "-0"}:
        return "0"
    return rendered


def optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def positive_decimal(value: Any) -> Decimal | None:
    parsed = optional_decimal(value)
    if parsed is None:
        return None
    if parsed.is_finite() and parsed > 0:
        return parsed
    return None


def signed_position_market_value(
    position: Mapping[str, Any], *, side: str
) -> Decimal | None:
    market_value = optional_decimal(position.get("market_value"))
    if market_value is None:
        return None
    normalized_side = side.strip().lower()
    if normalized_side == "short":
        return -abs(market_value)
    if normalized_side == "long":
        return abs(market_value)
    return market_value


def resolve_simulation_context_payload(
    *,
    simulation_run_id: str | None,
    dataset_id: str | None,
    symbol: str,
    source: Mapping[str, Any] | None,
) -> dict[str, Any]:
    context: dict[str, Any] = {}
    if isinstance(source, Mapping):
        context.update({str(key): value for key, value in source.items()})
    if context.get("simulation_run_id") in (None, ""):
        context["simulation_run_id"] = (simulation_run_id or "").strip() or "simulation"
    if context.get("dataset_id") in (None, ""):
        context["dataset_id"] = (dataset_id or "").strip() or "unknown"
    if context.get("symbol") in (None, "") and symbol.strip():
        context["symbol"] = symbol.strip().upper()
    return context


__all__ = [
    "decimal_to_order_text",
    "float_to_order_text",
    "optional_decimal",
    "positive_decimal",
    "resolve_simulation_context_payload",
    "signed_decimal_to_text",
    "signed_position_market_value",
]
