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


US_EQUITIES_TIMEZONE = "America/New_York"

REGULAR_OPEN_LOCAL = time(hour=9, minute=30)

REGULAR_CLOSE_LOCAL = time(hour=16, minute=0)

DEFAULT_OPENING_RANGE_MINUTES = 30

DEFAULT_RECENT_WINDOW = 30

DEFAULT_PRICE_HISTORY_WINDOW = 7200

DEFAULT_POSITION_IN_RANGE = Decimal("0.5")

_MARKET_TZ = ZoneInfo(US_EQUITIES_TIMEZONE)


def nyse_full_day_holidays(year: int) -> set[date]:
    holidays = {
        _nth_weekday(year, 1, 0, 3),
        _nth_weekday(year, 2, 0, 3),
        _easter_date(year) - timedelta(days=2),
        _last_weekday(year, 5, 0),
        _nth_weekday(year, 9, 0, 1),
        _nth_weekday(year, 11, 3, 4),
    }
    for holiday_year in (year, year + 1):
        for month, day in ((1, 1), (6, 19), (7, 4), (12, 25)):
            observed = _observed_fixed_holiday(holiday_year, month, day)
            if observed is not None and observed.year == year:
                holidays.add(observed)
    return holidays


def is_regular_equities_session_date(value: date) -> bool:
    return value.weekday() < 5 and value not in nyse_full_day_holidays(value.year)


def iter_regular_equities_session_dates(
    start_day: date, end_day: date
) -> tuple[date, ...]:
    if start_day > end_day:
        return ()
    days: list[date] = []
    current = start_day
    while current <= end_day:
        if is_regular_equities_session_date(current):
            days.append(current)
        current += timedelta(days=1)
    return tuple(days)


def most_recent_regular_equities_session_date(day: date) -> date:
    current = day
    while not is_regular_equities_session_date(current):
        current -= timedelta(days=1)
    return current


def _easter_date(year: int) -> date:
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    correction = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * correction) // 451
    month = (h + correction - 7 * m + 114) // 31
    day = ((h + correction - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    value = date(year, month, 1)
    offset = (weekday - value.weekday()) % 7
    return value + timedelta(days=offset + (nth - 1) * 7)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    value = date(year + int(month == 12), 1 if month == 12 else month + 1, 1)
    value -= timedelta(days=1)
    return value - timedelta(days=(value.weekday() - weekday) % 7)


def _observed_fixed_holiday(year: int, month: int, day: int) -> date | None:
    value = date(year, month, day)
    if value.weekday() == 5:
        return value - timedelta(days=1)
    if value.weekday() == 6:
        return value + timedelta(days=1)
    return value


def regular_session_open_utc_for(value: datetime | date) -> datetime:
    return _regular_session_boundary_utc_for(value, boundary=REGULAR_OPEN_LOCAL)


def regular_session_close_utc_for(value: datetime | date) -> datetime:
    return _regular_session_boundary_utc_for(value, boundary=REGULAR_CLOSE_LOCAL)


def _regular_session_boundary_utc_for(
    value: datetime | date, *, boundary: time
) -> datetime:
    if isinstance(value, datetime):
        aware = (
            value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        )
        session_day = aware.astimezone(_MARKET_TZ).date()
    else:
        session_day = value
    return datetime.combine(session_day, boundary, tzinfo=_MARKET_TZ).astimezone(
        timezone.utc
    )


def regular_session_minutes_elapsed(event_ts: datetime) -> int:
    ts_utc = (
        event_ts
        if event_ts.tzinfo is not None
        else event_ts.replace(tzinfo=timezone.utc)
    ).astimezone(timezone.utc)
    session_open = regular_session_open_utc_for(ts_utc)
    delta = ts_utc - session_open
    return max(0, int(delta.total_seconds() // 60))


def _extract_price(payload: dict[str, Any]) -> Decimal | None:
    return extract_price(payload)


def _extract_spread_bps(
    payload: dict[str, Any], price: Decimal | None
) -> Decimal | None:
    if price is None or price <= 0:
        return None
    spread_value = payload_value(payload, "spread")
    if spread_value is None:
        spread_value = payload_value(payload, "imbalance_spread")
    if spread_value is None:
        spread_value = nested_payload_value(payload, "imbalance", "spread")
    spread = optional_decimal(spread_value)
    if spread is None:
        return None
    return (abs(spread) / price) * Decimal("10000")


def _extract_imbalance_pressure(payload: dict[str, Any]) -> Decimal | None:
    bid_sz = optional_decimal(
        payload_value(
            payload, "imbalance_bid_sz", block="imbalance", nested_key="bid_sz"
        )
    )
    ask_sz = optional_decimal(
        payload_value(
            payload, "imbalance_ask_sz", block="imbalance", nested_key="ask_sz"
        )
    )
    if bid_sz is None or ask_sz is None:
        return None
    total = bid_sz + ask_sz
    if total <= 0:
        return None
    return (bid_sz - ask_sz) / total


def _extract_microprice_bias_bps(payload: dict[str, Any]) -> Decimal | None:
    bid_px = optional_decimal(
        payload_value(
            payload, "imbalance_bid_px", block="imbalance", nested_key="bid_px"
        )
    )
    ask_px = optional_decimal(
        payload_value(
            payload, "imbalance_ask_px", block="imbalance", nested_key="ask_px"
        )
    )
    bid_sz = optional_decimal(
        payload_value(
            payload, "imbalance_bid_sz", block="imbalance", nested_key="bid_sz"
        )
    )
    ask_sz = optional_decimal(
        payload_value(
            payload, "imbalance_ask_sz", block="imbalance", nested_key="ask_sz"
        )
    )
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
    return ((microprice - mid_price) / mid_price) * Decimal("10000")


def _bps_delta(price: Decimal | None, reference: Decimal | None) -> Decimal | None:
    if price is None or reference is None or reference == 0:
        return None
    return ((price - reference) / reference) * Decimal("10000")


def _recent_return_bps(
    price_history: deque[tuple[datetime, Decimal]],
    *,
    current_ts: datetime,
    current_price: Decimal,
    lookback_minutes: int,
) -> Decimal | None:
    cutoff_ts = current_ts - timedelta(minutes=lookback_minutes)
    for sample_ts, sample_price in reversed(price_history):
        if sample_ts <= cutoff_ts and sample_price > 0:
            return _bps_delta(current_price, sample_price)
    return None


def _mean_decimal(values: deque[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _max_decimal(values: deque[Decimal]) -> Decimal | None:
    if not values:
        return None
    return max(values)


def _average_decimal(values: list[Decimal | None]) -> Decimal | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    return sum(present, Decimal("0")) / Decimal(len(present))


def _ratio_decimal(values: list[bool]) -> Decimal | None:
    if not values:
        return None
    positive = sum(1 for item in values if item)
    return Decimal(positive) / Decimal(len(values))


def _rank_universe_size(values: list[int]) -> int:
    executable_values = [value for value in values if value > 0]
    if not executable_values:
        return 0
    return min(executable_values)


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
        return Decimal("1")
    for index, (candidate_symbol, _value) in enumerate(ordered):
        if candidate_symbol == normalized_symbol:
            return Decimal(index) / Decimal(len(ordered) - 1)
    return None


def _session_minutes_elapsed(event_ts: datetime) -> int:
    return regular_session_minutes_elapsed(event_ts)


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
    spread_bps_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    imbalance_pressure_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    quote_validity_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    quote_jump_bps_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    microprice_bias_bps_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    above_opening_range_high_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    above_opening_window_close_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    above_vwap_w5m_window: deque[Decimal] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_RECENT_WINDOW)
    )
    price_history: deque[tuple[datetime, Decimal]] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_PRICE_HISTORY_WINDOW)
    )
    latest_price_vs_session_open_bps: Decimal | None = None
    latest_price_vs_prev_session_close_bps: Decimal | None = None
    latest_price_position_in_session_range: Decimal | None = None
    latest_recent_15m_return_bps: Decimal | None = None
    latest_microbar_volume: Decimal | None = None
    latest_clusterlob_directional_ofi: Decimal | None = None
    latest_price_vs_vwap_w5m_bps: Decimal | None = None
    latest_opening_window_return_bps: Decimal | None = None
    latest_opening_window_return_from_prev_close_bps: Decimal | None = None
    latest_recent_imbalance_pressure_avg: Decimal | None = None
    latest_recent_quote_invalid_ratio: Decimal | None = None
    latest_recent_quote_jump_bps_avg: Decimal | None = None
    latest_recent_quote_jump_bps_max: Decimal | None = None
    latest_recent_microprice_bias_bps_avg: Decimal | None = None
    latest_vwap_w5m_stretch_bps: Decimal | None = None
    latest_rsi14: Decimal | None = None
    latest_macd_hist: Decimal | None = None
    latest_executable_metric_ts: datetime | None = None
    last_valid_quote_price: Decimal | None = None
    opening_45_return_bps: Decimal | None = None
    opening_60_return_bps: Decimal | None = None


__all__ = [name for name in globals() if not name.startswith("__")]
