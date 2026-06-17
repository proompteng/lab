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
from .positions_for_strategy_action import (
    actual_positions_only as _actual_positions_only,
    blocks_same_direction_reentry_any as _blocks_same_direction_reentry_any,
    cap_requested_qty_by_portfolio_gross_cap as _cap_requested_qty_by_portfolio_gross_cap,
    cap_requested_qty_by_symbol_cap as _cap_requested_qty_by_symbol_cap,
    exit_position_side_for_strategies as _exit_position_side_for_strategies,
    has_legacy_indicator_inputs as _has_legacy_indicator_inputs,
    is_entry_action_for_strategies as _is_entry_action_for_strategies,
    is_exit_action_for_strategies as _is_exit_action_for_strategies,
    is_pending_entry_position as _is_pending_entry_position,
    max_requested_qty_with_symbol_cap as _max_requested_qty_with_symbol_cap,
    passes_exit_profit_policy as _passes_exit_profit_policy,
    portfolio_gross_exposure as _portfolio_gross_exposure,
    position_avg_entry_price_for_symbol as _position_avg_entry_price_for_symbol,
    position_qty_for_symbol as _position_qty_for_symbol,
    position_qty_from_payload as _position_qty_from_payload,
    position_value_for_symbol as _position_value_for_symbol,
    positions_for_strategy_action as _positions_for_strategy_action,
    realized_exit_bps as _realized_exit_bps,
    reference_exit_price as _reference_exit_price,
    resolve_aggregated_notional_budget as _resolve_aggregated_notional_budget,
    resolve_bool_strategy_param as _resolve_bool_strategy_param,
    resolve_dynamic_exit_threshold_bps as _resolve_dynamic_exit_threshold_bps,
    resolve_legacy_action as _resolve_legacy_action,
    resolve_max_nonnegative_strategy_param as _resolve_max_nonnegative_strategy_param,
    resolve_min_positive_strategy_param as _resolve_min_positive_strategy_param,
    resolve_portfolio_gross_cap as _resolve_portfolio_gross_cap,
    resolve_symbol_notional_cap as _resolve_symbol_notional_cap,
    same_direction_reentry_exists as _same_direction_reentry_exists,
    signal_spread_bps as _signal_spread_bps,
    strategy_catalog_runtime_type as _strategy_catalog_runtime_type,
    strategy_exit_semantics_type as _strategy_exit_semantics_type,
    treats_buy_as_exit_only as _treats_buy_as_exit_only,
    treats_buy_as_exit_only_any as _treats_buy_as_exit_only_any,
    treats_sell_as_exit_only as _treats_sell_as_exit_only,
    treats_sell_as_exit_only_any as _treats_sell_as_exit_only_any,
    volatility_to_bps as _volatility_to_bps,
)
from .resolve_runtime_trade_policy import (
    count_open_long_positions as _count_open_long_positions,
    decision_position_exit_type as _decision_position_exit_type,
    default_trailing_stop_requires_structure_loss as _default_trailing_stop_requires_structure_loss,
    near_touch_exit_price as _near_touch_exit_price,
    normalize_exit_price as _normalize_exit_price,
    passes_runtime_trade_policy as _passes_runtime_trade_policy,
    passes_signal_exit_policy as _passes_signal_exit_policy,
    position_age_seconds_for_symbol as _position_age_seconds_for_symbol,
    position_exit_bypasses_min_hold as _position_exit_bypasses_min_hold,
    position_opened_at_for_symbol as _position_opened_at_for_symbol,
    record_runtime_trade_policy_decision as _record_runtime_trade_policy_decision,
    resolve_runtime_trade_policy as _resolve_runtime_trade_policy,
    resolve_runtime_trade_policy_session_state as _resolve_runtime_trade_policy_session_state,
    resolve_strategy_time_in_force as _resolve_strategy_time_in_force,
    runtime_intent_exit_side as _runtime_intent_exit_side,
    runtime_trade_policy_owner as _runtime_trade_policy_owner,
    signal_decimal_feature_bps as _signal_decimal_feature_bps,
    signal_spread as _signal_spread,
    trailing_stop_structure_loss_confirmed as _trailing_stop_structure_loss_confirmed,
)


def _count_open_short_positions(positions: Optional[list[dict[str, Any]]]) -> int:
    if not positions:
        return 0
    open_symbols: set[str] = set()
    for position in positions:
        symbol = str(position.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        qty = _position_qty_from_payload(position)
        if qty is not None:
            if qty < 0:
                open_symbols.add(symbol)
            continue
        raw_value = (
            position.get("market_value")
            or position.get("current_value")
            or position.get("notional")
        )
        if raw_value is None:
            continue
        try:
            market_value = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        side = str(position.get("side") or "").strip().lower()
        if side == "short" and market_value != 0:
            open_symbols.add(symbol)
    return len(open_symbols)


def _int_param(value: Any) -> int:
    if value is None:
        return 0
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _bool_param(value: Any) -> bool | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off"}:
        return False
    return None


def _resolve_signal_timeframe(signal: SignalEnvelope) -> Optional[str]:
    if signal.timeframe is not None:
        return signal.timeframe
    payload_map: dict[str, Any] = signal.payload

    timeframe = payload_map.get("timeframe")
    if isinstance(timeframe, str):
        return _coerce_timeframe(timeframe)

    window = payload_map.get("window")
    if isinstance(window, dict):
        window_payload = cast(dict[str, Any], window)
        window_size = window_payload.get("size")
        if isinstance(window_size, str):
            return _coerce_timeframe(window_size)

    window_size_payload = payload_map.get("window_size")
    if isinstance(window_size_payload, str):
        return _coerce_timeframe(window_size_payload)

    window_step = payload_map.get("window_step")
    if isinstance(window_step, str):
        return _coerce_timeframe(window_step)

    return None


def _coerce_timeframe(value: str) -> Optional[str]:
    legacy_match = re.fullmatch(
        r"(?i)\s*(\d+)\s*(sec|secs|s|min|minute|minutes|m|hour|hours|h)\s*",
        value,
    )
    if legacy_match is not None:
        amount = int(legacy_match.group(1))
        unit = legacy_match.group(2).lower()
        if unit in {"sec", "secs", "s"}:
            return f"{amount}Sec"
        if unit in {"min", "minute", "minutes", "m"}:
            return f"{amount}Min"
        if unit in {"hour", "hours", "h"}:
            return f"{amount}Hour"

    iso_match = re.fullmatch(r"PT(\d+)([SMH])", value)
    if iso_match is not None:
        amount = int(iso_match.group(1))
        unit = iso_match.group(2)
        if unit == "S":
            return f"{amount}Sec"
        if unit == "M":
            return f"{amount}Min"
        if unit == "H":
            return f"{amount}Hour"
    return None


def _runtime_enabled() -> bool:
    mode = settings.trading_strategy_runtime_mode
    if mode == "plugin_v3":
        return True
    if mode == "scheduler_v3":
        return settings.trading_strategy_scheduler_enabled
    return False


__all__ = [
    "DecisionEngine",
    "DecisionRuntimeTelemetry",
    "SignalFeatures",
    "extract_signal_features",
]


# Public aliases used by split-module consumers.
count_open_short_positions = _count_open_short_positions
resolve_signal_timeframe = _resolve_signal_timeframe
runtime_enabled = _runtime_enabled

__all__ = (
    "count_open_short_positions",
    "resolve_signal_timeframe",
    "runtime_enabled",
)
