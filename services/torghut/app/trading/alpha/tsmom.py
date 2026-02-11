"""Time-series momentum (trend) baseline backtest.

This is an *offline* research tool, not the online decision engine.

Model:
- Signal: sign(lookback return) using data up to t-1
  - return_L[t] = close[t-1] / close[t-L-1] - 1
- Risk targeting: weight ~ target_vol / realized_vol
- Portfolio constraints: gross leverage cap (scale down across symbols)
- Costs: proportional to daily turnover (bps per unit turnover)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class TSMOMConfig:
    lookback_days: int = 60
    vol_lookback_days: int = 20
    target_daily_vol: float = 0.01
    max_gross_leverage: float = 1.0
    long_only: bool = True
    cost_bps_per_turnover: float = 5.0
    start: Optional[date] = None
    end: Optional[date] = None


def backtest_tsmom(prices: pd.DataFrame, cfg: TSMOMConfig) -> tuple[pd.Series, pd.DataFrame]:
    """Backtest TSMOM on a price matrix.

    Args:
      prices: DataFrame indexed by datetime, columns are symbols, values are closes.
      cfg: strategy configuration

    Returns:
      (equity_curve, debug_frame)
    """

    if prices.empty:
        raise ValueError("prices is empty")
    if cfg.lookback_days <= 1:
        raise ValueError("lookback_days must be > 1")
    if cfg.vol_lookback_days <= 1:
        raise ValueError("vol_lookback_days must be > 1")
    if cfg.target_daily_vol <= 0:
        raise ValueError("target_daily_vol must be > 0")
    if cfg.max_gross_leverage <= 0:
        raise ValueError("max_gross_leverage must be > 0")
    if cfg.cost_bps_per_turnover < 0:
        raise ValueError("cost_bps_per_turnover must be >= 0")

    px = prices.copy()
    px = px.sort_index().dropna(how="all")
    if cfg.start is not None:
        px = px[px.index.date >= cfg.start]
    if cfg.end is not None:
        px = px[px.index.date <= cfg.end]
    px = px.dropna(axis=1, how="all")
    if px.empty:
        raise ValueError("prices empty after filtering")

    rets = px.pct_change(fill_method=None)

    # Lookback return uses up-to t-1 information.
    lookback_ret = px.shift(1) / px.shift(cfg.lookback_days + 1) - 1.0
    signal = np.sign(lookback_ret)
    if cfg.long_only:
        signal = signal.clip(lower=0.0)

    # Volatility estimate uses returns up to t-1.
    vol = rets.rolling(cfg.vol_lookback_days).std(ddof=0).shift(1)
    inv_vol = cfg.target_daily_vol / vol
    raw_w = signal * inv_vol
    raw_w = raw_w.replace([np.inf, -np.inf], np.nan).fillna(0.0)

    # Clip per-asset weight (pre-scale).
    raw_w = raw_w.clip(lower=-cfg.max_gross_leverage, upper=cfg.max_gross_leverage)

    gross = raw_w.abs().sum(axis=1)
    scale = (cfg.max_gross_leverage / gross).clip(upper=1.0).fillna(0.0)
    w = raw_w.mul(scale, axis=0)

    # Held weight at time t applies to return at time t (because weights are computed with shift(1) already).
    port_ret_gross = (w * rets).sum(axis=1).fillna(0.0)

    turnover = w.diff().abs().sum(axis=1).fillna(0.0)
    cost_ret = turnover * (cfg.cost_bps_per_turnover / 10000.0)
    port_ret_net = port_ret_gross - cost_ret

    equity = (1.0 + port_ret_net).cumprod()
    equity.name = "equity"

    debug = pd.DataFrame(
        {
            "port_ret_gross": port_ret_gross,
            "turnover": turnover,
            "cost_ret": cost_ret,
            "port_ret_net": port_ret_net,
            "gross_leverage": w.abs().sum(axis=1),
        }
    )
    return equity, debug


__all__ = ["TSMOMConfig", "backtest_tsmom"]
