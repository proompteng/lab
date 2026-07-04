"""Operator-facing submission authority status."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast


_RETIRED_SUBMISSION_AUTHORITY_BLOCKERS = frozenset(
    {
        "hypothesis_not_promotion_eligible",
        "runtime_ledger_profit_target_source_collection_pending",
        "runtime_ledger_source_collection_pending",
    }
)


def build_submission_authority_status(
    live_submission_gate: Mapping[str, Any],
    *,
    simple_lane_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Summarize the effective submit authority after retiring proof blockers."""

    simple_lane = _mapping(simple_lane_status)
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
        "simple_lane_contract": {
            "submit_enabled": _bool(simple_lane.get("submit_enabled")),
            "live_submit_enabled": _bool(simple_lane.get("live_submit_enabled")),
            "paper_route_probe_enabled": _bool(
                simple_lane.get("paper_route_probe_enabled")
            ),
            "paper_route_probe_allow_live_mode": _bool(
                simple_lane.get("paper_route_probe_allow_live_mode")
            ),
            "max_notional_per_order": simple_lane.get("max_notional_per_order"),
            "max_notional_per_symbol": simple_lane.get("max_notional_per_symbol"),
            "max_gross_exposure_pct_equity": simple_lane.get(
                "max_gross_exposure_pct_equity"
            ),
        },
    }


def operational_submission_gate_status(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    """Return the effective operational gate with retired proof blockers removed."""

    nested_gate = _mapping(live_submission_gate.get("operational_submission_gate"))
    gate = nested_gate or live_submission_gate
    raw_blocked_reasons = _strings(gate.get("blocked_reasons"))
    blocked_reasons = _active_submission_blockers(raw_blocked_reasons)
    raw_reason = _text(gate.get("reason"), "")
    raw_allowed = _bool(gate.get("allowed"))
    reason = _active_submission_reason(raw_reason, blocked_reasons, raw_allowed)
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
    if _is_retired_submission_blocker(raw_reason):
        return True
    if raw_blocked_reasons and not active_blocked_reasons:
        return True
    return False


def _active_submission_blockers(blocked_reasons: list[str]) -> list[str]:
    return [
        reason
        for reason in blocked_reasons
        if not _is_retired_submission_blocker(reason)
    ]


def _active_submission_reason(
    raw_reason: str,
    blocked_reasons: list[str],
    raw_allowed: bool,
) -> str:
    if blocked_reasons:
        return blocked_reasons[0]
    if _is_retired_submission_blocker(raw_reason):
        return "operational_submission_ready"
    if raw_allowed:
        return raw_reason or "operational_submission_ready"
    return raw_reason or "unknown"


def _is_retired_submission_blocker(reason: str) -> bool:
    return reason in _RETIRED_SUBMISSION_AUTHORITY_BLOCKERS


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
