# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Strategy runtime scaffolding for deterministic plugin execution."""

from __future__ import annotations

import hashlib
import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal, Protocol, cast

from ...models import Strategy
from ...strategies.catalog import extract_catalog_metadata
from ..evaluation_trace import GateTrace, StrategyTrace, ThresholdTrace
from ..features import FeatureVectorV3, validate_declared_features
from ..intraday_tsmom_contract import evaluate_intraday_tsmom_signal
from ..research_sleeves import (
    SleeveSignalEvaluation,
    SleeveSignalResult,
    evaluate_breakout_continuation_long,
    evaluate_end_of_day_reversal_long,
    evaluate_late_day_continuation_long,
    evaluate_mean_reversion_exhaustion_short,
    evaluate_mean_reversion_rebound_long,
    evaluate_momentum_pullback_long,
    evaluate_washout_rebound_long,
)
from ..session_context import regular_session_minutes_elapsed
from ..strategy_specs import (
    build_compiled_strategy_artifacts,
    strategy_type_supports_spec_v2,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_empty_meta import *
from .part_02_evaluate_microbar_cross_sectional import *


def _coerce_plugin_result(
    result: PluginEvaluationResult | StrategyIntent | None,
) -> PluginEvaluationResult:
    if isinstance(result, PluginEvaluationResult):
        return result
    if result is None:
        return PluginEvaluationResult(intent=None, trace=None)
    return PluginEvaluationResult(intent=result, trace=None)


def _trace_suppression_reason(trace: StrategyTrace | None) -> str:
    if trace is None:
        return "no_runtime_intent"
    failed_gate = trace.first_failed_gate
    selected_gate = trace.gates[0] if trace.gates else None
    gate = failed_gate or (selected_gate.gate if selected_gate is not None else "")
    reason = ""
    if selected_gate is not None:
        raw_reason = selected_gate.context.get("reason")
        if raw_reason is not None:
            reason = str(raw_reason).strip()
    if gate and reason:
        return f"{gate}:{reason}"
    if gate:
        return gate
    return "no_runtime_intent"


@dataclass
class _CircuitState:
    consecutive_errors: int = 0
    degraded_until: datetime | None = None


class StrategyRegistry:
    def __init__(
        self,
        plugins: dict[str, StrategyPlugin] | None = None,
        *,
        circuit_error_threshold: int = 3,
        cooldown_seconds: int = 300,
    ) -> None:
        plugin_map = plugins or {
            "legacy_macd_rsi": LegacyMacdRsiPlugin(),
            "intraday_tsmom_v1": IntradayTsmomPlugin(),
            "momentum_pullback_long_v1": MomentumPullbackLongPlugin(),
            "breakout_continuation_long_v1": BreakoutContinuationLongPlugin(),
            "mean_reversion_rebound_long_v1": MeanReversionReboundLongPlugin(),
            "mean_reversion_exhaustion_short_v1": MeanReversionExhaustionShortPlugin(),
            "microbar_cross_sectional_long_v1": MicrobarCrossSectionalLongPlugin(),
            "microbar_cross_sectional_short_v1": MicrobarCrossSectionalShortPlugin(),
            "microbar_cross_sectional_pairs_v1": MicrobarCrossSectionalPairsPlugin(),
            "washout_rebound_long_v1": WashoutReboundLongPlugin(),
            "late_day_continuation_long_v1": LateDayContinuationLongPlugin(),
            "end_of_day_reversal_long_v1": EndOfDayReversalLongPlugin(),
        }
        self._by_key: dict[tuple[str, str], StrategyPlugin] = {}
        self._type_alias: dict[str, tuple[str, str]] = {}
        for alias, plugin in plugin_map.items():
            normalized_alias = alias.strip()
            self._type_alias[normalized_alias] = (plugin.plugin_id, plugin.version)
            self._by_key[(plugin.plugin_id, plugin.version)] = plugin
        self.circuit_error_threshold = max(1, circuit_error_threshold)
        self.cooldown_seconds = max(1, cooldown_seconds)
        self._circuit_state: dict[str, _CircuitState] = {}

    def resolve(self, definition: StrategyDefinition) -> StrategyPlugin | None:
        explicit = self._by_key.get((definition.strategy_type, definition.version))
        if explicit is not None:
            return explicit
        alias = self._type_alias.get(definition.strategy_type)
        if alias is not None:
            return self._by_key.get(alias)
        # Deterministic fallback: pin the lowest lexical version for a matching strategy type.
        candidates = sorted(
            [
                (plugin_id, plugin_version)
                for plugin_id, plugin_version in self._by_key
                if plugin_id == definition.strategy_type
            ]
        )
        if not candidates:
            return None
        return self._by_key[candidates[0]]

    def is_degraded(self, strategy_id: str, *, event_ts: datetime) -> bool:
        state = self._circuit_state.get(strategy_id)
        if state is None or state.degraded_until is None:
            return False
        return event_ts.astimezone(timezone.utc) <= state.degraded_until

    def record_success(self, strategy_id: str) -> None:
        state = self._circuit_state.get(strategy_id)
        if state is None:
            return
        state.consecutive_errors = 0

    def record_error(self, strategy_id: str, *, event_ts: datetime) -> None:
        state = self._circuit_state.setdefault(strategy_id, _CircuitState())
        state.consecutive_errors += 1
        if state.consecutive_errors >= self.circuit_error_threshold:
            state.degraded_until = event_ts.astimezone(timezone.utc) + timedelta(
                seconds=self.cooldown_seconds
            )
            state.consecutive_errors = 0


class IntentAggregator:
    """Aggregate strategy intents to one symbol-level direction deterministically."""

    def aggregate(
        self, intents: list[StrategyIntent]
    ) -> tuple[list[AggregatedIntent], int]:
        grouped: dict[tuple[str, str], list[StrategyIntent]] = defaultdict(list)
        for intent in intents:
            grouped[(intent.symbol, intent.horizon)].append(intent)

        aggregated: list[AggregatedIntent] = []
        conflicts = 0
        for (symbol, horizon), bucket in sorted(grouped.items()):
            ranked = sorted(
                bucket,
                key=lambda item: (
                    -item.confidence,
                    -item.target_notional,
                    item.strategy_id,
                ),
            )
            directions = {item.direction for item in ranked}
            if len(directions) > 1:
                conflicts += 1

            net_score = Decimal("0")
            total_notional = Decimal("0")
            for intent in ranked:
                signed = (
                    intent.target_notional
                    if intent.direction == "buy"
                    else -intent.target_notional
                )
                net_score += intent.confidence * signed
                total_notional += abs(intent.target_notional)

            if net_score == 0:
                winner = ranked[0]
                direction = winner.direction
            else:
                direction = "buy" if net_score > 0 else "sell"

            selected = [intent for intent in ranked if intent.direction == direction]
            confidence = sum(
                (intent.confidence for intent in selected),
                Decimal("0"),
            ) / Decimal(len(selected))
            selected_notional = sum(
                (intent.target_notional for intent in selected),
                Decimal("0"),
            )
            top_reasons = selected[0].explain if selected else ranked[0].explain
            if len(directions) > 1:
                top_reasons = top_reasons + ("intent_conflict_resolved",)
            resolved_notional = (
                selected_notional if selected_notional > 0 else total_notional
            )
            source_intents = selected if selected else ranked
            source_strategy_ids = tuple(
                dict.fromkeys(intent.strategy_id for intent in source_intents)
            )

            aggregated.append(
                AggregatedIntent(
                    symbol=symbol,
                    direction=direction,
                    confidence=confidence.quantize(Decimal("0.0001")),
                    target_notional=resolved_notional.quantize(Decimal("0.0001")),
                    horizon=horizon,
                    explain=top_reasons,
                    source_strategy_ids=source_strategy_ids,
                    feature_snapshot_hashes=tuple(
                        sorted({item.feature_snapshot_hash for item in ranked})
                    ),
                )
            )
        return aggregated, conflicts


class LegacyMacdRsiPlugin:
    plugin_id = "legacy_macd_rsi"
    version = "1.0.0"
    required_features: tuple[str, ...] = ("macd", "macd_signal", "rsi14", "price")

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        macd = _decimal(features.values.get("macd"))
        macd_signal = _decimal(features.values.get("macd_signal"))
        rsi14 = _decimal(features.values.get("rsi14"))
        target_notional = _target_notional(context.params)
        if macd is None or macd_signal is None or rsi14 is None:
            return PluginEvaluationResult(
                intent=None,
                trace=_generic_plugin_trace(
                    context=context,
                    gate="legacy_required_inputs",
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric="required_inputs_present",
                            comparator="all_present",
                            value={
                                "macd": macd is not None,
                                "macd_signal": macd_signal is not None,
                                "rsi14": rsi14 is not None,
                            },
                            threshold=True,
                            passed=False,
                            missing_policy="fail_closed",
                        ),
                    ),
                ),
            )
        if macd > macd_signal and rsi14 < Decimal("35"):
            return PluginEvaluationResult(
                intent=StrategyIntent(
                    strategy_id=context.strategy_id,
                    symbol=context.symbol,
                    direction="buy",
                    confidence=Decimal("0.65"),
                    target_notional=target_notional,
                    horizon=context.timeframe,
                    explain=("macd_cross_up", "rsi_oversold"),
                    feature_snapshot_hash=features.normalization_hash,
                    required_features=self.required_features,
                ),
                trace=_generic_plugin_trace(
                    context=context,
                    gate="legacy_macd_rsi_signal",
                    passed=True,
                    action="buy",
                    rationale=("macd_cross_up", "rsi_oversold"),
                ),
            )
        if macd < macd_signal and rsi14 > Decimal("65"):
            return PluginEvaluationResult(
                intent=StrategyIntent(
                    strategy_id=context.strategy_id,
                    symbol=context.symbol,
                    direction="sell",
                    confidence=Decimal("0.65"),
                    target_notional=target_notional,
                    horizon=context.timeframe,
                    explain=("macd_cross_down", "rsi_overbought"),
                    feature_snapshot_hash=features.normalization_hash,
                    required_features=self.required_features,
                ),
                trace=_generic_plugin_trace(
                    context=context,
                    gate="legacy_macd_rsi_signal",
                    passed=True,
                    action="sell",
                    rationale=("macd_cross_down", "rsi_overbought"),
                ),
            )
        return PluginEvaluationResult(
            intent=None,
            trace=_generic_plugin_trace(
                context=context,
                gate="legacy_macd_rsi_signal",
                passed=False,
                thresholds=(
                    ThresholdTrace(
                        metric="signal_condition",
                        comparator="legacy_macd_rsi",
                        value={
                            "macd": macd,
                            "macd_signal": macd_signal,
                            "rsi14": rsi14,
                        },
                        threshold="cross_and_rsi",
                        passed=False,
                        missing_policy="fail_open",
                    ),
                ),
            ),
        )


class IntradayTsmomPlugin:
    """Intraday trend-following plugin with stricter momentum/volatility filters."""

    plugin_id = "intraday_tsmom"
    version = "1.1.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "ema26",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "session_range_bps",
        "price_position_in_session_range",
        "price_vs_vwap_w5m_bps",
        "price_vs_opening_range_high_bps",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "cross_section_opening_window_return_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_continuation_rank",
        "cross_section_continuation_breadth",
        "cross_section_range_position_rank",
        "cross_section_vwap_w5m_rank",
        "cross_section_recent_imbalance_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        ema12 = _decimal(features.values.get("ema12"))
        ema26 = _decimal(features.values.get("ema26"))
        price = _decimal(features.values.get("price"))
        macd = _decimal(features.values.get("macd"))
        macd_signal = _decimal(features.values.get("macd_signal"))
        rsi14 = _decimal(features.values.get("rsi14"))
        vol = _decimal(features.values.get("vol_realized_w60s"))
        evaluation = evaluate_intraday_tsmom_signal(
            timeframe=context.timeframe,
            params=context.params,
            event_ts=context.event_ts,
            price=price,
            spread=_decimal(features.values.get("spread")),
            ema12=ema12,
            ema26=ema26,
            macd=macd,
            macd_signal=macd_signal,
            rsi14=rsi14,
            vol_realized_w60s=vol,
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
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            price_position_in_session_range=_decimal(
                features.values.get("price_position_in_session_range")
            ),
            price_vs_vwap_w5m_bps=_decimal(
                features.values.get("price_vs_vwap_w5m_bps")
            ),
            price_vs_opening_range_high_bps=_decimal(
                features.values.get("price_vs_opening_range_high_bps")
            ),
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
            cross_section_continuation_breadth=_decimal(
                features.values.get("cross_section_continuation_breadth")
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
        )
        if evaluation is None:
            return PluginEvaluationResult(
                intent=None,
                trace=_generic_plugin_trace(
                    context=context,
                    gate="intraday_tsmom_contract",
                    passed=False,
                ),
            )

        target_notional = _target_notional(context.params)
        direction = "buy" if evaluation.direction == "long" else "sell"
        confidence_cap = (
            Decimal("0.84") if evaluation.direction == "long" else Decimal("0.80")
        )
        intent = StrategyIntent(
            strategy_id=context.strategy_id,
            symbol=context.symbol,
            direction=direction,
            confidence=min(evaluation.confidence, confidence_cap),
            target_notional=target_notional,
            horizon=context.timeframe,
            explain=evaluation.rationale,
            feature_snapshot_hash=features.normalization_hash,
            required_features=self.required_features,
        )
        return PluginEvaluationResult(
            intent=intent,
            trace=_generic_plugin_trace(
                context=context,
                gate="intraday_tsmom_contract",
                passed=True,
                action=intent.direction,
                rationale=intent.explain,
            ),
        )


class MomentumPullbackLongPlugin:
    plugin_id = "momentum_pullback_long"
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
        "price_vs_session_open_bps",
        "recent_spread_bps_avg",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "cross_section_continuation_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_momentum_pullback_long(
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
            recent_spread_bps_avg=_decimal(
                features.values.get("recent_spread_bps_avg")
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


__all__ = [name for name in globals() if not name.startswith("__")]
