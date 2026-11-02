"""Trading decision engine based on TA signals."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Optional, cast

from ...models import Strategy
from ..features import (
    FeatureNormalizationError,
    SignalFeatures,
    extract_signal_features,
    normalize_feature_vector_v3,
)
from ..forecasting import ForecastRouterV5
from ..microstructure import parse_microstructure_state
from ..models import SignalEnvelope, StrategyDecision
from ..regime_hmm import (
    HMM_UNKNOWN_REGIME_ID,
    resolve_hmm_context,
    resolve_regime_route_label,
)
from ..prices import MarketSnapshot
from ..simulation import resolve_simulation_context
from ..strategy_runtime import (
    StrategyRuntime,
)


from .shared_context import (
    DecisionEngineFields,
    logger,
)
from .decision_engine_core_methods import (
    DecisionEngineCoreMethods,
)
from .single_strategy_qty import (
    SingleStrategyCapacityAdjustment,
    SingleStrategyQtyContext,
    StrategyBudget,
    resolve_qty,
    resolve_single_strategy_qty_from_context,
    single_strategy_budget,
    single_strategy_capacity_adjustment,
    single_strategy_capacity_exhausted_result,
    single_strategy_capacity_reason,
    single_strategy_common_meta,
    single_strategy_exit_guard_result,
    single_strategy_min_qty_capacity_reason,
    single_strategy_min_qty_result,
    single_strategy_qty_context,
    single_strategy_requested_qty,
    single_strategy_short_entry_below_min_result,
    single_strategy_success_result,
    skip_non_executable_decision_qty,
)


def has_legacy_indicator_inputs(features: SignalFeatures) -> bool:
    from .positions_for_strategy_action import (
        has_legacy_indicator_inputs,
    )

    return has_legacy_indicator_inputs(features)


def resolve_legacy_action(features: SignalFeatures) -> Any:
    from .positions_for_strategy_action import (
        resolve_legacy_action as resolve_action,
    )

    return resolve_action(features)


@dataclass(frozen=True)
class LegacyDecisionInputs:
    timeframe: str
    features: SignalFeatures
    action: Literal["buy", "sell"]
    rationale_parts: list[str]


@dataclass(frozen=True)
class LegacyMarketContext:
    price: Decimal | None
    snapshot: MarketSnapshot | None
    forecast_contract: dict[str, Any] | None
    forecast_audit: dict[str, Any] | None


@dataclass(frozen=True)
class LegacySizing:
    qty: Decimal
    sizing_meta: dict[str, Any]


@dataclass(frozen=True)
class BuildParamsRequest:
    signal: SignalEnvelope
    macd: Decimal | None
    macd_signal: Decimal | None
    rsi: Decimal | None
    price: Decimal | None
    volatility: Decimal | None
    snapshot: MarketSnapshot | None
    runtime_metadata: dict[str, Any]
    forecast_contract: dict[str, Any] | None
    forecast_audit: dict[str, Any] | None


class DecisionEngineRuntimeMethods:
    def evaluate_legacy_strategy(
        self,
        signal: SignalEnvelope,
        strategy: Strategy,
        *,
        equity: Optional[Decimal],
        positions: Optional[list[dict[str, Any]]],
    ) -> Optional[StrategyDecision]:
        return self._evaluate_legacy_strategy(
            signal,
            strategy,
            equity=equity,
            positions=positions,
        )

    def _evaluate_legacy_strategy(
        self,
        signal: SignalEnvelope,
        strategy: Strategy,
        *,
        equity: Optional[Decimal],
        positions: Optional[list[dict[str, Any]]],
    ) -> Optional[StrategyDecision]:
        legacy_inputs = legacy_decision_inputs(signal=signal, strategy=strategy)
        if legacy_inputs is None:
            return None
        market_context = self._legacy_market_context(signal, legacy_inputs)
        qty, sizing_meta = resolve_qty(
            strategy,
            symbol=signal.symbol,
            action=legacy_inputs.action,
            price=market_context.price,
            equity=equity,
            positions=positions,
        )
        sizing = LegacySizing(qty=qty, sizing_meta=sizing_meta)
        if skip_non_executable_decision_qty(
            qty=sizing.qty, sizing_meta=sizing.sizing_meta
        ):
            log_skipped_legacy_decision(
                strategy=strategy,
                signal=signal,
                action=legacy_inputs.action,
                sizing_meta=sizing.sizing_meta,
            )
            return None
        return legacy_strategy_decision(
            signal=signal,
            strategy=strategy,
            inputs=legacy_inputs,
            market_context=market_context,
            runtime_metadata=legacy_runtime_metadata(strategy),
            sizing=sizing,
        )

    def _legacy_market_context(
        self,
        signal: SignalEnvelope,
        inputs: LegacyDecisionInputs,
    ) -> LegacyMarketContext:
        price, snapshot = self._resolve_price_and_snapshot(signal, inputs.features)
        forecast_contract, forecast_audit = self._resolve_forecast_payload(
            signal,
            timeframe=inputs.timeframe,
            price=price,
        )
        return LegacyMarketContext(
            price=price,
            snapshot=snapshot,
            forecast_contract=forecast_contract,
            forecast_audit=forecast_audit,
        )

    def _resolve_price_and_snapshot(
        self,
        signal: SignalEnvelope,
        features: SignalFeatures,
    ) -> tuple[Optional[Decimal], Optional[MarketSnapshot]]:
        price = features.price
        snapshot: Optional[MarketSnapshot] = None
        core_methods = cast(DecisionEngineCoreMethods, self)
        price_fetcher = core_methods.price_fetcher
        if price is None and price_fetcher is not None:
            snapshot = price_fetcher.fetch_market_snapshot(signal)
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
        core_methods = cast(DecisionEngineCoreMethods, self)
        forecast_router: ForecastRouterV5 | None = core_methods.forecast_router
        if forecast_router is None:
            return None, None
        normalized_payload = dict(signal.payload)
        if price is not None and "price" not in normalized_payload:
            normalized_payload["price"] = price
        normalized_signal = signal.model_copy(update={"payload": normalized_payload})
        try:
            feature_vector = normalize_feature_vector_v3(normalized_signal)
        except FeatureNormalizationError:
            return None, None
        forecast_result = forecast_router.route_and_forecast(
            feature_vector=feature_vector,
            horizon=timeframe,
            event_ts=signal.event_ts,
        )
        core_methods.append_forecast_telemetry(forecast_result.telemetry)
        return forecast_result.contract.to_payload(), forecast_result.audit.to_payload()


def legacy_decision_inputs(
    *,
    signal: SignalEnvelope,
    strategy: Strategy,
) -> LegacyDecisionInputs | None:
    timeframe = signal.timeframe
    if timeframe is None:
        return None
    features = extract_signal_features(signal)
    if not has_legacy_indicator_inputs(features):
        logger.debug("Signal missing indicators for strategy %s", strategy.id)
        return None
    action_bundle = resolve_legacy_action(features)
    if action_bundle is None:
        return None
    action, rationale_parts = action_bundle
    if action not in {"buy", "sell"}:
        return None
    return LegacyDecisionInputs(
        timeframe=timeframe,
        features=features,
        action=cast(Literal["buy", "sell"], action),
        rationale_parts=list(rationale_parts),
    )


def legacy_runtime_metadata(strategy: Strategy) -> dict[str, Any]:
    runtime_definition = StrategyRuntime.definition_from_strategy(strategy)
    return {
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
    }


def log_skipped_legacy_decision(
    *,
    strategy: Strategy,
    signal: SignalEnvelope,
    action: str,
    sizing_meta: Mapping[str, Any],
) -> None:
    logger.debug(
        "Skipping non-executable legacy decision strategy_id=%s symbol=%s action=%s reason=%s",
        strategy.id,
        signal.symbol,
        action,
        sizing_meta.get("reason"),
    )


def legacy_strategy_decision(
    *,
    signal: SignalEnvelope,
    strategy: Strategy,
    inputs: LegacyDecisionInputs,
    market_context: LegacyMarketContext,
    runtime_metadata: dict[str, Any],
    sizing: LegacySizing,
) -> StrategyDecision:
    return StrategyDecision(
        strategy_id=str(strategy.id),
        symbol=signal.symbol,
        event_ts=signal.event_ts,
        timeframe=inputs.timeframe,
        action=inputs.action,
        qty=sizing.qty,
        order_type="market",
        time_in_force="day",
        rationale=",".join(inputs.rationale_parts),
        params=build_params(
            signal=signal,
            macd=inputs.features.macd,
            macd_signal=inputs.features.macd_signal,
            rsi=inputs.features.rsi,
            price=market_context.price,
            volatility=inputs.features.volatility,
            snapshot=market_context.snapshot,
            runtime_metadata=runtime_metadata,
            forecast_contract=market_context.forecast_contract,
            forecast_audit=market_context.forecast_audit,
        )
        | {"sizing": sizing.sizing_meta},
    )


class DecisionEngine(
    DecisionEngineFields,
    DecisionEngineCoreMethods,
    DecisionEngineRuntimeMethods,
):
    pass


def build_params(**kwargs: Any) -> dict[str, Any]:
    request = build_params_request(kwargs)
    params = base_decision_params(request)
    params.update(market_decision_params(request))
    params.update(forecast_decision_params(request))
    params.update(regime_decision_params(request))
    params.update(source_context_decision_params(request))
    return params


def build_params_request(kwargs: Mapping[str, Any]) -> BuildParamsRequest:
    return BuildParamsRequest(
        signal=cast(SignalEnvelope, kwargs["signal"]),
        macd=cast(Decimal | None, kwargs["macd"]),
        macd_signal=cast(Decimal | None, kwargs["macd_signal"]),
        rsi=cast(Decimal | None, kwargs["rsi"]),
        price=cast(Decimal | None, kwargs["price"]),
        volatility=cast(Decimal | None, kwargs["volatility"]),
        snapshot=cast(MarketSnapshot | None, kwargs["snapshot"]),
        runtime_metadata=cast(dict[str, Any], kwargs["runtime_metadata"]),
        forecast_contract=cast(dict[str, Any] | None, kwargs.get("forecast_contract")),
        forecast_audit=cast(dict[str, Any] | None, kwargs.get("forecast_audit")),
    )


def base_decision_params(request: BuildParamsRequest) -> dict[str, Any]:
    params: dict[str, Any] = {
        "macd": request.macd,
        "macd_signal": request.macd_signal,
        "rsi": request.rsi,
        "price": request.price,
        "signal_seq": int(request.signal.seq or 0),
        "strategy_runtime": request.runtime_metadata,
    }
    if request.volatility is not None:
        params["volatility"] = request.volatility
    return params


def market_decision_params(request: BuildParamsRequest) -> dict[str, Any]:
    if request.snapshot is None:
        return {}
    params: dict[str, Any] = {"price_snapshot": snapshot_payload(request.snapshot)}
    if request.snapshot.spread is not None:
        params["spread"] = request.snapshot.spread
    return params


def forecast_decision_params(request: BuildParamsRequest) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if request.forecast_contract is not None:
        params["forecast"] = request.forecast_contract
    if request.forecast_audit is not None:
        params["forecast_audit"] = request.forecast_audit
    return params


def regime_decision_params(request: BuildParamsRequest) -> dict[str, Any]:
    regime_context_payload, regime_route_label = resolve_regime_context(
        request.signal,
        macd=request.macd,
        macd_signal=request.macd_signal,
    )
    params: dict[str, Any] = {}
    if regime_context_payload:
        params["regime_hmm"] = regime_context_payload
    if regime_route_label is not None:
        params["regime_label"] = regime_route_label
        params["route_regime_label"] = regime_route_label
    return params


def source_context_decision_params(request: BuildParamsRequest) -> dict[str, Any]:
    params: dict[str, Any] = {}
    microstructure_state = resolve_microstructure_state_payload(request.signal)
    if microstructure_state is not None:
        params["microstructure_state"] = microstructure_state
    execution_advice = resolve_execution_advice_payload(request.signal)
    if execution_advice is not None:
        params["execution_advice"] = execution_advice
    execution_features = resolve_execution_feature_payload(request.signal)
    if execution_features is not None:
        params["execution_features"] = execution_features
    fragility_snapshot = resolve_fragility_snapshot_payload(request.signal)
    if fragility_snapshot is not None:
        params["fragility_snapshot"] = fragility_snapshot
    simulation_context = resolve_decision_simulation_context(request.signal)
    if simulation_context is not None:
        params["simulation_context"] = simulation_context
    return params


def resolve_decision_simulation_context(
    signal: SignalEnvelope,
) -> dict[str, Any] | None:
    source_context = signal.payload.get("simulation_context")
    source_context_payload: dict[str, Any] | None = None
    if isinstance(source_context, Mapping):
        source_context_payload = {
            str(key): value
            for key, value in cast(Mapping[object, Any], source_context).items()
        }
    return resolve_simulation_context(signal=signal, source=source_context_payload)


def has_explicit_regime_context(payload: Mapping[str, Any]) -> bool:
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


def resolve_regime_context(
    signal: SignalEnvelope,
    macd: Decimal | None,
    macd_signal: Decimal | None,
) -> tuple[dict[str, Any], str | None]:
    payload = signal.payload
    regime_context = resolve_hmm_context(payload)
    if not has_explicit_regime_context(payload):
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


def resolve_microstructure_state_payload(
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


def resolve_execution_advice_payload(signal: SignalEnvelope) -> dict[str, Any] | None:
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


def resolve_execution_feature_payload(
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
        key: payload.get(key) for key in feature_keys if payload.get(key) is not None
    }
    if not execution_features:
        return None
    return execution_features


def resolve_fragility_snapshot_payload(
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


def snapshot_payload(snapshot: MarketSnapshot) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of.isoformat(),
        "price": str(snapshot.price) if snapshot.price is not None else None,
        "spread": str(snapshot.spread) if snapshot.spread is not None else None,
        "source": snapshot.source,
    }


__all__ = (
    "DecisionEngine",
    "build_params",
    "BuildParamsRequest",
    "DecisionEngineRuntimeMethods",
    "LegacyDecisionInputs",
    "LegacyMarketContext",
    "LegacySizing",
    "SingleStrategyCapacityAdjustment",
    "SingleStrategyQtyContext",
    "StrategyBudget",
    "base_decision_params",
    "build_params_request",
    "forecast_decision_params",
    "has_explicit_regime_context",
    "legacy_decision_inputs",
    "legacy_runtime_metadata",
    "legacy_strategy_decision",
    "log_skipped_legacy_decision",
    "market_decision_params",
    "regime_decision_params",
    "resolve_decision_simulation_context",
    "resolve_execution_advice_payload",
    "resolve_execution_feature_payload",
    "resolve_fragility_snapshot_payload",
    "resolve_microstructure_state_payload",
    "resolve_qty",
    "resolve_regime_context",
    "resolve_single_strategy_qty_from_context",
    "single_strategy_budget",
    "single_strategy_capacity_adjustment",
    "single_strategy_capacity_exhausted_result",
    "single_strategy_capacity_reason",
    "single_strategy_common_meta",
    "single_strategy_exit_guard_result",
    "single_strategy_min_qty_capacity_reason",
    "single_strategy_min_qty_result",
    "single_strategy_qty_context",
    "single_strategy_requested_qty",
    "single_strategy_short_entry_below_min_result",
    "single_strategy_success_result",
    "skip_non_executable_decision_qty",
    "snapshot_payload",
    "source_context_decision_params",
)
