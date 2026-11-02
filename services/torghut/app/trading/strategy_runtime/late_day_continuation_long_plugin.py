"""Strategy runtime scaffolding for deterministic plugin execution."""

from __future__ import annotations

import hashlib
import json
import time
from decimal import Decimal
from typing import Any, cast

from ...models import Strategy
from ...strategies.catalog import extract_catalog_metadata
from ..evaluation_trace import StrategyTrace
from ..features import FeatureVectorV3, validate_declared_features
from ..research_sleeves import (
    evaluate_end_of_day_reversal_long,
    evaluate_late_day_continuation_long,
)
from ..strategy_specs import (
    build_compiled_strategy_artifacts,
    strategy_type_supports_spec_v2,
)


from .empty_meta import (
    plugin_result_from_sleeve_result as _plugin_result_from_sleeve_result,
)
from .evaluate_microbar_cross_sectional import (
    PluginEvaluationResult,
    RuntimeDecision,
    RuntimeErrorRecord,
    RuntimeEvaluation,
    RuntimeObservation,
    StrategyContext,
    StrategyDefinition,
    StrategyIntent,
)
from .coerce_plugin_result import (
    IntentAggregator,
    StrategyRegistry,
    coerce_plugin_result as _coerce_plugin_result,
    trace_suppression_reason as _trace_suppression_reason,
)


class LateDayContinuationLongPlugin:
    plugin_id = "late_day_continuation_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "ema26",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "spread_bps",
        "imbalance_bid_sz",
        "imbalance_ask_sz",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_position_in_session_range",
        "price_vs_vwap_w5m_bps",
        "session_high_price",
        "opening_range_high",
        "price_vs_opening_range_high_bps",
        "price_vs_opening_window_close_bps",
        "recent_spread_bps_avg",
        "recent_imbalance_pressure_avg",
        "session_range_bps",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "recent_above_opening_window_close_ratio",
        "cross_section_positive_session_open_ratio",
        "cross_section_positive_opening_window_return_ratio",
        "cross_section_positive_prev_session_close_ratio",
        "cross_section_positive_opening_window_return_from_prev_close_ratio",
        "cross_section_above_vwap_w5m_ratio",
        "cross_section_continuation_breadth",
        "cross_section_session_open_rank",
        "cross_section_opening_window_return_rank",
        "cross_section_prev_session_close_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_range_position_rank",
        "cross_section_vwap_w5m_rank",
        "cross_section_recent_imbalance_rank",
        "cross_section_continuation_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_late_day_continuation_long(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            ema26=_decimal(features.values.get("ema26")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(
                features.values.get("price_vs_session_open_bps")
            ),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(
                features.values.get("opening_window_return_bps")
            ),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(
                features.values.get("price_position_in_session_range")
            ),
            price_vs_vwap_w5m_bps=_decimal(
                features.values.get("price_vs_vwap_w5m_bps")
            ),
            session_high_price=_decimal(features.values.get("session_high_price")),
            opening_range_high=_decimal(features.values.get("opening_range_high")),
            price_vs_opening_range_high_bps=_decimal(
                features.values.get("price_vs_opening_range_high_bps")
            ),
            price_vs_opening_window_close_bps=_decimal(
                features.values.get("price_vs_opening_window_close_bps")
            ),
            recent_spread_bps_avg=_decimal(
                features.values.get("recent_spread_bps_avg")
            ),
            recent_imbalance_pressure_avg=_decimal(
                features.values.get("recent_imbalance_pressure_avg")
            ),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_quote_invalid_ratio=_decimal(
                features.values.get("recent_quote_invalid_ratio")
            ),
            recent_quote_jump_bps_max=_decimal(
                features.values.get("recent_quote_jump_bps_max")
            ),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            recent_above_opening_range_high_ratio=_decimal(
                features.values.get("recent_above_opening_range_high_ratio")
            ),
            recent_above_opening_window_close_ratio=_decimal(
                features.values.get("recent_above_opening_window_close_ratio")
            ),
            recent_above_vwap_w5m_ratio=_decimal(
                features.values.get("recent_above_vwap_w5m_ratio")
            ),
            cross_section_positive_session_open_ratio=_decimal(
                features.values.get("cross_section_positive_session_open_ratio")
            ),
            cross_section_positive_opening_window_return_ratio=_decimal(
                features.values.get(
                    "cross_section_positive_opening_window_return_ratio"
                )
            ),
            cross_section_positive_prev_session_close_ratio=_decimal(
                features.values.get("cross_section_positive_prev_session_close_ratio")
            ),
            cross_section_positive_opening_window_return_from_prev_close_ratio=_decimal(
                features.values.get(
                    "cross_section_positive_opening_window_return_from_prev_close_ratio"
                )
            ),
            cross_section_above_vwap_w5m_ratio=_decimal(
                features.values.get("cross_section_above_vwap_w5m_ratio")
            ),
            cross_section_continuation_breadth=_decimal(
                features.values.get("cross_section_continuation_breadth")
            ),
            cross_section_session_open_rank=_decimal(
                features.values.get("cross_section_session_open_rank")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_prev_session_close_rank=_decimal(
                features.values.get("cross_section_prev_session_close_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get(
                    "cross_section_opening_window_return_from_prev_close_rank"
                )
            ),
            cross_section_range_position_rank=_decimal(
                features.values.get("cross_section_range_position_rank")
            ),
            cross_section_vwap_w5m_rank=_decimal(
                features.values.get("cross_section_vwap_w5m_rank")
            ),
            cross_section_recent_imbalance_rank=_decimal(
                features.values.get("cross_section_recent_imbalance_rank")
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
        )
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
        )


class EndOfDayReversalLongPlugin:
    plugin_id = "end_of_day_reversal_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "ema26",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "vwap_session",
        "spread_bps",
        "imbalance_bid_sz",
        "imbalance_ask_sz",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_position_in_session_range",
        "price_vs_opening_range_low_bps",
        "session_range_bps",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "cross_section_opening_window_return_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_continuation_rank",
        "cross_section_reversal_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_end_of_day_reversal_long(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            ema26=_decimal(features.values.get("ema26")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            vwap_session=_decimal(features.values.get("vwap_session")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(
                features.values.get("price_vs_session_open_bps")
            ),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(
                features.values.get("opening_window_return_bps")
            ),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(
                features.values.get("price_position_in_session_range")
            ),
            price_vs_opening_range_low_bps=_decimal(
                features.values.get("price_vs_opening_range_low_bps")
            ),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(
                features.values.get("recent_spread_bps_avg")
            ),
            recent_spread_bps_max=_decimal(
                features.values.get("recent_spread_bps_max")
            ),
            recent_imbalance_pressure_avg=_decimal(
                features.values.get("recent_imbalance_pressure_avg")
            ),
            recent_quote_invalid_ratio=_decimal(
                features.values.get("recent_quote_invalid_ratio")
            ),
            recent_quote_jump_bps_max=_decimal(
                features.values.get("recent_quote_jump_bps_max")
            ),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get(
                    "cross_section_opening_window_return_from_prev_close_rank"
                )
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
            cross_section_reversal_rank=_decimal(
                features.values.get("cross_section_reversal_rank")
            ),
        )
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
        )


class StrategyRuntime:
    """Deterministic strategy plugin runtime with failure isolation."""

    def __init__(
        self,
        *,
        registry: StrategyRegistry | None = None,
        aggregator: IntentAggregator | None = None,
        trace_enabled: bool = False,
    ) -> None:
        self.registry = registry or StrategyRegistry()
        self.aggregator = aggregator or IntentAggregator()
        self.trace_enabled = trace_enabled

    def evaluate(
        self, strategy: Strategy, features: FeatureVectorV3, *, timeframe: str
    ) -> RuntimeDecision | None:
        definition = self.definition_from_strategy(strategy)
        if (
            definition.universe_symbols
            and features.symbol not in definition.universe_symbols
        ):
            return None
        plugin = self.registry.resolve(definition)
        if plugin is None:
            return None
        declared_valid, _ = validate_declared_features(plugin.required_features)
        if not declared_valid:
            return None
        context = StrategyContext(
            strategy_id=definition.strategy_id,
            strategy_name=definition.strategy_name,
            declared_strategy_id=definition.declared_strategy_id,
            strategy_type=definition.strategy_type,
            strategy_version=definition.version,
            event_ts=features.event_ts.isoformat(),
            symbol=features.symbol,
            timeframe=timeframe,
            params=definition.params,
            trace_enabled=self.trace_enabled,
            strategy_spec=dict(definition.strategy_spec),
        )
        plugin_result = _coerce_plugin_result(plugin.evaluate(context, features))
        if plugin_result.intent is None:
            return None
        return RuntimeDecision(
            intent=plugin_result.intent,
            trace=plugin_result.trace,
            strategy_row_id=definition.strategy_id,
            declared_strategy_id=definition.declared_strategy_id,
            strategy_name=definition.strategy_name,
            strategy_type=definition.strategy_type,
            strategy_version=definition.version,
            plugin_id=plugin.plugin_id,
            plugin_version=plugin.version,
            parameter_hash=self._parameter_hash(context.params),
            feature_hash=features.normalization_hash,
            compiler_source=definition.compiler_source,
            strategy_spec=dict(definition.strategy_spec),
            compiled_targets=dict(definition.compiled_targets),
        )

    def evaluate_all(
        self, strategies: list[Strategy], features: FeatureVectorV3, *, timeframe: str
    ) -> RuntimeEvaluation:
        raw_intents: list[RuntimeDecision] = []
        traces: list[StrategyTrace] = []
        errors: list[RuntimeErrorRecord] = []
        observation = RuntimeObservation()
        all_intents: list[StrategyIntent] = []

        sorted_definitions = sorted(
            [
                self.definition_from_strategy(strategy)
                for strategy in strategies
                if strategy.enabled
            ],
            key=lambda item: item.strategy_id,
        )
        for definition in sorted_definitions:
            if definition.base_timeframe != timeframe:
                continue
            if (
                definition.universe_symbols
                and features.symbol not in definition.universe_symbols
            ):
                continue
            start = time.perf_counter()
            if self.registry.is_degraded(
                definition.strategy_id, event_ts=features.event_ts
            ):
                observation.record_error(definition.strategy_id)
                errors.append(
                    RuntimeErrorRecord(
                        strategy_id=definition.strategy_id,
                        strategy_type=definition.strategy_type,
                        plugin_id="circuit_breaker",
                        reason="strategy_degraded",
                    )
                )
                continue

            plugin = self.registry.resolve(definition)
            if plugin is None:
                observation.record_error(definition.strategy_id)
                errors.append(
                    RuntimeErrorRecord(
                        strategy_id=definition.strategy_id,
                        strategy_type=definition.strategy_type,
                        plugin_id="unregistered",
                        reason="plugin_not_found",
                    )
                )
                continue

            context = StrategyContext(
                strategy_id=definition.strategy_id,
                strategy_name=definition.strategy_name,
                declared_strategy_id=definition.declared_strategy_id,
                strategy_type=definition.strategy_type,
                strategy_version=definition.version,
                event_ts=features.event_ts.isoformat(),
                symbol=features.symbol,
                timeframe=timeframe,
                params=definition.params,
                trace_enabled=self.trace_enabled,
                strategy_spec=dict(definition.strategy_spec),
            )

            try:
                plugin_result = _coerce_plugin_result(
                    plugin.evaluate(context, features)
                )
                latency_ms = int((time.perf_counter() - start) * 1000)
                observation.record_event(definition.strategy_id, latency_ms)
                self.registry.record_success(definition.strategy_id)
                if plugin_result.trace is not None:
                    traces.append(plugin_result.trace)
                if plugin_result.intent is None:
                    observation.record_intent_suppression(
                        definition.strategy_id,
                        _trace_suppression_reason(plugin_result.trace),
                    )
                    continue
                decision = RuntimeDecision(
                    intent=plugin_result.intent,
                    trace=plugin_result.trace,
                    strategy_row_id=definition.strategy_id,
                    declared_strategy_id=definition.declared_strategy_id,
                    strategy_name=definition.strategy_name,
                    strategy_type=definition.strategy_type,
                    strategy_version=definition.version,
                    plugin_id=plugin.plugin_id,
                    plugin_version=plugin.version,
                    parameter_hash=self._parameter_hash(context.params),
                    feature_hash=features.normalization_hash,
                    compiler_source=definition.compiler_source,
                    strategy_spec=dict(definition.strategy_spec),
                    compiled_targets=dict(definition.compiled_targets),
                )
                raw_intents.append(decision)
                all_intents.append(plugin_result.intent)
                observation.record_intent(definition.strategy_id)
            except Exception as exc:
                latency_ms = int((time.perf_counter() - start) * 1000)
                observation.record_event(definition.strategy_id, latency_ms)
                observation.record_error(definition.strategy_id)
                self.registry.record_error(
                    definition.strategy_id, event_ts=features.event_ts
                )
                errors.append(
                    RuntimeErrorRecord(
                        strategy_id=definition.strategy_id,
                        strategy_type=definition.strategy_type,
                        plugin_id=plugin.plugin_id,
                        reason=type(exc).__name__,
                    )
                )

        aggregated_intents, conflicts = self.aggregator.aggregate(all_intents)
        observation.intent_conflicts_total = conflicts
        return RuntimeEvaluation(
            intents=aggregated_intents,
            raw_intents=raw_intents,
            traces=traces,
            errors=errors,
            observation=observation,
        )

    @staticmethod
    def definition_from_strategy(strategy: Strategy) -> StrategyDefinition:
        catalog_metadata = StrategyRuntime._catalog_metadata(strategy)
        strategy_type = StrategyRuntime._strategy_plugin_type(strategy)
        version = StrategyRuntime._strategy_version(strategy)
        params = StrategyRuntime._strategy_params(strategy)
        compiler_source = str(
            catalog_metadata.get("compiler_source") or "legacy_runtime"
        )
        strategy_spec = (
            cast(dict[str, Any], catalog_metadata.get("strategy_spec_v2"))
            if isinstance(catalog_metadata.get("strategy_spec_v2"), dict)
            else {}
        )
        compiled_targets = (
            cast(dict[str, Any], catalog_metadata.get("compiled_targets"))
            if isinstance(catalog_metadata.get("compiled_targets"), dict)
            else {}
        )
        declared_strategy_id = str(
            catalog_metadata.get("strategy_id") or ""
        ).strip() or str(strategy.name)
        if strategy_type_supports_spec_v2(strategy_type):
            compiler_source = "spec_v2"
            if not strategy_spec or not compiled_targets:
                raw_universe_symbols: object = strategy.universe_symbols
                universe_symbols: list[str] | None = None
                if isinstance(raw_universe_symbols, list):
                    universe_symbols = []
                    for raw_item in cast(list[object], raw_universe_symbols):
                        item_text = str(raw_item).strip()
                        if item_text:
                            universe_symbols.append(item_text)
                compiled = build_compiled_strategy_artifacts(
                    strategy_id=declared_strategy_id,
                    strategy_type=strategy_type,
                    semantic_version=version,
                    params=params,
                    base_timeframe=str(strategy.base_timeframe),
                    universe_symbols=universe_symbols,
                    source="spec_v2",
                )
                strategy_spec = compiled.strategy_spec.to_payload()
                compiled_targets = {
                    "evaluator_config": compiled.evaluator_config,
                    "shadow_runtime_config": compiled.shadow_runtime_config,
                    "live_runtime_config": compiled.live_runtime_config,
                    "promotion_metadata": compiled.promotion_metadata,
                }
        return StrategyDefinition(
            strategy_id=str(strategy.id),
            strategy_name=str(strategy.name),
            declared_strategy_id=declared_strategy_id,
            strategy_type=strategy_type,
            version=version,
            params=params,
            feature_requirements=("macd", "macd_signal", "rsi14", "price"),
            risk_profile="default",
            execution_profile="market",
            enabled=bool(strategy.enabled),
            base_timeframe=str(strategy.base_timeframe),
            universe_symbols=StrategyRuntime._normalized_universe_symbols(strategy),
            compiler_source=compiler_source,
            strategy_spec=strategy_spec,
            compiled_targets=compiled_targets,
        )

    @staticmethod
    def _strategy_plugin_type(strategy: Strategy) -> str:
        metadata = StrategyRuntime._catalog_metadata(strategy)
        metadata_type = str(metadata.get("strategy_type") or "").strip()
        if metadata_type:
            return str(metadata_type)
        raw = getattr(strategy, "universe_type", None)
        if not raw:
            return "legacy_macd_rsi"
        if str(raw) in {"static", "legacy_macd_rsi"}:
            return "legacy_macd_rsi"
        if str(raw) in {"intraday_tsmom", "intraday_tsmom_v1", "tsmom_intraday"}:
            return "intraday_tsmom_v1"
        return str(raw)

    @staticmethod
    def _strategy_version(strategy: Strategy) -> str:
        metadata = StrategyRuntime._catalog_metadata(strategy)
        metadata_version = str(metadata.get("version") or "").strip()
        if metadata_version:
            return metadata_version
        if strategy.description:
            description = str(strategy.description)
            if "version=" in description:
                segments = [segment.strip() for segment in description.split(",")]
                for segment in segments:
                    if segment.startswith("version="):
                        return segment.split("=", 1)[1] or "1.0.0"
            marker_start = description.rfind("@")
            marker_end = description.rfind(")")
            if marker_start >= 0:
                candidate_end = (
                    marker_end if marker_end > marker_start else len(description)
                )
                candidate = description[marker_start + 1 : candidate_end].strip()
                if candidate:
                    return candidate
            tokens = description.split()
            if tokens:
                last = tokens[-1].lstrip("v")
                if last and any(ch.isdigit() for ch in last):
                    return last
        return "1.0.0"

    @staticmethod
    def _strategy_params(strategy: Strategy) -> dict[str, Any]:
        metadata = StrategyRuntime._catalog_metadata(strategy)
        params = (
            dict(cast(dict[str, Any], metadata.get("params")))
            if isinstance(metadata.get("params"), dict)
            else {}
        )
        params.setdefault(
            "max_position_pct_equity",
            str(strategy.max_position_pct_equity)
            if strategy.max_position_pct_equity is not None
            else None,
        )
        params.setdefault(
            "max_notional_per_trade",
            str(strategy.max_notional_per_trade)
            if strategy.max_notional_per_trade is not None
            else None,
        )
        params.setdefault("base_timeframe", strategy.base_timeframe)
        params.setdefault("universe_symbols", strategy.universe_symbols)
        return params

    @staticmethod
    def _normalized_universe_symbols(strategy: Strategy) -> tuple[str, ...]:
        raw = strategy.universe_symbols
        if not isinstance(raw, list):
            return ()
        values: list[str] = []
        for item in cast(list[object], raw):
            text = str(item).strip().upper()
            if text:
                values.append(text)
        return tuple(values)

    @staticmethod
    def _catalog_metadata(strategy: Strategy) -> dict[str, Any]:
        return extract_catalog_metadata(
            str(strategy.description) if strategy.description is not None else None
        )

    @staticmethod
    def _parameter_hash(params: dict[str, Any]) -> str:
        payload = json.dumps(params, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


__all__ = (
    "LateDayContinuationLongPlugin",
    "EndOfDayReversalLongPlugin",
    "StrategyRuntime",
)
