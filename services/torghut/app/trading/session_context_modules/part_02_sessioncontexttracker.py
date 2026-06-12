# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Stateful session-derived features for intraday strategy evaluation."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from ..features import (
    extract_price,
    nested_payload_value,
    optional_decimal,
    payload_value,
)
from ..models import SignalEnvelope
from ..quote_quality import QuoteQualityPolicy, assess_signal_quote_quality

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_21 import *


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
        self._last_opening_45_return_by_symbol: dict[str, Decimal] = {}
        self._last_opening_60_return_by_symbol: dict[str, Decimal] = {}

    def enrich_signal_payload(self, signal: SignalEnvelope) -> dict[str, Any]:
        payload = dict(signal.payload)
        price = _extract_price(payload)
        if price is None or price <= 0:
            return payload

        symbol = signal.symbol.strip().upper()
        signal_ts_utc = signal.event_ts.astimezone(timezone.utc)
        session_open_ts = regular_session_open_utc_for(signal_ts_utc)
        session_day = session_open_ts.astimezone(_MARKET_TZ).date()
        regular_session_started = signal_ts_utc >= session_open_ts
        self._roll_forward_completed_sessions(next_session_day=session_day)
        state = self._state_by_symbol.get(symbol)
        quote_quality = assess_signal_quote_quality(
            signal=signal,
            previous_price=(
                state.last_valid_quote_price if state is not None else None
            ),
            policy=self.quote_quality_policy,
        )
        if state is None:
            if not regular_session_started:
                previous_close = self._last_session_close_by_symbol.get(symbol)
                if previous_close is not None:
                    payload["prev_session_close_price"] = previous_close
                return payload
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
                above_opening_range_high_window=deque(maxlen=self.recent_window),
                above_opening_window_close_window=deque(maxlen=self.recent_window),
                above_vwap_w5m_window=deque(maxlen=self.recent_window),
                price_history=deque(maxlen=DEFAULT_PRICE_HISTORY_WINDOW),
            )
            self._state_by_symbol[symbol] = state

        minutes_elapsed = _session_minutes_elapsed(signal.event_ts)

        spread_bps = _extract_spread_bps(payload, price)
        imbalance_pressure = _extract_imbalance_pressure(payload)
        microprice_bias_bps = _extract_microprice_bias_bps(payload)
        rsi14 = optional_decimal(payload_value(payload, "rsi14", nested_key="rsi"))
        macd_hist = optional_decimal(
            payload_value(payload, "macd_hist", block="macd", nested_key="hist")
        )
        microbar_volume = optional_decimal(payload_value(payload, "microbar_volume"))
        if microbar_volume is None:
            microbar_volume = optional_decimal(payload_value(payload, "volume"))
        clusterlob_directional_ofi = optional_decimal(
            payload_value(payload, "clusterlob_directional_ofi")
        )
        clusterlob_opportunistic_ofi = optional_decimal(
            payload_value(payload, "clusterlob_opportunistic_ofi")
        )
        clusterlob_market_making_ofi = optional_decimal(
            payload_value(payload, "clusterlob_market_making_ofi")
        )
        clusterlob_event_cluster_stability_score = optional_decimal(
            payload_value(payload, "clusterlob_event_cluster_stability_score")
        )
        vwap_w5m = optional_decimal(
            payload_value(payload, "vwap_w5m", block="vwap", nested_key="w5m")
        )
        state.quote_validity_window.append(
            Decimal("1") if quote_quality.valid else Decimal("0")
        )
        if quote_quality.jump_bps is not None:
            state.quote_jump_bps_window.append(quote_quality.jump_bps)
        if quote_quality.valid:
            if state.last_valid_quote_price is None:
                state.session_open_price = price
                state.session_high_price = price
                state.session_low_price = price
                state.opening_range_high = price
                state.opening_range_low = price
                state.opening_window_close_price = price
            else:
                state.session_high_price = max(state.session_high_price, price)
                state.session_low_price = min(state.session_low_price, price)
                if minutes_elapsed <= self.opening_range_minutes:
                    state.opening_range_high = max(state.opening_range_high, price)
                    state.opening_range_low = min(state.opening_range_low, price)
                    state.opening_window_close_price = price
            if spread_bps is not None:
                state.spread_bps_window.append(spread_bps)
            if imbalance_pressure is not None:
                state.imbalance_pressure_window.append(imbalance_pressure)
            if microprice_bias_bps is not None:
                state.microprice_bias_bps_window.append(microprice_bias_bps)
            state.above_opening_range_high_window.append(
                Decimal("1") if price >= state.opening_range_high else Decimal("0")
            )
            state.above_opening_window_close_window.append(
                Decimal("1")
                if price >= state.opening_window_close_price
                else Decimal("0")
            )
            if vwap_w5m is not None:
                state.above_vwap_w5m_window.append(
                    Decimal("1") if price >= vwap_w5m else Decimal("0")
                )
            state.price_history.append((signal_ts_utc, price))
            state.last_valid_quote_price = price

        session_range = state.session_high_price - state.session_low_price
        position_in_range = DEFAULT_POSITION_IN_RANGE
        if session_range > 0:
            position_in_range = (price - state.session_low_price) / session_range
            position_in_range = min(
                Decimal("1"),
                max(Decimal("0"), position_in_range),
            )

        opening_range_width_bps = _bps_delta(
            state.opening_range_high, state.opening_range_low
        )
        session_range_bps = _bps_delta(
            state.session_high_price, state.session_low_price
        )
        price_vs_session_open_bps = _bps_delta(price, state.session_open_price)
        price_vs_prev_session_close_bps = _bps_delta(
            price, state.prev_session_close_price
        )
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
        price_vs_opening_window_close_bps = _bps_delta(
            price, state.opening_window_close_price
        )
        recent_spread_bps_avg = _mean_decimal(state.spread_bps_window)
        recent_spread_bps_max = _max_decimal(state.spread_bps_window)
        recent_imbalance_pressure_avg = _mean_decimal(state.imbalance_pressure_window)
        recent_quote_validity_avg = _mean_decimal(state.quote_validity_window)
        recent_quote_invalid_ratio = (
            Decimal("1") - recent_quote_validity_avg
            if recent_quote_validity_avg is not None
            else None
        )
        recent_quote_jump_bps_avg = _mean_decimal(state.quote_jump_bps_window)
        recent_quote_jump_bps_max = _max_decimal(state.quote_jump_bps_window)
        recent_microprice_bias_bps_avg = _mean_decimal(state.microprice_bias_bps_window)
        recent_above_opening_range_high_ratio = _mean_decimal(
            state.above_opening_range_high_window
        )
        recent_above_opening_window_close_ratio = _mean_decimal(
            state.above_opening_window_close_window
        )
        recent_above_vwap_w5m_ratio = _mean_decimal(state.above_vwap_w5m_window)
        recent_15m_return_bps = _recent_return_bps(
            state.price_history,
            current_ts=signal_ts_utc,
            current_price=price,
            lookback_minutes=15,
        )
        price_vs_vwap_w5m_bps = _bps_delta(price, vwap_w5m)
        vwap_w5m_stretch_bps = (
            price_vs_vwap_w5m_bps - microprice_bias_bps
            if price_vs_vwap_w5m_bps is not None and microprice_bias_bps is not None
            else None
        )

        if quote_quality.valid:
            state.latest_price_vs_session_open_bps = price_vs_session_open_bps
            state.latest_price_vs_prev_session_close_bps = (
                price_vs_prev_session_close_bps
            )
            state.latest_price_position_in_session_range = position_in_range
            state.latest_recent_15m_return_bps = recent_15m_return_bps
            state.latest_microbar_volume = microbar_volume
            state.latest_clusterlob_directional_ofi = clusterlob_directional_ofi
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
            state.latest_vwap_w5m_stretch_bps = vwap_w5m_stretch_bps
            state.latest_rsi14 = rsi14
            state.latest_macd_hist = macd_hist
            state.latest_executable_metric_ts = signal_ts_utc
            if minutes_elapsed >= 45 and state.opening_45_return_bps is None:
                state.opening_45_return_bps = price_vs_session_open_bps
            if minutes_elapsed >= 60 and state.opening_60_return_bps is None:
                state.opening_60_return_bps = price_vs_session_open_bps

        session_open_rank, session_open_rank_universe_size = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor="latest_price_vs_session_open_bps",
        )
        range_position_rank, range_position_rank_universe_size = (
            self._rank_latest_metric(
                current_day=session_day,
                symbol=symbol,
                accessor="latest_price_position_in_session_range",
            )
        )
        vwap_w5m_rank, vwap_w5m_rank_universe_size = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor="latest_price_vs_vwap_w5m_bps",
        )
        vwap_w5m_stretch_rank, vwap_w5m_stretch_rank_universe_size = (
            self._rank_latest_metric(
                current_day=session_day,
                symbol=symbol,
                accessor="latest_vwap_w5m_stretch_bps",
            )
        )
        recent_15m_return_rank, recent_15m_return_rank_universe_size = (
            self._rank_latest_metric(
                current_day=session_day,
                symbol=symbol,
                accessor="latest_recent_15m_return_bps",
            )
        )
        microbar_volume_rank, microbar_volume_rank_universe_size = (
            self._rank_latest_metric(
                current_day=session_day,
                symbol=symbol,
                accessor="latest_microbar_volume",
            )
        )
        (
            clusterlob_directional_ofi_rank,
            clusterlob_directional_ofi_rank_universe_size,
        ) = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor="latest_clusterlob_directional_ofi",
        )
        recent_imbalance_rank, recent_imbalance_rank_universe_size = (
            self._rank_latest_metric(
                current_day=session_day,
                symbol=symbol,
                accessor="latest_recent_imbalance_pressure_avg",
            )
        )
        rsi14_rank, rsi14_rank_universe_size = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor="latest_rsi14",
        )
        macd_hist_rank, macd_hist_rank_universe_size = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor="latest_macd_hist",
        )
        opening_window_return_rank, opening_window_return_rank_universe_size = (
            self._rank_latest_metric(
                current_day=session_day,
                symbol=symbol,
                accessor="latest_opening_window_return_bps",
            )
        )
        prev_session_close_rank, prev_session_close_rank_universe_size = (
            self._rank_latest_metric(
                current_day=session_day,
                symbol=symbol,
                accessor="latest_price_vs_prev_session_close_bps",
            )
        )
        (
            opening_window_prev_close_return_rank,
            opening_window_prev_close_return_rank_universe_size,
        ) = self._rank_latest_metric(
            current_day=session_day,
            symbol=symbol,
            accessor="latest_opening_window_return_from_prev_close_bps",
        )
        prev_day_open45_return_rank = _percentile_rank(
            self._last_opening_45_return_by_symbol,
            symbol=symbol,
        )
        prev_day_open45_return_rank_universe_size = len(
            self._last_opening_45_return_by_symbol
        )
        prev_day_open60_return_rank = _percentile_rank(
            self._last_opening_60_return_by_symbol,
            symbol=symbol,
        )
        prev_day_open60_return_rank_universe_size = len(
            self._last_opening_60_return_by_symbol
        )
        positive_session_open_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor="latest_price_vs_session_open_bps",
        )
        positive_opening_window_return_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor="latest_opening_window_return_bps",
        )
        positive_prev_session_close_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor="latest_price_vs_prev_session_close_bps",
        )
        positive_opening_window_return_from_prev_close_ratio = (
            self._positive_ratio_latest_metric(
                current_day=session_day,
                accessor="latest_opening_window_return_from_prev_close_bps",
            )
        )
        above_vwap_w5m_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor="latest_price_vs_vwap_w5m_bps",
        )
        positive_recent_imbalance_ratio = self._positive_ratio_latest_metric(
            current_day=session_day,
            accessor="latest_recent_imbalance_pressure_avg",
        )
        positive_prev_day_open45_return_ratio = _ratio_decimal(
            [value > 0 for value in self._last_opening_45_return_by_symbol.values()]
        )
        positive_prev_day_open60_return_ratio = _ratio_decimal(
            [value > 0 for value in self._last_opening_60_return_by_symbol.values()]
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
        effective_session_drive_rank_universe_size = (
            prev_session_close_rank_universe_size
            if prev_session_close_rank is not None
            else session_open_rank_universe_size
        )
        effective_opening_window_return_rank_universe_size = (
            opening_window_prev_close_return_rank_universe_size
            if opening_window_prev_close_return_rank is not None
            else opening_window_return_rank_universe_size
        )
        cross_section_continuation_rank_universe_size = _rank_universe_size(
            [
                effective_session_drive_rank_universe_size,
                effective_opening_window_return_rank_universe_size,
                range_position_rank_universe_size,
                vwap_w5m_rank_universe_size,
                recent_imbalance_rank_universe_size,
            ]
        )
        cross_section_reversal_rank = _average_decimal(
            [
                (
                    Decimal("1") - effective_session_drive_rank
                    if effective_session_drive_rank is not None
                    else None
                ),
                (
                    Decimal("1") - effective_opening_window_return_rank
                    if effective_opening_window_return_rank is not None
                    else None
                ),
                (
                    Decimal("1") - range_position_rank
                    if range_position_rank is not None
                    else None
                ),
                (Decimal("1") - vwap_w5m_rank if vwap_w5m_rank is not None else None),
                recent_imbalance_rank,
            ]
        )
        cross_section_reversal_rank_universe_size = (
            cross_section_continuation_rank_universe_size
        )
        cross_section_factor_neutral_residual_rank = _average_decimal(
            [
                effective_opening_window_return_rank,
                vwap_w5m_rank,
                recent_imbalance_rank,
                (
                    Decimal("1") - effective_session_drive_rank
                    if effective_session_drive_rank is not None
                    else None
                ),
            ]
        )
        cross_section_factor_neutral_residual_rank_universe_size = _rank_universe_size(
            [
                effective_opening_window_return_rank_universe_size,
                vwap_w5m_rank_universe_size,
                recent_imbalance_rank_universe_size,
                effective_session_drive_rank_universe_size,
            ]
        )
        cross_section_pair_relative_return_rank = _average_decimal(
            [
                effective_session_drive_rank,
                effective_opening_window_return_rank,
                recent_15m_return_rank,
                clusterlob_directional_ofi_rank,
            ]
        )
        cross_section_pair_relative_return_rank_universe_size = _rank_universe_size(
            [
                effective_session_drive_rank_universe_size,
                effective_opening_window_return_rank_universe_size,
                recent_15m_return_rank_universe_size,
                clusterlob_directional_ofi_rank_universe_size,
            ]
        )
        cross_section_residual_spread_zscore_rank = _average_decimal(
            [
                cross_section_reversal_rank,
                vwap_w5m_stretch_rank,
                (
                    Decimal("1") - recent_imbalance_rank
                    if recent_imbalance_rank is not None
                    else None
                ),
            ]
        )
        cross_section_residual_spread_zscore_rank_universe_size = _rank_universe_size(
            [
                cross_section_reversal_rank_universe_size,
                vwap_w5m_stretch_rank_universe_size,
                recent_imbalance_rank_universe_size,
            ]
        )

        payload.update(
            {
                "session_open_price": state.session_open_price,
                "prev_session_close_price": state.prev_session_close_price,
                "session_high_price": state.session_high_price,
                "session_low_price": state.session_low_price,
                "opening_range_high": state.opening_range_high,
                "opening_range_low": state.opening_range_low,
                "opening_window_close_price": state.opening_window_close_price,
                "opening_range_width_bps": opening_range_width_bps,
                "session_range_bps": session_range_bps,
                "price_vs_session_open_bps": price_vs_session_open_bps,
                "price_vs_prev_session_close_bps": price_vs_prev_session_close_bps,
                "opening_window_return_bps": opening_window_return_bps,
                "opening_window_return_from_prev_close_bps": opening_window_return_from_prev_close_bps,
                "price_vs_session_high_bps": price_vs_session_high_bps,
                "price_vs_session_low_bps": price_vs_session_low_bps,
                "price_vs_opening_range_high_bps": price_vs_opening_range_high_bps,
                "price_vs_opening_range_low_bps": price_vs_opening_range_low_bps,
                "price_vs_opening_window_close_bps": price_vs_opening_window_close_bps,
                "price_position_in_session_range": position_in_range,
                "recent_spread_bps_avg": recent_spread_bps_avg,
                "recent_spread_bps_max": recent_spread_bps_max,
                "recent_imbalance_pressure_avg": recent_imbalance_pressure_avg,
                "recent_quote_invalid_ratio": recent_quote_invalid_ratio,
                "recent_quote_jump_bps_avg": recent_quote_jump_bps_avg,
                "recent_quote_jump_bps_max": recent_quote_jump_bps_max,
                "recent_microprice_bias_bps_avg": recent_microprice_bias_bps_avg,
                "recent_above_opening_range_high_ratio": recent_above_opening_range_high_ratio,
                "recent_above_opening_window_close_ratio": recent_above_opening_window_close_ratio,
                "recent_above_vwap_w5m_ratio": recent_above_vwap_w5m_ratio,
                "recent_15m_return_bps": recent_15m_return_bps,
                "microbar_volume": microbar_volume,
                "clusterlob_directional_ofi": clusterlob_directional_ofi,
                "clusterlob_opportunistic_ofi": clusterlob_opportunistic_ofi,
                "clusterlob_market_making_ofi": clusterlob_market_making_ofi,
                "clusterlob_event_cluster_stability_score": (
                    clusterlob_event_cluster_stability_score
                ),
                "cross_section_session_open_rank": session_open_rank,
                "cross_section_session_open_rank_universe_size": session_open_rank_universe_size,
                "cross_section_prev_session_close_rank": prev_session_close_rank,
                "cross_section_prev_session_close_rank_universe_size": prev_session_close_rank_universe_size,
                "cross_section_opening_window_return_rank": opening_window_return_rank,
                "cross_section_opening_window_return_rank_universe_size": opening_window_return_rank_universe_size,
                "cross_section_opening_window_return_from_prev_close_rank": (
                    opening_window_prev_close_return_rank
                ),
                "cross_section_opening_window_return_from_prev_close_rank_universe_size": (
                    opening_window_prev_close_return_rank_universe_size
                ),
                "cross_section_prev_day_open45_return_rank": prev_day_open45_return_rank,
                "cross_section_prev_day_open45_return_rank_universe_size": prev_day_open45_return_rank_universe_size,
                "cross_section_prev_day_open60_return_rank": prev_day_open60_return_rank,
                "cross_section_prev_day_open60_return_rank_universe_size": prev_day_open60_return_rank_universe_size,
                "cross_section_range_position_rank": range_position_rank,
                "cross_section_range_position_rank_universe_size": range_position_rank_universe_size,
                "cross_section_vwap_w5m_rank": vwap_w5m_rank,
                "cross_section_vwap_w5m_rank_universe_size": vwap_w5m_rank_universe_size,
                "cross_section_vwap_w5m_stretch_rank": vwap_w5m_stretch_rank,
                "cross_section_vwap_w5m_stretch_rank_universe_size": vwap_w5m_stretch_rank_universe_size,
                "cross_section_recent_15m_return_rank": recent_15m_return_rank,
                "cross_section_recent_15m_return_rank_universe_size": recent_15m_return_rank_universe_size,
                "cross_section_microbar_volume_rank": microbar_volume_rank,
                "cross_section_microbar_volume_rank_universe_size": microbar_volume_rank_universe_size,
                "cross_section_clusterlob_directional_ofi_rank": (
                    clusterlob_directional_ofi_rank
                ),
                "cross_section_clusterlob_directional_ofi_rank_universe_size": (
                    clusterlob_directional_ofi_rank_universe_size
                ),
                "cross_section_recent_imbalance_rank": recent_imbalance_rank,
                "cross_section_recent_imbalance_rank_universe_size": recent_imbalance_rank_universe_size,
                "cross_section_rsi14_rank": rsi14_rank,
                "cross_section_rsi14_rank_universe_size": rsi14_rank_universe_size,
                "cross_section_macd_hist_rank": macd_hist_rank,
                "cross_section_macd_hist_rank_universe_size": macd_hist_rank_universe_size,
                "cross_section_positive_session_open_ratio": positive_session_open_ratio,
                "cross_section_positive_prev_session_close_ratio": positive_prev_session_close_ratio,
                "cross_section_positive_opening_window_return_ratio": positive_opening_window_return_ratio,
                "cross_section_positive_opening_window_return_from_prev_close_ratio": (
                    positive_opening_window_return_from_prev_close_ratio
                ),
                "cross_section_positive_prev_day_open45_return_ratio": (
                    positive_prev_day_open45_return_ratio
                ),
                "cross_section_positive_prev_day_open60_return_ratio": (
                    positive_prev_day_open60_return_ratio
                ),
                "cross_section_above_vwap_w5m_ratio": above_vwap_w5m_ratio,
                "cross_section_positive_recent_imbalance_ratio": positive_recent_imbalance_ratio,
                "cross_section_continuation_breadth": cross_section_continuation_breadth,
                "cross_section_continuation_rank": cross_section_continuation_rank,
                "cross_section_continuation_rank_universe_size": cross_section_continuation_rank_universe_size,
                "cross_section_reversal_rank": cross_section_reversal_rank,
                "cross_section_reversal_rank_universe_size": cross_section_reversal_rank_universe_size,
                "cross_section_factor_neutral_residual_rank": cross_section_factor_neutral_residual_rank,
                "cross_section_factor_neutral_residual_rank_universe_size": cross_section_factor_neutral_residual_rank_universe_size,
                "cross_section_pair_relative_return_rank": cross_section_pair_relative_return_rank,
                "cross_section_pair_relative_return_rank_universe_size": cross_section_pair_relative_return_rank_universe_size,
                "cross_section_residual_spread_zscore_rank": cross_section_residual_spread_zscore_rank,
                "cross_section_residual_spread_zscore_rank_universe_size": cross_section_residual_spread_zscore_rank_universe_size,
                "session_minutes_elapsed": minutes_elapsed,
            }
        )
        return payload

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
        return _percentile_rank(values, symbol=symbol), len(values)

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
        return _ratio_decimal(values)


__all__ = [name for name in globals() if not name.startswith("__")]
