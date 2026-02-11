"""Performance metrics for offline research runs."""

from __future__ import annotations

from dataclasses import dataclass
from math import sqrt
from typing import Optional

import pandas as pd


@dataclass(frozen=True)
class PerformanceSummary:
    total_return: float
    cagr: Optional[float]
    annualized_vol: Optional[float]
    sharpe: Optional[float]
    max_drawdown: Optional[float]
    days: int


def summarize_equity_curve(equity: pd.Series, *, periods_per_year: int = 252) -> PerformanceSummary:
    """Summarize an equity curve (indexed by datetime)."""

    if equity.empty:
        raise ValueError("equity series is empty")

    equity = equity.dropna()
    if len(equity) < 2:
        return PerformanceSummary(
            total_return=0.0,
            cagr=None,
            annualized_vol=None,
            sharpe=None,
            max_drawdown=None,
            days=int(len(equity)),
        )

    rets = equity.pct_change(fill_method=None).dropna()
    total_return = float(equity.iloc[-1] / equity.iloc[0] - 1.0)

    days = int(len(rets))
    years = days / float(periods_per_year)
    cagr = None
    if years > 0:
        cagr = float((equity.iloc[-1] / equity.iloc[0]) ** (1.0 / years) - 1.0)

    annualized_vol = None
    sharpe = None
    if rets.std(ddof=0) > 0:
        annualized_vol = float(rets.std(ddof=0) * sqrt(periods_per_year))
        sharpe = float((rets.mean() / rets.std(ddof=0)) * sqrt(periods_per_year))

    running_max = equity.cummax()
    dd = (equity / running_max) - 1.0
    max_drawdown = float(dd.min()) if not dd.empty else None

    return PerformanceSummary(
        total_return=total_return,
        cagr=cagr,
        annualized_vol=annualized_vol,
        sharpe=sharpe,
        max_drawdown=max_drawdown,
        days=days,
    )


def to_jsonable(summary: PerformanceSummary) -> dict[str, object]:
    return {
        "total_return": summary.total_return,
        "cagr": summary.cagr,
        "annualized_vol": summary.annualized_vol,
        "sharpe": summary.sharpe,
        "max_drawdown": summary.max_drawdown,
        "days": summary.days,
    }


__all__ = ["PerformanceSummary", "summarize_equity_curve", "to_jsonable"]
