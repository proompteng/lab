"""Operator-facing submission authority status."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast


_OPERATIONAL_SUBMISSION_REASONS = frozenset(
    {
        "broker_submit_failed",
        "emergency_stop_active",
        "emergency_stop_triggered",
        "invalid_order",
        "kill_switch_enabled",
        "live_submit_disabled",
        "risk_breach",
        "submit_disabled",
        "testnet_after_hours_disabled",
        "trading_disabled",
    }
)
_OPERATIONAL_SUBMISSION_SUFFIXES = ("_unavailable",)
_OPERATIONAL_SUBMISSION_PREFIXES = ("dependency_not_ready:",)
_DIAGNOSTIC_SUBMISSION_REASONS = frozenset(
    {
        "non_operational_diagnostic",
        "runtime_profit_target_import_required",
        "runtime_window_import_required",
    }
)
_DIAGNOSTIC_SUBMISSION_PREFIXES = (
    "proof_",
    "promotion_",
    "research_",
    "source_collection_",
    "runtime_ledger_",
)
_DIAGNOSTIC_SUBMISSION_SUFFIXES = ("_not_promotion_eligible",)


def build_submission_authority_status(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    """Summarize effective submit authority from operational blockers only."""

    operational_gate = operational_submission_gate_status(live_submission_gate)
    operational_allowed = _bool(operational_gate.get("allowed"))
    effective_mode = "operational_submission" if operational_allowed else "blocked"
    return {
        "schema_version": "torghut.submission-authority.v1",
        "effective_submit_mode": effective_mode,
        "can_submit_now": operational_allowed,
        "authority_scope": (
            "operational_submission" if operational_allowed else "none"
        ),
        "reason": _text(operational_gate.get("reason"), "unknown"),
        "operational_submission_gate": {
            "allowed": operational_allowed,
            "reason": _text(operational_gate.get("reason"), "unknown"),
            "blocked_reasons": _strings(operational_gate.get("blocked_reasons")),
            "execution_route": _mapping(operational_gate.get("execution_route")),
        },
    }


def operational_submission_gate_status(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    """Return the effective operational gate with diagnostic reasons removed."""

    nested_gate = _mapping(live_submission_gate.get("operational_submission_gate"))
    gate = nested_gate or live_submission_gate
    raw_blocked_reasons = _strings(gate.get("blocked_reasons"))
    raw_reason = _text(gate.get("reason"), "")
    raw_allowed = _bool(gate.get("allowed"))
    blocked_reasons = _active_submission_blockers(
        raw_blocked_reasons,
        raw_reason=raw_reason,
        raw_allowed=raw_allowed,
    )
    reason = _active_submission_reason(
        raw_reason,
        raw_blocked_reasons,
        blocked_reasons,
        raw_allowed,
    )
    allowed = _active_submission_allowed(
        raw_allowed=raw_allowed,
        raw_reason=raw_reason,
        raw_blocked_reasons=raw_blocked_reasons,
        active_blocked_reasons=blocked_reasons,
    )
    if allowed and not blocked_reasons:
        reason = "operational_submission_ready"
    return {
        "allowed": allowed,
        "reason": reason,
        "blocked_reasons": blocked_reasons,
        "execution_route": _mapping(gate.get("execution_route")),
    }


def _active_submission_allowed(
    *,
    raw_allowed: bool,
    raw_reason: str,
    raw_blocked_reasons: list[str],
    active_blocked_reasons: list[str],
) -> bool:
    if active_blocked_reasons:
        return False
    if raw_allowed:
        return True
    return _has_only_diagnostic_submission_reasons(raw_reason, raw_blocked_reasons)


def _active_submission_blockers(
    blocked_reasons: list[str],
    *,
    raw_reason: str,
    raw_allowed: bool,
) -> list[str]:
    active = [
        reason
        for reason in [raw_reason, *blocked_reasons]
        if _is_operational_submission_reason(reason)
    ]
    if raw_allowed:
        return active
    unknown_blockers = [
        reason
        for reason in [raw_reason, *blocked_reasons]
        if reason
        and not _is_operational_submission_reason(reason)
        and not _is_diagnostic_submission_reason(reason)
    ]
    return list(dict.fromkeys([*active, *unknown_blockers]))


def _active_submission_reason(
    raw_reason: str,
    raw_blocked_reasons: list[str],
    blocked_reasons: list[str],
    raw_allowed: bool,
) -> str:
    if blocked_reasons:
        return blocked_reasons[0]
    if _has_only_diagnostic_submission_reasons(raw_reason, raw_blocked_reasons):
        return "operational_submission_ready"
    if raw_allowed:
        return raw_reason or "operational_submission_ready"
    return raw_reason or "unknown"


def _is_operational_submission_reason(reason: str) -> bool:
    return (
        reason in _OPERATIONAL_SUBMISSION_REASONS
        or reason.endswith(_OPERATIONAL_SUBMISSION_SUFFIXES)
        or reason.startswith(_OPERATIONAL_SUBMISSION_PREFIXES)
    )


def _has_only_diagnostic_submission_reasons(
    raw_reason: str,
    raw_blocked_reasons: list[str],
) -> bool:
    reasons = [reason for reason in [raw_reason, *raw_blocked_reasons] if reason]
    return bool(reasons) and all(
        _is_diagnostic_submission_reason(reason) for reason in reasons
    )


def _is_diagnostic_submission_reason(reason: str) -> bool:
    return (
        reason in _DIAGNOSTIC_SUBMISSION_REASONS
        or reason.startswith(_DIAGNOSTIC_SUBMISSION_PREFIXES)
        or reason.endswith(_DIAGNOSTIC_SUBMISSION_SUFFIXES)
    )


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _bool(value: object) -> bool:
    return value is True


def _optional_text(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _text(value: object, default: str) -> str:
    return _optional_text(value) or default


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    strings: list[str] = []
    for item in cast(list[object], value):
        text = _optional_text(item)
        if text:
            strings.append(text)
    return strings


__all__ = ["build_submission_authority_status", "operational_submission_gate_status"]
