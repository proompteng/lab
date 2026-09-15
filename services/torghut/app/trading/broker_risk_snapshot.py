"""Fail-closed normalization for broker state used by live risk controls."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import cast


def normalize_live_position_rows(rows: object) -> list[dict[str, object]]:
    if not isinstance(rows, list):
        raise RuntimeError("live_risk_positions_snapshot_unavailable")
    return [_normalize_position_row(row) for row in cast(list[object], rows)]


def normalize_live_open_order_rows(rows: object) -> list[dict[str, object]]:
    if not isinstance(rows, list):
        raise RuntimeError("live_risk_open_orders_snapshot_unavailable")
    return [_normalize_open_order_row(row) for row in cast(list[object], rows)]


def _normalize_position_row(row: object) -> dict[str, object]:
    normalized = _mapping_row(row, "live_risk_positions_snapshot_invalid")
    symbol = _required_text(
        normalized.get("symbol"), "live_risk_position_symbol_invalid"
    ).upper()
    side = _required_text(
        normalized.get("side"), "live_risk_position_side_invalid"
    ).lower()
    qty = _required_decimal(
        normalized.get("qty") or normalized.get("quantity"),
        "live_risk_position_qty_invalid",
    )
    market_value = _required_decimal(
        normalized.get("market_value"), "live_risk_position_market_value_invalid"
    )
    if side not in {"long", "short"} or qty <= 0 or market_value == 0:
        raise RuntimeError("live_risk_position_values_invalid")
    if side == "long" and market_value < 0:
        raise RuntimeError("live_risk_position_values_invalid")
    if side == "short":
        market_value = -abs(market_value)
    normalized.update(
        symbol=symbol,
        side=side,
        qty=str(qty),
        market_value=str(market_value),
    )
    return normalized


def _normalize_open_order_row(row: object) -> dict[str, object]:
    normalized = _mapping_row(row, "live_risk_open_orders_snapshot_invalid")
    symbol = _required_text(
        normalized.get("symbol"), "live_risk_open_order_symbol_invalid"
    ).upper()
    side = _required_text(
        normalized.get("side"), "live_risk_open_order_side_invalid"
    ).lower()
    qty = _required_decimal(
        normalized.get("qty") or normalized.get("quantity"),
        "live_risk_open_order_qty_invalid",
    )
    filled_qty = _optional_decimal(normalized.get("filled_qty"))
    if filled_qty is None and normalized.get("filled_qty") is not None:
        raise RuntimeError("live_risk_open_order_filled_qty_invalid")
    filled_qty = filled_qty or Decimal("0")
    price = _open_order_price(normalized)
    if side not in {"buy", "sell"} or qty <= 0:
        raise RuntimeError("live_risk_open_order_values_invalid")
    if filled_qty < 0 or filled_qty >= qty or price is None or price <= 0:
        raise RuntimeError("live_risk_open_order_values_invalid")
    normalized.update(
        symbol=symbol,
        side=side,
        qty=str(qty),
        filled_qty=str(filled_qty),
        notional_price=str(price),
    )
    return normalized


def _mapping_row(row: object, reason: str) -> dict[str, object]:
    if not isinstance(row, Mapping):
        raise RuntimeError(reason)
    return {
        str(key): value for key, value in cast(Mapping[object, object], row).items()
    }


def _required_text(value: object, reason: str) -> str:
    resolved = str(value or "").strip()
    if not resolved:
        raise RuntimeError(reason)
    return resolved


def _required_decimal(value: object, reason: str) -> Decimal:
    resolved = _optional_decimal(value)
    if resolved is None:
        raise RuntimeError(reason)
    return resolved


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        resolved = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None
    return resolved if resolved.is_finite() else None


def _open_order_price(order: Mapping[str, object]) -> Decimal | None:
    for key in ("limit_price", "stop_price", "notional_price"):
        raw_value = order.get(key)
        if raw_value is None:
            continue
        return _optional_decimal(raw_value)
    return None


__all__ = ["normalize_live_open_order_rows", "normalize_live_position_rows"]
