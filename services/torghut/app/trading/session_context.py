"""Stateful session-derived features for intraday strategy evaluation."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Any, Mapping, cast

from .features import extract_price, optional_decimal
from .models import SignalEnvelope
from .quote_quality import QuoteQualityPolicy, assess_signal_quote_quality

REGULAR_OPEN_UTC = time(hour=13, minute=30)
DEFAULT_OPENING_RANGE_MINUTES = 30
DEFAULT_RECENT_WINDOW = 30
DEFAULT_POSITION_IN_RANGE = Decimal('0.5')


def _extract_price(payload: dict[str, Any]) -> Decimal | None:
    return extract_price(payload)


def _extract_spread_bps(payload: dict[str, Any], price: Decimal | None) -> Decimal | None:
    if price is None or price <= 0:
        return None
    spread = optional_decimal(
        payload.get('spread')
        or payload.get('imbalance_spread')
        or _nested(payload, 'imbalance', 'spread')
    )
    if spread is None:
        return None
    return (abs(spread) / price) * Decimal('10000')


def _extract_imbalance_pressure(payload: dict[str, Any]) -> Decimal | None:
    bid_sz = optional_decimal(payload.get('imbalance_bid_sz') or _nested(payload, 'imbalance', 'bid_sz'))
    ask_sz = optional_decimal(payload.get('imbalance_ask_sz') or _nested(payload, 'imbalance', 'ask_sz'))
    if bid_sz is None or ask_sz is None:
        return None
    total = bid_sz + ask_sz
    if total <= 0:
        return None
    return (bid_sz - ask_sz) / total


def _extract_microprice_bias_bps(payload: dict[str, Any]) -> Decimal | None:
    bid_px = optional_decimal(payload.get('imbalance_bid_px') or _nested(payload, 'imbalance', 'bid_px'))
    ask_px = optional_decimal(payload.get('imbalance_ask_px') or _nested(payload, 'imbalance', 'ask_px'))
    bid_sz = optional_decimal(payload.get('imbalance_bid_sz') or _nested(payload, 'imbalance', 'bid_sz'))
    ask_sz = optional_decimal(payload.get('imbalance_ask_sz') or _nested(payload, 'imbalance', 'ask_sz'))
    if (
        bid_px is None
        or ask_px is None
        or bid_sz is None
        or ask_sz is None
        or bid_px <= 0
        or ask_px <= 0
    ):
        return None
    total_size = bid_sz + ask_sz
    if total_size <= 0:
        return None
    mid_price = (bid_px + ask_px) / 2
    if mid_price <= 0:
        return None
    microprice = ((ask_px * bid_sz) + (bid_px * ask_sz)) / total_size
    return ((microprice - mid_price) / mid_price) * Decimal('10000')


def _nested(payload: dict[str, Any], block: str, key: str) -> Any:
    item = payload.get(block)
    if isinstance(item, dict):
        return cast(Mapping[str, Any], item).get(key)
    return None


def _bps_delta(price: Decimal | None, reference: Decimal | None) -> Decimal | None:
    if price is None or reference is None or reference == 0:
        return None
    return ((price - reference) / reference) * Decimal('10000')


def _mean_decimal(values: deque[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal('0')) / Decimal(len(values))


def _max_decimal(values: deque[Decimal]) -> Decimal | None:
    if not values:
        return None
    return max(values)


def _average_decimal(values: list[Decimal | None]) -> Decimal | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    return sum(present, Decimal('0')) / Decimal(len(present))


def _ratio_decimal(values: list[bool]) -> Decimal | None:
    if not values:
        return None
    positive = sum(1 for item in values if item)
    return Decimal(positive) / Decimal(len(values))


def _percentile_rank(
    values: dict[str, Decimal],
    *,
    symbol: str,
) -> Decimal | None:
    normalized_symbol = symbol.strip().upper()
    if normalized_symbol not in values or not values:
        return None
    ordered = sorted(values.items(), key=lambda item: (item[1], item[0]))
    if len(ordered) == 1:
        return Decimal('1')
    for index, (candidate_symbol, _value) in enumerate(ordered):
        if candidate_symbol == normalized_symbol:
            return Decimal(index) / Decimal(len(ordered) - 1)
    return None


def _session_minutes_elapsed(event_ts: datetime) -> int:
    ts_utc = event_ts.astimezone(timezone.utc)
    session_open = datetime.combine(ts_utc.date(), REGULAR_OPEN_UTC, tzinfo=timezone.utc)
    delta = ts_utc - session_open
    return max(0, int(delta.total_seconds() // 60))


@dataclass
class _SymbolSessionState:
    session_day: date
    session_open_price: Decimal
    prev_session_close_price: Decimal | None
    session_high_price: Decimal
    session_low_price: Decimal
    opening_range_high: Decimal
    opening_range_low: Decimal
    opening_window_close_price: Decimal
    spread_bps_window: deque[Decimal] = field(default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW))
    imbalance_pressure_window: deque[Decimal] = field(default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW))
    quote_validity_window: deque[Decimal] = field(default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW))
    quote_jump_bps_window: deque[Decimal] = field(default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW))
    microprice_bias_bps_window: deque[Decimal] = field(default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW))
    latest_price_vs_session_open_bps: Decimal | None = None
    latest_price_vs_prev_session_close_bps: Decimal | None = None
    latest_price_position_in_session_range: Decimal | None = None
    latest_price_vs_vwap_w5m_bps: Decimal | None = None
    latest_opening_window_return_bps: Decimal | None = None
    latest_opening_window_return_from_prev_close_bps: Decimal | None = None
    latest_recent_imbalance_pressure_avg: Decimal | None = None
    latest_recent_quote_invalid_ratio: Decimal | None = None
    latest_recent_quote_jump_bps_avg: Decimal | None = None
    latest_recent_quote_jump_bps_max: Decimal | None = None
    latest_recent_microprice_bias_bps_avg: Decimal | None = None
    last_valid_quote_price: Decimal | None = None


class SessionContextTracker:
    """Maintain per-symbol intraday context derived from sequential TA signals."""

    def __init__(
        self,
        *,
        opening_range_minutes: int = DEFAULT_OPENING_RANGE_MINUTES,
        recent_window: int = DEFAULT_RECENT_WINDOW,
        quote_quality_policy: QuoteQualityPolicy | None = None,
    ) -> None:
        self.opening_range_minutes = max(1, int(opening_range_minutes))
        self.recent_window = max(2, int(recent_window))
        self.quote_quality_policy = quote_quality_policy or QuoteQualityPolicy()
        self._state_by_symbol: dict[str, _SymbolSessionState] = {}
        self._last_session_close_by_symbol: dict[str, Decimal] = {}

    def enrich_signal_payload(self, signal: SignalEnvelope) -> dict[str, Any]:
        payload = dict(signal.payload)
        price = _extract_price(payload)
        if price is None or price <= 0:
            return payload

        symbol = signal.symbol.strip().upper()
        session_day = signal.event_ts.astimezone(timezone.utc).date()
        state = self._state_by_symbol.get(symbol)
        if state is not None and state.session_day != session_day:
            previous_close = (
                state.last_valid_quote_price
                or state.opening_window_close_price
                or state.session_open_price
            )
            if previous_close > 0:
                self._last_session_close_by_symbol[symbol] = previous_close
            state = None
        if state is None:
            state = _SymbolSessionState(
                session_day=session_day,
                session_open_price=price,
                prev_session_close_price=self._last_session_close_by_symbol.get(symbol),
                session_high_price=price,
                session_low_price=price,
                opening_range_high=price,
                opening_range_low=price,
                opening_window_close_price=price,
                spread_bps_window=deque(maxlen=self.recent_window),
                imbalance_pressure_window=deque(maxlen=self.recent_window),
                quote_validity_window=deque(maxlen=self.recent_window),
                quote_jump_bps_window=deque(maxlen=self.recent_window),
                microprice_bias_bps_window=deque(maxlen=self.recent_window),
            )
            self._state_by_symbol[symbol] = state

        state.session_high_price = max(state.session_high_price, price)
        state.session_low_price = min(state.session_low_price, price)

        minutes_elapsed = _session_minutes_elapsed(signal.event_ts)
        if minutes_elapsed <= self.opening_range_minutes:
            state.opening_range_high = max(state.opening_range_high, price)
            state.opening_range_low = min(state.opening_range_low, price)
            state.opening_window_close_price = price

        spread_bps = _extract_spread_bps(payload, price)
        imbalance_pressure = _extract_imbalance_pressure(payload)
        microprice_bias_bps = _extract_microprice_bias_bps(payload)
        quote_quality = assess_signal_quote_quality(
            signal=signal,
            previous_price=state.last_valid_quote_price,
            policy=self.quote_quality_policy,
        )
        if spread_bps is not None:
            state.spread_bps_window.append(spread_bps)
        if imbalance_pressure is not None:
            state.imbalance_pressure_window.append(imbalance_pressure)
        if microprice_bias_bps is not None:
            state.microprice_bias_bps_window.append(microprice_bias_bps)
        state.quote_validity_window.append(
            Decimal('1') if quote_quality.valid else Decimal('0')
        )
        if quote_quality.jump_bps is not None:
            state.quote_jump_bps_window.append(quote_quality.jump_bps)
        if quote_quality.valid:
            state.last_valid_quote_price = price

        session_range = state.session_high_price - state.session_low_price
        position_in_range = DEFAULT_POSITION_IN_RANGE
        if session_range > 0:
            position_in_range = (price - state.session_low_price) / session_range

        vwap_w5m = optional_decimal(payload.get('vwap_w5m') or _nested(payload, 'vwap', 'w5m'))
        opening_range_width_bps = _bps_delta(state.opening_range_high, state.opening_range_low)
        session_range_bps = _bps_delta(state.session_high_price, state.session_low_price)
        price_vs_session_open_bps = _bps_delta(price, state.session_open_price)
        price_vs_prev_session_close_bps = _bps_delta(price, state.prev_session_close_price)
        opening_window_return_bps = _bps_delta(
            state.opening_window_close_price,
            state.session_open_price,
        )
        opening_window_return_from_prev_close_bps = _bps_delta(
            state.opening_window_close_price,
            state.prev_session_close_price,
        )
        price_vs_session_high_bps = _bps_delta(price, state.session_high_price)
        price_vs_session_low_bps = _bps_delta(price, state.session_low_price)
        price_vs_opening_range_high_bps = _bps_delta(price, state.opening_range_high)
        price_vs_opening_range_low_bps = _bps_delta(price, state.opening_range_low)
        price_vs_opening_window_close_bps = _bps_delta(price, state.opening_window_close_price)
        recent_spread_bps_avg = _mean_decimal(state.spread_bps_window)
        recent_spread_bps_max = _max_decimal(state.spread_bps_window)
        recent_imbalance_pressure_avg = _mean_decimal(state.imbalance_pressure_window)
        recent_quote_validity_avg = _mean_decimal(state.quote_validity_window)
        recent_quote_invalid_ratio = (
            Decimal('1') - recent_quote_validity_avg
            if recent_quote_validity_avg is not None
            else None
        )
        recent_quote_jump_bps_avg = _mean_decimal(state.quote_jump_bps_window)
        recent_quote_jump_bps_max = _max_decimal(state.quote_jump_bps_window)
        recent_microprice_bias_bps_avg = _mean_decimal(
            state.microprice_bias_bps_window
        )
        price_vs_vwap_w5m_bps = _bps_delta(price, vwap_w5m)

        state.latest_price_vs_session_open_bps = price_vs_session_open_bps
        state.latest_price_vs_prev_session_close_bps = price_vs_prev_session_close_bps
        state.latest_price_position_in_session_range = position_in_range
        state.latest_price_vs_vwap_w5m_bps = price_vs_vwap_w5m_bps
        state.latest_opening_window_return_bps = opening_window_return_bps
        state.latest_opening_window_return_from_prev_close_bps = (
            opening_window_return_from_prev_close_bps
        )
        state.latest_recent_imbalance_pressure_avg = recent_imbalance_pressure_avg
        state.latest_recent_quote_invalid_ratio = recent_quote_invalid_ratio
        state.latest_recent_quote_jump_bps_avg = recent_quote_jump_bps_avg
        state.latest_recent_quote_jump_bps_max = recent_quote_jump_bps_max
        state.latest_recent_microprice_bias_bps_avg = recent_microprice_bias_bps_avg

        session_open_rank = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor='latest_price_vs_session_open_bps',
        )
        range_position_rank = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor='latest_price_position_in_session_range',
        )
        vwap_w5m_rank = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor='latest_price_vs_vwap_w5m_bps',
        )
        recent_imbalance_rank = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor='latest_recent_imbalance_pressure_avg',
        )
        opening_window_return_rank = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor='latest_opening_window_return_bps',
        )
        prev_session_close_rank = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor='latest_price_vs_prev_session_close_bps',
        )
        opening_window_prev_close_return_rank = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor='latest_opening_window_return_from_prev_close_bps',
        )
        positive_session_open_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor='latest_price_vs_session_open_bps',
        )
        positive_opening_window_return_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor='latest_opening_window_return_bps',
        )
        positive_prev_session_close_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor='latest_price_vs_prev_session_close_bps',
        )
        positive_opening_window_return_from_prev_close_ratio = (
            self._positive_ratio_latest_metric(
                current_day=session_day,
                accessor='latest_opening_window_return_from_prev_close_bps',
            )
        )
        above_vwap_w5m_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor='latest_price_vs_vwap_w5m_bps',
        )
        positive_recent_imbalance_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor='latest_recent_imbalance_pressure_avg',
        )
        effective_session_drive_rank = (
            prev_session_close_rank
            if prev_session_close_rank is not None
            else session_open_rank
        )
        effective_opening_window_return_rank = (
            opening_window_prev_close_return_rank
            if opening_window_prev_close_return_rank is not None
            else opening_window_return_rank
        )
        effective_positive_session_drive_ratio = (
            positive_prev_session_close_ratio
            if positive_prev_session_close_ratio is not None
            else positive_session_open_ratio
        )
        effective_positive_opening_window_return_ratio = (
            positive_opening_window_return_from_prev_close_ratio
            if positive_opening_window_return_from_prev_close_ratio is not None
            else positive_opening_window_return_ratio
        )
        cross_section_continuation_breadth = _average_decimal(
            [
                effective_positive_session_drive_ratio,
                effective_positive_opening_window_return_ratio,
                above_vwap_w5m_ratio,
                positive_recent_imbalance_ratio,
            ]
        )
        cross_section_continuation_rank = _average_decimal(
            [
                effective_session_drive_rank,
                effective_opening_window_return_rank,
                range_position_rank,
                vwap_w5m_rank,
                recent_imbalance_rank,
            ]
        )
        cross_section_reversal_rank = _average_decimal(
            [
                (
                    Decimal('1') - effective_session_drive_rank
                    if effective_session_drive_rank is not None
                    else None
                ),
                (
                    Decimal('1') - effective_opening_window_return_rank
                    if effective_opening_window_return_rank is not None
                    else None
                ),
                (
                    Decimal('1') - range_position_rank
                    if range_position_rank is not None
                    else None
                ),
                (
                    Decimal('1') - vwap_w5m_rank
                    if vwap_w5m_rank is not None
                    else None
                ),
                recent_imbalance_rank,
            ]
        )

        payload.update(
            {
                'session_open_price': state.session_open_price,
                'prev_session_close_price': state.prev_session_close_price,
                'session_high_price': state.session_high_price,
                'session_low_price': state.session_low_price,
                'opening_range_high': state.opening_range_high,
                'opening_range_low': state.opening_range_low,
                'opening_window_close_price': state.opening_window_close_price,
                'opening_range_width_bps': opening_range_width_bps,
                'session_range_bps': session_range_bps,
                'price_vs_session_open_bps': price_vs_session_open_bps,
                'price_vs_prev_session_close_bps': price_vs_prev_session_close_bps,
                'opening_window_return_bps': opening_window_return_bps,
                'opening_window_return_from_prev_close_bps': opening_window_return_from_prev_close_bps,
                'price_vs_session_high_bps': price_vs_session_high_bps,
                'price_vs_session_low_bps': price_vs_session_low_bps,
                'price_vs_opening_range_high_bps': price_vs_opening_range_high_bps,
                'price_vs_opening_range_low_bps': price_vs_opening_range_low_bps,
                'price_vs_opening_window_close_bps': price_vs_opening_window_close_bps,
                'price_position_in_session_range': position_in_range,
                'recent_spread_bps_avg': recent_spread_bps_avg,
                'recent_spread_bps_max': recent_spread_bps_max,
                'recent_imbalance_pressure_avg': recent_imbalance_pressure_avg,
                'recent_quote_invalid_ratio': recent_quote_invalid_ratio,
                'recent_quote_jump_bps_avg': recent_quote_jump_bps_avg,
                'recent_quote_jump_bps_max': recent_quote_jump_bps_max,
                'recent_microprice_bias_bps_avg': recent_microprice_bias_bps_avg,
                'cross_section_session_open_rank': session_open_rank,
                'cross_section_prev_session_close_rank': prev_session_close_rank,
                'cross_section_opening_window_return_rank': opening_window_return_rank,
                'cross_section_opening_window_return_from_prev_close_rank': (
                    opening_window_prev_close_return_rank
                ),
                'cross_section_range_position_rank': range_position_rank,
                'cross_section_vwap_w5m_rank': vwap_w5m_rank,
                'cross_section_recent_imbalance_rank': recent_imbalance_rank,
                'cross_section_positive_session_open_ratio': positive_session_open_ratio,
                'cross_section_positive_prev_session_close_ratio': positive_prev_session_close_ratio,
                'cross_section_positive_opening_window_return_ratio': positive_opening_window_return_ratio,
                'cross_section_positive_opening_window_return_from_prev_close_ratio': (
                    positive_opening_window_return_from_prev_close_ratio
                ),
                'cross_section_above_vwap_w5m_ratio': above_vwap_w5m_ratio,
                'cross_section_positive_recent_imbalance_ratio': positive_recent_imbalance_ratio,
                'cross_section_continuation_breadth': cross_section_continuation_breadth,
                'cross_section_continuation_rank': cross_section_continuation_rank,
                'cross_section_reversal_rank': cross_section_reversal_rank,
                'session_minutes_elapsed': minutes_elapsed,
            }
        )
        return payload

    def _rank_latest_metric(
        self,
        *,
        current_day: date,
        symbol: str,
        accessor: str,
    ) -> Decimal | None:
        values: dict[str, Decimal] = {}
        for candidate_symbol, state in self._state_by_symbol.items():
            if state.session_day != current_day:
                continue
            raw_value = getattr(state, accessor)
            if raw_value is None:
                continue
            values[candidate_symbol] = raw_value
        return _percentile_rank(values, symbol=symbol)

    def _positive_ratio_latest_metric(
        self,
        *,
        current_day: date,
        accessor: str,
    ) -> Decimal | None:
        values: list[bool] = []
        for state in self._state_by_symbol.values():
            if state.session_day != current_day:
                continue
            raw_value = getattr(state, accessor)
            if raw_value is None:
                continue
            values.append(raw_value > 0)
        return _ratio_decimal(values)
