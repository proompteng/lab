"""Research-backed intraday sleeve evaluations for the March profitability program."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Mapping


@dataclass(frozen=True)
class SleeveSignalEvaluation:
    action: Literal['buy', 'sell']
    confidence: Decimal
    rationale: tuple[str, ...]
    notional_multiplier: Decimal = Decimal('1')


def evaluate_momentum_pullback_long(
    *,
    params: Mapping[str, Any],
    event_ts: str,
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
) -> SleeveSignalEvaluation | None:
    if (
        price is None
        or ema12 is None
        or ema26 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
    ):
        return None

    ts = _parse_event_ts(event_ts)
    if not _within_utc_window(
        ts,
        start_minute=_minute_param(params, 'entry_start_minute_utc', 14 * 60),
        end_minute=_effective_entry_end_minute(
            params,
            default_end_minute=19 * 60 + 50,
        ),
    ):
        return None

    macd_hist = macd - macd_signal
    price_vs_ema12_bps = _bps_delta(price, ema12)
    effective_spread_bps = _nonnegative_decimal(spread_bps)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)

    bullish_hist_min = _decimal_param(params, 'bullish_hist_min', Decimal('0.01'))
    bullish_hist_cap = _decimal_param(params, 'bullish_hist_cap', Decimal('0.09'))
    min_bull_rsi = _decimal_param(params, 'min_bull_rsi', Decimal('54'))
    max_bull_rsi = _decimal_param(params, 'max_bull_rsi', Decimal('66'))
    min_pullback_bps = _decimal_param(params, 'min_price_below_ema12_bps', Decimal('1'))
    max_pullback_bps = _decimal_param(params, 'max_price_below_ema12_bps', Decimal('18'))
    spread_cap_bps = _decimal_param(params, 'max_spread_bps', Decimal('7'))
    imbalance_floor = _decimal_param(params, 'min_imbalance_pressure', Decimal('-0.05'))
    vol_floor = _optional_decimal_param(params, 'vol_floor', Decimal('0.00003'))
    vol_ceil = _optional_decimal_param(params, 'vol_ceil', Decimal('0.00035'))
    min_session_open_drive_bps = _optional_decimal_param(params, 'min_session_open_drive_bps', None)
    max_recent_spread_bps = _optional_decimal_param(params, 'max_recent_spread_bps', None)
    min_recent_imbalance_pressure = _optional_decimal_param(params, 'min_recent_imbalance_pressure', None)
    max_recent_quote_invalid_ratio = _optional_decimal_param(
        params,
        'max_recent_quote_invalid_ratio',
        Decimal('0.18'),
    )
    max_recent_quote_jump_bps = _optional_decimal_param(
        params,
        'max_recent_quote_jump_bps',
        Decimal('60'),
    )
    min_recent_microprice_bias_bps = _optional_decimal_param(
        params,
        'min_recent_microprice_bias_bps',
        Decimal('0'),
    )
    min_cross_section_continuation_rank = _optional_decimal_param(
        params,
        'min_cross_section_continuation_rank',
        None,
    )

    if (
        ema12 > ema26
        and bullish_hist_min <= macd_hist <= bullish_hist_cap
        and min_bull_rsi <= rsi14 <= max_bull_rsi
        and _optional_min_threshold(
            -price_vs_ema12_bps if price_vs_ema12_bps is not None else None,
            min_pullback_bps,
        )
        and _optional_max_threshold(
            -price_vs_ema12_bps if price_vs_ema12_bps is not None else None,
            max_pullback_bps,
        )
        and effective_spread_bps <= spread_cap_bps
        and imbalance_pressure >= imbalance_floor
        and _optional_min_threshold(price_vs_session_open_bps, min_session_open_drive_bps)
        and _optional_max_threshold(recent_spread_bps_avg, max_recent_spread_bps)
        and _optional_min_threshold(recent_imbalance_pressure_avg, min_recent_imbalance_pressure)
        and _quote_stability_passes(
            recent_quote_invalid_ratio=recent_quote_invalid_ratio,
            max_recent_quote_invalid_ratio=max_recent_quote_invalid_ratio,
            recent_quote_jump_bps_max=recent_quote_jump_bps_max,
            max_recent_quote_jump_bps=max_recent_quote_jump_bps,
        )
        and _optional_min_threshold(
            recent_microprice_bias_bps_avg,
            min_recent_microprice_bias_bps,
        )
        and _optional_min_threshold(
            cross_section_continuation_rank,
            min_cross_section_continuation_rank,
        )
        and _vol_within_band(vol_realized_w60s, floor=vol_floor, ceil=vol_ceil)
    ):
        confidence = Decimal('0.66')
        if imbalance_pressure > Decimal('0.05'):
            confidence += Decimal('0.03')
        if price_vs_ema12_bps is not None and price_vs_ema12_bps <= -Decimal('4'):
            confidence += Decimal('0.02')
        if (
            cross_section_continuation_rank is not None
            and cross_section_continuation_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.02')
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal('0.60')
        ):
            confidence += Decimal('0.02')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.82')),
            rationale=(
                'momentum_pullback_long',
                'trend_up',
                'pullback_entry',
                'spread_ok',
            ),
            notional_multiplier=_resolve_entry_notional_multiplier(
                params=params,
                confidence=min(confidence, Decimal('0.82')),
                rank=cross_section_continuation_rank,
                spread_bps=effective_spread_bps,
                spread_cap_bps=spread_cap_bps,
            ),
        )

    if (
        ema12 < ema26
        and macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.002'))
        and rsi14 <= _decimal_param(params, 'exit_rsi_max', Decimal('49'))
    ):
        return SleeveSignalEvaluation(
            action='sell',
            confidence=Decimal('0.63'),
            rationale=(
                'momentum_pullback_exit',
                'trend_lost',
                'momentum_rollover',
            ),
        )
    return None


def evaluate_breakout_continuation_long(
    *,
    params: Mapping[str, Any],
    event_ts: str,
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
    cross_section_positive_session_open_ratio: Decimal | None,
    cross_section_positive_prev_session_close_ratio: Decimal | None,
    cross_section_positive_opening_window_return_ratio: Decimal | None,
    cross_section_positive_opening_window_return_from_prev_close_ratio: Decimal | None,
    cross_section_above_vwap_w5m_ratio: Decimal | None,
    cross_section_continuation_breadth: Decimal | None,
    cross_section_opening_window_return_rank: Decimal | None,
    cross_section_prev_session_close_rank: Decimal | None,
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None,
    cross_section_continuation_rank: Decimal | None,
) -> SleeveSignalEvaluation | None:
    if (
        price is None
        or ema12 is None
        or ema26 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
    ):
        return None

    ts = _parse_event_ts(event_ts)
    if not _within_utc_window(
        ts,
        start_minute=_minute_param(params, 'entry_start_minute_utc', 14 * 60 + 15),
        end_minute=_effective_entry_end_minute(
            params,
            default_end_minute=19 * 60 + 45,
        ),
    ):
        return None

    macd_hist = macd - macd_signal
    price_vs_ema12_bps = _bps_delta(price, ema12)
    effective_spread_bps = _nonnegative_decimal(spread_bps)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    effective_price_drive_bps = _prefer_primary_decimal(
        price_vs_prev_session_close_bps,
        price_vs_session_open_bps,
    )
    effective_opening_window_return_bps = _prefer_primary_decimal(
        opening_window_return_from_prev_close_bps,
        opening_window_return_bps,
    )
    effective_positive_session_open_ratio = _prefer_primary_decimal(
        cross_section_positive_prev_session_close_ratio,
        cross_section_positive_session_open_ratio,
    )
    effective_positive_opening_window_return_ratio = _prefer_primary_decimal(
        cross_section_positive_opening_window_return_from_prev_close_ratio,
        cross_section_positive_opening_window_return_ratio,
    )
    effective_opening_window_return_rank = _prefer_primary_decimal(
        cross_section_opening_window_return_from_prev_close_rank,
        cross_section_opening_window_return_rank,
    )
    session_high_vs_opening_range_high_bps = _bps_delta(
        session_high_price,
        opening_range_high,
    )
    min_session_open_drive_bps = _decimal_param(params, 'min_session_open_drive_bps', Decimal('20'))
    min_opening_window_return_bps = _optional_decimal_param(
        params,
        'min_opening_window_return_bps',
        Decimal('12'),
    )
    min_session_high_above_opening_range_high_bps = _optional_decimal_param(
        params,
        'min_session_high_above_opening_range_high_bps',
        Decimal('4'),
    )
    min_price_vs_opening_range_high_bps = _decimal_param(
        params,
        'min_price_vs_opening_range_high_bps',
        _decimal_param(params, 'min_price_above_opening_range_high_bps', Decimal('-12')),
    )
    max_price_vs_opening_range_high_bps = _decimal_param(
        params,
        'max_price_vs_opening_range_high_bps',
        _decimal_param(params, 'max_price_above_opening_range_high_bps', Decimal('24')),
    )
    min_price_vs_opening_window_close_bps = _optional_decimal_param(
        params,
        'min_price_vs_opening_window_close_bps',
        Decimal('-10'),
    )
    max_price_vs_opening_window_close_bps = _optional_decimal_param(
        params,
        'max_price_vs_opening_window_close_bps',
        Decimal('18'),
    )
    min_opening_range_width_bps = _optional_decimal_param(params, 'min_opening_range_width_bps', Decimal('8'))
    min_session_range_bps = _optional_decimal_param(params, 'min_session_range_bps', Decimal('18'))
    min_session_range_position = _optional_decimal_param(params, 'min_session_range_position', Decimal('0.72'))
    min_price_vs_vwap_w5m_bps = _optional_decimal_param(
        params,
        'min_price_vs_vwap_w5m_bps',
        Decimal('-8'),
    )
    max_price_vs_vwap_w5m_bps = _optional_decimal_param(
        params,
        'max_price_vs_vwap_w5m_bps',
        Decimal('18'),
    )
    max_recent_spread_bps = _optional_decimal_param(params, 'max_recent_spread_bps', Decimal('6'))
    max_recent_spread_bps_max = _optional_decimal_param(params, 'max_recent_spread_bps_max', Decimal('8'))
    min_recent_imbalance_pressure = _optional_decimal_param(params, 'min_recent_imbalance_pressure', Decimal('0.01'))
    max_recent_quote_invalid_ratio = _optional_decimal_param(
        params,
        'max_recent_quote_invalid_ratio',
        Decimal('0.12'),
    )
    max_recent_quote_jump_bps = _optional_decimal_param(
        params,
        'max_recent_quote_jump_bps',
        Decimal('35'),
    )
    min_recent_microprice_bias_bps = _optional_decimal_param(
        params,
        'min_recent_microprice_bias_bps',
        Decimal('0.25'),
    )
    spread_cap_bps = _decimal_param(params, 'max_spread_bps', Decimal('6'))
    min_cross_section_continuation_rank = _optional_decimal_param(
        params,
        'min_cross_section_continuation_rank',
        None,
    )
    min_cross_section_opening_window_return_rank = _optional_decimal_param(
        params,
        'min_cross_section_opening_window_return_rank',
        None,
    )
    min_cross_section_positive_session_open_ratio = _optional_decimal_param(
        params,
        'min_cross_section_positive_session_open_ratio',
        None,
    )
    min_cross_section_positive_opening_window_return_ratio = _optional_decimal_param(
        params,
        'min_cross_section_positive_opening_window_return_ratio',
        None,
    )
    min_cross_section_above_vwap_w5m_ratio = _optional_decimal_param(
        params,
        'min_cross_section_above_vwap_w5m_ratio',
        None,
    )
    min_cross_section_continuation_breadth = _optional_decimal_param(
        params,
        'min_cross_section_continuation_breadth',
        None,
    )
    ema_extension_cap_bps = _scaled_extension_cap(
        base_cap=_decimal_param(params, 'max_price_above_ema12_bps', Decimal('16')),
        reference_bps=session_range_bps or opening_range_width_bps,
        multiplier=_optional_decimal_param(params, 'ema_extension_range_multiplier', Decimal('0.60')),
    )
    vwap_w5m_extension_cap_bps = _scaled_extension_cap(
        base_cap=max_price_vs_vwap_w5m_bps,
        reference_bps=session_range_bps or opening_range_width_bps,
        multiplier=_optional_decimal_param(params, 'vwap_w5m_range_multiplier', Decimal('0.45')),
    )

    if (
        ema12 > ema26
        and macd_hist >= _decimal_param(params, 'bullish_hist_min', Decimal('0.008'))
        and _decimal_param(params, 'min_bull_rsi', Decimal('58')) <= rsi14 <= _decimal_param(params, 'max_bull_rsi', Decimal('72'))
        and _optional_min_threshold(
            price_vs_ema12_bps,
            _decimal_param(params, 'min_price_above_ema12_bps', Decimal('0')),
        )
        and _optional_max_threshold(price_vs_ema12_bps, ema_extension_cap_bps)
        and _optional_min_threshold(price_vs_vwap_w5m_bps, min_price_vs_vwap_w5m_bps)
        and _optional_max_threshold(price_vs_vwap_w5m_bps, vwap_w5m_extension_cap_bps)
        and effective_spread_bps <= spread_cap_bps
        and imbalance_pressure >= _decimal_param(params, 'min_imbalance_pressure', Decimal('0'))
        and _optional_min_threshold(effective_price_drive_bps, min_session_open_drive_bps)
        and _optional_min_threshold(
            effective_opening_window_return_bps,
            min_opening_window_return_bps,
        )
        and _optional_min_threshold(session_high_vs_opening_range_high_bps, min_session_high_above_opening_range_high_bps)
        and _optional_min_threshold(price_vs_opening_range_high_bps, min_price_vs_opening_range_high_bps)
        and _optional_max_threshold(price_vs_opening_range_high_bps, max_price_vs_opening_range_high_bps)
        and _optional_min_threshold(
            price_vs_opening_window_close_bps,
            min_price_vs_opening_window_close_bps,
        )
        and _optional_max_threshold(
            price_vs_opening_window_close_bps,
            max_price_vs_opening_window_close_bps,
        )
        and _optional_min_threshold(opening_range_width_bps, min_opening_range_width_bps)
        and _optional_min_threshold(session_range_bps, min_session_range_bps)
        and _optional_min_threshold(price_position_in_session_range, min_session_range_position)
        and _optional_max_threshold(recent_spread_bps_avg, max_recent_spread_bps)
        and _optional_max_threshold(recent_spread_bps_max, max_recent_spread_bps_max)
        and _optional_min_threshold(recent_imbalance_pressure_avg, min_recent_imbalance_pressure)
        and _quote_stability_passes(
            recent_quote_invalid_ratio=recent_quote_invalid_ratio,
            max_recent_quote_invalid_ratio=max_recent_quote_invalid_ratio,
            recent_quote_jump_bps_max=recent_quote_jump_bps_max,
            max_recent_quote_jump_bps=max_recent_quote_jump_bps,
        )
        and _optional_min_threshold(
            recent_microprice_bias_bps_avg,
            min_recent_microprice_bias_bps,
        )
        and _optional_min_threshold(
            cross_section_continuation_rank,
            min_cross_section_continuation_rank,
        )
        and _optional_min_threshold(
            effective_opening_window_return_rank,
            min_cross_section_opening_window_return_rank,
        )
        and _optional_min_threshold(
            effective_positive_session_open_ratio,
            min_cross_section_positive_session_open_ratio,
        )
        and _optional_min_threshold(
            effective_positive_opening_window_return_ratio,
            min_cross_section_positive_opening_window_return_ratio,
        )
        and _optional_min_threshold(
            cross_section_above_vwap_w5m_ratio,
            min_cross_section_above_vwap_w5m_ratio,
        )
        and _optional_min_threshold(
            cross_section_continuation_breadth,
            min_cross_section_continuation_breadth,
        )
        and _vol_within_band(
            vol_realized_w60s,
            floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00004')),
            ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00040')),
        )
    ):
        confidence = Decimal('0.68')
        if price_vs_opening_range_high_bps is not None and price_vs_opening_range_high_bps >= 0:
            confidence += Decimal('0.03')
        if price_vs_vwap_w5m_bps is not None and price_vs_vwap_w5m_bps >= 0:
            confidence += Decimal('0.03')
        if imbalance_pressure >= Decimal('0.08'):
            confidence += Decimal('0.03')
        if effective_price_drive_bps is not None and effective_price_drive_bps >= Decimal('35'):
            confidence += Decimal('0.03')
        if (
            effective_opening_window_return_bps is not None
            and effective_opening_window_return_bps >= Decimal('25')
        ):
            confidence += Decimal('0.02')
        if (
            cross_section_continuation_rank is not None
            and cross_section_continuation_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.03')
        if (
            effective_opening_window_return_rank is not None
            and effective_opening_window_return_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.02')
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal('1.0')
        ):
            confidence += Decimal('0.02')
        if (
            cross_section_continuation_breadth is not None
            and cross_section_continuation_breadth >= Decimal('0.65')
        ):
            confidence += Decimal('0.02')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.86')),
            rationale=(
                'breakout_continuation_long',
                'trend_up',
                'session_drive_confirmed',
                'opening_range_breakout',
                'above_vwap',
                'imbalance_confirmed',
            ),
            notional_multiplier=_resolve_entry_notional_multiplier(
                params=params,
                confidence=min(confidence, Decimal('0.86')),
                rank=cross_section_continuation_rank,
                spread_bps=effective_spread_bps,
                spread_cap_bps=spread_cap_bps,
            ),
        )

    exit_macd_hist_max = _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.003'))
    exit_rsi_max = _decimal_param(params, 'exit_rsi_max', Decimal('56'))
    breakout_failure_confirmed = (
        (
            price_vs_vwap_w5m_bps is not None
            and price_vs_vwap_w5m_bps <= _decimal_param(params, 'exit_price_vs_vwap_w5m_bps', Decimal('-10'))
        )
        or (
            price_position_in_session_range is not None
            and price_position_in_session_range <= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.48'))
        )
        or (
            price_vs_session_open_bps is not None
            and price_vs_session_open_bps <= _decimal_param(params, 'exit_session_open_drive_bps', Decimal('18'))
        )
        or (
            macd_hist <= exit_macd_hist_max
            and rsi14 <= exit_rsi_max
            and price < ema12
        )
    )
    if breakout_failure_confirmed:
        return SleeveSignalEvaluation(
            action='sell',
            confidence=Decimal('0.62'),
            rationale=(
                'breakout_continuation_exit',
                'breakout_failed',
            ),
        )
    if (
        price_vs_opening_range_high_bps is not None
        and price_vs_opening_range_high_bps <= _decimal_param(params, 'exit_price_below_opening_range_high_bps', Decimal('-6'))
    ) or (
        recent_imbalance_pressure_avg is not None
        and recent_imbalance_pressure_avg <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.03'))
    ):
        return SleeveSignalEvaluation(
            action='sell',
            confidence=Decimal('0.63'),
            rationale=(
                'breakout_continuation_exit',
                'session_strength_reversal',
            ),
        )
    return None


def evaluate_mean_reversion_rebound_long(
    *,
    params: Mapping[str, Any],
    event_ts: str,
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
    price_vs_opening_range_low_bps: Decimal | None,
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
) -> SleeveSignalEvaluation | None:
    if (
        price is None
        or ema12 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
    ):
        return None

    ts = _parse_event_ts(event_ts)
    if not _within_utc_window(
        ts,
        start_minute=_minute_param(params, 'entry_start_minute_utc', 14 * 60),
        end_minute=_effective_entry_end_minute(
            params,
            default_end_minute=18 * 60 + 45,
        ),
    ):
        return None

    macd_hist = macd - macd_signal
    price_vs_ema12_bps = _bps_delta(price, ema12)
    price_vs_vwap_bps = _bps_delta(price, vwap_session) if vwap_session is not None else price_vs_ema12_bps
    effective_spread_bps = _nonnegative_decimal(spread_bps)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    effective_price_drive_bps = _prefer_primary_decimal(
        price_vs_prev_session_close_bps,
        price_vs_session_open_bps,
    )
    effective_opening_window_return_bps = _prefer_primary_decimal(
        opening_window_return_from_prev_close_bps,
        opening_window_return_bps,
    )
    effective_opening_window_return_rank = _prefer_primary_decimal(
        cross_section_opening_window_return_from_prev_close_rank,
        cross_section_opening_window_return_rank,
    )
    max_session_open_drive_bps = _optional_decimal_param(params, 'max_price_vs_session_open_bps', Decimal('-20'))
    max_session_range_position = _optional_decimal_param(params, 'max_session_range_position', Decimal('0.32'))
    min_session_range_bps = _optional_decimal_param(params, 'min_session_range_bps', Decimal('30'))
    min_price_vs_opening_range_low_bps = _optional_decimal_param(
        params,
        'min_price_vs_opening_range_low_bps',
        Decimal('-18'),
    )
    max_price_vs_opening_range_low_bps = _optional_decimal_param(
        params,
        'max_price_vs_opening_range_low_bps',
        Decimal('8'),
    )
    max_recent_spread_bps = _optional_decimal_param(params, 'max_recent_spread_bps', Decimal('8'))
    max_recent_spread_bps_max = _optional_decimal_param(params, 'max_recent_spread_bps_max', Decimal('16'))
    min_recent_imbalance_pressure = _optional_decimal_param(
        params,
        'min_recent_imbalance_pressure',
        Decimal('0.02'),
    )
    max_recent_quote_invalid_ratio = _optional_decimal_param(
        params,
        'max_recent_quote_invalid_ratio',
        Decimal('0.18'),
    )
    max_recent_quote_jump_bps = _optional_decimal_param(
        params,
        'max_recent_quote_jump_bps',
        Decimal('55'),
    )
    min_recent_microprice_bias_bps = _optional_decimal_param(
        params,
        'min_recent_microprice_bias_bps',
        Decimal('0.10'),
    )
    spread_cap_bps = _decimal_param(params, 'max_spread_bps', Decimal('8'))
    max_cross_section_continuation_rank = _optional_decimal_param(
        params,
        'max_cross_section_continuation_rank',
        None,
    )
    min_cross_section_reversal_rank = _optional_decimal_param(
        params,
        'min_cross_section_reversal_rank',
        None,
    )
    max_opening_window_return_bps = _optional_decimal_param(
        params,
        'max_opening_window_return_bps',
        None,
    )
    max_cross_section_opening_window_return_rank = _optional_decimal_param(
        params,
        'max_cross_section_opening_window_return_rank',
        None,
    )

    if (
        _optional_min_threshold(
            -price_vs_vwap_bps if price_vs_vwap_bps is not None else None,
            _decimal_param(params, 'min_price_below_vwap_bps', Decimal('8')),
        )
        and _optional_max_threshold(
            -price_vs_vwap_bps if price_vs_vwap_bps is not None else None,
            _decimal_param(params, 'max_price_below_vwap_bps', Decimal('70')),
        )
        and _optional_min_threshold(
            -price_vs_ema12_bps if price_vs_ema12_bps is not None else None,
            _decimal_param(params, 'min_price_below_ema12_bps', Decimal('2')),
        )
        and _optional_max_threshold(
            -price_vs_ema12_bps if price_vs_ema12_bps is not None else None,
            _decimal_param(params, 'max_price_below_ema12_bps', Decimal('35')),
        )
        and _decimal_param(params, 'min_bull_rsi', Decimal('40')) <= rsi14 <= _decimal_param(params, 'max_bull_rsi', Decimal('52'))
        and _decimal_param(params, 'bullish_hist_min', Decimal('0.002')) <= macd_hist <= _decimal_param(params, 'bullish_hist_cap', Decimal('0.05'))
        and effective_spread_bps <= spread_cap_bps
        and imbalance_pressure >= _decimal_param(params, 'min_imbalance_pressure', Decimal('0'))
        and _optional_max_threshold(effective_price_drive_bps, max_session_open_drive_bps)
        and _optional_max_threshold(
            effective_opening_window_return_bps,
            max_opening_window_return_bps,
        )
        and _optional_max_threshold(price_position_in_session_range, max_session_range_position)
        and _optional_min_threshold(session_range_bps, min_session_range_bps)
        and _optional_min_threshold(price_vs_opening_range_low_bps, min_price_vs_opening_range_low_bps)
        and _optional_max_threshold(price_vs_opening_range_low_bps, max_price_vs_opening_range_low_bps)
        and _optional_max_threshold(recent_spread_bps_avg, max_recent_spread_bps)
        and _optional_max_threshold(recent_spread_bps_max, max_recent_spread_bps_max)
        and _optional_min_threshold(recent_imbalance_pressure_avg, min_recent_imbalance_pressure)
        and _quote_stability_passes(
            recent_quote_invalid_ratio=recent_quote_invalid_ratio,
            max_recent_quote_invalid_ratio=max_recent_quote_invalid_ratio,
            recent_quote_jump_bps_max=recent_quote_jump_bps_max,
            max_recent_quote_jump_bps=max_recent_quote_jump_bps,
        )
        and _optional_min_threshold(
            recent_microprice_bias_bps_avg,
            min_recent_microprice_bias_bps,
        )
        and _optional_max_threshold(
            cross_section_continuation_rank,
            max_cross_section_continuation_rank,
        )
        and _optional_min_threshold(
            cross_section_reversal_rank,
            min_cross_section_reversal_rank,
        )
        and _optional_max_threshold(
            effective_opening_window_return_rank,
            max_cross_section_opening_window_return_rank,
        )
        and _vol_within_band(
            vol_realized_w60s,
            floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
            ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00055')),
        )
    ):
        confidence = Decimal('0.64')
        if price_vs_vwap_bps is not None and -price_vs_vwap_bps >= Decimal('16'):
            confidence += Decimal('0.03')
        if imbalance_pressure >= Decimal('0.06'):
            confidence += Decimal('0.02')
        if price_position_in_session_range is not None and price_position_in_session_range <= Decimal('0.18'):
            confidence += Decimal('0.02')
        if recent_imbalance_pressure_avg is not None and recent_imbalance_pressure_avg >= Decimal('0.06'):
            confidence += Decimal('0.02')
        if (
            cross_section_reversal_rank is not None
            and cross_section_reversal_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.03')
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal('0.75')
        ):
            confidence += Decimal('0.02')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.81')),
            rationale=(
                'mean_reversion_rebound_long',
                'oversold_rebound',
                'below_vwap',
                'session_dislocation',
                'spread_normalized',
            ),
            notional_multiplier=_resolve_entry_notional_multiplier(
                params=params,
                confidence=min(confidence, Decimal('0.81')),
                rank=cross_section_reversal_rank,
                spread_bps=effective_spread_bps,
                spread_cap_bps=spread_cap_bps,
            ),
        )

    if (
        (vwap_session is not None and price >= vwap_session)
        or (vwap_session is None and price >= ema12)
        or rsi14 >= _decimal_param(params, 'exit_rsi_min', Decimal('61'))
        or macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.002'))
        or (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.02'))
        )
        or (
            price_position_in_session_range is not None
            and price_position_in_session_range >= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.58'))
        )
    ):
        return SleeveSignalEvaluation(
            action='sell',
            confidence=Decimal('0.61'),
            rationale=(
                'mean_reversion_rebound_exit',
                'rebound_complete',
            ),
        )
    return None


def evaluate_late_day_continuation_long(
    *,
    params: Mapping[str, Any],
    event_ts: str,
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
    cross_section_positive_session_open_ratio: Decimal | None,
    cross_section_positive_prev_session_close_ratio: Decimal | None,
    cross_section_positive_opening_window_return_ratio: Decimal | None,
    cross_section_positive_opening_window_return_from_prev_close_ratio: Decimal | None,
    cross_section_above_vwap_w5m_ratio: Decimal | None,
    cross_section_continuation_breadth: Decimal | None,
    cross_section_opening_window_return_rank: Decimal | None,
    cross_section_prev_session_close_rank: Decimal | None,
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None,
    cross_section_continuation_rank: Decimal | None,
) -> SleeveSignalEvaluation | None:
    if (
        price is None
        or ema12 is None
        or ema26 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
    ):
        return None

    ts = _parse_event_ts(event_ts)
    if not _within_utc_window(
        ts,
        start_minute=_minute_param(params, 'entry_start_minute_utc', 18 * 60 + 15),
        end_minute=_effective_entry_end_minute(
            params,
            default_end_minute=19 * 60 + 20,
        ),
    ):
        return None

    macd_hist = macd - macd_signal
    price_vs_ema12_bps = _bps_delta(price, ema12)
    effective_spread_bps = _nonnegative_decimal(spread_bps)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    effective_price_drive_bps = _prefer_primary_decimal(
        price_vs_prev_session_close_bps,
        price_vs_session_open_bps,
    )
    effective_opening_window_return_bps = _prefer_primary_decimal(
        opening_window_return_from_prev_close_bps,
        opening_window_return_bps,
    )
    effective_positive_session_open_ratio = _prefer_primary_decimal(
        cross_section_positive_prev_session_close_ratio,
        cross_section_positive_session_open_ratio,
    )
    effective_positive_opening_window_return_ratio = _prefer_primary_decimal(
        cross_section_positive_opening_window_return_from_prev_close_ratio,
        cross_section_positive_opening_window_return_ratio,
    )
    effective_opening_window_return_rank = _prefer_primary_decimal(
        cross_section_opening_window_return_from_prev_close_rank,
        cross_section_opening_window_return_rank,
    )
    session_high_vs_opening_range_high_bps = _bps_delta(
        session_high_price,
        opening_range_high,
    )
    min_session_open_drive_bps = _decimal_param(params, 'min_session_open_drive_bps', Decimal('35'))
    min_opening_window_return_bps = _optional_decimal_param(
        params,
        'min_opening_window_return_bps',
        Decimal('18'),
    )
    min_session_range_position = _optional_decimal_param(params, 'min_session_range_position', Decimal('0.74'))
    min_session_high_above_opening_range_high_bps = _optional_decimal_param(
        params,
        'min_session_high_above_opening_range_high_bps',
        Decimal('4'),
    )
    min_price_vs_vwap_w5m_bps = _optional_decimal_param(
        params,
        'min_price_vs_vwap_w5m_bps',
        Decimal('-6'),
    )
    max_price_vs_vwap_w5m_bps = _optional_decimal_param(
        params,
        'max_price_vs_vwap_w5m_bps',
        Decimal('14'),
    )
    min_price_vs_opening_range_high_bps = _optional_decimal_param(
        params,
        'min_price_vs_opening_range_high_bps',
        Decimal('-10'),
    )
    max_price_vs_opening_range_high_bps = _optional_decimal_param(
        params,
        'max_price_vs_opening_range_high_bps',
        Decimal('18'),
    )
    min_price_vs_opening_window_close_bps = _optional_decimal_param(
        params,
        'min_price_vs_opening_window_close_bps',
        Decimal('-8'),
    )
    max_price_vs_opening_window_close_bps = _optional_decimal_param(
        params,
        'max_price_vs_opening_window_close_bps',
        Decimal('18'),
    )
    max_recent_spread_bps = _optional_decimal_param(params, 'max_recent_spread_bps', Decimal('5'))
    min_recent_imbalance_pressure = _optional_decimal_param(params, 'min_recent_imbalance_pressure', Decimal('0'))
    min_session_range_bps = _optional_decimal_param(params, 'min_session_range_bps', Decimal('20'))
    max_recent_quote_invalid_ratio = _optional_decimal_param(
        params,
        'max_recent_quote_invalid_ratio',
        Decimal('0.10'),
    )
    max_recent_quote_jump_bps = _optional_decimal_param(
        params,
        'max_recent_quote_jump_bps',
        Decimal('30'),
    )
    min_recent_microprice_bias_bps = _optional_decimal_param(
        params,
        'min_recent_microprice_bias_bps',
        Decimal('0.50'),
    )
    spread_cap_bps = _decimal_param(params, 'max_spread_bps', Decimal('6'))
    min_cross_section_continuation_rank = _optional_decimal_param(
        params,
        'min_cross_section_continuation_rank',
        None,
    )
    min_cross_section_opening_window_return_rank = _optional_decimal_param(
        params,
        'min_cross_section_opening_window_return_rank',
        None,
    )
    min_cross_section_positive_session_open_ratio = _optional_decimal_param(
        params,
        'min_cross_section_positive_session_open_ratio',
        None,
    )
    min_cross_section_positive_opening_window_return_ratio = _optional_decimal_param(
        params,
        'min_cross_section_positive_opening_window_return_ratio',
        None,
    )
    min_cross_section_above_vwap_w5m_ratio = _optional_decimal_param(
        params,
        'min_cross_section_above_vwap_w5m_ratio',
        None,
    )
    min_cross_section_continuation_breadth = _optional_decimal_param(
        params,
        'min_cross_section_continuation_breadth',
        None,
    )

    if (
        ema12 > ema26
        and _decimal_param(params, 'bullish_hist_min', Decimal('0.006')) <= macd_hist <= _decimal_param(params, 'bullish_hist_cap', Decimal('0.05'))
        and _decimal_param(params, 'min_bull_rsi', Decimal('57')) <= rsi14 <= _decimal_param(params, 'max_bull_rsi', Decimal('72'))
        and _optional_min_threshold(
            price_vs_ema12_bps,
            _decimal_param(params, 'min_price_above_ema12_bps', Decimal('0')),
        )
        and _optional_max_threshold(
            price_vs_ema12_bps,
            _decimal_param(params, 'max_price_above_ema12_bps', Decimal('14')),
        )
        and _optional_min_threshold(price_vs_vwap_w5m_bps, min_price_vs_vwap_w5m_bps)
        and _optional_max_threshold(price_vs_vwap_w5m_bps, max_price_vs_vwap_w5m_bps)
        and effective_spread_bps <= spread_cap_bps
        and imbalance_pressure >= _decimal_param(params, 'min_imbalance_pressure', Decimal('-0.01'))
        and _optional_min_threshold(effective_price_drive_bps, min_session_open_drive_bps)
        and _optional_min_threshold(
            effective_opening_window_return_bps,
            min_opening_window_return_bps,
        )
        and _optional_min_threshold(price_position_in_session_range, min_session_range_position)
        and _optional_min_threshold(session_high_vs_opening_range_high_bps, min_session_high_above_opening_range_high_bps)
        and _optional_min_threshold(price_vs_opening_range_high_bps, min_price_vs_opening_range_high_bps)
        and _optional_max_threshold(price_vs_opening_range_high_bps, max_price_vs_opening_range_high_bps)
        and _optional_min_threshold(
            price_vs_opening_window_close_bps,
            min_price_vs_opening_window_close_bps,
        )
        and _optional_max_threshold(
            price_vs_opening_window_close_bps,
            max_price_vs_opening_window_close_bps,
        )
        and _optional_max_threshold(recent_spread_bps_avg, max_recent_spread_bps)
        and _optional_min_threshold(recent_imbalance_pressure_avg, min_recent_imbalance_pressure)
        and _optional_min_threshold(session_range_bps, min_session_range_bps)
        and _quote_stability_passes(
            recent_quote_invalid_ratio=recent_quote_invalid_ratio,
            max_recent_quote_invalid_ratio=max_recent_quote_invalid_ratio,
            recent_quote_jump_bps_max=recent_quote_jump_bps_max,
            max_recent_quote_jump_bps=max_recent_quote_jump_bps,
        )
        and _optional_min_threshold(
            recent_microprice_bias_bps_avg,
            min_recent_microprice_bias_bps,
        )
        and _optional_min_threshold(
            cross_section_continuation_rank,
            min_cross_section_continuation_rank,
        )
        and _optional_min_threshold(
            effective_opening_window_return_rank,
            min_cross_section_opening_window_return_rank,
        )
        and _optional_min_threshold(
            effective_positive_session_open_ratio,
            min_cross_section_positive_session_open_ratio,
        )
        and _optional_min_threshold(
            effective_positive_opening_window_return_ratio,
            min_cross_section_positive_opening_window_return_ratio,
        )
        and _optional_min_threshold(
            cross_section_above_vwap_w5m_ratio,
            min_cross_section_above_vwap_w5m_ratio,
        )
        and _optional_min_threshold(
            cross_section_continuation_breadth,
            min_cross_section_continuation_breadth,
        )
        and _vol_within_band(
            vol_realized_w60s,
            floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
            ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00035')),
        )
    ):
        confidence = Decimal('0.69')
        if price_vs_vwap_w5m_bps is not None and price_vs_vwap_w5m_bps >= Decimal('4'):
            confidence += Decimal('0.03')
        if effective_spread_bps <= Decimal('3'):
            confidence += Decimal('0.02')
        if imbalance_pressure >= Decimal('0.04'):
            confidence += Decimal('0.02')
        if effective_price_drive_bps is not None and effective_price_drive_bps >= Decimal('60'):
            confidence += Decimal('0.03')
        if (
            effective_opening_window_return_bps is not None
            and effective_opening_window_return_bps >= Decimal('30')
        ):
            confidence += Decimal('0.02')
        if (
            cross_section_continuation_rank is not None
            and cross_section_continuation_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.03')
        if (
            effective_opening_window_return_rank is not None
            and effective_opening_window_return_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.02')
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal('1.5')
        ):
            confidence += Decimal('0.03')
        if (
            cross_section_continuation_breadth is not None
            and cross_section_continuation_breadth >= Decimal('0.60')
        ):
            confidence += Decimal('0.02')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.87')),
            rationale=(
                'late_day_continuation_long',
                'trend_up',
                'session_strength_confirmed',
                'late_day_strength',
                'close_auction_setup',
            ),
            notional_multiplier=_resolve_entry_notional_multiplier(
                params=params,
                confidence=min(confidence, Decimal('0.87')),
                rank=cross_section_continuation_rank,
                spread_bps=effective_spread_bps,
                spread_cap_bps=spread_cap_bps,
            ),
        )

    if (
        (
            price_vs_vwap_w5m_bps is not None
            and price_vs_vwap_w5m_bps <= _decimal_param(params, 'exit_price_vs_vwap_w5m_bps', Decimal('-10'))
        )
        or (
            price_position_in_session_range is not None
            and price_position_in_session_range <= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.58'))
        )
        or (
            price_vs_session_open_bps is not None
            and price_vs_session_open_bps <= _decimal_param(params, 'exit_session_open_drive_bps', Decimal('24'))
        )
        or (
            macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.004'))
            and rsi14 <= _decimal_param(params, 'exit_rsi_max', Decimal('55'))
        )
        or (
            price_vs_opening_range_high_bps is not None
            and price_vs_opening_range_high_bps <= _decimal_param(params, 'exit_price_below_opening_range_high_bps', Decimal('-16'))
        )
        or (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.02'))
        )
    ):
        return SleeveSignalEvaluation(
            action='sell',
            confidence=Decimal('0.63'),
            rationale=(
                'late_day_continuation_exit',
                'late_day_failure',
            ),
        )
    return None


def evaluate_end_of_day_reversal_long(
    *,
    params: Mapping[str, Any],
    event_ts: str,
    price: Decimal | None,
    ema12: Decimal | None,
    ema26: Decimal | None,
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
    price_vs_opening_range_low_bps: Decimal | None,
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
) -> SleeveSignalEvaluation | None:
    if (
        price is None
        or ema12 is None
        or ema26 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
    ):
        return None

    ts = _parse_event_ts(event_ts)
    if not _within_utc_window(
        ts,
        start_minute=_minute_param(params, 'entry_start_minute_utc', 19 * 60 + 20),
        end_minute=_effective_entry_end_minute(
            params,
            default_end_minute=19 * 60 + 48,
        ),
    ):
        return None

    macd_hist = macd - macd_signal
    price_vs_ema12_bps = _bps_delta(price, ema12)
    price_vs_vwap_bps = _bps_delta(price, vwap_session) if vwap_session is not None else price_vs_ema12_bps
    effective_spread_bps = _nonnegative_decimal(spread_bps)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    effective_price_drive_bps = _prefer_primary_decimal(
        price_vs_prev_session_close_bps,
        price_vs_session_open_bps,
    )
    effective_opening_window_return_bps = _prefer_primary_decimal(
        opening_window_return_from_prev_close_bps,
        opening_window_return_bps,
    )
    effective_opening_window_return_rank = _prefer_primary_decimal(
        cross_section_opening_window_return_from_prev_close_rank,
        cross_section_opening_window_return_rank,
    )
    max_cross_section_continuation_rank = _optional_decimal_param(
        params,
        'max_cross_section_continuation_rank',
        None,
    )
    spread_cap_bps = _decimal_param(params, 'max_spread_bps', Decimal('12'))
    max_recent_quote_invalid_ratio = _optional_decimal_param(
        params,
        'max_recent_quote_invalid_ratio',
        Decimal('0.14'),
    )
    max_recent_quote_jump_bps = _optional_decimal_param(
        params,
        'max_recent_quote_jump_bps',
        Decimal('45'),
    )
    min_recent_microprice_bias_bps = _optional_decimal_param(
        params,
        'min_recent_microprice_bias_bps',
        Decimal('0.05'),
    )
    min_cross_section_reversal_rank = _optional_decimal_param(
        params,
        'min_cross_section_reversal_rank',
        None,
    )
    max_opening_window_return_bps = _optional_decimal_param(
        params,
        'max_opening_window_return_bps',
        None,
    )
    max_cross_section_opening_window_return_rank = _optional_decimal_param(
        params,
        'max_cross_section_opening_window_return_rank',
        None,
    )

    if (
        _optional_max_threshold(
            effective_price_drive_bps,
            _optional_decimal_param(params, 'max_price_vs_session_open_bps', Decimal('-45')),
        )
        and _optional_max_threshold(
            effective_opening_window_return_bps,
            max_opening_window_return_bps,
        )
        and _optional_max_threshold(
            price_position_in_session_range,
            _optional_decimal_param(params, 'max_session_range_position', Decimal('0.40')),
        )
        and _optional_min_threshold(
            session_range_bps,
            _optional_decimal_param(params, 'min_session_range_bps', Decimal('40')),
        )
        and _optional_min_threshold(
            price_vs_opening_range_low_bps,
            _optional_decimal_param(params, 'min_price_vs_opening_range_low_bps', Decimal('-6')),
        )
        and _optional_max_threshold(
            price_vs_opening_range_low_bps,
            _optional_decimal_param(params, 'max_price_vs_opening_range_low_bps', Decimal('16')),
        )
        and _optional_min_threshold(
            -price_vs_vwap_bps if price_vs_vwap_bps is not None else None,
            _optional_decimal_param(params, 'min_price_below_vwap_bps', Decimal('8')),
        )
        and _optional_max_threshold(
            -price_vs_vwap_bps if price_vs_vwap_bps is not None else None,
            _optional_decimal_param(params, 'max_price_below_vwap_bps', Decimal('40')),
        )
        and _optional_min_threshold(
            -price_vs_ema12_bps if price_vs_ema12_bps is not None else None,
            _optional_decimal_param(params, 'min_price_below_ema12_bps', Decimal('4')),
        )
        and _optional_max_threshold(
            -price_vs_ema12_bps if price_vs_ema12_bps is not None else None,
            _optional_decimal_param(params, 'max_price_below_ema12_bps', Decimal('28')),
        )
        and _decimal_param(params, 'min_bull_rsi', Decimal('34'))
        <= rsi14
        <= _decimal_param(params, 'max_bull_rsi', Decimal('48'))
        and _decimal_param(params, 'min_macd_hist', Decimal('-0.010'))
        <= macd_hist
        <= _decimal_param(params, 'max_macd_hist', Decimal('0.012'))
        and ema12 <= ema26
        and effective_spread_bps <= spread_cap_bps
        and imbalance_pressure >= _decimal_param(params, 'min_imbalance_pressure', Decimal('0.02'))
        and _optional_max_threshold(
            recent_spread_bps_avg,
            _optional_decimal_param(params, 'max_recent_spread_bps', Decimal('8')),
        )
        and _optional_max_threshold(
            recent_spread_bps_max,
            _optional_decimal_param(params, 'max_recent_spread_bps_max', Decimal('16')),
        )
        and _optional_min_threshold(
            recent_imbalance_pressure_avg,
            _optional_decimal_param(params, 'min_recent_imbalance_pressure', Decimal('0.03')),
        )
        and _quote_stability_passes(
            recent_quote_invalid_ratio=recent_quote_invalid_ratio,
            max_recent_quote_invalid_ratio=max_recent_quote_invalid_ratio,
            recent_quote_jump_bps_max=recent_quote_jump_bps_max,
            max_recent_quote_jump_bps=max_recent_quote_jump_bps,
        )
        and _optional_min_threshold(
            recent_microprice_bias_bps_avg,
            min_recent_microprice_bias_bps,
        )
        and _optional_max_threshold(
            cross_section_continuation_rank,
            max_cross_section_continuation_rank,
        )
        and _optional_min_threshold(
            cross_section_reversal_rank,
            min_cross_section_reversal_rank,
        )
        and _optional_max_threshold(
            effective_opening_window_return_rank,
            max_cross_section_opening_window_return_rank,
        )
        and _vol_within_band(
            vol_realized_w60s,
            floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
            ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00050')),
        )
    ):
        confidence = Decimal('0.67')
        if effective_price_drive_bps is not None and effective_price_drive_bps <= Decimal('-70'):
            confidence += Decimal('0.03')
        if recent_imbalance_pressure_avg is not None and recent_imbalance_pressure_avg >= Decimal('0.06'):
            confidence += Decimal('0.02')
        if price_position_in_session_range is not None and price_position_in_session_range <= Decimal('0.25'):
            confidence += Decimal('0.02')
        if (
            cross_section_reversal_rank is not None
            and cross_section_reversal_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.03')
        if (
            recent_microprice_bias_bps_avg is not None
            and recent_microprice_bias_bps_avg >= Decimal('0.50')
        ):
            confidence += Decimal('0.02')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.84')),
            rationale=(
                'end_of_day_reversal_long',
                'intraday_loser',
                'close_reversion_setup',
                'spread_normalized',
                'rebid_confirmed',
            ),
            notional_multiplier=_resolve_entry_notional_multiplier(
                params=params,
                confidence=min(confidence, Decimal('0.84')),
                rank=cross_section_reversal_rank,
                spread_bps=effective_spread_bps,
                spread_cap_bps=spread_cap_bps,
            ),
        )

    if (
        (vwap_session is not None and price >= vwap_session)
        or price >= ema12
        or rsi14 >= _decimal_param(params, 'exit_rsi_min', Decimal('56'))
        or (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.02'))
        )
        or (
            price_position_in_session_range is not None
            and price_position_in_session_range >= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.58'))
        )
    ):
        return SleeveSignalEvaluation(
            action='sell',
            confidence=Decimal('0.62'),
            rationale=(
                'end_of_day_reversal_exit',
                'reversion_complete',
            ),
        )
    return None


def _parse_event_ts(raw: str) -> datetime:
    normalized = raw.replace('Z', '+00:00')
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _minute_param(params: Mapping[str, Any], key: str, default: int) -> int:
    raw = params.get(key)
    if raw is None:
        return default
    try:
        return int(str(raw))
    except (TypeError, ValueError):
        return default


def _optional_minute_param(params: Mapping[str, Any], key: str) -> int | None:
    raw = params.get(key)
    if raw is None:
        return None
    try:
        return int(str(raw))
    except (TypeError, ValueError):
        return None


def _decimal_param(params: Mapping[str, Any], key: str, default: Decimal) -> Decimal:
    raw = params.get(key)
    if raw is None:
        return default
    try:
        return Decimal(str(raw))
    except Exception:
        return default


def _optional_decimal_param(params: Mapping[str, Any], key: str, default: Decimal | None) -> Decimal | None:
    raw = params.get(key)
    if raw is None:
        return default
    try:
        return Decimal(str(raw))
    except Exception:
        return default


def _within_utc_window(ts: datetime, *, start_minute: int, end_minute: int) -> bool:
    minute = ts.hour * 60 + ts.minute
    return start_minute <= minute <= end_minute


def _effective_entry_end_minute(
    params: Mapping[str, Any],
    *,
    default_end_minute: int,
) -> int:
    entry_end_minute = _minute_param(params, 'entry_end_minute_utc', default_end_minute)
    flatten_start_minute = _optional_minute_param(params, 'session_flatten_start_minute_utc')
    min_entry_minutes_before_flatten = _minute_param(
        params,
        'min_entry_minutes_before_flatten',
        15,
    )
    if flatten_start_minute is None or min_entry_minutes_before_flatten <= 0:
        return entry_end_minute
    return min(entry_end_minute, flatten_start_minute - min_entry_minutes_before_flatten)


def _bps_delta(price: Decimal | None, reference: Decimal | None) -> Decimal | None:
    if price is None or reference is None or reference == 0:
        return None
    return ((price - reference) / reference) * Decimal('10000')


def _prefer_primary_decimal(primary: Decimal | None, fallback: Decimal | None) -> Decimal | None:
    return primary if primary is not None else fallback


def _nonnegative_decimal(value: Decimal | None) -> Decimal:
    if value is None:
        return Decimal('0')
    return max(value, Decimal('0'))


def _scaled_extension_cap(
    *,
    base_cap: Decimal | None,
    reference_bps: Decimal | None,
    multiplier: Decimal | None,
) -> Decimal:
    cap = base_cap if base_cap is not None else Decimal('0')
    if reference_bps is None or reference_bps <= 0 or multiplier is None or multiplier <= 0:
        return cap
    return max(cap, reference_bps * multiplier)


def _imbalance_pressure(bid_sz: Decimal | None, ask_sz: Decimal | None) -> Decimal:
    if bid_sz is None or ask_sz is None:
        return Decimal('0')
    total = bid_sz + ask_sz
    if total <= 0:
        return Decimal('0')
    return (bid_sz - ask_sz) / total


def _vol_within_band(
    value: Decimal | None,
    *,
    floor: Decimal | None,
    ceil: Decimal | None,
) -> bool:
    if value is None:
        return True
    if floor is not None and value < floor:
        return False
    if ceil is not None and value > ceil:
        return False
    return True


def _optional_min_threshold(value: Decimal | None, floor: Decimal | None) -> bool:
    if floor is None or value is None:
        return True
    return value >= floor


def _optional_max_threshold(value: Decimal | None, ceil: Decimal | None) -> bool:
    if ceil is None or value is None:
        return True
    return value <= ceil


def _quote_stability_passes(
    *,
    recent_quote_invalid_ratio: Decimal | None,
    max_recent_quote_invalid_ratio: Decimal | None,
    recent_quote_jump_bps_max: Decimal | None,
    max_recent_quote_jump_bps: Decimal | None,
) -> bool:
    return _optional_max_threshold(
        recent_quote_invalid_ratio,
        max_recent_quote_invalid_ratio,
    ) and _optional_max_threshold(
        recent_quote_jump_bps_max,
        max_recent_quote_jump_bps,
    )


def _resolve_entry_notional_multiplier(
    *,
    params: Mapping[str, Any],
    confidence: Decimal,
    rank: Decimal | None,
    spread_bps: Decimal | None,
    spread_cap_bps: Decimal | None,
) -> Decimal:
    min_multiplier = _decimal_param(
        params,
        'entry_notional_min_multiplier',
        Decimal('0.20'),
    )
    max_multiplier = _decimal_param(
        params,
        'entry_notional_max_multiplier',
        Decimal('1'),
    )
    if max_multiplier <= 0:
        return Decimal('0')
    if min_multiplier < 0:
        min_multiplier = Decimal('0')
    if min_multiplier > max_multiplier:
        min_multiplier = max_multiplier

    score_terms = [
        _normalize_score(
            confidence,
            floor=_decimal_param(
                params,
                'entry_notional_confidence_floor',
                Decimal('0.62'),
            ),
            ceil=_decimal_param(
                params,
                'entry_notional_confidence_ceiling',
                Decimal('0.85'),
            ),
        )
    ]
    rank_floor = _optional_decimal_param(params, 'entry_notional_rank_floor', None)
    rank_ceil = _optional_decimal_param(params, 'entry_notional_rank_ceiling', Decimal('0.95'))
    if rank is not None and rank_floor is not None:
        score_terms.append(
            _normalize_score(
                rank,
                floor=rank_floor,
                ceil=rank_ceil if rank_ceil is not None else Decimal('0.95'),
            )
        )

    spread_ceil = _optional_decimal_param(
        params,
        'entry_notional_spread_ceiling_bps',
        spread_cap_bps,
    )
    if spread_bps is not None and spread_ceil is not None and spread_ceil > 0:
        score_terms.append(
            Decimal('1')
            - _normalize_score(
                spread_bps,
                floor=Decimal('0'),
                ceil=spread_ceil,
            )
        )

    score = sum(score_terms, Decimal('0')) / Decimal(len(score_terms))
    multiplier = min_multiplier + ((max_multiplier - min_multiplier) * score)
    if multiplier < min_multiplier:
        multiplier = min_multiplier
    if multiplier > max_multiplier:
        multiplier = max_multiplier
    return multiplier.quantize(Decimal('0.0001'))


def _normalize_score(value: Decimal, *, floor: Decimal, ceil: Decimal) -> Decimal:
    if ceil <= floor:
        return Decimal('1') if value >= ceil else Decimal('0')
    if value <= floor:
        return Decimal('0')
    if value >= ceil:
        return Decimal('1')
    return (value - floor) / (ceil - floor)
