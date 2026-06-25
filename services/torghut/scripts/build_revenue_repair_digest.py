#!/usr/bin/env python
"""CLI wrapper for the Torghut revenue-repair digest builder."""

from __future__ import annotations


import sys
from pathlib import Path

_SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))

from app.trading.revenue_repair import (
    SCHEMA_VERSION,
    bool_value as _bool,
    build_alpha_evidence_foundry,
    build_alpha_repair_closure_board,
    build_executable_alpha_settlement_slots,
    build_repair_queue as _build_repair_queue,
    build_revenue_repair_digest,
    business_state as _business_state,
    collect_blocking_reasons as _collect_blocking_reasons,
    int_value as _int,
    load_json_object as _load_json_object,
    main,
    parse_generated_at as _parse_generated_at,
    sequence_value as _sequence,
)

__all__ = [
    "SCHEMA_VERSION",
    "_bool",
    "_build_repair_queue",
    "_business_state",
    "_collect_blocking_reasons",
    "_int",
    "_load_json_object",
    "_parse_generated_at",
    "_sequence",
    "build_alpha_evidence_foundry",
    "build_alpha_repair_closure_board",
    "build_executable_alpha_settlement_slots",
    "build_revenue_repair_digest",
    "main",
]


if __name__ == "__main__":
    raise SystemExit(main())
