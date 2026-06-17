# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    DecisionRuntimeTelemetry,
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
    logger,
)
from .decision_engine_core_methods import _DecisionEngineCoreMethods
from .decision_engine_runtime_methods import (
    DecisionEngine,
    _BuildParamsRequest,
    _DecisionEngineRuntimeMethods,
    _LegacyDecisionInputs,
    _LegacyMarketContext,
    _LegacySizing,
    _SingleStrategyCapacityAdjustment,
    _SingleStrategyQtyContext,
    _StrategyBudget,
    _base_decision_params,
    _build_params,
    _build_params_request,
    _forecast_decision_params,
    _has_explicit_regime_context,
    _legacy_decision_inputs,
    _legacy_runtime_metadata,
    _legacy_strategy_decision,
    _log_skipped_legacy_decision,
    _market_decision_params,
    _regime_decision_params,
    _resolve_decision_simulation_context,
    _resolve_execution_advice_payload,
    _resolve_execution_feature_payload,
    _resolve_fragility_snapshot_payload,
    _resolve_microstructure_state_payload,
    _resolve_qty,
    _resolve_regime_context,
    _resolve_single_strategy_qty_from_context,
    _single_strategy_budget,
    _single_strategy_capacity_adjustment,
    _single_strategy_capacity_exhausted_result,
    _single_strategy_capacity_reason,
    _single_strategy_common_meta,
    _single_strategy_exit_guard_result,
    _single_strategy_min_qty_capacity_reason,
    _single_strategy_min_qty_result,
    _single_strategy_qty_context,
    _single_strategy_requested_qty,
    _single_strategy_short_entry_below_min_result,
    _single_strategy_success_result,
    _skip_non_executable_decision_qty,
    _snapshot_payload,
    _source_context_decision_params,
)
from .resolve_qty_for_aggregated import (
    _AggregatedCapacityAdjustment,
    _AggregatedQtyContext,
    _RuntimeExitMetrics,
    _RuntimeExitOverlayContext,
    _RuntimeExitOverlayRequest,
    _RuntimeExitSizing,
    _RuntimeExitThresholds,
    _RuntimeExitTrigger,
    _aggregated_capacity_adjustment,
    _aggregated_capacity_exhausted_result,
    _aggregated_capacity_meta,
    _aggregated_capacity_reason,
    _aggregated_exit_or_reentry_result,
    _aggregated_min_qty_capacity_reason,
    _aggregated_min_qty_result,
    _aggregated_qty_context,
    _aggregated_qty_success_result,
    _aggregated_requested_qty,
    _aggregated_short_entry_below_min,
    _aggregated_zero_qty_result,
    _blocks_same_direction_reentry,
    _build_runtime_position_exit_overlay,
    _minute_of_day_utc,
    _negative_position_qty,
    _position_qty_is_flat_or_long,
    _position_qty_is_flat_or_short,
    _position_state_scope_key,
    _positive_position_qty,
    _resolve_qty_for_aggregated,
    _resolve_qty_from_aggregated_context,
    _runtime_exit_candidate_requires_profit,
    _runtime_exit_candidates,
    _runtime_exit_decision,
    _runtime_exit_eligible_strategies,
    _runtime_exit_entry_drawdown_bps,
    _runtime_exit_metadata,
    _runtime_exit_metrics,
    _runtime_exit_overlay_context,
    _runtime_exit_overlay_request,
    _runtime_exit_position_payload,
    _runtime_exit_sizing,
    _runtime_exit_thresholds,
    _runtime_exit_trigger,
    _runtime_hard_stop_loss_bps,
    _runtime_hard_stop_triggered,
    _runtime_max_hold_triggered,
    _runtime_session_flatten_triggered,
    _runtime_trade_policy_key,
    _runtime_trailing_exit_armed,
    _runtime_trailing_exit_candidate,
    _runtime_trailing_thresholds,
    _strategy_uses_position_isolation,
    _supports_runtime_position_exit_overlay,
)
from .positions_for_strategy_action import (
    _actual_positions_only,
    _blocks_same_direction_reentry_any,
    _cap_requested_qty_by_portfolio_gross_cap,
    _cap_requested_qty_by_symbol_cap,
    _exit_position_side_for_strategies,
    _has_legacy_indicator_inputs,
    _is_entry_action_for_strategies,
    _is_exit_action_for_strategies,
    _is_pending_entry_position,
    _max_requested_qty_with_symbol_cap,
    _passes_exit_profit_policy,
    _portfolio_gross_exposure,
    _position_avg_entry_price_for_symbol,
    _position_qty_for_symbol,
    _position_qty_from_payload,
    _position_value_for_symbol,
    _positions_for_strategy_action,
    _realized_exit_bps,
    _reference_exit_price,
    _resolve_aggregated_notional_budget,
    _resolve_bool_strategy_param,
    _resolve_dynamic_exit_threshold_bps,
    _resolve_legacy_action,
    _resolve_max_nonnegative_strategy_param,
    _resolve_min_positive_strategy_param,
    _resolve_portfolio_gross_cap,
    _resolve_symbol_notional_cap,
    _same_direction_reentry_exists,
    _signal_spread_bps,
    _strategy_catalog_runtime_type,
    _strategy_exit_semantics_type,
    _treats_buy_as_exit_only,
    _treats_buy_as_exit_only_any,
    _treats_sell_as_exit_only,
    _treats_sell_as_exit_only_any,
    _volatility_to_bps,
)
from .resolve_runtime_trade_policy import (
    _count_open_long_positions,
    _decision_position_exit_type,
    _default_trailing_stop_requires_structure_loss,
    _near_touch_exit_price,
    _normalize_exit_price,
    _passes_runtime_trade_policy,
    _passes_signal_exit_policy,
    _position_age_seconds_for_symbol,
    _position_exit_bypasses_min_hold,
    _position_opened_at_for_symbol,
    _record_runtime_trade_policy_decision,
    _resolve_runtime_trade_policy,
    _resolve_runtime_trade_policy_session_state,
    _resolve_strategy_time_in_force,
    _runtime_intent_exit_side,
    _runtime_trade_policy_owner,
    _signal_decimal_feature_bps,
    _signal_spread,
    _trailing_stop_structure_loss_confirmed,
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


__all__ = [name for name in globals() if not name.startswith("__")]
