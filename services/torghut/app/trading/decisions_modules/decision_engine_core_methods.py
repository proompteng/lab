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

from .decision_engine_core_support import (
    actual_positions_only as _actual_positions_only,
    build_params as _build_params,
    build_runtime_position_exit_overlay as _build_runtime_position_exit_overlay,
    decision_position_exit_type as _decision_position_exit_type,
    passes_runtime_trade_policy as _passes_runtime_trade_policy,
    passes_signal_exit_policy as _passes_signal_exit_policy,
    position_avg_entry_price_for_symbol as _position_avg_entry_price_for_symbol,
    position_qty_for_symbol as _position_qty_for_symbol,
    position_qty_from_payload as _position_qty_from_payload,
    position_state_scope_key as _position_state_scope_key,
    positions_for_strategy_action as _positions_for_strategy_action,
    record_runtime_trade_policy_decision as _record_runtime_trade_policy_decision,
    resolve_qty_for_aggregated as _resolve_qty_for_aggregated,
    resolve_runtime_trade_policy as _resolve_runtime_trade_policy,
    resolve_signal_timeframe as _resolve_signal_timeframe,
    resolve_strategy_time_in_force as _resolve_strategy_time_in_force,
    runtime_enabled as _runtime_enabled,
    runtime_intent_exit_side as _runtime_intent_exit_side,
    runtime_trade_policy_key as _runtime_trade_policy_key,
    runtime_trade_policy_owner as _runtime_trade_policy_owner,
    skip_non_executable_decision_qty as _skip_non_executable_decision_qty,
    strategy_uses_position_isolation as _strategy_uses_position_isolation,
)


class _DecisionEngineCoreMethods:
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
        runtime_position_qty = _position_qty_for_symbol(actual_positions, signal.symbol)
        runtime_position_side: str | None = None
        if runtime_position_qty is not None:
            normalized_payload["runtime_position_qty"] = str(runtime_position_qty)
            runtime_position_side = _runtime_position_side(runtime_position_qty)
            normalized_payload["runtime_position_side"] = runtime_position_side
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
        account_feature_vector = feature_vector
        if runtime_position_qty is not None:
            account_feature_vector = _feature_vector_with_runtime_position(
                feature_vector,
                position_qty=runtime_position_qty,
                position_side=runtime_position_side,
            )

        strategies_by_id = {str(strategy.id): strategy for strategy in strategies}
        isolated_strategy_ids = {
            str(strategy.id)
            for strategy in strategies
            if _strategy_uses_position_isolation(strategy)
        }
        non_isolated_strategy_ids = {
            str(strategy.id)
            for strategy in strategies
            if str(strategy.id) not in isolated_strategy_ids
        }
        runtime_evaluations: list[RuntimeEvaluation] = []
        non_isolated_strategies = [
            strategy
            for strategy in strategies
            if str(strategy.id) in non_isolated_strategy_ids
        ]
        if non_isolated_strategies:
            runtime_evaluations.append(
                self.strategy_runtime.evaluate_all(
                    non_isolated_strategies,
                    account_feature_vector,
                    timeframe=timeframe,
                )
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
            runtime_evaluations.append(
                self.strategy_runtime.evaluate_all(
                    [strategy],
                    _feature_vector_with_positions(
                        feature_vector,
                        positions=isolated_positions,
                        symbol=signal.symbol,
                    ),
                    timeframe=timeframe,
                )
            )
        runtime_eval = _merge_runtime_evaluations(runtime_evaluations)
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

        raw_runtime_by_strategy_id = {
            item.intent.strategy_id: item.metadata()
            for item in runtime_eval.raw_intents
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
            runtime_exit_side: Literal["long", "short"] | None = None,
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
                runtime_exit_side=runtime_exit_side,
            )

            def _record_suppression(reason: str) -> None:
                for strategy_id in source_strategy_ids or [primary_strategy_id]:
                    runtime_eval.observation.record_intent_suppression(
                        strategy_id,
                        reason,
                    )

            if _skip_non_executable_decision_qty(qty=qty, sizing_meta=sizing_meta):
                reason = str(sizing_meta.get("reason") or "non_executable_qty")
                _record_suppression(reason)
                logger.debug(
                    "Skipping non-executable runtime decision symbol=%s action=%s reason=%s",
                    symbol,
                    direction,
                    reason,
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
                runtime_exit_side=runtime_exit_side,
                state_scope_key=position_state_scope_key,
            ):
                _record_suppression("runtime_trade_policy_blocked")
                return
            if not _passes_signal_exit_policy(
                strategies=source_strategies,
                symbol=symbol,
                action=direction,
                price=price,
                signal=signal,
                positions=positions_scope,
                runtime_exit_side=runtime_exit_side,
            ):
                _record_suppression("signal_exit_policy_blocked")
                return
            position_exit_params = (
                {
                    "position_exit": {
                        "type": "runtime_signal_exit",
                        "position_side": runtime_exit_side,
                        "source": "strategy_runtime",
                    }
                }
                if runtime_exit_side is not None
                else {}
            )
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
                        runtime_exit_side=runtime_exit_side,
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
                | {"sizing": sizing_meta}
                | position_exit_params,
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
                runtime_exit_side=runtime_exit_side,
            )

        for raw_decision in runtime_eval.raw_intents:
            primary_strategy_id = raw_decision.intent.strategy_id
            if primary_strategy_id not in isolated_strategy_ids:
                continue
            strategy = strategies_by_id.get(primary_strategy_id)
            if strategy is None:
                continue
            runtime_exit_side = _runtime_intent_exit_side(
                action=raw_decision.intent.direction,
                explain=raw_decision.intent.explain,
            )
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
                    runtime_exit_side=runtime_exit_side,
                ),
                aggregated=False,
                runtime_target_notional=raw_decision.intent.target_notional,
                position_isolation_mode="per_strategy",
                runtime_exit_side=runtime_exit_side,
            )

        for intent in aggregated_intents:
            source_strategy_ids = list(intent.source_strategy_ids)
            primary_strategy_id = (
                source_strategy_ids[0] if source_strategy_ids else None
            )
            if primary_strategy_id is None:
                logger.warning(
                    "Skipping aggregated intent without source strategy symbol=%s horizon=%s",
                    intent.symbol,
                    intent.horizon,
                )
                continue
            runtime_exit_side = _runtime_intent_exit_side(
                action=intent.direction,
                explain=intent.explain,
            )
            _append_runtime_intent_decision(
                primary_strategy_id=primary_strategy_id,
                source_strategy_ids=source_strategy_ids,
                symbol=intent.symbol,
                direction=intent.direction,
                explain=intent.explain,
                feature_snapshot_hashes=list(intent.feature_snapshot_hashes),
                positions_scope=(
                    actual_positions
                    if runtime_exit_side is not None or intent.direction == "sell"
                    else positions
                ),
                aggregated=True,
                runtime_target_notional=intent.target_notional,
                runtime_exit_side=runtime_exit_side,
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
                    if decision.symbol == signal.symbol
                    and decision.strategy_id == isolated_strategy_id
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
                if decision.symbol == signal.symbol
                and decision.strategy_id in non_isolated_strategy_ids
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
        for tracked_symbol, tracked_scope_key in list(
            self._position_peak_price_by_scope
        ):
            if tracked_scope_key != state_scope_key:
                continue
            if tracked_symbol not in active_symbols:
                self._position_peak_price_by_scope.pop(
                    (tracked_symbol, tracked_scope_key), None
                )

        normalized_symbol = symbol.strip().upper()
        peak_price_key = (normalized_symbol, state_scope_key)
        position_qty = _position_qty_for_symbol(positions, normalized_symbol)
        if position_qty is None or position_qty <= 0:
            self._position_peak_price_by_scope.pop(peak_price_key, None)
            return None

        avg_entry_price = _position_avg_entry_price_for_symbol(
            positions, normalized_symbol
        )
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


# Public aliases used by split-module consumers.
DecisionEngineCoreMethods = _DecisionEngineCoreMethods

__all__ = ("DecisionEngineCoreMethods",)
