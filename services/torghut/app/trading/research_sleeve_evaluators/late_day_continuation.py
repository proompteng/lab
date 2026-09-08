from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping
from .core import (
    SleeveSignalEvaluation,
    SleeveSignalResult,
    build_gate,
    build_sleeve_result,
    entry_window_gate,
    exit_trigger_gate,
    required_inputs_gate,
    threshold_bool,
    threshold_max,
    threshold_min,
    threshold_range,
)
from .helpers import (
    bps_delta,
    calculate_imbalance_pressure,
    decayed_minimum,
    decimal_param,
    effective_entry_end_minute,
    isolated_breakout_strength_confirmed,
    isolated_leader_continuation_shape_passes,
    minute_param,
    nonnegative_decimal,
    optional_decimal_param,
    optional_max_threshold,
    optional_min_threshold,
    parse_event_ts,
    prefer_primary_decimal,
    recent_reference_hold_passes,
    relax_floor_for_isolated_strength,
    required_min_threshold,
    resolve_entry_notional_multiplier,
    resolve_live_continuation_rank,
    widen_cap_for_isolated_strength,
    within_utc_window,
)


def evaluate_late_day_continuation_long(
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
    price_position_in_session_range: Decimal | None,
    price_vs_vwap_w5m_bps: Decimal | None,
    session_high_price: Decimal | None,
    opening_range_high: Decimal | None,
    price_vs_opening_range_high_bps: Decimal | None,
    price_vs_opening_window_close_bps: Decimal | None,
    recent_spread_bps_avg: Decimal | None,
    recent_imbalance_pressure_avg: Decimal | None,
    session_range_bps: Decimal | None,
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
    trace_context = {"family": "late_day_continuation_long"}
    required_fields = {
        "price": price is not None,
        "ema12": ema12 is not None,
        "ema26": ema26 is not None,
        "macd": macd is not None,
        "macd_signal": macd_signal is not None,
        "rsi14": rsi14 is not None,
    }
    if not all(required_fields.values()):
        return build_sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(required_inputs_gate(fields=required_fields),),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    ts = parse_event_ts(event_ts)
    entry_start_minute = minute_param(params, "entry_start_minute_utc", 18 * 60 + 15)
    entry_end_minute = effective_entry_end_minute(
        params, default_end_minute=19 * 60 + 20
    )
    within_window = within_utc_window(
        ts, start_minute=entry_start_minute, end_minute=entry_end_minute
    )
    if not within_window:
        return build_sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                entry_window_gate(
                    within_window=within_window,
                    start_minute=entry_start_minute,
                    end_minute=entry_end_minute,
                ),
            ),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    assert price is not None
    assert ema12 is not None
    assert ema26 is not None
    assert macd is not None
    assert macd_signal is not None
    assert rsi14 is not None
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
            params, "min_session_open_drive_bps", Decimal("35")
        ),
        late_floor=optional_decimal_param(
            params, "late_session_min_session_open_drive_bps", None
        ),
    )
    min_opening_window_return_bps = decayed_minimum(
        event_ts=event_ts,
        early_floor=optional_decimal_param(
            params, "min_opening_window_return_bps", Decimal("18")
        ),
        late_floor=optional_decimal_param(
            params, "late_session_min_opening_window_return_bps", None
        ),
    )
    min_session_range_position = optional_decimal_param(
        params, "min_session_range_position", Decimal("0.74")
    )
    min_session_high_above_opening_range_high_bps = optional_decimal_param(
        params, "min_session_high_above_opening_range_high_bps", Decimal("4")
    )
    min_price_vs_vwap_w5m_bps = optional_decimal_param(
        params, "min_price_vs_vwap_w5m_bps", Decimal("-6")
    )
    max_price_vs_vwap_w5m_bps = optional_decimal_param(
        params, "max_price_vs_vwap_w5m_bps", Decimal("14")
    )
    min_price_vs_opening_range_high_bps = optional_decimal_param(
        params, "min_price_vs_opening_range_high_bps", Decimal("-10")
    )
    max_price_vs_opening_range_high_bps = optional_decimal_param(
        params, "max_price_vs_opening_range_high_bps", Decimal("18")
    )
    min_price_vs_opening_window_close_bps = optional_decimal_param(
        params, "min_price_vs_opening_window_close_bps", Decimal("-8")
    )
    max_price_vs_opening_window_close_bps = optional_decimal_param(
        params, "max_price_vs_opening_window_close_bps", Decimal("18")
    )
    max_recent_spread_bps = optional_decimal_param(
        params, "max_recent_spread_bps", Decimal("5")
    )
    min_recent_imbalance_pressure = optional_decimal_param(
        params, "min_recent_imbalance_pressure", Decimal("0")
    )
    min_session_range_bps = optional_decimal_param(
        params, "min_session_range_bps", Decimal("20")
    )
    max_recent_quote_invalid_ratio = optional_decimal_param(
        params, "max_recent_quote_invalid_ratio", Decimal("0.10")
    )
    max_recent_quote_jump_bps = optional_decimal_param(
        params, "max_recent_quote_jump_bps", Decimal("30")
    )
    hard_max_recent_quote_invalid_ratio = optional_decimal_param(
        params, "hard_max_recent_quote_invalid_ratio", Decimal("0.12")
    )
    min_recent_microprice_bias_bps = optional_decimal_param(
        params, "min_recent_microprice_bias_bps", Decimal("0.50")
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
    min_same_day_opening_window_return_bps = optional_decimal_param(
        params, "min_same_day_opening_window_return_bps", Decimal("5")
    )
    min_same_day_positive_opening_window_return_ratio = optional_decimal_param(
        params, "min_same_day_positive_opening_window_return_ratio", None
    )
    min_cross_section_above_vwap_w5m_ratio = optional_decimal_param(
        params, "min_cross_section_above_vwap_w5m_ratio", None
    )
    min_cross_section_continuation_breadth = optional_decimal_param(
        params, "min_cross_section_continuation_breadth", None
    )
    opening_drive_late_day_session_open_drive_bps = optional_decimal_param(
        params, "opening_drive_late_day_session_open_drive_bps", Decimal("45")
    )
    opening_drive_late_day_opening_window_return_bps = optional_decimal_param(
        params, "opening_drive_late_day_opening_window_return_bps", Decimal("25")
    )
    opening_drive_late_day_price_vs_opening_window_close_bps = optional_decimal_param(
        params, "opening_drive_late_day_price_vs_opening_window_close_bps", Decimal("2")
    )
    opening_drive_late_day_session_range_position = optional_decimal_param(
        params, "opening_drive_late_day_session_range_position", Decimal("0.70")
    )
    opening_drive_late_day_recent_above_opening_window_close_ratio = (
        optional_decimal_param(
            params,
            "opening_drive_late_day_recent_above_opening_window_close_ratio",
            Decimal("0.78"),
        )
    )
    opening_drive_late_day_recent_above_vwap_w5m_ratio = optional_decimal_param(
        params, "opening_drive_late_day_recent_above_vwap_w5m_ratio", Decimal("0.68")
    )
    isolated_strength_confirmed = isolated_breakout_strength_confirmed(
        params=params,
        range_position_rank=cross_section_range_position_rank,
        vwap_w5m_rank=cross_section_vwap_w5m_rank,
        recent_imbalance_rank=cross_section_recent_imbalance_rank,
    )
    min_session_open_drive_bps = relax_floor_for_isolated_strength(
        floor=min_session_open_drive_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_session_open_drive_relaxation_bps", Decimal("10")
        ),
    )
    min_opening_window_return_bps = relax_floor_for_isolated_strength(
        floor=min_opening_window_return_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_opening_window_return_relaxation_bps", Decimal("8")
        ),
    )
    max_recent_spread_bps = widen_cap_for_isolated_strength(
        cap=max_recent_spread_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=optional_decimal_param(
            params, "isolated_flow_recent_spread_bps_extension", Decimal("4")
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
    opening_drive_late_day_confirmed = (
        required_min_threshold(
            effective_price_drive_bps, opening_drive_late_day_session_open_drive_bps
        )
        and required_min_threshold(
            effective_opening_window_return_bps,
            opening_drive_late_day_opening_window_return_bps,
        )
        and required_min_threshold(
            price_vs_opening_window_close_bps,
            opening_drive_late_day_price_vs_opening_window_close_bps,
        )
        and required_min_threshold(
            price_position_in_session_range,
            opening_drive_late_day_session_range_position,
        )
        and required_min_threshold(
            recent_above_opening_window_close_ratio,
            opening_drive_late_day_recent_above_opening_window_close_ratio,
        )
        and required_min_threshold(
            recent_above_vwap_w5m_ratio,
            opening_drive_late_day_recent_above_vwap_w5m_ratio,
        )
    )
    late_day_strength_confirmed = (
        isolated_strength_confirmed or opening_drive_late_day_confirmed
    )
    same_day_opening_window_confirmed = required_min_threshold(
        opening_window_return_bps, min_same_day_opening_window_return_bps
    ) and required_min_threshold(
        cross_section_positive_opening_window_return_ratio,
        min_same_day_positive_opening_window_return_ratio,
    )
    min_cross_section_continuation_rank = relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_rank,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "opening_drive_late_day_continuation_rank_relaxation",
            Decimal("0.12"),
        ),
    )
    min_cross_section_opening_window_return_rank = relax_floor_for_isolated_strength(
        floor=min_cross_section_opening_window_return_rank,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "opening_drive_late_day_opening_window_rank_relaxation",
            Decimal("0.12"),
        ),
    )
    min_cross_section_positive_session_open_ratio = relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_session_open_ratio,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "opening_drive_late_day_positive_session_open_ratio_relaxation",
            Decimal("0.12"),
        ),
    )
    min_cross_section_positive_opening_window_return_ratio = (
        relax_floor_for_isolated_strength(
            floor=min_cross_section_positive_opening_window_return_ratio,
            isolated_strength_confirmed=late_day_strength_confirmed,
            relaxation=optional_decimal_param(
                params,
                "opening_drive_late_day_positive_opening_window_ratio_relaxation",
                Decimal("0.15"),
            ),
        )
    )
    min_cross_section_above_vwap_w5m_ratio = relax_floor_for_isolated_strength(
        floor=min_cross_section_above_vwap_w5m_ratio,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "opening_drive_late_day_above_vwap_ratio_relaxation",
            Decimal("0.10"),
        ),
    )
    min_cross_section_continuation_breadth = relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_breadth,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=optional_decimal_param(
            params,
            "opening_drive_late_day_continuation_breadth_relaxation",
            Decimal("0.12"),
        ),
    )
    classical_late_day_shape_passes = (
        optional_min_threshold(
            price_position_in_session_range, min_session_range_position
        )
        and optional_min_threshold(
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
        and optional_min_threshold(session_range_bps, min_session_range_bps)
    )
    isolated_late_day_shape_passes = (
        isolated_leader_continuation_shape_passes(
            params=params,
            isolated_strength_confirmed=isolated_strength_confirmed,
            price_position_in_session_range=price_position_in_session_range,
            price_vs_opening_range_high_bps=price_vs_opening_range_high_bps,
            opening_range_width_bps=None,
            session_range_bps=session_range_bps,
            min_session_range_position_key="isolated_flow_min_late_day_session_range_position",
            default_min_session_range_position=Decimal("0.88"),
            min_price_vs_opening_range_high_key="isolated_flow_min_late_day_price_vs_opening_range_high_bps",
            default_min_price_vs_opening_range_high_bps=Decimal("-24"),
            min_session_range_bps_key="isolated_flow_min_late_day_session_range_bps",
            default_min_session_range_bps=min_session_range_bps or Decimal("20"),
        )
        and optional_max_threshold(
            price_vs_opening_range_high_bps,
            optional_decimal_param(
                params,
                "isolated_flow_max_late_day_price_vs_opening_range_high_bps",
                Decimal("30"),
            ),
        )
        and optional_max_threshold(
            price_vs_opening_window_close_bps,
            optional_decimal_param(
                params,
                "isolated_flow_max_late_day_price_vs_opening_window_close_bps",
                Decimal("40"),
            ),
        )
    )
    recent_late_day_reference_hold_passes = recent_reference_hold_passes(
        recent_above_opening_range_high_ratio=recent_above_opening_range_high_ratio,
        min_recent_above_opening_range_high_ratio=min_recent_above_opening_range_high_ratio,
        recent_above_opening_window_close_ratio=recent_above_opening_window_close_ratio,
        min_recent_above_opening_window_close_ratio=min_recent_above_opening_window_close_ratio,
    )
    late_day_opening_window_close_hold_passes = required_min_threshold(
        recent_above_opening_window_close_ratio,
        min_recent_above_opening_window_close_ratio,
    )
    opening_drive_late_day_shape_passes = (
        opening_drive_late_day_confirmed
        and optional_min_threshold(session_range_bps, min_session_range_bps)
        and optional_min_threshold(price_vs_vwap_w5m_bps, min_price_vs_vwap_w5m_bps)
        and optional_max_threshold(price_vs_vwap_w5m_bps, max_price_vs_vwap_w5m_bps)
        and optional_min_threshold(
            price_vs_opening_window_close_bps, min_price_vs_opening_window_close_bps
        )
        and optional_max_threshold(
            price_vs_opening_window_close_bps, max_price_vs_opening_window_close_bps
        )
    )
    buy_gates = (
        build_gate(
            name="structure",
            category="structure",
            thresholds=(
                threshold_bool(
                    metric="ema12_gt_ema26", passed=ema12 > ema26, threshold=True
                ),
                *threshold_range(
                    metric="macd_hist",
                    value=macd_hist,
                    floor=decimal_param(params, "bullish_hist_min", Decimal("0.006")),
                    ceil=decimal_param(params, "bullish_hist_cap", Decimal("0.05")),
                    required=True,
                ),
                *threshold_range(
                    metric="rsi14",
                    value=rsi14,
                    floor=decimal_param(params, "min_bull_rsi", Decimal("57")),
                    ceil=decimal_param(params, "max_bull_rsi", Decimal("72")),
                    required=True,
                ),
                threshold_min(
                    metric="price_vs_ema12_bps",
                    value=price_vs_ema12_bps,
                    floor=decimal_param(
                        params, "min_price_above_ema12_bps", Decimal("0")
                    ),
                    required=True,
                ),
                threshold_max(
                    metric="price_vs_ema12_bps",
                    value=price_vs_ema12_bps,
                    ceil=decimal_param(
                        params, "max_price_above_ema12_bps", Decimal("14")
                    ),
                    required=True,
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
                    ceil=max_price_vs_vwap_w5m_bps,
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
                threshold_bool(
                    metric="same_day_opening_window_confirmed",
                    passed=same_day_opening_window_confirmed,
                    threshold=True,
                ),
                threshold_bool(
                    metric="late_day_shape_passes",
                    passed=classical_late_day_shape_passes
                    or isolated_late_day_shape_passes
                    or opening_drive_late_day_shape_passes,
                    threshold=True,
                ),
                *threshold_range(
                    metric="vol_realized_w60s",
                    value=vol_realized_w60s,
                    floor=optional_decimal_param(
                        params, "vol_floor", Decimal("0.00005")
                    ),
                    ceil=optional_decimal_param(params, "vol_ceil", Decimal("0.00035")),
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
                threshold_min(
                    metric="imbalance_pressure",
                    value=imbalance_pressure,
                    floor=decimal_param(
                        params, "min_imbalance_pressure", Decimal("-0.01")
                    ),
                    required=True,
                ),
                threshold_max(
                    metric="recent_spread_bps_avg",
                    value=recent_spread_bps_avg,
                    ceil=max_recent_spread_bps,
                    required=False,
                ),
                threshold_min(
                    metric="recent_imbalance_pressure_avg",
                    value=recent_imbalance_pressure_avg,
                    floor=min_recent_imbalance_pressure,
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
                threshold_min(
                    metric="recent_microprice_bias_bps_avg",
                    value=recent_microprice_bias_bps_avg,
                    floor=min_recent_microprice_bias_bps,
                    required=False,
                ),
            ),
        ),
        build_gate(
            name="confirmation",
            category="confirmation",
            thresholds=(
                threshold_bool(
                    metric="recent_late_day_reference_hold_passes",
                    passed=recent_late_day_reference_hold_passes,
                    threshold=True,
                ),
                threshold_bool(
                    metric="late_day_opening_window_close_hold_passes",
                    passed=late_day_opening_window_close_hold_passes,
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
            ),
        ),
    )
    if all((gate.passed for gate in buy_gates)):
        confidence = Decimal("0.69")
        if price_vs_vwap_w5m_bps is not None and price_vs_vwap_w5m_bps >= Decimal("4"):
            confidence += Decimal("0.03")
        if effective_spread_bps <= Decimal("3"):
            confidence += Decimal("0.02")
        if imbalance_pressure >= Decimal("0.04"):
            confidence += Decimal("0.02")
        if (
            effective_price_drive_bps is not None
            and effective_price_drive_bps >= Decimal("60")
        ):
            confidence += Decimal("0.03")
        if (
            effective_opening_window_return_bps is not None
            and effective_opening_window_return_bps >= Decimal("30")
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
            and recent_microprice_bias_bps_avg >= Decimal("1.5")
        ):
            confidence += Decimal("0.03")
        if (
            cross_section_continuation_breadth is not None
            and cross_section_continuation_breadth >= Decimal("0.60")
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
                confidence=min(confidence, Decimal("0.87")),
                rationale=(
                    "late_day_continuation_long",
                    "trend_up",
                    "session_strength_confirmed",
                    "late_day_strength",
                    "close_auction_setup",
                ),
                notional_multiplier=resolve_entry_notional_multiplier(
                    params=params,
                    confidence=min(confidence, Decimal("0.87")),
                    rank=effective_continuation_rank,
                    spread_bps=effective_spread_bps,
                    spread_cap_bps=spread_cap_bps,
                ),
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    exit_reasons: dict[str, bool] = {
        "below_vwap": price_vs_vwap_w5m_bps is not None
        and price_vs_vwap_w5m_bps
        <= decimal_param(params, "exit_price_vs_vwap_w5m_bps", Decimal("-10")),
        "range_position_lost": price_position_in_session_range is not None
        and price_position_in_session_range
        <= decimal_param(params, "exit_session_range_position_min", Decimal("0.58")),
        "session_drive_lost": price_vs_session_open_bps is not None
        and price_vs_session_open_bps
        <= decimal_param(params, "exit_session_open_drive_bps", Decimal("24")),
        "momentum_rollover": macd_hist
        <= decimal_param(params, "exit_macd_hist_max", Decimal("-0.004"))
        and rsi14 <= decimal_param(params, "exit_rsi_max", Decimal("55")),
        "below_opening_range_high": price_vs_opening_range_high_bps is not None
        and price_vs_opening_range_high_bps
        <= decimal_param(
            params, "exit_price_below_opening_range_high_bps", Decimal("-16")
        ),
        "imbalance_reversal": recent_imbalance_pressure_avg is not None
        and recent_imbalance_pressure_avg
        <= decimal_param(
            params, "exit_recent_imbalance_pressure_max", Decimal("-0.02")
        ),
    }
    exit_gate = exit_trigger_gate(reason_flags=exit_reasons)
    if exit_gate.passed:
        return build_sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action="sell",
                confidence=Decimal("0.63"),
                rationale=("late_day_continuation_exit", "late_day_failure"),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
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
    "evaluate_late_day_continuation_long",
]
