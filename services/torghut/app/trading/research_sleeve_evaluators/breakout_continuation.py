from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping
from .core import (
    SleeveSignalEvaluation,
    SleeveSignalResult,
    build_gate,
    build_sleeve_result,
    threshold_bool,
    threshold_max,
    threshold_min,
    threshold_range,
)
from .breakout_exit import breakout_exit_result
from .helpers import (
    bps_delta,
    calculate_imbalance_pressure,
    confirm_leader_reclaim,
    confirm_same_day_leadership,
    decayed_minimum,
    decimal_param,
    early_breakout_quality_passes,
    effective_entry_end_minute,
    isolated_breakout_strength_confirmed,
    isolated_leader_continuation_shape_passes,
    minute_param,
    nonnegative_decimal,
    optional_decimal_param,
    optional_max_threshold,
    optional_min_threshold,
    optional_minute_param,
    parse_event_ts,
    prefer_primary_decimal,
    ratio_decimal_over_bps,
    recent_reference_hold_passes,
    relax_floor_for_isolated_strength,
    resolve_entry_notional_multiplier,
    resolve_live_continuation_rank,
    scaled_extension_cap,
    widen_cap_for_isolated_strength,
    within_utc_window,
)


def evaluate_breakout_continuation_long(
    *,
    params: Mapping[str, Any],
    strategy_id: str | None,
    strategy_type: str | None,
    symbol: str,
    event_ts: str,
    timeframe: str | None,
    trace_enabled: bool,
    price: Decimal | None,
    ema12: Decimal | None,
    ema26: Decimal | None,
    macd: Decimal | None,
    macd_signal: Decimal | None,
    rsi14: Decimal | None,
    vol_realized_w60s: Decimal | None,
    spread_bps: Decimal | None,
    imbalance_bid_sz: Decimal | None,
    imbalance_ask_sz: Decimal | None,
    price_vs_session_open_bps: Decimal | None,
    price_vs_prev_session_close_bps: Decimal | None,
    opening_window_return_bps: Decimal | None,
    opening_window_return_from_prev_close_bps: Decimal | None,
    price_vs_opening_range_high_bps: Decimal | None,
    price_vs_opening_window_close_bps: Decimal | None,
    opening_range_width_bps: Decimal | None,
    session_range_bps: Decimal | None,
    price_position_in_session_range: Decimal | None,
    price_vs_vwap_w5m_bps: Decimal | None,
    session_high_price: Decimal | None,
    opening_range_high: Decimal | None,
    recent_spread_bps_avg: Decimal | None,
    recent_spread_bps_max: Decimal | None,
    recent_imbalance_pressure_avg: Decimal | None,
    recent_quote_invalid_ratio: Decimal | None,
    recent_quote_jump_bps_max: Decimal | None,
    recent_microprice_bias_bps_avg: Decimal | None,
    recent_above_opening_range_high_ratio: Decimal | None,
    recent_above_opening_window_close_ratio: Decimal | None,
    recent_above_vwap_w5m_ratio: Decimal | None,
    cross_section_positive_session_open_ratio: Decimal | None,
    cross_section_positive_prev_session_close_ratio: Decimal | None,
    cross_section_positive_opening_window_return_ratio: Decimal | None,
    cross_section_positive_opening_window_return_from_prev_close_ratio: Decimal | None,
    cross_section_above_vwap_w5m_ratio: Decimal | None,
    cross_section_continuation_breadth: Decimal | None,
    cross_section_session_open_rank: Decimal | None,
    cross_section_opening_window_return_rank: Decimal | None,
    cross_section_prev_session_close_rank: Decimal | None,
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None,
    cross_section_range_position_rank: Decimal | None,
    cross_section_vwap_w5m_rank: Decimal | None,
    cross_section_recent_imbalance_rank: Decimal | None,
    cross_section_continuation_rank: Decimal | None,
) -> SleeveSignalResult:
    trace_context = {"family": "breakout_continuation_long"}
    if (
        price is None
        or ema12 is None
        or ema26 is None
        or (macd is None)
        or (macd_signal is None)
        or (rsi14 is None)
    ):
        return build_sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                build_gate(
                    name="eligibility",
                    category="eligibility",
                    thresholds=(
                        threshold_bool(
                            metric="required_inputs_present",
                            passed=False,
                            threshold=True,
                            value={
                                "price": price is not None,
                                "ema12": ema12 is not None,
                                "ema26": ema26 is not None,
                                "macd": macd is not None,
                                "macd_signal": macd_signal is not None,
                                "rsi14": rsi14 is not None,
                            },
                        ),
                    ),
                ),
            ),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    ts = parse_event_ts(event_ts)
    entry_start_minute = minute_param(params, "entry_start_minute_utc", 14 * 60 + 15)
    entry_end_minute = effective_entry_end_minute(
        params, default_end_minute=19 * 60 + 45
    )
    latest_breakout_entry_end_minute = optional_minute_param(
        params, "latest_breakout_entry_end_minute_utc"
    )
    if latest_breakout_entry_end_minute is not None:
        entry_end_minute = min(entry_end_minute, latest_breakout_entry_end_minute)
    if not within_utc_window(
        ts, start_minute=entry_start_minute, end_minute=entry_end_minute
    ):
        return build_sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                build_gate(
                    name="eligibility",
                    category="eligibility",
                    thresholds=(
                        threshold_bool(
                            metric="within_entry_window",
                            passed=False,
                            threshold="entry_window",
                        ),
                    ),
                    context={
                        "entry_start_minute_utc": entry_start_minute,
                        "entry_end_minute_utc": entry_end_minute,
                    },
                ),
            ),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    macd_hist = macd - macd_signal
    price_vs_ema12_bps = bps_delta(price, ema12)
    effective_spread_bps = nonnegative_decimal(spread_bps)
    imbalance_pressure = calculate_imbalance_pressure(
        imbalance_bid_sz, imbalance_ask_sz
    )
    effective_price_drive_bps = prefer_primary_decimal(
        price_vs_prev_session_close_bps, price_vs_session_open_bps
    )
    effective_opening_window_return_bps = prefer_primary_decimal(
        opening_window_return_from_prev_close_bps, opening_window_return_bps
    )
    session_open_return_efficiency = ratio_decimal_over_bps(
        opening_window_return_bps, opening_range_width_bps
    )
    effective_positive_session_open_ratio = prefer_primary_decimal(
        cross_section_positive_prev_session_close_ratio,
        cross_section_positive_session_open_ratio,
    )
    effective_positive_opening_window_return_ratio = prefer_primary_decimal(
        cross_section_positive_opening_window_return_from_prev_close_ratio,
        cross_section_positive_opening_window_return_ratio,
    )
    effective_opening_window_return_rank = prefer_primary_decimal(
        cross_section_opening_window_return_from_prev_close_rank,
        cross_section_opening_window_return_rank,
    )
    effective_continuation_rank = resolve_live_continuation_rank(
        event_ts=event_ts,
        cross_section_session_open_rank=cross_section_session_open_rank,
        cross_section_prev_session_close_rank=cross_section_prev_session_close_rank,
        cross_section_opening_window_return_rank=cross_section_opening_window_return_rank,
        cross_section_opening_window_return_from_prev_close_rank=cross_section_opening_window_return_from_prev_close_rank,
        cross_section_range_position_rank=cross_section_range_position_rank,
        cross_section_vwap_w5m_rank=cross_section_vwap_w5m_rank,
        cross_section_recent_imbalance_rank=cross_section_recent_imbalance_rank,
        fallback_rank=cross_section_continuation_rank,
    )
    session_high_vs_opening_range_high_bps = bps_delta(
        session_high_price, opening_range_high
    )
    min_session_open_drive_bps = decayed_minimum(
        event_ts=event_ts,
        early_floor=optional_decimal_param(
            params, "min_session_open_drive_bps", Decimal("20")
        ),
        late_floor=optional_decimal_param(
            params, "late_session_min_session_open_drive_bps", None
        ),
    )
    min_opening_window_return_bps = decayed_minimum(
        event_ts=event_ts,
        early_floor=optional_decimal_param(
            params, "min_opening_window_return_bps", Decimal("12")
        ),
        late_floor=optional_decimal_param(
            params, "late_session_min_opening_window_return_bps", None
        ),
    )
    min_session_open_return_efficiency = decayed_minimum(
        event_ts=event_ts,
        early_floor=optional_decimal_param(
            params, "min_session_open_return_efficiency", Decimal("0.60")
        ),
        late_floor=optional_decimal_param(
            params, "late_session_min_session_open_return_efficiency", Decimal("0.45")
        ),
    )
    min_session_high_above_opening_range_high_bps = optional_decimal_param(
        params, "min_session_high_above_opening_range_high_bps", Decimal("4")
    )
    min_price_vs_opening_range_high_bps = decimal_param(
        params,
        "min_price_vs_opening_range_high_bps",
        decimal_param(params, "min_price_above_opening_range_high_bps", Decimal("-12")),
    )
    max_price_vs_opening_range_high_bps = decimal_param(
        params,
        "max_price_vs_opening_range_high_bps",
        decimal_param(params, "max_price_above_opening_range_high_bps", Decimal("24")),
    )
    min_price_vs_opening_window_close_bps = optional_decimal_param(
        params, "min_price_vs_opening_window_close_bps", Decimal("-10")
    )
    max_price_vs_opening_window_close_bps = optional_decimal_param(
        params, "max_price_vs_opening_window_close_bps", Decimal("18")
    )
    min_opening_range_width_bps = optional_decimal_param(
        params, "min_opening_range_width_bps", Decimal("8")
    )
    min_session_range_bps = optional_decimal_param(
        params, "min_session_range_bps", Decimal("18")
    )
    min_session_range_position = optional_decimal_param(
        params, "min_session_range_position", Decimal("0.72")
    )
    min_price_vs_vwap_w5m_bps = optional_decimal_param(
        params, "min_price_vs_vwap_w5m_bps", Decimal("-8")
    )
    max_price_vs_vwap_w5m_bps = optional_decimal_param(
        params, "max_price_vs_vwap_w5m_bps", Decimal("18")
    )
    max_recent_spread_bps = optional_decimal_param(
        params, "max_recent_spread_bps", Decimal("6")
    )
    max_recent_spread_bps_max = optional_decimal_param(
        params, "max_recent_spread_bps_max", Decimal("8")
    )
    min_recent_imbalance_pressure = optional_decimal_param(
        params, "min_recent_imbalance_pressure", Decimal("0.01")
    )
    max_recent_quote_invalid_ratio = optional_decimal_param(
        params, "max_recent_quote_invalid_ratio", Decimal("0.12")
    )
    hard_max_recent_quote_invalid_ratio = optional_decimal_param(
        params, "hard_max_recent_quote_invalid_ratio", None
    )
    max_recent_quote_jump_bps = optional_decimal_param(
        params, "max_recent_quote_jump_bps", Decimal("35")
    )
    min_recent_microprice_bias_bps = optional_decimal_param(
        params, "min_recent_microprice_bias_bps", Decimal("0.25")
    )
    min_recent_above_opening_range_high_ratio = optional_decimal_param(
        params, "min_recent_above_opening_range_high_ratio", None
    )
    min_recent_above_opening_window_close_ratio = optional_decimal_param(
        params, "min_recent_above_opening_window_close_ratio", None
    )
    min_recent_above_vwap_w5m_ratio = optional_decimal_param(
        params, "min_recent_above_vwap_w5m_ratio", None
    )
    spread_cap_bps = decimal_param(params, "max_spread_bps", Decimal("6"))
    min_imbalance_pressure = decimal_param(
        params, "min_imbalance_pressure", Decimal("0")
    )
    min_cross_section_continuation_rank = optional_decimal_param(
        params, "min_cross_section_continuation_rank", None
    )
    min_cross_section_opening_window_return_rank = decayed_minimum(
        event_ts=event_ts,
        early_floor=optional_decimal_param(
            params, "min_cross_section_opening_window_return_rank", None
        ),
        late_floor=optional_decimal_param(
            params, "late_session_min_cross_section_opening_window_return_rank", None
        ),
    )
    min_cross_section_positive_session_open_ratio = optional_decimal_param(
        params, "min_cross_section_positive_session_open_ratio", None
    )
    min_cross_section_positive_opening_window_return_ratio = decayed_minimum(
        event_ts=event_ts,
        early_floor=optional_decimal_param(
            params, "min_cross_section_positive_opening_window_return_ratio", None
        ),
        late_floor=optional_decimal_param(
            params,
            "late_session_min_cross_section_positive_opening_window_return_ratio",
            None,
        ),
    )
    min_cross_section_above_vwap_w5m_ratio = optional_decimal_param(
        params, "min_cross_section_above_vwap_w5m_ratio", None
    )
    min_cross_section_continuation_breadth = optional_decimal_param(
        params, "min_cross_section_continuation_breadth", None
    )
    early_breakout_quality_cutoff_minutes = minute_param(
        params, "early_breakout_quality_cutoff_minutes", 90
    )
    early_breakout_elite_continuation_rank = optional_decimal_param(
        params, "early_breakout_elite_continuation_rank", Decimal("0.90")
    )
    min_early_breakout_continuation_breadth = optional_decimal_param(
        params, "min_early_breakout_continuation_breadth", Decimal("0.75")
    )
    min_early_breakout_microprice_bias_bps = optional_decimal_param(
        params, "min_early_breakout_microprice_bias_bps", Decimal("0.60")
    )
    ema_extension_cap_bps = scaled_extension_cap(
        base_cap=decimal_param(params, "max_price_above_ema12_bps", Decimal("16")),
        reference_bps=session_range_bps or opening_range_width_bps,
        multiplier=optional_decimal_param(
            params, "ema_extension_range_multiplier", Decimal("0.60")
        ),
    )
    vwap_w5m_extension_cap_bps = scaled_extension_cap(
        base_cap=max_price_vs_vwap_w5m_bps,
        reference_bps=session_range_bps or opening_range_width_bps,
        multiplier=optional_decimal_param(
            params, "vwap_w5m_range_multiplier", Decimal("0.45")
        ),
    )
    isolated_flow_strength_confirmed = isolated_breakout_strength_confirmed(
        params=params,
        range_position_rank=cross_section_range_position_rank,
        vwap_w5m_rank=cross_section_vwap_w5m_rank,
        recent_imbalance_rank=cross_section_recent_imbalance_rank,
    )
    isolated_same_day_leadership_confirmed = confirm_same_day_leadership(
        params=params,
        session_open_rank=cross_section_session_open_rank,
        opening_window_return_rank=cross_section_opening_window_return_rank,
        continuation_rank=effective_continuation_rank,
        microprice_bias_bps=recent_microprice_bias_bps_avg,
        price_vs_opening_window_close_bps=price_vs_opening_window_close_bps,
        recent_above_opening_window_close_ratio=recent_above_opening_window_close_ratio,
    )
    isolated_strength_confirmed = (
        isolated_flow_strength_confirmed or isolated_same_day_leadership_confirmed
    )
    leader_reclaim_confirmed = confirm_leader_reclaim(
        params=params,
        event_ts=event_ts,
        same_day_leadership_confirmed=isolated_same_day_leadership_confirmed,
        recent_imbalance_pressure_avg=recent_imbalance_pressure_avg,
        recent_microprice_bias_bps_avg=recent_microprice_bias_bps_avg,
        recent_above_opening_window_close_ratio=recent_above_opening_window_close_ratio,
        recent_above_vwap_w5m_ratio=recent_above_vwap_w5m_ratio,
        price_position_in_session_range=price_position_in_session_range,
        price_vs_vwap_w5m_bps=price_vs_vwap_w5m_bps,
    )
    effective_bullish_hist_min = decimal_param(
        params, "bullish_hist_min", Decimal("0.008")
    )
    if leader_reclaim_confirmed:
        effective_bullish_hist_min -= optional_decimal_param(
            params, "leader_reclaim_bullish_hist_relaxation", Decimal("0.053")
        ) or Decimal("0")
    effective_min_bull_rsi = relax_floor_for_isolated_strength(
        floor=decimal_param(params, "min_bull_rsi", Decimal("58")),
        isolated_strength_confirmed=leader_reclaim_confirmed,
        relaxation=optional_decimal_param(
            params, "leader_reclaim_min_bull_rsi_relaxation", Decimal("4")
        ),
    )
    effective_max_bull_rsi = widen_cap_for_isolated_strength(
        cap=decimal_param(params, "max_bull_rsi", Decimal("72")),
        isolated_strength_confirmed=leader_reclaim_confirmed,
        extension=optional_decimal_param(
            params, "leader_reclaim_max_bull_rsi_extension", Decimal("6")
        ),
    )
    effective_vol_ceil = widen_cap_for_isolated_strength(
        cap=optional_decimal_param(params, "vol_ceil", Decimal("0.00040")),
        isolated_strength_confirmed=leader_reclaim_confirmed,
        extension=optional_decimal_param(
            params, "leader_reclaim_vol_ceil_extension", Decimal("0.00030")
        ),
    )
    effective_min_imbalance_pressure = relax_floor_for_isolated_strength(
        floor=min_imbalance_pressure,
        isolated_strength_confirmed=leader_reclaim_confirmed,
        relaxation=optional_decimal_param(
            params, "leader_reclaim_imbalance_relaxation", Decimal("0.22")
        ),
    )
    if effective_min_bull_rsi is None:
        effective_min_bull_rsi = Decimal("58")
    if effective_max_bull_rsi is None:
        effective_max_bull_rsi = Decimal("72")
    if effective_min_imbalance_pressure is None:
        effective_min_imbalance_pressure = Decimal("0")
    min_session_open_drive_bps = relax_floor_for_isolated_strength(
        floor=min_session_open_drive_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_session_open_drive_relaxation_bps", Decimal("8")
        ),
    )
    min_opening_window_return_bps = relax_floor_for_isolated_strength(
        floor=min_opening_window_return_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_opening_window_return_relaxation_bps", Decimal("6")
        ),
    )
    min_session_open_return_efficiency = relax_floor_for_isolated_strength(
        floor=min_session_open_return_efficiency,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "isolated_flow_session_open_return_efficiency_relaxation",
            Decimal("0.10"),
        ),
    )
    min_cross_section_positive_session_open_ratio = relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_session_open_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_session_open_ratio_relaxation", Decimal("0.12")
        ),
    )
    min_cross_section_positive_session_open_ratio = relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_session_open_ratio,
        isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_same_day_session_open_ratio_relaxation", Decimal("0.25")
        ),
    )
    min_cross_section_positive_opening_window_return_ratio = (
        relax_floor_for_isolated_strength(
            floor=min_cross_section_positive_opening_window_return_ratio,
            isolated_strength_confirmed=isolated_strength_confirmed,
            relaxation=optional_decimal_param(
                params, "isolated_flow_opening_window_ratio_relaxation", Decimal("0.15")
            ),
        )
    )
    min_cross_section_positive_opening_window_return_ratio = (
        relax_floor_for_isolated_strength(
            floor=min_cross_section_positive_opening_window_return_ratio,
            isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
            relaxation=optional_decimal_param(
                params,
                "isolated_same_day_opening_window_ratio_relaxation",
                Decimal("0.25"),
            ),
        )
    )
    min_cross_section_above_vwap_w5m_ratio = relax_floor_for_isolated_strength(
        floor=min_cross_section_above_vwap_w5m_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_above_vwap_ratio_relaxation", Decimal("0.15")
        ),
    )
    min_cross_section_above_vwap_w5m_ratio = relax_floor_for_isolated_strength(
        floor=min_cross_section_above_vwap_w5m_ratio,
        isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_same_day_above_vwap_ratio_relaxation", Decimal("0.20")
        ),
    )
    min_cross_section_continuation_breadth = relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_breadth,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_continuation_breadth_relaxation", Decimal("0.15")
        ),
    )
    min_cross_section_continuation_breadth = relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_breadth,
        isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_same_day_continuation_breadth_relaxation", Decimal("0.30")
        ),
    )
    max_recent_spread_bps = widen_cap_for_isolated_strength(
        cap=max_recent_spread_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=optional_decimal_param(
            params, "isolated_flow_recent_spread_bps_extension", Decimal("4")
        ),
    )
    max_recent_spread_bps_max = widen_cap_for_isolated_strength(
        cap=max_recent_spread_bps_max,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=optional_decimal_param(
            params, "isolated_flow_recent_spread_bps_max_extension", Decimal("18")
        ),
    )
    max_recent_quote_invalid_ratio = widen_cap_for_isolated_strength(
        cap=max_recent_quote_invalid_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=optional_decimal_param(
            params,
            "isolated_flow_recent_quote_invalid_ratio_extension",
            Decimal("0.10"),
        ),
    )
    min_recent_microprice_bias_bps = relax_floor_for_isolated_strength(
        floor=min_recent_microprice_bias_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "isolated_flow_recent_microprice_bias_relaxation_bps",
            Decimal("0.15"),
        ),
    )
    min_recent_above_opening_range_high_ratio = relax_floor_for_isolated_strength(
        floor=min_recent_above_opening_range_high_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_recent_above_orh_ratio_relaxation", Decimal("0.20")
        ),
    )
    min_recent_above_opening_window_close_ratio = relax_floor_for_isolated_strength(
        floor=min_recent_above_opening_window_close_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "isolated_flow_recent_above_open_close_ratio_relaxation",
            Decimal("0.15"),
        ),
    )
    min_recent_above_vwap_w5m_ratio = relax_floor_for_isolated_strength(
        floor=min_recent_above_vwap_w5m_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_recent_above_vwap_ratio_relaxation", Decimal("0.15")
        ),
    )
    min_session_high_above_opening_range_high_bps = relax_floor_for_isolated_strength(
        floor=min_session_high_above_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_session_high_above_orh_relaxation_bps", Decimal("4")
        ),
    )
    min_price_vs_opening_range_high_bps = relax_floor_for_isolated_strength(
        floor=min_price_vs_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_price_vs_orh_relaxation_bps", Decimal("12")
        ),
    )
    min_price_vs_opening_window_close_bps = relax_floor_for_isolated_strength(
        floor=min_price_vs_opening_window_close_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_price_vs_open_close_min_relaxation_bps", Decimal("4")
        ),
    )
    max_price_vs_opening_range_high_bps = widen_cap_for_isolated_strength(
        cap=max_price_vs_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=optional_decimal_param(
            params, "isolated_flow_price_vs_orh_cap_extension_bps", Decimal("8")
        ),
    )
    max_price_vs_opening_window_close_bps = widen_cap_for_isolated_strength(
        cap=max_price_vs_opening_window_close_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=optional_decimal_param(
            params, "isolated_flow_price_vs_open_close_cap_extension_bps", Decimal("14")
        ),
    )
    classical_breakout_shape_passes = (
        optional_min_threshold(
            session_high_vs_opening_range_high_bps,
            min_session_high_above_opening_range_high_bps,
        )
        and optional_min_threshold(
            price_vs_opening_range_high_bps, min_price_vs_opening_range_high_bps
        )
        and optional_max_threshold(
            price_vs_opening_range_high_bps, max_price_vs_opening_range_high_bps
        )
        and optional_min_threshold(
            price_vs_opening_window_close_bps, min_price_vs_opening_window_close_bps
        )
        and optional_max_threshold(
            price_vs_opening_window_close_bps, max_price_vs_opening_window_close_bps
        )
        and optional_min_threshold(opening_range_width_bps, min_opening_range_width_bps)
        and optional_min_threshold(session_range_bps, min_session_range_bps)
        and optional_min_threshold(
            price_position_in_session_range, min_session_range_position
        )
    )
    isolated_continuation_shape_passes = isolated_leader_continuation_shape_passes(
        params=params,
        isolated_strength_confirmed=isolated_strength_confirmed,
        price_position_in_session_range=price_position_in_session_range,
        price_vs_opening_range_high_bps=price_vs_opening_range_high_bps,
        opening_range_width_bps=opening_range_width_bps,
        session_range_bps=session_range_bps,
    )
    recent_breakout_reference_hold_passes = recent_reference_hold_passes(
        recent_above_opening_range_high_ratio=recent_above_opening_range_high_ratio,
        min_recent_above_opening_range_high_ratio=min_recent_above_opening_range_high_ratio,
        recent_above_opening_window_close_ratio=recent_above_opening_window_close_ratio,
        min_recent_above_opening_window_close_ratio=min_recent_above_opening_window_close_ratio,
    )
    buy_gates = (
        build_gate(
            name="structure",
            category="structure",
            thresholds=(
                threshold_bool(
                    metric="ema12_gt_ema26", passed=ema12 > ema26, threshold=True
                ),
                threshold_min(
                    metric="macd_hist",
                    value=macd_hist,
                    floor=effective_bullish_hist_min,
                    required=True,
                ),
                *threshold_range(
                    metric="rsi14",
                    value=rsi14,
                    floor=effective_min_bull_rsi,
                    ceil=effective_max_bull_rsi,
                    required=True,
                ),
                threshold_min(
                    metric="price_vs_ema12_bps",
                    value=price_vs_ema12_bps,
                    floor=decimal_param(
                        params, "min_price_above_ema12_bps", Decimal("0")
                    ),
                    required=False,
                ),
                threshold_max(
                    metric="price_vs_ema12_bps",
                    value=price_vs_ema12_bps,
                    ceil=ema_extension_cap_bps,
                    required=False,
                ),
                threshold_min(
                    metric="price_vs_vwap_w5m_bps",
                    value=price_vs_vwap_w5m_bps,
                    floor=min_price_vs_vwap_w5m_bps,
                    required=False,
                ),
                threshold_max(
                    metric="price_vs_vwap_w5m_bps",
                    value=price_vs_vwap_w5m_bps,
                    ceil=vwap_w5m_extension_cap_bps,
                    required=False,
                ),
                threshold_min(
                    metric="effective_price_drive_bps",
                    value=effective_price_drive_bps,
                    floor=min_session_open_drive_bps,
                    required=False,
                ),
                threshold_min(
                    metric="effective_opening_window_return_bps",
                    value=effective_opening_window_return_bps,
                    floor=min_opening_window_return_bps,
                    required=False,
                ),
                threshold_min(
                    metric="session_open_return_efficiency",
                    value=session_open_return_efficiency,
                    floor=min_session_open_return_efficiency,
                    required=False,
                ),
                threshold_bool(
                    metric="shape_passes",
                    passed=classical_breakout_shape_passes
                    or isolated_continuation_shape_passes,
                    threshold=True,
                ),
                *threshold_range(
                    metric="vol_realized_w60s",
                    value=vol_realized_w60s,
                    floor=optional_decimal_param(
                        params, "vol_floor", Decimal("0.00004")
                    ),
                    ceil=effective_vol_ceil,
                    required=False,
                ),
            ),
        ),
        build_gate(
            name="feed_quality",
            category="feed_quality",
            thresholds=(
                threshold_max(
                    metric="spread_bps",
                    value=effective_spread_bps,
                    ceil=spread_cap_bps,
                    required=True,
                ),
                threshold_max(
                    metric="recent_spread_bps_avg",
                    value=recent_spread_bps_avg,
                    ceil=max_recent_spread_bps,
                    required=False,
                ),
                threshold_max(
                    metric="recent_spread_bps_max",
                    value=recent_spread_bps_max,
                    ceil=max_recent_spread_bps_max,
                    required=False,
                ),
                threshold_max(
                    metric="recent_quote_invalid_ratio_hard",
                    value=recent_quote_invalid_ratio,
                    ceil=hard_max_recent_quote_invalid_ratio,
                    required=False,
                ),
                threshold_max(
                    metric="recent_quote_invalid_ratio",
                    value=recent_quote_invalid_ratio,
                    ceil=max_recent_quote_invalid_ratio,
                    required=False,
                ),
                threshold_max(
                    metric="recent_quote_jump_bps_max",
                    value=recent_quote_jump_bps_max,
                    ceil=max_recent_quote_jump_bps,
                    required=False,
                ),
            ),
        ),
        build_gate(
            name="confirmation",
            category="confirmation",
            thresholds=(
                threshold_min(
                    metric="imbalance_pressure",
                    value=imbalance_pressure,
                    floor=effective_min_imbalance_pressure,
                    required=True,
                ),
                threshold_min(
                    metric="recent_imbalance_pressure_avg",
                    value=recent_imbalance_pressure_avg,
                    floor=min_recent_imbalance_pressure,
                    required=False,
                ),
                threshold_min(
                    metric="recent_microprice_bias_bps_avg",
                    value=recent_microprice_bias_bps_avg,
                    floor=min_recent_microprice_bias_bps,
                    required=False,
                ),
                threshold_bool(
                    metric="recent_breakout_reference_hold_passes",
                    passed=recent_breakout_reference_hold_passes,
                    threshold=True,
                ),
                threshold_min(
                    metric="recent_above_vwap_w5m_ratio",
                    value=recent_above_vwap_w5m_ratio,
                    floor=min_recent_above_vwap_w5m_ratio,
                    required=False,
                ),
                threshold_min(
                    metric="effective_continuation_rank",
                    value=effective_continuation_rank,
                    floor=min_cross_section_continuation_rank,
                    required=False,
                ),
                threshold_min(
                    metric="effective_opening_window_return_rank",
                    value=effective_opening_window_return_rank,
                    floor=min_cross_section_opening_window_return_rank,
                    required=False,
                ),
                threshold_min(
                    metric="effective_positive_session_open_ratio",
                    value=effective_positive_session_open_ratio,
                    floor=min_cross_section_positive_session_open_ratio,
                    required=False,
                ),
                threshold_min(
                    metric="effective_positive_opening_window_return_ratio",
                    value=effective_positive_opening_window_return_ratio,
                    floor=min_cross_section_positive_opening_window_return_ratio,
                    required=False,
                ),
                threshold_min(
                    metric="cross_section_above_vwap_w5m_ratio",
                    value=cross_section_above_vwap_w5m_ratio,
                    floor=min_cross_section_above_vwap_w5m_ratio,
                    required=False,
                ),
                threshold_min(
                    metric="cross_section_continuation_breadth",
                    value=cross_section_continuation_breadth,
                    floor=min_cross_section_continuation_breadth,
                    required=False,
                ),
                threshold_bool(
                    metric="early_breakout_quality_passes",
                    passed=early_breakout_quality_passes(
                        event_ts=event_ts,
                        cutoff_minutes=early_breakout_quality_cutoff_minutes,
                        continuation_rank=effective_continuation_rank,
                        elite_continuation_rank=early_breakout_elite_continuation_rank,
                        continuation_breadth=cross_section_continuation_breadth,
                        min_continuation_breadth=min_early_breakout_continuation_breadth,
                        microprice_bias_bps=recent_microprice_bias_bps_avg,
                        min_microprice_bias_bps=min_early_breakout_microprice_bias_bps,
                    ),
                    threshold=True,
                ),
            ),
        ),
    )
    if all((gate.passed for gate in buy_gates)):
        confidence = Decimal("0.68")
        if (
            price_vs_opening_range_high_bps is not None
            and price_vs_opening_range_high_bps >= 0
        ):
            confidence += Decimal("0.03")
        if price_vs_vwap_w5m_bps is not None and price_vs_vwap_w5m_bps >= 0:
            confidence += Decimal("0.03")
        if imbalance_pressure >= Decimal("0.08"):
            confidence += Decimal("0.03")
        if (
            effective_price_drive_bps is not None
            and effective_price_drive_bps >= Decimal("35")
        ):
            confidence += Decimal("0.03")
        if (
            effective_opening_window_return_bps is not None
            and effective_opening_window_return_bps >= Decimal("25")
        ):
            confidence += Decimal("0.02")
        if (
            effective_continuation_rank is not None
            and effective_continuation_rank >= Decimal("0.85")
        ):
            confidence += Decimal("0.03")
        if (
            effective_opening_window_return_rank is not None
            and effective_opening_window_return_rank >= Decimal("0.85")
        ):
            confidence += Decimal("0.02")
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal("1.0")
        ):
            confidence += Decimal("0.02")
        if (
            cross_section_continuation_breadth is not None
            and cross_section_continuation_breadth >= Decimal("0.65")
        ):
            confidence += Decimal("0.02")
        return build_sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action="buy",
                confidence=min(confidence, Decimal("0.86")),
                rationale=(
                    "breakout_continuation_long",
                    "trend_up",
                    "session_drive_confirmed",
                    "opening_range_breakout",
                    "above_vwap",
                    "leader_reclaim_confirmed"
                    if leader_reclaim_confirmed
                    else "imbalance_confirmed",
                ),
                notional_multiplier=resolve_entry_notional_multiplier(
                    params=params,
                    confidence=min(confidence, Decimal("0.86")),
                    rank=effective_continuation_rank,
                    spread_bps=effective_spread_bps,
                    spread_cap_bps=spread_cap_bps,
                ),
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    exit_result = breakout_exit_result(
        params=params,
        strategy_id=strategy_id,
        strategy_type=strategy_type,
        symbol=symbol,
        event_ts=event_ts,
        timeframe=timeframe,
        trace_enabled=trace_enabled,
        trace_context=trace_context,
        price=price,
        ema12=ema12,
        rsi14=rsi14,
        macd_hist=macd_hist,
        price_vs_opening_range_high_bps=price_vs_opening_range_high_bps,
        price_vs_vwap_w5m_bps=price_vs_vwap_w5m_bps,
        price_position_in_session_range=price_position_in_session_range,
        price_vs_session_open_bps=price_vs_session_open_bps,
        recent_imbalance_pressure_avg=recent_imbalance_pressure_avg,
        isolated_strength_confirmed=isolated_strength_confirmed,
    )
    if exit_result is not None:
        return exit_result
    return build_sleeve_result(
        strategy_id=strategy_id,
        strategy_type=strategy_type,
        symbol=symbol,
        event_ts=event_ts,
        timeframe=timeframe,
        signal=None,
        gates=buy_gates,
        trace_enabled=trace_enabled,
        context=trace_context,
    )


__all__ = [
    "evaluate_breakout_continuation_long",
]
