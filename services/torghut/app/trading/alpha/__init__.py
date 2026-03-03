"""Offline alpha research utilities.

This package is intentionally kept separate from the online trading loop. It is used for
backtests, walk-forward evaluation, and research iteration without coupling to ClickHouse
signal ingestion or broker execution.
"""

from .metrics import PerformanceSummary, summarize_equity_curve
from .lane import AlphaLaneResult, run_alpha_discovery_lane
from .search import SearchResult, run_tsmom_grid_search
from .tsmom import TSMOMConfig, backtest_tsmom

__all__ = [
    "PerformanceSummary",
    "SearchResult",
    "AlphaLaneResult",
    "TSMOMConfig",
    "backtest_tsmom",
    "run_alpha_discovery_lane",
    "run_tsmom_grid_search",
    "summarize_equity_curve",
]
