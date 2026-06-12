# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F403,F405,F811,F821


logger = logging.getLogger(__name__)

_SHORT_ENTRY_BELOW_MIN_QTY_REASON = "short_entry_below_min_qty"

_SAME_DIRECTION_REENTRY_REASON = "same_direction_reentry"

_EXIT_ONLY_SELL_FLAT_REASON = "exit_only_sell_without_long_position"

_EXIT_ONLY_BUY_FLAT_REASON = "exit_only_buy_without_short_position"

_RUNTIME_TRADE_POLICY_SHARED_OWNER = "__shared__"

_SELL_EXIT_ONLY_STRATEGY_TYPES = {
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

_BUY_EXIT_ONLY_STRATEGY_TYPES = {
    "mean_reversion_exhaustion_short_v1",
    "microbar_cross_sectional_short_v1",
}

_MICROBAR_PAIR_EXIT_RATIONALE = "microbar_cross_sectional_pair_exit"


def _feature_vector_with_runtime_position(
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


def _runtime_position_side(position_qty: Decimal | None) -> str | None:
    if position_qty is None:
        return None
    if position_qty > 0:
        return "long"
    if position_qty < 0:
        return "short"
    return "flat"


def _feature_vector_with_positions(
    feature_vector: FeatureVectorV3,
    *,
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> FeatureVectorV3:
    position_qty = _position_qty_for_symbol(positions, symbol)
    if position_qty is None:
        return feature_vector
    return _feature_vector_with_runtime_position(
        feature_vector,
        position_qty=position_qty,
        position_side=_runtime_position_side(position_qty),
    )


def _merge_runtime_counter(
    target: dict[str, int],
    source: Mapping[str, int],
) -> None:
    for key, value in source.items():
        target[str(key)] = target.get(str(key), 0) + int(value)


def _merge_runtime_evaluations(
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
        _merge_runtime_counter(
            observation.strategy_events_total,
            evaluation.observation.strategy_events_total,
        )
        _merge_runtime_counter(
            observation.strategy_intents_total,
            evaluation.observation.strategy_intents_total,
        )
        _merge_runtime_counter(
            observation.strategy_intent_suppression_total,
            evaluation.observation.strategy_intent_suppression_total,
        )
        _merge_runtime_counter(
            observation.strategy_errors_total,
            evaluation.observation.strategy_errors_total,
        )
        _merge_runtime_counter(
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
class _RuntimeTradePolicySessionState:
    session_day: date
    entry_count: int = 0
    stop_loss_exit_count: int = 0
    negative_exit_count: int = 0
    cumulative_negative_exit_bps: Decimal = field(default_factory=lambda: Decimal("0"))
    last_stop_loss_exit_at: datetime | None = None
    last_negative_exit_at: datetime | None = None


class _DecisionEngineFieldsPart1:
    """Evaluate TA signals against configured strategies."""


__all__ = [name for name in globals() if not name.startswith("__")]
