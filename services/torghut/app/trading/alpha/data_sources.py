"""Minimal market data sources for offline research.

These are for local/offline experimentation. Production data flow should remain:
WS forwarder -> Kafka -> Flink TA -> ClickHouse -> trading service.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from http.client import HTTPConnection, HTTPSConnection
from io import StringIO
from typing import Optional
from urllib.parse import urlencode, urlsplit

import pandas as pd


@dataclass(frozen=True)
class DailyBars:
    """Standardized OHLCV daily bars."""

    df: pd.DataFrame

    @property
    def close(self) -> pd.Series:
        return self.df["close"]


def fetch_stooq_daily(symbol: str, *, start: Optional[date] = None, end: Optional[date] = None) -> DailyBars:
    """Fetch daily OHLCV bars from Stooq.

    Stooq symbols are typically lowercase and region qualified, e.g.:
    - "spy.us"
    - "aapl.us"
    """

    cleaned = symbol.strip().lower()
    if not cleaned:
        raise ValueError("symbol is required")

    query = urlencode({'s': cleaned, 'i': 'd'})
    url = f'https://stooq.com/q/d/l/?{query}'
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        raise ValueError(f"unsupported Stooq URL scheme: {scheme or 'missing'}")
    if not parsed.hostname:
        raise ValueError('invalid Stooq URL host')

    path = parsed.path or '/'
    if parsed.query:
        path = f'{path}?{parsed.query}'
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port, timeout=30)
    try:
        connection.request('GET', path, headers={'accept': 'text/csv'})
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            raise ValueError(f'stooq request failed with status={response.status}')
        raw = response.read().decode('utf-8')
    finally:
        connection.close()

    df = pd.read_csv(StringIO(raw))
    if df.empty:
        raise ValueError(f"no data returned for symbol={symbol}")

    # Standardize.
    columns = {c.lower(): c for c in df.columns}
    date_col = columns.get("date")
    if date_col is None:
        raise ValueError("stooq response missing Date column")
    df[date_col] = pd.to_datetime(df[date_col], utc=True)
    df = df.rename(
        columns={
            columns.get("open", "Open"): "open",
            columns.get("high", "High"): "high",
            columns.get("low", "Low"): "low",
            columns.get("close", "Close"): "close",
            columns.get("volume", "Volume"): "volume",
            date_col: "date",
        }
    )

    keep = [c for c in ["date", "open", "high", "low", "close", "volume"] if c in df.columns]
    df = df[keep].sort_values("date").dropna(subset=["date", "close"])

    if start is not None:
        df = df[df["date"].dt.date >= start]
    if end is not None:
        df = df[df["date"].dt.date <= end]

    df = df.set_index("date")
    return DailyBars(df=df)


__all__ = ["DailyBars", "fetch_stooq_daily"]
