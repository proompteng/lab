"""Command entrypoint for historical simulation report analysis."""

from __future__ import annotations

from typing import Any

from scripts import analyze_historical_simulation_modules as _analysis_modules

_as_decimal: Any = getattr(_analysis_modules, "_as_decimal")
_build_last_price_map: Any = getattr(_analysis_modules, "_build_last_price_map")
_build_report: Any = getattr(_analysis_modules, "_build_report")
_collect_clickhouse_stats: Any = getattr(_analysis_modules, "_collect_clickhouse_stats")
_csv_write: Any = getattr(_analysis_modules, "_csv_write")
_decimal_to_str: Any = getattr(_analysis_modules, "_decimal_to_str")
_extract_run_scope_decisions: Any = getattr(
    _analysis_modules, "_extract_run_scope_decisions"
)
_extract_signal_event_ts: Any = getattr(_analysis_modules, "_extract_signal_event_ts")
_fifo_trade_pnl: Any = getattr(_analysis_modules, "_fifo_trade_pnl")
_json_default: Any = getattr(_analysis_modules, "_json_default")
_load_json: Any = getattr(_analysis_modules, "_load_json")
_mean: Any = getattr(_analysis_modules, "_mean")
_parse_args: Any = getattr(_analysis_modules, "_parse_args")
_percentile: Any = getattr(_analysis_modules, "_percentile")
_query_rows: Any = getattr(_analysis_modules, "_query_rows")
_render_markdown: Any = getattr(_analysis_modules, "_render_markdown")
_to_list_of_strings: Any = getattr(_analysis_modules, "_to_list_of_strings")
_to_mapping: Any = getattr(_analysis_modules, "_to_mapping")
main = _analysis_modules.main

__all__ = (
    "_as_decimal",
    "_build_last_price_map",
    "_build_report",
    "_collect_clickhouse_stats",
    "_csv_write",
    "_decimal_to_str",
    "_extract_run_scope_decisions",
    "_extract_signal_event_ts",
    "_fifo_trade_pnl",
    "_json_default",
    "_load_json",
    "_mean",
    "_parse_args",
    "_percentile",
    "_query_rows",
    "_render_markdown",
    "_to_list_of_strings",
    "_to_mapping",
    "main",
)

if __name__ == "__main__":
    raise SystemExit(main())
