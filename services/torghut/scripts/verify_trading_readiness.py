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


SCHEMA_VERSION = "torghut.trading-readiness-verification.v1"
ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION = "torghut.route-reacquisition-board.v1"
ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION = "torghut.route-reacquisition-book.v1"
NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION = (
    "torghut.next-paper-route-runtime-window-targets.v1"
)
RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION = (
    "torghut.runtime-ledger-live-paper-proof-packet.v1"
)
DOC29_LIVE_SCALE_GATE = "live_scale_observed"
REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS = (
    "--runtime-window-import",
    "--runtime-window-target-plan-url",
    "--runtime-window-target-plan-exclusive",
    "--runtime-window-target-plan-required",
    "--runtime-window-target-plan-settlement-seconds",
)
_RUNTIME_LEDGER_TRADING_DAY_KEYS = (
    "runtime_ledger_observed_trading_day_count",
    "runtime_ledger_trading_day_count",
    "observed_trading_day_count",
    "trading_day_count",
    "runtime_ledger_session_count",
    "session_count",
)
_MISSING_QUANT_REASONS = {
    "quant_health_fetch_failed",
    "quant_health_missing",
    "quant_latest_metrics_empty",
    "quant_latest_store_alarm",
    "quant_pipeline_stages_missing",
}


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "open"}
    return False


def _health_gate_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return _text(value).lower() == "true"


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None


def _decimal_positive(value: object) -> bool:
    parsed = _decimal(value)
    return parsed is not None and parsed > 0


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"json_object_required:{path}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _load_status_url(url: str, *, timeout_seconds: float) -> dict[str, Any]:
    with urlopen(url, timeout=timeout_seconds) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"json_object_required:{url}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _load_optional_json_object(
    *,
    path: Path | None,
    url: str | None,
    timeout_seconds: float,
) -> dict[str, Any] | None:
    if path is not None:
        return _load_json_object(path)
    if url:
        return _load_status_url(url, timeout_seconds=timeout_seconds)
    return None


def _dimension_by_name(proof_floor: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    dimensions: dict[str, Mapping[str, Any]] = {}
    for raw_dimension in _sequence(proof_floor.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        name = _text(dimension.get("dimension"))
        if name:
            dimensions[name] = dimension
    return dimensions


def _dimension_is_required(dimension: Mapping[str, Any]) -> bool:
    source_ref = _mapping(dimension.get("source_ref"))
    if "required" in source_ref:
        return _bool(source_ref.get("required"))
    if "evidence_required" in source_ref:
        return _bool(source_ref.get("evidence_required"))
    return True


def _market_session_open(
    status: Mapping[str, Any], proof_floor: Mapping[str, Any]
) -> bool:
    metrics = _mapping(status.get("metrics"))
    if "market_session_open" in metrics:
        return _bool(metrics.get("market_session_open"))
    market_window = _mapping(proof_floor.get("market_window"))
    return _bool(market_window.get("session_open"))


def _add_check(
    checks: dict[str, dict[str, Any]],
    key: str,
    *,
    passed: bool,
    observed: object,
    expected: object,
    detail: object | None = None,
) -> None:
    payload: dict[str, Any] = {
        "passed": passed,
        "observed": observed,
        "expected": expected,
    }
    if detail is not None:
        payload["detail"] = detail
    checks[key] = payload


def _expected_floor_states(profile: str) -> tuple[set[str], set[str], set[str]]:
    if profile == "paper":
        return {"paper_ready"}, {"paper_candidate"}, {"paper_allowed"}
    if profile == "live":
        return (
            {"live_micro_ready", "live_scale_ready"},
            {"live_micro_candidate", "live_scale_candidate"},
            {"live_allowed"},
        )
    return (
        {"paper_ready", "live_micro_ready", "live_scale_ready"},
        {"paper_candidate", "live_micro_candidate", "live_scale_candidate"},
        {"paper_allowed", "live_allowed"},
    )


def _paper_route_probe_summary(
    status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
) -> dict[str, Any]:
    route_book = _mapping(status.get("route_reacquisition_book")) or _mapping(
        proof_floor.get("route_reacquisition_book")
    )
    route_summary = _mapping(route_book.get("summary"))
    probe = _mapping(route_book.get("paper_route_probe"))
    eligible_symbols = _sequence(probe.get("eligible_symbols")) or _sequence(
        route_summary.get("paper_route_probe_eligible_symbols")
    )
    active_symbols = _sequence(probe.get("active_symbols")) or _sequence(
        route_summary.get("paper_route_probe_active_symbols")
    )
    return {
        "route_book_present": bool(route_book),
        "route_book_schema_version": _text(route_book.get("schema_version")),
        "configured_enabled": _bool(probe.get("configured_enabled")),
        "configured_max_notional": _text(probe.get("configured_max_notional"), "0"),
        "active": _bool(probe.get("active")),
        "effective_max_notional": _text(probe.get("effective_max_notional"), "0"),
        "next_session_max_notional": _text(probe.get("next_session_max_notional"), "0"),
        "eligible_symbol_count": _int(
            probe.get("eligible_symbol_count"), default=len(eligible_symbols)
        ),
        "eligible_symbols": [
            _text(symbol) for symbol in eligible_symbols if _text(symbol)
        ],
        "active_symbols": [_text(symbol) for symbol in active_symbols if _text(symbol)],
        "blocking_reasons": [
            _text(reason)
            for reason in _sequence(probe.get("blocking_reasons"))
            if _text(reason)
        ],
        "capital_authority": _text(probe.get("capital_authority"), "none"),
    }


def _paper_route_target_plan_summary(
    paper_route_evidence: Mapping[str, Any] | None,
) -> dict[str, Any]:
    evidence = paper_route_evidence or {}
    plan = _mapping(evidence.get("next_paper_route_runtime_window_targets"))
    targets = [_mapping(target) for target in _sequence(plan.get("targets"))]
    handoff = _mapping(plan.get("runtime_window_import_handoff"))
    session_readiness = _mapping(plan.get("session_readiness"))
    required_flags = {
        _text(flag) for flag in _sequence(handoff.get("required_flags")) if _text(flag)
    }
    missing_required_flags = [
        flag
        for flag in REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS
        if flag not in required_flags
    ]
    import_blockers = [
        _text(reason)
        for reason in (
            _sequence(handoff.get("import_blockers"))
            or _sequence(session_readiness.get("import_blockers"))
        )
        if _text(reason)
    ]
    runtime_window_audit = _mapping(evidence.get("runtime_window_import_audit"))
    runtime_window_diagnostics = _mapping(runtime_window_audit.get("diagnostics"))
    account_clean_blockers: list[str] = []

    def add_account_blocker(reason: Any) -> None:
        blocker = _text(reason)
        if blocker and blocker not in account_clean_blockers:
            account_clean_blockers.append(blocker)

    account_pre_session_readiness = _mapping(plan.get("account_pre_session_readiness"))
    for reason in _sequence(account_pre_session_readiness.get("blockers")):
        add_account_blocker(reason)
    for key in ("account_state_blockers", "account_contamination_blockers"):
        for reason in _sequence(runtime_window_diagnostics.get(key)):
            add_account_blocker(reason)
    target_summaries: list[dict[str, Any]] = []
    skipped_target_summaries: list[dict[str, Any]] = []
    missing_identity_count = 0
    probe_contract_count = 0
    promotion_blocked_count = 0
    health_gate_ready_count = 0
    health_gate_blockers: list[str] = []
    health_gate_promotion_blockers: list[str] = []
    health_gate_continuity_reasons: list[str] = []
    health_gate_drift_reasons: list[str] = []
    for target in targets:
        missing_identity = [
            field
            for field in (
                "hypothesis_id",
                "candidate_id",
                "strategy_family",
                "strategy_name",
                "account_label",
                "source_dsn_env",
                "source_kind",
                "window_start",
                "window_end",
            )
            if not _text(target.get(field))
        ]
        if missing_identity:
            missing_identity_count += 1
        probe_symbols = [
            _text(symbol)
            for symbol in _sequence(target.get("paper_route_probe_symbols"))
            if _text(symbol)
        ]
        probe_notional_positive = _decimal_positive(
            target.get("paper_route_probe_next_session_max_notional")
        )
        if probe_symbols and probe_notional_positive:
            probe_contract_count += 1
        promotion_blocked = (
            not _bool(target.get("promotion_allowed"))
            and not _bool(target.get("final_promotion_authorized"))
            and not _bool(target.get("final_promotion_allowed"))
            and (_decimal(target.get("max_notional")) or Decimal("0")) == 0
        )
        if promotion_blocked:
            promotion_blocked_count += 1
        health_gate = _mapping(target.get("runtime_window_import_health_gate"))
        target_health_blockers = [
            _text(reason)
            for reason in _sequence(
                target.get("runtime_window_import_health_gate_blockers")
            )
            if _text(reason)
        ]
        for reason in _sequence(health_gate.get("blockers")):
            blocker = _text(reason)
            if blocker and blocker not in target_health_blockers:
                target_health_blockers.append(blocker)
        target_health_promotion_blockers = [
            _text(reason)
            for reason in _sequence(
                target.get("runtime_window_import_promotion_blockers")
            )
            if _text(reason)
        ]
        for reason in _sequence(health_gate.get("promotion_blockers")):
            blocker = _text(reason)
            if blocker and blocker not in target_health_promotion_blockers:
                target_health_promotion_blockers.append(blocker)
        dependency_quorum_decision = _text(
            target.get("dependency_quorum_decision")
            or health_gate.get("dependency_quorum_decision")
        )
        continuity_ok = target.get("continuity_ok", health_gate.get("continuity_ok"))
        drift_ok = target.get("drift_ok", health_gate.get("drift_ok"))
        continuity_reason = _text(
            target.get("continuity_reason") or health_gate.get("continuity_reason")
        )
        drift_reason = _text(
            target.get("drift_reason") or health_gate.get("drift_reason")
        )
        if not health_gate:
            target_health_blockers.append("runtime_window_import_health_gate_missing")
        if dependency_quorum_decision != "allow":
            target_health_blockers.append("dependency_quorum_not_allow")
        if not _health_gate_bool(continuity_ok):
            target_health_blockers.append("continuity_not_ok")
        if not _health_gate_bool(drift_ok) and not target_health_promotion_blockers:
            target_health_promotion_blockers.append("drift_not_ok")
        target_health_blockers = sorted(set(target_health_blockers))
        target_health_promotion_blockers = sorted(set(target_health_promotion_blockers))
        if not target_health_blockers:
            health_gate_ready_count += 1
        for blocker in target_health_blockers:
            if blocker not in health_gate_blockers:
                health_gate_blockers.append(blocker)
        for blocker in target_health_promotion_blockers:
            if blocker not in health_gate_promotion_blockers:
                health_gate_promotion_blockers.append(blocker)
        if (
            continuity_reason
            and continuity_reason not in health_gate_continuity_reasons
        ):
            health_gate_continuity_reasons.append(continuity_reason)
        if drift_reason and drift_reason not in health_gate_drift_reasons:
            health_gate_drift_reasons.append(drift_reason)
        target_account_state = _mapping(
            target.get("paper_route_account_pre_session_state")
        )
        target_account_blockers = [
            _text(reason)
            for reason in _sequence(
                target.get("paper_route_account_pre_session_blockers")
            )
            if _text(reason)
        ]
        for reason in _sequence(target_account_state.get("blockers")):
            blocker = _text(reason)
            if blocker and blocker not in target_account_blockers:
                target_account_blockers.append(blocker)
        for blocker in target_account_blockers:
            add_account_blocker(blocker)
        target_summaries.append(
            {
                "hypothesis_id": _text(target.get("hypothesis_id")),
                "candidate_id": _text(target.get("candidate_id")),
                "strategy_name": _text(target.get("strategy_name")),
                "account_label": _text(target.get("account_label")),
                "source_dsn_env": _text(target.get("source_dsn_env")),
                "source_kind": _text(target.get("source_kind")),
                "window_start": _text(target.get("window_start")),
                "window_end": _text(target.get("window_end")),
                "paper_route_probe_symbols": probe_symbols,
                "paper_route_probe_next_session_max_notional": _text(
                    target.get("paper_route_probe_next_session_max_notional")
                ),
                "promotion_blocked": promotion_blocked,
                "dependency_quorum_decision": dependency_quorum_decision,
                "continuity_ok": _text(continuity_ok),
                "continuity_reason": continuity_reason,
                "drift_ok": _text(drift_ok),
                "drift_reason": drift_reason,
                "runtime_window_import_health_gate_blockers": target_health_blockers,
                "runtime_window_import_promotion_blockers": (
                    target_health_promotion_blockers
                ),
                "paper_route_account_pre_session_state": _text(
                    target_account_state.get("state")
                ),
                "paper_route_account_pre_session_blockers": sorted(
                    set(target_account_blockers)
                ),
                "missing_identity_fields": missing_identity,
            }
        )
    for skipped_target in (
        _mapping(target) for target in _sequence(plan.get("skipped_targets"))
    ):
        skipped_blockers = [
            _text(reason)
            for reason in _sequence(skipped_target.get("missing_or_blocking_fields"))
            if _text(reason)
        ]
        for reason in _sequence(
            skipped_target.get("paper_route_account_pre_session_blockers")
        ):
            blocker = _text(reason)
            if blocker and blocker not in skipped_blockers:
                skipped_blockers.append(blocker)
        skipped_account_state = _mapping(
            skipped_target.get("paper_route_account_pre_session_state")
        )
        for reason in _sequence(skipped_account_state.get("blockers")):
            blocker = _text(reason)
            if blocker and blocker not in skipped_blockers:
                skipped_blockers.append(blocker)
        if (
            _text(skipped_target.get("reason"))
            == "paper_route_account_pre_session_not_clean"
        ):
            for blocker in skipped_blockers:
                add_account_blocker(blocker)
        skipped_target_summaries.append(
            {
                "hypothesis_id": _text(skipped_target.get("hypothesis_id")),
                "candidate_id": _text(skipped_target.get("candidate_id")),
                "reason": _text(skipped_target.get("reason")),
                "blockers": sorted(set(skipped_blockers)),
                "paper_route_account_pre_session_state": _text(
                    skipped_account_state.get("state")
                ),
            }
        )
    target_count = _int(plan.get("target_count"), default=len(targets))
    import_ready = _bool(handoff.get("import_ready")) or _bool(
        session_readiness.get("import_ready")
    )
    return {
        "present": bool(plan),
        "schema_version": _text(plan.get("schema_version")),
        "target_count": target_count,
        "actual_target_count": len(targets),
        "skipped_target_count": _int(plan.get("skipped_target_count")),
        "session_window": _mapping(plan.get("session_window")),
        "session_readiness_state": _text(session_readiness.get("state")),
        "import_ready": import_ready,
        "import_blockers": import_blockers,
        "required_flags": sorted(required_flags),
        "missing_required_flags": missing_required_flags,
        "targets": target_summaries,
        "skipped_targets": skipped_target_summaries,
        "missing_identity_count": missing_identity_count,
        "probe_contract_count": probe_contract_count,
        "promotion_blocked_count": promotion_blocked_count,
        "account_clean": not account_clean_blockers,
        "account_clean_blockers": sorted(account_clean_blockers),
        "runtime_window_import_health_gate": {
            "ready": bool(targets)
            and health_gate_ready_count == len(targets)
            and not health_gate_blockers,
            "target_count": len(targets),
            "ready_target_count": health_gate_ready_count,
            "blocked_target_count": max(0, len(targets) - health_gate_ready_count),
            "blockers": health_gate_blockers,
            "promotion_blockers": health_gate_promotion_blockers,
            "continuity_reasons": health_gate_continuity_reasons,
            "drift_reasons": health_gate_drift_reasons,
        },
    }


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
    target_plan_health_gate = _mapping(
        paper_route_target_plan.get("runtime_window_import_health_gate")
    )
    probe_blockers = [
        _text(reason)
        for reason in _sequence(paper_route_probe.get("blocking_reasons"))
        if _text(reason)
    ]
    import_blockers = [
        _text(reason)
        for reason in _sequence(paper_route_target_plan.get("import_blockers"))
        if _text(reason)
    ]
    allowed_probe_blockers = {"market_session_closed"}
    allowed_import_blockers = {"paper_route_session_window_not_open"}
    conditions = {
        "profile_allows_paper": profile in {"paper", "either"},
        "market_open_not_required": not require_market_open,
        "market_closed": not market_open,
        "probe_candidate_requirement_satisfied": (
            require_paper_route_probe_candidate or require_paper_route_target_plan
        ),
        "target_plan_required": require_paper_route_target_plan,
        "import_ready_not_required": not require_paper_route_import_ready,
        "runtime_profit_proof_not_required": not require_runtime_ledger_profit_proof,
        "runtime_packet_not_required": not require_runtime_ledger_proof_packet,
        "probe_present": bool(paper_route_probe.get("route_book_present")),
        "probe_configured": _bool(paper_route_probe.get("configured_enabled")),
        "probe_symbols_present": _int(paper_route_probe.get("eligible_symbol_count"))
        > 0,
        "probe_next_notional_positive": _decimal_positive(
            paper_route_probe.get("next_session_max_notional")
        ),
        "probe_blockers_only_market_closed": all(
            blocker in allowed_probe_blockers for blocker in probe_blockers
        ),
        "target_plan_present": bool(paper_route_target_plan.get("present")),
        "target_plan_targets_present": _int(
            paper_route_target_plan.get("actual_target_count")
        )
        > 0,
        "target_plan_identity_complete": _int(
            paper_route_target_plan.get("missing_identity_count")
        )
        == 0,
        "target_plan_probe_contract_ready": _int(
            paper_route_target_plan.get("probe_contract_count")
        )
        == _int(paper_route_target_plan.get("actual_target_count"))
        and _int(paper_route_target_plan.get("actual_target_count")) > 0,
        "target_plan_promotion_blocked": _int(
            paper_route_target_plan.get("promotion_blocked_count")
        )
        == _int(paper_route_target_plan.get("actual_target_count"))
        and _int(paper_route_target_plan.get("actual_target_count")) > 0,
        "target_plan_account_clean": _bool(
            paper_route_target_plan.get("account_clean")
        ),
        "target_plan_health_gate_ready": _bool(target_plan_health_gate.get("ready")),
        "target_plan_import_blockers_only_session_not_open": all(
            blocker in allowed_import_blockers for blocker in import_blockers
        ),
    }
    ready = all(conditions.values())
    return {
        "ready": ready,
        "conditions": conditions,
        "softened_checks": sorted(_PAPER_ROUTE_PREOPEN_SOFT_CHECKS) if ready else [],
        "probe_blockers": probe_blockers,
        "import_blockers": import_blockers,
        "account_clean_blockers": list(
            _sequence(paper_route_target_plan.get("account_clean_blockers"))
        ),
        "note": (
            "pre-open evidence collection only; not promotion, runtime-ledger, "
            "or profitability proof"
        ),
    }


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
    packet = _mapping(runtime_ledger_proof_packet)
    authority = _mapping(packet.get("promotion_authority"))
    schema_version = _text(packet.get("schema_version"))
    allowed = authority.get("allowed") is True
    packet_ok = packet.get("ok") is True and allowed
    expected_schema = schema_version == RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION
    _add_check(
        checks,
        "runtime_ledger_proof_packet_authority",
        passed=bool(packet) and expected_schema and packet_ok,
        observed={
            "present": bool(packet),
            "schema_version": schema_version,
            "proof_mode": _text(packet.get("proof_mode")),
            "final_authority_ok": packet.get("final_authority_ok"),
            "ok": packet.get("ok"),
            "verdict": _text(packet.get("verdict")),
            "authority_allowed": authority.get("allowed"),
            "authority_reason": _text(authority.get("reason")),
            "blocking_reasons": [
                _text(reason)
                for reason in _sequence(authority.get("blocking_reasons"))
                if _text(reason)
            ],
            "failed_checks": [
                _text(check)
                for check in _sequence(authority.get("failed_checks"))
                if _text(check)
            ],
        },
        expected={
            "schema_version": RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
            "ok": True,
            "promotion_authority.allowed": True,
        },
    )


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


def evaluate_trading_readiness(
    status: Mapping[str, Any],
    *,
    completion_status: Mapping[str, Any] | None = None,
    paper_route_evidence: Mapping[str, Any] | None = None,
    runtime_ledger_proof_packet: Mapping[str, Any] | None = None,
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
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": not failed_checks,
        "profile": profile,
        "failed_checks": failed_checks,
        "checks": checks,
        "paper_route_probe": paper_route_probe,
        "paper_route_target_plan": paper_route_target_plan,
        "paper_route_preopen_evidence_collection": (
            paper_route_preopen_evidence_collection
        ),
        "completion_profit_proof": {
            "required": require_runtime_ledger_profit_proof,
            "gate_id": DOC29_LIVE_SCALE_GATE,
            "min_runtime_ledger_net_pnl": str(min_runtime_ledger_net_pnl),
            "min_runtime_ledger_trading_days": min_runtime_ledger_trading_days,
            "min_runtime_ledger_daily_net_pnl": str(min_runtime_ledger_daily_net_pnl),
        },
        "runtime_ledger_proof_packet": {
            "required": require_runtime_ledger_proof_packet,
            "schema_version": _text(
                _mapping(runtime_ledger_proof_packet).get("schema_version")
            ),
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
        help="Path to a /trading/paper-route-evidence JSON payload.",
    )
    paper_route_evidence_source.add_argument(
        "--paper-route-evidence-url",
        help="URL returning a /trading/paper-route-evidence JSON payload.",
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
        help="Require /trading/paper-route-evidence to expose a next-session runtime-window target plan.",
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


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    status = (
        _load_json_object(args.status_file)
        if args.status_file is not None
        else _load_status_url(
            str(args.status_url), timeout_seconds=args.timeout_seconds
        )
    )
    completion_status = _load_optional_json_object(
        path=args.completion_file,
        url=args.completion_url,
        timeout_seconds=args.timeout_seconds,
    )
    paper_route_evidence = _load_optional_json_object(
        path=args.paper_route_evidence_file,
        url=args.paper_route_evidence_url,
        timeout_seconds=args.timeout_seconds,
    )
    runtime_ledger_proof_packet = _load_optional_json_object(
        path=args.runtime_ledger_proof_packet_file,
        url=args.runtime_ledger_proof_packet_url,
        timeout_seconds=args.timeout_seconds,
    )
    min_runtime_ledger_net_pnl = _decimal(args.min_runtime_ledger_net_pnl)
    if min_runtime_ledger_net_pnl is None:
        raise SystemExit(
            f"--min-runtime-ledger-net-pnl must be decimal, got {args.min_runtime_ledger_net_pnl!r}"
        )
    min_runtime_ledger_daily_net_pnl = _decimal(args.min_runtime_ledger_daily_net_pnl)
    if min_runtime_ledger_daily_net_pnl is None:
        raise SystemExit(
            "--min-runtime-ledger-daily-net-pnl must be decimal, "
            f"got {args.min_runtime_ledger_daily_net_pnl!r}"
        )
    result = evaluate_trading_readiness(
        status,
        completion_status=completion_status,
        paper_route_evidence=paper_route_evidence,
        runtime_ledger_proof_packet=runtime_ledger_proof_packet,
        profile=str(args.profile),
        min_routeable_symbols=max(0, int(args.min_routeable_symbols)),
        min_decisions=max(0, int(args.min_decisions)),
        min_orders=max(0, int(args.min_orders)),
        min_runtime_ledger_net_pnl=min_runtime_ledger_net_pnl,
        min_runtime_ledger_trading_days=max(
            0, int(args.min_runtime_ledger_trading_days)
        ),
        min_runtime_ledger_daily_net_pnl=min_runtime_ledger_daily_net_pnl,
        require_market_open=not bool(args.allow_closed_session),
        require_quant_fresh=not bool(args.allow_informational_quant),
        require_paper_route_probe_candidate=bool(
            args.require_paper_route_probe_candidate
        ),
        require_paper_route_target_plan=bool(args.require_paper_route_target_plan),
        require_paper_route_import_ready=bool(args.require_paper_route_import_ready),
        require_runtime_ledger_profit_proof=bool(
            args.require_runtime_ledger_profit_proof
        ),
        require_runtime_ledger_proof_packet=bool(
            args.require_runtime_ledger_proof_packet
        ),
        allow_paper_route_preopen_evidence_collection=bool(
            args.allow_paper_route_preopen_evidence_collection
        ),
    )
    result["evaluated_at"] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
