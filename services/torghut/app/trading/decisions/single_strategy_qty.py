"""Single-strategy quantity sizing helpers for the trading decision engine."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional, cast

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


def position_qty_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import position_qty_for_symbol

    return position_qty_for_symbol(positions, symbol)


def treats_sell_as_exit_only(strategy: Strategy) -> bool:
    from .positions_for_strategy_action import treats_sell_as_exit_only

    return treats_sell_as_exit_only(strategy)


def treats_buy_as_exit_only(strategy: Strategy) -> bool:
    from .positions_for_strategy_action import treats_buy_as_exit_only

    return treats_buy_as_exit_only(strategy)


def blocks_same_direction_reentry(strategy: Strategy) -> bool:
    from .positions_for_strategy_action import blocks_same_direction_reentry

    return blocks_same_direction_reentry(strategy)


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


def skip_non_executable_decision_qty(
    *, qty: Decimal, sizing_meta: Mapping[str, Any]
) -> bool:
    reason = str(sizing_meta.get("reason") or "").strip()
    return qty <= 0 and reason in {
        EXIT_ONLY_SELL_FLAT_REASON,
        EXIT_ONLY_BUY_FLAT_REASON,
        SHORT_ENTRY_BELOW_MIN_QTY_REASON,
        SAME_DIRECTION_REENTRY_REASON,
        "symbol_capacity_exhausted",
        "portfolio_gross_capacity_exhausted",
    }


@dataclass(frozen=True)
class StrategyBudget:
    notional_budget: Decimal | None
    method: str


@dataclass(frozen=True)
class SingleStrategyQtyContext:
    strategy: Strategy
    symbol: str
    action: str
    price: Decimal
    equity: Decimal | None
    positions: list[dict[str, Any]] | None
    notional_budget: Decimal
    method: str
    symbol_notional_cap: Decimal | None
    portfolio_gross_cap: Decimal | None
    current_value: Decimal | None
    current_gross: Decimal
    position_qty: Decimal | None
    normalized_action: str
    exit_only_sell: bool
    exit_only_buy: bool


@dataclass(frozen=True)
class SingleStrategyCapacityAdjustment:
    original_requested_qty: Decimal
    requested_qty: Decimal
    cap_applied: bool
    portfolio_cap_applied: bool


def resolve_qty(
    strategy: Strategy,
    *,
    symbol: str,
    action: str,
    price: Optional[Decimal],
    equity: Optional[Decimal],
    positions: Optional[list[dict[str, Any]]],
) -> tuple[Decimal, dict[str, Any]]:
    """Resolve an asset-class-aware quantity from strategy settings.

    Live mode uses equity-relative strategy sizing and ignores fixed notional
    budgets. Paper and simulation retain the replay contract precedence:
    - `min(max_notional_per_trade, equity * max_position_pct_equity)` when both are available
    - `max_notional_per_trade`
    - `equity * max_position_pct_equity`
    - global `TRADING_MAX_NOTIONAL_PER_TRADE` / `TRADING_MAX_POSITION_PCT_EQUITY`
    - global `TRADING_DEFAULT_QTY` fallback
    """

    default_qty = Decimal(str(settings.trading_default_qty))
    if price is None or price <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_price"}
    budget = single_strategy_budget(strategy=strategy, equity=equity)
    if budget.notional_budget is None or budget.notional_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}
    context = single_strategy_qty_context(
        strategy=strategy,
        symbol=symbol,
        action=action,
        price=price,
        equity=equity,
        positions=positions,
        budget=budget,
    )
    return resolve_single_strategy_qty_from_context(context)


def single_strategy_budget(
    *,
    strategy: Strategy,
    equity: Decimal | None,
) -> StrategyBudget:
    max_notional = optional_decimal(strategy.max_notional_per_trade)
    max_pct = optional_decimal(strategy.max_position_pct_equity)
    if settings.trading_mode == "live":
        live_pcts = [
            value
            for value in (
                max_pct,
                optional_decimal(settings.trading_max_position_pct_equity),
                optional_decimal(settings.trading_simple_max_symbol_pct_equity),
            )
            if value is not None and value > 0
        ]
        live_pct = min(live_pcts) if live_pcts else None
        return StrategyBudget(
            notional_budget=(
                equity * live_pct
                if equity is not None and live_pct is not None and equity > 0
                else None
            ),
            method="live_equity_pct",
        )
    pct_notional: Optional[Decimal] = None
    if equity is not None and max_pct is not None and max_pct > 0:
        pct_notional = equity * max_pct

    notional_budget: Optional[Decimal] = None
    method = "default_qty"
    if max_notional is not None and max_notional > 0 and pct_notional is not None:
        notional_budget = min(max_notional, pct_notional)
        method = "min(max_notional,pct_equity)"
    elif max_notional is not None and max_notional > 0:
        notional_budget = max_notional
        method = "max_notional_per_trade"
    elif pct_notional is not None:
        notional_budget = pct_notional
        method = "max_position_pct_equity"
    else:
        # Fall back to a global max_notional to avoid fixed-share trading when no strategy sizing is configured.
        global_notional = optional_decimal(settings.trading_max_notional_per_trade)
        if global_notional is not None and global_notional > 0:
            notional_budget = global_notional
            method = "global_max_notional_per_trade"
    return StrategyBudget(notional_budget=notional_budget, method=method)


def single_strategy_qty_context(
    *,
    strategy: Strategy,
    symbol: str,
    action: str,
    price: Decimal,
    equity: Decimal | None,
    positions: list[dict[str, Any]] | None,
    budget: StrategyBudget,
) -> SingleStrategyQtyContext:
    symbol_notional_cap = resolve_symbol_notional_cap(
        strategy_pcts=[optional_decimal(strategy.max_position_pct_equity)],
        equity=equity,
    )
    portfolio_gross_cap = resolve_portfolio_gross_cap(
        strategies=[strategy],
        equity=equity,
    )
    current_value = position_value_for_symbol(positions, symbol)
    current_gross = portfolio_gross_exposure(positions)
    position_qty = position_qty_for_symbol(positions, symbol)
    normalized_action = action.strip().lower()
    exit_only_sell = treats_sell_as_exit_only(strategy) and normalized_action == "sell"
    exit_only_buy = treats_buy_as_exit_only(strategy) and normalized_action == "buy"
    return SingleStrategyQtyContext(
        strategy=strategy,
        symbol=symbol,
        action=action,
        price=price,
        equity=equity,
        positions=positions,
        notional_budget=cast(Decimal, budget.notional_budget),
        method=budget.method,
        symbol_notional_cap=symbol_notional_cap,
        portfolio_gross_cap=portfolio_gross_cap,
        current_value=current_value,
        current_gross=current_gross,
        position_qty=position_qty,
        normalized_action=normalized_action,
        exit_only_sell=exit_only_sell,
        exit_only_buy=exit_only_buy,
    )


def resolve_single_strategy_qty_from_context(
    context: SingleStrategyQtyContext,
) -> tuple[Decimal, dict[str, Any]]:
    exit_result = single_strategy_exit_guard_result(context)
    if exit_result is not None:
        return exit_result
    capacity = single_strategy_capacity_adjustment(
        context,
        requested_qty=single_strategy_requested_qty(context),
    )
    if capacity.requested_qty <= 0:
        return single_strategy_capacity_exhausted_result(context, capacity)
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
    min_qty_result = single_strategy_min_qty_result(
        context=context,
        capacity=capacity,
        resolution=resolution,
        qty=qty,
        min_qty=min_qty,
    )
    if min_qty_result is not None:
        return min_qty_result
    result_position_qty = context.position_qty
    if qty < min_qty:
        qty = min_qty
        result_position_qty = resolution.position_qty
    return single_strategy_success_result(
        context=context,
        capacity=capacity,
        resolution=resolution,
        qty=qty,
        position_qty=result_position_qty,
    )


def single_strategy_exit_guard_result(
    context: SingleStrategyQtyContext,
) -> tuple[Decimal, dict[str, Any]] | None:
    if (
        context.exit_only_sell
        and context.position_qty is not None
        and context.position_qty <= 0
    ):
        return Decimal("0"), {
            "method": context.method,
            "reason": EXIT_ONLY_SELL_FLAT_REASON,
            "notional_budget": str(context.notional_budget),
            "price": str(context.price),
            "position_qty": str(context.position_qty),
        }
    if (
        context.exit_only_buy
        and context.position_qty is not None
        and context.position_qty >= 0
    ):
        return Decimal("0"), {
            "method": context.method,
            "reason": EXIT_ONLY_BUY_FLAT_REASON,
            "notional_budget": str(context.notional_budget),
            "price": str(context.price),
            "position_qty": str(context.position_qty),
        }
    if blocks_same_direction_reentry(
        context.strategy
    ) and same_direction_reentry_exists(
        action=context.normalized_action,
        position_qty=context.position_qty,
    ):
        return Decimal("0"), {
            "method": context.method,
            "reason": SAME_DIRECTION_REENTRY_REASON,
            "notional_budget": str(context.notional_budget),
            "price": str(context.price),
            "position_qty": (
                str(context.position_qty) if context.position_qty is not None else None
            ),
        }
    return None


def single_strategy_requested_qty(context: SingleStrategyQtyContext) -> Decimal:
    requested_qty = context.notional_budget / context.price
    if (
        context.exit_only_sell
        and context.position_qty is not None
        and context.position_qty > 0
    ):
        requested_qty = context.position_qty
    if (
        context.exit_only_buy
        and context.position_qty is not None
        and context.position_qty < 0
    ):
        requested_qty = abs(context.position_qty)
    return requested_qty


def single_strategy_capacity_adjustment(
    context: SingleStrategyQtyContext,
    *,
    requested_qty: Decimal,
) -> SingleStrategyCapacityAdjustment:
    capped_requested_qty = cap_requested_qty_by_symbol_cap(
        action=context.normalized_action,
        requested_qty=requested_qty,
        price=context.price,
        position_qty=context.position_qty,
        symbol_notional_cap=context.symbol_notional_cap,
    )
    cap_applied = (
        capped_requested_qty is not None and capped_requested_qty < requested_qty
    )
    if capped_requested_qty is not None:
        requested_qty = capped_requested_qty
    capped_by_portfolio_qty = cap_requested_qty_by_portfolio_gross_cap(
        action=context.normalized_action,
        requested_qty=requested_qty,
        price=context.price,
        positions=context.positions,
        portfolio_gross_cap=context.portfolio_gross_cap,
    )
    portfolio_cap_applied = (
        capped_by_portfolio_qty is not None and capped_by_portfolio_qty < requested_qty
    )
    if capped_by_portfolio_qty is not None:
        requested_qty = capped_by_portfolio_qty
    return SingleStrategyCapacityAdjustment(
        original_requested_qty=context.notional_budget / context.price,
        requested_qty=requested_qty,
        cap_applied=cap_applied,
        portfolio_cap_applied=portfolio_cap_applied,
    )


def single_strategy_capacity_exhausted_result(
    context: SingleStrategyQtyContext,
    capacity: SingleStrategyCapacityAdjustment,
) -> tuple[Decimal, dict[str, Any]]:
    return Decimal("0"), {
        "reason": single_strategy_capacity_reason(context, capacity),
        "requested_qty": str(capacity.original_requested_qty),
        **single_strategy_common_meta(context, position_qty=context.position_qty),
    }


def single_strategy_capacity_reason(
    context: SingleStrategyQtyContext,
    capacity: SingleStrategyCapacityAdjustment,
) -> str:
    if capacity.portfolio_cap_applied:
        return "portfolio_gross_capacity_exhausted"
    if (
        context.normalized_action == "buy"
        and context.portfolio_gross_cap is not None
        and context.portfolio_gross_cap > 0
        and context.current_gross >= context.portfolio_gross_cap
    ):
        return "portfolio_gross_capacity_exhausted"
    return "symbol_capacity_exhausted"


def single_strategy_min_qty_result(
    *,
    context: SingleStrategyQtyContext,
    capacity: SingleStrategyCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
    min_qty: Decimal,
) -> tuple[Decimal, dict[str, Any]] | None:
    if qty >= min_qty:
        return None
    if qty < min_qty:
        if capacity.cap_applied or capacity.portfolio_cap_applied:
            return Decimal("0"), {
                "reason": single_strategy_min_qty_capacity_reason(capacity),
                "requested_qty": str(capacity.requested_qty),
                "min_qty": str(min_qty),
                "quantity_resolution": resolution.to_payload(),
                **single_strategy_common_meta(
                    context,
                    position_qty=context.position_qty,
                ),
            }
        return single_strategy_short_entry_below_min_result(
            context=context,
            resolution=resolution,
            requested_qty=capacity.requested_qty,
            min_qty=min_qty,
        )
    return None


def single_strategy_min_qty_capacity_reason(
    capacity: SingleStrategyCapacityAdjustment,
) -> str:
    if capacity.portfolio_cap_applied and not capacity.cap_applied:
        return "portfolio_gross_capacity_exhausted"
    return "symbol_capacity_exhausted"


def single_strategy_short_entry_below_min_result(
    *,
    context: SingleStrategyQtyContext,
    resolution: Any,
    requested_qty: Decimal,
    min_qty: Decimal,
) -> tuple[Decimal, dict[str, Any]] | None:
    position_qty = resolution.position_qty
    entering_short = (
        context.normalized_action == "sell"
        and not resolution.fractional_allowed
        and (position_qty is None or position_qty <= 0)
    )
    if not entering_short:
        return None
    return Decimal("0"), {
        "method": context.method,
        "reason": SHORT_ENTRY_BELOW_MIN_QTY_REASON,
        "notional_budget": str(context.notional_budget),
        "price": str(context.price),
        "requested_qty": str(requested_qty),
        "min_qty": str(min_qty),
        "quantity_resolution": resolution.to_payload(),
    }


def single_strategy_success_result(
    *,
    context: SingleStrategyQtyContext,
    capacity: SingleStrategyCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
    position_qty: Decimal | None,
) -> tuple[Decimal, dict[str, Any]]:
    return qty, {
        "requested_qty": str(capacity.requested_qty),
        "symbol_capacity_limited": capacity.cap_applied,
        "portfolio_gross_limited": capacity.portfolio_cap_applied,
        "quantity_resolution": resolution.to_payload(),
        **single_strategy_common_meta(context, position_qty=position_qty),
    }


def single_strategy_common_meta(
    context: SingleStrategyQtyContext,
    *,
    position_qty: Decimal | None,
) -> dict[str, Any]:
    return {
        "method": context.method,
        "notional_budget": str(context.notional_budget),
        "price": str(context.price),
        "current_value": (
            str(context.current_value) if context.current_value is not None else None
        ),
        "current_gross": str(context.current_gross),
        "position_qty": str(position_qty) if position_qty is not None else None,
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
    "SingleStrategyCapacityAdjustment",
    "SingleStrategyQtyContext",
    "StrategyBudget",
    "resolve_qty",
    "resolve_single_strategy_qty_from_context",
    "single_strategy_budget",
    "single_strategy_capacity_adjustment",
    "single_strategy_capacity_exhausted_result",
    "single_strategy_capacity_reason",
    "single_strategy_common_meta",
    "single_strategy_exit_guard_result",
    "single_strategy_min_qty_capacity_reason",
    "single_strategy_min_qty_result",
    "single_strategy_qty_context",
    "single_strategy_requested_qty",
    "single_strategy_short_entry_below_min_result",
    "single_strategy_success_result",
    "skip_non_executable_decision_qty",
)
