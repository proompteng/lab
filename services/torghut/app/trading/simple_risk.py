"""Minimal hard-risk checks for the simple execution lane."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from .models import StrategyDecision
from .quantity_rules import (
    QuantityResolution,
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    qty_has_valid_increment,
    resolve_quantity_resolution,
)


@dataclass(frozen=True)
class SimpleRiskPreparation:
    approved: bool
    decision: StrategyDecision
    quantity_resolution: QuantityResolution
    notional: Decimal | None
    reject_reason: str | None = None
    diagnostics: dict[str, Any] | None = None


def position_qty_for_symbol(
    positions: list[dict[str, Any]],
    symbol: str,
) -> Decimal:
    normalized_symbol = symbol.strip().upper()
    current_qty = Decimal("0")
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_qty = position.get("qty") or position.get("quantity")
        if raw_qty is None:
            continue
        try:
            qty = Decimal(str(raw_qty))
        except (ArithmeticError, ValueError):
            continue
        side = str(position.get("side") or "").strip().lower()
        if side == "short":
            qty = -abs(qty)
        current_qty += qty
    return current_qty


def position_value_for_symbol(
    positions: list[dict[str, Any]],
    symbol: str,
    *,
    fallback_price: Decimal | None,
) -> Decimal:
    normalized_symbol = symbol.strip().upper()
    total = Decimal("0")
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_market_value = position.get("market_value")
        if raw_market_value is not None:
            try:
                total += Decimal(str(raw_market_value))
                continue
            except (ArithmeticError, ValueError):
                pass
        if fallback_price is None:
            continue
        raw_qty = position.get("qty") or position.get("quantity")
        if raw_qty is None:
            continue
        try:
            qty = Decimal(str(raw_qty))
        except (ArithmeticError, ValueError):
            continue
        side = str(position.get("side") or "").strip().lower()
        signed_qty = -abs(qty) if side == "short" else qty
        total += signed_qty * fallback_price
    return total


def prepare_simple_decision(
    *,
    decision: StrategyDecision,
    account: dict[str, str],
    positions: list[dict[str, Any]],
    fractional_equities_enabled: bool,
    allow_shorts: bool,
    max_notional_per_order: Decimal | None,
    max_notional_per_symbol: Decimal | None,
) -> SimpleRiskPreparation:
    price = _extract_decision_price(decision)
    current_qty = position_qty_for_symbol(positions, decision.symbol)
    resolution = resolve_quantity_resolution(
        decision.symbol,
        action=decision.action,
        global_enabled=fractional_equities_enabled,
        allow_shorts=allow_shorts,
        position_qty=current_qty,
        requested_qty=decision.qty,
    )
    min_qty = min_qty_for_symbol(
        decision.symbol,
        fractional_equities_enabled=resolution.fractional_allowed,
    )
    quantized_qty = quantize_qty_for_symbol(
        decision.symbol,
        decision.qty,
        fractional_equities_enabled=resolution.fractional_allowed,
    )
    diagnostics: dict[str, Any] = {
        "requested_qty": str(decision.qty),
        "quantized_qty": str(quantized_qty),
        "min_qty": str(min_qty),
        "quantity_resolution": resolution.to_payload(),
    }

    if price is None or price <= 0:
        diagnostics["price"] = None if price is None else str(price)
        return SimpleRiskPreparation(
            approved=False,
            decision=decision,
            quantity_resolution=resolution,
            notional=None,
            reject_reason="broker_precheck_failed",
            diagnostics=diagnostics,
        )

    diagnostics["price"] = str(price)
    if quantized_qty <= 0 or quantized_qty < min_qty:
        return SimpleRiskPreparation(
            approved=False,
            decision=decision,
            quantity_resolution=resolution,
            notional=price * quantized_qty if quantized_qty > 0 else Decimal("0"),
            reject_reason="qty_below_min_after_clamp",
            diagnostics=diagnostics,
        )
    if not qty_has_valid_increment(
        decision.symbol,
        quantized_qty,
        fractional_equities_enabled=resolution.fractional_allowed,
    ):
        return SimpleRiskPreparation(
            approved=False,
            decision=decision,
            quantity_resolution=resolution,
            notional=price * quantized_qty,
            reject_reason="invalid_qty_increment",
            diagnostics=diagnostics,
        )

    enforce_exposure = decision.action == "buy" or resolution.short_increasing
    adjusted_qty = quantized_qty
    capped_by_order = False
    capped_by_symbol = False

    if enforce_exposure and max_notional_per_order is not None and max_notional_per_order >= 0:
        order_cap_qty = quantize_qty_for_symbol(
            decision.symbol,
            max_notional_per_order / price,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        if order_cap_qty < adjusted_qty:
            adjusted_qty = order_cap_qty
            capped_by_order = True

    if enforce_exposure and max_notional_per_symbol is not None and max_notional_per_symbol >= 0:
        current_abs_value = abs(
            position_value_for_symbol(
                positions,
                decision.symbol,
                fallback_price=price,
            )
        )
        remaining_notional = max_notional_per_symbol - current_abs_value
        diagnostics["current_symbol_abs_notional"] = str(current_abs_value)
        diagnostics["remaining_symbol_notional_room"] = str(remaining_notional)
        if remaining_notional <= 0:
            adjusted_qty = Decimal("0")
            capped_by_symbol = True
        else:
            symbol_cap_qty = quantize_qty_for_symbol(
                decision.symbol,
                remaining_notional / price,
                fractional_equities_enabled=resolution.fractional_allowed,
            )
            if symbol_cap_qty < adjusted_qty:
                adjusted_qty = symbol_cap_qty
                capped_by_symbol = True

    diagnostics["final_qty"] = str(adjusted_qty)
    if adjusted_qty <= 0 or adjusted_qty < min_qty:
        reject_reason = "qty_below_min_after_clamp"
        if capped_by_symbol:
            reject_reason = "max_symbol_exposure_exceeded"
        elif capped_by_order:
            reject_reason = "max_notional_exceeded"
        return SimpleRiskPreparation(
            approved=False,
            decision=decision,
            quantity_resolution=resolution,
            notional=price * adjusted_qty if adjusted_qty > 0 else Decimal("0"),
            reject_reason=reject_reason,
            diagnostics=diagnostics,
        )
    if not qty_has_valid_increment(
        decision.symbol,
        adjusted_qty,
        fractional_equities_enabled=resolution.fractional_allowed,
    ):
        return SimpleRiskPreparation(
            approved=False,
            decision=decision,
            quantity_resolution=resolution,
            notional=price * adjusted_qty,
            reject_reason="invalid_qty_increment",
            diagnostics=diagnostics,
        )

    notional = price * adjusted_qty
    diagnostics["final_notional"] = str(notional)
    if enforce_exposure:
        buying_power = _resolve_decimal(account.get("buying_power"))
        diagnostics["buying_power"] = str(buying_power) if buying_power is not None else None
        if buying_power is not None and notional > buying_power:
            return SimpleRiskPreparation(
                approved=False,
                decision=decision,
                quantity_resolution=resolution,
                notional=notional,
                reject_reason="insufficient_buying_power",
                diagnostics=diagnostics,
            )

    params = dict(decision.params)
    params["execution_lane"] = "simple"
    params["submit_path"] = "direct_alpaca"
    params["simple_lane"] = {
        "requested_qty": str(decision.qty),
        "final_qty": str(adjusted_qty),
        "price": str(price),
        "notional": str(notional),
        "quantity_resolution": resolution.to_payload(),
        "capped_by_order": capped_by_order,
        "capped_by_symbol": capped_by_symbol,
    }
    return SimpleRiskPreparation(
        approved=True,
        decision=decision.model_copy(update={"qty": adjusted_qty, "params": params}),
        quantity_resolution=resolution,
        notional=notional,
        diagnostics=diagnostics,
    )


def _extract_decision_price(decision: StrategyDecision) -> Decimal | None:
    for candidate in (
        decision.params.get("price"),
        decision.limit_price,
        decision.stop_price,
    ):
        if candidate is None:
            continue
        try:
            return Decimal(str(candidate))
        except (ArithmeticError, ValueError):
            continue
    return None


def _resolve_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


__all__ = [
    "SimpleRiskPreparation",
    "position_qty_for_symbol",
    "position_value_for_symbol",
    "prepare_simple_decision",
]
