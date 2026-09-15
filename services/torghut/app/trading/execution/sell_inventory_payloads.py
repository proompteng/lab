"""Sell-inventory conflict payload helpers for order execution."""

from __future__ import annotations


from .shared_context import (
    Any,
    Decimal,
    ExecutionRequest,
)
from .order_executor_core_support import (
    SellInventoryReservations as _SellInventoryReservations,
)


def _unknown_position_sell_inventory_conflict(
    request: ExecutionRequest,
    *,
    request_symbol: str,
    reservations: _SellInventoryReservations,
) -> dict[str, Any] | None:
    if request.qty > reservations.held_qty:
        return None
    return {
        "source": "broker_precheck",
        "code": "precheck_sell_qty_exceeds_available",
        "reject_reason": (
            "sell qty may exceed available inventory; position lookup unavailable and "
            "open sell reservations cover requested qty"
        ),
        "symbol": request_symbol,
        "qty": str(request.qty),
        "position_qty": None,
        "held_for_open_sells": str(reservations.held_qty),
        "available_qty": None,
        "existing_order_id": _first_order_id(reservations),
        "existing_order_ids": reservations.existing_order_ids,
    }


def _sell_inventory_conflict_payload(
    request: ExecutionRequest,
    *,
    request_symbol: str,
    reservations: _SellInventoryReservations,
    position_qty: Decimal,
    available_qty: Decimal,
) -> dict[str, Any]:
    return {
        "source": "broker_precheck",
        "code": "precheck_sell_qty_exceeds_available",
        "reject_reason": "sell qty exceeds available inventory after open sell reservations",
        "symbol": request_symbol,
        "qty": str(request.qty),
        "position_qty": str(position_qty),
        "held_for_open_sells": str(reservations.held_qty),
        "available_qty": str(available_qty),
        "existing_order_id": _first_order_id(reservations),
        "existing_order_ids": reservations.existing_order_ids,
    }


def _first_order_id(reservations: _SellInventoryReservations) -> str | None:
    if not reservations.existing_order_ids:
        return None
    return reservations.existing_order_ids[0]


# Public aliases used by split-module consumers.
sell_inventory_conflict_payload = _sell_inventory_conflict_payload
unknown_position_sell_inventory_conflict = _unknown_position_sell_inventory_conflict

__all__ = (
    "sell_inventory_conflict_payload",
    "unknown_position_sell_inventory_conflict",
)
