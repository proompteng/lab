from __future__ import annotations

from datetime import date

import pandas as pd
import pytest

from app.trading.alpha.tsmom import (
    TSMOMConfig,
    _compute_portfolio_returns,
    backtest_tsmom,
)


def test_backtest_tsmom_filters_dates_and_reports_debug_columns() -> None:
    prices = pd.DataFrame(
        {
            "AAPL": [100, 101, 103, 106, 110, 115, 121, 128],
            "MSFT": [50, 50, 49, 50, 51, 53, 54, 55],
        },
        index=pd.date_range("2026-01-01", periods=8, freq="D", tz="UTC"),
    )

    equity, debug = backtest_tsmom(
        prices,
        TSMOMConfig(
            lookback_days=2,
            vol_lookback_days=2,
            start=date(2026, 1, 2),
            end=date(2026, 1, 8),
            long_only=True,
            cost_bps_per_turnover=1.0,
        ),
    )

    assert not equity.empty
    assert equity.index.min().date() >= date(2026, 1, 2)
    assert {
        "port_ret_gross",
        "turnover",
        "cost_ret",
        "port_ret_net",
        "gross_leverage",
    }.issubset(debug.columns)
    assert debug["gross_leverage"].max() <= 1.0


def test_portfolio_returns_charge_initial_rebalance_from_cash() -> None:
    index = pd.date_range("2026-01-01", periods=2, freq="D", tz="UTC")
    weights = pd.DataFrame(
        {
            "AAPL": [0.4, 0.1],
            "MSFT": [-0.2, -0.1],
        },
        index=index,
    )
    rets = pd.DataFrame(0.0, index=index, columns=weights.columns)

    _, turnover, cost_ret, port_ret_net = _compute_portfolio_returns(
        weights,
        rets,
        TSMOMConfig(cost_bps_per_turnover=10.0),
    )

    assert turnover.tolist() == pytest.approx([0.6, 0.4])
    assert cost_ret.tolist() == pytest.approx([0.0006, 0.0004])
    assert port_ret_net.tolist() == pytest.approx([-0.0006, -0.0004])
