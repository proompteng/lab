"""Strict normalization of Alpaca order and position observations."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
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
        symbol=_position_symbol(raw),
        signed_quantity=signed_quantity,
        unit_notional=unit_notional,
        broker_symbol=str(raw.get("symbol") or ""),
    )


def alpaca_order_references(raw: object) -> tuple[str, ...]:
    """Return distinct order IDs from an order or close-position response."""

    references: list[str] = []

    def collect(value: object) -> None:
        if isinstance(value, Mapping):
            response = cast(Mapping[object, object], value)
            reference = str(
                response.get("id") or response.get("order_id") or ""
            ).strip()
            if reference and reference not in references:
                references.append(reference)
            body = response.get("body")
            if body is not None:
                collect(body)
            return
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            for item in cast(Sequence[object], value):
                collect(item)

    collect(raw)
    return tuple(references)


def optional_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _position_symbol(raw: Mapping[str, object]) -> str:
    broker_symbol = str(raw.get("symbol") or "").strip().upper()
    asset_class = str(raw.get("asset_class") or "").strip().lower()
    if asset_class != "crypto" or "/" in broker_symbol:
        return broker_symbol
    for quote_asset in ("USDT", "USDC", "USD", "BTC"):
        if broker_symbol.endswith(quote_asset) and len(broker_symbol) > len(
            quote_asset
        ):
            return f"{broker_symbol[: -len(quote_asset)]}/{quote_asset}"
    raise RiskReductionPermitError("alpaca_crypto_position_symbol_invalid")


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
    "alpaca_order_references",
    "alpaca_order_observation",
    "alpaca_position_observation",
    "optional_decimal",
]
