"""Trading decision engine based on TA signals."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Optional, cast

from ...config import settings
from ...models import Strategy
from ..features import (
    SignalFeatures,
)
from ..models import SignalEnvelope, StrategyDecision
from ..prices import MarketSnapshot
from ..strategy_runtime import (
    StrategyRuntime,
)


from .decision_engine_runtime_methods import (
    build_params,
    skip_non_executable_decision_qty,
)
from .aggregated_qty import (
    AggregatedCapacityAdjustment,
    AggregatedQtyContext,
    aggregated_capacity_adjustment,
    aggregated_capacity_exhausted_result,
    aggregated_capacity_meta,
    aggregated_capacity_reason,
    aggregated_exit_or_reentry_result,
    aggregated_min_qty_capacity_reason,
    aggregated_min_qty_result,
    aggregated_qty_context,
    aggregated_qty_success_result,
    aggregated_requested_qty,
    aggregated_short_entry_below_min,
    aggregated_zero_qty_result,
    negative_position_qty,
    position_qty_is_flat_or_long,
    position_qty_is_flat_or_short,
    positive_position_qty,
    resolve_qty_for_aggregated,
    resolve_qty_from_aggregated_context,
)
from .resolve_qty_for_aggregated_support import (
    default_trailing_stop_requires_structure_loss,
    passes_exit_profit_policy,
    position_age_seconds_for_symbol,
    position_avg_entry_price_for_symbol,
    position_qty_for_symbol,
    realized_exit_bps,
    reference_exit_price as resolve_reference_exit_price,
    resolve_bool_strategy_param,
    resolve_dynamic_exit_threshold_bps,
    resolve_max_nonnegative_strategy_param,
    resolve_min_positive_strategy_param,
    signal_spread_bps,
    strategy_catalog_runtime_type,
    trailing_stop_structure_loss_confirmed,
    treats_buy_as_exit_only,
    treats_sell_as_exit_only,
    volatility_to_bps,
)


@dataclass(frozen=True)
class RuntimeExitOverlayContext:
    signal: SignalEnvelope
    strategies: list[Strategy]
    timeframe: str
    positions: list[dict[str, Any]]
    equity: Optional[Decimal]
    price: Decimal
    features: SignalFeatures
    snapshot: Optional[MarketSnapshot]
    raw_runtime_by_strategy_id: Mapping[str, dict[str, Any]]
    runtime_eval: Any
    position_peak_price: Decimal | None
    aggregated: bool
    position_isolation_mode: str | None
    position_qty: Decimal
    position_side: Literal["long", "short"]
    exit_action: Literal["buy", "sell"]
    eligible_strategies: list[Strategy]
    avg_entry_price: Decimal


@dataclass(frozen=True)
class RuntimeExitOverlayRequest:
    signal: SignalEnvelope
    strategies: list[Strategy]
    timeframe: str
    decisions: list[StrategyDecision]
    positions: Optional[list[dict[str, Any]]]
    equity: Optional[Decimal]
    price: Optional[Decimal]
    features: SignalFeatures
    snapshot: Optional[MarketSnapshot]
    raw_runtime_by_strategy_id: Mapping[str, dict[str, Any]]
    runtime_eval: Any
    position_peak_price: Decimal | None
    aggregated: bool
    position_isolation_mode: str | None


@dataclass(frozen=True)
class RuntimeExitMetrics:
    spread_bps: Decimal | None
    volatility_bps: Decimal | None
    entry_drawdown_bps: Decimal
    position_age_seconds: int | None
    minute_of_day_utc: Decimal


@dataclass(frozen=True)
class RuntimeExitThresholds:
    hard_stop_threshold_bps: Decimal | None
    trailing_activation_profit_bps: Decimal | None
    trailing_stop_threshold_bps: Decimal | None
    trailing_stop_requires_structure_loss: bool
    trailing_stop_structure_loss_confirmed: bool
    flatten_start_minute_utc: Decimal | None
    max_hold_seconds: Decimal | None


@dataclass(frozen=True)
class RuntimeExitTrigger:
    exit_type: str
    rationale: str
    threshold_bps: Decimal | None
    drawdown_bps: Decimal | None
    reference_exit_price: Decimal
    realized_bps: Decimal


@dataclass(frozen=True)
class RuntimeExitSizing:
    qty: Decimal
    sizing_meta: dict[str, Any]


def build_runtime_position_exit_overlay(**kwargs: Any) -> StrategyDecision | None:
    request = runtime_exit_overlay_request(kwargs)
    context = runtime_exit_overlay_context(request)
    if context is None:
        return None
    metrics = runtime_exit_metrics(context)
    thresholds = runtime_exit_thresholds(context, metrics)
    candidates = runtime_exit_candidates(context, metrics, thresholds)
    if not candidates:
        return None
    trigger = runtime_exit_trigger(context, candidates)
    if trigger is None:
        return None
    sizing = runtime_exit_sizing(context)
    if sizing is None:
        return None
    return runtime_exit_decision(
        context=context,
        metrics=metrics,
        trigger=trigger,
        sizing=sizing,
    )


def runtime_exit_overlay_request(
    kwargs: Mapping[str, Any],
) -> RuntimeExitOverlayRequest:
    return RuntimeExitOverlayRequest(
        signal=cast(SignalEnvelope, kwargs["signal"]),
        strategies=cast(list[Strategy], kwargs["strategies"]),
        timeframe=str(kwargs["timeframe"]),
        decisions=cast(list[StrategyDecision], kwargs["decisions"]),
        positions=cast(Optional[list[dict[str, Any]]], kwargs["positions"]),
        equity=cast(Optional[Decimal], kwargs["equity"]),
        price=cast(Optional[Decimal], kwargs["price"]),
        features=cast(SignalFeatures, kwargs["features"]),
        snapshot=cast(Optional[MarketSnapshot], kwargs["snapshot"]),
        raw_runtime_by_strategy_id=cast(
            Mapping[str, dict[str, Any]],
            kwargs["raw_runtime_by_strategy_id"],
        ),
        runtime_eval=kwargs["runtime_eval"],
        position_peak_price=cast(
            Decimal | None,
            kwargs["position_peak_price"],
        ),
        aggregated=cast(bool, kwargs.get("aggregated", True)),
        position_isolation_mode=cast(str | None, kwargs.get("position_isolation_mode")),
    )


def runtime_exit_overlay_context(
    request: RuntimeExitOverlayRequest,
) -> RuntimeExitOverlayContext | None:
    if request.price is None or request.positions is None:
        return None
    position_qty = position_qty_for_symbol(request.positions, request.signal.symbol)
    if position_qty is None or position_qty == 0:
        return None
    position_side: Literal["long", "short"] = "long" if position_qty > 0 else "short"
    exit_action: Literal["buy", "sell"] = "sell" if position_side == "long" else "buy"
    if any(
        decision.symbol == request.signal.symbol and decision.action == exit_action
        for decision in request.decisions
    ):
        return None
    eligible_strategies = runtime_exit_eligible_strategies(
        strategies=request.strategies,
        timeframe=request.timeframe,
        position_side=position_side,
    )
    if not eligible_strategies:
        return None
    avg_entry_price = position_avg_entry_price_for_symbol(
        request.positions,
        request.signal.symbol,
    )
    if avg_entry_price is None or avg_entry_price <= 0:
        return None
    return RuntimeExitOverlayContext(
        signal=request.signal,
        strategies=request.strategies,
        timeframe=request.timeframe,
        positions=request.positions,
        equity=request.equity,
        price=request.price,
        features=request.features,
        snapshot=request.snapshot,
        raw_runtime_by_strategy_id=request.raw_runtime_by_strategy_id,
        runtime_eval=request.runtime_eval,
        position_peak_price=request.position_peak_price,
        aggregated=request.aggregated,
        position_isolation_mode=request.position_isolation_mode,
        position_qty=position_qty,
        position_side=position_side,
        exit_action=exit_action,
        eligible_strategies=eligible_strategies,
        avg_entry_price=avg_entry_price,
    )


def runtime_exit_eligible_strategies(
    *,
    strategies: list[Strategy],
    timeframe: str,
    position_side: Literal["long", "short"],
) -> list[Strategy]:
    return [
        strategy
        for strategy in strategies
        if strategy.enabled
        and strategy.base_timeframe == timeframe
        and supports_runtime_position_exit_overlay(
            strategy=strategy,
            position_side=position_side,
        )
    ]


def runtime_exit_metrics(context: RuntimeExitOverlayContext) -> RuntimeExitMetrics:
    return RuntimeExitMetrics(
        spread_bps=signal_spread_bps(signal=context.signal, price=context.price),
        volatility_bps=volatility_to_bps(context.features.volatility),
        entry_drawdown_bps=runtime_exit_entry_drawdown_bps(context),
        position_age_seconds=position_age_seconds_for_symbol(
            context.positions,
            context.signal.symbol,
            signal_ts=context.signal.event_ts,
        ),
        minute_of_day_utc=minute_of_day_utc(context.signal.event_ts),
    )


def runtime_exit_entry_drawdown_bps(
    context: RuntimeExitOverlayContext,
) -> Decimal:
    if context.position_side == "long" and context.price < context.avg_entry_price:
        return (
            (context.avg_entry_price - context.price) / context.avg_entry_price
        ) * Decimal("10000")
    if context.position_side == "short" and context.price > context.avg_entry_price:
        return (
            (context.price - context.avg_entry_price) / context.avg_entry_price
        ) * Decimal("10000")
    return Decimal("0")


def minute_of_day_utc(value: datetime) -> Decimal:
    event_ts = value.astimezone(timezone.utc)
    return Decimal(str(event_ts.hour * 60 + event_ts.minute))


def runtime_exit_thresholds(
    context: RuntimeExitOverlayContext,
    metrics: RuntimeExitMetrics,
) -> RuntimeExitThresholds:
    hard_stop_loss_bps = runtime_hard_stop_loss_bps(context)
    trailing_activation, trailing_threshold = runtime_trailing_thresholds(
        context,
        metrics,
    )
    return RuntimeExitThresholds(
        hard_stop_threshold_bps=resolve_dynamic_exit_threshold_bps(
            strategies=context.eligible_strategies,
            base_bps=hard_stop_loss_bps,
            spread_bps=metrics.spread_bps,
            spread_multiplier_key=f"{context.position_side}_stop_loss_spread_bps_multiplier",
            volatility_bps=metrics.volatility_bps,
            volatility_multiplier_key=f"{context.position_side}_stop_loss_volatility_bps_multiplier",
        ),
        trailing_activation_profit_bps=trailing_activation,
        trailing_stop_threshold_bps=trailing_threshold,
        trailing_stop_requires_structure_loss=resolve_bool_strategy_param(
            strategies=context.eligible_strategies,
            key="long_trailing_stop_requires_structure_loss",
            default=default_trailing_stop_requires_structure_loss(
                context.eligible_strategies
            ),
        ),
        trailing_stop_structure_loss_confirmed=trailing_stop_structure_loss_confirmed(
            signal=context.signal,
            price=context.price,
            strategies=context.eligible_strategies,
        ),
        flatten_start_minute_utc=resolve_max_nonnegative_strategy_param(
            strategies=context.eligible_strategies,
            key="session_flatten_start_minute_utc",
        ),
        max_hold_seconds=resolve_max_nonnegative_strategy_param(
            strategies=context.eligible_strategies,
            key="max_hold_seconds",
        ),
    )


def runtime_hard_stop_loss_bps(
    context: RuntimeExitOverlayContext,
) -> Decimal | None:
    value = resolve_min_positive_strategy_param(
        strategies=context.eligible_strategies,
        key=f"{context.position_side}_stop_loss_bps",
    )
    if value is None and context.position_side == "short":
        return resolve_min_positive_strategy_param(
            strategies=context.eligible_strategies,
            key="long_stop_loss_bps",
        )
    return value


def runtime_trailing_thresholds(
    context: RuntimeExitOverlayContext,
    metrics: RuntimeExitMetrics,
) -> tuple[Decimal | None, Decimal | None]:
    if context.position_side != "long":
        return None, None
    activation = resolve_min_positive_strategy_param(
        strategies=context.eligible_strategies,
        key="long_trailing_stop_activation_profit_bps",
    )
    drawdown = resolve_min_positive_strategy_param(
        strategies=context.eligible_strategies,
        key="long_trailing_stop_drawdown_bps",
    )
    threshold = resolve_dynamic_exit_threshold_bps(
        strategies=context.eligible_strategies,
        base_bps=drawdown,
        spread_bps=metrics.spread_bps,
        spread_multiplier_key="long_trailing_stop_spread_bps_multiplier",
        volatility_bps=metrics.volatility_bps,
        volatility_multiplier_key="long_trailing_stop_volatility_bps_multiplier",
    )
    return activation, threshold


def runtime_exit_candidates(
    context: RuntimeExitOverlayContext,
    metrics: RuntimeExitMetrics,
    thresholds: RuntimeExitThresholds,
) -> list[tuple[str, str, Decimal | None, Decimal | None]]:
    candidates: list[tuple[str, str, Decimal | None, Decimal | None]] = []
    trailing = runtime_trailing_exit_candidate(context, thresholds)
    if trailing is not None:
        candidates.append(trailing)
    if runtime_hard_stop_triggered(metrics, thresholds):
        candidates.append(
            (
                f"{context.position_side}_stop_loss_bps",
                "position_stop_loss_exit",
                thresholds.hard_stop_threshold_bps,
                metrics.entry_drawdown_bps,
            )
        )
    if runtime_max_hold_triggered(metrics, thresholds):
        candidates.append(
            (
                "max_hold_seconds",
                "position_time_exit",
                thresholds.max_hold_seconds,
                None,
            )
        )
    if runtime_session_flatten_triggered(metrics, thresholds):
        candidates.append(
            (
                "session_flatten_minute_utc",
                "session_flatten_exit",
                thresholds.flatten_start_minute_utc,
                None,
            )
        )
    return candidates


def runtime_trailing_exit_candidate(
    context: RuntimeExitOverlayContext,
    thresholds: RuntimeExitThresholds,
) -> tuple[str, str, Decimal | None, Decimal | None] | None:
    if not runtime_trailing_exit_armed(context, thresholds):
        return None
    peak_profit_bps = (
        (cast(Decimal, context.position_peak_price) - context.avg_entry_price)
        / context.avg_entry_price
    ) * Decimal("10000")
    if peak_profit_bps < cast(Decimal, thresholds.trailing_activation_profit_bps):
        return None
    if context.price >= cast(Decimal, context.position_peak_price):
        return None
    peak_drawdown_bps = (
        (cast(Decimal, context.position_peak_price) - context.price)
        / cast(Decimal, context.position_peak_price)
    ) * Decimal("10000")
    if peak_drawdown_bps < cast(Decimal, thresholds.trailing_stop_threshold_bps):
        return None
    if (
        thresholds.trailing_stop_requires_structure_loss
        and not thresholds.trailing_stop_structure_loss_confirmed
    ):
        return None
    return (
        "long_trailing_stop_bps",
        "position_trailing_stop_exit",
        thresholds.trailing_stop_threshold_bps,
        peak_drawdown_bps,
    )


def runtime_trailing_exit_armed(
    context: RuntimeExitOverlayContext,
    thresholds: RuntimeExitThresholds,
) -> bool:
    return (
        context.position_peak_price is not None
        and context.position_peak_price > context.avg_entry_price
        and thresholds.trailing_activation_profit_bps is not None
        and thresholds.trailing_stop_threshold_bps is not None
        and thresholds.trailing_stop_threshold_bps > 0
    )


def runtime_hard_stop_triggered(
    metrics: RuntimeExitMetrics,
    thresholds: RuntimeExitThresholds,
) -> bool:
    return (
        thresholds.hard_stop_threshold_bps is not None
        and thresholds.hard_stop_threshold_bps > 0
        and metrics.entry_drawdown_bps >= thresholds.hard_stop_threshold_bps
    )


def runtime_max_hold_triggered(
    metrics: RuntimeExitMetrics,
    thresholds: RuntimeExitThresholds,
) -> bool:
    return (
        thresholds.max_hold_seconds is not None
        and thresholds.max_hold_seconds > 0
        and metrics.position_age_seconds is not None
        and metrics.position_age_seconds >= int(thresholds.max_hold_seconds)
    )


def runtime_session_flatten_triggered(
    metrics: RuntimeExitMetrics,
    thresholds: RuntimeExitThresholds,
) -> bool:
    return (
        thresholds.flatten_start_minute_utc is not None
        and metrics.minute_of_day_utc >= thresholds.flatten_start_minute_utc
    )


def runtime_exit_trigger(
    context: RuntimeExitOverlayContext,
    candidates: list[tuple[str, str, Decimal | None, Decimal | None]],
) -> RuntimeExitTrigger | None:
    reference_exit_price = resolve_reference_exit_price(
        price=context.price,
        signal=context.signal,
        action=context.exit_action,
    )
    realized_bps = realized_exit_bps(
        avg_entry_price=context.avg_entry_price,
        exit_price=reference_exit_price,
        position_side=context.position_side,
    )
    for exit_type, rationale, threshold_bps, drawdown_bps in candidates:
        if runtime_exit_candidate_requires_profit(
            exit_type
        ) and not passes_exit_profit_policy(
            strategies=context.eligible_strategies,
            realized_bps=realized_bps,
        ):
            continue
        return RuntimeExitTrigger(
            exit_type=exit_type,
            rationale=rationale,
            threshold_bps=threshold_bps,
            drawdown_bps=drawdown_bps,
            reference_exit_price=reference_exit_price,
            realized_bps=realized_bps,
        )
    return None


def runtime_exit_candidate_requires_profit(exit_type: str) -> bool:
    return exit_type not in {
        "long_stop_loss_bps",
        "short_stop_loss_bps",
        "max_hold_seconds",
        "session_flatten_minute_utc",
    }


def runtime_exit_sizing(
    context: RuntimeExitOverlayContext,
) -> RuntimeExitSizing | None:
    qty, sizing_meta = resolve_qty_for_aggregated(
        context.eligible_strategies,
        symbol=context.signal.symbol,
        action=context.exit_action,
        price=context.price,
        equity=context.equity,
        positions=context.positions,
    )
    if skip_non_executable_decision_qty(qty=qty, sizing_meta=sizing_meta):
        return None
    return RuntimeExitSizing(qty=qty, sizing_meta=sizing_meta)


def runtime_exit_decision(
    *,
    context: RuntimeExitOverlayContext,
    metrics: RuntimeExitMetrics,
    trigger: RuntimeExitTrigger,
    sizing: RuntimeExitSizing,
) -> StrategyDecision:
    primary_strategy = context.eligible_strategies[0]
    return StrategyDecision(
        strategy_id=str(primary_strategy.id),
        symbol=context.signal.symbol,
        event_ts=context.signal.event_ts,
        timeframe=context.timeframe,
        action=context.exit_action,
        qty=sizing.qty,
        order_type="market",
        time_in_force="day",
        rationale=trigger.rationale,
        params=build_params(
            signal=context.signal,
            macd=context.features.macd,
            macd_signal=context.features.macd_signal,
            rsi=context.features.rsi,
            price=context.price,
            volatility=context.features.volatility,
            snapshot=context.snapshot,
            runtime_metadata=runtime_exit_metadata(context, primary_strategy, trigger),
        )
        | {
            "sizing": sizing.sizing_meta,
            "position_exit": runtime_exit_position_payload(
                context=context,
                metrics=metrics,
                trigger=trigger,
            ),
        },
    )


def runtime_exit_metadata(
    context: RuntimeExitOverlayContext,
    primary_strategy: Strategy,
    trigger: RuntimeExitTrigger,
) -> dict[str, Any]:
    primary_runtime_metadata = dict(
        context.raw_runtime_by_strategy_id.get(str(primary_strategy.id), {})
    )
    return {
        "mode": settings.trading_strategy_runtime_mode,
        "aggregated": context.aggregated,
        "position_isolation_mode": context.position_isolation_mode,
        "primary_strategy_row_id": str(primary_strategy.id),
        "primary_declared_strategy_id": primary_runtime_metadata.get(
            "declared_strategy_id"
        ),
        "source_strategy_ids": [
            str(strategy.id) for strategy in context.eligible_strategies
        ],
        "source_declared_strategy_ids": [
            str(item.get("declared_strategy_id"))
            for item in context.raw_runtime_by_strategy_id.values()
            if str(item.get("declared_strategy_id") or "").strip()
        ],
        "compiler_sources": sorted(
            {
                str(item.get("compiler_source") or "").strip()
                for item in context.raw_runtime_by_strategy_id.values()
                if str(item.get("compiler_source") or "").strip()
            }
        ),
        "source_strategy_runtime": [
            dict(context.raw_runtime_by_strategy_id[str(strategy.id)])
            for strategy in context.eligible_strategies
            if str(strategy.id) in context.raw_runtime_by_strategy_id
        ],
        "intent_conflicts_total": context.runtime_eval.observation.intent_conflicts_total,
        "strategy_errors": [
            {
                "strategy_id": error.strategy_id,
                "strategy_type": error.strategy_type,
                "plugin_id": error.plugin_id,
                "reason": error.reason,
            }
            for error in context.runtime_eval.errors
        ],
        "exit_overlay": trigger.exit_type,
    }


def runtime_exit_position_payload(
    *,
    context: RuntimeExitOverlayContext,
    metrics: RuntimeExitMetrics,
    trigger: RuntimeExitTrigger,
) -> dict[str, Any]:
    return {
        "type": trigger.exit_type,
        "threshold_bps": trigger.threshold_bps,
        "drawdown_bps": trigger.drawdown_bps,
        "avg_entry_price": context.avg_entry_price,
        "peak_price": context.position_peak_price,
        "entry_drawdown_bps": metrics.entry_drawdown_bps,
        "reference_exit_price": trigger.reference_exit_price,
        "realized_bps": trigger.realized_bps,
        "spread_bps": metrics.spread_bps,
        "volatility_bps": metrics.volatility_bps,
    }


def blocks_same_direction_reentry(strategy: Strategy) -> bool:
    normalized = str(strategy.universe_type or "").strip().lower()
    return normalized in {
        "intraday_tsmom_v1",
        "intraday_tsmom",
        "tsmom_intraday",
        "momentum_pullback_long_v1",
        "microbar_cross_sectional_long_v1",
        "breakout_continuation_long_v1",
        "washout_rebound_long_v1",
        "mean_reversion_rebound_long_v1",
        "late_day_continuation_long_v1",
        "end_of_day_reversal_long_v1",
    }


def strategy_uses_position_isolation(strategy: Strategy) -> bool:
    params = StrategyRuntime.definition_from_strategy(strategy).params
    isolation_mode = str(params.get("position_isolation_mode") or "").strip().lower()
    if isolation_mode == "per_strategy":
        return True
    normalized = str(strategy.universe_type or "").strip().lower()
    runtime_type = strategy_catalog_runtime_type(strategy)
    if (
        normalized == "microbar_cross_sectional_pairs_v1"
        and runtime_type != "microbar_cross_sectional_pairs_v1"
    ):
        return False
    return normalized in {
        "momentum_pullback_long_v1",
        "breakout_continuation_long_v1",
        "microbar_cross_sectional_pairs_v1",
        "mean_reversion_rebound_long_v1",
        "late_day_continuation_long_v1",
        "end_of_day_reversal_long_v1",
    }


def supports_runtime_position_exit_overlay(
    *,
    strategy: Strategy,
    position_side: Literal["long", "short"],
) -> bool:
    if (
        treats_sell_as_exit_only(strategy)
        if position_side == "long"
        else treats_buy_as_exit_only(strategy)
    ):
        return True
    runtime_type = strategy_catalog_runtime_type(strategy)
    if runtime_type != "microbar_cross_sectional_pairs_v1":
        return False
    strategy_list = [strategy]
    has_session_flatten = (
        resolve_max_nonnegative_strategy_param(
            strategies=strategy_list,
            key="session_flatten_start_minute_utc",
        )
        is not None
    )
    has_position_exit = any(
        resolve_max_nonnegative_strategy_param(strategies=strategy_list, key=key)
        is not None
        for key in (
            "max_hold_seconds",
            "long_stop_loss_bps",
            "short_stop_loss_bps",
            "long_trailing_stop_activation_profit_bps",
            "long_trailing_stop_drawdown_bps",
        )
    )
    return strategy_uses_position_isolation(strategy) and (
        has_session_flatten or has_position_exit
    )


def position_state_scope_key(
    *,
    position_isolation_mode: str | None,
    strategy_id: str | None,
) -> str | None:
    if str(position_isolation_mode or "").strip().lower() != "per_strategy":
        return None
    normalized_strategy_id = str(strategy_id or "").strip()
    return normalized_strategy_id or None


def runtime_trade_policy_key(
    *,
    symbol: str,
    action: str,
    state_scope_key: str | None,
) -> tuple[str, str, str | None]:
    return (
        symbol.strip().upper(),
        action.strip().lower(),
        state_scope_key,
    )


__all__ = (
    "build_runtime_position_exit_overlay",
    "position_state_scope_key",
    "runtime_trade_policy_key",
    "strategy_uses_position_isolation",
    "AggregatedCapacityAdjustment",
    "AggregatedQtyContext",
    "RuntimeExitMetrics",
    "RuntimeExitOverlayContext",
    "RuntimeExitOverlayRequest",
    "RuntimeExitSizing",
    "RuntimeExitThresholds",
    "RuntimeExitTrigger",
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
    "blocks_same_direction_reentry",
    "minute_of_day_utc",
    "negative_position_qty",
    "position_qty_is_flat_or_long",
    "position_qty_is_flat_or_short",
    "positive_position_qty",
    "resolve_qty_for_aggregated",
    "resolve_qty_from_aggregated_context",
    "runtime_exit_candidate_requires_profit",
    "runtime_exit_candidates",
    "runtime_exit_decision",
    "runtime_exit_eligible_strategies",
    "runtime_exit_entry_drawdown_bps",
    "runtime_exit_metadata",
    "runtime_exit_metrics",
    "runtime_exit_overlay_context",
    "runtime_exit_overlay_request",
    "runtime_exit_position_payload",
    "runtime_exit_sizing",
    "runtime_exit_thresholds",
    "runtime_exit_trigger",
    "runtime_hard_stop_loss_bps",
    "runtime_hard_stop_triggered",
    "runtime_max_hold_triggered",
    "runtime_session_flatten_triggered",
    "runtime_trailing_exit_armed",
    "runtime_trailing_exit_candidate",
    "runtime_trailing_thresholds",
    "supports_runtime_position_exit_overlay",
)
