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

from ..models import Strategy
from ..strategies.catalog import extract_catalog_metadata
from .evaluation_trace import GateTrace, StrategyTrace, ThresholdTrace
from .features import FeatureVectorV3, validate_declared_features
from .intraday_tsmom_contract import evaluate_intraday_tsmom_signal
from .research_sleeves import (
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
from .strategy_specs import build_compiled_strategy_artifacts, strategy_type_supports_spec_v2


def _empty_meta() -> dict[str, Any]:
    return {}


def _generic_plugin_trace(
    *,
    context: "StrategyContext",
    gate: str,
    passed: bool,
    action: Literal["buy", "sell"] | None = None,
    rationale: tuple[str, ...] = (),
    thresholds: tuple[ThresholdTrace, ...] = (),
    gate_context: dict[str, Any] | None = None,
) -> StrategyTrace | None:
    if not context.trace_enabled:
        return None
    return StrategyTrace(
        strategy_id=context.strategy_id,
        strategy_type=context.strategy_type,
        symbol=context.symbol,
        event_ts=context.event_ts,
        timeframe=context.timeframe,
        passed=passed,
        action=action,
        rationale=rationale,
        gates=(
            GateTrace(
                gate=gate,
                category='structure',
                passed=passed,
                thresholds=thresholds,
                context=gate_context or {},
            ),
        ),
        first_failed_gate=None if passed else gate,
    )


def _plugin_result_from_sleeve_result(
    *,
    context: "StrategyContext",
    features: FeatureVectorV3,
    required_features: tuple[str, ...],
    evaluation: SleeveSignalResult | SleeveSignalEvaluation | None,
) -> PluginEvaluationResult:
    if evaluation is None:
        return PluginEvaluationResult(intent=None, trace=None)
    if isinstance(evaluation, SleeveSignalEvaluation):
        evaluation = SleeveSignalResult(signal=evaluation, trace=None)
    if evaluation.signal is None:
        return PluginEvaluationResult(intent=None, trace=evaluation.trace)
    return PluginEvaluationResult(
        intent=StrategyIntent(
            strategy_id=context.strategy_id,
            symbol=context.symbol,
            direction=evaluation.signal.action,
            confidence=evaluation.signal.confidence,
            target_notional=_resolved_target_notional(
                context.params,
                multiplier=evaluation.signal.notional_multiplier,
            ),
            horizon=context.timeframe,
            explain=evaluation.signal.rationale,
            feature_snapshot_hash=features.normalization_hash,
            required_features=required_features,
        ),
        trace=evaluation.trace,
    )


def _microbar_minutes_elapsed(
    *,
    context: "StrategyContext",
    features: FeatureVectorV3,
) -> int | None:
    raw_minutes = features.values.get("session_minutes_elapsed")
    if raw_minutes is not None:
        try:
            return max(0, int(raw_minutes))
        except (TypeError, ValueError):
            return None
    try:
        event_ts = datetime.fromisoformat(context.event_ts)
    except ValueError:
        return None
    session_open = event_ts.replace(hour=13, minute=30, second=0, microsecond=0)
    return max(0, int((event_ts - session_open).total_seconds() // 60))


def _microbar_exit_minute_after_open(params: dict[str, Any]) -> int | None:
    raw_value = params.get("exit_minute_after_open")
    if raw_value is None:
        return None
    normalized = str(raw_value).strip().lower()
    if not normalized:
        return None
    if normalized == "close":
        return 390
    try:
        return max(0, int(normalized))
    except ValueError:
        return None


def _microbar_universe_size(
    *,
    context: "StrategyContext",
    params: dict[str, Any],
) -> int:
    raw_value = params.get("universe_size")
    if raw_value is not None:
        try:
            resolved = int(str(raw_value).strip())
        except ValueError:
            resolved = 0
        if resolved > 1:
            return resolved
    raw_symbols = params.get("universe_symbols")
    if isinstance(raw_symbols, list):
        resolved_symbols = [
            symbol
            for item in cast(list[object], raw_symbols)
            if (symbol := str(item).strip())
        ]
        if len(resolved_symbols) > 1:
            return len(resolved_symbols)
    strategy_spec_symbols = context.strategy_spec.get("universe_symbols")
    if isinstance(strategy_spec_symbols, list):
        return max(2, len(cast(list[object], strategy_spec_symbols)))
    return 2


def _microbar_rank_thresholds(
    *,
    universe_size: int,
    top_n: int,
) -> tuple[Decimal, Decimal]:
    if universe_size <= 1:
        return (Decimal("0"), Decimal("1"))
    resolved_top_n = min(max(1, top_n), universe_size)
    denominator = Decimal(universe_size - 1)
    low_threshold = Decimal(resolved_top_n - 1) / denominator
    high_threshold = Decimal(universe_size - resolved_top_n) / denominator
    return (low_threshold, high_threshold)


def _evaluate_microbar_cross_sectional(
    *,
    context: "StrategyContext",
    features: FeatureVectorV3,
    entry_action: Literal["buy", "sell"],
    exit_action: Literal["buy", "sell"],
) -> PluginEvaluationResult:
    params = context.params
    minutes_elapsed = _microbar_minutes_elapsed(context=context, features=features)
    if minutes_elapsed is None:
        return PluginEvaluationResult(
            intent=None,
            trace=_generic_plugin_trace(
                context=context,
                gate="schedule",
                passed=False,
                gate_context={"reason": "missing_session_minutes_elapsed"},
            ),
        )

    entry_minute = max(0, int(_decimal(params.get("entry_minute_after_open")) or Decimal("0")))
    exit_minute = _microbar_exit_minute_after_open(params)
    if exit_minute is not None and minutes_elapsed >= exit_minute:
        rationale = (
            "microbar_time_exit",
            str(params.get("signal_motif") or "").strip().lower(),
        )
        return PluginEvaluationResult(
            intent=StrategyIntent(
                strategy_id=context.strategy_id,
                symbol=context.symbol,
                direction=exit_action,
                confidence=Decimal("0.51"),
                target_notional=_resolved_target_notional(params),
                horizon=context.timeframe,
                explain=rationale,
                feature_snapshot_hash=features.normalization_hash,
                required_features=(
                    "session_minutes_elapsed",
                    "cross_section_continuation_breadth",
                    "cross_section_session_open_rank",
                    "cross_section_vwap_w5m_rank",
                ),
            ),
            trace=_generic_plugin_trace(
                context=context,
                gate="time_exit",
                passed=True,
                action=exit_action,
                rationale=rationale,
                gate_context={
                    "minutes_elapsed": minutes_elapsed,
                    "exit_minute_after_open": exit_minute,
                },
            ),
        )

    if minutes_elapsed != entry_minute:
        return PluginEvaluationResult(
            intent=None,
            trace=_generic_plugin_trace(
                context=context,
                gate="schedule",
                passed=False,
                gate_context={
                    "minutes_elapsed": minutes_elapsed,
                    "entry_minute_after_open": entry_minute,
                },
            ),
        )

    gate_feature = str(params.get("gate_feature") or "").strip()
    gate_value = _decimal(features.values.get(gate_feature)) if gate_feature else None
    gate_min = _decimal(params.get("gate_min"))
    gate_max = _decimal(params.get("gate_max"))
    if gate_feature:
        passed_min = gate_min is None or (gate_value is not None and gate_value >= gate_min)
        passed_max = gate_max is None or (gate_value is not None and gate_value <= gate_max)
        if not (passed_min and passed_max):
            thresholds: list[ThresholdTrace] = []
            if gate_min is not None:
                thresholds.append(
                    ThresholdTrace(
                        metric=f"{gate_feature}_min",
                        comparator="min_gte",
                        value=gate_value,
                        threshold=gate_min,
                        passed=passed_min,
                        missing_policy="fail_closed",
                        distance_to_pass=(
                            Decimal("0")
                            if passed_min
                            else (
                                gate_min
                                if gate_value is None
                                else max(Decimal("0"), gate_min - gate_value)
                            )
                        ),
                    )
                )
            if gate_max is not None:
                thresholds.append(
                    ThresholdTrace(
                        metric=f"{gate_feature}_max",
                        comparator="max_lte",
                        value=gate_value,
                        threshold=gate_max,
                        passed=passed_max,
                        missing_policy="fail_closed",
                        distance_to_pass=(
                            Decimal("0")
                            if passed_max
                            else (
                                gate_max
                                if gate_value is None
                                else max(Decimal("0"), gate_value - gate_max)
                            )
                        ),
                    )
                )
            return PluginEvaluationResult(
                intent=None,
                trace=_generic_plugin_trace(
                    context=context,
                    gate="regime_gate",
                    passed=False,
                    thresholds=tuple(thresholds),
                    gate_context={gate_feature: gate_value},
                ),
            )

    rank_feature = str(params.get("rank_feature") or "").strip()
    rank_value = _decimal(features.values.get(rank_feature))
    if rank_value is None:
        return PluginEvaluationResult(
            intent=None,
            trace=_generic_plugin_trace(
                context=context,
                gate="rank_selection",
                passed=False,
                gate_context={"reason": "missing_rank_feature", "rank_feature": rank_feature},
            ),
        )

    selection_mode = str(params.get("selection_mode") or "continuation").strip().lower()
    top_n = max(1, int(_decimal(params.get("top_n")) or Decimal("1")))
    universe_size = _microbar_universe_size(context=context, params=params)
    low_threshold, high_threshold = _microbar_rank_thresholds(
        universe_size=universe_size,
        top_n=top_n,
    )
    should_trade = False
    comparator = "gte"
    threshold_value = high_threshold
    if selection_mode == "reversal":
        if entry_action == "buy":
            comparator = "lte"
            threshold_value = low_threshold
            should_trade = rank_value <= low_threshold
        else:
            comparator = "gte"
            threshold_value = high_threshold
            should_trade = rank_value >= high_threshold
    else:
        if entry_action == "buy":
            comparator = "gte"
            threshold_value = high_threshold
            should_trade = rank_value >= high_threshold
        else:
            comparator = "lte"
            threshold_value = low_threshold
            should_trade = rank_value <= low_threshold

    entry_rationale = (
        "microbar_cross_sectional_entry",
        str(params.get("signal_motif") or "").strip().lower(),
        f"selection_mode:{selection_mode}",
        f"rank_feature:{rank_feature}",
        f"top_n:{top_n}",
    )
    trace = _generic_plugin_trace(
        context=context,
        gate="rank_selection",
        passed=should_trade,
        action=entry_action if should_trade else None,
        rationale=entry_rationale if should_trade else (),
        thresholds=(
            ThresholdTrace(
                metric=rank_feature,
                comparator="min_gte" if comparator == "gte" else "max_lte",
                value=rank_value,
                threshold=threshold_value,
                passed=should_trade,
                missing_policy="fail_closed",
                distance_to_pass=(
                    Decimal("0")
                    if should_trade
                    else (
                        max(Decimal("0"), threshold_value - rank_value)
                        if comparator == "gte"
                        else max(Decimal("0"), rank_value - threshold_value)
                    )
                ),
            ),
        ),
        gate_context={
            "minutes_elapsed": minutes_elapsed,
            "entry_minute_after_open": entry_minute,
            "selection_mode": selection_mode,
            "top_n": top_n,
            "universe_size": universe_size,
        },
    )
    if not should_trade:
        return PluginEvaluationResult(intent=None, trace=trace)

    rank_distance = (
        rank_value - threshold_value
        if comparator == "gte"
        else threshold_value - rank_value
    )
    confidence = min(Decimal("0.95"), Decimal("0.55") + max(Decimal("0"), rank_distance))
    return PluginEvaluationResult(
        intent=StrategyIntent(
            strategy_id=context.strategy_id,
            symbol=context.symbol,
            direction=entry_action,
            confidence=confidence,
            target_notional=_resolved_target_notional(params),
            horizon=context.timeframe,
            explain=entry_rationale,
            feature_snapshot_hash=features.normalization_hash,
            required_features=(
                "session_minutes_elapsed",
                "cross_section_continuation_breadth",
                "cross_section_session_open_rank",
                "cross_section_vwap_w5m_rank",
            ),
        ),
        trace=trace,
    )


@dataclass(frozen=True)
class StrategyDefinition:
    strategy_id: str
    strategy_name: str
    declared_strategy_id: str
    strategy_type: str
    version: str
    params: dict[str, Any]
    feature_requirements: tuple[str, ...]
    risk_profile: str
    execution_profile: str
    enabled: bool
    base_timeframe: str
    universe_symbols: tuple[str, ...] = field(default_factory=tuple)
    compiler_source: str = "legacy_runtime"
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)
    compiled_targets: dict[str, Any] = field(default_factory=_empty_meta)


@dataclass(frozen=True)
class StrategyContext:
    strategy_id: str
    strategy_name: str
    declared_strategy_id: str
    strategy_type: str
    strategy_version: str
    event_ts: str
    symbol: str
    timeframe: str
    params: dict[str, Any]
    trace_enabled: bool = False
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)


@dataclass(frozen=True)
class StrategyIntent:
    strategy_id: str
    symbol: str
    direction: Literal["buy", "sell"]
    confidence: Decimal
    target_notional: Decimal
    horizon: str
    explain: tuple[str, ...]
    feature_snapshot_hash: str
    required_features: tuple[str, ...]

    @property
    def action(self) -> Literal["buy", "sell"]:
        return self.direction

    @property
    def rationale(self) -> tuple[str, ...]:
        return self.explain


@dataclass(frozen=True)
class AggregatedIntent:
    symbol: str
    direction: Literal["buy", "sell"]
    confidence: Decimal
    target_notional: Decimal
    horizon: str
    explain: tuple[str, ...]
    source_strategy_ids: tuple[str, ...]
    feature_snapshot_hashes: tuple[str, ...]


@dataclass(frozen=True)
class RuntimeDecision:
    intent: StrategyIntent
    trace: StrategyTrace | None
    strategy_row_id: str
    declared_strategy_id: str
    strategy_name: str
    strategy_type: str
    strategy_version: str
    plugin_id: str
    plugin_version: str
    parameter_hash: str
    feature_hash: str
    compiler_source: str = "legacy_runtime"
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)
    compiled_targets: dict[str, Any] = field(default_factory=_empty_meta)

    def metadata(self) -> dict[str, Any]:
        payload = {
            "strategy_row_id": self.strategy_row_id,
            "declared_strategy_id": self.declared_strategy_id,
            "strategy_name": self.strategy_name,
            "strategy_type": self.strategy_type,
            "strategy_version": self.strategy_version,
            "plugin_id": self.plugin_id,
            "plugin_version": self.plugin_version,
            "parameter_hash": self.parameter_hash,
            "feature_hash": self.feature_hash,
            "intent_action": self.intent.direction,
            "intent_confidence": str(self.intent.confidence),
            "intent_target_notional": str(self.intent.target_notional),
            "intent_rationale": list(self.intent.explain),
            "required_features": list(self.intent.required_features),
            "compiler_source": self.compiler_source,
            "strategy_spec_v2": dict(self.strategy_spec),
            "compiled_targets": dict(self.compiled_targets),
        }
        if self.trace is not None:
            payload["strategy_trace"] = self.trace.to_payload()
        return payload


@dataclass(frozen=True)
class RuntimeErrorRecord:
    strategy_id: str
    strategy_type: str
    plugin_id: str
    reason: str


@dataclass
class RuntimeObservation:
    strategy_events_total: dict[str, int] = field(default_factory=lambda: {})
    strategy_intents_total: dict[str, int] = field(default_factory=lambda: {})
    strategy_errors_total: dict[str, int] = field(default_factory=lambda: {})
    strategy_latency_ms: dict[str, int] = field(default_factory=lambda: {})
    intent_conflicts_total: int = 0
    isolated_failures_total: int = 0

    def record_event(self, strategy_id: str, latency_ms: int) -> None:
        self.strategy_events_total[strategy_id] = (
            self.strategy_events_total.get(strategy_id, 0) + 1
        )
        self.strategy_latency_ms[strategy_id] = latency_ms

    def record_intent(self, strategy_id: str) -> None:
        self.strategy_intents_total[strategy_id] = (
            self.strategy_intents_total.get(strategy_id, 0) + 1
        )

    def record_error(self, strategy_id: str) -> None:
        self.strategy_errors_total[strategy_id] = (
            self.strategy_errors_total.get(strategy_id, 0) + 1
        )
        self.isolated_failures_total += 1


@dataclass(frozen=True)
class RuntimeEvaluation:
    intents: list[AggregatedIntent]
    raw_intents: list[RuntimeDecision]
    traces: list[StrategyTrace]
    errors: list[RuntimeErrorRecord]
    observation: RuntimeObservation


class StrategyPlugin(Protocol):
    plugin_id: str
    version: str
    required_features: tuple[str, ...]

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> "PluginEvaluationResult": ...


@dataclass(frozen=True)
class PluginEvaluationResult:
    intent: StrategyIntent | None
    trace: StrategyTrace | None = None


def _coerce_plugin_result(result: PluginEvaluationResult | StrategyIntent | None) -> PluginEvaluationResult:
    if isinstance(result, PluginEvaluationResult):
        return result
    if result is None:
        return PluginEvaluationResult(intent=None, trace=None)
    return PluginEvaluationResult(intent=result, trace=None)


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
                    gate='legacy_required_inputs',
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric='required_inputs_present',
                            comparator='all_present',
                            value={
                                'macd': macd is not None,
                                'macd_signal': macd_signal is not None,
                                'rsi14': rsi14 is not None,
                            },
                            threshold=True,
                            passed=False,
                            missing_policy='fail_closed',
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
                    gate='legacy_macd_rsi_signal',
                    passed=True,
                    action='buy',
                    rationale=('macd_cross_up', 'rsi_oversold'),
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
                    gate='legacy_macd_rsi_signal',
                    passed=True,
                    action='sell',
                    rationale=('macd_cross_down', 'rsi_overbought'),
                ),
            )
        return PluginEvaluationResult(
            intent=None,
            trace=_generic_plugin_trace(
                context=context,
                gate='legacy_macd_rsi_signal',
                passed=False,
                thresholds=(
                    ThresholdTrace(
                        metric='signal_condition',
                        comparator='legacy_macd_rsi',
                        value={
                            'macd': macd,
                            'macd_signal': macd_signal,
                            'rsi14': rsi14,
                        },
                        threshold='cross_and_rsi',
                        passed=False,
                        missing_policy='fail_open',
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
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
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
            price_vs_vwap_w5m_bps=_decimal(features.values.get("price_vs_vwap_w5m_bps")),
            price_vs_opening_range_high_bps=_decimal(
                features.values.get("price_vs_opening_range_high_bps")
            ),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_spread_bps_max=_decimal(features.values.get("recent_spread_bps_max")),
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
                features.values.get("cross_section_opening_window_return_from_prev_close_rank")
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
                    gate='intraday_tsmom_contract',
                    passed=False,
                ),
            )

        target_notional = _target_notional(context.params)
        direction = "buy" if evaluation.direction == "long" else "sell"
        confidence_cap = Decimal("0.84") if evaluation.direction == "long" else Decimal("0.80")
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
                gate='intraday_tsmom_contract',
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
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_imbalance_pressure_avg=_decimal(features.values.get("recent_imbalance_pressure_avg")),
            recent_quote_invalid_ratio=_decimal(features.values.get("recent_quote_invalid_ratio")),
            recent_quote_jump_bps_max=_decimal(features.values.get("recent_quote_jump_bps_max")),
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


class BreakoutContinuationLongPlugin:
    plugin_id = "breakout_continuation_long"
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
        "price_vs_vwap_w5m_bps",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_vs_opening_range_high_bps",
        "price_vs_opening_window_close_bps",
        "opening_range_width_bps",
        "session_high_price",
        "opening_range_high",
        "session_range_bps",
        "price_position_in_session_range",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
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
        evaluation = evaluate_breakout_continuation_long(
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
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(features.values.get("opening_window_return_bps")),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_vs_opening_range_high_bps=_decimal(features.values.get("price_vs_opening_range_high_bps")),
            price_vs_opening_window_close_bps=_decimal(
                features.values.get("price_vs_opening_window_close_bps")
            ),
            opening_range_width_bps=_decimal(features.values.get("opening_range_width_bps")),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            price_position_in_session_range=_decimal(features.values.get("price_position_in_session_range")),
            price_vs_vwap_w5m_bps=_decimal(features.values.get("price_vs_vwap_w5m_bps")),
            session_high_price=_decimal(features.values.get("session_high_price")),
            opening_range_high=_decimal(features.values.get("opening_range_high")),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_spread_bps_max=_decimal(features.values.get("recent_spread_bps_max")),
            recent_imbalance_pressure_avg=_decimal(features.values.get("recent_imbalance_pressure_avg")),
            recent_quote_invalid_ratio=_decimal(features.values.get("recent_quote_invalid_ratio")),
            recent_quote_jump_bps_max=_decimal(features.values.get("recent_quote_jump_bps_max")),
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
                features.values.get("cross_section_positive_opening_window_return_ratio")
            ),
            cross_section_positive_prev_session_close_ratio=_decimal(
                features.values.get("cross_section_positive_prev_session_close_ratio")
            ),
            cross_section_positive_opening_window_return_from_prev_close_ratio=_decimal(
                features.values.get("cross_section_positive_opening_window_return_from_prev_close_ratio")
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
                features.values.get("cross_section_opening_window_return_from_prev_close_rank")
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


class MeanReversionReboundLongPlugin:
    plugin_id = "mean_reversion_rebound_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "spread_bps",
        "vwap_session",
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
        evaluation = evaluate_mean_reversion_rebound_long(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            vwap_session=_decimal(features.values.get("vwap_session")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(features.values.get("opening_window_return_bps")),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(features.values.get("price_position_in_session_range")),
            price_vs_opening_range_low_bps=_decimal(features.values.get("price_vs_opening_range_low_bps")),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_spread_bps_max=_decimal(features.values.get("recent_spread_bps_max")),
            recent_imbalance_pressure_avg=_decimal(features.values.get("recent_imbalance_pressure_avg")),
            recent_quote_invalid_ratio=_decimal(features.values.get("recent_quote_invalid_ratio")),
            recent_quote_jump_bps_max=_decimal(features.values.get("recent_quote_jump_bps_max")),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get("cross_section_opening_window_return_from_prev_close_rank")
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


class MeanReversionExhaustionShortPlugin:
    plugin_id = "mean_reversion_exhaustion_short"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "spread_bps",
        "vwap_session",
        "imbalance_bid_sz",
        "imbalance_ask_sz",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_position_in_session_range",
        "price_vs_opening_range_high_bps",
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
        "cross_section_session_open_rank",
        "cross_section_prev_session_close_rank",
        "cross_section_range_position_rank",
        "cross_section_vwap_w5m_rank",
        "cross_section_recent_imbalance_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_mean_reversion_exhaustion_short(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            vwap_session=_decimal(features.values.get("vwap_session")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(features.values.get("opening_window_return_bps")),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(features.values.get("price_position_in_session_range")),
            price_vs_opening_range_high_bps=_decimal(
                features.values.get("price_vs_opening_range_high_bps")
            ),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_spread_bps_max=_decimal(features.values.get("recent_spread_bps_max")),
            recent_imbalance_pressure_avg=_decimal(features.values.get("recent_imbalance_pressure_avg")),
            recent_quote_invalid_ratio=_decimal(features.values.get("recent_quote_invalid_ratio")),
            recent_quote_jump_bps_max=_decimal(features.values.get("recent_quote_jump_bps_max")),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get("cross_section_opening_window_return_from_prev_close_rank")
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
            cross_section_reversal_rank=_decimal(
                features.values.get("cross_section_reversal_rank")
            ),
            cross_section_session_open_rank=_decimal(
                features.values.get("cross_section_session_open_rank")
            ),
            cross_section_prev_session_close_rank=_decimal(
                features.values.get("cross_section_prev_session_close_rank")
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
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
        )


class MicrobarCrossSectionalLongPlugin:
    plugin_id = "microbar_cross_sectional_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "macd",
        "macd_signal",
        "rsi14",
        "session_minutes_elapsed",
        "cross_section_continuation_breadth",
        "cross_section_session_open_rank",
        "cross_section_vwap_w5m_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        return _evaluate_microbar_cross_sectional(
            context=context,
            features=features,
            entry_action="buy",
            exit_action="sell",
        )


class MicrobarCrossSectionalShortPlugin:
    plugin_id = "microbar_cross_sectional_short"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "macd",
        "macd_signal",
        "rsi14",
        "session_minutes_elapsed",
        "cross_section_continuation_breadth",
        "cross_section_session_open_rank",
        "cross_section_vwap_w5m_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        return _evaluate_microbar_cross_sectional(
            context=context,
            features=features,
            entry_action="sell",
            exit_action="buy",
        )


class WashoutReboundLongPlugin:
    plugin_id = "washout_rebound_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
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
        "price_vs_session_low_bps",
        "price_vs_opening_range_low_bps",
        "session_range_bps",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "recent_above_vwap_w5m_ratio",
        "cross_section_opening_window_return_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_continuation_rank",
        "cross_section_reversal_rank",
        "cross_section_recent_imbalance_rank",
        "cross_section_positive_recent_imbalance_ratio",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_washout_rebound_long(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            vwap_session=_decimal(features.values.get("vwap_session")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(features.values.get("opening_window_return_bps")),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(features.values.get("price_position_in_session_range")),
            price_vs_session_low_bps=_decimal(features.values.get("price_vs_session_low_bps")),
            price_vs_opening_range_low_bps=_decimal(features.values.get("price_vs_opening_range_low_bps")),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_spread_bps_max=_decimal(features.values.get("recent_spread_bps_max")),
            recent_imbalance_pressure_avg=_decimal(features.values.get("recent_imbalance_pressure_avg")),
            recent_quote_invalid_ratio=_decimal(features.values.get("recent_quote_invalid_ratio")),
            recent_quote_jump_bps_max=_decimal(features.values.get("recent_quote_jump_bps_max")),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            recent_above_vwap_w5m_ratio=_decimal(
                features.values.get("recent_above_vwap_w5m_ratio")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get("cross_section_opening_window_return_from_prev_close_rank")
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
            cross_section_reversal_rank=_decimal(
                features.values.get("cross_section_reversal_rank")
            ),
            cross_section_recent_imbalance_rank=_decimal(
                features.values.get("cross_section_recent_imbalance_rank")
            ),
            cross_section_positive_recent_imbalance_ratio=_decimal(
                features.values.get("cross_section_positive_recent_imbalance_ratio")
            ),
        )
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
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
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(features.values.get("opening_window_return_bps")),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(features.values.get("price_position_in_session_range")),
            price_vs_vwap_w5m_bps=_decimal(features.values.get("price_vs_vwap_w5m_bps")),
            session_high_price=_decimal(features.values.get("session_high_price")),
            opening_range_high=_decimal(features.values.get("opening_range_high")),
            price_vs_opening_range_high_bps=_decimal(features.values.get("price_vs_opening_range_high_bps")),
            price_vs_opening_window_close_bps=_decimal(
                features.values.get("price_vs_opening_window_close_bps")
            ),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_imbalance_pressure_avg=_decimal(features.values.get("recent_imbalance_pressure_avg")),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_quote_invalid_ratio=_decimal(features.values.get("recent_quote_invalid_ratio")),
            recent_quote_jump_bps_max=_decimal(features.values.get("recent_quote_jump_bps_max")),
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
                features.values.get("cross_section_positive_opening_window_return_ratio")
            ),
            cross_section_positive_prev_session_close_ratio=_decimal(
                features.values.get("cross_section_positive_prev_session_close_ratio")
            ),
            cross_section_positive_opening_window_return_from_prev_close_ratio=_decimal(
                features.values.get("cross_section_positive_opening_window_return_from_prev_close_ratio")
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
                features.values.get("cross_section_opening_window_return_from_prev_close_rank")
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
            price_vs_session_open_bps=_decimal(features.values.get("price_vs_session_open_bps")),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(features.values.get("opening_window_return_bps")),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(features.values.get("price_position_in_session_range")),
            price_vs_opening_range_low_bps=_decimal(features.values.get("price_vs_opening_range_low_bps")),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(features.values.get("recent_spread_bps_avg")),
            recent_spread_bps_max=_decimal(features.values.get("recent_spread_bps_max")),
            recent_imbalance_pressure_avg=_decimal(features.values.get("recent_imbalance_pressure_avg")),
            recent_quote_invalid_ratio=_decimal(features.values.get("recent_quote_invalid_ratio")),
            recent_quote_jump_bps_max=_decimal(features.values.get("recent_quote_jump_bps_max")),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get("cross_section_opening_window_return_from_prev_close_rank")
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
        if definition.universe_symbols and features.symbol not in definition.universe_symbols:
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
            if definition.universe_symbols and features.symbol not in definition.universe_symbols:
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
                plugin_result = _coerce_plugin_result(plugin.evaluate(context, features))
                latency_ms = int((time.perf_counter() - start) * 1000)
                observation.record_event(definition.strategy_id, latency_ms)
                self.registry.record_success(definition.strategy_id)
                if plugin_result.trace is not None:
                    traces.append(plugin_result.trace)
                if plugin_result.intent is None:
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
        compiler_source = str(catalog_metadata.get("compiler_source") or "legacy_runtime")
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
        declared_strategy_id = (
            str(catalog_metadata.get("strategy_id") or "").strip()
            or str(strategy.name)
        )
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
                candidate_end = marker_end if marker_end > marker_start else len(description)
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


def _target_notional(params: dict[str, Any]) -> Decimal:
    notional = _decimal(params.get("max_notional_per_trade"))
    if notional is None or notional <= 0:
        return Decimal("100")
    return notional


def _resolved_target_notional(
    params: dict[str, Any],
    *,
    multiplier: Decimal | None = None,
) -> Decimal:
    base_notional = _target_notional(params)
    if multiplier is None or multiplier <= 0:
        return base_notional
    resolved = base_notional * multiplier
    if resolved <= 0:
        return base_notional
    return resolved.quantize(Decimal("0.0001"))
