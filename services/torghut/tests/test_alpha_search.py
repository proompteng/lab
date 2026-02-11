from __future__ import annotations

from unittest import TestCase

import pandas as pd

from app.trading.alpha.search import run_tsmom_grid_search


class TestAlphaSearch(TestCase):
    def test_grid_search_returns_accepted_candidate_on_trend(self) -> None:
        idx = pd.date_range('2010-01-01', periods=520, freq='B', tz='UTC')
        px_a = pd.Series(range(100, 100 + len(idx)), index=idx, dtype='float64')
        px_b = pd.Series(range(200, 200 + len(idx)), index=idx, dtype='float64')
        prices = pd.DataFrame({'A': px_a, 'B': px_b})

        train = prices.iloc[:360]
        test = prices.iloc[360:]

        result = run_tsmom_grid_search(
            train,
            test,
            lookback_days=[20, 40, 60],
            vol_lookback_days=[10, 20],
            target_daily_vols=[0.0075, 0.01],
            max_gross_leverages=[0.75, 1.0],
            long_only=True,
            cost_bps_per_turnover=5.0,
        )

        self.assertTrue(result.accepted)
        self.assertGreater(result.best.test.total_return, 0.0)
        self.assertGreaterEqual(len(result.candidates), 1)

