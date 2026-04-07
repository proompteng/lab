"""Offline alpha research utilities.

This package is intentionally kept separate from the online trading loop. It is used for
backtests, walk-forward evaluation, and research iteration without coupling to ClickHouse
signal ingestion or broker execution.
"""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .lane import AlphaLaneResult, run_alpha_discovery_lane
    from .metrics import PerformanceSummary, summarize_equity_curve
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

_EXPORTS = {
    'PerformanceSummary': ('.metrics', 'PerformanceSummary'),
    'summarize_equity_curve': ('.metrics', 'summarize_equity_curve'),
    'AlphaLaneResult': ('.lane', 'AlphaLaneResult'),
    'run_alpha_discovery_lane': ('.lane', 'run_alpha_discovery_lane'),
    'SearchResult': ('.search', 'SearchResult'),
    'run_tsmom_grid_search': ('.search', 'run_tsmom_grid_search'),
    'TSMOMConfig': ('.tsmom', 'TSMOMConfig'),
    'backtest_tsmom': ('.tsmom', 'backtest_tsmom'),
}


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
    module_name, attribute = _EXPORTS[name]
    module = import_module(module_name, __name__)
    value = getattr(module, attribute)
    globals()[name] = value
    return value
