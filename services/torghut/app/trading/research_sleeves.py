"""Research-backed intraday sleeve evaluation exports."""

from __future__ import annotations

from app.trading.research_sleeve_evaluators import (
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
    evaluate_momentum_pullback_long,
    evaluate_breakout_continuation_long,
    evaluate_mean_reversion_rebound_long,
    evaluate_mean_reversion_exhaustion_short,
    evaluate_washout_rebound_long,
    evaluate_late_day_continuation_long,
    evaluate_end_of_day_reversal_long,
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

_make_strategy_trace = make_strategy_trace
_threshold_min = threshold_min
_threshold_max = threshold_max
_threshold_range = threshold_range
_threshold_bool = threshold_bool
_gate = build_gate
_sleeve_result = build_sleeve_result
_required_inputs_gate = required_inputs_gate
_entry_window_gate = entry_window_gate
_exit_trigger_gate = exit_trigger_gate
_rank_thresholds = rank_thresholds
_parse_event_ts = parse_event_ts
_minute_param = minute_param
_optional_minute_param = optional_minute_param
_decimal_param = decimal_param
_optional_decimal_param = optional_decimal_param
_within_utc_window = within_utc_window
_effective_entry_end_minute = effective_entry_end_minute
_bps_delta = bps_delta
_ratio_decimal_over_bps = ratio_decimal_over_bps
_prefer_primary_decimal = prefer_primary_decimal
_select_reference_decimal = select_reference_decimal
_weighted_average_decimal = weighted_average_decimal
_session_minutes_elapsed = session_minutes_elapsed
_resolve_live_continuation_rank = resolve_live_continuation_rank
_decayed_minimum = decayed_minimum
_early_breakout_quality_passes = early_breakout_quality_passes
_isolated_breakout_strength_confirmed = isolated_breakout_strength_confirmed
_isolated_same_day_leadership_confirmed = confirm_same_day_leadership
_leader_reclaim_confirmed = confirm_leader_reclaim
_relax_floor_for_isolated_strength = relax_floor_for_isolated_strength
_widen_cap_for_isolated_strength = widen_cap_for_isolated_strength
_isolated_leader_continuation_shape_passes = isolated_leader_continuation_shape_passes
_nonnegative_decimal = nonnegative_decimal
_scaled_extension_cap = scaled_extension_cap
_imbalance_pressure = calculate_imbalance_pressure
_optional_min_threshold = optional_min_threshold
_required_min_threshold = required_min_threshold
_recent_reference_hold_passes = recent_reference_hold_passes
_optional_max_threshold = optional_max_threshold
_resolve_entry_notional_multiplier = resolve_entry_notional_multiplier
_normalize_score = normalize_score

__all__ = [
    "SleeveSignalEvaluation",
    "SleeveSignalResult",
    "_make_strategy_trace",
    "_threshold_min",
    "_threshold_max",
    "_threshold_range",
    "_threshold_bool",
    "_gate",
    "_sleeve_result",
    "_required_inputs_gate",
    "_entry_window_gate",
    "_exit_trigger_gate",
    "_rank_thresholds",
    "_parse_event_ts",
    "_minute_param",
    "_optional_minute_param",
    "_decimal_param",
    "_optional_decimal_param",
    "_within_utc_window",
    "_effective_entry_end_minute",
    "_bps_delta",
    "_ratio_decimal_over_bps",
    "_prefer_primary_decimal",
    "_select_reference_decimal",
    "_weighted_average_decimal",
    "_session_minutes_elapsed",
    "_resolve_live_continuation_rank",
    "_decayed_minimum",
    "_early_breakout_quality_passes",
    "_isolated_breakout_strength_confirmed",
    "_isolated_same_day_leadership_confirmed",
    "_leader_reclaim_confirmed",
    "_relax_floor_for_isolated_strength",
    "_widen_cap_for_isolated_strength",
    "_isolated_leader_continuation_shape_passes",
    "_nonnegative_decimal",
    "_scaled_extension_cap",
    "_imbalance_pressure",
    "_optional_min_threshold",
    "_required_min_threshold",
    "_recent_reference_hold_passes",
    "_optional_max_threshold",
    "_resolve_entry_notional_multiplier",
    "_normalize_score",
    "evaluate_momentum_pullback_long",
    "evaluate_breakout_continuation_long",
    "evaluate_mean_reversion_rebound_long",
    "evaluate_mean_reversion_exhaustion_short",
    "evaluate_washout_rebound_long",
    "evaluate_late_day_continuation_long",
    "evaluate_end_of_day_reversal_long",
]
