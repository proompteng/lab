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
from .helpers import (
    bps_delta,
    calculate_imbalance_pressure,
    decimal_param,
    effective_entry_end_minute,
    minute_param,
    nonnegative_decimal,
    optional_decimal_param,
    parse_event_ts,
    resolve_entry_notional_multiplier,
    within_utc_window,
)


def evaluate_momentum_pullback_long(
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
    recent_spread_bps_avg: Decimal | None,
    recent_imbalance_pressure_avg: Decimal | None,
    recent_quote_invalid_ratio: Decimal | None,
    recent_quote_jump_bps_max: Decimal | None,
    recent_microprice_bias_bps_avg: Decimal | None,
    cross_section_continuation_rank: Decimal | None,
) -> SleeveSignalResult:
    trace_context = {"family": "momentum_pullback_long"}
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
    entry_start_minute = minute_param(params, "entry_start_minute_utc", 14 * 60)
    within_entry_window = within_utc_window(
        ts,
        start_minute=entry_start_minute,
        end_minute=effective_entry_end_minute(params, default_end_minute=19 * 60 + 50),
    )
    macd_hist = macd - macd_signal
    price_vs_ema12_bps = bps_delta(price, ema12)
    effective_spread_bps = nonnegative_decimal(spread_bps)
    imbalance_pressure = calculate_imbalance_pressure(
        imbalance_bid_sz, imbalance_ask_sz
    )
    bullish_hist_min = decimal_param(params, "bullish_hist_min", Decimal("0.01"))
    bullish_hist_cap = decimal_param(params, "bullish_hist_cap", Decimal("0.09"))
    min_bull_rsi = decimal_param(params, "min_bull_rsi", Decimal("54"))
    max_bull_rsi = decimal_param(params, "max_bull_rsi", Decimal("66"))
    min_pullback_bps = decimal_param(params, "min_price_below_ema12_bps", Decimal("1"))
    max_pullback_bps = decimal_param(params, "max_price_below_ema12_bps", Decimal("18"))
    spread_cap_bps = decimal_param(params, "max_spread_bps", Decimal("7"))
    imbalance_floor = decimal_param(params, "min_imbalance_pressure", Decimal("-0.05"))
    vol_floor = optional_decimal_param(params, "vol_floor", Decimal("0.00003"))
    vol_ceil = optional_decimal_param(params, "vol_ceil", Decimal("0.00035"))
    min_session_open_drive_bps = optional_decimal_param(
        params, "min_session_open_drive_bps", None
    )
    max_recent_spread_bps = optional_decimal_param(
        params, "max_recent_spread_bps", None
    )
    min_recent_imbalance_pressure = optional_decimal_param(
        params, "min_recent_imbalance_pressure", None
    )
    max_recent_quote_invalid_ratio = optional_decimal_param(
        params, "max_recent_quote_invalid_ratio", Decimal("0.18")
    )
    max_recent_quote_jump_bps = optional_decimal_param(
        params, "max_recent_quote_jump_bps", Decimal("60")
    )
    min_recent_microprice_bias_bps = optional_decimal_param(
        params, "min_recent_microprice_bias_bps", Decimal("0")
    )
    min_cross_section_continuation_rank = optional_decimal_param(
        params, "min_cross_section_continuation_rank", None
    )
    pullback_bps = -price_vs_ema12_bps if price_vs_ema12_bps is not None else None
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
                    floor=bullish_hist_min,
                    ceil=bullish_hist_cap,
                    required=True,
                ),
                *threshold_range(
                    metric="rsi14",
                    value=rsi14,
                    floor=min_bull_rsi,
                    ceil=max_bull_rsi,
                    required=True,
                ),
                *threshold_range(
                    metric="pullback_bps",
                    value=pullback_bps,
                    floor=min_pullback_bps,
                    ceil=max_pullback_bps,
                    required=False,
                ),
                threshold_min(
                    metric="price_vs_session_open_bps",
                    value=price_vs_session_open_bps,
                    floor=min_session_open_drive_bps,
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
                    floor=vol_floor,
                    ceil=vol_ceil,
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
                    floor=imbalance_floor,
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
                threshold_min(
                    metric="cross_section_continuation_rank",
                    value=cross_section_continuation_rank,
                    floor=min_cross_section_continuation_rank,
                    required=False,
                ),
            ),
        ),
    )
    if within_entry_window and all((gate.passed for gate in buy_gates)):
        confidence = Decimal("0.66")
        if imbalance_pressure > Decimal("0.05"):
            confidence += Decimal("0.03")
        if price_vs_ema12_bps is not None and price_vs_ema12_bps <= -Decimal("4"):
            confidence += Decimal("0.02")
        if (
            cross_section_continuation_rank is not None
            and cross_section_continuation_rank >= Decimal("0.85")
        ):
            confidence += Decimal("0.02")
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal("0.60")
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
                    "momentum_pullback_long",
                    "trend_up",
                    "pullback_entry",
                    "spread_ok",
                ),
                notional_multiplier=resolve_entry_notional_multiplier(
                    params=params,
                    confidence=min(confidence, Decimal("0.82")),
                    rank=cross_section_continuation_rank,
                    spread_bps=effective_spread_bps,
                    spread_cap_bps=spread_cap_bps,
                ),
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    exit_gate = build_gate(
        name="exit",
        category="exit",
        thresholds=(
            threshold_bool(
                metric="ema12_lt_ema26", passed=ema12 < ema26, threshold=True
            ),
            threshold_max(
                metric="macd_hist",
                value=macd_hist,
                ceil=decimal_param(params, "exit_macd_hist_max", Decimal("-0.002")),
                required=True,
            ),
            threshold_max(
                metric="rsi14",
                value=rsi14,
                ceil=decimal_param(params, "exit_rsi_max", Decimal("49")),
                required=True,
            ),
        ),
    )
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
                rationale=("momentum_pullback_exit", "trend_lost", "momentum_rollover"),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    if not within_entry_window:
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
                    context={"entry_start_minute_utc": entry_start_minute},
                ),
                exit_gate,
            ),
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
    "evaluate_momentum_pullback_long",
]
