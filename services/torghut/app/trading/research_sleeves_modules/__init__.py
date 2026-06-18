"""Explicit research sleeve module exports."""

from __future__ import annotations

from .core import (
    SleeveSignalEvaluation,
    SleeveSignalResult,
    make_strategy_trace,
    threshold_min,
    threshold_max,
    threshold_range,
    threshold_bool,
    build_gate,
    build_sleeve_result,
    required_inputs_gate,
    entry_window_gate,
    exit_trigger_gate,
    rank_thresholds,
)
from .momentum_pullback import (
    evaluate_momentum_pullback_long,
)
from .breakout_continuation import (
    evaluate_breakout_continuation_long,
)
from .mean_reversion_rebound import (
    evaluate_mean_reversion_rebound_long,
)
from .mean_reversion_exhaustion_short import (
    evaluate_mean_reversion_exhaustion_short,
)
from .washout_rebound import (
    evaluate_washout_rebound_long,
)
from .late_day_continuation import (
    evaluate_late_day_continuation_long,
)
from .end_of_day_reversal import (
    evaluate_end_of_day_reversal_long,
)
from .helpers import (
    parse_event_ts,
    minute_param,
    optional_minute_param,
    decimal_param,
    optional_decimal_param,
    within_utc_window,
    effective_entry_end_minute,
    bps_delta,
    ratio_decimal_over_bps,
    prefer_primary_decimal,
    select_reference_decimal,
    weighted_average_decimal,
    session_minutes_elapsed,
    resolve_live_continuation_rank,
    decayed_minimum,
    early_breakout_quality_passes,
    isolated_breakout_strength_confirmed,
    confirm_same_day_leadership,
    confirm_leader_reclaim,
    relax_floor_for_isolated_strength,
    widen_cap_for_isolated_strength,
    isolated_leader_continuation_shape_passes,
    nonnegative_decimal,
    scaled_extension_cap,
    calculate_imbalance_pressure,
    optional_min_threshold,
    required_min_threshold,
    recent_reference_hold_passes,
    optional_max_threshold,
    resolve_entry_notional_multiplier,
    normalize_score,
)

__all__ = [
    "SleeveSignalEvaluation",
    "SleeveSignalResult",
    "make_strategy_trace",
    "threshold_min",
    "threshold_max",
    "threshold_range",
    "threshold_bool",
    "build_gate",
    "build_sleeve_result",
    "required_inputs_gate",
    "entry_window_gate",
    "exit_trigger_gate",
    "rank_thresholds",
    "evaluate_momentum_pullback_long",
    "evaluate_breakout_continuation_long",
    "evaluate_mean_reversion_rebound_long",
    "evaluate_mean_reversion_exhaustion_short",
    "evaluate_washout_rebound_long",
    "evaluate_late_day_continuation_long",
    "evaluate_end_of_day_reversal_long",
    "parse_event_ts",
    "minute_param",
    "optional_minute_param",
    "decimal_param",
    "optional_decimal_param",
    "within_utc_window",
    "effective_entry_end_minute",
    "bps_delta",
    "ratio_decimal_over_bps",
    "prefer_primary_decimal",
    "select_reference_decimal",
    "weighted_average_decimal",
    "session_minutes_elapsed",
    "resolve_live_continuation_rank",
    "decayed_minimum",
    "early_breakout_quality_passes",
    "isolated_breakout_strength_confirmed",
    "confirm_same_day_leadership",
    "confirm_leader_reclaim",
    "relax_floor_for_isolated_strength",
    "widen_cap_for_isolated_strength",
    "isolated_leader_continuation_shape_passes",
    "nonnegative_decimal",
    "scaled_extension_cap",
    "calculate_imbalance_pressure",
    "optional_min_threshold",
    "required_min_threshold",
    "recent_reference_hold_passes",
    "optional_max_threshold",
    "resolve_entry_notional_multiplier",
    "normalize_score",
]
