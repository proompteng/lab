from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from hypothesis import strategies as st

JANGAR_EQUITY_SYMBOLS = (
    'AAPL',
    'AMAT',
    'AMD',
    'AVGO',
    'GOOG',
    'INTC',
    'META',
    'MSFT',
    'MU',
    'NVDA',
    'PLTR',
    'SHOP',
)
CRYPTO_SYMBOLS = ('BTC/USD', 'ETH/USD')

_UTC_MIN = datetime(2026, 1, 1, tzinfo=timezone.utc)
_UTC_MAX = datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc)


def quantized_decimals(
    *,
    min_value: str,
    max_value: str,
    places: int,
) -> st.SearchStrategy[Decimal]:
    return st.decimals(
        min_value=Decimal(min_value),
        max_value=Decimal(max_value),
        allow_infinity=False,
        allow_nan=False,
        places=places,
    )


def positive_prices() -> st.SearchStrategy[Decimal]:
    return quantized_decimals(min_value='1.00', max_value='1000.00', places=4)


def non_negative_spreads() -> st.SearchStrategy[Decimal]:
    return quantized_decimals(min_value='0.0000', max_value='5.0000', places=4)


def executable_spread_bps() -> st.SearchStrategy[Decimal]:
    return quantized_decimals(min_value='0', max_value='50', places=4)


def positive_quantities() -> st.SearchStrategy[Decimal]:
    return quantized_decimals(min_value='0.0001', max_value='500.0000', places=4)


def position_quantities() -> st.SearchStrategy[Decimal]:
    return quantized_decimals(min_value='-500.0000', max_value='500.0000', places=4)


def size_decimals() -> st.SearchStrategy[Decimal]:
    return quantized_decimals(min_value='0', max_value='100000', places=0)


def utc_datetimes() -> st.SearchStrategy[datetime]:
    return st.datetimes(
        min_value=_UTC_MIN.replace(tzinfo=None),
        max_value=_UTC_MAX.replace(tzinfo=None),
        timezones=st.just(timezone.utc),
    )


def regular_session_datetimes() -> st.SearchStrategy[datetime]:
    return st.builds(
        lambda base_day, minute_offset, second_offset: datetime(
            base_day.year,
            base_day.month,
            base_day.day,
            13,
            30,
            tzinfo=timezone.utc,
        )
        + timedelta(minutes=minute_offset, seconds=second_offset),
        st.dates(min_value=_UTC_MIN.date(), max_value=_UTC_MAX.date()),
        st.integers(min_value=0, max_value=390),
        st.integers(min_value=0, max_value=59),
    )


def equity_symbols() -> st.SearchStrategy[str]:
    return st.sampled_from(JANGAR_EQUITY_SYMBOLS)


def crypto_symbols() -> st.SearchStrategy[str]:
    return st.sampled_from(CRYPTO_SYMBOLS)


def trading_symbols(*, include_crypto: bool = True) -> st.SearchStrategy[str]:
    if include_crypto:
        return st.sampled_from(JANGAR_EQUITY_SYMBOLS + CRYPTO_SYMBOLS)
    return equity_symbols()


def strategy_ids() -> st.SearchStrategy[str]:
    return st.sampled_from(
        (
            'intraday_tsmom_v1@prod',
            'breakout_continuation_long_v1@paper',
            'late_day_continuation_long_v1@paper',
            'mean_reversion_rebound_long_v1@paper',
        )
    )
