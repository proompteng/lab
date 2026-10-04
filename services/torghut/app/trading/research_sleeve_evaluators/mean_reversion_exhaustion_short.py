from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping

from app.trading.evaluation_trace import GateTrace, ThresholdTrace

from .core import (
    SleeveSignalEvaluation,
    SleeveSignalResult,
    build_gate,
    build_sleeve_result,
    entry_window_gate,
    exit_trigger_gate,
    rank_thresholds,
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
    select_reference_decimal,
    within_utc_window,
)


def evaluate_mean_reversion_exhaustion_short(
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
    price_vs_opening_range_high_bps: Decimal | None,
    session_range_bps: Decimal | None,
    recent_spread_bps_avg: Decimal | None,
    recent_spread_bps_max: Decimal | None,
    recent_imbalance_pressure_avg: Decimal | None,
    recent_quote_invalid_ratio: Decimal | None,
    recent_quote_jump_bps_max: Decimal | None,
    recent_microprice_bias_bps_avg: Decimal | None,
    cross_section_opening_window_return_rank: Decimal | None,
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None,
    cross_section_continuation_rank: Decimal | None,
    cross_section_reversal_rank: Decimal | None,
    cross_section_session_open_rank: Decimal | None,
    cross_section_prev_session_close_rank: Decimal | None,
    cross_section_range_position_rank: Decimal | None,
    cross_section_vwap_w5m_rank: Decimal | None,
    cross_section_recent_imbalance_rank: Decimal | None,
) -> SleeveSignalResult:
    trace_context = {"family": "mean_reversion_exhaustion_short"}
    required_fields = {
        "price": price is not None,
        "ema12": ema12 is not None,
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
    entry_start_minute = minute_param(params, "entry_start_minute_utc", 14 * 60)
    entry_end_minute = effective_entry_end_minute(
        params, default_end_minute=18 * 60 + 45
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
    effective_price_drive_bps = select_reference_decimal(
        params=params,
        key="drive_reference_basis",
        default_basis="prev_close",
        session_open_value=price_vs_session_open_bps,
        prev_close_value=price_vs_prev_session_close_bps,
    )
    effective_opening_window_return_bps = select_reference_decimal(
        params=params,
        key="opening_window_reference_basis",
        default_basis="prev_close",
        session_open_value=opening_window_return_bps,
        prev_close_value=opening_window_return_from_prev_close_bps,
    )
    effective_opening_window_return_rank = select_reference_decimal(
        params=params,
        key="opening_window_rank_reference_basis",
        default_basis="prev_close",
        session_open_value=cross_section_opening_window_return_rank,
        prev_close_value=cross_section_opening_window_return_from_prev_close_rank,
    )
    min_session_open_drive_bps = optional_decimal_param(
        params, "min_price_vs_session_open_bps", Decimal("20")
    )
    min_opening_window_return_bps = optional_decimal_param(
        params, "min_opening_window_return_bps", Decimal("5")
    )
    min_session_range_position = optional_decimal_param(
        params, "min_session_range_position", Decimal("0.68")
    )
    min_session_range_bps = optional_decimal_param(
        params, "min_session_range_bps", Decimal("30")
    )
    min_price_vs_opening_range_high_bps = optional_decimal_param(
        params, "min_price_vs_opening_range_high_bps", Decimal("-8")
    )
    max_price_vs_opening_range_high_bps = optional_decimal_param(
        params, "max_price_vs_opening_range_high_bps", Decimal("12")
    )
    max_recent_spread_bps = optional_decimal_param(
        params, "max_recent_spread_bps", Decimal("8")
    )
    max_recent_spread_bps_max = optional_decimal_param(
        params, "max_recent_spread_bps_max", Decimal("16")
    )
    max_recent_imbalance_pressure = optional_decimal_param(
        params, "max_recent_imbalance_pressure", Decimal("-0.02")
    )
    max_recent_quote_invalid_ratio = optional_decimal_param(
        params, "max_recent_quote_invalid_ratio", Decimal("0.18")
    )
    max_recent_quote_jump_bps = optional_decimal_param(
        params, "max_recent_quote_jump_bps", Decimal("55")
    )
    max_recent_microprice_bias_bps = optional_decimal_param(
        params, "max_recent_microprice_bias_bps", Decimal("-0.10")
    )
    spread_cap_bps = decimal_param(params, "max_spread_bps", Decimal("8"))
    min_cross_section_opening_window_return_rank = optional_decimal_param(
        params, "min_cross_section_opening_window_return_rank", None
    )
    max_cross_section_continuation_rank = optional_decimal_param(
        params, "max_cross_section_continuation_rank", None
    )
    min_cross_section_reversal_rank = optional_decimal_param(
        params, "min_cross_section_reversal_rank", None
    )
    price_above_vwap_bps = price_vs_vwap_bps
    price_above_ema12_bps = price_vs_ema12_bps
    sell_gates = (
        build_gate(
            name="structure",
            category="structure",
            thresholds=(
                *threshold_range(
                    metric="price_above_vwap_bps",
                    value=price_above_vwap_bps,
                    floor=decimal_param(
                        params, "min_price_above_vwap_bps", Decimal("8")
                    ),
                    ceil=decimal_param(
                        params, "max_price_above_vwap_bps", Decimal("70")
                    ),
                    required=True,
                ),
                *threshold_range(
                    metric="price_above_ema12_bps",
                    value=price_above_ema12_bps,
                    floor=decimal_param(
                        params, "min_price_above_ema12_bps", Decimal("2")
                    ),
                    ceil=decimal_param(
                        params, "max_price_above_ema12_bps", Decimal("35")
                    ),
                    required=True,
                ),
                *threshold_range(
                    metric="rsi14",
                    value=rsi14,
                    floor=decimal_param(params, "min_bear_rsi", Decimal("52")),
                    ceil=decimal_param(params, "max_bear_rsi", Decimal("64")),
                    required=True,
                ),
                *threshold_range(
                    metric="macd_hist",
                    value=macd_hist,
                    floor=decimal_param(params, "min_macd_hist", Decimal("-0.010")),
                    ceil=decimal_param(params, "max_macd_hist", Decimal("0.012")),
                    required=True,
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
                    metric="price_position_in_session_range",
                    value=price_position_in_session_range,
                    floor=min_session_range_position,
                    required=False,
                ),
                threshold_min(
                    metric="session_range_bps",
                    value=session_range_bps,
                    floor=min_session_range_bps,
                    required=False,
                ),
                threshold_min(
                    metric="price_vs_opening_range_high_bps",
                    value=price_vs_opening_range_high_bps,
                    floor=min_price_vs_opening_range_high_bps,
                    required=False,
                ),
                threshold_max(
                    metric="price_vs_opening_range_high_bps",
                    value=price_vs_opening_range_high_bps,
                    ceil=max_price_vs_opening_range_high_bps,
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
                *threshold_range(
                    metric="vol_realized_w60s",
                    value=vol_realized_w60s,
                    floor=optional_decimal_param(
                        params, "vol_floor", Decimal("0.00005")
                    ),
                    ceil=optional_decimal_param(params, "vol_ceil", Decimal("0.00055")),
                    required=False,
                ),
            ),
        ),
        build_gate(
            name="confirmation",
            category="confirmation",
            thresholds=(
                threshold_max(
                    metric="imbalance_pressure",
                    value=imbalance_pressure,
                    ceil=decimal_param(
                        params, "max_imbalance_pressure", Decimal("-0.02")
                    ),
                    required=True,
                ),
                threshold_max(
                    metric="recent_imbalance_pressure_avg",
                    value=recent_imbalance_pressure_avg,
                    ceil=max_recent_imbalance_pressure,
                    required=False,
                ),
                threshold_max(
                    metric="recent_microprice_bias_bps_avg",
                    value=recent_microprice_bias_bps_avg,
                    ceil=max_recent_microprice_bias_bps,
                    required=False,
                ),
                threshold_max(
                    metric="cross_section_continuation_rank",
                    value=cross_section_continuation_rank,
                    ceil=max_cross_section_continuation_rank,
                    required=False,
                ),
                threshold_min(
                    metric="cross_section_reversal_rank",
                    value=cross_section_reversal_rank,
                    floor=min_cross_section_reversal_rank,
                    required=False,
                ),
                threshold_min(
                    metric="effective_opening_window_return_rank",
                    value=effective_opening_window_return_rank,
                    floor=min_cross_section_opening_window_return_rank,
                    required=False,
                ),
            ),
        ),
    )
    if all((gate.passed for gate in sell_gates)):
        rank_gates: tuple[GateTrace, ...] = ()
        rank_feature = str(params.get("rank_feature") or "").strip()
        rank_lookup = {
            "cross_section_session_open_rank": cross_section_session_open_rank,
            "cross_section_opening_window_return_rank": cross_section_opening_window_return_rank,
            "cross_section_prev_session_close_rank": cross_section_prev_session_close_rank,
            "cross_section_opening_window_return_from_prev_close_rank": cross_section_opening_window_return_from_prev_close_rank,
            "cross_section_range_position_rank": cross_section_range_position_rank,
            "cross_section_vwap_w5m_rank": cross_section_vwap_w5m_rank,
            "cross_section_recent_imbalance_rank": cross_section_recent_imbalance_rank,
            "cross_section_continuation_rank": cross_section_continuation_rank,
            "cross_section_reversal_rank": cross_section_reversal_rank,
        }
        rank_value = rank_lookup.get(rank_feature)
        if rank_feature:
            universe_size = max(
                2,
                int(
                    optional_decimal_param(params, "universe_size", Decimal("2"))
                    or Decimal("2")
                ),
            )
            top_n = max(
                1,
                int(
                    optional_decimal_param(params, "top_n", Decimal("1"))
                    or Decimal("1")
                ),
            )
            selection_mode = (
                str(params.get("selection_mode") or "reversal").strip().lower()
            )
            low_threshold, high_threshold = rank_thresholds(
                universe_size=universe_size, top_n=top_n
            )
            should_trade = False
            comparator = "gte"
            threshold_value = high_threshold
            if selection_mode == "continuation":
                comparator = "lte"
                threshold_value = low_threshold
                should_trade = rank_value is not None and rank_value <= low_threshold
            else:
                comparator = "gte"
                threshold_value = high_threshold
                should_trade = rank_value is not None and rank_value >= high_threshold
            rank_gate = build_gate(
                name="rank_selection",
                category="structure",
                thresholds=(
                    ThresholdTrace(
                        metric=rank_feature,
                        comparator="min_gte" if comparator == "gte" else "max_lte",
                        value=rank_value,
                        threshold=threshold_value,
                        passed=should_trade,
                        missing_policy="fail_closed",
                        distance_to_pass=Decimal("0")
                        if should_trade
                        else threshold_value
                        if rank_value is None
                        else max(Decimal("0"), threshold_value - rank_value)
                        if comparator == "gte"
                        else max(Decimal("0"), rank_value - threshold_value),
                    ),
                ),
                context={
                    "selection_mode": selection_mode,
                    "top_n": top_n,
                    "universe_size": universe_size,
                },
            )
            rank_gates = (rank_gate,)
            if not should_trade:
                return build_sleeve_result(
                    strategy_id=strategy_id,
                    strategy_type=strategy_type,
                    symbol=symbol,
                    event_ts=event_ts,
                    timeframe=timeframe,
                    signal=None,
                    gates=sell_gates + rank_gates,
                    trace_enabled=trace_enabled,
                    context=trace_context,
                )
        confidence = Decimal("0.64")
        if price_vs_vwap_bps is not None and price_vs_vwap_bps >= Decimal("16"):
            confidence += Decimal("0.03")
        if imbalance_pressure <= Decimal("-0.06"):
            confidence += Decimal("0.02")
        if (
            price_position_in_session_range is not None
            and price_position_in_session_range >= Decimal("0.82")
        ):
            confidence += Decimal("0.02")
        if (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg <= Decimal("-0.06")
        ):
            confidence += Decimal("0.02")
        if (
            effective_opening_window_return_rank is not None
            and effective_opening_window_return_rank >= Decimal("0.85")
        ):
            confidence += Decimal("0.03")
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg <= Decimal("-0.75")
        ):
            confidence += Decimal("0.02")
        selected_rank = prefer_primary_decimal(
            effective_opening_window_return_rank, cross_section_reversal_rank
        )
        return build_sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action="sell",
                confidence=min(confidence, Decimal("0.81")),
                rationale=(
                    "mean_reversion_exhaustion_short",
                    "overbought_fade",
                    "above_vwap",
                    "session_overextension",
                    "offer_pressure_confirmed",
                    *(
                        (
                            f"selection_mode:{str(params.get('selection_mode') or 'reversal').strip().lower()}",
                            f"rank_feature:{rank_feature}",
                        )
                        if rank_feature
                        else ()
                    ),
                ),
                notional_multiplier=resolve_entry_notional_multiplier(
                    params=params,
                    confidence=min(confidence, Decimal("0.81")),
                    rank=selected_rank,
                    spread_bps=effective_spread_bps,
                    spread_cap_bps=spread_cap_bps,
                ),
            ),
            gates=sell_gates + rank_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    exit_reasons: dict[str, bool] = {
        "vwap_reversion": vwap_session is not None
        and price <= vwap_session
        or (vwap_session is None and price <= ema12),
        "rsi_cooled": rsi14 <= decimal_param(params, "exit_rsi_max", Decimal("42")),
        "macd_rebound": macd_hist
        >= decimal_param(params, "exit_macd_hist_min", Decimal("0.003")),
        "imbalance_reversal": recent_imbalance_pressure_avg is not None
        and recent_imbalance_pressure_avg
        >= decimal_param(params, "exit_recent_imbalance_pressure_min", Decimal("0.03")),
        "range_reversion": price_position_in_session_range is not None
        and price_position_in_session_range
        <= decimal_param(params, "exit_session_range_position_max", Decimal("0.44")),
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
                action="buy",
                confidence=Decimal("0.61"),
                rationale=("mean_reversion_exhaustion_short_exit", "fade_complete"),
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
        gates=sell_gates,
        trace_enabled=trace_enabled,
        context=trace_context,
    )


__all__ = [
    "evaluate_mean_reversion_exhaustion_short",
]
