"""Minimal hard-risk checks for the simple execution lane."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from collections.abc import Mapping
from typing import Any, cast

from .execution_metadata import set_execution_metadata
from .models import StrategyDecision
from .portfolio.allocation_helpers import portfolio_exposure
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


@dataclass(frozen=True)
class _SimpleRiskRequest:
    decision: StrategyDecision
    account: dict[str, str]
    positions: list[dict[str, Any]]
    fractional_equities_enabled: bool
    allow_shorts: bool
    max_notional_per_order: Decimal | None
    max_notional_per_symbol: Decimal | None
    buying_power_reserve_bps: Decimal
    max_order_pct_equity: Decimal | None
    max_gross_exposure_pct_equity: Decimal | None
    max_net_exposure_pct_equity: Decimal | None
    require_equity_for_exposure_increase: bool


@dataclass(frozen=True)
class _SimpleRiskContext:
    decision: StrategyDecision
    price: Decimal
    current_qty: Decimal
    resolution: QuantityResolution
    min_qty: Decimal
    quantized_qty: Decimal
    normalized_action: str
    exposure_increase_qty: Decimal
    non_increasing_qty_allowance: Decimal
    diagnostics: dict[str, Any]

    @property
    def enforce_exposure(self) -> bool:
        return self.exposure_increase_qty > 0

    @property
    def short_increasing(self) -> bool:
        return (
            self.normalized_action == "sell"
            and self.exposure_increase_qty > Decimal("0")
        )


@dataclass
class _SimpleRiskCaps:
    adjusted_qty: Decimal
    capped_by_order: bool = False
    capped_by_symbol: bool = False
    capped_by_gross: bool = False
    capped_by_net: bool = False
    capped_by_buying_power: bool = False
    buying_power: Decimal | None = None


@dataclass(frozen=True)
class _SimpleRiskFinal:
    notional: Decimal
    buying_power_required: Decimal


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


def _close_only_adjusted_decision(
    decision: StrategyDecision,
    *,
    current_qty: Decimal,
) -> tuple[StrategyDecision, dict[str, str | bool]]:
    if not isinstance(decision.params.get("position_exit"), Mapping):
        return decision, {}
    requested_qty = _resolve_decimal(decision.qty)
    if requested_qty is None or requested_qty <= 0:
        return decision, {}
    action = decision.action.strip().lower()
    close_qty: Decimal | None = None
    if action == "sell" and current_qty > 0:
        close_qty = current_qty
    elif action == "buy" and current_qty < 0:
        close_qty = abs(current_qty)
    if close_qty is None or requested_qty <= close_qty:
        return decision, {}
    return (
        decision.model_copy(update={"qty": close_qty}),
        {
            "close_only_qty_clamped": True,
            "close_only_requested_qty": str(requested_qty),
            "close_only_position_qty": str(close_qty),
        },
    )


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
    max_net_exposure_pct_equity: Decimal | None = None,
    require_equity_for_exposure_increase: bool = False,
) -> SimpleRiskPreparation:
    return _prepare_simple_risk_request(
        _SimpleRiskRequest(
            decision=decision,
            account=account,
            positions=positions,
            fractional_equities_enabled=fractional_equities_enabled,
            allow_shorts=allow_shorts,
            max_notional_per_order=max_notional_per_order,
            max_notional_per_symbol=max_notional_per_symbol,
            buying_power_reserve_bps=buying_power_reserve_bps,
            max_order_pct_equity=max_order_pct_equity,
            max_gross_exposure_pct_equity=max_gross_exposure_pct_equity,
            max_net_exposure_pct_equity=max_net_exposure_pct_equity,
            require_equity_for_exposure_increase=require_equity_for_exposure_increase,
        )
    )


def _prepare_simple_risk_request(
    request: _SimpleRiskRequest,
) -> SimpleRiskPreparation:
    context, rejection = _build_simple_risk_context(
        decision=request.decision,
        positions=request.positions,
        fractional_equities_enabled=request.fractional_equities_enabled,
        allow_shorts=request.allow_shorts,
    )
    if rejection is not None:
        return rejection
    if context is None:
        raise RuntimeError("simple_risk_context_missing")

    rejection = _initial_simple_risk_rejection(
        context=context,
        account=request.account,
        allow_shorts=request.allow_shorts,
        require_equity_for_exposure_increase=(
            request.require_equity_for_exposure_increase
        ),
        max_order_pct_equity=request.max_order_pct_equity,
        max_gross_exposure_pct_equity=request.max_gross_exposure_pct_equity,
        max_net_exposure_pct_equity=request.max_net_exposure_pct_equity,
    )
    if rejection is not None:
        return rejection

    caps = _apply_simple_risk_caps(
        context=context,
        account=request.account,
        positions=request.positions,
        buying_power_reserve_bps=request.buying_power_reserve_bps,
        max_notional_per_order=request.max_notional_per_order,
        max_notional_per_symbol=request.max_notional_per_symbol,
        max_order_pct_equity=request.max_order_pct_equity,
        max_gross_exposure_pct_equity=request.max_gross_exposure_pct_equity,
        max_net_exposure_pct_equity=request.max_net_exposure_pct_equity,
    )
    rejection = _final_quantity_rejection(context=context, caps=caps)
    if rejection is not None:
        return rejection

    final = _build_simple_risk_final(context=context, caps=caps)
    rejection = _buying_power_rejection(
        context=context,
        caps=caps,
        final=final,
        buying_power_reserve_bps=request.buying_power_reserve_bps,
    )
    if rejection is not None:
        return rejection
    return _approved_simple_risk(context=context, caps=caps, final=final)


def _build_simple_risk_context(
    *,
    decision: StrategyDecision,
    positions: list[dict[str, Any]],
    fractional_equities_enabled: bool,
    allow_shorts: bool,
) -> tuple[_SimpleRiskContext | None, SimpleRiskPreparation | None]:
    price = _extract_decision_price(decision)
    current_qty = position_qty_for_symbol(positions, decision.symbol)
    decision, close_only_diagnostics = _close_only_adjusted_decision(
        decision,
        current_qty=current_qty,
    )
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
    diagnostics.update(close_only_diagnostics)
    if price is None or price <= 0:
        diagnostics["price"] = None if price is None else str(price)
        return None, _rejected_simple_risk_preparation(
            decision=decision,
            quantity_resolution=resolution,
            notional=None,
            reject_reason="broker_precheck_failed",
            diagnostics=diagnostics,
        )

    diagnostics["price"] = str(price)
    normalized_action = decision.action.strip().lower()
    exposure_increase_qty = _exposure_increase_qty(
        action=normalized_action,
        qty=quantized_qty,
        current_qty=current_qty,
    )
    return (
        _SimpleRiskContext(
            decision=decision,
            price=price,
            current_qty=current_qty,
            resolution=resolution,
            min_qty=min_qty,
            quantized_qty=quantized_qty,
            normalized_action=normalized_action,
            exposure_increase_qty=exposure_increase_qty,
            non_increasing_qty_allowance=quantized_qty - exposure_increase_qty,
            diagnostics=diagnostics,
        ),
        None,
    )


def _initial_simple_risk_rejection(
    *,
    context: _SimpleRiskContext,
    account: dict[str, str],
    allow_shorts: bool,
    require_equity_for_exposure_increase: bool,
    max_order_pct_equity: Decimal | None,
    max_gross_exposure_pct_equity: Decimal | None,
    max_net_exposure_pct_equity: Decimal | None,
) -> SimpleRiskPreparation | None:
    target_sizing_rejection = _target_sizing_rejection(context)
    if target_sizing_rejection is not None:
        return target_sizing_rejection
    if context.quantized_qty <= 0 or context.quantized_qty < context.min_qty:
        return _rejected_simple_risk_preparation(
            decision=context.decision,
            quantity_resolution=context.resolution,
            notional=_positive_notional(context.price, context.quantized_qty),
            reject_reason="qty_below_min_after_clamp",
            diagnostics=context.diagnostics,
        )
    if not qty_has_valid_increment(
        context.decision.symbol,
        context.quantized_qty,
        fractional_equities_enabled=context.resolution.fractional_allowed,
    ):
        return _rejected_simple_risk_preparation(
            decision=context.decision,
            quantity_resolution=context.resolution,
            notional=context.price * context.quantized_qty,
            reject_reason="invalid_qty_increment",
            diagnostics=context.diagnostics,
        )
    if context.short_increasing and not allow_shorts:
        return _rejected_simple_risk_preparation(
            decision=context.decision,
            quantity_resolution=context.resolution,
            notional=context.price * context.quantized_qty,
            reject_reason="shorting_not_allowed_for_asset",
            diagnostics=context.diagnostics,
        )
    equity = _resolve_equity(context, account)
    if _equity_required_for_exposure(
        context=context,
        equity=equity,
        require_equity_for_exposure_increase=require_equity_for_exposure_increase,
        max_order_pct_equity=max_order_pct_equity,
        max_gross_exposure_pct_equity=max_gross_exposure_pct_equity,
        max_net_exposure_pct_equity=max_net_exposure_pct_equity,
    ):
        return _rejected_simple_risk_preparation(
            decision=context.decision,
            quantity_resolution=context.resolution,
            notional=context.price * context.quantized_qty,
            reject_reason="equity_required_for_exposure_increase",
            diagnostics=context.diagnostics,
        )
    return None


def _target_sizing_rejection(
    context: _SimpleRiskContext,
) -> SimpleRiskPreparation | None:
    raw_target_sizing = context.decision.params.get("target_sizing")
    if not isinstance(raw_target_sizing, Mapping):
        return None
    target_sizing = target_sizing_payload(cast(Mapping[str, Any], raw_target_sizing))
    context.diagnostics["target_sizing"] = target_sizing
    if not target_sizing["blocking_reasons"]:
        return None
    return _rejected_simple_risk_preparation(
        decision=context.decision,
        quantity_resolution=context.resolution,
        notional=_positive_notional(context.price, context.quantized_qty),
        reject_reason="target_sizing_blocked",
        diagnostics=context.diagnostics,
    )


def _equity_required_for_exposure(
    *,
    context: _SimpleRiskContext,
    equity: Decimal | None,
    require_equity_for_exposure_increase: bool,
    max_order_pct_equity: Decimal | None,
    max_gross_exposure_pct_equity: Decimal | None,
    max_net_exposure_pct_equity: Decimal | None,
) -> bool:
    if not context.enforce_exposure or equity is not None:
        return False
    return (
        require_equity_for_exposure_increase
        or _non_negative_limit(max_order_pct_equity)
        or _non_negative_limit(max_gross_exposure_pct_equity)
        or _non_negative_limit(max_net_exposure_pct_equity)
    )


def _resolve_equity(
    context: _SimpleRiskContext,
    account: dict[str, str],
) -> Decimal | None:
    equity = _resolve_decimal(account.get("equity"))
    context.diagnostics["equity"] = str(equity) if equity is not None else None
    return equity


def _apply_simple_risk_caps(
    *,
    context: _SimpleRiskContext,
    account: dict[str, str],
    positions: list[dict[str, Any]],
    buying_power_reserve_bps: Decimal,
    max_notional_per_order: Decimal | None,
    max_notional_per_symbol: Decimal | None,
    max_order_pct_equity: Decimal | None,
    max_gross_exposure_pct_equity: Decimal | None,
    max_net_exposure_pct_equity: Decimal | None,
) -> _SimpleRiskCaps:
    caps = _SimpleRiskCaps(adjusted_qty=context.quantized_qty)
    if context.enforce_exposure:
        equity = _resolve_equity(context, account)
        _apply_order_notional_cap(context, caps, max_notional_per_order)
        _apply_equity_order_cap(context, caps, equity, max_order_pct_equity)
        _apply_symbol_notional_cap(context, caps, positions, max_notional_per_symbol)
        _apply_gross_exposure_cap(
            context,
            caps,
            positions,
            equity,
            max_gross_exposure_pct_equity,
        )
        _apply_net_exposure_cap(
            context,
            caps,
            positions,
            equity,
            max_net_exposure_pct_equity,
        )
        _apply_buying_power_cap(
            context,
            caps,
            account=account,
            buying_power_reserve_bps=buying_power_reserve_bps,
        )
    context.diagnostics["final_qty"] = str(caps.adjusted_qty)
    return caps


def _apply_order_notional_cap(
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    max_notional_per_order: Decimal | None,
) -> None:
    if not _non_negative_limit(max_notional_per_order):
        return
    order_cap_qty = _cap_qty_by_new_exposure_notional(
        decision=context.decision,
        price=context.price,
        current_qty=context.current_qty,
        cap_notional=cast(Decimal, max_notional_per_order),
        fractional_equities_enabled=context.resolution.fractional_allowed,
    )
    if order_cap_qty < caps.adjusted_qty:
        caps.adjusted_qty = order_cap_qty
        caps.capped_by_order = True


def _apply_equity_order_cap(
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    equity: Decimal | None,
    max_order_pct_equity: Decimal | None,
) -> None:
    if equity is None or not _non_negative_limit(max_order_pct_equity):
        return
    equity_order_cap_notional = equity * cast(Decimal, max_order_pct_equity)
    context.diagnostics["max_order_pct_equity"] = str(max_order_pct_equity)
    context.diagnostics["equity_order_cap_notional"] = str(equity_order_cap_notional)
    order_cap_qty = _cap_qty_by_new_exposure_notional(
        decision=context.decision,
        price=context.price,
        current_qty=context.current_qty,
        cap_notional=equity_order_cap_notional,
        fractional_equities_enabled=context.resolution.fractional_allowed,
    )
    if order_cap_qty < caps.adjusted_qty:
        caps.adjusted_qty = order_cap_qty
        caps.capped_by_order = True


def _apply_symbol_notional_cap(
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    positions: list[dict[str, Any]],
    max_notional_per_symbol: Decimal | None,
) -> None:
    if not _non_negative_limit(max_notional_per_symbol):
        return
    current_abs_value = abs(
        position_value_for_symbol(
            positions,
            context.decision.symbol,
            fallback_price=context.price,
        )
    )
    remaining_notional = cast(Decimal, max_notional_per_symbol) - current_abs_value
    context.diagnostics["current_symbol_abs_notional"] = str(current_abs_value)
    context.diagnostics["remaining_symbol_notional_room"] = str(remaining_notional)
    symbol_cap_qty = (
        _non_increasing_qty_allowance(
            action=context.normalized_action,
            current_qty=context.current_qty,
        )
        if remaining_notional <= 0
        else _cap_qty_by_new_exposure_notional(
            decision=context.decision,
            price=context.price,
            current_qty=context.current_qty,
            cap_notional=remaining_notional,
            fractional_equities_enabled=context.resolution.fractional_allowed,
        )
    )
    if symbol_cap_qty < caps.adjusted_qty:
        caps.adjusted_qty = symbol_cap_qty
        caps.capped_by_symbol = True


def _apply_gross_exposure_cap(
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    positions: list[dict[str, Any]],
    equity: Decimal | None,
    max_gross_exposure_pct_equity: Decimal | None,
) -> None:
    if equity is None or not _non_negative_limit(max_gross_exposure_pct_equity):
        return
    current_gross_notional = portfolio_gross_notional(
        positions,
        context.decision.symbol,
        fallback_price=context.price,
    )
    gross_cap_notional = equity * cast(Decimal, max_gross_exposure_pct_equity)
    remaining_gross_notional = gross_cap_notional - current_gross_notional
    context.diagnostics["max_gross_exposure_pct_equity"] = str(
        max_gross_exposure_pct_equity
    )
    context.diagnostics["current_gross_notional"] = str(current_gross_notional)
    context.diagnostics["gross_cap_notional"] = str(gross_cap_notional)
    context.diagnostics["remaining_gross_notional_room"] = str(remaining_gross_notional)
    gross_cap_qty = (
        _non_increasing_qty_allowance(
            action=context.normalized_action,
            current_qty=context.current_qty,
        )
        if remaining_gross_notional <= 0
        else _cap_qty_by_new_exposure_notional(
            decision=context.decision,
            price=context.price,
            current_qty=context.current_qty,
            cap_notional=remaining_gross_notional,
            fractional_equities_enabled=context.resolution.fractional_allowed,
        )
    )
    if gross_cap_qty < caps.adjusted_qty:
        caps.adjusted_qty = gross_cap_qty
        caps.capped_by_gross = True


def _apply_net_exposure_cap(
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    positions: list[dict[str, Any]],
    equity: Decimal | None,
    max_net_exposure_pct_equity: Decimal | None,
) -> None:
    if equity is None or not _non_negative_limit(max_net_exposure_pct_equity):
        return
    _, current_net_notional = portfolio_exposure(positions)
    net_cap_notional = equity * cast(Decimal, max_net_exposure_pct_equity)
    if context.normalized_action == "buy":
        remaining_net_notional = net_cap_notional - current_net_notional
    else:
        remaining_net_notional = net_cap_notional + current_net_notional
    context.diagnostics["max_net_exposure_pct_equity"] = str(
        max_net_exposure_pct_equity
    )
    context.diagnostics["current_net_notional"] = str(current_net_notional)
    context.diagnostics["net_cap_notional"] = str(net_cap_notional)
    context.diagnostics["remaining_net_notional_room"] = str(remaining_net_notional)
    net_cap_qty = quantize_qty_for_symbol(
        context.decision.symbol,
        max(remaining_net_notional, Decimal("0")) / context.price,
        fractional_equities_enabled=context.resolution.fractional_allowed,
    )
    if net_cap_qty < caps.adjusted_qty:
        caps.adjusted_qty = net_cap_qty
        caps.capped_by_net = True


def _apply_buying_power_cap(
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    *,
    account: dict[str, str],
    buying_power_reserve_bps: Decimal,
) -> None:
    caps.buying_power = _resolve_decimal(account.get("buying_power"))
    context.diagnostics["buying_power"] = (
        str(caps.buying_power) if caps.buying_power is not None else None
    )
    if caps.buying_power is None:
        return
    effective_buying_power = _buying_power_after_reserve(
        buying_power=caps.buying_power,
        reserve_bps=buying_power_reserve_bps,
    )
    context.diagnostics["buying_power_reserve_bps"] = str(buying_power_reserve_bps)
    context.diagnostics["buying_power_after_reserve"] = str(effective_buying_power)
    buying_power_price = _buying_power_reference_price(
        context.decision,
        context.price,
    )
    context.diagnostics["buying_power_reference_price"] = str(buying_power_price)
    buying_power_cap_qty = _buying_power_cap_qty(
        decision=context.decision,
        price=buying_power_price,
        buying_power=max(effective_buying_power, Decimal("0")),
        current_qty=context.current_qty,
        fractional_allowed=context.resolution.fractional_allowed,
    )
    context.diagnostics["buying_power_cap_qty"] = str(buying_power_cap_qty)
    if buying_power_cap_qty < caps.adjusted_qty:
        caps.adjusted_qty = buying_power_cap_qty
        caps.capped_by_buying_power = True


def _final_quantity_rejection(
    *,
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
) -> SimpleRiskPreparation | None:
    if caps.adjusted_qty <= 0 or caps.adjusted_qty < context.min_qty:
        return _rejected_simple_risk_preparation(
            decision=context.decision,
            quantity_resolution=context.resolution,
            notional=_positive_notional(context.price, caps.adjusted_qty),
            reject_reason=_quantity_reject_reason(caps),
            diagnostics=context.diagnostics,
        )
    if qty_has_valid_increment(
        context.decision.symbol,
        caps.adjusted_qty,
        fractional_equities_enabled=context.resolution.fractional_allowed,
    ):
        return None
    return _rejected_simple_risk_preparation(
        decision=context.decision,
        quantity_resolution=context.resolution,
        notional=context.price * caps.adjusted_qty,
        reject_reason="invalid_qty_increment",
        diagnostics=context.diagnostics,
    )


def _build_simple_risk_final(
    *,
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
) -> _SimpleRiskFinal:
    notional = context.price * caps.adjusted_qty
    context.diagnostics["final_notional"] = str(notional)
    buying_power_required = _buying_power_required_notional(
        decision=context.decision,
        qty=caps.adjusted_qty,
        price=context.price,
        current_qty=context.current_qty,
    )
    context.diagnostics["buying_power_required_notional"] = str(buying_power_required)
    if not context.enforce_exposure:
        context.diagnostics.setdefault("buying_power_cap_qty", str(caps.adjusted_qty))
    return _SimpleRiskFinal(
        notional=notional,
        buying_power_required=buying_power_required,
    )


def _buying_power_rejection(
    *,
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    final: _SimpleRiskFinal,
    buying_power_reserve_bps: Decimal,
) -> SimpleRiskPreparation | None:
    if not context.enforce_exposure or caps.buying_power is None:
        return None
    effective_buying_power = _buying_power_after_reserve(
        buying_power=caps.buying_power,
        reserve_bps=buying_power_reserve_bps,
    )
    if final.buying_power_required <= effective_buying_power:
        return None
    return _rejected_simple_risk_preparation(
        decision=context.decision,
        quantity_resolution=context.resolution,
        notional=final.notional,
        reject_reason="insufficient_buying_power",
        diagnostics=context.diagnostics,
    )


def _approved_simple_risk(
    *,
    context: _SimpleRiskContext,
    caps: _SimpleRiskCaps,
    final: _SimpleRiskFinal,
) -> SimpleRiskPreparation:
    params = dict(context.decision.params)
    params["execution_lane"] = "simple"
    params["submit_path"] = "direct_alpaca"
    set_execution_metadata(
        params,
        {
            "requested_qty": str(context.decision.qty),
            "final_qty": str(caps.adjusted_qty),
            "price": str(context.price),
            "notional": str(final.notional),
            "quantity_resolution": context.resolution.to_payload(),
            "capped_by_order": caps.capped_by_order,
            "capped_by_symbol": caps.capped_by_symbol,
            "capped_by_gross": caps.capped_by_gross,
            "capped_by_net": caps.capped_by_net,
            "capped_by_buying_power": caps.capped_by_buying_power,
        },
    )
    return SimpleRiskPreparation(
        approved=True,
        decision=context.decision.model_copy(
            update={"qty": caps.adjusted_qty, "params": params}
        ),
        quantity_resolution=context.resolution,
        notional=final.notional,
        diagnostics=context.diagnostics,
    )


def _rejected_simple_risk_preparation(
    *,
    decision: StrategyDecision,
    quantity_resolution: QuantityResolution,
    notional: Decimal | None,
    reject_reason: str,
    diagnostics: dict[str, Any],
) -> SimpleRiskPreparation:
    return SimpleRiskPreparation(
        approved=False,
        decision=decision,
        quantity_resolution=quantity_resolution,
        notional=notional,
        reject_reason=reject_reason,
        diagnostics=diagnostics,
    )


def _positive_notional(price: Decimal, qty: Decimal) -> Decimal:
    return price * qty if qty > 0 else Decimal("0")


def _non_negative_limit(limit: Decimal | None) -> bool:
    return limit is not None and limit >= 0


def _quantity_reject_reason(caps: _SimpleRiskCaps) -> str:
    if caps.capped_by_symbol:
        return "max_symbol_exposure_exceeded"
    if caps.capped_by_gross:
        return "max_gross_exposure_exceeded"
    if caps.capped_by_net:
        return "max_net_exposure_exceeded"
    if caps.capped_by_buying_power:
        return "insufficient_buying_power"
    if caps.capped_by_order:
        return "max_notional_exceeded"
    return "qty_below_min_after_clamp"


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
    return _buying_power_reference_price(decision, price) * exposure_increase_qty


def _buying_power_reference_price(
    decision: StrategyDecision,
    price: Decimal,
) -> Decimal:
    if decision.action.strip().lower() != "sell":
        return price
    snapshot = decision.params.get("price_snapshot")
    if not isinstance(snapshot, Mapping):
        return price
    ask = _resolve_decimal(cast(Mapping[object, object], snapshot).get("ask"))
    if ask is None or ask <= 0:
        return price
    return max(price, ask * Decimal("1.03"))


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
