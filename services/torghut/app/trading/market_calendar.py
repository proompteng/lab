"""Regular-session calendar helpers for US equities research artifacts."""

from __future__ import annotations

from datetime import date, timedelta


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


def _observed_fixed_holiday(year: int, month: int, day: int) -> date:
    value = date(year, month, day)
    if value.weekday() == 5:
        return value - timedelta(days=1)
    if value.weekday() == 6:
        return value + timedelta(days=1)
    return value


def nyse_full_day_holidays(year: int) -> frozenset[date]:
    holidays = {
        _nth_weekday(year, 1, 0, 3),
        _nth_weekday(year, 2, 0, 3),
        _easter_date(year) - timedelta(days=2),
        _last_weekday(year, 5, 0),
        _nth_weekday(year, 9, 0, 1),
        _nth_weekday(year, 11, 3, 4),
    }
    for fixed_year in (year - 1, year, year + 1):
        for month, day in ((1, 1), (7, 4), (12, 25)):
            observed = _observed_fixed_holiday(fixed_year, month, day)
            if observed.year == year:
                holidays.add(observed)
        if fixed_year >= 2022:
            observed = _observed_fixed_holiday(fixed_year, 6, 19)
            if observed.year == year:
                holidays.add(observed)
    return frozenset(holidays)


def is_regular_equities_session_day(value: date) -> bool:
    return value.weekday() < 5 and value not in nyse_full_day_holidays(value.year)


def regular_equities_session_days(start_day: date, end_day: date) -> tuple[date, ...]:
    if start_day > end_day:
        return ()
    current = start_day
    values: list[date] = []
    while current <= end_day:
        if is_regular_equities_session_day(current):
            values.append(current)
        current += timedelta(days=1)
    return tuple(values)


__all__ = [
    "is_regular_equities_session_day",
    "nyse_full_day_holidays",
    "regular_equities_session_days",
]
