"""Aggregated strategy quantity sizing helpers for the trading decision engine."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Optional, cast

from ...config import settings
from ...models import Strategy
from ..features import optional_decimal
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)


from .shared_context import (
    EXIT_ONLY_BUY_FLAT_REASON,
    EXIT_ONLY_SELL_FLAT_REASON,
    SAME_DIRECTION_REENTRY_REASON,
    SHORT_ENTRY_BELOW_MIN_QTY_REASON,
)


def resolve_aggregated_notional_budget(
    strategies: list[Strategy],
    *,
    equity: Optional[Decimal],
    runtime_target_notional: Decimal | None = None,
) -> Decimal:
    from .positions_for_strategy_action import resolve_aggregated_notional_budget

    return resolve_aggregated_notional_budget(
        strategies,
        equity=equity,
        runtime_target_notional=runtime_target_notional,
    )


def position_qty_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import position_qty_for_symbol

    return position_qty_for_symbol(positions, symbol)


def resolve_symbol_notional_cap(
    *,
    strategy_pcts: list[Optional[Decimal]],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    from .positions_for_strategy_action import resolve_symbol_notional_cap

    return resolve_symbol_notional_cap(strategy_pcts=strategy_pcts, equity=equity)


def resolve_portfolio_gross_cap(
    *,
    strategies: list[Strategy],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    from .positions_for_strategy_action import resolve_portfolio_gross_cap

    return resolve_portfolio_gross_cap(strategies=strategies, equity=equity)


def position_value_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import position_value_for_symbol

    return position_value_for_symbol(positions, symbol)


def portfolio_gross_exposure(
    positions: Optional[list[dict[str, Any]]],
) -> Decimal:
    from .positions_for_strategy_action import portfolio_gross_exposure

    return portfolio_gross_exposure(positions)


def treats_sell_as_exit_only_any(strategies: list[Strategy]) -> bool:
    from .positions_for_strategy_action import treats_sell_as_exit_only_any

    return treats_sell_as_exit_only_any(strategies)


def treats_buy_as_exit_only_any(strategies: list[Strategy]) -> bool:
    from .positions_for_strategy_action import treats_buy_as_exit_only_any

    return treats_buy_as_exit_only_any(strategies)


def blocks_same_direction_reentry_any(strategies: list[Strategy]) -> bool:
    from .positions_for_strategy_action import blocks_same_direction_reentry_any

    return blocks_same_direction_reentry_any(strategies)


def same_direction_reentry_exists(
    *,
    action: str,
    position_qty: Optional[Decimal],
) -> bool:
    from .positions_for_strategy_action import same_direction_reentry_exists

    return same_direction_reentry_exists(action=action, position_qty=position_qty)


def cap_requested_qty_by_symbol_cap(
    *,
    action: str,
    requested_qty: Decimal,
    price: Decimal,
    position_qty: Optional[Decimal],
    symbol_notional_cap: Optional[Decimal],
) -> Decimal | None:
    from .positions_for_strategy_action import cap_requested_qty_by_symbol_cap

    return cap_requested_qty_by_symbol_cap(
        action=action,
        requested_qty=requested_qty,
        price=price,
        position_qty=position_qty,
        symbol_notional_cap=symbol_notional_cap,
    )


def cap_requested_qty_by_portfolio_gross_cap(
    *,
    action: str,
    requested_qty: Decimal,
    price: Decimal,
    positions: Optional[list[dict[str, Any]]],
    portfolio_gross_cap: Optional[Decimal],
) -> Decimal | None:
    from .positions_for_strategy_action import cap_requested_qty_by_portfolio_gross_cap

    return cap_requested_qty_by_portfolio_gross_cap(
        action=action,
        requested_qty=requested_qty,
        price=price,
        positions=positions,
        portfolio_gross_cap=portfolio_gross_cap,
    )


@dataclass(frozen=True)
class AggregatedQtyContext:
    strategies: list[Strategy]
    symbol: str
    action: str
    price: Decimal
    equity: Optional[Decimal]
    positions: Optional[list[dict[str, Any]]]
    effective_capacity_positions: Optional[list[dict[str, Any]]]
    total_budget: Decimal
    budget_method: str
    symbol_notional_cap: Decimal | None
    portfolio_gross_cap: Decimal | None
    current_value: Decimal | None
    current_gross: Decimal
    position_qty: Decimal | None
    normalized_action: str
    exit_only_sell: bool
    exit_only_buy: bool


@dataclass(frozen=True)
class AggregatedCapacityAdjustment:
    original_requested_qty: Decimal
    requested_qty: Decimal
    cap_applied: bool
    portfolio_cap_applied: bool


def resolve_qty_for_aggregated(
    strategies: list[Strategy],
    *,
    symbol: str,
    action: str,
    price: Optional[Decimal],
    equity: Optional[Decimal],
    positions: Optional[list[dict[str, Any]]],
    capacity_positions: Optional[list[dict[str, Any]]] = None,
    runtime_target_notional: Decimal | None = None,
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> tuple[Decimal, dict[str, Any]]:
    default_qty = Decimal(str(settings.trading_default_qty))
    if price is None or price <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_price"}
    if not strategies:
        return default_qty, {"method": "default_qty", "reason": "no_strategies"}

    effective_capacity_positions = (
        capacity_positions if capacity_positions is not None else positions
    )
    total_budget = resolve_aggregated_notional_budget(
        strategies,
        equity=equity,
        runtime_target_notional=runtime_target_notional,
    )
    if total_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}
    budget_method = (
        "runtime_target_notional"
        if runtime_target_notional is not None and runtime_target_notional > 0
        else "aggregated_notional_budget"
    )
    context = aggregated_qty_context(
        strategies=strategies,
        symbol=symbol,
        action=action,
        price=price,
        equity=equity,
        positions=positions,
        effective_capacity_positions=effective_capacity_positions,
        total_budget=total_budget,
        budget_method=budget_method,
        runtime_exit_side=runtime_exit_side,
    )
    return resolve_qty_from_aggregated_context(context)


def aggregated_qty_context(
    *,
    strategies: list[Strategy],
    symbol: str,
    action: str,
    price: Decimal,
    equity: Optional[Decimal],
    positions: Optional[list[dict[str, Any]]],
    effective_capacity_positions: Optional[list[dict[str, Any]]],
    total_budget: Decimal,
    budget_method: str,
    runtime_exit_side: Literal["long", "short"] | None,
) -> AggregatedQtyContext:
    normalized_action = action.strip().lower()
    position_qty = position_qty_for_symbol(positions, symbol)
    return AggregatedQtyContext(
        strategies=strategies,
        symbol=symbol,
        action=action,
        price=price,
        equity=equity,
        positions=positions,
        effective_capacity_positions=effective_capacity_positions,
        total_budget=total_budget,
        budget_method=budget_method,
        symbol_notional_cap=resolve_symbol_notional_cap(
            strategy_pcts=[
                optional_decimal(strategy.max_position_pct_equity)
                for strategy in strategies
            ],
            equity=equity,
        ),
        portfolio_gross_cap=resolve_portfolio_gross_cap(
            strategies=strategies,
            equity=equity,
        ),
        current_value=position_value_for_symbol(effective_capacity_positions, symbol),
        current_gross=portfolio_gross_exposure(effective_capacity_positions),
        position_qty=position_qty,
        normalized_action=normalized_action,
        exit_only_sell=(
            treats_sell_as_exit_only_any(strategies) or runtime_exit_side == "long"
        )
        and normalized_action == "sell",
        exit_only_buy=(
            treats_buy_as_exit_only_any(strategies) or runtime_exit_side == "short"
        )
        and normalized_action == "buy",
    )


def resolve_qty_from_aggregated_context(
    context: AggregatedQtyContext,
) -> tuple[Decimal, dict[str, Any]]:
    blocked_result = aggregated_exit_or_reentry_result(context)
    if blocked_result is not None:
        return blocked_result
    capacity = aggregated_capacity_adjustment(
        context,
        aggregated_requested_qty(context),
    )
    if capacity.requested_qty <= 0:
        return aggregated_capacity_exhausted_result(context, capacity)
    resolution = resolve_quantity_resolution(
        action=context.action,
        symbol=context.symbol,
        global_enabled=settings.trading_fractional_equities_enabled,
        allow_shorts=settings.trading_allow_shorts,
        position_qty=context.position_qty,
        requested_qty=capacity.requested_qty,
    )
    qty = quantize_qty_for_symbol(
        context.symbol,
        capacity.requested_qty,
        fractional_equities_enabled=resolution.fractional_allowed,
    )
    min_qty = min_qty_for_symbol(
        context.symbol,
        fractional_equities_enabled=resolution.fractional_allowed,
    )
    min_qty_result = aggregated_min_qty_result(
        context=context,
        capacity=capacity,
        resolution=resolution,
        qty=qty,
        min_qty=min_qty,
    )
    if min_qty_result is not None:
        return min_qty_result
    if qty < min_qty:
        qty = min_qty
    return aggregated_qty_success_result(
        context=context,
        capacity=capacity,
        resolution=resolution,
        qty=qty,
    )


def aggregated_exit_or_reentry_result(
    context: AggregatedQtyContext,
) -> tuple[Decimal, dict[str, Any]] | None:
    if context.exit_only_sell and position_qty_is_flat_or_short(context.position_qty):
        return aggregated_zero_qty_result(
            context,
            reason=EXIT_ONLY_SELL_FLAT_REASON,
        )
    if context.exit_only_buy and position_qty_is_flat_or_long(context.position_qty):
        return aggregated_zero_qty_result(
            context,
            reason=EXIT_ONLY_BUY_FLAT_REASON,
        )
    if blocks_same_direction_reentry_any(
        context.strategies
    ) and same_direction_reentry_exists(
        action=context.normalized_action,
        position_qty=context.position_qty,
    ):
        return aggregated_zero_qty_result(
            context,
            reason=SAME_DIRECTION_REENTRY_REASON,
        )
    return None


def position_qty_is_flat_or_short(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty <= 0


def position_qty_is_flat_or_long(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty >= 0


def aggregated_zero_qty_result(
    context: AggregatedQtyContext,
    *,
    reason: str,
) -> tuple[Decimal, dict[str, Any]]:
    return Decimal("0"), {
        "method": context.budget_method,
        "reason": reason,
        "notional_budget": str(context.total_budget),
        "price": str(context.price),
        "position_qty": (
            str(context.position_qty) if context.position_qty is not None else None
        ),
    }


def aggregated_requested_qty(context: AggregatedQtyContext) -> Decimal:
    requested_qty = context.total_budget / context.price
    if context.exit_only_sell and positive_position_qty(context.position_qty):
        return cast(Decimal, context.position_qty)
    if context.exit_only_buy and negative_position_qty(context.position_qty):
        return abs(cast(Decimal, context.position_qty))
    return requested_qty


def positive_position_qty(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty > 0


def negative_position_qty(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty < 0


def aggregated_capacity_adjustment(
    context: AggregatedQtyContext,
    requested_qty: Decimal,
) -> AggregatedCapacityAdjustment:
    capped_by_symbol = cap_requested_qty_by_symbol_cap(
        action=context.normalized_action,
        requested_qty=requested_qty,
        price=context.price,
        position_qty=context.position_qty,
        symbol_notional_cap=context.symbol_notional_cap,
    )
    symbol_adjusted_qty = (
        capped_by_symbol if capped_by_symbol is not None else requested_qty
    )
    capped_by_portfolio = cap_requested_qty_by_portfolio_gross_cap(
        action=context.normalized_action,
        requested_qty=symbol_adjusted_qty,
        price=context.price,
        positions=context.effective_capacity_positions,
        portfolio_gross_cap=context.portfolio_gross_cap,
    )
    adjusted_qty = (
        capped_by_portfolio if capped_by_portfolio is not None else symbol_adjusted_qty
    )
    return AggregatedCapacityAdjustment(
        original_requested_qty=requested_qty,
        requested_qty=adjusted_qty,
        cap_applied=capped_by_symbol is not None and capped_by_symbol < requested_qty,
        portfolio_cap_applied=(
            capped_by_portfolio is not None
            and capped_by_portfolio < symbol_adjusted_qty
        ),
    )


def aggregated_capacity_exhausted_result(
    context: AggregatedQtyContext,
    capacity: AggregatedCapacityAdjustment,
) -> tuple[Decimal, dict[str, Any]]:
    return Decimal("0"), {
        **aggregated_capacity_meta(context, capacity),
        "reason": aggregated_capacity_reason(context, capacity),
        "requested_qty": str(capacity.original_requested_qty),
    }


def aggregated_capacity_reason(
    context: AggregatedQtyContext,
    capacity: AggregatedCapacityAdjustment,
) -> str:
    if capacity.portfolio_cap_applied or (
        context.normalized_action == "buy"
        and context.portfolio_gross_cap is not None
        and context.portfolio_gross_cap > 0
        and context.current_gross >= context.portfolio_gross_cap
    ):
        return "portfolio_gross_capacity_exhausted"
    return "symbol_capacity_exhausted"


def aggregated_min_qty_result(
    *,
    context: AggregatedQtyContext,
    capacity: AggregatedCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
    min_qty: Decimal,
) -> tuple[Decimal, dict[str, Any]] | None:
    if qty >= min_qty:
        return None
    if capacity.cap_applied or capacity.portfolio_cap_applied:
        return Decimal("0"), {
            **aggregated_capacity_meta(context, capacity),
            "reason": aggregated_min_qty_capacity_reason(capacity),
            "requested_qty": str(capacity.requested_qty),
            "min_qty": str(min_qty),
            "quantity_resolution": resolution.to_payload(),
        }
    if aggregated_short_entry_below_min(context, resolution):
        return Decimal("0"), {
            "method": context.budget_method,
            "reason": SHORT_ENTRY_BELOW_MIN_QTY_REASON,
            "notional_budget": str(context.total_budget),
            "price": str(context.price),
            "requested_qty": str(capacity.requested_qty),
            "min_qty": str(min_qty),
            "quantity_resolution": resolution.to_payload(),
        }
    return None


def aggregated_min_qty_capacity_reason(
    capacity: AggregatedCapacityAdjustment,
) -> str:
    if capacity.portfolio_cap_applied and not capacity.cap_applied:
        return "portfolio_gross_capacity_exhausted"
    return "symbol_capacity_exhausted"


def aggregated_short_entry_below_min(
    context: AggregatedQtyContext,
    resolution: Any,
) -> bool:
    position_qty = resolution.position_qty
    return (
        context.normalized_action == "sell"
        and not resolution.fractional_allowed
        and (position_qty is None or position_qty <= 0)
    )


def aggregated_qty_success_result(
    *,
    context: AggregatedQtyContext,
    capacity: AggregatedCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
) -> tuple[Decimal, dict[str, Any]]:
    return qty, {
        **aggregated_capacity_meta(context, capacity),
        "requested_qty": str(capacity.requested_qty),
        "symbol_capacity_limited": capacity.cap_applied,
        "portfolio_gross_limited": capacity.portfolio_cap_applied,
        "quantity_resolution": resolution.to_payload(),
        "position_qty": (
            str(resolution.position_qty)
            if resolution.position_qty is not None
            else None
        ),
    }


def aggregated_capacity_meta(
    context: AggregatedQtyContext,
    capacity: AggregatedCapacityAdjustment,
) -> dict[str, Any]:
    del capacity
    return {
        "method": context.budget_method,
        "notional_budget": str(context.total_budget),
        "price": str(context.price),
        "current_value": (
            str(context.current_value) if context.current_value is not None else None
        ),
        "current_gross": str(context.current_gross),
        "position_qty": (
            str(context.position_qty) if context.position_qty is not None else None
        ),
        "symbol_notional_cap": (
            str(context.symbol_notional_cap)
            if context.symbol_notional_cap is not None
            else None
        ),
        "portfolio_gross_cap": (
            str(context.portfolio_gross_cap)
            if context.portfolio_gross_cap is not None
            else None
        ),
    }


__all__ = (
    "resolve_qty_for_aggregated",
    "AggregatedCapacityAdjustment",
    "AggregatedQtyContext",
    "aggregated_capacity_adjustment",
    "aggregated_capacity_exhausted_result",
    "aggregated_capacity_meta",
    "aggregated_capacity_reason",
    "aggregated_exit_or_reentry_result",
    "aggregated_min_qty_capacity_reason",
    "aggregated_min_qty_result",
    "aggregated_qty_context",
    "aggregated_qty_success_result",
    "aggregated_requested_qty",
    "aggregated_short_entry_below_min",
    "aggregated_zero_qty_result",
    "negative_position_qty",
    "position_qty_is_flat_or_long",
    "position_qty_is_flat_or_short",
    "positive_position_qty",
    "resolve_qty_from_aggregated_context",
)
