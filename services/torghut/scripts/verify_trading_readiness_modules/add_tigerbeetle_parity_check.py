# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
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

# ruff: noqa: F401

from . import paper_route_target_plan_summary as _paper_route_target_plan_summary_module
from . import shared_context as _shared_context

DOC29_LIVE_SCALE_GATE = _shared_context.DOC29_LIVE_SCALE_GATE
NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION = (
    _shared_context.NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION
)
REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS = (
    _shared_context.REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS
)
ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION = (
    _shared_context.ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION
)
ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION = (
    _shared_context.ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION
)
RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION = (
    _shared_context.RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION
)
SCHEMA_VERSION = _shared_context.SCHEMA_VERSION
TIGERBEETLE_PARITY_STATUS_PASS = _shared_context.TIGERBEETLE_PARITY_STATUS_PASS
TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION = (
    _shared_context.TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION
)
_MISSING_QUANT_REASONS = getattr(_shared_context, "_MISSING_QUANT_REASONS")
_QUOTE_FILLABILITY_REASON_TOKENS = getattr(
    _shared_context,
    "_QUOTE_FILLABILITY_REASON_TOKENS",
)
_QUOTE_FILLABILITY_REPAIR_ACTIONS = getattr(
    _shared_context,
    "_QUOTE_FILLABILITY_REPAIR_ACTIONS",
)
_RUNTIME_LEDGER_TRADING_DAY_KEYS = getattr(
    _shared_context,
    "_RUNTIME_LEDGER_TRADING_DAY_KEYS",
)
_add_check = getattr(_shared_context, "_add_check")
_append_unique_text = getattr(_shared_context, "_append_unique_text")
_bool = getattr(_shared_context, "_bool")
_decimal = getattr(_shared_context, "_decimal")
_decimal_positive = getattr(_shared_context, "_decimal_positive")
_dimension_by_name = getattr(_shared_context, "_dimension_by_name")
_dimension_is_required = getattr(_shared_context, "_dimension_is_required")
_expected_floor_states = getattr(_shared_context, "_expected_floor_states")
_health_gate_bool = getattr(_shared_context, "_health_gate_bool")
_int = getattr(_shared_context, "_int")
_load_json_object = getattr(_shared_context, "_load_json_object")
_load_optional_json_object = getattr(_shared_context, "_load_optional_json_object")
_load_status_url = getattr(_shared_context, "_load_status_url")
_mapping = getattr(_shared_context, "_mapping")
_market_session_open = getattr(_shared_context, "_market_session_open")
_paper_route_probe_summary = getattr(_shared_context, "_paper_route_probe_summary")
_paper_route_quote_fillability_summary = getattr(
    _shared_context,
    "_paper_route_quote_fillability_summary",
)
_quote_fillability_reason = getattr(_shared_context, "_quote_fillability_reason")
_quote_fillability_repair_action = getattr(
    _shared_context,
    "_quote_fillability_repair_action",
)
_sequence = getattr(_shared_context, "_sequence")
_text = getattr(_shared_context, "_text")
_text_list = getattr(_shared_context, "_text_list")
_PAPER_ROUTE_PREOPEN_SOFT_CHECKS = getattr(
    _paper_route_target_plan_summary_module,
    "_PAPER_ROUTE_PREOPEN_SOFT_CHECKS",
)
_add_runtime_ledger_proof_packet_check = getattr(
    _paper_route_target_plan_summary_module,
    "_add_runtime_ledger_proof_packet_check",
)
_apply_paper_route_preopen_evidence_collection = getattr(
    _paper_route_target_plan_summary_module,
    "_apply_paper_route_preopen_evidence_collection",
)
_build_paper_route_preopen_evidence_collection_ready = getattr(
    _paper_route_target_plan_summary_module,
    "_build_paper_route_preopen_evidence_collection_ready",
)
_build_proofs_target_plan_summary = getattr(
    _paper_route_target_plan_summary_module,
    "_build_proofs_target_plan_summary",
)
_completion_gate = getattr(_paper_route_target_plan_summary_module, "_completion_gate")
_legacy_paper_route_target_plan_summary = getattr(
    _paper_route_target_plan_summary_module,
    "_legacy_paper_route_target_plan_summary",
)
_paper_route_preopen_evidence_collection_ready = getattr(
    _paper_route_target_plan_summary_module,
    "_paper_route_preopen_evidence_collection_ready",
)
_paper_route_target_plan_summary = getattr(
    _paper_route_target_plan_summary_module,
    "_paper_route_target_plan_summary",
)
_proofs_target_plan_summary = getattr(
    _paper_route_target_plan_summary_module,
    "_proofs_target_plan_summary",
)
_runtime_ledger_daily_net_pnl = getattr(
    _paper_route_target_plan_summary_module,
    "_runtime_ledger_daily_net_pnl",
)
_runtime_ledger_proof_packet_check_payload = getattr(
    _paper_route_target_plan_summary_module,
    "_runtime_ledger_proof_packet_check_payload",
)
_runtime_ledger_refs = getattr(
    _paper_route_target_plan_summary_module,
    "_runtime_ledger_refs",
)
_runtime_ledger_summary = getattr(
    _paper_route_target_plan_summary_module,
    "_runtime_ledger_summary",
)
_runtime_ledger_trading_day_count = getattr(
    _paper_route_target_plan_summary_module,
    "_runtime_ledger_trading_day_count",
)


def _add_tigerbeetle_parity_check(
    checks: dict[str, dict[str, Any]],
    tigerbeetle_parity: Mapping[str, Any] | None,
) -> None:
    parity = _mapping(tigerbeetle_parity)
    totals = _mapping(parity.get("totals"))
    read_only_contract = _mapping(parity.get("read_only_contract"))
    blockers = [
        text for item in _sequence(parity.get("blockers")) if (text := _text(item))
    ]
    schema_version = _text(parity.get("schema_version"))
    parity_status = _text(parity.get("parity_status"))
    checked_source_count = _int(totals.get("checked_source_count"))
    accounting_only = (
        read_only_contract.get("generates_proof") is False
        and read_only_contract.get("synthesizes_fills") is False
        and read_only_contract.get("overrides_runtime_ledger_authority") is False
    )
    _add_check(
        checks,
        "tigerbeetle_runtime_ledger_parity",
        passed=(
            bool(parity)
            and schema_version == TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION
            and parity.get("ok") is True
            and parity_status == TIGERBEETLE_PARITY_STATUS_PASS
            and checked_source_count > 0
            and not blockers
            and accounting_only
        ),
        observed={
            "present": bool(parity),
            "schema_version": schema_version,
            "ok": parity.get("ok"),
            "parity_status": parity_status,
            "checked_source_count": checked_source_count,
            "blockers": blockers,
            "read_only_contract": read_only_contract,
        },
        expected={
            "schema_version": TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION,
            "ok": True,
            "parity_status": TIGERBEETLE_PARITY_STATUS_PASS,
            "checked_source_count": ">0",
            "blockers": [],
            "read_only_contract.overrides_runtime_ledger_authority": False,
        },
    )


def _readiness_next_action(
    *,
    failed_checks: Sequence[str],
    checks: Mapping[str, Mapping[str, Any]],
    runtime_ledger_proof_packet: Mapping[str, Any] | None,
) -> str:
    packet = _mapping(runtime_ledger_proof_packet)
    packet_next_action = _text(packet.get("next_action"))
    if "runtime_ledger_proof_packet_authority" in failed_checks and packet_next_action:
        return packet_next_action
    if "tigerbeetle_runtime_ledger_parity" in failed_checks:
        return "repair_tigerbeetle_journal_parity_without_using_as_profit_authority"
    blockers: list[str] = []
    for check_name in failed_checks:
        check = _mapping(checks.get(check_name))
        observed = _mapping(check.get("observed"))
        for key in ("blocking_reasons", "import_blockers", "failed_checks"):
            for reason in _sequence(observed.get(key)):
                text = _text(reason)
                if text and text not in blockers:
                    blockers.append(text)
    for blocker in blockers:
        if _quote_fillability_reason(blocker):
            return (
                "repair_quote_quality_or_fillability_before_runtime_ledger_collection"
            )
        if blocker in {
            "runtime_window_import_missing",
            "runtime_window_import_runtime_ledger_materialization_missing",
            "paper_route_runtime_ledger_import_pending",
            "paper_route_import_not_ready",
        }:
            return "run_runtime_window_import_from_paper_route_target_plan"
        if blocker in {
            "paper_route_source_activity_missing",
            "runtime_ledger_source_authority_missing",
        } or blocker.startswith("runtime_ledger_source_"):
            return "inspect_runtime_ledger_source_activity"
        if blocker in {
            "runtime_ledger_trading_days_below_target",
            "runtime_ledger_observed_trading_day_count_below_target",
        }:
            return "collect_more_runtime_ledger_trading_days"
        if blocker in {
            "runtime_ledger_closed_round_trips_below_authority_floor",
            "runtime_ledger_closed_trade_count_zero",
        }:
            return "collect_more_closed_runtime_round_trips"
        if blocker in {
            "runtime_ledger_filled_notional_below_authority_floor",
            "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor",
        }:
            return "collect_more_runtime_ledger_filled_notional"
        if blocker.startswith("runtime_ledger_"):
            return "repair_runtime_ledger_lifecycle_cost_or_lineage_evidence"
    for failed_check in failed_checks:
        if "quote_fillability" in failed_check:
            return (
                "repair_quote_quality_or_fillability_before_runtime_ledger_collection"
            )
        if failed_check.startswith("paper_route_target_plan"):
            return "repair_candidate_frontier_or_paper_route_target_plan"
        if failed_check.startswith("runtime_ledger"):
            return "inspect_runtime_live_paper_ledger_evidence"
    return "none" if not failed_checks else "inspect_failed_readiness_checks"


def _add_runtime_ledger_profit_proof_checks(
    checks: dict[str, dict[str, Any]],
    *,
    completion_status: Mapping[str, Any] | None,
    min_runtime_ledger_net_pnl: Decimal,
    min_runtime_ledger_trading_days: int,
    min_runtime_ledger_daily_net_pnl: Decimal,
) -> None:
    completion_present = completion_status is not None
    _add_check(
        checks,
        "completion_status_present",
        passed=completion_present,
        observed=completion_present,
        expected=True,
    )
    if completion_status is None:
        return

    gate = _completion_gate(completion_status, DOC29_LIVE_SCALE_GATE)
    summary = _runtime_ledger_summary(gate)
    ledger_refs = _runtime_ledger_refs(gate, "strategy_runtime_ledger_buckets")
    unbacked_refs = _runtime_ledger_refs(
        gate,
        "runtime_ledger_unbacked_hypothesis_metric_windows",
    )
    gate_status = _text(gate.get("status"))
    blocked_reason = _text(gate.get("blocked_reason"))
    _add_check(
        checks,
        "doc29_live_scale_gate_satisfied",
        passed=gate_status == "satisfied" and not blocked_reason,
        observed={"status": gate_status, "blocked_reason": blocked_reason or None},
        expected={"status": "satisfied", "blocked_reason": None},
    )
    _add_check(
        checks,
        "runtime_ledger_db_refs_present",
        passed=len(ledger_refs) > 0,
        observed=len(ledger_refs),
        expected=">0",
        detail=list(ledger_refs),
    )
    _add_check(
        checks,
        "runtime_ledger_unbacked_windows_empty",
        passed=len(unbacked_refs) == 0,
        observed=len(unbacked_refs),
        expected=0,
        detail=list(unbacked_refs),
    )
    _add_check(
        checks,
        "runtime_ledger_bucket_count",
        passed=_int(summary.get("runtime_ledger_bucket_count")) > 0,
        observed=summary.get("runtime_ledger_bucket_count"),
        expected=">0",
    )
    _add_check(
        checks,
        "runtime_ledger_fill_count",
        passed=_int(summary.get("runtime_ledger_fill_count")) > 0,
        observed=summary.get("runtime_ledger_fill_count"),
        expected=">0",
    )
    _add_check(
        checks,
        "runtime_ledger_closed_trade_count",
        passed=_int(summary.get("runtime_ledger_closed_trade_count")) > 0,
        observed=summary.get("runtime_ledger_closed_trade_count"),
        expected=">0",
    )
    trading_day_count, trading_day_count_key = _runtime_ledger_trading_day_count(
        summary
    )
    _add_check(
        checks,
        "runtime_ledger_observed_trading_days",
        passed=trading_day_count >= min_runtime_ledger_trading_days,
        observed=trading_day_count,
        expected=f">={min_runtime_ledger_trading_days}",
        detail={"source_key": trading_day_count_key},
    )
    _add_check(
        checks,
        "runtime_ledger_filled_notional",
        passed=_decimal_positive(summary.get("runtime_ledger_filled_notional")),
        observed=summary.get("runtime_ledger_filled_notional"),
        expected=">0",
    )
    net_pnl = _decimal(summary.get("runtime_ledger_net_strategy_pnl_after_costs"))
    _add_check(
        checks,
        "runtime_ledger_net_pnl_target",
        passed=net_pnl is not None and net_pnl >= min_runtime_ledger_net_pnl,
        observed=str(net_pnl) if net_pnl is not None else None,
        expected=f">={min_runtime_ledger_net_pnl}",
    )
    daily_net_pnl, daily_net_pnl_key = _runtime_ledger_daily_net_pnl(
        summary,
        net_pnl=net_pnl,
        trading_day_count=trading_day_count,
    )
    daily_net_pnl_required = min_runtime_ledger_daily_net_pnl > 0
    _add_check(
        checks,
        "runtime_ledger_daily_net_pnl_target",
        passed=not daily_net_pnl_required
        or (
            daily_net_pnl is not None
            and daily_net_pnl >= min_runtime_ledger_daily_net_pnl
        ),
        observed=str(daily_net_pnl) if daily_net_pnl is not None else None,
        expected=f">={min_runtime_ledger_daily_net_pnl}",
        detail={
            "trading_day_count": trading_day_count,
            "source_key": daily_net_pnl_key,
        },
    )
    _add_check(
        checks,
        "runtime_ledger_post_cost_expectancy_positive",
        passed=_decimal_positive(
            summary.get("runtime_ledger_post_cost_expectancy_bps")
        ),
        observed=summary.get("runtime_ledger_post_cost_expectancy_bps"),
        expected=">0",
    )


def _execution_tca_lineage_summary(tca_source_ref: Mapping[str, Any]) -> dict[str, Any]:
    lineage = _mapping(
        tca_source_ref.get("runtime_ledger_lineage")
        or tca_source_ref.get("execution_tca_cost_lineage")
    )
    if not lineage:
        return {
            "present": False,
            "status": "missing",
            "schema_version": None,
            "promotion_authority": False,
            "execution_count": 0,
            "source_backed_count": 0,
            "blocked_count": 0,
            "blockers": ["runtime_tca_cost_lineage_readback_missing"],
            "blocker_counts": {
                "runtime_tca_cost_lineage_readback_missing": 1,
            },
        }
    blockers = [
        _text(item) for item in _sequence(lineage.get("blockers")) if _text(item)
    ]
    return {
        "present": True,
        "schema_version": _text(lineage.get("schema_version")),
        "status": _text(lineage.get("status")),
        "promotion_authority": lineage.get("promotion_authority") is True,
        "promotion_authority_reason": _text(lineage.get("promotion_authority_reason")),
        "execution_count": _int(lineage.get("execution_count")),
        "source_backed_count": _int(lineage.get("source_backed_count")),
        "blocked_count": _int(lineage.get("blocked_count")),
        "filled_notional_count": _int(lineage.get("filled_notional_count")),
        "explicit_cost_count": _int(lineage.get("explicit_cost_count")),
        "execution_policy_hash_count": _int(lineage.get("execution_policy_hash_count")),
        "cost_model_hash_count": _int(lineage.get("cost_model_hash_count")),
        "post_cost_pnl_basis_count": _int(lineage.get("post_cost_pnl_basis_count")),
        "blockers": blockers,
        "blocker_counts": _mapping(lineage.get("blocker_counts")),
        "sample_blockers": list(_sequence(lineage.get("sample_blockers"))),
    }


def _add_execution_tca_lineage_check(
    checks: dict[str, dict[str, Any]],
    lineage: Mapping[str, Any],
) -> None:
    execution_count = _int(lineage.get("execution_count"))
    source_backed_count = _int(lineage.get("source_backed_count"))
    blockers = [
        _text(item) for item in _sequence(lineage.get("blockers")) if _text(item)
    ]
    _add_check(
        checks,
        "execution_tca_cost_lineage_source_backed",
        passed=(
            lineage.get("present") is True
            and lineage.get("schema_version") == "torghut.execution-tca-cost-lineage.v1"
            and lineage.get("status") == "source_backed"
            and execution_count > 0
            and source_backed_count == execution_count
            and _int(lineage.get("filled_notional_count")) == execution_count
            and _int(lineage.get("explicit_cost_count")) == execution_count
            and _int(lineage.get("execution_policy_hash_count")) == execution_count
            and _int(lineage.get("cost_model_hash_count")) == execution_count
            and _int(lineage.get("post_cost_pnl_basis_count")) == execution_count
            and lineage.get("promotion_authority") is False
            and not blockers
        ),
        observed=lineage,
        expected={
            "schema_version": "torghut.execution-tca-cost-lineage.v1",
            "status": "source_backed",
            "execution_count": ">0",
            "source_backed_count": "execution_count",
            "promotion_authority": False,
            "blockers": [],
        },
    )


readiness_next_action = _readiness_next_action

__all__ = (
    "DOC29_LIVE_SCALE_GATE",
    "NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION",
    "REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS",
    "ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION",
    "ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION",
    "RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION",
    "SCHEMA_VERSION",
    "TIGERBEETLE_PARITY_STATUS_PASS",
    "TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION",
    "readiness_next_action",
)
