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

from .shared_context import (
    DOC29_LIVE_SCALE_GATE,
    NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION,
    REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS,
    ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION,
    ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION,
    RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
    SCHEMA_VERSION,
    TIGERBEETLE_PARITY_STATUS_PASS,
    TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION,
    _MISSING_QUANT_REASONS,
    _QUOTE_FILLABILITY_REASON_TOKENS,
    _QUOTE_FILLABILITY_REPAIR_ACTIONS,
    _RUNTIME_LEDGER_TRADING_DAY_KEYS,
    _add_check,
    _append_unique_text,
    _bool,
    _decimal,
    _decimal_positive,
    _dimension_by_name,
    _dimension_is_required,
    _expected_floor_states,
    _health_gate_bool,
    _int,
    _load_json_object,
    _load_optional_json_object,
    _load_status_url,
    _mapping,
    _market_session_open,
    _paper_route_probe_summary,
    _paper_route_quote_fillability_summary,
    _quote_fillability_reason,
    _quote_fillability_repair_action,
    _sequence,
    _text,
    _text_list,
)
from .paper_route_target_plan_summary import (
    _PAPER_ROUTE_PREOPEN_SOFT_CHECKS,
    _add_runtime_ledger_proof_packet_check,
    _apply_paper_route_preopen_evidence_collection,
    _build_paper_route_preopen_evidence_collection_ready,
    _build_proofs_target_plan_summary,
    _completion_gate,
    _legacy_paper_route_target_plan_summary,
    _paper_route_preopen_evidence_collection_ready,
    _paper_route_target_plan_summary,
    _proofs_target_plan_summary,
    _runtime_ledger_daily_net_pnl,
    _runtime_ledger_proof_packet_check_payload,
    _runtime_ledger_refs,
    _runtime_ledger_summary,
    _runtime_ledger_trading_day_count,
)
from .add_tigerbeetle_parity_check import (
    _add_execution_tca_lineage_check,
    _add_runtime_ledger_profit_proof_checks,
    _add_tigerbeetle_parity_check,
    _execution_tca_lineage_summary,
    _readiness_next_action,
)


def evaluate_trading_readiness(
    status: Mapping[str, Any],
    *,
    completion_status: Mapping[str, Any] | None = None,
    paper_route_evidence: Mapping[str, Any] | None = None,
    runtime_ledger_proof_packet: Mapping[str, Any] | None = None,
    tigerbeetle_parity: Mapping[str, Any] | None = None,
    profile: str = "paper",
    min_routeable_symbols: int = 2,
    min_decisions: int = 0,
    min_orders: int = 0,
    min_runtime_ledger_net_pnl: Decimal = Decimal("0"),
    min_runtime_ledger_trading_days: int = 0,
    min_runtime_ledger_daily_net_pnl: Decimal = Decimal("0"),
    require_market_open: bool = True,
    require_quant_fresh: bool = True,
    require_paper_route_probe_candidate: bool = False,
    require_paper_route_target_plan: bool = False,
    require_paper_route_import_ready: bool = False,
    require_runtime_ledger_profit_proof: bool = False,
    require_runtime_ledger_proof_packet: bool = False,
    require_tigerbeetle_parity: bool = False,
    allow_paper_route_preopen_evidence_collection: bool = False,
) -> dict[str, Any]:
    """Return a strict readiness verdict from a Torghut trading status payload."""

    checks: dict[str, dict[str, Any]] = {}
    metrics = _mapping(status.get("metrics"))
    proof_floor = _mapping(status.get("proof_floor"))
    dimensions = _dimension_by_name(proof_floor)
    paper_route_probe = _paper_route_probe_summary(status, proof_floor)
    paper_route_target_plan = _paper_route_target_plan_summary(paper_route_evidence)

    mode = _text(status.get("mode") or status.get("trading_mode")).lower()
    if profile in {"paper", "live"}:
        _add_check(
            checks,
            "trading_mode",
            passed=mode == profile,
            observed=mode,
            expected=profile,
        )

    _add_check(
        checks,
        "scheduler_running",
        passed=_bool(status.get("running")),
        observed=status.get("running"),
        expected=True,
    )
    last_error = _text(status.get("last_error"))
    _add_check(
        checks,
        "last_error_clear",
        passed=not last_error,
        observed=last_error or None,
        expected=None,
    )
    _add_check(
        checks,
        "proof_floor_present",
        passed=bool(proof_floor),
        observed=bool(proof_floor),
        expected=True,
    )

    market_open = _market_session_open(status, proof_floor)
    if require_market_open:
        _add_check(
            checks,
            "market_session_open",
            passed=market_open,
            observed=market_open,
            expected=True,
        )

    floor_states, route_states, capital_states = _expected_floor_states(profile)
    floor_state = _text(proof_floor.get("floor_state"))
    route_state = _text(proof_floor.get("route_state"))
    capital_state = _text(proof_floor.get("capital_state"))
    max_notional = _decimal(proof_floor.get("max_notional"))
    blocking_reasons = [
        _text(reason)
        for reason in _sequence(proof_floor.get("blocking_reasons"))
        if _text(reason)
    ]
    _add_check(
        checks,
        "proof_floor_state",
        passed=floor_state in floor_states,
        observed=floor_state,
        expected=sorted(floor_states),
    )
    _add_check(
        checks,
        "route_state",
        passed=route_state in route_states,
        observed=route_state,
        expected=sorted(route_states),
    )
    _add_check(
        checks,
        "capital_state",
        passed=capital_state in capital_states,
        observed=capital_state,
        expected=sorted(capital_states),
    )
    _add_check(
        checks,
        "max_notional_positive",
        passed=max_notional is not None and max_notional > 0,
        observed=str(proof_floor.get("max_notional")),
        expected=">0",
    )
    _add_check(
        checks,
        "blocking_reasons_empty",
        passed=not blocking_reasons,
        observed=blocking_reasons,
        expected=[],
    )

    for dimension_name in ("alpha_readiness", "execution_tca", "market_context"):
        dimension = dimensions.get(dimension_name, {})
        state = _text(dimension.get("state"))
        _add_check(
            checks,
            f"{dimension_name}_pass",
            passed=state == "pass",
            observed={"state": state, "reason": dimension.get("reason")},
            expected={"state": "pass"},
        )

    quant_dimension = dimensions.get("quant_ingestion", {})
    quant_state = _text(quant_dimension.get("state"))
    quant_reason = _text(quant_dimension.get("reason"))
    quant_required = _dimension_is_required(quant_dimension)
    quant_passed = quant_state == "pass" or (
        not require_quant_fresh
        and not quant_required
        and quant_state == "informational"
    )
    if require_quant_fresh and quant_reason in _MISSING_QUANT_REASONS:
        quant_passed = False
    _add_check(
        checks,
        "quant_ingestion_ready",
        passed=quant_passed,
        observed={
            "state": quant_state,
            "reason": quant_reason,
            "required": quant_required,
        },
        expected={"state": "pass"}
        if require_quant_fresh or quant_required
        else {"state": "pass|optional_informational"},
    )

    tca_source_ref = _mapping(dimensions.get("execution_tca", {}).get("source_ref"))
    execution_tca_lineage = _execution_tca_lineage_summary(tca_source_ref)
    symbol_routes = _mapping(tca_source_ref.get("symbol_routes"))
    routeable_symbol_count = _int(symbol_routes.get("routeable_symbol_count"))
    blocked_symbol_count = _int(symbol_routes.get("blocked_symbol_count"))
    missing_symbol_count = _int(symbol_routes.get("missing_symbol_count"))
    _add_check(
        checks,
        "routeable_symbol_count",
        passed=routeable_symbol_count >= min_routeable_symbols,
        observed=routeable_symbol_count,
        expected=f">={min_routeable_symbols}",
        detail={
            "routeable_symbols": symbol_routes.get("routeable_symbols") or [],
            "scope_symbols": symbol_routes.get("scope_symbols") or [],
        },
    )
    _add_check(
        checks,
        "blocked_symbol_count",
        passed=blocked_symbol_count == 0,
        observed=blocked_symbol_count,
        expected=0,
        detail=symbol_routes.get("blocked_symbols") or [],
    )
    _add_check(
        checks,
        "missing_symbol_count",
        passed=missing_symbol_count == 0,
        observed=missing_symbol_count,
        expected=0,
        detail=symbol_routes.get("missing_symbols") or [],
    )
    if require_runtime_ledger_profit_proof or require_runtime_ledger_proof_packet:
        _add_execution_tca_lineage_check(checks, execution_tca_lineage)

    route_board = _mapping(status.get("route_reacquisition_board"))
    route_board_summary = _mapping(route_board.get("summary"))
    route_board_continuity = _mapping(route_board.get("jangar_continuity"))
    route_board_capital_eligible_symbols = _int(
        route_board_summary.get("capital_eligible_symbol_count")
    )
    route_board_zero_notional_rows = _int(
        route_board_summary.get("zero_notional_row_count")
    )
    _add_check(
        checks,
        "route_reacquisition_board_present",
        passed=bool(route_board),
        observed=bool(route_board),
        expected=True,
    )
    _add_check(
        checks,
        "route_board_schema_version",
        passed=_text(route_board.get("schema_version"))
        == ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION,
        observed=_text(route_board.get("schema_version")),
        expected=ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION,
    )
    route_board_continuity_decision = _text(route_board_continuity.get("decision"))
    route_board_continuity_state = _text(route_board_continuity.get("state"))
    route_board_continuity_ready = (
        route_board_continuity_state == "present"
        and route_board_continuity_decision == "allow"
    )
    _add_check(
        checks,
        "route_board_jangar_continuity_ready",
        passed=route_board_continuity_ready,
        observed={
            "state": route_board_continuity_state,
            "decision": route_board_continuity_decision,
            "epoch_id": route_board_continuity.get("epoch_id"),
            "blocking_reasons": route_board_continuity.get("blocking_reasons") or [],
        },
        expected={"state": "present", "decision": "allow"},
    )
    _add_check(
        checks,
        "route_board_capital_eligible_symbols",
        passed=route_board_capital_eligible_symbols >= min_routeable_symbols,
        observed=route_board_capital_eligible_symbols,
        expected=f">={min_routeable_symbols}",
        detail=route_board_summary,
    )
    _add_check(
        checks,
        "route_board_zero_notional_rows",
        passed=route_board_zero_notional_rows == 0,
        observed=route_board_zero_notional_rows,
        expected=0,
        detail=route_board_summary,
    )

    if require_paper_route_probe_candidate:
        allowed_probe_blockers = (
            set() if require_market_open else {"market_session_closed"}
        )
        unexpected_probe_blockers = [
            reason
            for reason in paper_route_probe["blocking_reasons"]
            if reason not in allowed_probe_blockers
        ]
        _add_check(
            checks,
            "paper_route_probe_book_present",
            passed=paper_route_probe["route_book_present"],
            observed=paper_route_probe["route_book_present"],
            expected=True,
        )
        _add_check(
            checks,
            "paper_route_probe_book_schema_version",
            passed=paper_route_probe["route_book_schema_version"]
            == ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION,
            observed=paper_route_probe["route_book_schema_version"],
            expected=ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION,
        )
        _add_check(
            checks,
            "paper_route_probe_configured",
            passed=paper_route_probe["configured_enabled"],
            observed=paper_route_probe["configured_enabled"],
            expected=True,
        )
        _add_check(
            checks,
            "paper_route_probe_candidate_symbols",
            passed=paper_route_probe["eligible_symbol_count"] > 0,
            observed={
                "eligible_symbol_count": paper_route_probe["eligible_symbol_count"],
                "eligible_symbols": paper_route_probe["eligible_symbols"],
            },
            expected=">=1",
        )
        _add_check(
            checks,
            "paper_route_probe_notional_positive",
            passed=_decimal_positive(paper_route_probe["effective_max_notional"])
            or _decimal_positive(paper_route_probe["next_session_max_notional"]),
            observed={
                "effective_max_notional": paper_route_probe["effective_max_notional"],
                "next_session_max_notional": paper_route_probe[
                    "next_session_max_notional"
                ],
            },
            expected="effective_or_next_session_>0",
        )
        _add_check(
            checks,
            "paper_route_probe_blockers",
            passed=not unexpected_probe_blockers,
            observed=paper_route_probe["blocking_reasons"],
            expected=sorted(allowed_probe_blockers),
        )

    if require_paper_route_target_plan or require_paper_route_import_ready:
        _add_check(
            checks,
            "paper_route_target_plan_present",
            passed=paper_route_target_plan["present"],
            observed=paper_route_target_plan["present"],
            expected=True,
        )
        _add_check(
            checks,
            "paper_route_target_plan_schema_version",
            passed=paper_route_target_plan["schema_version"]
            == NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION,
            observed=paper_route_target_plan["schema_version"],
            expected=NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION,
        )
        _add_check(
            checks,
            "paper_route_target_plan_targets_present",
            passed=paper_route_target_plan["target_count"] > 0
            and paper_route_target_plan["actual_target_count"] > 0,
            observed={
                "target_count": paper_route_target_plan["target_count"],
                "actual_target_count": paper_route_target_plan["actual_target_count"],
                "skipped_target_count": paper_route_target_plan["skipped_target_count"],
            },
            expected={"target_count": ">0", "actual_target_count": ">0"},
        )
        _add_check(
            checks,
            "paper_route_target_plan_handoff_flags",
            passed=not paper_route_target_plan["missing_required_flags"],
            observed=paper_route_target_plan["required_flags"],
            expected=list(REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS),
            detail={
                "missing_required_flags": paper_route_target_plan[
                    "missing_required_flags"
                ]
            },
        )
        _add_check(
            checks,
            "paper_route_target_plan_target_identity",
            passed=paper_route_target_plan["missing_identity_count"] == 0
            and paper_route_target_plan["actual_target_count"] > 0,
            observed={
                "missing_identity_count": paper_route_target_plan[
                    "missing_identity_count"
                ],
                "targets": paper_route_target_plan["targets"],
            },
            expected={"missing_identity_count": 0},
        )
        _add_check(
            checks,
            "paper_route_target_plan_probe_contract",
            passed=paper_route_target_plan["probe_contract_count"]
            == paper_route_target_plan["actual_target_count"]
            and paper_route_target_plan["actual_target_count"] > 0,
            observed={
                "probe_contract_count": paper_route_target_plan["probe_contract_count"],
                "targets": paper_route_target_plan["targets"],
            },
            expected="every_target_has_probe_symbols_and_positive_next_notional",
        )
        _add_check(
            checks,
            "paper_route_target_plan_promotion_blocked",
            passed=paper_route_target_plan["promotion_blocked_count"]
            == paper_route_target_plan["actual_target_count"]
            and paper_route_target_plan["actual_target_count"] > 0,
            observed={
                "promotion_blocked_count": paper_route_target_plan[
                    "promotion_blocked_count"
                ],
                "targets": paper_route_target_plan["targets"],
            },
            expected="every_target_zero_notional_and_not_final_promotion",
        )
        _add_check(
            checks,
            "paper_route_target_plan_account_clean",
            passed=bool(paper_route_target_plan["account_clean"]),
            observed={
                "account_clean": paper_route_target_plan["account_clean"],
                "account_clean_blockers": paper_route_target_plan[
                    "account_clean_blockers"
                ],
                "targets": paper_route_target_plan["targets"],
                "skipped_targets": paper_route_target_plan["skipped_targets"],
            },
            expected={"account_clean": True, "account_clean_blockers": []},
        )
        quote_fillability = _mapping(paper_route_target_plan["quote_fillability"])
        _add_check(
            checks,
            "paper_route_target_plan_quote_fillability",
            passed=not _bool(quote_fillability.get("blocked")),
            observed=quote_fillability,
            expected={"blocked": False},
        )
        import_health_gate = _mapping(
            paper_route_target_plan["runtime_window_import_health_gate"]
        )
        _add_check(
            checks,
            "paper_route_target_plan_import_health_gate",
            passed=bool(import_health_gate.get("ready")),
            observed=import_health_gate,
            expected={
                "ready": True,
                "dependency_quorum_decision": "allow",
                "continuity_ok": "true",
                "drift_ok": "true",
            },
        )

    if require_paper_route_import_ready:
        _add_check(
            checks,
            "paper_route_target_plan_import_ready",
            passed=paper_route_target_plan["import_ready"]
            and not paper_route_target_plan["import_blockers"],
            observed={
                "import_ready": paper_route_target_plan["import_ready"],
                "import_blockers": paper_route_target_plan["import_blockers"],
                "session_readiness_state": paper_route_target_plan[
                    "session_readiness_state"
                ],
                "session_window": paper_route_target_plan["session_window"],
            },
            expected={"import_ready": True, "import_blockers": []},
        )

    decisions_total = _int(metrics.get("decisions_total"))
    orders_submitted_total = _int(metrics.get("orders_submitted_total"))
    _add_check(
        checks,
        "decisions_total",
        passed=decisions_total >= min_decisions,
        observed=decisions_total,
        expected=f">={min_decisions}",
    )
    _add_check(
        checks,
        "orders_submitted_total",
        passed=orders_submitted_total >= min_orders,
        observed=orders_submitted_total,
        expected=f">={min_orders}",
    )

    if require_runtime_ledger_profit_proof:
        _add_runtime_ledger_profit_proof_checks(
            checks,
            completion_status=completion_status,
            min_runtime_ledger_net_pnl=min_runtime_ledger_net_pnl,
            min_runtime_ledger_trading_days=min_runtime_ledger_trading_days,
            min_runtime_ledger_daily_net_pnl=min_runtime_ledger_daily_net_pnl,
        )
    if require_runtime_ledger_proof_packet:
        _add_runtime_ledger_proof_packet_check(
            checks,
            runtime_ledger_proof_packet,
        )
    if require_tigerbeetle_parity:
        _add_tigerbeetle_parity_check(checks, tigerbeetle_parity)

    paper_route_preopen_evidence_collection = (
        _paper_route_preopen_evidence_collection_ready(
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
        if allow_paper_route_preopen_evidence_collection
        else {
            "ready": False,
            "conditions": {},
            "softened_checks": [],
            "probe_blockers": paper_route_probe["blocking_reasons"],
            "import_blockers": paper_route_target_plan["import_blockers"],
            "note": "disabled",
        }
    )
    _add_check(
        checks,
        "paper_route_preopen_evidence_collection_ready",
        passed=not allow_paper_route_preopen_evidence_collection
        or _bool(paper_route_preopen_evidence_collection.get("ready")),
        observed=paper_route_preopen_evidence_collection,
        expected={"ready": True}
        if allow_paper_route_preopen_evidence_collection
        else {"enabled": False},
    )
    _apply_paper_route_preopen_evidence_collection(
        checks, paper_route_preopen_evidence_collection
    )

    failed_checks = [key for key, value in checks.items() if not value["passed"]]
    readiness_next_action = _readiness_next_action(
        failed_checks=failed_checks,
        checks=checks,
        runtime_ledger_proof_packet=runtime_ledger_proof_packet,
    )
    packet_summary = _mapping(runtime_ledger_proof_packet)
    tigerbeetle_parity_summary = _mapping(tigerbeetle_parity)
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": not failed_checks,
        "profile": profile,
        "failed_checks": failed_checks,
        "next_action": readiness_next_action,
        "checks": checks,
        "paper_route_probe": paper_route_probe,
        "paper_route_target_plan": paper_route_target_plan,
        "paper_route_preopen_evidence_collection": (
            paper_route_preopen_evidence_collection
        ),
        "execution_tca_lineage": execution_tca_lineage,
        "completion_profit_proof": {
            "required": require_runtime_ledger_profit_proof,
            "gate_id": DOC29_LIVE_SCALE_GATE,
            "min_runtime_ledger_net_pnl": str(min_runtime_ledger_net_pnl),
            "min_runtime_ledger_trading_days": min_runtime_ledger_trading_days,
            "min_runtime_ledger_daily_net_pnl": str(min_runtime_ledger_daily_net_pnl),
        },
        "runtime_ledger_proof_packet": {
            "required": require_runtime_ledger_proof_packet,
            "schema_version": _text(packet_summary.get("schema_version")),
            "proof_mode": _text(packet_summary.get("proof_mode")),
            "proof_mode_contract": dict(
                _mapping(packet_summary.get("proof_mode_contract"))
            ),
            "target": dict(_mapping(packet_summary.get("target"))),
            "min_runtime_ledger_trading_days": _mapping(
                packet_summary.get("target")
            ).get("min_runtime_ledger_trading_days"),
            "min_runtime_ledger_net_pnl_after_costs": _mapping(
                packet_summary.get("target")
            ).get("min_runtime_ledger_net_pnl_after_costs"),
            "min_runtime_ledger_daily_net_pnl_after_costs": _mapping(
                packet_summary.get("target")
            ).get("min_runtime_ledger_daily_net_pnl_after_costs"),
            "source_backed_runtime_ledger_proof_required": _mapping(
                packet_summary.get("target")
            ).get("source_backed_runtime_ledger_proof_required"),
            "non_empty_runtime_ledger_source_refs_required": _mapping(
                packet_summary.get("target")
            ).get("non_empty_runtime_ledger_source_refs_required"),
            "blockers": [
                _text(blocker)
                for blocker in _sequence(packet_summary.get("blockers"))
                if _text(blocker)
            ],
            "authority_blockers": [
                _text(blocker)
                for blocker in _sequence(packet_summary.get("authority_blockers"))
                if _text(blocker)
            ],
            "final_authority_ok": packet_summary.get("final_authority_ok"),
            "evidence_collection_only": packet_summary.get("evidence_collection_only"),
            "evidence_collection_ok": packet_summary.get("evidence_collection_ok"),
            "canary_collection_authorized": packet_summary.get(
                "canary_collection_authorized"
            ),
            "promotion_allowed": packet_summary.get("promotion_allowed"),
            "capital_promotion_allowed": packet_summary.get(
                "capital_promotion_allowed"
            ),
            "final_promotion_allowed": packet_summary.get("final_promotion_allowed"),
            "next_action": _text(packet_summary.get("next_action")),
        },
        "tigerbeetle_parity": {
            "required": require_tigerbeetle_parity,
            "schema_version": _text(tigerbeetle_parity_summary.get("schema_version")),
            "parity_status": _text(tigerbeetle_parity_summary.get("parity_status")),
            "ok": tigerbeetle_parity_summary.get("ok"),
        },
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--status-file", type=Path, help="Path to a /trading/status JSON payload."
    )
    source.add_argument(
        "--status-url", help="URL returning a /trading/status JSON payload."
    )
    completion_source = parser.add_mutually_exclusive_group(required=False)
    completion_source.add_argument(
        "--completion-file",
        type=Path,
        help="Path to a /trading/completion/doc29 JSON payload.",
    )
    completion_source.add_argument(
        "--completion-url",
        help="URL returning a /trading/completion/doc29 JSON payload.",
    )
    paper_route_evidence_source = parser.add_mutually_exclusive_group(required=False)
    paper_route_evidence_source.add_argument(
        "--paper-route-evidence-file",
        type=Path,
        help="Path to a /trading/proofs JSON payload.",
    )
    paper_route_evidence_source.add_argument(
        "--paper-route-evidence-url",
        help="URL returning a /trading/proofs JSON payload.",
    )
    runtime_ledger_packet_source = parser.add_mutually_exclusive_group(required=False)
    runtime_ledger_packet_source.add_argument(
        "--runtime-ledger-proof-packet-file",
        type=Path,
        help="Path to an assemble_runtime_ledger_proof_packet.py JSON payload.",
    )
    runtime_ledger_packet_source.add_argument(
        "--runtime-ledger-proof-packet-url",
        help="URL returning an assemble_runtime_ledger_proof_packet.py JSON payload.",
    )
    tigerbeetle_parity_source = parser.add_mutually_exclusive_group(required=False)
    tigerbeetle_parity_source.add_argument(
        "--tigerbeetle-parity-file",
        type=Path,
        help="Path to an audit_tigerbeetle_runtime_ledger_parity.py JSON payload.",
    )
    tigerbeetle_parity_source.add_argument(
        "--tigerbeetle-parity-url",
        help="URL returning a TigerBeetle/runtime-ledger parity payload.",
    )
    parser.add_argument(
        "--profile", choices=("paper", "live", "either"), default="paper"
    )
    parser.add_argument("--min-routeable-symbols", type=int, default=2)
    parser.add_argument("--min-decisions", type=int, default=0)
    parser.add_argument("--min-orders", type=int, default=0)
    parser.add_argument(
        "--min-runtime-ledger-net-pnl",
        default="0",
        help="Minimum runtime-ledger net strategy PnL after costs required when runtime proof is required.",
    )
    parser.add_argument(
        "--min-runtime-ledger-trading-days",
        type=int,
        default=0,
        help="Minimum observed runtime-ledger trading days required when runtime proof is required.",
    )
    parser.add_argument(
        "--min-runtime-ledger-daily-net-pnl",
        default="0",
        help="Minimum runtime-ledger net strategy PnL after costs per observed trading day.",
    )
    parser.add_argument("--allow-closed-session", action="store_true")
    parser.add_argument("--allow-informational-quant", action="store_true")
    parser.add_argument(
        "--require-paper-route-probe-candidate",
        action="store_true",
        help="Require a bounded paper-route probe candidate in route_reacquisition_book.",
    )
    parser.add_argument(
        "--require-paper-route-target-plan",
        action="store_true",
        help="Require /trading/proofs to expose runtime-window targets.",
    )
    parser.add_argument(
        "--require-paper-route-import-ready",
        action="store_true",
        help="Require the paper-route target plan to be settlement-ready for runtime-window import.",
    )
    parser.add_argument(
        "--require-runtime-ledger-profit-proof",
        action="store_true",
        help="Require doc29 live-scale runtime-ledger proof from /trading/completion/doc29.",
    )
    parser.add_argument(
        "--require-runtime-ledger-proof-packet",
        action="store_true",
        help="Require canonical runtime-ledger proof packet promotion authority.",
    )
    parser.add_argument(
        "--require-tigerbeetle-parity",
        action="store_true",
        help=(
            "Require TigerBeetle journal parity to pass as an accounting-only "
            "companion check; this never satisfies runtime-ledger proof authority."
        ),
    )
    parser.add_argument(
        "--allow-paper-route-preopen-evidence-collection",
        action="store_true",
        help=(
            "Allow closed-session paper-route target-plan checks to pass when the "
            "next session proof lane is armed. Does not satisfy import, "
            "runtime-ledger, promotion, or profitability proof gates."
        ),
    )
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    return parser


__all__ = [name for name in globals() if not name.startswith("__")]
