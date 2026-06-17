# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    AggregatedIntent,
    DecisionRuntimeTelemetry,
    FeatureNormalizationError,
    FeatureVectorV3,
    ForecastRoutingTelemetry,
    HMM_UNKNOWN_REGIME_ID,
    Iterable,
    Literal,
    MarketSnapshot,
    PriceFetcher,
    QuoteQualityPolicy,
    ROUND_HALF_UP,
    RuntimeDecision,
    RuntimeErrorRecord,
    RuntimeEvaluation,
    RuntimeObservation,
    SessionContextTracker,
    SignalEnvelope,
    SignalFeatures,
    StrategyDecision,
    StrategyRegistry,
    StrategyRuntime,
    StrategyTrace,
    _BUY_EXIT_ONLY_STRATEGY_TYPES,
    _DecisionEngineFields,
    _EXIT_ONLY_BUY_FLAT_REASON,
    _EXIT_ONLY_SELL_FLAT_REASON,
    _MICROBAR_PAIR_EXIT_RATIONALE,
    _RUNTIME_TRADE_POLICY_SHARED_OWNER,
    _RuntimeTradePolicySessionState,
    _SAME_DIRECTION_REENTRY_REASON,
    _SELL_EXIT_ONLY_STRATEGY_TYPES,
    _SHORT_ENTRY_BELOW_MIN_QTY_REASON,
    _feature_vector_with_positions,
    _feature_vector_with_runtime_position,
    _merge_runtime_counter,
    _merge_runtime_evaluations,
    _runtime_position_side,
    build_default_forecast_router,
    date,
    datetime,
    extract_catalog_metadata,
    extract_signal_features,
    field,
    hashlib,
    json,
    logger,
    logging,
    normalize_feature_vector_v3,
    parse_microstructure_state,
    re,
    resolve_hmm_context,
    resolve_regime_route_label,
    resolve_simulation_context,
    timezone,
)
from .decision_engine_core_methods import _DecisionEngineCoreMethods


def _skip_non_executable_decision_qty(
    *, qty: Decimal, sizing_meta: Mapping[str, Any]
) -> bool:
    reason = str(sizing_meta.get("reason") or "").strip()
    return qty <= 0 and reason in {
        _EXIT_ONLY_SELL_FLAT_REASON,
        _EXIT_ONLY_BUY_FLAT_REASON,
        _SHORT_ENTRY_BELOW_MIN_QTY_REASON,
        _SAME_DIRECTION_REENTRY_REASON,
        "symbol_capacity_exhausted",
        "portfolio_gross_capacity_exhausted",
    }


@dataclass(frozen=True)
class _StrategyBudget:
    notional_budget: Decimal | None
    method: str


@dataclass(frozen=True)
class _SingleStrategyQtyContext:
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
class _SingleStrategyCapacityAdjustment:
    original_requested_qty: Decimal
    requested_qty: Decimal
    cap_applied: bool
    portfolio_cap_applied: bool


def _resolve_qty(
    strategy: Strategy,
    *,
    symbol: str,
    action: str,
    price: Optional[Decimal],
    equity: Optional[Decimal],
    positions: Optional[list[dict[str, Any]]],
) -> tuple[Decimal, dict[str, Any]]:
    """Resolve an asset-class-aware quantity from strategy settings.

    Precedence:
    - `min(max_notional_per_trade, equity * max_position_pct_equity)` when both are available
    - `max_notional_per_trade`
    - `equity * max_position_pct_equity`
    - global `TRADING_MAX_NOTIONAL_PER_TRADE` / `TRADING_MAX_POSITION_PCT_EQUITY`
    - global `TRADING_DEFAULT_QTY` fallback
    """

    default_qty = Decimal(str(settings.trading_default_qty))
    if price is None or price <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_price"}
    budget = _single_strategy_budget(strategy=strategy, equity=equity)
    if budget.notional_budget is None or budget.notional_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}
    context = _single_strategy_qty_context(
        strategy=strategy,
        symbol=symbol,
        action=action,
        price=price,
        equity=equity,
        positions=positions,
        budget=budget,
    )
    return _resolve_single_strategy_qty_from_context(context)


def _single_strategy_budget(
    *,
    strategy: Strategy,
    equity: Decimal | None,
) -> _StrategyBudget:
    max_notional = optional_decimal(strategy.max_notional_per_trade)
    max_pct = optional_decimal(strategy.max_position_pct_equity)
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
    return _StrategyBudget(notional_budget=notional_budget, method=method)


def _single_strategy_qty_context(
    *,
    strategy: Strategy,
    symbol: str,
    action: str,
    price: Decimal,
    equity: Decimal | None,
    positions: list[dict[str, Any]] | None,
    budget: _StrategyBudget,
) -> _SingleStrategyQtyContext:
    symbol_notional_cap = _resolve_symbol_notional_cap(
        strategy_pcts=[optional_decimal(strategy.max_position_pct_equity)],
        equity=equity,
    )
    portfolio_gross_cap = _resolve_portfolio_gross_cap(
        strategies=[strategy],
        equity=equity,
    )
    current_value = _position_value_for_symbol(positions, symbol)
    current_gross = _portfolio_gross_exposure(positions)
    position_qty = _position_qty_for_symbol(positions, symbol)
    normalized_action = action.strip().lower()
    exit_only_sell = _treats_sell_as_exit_only(strategy) and normalized_action == "sell"
    exit_only_buy = _treats_buy_as_exit_only(strategy) and normalized_action == "buy"
    return _SingleStrategyQtyContext(
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


def _resolve_single_strategy_qty_from_context(
    context: _SingleStrategyQtyContext,
) -> tuple[Decimal, dict[str, Any]]:
    exit_result = _single_strategy_exit_guard_result(context)
    if exit_result is not None:
        return exit_result
    capacity = _single_strategy_capacity_adjustment(
        context,
        requested_qty=_single_strategy_requested_qty(context),
    )
    if capacity.requested_qty <= 0:
        return _single_strategy_capacity_exhausted_result(context, capacity)
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
    min_qty_result = _single_strategy_min_qty_result(
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
    return _single_strategy_success_result(
        context=context,
        capacity=capacity,
        resolution=resolution,
        qty=qty,
        position_qty=result_position_qty,
    )


def _single_strategy_exit_guard_result(
    context: _SingleStrategyQtyContext,
) -> tuple[Decimal, dict[str, Any]] | None:
    if (
        context.exit_only_sell
        and context.position_qty is not None
        and context.position_qty <= 0
    ):
        return Decimal("0"), {
            "method": context.method,
            "reason": _EXIT_ONLY_SELL_FLAT_REASON,
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
            "reason": _EXIT_ONLY_BUY_FLAT_REASON,
            "notional_budget": str(context.notional_budget),
            "price": str(context.price),
            "position_qty": str(context.position_qty),
        }
    if _blocks_same_direction_reentry(
        context.strategy
    ) and _same_direction_reentry_exists(
        action=context.normalized_action,
        position_qty=context.position_qty,
    ):
        return Decimal("0"), {
            "method": context.method,
            "reason": _SAME_DIRECTION_REENTRY_REASON,
            "notional_budget": str(context.notional_budget),
            "price": str(context.price),
            "position_qty": (
                str(context.position_qty) if context.position_qty is not None else None
            ),
        }
    return None


def _single_strategy_requested_qty(context: _SingleStrategyQtyContext) -> Decimal:
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


def _single_strategy_capacity_adjustment(
    context: _SingleStrategyQtyContext,
    *,
    requested_qty: Decimal,
) -> _SingleStrategyCapacityAdjustment:
    capped_requested_qty = _cap_requested_qty_by_symbol_cap(
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
    capped_by_portfolio_qty = _cap_requested_qty_by_portfolio_gross_cap(
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
    return _SingleStrategyCapacityAdjustment(
        original_requested_qty=context.notional_budget / context.price,
        requested_qty=requested_qty,
        cap_applied=cap_applied,
        portfolio_cap_applied=portfolio_cap_applied,
    )


def _single_strategy_capacity_exhausted_result(
    context: _SingleStrategyQtyContext,
    capacity: _SingleStrategyCapacityAdjustment,
) -> tuple[Decimal, dict[str, Any]]:
    return Decimal("0"), {
        "reason": _single_strategy_capacity_reason(context, capacity),
        "requested_qty": str(capacity.original_requested_qty),
        **_single_strategy_common_meta(context, position_qty=context.position_qty),
    }


def _single_strategy_capacity_reason(
    context: _SingleStrategyQtyContext,
    capacity: _SingleStrategyCapacityAdjustment,
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


def _single_strategy_min_qty_result(
    *,
    context: _SingleStrategyQtyContext,
    capacity: _SingleStrategyCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
    min_qty: Decimal,
) -> tuple[Decimal, dict[str, Any]] | None:
    if qty >= min_qty:
        return None
    if qty < min_qty:
        if capacity.cap_applied or capacity.portfolio_cap_applied:
            return Decimal("0"), {
                "reason": _single_strategy_min_qty_capacity_reason(capacity),
                "requested_qty": str(capacity.requested_qty),
                "min_qty": str(min_qty),
                "quantity_resolution": resolution.to_payload(),
                **_single_strategy_common_meta(
                    context,
                    position_qty=context.position_qty,
                ),
            }
        return _single_strategy_short_entry_below_min_result(
            context=context,
            resolution=resolution,
            requested_qty=capacity.requested_qty,
            min_qty=min_qty,
        )
    return None


def _single_strategy_min_qty_capacity_reason(
    capacity: _SingleStrategyCapacityAdjustment,
) -> str:
    if capacity.portfolio_cap_applied and not capacity.cap_applied:
        return "portfolio_gross_capacity_exhausted"
    return "symbol_capacity_exhausted"


def _single_strategy_short_entry_below_min_result(
    *,
    context: _SingleStrategyQtyContext,
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
        "reason": _SHORT_ENTRY_BELOW_MIN_QTY_REASON,
        "notional_budget": str(context.notional_budget),
        "price": str(context.price),
        "requested_qty": str(requested_qty),
        "min_qty": str(min_qty),
        "quantity_resolution": resolution.to_payload(),
    }


def _single_strategy_success_result(
    *,
    context: _SingleStrategyQtyContext,
    capacity: _SingleStrategyCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
    position_qty: Decimal | None,
) -> tuple[Decimal, dict[str, Any]]:
    return qty, {
        "requested_qty": str(capacity.requested_qty),
        "symbol_capacity_limited": capacity.cap_applied,
        "portfolio_gross_limited": capacity.portfolio_cap_applied,
        "quantity_resolution": resolution.to_payload(),
        **_single_strategy_common_meta(context, position_qty=position_qty),
    }


def _single_strategy_common_meta(
    context: _SingleStrategyQtyContext,
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


__all__ = [name for name in globals() if not name.startswith("__")]
