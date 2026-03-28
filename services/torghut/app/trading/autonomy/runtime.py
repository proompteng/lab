"""Autonomous strategy runtime scaffolding for Torghut v3."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_DOWN
from typing import Any, Protocol, cast

from ..features import (
    FeatureNormalizationError,
    FeatureVectorV3,
    normalize_feature_vector_v3,
    validate_declared_features,
)
from ..intraday_tsmom_contract import evaluate_intraday_tsmom_signal, validate_intraday_tsmom_params
from ..models import SignalEnvelope, StrategyDecision
from ..strategy_specs import build_compiled_strategy_artifacts, strategy_type_supports_spec_v2

logger = logging.getLogger(__name__)


def _empty_meta() -> dict[str, Any]:
    return {}


@dataclass(frozen=True)
class StrategyRuntimeConfig:
    """Deterministic strategy runtime definition loaded from autonomous config."""

    strategy_id: str
    strategy_type: str
    version: str
    params: dict[str, Any]
    base_timeframe: str = '1Min'
    enabled: bool = True
    priority: int = 100
    compiler_source: str = 'legacy_runtime'
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)
    compiled_targets: dict[str, Any] = field(default_factory=_empty_meta)


@dataclass(frozen=True)
class StrategyContext:
    """Plugin execution context."""

    strategy_id: str
    strategy_type: str
    version: str
    params: dict[str, Any]
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)


@dataclass(frozen=True)
class StrategyIntent:
    """Broker-neutral intent emitted by strategy plugins."""

    strategy_id: str
    symbol: str
    direction: str
    confidence: Decimal
    target_qty: Decimal
    horizon: str
    rationale: list[str]
    meta: dict[str, Any] = field(default_factory=_empty_meta)


@dataclass(frozen=True)
class RuntimeEvaluationResult:
    """Evaluation result for a signal event."""

    decisions: list[StrategyDecision]
    errors: list[str]
    normalized: FeatureVectorV3 | None


class StrategyPlugin(Protocol):
    """Runtime contract for strategy plugins."""

    strategy_type: str
    version: str

    def validate_params(self, params: dict[str, Any]) -> None:
        ...

    def required_features(self) -> set[str]:
        ...

    def warmup_bars(self) -> int:
        ...

    def on_event(self, fv: FeatureVectorV3, ctx: StrategyContext) -> StrategyIntent | None:
        ...


class StrategyPluginRegistry:
    """Registry for strategy plugin families."""

    def __init__(self) -> None:
        self._plugins: dict[tuple[str, str], StrategyPlugin] = {}

    def register(self, plugin: StrategyPlugin) -> None:
        self._plugins[(plugin.strategy_type, plugin.version)] = plugin

    def get(self, strategy_type: str, version: str) -> StrategyPlugin | None:
        return self._plugins.get((strategy_type, version))


class LegacyMacdRsiPlugin:
    """Compatibility plugin implementing legacy MACD/RSI logic."""

    strategy_type = 'legacy_macd_rsi'
    version = '1.0.0'

    def validate_params(self, params: dict[str, Any]) -> None:
        buy_rsi = _decimal(params.get('buy_rsi_threshold', Decimal('35')))
        sell_rsi = _decimal(params.get('sell_rsi_threshold', Decimal('65')))
        if buy_rsi is None or sell_rsi is None:
            raise ValueError('invalid_rsi_threshold')

    def required_features(self) -> set[str]:
        return {'macd', 'macd_signal', 'rsi14', 'price'}

    def warmup_bars(self) -> int:
        return 0

    def on_event(self, fv: FeatureVectorV3, ctx: StrategyContext) -> StrategyIntent | None:
        macd = _decimal(fv.values.get('macd'))
        macd_signal = _decimal(fv.values.get('macd_signal'))
        rsi14 = _decimal(fv.values.get('rsi14'))
        if macd is None or macd_signal is None or rsi14 is None:
            return None

        buy_rsi = _decimal(ctx.params.get('buy_rsi_threshold', Decimal('35'))) or Decimal('35')
        sell_rsi = _decimal(ctx.params.get('sell_rsi_threshold', Decimal('65'))) or Decimal('65')
        qty = _decimal(ctx.params.get('qty', Decimal('1'))) or Decimal('1')

        if macd > macd_signal and rsi14 < buy_rsi:
            return StrategyIntent(
                strategy_id=ctx.strategy_id,
                symbol=fv.symbol,
                direction='long',
                confidence=Decimal('0.70'),
                target_qty=qty,
                horizon='intraday',
                rationale=['macd_cross_up', 'rsi_oversold'],
                meta={
                    'strategy_type': ctx.strategy_type,
                    'schema': fv.feature_schema_version,
                    'feature_hash': fv.normalization_hash,
                    'compiler_source': 'spec_v2' if ctx.strategy_spec else 'legacy_runtime',
                },
            )

        if macd < macd_signal and rsi14 > sell_rsi:
            return StrategyIntent(
                strategy_id=ctx.strategy_id,
                symbol=fv.symbol,
                direction='short',
                confidence=Decimal('0.70'),
                target_qty=qty,
                horizon='intraday',
                rationale=['macd_cross_down', 'rsi_overbought'],
                meta={
                    'strategy_type': ctx.strategy_type,
                    'schema': fv.feature_schema_version,
                    'feature_hash': fv.normalization_hash,
                },
            )

        return None


class IntradayTsmomV1Plugin:
    """Intraday momentum plugin with volatility gating and confidence shaping."""

    strategy_type = 'intraday_tsmom_v1'
    version = '1.1.0'

    def validate_params(self, params: dict[str, Any]) -> None:
        validate_intraday_tsmom_params(params)

    def required_features(self) -> set[str]:
        return {'price', 'ema12', 'ema26', 'macd', 'macd_signal', 'rsi14', 'vol_realized_w60s'}

    def warmup_bars(self) -> int:
        return 0

    def on_event(self, fv: FeatureVectorV3, ctx: StrategyContext) -> StrategyIntent | None:
        price = _decimal(fv.values.get('price'))
        ema12 = _decimal(fv.values.get('ema12'))
        ema26 = _decimal(fv.values.get('ema26'))
        macd = _decimal(fv.values.get('macd'))
        macd_signal = _decimal(fv.values.get('macd_signal'))
        rsi14 = _decimal(fv.values.get('rsi14'))
        vol = _decimal(fv.values.get('vol_realized_w60s'))
        evaluation = evaluate_intraday_tsmom_signal(
            timeframe=fv.timeframe,
            params=ctx.params,
            event_ts=fv.event_ts,
            price=price,
            spread=_decimal(fv.values.get('spread')),
            ema12=ema12,
            ema26=ema26,
            macd=macd,
            macd_signal=macd_signal,
            rsi14=rsi14,
            vol_realized_w60s=vol,
        )
        if evaluation is None:
            return None

        return StrategyIntent(
            strategy_id=ctx.strategy_id,
            symbol=fv.symbol,
            direction=evaluation.direction,
            confidence=min(
                evaluation.confidence,
                Decimal('0.84') if evaluation.direction == 'long' else Decimal('0.80'),
            ),
            target_qty=_decimal(ctx.params.get('qty')) or Decimal('1'),
            horizon='intraday',
            rationale=list(evaluation.rationale),
            meta={
                'strategy_type': ctx.strategy_type,
                'schema': fv.feature_schema_version,
                'feature_hash': fv.normalization_hash,
                'macd_hist': str(evaluation.macd_hist),
                'compiler_source': 'spec_v2' if ctx.strategy_spec else 'legacy_runtime',
            },
        )


class StrategyRuntime:
    """Evaluate enabled strategy plugins against normalized features."""

    def __init__(self, registry: StrategyPluginRegistry | None = None) -> None:
        self.registry = registry or StrategyPluginRegistry()

    def evaluate(self, signal: SignalEnvelope, strategies: list[StrategyRuntimeConfig]) -> RuntimeEvaluationResult:
        errors: list[str] = []
        try:
            fv = normalize_feature_vector_v3(signal)
        except FeatureNormalizationError as exc:
            return RuntimeEvaluationResult(decisions=[], errors=[f'feature_normalization_failed:{exc}'], normalized=None)

        decisions: list[StrategyDecision] = []
        ordered = sorted(strategies, key=lambda item: (item.priority, item.strategy_id))
        for strategy in ordered:
            if not strategy.enabled:
                continue
            if signal.timeframe is None or signal.timeframe != strategy.base_timeframe:
                continue

            plugin = self.registry.get(strategy.strategy_type, strategy.version)
            if plugin is None:
                errors.append(f'plugin_not_found:{strategy.strategy_type}@{strategy.version}')
                continue

            context = StrategyContext(
                strategy_id=strategy.strategy_id,
                strategy_type=strategy.strategy_type,
                version=strategy.version,
                params=dict(strategy.params),
                strategy_spec=dict(strategy.strategy_spec),
            )

            try:
                plugin.validate_params(context.params)
                declared = plugin.required_features()
                declared_valid, unknown_declared = validate_declared_features(declared)
                if not declared_valid:
                    errors.append(
                        f'declared_features_not_in_schema:{strategy.strategy_id}:{"|".join(unknown_declared)}'
                    )
                    continue
                missing = [feature for feature in declared if fv.values.get(feature) is None]
                if missing:
                    errors.append(f'missing_features:{strategy.strategy_id}:{"|".join(sorted(missing))}')
                    continue
                intent = plugin.on_event(fv, context)
            except Exception as exc:  # defensive per-plugin isolation
                logger.exception('strategy plugin failed strategy_id=%s', strategy.strategy_id)
                errors.append(f'plugin_error:{strategy.strategy_id}:{type(exc).__name__}')
                continue

            if intent is None:
                continue

            decision = _intent_to_decision(intent, signal)
            decisions.append(decision)

        decisions.sort(key=lambda item: (item.strategy_id, item.symbol, item.action))
        return RuntimeEvaluationResult(decisions=decisions, errors=errors, normalized=fv)


def default_runtime_registry() -> StrategyPluginRegistry:
    registry = StrategyPluginRegistry()
    registry.register(LegacyMacdRsiPlugin())
    registry.register(IntradayTsmomV1Plugin())
    return registry


def _intent_to_decision(intent: StrategyIntent, signal: SignalEnvelope) -> StrategyDecision:
    action = 'buy' if intent.direction == 'long' else 'sell'
    qty = intent.target_qty.quantize(Decimal('1'), rounding=ROUND_DOWN)
    if qty <= 0:
        qty = Decimal('1')

    return StrategyDecision(
        strategy_id=intent.strategy_id,
        symbol=intent.symbol,
        event_ts=signal.event_ts,
        timeframe=signal.timeframe or '1Min',
        action=action,
        qty=qty,
        order_type='market',
        time_in_force='day',
        rationale=','.join(intent.rationale) if intent.rationale else None,
        params={
            'runtime': {
                'strategy_type': intent.meta.get('strategy_type'),
                'schema': intent.meta.get('schema'),
                'confidence': str(intent.confidence),
                'horizon': intent.horizon,
                'compiler_source': intent.meta.get('compiler_source'),
            },
            'feature_hash': intent.meta.get('feature_hash'),
        },
    )


def compile_runtime_config(config: StrategyRuntimeConfig) -> StrategyRuntimeConfig:
    if not strategy_type_supports_spec_v2(config.strategy_type):
        return config
    compiled = build_compiled_strategy_artifacts(
        strategy_id=config.strategy_id,
        strategy_type=config.strategy_type,
        semantic_version=config.version,
        params=config.params,
        base_timeframe=config.base_timeframe,
        source='spec_v2',
    )
    shadow_runtime = dict(compiled.shadow_runtime_config)
    params = shadow_runtime.get('params', config.params)
    return StrategyRuntimeConfig(
        strategy_id=config.strategy_id,
        strategy_type=str(shadow_runtime.get('strategy_type', config.strategy_type)),
        version=str(shadow_runtime.get('version', config.version)),
        params=cast(dict[str, Any], params) if isinstance(params, dict) else dict(config.params),
        base_timeframe=str(shadow_runtime.get('base_timeframe', config.base_timeframe)),
        enabled=config.enabled,
        priority=config.priority,
        compiler_source='spec_v2',
        strategy_spec=compiled.strategy_spec.to_payload(),
        compiled_targets={
            'evaluator_config': compiled.evaluator_config,
            'shadow_runtime_config': compiled.shadow_runtime_config,
            'live_runtime_config': compiled.live_runtime_config,
            'promotion_metadata': compiled.promotion_metadata,
        },
    )


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


__all__ = [
    'LegacyMacdRsiPlugin',
    'IntradayTsmomV1Plugin',
    'RuntimeEvaluationResult',
    'StrategyContext',
    'StrategyIntent',
    'StrategyPlugin',
    'StrategyPluginRegistry',
    'StrategyRuntime',
    'StrategyRuntimeConfig',
    'compile_runtime_config',
    'default_runtime_registry',
]
