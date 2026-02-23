"""Asset-class-aware quantity constraints for deterministic sizing and execution checks."""

from __future__ import annotations

from decimal import ROUND_DOWN, Decimal

EQUITY_QTY_STEP = Decimal("1")
CRYPTO_QTY_STEP = Decimal("0.00000001")


def is_crypto_symbol(symbol: str) -> bool:
    normalized = symbol.strip().upper()
    return "/" in normalized and len(normalized) >= 5


def qty_step_for_symbol(symbol: str) -> Decimal:
    if is_crypto_symbol(symbol):
        return CRYPTO_QTY_STEP
    return EQUITY_QTY_STEP


def min_qty_for_symbol(symbol: str) -> Decimal:
    return qty_step_for_symbol(symbol)


def quantize_qty_for_symbol(symbol: str, qty: Decimal) -> Decimal:
    step = qty_step_for_symbol(symbol)
    return qty.quantize(step, rounding=ROUND_DOWN)


def qty_has_valid_increment(symbol: str, qty: Decimal) -> bool:
    return quantize_qty_for_symbol(symbol, qty) == qty


__all__ = [
    "is_crypto_symbol",
    "min_qty_for_symbol",
    "qty_has_valid_increment",
    "qty_step_for_symbol",
    "quantize_qty_for_symbol",
]
