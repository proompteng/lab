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

# ruff: noqa: F401,F811,F821


SCHEMA_VERSION = "torghut.trading-readiness-verification.v1"

ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION = "torghut.route-reacquisition-board.v1"

ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION = "torghut.route-reacquisition-book.v1"

NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION = (
    "torghut.next-paper-route-runtime-window-targets.v1"
)

RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION = (
    "torghut.runtime-ledger-live-paper-proof-packet.v1"
)

TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION = (
    "torghut.tigerbeetle-runtime-ledger-parity.v1"
)

TIGERBEETLE_PARITY_STATUS_PASS = "pass"

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


def _text_list(value: object) -> list[str]:
    return [_text(item) for item in _sequence(value) if _text(item)]


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


_QUOTE_FILLABILITY_REASON_TOKENS = (
    "quote",
    "bid",
    "ask",
    "spread",
    "fillability",
    "fillable",
    "routeability",
)

_QUOTE_FILLABILITY_REPAIR_ACTIONS: Mapping[str, str] = {
    "stale_quote": "refresh_quote_snapshot_and_recompute_route_fillability",
    "missing_executable_quote": "collect_bid_ask_quote_before_routeability_claim",
    "missing_bid": "collect_bid_quote_before_routeability_claim",
    "missing_ask": "collect_ask_quote_before_routeability_claim",
    "non_positive_bid": "refresh_bid_quote_before_routeability_claim",
    "non_positive_ask": "refresh_ask_quote_before_routeability_claim",
    "crossed_quote": "refresh_uncrossed_executable_quote_before_routeability_claim",
    "spread_bps_exceeded": "wait_for_tighter_executable_quote_before_routeability_claim",
    "wide_spread_midpoint_jump": "collect_fresh_tight_quote_and_recheck_midpoint_jump",
    "source_signal_rejected_by_quote_quality": "inspect_rejected_signal_quote_quality_events",
}


def _quote_fillability_reason(reason: object) -> str:
    text = _text(reason)
    if not text:
        return ""
    lowered = text.lower()
    if lowered.startswith("source_reject_"):
        lowered = lowered.removeprefix("source_reject_")
    if lowered in _QUOTE_FILLABILITY_REPAIR_ACTIONS:
        return text
    if any(token in lowered for token in _QUOTE_FILLABILITY_REASON_TOKENS):
        return text
    return ""


def _quote_fillability_repair_action(reasons: Sequence[str]) -> str:
    for reason in reasons:
        lowered = reason.lower()
        if lowered.startswith("source_reject_"):
            lowered = lowered.removeprefix("source_reject_")
        action = _QUOTE_FILLABILITY_REPAIR_ACTIONS.get(lowered)
        if action:
            return action
    return "repair_quote_quality_or_fillability_before_runtime_ledger_collection"


def _append_unique_text(target: list[str], value: object) -> None:
    text = _text(value)
    if text and text not in target:
        target.append(text)


def _paper_route_quote_fillability_summary(
    *,
    evidence: Mapping[str, Any],
    targets: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    runtime_window_audit = _mapping(evidence.get("runtime_window_import_audit"))
    diagnostics = _mapping(runtime_window_audit.get("diagnostics"))
    reasons: list[str] = []
    target_summaries: list[dict[str, Any]] = []

    for key in (
        "rejected_signal_diagnostic_reasons",
        "quote_fillability_reasons",
        "quote_quality_reasons",
        "fillability_reasons",
    ):
        for reason in _sequence(diagnostics.get(key)):
            _append_unique_text(reasons, _quote_fillability_reason(reason))

    for raw_blocker in _sequence(runtime_window_audit.get("blockers")):
        _append_unique_text(reasons, _quote_fillability_reason(raw_blocker))
    for raw_target_blocker in _sequence(runtime_window_audit.get("target_blockers")):
        target_blocker = _mapping(raw_target_blocker)
        for blocker in _sequence(target_blocker.get("blockers")):
            _append_unique_text(reasons, _quote_fillability_reason(blocker))

    for target in targets:
        routeability = (
            _mapping(target.get("paper_route_quote_routeability"))
            or _mapping(target.get("quote_routeability"))
            or _mapping(target.get("quote_fillability"))
            or _mapping(target.get("fillability"))
            or _mapping(target.get("routeability"))
        )
        target_reasons: list[str] = []
        routeability_reason = _quote_fillability_reason(routeability.get("reason"))
        if routeability_reason:
            target_reasons.append(routeability_reason)
        for key in ("blocking_reasons", "reasons", "reason_codes"):
            for reason in _sequence(routeability.get(key)):
                normalized = _quote_fillability_reason(reason)
                if normalized and normalized not in target_reasons:
                    target_reasons.append(normalized)
        for reason in target_reasons:
            _append_unique_text(reasons, reason)
        if routeability or target_reasons:
            target_summaries.append(
                {
                    "hypothesis_id": _text(target.get("hypothesis_id")),
                    "candidate_id": _text(target.get("candidate_id")),
                    "strategy_name": _text(target.get("strategy_name")),
                    "symbol": _text(routeability.get("symbol") or target.get("symbol")),
                    "status": _text(routeability.get("status"), "unknown"),
                    "reasons": target_reasons,
                    "repair_action": _text(routeability.get("repair_action"))
                    or (
                        _quote_fillability_repair_action(target_reasons)
                        if target_reasons
                        else "none"
                    ),
                    "quote_age_seconds": _text(routeability.get("quote_age_seconds")),
                    "spread_bps": _text(routeability.get("spread_bps")),
                    "source": _text(routeability.get("source")),
                }
            )

    for audit_key in ("target_audits", "runtime_window_import_target_audits"):
        for raw_audit in _sequence(evidence.get(audit_key)):
            audit = _mapping(raw_audit)
            rejected_signal_activity = _mapping(audit.get("rejected_signal_activity"))
            audit_reasons: list[str] = []
            for reason in _sequence(rejected_signal_activity.get("blocking_reasons")):
                normalized = _quote_fillability_reason(reason)
                if normalized and normalized not in audit_reasons:
                    audit_reasons.append(normalized)
            for raw_reason_count in _sequence(
                rejected_signal_activity.get("reason_counts")
            ):
                reason_count = _mapping(raw_reason_count)
                normalized = _quote_fillability_reason(reason_count.get("reason"))
                if normalized and normalized not in audit_reasons:
                    audit_reasons.append(normalized)
            for reason in audit_reasons:
                _append_unique_text(reasons, reason)
            if audit_reasons:
                target = _mapping(audit.get("target"))
                target_summaries.append(
                    {
                        "hypothesis_id": _text(target.get("hypothesis_id")),
                        "candidate_id": _text(target.get("candidate_id")),
                        "strategy_name": _text(target.get("strategy_name")),
                        "symbol": "",
                        "status": "blocked",
                        "reasons": audit_reasons,
                        "repair_action": _quote_fillability_repair_action(
                            audit_reasons
                        ),
                        "quote_age_seconds": "",
                        "spread_bps": _text(
                            rejected_signal_activity.get("max_spread_bps")
                        ),
                        "source": "rejected_signal_activity",
                    }
                )

    present = bool(target_summaries or reasons)
    blocked = bool(reasons)
    return {
        "present": present,
        "state": "blocked" if blocked else ("clear" if present else "not_reported"),
        "blocked": blocked,
        "blocking_reasons": sorted(reasons),
        "repair_action": _quote_fillability_repair_action(sorted(reasons))
        if blocked
        else "none",
        "targets": target_summaries,
    }


__all__ = [name for name in globals() if not name.startswith("__")]
