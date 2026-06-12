"""Minimal hard-risk checks for the simple execution lane."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from collections.abc import Mapping
from typing import Any, cast

from .models import StrategyDecision
from .prices import resolve_execution_reference_price
from .quantity_rules import (
    QuantityResolution,
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    qty_has_valid_increment,
    resolve_quantity_resolution,
)
from .risk import target_sizing_payload


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
    buying_power_reserve_bps: Decimal = Decimal("0"),
    max_order_pct_equity: Decimal | None = None,
    max_gross_exposure_pct_equity: Decimal | None = None,
    require_equity_for_exposure_increase: bool = False,
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
    raw_target_sizing = decision.params.get("target_sizing")
    if isinstance(raw_target_sizing, Mapping):
        target_sizing = target_sizing_payload(
            cast(Mapping[str, Any], raw_target_sizing)
        )
        diagnostics["target_sizing"] = target_sizing
        if target_sizing["blocking_reasons"]:
            return SimpleRiskPreparation(
                approved=False,
                decision=decision,
                quantity_resolution=resolution,
                notional=price * quantized_qty if quantized_qty > 0 else Decimal("0"),
                reject_reason="target_sizing_blocked",
                diagnostics=diagnostics,
            )

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

    normalized_action = decision.action.strip().lower()
    exposure_increase_qty = _exposure_increase_qty(
        action=normalized_action,
        qty=quantized_qty,
        current_qty=current_qty,
    )
    non_increasing_qty_allowance = quantized_qty - exposure_increase_qty
    diagnostics["current_qty"] = str(current_qty)
    diagnostics["exposure_increase_qty"] = str(exposure_increase_qty)
    diagnostics["non_increasing_qty_allowance"] = str(non_increasing_qty_allowance)
    short_increasing = normalized_action == "sell" and exposure_increase_qty > 0
    if short_increasing and not allow_shorts:
        return SimpleRiskPreparation(
            approved=False,
            decision=decision,
            quantity_resolution=resolution,
            notional=price * quantized_qty,
            reject_reason="shorting_not_allowed_for_asset",
            diagnostics=diagnostics,
        )

    enforce_exposure = exposure_increase_qty > 0
    adjusted_qty = quantized_qty
    capped_by_order = False
    capped_by_symbol = False
    capped_by_gross = False
    capped_by_buying_power = False
    buying_power: Decimal | None = None
    equity = _resolve_decimal(account.get("equity"))
    diagnostics["equity"] = str(equity) if equity is not None else None
    if require_equity_for_exposure_increase and enforce_exposure and equity is None:
        return SimpleRiskPreparation(
            approved=False,
            decision=decision,
            quantity_resolution=resolution,
            notional=price * quantized_qty,
            reject_reason="equity_required_for_exposure_increase",
            diagnostics=diagnostics,
        )

    if (
        enforce_exposure
        and max_notional_per_order is not None
        and max_notional_per_order >= 0
    ):
        order_cap_qty = _cap_qty_by_new_exposure_notional(
            decision=decision,
            price=price,
            current_qty=current_qty,
            cap_notional=max_notional_per_order,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        if order_cap_qty < adjusted_qty:
            adjusted_qty = order_cap_qty
            capped_by_order = True

    if (
        enforce_exposure
        and max_order_pct_equity is not None
        and max_order_pct_equity >= 0
    ):
        if equity is None:
            return SimpleRiskPreparation(
                approved=False,
                decision=decision,
                quantity_resolution=resolution,
                notional=price * quantized_qty,
                reject_reason="equity_required_for_exposure_increase",
                diagnostics=diagnostics,
            )
        equity_order_cap_notional = equity * max_order_pct_equity
        diagnostics["max_order_pct_equity"] = str(max_order_pct_equity)
        diagnostics["equity_order_cap_notional"] = str(equity_order_cap_notional)
        order_cap_qty = _cap_qty_by_new_exposure_notional(
            decision=decision,
            price=price,
            current_qty=current_qty,
            cap_notional=equity_order_cap_notional,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        if order_cap_qty < adjusted_qty:
            adjusted_qty = order_cap_qty
            capped_by_order = True

    if (
        enforce_exposure
        and max_notional_per_symbol is not None
        and max_notional_per_symbol >= 0
    ):
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
            symbol_cap_qty = _non_increasing_qty_allowance(
                action=normalized_action,
                current_qty=current_qty,
            )
            adjusted_qty = min(adjusted_qty, symbol_cap_qty)
            capped_by_symbol = True
        else:
            symbol_cap_qty = _cap_qty_by_new_exposure_notional(
                decision=decision,
                price=price,
                current_qty=current_qty,
                cap_notional=remaining_notional,
                fractional_equities_enabled=resolution.fractional_allowed,
            )
            if symbol_cap_qty < adjusted_qty:
                adjusted_qty = symbol_cap_qty
                capped_by_symbol = True

    if (
        enforce_exposure
        and max_gross_exposure_pct_equity is not None
        and max_gross_exposure_pct_equity >= 0
    ):
        if equity is None:
            return SimpleRiskPreparation(
                approved=False,
                decision=decision,
                quantity_resolution=resolution,
                notional=price * quantized_qty,
                reject_reason="equity_required_for_exposure_increase",
                diagnostics=diagnostics,
            )
        current_gross_notional = portfolio_gross_notional(
            positions,
            decision.symbol,
            fallback_price=price,
        )
        gross_cap_notional = equity * max_gross_exposure_pct_equity
        remaining_gross_notional = gross_cap_notional - current_gross_notional
        diagnostics["max_gross_exposure_pct_equity"] = str(
            max_gross_exposure_pct_equity
        )
        diagnostics["current_gross_notional"] = str(current_gross_notional)
        diagnostics["gross_cap_notional"] = str(gross_cap_notional)
        diagnostics["remaining_gross_notional_room"] = str(remaining_gross_notional)
        if remaining_gross_notional <= 0:
            gross_cap_qty = _non_increasing_qty_allowance(
                action=normalized_action,
                current_qty=current_qty,
            )
        else:
            gross_cap_qty = _cap_qty_by_new_exposure_notional(
                decision=decision,
                price=price,
                current_qty=current_qty,
                cap_notional=remaining_gross_notional,
                fractional_equities_enabled=resolution.fractional_allowed,
            )
        if gross_cap_qty < adjusted_qty:
            adjusted_qty = gross_cap_qty
            capped_by_gross = True

    if enforce_exposure:
        buying_power = _resolve_decimal(account.get("buying_power"))
        diagnostics["buying_power"] = (
            str(buying_power) if buying_power is not None else None
        )
        if buying_power is not None:
            effective_buying_power = _buying_power_after_reserve(
                buying_power=buying_power,
                reserve_bps=buying_power_reserve_bps,
            )
            diagnostics["buying_power_reserve_bps"] = str(buying_power_reserve_bps)
            diagnostics["buying_power_after_reserve"] = str(effective_buying_power)
            buying_power_cap_qty = _buying_power_cap_qty(
                decision=decision,
                price=price,
                buying_power=max(effective_buying_power, Decimal("0")),
                current_qty=current_qty,
                fractional_allowed=resolution.fractional_allowed,
            )
            diagnostics["buying_power_cap_qty"] = str(buying_power_cap_qty)
            if buying_power_cap_qty < adjusted_qty:
                adjusted_qty = buying_power_cap_qty
                capped_by_buying_power = True

    diagnostics["final_qty"] = str(adjusted_qty)
    if adjusted_qty <= 0 or adjusted_qty < min_qty:
        reject_reason = "qty_below_min_after_clamp"
        if capped_by_symbol:
            reject_reason = "max_symbol_exposure_exceeded"
        elif capped_by_gross:
            reject_reason = "max_gross_exposure_exceeded"
        elif capped_by_buying_power:
            reject_reason = "insufficient_buying_power"
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
    buying_power_required = _buying_power_required_notional(
        decision=decision,
        qty=adjusted_qty,
        price=price,
        current_qty=current_qty,
    )
    diagnostics["buying_power_required_notional"] = str(buying_power_required)
    if not enforce_exposure:
        diagnostics.setdefault("buying_power_cap_qty", str(adjusted_qty))
    if enforce_exposure:
        effective_buying_power = (
            _buying_power_after_reserve(
                buying_power=buying_power,
                reserve_bps=buying_power_reserve_bps,
            )
            if buying_power is not None
            else None
        )
        if (
            effective_buying_power is not None
            and buying_power_required > effective_buying_power
        ):
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
        "capped_by_gross": capped_by_gross,
        "capped_by_buying_power": capped_by_buying_power,
    }
    return SimpleRiskPreparation(
        approved=True,
        decision=decision.model_copy(update={"qty": adjusted_qty, "params": params}),
        quantity_resolution=resolution,
        notional=notional,
        diagnostics=diagnostics,
    )


def _extract_decision_price(decision: StrategyDecision) -> Decimal | None:
    return resolve_execution_reference_price(
        params=decision.params,
        limit_price=decision.limit_price,
        stop_price=decision.stop_price,
    )


def _resolve_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _buying_power_cap_qty(
    *,
    decision: StrategyDecision,
    price: Decimal,
    buying_power: Decimal,
    current_qty: Decimal,
    fractional_allowed: bool,
) -> Decimal:
    buying_power_qty = _non_increasing_qty_allowance(
        action=decision.action.strip().lower(),
        current_qty=current_qty,
    )
    if buying_power > 0:
        buying_power_qty += buying_power / price
    return quantize_qty_for_symbol(
        decision.symbol,
        buying_power_qty,
        fractional_equities_enabled=fractional_allowed,
    )


def _buying_power_after_reserve(
    *,
    buying_power: Decimal,
    reserve_bps: Decimal,
) -> Decimal:
    if reserve_bps <= 0:
        return buying_power
    reserve_multiplier = Decimal("1") - (reserve_bps / Decimal("10000"))
    if reserve_multiplier <= 0:
        return Decimal("0")
    return buying_power * reserve_multiplier


def _buying_power_required_notional(
    *,
    decision: StrategyDecision,
    qty: Decimal,
    price: Decimal,
    current_qty: Decimal,
) -> Decimal:
    exposure_increase_qty = _exposure_increase_qty(
        action=decision.action.strip().lower(),
        qty=qty,
        current_qty=current_qty,
    )
    if exposure_increase_qty <= 0:
        return Decimal("0")
    return price * exposure_increase_qty


def _exposure_increase_qty(
    *,
    action: str,
    qty: Decimal,
    current_qty: Decimal,
) -> Decimal:
    if qty <= 0:
        return Decimal("0")
    if action == "buy":
        if current_qty < 0:
            return max(qty - abs(current_qty), Decimal("0"))
        return qty
    if action == "sell":
        if current_qty > 0:
            return max(qty - current_qty, Decimal("0"))
        return qty
    return Decimal("0")


def _non_increasing_qty_allowance(*, action: str, current_qty: Decimal) -> Decimal:
    if action == "buy" and current_qty < 0:
        return abs(current_qty)
    if action == "sell" and current_qty > 0:
        return current_qty
    return Decimal("0")


def _cap_qty_by_new_exposure_notional(
    *,
    decision: StrategyDecision,
    price: Decimal,
    current_qty: Decimal,
    cap_notional: Decimal,
    fractional_equities_enabled: bool,
) -> Decimal:
    allowed_qty = _non_increasing_qty_allowance(
        action=decision.action.strip().lower(),
        current_qty=current_qty,
    )
    if cap_notional > 0:
        allowed_qty += cap_notional / price
    return quantize_qty_for_symbol(
        decision.symbol,
        allowed_qty,
        fractional_equities_enabled=fractional_equities_enabled,
    )


def portfolio_gross_notional(
    positions: list[dict[str, Any]],
    symbol: str,
    *,
    fallback_price: Decimal | None,
) -> Decimal:
    normalized_symbol = symbol.strip().upper()
    total = Decimal("0")
    for position in positions:
        raw_market_value = position.get("market_value")
        if raw_market_value is not None:
            try:
                total += abs(Decimal(str(raw_market_value)))
                continue
            except (ArithmeticError, ValueError):
                pass
        if fallback_price is None:
            continue
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_qty = position.get("qty") or position.get("quantity")
        if raw_qty is None:
            continue
        try:
            qty = Decimal(str(raw_qty))
        except (ArithmeticError, ValueError):
            continue
        total += abs(qty * fallback_price)
    return total


__all__ = [
    "SimpleRiskPreparation",
    "portfolio_gross_notional",
    "position_qty_for_symbol",
    "position_value_for_symbol",
    "prepare_simple_decision",
]
