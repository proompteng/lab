from __future__ import annotations
from scripts.verify_trading_readiness_modules import (
    argparse,
    json,
    Mapping,
    Sequence,
    datetime,
    timezone,
    Decimal,
    InvalidOperation,
    Path,
    Any,
    cast,
    urlopen,
    SCHEMA_VERSION,
    ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION,
    ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION,
    NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION,
    RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
    TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION,
    TIGERBEETLE_PARITY_STATUS_PASS,
    DOC29_LIVE_SCALE_GATE,
    REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS,
    evaluate_trading_readiness,
    main,
)
from scripts.verify_trading_readiness_modules.add_tigerbeetle_parity_check import (
    readiness_next_action as _readiness_next_action,
)
from scripts.verify_trading_readiness_modules.paper_route_target_plan_summary import (
    runtime_ledger_daily_net_pnl as _runtime_ledger_daily_net_pnl,
)
from scripts.verify_trading_readiness_modules import (
    paper_route_target_plan_summary as _paper_route_target_plan_summary_module,
    shared_context as _readiness_shared_context,
)

_bool = getattr(_readiness_shared_context, "_bool")
_decimal = getattr(_readiness_shared_context, "_decimal")
_int = getattr(_readiness_shared_context, "_int")
_load_json_object = getattr(_readiness_shared_context, "_load_json_object")
_load_status_url = getattr(_readiness_shared_context, "_load_status_url")
_mapping = getattr(_readiness_shared_context, "_mapping")
_paper_route_target_plan_summary = getattr(
    _paper_route_target_plan_summary_module,
    "_paper_route_target_plan_summary",
)
_quote_fillability_repair_action = getattr(
    _readiness_shared_context,
    "_quote_fillability_repair_action",
)
_quote_fillability_reason = getattr(
    _readiness_shared_context,
    "_quote_fillability_reason",
)
_sequence = getattr(_readiness_shared_context, "_sequence")

__all__ = [
    "argparse",
    "json",
    "Mapping",
    "Sequence",
    "datetime",
    "timezone",
    "Decimal",
    "InvalidOperation",
    "Path",
    "Any",
    "cast",
    "urlopen",
    "SCHEMA_VERSION",
    "ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION",
    "ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION",
    "NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION",
    "RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION",
    "TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION",
    "TIGERBEETLE_PARITY_STATUS_PASS",
    "DOC29_LIVE_SCALE_GATE",
    "REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS",
    "_readiness_next_action",
    "_runtime_ledger_daily_net_pnl",
    "_bool",
    "_decimal",
    "_int",
    "_load_json_object",
    "_load_status_url",
    "_mapping",
    "_paper_route_target_plan_summary",
    "_quote_fillability_repair_action",
    "_quote_fillability_reason",
    "_sequence",
    "evaluate_trading_readiness",
    "main",
]
if __name__ == "__main__":
    raise SystemExit(main())
