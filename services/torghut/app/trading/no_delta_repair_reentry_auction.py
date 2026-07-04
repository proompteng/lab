"""No-delta alpha repair reentry auction for routeable-candidate recovery."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from .read_model_utils import (
    append_unique_text as _append_unique,
    as_int as _int,
    as_mapping as _mapping,
    as_sequence as _sequence,
    as_text as _text,
    first_mapping as _top_queue_item,
    is_alpha_readiness_repair as _is_alpha_repair,
    parse_datetime_utc as _parse_datetime,
    stable_hash24 as _stable_hash,
    unique_text_list as _string_list,
)

NO_DELTA_REPAIR_REENTRY_AUCTION_SCHEMA_VERSION = (
    "torghut.no-delta-repair-reentry-auction.v1"
)
NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION = (
    "torghut.no-delta-repair-reentry-auction-ref.v1"
)
JANGAR_VERIFICATION_CARRY_SCHEMA_VERSION = "torghut.jangar-verification-carry.v1"

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md"
)
_COMPANION_JANGAR_DESIGN_REF = (
    "docs/agents/designs/"
    "201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md"
)
_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_ZERO_NOTIONAL_VALUES = {"0", "0.0", "0.00", "0.0000"}
_ROLLBACK_TARGET = (
    "stop emitting no_delta_repair_reentry_auction, keep alpha settlement and "
    "dividend evidence, and keep Torghut max_notional=0"
)
_RELEASE_CONDITION_CODES = [
    "source_revenue_repair_ref_changed",
    "evidence_window_changed",
    "blocker_set_changed",
    "required_receipt_set_changed",
    "selected_hypothesis_changed",
    "jangar_controller_ingestion_current",
    "jangar_verify_foreclosure_ticket_current",
    "schema_lineage_receipt_current",
    "empirical_receipt_current",
    "market_context_receipt_current",
    "execution_tca_receipt_current",
]
_SOURCE_CHANGE_CONDITIONS = {
    "source_revenue_repair_ref_changed",
    "source_ref_changed",
    "source_ref_changes",
}
_EVIDENCE_WINDOW_CONDITIONS = {
    "evidence_window_changed",
    "evidence_window_changes",
}
_BLOCKER_SET_CONDITIONS = {
    "blocker_set_changed",
    "blocker_set_changes",
}
_REQUIRED_RECEIPT_CONDITIONS = {
    "required_receipt_set_changed",
    "required_receipt_changes",
}
_SELECTED_HYPOTHESIS_CONDITIONS = {
    "selected_hypothesis_changed",
}
_EMPIRICAL_BLOCKERS = {
    "empirical_jobs_degraded",
    "empirical_jobs_not_ready",
    "job_ineligible:benchmark_parity",
    "job_ineligible:foundation_router_parity",
    "job_ineligible:janus_event_car",
    "job_ineligible:janus_hgrm_reward",
    "job_stale:benchmark_parity",
    "job_stale:foundation_router_parity",
    "job_stale:janus_event_car",
    "job_stale:janus_hgrm_reward",
}
_MARKET_CONTEXT_BLOCKERS = {
    "market_context_evidence_missing",
    "market_context_stale",
    "market_context_state_unknown",
}
_SCHEMA_LINEAGE_BLOCKERS = {
    "schema_lineage_missing",
    "strategy_hypothesis_lineage_missing",
    "required_feature_set_unavailable",
}
_TCA_BLOCKERS = {
    "execution_tca_above_guardrail",
    "execution_tca_expected_shortfall_samples_missing_non_promoting",
    "execution_tca_missing",
    "execution_tca_route_universe_exclusions_applied",
    "execution_tca_stale",
    "execution_tca_symbol_missing",
    "tca_evidence_stale",
}


def _zero_notional(value: object) -> bool:
    raw = _text(value)
    if raw in _ZERO_NOTIONAL_VALUES:
        return True
    try:
        return float(raw) == 0
    except ValueError:
        return False


def _release_condition_changes(
    alpha_repair_dividend_ledger: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
) -> set[str]:
    raw_changes = _string_list(
        alpha_repair_dividend_ledger.get("changed_release_conditions")
    )
    raw_changes = _append_unique(
        raw_changes,
        alpha_readiness_settlement_conveyor.get("changed_release_conditions"),
    )
    changes: set[str] = set()
    for condition in raw_changes:
        if condition in _SOURCE_CHANGE_CONDITIONS:
            changes.add("source_revenue_repair_ref_changed")
        elif condition in _EVIDENCE_WINDOW_CONDITIONS:
            changes.add("evidence_window_changed")
        elif condition in _BLOCKER_SET_CONDITIONS:
            changes.add("blocker_set_changed")
        elif condition in _REQUIRED_RECEIPT_CONDITIONS:
            changes.add("required_receipt_set_changed")
        elif condition in _SELECTED_HYPOTHESIS_CONDITIONS:
            changes.add("selected_hypothesis_changed")
        elif condition in _RELEASE_CONDITION_CODES:
            changes.add(condition)
    return changes


def _preserved_reason_codes(
    alpha_repair_dividend_ledger: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
) -> list[str]:
    selected_lane = _mapping(alpha_readiness_settlement_conveyor.get("selected_lane"))
    settlement_receipt = _mapping(
        alpha_readiness_settlement_conveyor.get("settlement_receipt")
    )
    return (
        _string_list(alpha_repair_dividend_ledger.get("preserved_reason_codes"))
        or _string_list(settlement_receipt.get("preserved_reason_codes"))
        or _string_list(selected_lane.get("before_reason_codes"))
    )


def _source_revenue_repair_ref(
    alpha_repair_dividend_ledger: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
) -> str:
    return (
        _text(alpha_repair_dividend_ledger.get("source_revenue_repair_ref"))
        or _text(alpha_readiness_settlement_conveyor.get("source_revenue_repair_ref"))
        or "torghut-revenue-repair-digest:unknown"
    )


def _selected_hypothesis_id(
    alpha_repair_dividend_ledger: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
) -> str:
    selected_lane = _mapping(alpha_readiness_settlement_conveyor.get("selected_lane"))
    return (
        _text(alpha_repair_dividend_ledger.get("selected_hypothesis_id"))
        or _text(selected_lane.get("hypothesis_id"))
        or "unknown"
    )


def _selected_value_gate(
    top_item: Mapping[str, Any],
    alpha_repair_dividend_ledger: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
) -> str:
    return (
        _text(alpha_repair_dividend_ledger.get("selected_value_gate"))
        or _text(alpha_readiness_settlement_conveyor.get("selected_value_gate"))
        or _text(top_item.get("value_gate"))
        or "routeable_candidate_count"
    )


def _active_no_delta_release_key(
    alpha_repair_dividend_ledger: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
) -> str:
    dividend_state = _text(alpha_repair_dividend_ledger.get("dividend_state"))
    dividend_launch = _mapping(alpha_repair_dividend_ledger.get("jangar_custody")).get(
        "launch_decision"
    )
    dividend_launch = _text(
        dividend_launch, _text(alpha_repair_dividend_ledger.get("launch_decision"))
    )
    conveyor_repeat = _text(
        _mapping(alpha_readiness_settlement_conveyor.get("selected_lane")).get(
            "repeat_launch_decision"
        ),
        _text(alpha_readiness_settlement_conveyor.get("repeat_launch_decision")),
    )
    active = (
        dividend_state == "no_delta"
        or dividend_launch == "deny"
        or conveyor_repeat == "deny"
        or _int(alpha_readiness_settlement_conveyor.get("active_no_delta_lease_count"))
        > 0
    )
    if not active:
        return ""
    return (
        _text(alpha_repair_dividend_ledger.get("no_delta_release_key"))
        or _text(alpha_readiness_settlement_conveyor.get("no_delta_release_key"))
        or _text(
            _mapping(alpha_readiness_settlement_conveyor.get("selected_lane")).get(
                "no_delta_release_key"
            )
        )
    )


def _build_jangar_verification_carry(
    *,
    generated: datetime,
    jangar_verification_carry: Mapping[str, Any] | None,
) -> dict[str, object]:
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    payload = _mapping(jangar_verification_carry)
    if not payload:
        return {
            "schema_version": JANGAR_VERIFICATION_CARRY_SCHEMA_VERSION,
            "carry_id": "jangar-verification-carry:unavailable",
            "generated_at": generated.isoformat(),
            "fresh_until": fresh_until.isoformat(),
            "status": "unavailable",
            "jangar_execution_trust_status": "unavailable",
            "jangar_source_rollout_truth_state": "unknown",
            "jangar_foreclosure_board_ref": None,
            "held_action_classes": ["dispatch_repair"],
            "blocked_action_classes": [],
            "required_jangar_receipt": "jangar.verify-trust-foreclosure-ticket.v1",
            "reason_codes": ["jangar_verification_carry_unavailable"],
        }

    board_id = _text(payload.get("board_id")) or _text(payload.get("carry_id"))
    fresh = _parse_datetime(payload.get("fresh_until"))
    status = _text(payload.get("status"), "current")
    execution_trust = _text(payload.get("execution_trust_status"), status)
    source_truth = _text(payload.get("source_rollout_truth_state"), "unknown")
    tickets: list[Mapping[str, Any]] = [
        _mapping(ticket)
        for ticket in _sequence(payload.get("foreclosure_tickets"))
        if _mapping(ticket)
    ]
    current_ticket: Mapping[str, Any] = {}
    for ticket in tickets:
        if _text(ticket.get("state")) in {"open", "closed", "current"}:
            current_ticket = ticket
            break
    reason_codes = _string_list(payload.get("reason_codes"))
    if fresh is not None and fresh <= generated:
        reason_codes = _append_unique(reason_codes, "jangar_verification_carry_stale")
        status = "stale"
    if not current_ticket:
        reason_codes = _append_unique(reason_codes, "jangar_foreclosure_ticket_missing")
    carry_id = "jangar-verification-carry:" + _stable_hash(
        "jangar-verification-carry",
        {
            "board_id": board_id,
            "status": status,
            "execution_trust": execution_trust,
            "source_truth": source_truth,
            "ticket": _text(current_ticket.get("ticket_id")),
        },
    )
    return {
        "schema_version": JANGAR_VERIFICATION_CARRY_SCHEMA_VERSION,
        "carry_id": carry_id,
        "generated_at": generated.isoformat(),
        "fresh_until": (fresh or fresh_until).isoformat(),
        "status": status,
        "jangar_execution_trust_status": execution_trust,
        "jangar_source_rollout_truth_state": source_truth,
        "jangar_foreclosure_board_ref": board_id or None,
        "held_action_classes": _string_list(payload.get("held_action_classes")),
        "blocked_action_classes": _string_list(payload.get("blocked_action_classes")),
        "required_jangar_receipt": _text(
            current_ticket.get("required_output_receipt"),
            "jangar.verify-trust-foreclosure-ticket.v1",
        ),
        "current_foreclosure_ticket_id": current_ticket.get("ticket_id"),
        "reason_codes": reason_codes,
    }


def _condition_state(
    *,
    code: str,
    changed_conditions: set[str],
    preserved_reasons: set[str],
    jangar_carry: Mapping[str, Any],
    jangar_controller_ingestion_carry: Mapping[str, Any],
) -> tuple[str, list[str]]:
    if code in changed_conditions:
        return "changed", ["release_condition_changed"]
    if code == "jangar_controller_ingestion_current":
        carry_state = _text(jangar_controller_ingestion_carry.get("carry_state"))
        if carry_state == "current":
            return "current", ["jangar_controller_ingestion_carry_current"]
        if carry_state == "repairable":
            return "repairable", ["jangar_controller_ingestion_carry_repairable"]
        if carry_state:
            return carry_state, _string_list(
                jangar_controller_ingestion_carry.get("reason_codes")
            )
        return "unavailable", ["jangar_controller_ingestion_carry_unavailable"]
    if code == "jangar_verify_foreclosure_ticket_current":
        if _text(jangar_carry.get("status")) == "current" and _text(
            jangar_carry.get("current_foreclosure_ticket_id")
        ):
            return "current", ["jangar_foreclosure_ticket_current"]
        return "unavailable", _string_list(jangar_carry.get("reason_codes"))
    blocker_sets = {
        "schema_lineage_receipt_current": _SCHEMA_LINEAGE_BLOCKERS,
        "empirical_receipt_current": _EMPIRICAL_BLOCKERS,
        "market_context_receipt_current": _MARKET_CONTEXT_BLOCKERS,
        "execution_tca_receipt_current": _TCA_BLOCKERS,
    }
    blockers = blocker_sets.get(code)
    if blockers is None:
        return "unchanged", ["release_condition_not_changed"]
    if preserved_reasons.intersection(blockers):
        return "missing", [
            f"{code.removesuffix('_current')}_missing",
            "release_condition_not_changed",
        ]
    return "not_required", ["prerequisite_not_required_for_selected_lane"]


def _build_release_conditions(
    *,
    changed_conditions: set[str],
    preserved_reason_codes: Sequence[str],
    jangar_carry: Mapping[str, Any],
    jangar_controller_ingestion_carry: Mapping[str, Any],
) -> list[dict[str, object]]:
    preserved = set(preserved_reason_codes)
    return [
        {
            "code": code,
            "state": state,
            "reason_codes": reason_codes,
        }
        for code in _RELEASE_CONDITION_CODES
        for state, reason_codes in [
            _condition_state(
                code=code,
                changed_conditions=changed_conditions,
                preserved_reasons=preserved,
                jangar_carry=jangar_carry,
                jangar_controller_ingestion_carry=jangar_controller_ingestion_carry,
            )
        ]
    ]


def _condition_unblocks(condition: Mapping[str, Any]) -> bool:
    state = _text(condition.get("state"))
    return state in {"changed", "current", "repairable"}


def _ticket_specs() -> list[dict[str, object]]:
    return [
        {
            "ticket_class": "alpha_evidence_window",
            "release_conditions": [
                "source_revenue_repair_ref_changed",
                "evidence_window_changed",
                "blocker_set_changed",
                "required_receipt_set_changed",
                "selected_hypothesis_changed",
            ],
            "required_output_receipt": "torghut.alpha-evidence-window-receipt.v1",
            "validation_commands": [
                "uv run --frozen pytest services/torghut/tests/test_alpha_evidence_foundry.py"
            ],
            "priority": 100,
        },
        {
            "ticket_class": "schema_lineage_receipt",
            "release_conditions": ["schema_lineage_receipt_current"],
            "required_output_receipt": "torghut.schema-lineage-receipt.v1",
            "validation_commands": [
                "uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py"
            ],
            "priority": 90,
        },
        {
            "ticket_class": "empirical_receipt",
            "release_conditions": ["empirical_receipt_current"],
            "required_output_receipt": "torghut.empirical-job-receipt.v1",
            "validation_commands": [
                "uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair"
            ],
            "priority": 80,
        },
        {
            "ticket_class": "market_context_receipt",
            "release_conditions": ["market_context_receipt_current"],
            "required_output_receipt": "torghut.market-context-receipt.v1",
            "validation_commands": [
                "uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py"
            ],
            "priority": 70,
        },
        {
            "ticket_class": "execution_tca_receipt",
            "release_conditions": ["execution_tca_receipt_current"],
            "required_output_receipt": "torghut.execution-tca-repair-receipt.v1",
            "validation_commands": [
                "uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair"
            ],
            "priority": 60,
        },
        {
            "ticket_class": "jangar_verify_carry",
            "release_conditions": [
                "jangar_controller_ingestion_current",
                "jangar_verify_foreclosure_ticket_current",
            ],
            "required_output_receipt": "jangar.verify-trust-foreclosure-ticket.v1",
            "validation_commands": [
                "bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-verify-trust-foreclosure.test.ts"
            ],
            "priority": 50,
        },
    ]


def _build_candidate_tickets(
    *,
    source_revenue_repair_ref: str,
    active_no_delta_release_key: str,
    selected_hypothesis_id: str,
    selected_value_gate: str,
    release_conditions: Sequence[Mapping[str, Any]],
    max_notional: str,
    top_item_is_alpha: bool,
    jangar_controller_ingestion_carry: Mapping[str, Any],
) -> list[dict[str, object]]:
    conditions_by_code = {
        _text(condition.get("code")): condition for condition in release_conditions
    }
    tickets: list[dict[str, object]] = []
    for spec in _ticket_specs():
        spec_conditions = _string_list(spec.get("release_conditions"))
        matched_condition: Mapping[str, Any] = {}
        for condition in spec_conditions:
            candidate_condition = conditions_by_code.get(condition)
            if candidate_condition and _condition_unblocks(candidate_condition):
                matched_condition = candidate_condition
                break
        release_condition = _text(
            matched_condition.get("code"),
            spec_conditions[0] if spec_conditions else "unknown",
        )
        hold_reason_codes: list[str] = []
        if not top_item_is_alpha:
            hold_reason_codes.append("top_repair_queue_item_not_alpha_readiness")
        if selected_value_gate != "routeable_candidate_count":
            hold_reason_codes.append(
                "selected_value_gate_not_routeable_candidate_count"
            )
        if not _zero_notional(max_notional):
            hold_reason_codes.append("capital_notional_nonzero")
        if not matched_condition:
            hold_reason_codes.append("release_condition_not_changed")
        if active_no_delta_release_key and not matched_condition:
            hold_reason_codes.append("active_no_delta_release_key_unchanged")
        if (
            _text(spec.get("ticket_class")) == "jangar_verify_carry"
            and _text(jangar_controller_ingestion_carry.get("carry_state"))
            != "repairable"
        ):
            hold_reason_codes.append("jangar_controller_ingestion_carry_not_repairable")

        state = "held"
        if hold_reason_codes and active_no_delta_release_key:
            state = "denied"
        elif hold_reason_codes:
            state = "held"
        else:
            state = "eligible"

        ticket_id = "no-delta-reentry-ticket:" + _stable_hash(
            "no-delta-reentry-ticket",
            {
                "source_revenue_repair_ref": source_revenue_repair_ref,
                "release_key": active_no_delta_release_key,
                "selected_hypothesis_id": selected_hypothesis_id,
                "ticket_class": _text(spec.get("ticket_class")),
                "release_condition": release_condition,
                "state": state,
            },
        )
        tickets.append(
            {
                "ticket_id": ticket_id,
                "ticket_class": spec.get("ticket_class"),
                "target_value_gate": selected_value_gate,
                "expected_gate_delta": "retire_hypothesis_not_promotion_eligible",
                "release_condition": release_condition,
                "required_output_receipt": spec.get("required_output_receipt"),
                "validation_commands": _string_list(spec.get("validation_commands")),
                "max_runtime_seconds": 20 * 60,
                "max_parallelism": 1,
                "max_notional": "0",
                "state": state,
                "hold_reason_codes": hold_reason_codes,
                "priority": spec.get("priority"),
            }
        )
    return tickets


def _select_ticket(tickets: Sequence[Mapping[str, Any]]) -> dict[str, object] | None:
    eligible = [
        ticket
        for ticket in tickets
        if _text(ticket.get("state")) == "eligible"
        and _zero_notional(ticket.get("max_notional"))
        and _text(ticket.get("required_output_receipt"))
        and _string_list(ticket.get("validation_commands"))
    ]
    if not eligible:
        return None
    selected = sorted(
        eligible,
        key=lambda ticket: (
            -_int(ticket.get("priority")),
            _text(ticket.get("ticket_id")),
        ),
    )[0]
    result = dict(selected)
    result["state"] = "selected"
    return result


def build_no_delta_repair_reentry_auction(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    capital: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
    alpha_repair_dividend_ledger: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    jangar_verification_carry: Mapping[str, Any] | None = None,
    jangar_controller_ingestion_carry: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Build the observe-mode no-delta reentry auction for alpha repair."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    top_item = _top_queue_item(repair_queue)
    selected_value_gate = _selected_value_gate(
        top_item,
        alpha_repair_dividend_ledger,
        alpha_readiness_settlement_conveyor,
    )
    selected_hypothesis_id = _selected_hypothesis_id(
        alpha_repair_dividend_ledger,
        alpha_readiness_settlement_conveyor,
    )
    source_revenue_repair_ref = _source_revenue_repair_ref(
        alpha_repair_dividend_ledger,
        alpha_readiness_settlement_conveyor,
    )
    active_release_key = _active_no_delta_release_key(
        alpha_repair_dividend_ledger,
        alpha_readiness_settlement_conveyor,
    )
    max_notional = (
        _text(capital.get("max_notional"))
        or _text(alpha_repair_dividend_ledger.get("max_notional"))
        or _text(top_item.get("max_notional"))
        or "0"
    )
    routeable_before = _int(
        alpha_repair_dividend_ledger.get("routeable_candidate_count_before"),
        _int(
            alpha_readiness_settlement_conveyor.get("routeable_candidate_count_before")
        ),
    )
    routeable_after = _int(
        alpha_repair_dividend_ledger.get("routeable_candidate_count_after"),
        _int(
            alpha_readiness_settlement_conveyor.get("routeable_candidate_count_after"),
            routeable_before,
        ),
    )
    changed_conditions = _release_condition_changes(
        alpha_repair_dividend_ledger,
        alpha_readiness_settlement_conveyor,
    )
    jangar_carry = _build_jangar_verification_carry(
        generated=generated,
        jangar_verification_carry=jangar_verification_carry,
    )
    controller_carry = _mapping(jangar_controller_ingestion_carry)
    preserved_codes = _preserved_reason_codes(
        alpha_repair_dividend_ledger,
        alpha_readiness_settlement_conveyor,
    )
    release_conditions = _build_release_conditions(
        changed_conditions=changed_conditions,
        preserved_reason_codes=preserved_codes,
        jangar_carry=jangar_carry,
        jangar_controller_ingestion_carry=controller_carry,
    )
    top_item_is_alpha = _is_alpha_repair(top_item)
    candidate_tickets = _build_candidate_tickets(
        source_revenue_repair_ref=source_revenue_repair_ref,
        active_no_delta_release_key=active_release_key,
        selected_hypothesis_id=selected_hypothesis_id,
        selected_value_gate=selected_value_gate,
        release_conditions=release_conditions,
        max_notional=max_notional,
        top_item_is_alpha=top_item_is_alpha,
        jangar_controller_ingestion_carry=controller_carry,
    )
    selected_ticket = _select_ticket(candidate_tickets)

    reason_codes: list[str] = []
    if revenue_ready:
        reason_codes.append("revenue_already_ready")
    if business_state != "repair_only":
        reason_codes.append(f"business_state_{business_state or 'unknown'}")
    if not top_item_is_alpha:
        reason_codes.append("top_repair_queue_item_not_alpha_readiness")
    if selected_value_gate != "routeable_candidate_count":
        reason_codes.append("selected_value_gate_not_routeable_candidate_count")
    if not _zero_notional(max_notional):
        reason_codes.append("capital_notional_nonzero")
    if active_release_key:
        reason_codes.append("active_no_delta_release_key")
    if not any(_condition_unblocks(condition) for condition in release_conditions):
        reason_codes.append("no_release_condition_changed")
    if not selected_ticket:
        reason_codes.append("zero_notional_reentry_ticket_not_selected")
    else:
        reason_codes.append("zero_notional_reentry_ticket_selected")
    reason_codes = _append_unique(
        reason_codes,
        jangar_carry.get("reason_codes"),
        controller_carry.get("reason_codes"),
    )

    if not _zero_notional(max_notional):
        reentry_decision = "deny"
    elif selected_ticket:
        reentry_decision = "allow"
    elif active_release_key:
        reentry_decision = "deny"
        reason_codes = _append_unique(reason_codes, "duplicate_no_delta_reentry_denied")
    else:
        reentry_decision = "hold"

    auction_id = "no-delta-repair-reentry-auction:" + _stable_hash(
        "no-delta-repair-reentry-auction",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "alpha_conveyor_ref": alpha_readiness_settlement_conveyor.get(
                "conveyor_id"
            ),
            "alpha_dividend_ref": alpha_repair_dividend_ledger.get("ledger_id"),
            "active_no_delta_release_key": active_release_key,
            "selected_ticket_id": selected_ticket.get("ticket_id")
            if selected_ticket
            else None,
            "decision": reentry_decision,
        },
    )

    return {
        "schema_version": NO_DELTA_REPAIR_REENTRY_AUCTION_SCHEMA_VERSION,
        "auction_id": auction_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _DESIGN_REF,
        "companion_jangar_design_ref": _COMPANION_JANGAR_DESIGN_REF,
        "enforcement_mode": "observe",
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "active_alpha_conveyor_ref": alpha_readiness_settlement_conveyor.get(
            "conveyor_id"
        ),
        "active_alpha_dividend_ref": alpha_repair_dividend_ledger.get("ledger_id"),
        "active_no_delta_release_key": active_release_key or None,
        "selected_queue_code": _text(top_item.get("code")),
        "selected_value_gate": selected_value_gate,
        "selected_hypothesis_id": selected_hypothesis_id,
        "account_id": alpha_repair_dividend_ledger.get("account_id")
        or alpha_readiness_settlement_conveyor.get("account_id")
        or repair_bid_settlement_ledger.get("account_id"),
        "window": alpha_repair_dividend_ledger.get("window")
        or alpha_readiness_settlement_conveyor.get("window")
        or repair_bid_settlement_ledger.get("session_id"),
        "trading_mode": alpha_repair_dividend_ledger.get("trading_mode")
        or alpha_readiness_settlement_conveyor.get("trading_mode")
        or repair_bid_settlement_ledger.get("trading_mode"),
        "business_state": business_state,
        "revenue_ready": revenue_ready,
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "measured_delta": routeable_after - routeable_before,
        "release_conditions": release_conditions,
        "candidate_tickets": candidate_tickets,
        "selected_ticket": selected_ticket,
        "reentry_decision": reentry_decision,
        "reason_codes": reason_codes,
        "jangar_verification_carry": jangar_carry,
        "jangar_controller_ingestion_carry": controller_carry or None,
        "max_notional": max_notional,
        "capital_rule": _text(
            top_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "rollback_target": _ROLLBACK_TARGET,
    }


def compact_no_delta_repair_reentry_auction(
    auction: Mapping[str, Any] | None,
) -> dict[str, object]:
    """Return the compact Jangar-facing no-delta reentry auction ref."""

    payload = _mapping(auction)
    if not payload:
        return {
            "schema_version": NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION,
            "status": "missing",
            "reason_codes": ["no_delta_repair_reentry_auction_missing"],
        }
    selected_ticket = _mapping(payload.get("selected_ticket"))
    validation_commands = _string_list(selected_ticket.get("validation_commands"))
    return {
        "schema_version": NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION,
        "auction_schema_version": payload.get("schema_version"),
        "auction_id": payload.get("auction_id"),
        "generated_at": payload.get("generated_at"),
        "fresh_until": payload.get("fresh_until"),
        "reentry_decision": payload.get("reentry_decision"),
        "reason_codes": _string_list(payload.get("reason_codes")),
        "active_no_delta_release_key": payload.get("active_no_delta_release_key"),
        "selected_hypothesis_id": payload.get("selected_hypothesis_id"),
        "selected_value_gate": payload.get("selected_value_gate"),
        "routeable_candidate_count_before": payload.get(
            "routeable_candidate_count_before"
        ),
        "routeable_candidate_count_after": payload.get(
            "routeable_candidate_count_after"
        ),
        "selected_ticket_id": selected_ticket.get("ticket_id"),
        "selected_ticket_class": selected_ticket.get("ticket_class"),
        "selected_release_condition": selected_ticket.get("release_condition"),
        "required_output_receipt": selected_ticket.get("required_output_receipt"),
        "validation_command": validation_commands[0] if validation_commands else None,
        "jangar_controller_ingestion_carry_state": _mapping(
            payload.get("jangar_controller_ingestion_carry")
        ).get("carry_state"),
        "enforcement_mode": payload.get("enforcement_mode"),
        "max_notional": payload.get("max_notional"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


__all__ = [
    "JANGAR_VERIFICATION_CARRY_SCHEMA_VERSION",
    "NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION",
    "NO_DELTA_REPAIR_REENTRY_AUCTION_SCHEMA_VERSION",
    "build_no_delta_repair_reentry_auction",
    "compact_no_delta_repair_reentry_auction",
]
