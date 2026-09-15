"""Session context tracker for intraday strategy features."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from ..features import optional_decimal, payload_value
from ..models import SignalEnvelope
from ..quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    assess_signal_quote_quality,
)
from .features import (
    DEFAULT_OPENING_RANGE_MINUTES,
    DEFAULT_POSITION_IN_RANGE,
    DEFAULT_PRICE_HISTORY_WINDOW,
    DEFAULT_RECENT_WINDOW,
    MARKET_TZ,
    SymbolSessionState,
    average_decimal,
    bps_delta,
    extract_imbalance_pressure,
    extract_microprice_bias_bps,
    extract_price_from_payload,
    extract_spread_bps,
    max_decimal,
    mean_decimal,
    percentile_rank,
    rank_universe_size,
    ratio_decimal,
    recent_return_bps,
    session_minutes_elapsed,
    regular_session_open_utc_for,
)


@dataclass(frozen=True)
class _PreparedSignal:
    payload: dict[str, Any]
    symbol: str
    price: Decimal
    signal_ts_utc: datetime
    session_day: date
    regular_session_started: bool
    minutes_elapsed: int


@dataclass(frozen=True)
class _IntradaySignalMetrics:
    spread_bps: Decimal | None
    imbalance_pressure: Decimal | None
    microprice_bias_bps: Decimal | None
    rsi14: Decimal | None
    macd_hist: Decimal | None
    microbar_volume: Decimal | None
    clusterlob_directional_ofi: Decimal | None
    clusterlob_opportunistic_ofi: Decimal | None
    clusterlob_market_making_ofi: Decimal | None
    clusterlob_event_cluster_stability_score: Decimal | None
    vwap_w5m: Decimal | None


@dataclass(frozen=True)
class _PriceMetrics:
    position_in_range: Decimal
    opening_range_width_bps: Decimal | None
    session_range_bps: Decimal | None
    price_vs_session_open_bps: Decimal | None
    price_vs_prev_session_close_bps: Decimal | None
    opening_window_return_bps: Decimal | None
    opening_window_return_from_prev_close_bps: Decimal | None
    price_vs_session_high_bps: Decimal | None
    price_vs_session_low_bps: Decimal | None
    price_vs_opening_range_high_bps: Decimal | None
    price_vs_opening_range_low_bps: Decimal | None
    price_vs_opening_window_close_bps: Decimal | None
    recent_spread_bps_avg: Decimal | None
    recent_spread_bps_max: Decimal | None
    recent_imbalance_pressure_avg: Decimal | None
    recent_quote_invalid_ratio: Decimal | None
    recent_quote_jump_bps_avg: Decimal | None
    recent_quote_jump_bps_max: Decimal | None
    recent_microprice_bias_bps_avg: Decimal | None
    recent_above_opening_range_high_ratio: Decimal | None
    recent_above_opening_window_close_ratio: Decimal | None
    recent_above_vwap_w5m_ratio: Decimal | None
    recent_15m_return_bps: Decimal | None
    price_vs_vwap_w5m_bps: Decimal | None
    vwap_w5m_stretch_bps: Decimal | None


@dataclass(frozen=True)
class _MetricRank:
    rank: Decimal | None
    universe_size: int


@dataclass(frozen=True)
class _RankMetrics:
    session_open: _MetricRank
    range_position: _MetricRank
    vwap_w5m: _MetricRank
    vwap_w5m_stretch: _MetricRank
    recent_15m_return: _MetricRank
    microbar_volume: _MetricRank
    clusterlob_directional_ofi: _MetricRank
    recent_imbalance: _MetricRank
    rsi14: _MetricRank
    macd_hist: _MetricRank
    opening_window_return: _MetricRank
    prev_session_close: _MetricRank
    opening_window_prev_close_return: _MetricRank
    prev_day_open45_return: _MetricRank
    prev_day_open60_return: _MetricRank
    positive_session_open_ratio: Decimal | None
    positive_opening_window_return_ratio: Decimal | None
    positive_prev_session_close_ratio: Decimal | None
    positive_opening_window_return_from_prev_close_ratio: Decimal | None
    above_vwap_w5m_ratio: Decimal | None
    positive_recent_imbalance_ratio: Decimal | None
    positive_prev_day_open45_return_ratio: Decimal | None
    positive_prev_day_open60_return_ratio: Decimal | None


@dataclass(frozen=True)
class _CrossSectionMetrics:
    continuation_breadth: Decimal | None
    continuation_rank: Decimal | None
    continuation_rank_universe_size: int
    reversal_rank: Decimal | None
    reversal_rank_universe_size: int
    factor_neutral_residual_rank: Decimal | None
    factor_neutral_residual_rank_universe_size: int
    pair_relative_return_rank: Decimal | None
    pair_relative_return_rank_universe_size: int
    residual_spread_zscore_rank: Decimal | None
    residual_spread_zscore_rank_universe_size: int


@dataclass(frozen=True)
class _ComputedSessionMetrics:
    signal: _IntradaySignalMetrics
    price: _PriceMetrics
    ranks: _RankMetrics
    cross_section: _CrossSectionMetrics


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
        self._state_by_symbol: dict[str, SymbolSessionState] = {}
        self._last_session_close_by_symbol: dict[str, Decimal] = {}
        self._last_opening_45_return_by_symbol: dict[str, Decimal] = {}
        self._last_opening_60_return_by_symbol: dict[str, Decimal] = {}

    def enrich_signal_payload(self, signal: SignalEnvelope) -> dict[str, Any]:
        prepared = _prepare_signal(signal)
        if prepared is None:
            return dict(signal.payload)

        self._roll_forward_completed_sessions(next_session_day=prepared.session_day)
        state = self._state_by_symbol.get(prepared.symbol)
        quote_quality = assess_signal_quote_quality(
            signal=signal,
            previous_price=state.last_valid_quote_price if state is not None else None,
            policy=self.quote_quality_policy,
        )
        state = state or self._state_for_prepared_signal(prepared)
        if state is None:
            return prepared.payload

        signal_metrics = _extract_intraday_signal_metrics(prepared)
        _record_quote_observation(
            state,
            prepared,
            signal_metrics,
            quote_quality,
            self.opening_range_minutes,
        )
        price_metrics = _build_price_metrics(state, prepared, signal_metrics)
        if quote_quality.valid:
            _store_latest_executable_metrics(
                state,
                price_metrics,
                signal_metrics,
                prepared.signal_ts_utc,
                prepared.minutes_elapsed,
            )

        ranks = self._rank_metrics_for_session(prepared.session_day, prepared.symbol)
        computed = _ComputedSessionMetrics(
            signal=signal_metrics,
            price=price_metrics,
            ranks=ranks,
            cross_section=_build_cross_section_metrics(ranks),
        )
        prepared.payload.update(_payload_fields(state, computed, prepared))
        return prepared.payload

    def _state_for_prepared_signal(
        self, prepared: _PreparedSignal
    ) -> SymbolSessionState | None:
        previous_close = self._last_session_close_by_symbol.get(prepared.symbol)
        if not prepared.regular_session_started:
            if previous_close is not None:
                prepared.payload["prev_session_close_price"] = previous_close
            return None
        state = _new_symbol_session_state(
            prepared=prepared,
            previous_close=previous_close,
            recent_window=self.recent_window,
        )
        self._state_by_symbol[prepared.symbol] = state
        return state

    def _roll_forward_completed_sessions(self, *, next_session_day: date) -> None:
        for candidate_symbol, state in list(self._state_by_symbol.items()):
            if state.session_day >= next_session_day:
                continue
            previous_close = (
                state.last_valid_quote_price
                or state.opening_window_close_price
                or state.session_open_price
            )
            if previous_close > 0:
                self._last_session_close_by_symbol[candidate_symbol] = previous_close
            if state.opening_45_return_bps is not None:
                self._last_opening_45_return_by_symbol[candidate_symbol] = (
                    state.opening_45_return_bps
                )
            if state.opening_60_return_bps is not None:
                self._last_opening_60_return_by_symbol[candidate_symbol] = (
                    state.opening_60_return_bps
                )
            del self._state_by_symbol[candidate_symbol]

    def _rank_metrics_for_session(self, current_day: date, symbol: str) -> _RankMetrics:
        return _RankMetrics(
            session_open=self._metric_rank(
                current_day, symbol, "latest_price_vs_session_open_bps"
            ),
            range_position=self._metric_rank(
                current_day, symbol, "latest_price_position_in_session_range"
            ),
            vwap_w5m=self._metric_rank(
                current_day, symbol, "latest_price_vs_vwap_w5m_bps"
            ),
            vwap_w5m_stretch=self._metric_rank(
                current_day, symbol, "latest_vwap_w5m_stretch_bps"
            ),
            recent_15m_return=self._metric_rank(
                current_day, symbol, "latest_recent_15m_return_bps"
            ),
            microbar_volume=self._metric_rank(
                current_day, symbol, "latest_microbar_volume"
            ),
            clusterlob_directional_ofi=self._metric_rank(
                current_day, symbol, "latest_clusterlob_directional_ofi"
            ),
            recent_imbalance=self._metric_rank(
                current_day, symbol, "latest_recent_imbalance_pressure_avg"
            ),
            rsi14=self._metric_rank(current_day, symbol, "latest_rsi14"),
            macd_hist=self._metric_rank(current_day, symbol, "latest_macd_hist"),
            opening_window_return=self._metric_rank(
                current_day, symbol, "latest_opening_window_return_bps"
            ),
            prev_session_close=self._metric_rank(
                current_day, symbol, "latest_price_vs_prev_session_close_bps"
            ),
            opening_window_prev_close_return=self._metric_rank(
                current_day,
                symbol,
                "latest_opening_window_return_from_prev_close_bps",
            ),
            prev_day_open45_return=_MetricRank(
                rank=percentile_rank(
                    self._last_opening_45_return_by_symbol,
                    symbol=symbol,
                ),
                universe_size=len(self._last_opening_45_return_by_symbol),
            ),
            prev_day_open60_return=_MetricRank(
                rank=percentile_rank(
                    self._last_opening_60_return_by_symbol,
                    symbol=symbol,
                ),
                universe_size=len(self._last_opening_60_return_by_symbol),
            ),
            positive_session_open_ratio=self._positive_ratio_latest_metric(
                current_day=current_day,
                accessor="latest_price_vs_session_open_bps",
            ),
            positive_opening_window_return_ratio=self._positive_ratio_latest_metric(
                current_day=current_day,
                accessor="latest_opening_window_return_bps",
            ),
            positive_prev_session_close_ratio=self._positive_ratio_latest_metric(
                current_day=current_day,
                accessor="latest_price_vs_prev_session_close_bps",
            ),
            positive_opening_window_return_from_prev_close_ratio=(
                self._positive_ratio_latest_metric(
                    current_day=current_day,
                    accessor="latest_opening_window_return_from_prev_close_bps",
                )
            ),
            above_vwap_w5m_ratio=self._positive_ratio_latest_metric(
                current_day=current_day,
                accessor="latest_price_vs_vwap_w5m_bps",
            ),
            positive_recent_imbalance_ratio=self._positive_ratio_latest_metric(
                current_day=current_day,
                accessor="latest_recent_imbalance_pressure_avg",
            ),
            positive_prev_day_open45_return_ratio=ratio_decimal(
                [value > 0 for value in self._last_opening_45_return_by_symbol.values()]
            ),
            positive_prev_day_open60_return_ratio=ratio_decimal(
                [value > 0 for value in self._last_opening_60_return_by_symbol.values()]
            ),
        )

    def _metric_rank(
        self, current_day: date, symbol: str, accessor: str
    ) -> _MetricRank:
        rank, universe_size = self._rank_latest_metric(
            current_day=current_day,
            symbol=symbol,
            accessor=accessor,
        )
        return _MetricRank(rank=rank, universe_size=universe_size)

    def _rank_latest_metric(
        self,
        *,
        current_day: date,
        symbol: str,
        accessor: str,
    ) -> tuple[Decimal | None, int]:
        values: dict[str, Decimal] = {}
        for candidate_symbol, state in self._state_by_symbol.items():
            if state.session_day != current_day:
                continue
            if state.latest_executable_metric_ts is None:
                continue
            raw_value = getattr(state, accessor)
            if raw_value is None:
                continue
            values[candidate_symbol] = raw_value
        return percentile_rank(values, symbol=symbol), len(values)

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
            if state.latest_executable_metric_ts is None:
                continue
            raw_value = getattr(state, accessor)
            if raw_value is None:
                continue
            values.append(raw_value > 0)
        return ratio_decimal(values)


def _prepare_signal(signal: SignalEnvelope) -> _PreparedSignal | None:
    payload = dict(signal.payload)
    price = extract_price_from_payload(payload)
    if price is None or price <= 0:
        return None
    signal_ts_utc = signal.event_ts.astimezone(timezone.utc)
    session_open_ts = regular_session_open_utc_for(signal_ts_utc)
    return _PreparedSignal(
        payload=payload,
        symbol=signal.symbol.strip().upper(),
        price=price,
        signal_ts_utc=signal_ts_utc,
        session_day=session_open_ts.astimezone(MARKET_TZ).date(),
        regular_session_started=signal_ts_utc >= session_open_ts,
        minutes_elapsed=session_minutes_elapsed(signal.event_ts),
    )


def _new_symbol_session_state(
    *,
    prepared: _PreparedSignal,
    previous_close: Decimal | None,
    recent_window: int,
) -> SymbolSessionState:
    return SymbolSessionState(
        session_day=prepared.session_day,
        session_open_price=prepared.price,
        prev_session_close_price=previous_close,
        session_high_price=prepared.price,
        session_low_price=prepared.price,
        opening_range_high=prepared.price,
        opening_range_low=prepared.price,
        opening_window_close_price=prepared.price,
        spread_bps_window=deque(maxlen=recent_window),
        imbalance_pressure_window=deque(maxlen=recent_window),
        quote_validity_window=deque(maxlen=recent_window),
        quote_jump_bps_window=deque(maxlen=recent_window),
        microprice_bias_bps_window=deque(maxlen=recent_window),
        above_opening_range_high_window=deque(maxlen=recent_window),
        above_opening_window_close_window=deque(maxlen=recent_window),
        above_vwap_w5m_window=deque(maxlen=recent_window),
        price_history=deque(maxlen=DEFAULT_PRICE_HISTORY_WINDOW),
    )


def _extract_intraday_signal_metrics(
    prepared: _PreparedSignal,
) -> _IntradaySignalMetrics:
    microbar_volume = optional_decimal(
        payload_value(prepared.payload, "microbar_volume")
    )
    if microbar_volume is None:
        microbar_volume = optional_decimal(payload_value(prepared.payload, "volume"))
    return _IntradaySignalMetrics(
        spread_bps=extract_spread_bps(prepared.payload, prepared.price),
        imbalance_pressure=extract_imbalance_pressure(prepared.payload),
        microprice_bias_bps=extract_microprice_bias_bps(prepared.payload),
        rsi14=optional_decimal(
            payload_value(prepared.payload, "rsi14", nested_key="rsi")
        ),
        macd_hist=optional_decimal(
            payload_value(
                prepared.payload, "macd_hist", block="macd", nested_key="hist"
            )
        ),
        microbar_volume=microbar_volume,
        clusterlob_directional_ofi=optional_decimal(
            payload_value(prepared.payload, "clusterlob_directional_ofi")
        ),
        clusterlob_opportunistic_ofi=optional_decimal(
            payload_value(prepared.payload, "clusterlob_opportunistic_ofi")
        ),
        clusterlob_market_making_ofi=optional_decimal(
            payload_value(prepared.payload, "clusterlob_market_making_ofi")
        ),
        clusterlob_event_cluster_stability_score=optional_decimal(
            payload_value(prepared.payload, "clusterlob_event_cluster_stability_score")
        ),
        vwap_w5m=optional_decimal(
            payload_value(prepared.payload, "vwap_w5m", block="vwap", nested_key="w5m")
        ),
    )


def _record_quote_observation(
    state: SymbolSessionState,
    prepared: _PreparedSignal,
    metrics: _IntradaySignalMetrics,
    quote_quality: QuoteQualityStatus,
    opening_range_minutes: int,
) -> None:
    state.quote_validity_window.append(
        Decimal("1") if quote_quality.valid else Decimal("0")
    )
    if quote_quality.jump_bps is not None:
        state.quote_jump_bps_window.append(quote_quality.jump_bps)
    if not quote_quality.valid:
        return

    _record_valid_price_anchor(state, prepared, opening_range_minutes)
    if metrics.spread_bps is not None:
        state.spread_bps_window.append(metrics.spread_bps)
    if metrics.imbalance_pressure is not None:
        state.imbalance_pressure_window.append(metrics.imbalance_pressure)
    if metrics.microprice_bias_bps is not None:
        state.microprice_bias_bps_window.append(metrics.microprice_bias_bps)
    state.above_opening_range_high_window.append(
        Decimal("1") if prepared.price >= state.opening_range_high else Decimal("0")
    )
    state.above_opening_window_close_window.append(
        Decimal("1")
        if prepared.price >= state.opening_window_close_price
        else Decimal("0")
    )
    if metrics.vwap_w5m is not None:
        state.above_vwap_w5m_window.append(
            Decimal("1") if prepared.price >= metrics.vwap_w5m else Decimal("0")
        )
    state.price_history.append((prepared.signal_ts_utc, prepared.price))
    state.last_valid_quote_price = prepared.price


def _record_valid_price_anchor(
    state: SymbolSessionState,
    prepared: _PreparedSignal,
    opening_range_minutes: int,
) -> None:
    if state.last_valid_quote_price is None:
        state.session_open_price = prepared.price
        state.session_high_price = prepared.price
        state.session_low_price = prepared.price
        state.opening_range_high = prepared.price
        state.opening_range_low = prepared.price
        state.opening_window_close_price = prepared.price
        return
    state.session_high_price = max(state.session_high_price, prepared.price)
    state.session_low_price = min(state.session_low_price, prepared.price)
    if prepared.minutes_elapsed <= opening_range_minutes:
        state.opening_range_high = max(state.opening_range_high, prepared.price)
        state.opening_range_low = min(state.opening_range_low, prepared.price)
        state.opening_window_close_price = prepared.price


def _build_price_metrics(
    state: SymbolSessionState,
    prepared: _PreparedSignal,
    signal_metrics: _IntradaySignalMetrics,
) -> _PriceMetrics:
    return _PriceMetrics(
        position_in_range=_position_in_session_range(state, prepared.price),
        opening_range_width_bps=bps_delta(
            state.opening_range_high, state.opening_range_low
        ),
        session_range_bps=bps_delta(state.session_high_price, state.session_low_price),
        price_vs_session_open_bps=bps_delta(prepared.price, state.session_open_price),
        price_vs_prev_session_close_bps=bps_delta(
            prepared.price, state.prev_session_close_price
        ),
        opening_window_return_bps=bps_delta(
            state.opening_window_close_price,
            state.session_open_price,
        ),
        opening_window_return_from_prev_close_bps=bps_delta(
            state.opening_window_close_price,
            state.prev_session_close_price,
        ),
        price_vs_session_high_bps=bps_delta(prepared.price, state.session_high_price),
        price_vs_session_low_bps=bps_delta(prepared.price, state.session_low_price),
        price_vs_opening_range_high_bps=bps_delta(
            prepared.price, state.opening_range_high
        ),
        price_vs_opening_range_low_bps=bps_delta(
            prepared.price, state.opening_range_low
        ),
        price_vs_opening_window_close_bps=bps_delta(
            prepared.price, state.opening_window_close_price
        ),
        recent_spread_bps_avg=mean_decimal(state.spread_bps_window),
        recent_spread_bps_max=max_decimal(state.spread_bps_window),
        recent_imbalance_pressure_avg=mean_decimal(state.imbalance_pressure_window),
        recent_quote_invalid_ratio=_recent_quote_invalid_ratio(state),
        recent_quote_jump_bps_avg=mean_decimal(state.quote_jump_bps_window),
        recent_quote_jump_bps_max=max_decimal(state.quote_jump_bps_window),
        recent_microprice_bias_bps_avg=mean_decimal(state.microprice_bias_bps_window),
        recent_above_opening_range_high_ratio=mean_decimal(
            state.above_opening_range_high_window
        ),
        recent_above_opening_window_close_ratio=mean_decimal(
            state.above_opening_window_close_window
        ),
        recent_above_vwap_w5m_ratio=mean_decimal(state.above_vwap_w5m_window),
        recent_15m_return_bps=recent_return_bps(
            state.price_history,
            current_ts=prepared.signal_ts_utc,
            current_price=prepared.price,
            lookback_minutes=15,
        ),
        price_vs_vwap_w5m_bps=bps_delta(prepared.price, signal_metrics.vwap_w5m),
        vwap_w5m_stretch_bps=_vwap_w5m_stretch_bps(prepared, signal_metrics),
    )


def _position_in_session_range(state: SymbolSessionState, price: Decimal) -> Decimal:
    session_range = state.session_high_price - state.session_low_price
    if session_range <= 0:
        return DEFAULT_POSITION_IN_RANGE
    position = (price - state.session_low_price) / session_range
    return min(Decimal("1"), max(Decimal("0"), position))


def _recent_quote_invalid_ratio(state: SymbolSessionState) -> Decimal | None:
    recent_quote_validity_avg = mean_decimal(state.quote_validity_window)
    if recent_quote_validity_avg is None:
        return None
    return Decimal("1") - recent_quote_validity_avg


def _vwap_w5m_stretch_bps(
    prepared: _PreparedSignal, metrics: _IntradaySignalMetrics
) -> Decimal | None:
    price_vs_vwap_w5m_bps = bps_delta(prepared.price, metrics.vwap_w5m)
    if price_vs_vwap_w5m_bps is None or metrics.microprice_bias_bps is None:
        return None
    return price_vs_vwap_w5m_bps - metrics.microprice_bias_bps


def _store_latest_executable_metrics(
    state: SymbolSessionState,
    price: _PriceMetrics,
    signal: _IntradaySignalMetrics,
    signal_ts_utc: datetime,
    minutes_elapsed: int,
) -> None:
    state.latest_price_vs_session_open_bps = price.price_vs_session_open_bps
    state.latest_price_vs_prev_session_close_bps = price.price_vs_prev_session_close_bps
    state.latest_price_position_in_session_range = price.position_in_range
    state.latest_recent_15m_return_bps = price.recent_15m_return_bps
    state.latest_microbar_volume = signal.microbar_volume
    state.latest_clusterlob_directional_ofi = signal.clusterlob_directional_ofi
    state.latest_price_vs_vwap_w5m_bps = price.price_vs_vwap_w5m_bps
    state.latest_opening_window_return_bps = price.opening_window_return_bps
    state.latest_opening_window_return_from_prev_close_bps = (
        price.opening_window_return_from_prev_close_bps
    )
    state.latest_recent_imbalance_pressure_avg = price.recent_imbalance_pressure_avg
    state.latest_recent_quote_invalid_ratio = price.recent_quote_invalid_ratio
    state.latest_recent_quote_jump_bps_avg = price.recent_quote_jump_bps_avg
    state.latest_recent_quote_jump_bps_max = price.recent_quote_jump_bps_max
    state.latest_recent_microprice_bias_bps_avg = price.recent_microprice_bias_bps_avg
    state.latest_vwap_w5m_stretch_bps = price.vwap_w5m_stretch_bps
    state.latest_rsi14 = signal.rsi14
    state.latest_macd_hist = signal.macd_hist
    state.latest_executable_metric_ts = signal_ts_utc
    if minutes_elapsed >= 45 and state.opening_45_return_bps is None:
        state.opening_45_return_bps = price.price_vs_session_open_bps
    if minutes_elapsed >= 60 and state.opening_60_return_bps is None:
        state.opening_60_return_bps = price.price_vs_session_open_bps


def _build_cross_section_metrics(ranks: _RankMetrics) -> _CrossSectionMetrics:
    effective_session_drive_rank = _prefer_decimal(
        ranks.prev_session_close.rank, ranks.session_open.rank
    )
    effective_opening_window_return_rank = _prefer_decimal(
        ranks.opening_window_prev_close_return.rank,
        ranks.opening_window_return.rank,
    )
    effective_positive_session_drive_ratio = _prefer_decimal(
        ranks.positive_prev_session_close_ratio,
        ranks.positive_session_open_ratio,
    )
    effective_positive_opening_window_return_ratio = _prefer_decimal(
        ranks.positive_opening_window_return_from_prev_close_ratio,
        ranks.positive_opening_window_return_ratio,
    )
    effective_session_drive_size = _prefer_size(
        ranks.prev_session_close, ranks.session_open
    )
    effective_opening_window_return_size = _prefer_size(
        ranks.opening_window_prev_close_return,
        ranks.opening_window_return,
    )
    continuation_size = rank_universe_size(
        [
            effective_session_drive_size,
            effective_opening_window_return_size,
            ranks.range_position.universe_size,
            ranks.vwap_w5m.universe_size,
            ranks.recent_imbalance.universe_size,
        ]
    )
    return _CrossSectionMetrics(
        continuation_breadth=average_decimal(
            [
                effective_positive_session_drive_ratio,
                effective_positive_opening_window_return_ratio,
                ranks.above_vwap_w5m_ratio,
                ranks.positive_recent_imbalance_ratio,
            ]
        ),
        continuation_rank=average_decimal(
            [
                effective_session_drive_rank,
                effective_opening_window_return_rank,
                ranks.range_position.rank,
                ranks.vwap_w5m.rank,
                ranks.recent_imbalance.rank,
            ]
        ),
        continuation_rank_universe_size=continuation_size,
        reversal_rank=average_decimal(
            [
                _inverse_rank(effective_session_drive_rank),
                _inverse_rank(effective_opening_window_return_rank),
                _inverse_rank(ranks.range_position.rank),
                _inverse_rank(ranks.vwap_w5m.rank),
                ranks.recent_imbalance.rank,
            ]
        ),
        reversal_rank_universe_size=continuation_size,
        factor_neutral_residual_rank=average_decimal(
            [
                effective_opening_window_return_rank,
                ranks.vwap_w5m.rank,
                ranks.recent_imbalance.rank,
                _inverse_rank(effective_session_drive_rank),
            ]
        ),
        factor_neutral_residual_rank_universe_size=rank_universe_size(
            [
                effective_opening_window_return_size,
                ranks.vwap_w5m.universe_size,
                ranks.recent_imbalance.universe_size,
                effective_session_drive_size,
            ]
        ),
        pair_relative_return_rank=average_decimal(
            [
                effective_session_drive_rank,
                effective_opening_window_return_rank,
                ranks.recent_15m_return.rank,
                ranks.clusterlob_directional_ofi.rank,
            ]
        ),
        pair_relative_return_rank_universe_size=rank_universe_size(
            [
                effective_session_drive_size,
                effective_opening_window_return_size,
                ranks.recent_15m_return.universe_size,
                ranks.clusterlob_directional_ofi.universe_size,
            ]
        ),
        residual_spread_zscore_rank=average_decimal(
            [
                average_decimal(
                    [
                        _inverse_rank(effective_session_drive_rank),
                        _inverse_rank(effective_opening_window_return_rank),
                        _inverse_rank(ranks.range_position.rank),
                        _inverse_rank(ranks.vwap_w5m.rank),
                        ranks.recent_imbalance.rank,
                    ]
                ),
                ranks.vwap_w5m_stretch.rank,
                _inverse_rank(ranks.recent_imbalance.rank),
            ]
        ),
        residual_spread_zscore_rank_universe_size=rank_universe_size(
            [
                continuation_size,
                ranks.vwap_w5m_stretch.universe_size,
                ranks.recent_imbalance.universe_size,
            ]
        ),
    )


def _prefer_decimal(
    preferred: Decimal | None, fallback: Decimal | None
) -> Decimal | None:
    return preferred if preferred is not None else fallback


def _prefer_size(preferred: _MetricRank, fallback: _MetricRank) -> int:
    return (
        preferred.universe_size
        if preferred.rank is not None
        else fallback.universe_size
    )


def _inverse_rank(value: Decimal | None) -> Decimal | None:
    return Decimal("1") - value if value is not None else None


def _payload_fields(
    state: SymbolSessionState,
    computed: _ComputedSessionMetrics,
    prepared: _PreparedSignal,
) -> dict[str, object]:
    price = computed.price
    signal = computed.signal
    ranks = computed.ranks
    cross = computed.cross_section
    return {
        "session_open_price": state.session_open_price,
        "prev_session_close_price": state.prev_session_close_price,
        "session_high_price": state.session_high_price,
        "session_low_price": state.session_low_price,
        "opening_range_high": state.opening_range_high,
        "opening_range_low": state.opening_range_low,
        "opening_window_close_price": state.opening_window_close_price,
        "opening_range_width_bps": price.opening_range_width_bps,
        "session_range_bps": price.session_range_bps,
        "price_vs_session_open_bps": price.price_vs_session_open_bps,
        "price_vs_prev_session_close_bps": price.price_vs_prev_session_close_bps,
        "opening_window_return_bps": price.opening_window_return_bps,
        "opening_window_return_from_prev_close_bps": (
            price.opening_window_return_from_prev_close_bps
        ),
        "price_vs_session_high_bps": price.price_vs_session_high_bps,
        "price_vs_session_low_bps": price.price_vs_session_low_bps,
        "price_vs_opening_range_high_bps": price.price_vs_opening_range_high_bps,
        "price_vs_opening_range_low_bps": price.price_vs_opening_range_low_bps,
        "price_vs_opening_window_close_bps": price.price_vs_opening_window_close_bps,
        "price_position_in_session_range": price.position_in_range,
        "recent_spread_bps_avg": price.recent_spread_bps_avg,
        "recent_spread_bps_max": price.recent_spread_bps_max,
        "recent_imbalance_pressure_avg": price.recent_imbalance_pressure_avg,
        "recent_quote_invalid_ratio": price.recent_quote_invalid_ratio,
        "recent_quote_jump_bps_avg": price.recent_quote_jump_bps_avg,
        "recent_quote_jump_bps_max": price.recent_quote_jump_bps_max,
        "recent_microprice_bias_bps_avg": price.recent_microprice_bias_bps_avg,
        "recent_above_opening_range_high_ratio": (
            price.recent_above_opening_range_high_ratio
        ),
        "recent_above_opening_window_close_ratio": (
            price.recent_above_opening_window_close_ratio
        ),
        "recent_above_vwap_w5m_ratio": price.recent_above_vwap_w5m_ratio,
        "recent_15m_return_bps": price.recent_15m_return_bps,
        "microbar_volume": signal.microbar_volume,
        "clusterlob_directional_ofi": signal.clusterlob_directional_ofi,
        "clusterlob_opportunistic_ofi": signal.clusterlob_opportunistic_ofi,
        "clusterlob_market_making_ofi": signal.clusterlob_market_making_ofi,
        "clusterlob_event_cluster_stability_score": (
            signal.clusterlob_event_cluster_stability_score
        ),
        "cross_section_session_open_rank": ranks.session_open.rank,
        "cross_section_session_open_rank_universe_size": (
            ranks.session_open.universe_size
        ),
        "cross_section_prev_session_close_rank": ranks.prev_session_close.rank,
        "cross_section_prev_session_close_rank_universe_size": (
            ranks.prev_session_close.universe_size
        ),
        "cross_section_opening_window_return_rank": (ranks.opening_window_return.rank),
        "cross_section_opening_window_return_rank_universe_size": (
            ranks.opening_window_return.universe_size
        ),
        "cross_section_opening_window_return_from_prev_close_rank": (
            ranks.opening_window_prev_close_return.rank
        ),
        "cross_section_opening_window_return_from_prev_close_rank_universe_size": (
            ranks.opening_window_prev_close_return.universe_size
        ),
        "cross_section_prev_day_open45_return_rank": (
            ranks.prev_day_open45_return.rank
        ),
        "cross_section_prev_day_open45_return_rank_universe_size": (
            ranks.prev_day_open45_return.universe_size
        ),
        "cross_section_prev_day_open60_return_rank": (
            ranks.prev_day_open60_return.rank
        ),
        "cross_section_prev_day_open60_return_rank_universe_size": (
            ranks.prev_day_open60_return.universe_size
        ),
        "cross_section_range_position_rank": ranks.range_position.rank,
        "cross_section_range_position_rank_universe_size": (
            ranks.range_position.universe_size
        ),
        "cross_section_vwap_w5m_rank": ranks.vwap_w5m.rank,
        "cross_section_vwap_w5m_rank_universe_size": ranks.vwap_w5m.universe_size,
        "cross_section_vwap_w5m_stretch_rank": ranks.vwap_w5m_stretch.rank,
        "cross_section_vwap_w5m_stretch_rank_universe_size": (
            ranks.vwap_w5m_stretch.universe_size
        ),
        "cross_section_recent_15m_return_rank": ranks.recent_15m_return.rank,
        "cross_section_recent_15m_return_rank_universe_size": (
            ranks.recent_15m_return.universe_size
        ),
        "cross_section_microbar_volume_rank": ranks.microbar_volume.rank,
        "cross_section_microbar_volume_rank_universe_size": (
            ranks.microbar_volume.universe_size
        ),
        "cross_section_clusterlob_directional_ofi_rank": (
            ranks.clusterlob_directional_ofi.rank
        ),
        "cross_section_clusterlob_directional_ofi_rank_universe_size": (
            ranks.clusterlob_directional_ofi.universe_size
        ),
        "cross_section_recent_imbalance_rank": ranks.recent_imbalance.rank,
        "cross_section_recent_imbalance_rank_universe_size": (
            ranks.recent_imbalance.universe_size
        ),
        "cross_section_rsi14_rank": ranks.rsi14.rank,
        "cross_section_rsi14_rank_universe_size": ranks.rsi14.universe_size,
        "cross_section_macd_hist_rank": ranks.macd_hist.rank,
        "cross_section_macd_hist_rank_universe_size": ranks.macd_hist.universe_size,
        "cross_section_positive_session_open_ratio": (
            ranks.positive_session_open_ratio
        ),
        "cross_section_positive_prev_session_close_ratio": (
            ranks.positive_prev_session_close_ratio
        ),
        "cross_section_positive_opening_window_return_ratio": (
            ranks.positive_opening_window_return_ratio
        ),
        "cross_section_positive_opening_window_return_from_prev_close_ratio": (
            ranks.positive_opening_window_return_from_prev_close_ratio
        ),
        "cross_section_positive_prev_day_open45_return_ratio": (
            ranks.positive_prev_day_open45_return_ratio
        ),
        "cross_section_positive_prev_day_open60_return_ratio": (
            ranks.positive_prev_day_open60_return_ratio
        ),
        "cross_section_above_vwap_w5m_ratio": ranks.above_vwap_w5m_ratio,
        "cross_section_positive_recent_imbalance_ratio": (
            ranks.positive_recent_imbalance_ratio
        ),
        "cross_section_continuation_breadth": cross.continuation_breadth,
        "cross_section_continuation_rank": cross.continuation_rank,
        "cross_section_continuation_rank_universe_size": (
            cross.continuation_rank_universe_size
        ),
        "cross_section_reversal_rank": cross.reversal_rank,
        "cross_section_reversal_rank_universe_size": cross.reversal_rank_universe_size,
        "cross_section_factor_neutral_residual_rank": (
            cross.factor_neutral_residual_rank
        ),
        "cross_section_factor_neutral_residual_rank_universe_size": (
            cross.factor_neutral_residual_rank_universe_size
        ),
        "cross_section_pair_relative_return_rank": cross.pair_relative_return_rank,
        "cross_section_pair_relative_return_rank_universe_size": (
            cross.pair_relative_return_rank_universe_size
        ),
        "cross_section_residual_spread_zscore_rank": (
            cross.residual_spread_zscore_rank
        ),
        "cross_section_residual_spread_zscore_rank_universe_size": (
            cross.residual_spread_zscore_rank_universe_size
        ),
        "session_minutes_elapsed": prepared.minutes_elapsed,
    }


__all__ = ["SessionContextTracker"]
