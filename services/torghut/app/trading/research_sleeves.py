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
    spread: Decimal | None,
    imbalance_bid_sz: Decimal | None,
    imbalance_ask_sz: Decimal | None,
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
    spread_bps = _spread_bps(price, spread)
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

    if (
        ema12 > ema26
        and bullish_hist_min <= macd_hist <= bullish_hist_cap
        and min_bull_rsi <= rsi14 <= max_bull_rsi
        and -max_pullback_bps <= price_vs_ema12_bps <= -min_pullback_bps
        and spread_bps <= spread_cap_bps
        and imbalance_pressure >= imbalance_floor
        and _vol_within_band(vol_realized_w60s, floor=vol_floor, ceil=vol_ceil)
    ):
        confidence = Decimal('0.66')
        if imbalance_pressure > Decimal('0.05'):
            confidence += Decimal('0.03')
        if price_vs_ema12_bps <= -Decimal('4'):
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
    vwap_session: Decimal | None,
    spread: Decimal | None,
    imbalance_bid_sz: Decimal | None,
    imbalance_ask_sz: Decimal | None,
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
    price_vs_vwap_bps = _bps_delta(price, vwap_session) if vwap_session is not None else price_vs_ema12_bps
    spread_bps = _spread_bps(price, spread)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    price_below_ema12 = price < ema12
    price_below_vwap = vwap_session is not None and price < vwap_session

    if (
        ema12 > ema26
        and macd_hist >= _decimal_param(params, 'bullish_hist_min', Decimal('0.008'))
        and _decimal_param(params, 'min_bull_rsi', Decimal('58')) <= rsi14 <= _decimal_param(params, 'max_bull_rsi', Decimal('72'))
        and _decimal_param(params, 'min_price_above_ema12_bps', Decimal('0')) <= price_vs_ema12_bps <= _decimal_param(params, 'max_price_above_ema12_bps', Decimal('16'))
        and _decimal_param(params, 'min_price_above_vwap_bps', Decimal('0')) <= price_vs_vwap_bps <= _decimal_param(params, 'max_price_above_vwap_bps', Decimal('30'))
        and spread_bps <= _decimal_param(params, 'max_spread_bps', Decimal('6'))
        and imbalance_pressure >= _decimal_param(params, 'min_imbalance_pressure', Decimal('0'))
        and _vol_within_band(
            vol_realized_w60s,
            floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00004')),
            ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00040')),
        )
    ):
        confidence = Decimal('0.68')
        if price_vs_vwap_bps >= Decimal('4'):
            confidence += Decimal('0.03')
        if imbalance_pressure >= Decimal('0.08'):
            confidence += Decimal('0.03')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.86')),
            rationale=(
                'breakout_continuation_long',
                'trend_up',
                'above_vwap',
                'imbalance_confirmed',
            ),
        )

    exit_macd_hist_max = _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.003'))
    exit_rsi_max = _decimal_param(params, 'exit_rsi_max', Decimal('56'))
    breakout_failure_confirmed = (
        (price_below_ema12 and price_below_vwap)
        or (
            macd_hist <= exit_macd_hist_max
            and rsi14 <= exit_rsi_max
            and (price_below_ema12 or price_below_vwap)
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
    spread: Decimal | None,
    imbalance_bid_sz: Decimal | None,
    imbalance_ask_sz: Decimal | None,
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
    spread_bps = _spread_bps(price, spread)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)

    if (
        _decimal_param(params, 'min_price_below_vwap_bps', Decimal('8')) <= -price_vs_vwap_bps <= _decimal_param(params, 'max_price_below_vwap_bps', Decimal('70'))
        and _decimal_param(params, 'min_price_below_ema12_bps', Decimal('2')) <= -price_vs_ema12_bps <= _decimal_param(params, 'max_price_below_ema12_bps', Decimal('35'))
        and _decimal_param(params, 'min_bull_rsi', Decimal('40')) <= rsi14 <= _decimal_param(params, 'max_bull_rsi', Decimal('52'))
        and _decimal_param(params, 'bullish_hist_min', Decimal('0.002')) <= macd_hist <= _decimal_param(params, 'bullish_hist_cap', Decimal('0.05'))
        and spread_bps <= _decimal_param(params, 'max_spread_bps', Decimal('8'))
        and imbalance_pressure >= _decimal_param(params, 'min_imbalance_pressure', Decimal('0'))
        and _vol_within_band(
            vol_realized_w60s,
            floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
            ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00055')),
        )
    ):
        confidence = Decimal('0.64')
        if -price_vs_vwap_bps >= Decimal('16'):
            confidence += Decimal('0.03')
        if imbalance_pressure >= Decimal('0.06'):
            confidence += Decimal('0.02')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.81')),
            rationale=(
                'mean_reversion_rebound_long',
                'oversold_rebound',
                'below_vwap',
                'spread_normalized',
            ),
        )

    if (
        (vwap_session is not None and price >= vwap_session)
        or (vwap_session is None and price >= ema12)
        or rsi14 >= _decimal_param(params, 'exit_rsi_min', Decimal('61'))
        or macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.002'))
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
    vwap_session: Decimal | None,
    spread: Decimal | None,
    imbalance_bid_sz: Decimal | None,
    imbalance_ask_sz: Decimal | None,
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
    price_vs_vwap_bps = _bps_delta(price, vwap_session) if vwap_session is not None else price_vs_ema12_bps
    spread_bps = _spread_bps(price, spread)
    imbalance_pressure = _imbalance_pressure(imbalance_bid_sz, imbalance_ask_sz)
    price_below_ema12 = price < ema12
    price_below_vwap = vwap_session is not None and price < vwap_session

    if (
        ema12 > ema26
        and _decimal_param(params, 'bullish_hist_min', Decimal('0.006')) <= macd_hist <= _decimal_param(params, 'bullish_hist_cap', Decimal('0.05'))
        and _decimal_param(params, 'min_bull_rsi', Decimal('57')) <= rsi14 <= _decimal_param(params, 'max_bull_rsi', Decimal('72'))
        and _decimal_param(params, 'min_price_above_ema12_bps', Decimal('0')) <= price_vs_ema12_bps <= _decimal_param(params, 'max_price_above_ema12_bps', Decimal('14'))
        and _decimal_param(params, 'min_price_above_vwap_bps', Decimal('2')) <= price_vs_vwap_bps <= _decimal_param(params, 'max_price_above_vwap_bps', Decimal('20'))
        and spread_bps <= _decimal_param(params, 'max_spread_bps', Decimal('6'))
        and imbalance_pressure >= _decimal_param(params, 'min_imbalance_pressure', Decimal('-0.01'))
        and _vol_within_band(
            vol_realized_w60s,
            floor=_optional_decimal_param(params, 'vol_floor', Decimal('0.00005')),
            ceil=_optional_decimal_param(params, 'vol_ceil', Decimal('0.00035')),
        )
    ):
        confidence = Decimal('0.69')
        if price_vs_vwap_bps >= Decimal('6'):
            confidence += Decimal('0.03')
        if spread_bps <= Decimal('3'):
            confidence += Decimal('0.02')
        if imbalance_pressure >= Decimal('0.04'):
            confidence += Decimal('0.02')
        return SleeveSignalEvaluation(
            action='buy',
            confidence=min(confidence, Decimal('0.87')),
            rationale=(
                'late_day_continuation_long',
                'trend_up',
                'late_day_strength',
                'close_auction_setup',
            ),
        )

    if (
        (price_below_ema12 and price_below_vwap)
        or (
            macd_hist <= _decimal_param(params, 'exit_macd_hist_max', Decimal('-0.004'))
            and rsi14 <= _decimal_param(params, 'exit_rsi_max', Decimal('55'))
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


def _bps_delta(price: Decimal, reference: Decimal) -> Decimal:
    if reference == 0:
        return Decimal('0')
    return ((price - reference) / reference) * Decimal('10000')


def _spread_bps(price: Decimal, spread: Decimal | None) -> Decimal:
    if spread is None or price <= 0:
        return Decimal('0')
    return (spread / price) * Decimal('10000')


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
