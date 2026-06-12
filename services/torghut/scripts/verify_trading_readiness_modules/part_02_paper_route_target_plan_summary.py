# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python
"""Verify Torghut trading readiness from a `/trading/status` payload."""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast
from urllib.request import urlopen

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_16 import *
from .part_02_target_plan_helpers import (
    _build_paper_route_preopen_evidence_collection_ready,
    _build_proofs_target_plan_summary,
    _legacy_paper_route_target_plan_summary,
    _runtime_ledger_proof_packet_check_payload,
)


def _paper_route_target_plan_summary(
    paper_route_evidence: Mapping[str, Any] | None,
) -> dict[str, Any]:
    evidence = paper_route_evidence or {}
    if _text(evidence.get("schema_version")) == "torghut.proofs.v1":
        return _proofs_target_plan_summary(evidence)
    return _legacy_paper_route_target_plan_summary(evidence)


def _proofs_target_plan_summary(evidence: Mapping[str, Any]) -> dict[str, Any]:
    return _build_proofs_target_plan_summary(evidence)


_PAPER_ROUTE_PREOPEN_SOFT_CHECKS = {
    "proof_floor_state",
    "route_state",
    "capital_state",
    "max_notional_positive",
    "blocking_reasons_empty",
    "alpha_readiness_pass",
    "execution_tca_pass",
    "routeable_symbol_count",
    "route_board_capital_eligible_symbols",
    "route_board_zero_notional_rows",
}


def _paper_route_preopen_evidence_collection_ready(
    *,
    profile: str,
    require_market_open: bool,
    require_paper_route_probe_candidate: bool,
    require_paper_route_target_plan: bool,
    require_paper_route_import_ready: bool,
    require_runtime_ledger_profit_proof: bool,
    require_runtime_ledger_proof_packet: bool,
    market_open: bool,
    paper_route_probe: Mapping[str, Any],
    paper_route_target_plan: Mapping[str, Any],
) -> dict[str, Any]:
    return _build_paper_route_preopen_evidence_collection_ready(
        profile=profile,
        require_market_open=require_market_open,
        require_paper_route_probe_candidate=require_paper_route_probe_candidate,
        require_paper_route_target_plan=require_paper_route_target_plan,
        require_paper_route_import_ready=require_paper_route_import_ready,
        require_runtime_ledger_profit_proof=require_runtime_ledger_profit_proof,
        require_runtime_ledger_proof_packet=require_runtime_ledger_proof_packet,
        market_open=market_open,
        paper_route_probe=paper_route_probe,
        paper_route_target_plan=paper_route_target_plan,
    )


def _apply_paper_route_preopen_evidence_collection(
    checks: dict[str, dict[str, Any]],
    summary: Mapping[str, Any],
) -> None:
    if not _bool(summary.get("ready")):
        return
    for check_name in _sequence(summary.get("softened_checks")):
        check = checks.get(_text(check_name))
        if not check or check.get("passed") is True:
            continue
        detail = _mapping(check.get("detail"))
        check["detail"] = {
            **dict(detail),
            "preopen_evidence_collection_override": True,
            "original_expected": check.get("expected"),
            "original_observed": check.get("observed"),
        }
        check["expected"] = "paper_route_preopen_evidence_collection_ready"
        check["passed"] = True


def _completion_gate(
    completion_status: Mapping[str, Any], gate_id: str
) -> Mapping[str, Any]:
    for raw_gate in _sequence(completion_status.get("gates")):
        gate = _mapping(raw_gate)
        if _text(gate.get("gate_id")) == gate_id:
            return gate
    return {}


def _runtime_ledger_summary(gate: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(gate.get("runtime_ledger_summary"))


def _runtime_ledger_refs(gate: Mapping[str, Any], key: str) -> Sequence[object]:
    refs = _mapping(gate.get("db_row_refs"))
    return _sequence(refs.get(key))


def _runtime_ledger_trading_day_count(
    summary: Mapping[str, Any],
) -> tuple[int, str | None]:
    for key in _RUNTIME_LEDGER_TRADING_DAY_KEYS:
        if key in summary:
            return _int(summary.get(key)), key
    return 0, None


def _runtime_ledger_daily_net_pnl(
    summary: Mapping[str, Any],
    *,
    net_pnl: Decimal | None,
    trading_day_count: int,
) -> tuple[Decimal | None, str]:
    for key in (
        "runtime_ledger_mean_daily_net_pnl_after_costs",
        "runtime_ledger_daily_net_pnl_after_costs",
        "mean_daily_net_pnl_after_costs",
        "daily_net_pnl_after_costs",
    ):
        if key in summary:
            parsed = _decimal(summary.get(key))
            if parsed is not None:
                return parsed, key
    if net_pnl is not None and trading_day_count > 0:
        return net_pnl / Decimal(trading_day_count), "computed_from_total_net_pnl"
    return None, "missing"


def _add_runtime_ledger_proof_packet_check(
    checks: dict[str, dict[str, Any]],
    runtime_ledger_proof_packet: Mapping[str, Any] | None,
) -> None:
    passed, observed, expected = _runtime_ledger_proof_packet_check_payload(
        runtime_ledger_proof_packet
    )
    _add_check(
        checks,
        "runtime_ledger_proof_packet_authority",
        passed=passed,
        observed=observed,
        expected=expected,
    )


__all__ = [name for name in globals() if not name.startswith("__")]
