from __future__ import annotations

from app.strategies.catalog import extract_catalog_metadata

from .strategy_runtime_modules import (
    part_01_empty_meta as _empty_meta_helpers,
    part_02_evaluate_microbar_cross_sectional as _microbar_evaluator_helpers,
    part_03_coerce_plugin_result as _plugin_result_helpers,
)
from .strategy_runtime_modules.part_02_evaluate_microbar_cross_sectional import (
    AggregatedIntent,
    PluginEvaluationResult,
    RuntimeDecision,
    RuntimeErrorRecord,
    RuntimeEvaluation,
    RuntimeObservation,
    StrategyContext,
    StrategyDefinition,
    StrategyIntent,
    StrategyPlugin,
)
from .strategy_runtime_modules.part_03_coerce_plugin_result import (
    IntentAggregator,
    IntradayTsmomPlugin,
    LegacyMacdRsiPlugin,
    MomentumPullbackLongPlugin,
    StrategyRegistry,
)
from .strategy_runtime_modules.part_04_breakoutcontinuationlongplugin import (
    BreakoutContinuationLongPlugin,
    MeanReversionExhaustionShortPlugin,
    MeanReversionReboundLongPlugin,
    MicrobarCrossSectionalLongPlugin,
    MicrobarCrossSectionalPairsPlugin,
    MicrobarCrossSectionalShortPlugin,
    WashoutReboundLongPlugin,
)
from .strategy_runtime_modules.part_05_latedaycontinuationlongplugin import (
    EndOfDayReversalLongPlugin,
    LateDayContinuationLongPlugin,
    StrategyRuntime,
)
from .strategy_specs import (
    build_compiled_strategy_artifacts,
    strategy_type_supports_spec_v2,
)

_microbar_entry_window_minutes = getattr(
    _empty_meta_helpers,
    "_microbar_entry_window_minutes",
)
_microbar_exit_minute_after_open = getattr(
    _empty_meta_helpers,
    "_microbar_exit_minute_after_open",
)
_microbar_minutes_elapsed = getattr(
    _empty_meta_helpers,
    "_microbar_minutes_elapsed",
)
_microbar_pair_max_legs = getattr(
    _empty_meta_helpers,
    "_microbar_pair_max_legs",
)
_microbar_pair_rank_thresholds = getattr(
    _empty_meta_helpers,
    "_microbar_pair_rank_thresholds",
)
_microbar_pair_side_count = getattr(
    _empty_meta_helpers,
    "_microbar_pair_side_count",
)
_microbar_rank_thresholds = getattr(
    _empty_meta_helpers,
    "_microbar_rank_thresholds",
)
_microbar_rank_universe_size = getattr(
    _empty_meta_helpers,
    "_microbar_rank_universe_size",
)
_microbar_required_features = getattr(
    _empty_meta_helpers,
    "_microbar_required_features",
)
_microbar_universe_size = getattr(
    _empty_meta_helpers,
    "_microbar_universe_size",
)
_evaluate_microbar_cross_sectional = getattr(
    _microbar_evaluator_helpers,
    "_evaluate_microbar_cross_sectional",
)
_trace_suppression_reason = getattr(
    _plugin_result_helpers,
    "_trace_suppression_reason",
)

__all__ = [
    "AggregatedIntent",
    "BreakoutContinuationLongPlugin",
    "EndOfDayReversalLongPlugin",
    "IntentAggregator",
    "IntradayTsmomPlugin",
    "LateDayContinuationLongPlugin",
    "LegacyMacdRsiPlugin",
    "MeanReversionExhaustionShortPlugin",
    "MeanReversionReboundLongPlugin",
    "MicrobarCrossSectionalLongPlugin",
    "MicrobarCrossSectionalPairsPlugin",
    "MicrobarCrossSectionalShortPlugin",
    "MomentumPullbackLongPlugin",
    "PluginEvaluationResult",
    "RuntimeDecision",
    "RuntimeErrorRecord",
    "RuntimeEvaluation",
    "RuntimeObservation",
    "StrategyContext",
    "StrategyDefinition",
    "StrategyIntent",
    "StrategyPlugin",
    "StrategyRegistry",
    "StrategyRuntime",
    "WashoutReboundLongPlugin",
    "_evaluate_microbar_cross_sectional",
    "_microbar_entry_window_minutes",
    "_microbar_exit_minute_after_open",
    "_microbar_minutes_elapsed",
    "_microbar_pair_max_legs",
    "_microbar_pair_rank_thresholds",
    "_microbar_pair_side_count",
    "_microbar_rank_thresholds",
    "_microbar_rank_universe_size",
    "_microbar_required_features",
    "_microbar_universe_size",
    "_trace_suppression_reason",
    "build_compiled_strategy_artifacts",
    "extract_catalog_metadata",
    "strategy_type_supports_spec_v2",
]
