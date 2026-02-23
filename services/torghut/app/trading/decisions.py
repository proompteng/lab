"""Trading decision engine based on TA signals."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Iterable, Literal, Optional, cast

from ..config import settings
from ..models import Strategy
from .features import (
    FeatureNormalizationError,
    SignalFeatures,
    extract_microstructure_features_v1,
    extract_signal_features,
    normalize_feature_vector_v3,
    optional_decimal,
)
from .forecasting import ForecastRoutingTelemetry, build_default_forecast_router
from .models import SignalEnvelope, StrategyDecision
from .prices import MarketSnapshot, PriceFetcher
from .quantity_rules import min_qty_for_symbol, quantize_qty_for_symbol
from .strategy_runtime import (
    RuntimeErrorRecord,
    RuntimeObservation,
    StrategyRegistry,
    StrategyRuntime,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DecisionRuntimeTelemetry:
    mode: str
    runtime_enabled: bool
    fallback_to_legacy: bool
    errors: tuple[RuntimeErrorRecord, ...] = field(default_factory=tuple)
    observation: RuntimeObservation | None = None


class DecisionEngine:
    """Evaluate TA signals against configured strategies."""

    def __init__(self, price_fetcher: Optional[PriceFetcher] = None) -> None:
        self.price_fetcher = price_fetcher
        self.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                circuit_error_threshold=settings.trading_strategy_runtime_circuit_errors,
                cooldown_seconds=settings.trading_strategy_runtime_circuit_cooldown_seconds,
            )
        )
        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode="legacy",
            runtime_enabled=False,
            fallback_to_legacy=False,
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
            decisions = self._evaluate_with_runtime(signal, filtered, equity=equity)
            if decisions:
                return decisions
            if settings.trading_strategy_runtime_fallback_legacy:
                runtime_telemetry = self._last_runtime_telemetry
                legacy_decisions = self._evaluate_legacy(
                    signal, filtered, equity=equity
                )
                self._last_runtime_telemetry = DecisionRuntimeTelemetry(
                    mode=settings.trading_strategy_runtime_mode,
                    runtime_enabled=True,
                    fallback_to_legacy=True,
                    errors=runtime_telemetry.errors,
                    observation=runtime_telemetry.observation,
                )
                return legacy_decisions
            return []

        return self._evaluate_legacy(signal, filtered, equity=equity)

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

    def _evaluate_with_runtime(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Optional[Decimal],
    ) -> list[StrategyDecision]:
        timeframe = signal.timeframe
        if timeframe is None:
            return []
        features = extract_signal_features(signal)

        price = features.price
        snapshot: Optional[MarketSnapshot] = None
        if price is None and self.price_fetcher is not None:
            snapshot = self.price_fetcher.fetch_market_snapshot(signal)
            if snapshot is not None:
                price = snapshot.price

        normalized_payload = dict(signal.payload)
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
        )

        decisions: list[StrategyDecision] = []
        self._last_forecast_telemetry = []
        if not runtime_eval.intents:
            return decisions

        strategies_by_id = {str(strategy.id): strategy for strategy in strategies}
        for intent in runtime_eval.intents:
            source_strategy_ids = list(intent.source_strategy_ids)
            primary_strategy_id = source_strategy_ids[0] if source_strategy_ids else None
            if primary_strategy_id is None:
                logger.warning(
                    "Skipping aggregated intent without source strategy symbol=%s horizon=%s",
                    intent.symbol,
                    intent.horizon,
                )
                continue
            source_strategies = [
                strategies_by_id[strategy_id]
                for strategy_id in source_strategy_ids
                if strategy_id in strategies_by_id
            ]
            qty, sizing_meta = _resolve_qty_for_aggregated(
                source_strategies,
                symbol=intent.symbol,
                price=price,
                equity=equity,
            )
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
            decisions.append(
                StrategyDecision(
                    strategy_id=primary_strategy_id,
                    symbol=intent.symbol,
                    event_ts=signal.event_ts,
                    timeframe=timeframe,
                    action=intent.direction,
                    qty=qty,
                    order_type="market",
                    time_in_force="day",
                    rationale=",".join(intent.explain),
                    params=_build_params(
                        signal=signal,
                        macd=features.macd,
                        macd_signal=features.macd_signal,
                        rsi=features.rsi,
                        price=price,
                        volatility=features.volatility,
                        snapshot=snapshot,
                        runtime_metadata={
                            "mode": settings.trading_strategy_runtime_mode,
                            "aggregated": True,
                            "source_strategy_ids": source_strategy_ids,
                            "feature_snapshot_hashes": list(
                                intent.feature_snapshot_hashes
                            ),
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
            )
        return decisions

    def _evaluate_legacy(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Optional[Decimal],
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
            decision = self._evaluate_legacy_strategy(signal, strategy, equity=equity)
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
    ) -> Optional[StrategyDecision]:
        timeframe = signal.timeframe
        if timeframe is None:
            return None
        features = extract_signal_features(signal)

        price = features.price
        snapshot: Optional[MarketSnapshot] = None
        if price is None and self.price_fetcher is not None:
            snapshot = self.price_fetcher.fetch_market_snapshot(signal)
            if snapshot is not None:
                price = snapshot.price
        forecast_contract: dict[str, Any] | None = None
        forecast_audit: dict[str, Any] | None = None
        if self.forecast_router is not None:
            normalized_payload = dict(signal.payload)
            if price is not None and "price" not in normalized_payload:
                normalized_payload["price"] = price
            normalized_signal = signal.model_copy(update={"payload": normalized_payload})
            try:
                feature_vector = normalize_feature_vector_v3(normalized_signal)
            except FeatureNormalizationError:
                feature_vector = None
            if feature_vector is not None:
                forecast_result = self.forecast_router.route_and_forecast(
                    feature_vector=feature_vector,
                    horizon=timeframe,
                    event_ts=signal.event_ts,
                )
                forecast_contract = forecast_result.contract.to_payload()
                forecast_audit = forecast_result.audit.to_payload()
                self._last_forecast_telemetry.append(forecast_result.telemetry)

        if (
            features.macd is None
            or features.macd_signal is None
            or features.rsi is None
        ):
            logger.debug("Signal missing indicators for strategy %s", strategy.id)
            return None

        action: Literal["buy", "sell"]
        rationale_parts: list[str]
        if features.macd > features.macd_signal and features.rsi < 35:
            action = "buy"
            rationale_parts = ["macd_cross_up", "rsi_oversold"]
        elif features.macd < features.macd_signal and features.rsi > 65:
            action = "sell"
            rationale_parts = ["macd_cross_down", "rsi_overbought"]
        else:
            return None

        qty, sizing_meta = _resolve_qty(
            strategy,
            symbol=signal.symbol,
            price=price,
            equity=equity,
        )

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
                    "plugin_id": "legacy_builtin",
                    "plugin_version": "1.0.0",
                    "parameter_hash": "legacy",
                    "required_features": ["macd", "macd_signal", "rsi14", "price"],
                },
                forecast_contract=forecast_contract,
                forecast_audit=forecast_audit,
            )
            | {"sizing": sizing_meta},
        )


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
    params: dict[str, Any] = {
        "macd": macd,
        "macd_signal": macd_signal,
        "rsi": rsi,
        "price": price,
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
    microstructure_state = _resolve_microstructure_state_payload(signal)
    if microstructure_state is not None:
        params["microstructure_state"] = microstructure_state
    execution_advice = _resolve_execution_advice_payload(signal)
    if execution_advice is not None:
        params["execution_advice"] = execution_advice
    fragility_snapshot = _resolve_fragility_snapshot_payload(signal)
    if fragility_snapshot is not None:
        params["fragility_snapshot"] = fragility_snapshot
    return params


def _resolve_microstructure_state_payload(
    signal: SignalEnvelope,
) -> dict[str, Any] | None:
    payload = signal.payload
    raw_state = payload.get("microstructure_state")
    if isinstance(raw_state, dict):
        state = dict(cast(dict[str, Any], raw_state))
    else:
        extracted = extract_microstructure_features_v1(signal)
        state = {
            "schema_version": extracted.schema_version,
            "symbol": extracted.symbol,
            "event_ts": extracted.event_ts.isoformat(),
            "spread_bps": str(extracted.spread_bps),
            "depth_top5_usd": str(extracted.depth_top5_usd),
            "order_flow_imbalance": str(extracted.order_flow_imbalance),
            "latency_ms_estimate": extracted.latency_ms_estimate,
            "fill_hazard": str(extracted.fill_hazard),
            "liquidity_regime": extracted.liquidity_regime,
        }

    state["schema_version"] = "microstructure_state_v1"
    state["symbol"] = str(state.get("symbol") or signal.symbol).strip().upper()
    if not state["symbol"]:
        state["symbol"] = signal.symbol.strip().upper()
    event_ts = state.get("event_ts")
    if event_ts is None:
        state["event_ts"] = signal.event_ts.isoformat()
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
    price: Optional[Decimal],
    equity: Optional[Decimal],
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

    qty = quantize_qty_for_symbol(symbol, notional_budget / price)
    min_qty = min_qty_for_symbol(symbol)
    if qty < min_qty:
        qty = min_qty

    return qty, {
        "method": method,
        "notional_budget": str(notional_budget),
        "price": str(price),
    }


def _resolve_qty_for_aggregated(
    strategies: list[Strategy],
    *,
    symbol: str,
    price: Optional[Decimal],
    equity: Optional[Decimal],
) -> tuple[Decimal, dict[str, Any]]:
    default_qty = Decimal(str(settings.trading_default_qty))
    if price is None or price <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_price"}
    if not strategies:
        return default_qty, {"method": "default_qty", "reason": "no_strategies"}

    total_budget = Decimal("0")
    for strategy in strategies:
        budget = optional_decimal(strategy.max_notional_per_trade)
        if budget is not None and budget > 0:
            total_budget += budget
    if total_budget <= 0:
        global_budget = optional_decimal(settings.trading_max_notional_per_trade)
        if global_budget is not None and global_budget > 0:
            total_budget = global_budget
    if total_budget <= 0 and equity is not None:
        pct = optional_decimal(settings.trading_max_position_pct_equity)
        if pct is not None and pct > 0:
            total_budget = equity * pct
    if total_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}

    qty = quantize_qty_for_symbol(symbol, total_budget / price)
    min_qty = min_qty_for_symbol(symbol)
    if qty < min_qty:
        qty = min_qty
    return qty, {
        "method": "aggregated_notional_budget",
        "notional_budget": str(total_budget),
        "price": str(price),
    }


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
