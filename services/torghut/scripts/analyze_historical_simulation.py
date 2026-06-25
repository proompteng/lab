"""Command entrypoint for historical simulation report analysis."""

from __future__ import annotations

from scripts.historical_simulation_analysis import (
    _as_decimal,
    _build_last_price_map,
    _build_report,
    _collect_clickhouse_stats,
    _csv_write,
    _decimal_to_str,
    _extract_run_scope_decisions,
    _extract_signal_event_ts,
    _fifo_trade_pnl,
    _json_default,
    _load_json,
    _mean,
    _parse_args,
    _percentile,
    _query_rows,
    _render_markdown,
    _to_list_of_strings,
    _to_mapping,
    main,
)

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
