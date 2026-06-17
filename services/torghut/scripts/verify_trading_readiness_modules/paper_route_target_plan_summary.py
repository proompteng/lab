#!/usr/bin/env python
"""Verify Torghut trading readiness from a `/trading/status` payload."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any


from . import shared_context as _shared_context
from . import target_plan_helpers as _target_plan_helpers

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
_build_paper_route_preopen_evidence_collection_ready = getattr(
    _target_plan_helpers,
    "_build_paper_route_preopen_evidence_collection_ready",
)
_build_proofs_target_plan_summary = getattr(
    _target_plan_helpers,
    "_build_proofs_target_plan_summary",
)
_legacy_paper_route_target_plan_summary = getattr(
    _target_plan_helpers,
    "_legacy_paper_route_target_plan_summary",
)
_runtime_ledger_proof_packet_check_payload = getattr(
    _target_plan_helpers,
    "_runtime_ledger_proof_packet_check_payload",
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


runtime_ledger_daily_net_pnl = _runtime_ledger_daily_net_pnl

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
    "runtime_ledger_daily_net_pnl",
)
