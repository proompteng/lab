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
                category="structure",
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
    event_minutes: int | None = None
    try:
        event_ts = datetime.fromisoformat(context.event_ts)
        event_minutes = regular_session_minutes_elapsed(event_ts)
    except ValueError:
        event_minutes = None
    raw_minutes = features.values.get("session_minutes_elapsed")
    if raw_minutes is not None:
        try:
            parsed_minutes = max(0, int(raw_minutes))
        except (TypeError, ValueError):
            return None
        if event_minutes is not None and event_minutes > parsed_minutes:
            return event_minutes
        return parsed_minutes
    return event_minutes


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


def _microbar_entry_window_minutes(params: dict[str, Any]) -> int:
    resolved = _decimal(params.get("entry_window_minutes"))
    if resolved is None:
        return 0
    return max(0, int(resolved))


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


def _microbar_pair_max_legs(params: dict[str, Any]) -> int:
    raw_max_legs = _decimal(params.get("max_pair_legs"))
    if raw_max_legs is None:
        return 2
    return int(raw_max_legs)


def _microbar_pair_side_count(
    *,
    universe_size: int,
    max_pair_legs: int,
) -> int:
    if universe_size < 2 or max_pair_legs < 2:
        return 0
    return max(1, min(universe_size // 2, max_pair_legs // 2))


def _microbar_rank_universe_size(
    *,
    context: "StrategyContext",
    params: dict[str, Any],
    features: FeatureVectorV3,
    rank_feature: str,
) -> int:
    executable_universe_size = _microbar_observed_rank_universe_size(
        features=features,
        rank_feature=rank_feature,
    )
    if executable_universe_size is not None and executable_universe_size > 0:
        return executable_universe_size
    return _microbar_universe_size(context=context, params=params)


def _microbar_observed_rank_universe_size(
    *,
    features: FeatureVectorV3,
    rank_feature: str,
) -> int | None:
    executable_universe_size = _decimal(
        features.values.get(f"{rank_feature}_universe_size")
    )
    if executable_universe_size is not None and executable_universe_size > 0:
        return max(1, int(executable_universe_size))
    return None


def _microbar_pair_rank_thresholds(
    *,
    context: "StrategyContext",
    params: dict[str, Any],
    features: FeatureVectorV3,
    rank_feature: str,
    pair_side_count: int,
) -> tuple[Decimal, Decimal, str, int, int | None]:
    configured_universe_size = _microbar_universe_size(context=context, params=params)
    observed_universe_size = _microbar_observed_rank_universe_size(
        features=features,
        rank_feature=rank_feature,
    )
    if (
        configured_universe_size == 2
        and observed_universe_size is not None
        and observed_universe_size > configured_universe_size
        and pair_side_count == 1
    ):
        midpoint = Decimal("0.5")
        return (
            midpoint,
            midpoint,
            "configured_pair_midpoint",
            configured_universe_size,
            observed_universe_size,
        )
    low_threshold, high_threshold = _microbar_rank_thresholds(
        universe_size=observed_universe_size or configured_universe_size,
        top_n=pair_side_count,
    )
    return (
        low_threshold,
        high_threshold,
        "observed_rank_universe"
        if observed_universe_size is not None
        else "configured_universe",
        configured_universe_size,
        observed_universe_size,
    )


def _microbar_runtime_position_qty(features: FeatureVectorV3) -> Decimal | None:
    return _decimal(features.values.get("runtime_position_qty"))


def _microbar_required_features(params: dict[str, Any]) -> tuple[str, ...]:
    required = ["session_minutes_elapsed"]
    rank_feature = str(params.get("rank_feature") or "").strip()
    gate_feature = str(params.get("gate_feature") or "").strip()
    if rank_feature:
        required.append(rank_feature)
    if gate_feature:
        required.append(gate_feature)
    return tuple(dict.fromkeys(required))


__all__ = [name for name in globals() if not name.startswith("__")]
