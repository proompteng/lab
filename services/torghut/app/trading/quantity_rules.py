"""Asset-class-aware quantity constraints for deterministic sizing and execution checks."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from typing import Optional

EQUITY_QTY_STEP = Decimal("1")
EQUITY_FRACTIONAL_QTY_STEP = Decimal("0.0001")
CRYPTO_QTY_STEP = Decimal("0.00000001")


@dataclass(frozen=True)
class QuantityResolution:
    symbol: str
    action: str
    asset_class: str
    fractional_allowed: bool
    qty_step: Decimal
    min_qty: Decimal
    reason: str
    position_qty: Optional[Decimal] = None
    requested_qty: Optional[Decimal] = None
    short_increasing: bool = False

    def to_payload(self) -> dict[str, str | bool | None]:
        return {
            "symbol": self.symbol,
            "action": self.action,
            "asset_class": self.asset_class,
            "fractional_allowed": self.fractional_allowed,
            "qty_step": str(self.qty_step),
            "min_qty": str(self.min_qty),
            "reason": self.reason,
            "position_qty": (
                str(self.position_qty) if self.position_qty is not None else None
            ),
            "requested_qty": (
                str(self.requested_qty) if self.requested_qty is not None else None
            ),
            "short_increasing": self.short_increasing,
        }


def is_crypto_symbol(symbol: str) -> bool:
    normalized = symbol.strip().upper()
    return "/" in normalized and len(normalized) >= 5


def resolve_quantity_resolution(
    symbol: str,
    *,
    action: str,
    global_enabled: bool,
    allow_shorts: bool,
    position_qty: Optional[Decimal] = None,
    requested_qty: Optional[Decimal] = None,
) -> QuantityResolution:
    normalized_symbol = symbol.strip().upper()
    normalized_action = action.strip().lower()
    if is_crypto_symbol(normalized_symbol):
        return QuantityResolution(
            symbol=normalized_symbol,
            action=normalized_action,
            asset_class="crypto",
            fractional_allowed=True,
            qty_step=CRYPTO_QTY_STEP,
            min_qty=CRYPTO_QTY_STEP,
            reason="crypto_fractional_allowed",
            position_qty=position_qty,
            requested_qty=requested_qty,
            short_increasing=False,
        )

    short_increasing = False
    reason = "fractional_disabled"
    fractional_allowed = False

    if global_enabled:
        if normalized_action == "buy":
            fractional_allowed = True
            reason = "equity_buy_fractional_allowed"
        elif normalized_action == "sell":
            if position_qty is None:
                fractional_allowed = False
                reason = "sell_inventory_unknown_integer_only"
            elif position_qty <= 0:
                short_increasing = True
                fractional_allowed = False
                reason = (
                    "sell_short_increasing_integer_only"
                    if allow_shorts
                    else "sell_short_disallowed_integer_only"
                )
            elif requested_qty is None or requested_qty <= 0:
                fractional_allowed = True
                reason = "sell_reducing_long_fractional_allowed"
            elif requested_qty <= position_qty:
                fractional_allowed = True
                reason = "sell_reducing_long_fractional_allowed"
            else:
                short_increasing = True
                fractional_allowed = False
                reason = (
                    "sell_short_increasing_integer_only"
                    if allow_shorts
                    else "sell_short_disallowed_integer_only"
                )
        else:
            reason = "unsupported_action_integer_only"

    qty_step = qty_step_for_symbol(
        normalized_symbol, fractional_equities_enabled=fractional_allowed
    )
    return QuantityResolution(
        symbol=normalized_symbol,
        action=normalized_action,
        asset_class="equity",
        fractional_allowed=fractional_allowed,
        qty_step=qty_step,
        min_qty=qty_step,
        reason=reason,
        position_qty=position_qty,
        requested_qty=requested_qty,
        short_increasing=short_increasing,
    )


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
    if position_qty is None:
        return False
    if position_qty <= 0:
        return False
    if requested_qty is None or requested_qty <= 0:
        return True
    return requested_qty <= position_qty


__all__ = [
    "fractional_equities_enabled_for_trade",
    "is_crypto_symbol",
    "min_qty_for_symbol",
    "QuantityResolution",
    "qty_has_valid_increment",
    "qty_step_for_symbol",
    "quantize_qty_for_symbol",
    "resolve_quantity_resolution",
]
