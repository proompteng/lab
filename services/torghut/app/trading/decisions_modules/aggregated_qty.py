# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    AggregatedIntent,
    DecisionRuntimeTelemetry,
    FeatureNormalizationError,
    FeatureVectorV3,
    ForecastRoutingTelemetry,
    HMM_UNKNOWN_REGIME_ID,
    Iterable,
    Mapping,
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
    BUY_EXIT_ONLY_STRATEGY_TYPES as _BUY_EXIT_ONLY_STRATEGY_TYPES,
    DecisionEngineFields as _DecisionEngineFields,
    EXIT_ONLY_BUY_FLAT_REASON as _EXIT_ONLY_BUY_FLAT_REASON,
    EXIT_ONLY_SELL_FLAT_REASON as _EXIT_ONLY_SELL_FLAT_REASON,
    MICROBAR_PAIR_EXIT_RATIONALE as _MICROBAR_PAIR_EXIT_RATIONALE,
    RUNTIME_TRADE_POLICY_SHARED_OWNER as _RUNTIME_TRADE_POLICY_SHARED_OWNER,
    RuntimeTradePolicySessionState as _RuntimeTradePolicySessionState,
    SAME_DIRECTION_REENTRY_REASON as _SAME_DIRECTION_REENTRY_REASON,
    SELL_EXIT_ONLY_STRATEGY_TYPES as _SELL_EXIT_ONLY_STRATEGY_TYPES,
    SHORT_ENTRY_BELOW_MIN_QTY_REASON as _SHORT_ENTRY_BELOW_MIN_QTY_REASON,
    feature_vector_with_positions as _feature_vector_with_positions,
    feature_vector_with_runtime_position as _feature_vector_with_runtime_position,
    merge_runtime_counter as _merge_runtime_counter,
    merge_runtime_evaluations as _merge_runtime_evaluations,
    runtime_position_side as _runtime_position_side,
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
from .decision_engine_core_methods import (
    DecisionEngineCoreMethods as _DecisionEngineCoreMethods,
)
from .decision_engine_runtime_methods import (
    DecisionEngine,
    BuildParamsRequest as _BuildParamsRequest,
    DecisionEngineRuntimeMethods as _DecisionEngineRuntimeMethods,
    LegacyDecisionInputs as _LegacyDecisionInputs,
    LegacyMarketContext as _LegacyMarketContext,
    LegacySizing as _LegacySizing,
    SingleStrategyCapacityAdjustment as _SingleStrategyCapacityAdjustment,
    SingleStrategyQtyContext as _SingleStrategyQtyContext,
    StrategyBudget as _StrategyBudget,
    base_decision_params as _base_decision_params,
    build_params as _build_params,
    build_params_request as _build_params_request,
    forecast_decision_params as _forecast_decision_params,
    has_explicit_regime_context as _has_explicit_regime_context,
    legacy_decision_inputs as _legacy_decision_inputs,
    legacy_runtime_metadata as _legacy_runtime_metadata,
    legacy_strategy_decision as _legacy_strategy_decision,
    log_skipped_legacy_decision as _log_skipped_legacy_decision,
    market_decision_params as _market_decision_params,
    regime_decision_params as _regime_decision_params,
    resolve_decision_simulation_context as _resolve_decision_simulation_context,
    resolve_execution_advice_payload as _resolve_execution_advice_payload,
    resolve_execution_feature_payload as _resolve_execution_feature_payload,
    resolve_fragility_snapshot_payload as _resolve_fragility_snapshot_payload,
    resolve_microstructure_state_payload as _resolve_microstructure_state_payload,
    resolve_qty as _resolve_qty,
    resolve_regime_context as _resolve_regime_context,
    resolve_single_strategy_qty_from_context as _resolve_single_strategy_qty_from_context,
    single_strategy_budget as _single_strategy_budget,
    single_strategy_capacity_adjustment as _single_strategy_capacity_adjustment,
    single_strategy_capacity_exhausted_result as _single_strategy_capacity_exhausted_result,
    single_strategy_capacity_reason as _single_strategy_capacity_reason,
    single_strategy_common_meta as _single_strategy_common_meta,
    single_strategy_exit_guard_result as _single_strategy_exit_guard_result,
    single_strategy_min_qty_capacity_reason as _single_strategy_min_qty_capacity_reason,
    single_strategy_min_qty_result as _single_strategy_min_qty_result,
    single_strategy_qty_context as _single_strategy_qty_context,
    single_strategy_requested_qty as _single_strategy_requested_qty,
    single_strategy_short_entry_below_min_result as _single_strategy_short_entry_below_min_result,
    single_strategy_success_result as _single_strategy_success_result,
    skip_non_executable_decision_qty as _skip_non_executable_decision_qty,
    snapshot_payload as _snapshot_payload,
    source_context_decision_params as _source_context_decision_params,
)


def _resolve_aggregated_notional_budget(
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


def _position_qty_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import position_qty_for_symbol

    return position_qty_for_symbol(positions, symbol)


def _resolve_symbol_notional_cap(
    *,
    strategy_pcts: list[Optional[Decimal]],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    from .positions_for_strategy_action import resolve_symbol_notional_cap

    return resolve_symbol_notional_cap(strategy_pcts=strategy_pcts, equity=equity)


def _resolve_portfolio_gross_cap(
    *,
    strategies: list[Strategy],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    from .positions_for_strategy_action import resolve_portfolio_gross_cap

    return resolve_portfolio_gross_cap(strategies=strategies, equity=equity)


def _position_value_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import position_value_for_symbol

    return position_value_for_symbol(positions, symbol)


def _portfolio_gross_exposure(
    positions: Optional[list[dict[str, Any]]],
) -> Decimal:
    from .positions_for_strategy_action import portfolio_gross_exposure

    return portfolio_gross_exposure(positions)


def _treats_sell_as_exit_only_any(strategies: list[Strategy]) -> bool:
    from .positions_for_strategy_action import treats_sell_as_exit_only_any

    return treats_sell_as_exit_only_any(strategies)


def _treats_buy_as_exit_only_any(strategies: list[Strategy]) -> bool:
    from .positions_for_strategy_action import treats_buy_as_exit_only_any

    return treats_buy_as_exit_only_any(strategies)


def _blocks_same_direction_reentry_any(strategies: list[Strategy]) -> bool:
    from .positions_for_strategy_action import blocks_same_direction_reentry_any

    return blocks_same_direction_reentry_any(strategies)


def _same_direction_reentry_exists(
    *,
    action: str,
    position_qty: Optional[Decimal],
) -> bool:
    from .positions_for_strategy_action import same_direction_reentry_exists

    return same_direction_reentry_exists(action=action, position_qty=position_qty)


def _cap_requested_qty_by_symbol_cap(
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


def _cap_requested_qty_by_portfolio_gross_cap(
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
class _AggregatedQtyContext:
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
class _AggregatedCapacityAdjustment:
    original_requested_qty: Decimal
    requested_qty: Decimal
    cap_applied: bool
    portfolio_cap_applied: bool


def _resolve_qty_for_aggregated(
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
    total_budget = _resolve_aggregated_notional_budget(
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
    context = _aggregated_qty_context(
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
    return _resolve_qty_from_aggregated_context(context)


def _aggregated_qty_context(
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
) -> _AggregatedQtyContext:
    normalized_action = action.strip().lower()
    position_qty = _position_qty_for_symbol(positions, symbol)
    return _AggregatedQtyContext(
        strategies=strategies,
        symbol=symbol,
        action=action,
        price=price,
        equity=equity,
        positions=positions,
        effective_capacity_positions=effective_capacity_positions,
        total_budget=total_budget,
        budget_method=budget_method,
        symbol_notional_cap=_resolve_symbol_notional_cap(
            strategy_pcts=[
                optional_decimal(strategy.max_position_pct_equity)
                for strategy in strategies
            ],
            equity=equity,
        ),
        portfolio_gross_cap=_resolve_portfolio_gross_cap(
            strategies=strategies,
            equity=equity,
        ),
        current_value=_position_value_for_symbol(effective_capacity_positions, symbol),
        current_gross=_portfolio_gross_exposure(effective_capacity_positions),
        position_qty=position_qty,
        normalized_action=normalized_action,
        exit_only_sell=(
            _treats_sell_as_exit_only_any(strategies) or runtime_exit_side == "long"
        )
        and normalized_action == "sell",
        exit_only_buy=(
            _treats_buy_as_exit_only_any(strategies) or runtime_exit_side == "short"
        )
        and normalized_action == "buy",
    )


def _resolve_qty_from_aggregated_context(
    context: _AggregatedQtyContext,
) -> tuple[Decimal, dict[str, Any]]:
    blocked_result = _aggregated_exit_or_reentry_result(context)
    if blocked_result is not None:
        return blocked_result
    capacity = _aggregated_capacity_adjustment(
        context,
        _aggregated_requested_qty(context),
    )
    if capacity.requested_qty <= 0:
        return _aggregated_capacity_exhausted_result(context, capacity)
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
    min_qty_result = _aggregated_min_qty_result(
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
    return _aggregated_qty_success_result(
        context=context,
        capacity=capacity,
        resolution=resolution,
        qty=qty,
    )


def _aggregated_exit_or_reentry_result(
    context: _AggregatedQtyContext,
) -> tuple[Decimal, dict[str, Any]] | None:
    if context.exit_only_sell and _position_qty_is_flat_or_short(context.position_qty):
        return _aggregated_zero_qty_result(
            context,
            reason=_EXIT_ONLY_SELL_FLAT_REASON,
        )
    if context.exit_only_buy and _position_qty_is_flat_or_long(context.position_qty):
        return _aggregated_zero_qty_result(
            context,
            reason=_EXIT_ONLY_BUY_FLAT_REASON,
        )
    if _blocks_same_direction_reentry_any(
        context.strategies
    ) and _same_direction_reentry_exists(
        action=context.normalized_action,
        position_qty=context.position_qty,
    ):
        return _aggregated_zero_qty_result(
            context,
            reason=_SAME_DIRECTION_REENTRY_REASON,
        )
    return None


def _position_qty_is_flat_or_short(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty <= 0


def _position_qty_is_flat_or_long(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty >= 0


def _aggregated_zero_qty_result(
    context: _AggregatedQtyContext,
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


def _aggregated_requested_qty(context: _AggregatedQtyContext) -> Decimal:
    requested_qty = context.total_budget / context.price
    if context.exit_only_sell and _positive_position_qty(context.position_qty):
        return cast(Decimal, context.position_qty)
    if context.exit_only_buy and _negative_position_qty(context.position_qty):
        return abs(cast(Decimal, context.position_qty))
    return requested_qty


def _positive_position_qty(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty > 0


def _negative_position_qty(position_qty: Decimal | None) -> bool:
    return position_qty is not None and position_qty < 0


def _aggregated_capacity_adjustment(
    context: _AggregatedQtyContext,
    requested_qty: Decimal,
) -> _AggregatedCapacityAdjustment:
    capped_by_symbol = _cap_requested_qty_by_symbol_cap(
        action=context.normalized_action,
        requested_qty=requested_qty,
        price=context.price,
        position_qty=context.position_qty,
        symbol_notional_cap=context.symbol_notional_cap,
    )
    symbol_adjusted_qty = (
        capped_by_symbol if capped_by_symbol is not None else requested_qty
    )
    capped_by_portfolio = _cap_requested_qty_by_portfolio_gross_cap(
        action=context.normalized_action,
        requested_qty=symbol_adjusted_qty,
        price=context.price,
        positions=context.effective_capacity_positions,
        portfolio_gross_cap=context.portfolio_gross_cap,
    )
    adjusted_qty = (
        capped_by_portfolio if capped_by_portfolio is not None else symbol_adjusted_qty
    )
    return _AggregatedCapacityAdjustment(
        original_requested_qty=requested_qty,
        requested_qty=adjusted_qty,
        cap_applied=capped_by_symbol is not None and capped_by_symbol < requested_qty,
        portfolio_cap_applied=(
            capped_by_portfolio is not None
            and capped_by_portfolio < symbol_adjusted_qty
        ),
    )


def _aggregated_capacity_exhausted_result(
    context: _AggregatedQtyContext,
    capacity: _AggregatedCapacityAdjustment,
) -> tuple[Decimal, dict[str, Any]]:
    return Decimal("0"), {
        **_aggregated_capacity_meta(context, capacity),
        "reason": _aggregated_capacity_reason(context, capacity),
        "requested_qty": str(capacity.original_requested_qty),
    }


def _aggregated_capacity_reason(
    context: _AggregatedQtyContext,
    capacity: _AggregatedCapacityAdjustment,
) -> str:
    if capacity.portfolio_cap_applied or (
        context.normalized_action == "buy"
        and context.portfolio_gross_cap is not None
        and context.portfolio_gross_cap > 0
        and context.current_gross >= context.portfolio_gross_cap
    ):
        return "portfolio_gross_capacity_exhausted"
    return "symbol_capacity_exhausted"


def _aggregated_min_qty_result(
    *,
    context: _AggregatedQtyContext,
    capacity: _AggregatedCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
    min_qty: Decimal,
) -> tuple[Decimal, dict[str, Any]] | None:
    if qty >= min_qty:
        return None
    if capacity.cap_applied or capacity.portfolio_cap_applied:
        return Decimal("0"), {
            **_aggregated_capacity_meta(context, capacity),
            "reason": _aggregated_min_qty_capacity_reason(capacity),
            "requested_qty": str(capacity.requested_qty),
            "min_qty": str(min_qty),
            "quantity_resolution": resolution.to_payload(),
        }
    if _aggregated_short_entry_below_min(context, resolution):
        return Decimal("0"), {
            "method": context.budget_method,
            "reason": _SHORT_ENTRY_BELOW_MIN_QTY_REASON,
            "notional_budget": str(context.total_budget),
            "price": str(context.price),
            "requested_qty": str(capacity.requested_qty),
            "min_qty": str(min_qty),
            "quantity_resolution": resolution.to_payload(),
        }
    return None


def _aggregated_min_qty_capacity_reason(
    capacity: _AggregatedCapacityAdjustment,
) -> str:
    if capacity.portfolio_cap_applied and not capacity.cap_applied:
        return "portfolio_gross_capacity_exhausted"
    return "symbol_capacity_exhausted"


def _aggregated_short_entry_below_min(
    context: _AggregatedQtyContext,
    resolution: Any,
) -> bool:
    position_qty = resolution.position_qty
    return (
        context.normalized_action == "sell"
        and not resolution.fractional_allowed
        and (position_qty is None or position_qty <= 0)
    )


def _aggregated_qty_success_result(
    *,
    context: _AggregatedQtyContext,
    capacity: _AggregatedCapacityAdjustment,
    resolution: Any,
    qty: Decimal,
) -> tuple[Decimal, dict[str, Any]]:
    return qty, {
        **_aggregated_capacity_meta(context, capacity),
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


def _aggregated_capacity_meta(
    context: _AggregatedQtyContext,
    capacity: _AggregatedCapacityAdjustment,
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


# Public aliases used by split-module consumers.
resolve_qty_for_aggregated = _resolve_qty_for_aggregated
AggregatedCapacityAdjustment = _AggregatedCapacityAdjustment
AggregatedQtyContext = _AggregatedQtyContext
aggregated_capacity_adjustment = _aggregated_capacity_adjustment
aggregated_capacity_exhausted_result = _aggregated_capacity_exhausted_result
aggregated_capacity_meta = _aggregated_capacity_meta
aggregated_capacity_reason = _aggregated_capacity_reason
aggregated_exit_or_reentry_result = _aggregated_exit_or_reentry_result
aggregated_min_qty_capacity_reason = _aggregated_min_qty_capacity_reason
aggregated_min_qty_result = _aggregated_min_qty_result
aggregated_qty_context = _aggregated_qty_context
aggregated_qty_success_result = _aggregated_qty_success_result
aggregated_requested_qty = _aggregated_requested_qty
aggregated_short_entry_below_min = _aggregated_short_entry_below_min
aggregated_zero_qty_result = _aggregated_zero_qty_result
negative_position_qty = _negative_position_qty
position_qty_is_flat_or_long = _position_qty_is_flat_or_long
position_qty_is_flat_or_short = _position_qty_is_flat_or_short
positive_position_qty = _positive_position_qty
resolve_qty_from_aggregated_context = _resolve_qty_from_aggregated_context

__all__ = [name for name in globals() if not name.startswith("__")]
