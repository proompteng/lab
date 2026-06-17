# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Trading decision engine based on TA signals."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Literal, Optional, cast

from ...config import settings
from ...models import Strategy
from ...strategies.catalog import extract_catalog_metadata
from ..features import (
    FeatureVectorV3,
    FeatureNormalizationError,
    SignalFeatures,
    extract_signal_features,
    normalize_feature_vector_v3,
    optional_decimal,
)
from ..microstructure import parse_microstructure_state
from ..evaluation_trace import StrategyTrace
from ..forecasting import ForecastRoutingTelemetry, build_default_forecast_router
from ..models import SignalEnvelope, StrategyDecision
from ..regime_hmm import (
    HMM_UNKNOWN_REGIME_ID,
    resolve_hmm_context,
    resolve_regime_route_label,
)
from ..prices import MarketSnapshot, PriceFetcher
from ..quote_quality import QuoteQualityPolicy
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from ..session_context import SessionContextTracker
from ..simulation import resolve_simulation_context
from ..strategy_runtime import (
    AggregatedIntent,
    RuntimeErrorRecord,
    RuntimeDecision,
    RuntimeEvaluation,
    RuntimeObservation,
    StrategyRegistry,
    StrategyRuntime,
)

# ruff: noqa: F401

from .shared_context import (
    DecisionRuntimeTelemetry,
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
    logger,
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
from .resolve_qty_for_aggregated import (
    AggregatedCapacityAdjustment as _AggregatedCapacityAdjustment,
    AggregatedQtyContext as _AggregatedQtyContext,
    RuntimeExitMetrics as _RuntimeExitMetrics,
    RuntimeExitOverlayContext as _RuntimeExitOverlayContext,
    RuntimeExitOverlayRequest as _RuntimeExitOverlayRequest,
    RuntimeExitSizing as _RuntimeExitSizing,
    RuntimeExitThresholds as _RuntimeExitThresholds,
    RuntimeExitTrigger as _RuntimeExitTrigger,
    aggregated_capacity_adjustment as _aggregated_capacity_adjustment,
    aggregated_capacity_exhausted_result as _aggregated_capacity_exhausted_result,
    aggregated_capacity_meta as _aggregated_capacity_meta,
    aggregated_capacity_reason as _aggregated_capacity_reason,
    aggregated_exit_or_reentry_result as _aggregated_exit_or_reentry_result,
    aggregated_min_qty_capacity_reason as _aggregated_min_qty_capacity_reason,
    aggregated_min_qty_result as _aggregated_min_qty_result,
    aggregated_qty_context as _aggregated_qty_context,
    aggregated_qty_success_result as _aggregated_qty_success_result,
    aggregated_requested_qty as _aggregated_requested_qty,
    aggregated_short_entry_below_min as _aggregated_short_entry_below_min,
    aggregated_zero_qty_result as _aggregated_zero_qty_result,
    blocks_same_direction_reentry as _blocks_same_direction_reentry,
    build_runtime_position_exit_overlay as _build_runtime_position_exit_overlay,
    minute_of_day_utc as _minute_of_day_utc,
    negative_position_qty as _negative_position_qty,
    position_qty_is_flat_or_long as _position_qty_is_flat_or_long,
    position_qty_is_flat_or_short as _position_qty_is_flat_or_short,
    position_state_scope_key as _position_state_scope_key,
    positive_position_qty as _positive_position_qty,
    resolve_qty_for_aggregated as _resolve_qty_for_aggregated,
    resolve_qty_from_aggregated_context as _resolve_qty_from_aggregated_context,
    runtime_exit_candidate_requires_profit as _runtime_exit_candidate_requires_profit,
    runtime_exit_candidates as _runtime_exit_candidates,
    runtime_exit_decision as _runtime_exit_decision,
    runtime_exit_eligible_strategies as _runtime_exit_eligible_strategies,
    runtime_exit_entry_drawdown_bps as _runtime_exit_entry_drawdown_bps,
    runtime_exit_metadata as _runtime_exit_metadata,
    runtime_exit_metrics as _runtime_exit_metrics,
    runtime_exit_overlay_context as _runtime_exit_overlay_context,
    runtime_exit_overlay_request as _runtime_exit_overlay_request,
    runtime_exit_position_payload as _runtime_exit_position_payload,
    runtime_exit_sizing as _runtime_exit_sizing,
    runtime_exit_thresholds as _runtime_exit_thresholds,
    runtime_exit_trigger as _runtime_exit_trigger,
    runtime_hard_stop_loss_bps as _runtime_hard_stop_loss_bps,
    runtime_hard_stop_triggered as _runtime_hard_stop_triggered,
    runtime_max_hold_triggered as _runtime_max_hold_triggered,
    runtime_session_flatten_triggered as _runtime_session_flatten_triggered,
    runtime_trade_policy_key as _runtime_trade_policy_key,
    runtime_trailing_exit_armed as _runtime_trailing_exit_armed,
    runtime_trailing_exit_candidate as _runtime_trailing_exit_candidate,
    runtime_trailing_thresholds as _runtime_trailing_thresholds,
    strategy_uses_position_isolation as _strategy_uses_position_isolation,
    supports_runtime_position_exit_overlay as _supports_runtime_position_exit_overlay,
)


def _positions_for_strategy_action(
    positions: Optional[list[dict[str, Any]]],
    *,
    strategy_id: str,
    action: str,
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> Optional[list[dict[str, Any]]]:
    if not positions:
        return positions
    tagged_positions = [
        dict(position)
        for position in positions
        if str(position.get("strategy_id") or "").strip() == strategy_id
    ]
    if runtime_exit_side is not None or action.strip().lower() == "sell":
        return _actual_positions_only(tagged_positions)
    if tagged_positions:
        return tagged_positions
    return []


def _is_pending_entry_position(position: Mapping[str, Any]) -> bool:
    return bool(position.get("pending_entry"))


def _actual_positions_only(
    positions: Optional[list[dict[str, Any]]],
) -> Optional[list[dict[str, Any]]]:
    if not positions:
        return positions
    return [
        dict(position)
        for position in positions
        if not _is_pending_entry_position(position)
    ]


def _treats_sell_as_exit_only(strategy: Strategy) -> bool:
    return _strategy_exit_semantics_type(strategy) in _SELL_EXIT_ONLY_STRATEGY_TYPES


def _treats_buy_as_exit_only(strategy: Strategy) -> bool:
    return _strategy_exit_semantics_type(strategy) in _BUY_EXIT_ONLY_STRATEGY_TYPES


def _strategy_exit_semantics_type(strategy: Strategy) -> str:
    runtime_type = _strategy_catalog_runtime_type(strategy)
    if runtime_type in _SELL_EXIT_ONLY_STRATEGY_TYPES | _BUY_EXIT_ONLY_STRATEGY_TYPES:
        return runtime_type

    universe_type = str(strategy.universe_type or "").strip().lower()
    if universe_type in (
        _SELL_EXIT_ONLY_STRATEGY_TYPES | _BUY_EXIT_ONLY_STRATEGY_TYPES
    ):
        return universe_type
    return runtime_type


def _strategy_catalog_runtime_type(strategy: Strategy) -> str:
    metadata = extract_catalog_metadata(
        str(strategy.description) if strategy.description is not None else None
    )
    metadata_type = str(metadata.get("strategy_type") or "").strip().lower()
    if metadata_type:
        return metadata_type
    universe_type = str(strategy.universe_type or "").strip().lower()
    if universe_type in {"static", "legacy_macd_rsi"}:
        return "legacy_macd_rsi"
    if universe_type in {"intraday_tsmom", "intraday_tsmom_v1", "tsmom_intraday"}:
        return "intraday_tsmom_v1"
    return universe_type


def _blocks_same_direction_reentry_any(strategies: list[Strategy]) -> bool:
    return any(_blocks_same_direction_reentry(strategy) for strategy in strategies)


def _treats_sell_as_exit_only_any(strategies: list[Strategy]) -> bool:
    return any(_treats_sell_as_exit_only(strategy) for strategy in strategies)


def _treats_buy_as_exit_only_any(strategies: list[Strategy]) -> bool:
    return any(_treats_buy_as_exit_only(strategy) for strategy in strategies)


def _is_entry_action_for_strategies(*, strategies: list[Strategy], action: str) -> bool:
    normalized_action = action.strip().lower()
    if normalized_action == "buy":
        return not _treats_buy_as_exit_only_any(strategies)
    if normalized_action == "sell":
        return not _treats_sell_as_exit_only_any(strategies)
    return False


def _is_exit_action_for_strategies(*, strategies: list[Strategy], action: str) -> bool:
    normalized_action = action.strip().lower()
    if normalized_action == "buy":
        return _treats_buy_as_exit_only_any(strategies)
    if normalized_action == "sell":
        return _treats_sell_as_exit_only_any(strategies)
    return False


def _exit_position_side_for_strategies(
    *, strategies: list[Strategy], action: str
) -> Literal["long", "short"] | None:
    normalized_action = action.strip().lower()
    if normalized_action == "sell" and _treats_sell_as_exit_only_any(strategies):
        return "long"
    if normalized_action == "buy" and _treats_buy_as_exit_only_any(strategies):
        return "short"
    return None


def _same_direction_reentry_exists(
    *,
    action: str,
    position_qty: Optional[Decimal],
) -> bool:
    if position_qty is None:
        return False
    if action == "buy":
        return position_qty > 0
    if action == "sell":
        return position_qty < 0
    return False


def _cap_requested_qty_by_symbol_cap(
    *,
    action: str,
    requested_qty: Decimal,
    price: Decimal,
    position_qty: Optional[Decimal],
    symbol_notional_cap: Optional[Decimal],
) -> Decimal | None:
    if requested_qty <= 0:
        return Decimal("0")
    if symbol_notional_cap is None or symbol_notional_cap <= 0:
        return None
    if price <= 0 or position_qty is None:
        return None

    cap_qty = symbol_notional_cap / price
    max_requested_qty = _max_requested_qty_with_symbol_cap(
        action=action,
        position_qty=position_qty,
        cap_qty=cap_qty,
    )
    return min(requested_qty, max_requested_qty)


def _cap_requested_qty_by_portfolio_gross_cap(
    *,
    action: str,
    requested_qty: Decimal,
    price: Decimal,
    positions: Optional[list[dict[str, Any]]],
    portfolio_gross_cap: Optional[Decimal],
) -> Decimal | None:
    if requested_qty <= 0:
        return Decimal("0")
    if action != "buy":
        return None
    if portfolio_gross_cap is None or portfolio_gross_cap <= 0 or price <= 0:
        return None
    current_gross = _portfolio_gross_exposure(positions)
    available_notional = portfolio_gross_cap - current_gross
    if available_notional <= 0:
        return Decimal("0")
    cap_qty = available_notional / price
    return min(requested_qty, cap_qty)


def _max_requested_qty_with_symbol_cap(
    *,
    action: str,
    position_qty: Decimal,
    cap_qty: Decimal,
) -> Decimal:
    if cap_qty <= 0:
        return Decimal("0")
    if action == "buy":
        if position_qty < 0:
            return abs(position_qty) + cap_qty
        return max(Decimal("0"), cap_qty - position_qty)
    if action == "sell":
        if position_qty > 0:
            return position_qty + cap_qty
        return max(Decimal("0"), cap_qty - abs(position_qty))
    return Decimal("0")


def _position_qty_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    if positions is None:
        return None
    normalized_symbol = symbol.strip().upper()
    current_qty = Decimal("0")
    matched = False
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
        matched = True
        current_qty += qty
    if not matched:
        return Decimal("0")
    return current_qty


def _position_qty_from_payload(position: Mapping[str, Any]) -> Decimal | None:
    raw_qty = position.get("qty") or position.get("quantity")
    if raw_qty is None:
        return None
    try:
        qty = Decimal(str(raw_qty))
    except (ArithmeticError, ValueError):
        return None
    side = str(position.get("side") or "").strip().lower()
    if side == "short":
        qty = -abs(qty)
    return qty


def _portfolio_gross_exposure(
    positions: Optional[list[dict[str, Any]]],
) -> Decimal:
    if not positions:
        return Decimal("0")
    gross = Decimal("0")
    for position in positions:
        raw_value = (
            position.get("market_value")
            or position.get("current_value")
            or position.get("notional")
        )
        if raw_value is None:
            continue
        try:
            gross += abs(Decimal(str(raw_value)))
        except (ArithmeticError, ValueError):
            continue
    return gross


def _position_value_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    if positions is None:
        return None
    normalized_symbol = symbol.strip().upper()
    current_value = Decimal("0")
    matched = False
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_value = (
            position.get("market_value")
            or position.get("current_value")
            or position.get("notional")
        )
        if raw_value is None:
            continue
        try:
            value = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        matched = True
        current_value += abs(value)
    if not matched:
        return None
    return current_value


def _position_avg_entry_price_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    if positions is None:
        return None
    normalized_symbol = symbol.strip().upper()
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_value = position.get("avg_entry_price") or position.get(
            "average_entry_price"
        )
        if raw_value is None:
            continue
        try:
            return Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
    return None


def _resolve_min_positive_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
) -> Optional[Decimal]:
    values: list[Decimal] = []
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        raw_value = params.get(key)
        if raw_value is None:
            continue
        try:
            resolved = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        if resolved > 0:
            values.append(resolved)
    if not values:
        return None
    return min(values)


def _resolve_max_nonnegative_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
) -> Optional[Decimal]:
    values: list[Decimal] = []
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        raw_value = params.get(key)
        if raw_value is None:
            continue
        try:
            resolved = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        if resolved >= 0:
            values.append(resolved)
    if not values:
        return None
    return max(values)


def _resolve_dynamic_exit_threshold_bps(
    *,
    strategies: list[Strategy],
    base_bps: Decimal | None,
    spread_bps: Decimal | None,
    spread_multiplier_key: str,
    volatility_bps: Decimal | None,
    volatility_multiplier_key: str,
) -> Decimal | None:
    if base_bps is None or base_bps <= 0:
        return None
    threshold_bps = base_bps
    spread_multiplier = _resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key=spread_multiplier_key,
    )
    if (
        spread_bps is not None
        and spread_bps > 0
        and spread_multiplier is not None
        and spread_multiplier > 0
    ):
        threshold_bps += spread_bps * spread_multiplier
    volatility_multiplier = _resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key=volatility_multiplier_key,
    )
    if (
        volatility_bps is not None
        and volatility_bps > 0
        and volatility_multiplier is not None
        and volatility_multiplier > 0
    ):
        threshold_bps += volatility_bps * volatility_multiplier
    return threshold_bps


def _volatility_to_bps(volatility: Decimal | None) -> Decimal | None:
    if volatility is None or volatility <= 0:
        return None
    return volatility * Decimal("10000")


def _signal_spread(signal: SignalEnvelope) -> Decimal | None:
    from .resolve_runtime_trade_policy import signal_spread as owned

    return owned(signal)


def _near_touch_exit_price(
    price: Decimal,
    spread: Decimal | None,
    action: str,
) -> Decimal:
    from .resolve_runtime_trade_policy import near_touch_exit_price as owned

    return owned(price, spread, action)


def _bool_param(value: Any) -> bool | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off"}:
        return False
    return None


def _signal_spread_bps(
    *,
    signal: SignalEnvelope,
    price: Decimal,
) -> Decimal | None:
    spread = _signal_spread(signal)
    if spread is None or spread <= 0 or price <= 0:
        return None
    return (spread / price) * Decimal("10000")


def _reference_exit_price(
    *,
    price: Decimal,
    signal: SignalEnvelope,
    action: str,
) -> Decimal:
    if settings.trading_execution_prefer_limit:
        return _near_touch_exit_price(
            price,
            _signal_spread(signal),
            action,
        )
    return price


def _realized_exit_bps(
    *,
    avg_entry_price: Decimal,
    exit_price: Decimal,
    position_side: Literal["long", "short"] = "long",
) -> Decimal:
    if position_side == "short":
        return ((avg_entry_price - exit_price) / avg_entry_price) * Decimal("10000")
    return ((exit_price - avg_entry_price) / avg_entry_price) * Decimal("10000")


def _passes_exit_profit_policy(
    *,
    strategies: list[Strategy],
    realized_bps: Decimal,
) -> bool:
    if (
        _resolve_bool_strategy_param(
            strategies=strategies,
            key="require_positive_price_for_signal_exit",
            default=True,
        )
        and realized_bps <= 0
    ):
        return False

    min_profit_bps = _resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="min_signal_exit_profit_bps",
    )
    if min_profit_bps is not None and realized_bps < min_profit_bps:
        return False
    return True


def _resolve_bool_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
    default: bool,
) -> bool:
    resolved_any = False
    resolved = False
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        value = _bool_param(params.get(key))
        if value is None:
            continue
        resolved_any = True
        resolved = resolved or value
    return resolved if resolved_any else default


def _resolve_symbol_notional_cap(
    *,
    strategy_pcts: list[Optional[Decimal]],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    if equity is None or equity <= 0:
        return None
    caps: list[Decimal] = []
    global_pct = optional_decimal(settings.trading_max_position_pct_equity)
    if global_pct is not None and global_pct > 0:
        caps.append(equity * global_pct)
    for pct in strategy_pcts:
        if pct is not None and pct > 0:
            caps.append(equity * pct)
    if not caps:
        return None
    return min(caps)


def _resolve_portfolio_gross_cap(
    *,
    strategies: list[Strategy],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    caps: list[Decimal] = []
    absolute_cap = optional_decimal(settings.trading_portfolio_max_gross_exposure)
    if absolute_cap is not None and absolute_cap > 0:
        caps.append(absolute_cap)
    if equity is not None and equity > 0:
        global_pct = optional_decimal(
            settings.trading_portfolio_max_gross_exposure_pct_equity
        )
        if global_pct is not None and global_pct > 0:
            caps.append(equity * global_pct)
        strategy_pct = _resolve_min_positive_strategy_param(
            strategies=strategies,
            key="max_gross_exposure_pct_equity",
        )
        if strategy_pct is not None and strategy_pct > 0:
            caps.append(equity * strategy_pct)
    strategy_absolute = _resolve_min_positive_strategy_param(
        strategies=strategies,
        key="max_gross_exposure",
    )
    if strategy_absolute is not None and strategy_absolute > 0:
        caps.append(strategy_absolute)
    if not caps:
        return None
    return min(caps)


def _has_legacy_indicator_inputs(features: SignalFeatures) -> bool:
    return (
        features.macd is not None
        and features.macd_signal is not None
        and features.rsi is not None
    )


def _resolve_legacy_action(
    features: SignalFeatures,
) -> tuple[Literal["buy", "sell"], list[str]] | None:
    if features.macd is None or features.macd_signal is None or features.rsi is None:
        return None
    if features.macd > features.macd_signal and features.rsi < 35:
        return "buy", ["macd_cross_up", "rsi_oversold"]
    if features.macd < features.macd_signal and features.rsi > 65:
        return "sell", ["macd_cross_down", "rsi_overbought"]
    return None


def _resolve_aggregated_notional_budget(
    strategies: list[Strategy],
    *,
    equity: Optional[Decimal],
    runtime_target_notional: Decimal | None = None,
) -> Decimal:
    if runtime_target_notional is not None and runtime_target_notional > 0:
        return runtime_target_notional
    total_budget = Decimal("0")
    for strategy in strategies:
        budget = optional_decimal(strategy.max_notional_per_trade)
        if budget is not None and budget > 0:
            total_budget += budget
    if total_budget > 0:
        return total_budget

    global_budget = optional_decimal(settings.trading_max_notional_per_trade)
    if global_budget is not None and global_budget > 0:
        return global_budget

    if equity is None:
        return Decimal("0")
    pct = optional_decimal(settings.trading_max_position_pct_equity)
    if pct is not None and pct > 0:
        return equity * pct
    return Decimal("0")


# Public aliases used by split-module consumers.
actual_positions_only = _actual_positions_only
has_legacy_indicator_inputs = _has_legacy_indicator_inputs
position_avg_entry_price_for_symbol = _position_avg_entry_price_for_symbol
position_qty_for_symbol = _position_qty_for_symbol
position_qty_from_payload = _position_qty_from_payload
positions_for_strategy_action = _positions_for_strategy_action
resolve_legacy_action = _resolve_legacy_action
blocks_same_direction_reentry = _blocks_same_direction_reentry
blocks_same_direction_reentry_any = _blocks_same_direction_reentry_any
cap_requested_qty_by_portfolio_gross_cap = _cap_requested_qty_by_portfolio_gross_cap
cap_requested_qty_by_symbol_cap = _cap_requested_qty_by_symbol_cap
exit_position_side_for_strategies = _exit_position_side_for_strategies
is_entry_action_for_strategies = _is_entry_action_for_strategies
is_exit_action_for_strategies = _is_exit_action_for_strategies
is_pending_entry_position = _is_pending_entry_position
max_requested_qty_with_symbol_cap = _max_requested_qty_with_symbol_cap
passes_exit_profit_policy = _passes_exit_profit_policy
portfolio_gross_exposure = _portfolio_gross_exposure
position_value_for_symbol = _position_value_for_symbol
realized_exit_bps = _realized_exit_bps
reference_exit_price = _reference_exit_price
resolve_aggregated_notional_budget = _resolve_aggregated_notional_budget
resolve_bool_strategy_param = _resolve_bool_strategy_param
resolve_dynamic_exit_threshold_bps = _resolve_dynamic_exit_threshold_bps
resolve_max_nonnegative_strategy_param = _resolve_max_nonnegative_strategy_param
resolve_min_positive_strategy_param = _resolve_min_positive_strategy_param
resolve_portfolio_gross_cap = _resolve_portfolio_gross_cap
resolve_symbol_notional_cap = _resolve_symbol_notional_cap
same_direction_reentry_exists = _same_direction_reentry_exists
signal_spread_bps = _signal_spread_bps
strategy_catalog_runtime_type = _strategy_catalog_runtime_type
strategy_exit_semantics_type = _strategy_exit_semantics_type
treats_buy_as_exit_only = _treats_buy_as_exit_only
treats_buy_as_exit_only_any = _treats_buy_as_exit_only_any
treats_sell_as_exit_only = _treats_sell_as_exit_only
treats_sell_as_exit_only_any = _treats_sell_as_exit_only_any
volatility_to_bps = _volatility_to_bps

__all__ = (
    "actual_positions_only",
    "has_legacy_indicator_inputs",
    "position_avg_entry_price_for_symbol",
    "position_qty_for_symbol",
    "position_qty_from_payload",
    "positions_for_strategy_action",
    "resolve_legacy_action",
    "blocks_same_direction_reentry",
    "blocks_same_direction_reentry_any",
    "cap_requested_qty_by_portfolio_gross_cap",
    "cap_requested_qty_by_symbol_cap",
    "exit_position_side_for_strategies",
    "is_entry_action_for_strategies",
    "is_exit_action_for_strategies",
    "is_pending_entry_position",
    "max_requested_qty_with_symbol_cap",
    "passes_exit_profit_policy",
    "portfolio_gross_exposure",
    "position_value_for_symbol",
    "realized_exit_bps",
    "reference_exit_price",
    "resolve_aggregated_notional_budget",
    "resolve_bool_strategy_param",
    "resolve_dynamic_exit_threshold_bps",
    "resolve_max_nonnegative_strategy_param",
    "resolve_min_positive_strategy_param",
    "resolve_portfolio_gross_cap",
    "resolve_symbol_notional_cap",
    "same_direction_reentry_exists",
    "signal_spread_bps",
    "strategy_catalog_runtime_type",
    "strategy_exit_semantics_type",
    "treats_buy_as_exit_only",
    "treats_buy_as_exit_only_any",
    "treats_sell_as_exit_only",
    "treats_sell_as_exit_only_any",
    "volatility_to_bps",
)
