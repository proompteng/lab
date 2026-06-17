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

# ruff: noqa: F401,F811,F821

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


def _int_param(value: Any) -> int:
    if value is None:
        return 0
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _resolve_runtime_trade_policy(
    strategies: list[Strategy],
) -> dict[str, int | Decimal]:
    entry_cooldown = 0
    exit_cooldown = 0
    min_hold = 0
    max_hold_candidates: list[int] = []
    max_concurrent_candidates: list[int] = []
    max_entries_per_session_candidates: list[int] = []
    max_stop_loss_exits_candidates: list[int] = []
    max_negative_exits_candidates: list[int] = []
    stop_loss_lockout = 0
    negative_exit_lockout = 0
    negative_exit_loss_bps_candidates: list[Decimal] = []
    max_session_negative_exit_bps_candidates: list[Decimal] = []
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        entry_cooldown = max(
            entry_cooldown,
            _int_param(params.get("entry_cooldown_seconds")),
        )
        exit_cooldown = max(
            exit_cooldown,
            _int_param(params.get("exit_cooldown_seconds")),
        )
        min_hold = max(
            min_hold,
            _int_param(params.get("min_hold_seconds")),
        )
        max_hold_seconds = _int_param(params.get("max_hold_seconds"))
        if max_hold_seconds > 0:
            max_hold_candidates.append(max_hold_seconds)
        max_concurrent_positions = _int_param(params.get("max_concurrent_positions"))
        if max_concurrent_positions > 0:
            max_concurrent_candidates.append(max_concurrent_positions)
        max_entries_per_session = _int_param(params.get("max_entries_per_session"))
        if max_entries_per_session > 0:
            max_entries_per_session_candidates.append(max_entries_per_session)
        max_stop_loss_exits = _int_param(params.get("max_stop_loss_exits_per_session"))
        if max_stop_loss_exits > 0:
            max_stop_loss_exits_candidates.append(max_stop_loss_exits)
        max_negative_exits = _int_param(params.get("max_negative_exits_per_session"))
        if max_negative_exits > 0:
            max_negative_exits_candidates.append(max_negative_exits)
        stop_loss_lockout = max(
            stop_loss_lockout,
            _int_param(params.get("stop_loss_lockout_seconds")),
        )
        negative_exit_lockout = max(
            negative_exit_lockout,
            _int_param(params.get("negative_exit_lockout_seconds")),
        )
        negative_exit_loss_bps = optional_decimal(params.get("negative_exit_loss_bps"))
        if negative_exit_loss_bps is not None and negative_exit_loss_bps > 0:
            negative_exit_loss_bps_candidates.append(negative_exit_loss_bps)
        max_session_negative_exit_bps = optional_decimal(
            params.get("max_session_negative_exit_bps")
        )
        if (
            max_session_negative_exit_bps is not None
            and max_session_negative_exit_bps > 0
        ):
            max_session_negative_exit_bps_candidates.append(
                max_session_negative_exit_bps
            )
    return {
        "entry_cooldown_seconds": entry_cooldown,
        "exit_cooldown_seconds": exit_cooldown,
        "min_hold_seconds": min_hold,
        "max_hold_seconds": min(max_hold_candidates) if max_hold_candidates else 0,
        "max_concurrent_positions": (
            min(max_concurrent_candidates) if max_concurrent_candidates else 0
        ),
        "max_entries_per_session": (
            min(max_entries_per_session_candidates)
            if max_entries_per_session_candidates
            else 0
        ),
        "max_stop_loss_exits_per_session": (
            min(max_stop_loss_exits_candidates) if max_stop_loss_exits_candidates else 0
        ),
        "max_negative_exits_per_session": (
            min(max_negative_exits_candidates) if max_negative_exits_candidates else 0
        ),
        "stop_loss_lockout_seconds": stop_loss_lockout,
        "negative_exit_lockout_seconds": negative_exit_lockout,
        "negative_exit_loss_bps": (
            min(negative_exit_loss_bps_candidates)
            if negative_exit_loss_bps_candidates
            else Decimal("0")
        ),
        "max_session_negative_exit_bps": (
            min(max_session_negative_exit_bps_candidates)
            if max_session_negative_exit_bps_candidates
            else Decimal("0")
        ),
    }


def _passes_runtime_trade_policy(
    *,
    strategies: list[Strategy],
    last_emitted_action_at: dict[tuple[str, str, str | None], datetime],
    runtime_trade_policy_state: dict[tuple[str, str], _RuntimeTradePolicySessionState],
    signal_ts: datetime,
    symbol: str,
    action: str,
    position_owner: str,
    positions: Optional[list[dict[str, Any]]],
    policy: Mapping[str, int | Decimal],
    position_exit_type: str | None = None,
    runtime_exit_side: Literal["long", "short"] | None = None,
    state_scope_key: str | None = None,
) -> bool:
    normalized_action = action.strip().lower()
    session_state = _resolve_runtime_trade_policy_session_state(
        runtime_trade_policy_state=runtime_trade_policy_state,
        signal_ts=signal_ts,
        symbol=symbol,
        position_owner=position_owner,
    )
    entry_action = runtime_exit_side is None and _is_entry_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    exit_action = runtime_exit_side is not None or _is_exit_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if entry_action:
        max_concurrent_positions = max(
            0, int(policy.get("max_concurrent_positions", 0))
        )
        if max_concurrent_positions > 0 and (
            (
                normalized_action == "buy"
                and _count_open_long_positions(positions) >= max_concurrent_positions
            )
            or (
                normalized_action == "sell"
                and _count_open_short_positions(positions) >= max_concurrent_positions
            )
        ):
            return False
        max_entries_per_session = max(0, int(policy.get("max_entries_per_session", 0)))
        if (
            max_entries_per_session > 0
            and session_state.entry_count >= max_entries_per_session
        ):
            return False
        max_stop_loss_exits = max(
            0, int(policy.get("max_stop_loss_exits_per_session", 0))
        )
        if (
            max_stop_loss_exits > 0
            and session_state.stop_loss_exit_count >= max_stop_loss_exits
        ):
            return False
        max_negative_exits = max(
            0, int(policy.get("max_negative_exits_per_session", 0))
        )
        if (
            max_negative_exits > 0
            and session_state.negative_exit_count >= max_negative_exits
        ):
            return False
        max_session_negative_exit_bps = optional_decimal(
            policy.get("max_session_negative_exit_bps")
        )
        if (
            max_session_negative_exit_bps is not None
            and max_session_negative_exit_bps > 0
            and session_state.cumulative_negative_exit_bps
            >= max_session_negative_exit_bps
        ):
            return False
        stop_loss_lockout_seconds = max(
            0, int(policy.get("stop_loss_lockout_seconds", 0))
        )
        if (
            stop_loss_lockout_seconds > 0
            and session_state.last_stop_loss_exit_at is not None
            and (
                signal_ts.astimezone(timezone.utc)
                - session_state.last_stop_loss_exit_at.astimezone(timezone.utc)
            ).total_seconds()
            < stop_loss_lockout_seconds
        ):
            return False
        negative_exit_lockout_seconds = max(
            0, int(policy.get("negative_exit_lockout_seconds", 0))
        )
        if (
            negative_exit_lockout_seconds > 0
            and session_state.last_negative_exit_at is not None
            and (
                signal_ts.astimezone(timezone.utc)
                - session_state.last_negative_exit_at.astimezone(timezone.utc)
            ).total_seconds()
            < negative_exit_lockout_seconds
        ):
            return False

    cooldown_key = "entry_cooldown_seconds" if entry_action else "exit_cooldown_seconds"
    cooldown_seconds = max(0, int(policy.get(cooldown_key, 0)))
    last_emitted = last_emitted_action_at.get(
        _runtime_trade_policy_key(
            symbol=symbol,
            action=normalized_action,
            state_scope_key=state_scope_key,
        )
    )
    if (
        cooldown_seconds > 0
        and last_emitted is not None
        and (
            signal_ts.astimezone(timezone.utc) - last_emitted.astimezone(timezone.utc)
        ).total_seconds()
        < cooldown_seconds
    ):
        return False

    if not exit_action:
        return True

    if _position_exit_bypasses_min_hold(position_exit_type):
        return True

    min_hold_seconds = max(0, int(policy.get("min_hold_seconds", 0)))
    if min_hold_seconds <= 0:
        return True
    position_opened_at = _position_opened_at_for_symbol(positions, symbol)
    if position_opened_at is None:
        return True
    age_seconds = (
        signal_ts.astimezone(timezone.utc) - position_opened_at.astimezone(timezone.utc)
    ).total_seconds()
    return age_seconds >= min_hold_seconds


def _decision_position_exit_type(decision: StrategyDecision) -> str | None:
    position_exit = decision.params.get("position_exit")
    if not isinstance(position_exit, Mapping):
        return None
    normalized = str(cast(Mapping[str, Any], position_exit).get("type") or "").strip()
    return normalized or None


def _position_exit_bypasses_min_hold(position_exit_type: str | None) -> bool:
    normalized = str(position_exit_type or "").strip().lower()
    return normalized in {
        "long_stop_loss_bps",
        "short_stop_loss_bps",
        "max_hold_seconds",
        "session_flatten_minute_utc",
    }


def _resolve_strategy_time_in_force(
    *,
    strategies: list[Strategy],
    action: str,
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> str:
    normalized_action = str(action or "").strip().lower()
    param_key = (
        "exit_time_in_force"
        if runtime_exit_side is not None
        else "entry_time_in_force"
        if _is_entry_action_for_strategies(
            strategies=strategies, action=normalized_action
        )
        else "exit_time_in_force"
    )
    supported_values = {"day", "gtc", "ioc", "fok"}
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        candidate = str(params.get(param_key) or "").strip().lower()
        if candidate in supported_values:
            return candidate
    if normalized_action == "buy":
        continuation_strategy_types = {
            "breakout_continuation_long_v1",
            "late_day_continuation_long_v1",
        }
        if any(
            str(strategy.universe_type or "").strip().lower()
            in continuation_strategy_types
            for strategy in strategies
        ):
            return "ioc"
    return "day"


def _runtime_trade_policy_owner(
    *,
    primary_strategy_id: str,
    position_isolation_mode: str | None,
) -> str:
    if str(position_isolation_mode or "").strip().lower() == "per_strategy":
        return primary_strategy_id
    return _RUNTIME_TRADE_POLICY_SHARED_OWNER


def _resolve_runtime_trade_policy_session_state(
    *,
    runtime_trade_policy_state: dict[tuple[str, str], _RuntimeTradePolicySessionState],
    signal_ts: datetime,
    symbol: str,
    position_owner: str,
) -> _RuntimeTradePolicySessionState:
    session_day = signal_ts.astimezone(timezone.utc).date()
    key = (
        symbol.strip().upper(),
        position_owner.strip() or _RUNTIME_TRADE_POLICY_SHARED_OWNER,
    )
    state = runtime_trade_policy_state.get(key)
    if state is None or state.session_day != session_day:
        state = _RuntimeTradePolicySessionState(session_day=session_day)
        runtime_trade_policy_state[key] = state
    return state


def _record_runtime_trade_policy_decision(
    *,
    strategies: list[Strategy],
    runtime_trade_policy_state: dict[tuple[str, str], _RuntimeTradePolicySessionState],
    signal_ts: datetime,
    symbol: str,
    position_owner: str,
    action: str,
    policy: Mapping[str, int | Decimal],
    positions: Optional[list[dict[str, Any]]],
    signal: SignalEnvelope,
    price: Decimal | None,
    decision: StrategyDecision,
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> None:
    normalized_action = action.strip().lower()
    state = _resolve_runtime_trade_policy_session_state(
        runtime_trade_policy_state=runtime_trade_policy_state,
        signal_ts=signal_ts,
        symbol=symbol,
        position_owner=position_owner,
    )
    entry_action = runtime_exit_side is None and _is_entry_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    exit_side = runtime_exit_side or _exit_position_side_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if entry_action:
        state.entry_count += 1
        return
    if exit_side is None or price is None or price <= 0:
        return

    position_exit = decision.params.get("position_exit")
    position_exit_type = (
        str(cast(Mapping[str, Any], position_exit).get("type") or "").strip()
        if isinstance(position_exit, Mapping)
        else ""
    )
    if position_exit_type in {"long_stop_loss_bps", "short_stop_loss_bps"}:
        state.stop_loss_exit_count += 1
        state.last_stop_loss_exit_at = signal_ts

    avg_entry_price = _position_avg_entry_price_for_symbol(positions, symbol)
    if avg_entry_price is None or avg_entry_price <= 0:
        return
    realized_bps = _realized_exit_bps(
        avg_entry_price=avg_entry_price,
        exit_price=_reference_exit_price(
            price=price,
            signal=signal,
            action=normalized_action,
        ),
        position_side=exit_side,
    )
    if realized_bps >= 0:
        return

    negative_exit_loss_bps = optional_decimal(policy.get("negative_exit_loss_bps"))
    loss_bps = abs(realized_bps)
    if (
        negative_exit_loss_bps is not None
        and negative_exit_loss_bps > 0
        and loss_bps < negative_exit_loss_bps
    ):
        return
    state.negative_exit_count += 1
    state.last_negative_exit_at = signal_ts
    state.cumulative_negative_exit_bps += loss_bps


def _passes_signal_exit_policy(
    *,
    strategies: list[Strategy],
    symbol: str,
    action: str,
    price: Optional[Decimal],
    signal: SignalEnvelope,
    positions: Optional[list[dict[str, Any]]],
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> bool:
    normalized_action = action.strip().lower()
    exit_side = runtime_exit_side or _exit_position_side_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if exit_side is None or price is None or price <= 0:
        return True

    position_qty = _position_qty_for_symbol(positions, symbol)
    if (exit_side == "long" and (position_qty is None or position_qty <= 0)) or (
        exit_side == "short" and (position_qty is None or position_qty >= 0)
    ):
        return True

    avg_entry_price = _position_avg_entry_price_for_symbol(positions, symbol)
    if avg_entry_price is None or avg_entry_price <= 0:
        return True

    reference_exit_price = _reference_exit_price(
        price=price,
        signal=signal,
        action=normalized_action,
    )
    realized_bps = _realized_exit_bps(
        avg_entry_price=avg_entry_price,
        exit_price=reference_exit_price,
        position_side=exit_side,
    )
    return _passes_exit_profit_policy(
        strategies=strategies,
        realized_bps=realized_bps,
    )


def _runtime_intent_exit_side(
    *,
    action: str,
    explain: tuple[str, ...],
) -> Literal["long", "short"] | None:
    tokens = {str(item).strip().lower() for item in explain if str(item).strip()}
    if _MICROBAR_PAIR_EXIT_RATIONALE not in tokens:
        return None
    normalized_action = action.strip().lower()
    if normalized_action == "sell":
        return "long"
    if normalized_action == "buy":
        return "short"
    return None


def _default_trailing_stop_requires_structure_loss(
    strategies: list[Strategy],
) -> bool:
    continuation_strategy_types = {
        "breakout_continuation_long_v1",
        "late_day_continuation_long_v1",
    }
    return any(
        str(strategy.universe_type or "").strip().lower() in continuation_strategy_types
        for strategy in strategies
    )


def _trailing_stop_structure_loss_confirmed(
    *,
    signal: SignalEnvelope,
    price: Decimal,
    strategies: list[Strategy],
) -> bool:
    payload = signal.payload or {}
    vwap_threshold = _resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="long_trailing_stop_structure_loss_vwap_bps",
    )
    if vwap_threshold is None:
        vwap_threshold = Decimal("0")
    opening_range_high_threshold = _resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="long_trailing_stop_structure_loss_price_vs_opening_range_high_bps",
    )
    if opening_range_high_threshold is None:
        opening_range_high_threshold = Decimal("0")
    session_range_position_max = _resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="long_trailing_stop_structure_loss_session_range_position_max",
    )
    if session_range_position_max is None:
        session_range_position_max = Decimal("0.80")
    price_vs_vwap_w5m_bps = _signal_decimal_feature_bps(
        signal,
        key="price_vs_vwap_w5m_bps",
        price=price,
        reference_key="vwap_w5m",
    )
    price_vs_opening_range_high_bps = _signal_decimal_feature_bps(
        signal,
        key="price_vs_opening_range_high_bps",
        price=price,
        reference_key="opening_range_high",
    )
    price_position_in_session_range = optional_decimal(
        payload.get("price_position_in_session_range")
    )
    return (
        price_vs_opening_range_high_bps is not None
        and price_vs_opening_range_high_bps <= opening_range_high_threshold
    ) or (
        price_vs_vwap_w5m_bps is not None
        and price_vs_vwap_w5m_bps <= vwap_threshold
        and price_position_in_session_range is not None
        and price_position_in_session_range <= session_range_position_max
    )


def _signal_spread(signal: SignalEnvelope) -> Decimal | None:
    payload = signal.payload or {}
    spread = optional_decimal(payload.get("spread"))
    if spread is not None and spread > 0:
        return spread

    bid = optional_decimal(payload.get("imbalance_bid_px"))
    ask = optional_decimal(payload.get("imbalance_ask_px"))
    imbalance_payload = payload.get("imbalance")
    if isinstance(imbalance_payload, Mapping):
        imbalance_mapping = cast(Mapping[str, Any], imbalance_payload)
        if bid is None:
            bid = optional_decimal(imbalance_mapping.get("bid_px"))
        if ask is None:
            ask = optional_decimal(imbalance_mapping.get("ask_px"))
        if spread is None:
            spread = optional_decimal(imbalance_mapping.get("spread"))
    if spread is not None and spread > 0:
        return spread
    if bid is None or ask is None or ask <= bid:
        return None
    return ask - bid


def _signal_decimal_feature_bps(
    signal: SignalEnvelope,
    *,
    key: str,
    price: Decimal,
    reference_key: str,
) -> Decimal | None:
    payload = signal.payload or {}
    direct_value = optional_decimal(payload.get(key))
    if direct_value is not None:
        return direct_value
    reference_value = optional_decimal(payload.get(reference_key))
    if reference_value is None or reference_value <= 0 or price <= 0:
        return None
    return ((price - reference_value) / reference_value) * Decimal("10000")


def _near_touch_exit_price(
    price: Decimal,
    spread: Decimal | None,
    action: str,
) -> Decimal:
    if spread is None or spread <= 0:
        return _normalize_exit_price(price)
    half_spread = spread / Decimal("2")
    if action == "buy":
        return _normalize_exit_price(price + half_spread)
    return _normalize_exit_price(price - half_spread)


def _normalize_exit_price(price: Decimal) -> Decimal:
    tick_size = (
        Decimal("0.0001") if price.copy_abs() < Decimal("1") else Decimal("0.01")
    )
    return price.quantize(tick_size, rounding=ROUND_HALF_UP)


def _position_opened_at_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> datetime | None:
    if not positions:
        return None
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != symbol.strip().upper():
            continue
        raw = position.get("opened_at")
        if raw is None:
            return None
        try:
            parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return None


def _position_age_seconds_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
    *,
    signal_ts: datetime,
) -> int | None:
    opened_at = _position_opened_at_for_symbol(positions, symbol)
    if opened_at is None:
        return None
    age_seconds = (
        signal_ts.astimezone(timezone.utc) - opened_at.astimezone(timezone.utc)
    ).total_seconds()
    return max(0, int(age_seconds))


def _count_open_long_positions(positions: Optional[list[dict[str, Any]]]) -> int:
    if not positions:
        return 0
    open_symbols: set[str] = set()
    for position in positions:
        symbol = str(position.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        qty = _position_qty_from_payload(position)
        if qty is not None:
            if qty > 0:
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
        if market_value > 0:
            open_symbols.add(symbol)
    return len(open_symbols)


# Public aliases used by split-module consumers.
decision_position_exit_type = _decision_position_exit_type
passes_runtime_trade_policy = _passes_runtime_trade_policy
passes_signal_exit_policy = _passes_signal_exit_policy
record_runtime_trade_policy_decision = _record_runtime_trade_policy_decision
resolve_runtime_trade_policy = _resolve_runtime_trade_policy
resolve_strategy_time_in_force = _resolve_strategy_time_in_force
runtime_intent_exit_side = _runtime_intent_exit_side
runtime_trade_policy_owner = _runtime_trade_policy_owner
count_open_long_positions = _count_open_long_positions
default_trailing_stop_requires_structure_loss = (
    _default_trailing_stop_requires_structure_loss
)
near_touch_exit_price = _near_touch_exit_price
normalize_exit_price = _normalize_exit_price
position_age_seconds_for_symbol = _position_age_seconds_for_symbol
position_exit_bypasses_min_hold = _position_exit_bypasses_min_hold
position_opened_at_for_symbol = _position_opened_at_for_symbol
resolve_runtime_trade_policy_session_state = _resolve_runtime_trade_policy_session_state
signal_decimal_feature_bps = _signal_decimal_feature_bps
signal_spread = _signal_spread
trailing_stop_structure_loss_confirmed = _trailing_stop_structure_loss_confirmed

__all__ = [name for name in globals() if not name.startswith("__")]
