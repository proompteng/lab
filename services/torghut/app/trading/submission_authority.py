"""Operator-facing submission authority status."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast


def build_submission_authority_status(
    live_submission_gate: Mapping[str, Any],
    *,
    simple_lane_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Summarize the effective submit authority without changing gate decisions."""

    simple_lane = _mapping(simple_lane_status)
    operational_gate = (
        _mapping(live_submission_gate.get("operational_submission_gate"))
        or live_submission_gate
    )
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


__all__ = ["build_submission_authority_status"]
