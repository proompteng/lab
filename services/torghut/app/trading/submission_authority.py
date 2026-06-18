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

    bounded_gate = _mapping(
        live_submission_gate.get("bounded_live_paper_collection_gate")
    )
    simple_lane = _mapping(simple_lane_status)
    capital_allowed = _bool(live_submission_gate.get("allowed"))
    bounded_allowed = _bool(bounded_gate.get("allowed"))
    bounded_active = _bool(bounded_gate.get("active"))
    effective_mode = _effective_submit_mode(
        capital_allowed=capital_allowed,
        bounded_allowed=bounded_allowed,
        bounded_active=bounded_active,
    )
    return {
        "schema_version": "torghut.submission-authority.v1",
        "effective_submit_mode": effective_mode,
        "can_submit_now": effective_mode
        in {"capital_promotion", "bounded_live_paper_collection"},
        "authority_scope": _authority_scope(
            effective_mode=effective_mode,
            bounded_gate=bounded_gate,
        ),
        "reason": _effective_reason(
            effective_mode=effective_mode,
            live_submission_gate=live_submission_gate,
            bounded_gate=bounded_gate,
        ),
        "capital_promotion_gate": {
            "allowed": capital_allowed,
            "reason": _text(live_submission_gate.get("reason"), "unknown"),
            "blocked_reasons": _strings(live_submission_gate.get("blocked_reasons")),
            "capital_stage": _optional_text(live_submission_gate.get("capital_stage")),
            "capital_state": _optional_text(live_submission_gate.get("capital_state")),
            "certificate_id": _optional_text(
                live_submission_gate.get("certificate_id")
            ),
        },
        "bounded_collection_gate": {
            "allowed": bounded_allowed,
            "active": bounded_active,
            "reason": _text(bounded_gate.get("reason"), "not_configured"),
            "blocked_reasons": _strings(bounded_gate.get("blocked_reasons")),
            "authority_scope": _text(
                bounded_gate.get("authority_scope"),
                "bounded_evidence_collection_only",
            ),
            "source_collection_target_count": _int(
                bounded_gate.get("source_collection_target_count")
            ),
            "source_collection_profit_target_count": _int(
                bounded_gate.get("source_collection_profit_target_count")
            ),
            "paper_route_probe_max_notional": _optional_text(
                bounded_gate.get("paper_route_probe_max_notional")
            ),
            "market_session_open": bounded_gate.get("market_session_open"),
            "capital_gate_blocked_reasons": _strings(
                bounded_gate.get("capital_gate_blocked_reasons")
            ),
            "collection_only_blockers": _strings(
                bounded_gate.get("collection_only_blockers")
            ),
            "hard_blockers": _strings(bounded_gate.get("hard_blockers")),
        },
        "simple_lane_contract": {
            "submit_enabled": _bool(simple_lane.get("submit_enabled")),
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


def _effective_submit_mode(
    *,
    capital_allowed: bool,
    bounded_allowed: bool,
    bounded_active: bool,
) -> str:
    if capital_allowed:
        return "capital_promotion"
    if bounded_active:
        return "bounded_live_paper_collection"
    if bounded_allowed:
        return "bounded_live_paper_collection_waiting_for_session"
    return "blocked"


def _authority_scope(
    *,
    effective_mode: str,
    bounded_gate: Mapping[str, Any],
) -> str:
    if effective_mode == "capital_promotion":
        return "capital_promotion"
    if effective_mode.startswith("bounded_live_paper_collection"):
        return _text(
            bounded_gate.get("authority_scope"),
            "bounded_evidence_collection_only",
        )
    return "none"


def _effective_reason(
    *,
    effective_mode: str,
    live_submission_gate: Mapping[str, Any],
    bounded_gate: Mapping[str, Any],
) -> str:
    if effective_mode.startswith("bounded_live_paper_collection"):
        return _text(bounded_gate.get("reason"), "bounded_collection_gate_unknown")
    return _text(live_submission_gate.get("reason"), "unknown")


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _bool(value: object) -> bool:
    return value is True


def _int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


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
