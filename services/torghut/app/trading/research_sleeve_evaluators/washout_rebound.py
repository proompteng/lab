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
    threshold_max,
    threshold_min,
    threshold_range,
)
from .helpers import (
    bps_delta,
    calculate_imbalance_pressure,
    decimal_param,
    effective_entry_end_minute,
    minute_param,
    nonnegative_decimal,
    optional_decimal_param,
    parse_event_ts,
    prefer_primary_decimal,
    resolve_entry_notional_multiplier,
    within_utc_window,
)


def evaluate_washout_rebound_long(
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
    macd: Decimal | None,
    macd_signal: Decimal | None,
    rsi14: Decimal | None,
    vol_realized_w60s: Decimal | None,
    vwap_session: Decimal | None,
    spread_bps: Decimal | None,
    imbalance_bid_sz: Decimal | None,
    imbalance_ask_sz: Decimal | None,
    price_vs_session_open_bps: Decimal | None,
    price_vs_prev_session_close_bps: Decimal | None,
    opening_window_return_bps: Decimal | None,
    opening_window_return_from_prev_close_bps: Decimal | None,
    price_position_in_session_range: Decimal | None,
    price_vs_session_low_bps: Decimal | None,
    price_vs_opening_range_low_bps: Decimal | None,
    session_range_bps: Decimal | None,
    recent_spread_bps_avg: Decimal | None,
    recent_spread_bps_max: Decimal | None,
    recent_imbalance_pressure_avg: Decimal | None,
    recent_quote_invalid_ratio: Decimal | None,
    recent_quote_jump_bps_max: Decimal | None,
    recent_microprice_bias_bps_avg: Decimal | None,
    recent_above_vwap_w5m_ratio: Decimal | None,
    cross_section_opening_window_return_rank: Decimal | None,
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None,
    cross_section_continuation_rank: Decimal | None,
    cross_section_reversal_rank: Decimal | None,
    cross_section_recent_imbalance_rank: Decimal | None,
    cross_section_positive_recent_imbalance_ratio: Decimal | None,
) -> SleeveSignalResult:
    trace_context = {"family": "washout_rebound_long"}
    required_fields = {
        "price": price is not None,
        "ema12": ema12 is not None,
        "macd": macd is not None,
        "macd_signal": macd_signal is not None,
        "rsi14": rsi14 is not None,
        "price_vs_session_low_bps": price_vs_session_low_bps is not None,
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
    entry_start_minute = minute_param(params, "entry_start_minute_utc", 14 * 60 + 10)
    entry_end_minute = effective_entry_end_minute(
        params, default_end_minute=17 * 60 + 30
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
    assert macd is not None
    assert macd_signal is not None
    assert rsi14 is not None
    assert price_vs_session_low_bps is not None
    macd_hist = macd - macd_signal
    price_vs_ema12_bps = bps_delta(price, ema12)
    price_vs_vwap_bps = (
        bps_delta(price, vwap_session)
        if vwap_session is not None
        else price_vs_ema12_bps
    )
    effective_spread_bps = nonnegative_decimal(spread_bps)
    imbalance_pressure = calculate_imbalance_pressure(
        imbalance_bid_sz, imbalance_ask_sz
    )
    effective_session_open_drive_bps = prefer_primary_decimal(
        price_vs_session_open_bps, price_vs_prev_session_close_bps
    )
    effective_opening_window_return_bps = prefer_primary_decimal(
        opening_window_return_bps, opening_window_return_from_prev_close_bps
    )
    effective_opening_window_return_rank = prefer_primary_decimal(
        cross_section_opening_window_return_rank,
        cross_section_opening_window_return_from_prev_close_rank,
    )
    price_below_vwap_bps = -price_vs_vwap_bps if price_vs_vwap_bps is not None else None
    price_below_ema12_bps = (
        -price_vs_ema12_bps if price_vs_ema12_bps is not None else None
    )
    session_open_selloff_bps = (
        -effective_session_open_drive_bps
        if effective_session_open_drive_bps is not None
        else None
    )
    opening_window_selloff_bps = (
        -effective_opening_window_return_bps
        if effective_opening_window_return_bps is not None
        else None
    )
    max_session_open_selloff_bps = decimal_param(
        params, "max_session_open_selloff_bps", Decimal("120")
    )
    max_price_below_vwap_bps = decimal_param(
        params, "max_price_below_vwap_bps", Decimal("120")
    )
    if session_range_bps is not None:
        max_session_open_selloff_bps = max(
            max_session_open_selloff_bps,
            session_range_bps
            * decimal_param(
                params, "max_session_open_selloff_range_multiplier", Decimal("3.5")
            ),
        )
        max_price_below_vwap_bps = max(
            max_price_below_vwap_bps,
            session_range_bps
            * decimal_param(
                params, "max_price_below_vwap_range_multiplier", Decimal("5.0")
            ),
        )
    buy_gates = (
        build_gate(
            name="structure",
            category="structure",
            thresholds=(
                *threshold_range(
                    metric="session_open_selloff_bps",
                    value=session_open_selloff_bps,
                    floor=decimal_param(
                        params, "min_session_open_selloff_bps", Decimal("20")
                    ),
                    ceil=max_session_open_selloff_bps,
                    required=True,
                ),
                threshold_min(
                    metric="opening_window_selloff_bps",
                    value=opening_window_selloff_bps,
                    floor=optional_decimal_param(
                        params, "min_opening_window_selloff_bps", None
                    ),
                    required=False,
                ),
                *threshold_range(
                    metric="price_below_vwap_bps",
                    value=price_below_vwap_bps,
                    floor=decimal_param(
                        params, "min_price_below_vwap_bps", Decimal("8")
                    ),
                    ceil=max_price_below_vwap_bps,
                    required=True,
                ),
                *threshold_range(
                    metric="price_below_ema12_bps",
                    value=price_below_ema12_bps,
                    floor=decimal_param(
                        params, "min_price_below_ema12_bps", Decimal("1")
                    ),
                    ceil=decimal_param(
                        params, "max_price_below_ema12_bps", Decimal("50")
                    ),
                    required=True,
                ),
                *threshold_range(
                    metric="rsi14",
                    value=rsi14,
                    floor=decimal_param(params, "min_bull_rsi", Decimal("34")),
                    ceil=decimal_param(params, "max_bull_rsi", Decimal("50")),
                    required=True,
                ),
                *threshold_range(
                    metric="macd_hist",
                    value=macd_hist,
                    floor=decimal_param(params, "rebound_hist_min", Decimal("-0.018")),
                    ceil=decimal_param(params, "rebound_hist_max", Decimal("0.010")),
                    required=True,
                ),
                threshold_max(
                    metric="price_position_in_session_range",
                    value=price_position_in_session_range,
                    ceil=optional_decimal_param(
                        params, "max_session_range_position", Decimal("0.45")
                    ),
                    required=False,
                ),
                threshold_min(
                    metric="session_range_bps",
                    value=session_range_bps,
                    floor=optional_decimal_param(
                        params, "min_session_range_bps", Decimal("35")
                    ),
                    required=False,
                ),
                *threshold_range(
                    metric="price_vs_session_low_bps",
                    value=price_vs_session_low_bps,
                    floor=decimal_param(
                        params, "min_price_vs_session_low_bps", Decimal("0")
                    ),
                    ceil=decimal_param(
                        params, "max_price_vs_session_low_bps", Decimal("40")
                    ),
                    required=True,
                ),
                *threshold_range(
                    metric="price_vs_opening_range_low_bps",
                    value=price_vs_opening_range_low_bps,
                    floor=optional_decimal_param(
                        params, "min_price_vs_opening_range_low_bps", None
                    ),
                    ceil=optional_decimal_param(
                        params, "max_price_vs_opening_range_low_bps", None
                    ),
                    required=False,
                ),
                threshold_max(
                    metric="recent_above_vwap_w5m_ratio",
                    value=recent_above_vwap_w5m_ratio,
                    ceil=optional_decimal_param(
                        params, "max_recent_above_vwap_w5m_ratio", None
                    ),
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
                    ceil=decimal_param(params, "max_spread_bps", Decimal("20")),
                    required=True,
                ),
                threshold_max(
                    metric="recent_spread_bps_avg",
                    value=recent_spread_bps_avg,
                    ceil=optional_decimal_param(
                        params, "max_recent_spread_bps", Decimal("10")
                    ),
                    required=False,
                ),
                threshold_max(
                    metric="recent_spread_bps_max",
                    value=recent_spread_bps_max,
                    ceil=optional_decimal_param(
                        params, "max_recent_spread_bps_max", Decimal("30")
                    ),
                    required=False,
                ),
                threshold_max(
                    metric="recent_quote_invalid_ratio",
                    value=recent_quote_invalid_ratio,
                    ceil=optional_decimal_param(
                        params, "max_recent_quote_invalid_ratio", Decimal("0.15")
                    ),
                    required=False,
                ),
                threshold_max(
                    metric="recent_quote_jump_bps_max",
                    value=recent_quote_jump_bps_max,
                    ceil=optional_decimal_param(
                        params, "max_recent_quote_jump_bps", Decimal("55")
                    ),
                    required=False,
                ),
                *threshold_range(
                    metric="vol_realized_w60s",
                    value=vol_realized_w60s,
                    floor=optional_decimal_param(
                        params, "vol_floor", Decimal("0.00005")
                    ),
                    ceil=optional_decimal_param(params, "vol_ceil", Decimal("0.00075")),
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
                    floor=decimal_param(params, "min_imbalance_pressure", Decimal("0")),
                    required=True,
                ),
                threshold_min(
                    metric="recent_imbalance_pressure_avg",
                    value=recent_imbalance_pressure_avg,
                    floor=optional_decimal_param(
                        params, "min_recent_imbalance_pressure", Decimal("0.02")
                    ),
                    required=False,
                ),
                threshold_min(
                    metric="recent_microprice_bias_bps_avg",
                    value=recent_microprice_bias_bps_avg,
                    floor=optional_decimal_param(
                        params, "min_recent_microprice_bias_bps", Decimal("0.05")
                    ),
                    required=False,
                ),
                threshold_min(
                    metric="cross_section_reversal_rank",
                    value=cross_section_reversal_rank,
                    floor=optional_decimal_param(
                        params, "min_cross_section_reversal_rank", Decimal("0.65")
                    ),
                    required=False,
                ),
                threshold_min(
                    metric="cross_section_recent_imbalance_rank",
                    value=cross_section_recent_imbalance_rank,
                    floor=optional_decimal_param(
                        params,
                        "min_cross_section_recent_imbalance_rank",
                        Decimal("0.45"),
                    ),
                    required=False,
                ),
                threshold_min(
                    metric="cross_section_positive_recent_imbalance_ratio",
                    value=cross_section_positive_recent_imbalance_ratio,
                    floor=optional_decimal_param(
                        params,
                        "min_cross_section_positive_recent_imbalance_ratio",
                        Decimal("0.35"),
                    ),
                    required=False,
                ),
                threshold_max(
                    metric="cross_section_continuation_rank",
                    value=cross_section_continuation_rank,
                    ceil=optional_decimal_param(
                        params, "max_cross_section_continuation_rank", Decimal("0.80")
                    ),
                    required=False,
                ),
                threshold_max(
                    metric="effective_opening_window_return_rank",
                    value=effective_opening_window_return_rank,
                    ceil=optional_decimal_param(
                        params,
                        "max_cross_section_opening_window_return_rank",
                        Decimal("0.80"),
                    ),
                    required=False,
                ),
            ),
        ),
    )
    if all((gate.passed for gate in buy_gates)):
        confidence = Decimal("0.64")
        if session_open_selloff_bps is not None and session_open_selloff_bps >= Decimal(
            "50"
        ):
            confidence += Decimal("0.02")
        if Decimal("5") <= price_vs_session_low_bps <= Decimal("20"):
            confidence += Decimal("0.03")
        if (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg >= Decimal("0.05")
        ):
            confidence += Decimal("0.02")
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal("0.30")
        ):
            confidence += Decimal("0.02")
        if (
            cross_section_reversal_rank is not None
            and cross_section_reversal_rank >= Decimal("0.85")
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
                confidence=min(confidence, Decimal("0.82")),
                rationale=(
                    "washout_rebound_long",
                    "activity_gated",
                    "bid_recovery",
                    "off_session_low",
                    "spread_normalized",
                ),
                notional_multiplier=resolve_entry_notional_multiplier(
                    params=params,
                    confidence=min(confidence, Decimal("0.82")),
                    rank=cross_section_reversal_rank,
                    spread_bps=effective_spread_bps,
                    spread_cap_bps=decimal_param(
                        params, "max_spread_bps", Decimal("20")
                    ),
                ),
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    vwap_recovered = (
        vwap_session is not None and price >= vwap_session or price >= ema12
    )
    session_open_recovered = (
        price_vs_session_open_bps is not None
        and price_vs_session_open_bps
        >= decimal_param(params, "exit_price_vs_session_open_bps", Decimal("-4"))
    )
    rsi_recovered = rsi14 >= decimal_param(params, "exit_rsi_min", Decimal("56"))
    macd_rollover = macd_hist <= decimal_param(
        params, "exit_macd_hist_max", Decimal("-0.004")
    )
    range_recovery = (
        price_position_in_session_range is not None
        and price_position_in_session_range
        >= decimal_param(params, "exit_session_range_position_min", Decimal("0.58"))
    )
    recovered_enough_to_exit = (vwap_recovered or session_open_recovered) and (
        rsi_recovered or range_recovery
    )
    flow_stall_after_recovery = (
        recent_imbalance_pressure_avg is not None
        and recent_imbalance_pressure_avg
        <= decimal_param(params, "exit_recent_imbalance_pressure_max", Decimal("-0.02"))
        and (price_position_in_session_range is not None)
        and (
            price_position_in_session_range
            >= decimal_param(
                params, "exit_flow_stall_session_range_position_min", Decimal("0.35")
            )
        )
    )
    macd_rollover_after_recovery = macd_rollover and (
        recovered_enough_to_exit
        or (
            price_position_in_session_range is not None
            and price_position_in_session_range
            >= decimal_param(
                params, "exit_flow_stall_session_range_position_min", Decimal("0.35")
            )
        )
    )
    exit_reasons: dict[str, bool] = {
        "rebound_complete": recovered_enough_to_exit,
        "macd_rollover_after_recovery": macd_rollover_after_recovery,
        "flow_stall_after_recovery": flow_stall_after_recovery,
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
                confidence=Decimal("0.61"),
                rationale=("washout_rebound_exit", "rebound_complete"),
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
    "evaluate_washout_rebound_long",
]
