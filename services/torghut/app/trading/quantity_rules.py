"""Asset-class-aware quantity constraints for deterministic sizing and execution checks."""

from __future__ import annotations

from decimal import ROUND_DOWN, Decimal
from typing import Optional

EQUITY_QTY_STEP = Decimal("1")
EQUITY_FRACTIONAL_QTY_STEP = Decimal("0.0001")
CRYPTO_QTY_STEP = Decimal("0.00000001")


def is_crypto_symbol(symbol: str) -> bool:
    normalized = symbol.strip().upper()
    return "/" in normalized and len(normalized) >= 5


def qty_step_for_symbol(
    symbol: str, *, fractional_equities_enabled: bool = False
) -> Decimal:
    if is_crypto_symbol(symbol):
        return CRYPTO_QTY_STEP
    if fractional_equities_enabled:
        return EQUITY_FRACTIONAL_QTY_STEP
    return EQUITY_QTY_STEP


def min_qty_for_symbol(
    symbol: str, *, fractional_equities_enabled: bool = False
) -> Decimal:
    return qty_step_for_symbol(
        symbol, fractional_equities_enabled=fractional_equities_enabled
    )


def quantize_qty_for_symbol(
    symbol: str, qty: Decimal, *, fractional_equities_enabled: bool = False
) -> Decimal:
    step = qty_step_for_symbol(
        symbol, fractional_equities_enabled=fractional_equities_enabled
    )
    return qty.quantize(step, rounding=ROUND_DOWN)


def qty_has_valid_increment(
    symbol: str, qty: Decimal, *, fractional_equities_enabled: bool = False
) -> bool:
    return (
        quantize_qty_for_symbol(
            symbol, qty, fractional_equities_enabled=fractional_equities_enabled
        )
        == qty
    )


def fractional_equities_enabled_for_trade(
    *,
    action: str,
    global_enabled: bool,
    allow_shorts: bool,
    position_qty: Optional[Decimal] = None,
    requested_qty: Optional[Decimal] = None,
) -> bool:
    if not global_enabled:
        return False
    normalized_action = action.strip().lower()
    if normalized_action == "buy":
        return True
    if normalized_action != "sell":
        return False

    # When positions are unavailable, allow sell-side fractional only when shorts are
    # disabled (sell can only reduce an existing long).
    if position_qty is None:
        return not allow_shorts
    if position_qty <= 0:
        return False
    if requested_qty is None or requested_qty <= 0:
        return True
    return requested_qty <= position_qty


__all__ = [
    "fractional_equities_enabled_for_trade",
    "is_crypto_symbol",
    "min_qty_for_symbol",
    "qty_has_valid_increment",
    "qty_step_for_symbol",
    "quantize_qty_for_symbol",
]
