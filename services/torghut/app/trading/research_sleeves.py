"""Research-backed intraday sleeve evaluations for the March profitability program."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Mapping

from .evaluation_trace import GateCategory, GateTrace, StrategyTrace, ThresholdTrace


@dataclass(frozen=True)
class SleeveSignalEvaluation:
    action: Literal['buy', 'sell']
    confidence: Decimal
    rationale: tuple[str, ...]
    notional_multiplier: Decimal = Decimal('1')


@dataclass(frozen=True)
class SleeveSignalResult:
    signal: SleeveSignalEvaluation | None
    trace: StrategyTrace | None = None


def _make_strategy_trace(
    *,
    strategy_id: str | None,
    strategy_type: str | None,
    symbol: str,
    event_ts: str,
    timeframe: str | None,
    passed: bool,
    action: Literal['buy', 'sell'] | None,
    rationale: tuple[str, ...],
    gates: tuple[GateTrace, ...],
    trace_enabled: bool,
    context: dict[str, Any] | None = None,
) -> StrategyTrace | None:
    if not trace_enabled:
        return None
    first_failed_gate = next((gate.gate for gate in gates if not gate.passed), None)
    return StrategyTrace(
        strategy_id=(strategy_id or '').strip() or 'unknown',
        strategy_type=(strategy_type or '').strip() or 'unknown',
        symbol=symbol,
        event_ts=event_ts,
        timeframe=(timeframe or '').strip() or 'unknown',
        passed=passed,
        action=action,
        rationale=rationale,
        gates=gates,
        first_failed_gate=first_failed_gate,
        context=context or {},
    )


def _threshold_min(
    *,
    metric: str,
    value: Decimal | None,
    floor: Decimal | None,
    required: bool,
) -> ThresholdTrace:
    if floor is None:
        return ThresholdTrace(
            metric=metric,
            comparator='optional_min',
            value=value,
            threshold=floor,
            passed=True,
            missing_policy='fail_open' if not required else 'fail_closed',
            distance_to_pass=Decimal('0'),
        )
    if value is None:
        return ThresholdTrace(
            metric=metric,
            comparator='min_gte',
            value=value,
            threshold=floor,
            passed=not required,
            missing_policy='fail_closed' if required else 'fail_open',
            distance_to_pass=(floor if required else Decimal('0')),
        )
    passed = value >= floor
    return ThresholdTrace(
        metric=metric,
        comparator='min_gte',
        value=value,
        threshold=floor,
        passed=passed,
        missing_policy='fail_closed' if required else 'fail_open',
        distance_to_pass=Decimal('0') if passed else (floor - value),
    )


def _threshold_max(
    *,
    metric: str,
    value: Decimal | None,
    ceil: Decimal | None,
    required: bool,
) -> ThresholdTrace:
    if ceil is None:
        return ThresholdTrace(
            metric=metric,
            comparator='optional_max',
            value=value,
            threshold=ceil,
            passed=True,
            missing_policy='fail_open' if not required else 'fail_closed',
            distance_to_pass=Decimal('0'),
        )
    if value is None:
        return ThresholdTrace(
            metric=metric,
            comparator='max_lte',
            value=value,
            threshold=ceil,
            passed=not required,
            missing_policy='fail_closed' if required else 'fail_open',
            distance_to_pass=(ceil if required else Decimal('0')),
        )
    passed = value <= ceil
    return ThresholdTrace(
        metric=metric,
        comparator='max_lte',
        value=value,
        threshold=ceil,
        passed=passed,
        missing_policy='fail_closed' if required else 'fail_open',
        distance_to_pass=Decimal('0') if passed else (value - ceil),
    )


def _threshold_range(
    *,
    metric: str,
    value: Decimal | None,
    floor: Decimal | None,
    ceil: Decimal | None,
    required: bool,
) -> tuple[ThresholdTrace, ThresholdTrace]:
    return (
        _threshold_min(metric=metric, value=value, floor=floor, required=required),
        _threshold_max(metric=metric, value=value, ceil=ceil, required=required),
    )


def _threshold_bool(
    *,
    metric: str,
    passed: bool,
    threshold: Any,
    value: Any = True,
) -> ThresholdTrace:
    return ThresholdTrace(
        metric=metric,
        comparator='bool',
        value=value,
        threshold=threshold,
        passed=passed,
        missing_policy='fail_closed',
        distance_to_pass=Decimal('0') if passed else Decimal('1'),
    )


def _gate(
    *,
    name: str,
    category: GateCategory,
    thresholds: tuple[ThresholdTrace, ...],
    context: dict[str, Any] | None = None,
) -> GateTrace:
    return GateTrace(
        gate=name,
        category=category,
        passed=all(item.passed for item in thresholds),
        thresholds=thresholds,
        context=context or {},
    )


def _sleeve_result(
    *,
    strategy_id: str | None,
    strategy_type: str | None,
    symbol: str,
    event_ts: str,
    timeframe: str | None,
    signal: SleeveSignalEvaluation | None,
    gates: tuple[GateTrace, ...],
    trace_enabled: bool,
    context: dict[str, Any] | None = None,
) -> SleeveSignalResult:
    trace = _make_strategy_trace(
        strategy_id=strategy_id,
        strategy_type=strategy_type,
        symbol=symbol,
        event_ts=event_ts,
        timeframe=timeframe,
        passed=signal is not None,
        action=signal.action if signal is not None else None,
        rationale=signal.rationale if signal is not None else (),
        gates=gates,
        trace_enabled=trace_enabled,
        context=context,
    )
    return SleeveSignalResult(signal=signal, trace=trace)


def _required_inputs_gate(
    *,
    fields: Mapping[str, bool],
) -> GateTrace:
    return _gate(
        name='eligibility',
        category='eligibility',
        thresholds=(
            _threshold_bool(
                metric='required_inputs_present',
                passed=all(fields.values()),
                threshold=True,
                value=dict(fields),
            ),
        ),
    )


def _entry_window_gate(
    *,
    within_window: bool,
    start_minute: int,
    end_minute: int,
) -> GateTrace:
    return _gate(
        name='eligibility',
        category='eligibility',
        thresholds=(
            _threshold_bool(
                metric='within_entry_window',
                passed=within_window,
                threshold='entry_window',
            ),
        ),
        context={
            'entry_start_minute_utc': start_minute,
            'entry_end_minute_utc': end_minute,
        },
    )


def _exit_trigger_gate(
    *,
    reason_flags: Mapping[str, bool],
) -> GateTrace:
    return _gate(
        name='exit',
        category='exit',
        thresholds=(
            _threshold_bool(
                metric='exit_triggered',
                passed=any(reason_flags.values()),
                threshold='any_exit_reason',
                value=dict(reason_flags),
            ),
        ),
        context={'reasons': dict(reason_flags)},
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
    trace_context = {
        'family': 'momentum_pullback_long',
    }
    if (
        price is None
        or ema12 is None
        or ema26 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
    ):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _gate(
                    name='eligibility',
                    category='eligibility',
                    thresholds=(
                        _threshold_bool(
                            metric='required_inputs_present',
                            passed=False,
                            threshold=True,
                            value={
                                'price': price is not None,
                                'ema12': ema12 is not None,
                                'ema26': ema26 is not None,
                                'macd': macd is not None,
                                'macd_signal': macd_signal is not None,
                                'rsi14': rsi14 is not None,
                            },
                        ),
                    ),
                ),
            ),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    ts = _parse_event_ts(event_ts)
    if not _within_utc_window(
        ts,
        start_minute=_minute_param(params, 'entry_start_minute_utc', 14 * 60),
        end_minute=_effective_entry_end_minute(
            params,
            default_end_minute=19 * 60 + 50,
        ),
    ):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _gate(
                    name='eligibility',
                    category='eligibility',
                    thresholds=(
                        _threshold_bool(
                            metric='within_entry_window',
                            passed=False,
                            threshold='entry_window',
                        ),
                    ),
                    context={'entry_start_minute_utc': _minute_param(params, 'entry_start_minute_utc', 14 * 60)},
                ),
            ),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

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

    pullback_bps = -price_vs_ema12_bps if price_vs_ema12_bps is not None else None
    buy_gates = (
        _gate(
            name='structure',
            category='structure',
            thresholds=(
                _threshold_bool(metric='ema12_gt_ema26', passed=ema12 > ema26, threshold=True),
                *_threshold_range(
                    metric='macd_hist',
                    value=macd_hist,
                    floor=bullish_hist_min,
                    ceil=bullish_hist_cap,
                    required=True,
                ),
                *_threshold_range(
                    metric='rsi14',
                    value=rsi14,
                    floor=min_bull_rsi,
                    ceil=max_bull_rsi,
                    required=True,
                ),
                *_threshold_range(
                    metric='pullback_bps',
                    value=pullback_bps,
                    floor=min_pullback_bps,
                    ceil=max_pullback_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='price_vs_session_open_bps',
                    value=price_vs_session_open_bps,
                    floor=min_session_open_drive_bps,
                    required=False,
                ),
            ),
        ),
        _gate(
            name='feed_quality',
            category='feed_quality',
            thresholds=(
                _threshold_max(
                    metric='spread_bps',
                    value=effective_spread_bps,
                    ceil=spread_cap_bps,
                    required=True,
                ),
                _threshold_max(
                    metric='recent_spread_bps_avg',
                    value=recent_spread_bps_avg,
                    ceil=max_recent_spread_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio',
                    value=recent_quote_invalid_ratio,
                    ceil=max_recent_quote_invalid_ratio,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_jump_bps_max',
                    value=recent_quote_jump_bps_max,
                    ceil=max_recent_quote_jump_bps,
                    required=False,
                ),
                *_threshold_range(
                    metric='vol_realized_w60s',
                    value=vol_realized_w60s,
                    floor=vol_floor,
                    ceil=vol_ceil,
                    required=False,
                ),
            ),
        ),
        _gate(
            name='confirmation',
            category='confirmation',
            thresholds=(
                _threshold_min(
                    metric='imbalance_pressure',
                    value=imbalance_pressure,
                    floor=imbalance_floor,
                    required=True,
                ),
                _threshold_min(
                    metric='recent_imbalance_pressure_avg',
                    value=recent_imbalance_pressure_avg,
                    floor=min_recent_imbalance_pressure,
                    required=False,
                ),
                _threshold_min(
                    metric='recent_microprice_bias_bps_avg',
                    value=recent_microprice_bias_bps_avg,
                    floor=min_recent_microprice_bias_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_continuation_rank',
                    value=cross_section_continuation_rank,
                    floor=min_cross_section_continuation_rank,
                    required=False,
                ),
            ),
        ),
    )
    if all(gate.passed for gate in buy_gates):
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
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
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
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    exit_gate = _gate(
        name='exit',
        category='exit',
        thresholds=(
            _threshold_bool(metric='ema12_lt_ema26', passed=ema12 < ema26, threshold=True),
            _threshold_max(
                metric='macd_hist',
                value=macd_hist,
                ceil=_decimal_param(params, 'exit_macd_hist_max', Decimal('-0.002')),
                required=True,
            ),
            _threshold_max(
                metric='rsi14',
                value=rsi14,
                ceil=_decimal_param(params, 'exit_rsi_max', Decimal('49')),
                required=True,
            ),
        ),
    )
    if exit_gate.passed:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='sell',
                confidence=Decimal('0.63'),
                rationale=(
                    'momentum_pullback_exit',
                    'trend_lost',
                    'momentum_rollover',
                ),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    return _sleeve_result(
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
    trace_context = {'family': 'breakout_continuation_long'}
    if (
        price is None
        or ema12 is None
        or ema26 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
    ):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _gate(
                    name='eligibility',
                    category='eligibility',
                    thresholds=(
                        _threshold_bool(
                            metric='required_inputs_present',
                            passed=False,
                            threshold=True,
                            value={
                                'price': price is not None,
                                'ema12': ema12 is not None,
                                'ema26': ema26 is not None,
                                'macd': macd is not None,
                                'macd_signal': macd_signal is not None,
                                'rsi14': rsi14 is not None,
                            },
                        ),
                    ),
                ),
            ),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    ts = _parse_event_ts(event_ts)
    entry_start_minute = _minute_param(params, 'entry_start_minute_utc', 14 * 60 + 15)
    entry_end_minute = _effective_entry_end_minute(
        params,
        default_end_minute=19 * 60 + 45,
    )
    latest_breakout_entry_end_minute = _optional_minute_param(
        params,
        'latest_breakout_entry_end_minute_utc',
    )
    if latest_breakout_entry_end_minute is not None:
        entry_end_minute = min(entry_end_minute, latest_breakout_entry_end_minute)
    if not _within_utc_window(
        ts,
        start_minute=entry_start_minute,
        end_minute=entry_end_minute,
    ):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _gate(
                    name='eligibility',
                    category='eligibility',
                    thresholds=(
                        _threshold_bool(
                            metric='within_entry_window',
                            passed=False,
                            threshold='entry_window',
                        ),
                    ),
                    context={
                        'entry_start_minute_utc': entry_start_minute,
                        'entry_end_minute_utc': entry_end_minute,
                    },
                ),
            ),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

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
    session_open_return_efficiency = _ratio_decimal_over_bps(
        opening_window_return_bps,
        opening_range_width_bps,
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
    effective_continuation_rank = _resolve_live_continuation_rank(
        event_ts=event_ts,
        cross_section_session_open_rank=cross_section_session_open_rank,
        cross_section_prev_session_close_rank=cross_section_prev_session_close_rank,
        cross_section_opening_window_return_rank=cross_section_opening_window_return_rank,
        cross_section_opening_window_return_from_prev_close_rank=(
            cross_section_opening_window_return_from_prev_close_rank
        ),
        cross_section_range_position_rank=cross_section_range_position_rank,
        cross_section_vwap_w5m_rank=cross_section_vwap_w5m_rank,
        cross_section_recent_imbalance_rank=cross_section_recent_imbalance_rank,
        fallback_rank=cross_section_continuation_rank,
    )
    session_high_vs_opening_range_high_bps = _bps_delta(
        session_high_price,
        opening_range_high,
    )
    min_session_open_drive_bps = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_session_open_drive_bps',
            Decimal('20'),
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_session_open_drive_bps',
            None,
        ),
    )
    min_opening_window_return_bps = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_opening_window_return_bps',
            Decimal('12'),
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_opening_window_return_bps',
            None,
        ),
    )
    min_session_open_return_efficiency = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_session_open_return_efficiency',
            Decimal('0.60'),
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_session_open_return_efficiency',
            Decimal('0.45'),
        ),
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
    hard_max_recent_quote_invalid_ratio = _optional_decimal_param(
        params,
        'hard_max_recent_quote_invalid_ratio',
        None,
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
    min_recent_above_opening_range_high_ratio = _optional_decimal_param(
        params,
        'min_recent_above_opening_range_high_ratio',
        None,
    )
    min_recent_above_opening_window_close_ratio = _optional_decimal_param(
        params,
        'min_recent_above_opening_window_close_ratio',
        None,
    )
    min_recent_above_vwap_w5m_ratio = _optional_decimal_param(
        params,
        'min_recent_above_vwap_w5m_ratio',
        None,
    )
    spread_cap_bps = _decimal_param(params, 'max_spread_bps', Decimal('6'))
    min_imbalance_pressure = _decimal_param(params, 'min_imbalance_pressure', Decimal('0'))
    min_cross_section_continuation_rank = _optional_decimal_param(
        params,
        'min_cross_section_continuation_rank',
        None,
    )
    min_cross_section_opening_window_return_rank = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_cross_section_opening_window_return_rank',
            None,
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_cross_section_opening_window_return_rank',
            None,
        ),
    )
    min_cross_section_positive_session_open_ratio = _optional_decimal_param(
        params,
        'min_cross_section_positive_session_open_ratio',
        None,
    )
    min_cross_section_positive_opening_window_return_ratio = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_cross_section_positive_opening_window_return_ratio',
            None,
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_cross_section_positive_opening_window_return_ratio',
            None,
        ),
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
    early_breakout_quality_cutoff_minutes = _minute_param(
        params,
        'early_breakout_quality_cutoff_minutes',
        90,
    )
    early_breakout_elite_continuation_rank = _optional_decimal_param(
        params,
        'early_breakout_elite_continuation_rank',
        Decimal('0.90'),
    )
    min_early_breakout_continuation_breadth = _optional_decimal_param(
        params,
        'min_early_breakout_continuation_breadth',
        Decimal('0.75'),
    )
    min_early_breakout_microprice_bias_bps = _optional_decimal_param(
        params,
        'min_early_breakout_microprice_bias_bps',
        Decimal('0.60'),
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
    isolated_flow_strength_confirmed = _isolated_breakout_strength_confirmed(
        params=params,
        range_position_rank=cross_section_range_position_rank,
        vwap_w5m_rank=cross_section_vwap_w5m_rank,
        recent_imbalance_rank=cross_section_recent_imbalance_rank,
    )
    isolated_same_day_leadership_confirmed = _isolated_same_day_leadership_confirmed(
        params=params,
        session_open_rank=cross_section_session_open_rank,
        opening_window_return_rank=cross_section_opening_window_return_rank,
        continuation_rank=effective_continuation_rank,
        microprice_bias_bps=recent_microprice_bias_bps_avg,
        price_vs_opening_window_close_bps=price_vs_opening_window_close_bps,
        recent_above_opening_window_close_ratio=recent_above_opening_window_close_ratio,
    )
    isolated_strength_confirmed = (
        isolated_flow_strength_confirmed
        or isolated_same_day_leadership_confirmed
    )
    leader_reclaim_confirmed = _leader_reclaim_confirmed(
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
    effective_bullish_hist_min = _decimal_param(params, 'bullish_hist_min', Decimal('0.008'))
    if leader_reclaim_confirmed:
        effective_bullish_hist_min -= (
            _optional_decimal_param(
                params,
                'leader_reclaim_bullish_hist_relaxation',
                Decimal('0.053'),
            )
            or Decimal('0')
        )
    effective_min_bull_rsi = _relax_floor_for_isolated_strength(
        floor=_decimal_param(params, 'min_bull_rsi', Decimal('58')),
        isolated_strength_confirmed=leader_reclaim_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'leader_reclaim_min_bull_rsi_relaxation',
            Decimal('4'),
        ),
    )
    effective_max_bull_rsi = _widen_cap_for_isolated_strength(
        cap=_decimal_param(params, 'max_bull_rsi', Decimal('72')),
        isolated_strength_confirmed=leader_reclaim_confirmed,
        extension=_optional_decimal_param(
            params,
            'leader_reclaim_max_bull_rsi_extension',
            Decimal('6'),
        ),
    )
    effective_vol_ceil = _widen_cap_for_isolated_strength(
        cap=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00040')),
        isolated_strength_confirmed=leader_reclaim_confirmed,
        extension=_optional_decimal_param(
            params,
            'leader_reclaim_vol_ceil_extension',
            Decimal('0.00030'),
        ),
    )
    effective_min_imbalance_pressure = _relax_floor_for_isolated_strength(
        floor=min_imbalance_pressure,
        isolated_strength_confirmed=leader_reclaim_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'leader_reclaim_imbalance_relaxation',
            Decimal('0.22'),
        ),
    )
    if effective_min_bull_rsi is None:
        effective_min_bull_rsi = Decimal('58')
    if effective_max_bull_rsi is None:
        effective_max_bull_rsi = Decimal('72')
    if effective_min_imbalance_pressure is None:
        effective_min_imbalance_pressure = Decimal('0')
    min_session_open_drive_bps = _relax_floor_for_isolated_strength(
        floor=min_session_open_drive_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_session_open_drive_relaxation_bps',
            Decimal('8'),
        ),
    )
    min_opening_window_return_bps = _relax_floor_for_isolated_strength(
        floor=min_opening_window_return_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_opening_window_return_relaxation_bps',
            Decimal('6'),
        ),
    )
    min_session_open_return_efficiency = _relax_floor_for_isolated_strength(
        floor=min_session_open_return_efficiency,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_session_open_return_efficiency_relaxation',
            Decimal('0.10'),
        ),
    )
    min_cross_section_positive_session_open_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_session_open_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_session_open_ratio_relaxation',
            Decimal('0.12'),
        ),
    )
    min_cross_section_positive_session_open_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_session_open_ratio,
        isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_same_day_session_open_ratio_relaxation',
            Decimal('0.25'),
        ),
    )
    min_cross_section_positive_opening_window_return_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_opening_window_return_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_opening_window_ratio_relaxation',
            Decimal('0.15'),
        ),
    )
    min_cross_section_positive_opening_window_return_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_opening_window_return_ratio,
        isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_same_day_opening_window_ratio_relaxation',
            Decimal('0.25'),
        ),
    )
    min_cross_section_above_vwap_w5m_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_above_vwap_w5m_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_above_vwap_ratio_relaxation',
            Decimal('0.15'),
        ),
    )
    min_cross_section_above_vwap_w5m_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_above_vwap_w5m_ratio,
        isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_same_day_above_vwap_ratio_relaxation',
            Decimal('0.20'),
        ),
    )
    min_cross_section_continuation_breadth = _relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_breadth,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_continuation_breadth_relaxation',
            Decimal('0.15'),
        ),
    )
    min_cross_section_continuation_breadth = _relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_breadth,
        isolated_strength_confirmed=isolated_same_day_leadership_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_same_day_continuation_breadth_relaxation',
            Decimal('0.30'),
        ),
    )
    max_recent_spread_bps = _widen_cap_for_isolated_strength(
        cap=max_recent_spread_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_recent_spread_bps_extension',
            Decimal('4'),
        ),
    )
    max_recent_spread_bps_max = _widen_cap_for_isolated_strength(
        cap=max_recent_spread_bps_max,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_recent_spread_bps_max_extension',
            Decimal('18'),
        ),
    )
    max_recent_quote_invalid_ratio = _widen_cap_for_isolated_strength(
        cap=max_recent_quote_invalid_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_recent_quote_invalid_ratio_extension',
            Decimal('0.10'),
        ),
    )
    min_recent_microprice_bias_bps = _relax_floor_for_isolated_strength(
        floor=min_recent_microprice_bias_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_microprice_bias_relaxation_bps',
            Decimal('0.15'),
        ),
    )
    min_recent_above_opening_range_high_ratio = _relax_floor_for_isolated_strength(
        floor=min_recent_above_opening_range_high_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_above_orh_ratio_relaxation',
            Decimal('0.20'),
        ),
    )
    min_recent_above_opening_window_close_ratio = _relax_floor_for_isolated_strength(
        floor=min_recent_above_opening_window_close_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_above_open_close_ratio_relaxation',
            Decimal('0.15'),
        ),
    )
    min_recent_above_vwap_w5m_ratio = _relax_floor_for_isolated_strength(
        floor=min_recent_above_vwap_w5m_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_above_vwap_ratio_relaxation',
            Decimal('0.15'),
        ),
    )
    min_session_high_above_opening_range_high_bps = _relax_floor_for_isolated_strength(
        floor=min_session_high_above_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_session_high_above_orh_relaxation_bps',
            Decimal('4'),
        ),
    )
    min_price_vs_opening_range_high_bps = _relax_floor_for_isolated_strength(
        floor=min_price_vs_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_orh_relaxation_bps',
            Decimal('12'),
        ),
    )
    min_price_vs_opening_window_close_bps = _relax_floor_for_isolated_strength(
        floor=min_price_vs_opening_window_close_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_open_close_min_relaxation_bps',
            Decimal('4'),
        ),
    )
    max_price_vs_opening_range_high_bps = _widen_cap_for_isolated_strength(
        cap=max_price_vs_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_orh_cap_extension_bps',
            Decimal('8'),
        ),
    )
    max_price_vs_opening_window_close_bps = _widen_cap_for_isolated_strength(
        cap=max_price_vs_opening_window_close_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_open_close_cap_extension_bps',
            Decimal('14'),
        ),
    )

    classical_breakout_shape_passes = (
        _optional_min_threshold(session_high_vs_opening_range_high_bps, min_session_high_above_opening_range_high_bps)
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
    )
    isolated_continuation_shape_passes = _isolated_leader_continuation_shape_passes(
        params=params,
        isolated_strength_confirmed=isolated_strength_confirmed,
        price_position_in_session_range=price_position_in_session_range,
        price_vs_opening_range_high_bps=price_vs_opening_range_high_bps,
        opening_range_width_bps=opening_range_width_bps,
        session_range_bps=session_range_bps,
    )
    recent_breakout_reference_hold_passes = _recent_reference_hold_passes(
        recent_above_opening_range_high_ratio=recent_above_opening_range_high_ratio,
        min_recent_above_opening_range_high_ratio=min_recent_above_opening_range_high_ratio,
        recent_above_opening_window_close_ratio=recent_above_opening_window_close_ratio,
        min_recent_above_opening_window_close_ratio=min_recent_above_opening_window_close_ratio,
    )
    buy_gates = (
        _gate(
            name='structure',
            category='structure',
            thresholds=(
                _threshold_bool(metric='ema12_gt_ema26', passed=ema12 > ema26, threshold=True),
                _threshold_min(
                    metric='macd_hist',
                    value=macd_hist,
                    floor=effective_bullish_hist_min,
                    required=True,
                ),
                *_threshold_range(
                    metric='rsi14',
                    value=rsi14,
                    floor=effective_min_bull_rsi,
                    ceil=effective_max_bull_rsi,
                    required=True,
                ),
                _threshold_min(
                    metric='price_vs_ema12_bps',
                    value=price_vs_ema12_bps,
                    floor=_decimal_param(params, 'min_price_above_ema12_bps', Decimal('0')),
                    required=False,
                ),
                _threshold_max(
                    metric='price_vs_ema12_bps',
                    value=price_vs_ema12_bps,
                    ceil=ema_extension_cap_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='price_vs_vwap_w5m_bps',
                    value=price_vs_vwap_w5m_bps,
                    floor=min_price_vs_vwap_w5m_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='price_vs_vwap_w5m_bps',
                    value=price_vs_vwap_w5m_bps,
                    ceil=vwap_w5m_extension_cap_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_price_drive_bps',
                    value=effective_price_drive_bps,
                    floor=min_session_open_drive_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_opening_window_return_bps',
                    value=effective_opening_window_return_bps,
                    floor=min_opening_window_return_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='session_open_return_efficiency',
                    value=session_open_return_efficiency,
                    floor=min_session_open_return_efficiency,
                    required=False,
                ),
                _threshold_bool(
                    metric='shape_passes',
                    passed=classical_breakout_shape_passes or isolated_continuation_shape_passes,
                    threshold=True,
                ),
                *_threshold_range(
                    metric='vol_realized_w60s',
                    value=vol_realized_w60s,
                    floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00004')),
                    ceil=effective_vol_ceil,
                    required=False,
                ),
            ),
        ),
        _gate(
            name='feed_quality',
            category='feed_quality',
            thresholds=(
                _threshold_max(
                    metric='spread_bps',
                    value=effective_spread_bps,
                    ceil=spread_cap_bps,
                    required=True,
                ),
                _threshold_max(
                    metric='recent_spread_bps_avg',
                    value=recent_spread_bps_avg,
                    ceil=max_recent_spread_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_spread_bps_max',
                    value=recent_spread_bps_max,
                    ceil=max_recent_spread_bps_max,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio_hard',
                    value=recent_quote_invalid_ratio,
                    ceil=hard_max_recent_quote_invalid_ratio,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio',
                    value=recent_quote_invalid_ratio,
                    ceil=max_recent_quote_invalid_ratio,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_jump_bps_max',
                    value=recent_quote_jump_bps_max,
                    ceil=max_recent_quote_jump_bps,
                    required=False,
                ),
            ),
        ),
        _gate(
            name='confirmation',
            category='confirmation',
            thresholds=(
                _threshold_min(
                    metric='imbalance_pressure',
                    value=imbalance_pressure,
                    floor=effective_min_imbalance_pressure,
                    required=True,
                ),
                _threshold_min(
                    metric='recent_imbalance_pressure_avg',
                    value=recent_imbalance_pressure_avg,
                    floor=min_recent_imbalance_pressure,
                    required=False,
                ),
                _threshold_min(
                    metric='recent_microprice_bias_bps_avg',
                    value=recent_microprice_bias_bps_avg,
                    floor=min_recent_microprice_bias_bps,
                    required=False,
                ),
                _threshold_bool(
                    metric='recent_breakout_reference_hold_passes',
                    passed=recent_breakout_reference_hold_passes,
                    threshold=True,
                ),
                _threshold_min(
                    metric='recent_above_vwap_w5m_ratio',
                    value=recent_above_vwap_w5m_ratio,
                    floor=min_recent_above_vwap_w5m_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_continuation_rank',
                    value=effective_continuation_rank,
                    floor=min_cross_section_continuation_rank,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_opening_window_return_rank',
                    value=effective_opening_window_return_rank,
                    floor=min_cross_section_opening_window_return_rank,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_positive_session_open_ratio',
                    value=effective_positive_session_open_ratio,
                    floor=min_cross_section_positive_session_open_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_positive_opening_window_return_ratio',
                    value=effective_positive_opening_window_return_ratio,
                    floor=min_cross_section_positive_opening_window_return_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_above_vwap_w5m_ratio',
                    value=cross_section_above_vwap_w5m_ratio,
                    floor=min_cross_section_above_vwap_w5m_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_continuation_breadth',
                    value=cross_section_continuation_breadth,
                    floor=min_cross_section_continuation_breadth,
                    required=False,
                ),
                _threshold_bool(
                    metric='early_breakout_quality_passes',
                    passed=_early_breakout_quality_passes(
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

    if all(gate.passed for gate in buy_gates):
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
            effective_continuation_rank is not None
            and effective_continuation_rank >= Decimal('0.85')
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
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='buy',
                confidence=min(confidence, Decimal('0.86')),
                rationale=(
                    'breakout_continuation_long',
                    'trend_up',
                    'session_drive_confirmed',
                    'opening_range_breakout',
                    'above_vwap',
                    'leader_reclaim_confirmed' if leader_reclaim_confirmed else 'imbalance_confirmed',
                ),
                notional_multiplier=_resolve_entry_notional_multiplier(
                    params=params,
                    confidence=min(confidence, Decimal('0.86')),
                    rank=effective_continuation_rank,
                    spread_bps=effective_spread_bps,
                    spread_cap_bps=spread_cap_bps,
                ),
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    exit_macd_hist_max = _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.003'))
    exit_rsi_max = _decimal_param(params, 'exit_rsi_max', Decimal('56'))
    exit_price_below_opening_range_high_bps = _relax_floor_for_isolated_strength(
        floor=_decimal_param(params, 'exit_price_below_opening_range_high_bps', Decimal('-6')),
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_orh_relaxation_bps',
            Decimal('12'),
        ),
    )
    momentum_rollover_failure_confirmed = (
        macd_hist <= exit_macd_hist_max
        and rsi14 <= exit_rsi_max
        and price < ema12
        and (
            (
                price_vs_opening_range_high_bps is not None
                and price_vs_opening_range_high_bps
                <= _decimal_param(
                    params,
                    'exit_momentum_rollover_price_vs_opening_range_high_bps',
                    Decimal('0'),
                )
            )
            or (
                price_vs_vwap_w5m_bps is not None
                and price_vs_vwap_w5m_bps
                <= _decimal_param(params, 'exit_momentum_rollover_vwap_bps', Decimal('0'))
                and price_position_in_session_range is not None
                and price_position_in_session_range
                <= _decimal_param(
                    params,
                    'exit_momentum_rollover_session_range_position_max',
                    Decimal('0.80'),
                )
            )
        )
    )
    vwap_breakout_failure_confirmed = (
        price_vs_vwap_w5m_bps is not None
        and price_vs_vwap_w5m_bps
        <= _decimal_param(params, 'exit_price_vs_vwap_w5m_bps', Decimal('-10'))
        and (
            (
                price_vs_opening_range_high_bps is not None
                and price_vs_opening_range_high_bps
                <= _decimal_param(
                    params,
                    'exit_breakout_failure_price_vs_opening_range_high_bps',
                    Decimal('0'),
                )
            )
            or (
                price_position_in_session_range is not None
                and price_position_in_session_range
                <= _decimal_param(
                    params,
                    'exit_breakout_failure_session_range_position_min',
                    _decimal_param(params, 'exit_session_range_position_min', Decimal('0.48')),
                )
            )
        )
    )
    breakout_failure_confirmed = (
        vwap_breakout_failure_confirmed
        or (
            price_position_in_session_range is not None
            and price_position_in_session_range <= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.48'))
        )
        or (
            price_vs_session_open_bps is not None
            and price_vs_session_open_bps <= _decimal_param(params, 'exit_session_open_drive_bps', Decimal('18'))
        )
        or momentum_rollover_failure_confirmed
    )
    session_strength_reversal_confirmed = (
        recent_imbalance_pressure_avg is not None
        and recent_imbalance_pressure_avg
        <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.03'))
        and (
            (
                price_vs_opening_range_high_bps is not None
                and price_vs_opening_range_high_bps
                <= _decimal_param(
                    params,
                    'exit_session_strength_reversal_price_vs_opening_range_high_bps',
                    Decimal('0'),
                )
            )
            or (
                price_vs_vwap_w5m_bps is not None
                and price_vs_vwap_w5m_bps
                <= _decimal_param(params, 'exit_session_strength_reversal_vwap_bps', Decimal('0'))
                and price_position_in_session_range is not None
                and price_position_in_session_range
                <= _decimal_param(
                    params,
                    'exit_session_strength_reversal_session_range_position_max',
                    Decimal('0.80'),
                )
            )
        )
    )
    exit_gate = _gate(
        name='exit',
        category='exit',
        thresholds=(
            _threshold_bool(metric='breakout_failure_confirmed', passed=breakout_failure_confirmed, threshold=True),
            _threshold_bool(
                metric='session_strength_reversal_confirmed',
                passed=session_strength_reversal_confirmed,
                threshold=False,
                value=session_strength_reversal_confirmed,
            ),
        ),
    )
    if breakout_failure_confirmed:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='sell',
                confidence=Decimal('0.62'),
                rationale=(
                    'breakout_continuation_exit',
                    'breakout_failed',
                ),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    price_below_opening_range_high = (
        price_vs_opening_range_high_bps is not None
        and _optional_max_threshold(
            price_vs_opening_range_high_bps,
            exit_price_below_opening_range_high_bps,
        )
    )
    if price_below_opening_range_high or session_strength_reversal_confirmed:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='sell',
                confidence=Decimal('0.63'),
                rationale=(
                    'breakout_continuation_exit',
                    'session_strength_reversal',
                ),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    return _sleeve_result(
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


def evaluate_mean_reversion_rebound_long(
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
) -> SleeveSignalResult:
    trace_context = {'family': 'mean_reversion_rebound_long'}
    required_fields = {
        'price': price is not None,
        'ema12': ema12 is not None,
        'macd': macd is not None,
        'macd_signal': macd_signal is not None,
        'rsi14': rsi14 is not None,
    }
    if not all(required_fields.values()):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(_required_inputs_gate(fields=required_fields),),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    ts = _parse_event_ts(event_ts)
    entry_start_minute = _minute_param(params, 'entry_start_minute_utc', 14 * 60)
    entry_end_minute = _effective_entry_end_minute(
        params,
        default_end_minute=18 * 60 + 45,
    )
    within_window = _within_utc_window(
        ts,
        start_minute=entry_start_minute,
        end_minute=entry_end_minute,
    )
    if not within_window:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _entry_window_gate(
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
    price_vs_ema12_bps = _bps_delta(price, ema12)
    price_vs_vwap_bps = _bps_delta(price, vwap_session) if vwap_session is not None else price_vs_ema12_bps
    effective_spread_bps = _nonnegative_decimal(spread_bps)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    effective_price_drive_bps = _select_reference_decimal(
        params=params,
        key='drive_reference_basis',
        default_basis='prev_close',
        session_open_value=price_vs_session_open_bps,
        prev_close_value=price_vs_prev_session_close_bps,
    )
    effective_opening_window_return_bps = _select_reference_decimal(
        params=params,
        key='opening_window_reference_basis',
        default_basis='prev_close',
        session_open_value=opening_window_return_bps,
        prev_close_value=opening_window_return_from_prev_close_bps,
    )
    effective_opening_window_return_rank = _select_reference_decimal(
        params=params,
        key='opening_window_rank_reference_basis',
        default_basis='prev_close',
        session_open_value=cross_section_opening_window_return_rank,
        prev_close_value=cross_section_opening_window_return_from_prev_close_rank,
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
    price_below_vwap_bps = -price_vs_vwap_bps if price_vs_vwap_bps is not None else None
    price_below_ema12_bps = -price_vs_ema12_bps if price_vs_ema12_bps is not None else None
    buy_gates = (
        _gate(
            name='structure',
            category='structure',
            thresholds=(
                *_threshold_range(
                    metric='price_below_vwap_bps',
                    value=price_below_vwap_bps,
                    floor=_decimal_param(params, 'min_price_below_vwap_bps', Decimal('8')),
                    ceil=_decimal_param(params, 'max_price_below_vwap_bps', Decimal('70')),
                    required=True,
                ),
                *_threshold_range(
                    metric='price_below_ema12_bps',
                    value=price_below_ema12_bps,
                    floor=_decimal_param(params, 'min_price_below_ema12_bps', Decimal('2')),
                    ceil=_decimal_param(params, 'max_price_below_ema12_bps', Decimal('35')),
                    required=True,
                ),
                *_threshold_range(
                    metric='rsi14',
                    value=rsi14,
                    floor=_decimal_param(params, 'min_bull_rsi', Decimal('40')),
                    ceil=_decimal_param(params, 'max_bull_rsi', Decimal('52')),
                    required=True,
                ),
                *_threshold_range(
                    metric='macd_hist',
                    value=macd_hist,
                    floor=_decimal_param(params, 'bullish_hist_min', Decimal('0.002')),
                    ceil=_decimal_param(params, 'bullish_hist_cap', Decimal('0.05')),
                    required=True,
                ),
                _threshold_max(
                    metric='effective_price_drive_bps',
                    value=effective_price_drive_bps,
                    ceil=max_session_open_drive_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='effective_opening_window_return_bps',
                    value=effective_opening_window_return_bps,
                    ceil=max_opening_window_return_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='price_position_in_session_range',
                    value=price_position_in_session_range,
                    ceil=max_session_range_position,
                    required=False,
                ),
                _threshold_min(
                    metric='session_range_bps',
                    value=session_range_bps,
                    floor=min_session_range_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='price_vs_opening_range_low_bps',
                    value=price_vs_opening_range_low_bps,
                    floor=min_price_vs_opening_range_low_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='price_vs_opening_range_low_bps',
                    value=price_vs_opening_range_low_bps,
                    ceil=max_price_vs_opening_range_low_bps,
                    required=False,
                ),
            ),
        ),
        _gate(
            name='feed_quality',
            category='feed_quality',
            thresholds=(
                _threshold_max(
                    metric='spread_bps',
                    value=effective_spread_bps,
                    ceil=spread_cap_bps,
                    required=True,
                ),
                _threshold_max(
                    metric='recent_spread_bps_avg',
                    value=recent_spread_bps_avg,
                    ceil=max_recent_spread_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_spread_bps_max',
                    value=recent_spread_bps_max,
                    ceil=max_recent_spread_bps_max,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio',
                    value=recent_quote_invalid_ratio,
                    ceil=max_recent_quote_invalid_ratio,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_jump_bps_max',
                    value=recent_quote_jump_bps_max,
                    ceil=max_recent_quote_jump_bps,
                    required=False,
                ),
                *_threshold_range(
                    metric='vol_realized_w60s',
                    value=vol_realized_w60s,
                    floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
                    ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00055')),
                    required=False,
                ),
            ),
        ),
        _gate(
            name='confirmation',
            category='confirmation',
            thresholds=(
                _threshold_min(
                    metric='imbalance_pressure',
                    value=imbalance_pressure,
                    floor=_decimal_param(params, 'min_imbalance_pressure', Decimal('0')),
                    required=True,
                ),
                _threshold_min(
                    metric='recent_imbalance_pressure_avg',
                    value=recent_imbalance_pressure_avg,
                    floor=min_recent_imbalance_pressure,
                    required=False,
                ),
                _threshold_min(
                    metric='recent_microprice_bias_bps_avg',
                    value=recent_microprice_bias_bps_avg,
                    floor=min_recent_microprice_bias_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='cross_section_continuation_rank',
                    value=cross_section_continuation_rank,
                    ceil=max_cross_section_continuation_rank,
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_reversal_rank',
                    value=cross_section_reversal_rank,
                    floor=min_cross_section_reversal_rank,
                    required=False,
                ),
                _threshold_max(
                    metric='effective_opening_window_return_rank',
                    value=effective_opening_window_return_rank,
                    ceil=max_cross_section_opening_window_return_rank,
                    required=False,
                ),
            ),
        ),
    )

    if all(gate.passed for gate in buy_gates):
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
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
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
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    exit_reasons: dict[str, bool] = {
        'vwap_recovery': (vwap_session is not None and price >= vwap_session)
        or (vwap_session is None and price >= ema12),
        'rsi_recovered': rsi14 >= _decimal_param(params, 'exit_rsi_min', Decimal('61')),
        'macd_rollover': macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.002')),
        'imbalance_reversal': (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg
            <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.02'))
        ),
        'range_recovery': (
            price_position_in_session_range is not None
            and price_position_in_session_range
            >= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.58'))
        ),
    }
    exit_gate = _exit_trigger_gate(reason_flags=exit_reasons)
    if exit_gate.passed:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='sell',
                confidence=Decimal('0.61'),
                rationale=(
                    'mean_reversion_rebound_exit',
                    'rebound_complete',
                ),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    return _sleeve_result(
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
    trace_context = {'family': 'washout_rebound_long'}
    required_fields = {
        'price': price is not None,
        'ema12': ema12 is not None,
        'macd': macd is not None,
        'macd_signal': macd_signal is not None,
        'rsi14': rsi14 is not None,
        'price_vs_session_low_bps': price_vs_session_low_bps is not None,
    }
    if not all(required_fields.values()):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(_required_inputs_gate(fields=required_fields),),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    ts = _parse_event_ts(event_ts)
    entry_start_minute = _minute_param(params, 'entry_start_minute_utc', 14 * 60 + 10)
    entry_end_minute = _effective_entry_end_minute(
        params,
        default_end_minute=17 * 60 + 30,
    )
    within_window = _within_utc_window(
        ts,
        start_minute=entry_start_minute,
        end_minute=entry_end_minute,
    )
    if not within_window:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _entry_window_gate(
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
    price_vs_ema12_bps = _bps_delta(price, ema12)
    price_vs_vwap_bps = _bps_delta(price, vwap_session) if vwap_session is not None else price_vs_ema12_bps
    effective_spread_bps = _nonnegative_decimal(spread_bps)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    effective_session_open_drive_bps = _prefer_primary_decimal(
        price_vs_session_open_bps,
        price_vs_prev_session_close_bps,
    )
    effective_opening_window_return_bps = _prefer_primary_decimal(
        opening_window_return_bps,
        opening_window_return_from_prev_close_bps,
    )
    effective_opening_window_return_rank = _prefer_primary_decimal(
        cross_section_opening_window_return_rank,
        cross_section_opening_window_return_from_prev_close_rank,
    )
    price_below_vwap_bps = -price_vs_vwap_bps if price_vs_vwap_bps is not None else None
    price_below_ema12_bps = -price_vs_ema12_bps if price_vs_ema12_bps is not None else None
    session_open_selloff_bps = (
        -effective_session_open_drive_bps if effective_session_open_drive_bps is not None else None
    )
    opening_window_selloff_bps = (
        -effective_opening_window_return_bps if effective_opening_window_return_bps is not None else None
    )
    max_session_open_selloff_bps = _decimal_param(params, 'max_session_open_selloff_bps', Decimal('120'))
    max_price_below_vwap_bps = _decimal_param(params, 'max_price_below_vwap_bps', Decimal('120'))
    if session_range_bps is not None:
        max_session_open_selloff_bps = max(
            max_session_open_selloff_bps,
            session_range_bps
            * _decimal_param(
                params,
                'max_session_open_selloff_range_multiplier',
                Decimal('3.5'),
            ),
        )
        max_price_below_vwap_bps = max(
            max_price_below_vwap_bps,
            session_range_bps
            * _decimal_param(
                params,
                'max_price_below_vwap_range_multiplier',
                Decimal('5.0'),
            ),
        )
    buy_gates = (
        _gate(
            name='structure',
            category='structure',
            thresholds=(
                *_threshold_range(
                    metric='session_open_selloff_bps',
                    value=session_open_selloff_bps,
                    floor=_decimal_param(params, 'min_session_open_selloff_bps', Decimal('20')),
                    ceil=max_session_open_selloff_bps,
                    required=True,
                ),
                _threshold_min(
                    metric='opening_window_selloff_bps',
                    value=opening_window_selloff_bps,
                    floor=_optional_decimal_param(
                        params,
                        'min_opening_window_selloff_bps',
                        None,
                    ),
                    required=False,
                ),
                *_threshold_range(
                    metric='price_below_vwap_bps',
                    value=price_below_vwap_bps,
                    floor=_decimal_param(params, 'min_price_below_vwap_bps', Decimal('8')),
                    ceil=max_price_below_vwap_bps,
                    required=True,
                ),
                *_threshold_range(
                    metric='price_below_ema12_bps',
                    value=price_below_ema12_bps,
                    floor=_decimal_param(params, 'min_price_below_ema12_bps', Decimal('1')),
                    ceil=_decimal_param(params, 'max_price_below_ema12_bps', Decimal('50')),
                    required=True,
                ),
                *_threshold_range(
                    metric='rsi14',
                    value=rsi14,
                    floor=_decimal_param(params, 'min_bull_rsi', Decimal('34')),
                    ceil=_decimal_param(params, 'max_bull_rsi', Decimal('50')),
                    required=True,
                ),
                *_threshold_range(
                    metric='macd_hist',
                    value=macd_hist,
                    floor=_decimal_param(params, 'rebound_hist_min', Decimal('-0.018')),
                    ceil=_decimal_param(params, 'rebound_hist_max', Decimal('0.010')),
                    required=True,
                ),
                _threshold_max(
                    metric='price_position_in_session_range',
                    value=price_position_in_session_range,
                    ceil=_optional_decimal_param(params, 'max_session_range_position', Decimal('0.45')),
                    required=False,
                ),
                _threshold_min(
                    metric='session_range_bps',
                    value=session_range_bps,
                    floor=_optional_decimal_param(params, 'min_session_range_bps', Decimal('35')),
                    required=False,
                ),
                *_threshold_range(
                    metric='price_vs_session_low_bps',
                    value=price_vs_session_low_bps,
                    floor=_decimal_param(params, 'min_price_vs_session_low_bps', Decimal('0')),
                    ceil=_decimal_param(params, 'max_price_vs_session_low_bps', Decimal('40')),
                    required=True,
                ),
                *_threshold_range(
                    metric='price_vs_opening_range_low_bps',
                    value=price_vs_opening_range_low_bps,
                    floor=_optional_decimal_param(
                        params,
                        'min_price_vs_opening_range_low_bps',
                        None,
                    ),
                    ceil=_optional_decimal_param(
                        params,
                        'max_price_vs_opening_range_low_bps',
                        None,
                    ),
                    required=False,
                ),
                _threshold_max(
                    metric='recent_above_vwap_w5m_ratio',
                    value=recent_above_vwap_w5m_ratio,
                    ceil=_optional_decimal_param(
                        params,
                        'max_recent_above_vwap_w5m_ratio',
                        None,
                    ),
                    required=False,
                ),
            ),
        ),
        _gate(
            name='feed_quality',
            category='feed_quality',
            thresholds=(
                _threshold_max(
                    metric='spread_bps',
                    value=effective_spread_bps,
                    ceil=_decimal_param(params, 'max_spread_bps', Decimal('20')),
                    required=True,
                ),
                _threshold_max(
                    metric='recent_spread_bps_avg',
                    value=recent_spread_bps_avg,
                    ceil=_optional_decimal_param(params, 'max_recent_spread_bps', Decimal('10')),
                    required=False,
                ),
                _threshold_max(
                    metric='recent_spread_bps_max',
                    value=recent_spread_bps_max,
                    ceil=_optional_decimal_param(params, 'max_recent_spread_bps_max', Decimal('30')),
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio',
                    value=recent_quote_invalid_ratio,
                    ceil=_optional_decimal_param(
                        params,
                        'max_recent_quote_invalid_ratio',
                        Decimal('0.15'),
                    ),
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_jump_bps_max',
                    value=recent_quote_jump_bps_max,
                    ceil=_optional_decimal_param(params, 'max_recent_quote_jump_bps', Decimal('55')),
                    required=False,
                ),
                *_threshold_range(
                    metric='vol_realized_w60s',
                    value=vol_realized_w60s,
                    floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
                    ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00075')),
                    required=False,
                ),
            ),
        ),
        _gate(
            name='confirmation',
            category='confirmation',
            thresholds=(
                _threshold_min(
                    metric='imbalance_pressure',
                    value=imbalance_pressure,
                    floor=_decimal_param(params, 'min_imbalance_pressure', Decimal('0')),
                    required=True,
                ),
                _threshold_min(
                    metric='recent_imbalance_pressure_avg',
                    value=recent_imbalance_pressure_avg,
                    floor=_optional_decimal_param(
                        params,
                        'min_recent_imbalance_pressure',
                        Decimal('0.02'),
                    ),
                    required=False,
                ),
                _threshold_min(
                    metric='recent_microprice_bias_bps_avg',
                    value=recent_microprice_bias_bps_avg,
                    floor=_optional_decimal_param(
                        params,
                        'min_recent_microprice_bias_bps',
                        Decimal('0.05'),
                    ),
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_reversal_rank',
                    value=cross_section_reversal_rank,
                    floor=_optional_decimal_param(
                        params,
                        'min_cross_section_reversal_rank',
                        Decimal('0.65'),
                    ),
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_recent_imbalance_rank',
                    value=cross_section_recent_imbalance_rank,
                    floor=_optional_decimal_param(
                        params,
                        'min_cross_section_recent_imbalance_rank',
                        Decimal('0.45'),
                    ),
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_positive_recent_imbalance_ratio',
                    value=cross_section_positive_recent_imbalance_ratio,
                    floor=_optional_decimal_param(
                        params,
                        'min_cross_section_positive_recent_imbalance_ratio',
                        Decimal('0.35'),
                    ),
                    required=False,
                ),
                _threshold_max(
                    metric='cross_section_continuation_rank',
                    value=cross_section_continuation_rank,
                    ceil=_optional_decimal_param(
                        params,
                        'max_cross_section_continuation_rank',
                        Decimal('0.80'),
                    ),
                    required=False,
                ),
                _threshold_max(
                    metric='effective_opening_window_return_rank',
                    value=effective_opening_window_return_rank,
                    ceil=_optional_decimal_param(
                        params,
                        'max_cross_section_opening_window_return_rank',
                        Decimal('0.80'),
                    ),
                    required=False,
                ),
            ),
        ),
    )

    if all(gate.passed for gate in buy_gates):
        confidence = Decimal('0.64')
        if session_open_selloff_bps is not None and session_open_selloff_bps >= Decimal('50'):
            confidence += Decimal('0.02')
        if Decimal('5') <= price_vs_session_low_bps <= Decimal('20'):
            confidence += Decimal('0.03')
        if recent_imbalance_pressure_avg is not None and recent_imbalance_pressure_avg >= Decimal('0.05'):
            confidence += Decimal('0.02')
        if recent_microprice_bias_bps_avg is not None and recent_microprice_bias_bps_avg >= Decimal('0.30'):
            confidence += Decimal('0.02')
        if (
            cross_section_reversal_rank is not None
            and cross_section_reversal_rank >= Decimal('0.85')
        ):
            confidence += Decimal('0.02')
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='buy',
                confidence=min(confidence, Decimal('0.82')),
                rationale=(
                    'washout_rebound_long',
                    'activity_gated',
                    'bid_recovery',
                    'off_session_low',
                    'spread_normalized',
                ),
                notional_multiplier=_resolve_entry_notional_multiplier(
                    params=params,
                    confidence=min(confidence, Decimal('0.82')),
                    rank=cross_section_reversal_rank,
                    spread_bps=effective_spread_bps,
                    spread_cap_bps=_decimal_param(params, 'max_spread_bps', Decimal('20')),
                ),
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    vwap_recovered = (vwap_session is not None and price >= vwap_session) or price >= ema12
    session_open_recovered = (
        price_vs_session_open_bps is not None
        and price_vs_session_open_bps
        >= _decimal_param(params, 'exit_price_vs_session_open_bps', Decimal('-4'))
    )
    rsi_recovered = rsi14 >= _decimal_param(params, 'exit_rsi_min', Decimal('56'))
    macd_rollover = macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.004'))
    range_recovery = (
        price_position_in_session_range is not None
        and price_position_in_session_range
        >= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.58'))
    )
    recovered_enough_to_exit = (vwap_recovered or session_open_recovered) and (
        rsi_recovered or range_recovery
    )
    flow_stall_after_recovery = (
        recent_imbalance_pressure_avg is not None
        and recent_imbalance_pressure_avg
        <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.02'))
        and price_position_in_session_range is not None
        and price_position_in_session_range
        >= _decimal_param(
            params,
            'exit_flow_stall_session_range_position_min',
            Decimal('0.35'),
        )
    )
    macd_rollover_after_recovery = macd_rollover and (
        recovered_enough_to_exit
        or (
            price_position_in_session_range is not None
            and price_position_in_session_range
            >= _decimal_param(
                params,
                'exit_flow_stall_session_range_position_min',
                Decimal('0.35'),
            )
        )
    )
    exit_reasons: dict[str, bool] = {
        'rebound_complete': recovered_enough_to_exit,
        'macd_rollover_after_recovery': macd_rollover_after_recovery,
        'flow_stall_after_recovery': flow_stall_after_recovery,
    }
    exit_gate = _exit_trigger_gate(reason_flags=exit_reasons)
    if exit_gate.passed:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='sell',
                confidence=Decimal('0.61'),
                rationale=(
                    'washout_rebound_exit',
                    'rebound_complete',
                ),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    return _sleeve_result(
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
    trace_context = {'family': 'late_day_continuation_long'}
    required_fields = {
        'price': price is not None,
        'ema12': ema12 is not None,
        'ema26': ema26 is not None,
        'macd': macd is not None,
        'macd_signal': macd_signal is not None,
        'rsi14': rsi14 is not None,
    }
    if not all(required_fields.values()):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(_required_inputs_gate(fields=required_fields),),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    ts = _parse_event_ts(event_ts)
    entry_start_minute = _minute_param(params, 'entry_start_minute_utc', 18 * 60 + 15)
    entry_end_minute = _effective_entry_end_minute(
        params,
        default_end_minute=19 * 60 + 20,
    )
    within_window = _within_utc_window(
        ts,
        start_minute=entry_start_minute,
        end_minute=entry_end_minute,
    )
    if not within_window:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _entry_window_gate(
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
    effective_continuation_rank = _resolve_live_continuation_rank(
        event_ts=event_ts,
        cross_section_session_open_rank=cross_section_session_open_rank,
        cross_section_prev_session_close_rank=cross_section_prev_session_close_rank,
        cross_section_opening_window_return_rank=cross_section_opening_window_return_rank,
        cross_section_opening_window_return_from_prev_close_rank=(
            cross_section_opening_window_return_from_prev_close_rank
        ),
        cross_section_range_position_rank=cross_section_range_position_rank,
        cross_section_vwap_w5m_rank=cross_section_vwap_w5m_rank,
        cross_section_recent_imbalance_rank=cross_section_recent_imbalance_rank,
        fallback_rank=cross_section_continuation_rank,
    )
    session_high_vs_opening_range_high_bps = _bps_delta(
        session_high_price,
        opening_range_high,
    )
    min_session_open_drive_bps = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_session_open_drive_bps',
            Decimal('35'),
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_session_open_drive_bps',
            None,
        ),
    )
    min_opening_window_return_bps = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_opening_window_return_bps',
            Decimal('18'),
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_opening_window_return_bps',
            None,
        ),
    )
    min_session_range_position = _optional_decimal_param(
        params,
        'min_session_range_position',
        Decimal('0.74'),
    )
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
    hard_max_recent_quote_invalid_ratio = _optional_decimal_param(
        params,
        'hard_max_recent_quote_invalid_ratio',
        Decimal('0.12'),
    )
    min_recent_microprice_bias_bps = _optional_decimal_param(
        params,
        'min_recent_microprice_bias_bps',
        Decimal('0.50'),
    )
    min_recent_above_opening_range_high_ratio = _optional_decimal_param(
        params,
        'min_recent_above_opening_range_high_ratio',
        None,
    )
    min_recent_above_opening_window_close_ratio = _optional_decimal_param(
        params,
        'min_recent_above_opening_window_close_ratio',
        None,
    )
    min_recent_above_vwap_w5m_ratio = _optional_decimal_param(
        params,
        'min_recent_above_vwap_w5m_ratio',
        None,
    )
    spread_cap_bps = _decimal_param(params, 'max_spread_bps', Decimal('6'))
    min_cross_section_continuation_rank = _optional_decimal_param(
        params,
        'min_cross_section_continuation_rank',
        None,
    )
    min_cross_section_opening_window_return_rank = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_cross_section_opening_window_return_rank',
            None,
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_cross_section_opening_window_return_rank',
            None,
        ),
    )
    min_cross_section_positive_session_open_ratio = _optional_decimal_param(
        params,
        'min_cross_section_positive_session_open_ratio',
        None,
    )
    min_cross_section_positive_opening_window_return_ratio = _decayed_minimum(
        event_ts=event_ts,
        early_floor=_optional_decimal_param(
            params,
            'min_cross_section_positive_opening_window_return_ratio',
            None,
        ),
        late_floor=_optional_decimal_param(
            params,
            'late_session_min_cross_section_positive_opening_window_return_ratio',
            None,
        ),
    )
    min_same_day_opening_window_return_bps = _optional_decimal_param(
        params,
        'min_same_day_opening_window_return_bps',
        Decimal('5'),
    )
    min_same_day_positive_opening_window_return_ratio = _optional_decimal_param(
        params,
        'min_same_day_positive_opening_window_return_ratio',
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
    opening_drive_late_day_session_open_drive_bps = _optional_decimal_param(
        params,
        'opening_drive_late_day_session_open_drive_bps',
        Decimal('45'),
    )
    opening_drive_late_day_opening_window_return_bps = _optional_decimal_param(
        params,
        'opening_drive_late_day_opening_window_return_bps',
        Decimal('25'),
    )
    opening_drive_late_day_price_vs_opening_window_close_bps = _optional_decimal_param(
        params,
        'opening_drive_late_day_price_vs_opening_window_close_bps',
        Decimal('2'),
    )
    opening_drive_late_day_session_range_position = _optional_decimal_param(
        params,
        'opening_drive_late_day_session_range_position',
        Decimal('0.70'),
    )
    opening_drive_late_day_recent_above_opening_window_close_ratio = _optional_decimal_param(
        params,
        'opening_drive_late_day_recent_above_opening_window_close_ratio',
        Decimal('0.78'),
    )
    opening_drive_late_day_recent_above_vwap_w5m_ratio = _optional_decimal_param(
        params,
        'opening_drive_late_day_recent_above_vwap_w5m_ratio',
        Decimal('0.68'),
    )
    isolated_strength_confirmed = _isolated_breakout_strength_confirmed(
        params=params,
        range_position_rank=cross_section_range_position_rank,
        vwap_w5m_rank=cross_section_vwap_w5m_rank,
        recent_imbalance_rank=cross_section_recent_imbalance_rank,
    )
    min_session_open_drive_bps = _relax_floor_for_isolated_strength(
        floor=min_session_open_drive_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_session_open_drive_relaxation_bps',
            Decimal('10'),
        ),
    )
    min_opening_window_return_bps = _relax_floor_for_isolated_strength(
        floor=min_opening_window_return_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_opening_window_return_relaxation_bps',
            Decimal('8'),
        ),
    )
    max_recent_spread_bps = _widen_cap_for_isolated_strength(
        cap=max_recent_spread_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_recent_spread_bps_extension',
            Decimal('4'),
        ),
    )
    max_recent_quote_invalid_ratio = _widen_cap_for_isolated_strength(
        cap=max_recent_quote_invalid_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_recent_quote_invalid_ratio_extension',
            Decimal('0.10'),
        ),
    )
    min_recent_microprice_bias_bps = _relax_floor_for_isolated_strength(
        floor=min_recent_microprice_bias_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_microprice_bias_relaxation_bps',
            Decimal('0.15'),
        ),
    )
    min_recent_above_opening_range_high_ratio = _relax_floor_for_isolated_strength(
        floor=min_recent_above_opening_range_high_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_above_orh_ratio_relaxation',
            Decimal('0.20'),
        ),
    )
    min_recent_above_opening_window_close_ratio = _relax_floor_for_isolated_strength(
        floor=min_recent_above_opening_window_close_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_above_open_close_ratio_relaxation',
            Decimal('0.15'),
        ),
    )
    min_recent_above_vwap_w5m_ratio = _relax_floor_for_isolated_strength(
        floor=min_recent_above_vwap_w5m_ratio,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_recent_above_vwap_ratio_relaxation',
            Decimal('0.15'),
        ),
    )
    min_session_high_above_opening_range_high_bps = _relax_floor_for_isolated_strength(
        floor=min_session_high_above_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_session_high_above_orh_relaxation_bps',
            Decimal('4'),
        ),
    )
    min_price_vs_opening_range_high_bps = _relax_floor_for_isolated_strength(
        floor=min_price_vs_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_orh_relaxation_bps',
            Decimal('12'),
        ),
    )
    min_price_vs_opening_window_close_bps = _relax_floor_for_isolated_strength(
        floor=min_price_vs_opening_window_close_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_open_close_min_relaxation_bps',
            Decimal('4'),
        ),
    )
    max_price_vs_opening_range_high_bps = _widen_cap_for_isolated_strength(
        cap=max_price_vs_opening_range_high_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_orh_cap_extension_bps',
            Decimal('8'),
        ),
    )
    max_price_vs_opening_window_close_bps = _widen_cap_for_isolated_strength(
        cap=max_price_vs_opening_window_close_bps,
        isolated_strength_confirmed=isolated_strength_confirmed,
        extension=_optional_decimal_param(
            params,
            'isolated_flow_price_vs_open_close_cap_extension_bps',
            Decimal('14'),
        ),
    )
    opening_drive_late_day_confirmed = (
        _required_min_threshold(
            effective_price_drive_bps,
            opening_drive_late_day_session_open_drive_bps,
        )
        and _required_min_threshold(
            effective_opening_window_return_bps,
            opening_drive_late_day_opening_window_return_bps,
        )
        and _required_min_threshold(
            price_vs_opening_window_close_bps,
            opening_drive_late_day_price_vs_opening_window_close_bps,
        )
        and _required_min_threshold(
            price_position_in_session_range,
            opening_drive_late_day_session_range_position,
        )
        and _required_min_threshold(
            recent_above_opening_window_close_ratio,
            opening_drive_late_day_recent_above_opening_window_close_ratio,
        )
        and _required_min_threshold(
            recent_above_vwap_w5m_ratio,
            opening_drive_late_day_recent_above_vwap_w5m_ratio,
        )
    )
    late_day_strength_confirmed = (
        isolated_strength_confirmed
        or opening_drive_late_day_confirmed
    )
    same_day_opening_window_confirmed = (
        _required_min_threshold(
            opening_window_return_bps,
            min_same_day_opening_window_return_bps,
        )
        and _required_min_threshold(
            cross_section_positive_opening_window_return_ratio,
            min_same_day_positive_opening_window_return_ratio,
        )
    )
    min_cross_section_continuation_rank = _relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_rank,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'opening_drive_late_day_continuation_rank_relaxation',
            Decimal('0.12'),
        ),
    )
    min_cross_section_opening_window_return_rank = _relax_floor_for_isolated_strength(
        floor=min_cross_section_opening_window_return_rank,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'opening_drive_late_day_opening_window_rank_relaxation',
            Decimal('0.12'),
        ),
    )
    min_cross_section_positive_session_open_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_session_open_ratio,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'opening_drive_late_day_positive_session_open_ratio_relaxation',
            Decimal('0.12'),
        ),
    )
    min_cross_section_positive_opening_window_return_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_positive_opening_window_return_ratio,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'opening_drive_late_day_positive_opening_window_ratio_relaxation',
            Decimal('0.15'),
        ),
    )
    min_cross_section_above_vwap_w5m_ratio = _relax_floor_for_isolated_strength(
        floor=min_cross_section_above_vwap_w5m_ratio,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'opening_drive_late_day_above_vwap_ratio_relaxation',
            Decimal('0.10'),
        ),
    )
    min_cross_section_continuation_breadth = _relax_floor_for_isolated_strength(
        floor=min_cross_section_continuation_breadth,
        isolated_strength_confirmed=late_day_strength_confirmed,
        relaxation=_optional_decimal_param(
            params,
            'opening_drive_late_day_continuation_breadth_relaxation',
            Decimal('0.12'),
        ),
    )

    classical_late_day_shape_passes = (
        _optional_min_threshold(price_position_in_session_range, min_session_range_position)
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
        and _optional_min_threshold(session_range_bps, min_session_range_bps)
    )
    isolated_late_day_shape_passes = _isolated_leader_continuation_shape_passes(
        params=params,
        isolated_strength_confirmed=isolated_strength_confirmed,
        price_position_in_session_range=price_position_in_session_range,
        price_vs_opening_range_high_bps=price_vs_opening_range_high_bps,
        opening_range_width_bps=None,
        session_range_bps=session_range_bps,
        min_session_range_position_key='isolated_flow_min_late_day_session_range_position',
        default_min_session_range_position=Decimal('0.88'),
        min_price_vs_opening_range_high_key='isolated_flow_min_late_day_price_vs_opening_range_high_bps',
        default_min_price_vs_opening_range_high_bps=Decimal('-24'),
        min_session_range_bps_key='isolated_flow_min_late_day_session_range_bps',
        default_min_session_range_bps=min_session_range_bps or Decimal('20'),
    ) and _optional_max_threshold(
        price_vs_opening_range_high_bps,
        _optional_decimal_param(
            params,
            'isolated_flow_max_late_day_price_vs_opening_range_high_bps',
            Decimal('30'),
        ),
    ) and _optional_max_threshold(
        price_vs_opening_window_close_bps,
        _optional_decimal_param(
            params,
            'isolated_flow_max_late_day_price_vs_opening_window_close_bps',
            Decimal('40'),
        ),
    )
    recent_late_day_reference_hold_passes = _recent_reference_hold_passes(
        recent_above_opening_range_high_ratio=recent_above_opening_range_high_ratio,
        min_recent_above_opening_range_high_ratio=min_recent_above_opening_range_high_ratio,
        recent_above_opening_window_close_ratio=recent_above_opening_window_close_ratio,
        min_recent_above_opening_window_close_ratio=min_recent_above_opening_window_close_ratio,
    )
    late_day_opening_window_close_hold_passes = _required_min_threshold(
        recent_above_opening_window_close_ratio,
        min_recent_above_opening_window_close_ratio,
    )
    opening_drive_late_day_shape_passes = (
        opening_drive_late_day_confirmed
        and _optional_min_threshold(session_range_bps, min_session_range_bps)
        and _optional_min_threshold(price_vs_vwap_w5m_bps, min_price_vs_vwap_w5m_bps)
        and _optional_max_threshold(price_vs_vwap_w5m_bps, max_price_vs_vwap_w5m_bps)
        and _optional_min_threshold(
            price_vs_opening_window_close_bps,
            min_price_vs_opening_window_close_bps,
        )
        and _optional_max_threshold(
            price_vs_opening_window_close_bps,
            max_price_vs_opening_window_close_bps,
        )
    )
    buy_gates = (
        _gate(
            name='structure',
            category='structure',
            thresholds=(
                _threshold_bool(metric='ema12_gt_ema26', passed=ema12 > ema26, threshold=True),
                *_threshold_range(
                    metric='macd_hist',
                    value=macd_hist,
                    floor=_decimal_param(params, 'bullish_hist_min', Decimal('0.006')),
                    ceil=_decimal_param(params, 'bullish_hist_cap', Decimal('0.05')),
                    required=True,
                ),
                *_threshold_range(
                    metric='rsi14',
                    value=rsi14,
                    floor=_decimal_param(params, 'min_bull_rsi', Decimal('57')),
                    ceil=_decimal_param(params, 'max_bull_rsi', Decimal('72')),
                    required=True,
                ),
                _threshold_min(
                    metric='price_vs_ema12_bps',
                    value=price_vs_ema12_bps,
                    floor=_decimal_param(params, 'min_price_above_ema12_bps', Decimal('0')),
                    required=True,
                ),
                _threshold_max(
                    metric='price_vs_ema12_bps',
                    value=price_vs_ema12_bps,
                    ceil=_decimal_param(params, 'max_price_above_ema12_bps', Decimal('14')),
                    required=True,
                ),
                _threshold_min(
                    metric='price_vs_vwap_w5m_bps',
                    value=price_vs_vwap_w5m_bps,
                    floor=min_price_vs_vwap_w5m_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='price_vs_vwap_w5m_bps',
                    value=price_vs_vwap_w5m_bps,
                    ceil=max_price_vs_vwap_w5m_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_price_drive_bps',
                    value=effective_price_drive_bps,
                    floor=min_session_open_drive_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_opening_window_return_bps',
                    value=effective_opening_window_return_bps,
                    floor=min_opening_window_return_bps,
                    required=False,
                ),
                _threshold_bool(
                    metric='same_day_opening_window_confirmed',
                    passed=same_day_opening_window_confirmed,
                    threshold=True,
                ),
                _threshold_bool(
                    metric='late_day_shape_passes',
                    passed=(
                        classical_late_day_shape_passes
                        or isolated_late_day_shape_passes
                        or opening_drive_late_day_shape_passes
                    ),
                    threshold=True,
                ),
                *_threshold_range(
                    metric='vol_realized_w60s',
                    value=vol_realized_w60s,
                    floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
                    ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00035')),
                    required=False,
                ),
            ),
        ),
        _gate(
            name='feed_quality',
            category='feed_quality',
            thresholds=(
                _threshold_max(
                    metric='spread_bps',
                    value=effective_spread_bps,
                    ceil=spread_cap_bps,
                    required=True,
                ),
                _threshold_min(
                    metric='imbalance_pressure',
                    value=imbalance_pressure,
                    floor=_decimal_param(params, 'min_imbalance_pressure', Decimal('-0.01')),
                    required=True,
                ),
                _threshold_max(
                    metric='recent_spread_bps_avg',
                    value=recent_spread_bps_avg,
                    ceil=max_recent_spread_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='recent_imbalance_pressure_avg',
                    value=recent_imbalance_pressure_avg,
                    floor=min_recent_imbalance_pressure,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio_hard',
                    value=recent_quote_invalid_ratio,
                    ceil=hard_max_recent_quote_invalid_ratio,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio',
                    value=recent_quote_invalid_ratio,
                    ceil=max_recent_quote_invalid_ratio,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_jump_bps_max',
                    value=recent_quote_jump_bps_max,
                    ceil=max_recent_quote_jump_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='recent_microprice_bias_bps_avg',
                    value=recent_microprice_bias_bps_avg,
                    floor=min_recent_microprice_bias_bps,
                    required=False,
                ),
            ),
        ),
        _gate(
            name='confirmation',
            category='confirmation',
            thresholds=(
                _threshold_bool(
                    metric='recent_late_day_reference_hold_passes',
                    passed=recent_late_day_reference_hold_passes,
                    threshold=True,
                ),
                _threshold_bool(
                    metric='late_day_opening_window_close_hold_passes',
                    passed=late_day_opening_window_close_hold_passes,
                    threshold=True,
                ),
                _threshold_min(
                    metric='recent_above_vwap_w5m_ratio',
                    value=recent_above_vwap_w5m_ratio,
                    floor=min_recent_above_vwap_w5m_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_continuation_rank',
                    value=effective_continuation_rank,
                    floor=min_cross_section_continuation_rank,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_opening_window_return_rank',
                    value=effective_opening_window_return_rank,
                    floor=min_cross_section_opening_window_return_rank,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_positive_session_open_ratio',
                    value=effective_positive_session_open_ratio,
                    floor=min_cross_section_positive_session_open_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='effective_positive_opening_window_return_ratio',
                    value=effective_positive_opening_window_return_ratio,
                    floor=min_cross_section_positive_opening_window_return_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_above_vwap_w5m_ratio',
                    value=cross_section_above_vwap_w5m_ratio,
                    floor=min_cross_section_above_vwap_w5m_ratio,
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_continuation_breadth',
                    value=cross_section_continuation_breadth,
                    floor=min_cross_section_continuation_breadth,
                    required=False,
                ),
            ),
        ),
    )

    if all(gate.passed for gate in buy_gates):
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
            effective_continuation_rank is not None
            and effective_continuation_rank >= Decimal('0.85')
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
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
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
        'below_vwap': (
            price_vs_vwap_w5m_bps is not None
            and price_vs_vwap_w5m_bps
            <= _decimal_param(params, 'exit_price_vs_vwap_w5m_bps', Decimal('-10'))
        ),
        'range_position_lost': (
            price_position_in_session_range is not None
            and price_position_in_session_range
            <= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.58'))
        ),
        'session_drive_lost': (
            price_vs_session_open_bps is not None
            and price_vs_session_open_bps
            <= _decimal_param(params, 'exit_session_open_drive_bps', Decimal('24'))
        ),
        'momentum_rollover': (
            macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.004'))
            and rsi14 <= _decimal_param(params, 'exit_rsi_max', Decimal('55'))
        ),
        'below_opening_range_high': (
            price_vs_opening_range_high_bps is not None
            and price_vs_opening_range_high_bps
            <= _decimal_param(params, 'exit_price_below_opening_range_high_bps', Decimal('-16'))
        ),
        'imbalance_reversal': (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg
            <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.02'))
        ),
    }
    exit_gate = _exit_trigger_gate(reason_flags=exit_reasons)
    if exit_gate.passed:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='sell',
                confidence=Decimal('0.63'),
                rationale=(
                    'late_day_continuation_exit',
                    'late_day_failure',
                ),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    return _sleeve_result(
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


def evaluate_end_of_day_reversal_long(
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
) -> SleeveSignalResult:
    trace_context = {'family': 'end_of_day_reversal_long'}
    required_fields = {
        'price': price is not None,
        'ema12': ema12 is not None,
        'ema26': ema26 is not None,
        'macd': macd is not None,
        'macd_signal': macd_signal is not None,
        'rsi14': rsi14 is not None,
    }
    if not all(required_fields.values()):
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(_required_inputs_gate(fields=required_fields),),
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    ts = _parse_event_ts(event_ts)
    entry_start_minute = _minute_param(params, 'entry_start_minute_utc', 19 * 60 + 20)
    entry_end_minute = _effective_entry_end_minute(
        params,
        default_end_minute=19 * 60 + 48,
    )
    within_window = _within_utc_window(
        ts,
        start_minute=entry_start_minute,
        end_minute=entry_end_minute,
    )
    if not within_window:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=None,
            gates=(
                _entry_window_gate(
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
    price_below_vwap_bps = -price_vs_vwap_bps if price_vs_vwap_bps is not None else None
    price_below_ema12_bps = -price_vs_ema12_bps if price_vs_ema12_bps is not None else None
    buy_gates = (
        _gate(
            name='structure',
            category='structure',
            thresholds=(
                _threshold_max(
                    metric='effective_price_drive_bps',
                    value=effective_price_drive_bps,
                    ceil=_optional_decimal_param(params, 'max_price_vs_session_open_bps', Decimal('-45')),
                    required=False,
                ),
                _threshold_max(
                    metric='effective_opening_window_return_bps',
                    value=effective_opening_window_return_bps,
                    ceil=max_opening_window_return_bps,
                    required=False,
                ),
                _threshold_max(
                    metric='price_position_in_session_range',
                    value=price_position_in_session_range,
                    ceil=_optional_decimal_param(params, 'max_session_range_position', Decimal('0.40')),
                    required=False,
                ),
                _threshold_min(
                    metric='session_range_bps',
                    value=session_range_bps,
                    floor=_optional_decimal_param(params, 'min_session_range_bps', Decimal('40')),
                    required=False,
                ),
                _threshold_min(
                    metric='price_vs_opening_range_low_bps',
                    value=price_vs_opening_range_low_bps,
                    floor=_optional_decimal_param(params, 'min_price_vs_opening_range_low_bps', Decimal('-6')),
                    required=False,
                ),
                _threshold_max(
                    metric='price_vs_opening_range_low_bps',
                    value=price_vs_opening_range_low_bps,
                    ceil=_optional_decimal_param(params, 'max_price_vs_opening_range_low_bps', Decimal('16')),
                    required=False,
                ),
                *_threshold_range(
                    metric='price_below_vwap_bps',
                    value=price_below_vwap_bps,
                    floor=_optional_decimal_param(params, 'min_price_below_vwap_bps', Decimal('8')),
                    ceil=_optional_decimal_param(params, 'max_price_below_vwap_bps', Decimal('40')),
                    required=False,
                ),
                *_threshold_range(
                    metric='price_below_ema12_bps',
                    value=price_below_ema12_bps,
                    floor=_optional_decimal_param(params, 'min_price_below_ema12_bps', Decimal('4')),
                    ceil=_optional_decimal_param(params, 'max_price_below_ema12_bps', Decimal('28')),
                    required=False,
                ),
                *_threshold_range(
                    metric='rsi14',
                    value=rsi14,
                    floor=_decimal_param(params, 'min_bull_rsi', Decimal('34')),
                    ceil=_decimal_param(params, 'max_bull_rsi', Decimal('48')),
                    required=True,
                ),
                *_threshold_range(
                    metric='macd_hist',
                    value=macd_hist,
                    floor=_decimal_param(params, 'min_macd_hist', Decimal('-0.010')),
                    ceil=_decimal_param(params, 'max_macd_hist', Decimal('0.012')),
                    required=True,
                ),
                _threshold_bool(metric='ema12_lte_ema26', passed=ema12 <= ema26, threshold=True),
                *_threshold_range(
                    metric='vol_realized_w60s',
                    value=vol_realized_w60s,
                    floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
                    ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00050')),
                    required=False,
                ),
            ),
        ),
        _gate(
            name='feed_quality',
            category='feed_quality',
            thresholds=(
                _threshold_max(
                    metric='spread_bps',
                    value=effective_spread_bps,
                    ceil=spread_cap_bps,
                    required=True,
                ),
                _threshold_min(
                    metric='imbalance_pressure',
                    value=imbalance_pressure,
                    floor=_decimal_param(params, 'min_imbalance_pressure', Decimal('0.02')),
                    required=True,
                ),
                _threshold_max(
                    metric='recent_spread_bps_avg',
                    value=recent_spread_bps_avg,
                    ceil=_optional_decimal_param(params, 'max_recent_spread_bps', Decimal('8')),
                    required=False,
                ),
                _threshold_max(
                    metric='recent_spread_bps_max',
                    value=recent_spread_bps_max,
                    ceil=_optional_decimal_param(params, 'max_recent_spread_bps_max', Decimal('16')),
                    required=False,
                ),
                _threshold_min(
                    metric='recent_imbalance_pressure_avg',
                    value=recent_imbalance_pressure_avg,
                    floor=_optional_decimal_param(params, 'min_recent_imbalance_pressure', Decimal('0.03')),
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_invalid_ratio',
                    value=recent_quote_invalid_ratio,
                    ceil=max_recent_quote_invalid_ratio,
                    required=False,
                ),
                _threshold_max(
                    metric='recent_quote_jump_bps_max',
                    value=recent_quote_jump_bps_max,
                    ceil=max_recent_quote_jump_bps,
                    required=False,
                ),
                _threshold_min(
                    metric='recent_microprice_bias_bps_avg',
                    value=recent_microprice_bias_bps_avg,
                    floor=min_recent_microprice_bias_bps,
                    required=False,
                ),
            ),
        ),
        _gate(
            name='confirmation',
            category='confirmation',
            thresholds=(
                _threshold_max(
                    metric='cross_section_continuation_rank',
                    value=cross_section_continuation_rank,
                    ceil=max_cross_section_continuation_rank,
                    required=False,
                ),
                _threshold_min(
                    metric='cross_section_reversal_rank',
                    value=cross_section_reversal_rank,
                    floor=min_cross_section_reversal_rank,
                    required=False,
                ),
                _threshold_max(
                    metric='effective_opening_window_return_rank',
                    value=effective_opening_window_return_rank,
                    ceil=max_cross_section_opening_window_return_rank,
                    required=False,
                ),
            ),
        ),
    )

    if all(gate.passed for gate in buy_gates):
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
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
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
            ),
            gates=buy_gates,
            trace_enabled=trace_enabled,
            context=trace_context,
        )

    exit_reasons: dict[str, bool] = {
        'vwap_recovered': (vwap_session is not None and price >= vwap_session) or price >= ema12,
        'rsi_recovered': rsi14 >= _decimal_param(params, 'exit_rsi_min', Decimal('56')),
        'imbalance_reversal': (
            recent_imbalance_pressure_avg is not None
            and recent_imbalance_pressure_avg
            <= _decimal_param(params, 'exit_recent_imbalance_pressure_max', Decimal('-0.02'))
        ),
        'range_recovery': (
            price_position_in_session_range is not None
            and price_position_in_session_range
            >= _decimal_param(params, 'exit_session_range_position_min', Decimal('0.58'))
        ),
    }
    exit_gate = _exit_trigger_gate(reason_flags=exit_reasons)
    if exit_gate.passed:
        return _sleeve_result(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            signal=SleeveSignalEvaluation(
                action='sell',
                confidence=Decimal('0.62'),
                rationale=(
                    'end_of_day_reversal_exit',
                    'reversion_complete',
                ),
            ),
            gates=(exit_gate,),
            trace_enabled=trace_enabled,
            context=trace_context,
        )
    return _sleeve_result(
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


def _ratio_decimal_over_bps(
    value_bps: Decimal | None,
    reference_bps: Decimal | None,
) -> Decimal | None:
    if value_bps is None or reference_bps is None or reference_bps <= 0:
        return None
    return value_bps / reference_bps


def _prefer_primary_decimal(primary: Decimal | None, fallback: Decimal | None) -> Decimal | None:
    return primary if primary is not None else fallback


def _select_reference_decimal(
    *,
    params: Mapping[str, Any],
    key: str,
    default_basis: str,
    session_open_value: Decimal | None,
    prev_close_value: Decimal | None,
) -> Decimal | None:
    basis = str(params.get(key, default_basis)).strip().lower()
    if basis in {'session_open', 'session'}:
        return _prefer_primary_decimal(session_open_value, prev_close_value)
    return _prefer_primary_decimal(prev_close_value, session_open_value)


def _weighted_average_decimal(
    weighted_values: list[tuple[Decimal | None, Decimal]],
) -> Decimal | None:
    weighted_sum = Decimal('0')
    total_weight = Decimal('0')
    for value, weight in weighted_values:
        if value is None or weight <= 0:
            continue
        weighted_sum += value * weight
        total_weight += weight
    if total_weight <= 0:
        return None
    return weighted_sum / total_weight


def _session_minutes_elapsed(event_ts: str) -> int:
    ts = _parse_event_ts(event_ts)
    open_minute = 13 * 60 + 30
    current_minute = ts.hour * 60 + ts.minute
    return max(0, current_minute - open_minute)


def _resolve_live_continuation_rank(
    *,
    event_ts: str,
    cross_section_session_open_rank: Decimal | None,
    cross_section_prev_session_close_rank: Decimal | None,
    cross_section_opening_window_return_rank: Decimal | None,
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None,
    cross_section_range_position_rank: Decimal | None,
    cross_section_vwap_w5m_rank: Decimal | None,
    cross_section_recent_imbalance_rank: Decimal | None,
    fallback_rank: Decimal | None,
) -> Decimal | None:
    effective_session_drive_rank = _prefer_primary_decimal(
        cross_section_prev_session_close_rank,
        cross_section_session_open_rank,
    )
    effective_opening_window_rank = _prefer_primary_decimal(
        cross_section_opening_window_return_from_prev_close_rank,
        cross_section_opening_window_return_rank,
    )
    if (
        effective_session_drive_rank is None
        and effective_opening_window_rank is None
        and cross_section_range_position_rank is None
        and cross_section_vwap_w5m_rank is None
        and cross_section_recent_imbalance_rank is None
    ):
        return fallback_rank
    if (
        cross_section_range_position_rank is None
        and cross_section_vwap_w5m_rank is None
        and cross_section_recent_imbalance_rank is None
        and fallback_rank is not None
    ):
        return fallback_rank

    # Opening-window leadership matters at the open, but breakout continuation
    # should increasingly follow live range/VWAP/imbalance structure once the
    # opening auction is behind us.
    minutes_elapsed = _session_minutes_elapsed(event_ts)
    structural_progress = Decimal(
        max(0, min(minutes_elapsed - 30, 60))
    ) / Decimal('60')
    weights = {
        'session_drive': Decimal('0.18'),
        'opening_window': Decimal('0.16') - (Decimal('0.10') * structural_progress),
        'range_position': Decimal('0.26') + (Decimal('0.10') * structural_progress),
        'vwap': Decimal('0.20'),
        'imbalance': Decimal('0.20'),
    }
    resolved = _weighted_average_decimal(
        [
            (effective_session_drive_rank, weights['session_drive']),
            (effective_opening_window_rank, weights['opening_window']),
            (cross_section_range_position_rank, weights['range_position']),
            (cross_section_vwap_w5m_rank, weights['vwap']),
            (cross_section_recent_imbalance_rank, weights['imbalance']),
        ]
    )
    if resolved is None:
        return fallback_rank
    if fallback_rank is None:
        return resolved
    # The live-structure blend should improve rank fidelity, not silently
    # downgrade a symbol that already looks strong under the existing
    # continuation composite.
    return max(resolved, fallback_rank)


def _decayed_minimum(
    *,
    event_ts: str,
    early_floor: Decimal | None,
    late_floor: Decimal | None,
    decay_start_minutes: int = 60,
    decay_duration_minutes: int = 120,
) -> Decimal | None:
    if early_floor is None:
        return None
    if decay_duration_minutes <= 0:
        return late_floor if late_floor is not None else early_floor
    resolved_late_floor = late_floor
    if resolved_late_floor is None:
        resolved_late_floor = early_floor * Decimal('0.5')
    if resolved_late_floor > early_floor:
        resolved_late_floor = early_floor
    minutes_elapsed = _session_minutes_elapsed(event_ts)
    if minutes_elapsed <= decay_start_minutes:
        return early_floor
    progress = Decimal(
        min(max(minutes_elapsed - decay_start_minutes, 0), decay_duration_minutes)
    ) / Decimal(decay_duration_minutes)
    return early_floor - ((early_floor - resolved_late_floor) * progress)


def _early_breakout_quality_passes(
    *,
    event_ts: str,
    cutoff_minutes: int,
    continuation_rank: Decimal | None,
    elite_continuation_rank: Decimal | None,
    continuation_breadth: Decimal | None,
    min_continuation_breadth: Decimal | None,
    microprice_bias_bps: Decimal | None,
    min_microprice_bias_bps: Decimal | None,
) -> bool:
    minutes_elapsed = _session_minutes_elapsed(event_ts)
    if minutes_elapsed > cutoff_minutes:
        return True
    if _optional_min_threshold(continuation_rank, elite_continuation_rank):
        return True
    return _optional_min_threshold(
        continuation_breadth,
        min_continuation_breadth,
    ) and _optional_min_threshold(
        microprice_bias_bps,
        min_microprice_bias_bps,
    )


def _isolated_breakout_strength_confirmed(
    *,
    params: Mapping[str, Any],
    range_position_rank: Decimal | None,
    vwap_w5m_rank: Decimal | None,
    recent_imbalance_rank: Decimal | None,
) -> bool:
    return (
        _required_min_threshold(
            range_position_rank,
            _optional_decimal_param(
                params,
                'isolated_flow_min_range_position_rank',
                Decimal('0.85'),
            ),
        )
        and _required_min_threshold(
            vwap_w5m_rank,
            _optional_decimal_param(
                params,
                'isolated_flow_min_vwap_w5m_rank',
                Decimal('0.75'),
            ),
        )
        and _required_min_threshold(
            recent_imbalance_rank,
            _optional_decimal_param(
                params,
                'isolated_flow_min_recent_imbalance_rank',
                Decimal('0.75'),
            ),
        )
    )


def _isolated_same_day_leadership_confirmed(
    *,
    params: Mapping[str, Any],
    session_open_rank: Decimal | None,
    opening_window_return_rank: Decimal | None,
    continuation_rank: Decimal | None,
    microprice_bias_bps: Decimal | None,
    price_vs_opening_window_close_bps: Decimal | None,
    recent_above_opening_window_close_ratio: Decimal | None,
) -> bool:
    return (
        _required_min_threshold(
            session_open_rank,
            _optional_decimal_param(
                params,
                'isolated_same_day_min_session_open_rank',
                Decimal('0.90'),
            ),
        )
        and _required_min_threshold(
            opening_window_return_rank,
            _optional_decimal_param(
                params,
                'isolated_same_day_min_opening_window_return_rank',
                Decimal('0.85'),
            ),
        )
        and _required_min_threshold(
            continuation_rank,
            _optional_decimal_param(
                params,
                'isolated_same_day_min_continuation_rank',
                Decimal('0.88'),
            ),
        )
        and _required_min_threshold(
            microprice_bias_bps,
            _optional_decimal_param(
                params,
                'isolated_same_day_min_microprice_bias_bps',
                Decimal('0.25'),
            ),
        )
        and _required_min_threshold(
            price_vs_opening_window_close_bps,
            _optional_decimal_param(
                params,
                'isolated_same_day_min_price_vs_opening_window_close_bps',
                Decimal('0'),
            ),
        )
        and _required_min_threshold(
            recent_above_opening_window_close_ratio,
            _optional_decimal_param(
                params,
                'isolated_same_day_min_recent_above_opening_window_close_ratio',
                Decimal('0.55'),
            ),
        )
    )


def _leader_reclaim_confirmed(
    *,
    params: Mapping[str, Any],
    event_ts: str,
    same_day_leadership_confirmed: bool,
    recent_imbalance_pressure_avg: Decimal | None,
    recent_microprice_bias_bps_avg: Decimal | None,
    recent_above_opening_window_close_ratio: Decimal | None,
    recent_above_vwap_w5m_ratio: Decimal | None,
    price_position_in_session_range: Decimal | None,
    price_vs_vwap_w5m_bps: Decimal | None,
) -> bool:
    if not same_day_leadership_confirmed:
        return False
    if _session_minutes_elapsed(event_ts) <= _minute_param(
        params,
        'leader_reclaim_start_minutes_since_open',
        90,
    ):
        return False
    return (
        _required_min_threshold(
            recent_imbalance_pressure_avg,
            _optional_decimal_param(
                params,
                'leader_reclaim_min_recent_imbalance_pressure',
                Decimal('0.20'),
            ),
        )
        and _required_min_threshold(
            recent_microprice_bias_bps_avg,
            _optional_decimal_param(
                params,
                'leader_reclaim_min_recent_microprice_bias_bps',
                Decimal('1.0'),
            ),
        )
        and _required_min_threshold(
            recent_above_opening_window_close_ratio,
            _optional_decimal_param(
                params,
                'leader_reclaim_min_recent_above_opening_window_close_ratio',
                Decimal('0.85'),
            ),
        )
        and _required_min_threshold(
            recent_above_vwap_w5m_ratio,
            _optional_decimal_param(
                params,
                'leader_reclaim_min_recent_above_vwap_w5m_ratio',
                Decimal('0.80'),
            ),
        )
        and _required_min_threshold(
            price_position_in_session_range,
            _optional_decimal_param(
                params,
                'leader_reclaim_min_session_range_position',
                Decimal('0.80'),
            ),
        )
        and _required_min_threshold(
            price_vs_vwap_w5m_bps,
            _optional_decimal_param(
                params,
                'leader_reclaim_min_price_vs_vwap_w5m_bps',
                Decimal('-4'),
            ),
        )
        and _optional_max_threshold(
            price_vs_vwap_w5m_bps,
            _optional_decimal_param(
                params,
                'leader_reclaim_max_price_vs_vwap_w5m_bps',
                Decimal('28'),
            ),
        )
    )


def _relax_floor_for_isolated_strength(
    *,
    floor: Decimal | None,
    isolated_strength_confirmed: bool,
    relaxation: Decimal | None,
) -> Decimal | None:
    if floor is None or not isolated_strength_confirmed:
        return floor
    effective_relaxation = relaxation or Decimal('0')
    if effective_relaxation <= 0:
        return floor
    relaxed_floor = floor - effective_relaxation
    if floor >= 0:
        return max(Decimal('0'), relaxed_floor)
    return relaxed_floor


def _widen_cap_for_isolated_strength(
    *,
    cap: Decimal | None,
    isolated_strength_confirmed: bool,
    extension: Decimal | None,
) -> Decimal | None:
    if cap is None or not isolated_strength_confirmed:
        return cap
    effective_extension = extension or Decimal('0')
    if effective_extension <= 0:
        return cap
    return cap + effective_extension


def _isolated_leader_continuation_shape_passes(
    *,
    params: Mapping[str, Any],
    isolated_strength_confirmed: bool,
    price_position_in_session_range: Decimal | None,
    price_vs_opening_range_high_bps: Decimal | None,
    opening_range_width_bps: Decimal | None,
    session_range_bps: Decimal | None,
    min_session_range_position_key: str = 'isolated_flow_min_session_range_position',
    default_min_session_range_position: Decimal = Decimal('0.88'),
    min_price_vs_opening_range_high_key: str = 'isolated_flow_min_price_vs_opening_range_high_bps',
    default_min_price_vs_opening_range_high_bps: Decimal = Decimal('-24'),
    min_opening_range_width_bps_key: str = 'isolated_flow_min_opening_range_width_bps',
    default_min_opening_range_width_bps: Decimal = Decimal('8'),
    min_session_range_bps_key: str = 'isolated_flow_min_session_range_bps',
    default_min_session_range_bps: Decimal = Decimal('18'),
) -> bool:
    if not isolated_strength_confirmed:
        return False
    return (
        _optional_min_threshold(
            price_position_in_session_range,
            _optional_decimal_param(
                params,
                min_session_range_position_key,
                default_min_session_range_position,
            ),
        )
        and _optional_min_threshold(
            price_vs_opening_range_high_bps,
            _optional_decimal_param(
                params,
                min_price_vs_opening_range_high_key,
                default_min_price_vs_opening_range_high_bps,
            ),
        )
        and _optional_min_threshold(
            opening_range_width_bps,
            _optional_decimal_param(
                params,
                min_opening_range_width_bps_key,
                default_min_opening_range_width_bps,
            ),
        )
        and _optional_min_threshold(
            session_range_bps,
            _optional_decimal_param(
                params,
                min_session_range_bps_key,
                default_min_session_range_bps,
            ),
        )
    )


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


def _optional_min_threshold(value: Decimal | None, floor: Decimal | None) -> bool:
    if floor is None or value is None:
        return True
    return value >= floor


def _required_min_threshold(value: Decimal | None, floor: Decimal | None) -> bool:
    if floor is None:
        return True
    if value is None:
        return False
    return value >= floor


def _recent_reference_hold_passes(
    *,
    recent_above_opening_range_high_ratio: Decimal | None,
    min_recent_above_opening_range_high_ratio: Decimal | None,
    recent_above_opening_window_close_ratio: Decimal | None,
    min_recent_above_opening_window_close_ratio: Decimal | None,
) -> bool:
    checks: list[bool] = []
    if min_recent_above_opening_range_high_ratio is not None:
        checks.append(
            _required_min_threshold(
                recent_above_opening_range_high_ratio,
                min_recent_above_opening_range_high_ratio,
            )
        )
    if min_recent_above_opening_window_close_ratio is not None:
        checks.append(
            _required_min_threshold(
                recent_above_opening_window_close_ratio,
                min_recent_above_opening_window_close_ratio,
            )
        )
    if not checks:
        return True
    return any(checks)


def _optional_max_threshold(value: Decimal | None, ceil: Decimal | None) -> bool:
    if ceil is None or value is None:
        return True
    return value <= ceil


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
