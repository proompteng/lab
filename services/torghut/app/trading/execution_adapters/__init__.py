"""Execution adapter package exports."""

from __future__ import annotations

from ..simulation_progress import active_simulation_runtime_context
from .adapter_types import (
    AlpacaExecutionAdapter,
    ExecutionAdapter,
    OrderSubmission,
    SimulationExecutionAdapter,
    logger,
)
from .lean_adapter import LeanExecutionAdapter, build_execution_adapter
from .order_text import (
    classify_failure_taxonomy,
    classify_fallback_reason,
    decimal_to_order_text,
    error_summary,
    float_to_order_text,
    http_request_text,
    is_http_status_error,
    optional_decimal,
    positive_decimal,
    resolve_simulation_context_payload,
    signed_decimal_to_text,
    signed_position_market_value,
)
from .simulation_orders import (
    resolve_simulated_fill_price,
    resolve_simulated_filled_qty,
    resolve_simulation_event_ts,
    simulated_order_status,
    simulated_trade_update_event,
)

__all__ = [
    "AlpacaExecutionAdapter",
    "ExecutionAdapter",
    "LeanExecutionAdapter",
    "OrderSubmission",
    "SimulationExecutionAdapter",
    "classify_failure_taxonomy",
    "classify_fallback_reason",
    "decimal_to_order_text",
    "error_summary",
    "float_to_order_text",
    "http_request_text",
    "is_http_status_error",
    "optional_decimal",
    "positive_decimal",
    "resolve_simulated_fill_price",
    "resolve_simulated_filled_qty",
    "resolve_simulation_context_payload",
    "resolve_simulation_event_ts",
    "signed_decimal_to_text",
    "signed_position_market_value",
    "simulated_order_status",
    "simulated_trade_update_event",
    "active_simulation_runtime_context",
    "build_execution_adapter",
    "logger",
]
