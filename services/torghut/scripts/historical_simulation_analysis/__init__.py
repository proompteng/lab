"""Historical simulation report analysis package."""

from __future__ import annotations

from typing import Any

from . import report_builder as _report_builder
from . import report_helpers as _report_helpers

REPORT_SCHEMA_VERSION = _report_helpers.REPORT_SCHEMA_VERSION
_ExecutionFill: Any = getattr(_report_helpers, "_ExecutionFill")
_FifoPnlState: Any = getattr(_report_helpers, "_FifoPnlState")
_as_decimal: Any = getattr(_report_helpers, "_as_decimal")
_build_last_price_map: Any = getattr(_report_helpers, "_build_last_price_map")
_build_report: Any = getattr(_report_builder, "_build_report")
_collect_clickhouse_stats: Any = getattr(_report_helpers, "_collect_clickhouse_stats")
_csv_write: Any = getattr(_report_helpers, "_csv_write")
_decimal_input_text: Any = getattr(_report_helpers, "_decimal_input_text")
_decimal_to_str: Any = getattr(_report_helpers, "_decimal_to_str")
_extract_run_scope_decisions: Any = getattr(
    _report_helpers, "_extract_run_scope_decisions"
)
_extract_signal_event_ts: Any = getattr(_report_helpers, "_extract_signal_event_ts")
_fifo_pnl_payload: Any = getattr(_report_helpers, "_fifo_pnl_payload")
_fifo_trade_pnl: Any = getattr(_report_helpers, "_fifo_trade_pnl")
_json_default: Any = getattr(_report_helpers, "_json_default")
_load_json: Any = getattr(_report_helpers, "_load_json")
_mean: Any = getattr(_report_helpers, "_mean")
_parse_args: Any = getattr(_report_helpers, "_parse_args")
_parse_optional_ts: Any = getattr(_report_helpers, "_parse_optional_ts")
_percentile: Any = getattr(_report_helpers, "_percentile")
_query_rows: Any = getattr(_report_helpers, "_query_rows")
_render_markdown: Any = getattr(_report_helpers, "_render_markdown")
_to_list_of_strings: Any = getattr(_report_helpers, "_to_list_of_strings")
_to_mapping: Any = getattr(_report_helpers, "_to_mapping")
main = _report_builder.main

__all__ = (
    "REPORT_SCHEMA_VERSION",
    "_ExecutionFill",
    "_FifoPnlState",
    "_as_decimal",
    "_build_last_price_map",
    "_build_report",
    "_collect_clickhouse_stats",
    "_csv_write",
    "_decimal_input_text",
    "_decimal_to_str",
    "_extract_run_scope_decisions",
    "_extract_signal_event_ts",
    "_fifo_pnl_payload",
    "_fifo_trade_pnl",
    "_json_default",
    "_load_json",
    "_mean",
    "_parse_args",
    "_parse_optional_ts",
    "_percentile",
    "_query_rows",
    "_render_markdown",
    "_to_list_of_strings",
    "_to_mapping",
    "main",
)
