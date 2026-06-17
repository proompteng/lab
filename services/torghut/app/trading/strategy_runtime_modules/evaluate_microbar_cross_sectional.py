# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821

from .empty_meta import (
    decimal as _decimal,
    empty_meta as _empty_meta,
    generic_plugin_trace as _generic_plugin_trace,
    microbar_entry_window_minutes as _microbar_entry_window_minutes,
    microbar_exit_minute_after_open as _microbar_exit_minute_after_open,
    microbar_minutes_elapsed as _microbar_minutes_elapsed,
    microbar_observed_rank_universe_size as _microbar_observed_rank_universe_size,
    microbar_pair_max_legs as _microbar_pair_max_legs,
    microbar_pair_rank_thresholds as _microbar_pair_rank_thresholds,
    microbar_pair_side_count as _microbar_pair_side_count,
    microbar_rank_thresholds as _microbar_rank_thresholds,
    microbar_rank_universe_size as _microbar_rank_universe_size,
    microbar_required_features as _microbar_required_features,
    microbar_runtime_position_qty as _microbar_runtime_position_qty,
    microbar_universe_size as _microbar_universe_size,
    plugin_result_from_sleeve_result as _plugin_result_from_sleeve_result,
    resolved_target_notional as _resolved_target_notional,
)


def _evaluate_microbar_cross_sectional(
    *,
    context: "StrategyContext",
    features: FeatureVectorV3,
    entry_action: Literal["buy", "sell"],
    exit_action: Literal["buy", "sell"],
    pair_mode: bool = False,
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

    entry_minute = max(
        0, int(_decimal(params.get("entry_minute_after_open")) or Decimal("0"))
    )
    exit_minute = _microbar_exit_minute_after_open(params)
    entry_window_minutes = _microbar_entry_window_minutes(params)
    entry_window_end = entry_minute + entry_window_minutes
    if exit_minute is not None:
        entry_window_end = min(entry_window_end, max(entry_minute, exit_minute - 1))
    is_exit = exit_minute is not None and minutes_elapsed >= exit_minute
    if is_exit and not pair_mode:
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
                required_features=_microbar_required_features(params),
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

    if not is_exit and (
        minutes_elapsed < entry_minute or minutes_elapsed > entry_window_end
    ):
        return PluginEvaluationResult(
            intent=None,
            trace=_generic_plugin_trace(
                context=context,
                gate="schedule",
                passed=False,
                gate_context={
                    "minutes_elapsed": minutes_elapsed,
                    "entry_minute_after_open": entry_minute,
                    "entry_window_minutes": entry_window_minutes,
                    "entry_window_end_minute_after_open": entry_window_end,
                },
            ),
        )

    gate_feature = str(params.get("gate_feature") or "").strip()
    gate_value = _decimal(features.values.get(gate_feature)) if gate_feature else None
    gate_min = _decimal(params.get("gate_min"))
    gate_max = _decimal(params.get("gate_max"))
    if gate_feature and not is_exit:
        passed_min = gate_min is None or (
            gate_value is not None and gate_value >= gate_min
        )
        passed_max = gate_max is None or (
            gate_value is not None and gate_value <= gate_max
        )
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

    if pair_mode and is_exit:
        position_qty = _microbar_runtime_position_qty(features)
        if position_qty is None:
            return PluginEvaluationResult(
                intent=None,
                trace=_generic_plugin_trace(
                    context=context,
                    gate="pair_position_exit",
                    passed=False,
                    gate_context={
                        "reason": "missing_runtime_position_qty",
                        "minutes_elapsed": minutes_elapsed,
                        "exit_minute_after_open": exit_minute,
                    },
                ),
            )
        if position_qty == 0:
            return PluginEvaluationResult(
                intent=None,
                trace=_generic_plugin_trace(
                    context=context,
                    gate="pair_position_exit",
                    passed=False,
                    gate_context={
                        "reason": "flat_runtime_position",
                        "minutes_elapsed": minutes_elapsed,
                        "exit_minute_after_open": exit_minute,
                        "runtime_position_qty": position_qty,
                    },
                ),
            )
        position_side = "long" if position_qty > 0 else "short"
        position_exit_action: Literal["buy", "sell"] = (
            "sell" if position_qty > 0 else "buy"
        )
        rationale = (
            "microbar_cross_sectional_pair_exit",
            str(params.get("signal_motif") or "").strip().lower(),
            "exit_basis:runtime_position",
            f"position_side:{position_side}",
        )
        required_features = (
            "session_minutes_elapsed",
            "runtime_position_qty",
        )
        return PluginEvaluationResult(
            intent=StrategyIntent(
                strategy_id=context.strategy_id,
                symbol=context.symbol,
                direction=position_exit_action,
                confidence=Decimal("0.51"),
                target_notional=_resolved_target_notional(params),
                horizon=context.timeframe,
                explain=rationale,
                feature_snapshot_hash=features.normalization_hash,
                required_features=required_features,
            ),
            trace=_generic_plugin_trace(
                context=context,
                gate="pair_position_exit",
                passed=True,
                action=position_exit_action,
                rationale=rationale,
                gate_context={
                    "minutes_elapsed": minutes_elapsed,
                    "exit_minute_after_open": exit_minute,
                    "runtime_position_qty": position_qty,
                    "position_side": position_side,
                },
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
                gate_context={
                    "reason": "missing_rank_feature",
                    "rank_feature": rank_feature,
                },
            ),
        )

    selection_mode = str(params.get("selection_mode") or "continuation").strip().lower()
    top_n = max(1, int(_decimal(params.get("top_n")) or Decimal("1")))
    universe_size = _microbar_rank_universe_size(
        context=context,
        params=params,
        features=features,
        rank_feature=rank_feature,
    )
    max_pair_legs = _microbar_pair_max_legs(params)
    pair_side_count = (
        _microbar_pair_side_count(
            universe_size=universe_size,
            max_pair_legs=max_pair_legs,
        )
        if pair_mode
        else 0
    )
    if pair_mode and pair_side_count <= 0:
        return PluginEvaluationResult(
            intent=None,
            trace=_generic_plugin_trace(
                context=context,
                gate="pair_leg_selection",
                passed=False,
                gate_context={
                    "reason": "invalid_pair_leg_count",
                    "max_pair_legs": max_pair_legs,
                    "universe_size": universe_size,
                },
            ),
        )
    rank_threshold_basis = "observed_rank_universe"
    configured_universe_size = _microbar_universe_size(context=context, params=params)
    observed_rank_universe_size = _microbar_observed_rank_universe_size(
        features=features,
        rank_feature=rank_feature,
    )
    if pair_mode:
        (
            low_threshold,
            high_threshold,
            rank_threshold_basis,
            configured_universe_size,
            observed_rank_universe_size,
        ) = _microbar_pair_rank_thresholds(
            context=context,
            params=params,
            features=features,
            rank_feature=rank_feature,
            pair_side_count=pair_side_count,
        )
    else:
        low_threshold, high_threshold = _microbar_rank_thresholds(
            universe_size=universe_size,
            top_n=top_n,
        )
    if pair_mode:
        high_entry_action: Literal["buy", "sell"] = (
            "sell" if selection_mode == "reversal" else "buy"
        )
        low_entry_action: Literal["buy", "sell"] = (
            "buy" if selection_mode == "reversal" else "sell"
        )
        selected_entry_action: Literal["buy", "sell"] | None = None
        pair_side: str | None = None
        comparator = "gte"
        threshold_value = high_threshold
        if (
            rank_threshold_basis == "configured_pair_midpoint"
            and rank_value == high_threshold
        ):
            selected_entry_action = None
            pair_side = None
        elif rank_value >= high_threshold:
            selected_entry_action = high_entry_action
            pair_side = "high_rank"
            comparator = "gte"
            threshold_value = high_threshold
        elif rank_value <= low_threshold:
            selected_entry_action = low_entry_action
            pair_side = "low_rank"
            comparator = "lte"
            threshold_value = low_threshold
        rejection_reason: str | None = None
        if selected_entry_action is None:
            rejection_reason = (
                "ambiguous_pair_rank_midpoint"
                if (
                    rank_threshold_basis == "configured_pair_midpoint"
                    and rank_value == high_threshold
                )
                else "rank_inside_pair_band"
            )
        should_trade = selected_entry_action is not None
        resolved_action: Literal["buy", "sell"] | None = selected_entry_action
        rationale = (
            "microbar_cross_sectional_pair_entry",
            str(params.get("signal_motif") or "").strip().lower(),
            f"selection_mode:{selection_mode}",
            f"rank_feature:{rank_feature}",
            f"pair_side:{pair_side or 'none'}",
            f"pair_side_count:{pair_side_count}",
            f"max_pair_legs:{max_pair_legs}",
        )
        failed_thresholds = (
            ThresholdTrace(
                metric=rank_feature,
                comparator="min_gte",
                value=rank_value,
                threshold=high_threshold,
                passed=False,
                missing_policy="fail_closed",
                distance_to_pass=max(Decimal("0"), high_threshold - rank_value),
            ),
            ThresholdTrace(
                metric=rank_feature,
                comparator="max_lte",
                value=rank_value,
                threshold=low_threshold,
                passed=False,
                missing_policy="fail_closed",
                distance_to_pass=max(Decimal("0"), rank_value - low_threshold),
            ),
        )
        trace = _generic_plugin_trace(
            context=context,
            gate="pair_rank_selection",
            passed=should_trade,
            action=resolved_action if should_trade else None,
            rationale=rationale if should_trade else (),
            thresholds=(
                (
                    ThresholdTrace(
                        metric=rank_feature,
                        comparator=("min_gte" if comparator == "gte" else "max_lte"),
                        value=rank_value,
                        threshold=threshold_value,
                        passed=should_trade,
                        missing_policy="fail_closed",
                        distance_to_pass=Decimal("0"),
                    ),
                )
                if should_trade
                else failed_thresholds
            ),
            gate_context={
                "minutes_elapsed": minutes_elapsed,
                "entry_minute_after_open": entry_minute,
                "entry_window_minutes": entry_window_minutes,
                "entry_window_end_minute_after_open": entry_window_end,
                "exit_minute_after_open": exit_minute,
                "selection_mode": selection_mode,
                "top_n": top_n,
                "universe_size": universe_size,
                "configured_universe_size": configured_universe_size,
                "observed_rank_universe_size": observed_rank_universe_size,
                "rank_threshold_basis": rank_threshold_basis,
                "pair_side_count": pair_side_count,
                "max_pair_legs": max_pair_legs,
                "pair_side": pair_side,
                "reason": rejection_reason,
            },
        )
        if not should_trade:
            return PluginEvaluationResult(intent=None, trace=trace)
        assert resolved_action is not None
        rank_distance = (
            rank_value - threshold_value
            if comparator == "gte"
            else threshold_value - rank_value
        )
        confidence = min(
            Decimal("0.95"), Decimal("0.55") + max(Decimal("0"), rank_distance)
        )
        return PluginEvaluationResult(
            intent=StrategyIntent(
                strategy_id=context.strategy_id,
                symbol=context.symbol,
                direction=resolved_action,
                confidence=confidence,
                target_notional=_resolved_target_notional(params),
                horizon=context.timeframe,
                explain=rationale,
                feature_snapshot_hash=features.normalization_hash,
                required_features=_microbar_required_features(params),
            ),
            trace=trace,
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
            "entry_window_minutes": entry_window_minutes,
            "entry_window_end_minute_after_open": entry_window_end,
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
    confidence = min(
        Decimal("0.95"), Decimal("0.55") + max(Decimal("0"), rank_distance)
    )
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
            required_features=_microbar_required_features(params),
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
    strategy_intent_suppression_total: dict[str, int] = field(
        default_factory=lambda: {}
    )
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

    def record_intent_suppression(self, strategy_id: str, reason: str) -> None:
        normalized_reason = reason.strip() or "unknown"
        key = f"{strategy_id}|{normalized_reason}"
        self.strategy_intent_suppression_total[key] = (
            self.strategy_intent_suppression_total.get(key, 0) + 1
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


# Public aliases used by split-module consumers.
evaluate_microbar_cross_sectional = _evaluate_microbar_cross_sectional

__all__ = [name for name in globals() if not name.startswith("__")]
