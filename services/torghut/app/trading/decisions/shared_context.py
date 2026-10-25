"""Trading decision engine based on TA signals."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable, Optional

from ..features import (
    FeatureVectorV3,
)
from ..evaluation_trace import StrategyTrace
from ..strategy_runtime import (
    AggregatedIntent,
    RuntimeErrorRecord,
    RuntimeDecision,
    RuntimeEvaluation,
    RuntimeObservation,
)


logger = logging.getLogger(__name__)

SHORT_ENTRY_BELOW_MIN_QTY_REASON = "short_entry_below_min_qty"

SAME_DIRECTION_REENTRY_REASON = "same_direction_reentry"

EXIT_ONLY_SELL_FLAT_REASON = "exit_only_sell_without_long_position"

EXIT_ONLY_BUY_FLAT_REASON = "exit_only_buy_without_short_position"

RUNTIME_TRADE_POLICY_SHARED_OWNER = "__shared__"

SELL_EXIT_ONLY_STRATEGY_TYPES = {
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

BUY_EXIT_ONLY_STRATEGY_TYPES = {
    "mean_reversion_exhaustion_short_v1",
    "microbar_cross_sectional_short_v1",
}

MICROBAR_PAIR_EXIT_RATIONALE = "microbar_cross_sectional_pair_exit"


def feature_vector_with_runtime_position(
    feature_vector: FeatureVectorV3,
    *,
    position_qty: Decimal,
    position_side: str | None,
) -> FeatureVectorV3:
    values = dict(feature_vector.values)
    values["runtime_position_qty"] = position_qty
    values["runtime_position_side"] = position_side
    normalized_payload = {
        "event_ts": feature_vector.event_ts.isoformat(),
        "symbol": feature_vector.symbol,
        "timeframe": feature_vector.timeframe,
        "seq": feature_vector.seq,
        "source": feature_vector.source,
        "feature_schema_version": feature_vector.feature_schema_version,
        "values": {key: values[key] for key in sorted(values)},
    }
    normalization_hash = hashlib.sha256(
        json.dumps(
            normalized_payload,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()
    return FeatureVectorV3(
        event_ts=feature_vector.event_ts,
        symbol=feature_vector.symbol,
        timeframe=feature_vector.timeframe,
        seq=feature_vector.seq,
        source=feature_vector.source,
        feature_schema_version=feature_vector.feature_schema_version,
        values=values,
        normalization_hash=normalization_hash,
    )


@dataclass(frozen=True)
class DecisionRuntimeTelemetry:
    mode: str
    runtime_enabled: bool
    fallback_to_legacy: bool
    errors: tuple[RuntimeErrorRecord, ...] = field(default_factory=tuple)
    observation: RuntimeObservation | None = None
    traces: tuple[StrategyTrace, ...] = field(default_factory=tuple)


def runtime_position_side(position_qty: Decimal | None) -> str | None:
    if position_qty is None:
        return None
    if position_qty > 0:
        return "long"
    if position_qty < 0:
        return "short"
    return "flat"


def feature_vector_with_positions(
    feature_vector: FeatureVectorV3,
    *,
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> FeatureVectorV3:
    from .positions_for_strategy_action import position_qty_for_symbol

    position_qty = position_qty_for_symbol(positions, symbol)
    if position_qty is None:
        return feature_vector
    return feature_vector_with_runtime_position(
        feature_vector,
        position_qty=position_qty,
        position_side=runtime_position_side(position_qty),
    )


def merge_runtime_counter(
    target: dict[str, int],
    source: Mapping[str, int],
) -> None:
    for key, value in source.items():
        target[str(key)] = target.get(str(key), 0) + int(value)


def merge_runtime_evaluations(
    evaluations: Iterable[RuntimeEvaluation],
) -> RuntimeEvaluation:
    intents: list[AggregatedIntent] = []
    raw_intents: list[RuntimeDecision] = []
    traces: list[StrategyTrace] = []
    errors: list[RuntimeErrorRecord] = []
    observation = RuntimeObservation()
    for evaluation in evaluations:
        intents.extend(evaluation.intents)
        raw_intents.extend(evaluation.raw_intents)
        traces.extend(evaluation.traces)
        errors.extend(evaluation.errors)
        merge_runtime_counter(
            observation.strategy_events_total,
            evaluation.observation.strategy_events_total,
        )
        merge_runtime_counter(
            observation.strategy_intents_total,
            evaluation.observation.strategy_intents_total,
        )
        merge_runtime_counter(
            observation.strategy_intent_suppression_total,
            evaluation.observation.strategy_intent_suppression_total,
        )
        merge_runtime_counter(
            observation.strategy_errors_total,
            evaluation.observation.strategy_errors_total,
        )
        merge_runtime_counter(
            observation.strategy_latency_ms,
            evaluation.observation.strategy_latency_ms,
        )
        observation.intent_conflicts_total += (
            evaluation.observation.intent_conflicts_total
        )
        observation.isolated_failures_total += (
            evaluation.observation.isolated_failures_total
        )
    return RuntimeEvaluation(
        intents=intents,
        raw_intents=raw_intents,
        traces=traces,
        errors=errors,
        observation=observation,
    )


@dataclass
class RuntimeTradePolicySessionState:
    session_day: date
    entry_count: int = 0
    stop_loss_exit_count: int = 0
    negative_exit_count: int = 0
    cumulative_negative_exit_bps: Decimal = field(default_factory=lambda: Decimal("0"))
    last_stop_loss_exit_at: datetime | None = None
    last_negative_exit_at: datetime | None = None


class DecisionEngineFields:
    """Evaluate TA signals against configured strategies."""


__all__: tuple[str, ...] = (
    "BUY_EXIT_ONLY_STRATEGY_TYPES",
    "DecisionEngineFields",
    "DecisionRuntimeTelemetry",
    "EXIT_ONLY_BUY_FLAT_REASON",
    "EXIT_ONLY_SELL_FLAT_REASON",
    "MICROBAR_PAIR_EXIT_RATIONALE",
    "RUNTIME_TRADE_POLICY_SHARED_OWNER",
    "RuntimeTradePolicySessionState",
    "SAME_DIRECTION_REENTRY_REASON",
    "SELL_EXIT_ONLY_STRATEGY_TYPES",
    "SHORT_ENTRY_BELOW_MIN_QTY_REASON",
    "feature_vector_with_positions",
    "feature_vector_with_runtime_position",
    "merge_runtime_evaluations",
    "logger",
    "runtime_position_side",
)
