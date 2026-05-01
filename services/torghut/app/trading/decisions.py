"""Trading decision engine based on TA signals."""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Literal, Optional, cast

from ..config import settings
from ..models import Strategy
from ..strategies.catalog import extract_catalog_metadata
from .features import (
    FeatureNormalizationError,
    SignalFeatures,
    extract_signal_features,
    normalize_feature_vector_v3,
    optional_decimal,
)
from .microstructure import parse_microstructure_state
from .evaluation_trace import StrategyTrace
from .forecasting import ForecastRoutingTelemetry, build_default_forecast_router
from .models import SignalEnvelope, StrategyDecision
from .regime_hmm import (
    HMM_UNKNOWN_REGIME_ID,
    resolve_hmm_context,
    resolve_regime_route_label,
)
from .prices import MarketSnapshot, PriceFetcher
from .quote_quality import QuoteQualityPolicy
from .quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from .session_context import SessionContextTracker
from .simulation import resolve_simulation_context
from .strategy_runtime import (
    RuntimeErrorRecord,
    RuntimeObservation,
    StrategyRegistry,
    StrategyRuntime,
)

logger = logging.getLogger(__name__)
_SHORT_ENTRY_BELOW_MIN_QTY_REASON = "short_entry_below_min_qty"
_SAME_DIRECTION_REENTRY_REASON = "same_direction_reentry"
_EXIT_ONLY_SELL_FLAT_REASON = "exit_only_sell_without_long_position"
_EXIT_ONLY_BUY_FLAT_REASON = "exit_only_buy_without_short_position"
_RUNTIME_TRADE_POLICY_SHARED_OWNER = "__shared__"
_SELL_EXIT_ONLY_STRATEGY_TYPES = {
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
_BUY_EXIT_ONLY_STRATEGY_TYPES = {
    "mean_reversion_exhaustion_short_v1",
    "microbar_cross_sectional_short_v1",
}
_LEGACY_BUY_EXIT_ONLY_UNIVERSE_TYPES = {
    "microbar_cross_sectional_pairs_v1",
}


@dataclass(frozen=True)
class DecisionRuntimeTelemetry:
    mode: str
    runtime_enabled: bool
    fallback_to_legacy: bool
    errors: tuple[RuntimeErrorRecord, ...] = field(default_factory=tuple)
    observation: RuntimeObservation | None = None
    traces: tuple[StrategyTrace, ...] = field(default_factory=tuple)


@dataclass
class _RuntimeTradePolicySessionState:
    session_day: date
    entry_count: int = 0
    stop_loss_exit_count: int = 0
    negative_exit_count: int = 0
    cumulative_negative_exit_bps: Decimal = field(default_factory=lambda: Decimal("0"))
    last_stop_loss_exit_at: datetime | None = None
    last_negative_exit_at: datetime | None = None


class DecisionEngine:
    """Evaluate TA signals against configured strategies."""

    def __init__(
        self,
        price_fetcher: Optional[PriceFetcher] = None,
        *,
        runtime_trace_enabled: bool = False,
    ) -> None:
        self.price_fetcher = price_fetcher
        self.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                circuit_error_threshold=settings.trading_strategy_runtime_circuit_errors,
                cooldown_seconds=settings.trading_strategy_runtime_circuit_cooldown_seconds,
            ),
            trace_enabled=runtime_trace_enabled,
        )
        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode="legacy",
            runtime_enabled=False,
            fallback_to_legacy=False,
        )
        self._last_emitted_action_at: dict[tuple[str, str, str | None], datetime] = {}
        self._position_peak_price_by_scope: dict[tuple[str, str | None], Decimal] = {}
        self._runtime_trade_policy_state: dict[
            tuple[str, str], _RuntimeTradePolicySessionState
        ] = {}
        self._session_context_tracker = SessionContextTracker(
            quote_quality_policy=QuoteQualityPolicy(
                max_executable_spread_bps=settings.trading_signal_max_executable_spread_bps,
                max_quote_mid_jump_bps=settings.trading_signal_max_quote_mid_jump_bps,
                max_jump_with_wide_spread_bps=settings.trading_signal_max_jump_with_wide_spread_bps,
            )
        )
        self.forecast_router = (
            build_default_forecast_router(
                policy_path=settings.trading_forecast_router_policy_path,
                refinement_enabled=settings.trading_forecast_router_refinement_enabled,
            )
            if settings.trading_forecast_router_enabled
            else None
        )
        self._last_forecast_telemetry: list[ForecastRoutingTelemetry] = []

    def evaluate(
        self,
        signal: SignalEnvelope,
        strategies: Iterable[Strategy],
        *,
        equity: Optional[Decimal] = None,
        positions: Optional[list[dict[str, Any]]] = None,
    ) -> list[StrategyDecision]:
        filtered = [strategy for strategy in strategies if strategy.enabled]
        timeframe = _resolve_signal_timeframe(signal)
        if timeframe is None:
            self._last_runtime_telemetry = DecisionRuntimeTelemetry(
                mode="legacy",
                runtime_enabled=False,
                fallback_to_legacy=False,
            )
            return []
        if signal.timeframe != timeframe:
            signal = signal.model_copy(update={"timeframe": timeframe})

        runtime_enabled = _runtime_enabled()
        if runtime_enabled:
            decisions = self._evaluate_with_runtime(
                signal,
                filtered,
                equity=equity,
                positions=positions,
            )
            return decisions

        return self._evaluate_legacy(
            signal,
            filtered,
            equity=equity,
            positions=positions,
        )

    def consume_runtime_telemetry(self) -> DecisionRuntimeTelemetry:
        telemetry = self._last_runtime_telemetry
        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode="legacy",
            runtime_enabled=False,
            fallback_to_legacy=False,
        )
        return telemetry

    def consume_forecast_telemetry(self) -> list[ForecastRoutingTelemetry]:
        telemetry = list(self._last_forecast_telemetry)
        self._last_forecast_telemetry = []
        return telemetry

    def observe_signal(self, signal: SignalEnvelope) -> None:
        self._session_context_tracker.enrich_signal_payload(signal)

    def _evaluate_with_runtime(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Optional[Decimal],
        positions: Optional[list[dict[str, Any]]],
    ) -> list[StrategyDecision]:
        timeframe = signal.timeframe
        if timeframe is None:
            return []
        actual_positions = _actual_positions_only(positions)
        features = extract_signal_features(signal)

        price = features.price
        snapshot: Optional[MarketSnapshot] = None
        if price is None and self.price_fetcher is not None:
            snapshot = self.price_fetcher.fetch_market_snapshot(signal)
            if snapshot is not None:
                price = snapshot.price
        normalized_payload = self._session_context_tracker.enrich_signal_payload(signal)
        if price is not None and "price" not in normalized_payload:
            normalized_payload["price"] = price
        normalized_signal = signal.model_copy(update={"payload": normalized_payload})
        try:
            feature_vector = normalize_feature_vector_v3(normalized_signal)
        except FeatureNormalizationError:
            logger.debug("Feature normalization failed symbol=%s", signal.symbol)
            self._last_runtime_telemetry = DecisionRuntimeTelemetry(
                mode=settings.trading_strategy_runtime_mode,
                runtime_enabled=True,
                fallback_to_legacy=False,
            )
            return []

        runtime_eval = self.strategy_runtime.evaluate_all(
            strategies, feature_vector, timeframe=timeframe
        )
        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode=settings.trading_strategy_runtime_mode,
            runtime_enabled=True,
            fallback_to_legacy=False,
            errors=tuple(runtime_eval.errors),
            observation=runtime_eval.observation,
            traces=tuple(runtime_eval.traces),
        )

        decisions: list[StrategyDecision] = []
        self._last_forecast_telemetry = []

        strategies_by_id = {str(strategy.id): strategy for strategy in strategies}
        raw_runtime_by_strategy_id = {
            item.intent.strategy_id: item.metadata() for item in runtime_eval.raw_intents
        }
        isolated_strategy_ids = {
            str(strategy.id)
            for strategy in strategies
            if _strategy_uses_position_isolation(strategy)
        }
        non_isolated_strategy_ids = {
            str(strategy.id) for strategy in strategies if str(strategy.id) not in isolated_strategy_ids
        }
        aggregated_intents, _ = self.strategy_runtime.aggregator.aggregate(
            [
                item.intent
                for item in runtime_eval.raw_intents
                if item.intent.strategy_id not in isolated_strategy_ids
            ]
        )

        def _append_runtime_intent_decision(
            *,
            primary_strategy_id: str,
            source_strategy_ids: list[str],
            symbol: str,
            direction: str,
            explain: tuple[str, ...],
            feature_snapshot_hashes: list[str],
            positions_scope: Optional[list[dict[str, Any]]],
            aggregated: bool,
            runtime_target_notional: Decimal | None = None,
            position_isolation_mode: str | None = None,
        ) -> None:
            source_strategies = [
                strategies_by_id[strategy_id]
                for strategy_id in source_strategy_ids
                if strategy_id in strategies_by_id
            ]
            if not source_strategies:
                return
            source_runtime_metadata = [
                dict(raw_runtime_by_strategy_id[strategy_id])
                for strategy_id in source_strategy_ids
                if strategy_id in raw_runtime_by_strategy_id
            ]
            primary_runtime_metadata = (
                dict(raw_runtime_by_strategy_id[primary_strategy_id])
                if primary_strategy_id in raw_runtime_by_strategy_id
                else {}
            )
            qty, sizing_meta = _resolve_qty_for_aggregated(
                source_strategies,
                symbol=symbol,
                action=direction,
                price=price,
                equity=equity,
                positions=positions_scope,
                capacity_positions=positions,
                runtime_target_notional=runtime_target_notional,
            )
            if _skip_non_executable_decision_qty(qty=qty, sizing_meta=sizing_meta):
                logger.debug(
                    "Skipping non-executable runtime decision symbol=%s action=%s reason=%s",
                    symbol,
                    direction,
                    sizing_meta.get("reason"),
                )
                return
            forecast_contract: dict[str, Any] | None = None
            forecast_audit: dict[str, Any] | None = None
            if self.forecast_router is not None:
                forecast_result = self.forecast_router.route_and_forecast(
                    feature_vector=feature_vector,
                    horizon=timeframe,
                    event_ts=signal.event_ts,
                )
                forecast_contract = forecast_result.contract.to_payload()
                forecast_audit = forecast_result.audit.to_payload()
                self._last_forecast_telemetry.append(forecast_result.telemetry)
            trade_policy = _resolve_runtime_trade_policy(source_strategies)
            position_state_scope_key = _position_state_scope_key(
                position_isolation_mode=position_isolation_mode,
                strategy_id=primary_strategy_id,
            )
            if not _passes_runtime_trade_policy(
                strategies=source_strategies,
                last_emitted_action_at=self._last_emitted_action_at,
                runtime_trade_policy_state=self._runtime_trade_policy_state,
                signal_ts=signal.event_ts,
                symbol=symbol,
                action=direction,
                position_owner=_runtime_trade_policy_owner(
                    primary_strategy_id=primary_strategy_id,
                    position_isolation_mode=position_isolation_mode,
                ),
                positions=positions_scope,
                policy=trade_policy,
                state_scope_key=position_state_scope_key,
            ):
                return
            if not _passes_signal_exit_policy(
                strategies=source_strategies,
                symbol=symbol,
                action=direction,
                price=price,
                signal=signal,
                positions=positions_scope,
            ):
                return
            decision = StrategyDecision(
                    strategy_id=primary_strategy_id,
                    symbol=symbol,
                    event_ts=signal.event_ts,
                    timeframe=timeframe,
                    action=cast(Literal["buy", "sell"], direction),
                    qty=qty,
                    order_type="market",
                    time_in_force=cast(
                        Literal["day", "gtc", "ioc", "fok"],
                        _resolve_strategy_time_in_force(
                            strategies=source_strategies,
                            action=direction,
                        ),
                    ),
                    rationale=",".join(explain),
                    params=_build_params(
                        signal=normalized_signal,
                        macd=features.macd,
                        macd_signal=features.macd_signal,
                        rsi=features.rsi,
                        price=price,
                        volatility=features.volatility,
                        snapshot=snapshot,
                        runtime_metadata={
                            "mode": settings.trading_strategy_runtime_mode,
                            "aggregated": aggregated,
                            "position_isolation_mode": position_isolation_mode,
                            "primary_strategy_row_id": primary_strategy_id,
                            "primary_declared_strategy_id": primary_runtime_metadata.get(
                                "declared_strategy_id"
                            ),
                            "source_strategy_ids": source_strategy_ids,
                            "source_declared_strategy_ids": [
                                str(item.get("declared_strategy_id"))
                                for item in source_runtime_metadata
                                if str(item.get("declared_strategy_id") or "").strip()
                            ],
                            "compiler_sources": sorted(
                                {
                                    str(item.get("compiler_source") or "").strip()
                                    for item in source_runtime_metadata
                                    if str(item.get("compiler_source") or "").strip()
                                }
                            ),
                            "aggregated_target_notional": (
                                str(runtime_target_notional)
                                if runtime_target_notional is not None
                                else None
                            ),
                            "source_strategy_runtime": source_runtime_metadata,
                            "feature_snapshot_hashes": feature_snapshot_hashes,
                            "intent_conflicts_total": runtime_eval.observation.intent_conflicts_total,
                            "strategy_errors": [
                                {
                                    "strategy_id": error.strategy_id,
                                    "strategy_type": error.strategy_type,
                                    "plugin_id": error.plugin_id,
                                    "reason": error.reason,
                                }
                                for error in runtime_eval.errors
                            ],
                            "forecast_route_key": (
                                str(forecast_contract.get("route_key"))
                                if isinstance(forecast_contract, dict)
                                else None
                            ),
                        },
                        forecast_contract=forecast_contract,
                        forecast_audit=forecast_audit,
                    )
                    | {"sizing": sizing_meta},
                )
            decisions.append(decision)
            self._last_emitted_action_at[
                _runtime_trade_policy_key(
                    symbol=symbol,
                    action=direction,
                    state_scope_key=position_state_scope_key,
                )
            ] = signal.event_ts
            _record_runtime_trade_policy_decision(
                strategies=source_strategies,
                runtime_trade_policy_state=self._runtime_trade_policy_state,
                signal_ts=signal.event_ts,
                symbol=symbol,
                position_owner=_runtime_trade_policy_owner(
                    primary_strategy_id=primary_strategy_id,
                    position_isolation_mode=position_isolation_mode,
                ),
                action=direction,
                policy=trade_policy,
                positions=positions_scope,
                signal=signal,
                price=price,
                decision=decision,
            )

        for raw_decision in runtime_eval.raw_intents:
            primary_strategy_id = raw_decision.intent.strategy_id
            if primary_strategy_id not in isolated_strategy_ids:
                continue
            strategy = strategies_by_id.get(primary_strategy_id)
            if strategy is None:
                continue
            _append_runtime_intent_decision(
                primary_strategy_id=primary_strategy_id,
                source_strategy_ids=[primary_strategy_id],
                symbol=raw_decision.intent.symbol,
                direction=raw_decision.intent.direction,
                explain=raw_decision.intent.explain,
                feature_snapshot_hashes=[raw_decision.feature_hash],
                positions_scope=_positions_for_strategy_action(
                    positions,
                    strategy_id=primary_strategy_id,
                    action=raw_decision.intent.direction,
                ),
                aggregated=False,
                runtime_target_notional=raw_decision.intent.target_notional,
                position_isolation_mode="per_strategy",
            )

        for intent in aggregated_intents:
            source_strategy_ids = list(intent.source_strategy_ids)
            primary_strategy_id = source_strategy_ids[0] if source_strategy_ids else None
            if primary_strategy_id is None:
                logger.warning(
                    "Skipping aggregated intent without source strategy symbol=%s horizon=%s",
                    intent.symbol,
                    intent.horizon,
                )
                continue
            _append_runtime_intent_decision(
                primary_strategy_id=primary_strategy_id,
                source_strategy_ids=source_strategy_ids,
                symbol=intent.symbol,
                direction=intent.direction,
                explain=intent.explain,
                feature_snapshot_hashes=list(intent.feature_snapshot_hashes),
                positions_scope=(
                    actual_positions
                    if intent.direction == "sell"
                    else positions
                ),
                aggregated=True,
                runtime_target_notional=intent.target_notional,
            )
        for isolated_strategy_id in sorted(isolated_strategy_ids):
            strategy = strategies_by_id.get(isolated_strategy_id)
            if strategy is None:
                continue
            isolated_positions = _positions_for_strategy_action(
                actual_positions,
                strategy_id=isolated_strategy_id,
                action="sell",
            )
            isolated_position_peak_price = self._sync_position_peak_price(
                symbol=signal.symbol,
                positions=isolated_positions,
                price=price,
                state_scope_key=_position_state_scope_key(
                    position_isolation_mode="per_strategy",
                    strategy_id=isolated_strategy_id,
                ),
            )
            overlay_decision = _build_runtime_position_exit_overlay(
                signal=signal,
                strategies=[strategy],
                timeframe=timeframe,
                decisions=[
                    decision
                    for decision in decisions
                    if decision.symbol == signal.symbol and decision.strategy_id == isolated_strategy_id
                ],
                positions=isolated_positions,
                equity=equity,
                price=price,
                features=features,
                snapshot=snapshot,
                raw_runtime_by_strategy_id=raw_runtime_by_strategy_id,
                runtime_eval=runtime_eval,
                position_peak_price=isolated_position_peak_price,
                aggregated=False,
                position_isolation_mode="per_strategy",
            )
            if overlay_decision is not None:
                overlay_policy = _resolve_runtime_trade_policy([strategy])
                overlay_positions = _positions_for_strategy_action(
                    actual_positions,
                    strategy_id=isolated_strategy_id,
                    action="sell",
                )
                overlay_position_owner = _runtime_trade_policy_owner(
                    primary_strategy_id=isolated_strategy_id,
                    position_isolation_mode="per_strategy",
                )
                if not _passes_runtime_trade_policy(
                    strategies=[strategy],
                    last_emitted_action_at=self._last_emitted_action_at,
                    runtime_trade_policy_state=self._runtime_trade_policy_state,
                    signal_ts=signal.event_ts,
                    symbol=signal.symbol,
                    action=overlay_decision.action,
                    position_owner=overlay_position_owner,
                    positions=overlay_positions,
                    policy=overlay_policy,
                    position_exit_type=_decision_position_exit_type(overlay_decision),
                    state_scope_key=isolated_strategy_id,
                ):
                    continue
                decisions.append(overlay_decision)
                _record_runtime_trade_policy_decision(
                    strategies=[strategy],
                    runtime_trade_policy_state=self._runtime_trade_policy_state,
                    signal_ts=signal.event_ts,
                    symbol=signal.symbol,
                    position_owner=overlay_position_owner,
                    action=overlay_decision.action,
                    policy=overlay_policy,
                    positions=overlay_positions,
                    signal=signal,
                    price=price,
                    decision=overlay_decision,
                )
        aggregated_position_peak_price = (
            self._sync_position_peak_price(
                symbol=signal.symbol,
                positions=actual_positions,
                price=price,
            )
            if non_isolated_strategy_ids
            else None
        )
        aggregated_position_peak_price = (
            self._sync_position_peak_price(
                symbol=signal.symbol,
                positions=actual_positions,
                price=price,
            )
            if non_isolated_strategy_ids
            else None
        )
        overlay_decision = _build_runtime_position_exit_overlay(
            signal=signal,
            strategies=[
                strategy
                for strategy in strategies
                if str(strategy.id) in non_isolated_strategy_ids
            ],
            timeframe=timeframe,
            decisions=[
                decision
                for decision in decisions
                if decision.symbol == signal.symbol and decision.strategy_id in non_isolated_strategy_ids
            ],
            positions=actual_positions,
            equity=equity,
            price=price,
            features=features,
            snapshot=snapshot,
            raw_runtime_by_strategy_id=raw_runtime_by_strategy_id,
            runtime_eval=runtime_eval,
            position_peak_price=aggregated_position_peak_price,
        )
        if overlay_decision is not None:
            overlay_policy = _resolve_runtime_trade_policy(
                [
                    strategy
                    for strategy in strategies
                    if str(strategy.id) in non_isolated_strategy_ids
                ]
            )
            if not _passes_runtime_trade_policy(
                strategies=[
                    strategy
                    for strategy in strategies
                    if str(strategy.id) in non_isolated_strategy_ids
                ],
                last_emitted_action_at=self._last_emitted_action_at,
                runtime_trade_policy_state=self._runtime_trade_policy_state,
                signal_ts=signal.event_ts,
                symbol=signal.symbol,
                action=overlay_decision.action,
                position_owner=_RUNTIME_TRADE_POLICY_SHARED_OWNER,
                positions=actual_positions,
                policy=overlay_policy,
                position_exit_type=_decision_position_exit_type(overlay_decision),
            ):
                return decisions
            decisions.append(overlay_decision)
            _record_runtime_trade_policy_decision(
                strategies=[
                    strategy
                    for strategy in strategies
                    if str(strategy.id) in non_isolated_strategy_ids
                ],
                runtime_trade_policy_state=self._runtime_trade_policy_state,
                signal_ts=signal.event_ts,
                symbol=signal.symbol,
                position_owner=_RUNTIME_TRADE_POLICY_SHARED_OWNER,
                action=overlay_decision.action,
                policy=overlay_policy,
                positions=actual_positions,
                signal=signal,
                price=price,
                decision=overlay_decision,
            )
        return decisions

    def _sync_position_peak_price(
        self,
        *,
        symbol: str,
        positions: Optional[list[dict[str, Any]]],
        price: Optional[Decimal],
        state_scope_key: str | None = None,
    ) -> Decimal | None:
        active_symbols = {
            str(position.get("symbol") or "").strip().upper()
            for position in (positions or [])
            if (_position_qty_from_payload(position) or Decimal("0")) > 0
        }
        for tracked_symbol, tracked_scope_key in list(self._position_peak_price_by_scope):
            if tracked_scope_key != state_scope_key:
                continue
            if tracked_symbol not in active_symbols:
                self._position_peak_price_by_scope.pop((tracked_symbol, tracked_scope_key), None)

        normalized_symbol = symbol.strip().upper()
        peak_price_key = (normalized_symbol, state_scope_key)
        position_qty = _position_qty_for_symbol(positions, normalized_symbol)
        if position_qty is None or position_qty <= 0:
            self._position_peak_price_by_scope.pop(peak_price_key, None)
            return None

        avg_entry_price = _position_avg_entry_price_for_symbol(positions, normalized_symbol)
        candidates = [
            candidate
            for candidate in (
                self._position_peak_price_by_scope.get(peak_price_key),
                avg_entry_price,
                price,
            )
            if candidate is not None and candidate > 0
        ]
        if not candidates:
            return None
        peak_price = max(candidates)
        self._position_peak_price_by_scope[peak_price_key] = peak_price
        return peak_price

    def _evaluate_legacy(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Optional[Decimal],
        positions: Optional[list[dict[str, Any]]],
    ) -> list[StrategyDecision]:
        decisions: list[StrategyDecision] = []
        self._last_forecast_telemetry = []
        timeframe = signal.timeframe
        if timeframe is None:
            return decisions

        for strategy in strategies:
            if timeframe != strategy.base_timeframe:
                logger.debug(
                    "Skipping strategy %s due to timeframe mismatch signal=%s strategy=%s",
                    strategy.id,
                    timeframe,
                    strategy.base_timeframe,
                )
                continue
            decision = self._evaluate_legacy_strategy(
                signal,
                strategy,
                equity=equity,
                positions=positions,
            )
            if decision is not None:
                decisions.append(decision)

        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode="legacy",
            runtime_enabled=False,
            fallback_to_legacy=False,
        )
        return decisions

    def _evaluate_legacy_strategy(
        self,
        signal: SignalEnvelope,
        strategy: Strategy,
        *,
        equity: Optional[Decimal],
        positions: Optional[list[dict[str, Any]]],
    ) -> Optional[StrategyDecision]:
        timeframe = signal.timeframe
        if timeframe is None:
            return None
        features = extract_signal_features(signal)

        if not _has_legacy_indicator_inputs(features):
            logger.debug("Signal missing indicators for strategy %s", strategy.id)
            return None

        action_bundle = _resolve_legacy_action(features)
        if action_bundle is None:
            return None
        action, rationale_parts = action_bundle

        price, snapshot = self._resolve_price_and_snapshot(signal, features)
        forecast_contract, forecast_audit = self._resolve_forecast_payload(
            signal,
            timeframe=timeframe,
            price=price,
        )
        runtime_definition = StrategyRuntime.definition_from_strategy(strategy)

        qty, sizing_meta = _resolve_qty(
            strategy,
            symbol=signal.symbol,
            action=action,
            price=price,
            equity=equity,
            positions=positions,
        )
        if _skip_non_executable_decision_qty(qty=qty, sizing_meta=sizing_meta):
            logger.debug(
                "Skipping non-executable legacy decision strategy_id=%s symbol=%s action=%s reason=%s",
                strategy.id,
                signal.symbol,
                action,
                sizing_meta.get("reason"),
            )
            return None

        return StrategyDecision(
            strategy_id=str(strategy.id),
            symbol=signal.symbol,
            event_ts=signal.event_ts,
            timeframe=timeframe,
            action=action,
            qty=qty,
            order_type="market",
            time_in_force="day",
            rationale=",".join(rationale_parts),
            params=_build_params(
                signal=signal,
                macd=features.macd,
                macd_signal=features.macd_signal,
                rsi=features.rsi,
                price=price,
                volatility=features.volatility,
                snapshot=snapshot,
                runtime_metadata={
                    "strategy_row_id": str(strategy.id),
                    "declared_strategy_id": runtime_definition.declared_strategy_id,
                    "strategy_type": runtime_definition.strategy_type,
                    "strategy_version": runtime_definition.version,
                    "plugin_id": "legacy_builtin",
                    "plugin_version": "1.0.0",
                    "parameter_hash": "legacy",
                    "required_features": ["macd", "macd_signal", "rsi14", "price"],
                    "compiler_source": runtime_definition.compiler_source,
                    "strategy_spec_v2": runtime_definition.strategy_spec,
                    "compiled_targets": runtime_definition.compiled_targets,
                },
                forecast_contract=forecast_contract,
                forecast_audit=forecast_audit,
            )
            | {"sizing": sizing_meta},
        )

    def _resolve_price_and_snapshot(
        self,
        signal: SignalEnvelope,
        features: SignalFeatures,
    ) -> tuple[Optional[Decimal], Optional[MarketSnapshot]]:
        price = features.price
        snapshot: Optional[MarketSnapshot] = None
        if price is None and self.price_fetcher is not None:
            snapshot = self.price_fetcher.fetch_market_snapshot(signal)
            if snapshot is not None:
                price = snapshot.price
        return price, snapshot

    def _resolve_forecast_payload(
        self,
        signal: SignalEnvelope,
        *,
        timeframe: str,
        price: Optional[Decimal],
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        if self.forecast_router is None:
            return None, None
        normalized_payload = dict(signal.payload)
        if price is not None and "price" not in normalized_payload:
            normalized_payload["price"] = price
        normalized_signal = signal.model_copy(update={"payload": normalized_payload})
        try:
            feature_vector = normalize_feature_vector_v3(normalized_signal)
        except FeatureNormalizationError:
            return None, None
        forecast_result = self.forecast_router.route_and_forecast(
            feature_vector=feature_vector,
            horizon=timeframe,
            event_ts=signal.event_ts,
        )
        self._last_forecast_telemetry.append(forecast_result.telemetry)
        return forecast_result.contract.to_payload(), forecast_result.audit.to_payload()


def _build_params(
    signal: SignalEnvelope,
    macd: Decimal | None,
    macd_signal: Decimal | None,
    rsi: Decimal | None,
    price: Optional[Decimal],
    volatility: Optional[Decimal],
    snapshot: Optional[MarketSnapshot],
    runtime_metadata: dict[str, Any],
    forecast_contract: dict[str, Any] | None = None,
    forecast_audit: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source_context = signal.payload.get("simulation_context")
    source_context_payload: dict[str, Any] | None = None
    if isinstance(source_context, Mapping):
        source_context_payload = {
            str(key): value
            for key, value in cast(Mapping[object, Any], source_context).items()
        }
    simulation_context = resolve_simulation_context(
        signal=signal,
        source=source_context_payload,
    )
    params: dict[str, Any] = {
        "macd": macd,
        "macd_signal": macd_signal,
        "rsi": rsi,
        "price": price,
        "signal_seq": int(signal.seq or 0),
        "strategy_runtime": runtime_metadata,
    }
    if volatility is not None:
        params["volatility"] = volatility
    if snapshot is not None:
        params["price_snapshot"] = _snapshot_payload(snapshot)
        if snapshot.spread is not None:
            params.setdefault("spread", snapshot.spread)
    if forecast_contract is not None:
        params["forecast"] = forecast_contract
    if forecast_audit is not None:
        params["forecast_audit"] = forecast_audit
    regime_context_payload, regime_route_label = _resolve_regime_context(
        signal, macd=macd, macd_signal=macd_signal
    )
    if regime_context_payload:
        params["regime_hmm"] = regime_context_payload
    if regime_route_label is not None:
        params["regime_label"] = regime_route_label
        params["route_regime_label"] = regime_route_label
    microstructure_state = _resolve_microstructure_state_payload(signal)
    if microstructure_state is not None:
        params["microstructure_state"] = microstructure_state
    execution_advice = _resolve_execution_advice_payload(signal)
    if execution_advice is not None:
        params["execution_advice"] = execution_advice
    execution_features = _resolve_execution_feature_payload(signal)
    if execution_features is not None:
        params["execution_features"] = execution_features
    fragility_snapshot = _resolve_fragility_snapshot_payload(signal)
    if fragility_snapshot is not None:
        params["fragility_snapshot"] = fragility_snapshot
    if simulation_context is not None:
        params["simulation_context"] = simulation_context
    return params


def _has_explicit_regime_context(payload: Mapping[str, Any]) -> bool:
    def _is_explicit_value(value: Any) -> bool:
        if value is None:
            return False
        if isinstance(value, Mapping):
            typed_mapping = cast(Mapping[Any, Any], value)
            return any(_is_explicit_value(v) for v in typed_mapping.values())
        if isinstance(value, str):
            return bool(value.strip())
        return True

    for key in (
        "regime_hmm",
        "hmm_regime_context",
        "hmm_context",
        "regime_context",
        "hmm_state_posterior",
        "hmm_entropy",
        "hmm_entropy_band",
        "hmm_regime_id",
        "hmm_predicted_next",
        "hmm_transition_shock",
        "hmm_duration_ms",
        "hmm_artifact",
        "hmm_guardrail",
        "regime_id",
        "posterior",
        "entropy",
        "entropy_band",
        "predicted_next",
        "transition_shock",
        "duration_ms",
        "artifact",
        "guardrail",
    ):
        if _is_explicit_value(payload.get(key)):
            return True
    return False


def _resolve_regime_context(
    signal: SignalEnvelope,
    macd: Decimal | None,
    macd_signal: Decimal | None,
) -> tuple[dict[str, Any], str | None]:
    payload = signal.payload
    regime_context = resolve_hmm_context(payload)
    if not _has_explicit_regime_context(payload):
        regime_payload = regime_context.to_payload()
        if regime_payload.get("regime_id") == HMM_UNKNOWN_REGIME_ID:
            normalized_route_label = resolve_regime_route_label(
                payload,
                macd=macd,
                macd_signal=macd_signal,
            )
            return {}, normalized_route_label

    route_regime_label = resolve_regime_route_label(
        cast(Mapping[str, Any], payload),
        macd=macd,
        macd_signal=macd_signal,
    )
    normalized_route_label = str(route_regime_label).strip().lower()
    return regime_context.to_payload(), normalized_route_label


def _resolve_microstructure_state_payload(
    signal: SignalEnvelope,
) -> dict[str, Any] | None:
    payload = signal.payload
    raw_source = "microstructure_state"
    raw_state = payload.get("microstructure_state")
    state: dict[str, Any]
    if isinstance(raw_state, dict):
        state = dict(cast(dict[str, Any], raw_state))
    else:
        raw_signal = payload.get("microstructure_signal")
        if not isinstance(raw_signal, dict):
            return None
        state = dict(cast(dict[str, Any], raw_signal))
        raw_source = "microstructure_signal"
    if "schema_version" not in state and raw_source == "microstructure_state":
        state["schema_version"] = "microstructure_state_v1"
    state["symbol"] = str(state.get("symbol") or signal.symbol).strip().upper()
    if not state["symbol"]:
        state["symbol"] = signal.symbol.strip().upper()
    event_ts = state.get("event_ts")
    if event_ts is None:
        state["event_ts"] = signal.event_ts.isoformat()

    parsed = parse_microstructure_state(state, expected_symbol=signal.symbol)
    if parsed is None:
        return None

    return state


def _resolve_execution_advice_payload(signal: SignalEnvelope) -> dict[str, Any] | None:
    payload = signal.payload
    raw_advice = payload.get("execution_advice")
    advice: dict[str, Any]
    if isinstance(raw_advice, dict):
        advice = dict(cast(dict[str, Any], raw_advice))
    else:
        advice = {}
        direct_urgency = payload.get("urgency_tier")
        execution_block = payload.get("execution")
        execution_payload: dict[str, Any] | None = None
        if isinstance(execution_block, dict):
            execution_payload = dict(cast(dict[str, Any], execution_block))
        if execution_payload is not None and direct_urgency is None:
            direct_urgency = execution_payload.get("urgency_tier")
        advice["urgency_tier"] = direct_urgency
        for key in (
            "max_participation_rate",
            "preferred_order_type",
            "quote_offset_bps",
            "adverse_selection_risk",
            "simulator_version",
            "expected_shortfall_bps_p50",
            "expected_shortfall_bps_p95",
            "latency_ms",
        ):
            value = payload.get(key)
            if value is None and execution_payload is not None:
                value = execution_payload.get(key)
            if value is not None:
                advice[key] = value
        advice["event_ts"] = signal.event_ts.isoformat()

    urgency_tier = str(advice.get("urgency_tier") or "").strip().lower()
    if urgency_tier not in {"low", "normal", "high"}:
        return None
    advice["urgency_tier"] = urgency_tier
    if advice.get("event_ts") is None:
        advice["event_ts"] = signal.event_ts.isoformat()
    return advice


def _resolve_execution_feature_payload(
    signal: SignalEnvelope,
) -> dict[str, Any] | None:
    payload = signal.payload
    feature_keys = (
        "recent_imbalance_pressure_avg",
        "recent_microprice_bias_bps_avg",
        "recent_15m_return_bps",
        "microbar_volume",
        "cross_section_continuation_rank",
        "cross_section_reversal_rank",
        "cross_section_recent_15m_return_rank",
        "cross_section_microbar_volume_rank",
        "cross_section_recent_imbalance_rank",
        "cross_section_opening_window_return_rank",
        "cross_section_session_open_rank",
        "spread_bps",
    )
    execution_features = {
        key: payload.get(key)
        for key in feature_keys
        if payload.get(key) is not None
    }
    if not execution_features:
        return None
    return execution_features


def _resolve_fragility_snapshot_payload(
    signal: SignalEnvelope,
) -> dict[str, Any] | None:
    payload = signal.payload
    raw_snapshot = payload.get("fragility_snapshot")
    if isinstance(raw_snapshot, dict):
        snapshot = dict(cast(dict[str, Any], raw_snapshot))
    else:
        snapshot = {}

    keys = (
        "spread_acceleration",
        "liquidity_compression",
        "crowding_proxy",
        "correlation_concentration",
        "fragility_score",
        "fragility_state",
    )
    for key in keys:
        if snapshot.get(key) is None and payload.get(key) is not None:
            snapshot[key] = payload.get(key)

    has_fragility_inputs = any(snapshot.get(key) is not None for key in keys)
    if not has_fragility_inputs:
        return None

    snapshot["schema_version"] = "fragility_snapshot_v1"
    snapshot["symbol"] = str(snapshot.get("symbol") or signal.symbol).strip().upper()
    if snapshot.get("event_ts") is None:
        snapshot["event_ts"] = signal.event_ts.isoformat()
    return snapshot


def _snapshot_payload(snapshot: MarketSnapshot) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of.isoformat(),
        "price": str(snapshot.price) if snapshot.price is not None else None,
        "spread": str(snapshot.spread) if snapshot.spread is not None else None,
        "source": snapshot.source,
    }


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

    # Prefer strategy-level sizing. Treat global max_position_pct_equity as a risk cap, not a sizing target.
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

    if notional_budget is None or notional_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}

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
    if exit_only_sell and position_qty is not None and position_qty <= 0:
        return Decimal("0"), {
            "method": method,
            "reason": _EXIT_ONLY_SELL_FLAT_REASON,
            "notional_budget": str(notional_budget),
            "price": str(price),
            "position_qty": str(position_qty),
        }
    if exit_only_buy and position_qty is not None and position_qty >= 0:
        return Decimal("0"), {
            "method": method,
            "reason": _EXIT_ONLY_BUY_FLAT_REASON,
            "notional_budget": str(notional_budget),
            "price": str(price),
            "position_qty": str(position_qty),
        }
    if _blocks_same_direction_reentry(strategy) and _same_direction_reentry_exists(
        action=normalized_action,
        position_qty=position_qty,
    ):
        return Decimal("0"), {
            "method": method,
            "reason": _SAME_DIRECTION_REENTRY_REASON,
            "notional_budget": str(notional_budget),
            "price": str(price),
            "position_qty": (
                str(position_qty) if position_qty is not None else None
            ),
        }

    requested_qty = notional_budget / price
    if exit_only_sell and position_qty is not None and position_qty > 0:
        requested_qty = position_qty
    if exit_only_buy and position_qty is not None and position_qty < 0:
        requested_qty = abs(position_qty)
    capped_requested_qty = _cap_requested_qty_by_symbol_cap(
        action=normalized_action,
        requested_qty=requested_qty,
        price=price,
        position_qty=position_qty,
        symbol_notional_cap=symbol_notional_cap,
    )
    cap_applied = capped_requested_qty is not None and capped_requested_qty < requested_qty
    if capped_requested_qty is not None:
        requested_qty = capped_requested_qty
    capped_by_portfolio_qty = _cap_requested_qty_by_portfolio_gross_cap(
        action=normalized_action,
        requested_qty=requested_qty,
        price=price,
        positions=positions,
        portfolio_gross_cap=portfolio_gross_cap,
    )
    portfolio_cap_applied = (
        capped_by_portfolio_qty is not None and capped_by_portfolio_qty < requested_qty
    )
    if capped_by_portfolio_qty is not None:
        requested_qty = capped_by_portfolio_qty
    if requested_qty <= 0:
        capacity_reason = (
            "portfolio_gross_capacity_exhausted"
            if portfolio_cap_applied or (
                normalized_action == "buy"
                and portfolio_gross_cap is not None
                and portfolio_gross_cap > 0
                and current_gross >= portfolio_gross_cap
            )
            else "symbol_capacity_exhausted"
        )
        return Decimal("0"), {
            "method": method,
            "reason": capacity_reason,
            "notional_budget": str(notional_budget),
            "price": str(price),
            "requested_qty": str(notional_budget / price),
            "current_value": str(current_value) if current_value is not None else None,
            "current_gross": str(current_gross),
            "position_qty": (
                str(position_qty) if position_qty is not None else None
            ),
            "symbol_notional_cap": (
                str(symbol_notional_cap)
                if symbol_notional_cap is not None
                else None
            ),
            "portfolio_gross_cap": (
                str(portfolio_gross_cap) if portfolio_gross_cap is not None else None
            ),
        }
    resolution = resolve_quantity_resolution(
        action=action,
        symbol=symbol,
        global_enabled=settings.trading_fractional_equities_enabled,
        allow_shorts=settings.trading_allow_shorts,
        position_qty=position_qty,
        requested_qty=requested_qty,
    )
    qty = quantize_qty_for_symbol(
        symbol,
        requested_qty,
        fractional_equities_enabled=resolution.fractional_allowed,
    )
    min_qty = min_qty_for_symbol(
        symbol, fractional_equities_enabled=resolution.fractional_allowed
    )
    if qty < min_qty:
        if cap_applied or portfolio_cap_applied:
            capacity_reason = (
                "portfolio_gross_capacity_exhausted"
                if portfolio_cap_applied and not cap_applied
                else "symbol_capacity_exhausted"
            )
            return Decimal("0"), {
                "method": method,
                "reason": capacity_reason,
                "notional_budget": str(notional_budget),
                "price": str(price),
                "requested_qty": str(requested_qty),
                "min_qty": str(min_qty),
                "current_value": (
                    str(current_value) if current_value is not None else None
                ),
                "current_gross": str(current_gross),
                "position_qty": (
                    str(position_qty) if position_qty is not None else None
                ),
                "symbol_notional_cap": (
                    str(symbol_notional_cap)
                    if symbol_notional_cap is not None
                    else None
                ),
                "portfolio_gross_cap": (
                    str(portfolio_gross_cap) if portfolio_gross_cap is not None else None
                ),
                "quantity_resolution": resolution.to_payload(),
            }
        position_qty = resolution.position_qty
        entering_short = (
            action.strip().lower() == "sell"
            and not resolution.fractional_allowed
            and (position_qty is None or position_qty <= 0)
        )
        if entering_short:
            return Decimal("0"), {
                "method": method,
                "reason": _SHORT_ENTRY_BELOW_MIN_QTY_REASON,
                "notional_budget": str(notional_budget),
                "price": str(price),
                "requested_qty": str(requested_qty),
                "min_qty": str(min_qty),
                "quantity_resolution": resolution.to_payload(),
            }
        qty = min_qty

    return qty, {
        "method": method,
        "notional_budget": str(notional_budget),
        "price": str(price),
        "requested_qty": str(requested_qty),
        "current_value": str(current_value) if current_value is not None else None,
        "current_gross": str(current_gross),
        "position_qty": str(position_qty) if position_qty is not None else None,
        "symbol_notional_cap": (
            str(symbol_notional_cap) if symbol_notional_cap is not None else None
        ),
        "symbol_capacity_limited": cap_applied,
        "portfolio_gross_cap": (
            str(portfolio_gross_cap) if portfolio_gross_cap is not None else None
        ),
        "portfolio_gross_limited": portfolio_cap_applied,
        "quantity_resolution": resolution.to_payload(),
    }


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

    symbol_notional_cap = _resolve_symbol_notional_cap(
        strategy_pcts=[optional_decimal(strategy.max_position_pct_equity) for strategy in strategies],
        equity=equity,
    )
    portfolio_gross_cap = _resolve_portfolio_gross_cap(
        strategies=strategies,
        equity=equity,
    )
    current_value = _position_value_for_symbol(effective_capacity_positions, symbol)
    current_gross = _portfolio_gross_exposure(effective_capacity_positions)
    position_qty = _position_qty_for_symbol(positions, symbol)
    normalized_action = action.strip().lower()
    exit_only_sell = (
        _treats_sell_as_exit_only_any(strategies) and normalized_action == "sell"
    )
    exit_only_buy = (
        _treats_buy_as_exit_only_any(strategies) and normalized_action == "buy"
    )
    if exit_only_sell and position_qty is not None and position_qty <= 0:
        return Decimal("0"), {
            "method": budget_method,
            "reason": _EXIT_ONLY_SELL_FLAT_REASON,
            "notional_budget": str(total_budget),
            "price": str(price),
            "position_qty": str(position_qty),
        }
    if exit_only_buy and position_qty is not None and position_qty >= 0:
        return Decimal("0"), {
            "method": budget_method,
            "reason": _EXIT_ONLY_BUY_FLAT_REASON,
            "notional_budget": str(total_budget),
            "price": str(price),
            "position_qty": str(position_qty),
        }
    if _blocks_same_direction_reentry_any(strategies) and _same_direction_reentry_exists(
        action=normalized_action,
        position_qty=position_qty,
    ):
        return Decimal("0"), {
            "method": budget_method,
            "reason": _SAME_DIRECTION_REENTRY_REASON,
            "notional_budget": str(total_budget),
            "price": str(price),
            "position_qty": (
                str(position_qty) if position_qty is not None else None
            ),
        }

    requested_qty = total_budget / price
    if exit_only_sell and position_qty is not None and position_qty > 0:
        requested_qty = position_qty
    if exit_only_buy and position_qty is not None and position_qty < 0:
        requested_qty = abs(position_qty)
    capped_requested_qty = _cap_requested_qty_by_symbol_cap(
        action=normalized_action,
        requested_qty=requested_qty,
        price=price,
        position_qty=position_qty,
        symbol_notional_cap=symbol_notional_cap,
    )
    cap_applied = capped_requested_qty is not None and capped_requested_qty < requested_qty
    if capped_requested_qty is not None:
        requested_qty = capped_requested_qty
    capped_by_portfolio_qty = _cap_requested_qty_by_portfolio_gross_cap(
        action=normalized_action,
        requested_qty=requested_qty,
        price=price,
        positions=effective_capacity_positions,
        portfolio_gross_cap=portfolio_gross_cap,
    )
    portfolio_cap_applied = (
        capped_by_portfolio_qty is not None and capped_by_portfolio_qty < requested_qty
    )
    if capped_by_portfolio_qty is not None:
        requested_qty = capped_by_portfolio_qty
    if requested_qty <= 0:
        capacity_reason = (
            "portfolio_gross_capacity_exhausted"
            if portfolio_cap_applied or (
                normalized_action == "buy"
                and portfolio_gross_cap is not None
                and portfolio_gross_cap > 0
                and current_gross >= portfolio_gross_cap
            )
            else "symbol_capacity_exhausted"
        )
        return Decimal("0"), {
            "method": budget_method,
            "reason": capacity_reason,
            "notional_budget": str(total_budget),
            "price": str(price),
            "requested_qty": str(total_budget / price),
            "current_value": str(current_value) if current_value is not None else None,
            "current_gross": str(current_gross),
            "position_qty": (
                str(position_qty) if position_qty is not None else None
            ),
            "symbol_notional_cap": (
                str(symbol_notional_cap)
                if symbol_notional_cap is not None
                else None
            ),
            "portfolio_gross_cap": (
                str(portfolio_gross_cap) if portfolio_gross_cap is not None else None
            ),
        }
    resolution = resolve_quantity_resolution(
        action=action,
        symbol=symbol,
        global_enabled=settings.trading_fractional_equities_enabled,
        allow_shorts=settings.trading_allow_shorts,
        position_qty=position_qty,
        requested_qty=requested_qty,
    )
    qty = quantize_qty_for_symbol(
        symbol,
        requested_qty,
        fractional_equities_enabled=resolution.fractional_allowed,
    )
    min_qty = min_qty_for_symbol(
        symbol, fractional_equities_enabled=resolution.fractional_allowed
    )
    if qty < min_qty:
        if cap_applied or portfolio_cap_applied:
            capacity_reason = (
                "portfolio_gross_capacity_exhausted"
                if portfolio_cap_applied and not cap_applied
                else "symbol_capacity_exhausted"
            )
            return Decimal("0"), {
                "method": budget_method,
                "reason": capacity_reason,
                "notional_budget": str(total_budget),
                "price": str(price),
                "requested_qty": str(requested_qty),
                "min_qty": str(min_qty),
                "current_value": (
                    str(current_value) if current_value is not None else None
                ),
                "current_gross": str(current_gross),
                "position_qty": (
                    str(position_qty) if position_qty is not None else None
                ),
                "symbol_notional_cap": (
                    str(symbol_notional_cap)
                    if symbol_notional_cap is not None
                    else None
                ),
                "portfolio_gross_cap": (
                    str(portfolio_gross_cap) if portfolio_gross_cap is not None else None
                ),
                "quantity_resolution": resolution.to_payload(),
            }
        position_qty = resolution.position_qty
        entering_short = (
            action.strip().lower() == "sell"
            and not resolution.fractional_allowed
            and (position_qty is None or position_qty <= 0)
        )
        if entering_short:
            return Decimal("0"), {
                "method": budget_method,
                "reason": _SHORT_ENTRY_BELOW_MIN_QTY_REASON,
                "notional_budget": str(total_budget),
                "price": str(price),
                "requested_qty": str(requested_qty),
                "min_qty": str(min_qty),
                "quantity_resolution": resolution.to_payload(),
            }
        qty = min_qty
    return qty, {
        "method": budget_method,
        "notional_budget": str(total_budget),
        "price": str(price),
        "requested_qty": str(requested_qty),
        "current_value": str(current_value) if current_value is not None else None,
        "current_gross": str(current_gross),
        "position_qty": str(position_qty) if position_qty is not None else None,
        "symbol_notional_cap": (
            str(symbol_notional_cap) if symbol_notional_cap is not None else None
        ),
        "symbol_capacity_limited": cap_applied,
        "portfolio_gross_cap": (
            str(portfolio_gross_cap) if portfolio_gross_cap is not None else None
        ),
        "portfolio_gross_limited": portfolio_cap_applied,
        "quantity_resolution": resolution.to_payload(),
    }


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


def _build_runtime_position_exit_overlay(
    *,
    signal: SignalEnvelope,
    strategies: list[Strategy],
    timeframe: str,
    decisions: list[StrategyDecision],
    positions: Optional[list[dict[str, Any]]],
    equity: Optional[Decimal],
    price: Optional[Decimal],
    features: SignalFeatures,
    snapshot: Optional[MarketSnapshot],
    raw_runtime_by_strategy_id: Mapping[str, dict[str, Any]],
    runtime_eval: Any,
    position_peak_price: Decimal | None,
    aggregated: bool = True,
    position_isolation_mode: str | None = None,
) -> StrategyDecision | None:
    if price is None or positions is None:
        return None

    position_qty = _position_qty_for_symbol(positions, signal.symbol)
    if position_qty is None or position_qty == 0:
        return None
    position_side: Literal["long", "short"] = "long" if position_qty > 0 else "short"
    exit_action: Literal["buy", "sell"] = "sell" if position_side == "long" else "buy"
    if any(
        decision.symbol == signal.symbol and decision.action == exit_action
        for decision in decisions
    ):
        return None

    eligible_strategies = [
        strategy
        for strategy in strategies
        if strategy.enabled
        and strategy.base_timeframe == timeframe
        and (
            _treats_sell_as_exit_only(strategy)
            if position_side == "long"
            else _treats_buy_as_exit_only(strategy)
        )
    ]
    if not eligible_strategies:
        return None

    avg_entry_price = _position_avg_entry_price_for_symbol(positions, signal.symbol)
    if avg_entry_price is None or avg_entry_price <= 0:
        return None

    spread_bps = _signal_spread_bps(signal=signal, price=price)
    volatility_bps = _volatility_to_bps(features.volatility)

    hard_stop_loss_bps = _resolve_min_positive_strategy_param(
        strategies=eligible_strategies,
        key=f"{position_side}_stop_loss_bps",
    )
    if hard_stop_loss_bps is None and position_side == "short":
        hard_stop_loss_bps = _resolve_min_positive_strategy_param(
            strategies=eligible_strategies,
            key="long_stop_loss_bps",
        )
    hard_stop_threshold_bps = _resolve_dynamic_exit_threshold_bps(
        strategies=eligible_strategies,
        base_bps=hard_stop_loss_bps,
        spread_bps=spread_bps,
        spread_multiplier_key=f"{position_side}_stop_loss_spread_bps_multiplier",
        volatility_bps=volatility_bps,
        volatility_multiplier_key=f"{position_side}_stop_loss_volatility_bps_multiplier",
    )
    entry_drawdown_bps = Decimal("0")
    if position_side == "long" and price < avg_entry_price:
        entry_drawdown_bps = ((avg_entry_price - price) / avg_entry_price) * Decimal("10000")
    elif position_side == "short" and price > avg_entry_price:
        entry_drawdown_bps = ((price - avg_entry_price) / avg_entry_price) * Decimal("10000")

    trailing_activation_profit_bps: Decimal | None = None
    trailing_stop_threshold_bps: Decimal | None = None
    if position_side == "long":
        trailing_activation_profit_bps = _resolve_min_positive_strategy_param(
            strategies=eligible_strategies,
            key="long_trailing_stop_activation_profit_bps",
        )
        trailing_drawdown_bps = _resolve_min_positive_strategy_param(
            strategies=eligible_strategies,
            key="long_trailing_stop_drawdown_bps",
        )
        trailing_stop_threshold_bps = _resolve_dynamic_exit_threshold_bps(
            strategies=eligible_strategies,
            base_bps=trailing_drawdown_bps,
            spread_bps=spread_bps,
            spread_multiplier_key="long_trailing_stop_spread_bps_multiplier",
            volatility_bps=volatility_bps,
            volatility_multiplier_key="long_trailing_stop_volatility_bps_multiplier",
        )
    trailing_stop_requires_structure_loss = _resolve_bool_strategy_param(
        strategies=eligible_strategies,
        key="long_trailing_stop_requires_structure_loss",
        default=_default_trailing_stop_requires_structure_loss(eligible_strategies),
    )
    trailing_stop_structure_loss_confirmed = _trailing_stop_structure_loss_confirmed(
        signal=signal,
        price=price,
        strategies=eligible_strategies,
    )

    exit_candidates: list[tuple[str, str, Decimal | None, Decimal | None]] = []
    position_age_seconds = _position_age_seconds_for_symbol(
        positions,
        signal.symbol,
        signal_ts=signal.event_ts,
    )
    flatten_start_minute_utc = _resolve_max_nonnegative_strategy_param(
        strategies=eligible_strategies,
        key="session_flatten_start_minute_utc",
    )
    max_hold_seconds = _resolve_max_nonnegative_strategy_param(
        strategies=eligible_strategies,
        key="max_hold_seconds",
    )
    minute_of_day_utc = Decimal(
        str(signal.event_ts.astimezone(timezone.utc).hour * 60 + signal.event_ts.astimezone(timezone.utc).minute)
    )

    if (
        position_peak_price is not None
        and position_peak_price > avg_entry_price
        and trailing_activation_profit_bps is not None
        and trailing_stop_threshold_bps is not None
        and trailing_stop_threshold_bps > 0
    ):
        peak_profit_bps = ((position_peak_price - avg_entry_price) / avg_entry_price) * Decimal("10000")
        if peak_profit_bps >= trailing_activation_profit_bps and price < position_peak_price:
            peak_drawdown_bps = ((position_peak_price - price) / position_peak_price) * Decimal("10000")
            if (
                peak_drawdown_bps >= trailing_stop_threshold_bps
                and (
                    not trailing_stop_requires_structure_loss
                    or trailing_stop_structure_loss_confirmed
                )
            ):
                exit_candidates.append(
                    (
                        "long_trailing_stop_bps",
                        "position_trailing_stop_exit",
                        trailing_stop_threshold_bps,
                        peak_drawdown_bps,
                    )
                )

    if (
        hard_stop_threshold_bps is not None
        and hard_stop_threshold_bps > 0
        and entry_drawdown_bps >= hard_stop_threshold_bps
    ):
        exit_candidates.append(
            (
                f"{position_side}_stop_loss_bps",
                "position_stop_loss_exit",
                hard_stop_threshold_bps,
                entry_drawdown_bps,
            )
        )

    if (
        max_hold_seconds is not None
        and max_hold_seconds > 0
        and position_age_seconds is not None
        and position_age_seconds >= int(max_hold_seconds)
    ):
        exit_candidates.append(
            ("max_hold_seconds", "position_time_exit", max_hold_seconds, None)
        )

    if (
        flatten_start_minute_utc is not None
        and minute_of_day_utc >= flatten_start_minute_utc
    ):
        exit_candidates.append(
            (
                "session_flatten_minute_utc",
                "session_flatten_exit",
                flatten_start_minute_utc,
                None,
            )
        )

    if not exit_candidates:
        return None

    reference_exit_price = _reference_exit_price(
        price=price,
        signal=signal,
        action=exit_action,
    )
    realized_bps = _realized_exit_bps(
        avg_entry_price=avg_entry_price,
        exit_price=reference_exit_price,
        position_side=position_side,
    )
    exit_type: str | None = None
    exit_rationale: str | None = None
    trigger_threshold_bps: Decimal | None = None
    trigger_drawdown_bps: Decimal | None = None
    for (
        candidate_exit_type,
        candidate_exit_rationale,
        candidate_threshold_bps,
        candidate_drawdown_bps,
    ) in exit_candidates:
        if (
            candidate_exit_type
            not in {
                "long_stop_loss_bps",
                "short_stop_loss_bps",
                "max_hold_seconds",
                "session_flatten_minute_utc",
            }
            and not _passes_exit_profit_policy(
                strategies=eligible_strategies,
                realized_bps=realized_bps,
            )
        ):
            continue
        exit_type = candidate_exit_type
        exit_rationale = candidate_exit_rationale
        trigger_threshold_bps = candidate_threshold_bps
        trigger_drawdown_bps = candidate_drawdown_bps
        break
    if exit_type is None or exit_rationale is None:
        return None

    qty, sizing_meta = _resolve_qty_for_aggregated(
        eligible_strategies,
        symbol=signal.symbol,
        action=exit_action,
        price=price,
        equity=equity,
        positions=positions,
    )
    if _skip_non_executable_decision_qty(qty=qty, sizing_meta=sizing_meta):
        return None

    primary_strategy = eligible_strategies[0]
    primary_runtime_metadata = dict(
        raw_runtime_by_strategy_id.get(str(primary_strategy.id), {})
    )
    runtime_metadata = {
        "mode": settings.trading_strategy_runtime_mode,
        "aggregated": aggregated,
        "position_isolation_mode": position_isolation_mode,
        "primary_strategy_row_id": str(primary_strategy.id),
        "primary_declared_strategy_id": primary_runtime_metadata.get(
            "declared_strategy_id"
        ),
        "source_strategy_ids": [str(strategy.id) for strategy in eligible_strategies],
        "source_declared_strategy_ids": [
            str(item.get("declared_strategy_id"))
            for item in raw_runtime_by_strategy_id.values()
            if str(item.get("declared_strategy_id") or "").strip()
        ],
        "compiler_sources": sorted(
            {
                str(item.get("compiler_source") or "").strip()
                for item in raw_runtime_by_strategy_id.values()
                if str(item.get("compiler_source") or "").strip()
            }
        ),
        "source_strategy_runtime": [
            dict(raw_runtime_by_strategy_id[str(strategy.id)])
            for strategy in eligible_strategies
            if str(strategy.id) in raw_runtime_by_strategy_id
        ],
        "intent_conflicts_total": runtime_eval.observation.intent_conflicts_total,
        "strategy_errors": [
            {
                "strategy_id": error.strategy_id,
                "strategy_type": error.strategy_type,
                "plugin_id": error.plugin_id,
                "reason": error.reason,
            }
            for error in runtime_eval.errors
        ],
        "exit_overlay": exit_type,
    }
    decision = StrategyDecision(
        strategy_id=str(primary_strategy.id),
        symbol=signal.symbol,
        event_ts=signal.event_ts,
        timeframe=timeframe,
        action=exit_action,
        qty=qty,
        order_type="market",
        time_in_force="day",
        rationale=exit_rationale,
        params=_build_params(
            signal=signal,
            macd=features.macd,
            macd_signal=features.macd_signal,
            rsi=features.rsi,
            price=price,
            volatility=features.volatility,
            snapshot=snapshot,
            runtime_metadata=runtime_metadata,
        )
        | {
            "sizing": sizing_meta,
            "position_exit": {
                "type": exit_type,
                "threshold_bps": trigger_threshold_bps,
                "drawdown_bps": trigger_drawdown_bps,
                "avg_entry_price": avg_entry_price,
                "peak_price": position_peak_price,
                "entry_drawdown_bps": entry_drawdown_bps,
                "reference_exit_price": reference_exit_price,
                "realized_bps": realized_bps,
                "spread_bps": spread_bps,
                "volatility_bps": volatility_bps,
            },
        },
    )
    return decision


def _blocks_same_direction_reentry(strategy: Strategy) -> bool:
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


def _strategy_uses_position_isolation(strategy: Strategy) -> bool:
    params = StrategyRuntime.definition_from_strategy(strategy).params
    isolation_mode = str(params.get("position_isolation_mode") or "").strip().lower()
    if isolation_mode == "per_strategy":
        return True
    normalized = str(strategy.universe_type or "").strip().lower()
    return normalized in {
        "momentum_pullback_long_v1",
        "breakout_continuation_long_v1",
        "mean_reversion_rebound_long_v1",
        "late_day_continuation_long_v1",
        "end_of_day_reversal_long_v1",
    }


def _position_state_scope_key(
    *,
    position_isolation_mode: str | None,
    strategy_id: str | None,
) -> str | None:
    if str(position_isolation_mode or "").strip().lower() != "per_strategy":
        return None
    normalized_strategy_id = str(strategy_id or "").strip()
    return normalized_strategy_id or None


def _runtime_trade_policy_key(
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


def _positions_for_strategy_action(
    positions: Optional[list[dict[str, Any]]],
    *,
    strategy_id: str,
    action: str,
) -> Optional[list[dict[str, Any]]]:
    if not positions:
        return positions
    tagged_positions = [
        dict(position)
        for position in positions
        if str(position.get("strategy_id") or "").strip() == strategy_id
    ]
    if action.strip().lower() == "sell":
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
    return _strategy_exit_semantics_type(strategy) in (
        _BUY_EXIT_ONLY_STRATEGY_TYPES | _LEGACY_BUY_EXIT_ONLY_UNIVERSE_TYPES
    )


def _strategy_exit_semantics_type(strategy: Strategy) -> str:
    runtime_type = _strategy_catalog_runtime_type(strategy)
    if runtime_type in _SELL_EXIT_ONLY_STRATEGY_TYPES | _BUY_EXIT_ONLY_STRATEGY_TYPES:
        return runtime_type

    universe_type = str(strategy.universe_type or "").strip().lower()
    if universe_type in (
        _SELL_EXIT_ONLY_STRATEGY_TYPES
        | _BUY_EXIT_ONLY_STRATEGY_TYPES
        | _LEGACY_BUY_EXIT_ONLY_UNIVERSE_TYPES
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
        raw_value = position.get("avg_entry_price") or position.get("average_entry_price")
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
    if _resolve_bool_strategy_param(
        strategies=strategies,
        key="require_positive_price_for_signal_exit",
        default=True,
    ) and realized_bps <= 0:
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
        global_pct = optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity)
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


def _resolve_runtime_trade_policy(strategies: list[Strategy]) -> dict[str, int | Decimal]:
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
        if max_session_negative_exit_bps is not None and max_session_negative_exit_bps > 0:
            max_session_negative_exit_bps_candidates.append(max_session_negative_exit_bps)
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
            min(max_stop_loss_exits_candidates)
            if max_stop_loss_exits_candidates
            else 0
        ),
        "max_negative_exits_per_session": (
            min(max_negative_exits_candidates)
            if max_negative_exits_candidates
            else 0
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
    state_scope_key: str | None = None,
) -> bool:
    normalized_action = action.strip().lower()
    session_state = _resolve_runtime_trade_policy_session_state(
        runtime_trade_policy_state=runtime_trade_policy_state,
        signal_ts=signal_ts,
        symbol=symbol,
        position_owner=position_owner,
    )
    entry_action = _is_entry_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    exit_action = _is_exit_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if entry_action:
        max_concurrent_positions = max(0, int(policy.get("max_concurrent_positions", 0)))
        if (
            max_concurrent_positions > 0
            and (
                (
                    normalized_action == "buy"
                    and _count_open_long_positions(positions) >= max_concurrent_positions
                )
                or (
                    normalized_action == "sell"
                    and _count_open_short_positions(positions) >= max_concurrent_positions
                )
            )
        ):
            return False
        max_entries_per_session = max(0, int(policy.get("max_entries_per_session", 0)))
        if max_entries_per_session > 0 and session_state.entry_count >= max_entries_per_session:
            return False
        max_stop_loss_exits = max(0, int(policy.get("max_stop_loss_exits_per_session", 0)))
        if (
            max_stop_loss_exits > 0
            and session_state.stop_loss_exit_count >= max_stop_loss_exits
        ):
            return False
        max_negative_exits = max(0, int(policy.get("max_negative_exits_per_session", 0)))
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
            and session_state.cumulative_negative_exit_bps >= max_session_negative_exit_bps
        ):
            return False
        stop_loss_lockout_seconds = max(0, int(policy.get("stop_loss_lockout_seconds", 0)))
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

    cooldown_key = (
        "entry_cooldown_seconds" if entry_action else "exit_cooldown_seconds"
    )
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
        and (signal_ts.astimezone(timezone.utc) - last_emitted.astimezone(timezone.utc)).total_seconds()
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
        signal_ts.astimezone(timezone.utc)
        - position_opened_at.astimezone(timezone.utc)
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
) -> str:
    normalized_action = str(action or "").strip().lower()
    param_key = (
        "entry_time_in_force"
        if _is_entry_action_for_strategies(strategies=strategies, action=normalized_action)
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
    key = (symbol.strip().upper(), position_owner.strip() or _RUNTIME_TRADE_POLICY_SHARED_OWNER)
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
) -> None:
    normalized_action = action.strip().lower()
    state = _resolve_runtime_trade_policy_session_state(
        runtime_trade_policy_state=runtime_trade_policy_state,
        signal_ts=signal_ts,
        symbol=symbol,
        position_owner=position_owner,
    )
    entry_action = _is_entry_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    exit_side = _exit_position_side_for_strategies(
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
    if negative_exit_loss_bps is not None and negative_exit_loss_bps > 0 and loss_bps < negative_exit_loss_bps:
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
) -> bool:
    normalized_action = action.strip().lower()
    exit_side = _exit_position_side_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if exit_side is None or price is None or price <= 0:
        return True

    position_qty = _position_qty_for_symbol(positions, symbol)
    if (
        (exit_side == "long" and (position_qty is None or position_qty <= 0))
        or (exit_side == "short" and (position_qty is None or position_qty >= 0))
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
        (
            price_vs_opening_range_high_bps is not None
            and price_vs_opening_range_high_bps <= opening_range_high_threshold
        )
        or (
            price_vs_vwap_w5m_bps is not None
            and price_vs_vwap_w5m_bps <= vwap_threshold
            and price_position_in_session_range is not None
            and price_position_in_session_range <= session_range_position_max
        )
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
    tick_size = Decimal("0.0001") if price.copy_abs() < Decimal("1") else Decimal("0.01")
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
