from __future__ import annotations

from datetime import date

import pandas as pd

from app.trading.alpha.tsmom import TSMOMConfig, backtest_tsmom


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
