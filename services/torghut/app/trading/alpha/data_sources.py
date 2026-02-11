"""Minimal market data sources for offline research.

These are for local/offline experimentation. Production data flow should remain:
WS forwarder -> Kafka -> Flink TA -> ClickHouse -> trading service.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from io import StringIO
from typing import Optional
from urllib.request import urlopen

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

    url = f"https://stooq.com/q/d/l/?s={cleaned}&i=d"
    with urlopen(url, timeout=30) as resp:
        raw = resp.read().decode("utf-8")

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

