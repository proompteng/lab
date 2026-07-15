"""Strict normalization of Alpaca order and position observations."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import cast

from .risk_reduction import (
    BrokerOrderObservation,
    BrokerPositionObservation,
    OrderSide,
    RiskReductionPermitError,
)


def alpaca_order_observation(raw: Mapping[str, object]) -> BrokerOrderObservation:
    side = str(raw.get("side") or "").strip().lower()
    if side not in {"buy", "sell"}:
        raise RiskReductionPermitError("alpaca_order_side_invalid")
    return BrokerOrderObservation(
        order_id=str(raw.get("id") or raw.get("order_id") or "").strip(),
        client_order_id=str(raw.get("client_order_id") or "").strip() or None,
        symbol=str(raw.get("symbol") or ""),
        side=cast(OrderSide, side),
        quantity=_required_decimal(
            raw.get("qty") or raw.get("quantity"),
            field_name="order_quantity",
        ),
        filled_quantity=_required_decimal(
            raw.get("filled_qty") or raw.get("filled_quantity") or "0",
            field_name="filled_quantity",
        ),
        status=str(raw.get("status") or ""),
        limit_price=_optional_order_decimal(
            raw.get("limit_price"),
            field_name="limit_price",
        ),
    )


def alpaca_position_observation(
    raw: Mapping[str, object],
) -> BrokerPositionObservation:
    quantity = _required_decimal(
        raw.get("qty") or raw.get("quantity"),
        field_name="position_quantity",
    )
    side = str(raw.get("side") or "").strip().lower()
    if side not in {"long", "short"}:
        raise RiskReductionPermitError("alpaca_position_side_invalid")
    signed_quantity = -abs(quantity) if side == "short" else abs(quantity)
    market_value = optional_decimal(raw.get("market_value"))
    unit_notional = (
        abs(market_value) / abs(signed_quantity)
        if market_value is not None and market_value != 0
        else optional_decimal(raw.get("current_price"))
    )
    if unit_notional is None:
        raise RiskReductionPermitError("alpaca_position_unit_notional_unavailable")
    return BrokerPositionObservation(
        symbol=str(raw.get("symbol") or ""),
        signed_quantity=signed_quantity,
        unit_notional=unit_notional,
        broker_symbol=str(raw.get("symbol") or ""),
    )


def optional_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _required_decimal(value: object, *, field_name: str) -> Decimal:
    parsed = optional_decimal(value)
    if parsed is None:
        raise RiskReductionPermitError(f"alpaca_{field_name}_invalid")
    return parsed


def _optional_order_decimal(value: object, *, field_name: str) -> Decimal | None:
    if value is None or str(value).strip() == "":
        return None
    return _required_decimal(value, field_name=field_name)


__all__ = [
    "alpaca_order_observation",
    "alpaca_position_observation",
    "optional_decimal",
]
