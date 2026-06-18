#!/usr/bin/env python
"""CLI wrapper for the Torghut revenue-repair digest builder."""

from __future__ import annotations


from importlib import import_module
import sys
from pathlib import Path
from typing import Any, cast

_SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))

_revenue_repair = import_module("app.trading.revenue_repair")
SCHEMA_VERSION = cast(str, _revenue_repair.SCHEMA_VERSION)
_bool = cast(Any, _revenue_repair._bool)
_build_repair_queue = cast(Any, _revenue_repair._build_repair_queue)
_business_state = cast(Any, _revenue_repair._business_state)
_collect_blocking_reasons = cast(Any, _revenue_repair._collect_blocking_reasons)
_int = cast(Any, _revenue_repair._int)
_load_json_object = cast(Any, _revenue_repair._load_json_object)
_parse_generated_at = cast(Any, _revenue_repair._parse_generated_at)
_sequence = cast(Any, _revenue_repair._sequence)
build_alpha_evidence_foundry = cast(Any, _revenue_repair.build_alpha_evidence_foundry)
build_alpha_repair_closure_board = cast(
    Any, _revenue_repair.build_alpha_repair_closure_board
)
build_executable_alpha_settlement_slots = cast(
    Any, _revenue_repair.build_executable_alpha_settlement_slots
)
build_revenue_repair_digest = cast(Any, _revenue_repair.build_revenue_repair_digest)
main = cast(Any, _revenue_repair.main)

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
