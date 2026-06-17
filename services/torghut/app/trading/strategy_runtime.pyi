from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
# ruff: noqa: F401,F811,F821
from typing import Any
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
from .session_context import regular_session_minutes_elapsed
from .strategy_specs import (
    build_compiled_strategy_artifacts,
    strategy_type_supports_spec_v2,
)

def _empty_meta(*args: Any, **kwargs: Any) -> Any: ...
def _generic_plugin_trace(*args: Any, **kwargs: Any) -> Any: ...
def _plugin_result_from_sleeve_result(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_minutes_elapsed(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_exit_minute_after_open(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_entry_window_minutes(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_universe_size(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_rank_thresholds(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_pair_max_legs(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_pair_side_count(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_rank_universe_size(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_observed_rank_universe_size(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_pair_rank_thresholds(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_runtime_position_qty(*args: Any, **kwargs: Any) -> Any: ...
def _microbar_required_features(*args: Any, **kwargs: Any) -> Any: ...
def _evaluate_microbar_cross_sectional(*args: Any, **kwargs: Any) -> Any: ...

class StrategyDefinition:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    universe_symbols: tuple[str, ...]
    compiler_source: str
    strategy_spec: dict[str, Any]
    compiled_targets: dict[str, Any]

class StrategyContext:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    strategy_id: str
    strategy_name: str
    declared_strategy_id: str
    strategy_type: str
    strategy_version: str
    event_ts: str
    symbol: str
    timeframe: str
    params: dict[str, Any]
    trace_enabled: bool
    strategy_spec: dict[str, Any]

class StrategyIntent:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    strategy_id: str
    symbol: str
    direction: Literal["buy", "sell"]
    confidence: Decimal
    target_notional: Decimal
    horizon: str
    explain: tuple[str, ...]
    feature_snapshot_hash: str
    required_features: tuple[str, ...]
    def action(*args: Any, **kwargs: Any) -> Any: ...
    def rationale(*args: Any, **kwargs: Any) -> Any: ...

class AggregatedIntent:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    symbol: str
    direction: Literal["buy", "sell"]
    confidence: Decimal
    target_notional: Decimal
    horizon: str
    explain: tuple[str, ...]
    source_strategy_ids: tuple[str, ...]
    feature_snapshot_hashes: tuple[str, ...]

class RuntimeDecision:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    compiler_source: str
    strategy_spec: dict[str, Any]
    compiled_targets: dict[str, Any]
    def metadata(*args: Any, **kwargs: Any) -> Any: ...

class RuntimeErrorRecord:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    strategy_id: str
    strategy_type: str
    plugin_id: str
    reason: str

class RuntimeObservation:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    strategy_events_total: dict[str, int]
    strategy_intents_total: dict[str, int]
    strategy_intent_suppression_total: dict[str, int]
    strategy_errors_total: dict[str, int]
    strategy_latency_ms: dict[str, int]
    intent_conflicts_total: int
    isolated_failures_total: int
    def record_event(*args: Any, **kwargs: Any) -> Any: ...
    def record_intent(*args: Any, **kwargs: Any) -> Any: ...
    def record_intent_suppression(*args: Any, **kwargs: Any) -> Any: ...
    def record_error(*args: Any, **kwargs: Any) -> Any: ...

class RuntimeEvaluation:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    intents: list[AggregatedIntent]
    raw_intents: list[RuntimeDecision]
    traces: list[StrategyTrace]
    errors: list[RuntimeErrorRecord]
    observation: RuntimeObservation

class StrategyPlugin(Protocol):
    plugin_id: str
    version: str
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class PluginEvaluationResult:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    intent: StrategyIntent | None
    trace: StrategyTrace | None

def _coerce_plugin_result(*args: Any, **kwargs: Any) -> Any: ...
def _trace_suppression_reason(*args: Any, **kwargs: Any) -> Any: ...

class _CircuitState:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    consecutive_errors: int
    degraded_until: datetime | None

class StrategyRegistry:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    def resolve(*args: Any, **kwargs: Any) -> Any: ...
    def is_degraded(*args: Any, **kwargs: Any) -> Any: ...
    def record_success(*args: Any, **kwargs: Any) -> Any: ...
    def record_error(*args: Any, **kwargs: Any) -> Any: ...

class IntentAggregator:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    def aggregate(*args: Any, **kwargs: Any) -> Any: ...

class LegacyMacdRsiPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class IntradayTsmomPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class MomentumPullbackLongPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class BreakoutContinuationLongPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class MeanReversionReboundLongPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class MeanReversionExhaustionShortPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class MicrobarCrossSectionalLongPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class MicrobarCrossSectionalShortPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class MicrobarCrossSectionalPairsPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class WashoutReboundLongPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class LateDayContinuationLongPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class EndOfDayReversalLongPlugin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    plugin_id: Any
    version: Any
    required_features: tuple[str, ...]
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...

class StrategyRuntime:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    def evaluate(*args: Any, **kwargs: Any) -> Any: ...
    def evaluate_all(*args: Any, **kwargs: Any) -> Any: ...
    def definition_from_strategy(*args: Any, **kwargs: Any) -> Any: ...
    def _strategy_plugin_type(*args: Any, **kwargs: Any) -> Any: ...
    def _strategy_version(*args: Any, **kwargs: Any) -> Any: ...
    def _strategy_params(*args: Any, **kwargs: Any) -> Any: ...
    def _normalized_universe_symbols(*args: Any, **kwargs: Any) -> Any: ...
    def _catalog_metadata(*args: Any, **kwargs: Any) -> Any: ...
    def _parameter_hash(*args: Any, **kwargs: Any) -> Any: ...

def _decimal(*args: Any, **kwargs: Any) -> Any: ...
def _target_notional(*args: Any, **kwargs: Any) -> Any: ...
def _resolved_target_notional(*args: Any, **kwargs: Any) -> Any: ...
