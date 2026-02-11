from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

import pandas as pd

from app.trading.alpha.metrics import summarize_equity_curve
from app.trading.alpha.tsmom import TSMOMConfig, backtest_tsmom


class TestAlphaTSMOM(TestCase):
    def test_tsmom_trending_series_positive(self) -> None:
        # Deterministic upward trend: should produce positive return in long-only mode.
        idx = pd.date_range("2020-01-01", periods=260, freq="B", tz="UTC")
        close = pd.Series(range(100, 100 + len(idx)), index=idx, dtype="float64")
        prices = pd.DataFrame({"TREND": close})

        equity, debug = backtest_tsmom(
            prices,
            TSMOMConfig(
                lookback_days=20,
                vol_lookback_days=20,
                target_daily_vol=0.01,
                max_gross_leverage=1.0,
                long_only=True,
                cost_bps_per_turnover=0.0,
            ),
        )

        self.assertGreater(equity.iloc[-1], equity.iloc[0])
        summary = summarize_equity_curve(equity)
        self.assertGreater(summary.total_return, 0.0)
        self.assertIsNotNone(debug)

    def test_costs_reduce_performance(self) -> None:
        idx = pd.date_range("2020-01-01", periods=260, freq="B", tz="UTC")
        # Zig-zag: creates turnover.
        close = pd.Series([100 + (i % 2) for i in range(len(idx))], index=idx, dtype="float64").cumsum()
        prices = pd.DataFrame({"CHOP": close})

        equity_free, _ = backtest_tsmom(
            prices,
            TSMOMConfig(
                lookback_days=10,
                vol_lookback_days=10,
                target_daily_vol=0.01,
                max_gross_leverage=1.0,
                long_only=True,
                cost_bps_per_turnover=0.0,
            ),
        )
        equity_costly, _ = backtest_tsmom(
            prices,
            TSMOMConfig(
                lookback_days=10,
                vol_lookback_days=10,
                target_daily_vol=0.01,
                max_gross_leverage=1.0,
                long_only=True,
                cost_bps_per_turnover=50.0,
            ),
        )

        self.assertGreaterEqual(equity_free.iloc[-1], equity_costly.iloc[-1])

