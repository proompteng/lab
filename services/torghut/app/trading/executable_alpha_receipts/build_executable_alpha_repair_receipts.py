"""Executable alpha receipt projection for zero-notional repair planning."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from ..market_context import market_context_status_enforced


from .shared_context import (
    EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION,
    DEFAULT_FRESHNESS_SECONDS as _DEFAULT_FRESHNESS_SECONDS,
    EXECUTABLE_ALPHA_REPAIR_DESIGN_REF as _EXECUTABLE_ALPHA_REPAIR_DESIGN_REF,
    EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET as _EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET,
    EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF as _EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF,
    EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET as _EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET,
    NO_DELTA_RELEASE_CONDITIONS as _NO_DELTA_RELEASE_CONDITIONS,
    executable_alpha_repair_receipt as _executable_alpha_repair_receipt,
    float_value as _float,
    int_value as _int,
    mapping as _mapping,
    reason_list_from_target as _reason_list_from_target,
    receipt_by_hypothesis as _receipt_by_hypothesis,
    receipt_target_key as _receipt_target_key,
    sequence as _sequence,
    stable_hash as _stable_hash,
    string_list as _string_list,
    targets_from_alpha_readiness as _targets_from_alpha_readiness,
    text as _text,
    top_alpha_repair as _top_alpha_repair,
)


def build_executable_alpha_repair_receipts(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    alpha_readiness: Mapping[str, Any],
    capital: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
) -> dict[str, object]:
    """Build compact zero-notional receipts for the active alpha-readiness repair."""

    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    top_blocker: Mapping[str, Any] = repair_queue[0] if repair_queue else {}
    source_revenue_repair_ref = "torghut-revenue-repair-digest:" + _stable_hash(
        "torghut-revenue-repair-digest",
        {
            "business_state": business_state,
            "top_blocker": dict(top_blocker),
            "repair_bid_settlement_ledger_id": repair_bid_settlement_ledger.get(
                "ledger_id"
            ),
            "selected_lot_ids": _string_list(
                repair_bid_settlement_ledger.get("selected_lot_ids")
            ),
            "dispatchable_lot_ids": _string_list(
                repair_bid_settlement_ledger.get("dispatchable_lot_ids")
            ),
            "held_lot_ids": _string_list(
                repair_bid_settlement_ledger.get("held_lot_ids")
            ),
            "routeable_candidate_count": _int(
                repair_bid_settlement_ledger.get("routeable_candidate_count")
            ),
        },
    )

    reason_codes: list[str] = []
    if revenue_ready:
        reason_codes.append("revenue_already_ready")
    if business_state != "repair_only":
        reason_codes.append(f"business_state_{business_state or 'unknown'}")
    if not _top_alpha_repair(top_blocker):
        reason_codes.append("revenue_repair_top_item_not_alpha_readiness")
    if _text(capital.get("max_notional"), "0") not in {"0", "0.0", "0.00"}:
        reason_codes.append("capital_notional_nonzero")
    if _text(repair_bid_settlement_ledger.get("max_notional"), "0") not in {
        "0",
        "0.0",
        "0.00",
    }:
        reason_codes.append("repair_bid_settlement_notional_nonzero")

    capital_replay_board = _mapping(alpha_readiness.get("capital_replay_board"))
    executable_alpha_receipts = _mapping(
        alpha_readiness.get("executable_alpha_receipts")
    )
    receipts_by_hypothesis = _receipt_by_hypothesis(executable_alpha_receipts)
    routeable_candidate_count_before = _int(
        repair_bid_settlement_ledger.get("routeable_candidate_count")
    )

    receipts: list[dict[str, object]] = []
    if not reason_codes:
        for target in _targets_from_alpha_readiness(alpha_readiness)[:5]:
            hypothesis_id = _text(target.get("hypothesis_id"))
            receipts.append(
                _executable_alpha_repair_receipt(
                    generated_at=generated,
                    fresh_until=fresh_until,
                    source_revenue_repair_ref=source_revenue_repair_ref,
                    top_blocker=top_blocker,
                    target=target,
                    repair_bid_settlement_ledger=repair_bid_settlement_ledger,
                    capital_replay_board=capital_replay_board,
                    executable_alpha_receipt=receipts_by_hypothesis.get(
                        hypothesis_id, {}
                    ),
                    routeable_candidate_count_before=routeable_candidate_count_before,
                )
            )
        receipts.sort(key=_receipt_target_key)
        if not receipts:
            reason_codes.append("alpha_readiness_repair_targets_missing")

    selected_receipt = receipts[0] if receipts and not reason_codes else None
    if any(reason.endswith("_nonzero") for reason in reason_codes):
        status = "blocked"
    elif selected_receipt:
        status = "selected"
    elif _top_alpha_repair(top_blocker):
        status = "held"
    else:
        status = "inactive"

    return {
        "schema_version": EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "status": status,
        "governing_design_ref": _EXECUTABLE_ALPHA_REPAIR_DESIGN_REF,
        "selected_receipt_id": selected_receipt.get("receipt_id")
        if selected_receipt
        else None,
        "selected_receipt": selected_receipt,
        "receipt_count": len(receipts),
        "receipts": receipts,
        "target_value_gate": _text(top_blocker.get("value_gate")),
        "routeable_candidate_count_before": routeable_candidate_count_before,
        "max_notional": "0",
        "capital_rule": "zero_notional_repair_only",
        "reason_codes": reason_codes,
        "rollback_target": _EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET,
    }


def zero_notional(value: object) -> bool:
    return _text(value, "0") in {"0", "0.0", "0.00", "0.0000"}


def top_queue_item(repair_queue: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    for item in repair_queue:
        payload = _mapping(item)
        if payload:
            return payload
    return {}


def repair_receipt_reason_codes(receipt: Mapping[str, Any]) -> list[str]:
    reason_codes = _string_list(receipt.get("reason_codes"))
    settlement = _mapping(receipt.get("settlement"))
    if not reason_codes:
        reason_codes = _string_list(settlement.get("before_reason_codes"))
    return reason_codes


def selected_repair_receipt(
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> Mapping[str, Any]:
    selected = _mapping(executable_alpha_repair_receipts.get("selected_receipt"))
    if selected:
        return selected
    selected_receipt_id = _text(
        executable_alpha_repair_receipts.get("selected_receipt_id")
    )
    receipts = [
        _mapping(item)
        for item in _sequence(executable_alpha_repair_receipts.get("receipts"))
    ]
    for receipt in receipts:
        if (
            selected_receipt_id
            and _text(receipt.get("receipt_id")) == selected_receipt_id
        ):
            return receipt
    return receipts[0] if receipts else {}


def parse_datetime(value: object) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def routeable_candidate_count_from_evidence(evidence: Mapping[str, Any]) -> int:
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    routeability_acceptance = _mapping(evidence.get("routeability_acceptance"))
    route_clearinghouse = _mapping(evidence.get("route_evidence_clearinghouse"))
    return max(
        _int(repair_bid_settlement.get("routeable_candidate_count")),
        _int(routeability_acceptance.get("accepted_routeable_candidate_count")),
        _int(route_clearinghouse.get("accepted_routeable_candidate_count")),
    )


def alpha_target_reason_codes(
    evidence: Mapping[str, Any], hypothesis_id: str
) -> list[str]:
    alpha_readiness = _mapping(evidence.get("alpha_readiness"))
    for raw_target in _sequence(alpha_readiness.get("repair_targets")):
        target = _mapping(raw_target)
        if _text(target.get("hypothesis_id")) != hypothesis_id:
            continue
        return _reason_list_from_target(target)
    return []


def required_after_receipts(
    top_queue_item: Mapping[str, Any], selected_receipt: Mapping[str, Any]
) -> list[str]:
    receipts = _string_list(selected_receipt.get("required_output_receipts"))
    for receipt in [
        *_string_list(top_queue_item.get("required_receipts")),
        _text(top_queue_item.get("required_output_receipt")),
    ]:
        if receipt and receipt not in receipts:
            receipts.append(receipt)
    return receipts


def before_routeable_candidate_count(selected_receipt: Mapping[str, Any]) -> int:
    settlement = _mapping(selected_receipt.get("settlement"))
    before_value_gate = _mapping(settlement.get("before_value_gate"))
    return _int(before_value_gate.get("routeable_candidate_count"))


def settlement_state(
    *,
    before_reason_codes: Sequence[str],
    after_reason_codes: Sequence[str],
    routeable_before: int,
    routeable_after: int,
) -> str:
    before_set = set(before_reason_codes)
    after_set = set(after_reason_codes)
    if routeable_after > routeable_before:
        return "improved"
    if before_set and not before_set.intersection(after_set):
        return "retired"
    if len(after_set) < len(before_set):
        return "improved"
    return "no_delta"


def build_executable_alpha_settlement_slot(
    *,
    generated: datetime,
    fresh_until: datetime,
    top_queue_item: Mapping[str, Any],
    selected_receipt: Mapping[str, Any],
    evidence: Mapping[str, Any],
    capital: Mapping[str, Any],
) -> dict[str, object]:
    selected_receipt_id = _text(selected_receipt.get("receipt_id"))
    hypothesis_id = _text(selected_receipt.get("hypothesis_id"), "unknown")
    before_reason_codes = repair_receipt_reason_codes(selected_receipt)
    after_reason_codes = alpha_target_reason_codes(evidence, hypothesis_id)
    if not after_reason_codes:
        after_reason_codes = before_reason_codes
    routeable_before = before_routeable_candidate_count(selected_receipt)
    routeable_after = routeable_candidate_count_from_evidence(evidence)
    measured_delta = routeable_after - routeable_before
    state = settlement_state(
        before_reason_codes=before_reason_codes,
        after_reason_codes=after_reason_codes,
        routeable_before=routeable_before,
        routeable_after=routeable_after,
    )
    before_set = set(before_reason_codes)
    after_set = set(after_reason_codes)
    retired_reason_codes = sorted(before_set - after_set)
    preserved_reason_codes = [
        reason for reason in before_reason_codes if reason in after_set
    ]
    introduced_reason_codes = sorted(after_set - before_set)
    no_delta_reason = (
        "routeable_candidate_count_unchanged" if state == "no_delta" else ""
    )
    source_revenue_repair_ref = _text(
        selected_receipt.get("source_revenue_repair_ref"),
        "torghut-revenue-repair-digest:unknown",
    )
    dedupe_key = _stable_hash(
        "executable-alpha-settlement-slot-dedupe",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "selected_receipt_id": selected_receipt_id,
            "hypothesis_id": hypothesis_id,
            "before_reason_codes": before_reason_codes,
            "required_after_receipts": required_after_receipts(
                top_queue_item, selected_receipt
            ),
        },
    )
    slot_id = "executable-alpha-settlement-slot:" + _stable_hash(
        "executable-alpha-settlement-slot",
        {
            "dedupe_key": dedupe_key,
            "selected_receipt_id": selected_receipt_id,
        },
    )
    material_reentry_receipt_id = "material-reentry-receipt:" + _stable_hash(
        "material-reentry-receipt",
        {
            "slot_id": slot_id,
            "dedupe_key": dedupe_key,
            "selected_receipt_id": selected_receipt_id,
        },
    )
    return {
        "schema_version": EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION,
        "slot_id": slot_id,
        "selected_receipt_id": selected_receipt_id,
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "hypothesis_id": hypothesis_id,
        "candidate_id": selected_receipt.get("candidate_id"),
        "strategy_id": selected_receipt.get("strategy_id"),
        "repair_class": _text(selected_receipt.get("repair_class")),
        "target_value_gate": _text(
            selected_receipt.get("target_value_gate"),
            _text(top_queue_item.get("value_gate"), "routeable_candidate_count"),
        ),
        "expected_gate_delta": _text(selected_receipt.get("expected_gate_delta")),
        "before_reason_codes": before_reason_codes,
        "after_reason_codes": after_reason_codes,
        "retired_reason_codes": retired_reason_codes,
        "preserved_reason_codes": preserved_reason_codes,
        "introduced_reason_codes": introduced_reason_codes,
        "before_refs": _string_list(selected_receipt.get("required_input_refs")),
        "after_refs": [],
        "required_after_receipts": required_after_receipts(
            top_queue_item, selected_receipt
        ),
        "validation_commands": _string_list(
            selected_receipt.get("validation_commands")
        ),
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "measured_delta": measured_delta,
        "settlement_state": state,
        "no_delta_reason": no_delta_reason,
        "dedupe_key": dedupe_key,
        "material_reentry_receipt_id": material_reentry_receipt_id,
        "required_material_reentry_receipt": "jangar.material-reentry-receipt.v1",
        "next_allowed_attempt_after": fresh_until.isoformat()
        if no_delta_reason
        else None,
        "max_notional": _text(
            selected_receipt.get("max_notional"),
            _text(capital.get("max_notional"), "0"),
        ),
        "capital_rule": _text(
            selected_receipt.get("capital_rule"), "zero_notional_repair_only"
        ),
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "rollback_target": _EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET,
    }


def no_delta_debt_from_settlement_slot(
    slot: Mapping[str, Any],
) -> dict[str, object] | None:
    if _text(slot.get("settlement_state")) != "no_delta":
        return None
    preserved_reason_codes = _string_list(slot.get("preserved_reason_codes"))
    return {
        "debt_id": "executable-alpha-no-delta:"
        + _stable_hash(
            "executable-alpha-no-delta",
            {
                "slot_id": _text(slot.get("slot_id")),
                "dedupe_key": _text(slot.get("dedupe_key")),
                "selected_receipt_id": _text(slot.get("selected_receipt_id")),
            },
        ),
        "slot_id": slot.get("slot_id"),
        "selected_receipt_id": slot.get("selected_receipt_id"),
        "material_reentry_receipt_id": slot.get("material_reentry_receipt_id"),
        "dedupe_key": slot.get("dedupe_key"),
        "hypothesis_id": slot.get("hypothesis_id"),
        "value_gate": slot.get("target_value_gate"),
        "preserved_reason_codes": preserved_reason_codes,
        "routeable_candidate_count_before": slot.get(
            "routeable_candidate_count_before"
        ),
        "routeable_candidate_count_after": slot.get("routeable_candidate_count_after"),
        "measured_delta": slot.get("measured_delta"),
        "no_delta_reason": slot.get("no_delta_reason"),
        "remaining_blocker": primary_remaining_blocker(preserved_reason_codes),
        "release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
    }


def primary_remaining_blocker(reason_codes: Sequence[str]) -> str:
    for reason in reason_codes:
        if not reason.startswith("closed_session_"):
            return reason
    return reason_codes[0] if reason_codes else "unknown"


def build_executable_alpha_settlement_slots(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    capital: Mapping[str, Any],
    evidence: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> dict[str, object]:
    """Build no-delta settlement custody for the selected executable-alpha receipt."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    top_item = top_queue_item(repair_queue)
    selected_receipt = selected_repair_receipt(executable_alpha_repair_receipts)
    max_notional = _text(capital.get("max_notional"), "0")

    reason_codes: list[str] = []
    if revenue_ready:
        reason_codes.append("revenue_already_ready")
    if business_state != "repair_only":
        reason_codes.append(f"business_state_{business_state or 'unknown'}")
    top_alpha_repair = _top_alpha_repair(top_item)
    if not top_alpha_repair:
        reason_codes.append("revenue_repair_top_item_not_alpha_readiness")
    if top_alpha_repair and not selected_receipt:
        reason_codes.append("selected_executable_alpha_repair_receipt_missing")
    if not zero_notional(max_notional):
        reason_codes.append("capital_notional_nonzero")
    if bool(capital.get("live_submission_allowed")):
        reason_codes.append("live_submission_enabled")
    if selected_receipt and not zero_notional(selected_receipt.get("max_notional")):
        reason_codes.append("selected_receipt_notional_nonzero")

    selected_fresh_until = parse_datetime(selected_receipt.get("fresh_until"))
    if (
        selected_receipt
        and selected_fresh_until is not None
        and selected_fresh_until < generated
    ):
        reason_codes.append("selected_executable_alpha_repair_receipt_stale")

    slots: list[dict[str, object]] = []
    if not reason_codes:
        slots.append(
            build_executable_alpha_settlement_slot(
                generated=generated,
                fresh_until=fresh_until,
                top_queue_item=top_item,
                selected_receipt=selected_receipt,
                evidence=evidence,
                capital=capital,
            )
        )

    selected_slot = slots[0] if slots else None
    no_delta_debt = [
        debt
        for slot in slots
        if (debt := no_delta_debt_from_settlement_slot(slot)) is not None
    ]

    if any(
        reason
        in {
            "capital_notional_nonzero",
            "live_submission_enabled",
            "selected_receipt_notional_nonzero",
            "selected_executable_alpha_repair_receipt_stale",
        }
        for reason in reason_codes
    ):
        status = "blocked"
    elif "revenue_repair_top_item_not_alpha_readiness" in reason_codes:
        status = "inactive"
    elif selected_slot and _text(selected_slot.get("settlement_state")) in {
        "retired",
        "improved",
        "no_delta",
        "invalidated",
        "failed",
        "superseded",
    }:
        status = "settled"
    elif selected_slot:
        status = "selected"
    else:
        status = "held"

    return {
        "schema_version": EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF,
        "source_revenue_repair_ref": executable_alpha_repair_receipts.get(
            "source_revenue_repair_ref"
        ),
        "selected_receipt_id": selected_receipt.get("receipt_id")
        if selected_receipt
        else None,
        "selected_slot_id": selected_slot.get("slot_id") if selected_slot else None,
        "status": status,
        "reason_codes": reason_codes,
        "slots": slots,
        "selected_slot": selected_slot,
        "no_delta_debt": no_delta_debt,
        "max_notional": max_notional,
        "capital_rule": _text(
            top_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "rollback_target": _EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET,
    }


def compact_executable_alpha_settlement_slots(
    settlement_slots: Mapping[str, Any] | None,
) -> dict[str, object]:
    """Return the Jangar-facing compact settlement slot reference."""

    payload = _mapping(settlement_slots)
    if not payload:
        return {
            "schema_version": EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION,
            "status": "missing",
            "reason_codes": ["executable_alpha_settlement_slots_missing"],
        }
    selected_slot = _mapping(payload.get("selected_slot"))
    no_delta_debt = _sequence(payload.get("no_delta_debt"))
    preserved_reason_codes = _string_list(selected_slot.get("preserved_reason_codes"))
    return {
        "schema_version": EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION,
        "slots_schema_version": payload.get("schema_version"),
        "generated_at": payload.get("generated_at"),
        "fresh_until": payload.get("fresh_until"),
        "status": payload.get("status"),
        "reason_codes": _string_list(payload.get("reason_codes")),
        "selected_receipt_id": payload.get("selected_receipt_id"),
        "selected_slot_id": payload.get("selected_slot_id"),
        "selected_hypothesis_id": selected_slot.get("hypothesis_id"),
        "settlement_state": selected_slot.get("settlement_state"),
        "target_value_gate": selected_slot.get("target_value_gate"),
        "active_dedupe_key": selected_slot.get("dedupe_key"),
        "material_reentry_receipt_id": selected_slot.get("material_reentry_receipt_id"),
        "no_delta_debt_count": len(no_delta_debt),
        "remaining_blocker": primary_remaining_blocker(preserved_reason_codes)
        if preserved_reason_codes
        else None,
        "max_notional": payload.get("max_notional"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


def graduation_state(
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> tuple[str, list[str]]:
    state = _text(jangar_contract_graduation_ref.get("state"))
    decision = _text(jangar_contract_graduation_ref.get("decision")).lower()
    if state == "current" or decision == "allow":
        return "current", []
    reasons = _string_list(jangar_contract_graduation_ref.get("reasons"))
    return state or "missing", reasons or ["jangar_contract_graduation_missing"]


def market_context_blockers(market_context_status: Mapping[str, Any]) -> list[str]:
    if not market_context_status:
        return ["market_context_missing"]
    if not market_context_status_enforced(market_context_status):
        return []
    state = _text(
        market_context_status.get("overallState")
        or market_context_status.get("overall_state")
        or market_context_status.get("state")
        or market_context_status.get("status")
    ).lower()
    if bool(market_context_status.get("alert_active")):
        return [
            _text(
                market_context_status.get("alert_reason"),
                "market_context_alert_active",
            )
        ]
    if state in {"ok", "healthy", "fresh", "pass", "current", "not_required"}:
        return []
    if state:
        return [f"market_context_{state}"]
    return ["market_context_state_unknown"]


def quant_blockers(quant_evidence: Mapping[str, Any]) -> list[str]:
    blockers = _string_list(quant_evidence.get("blocking_reasons"))
    blockers.extend(_string_list(quant_evidence.get("informational_reasons")))
    latest_count = _int(quant_evidence.get("latest_metrics_count"), default=-1)
    if latest_count == 0:
        blockers.append("quant_latest_metrics_empty")
    stage_count = _int(quant_evidence.get("stage_count"), default=-1)
    if stage_count == 0:
        blockers.append("quant_pipeline_stages_missing")
    status = _text(quant_evidence.get("status")).lower()
    if status in {"degraded", "unknown", "error"}:
        blockers.append(f"quant_health_{status}")
    return sorted(set(blockers))


def empirical_blockers(empirical_jobs_status: Mapping[str, Any]) -> list[str]:
    if bool(empirical_jobs_status.get("ready")):
        return []
    status = _text(empirical_jobs_status.get("status"), "unknown")
    reasons = _string_list(empirical_jobs_status.get("reasons"))
    return sorted(set(reasons or [f"empirical_jobs_{status}"]))


def tca_guardrail_blockers(route_record: Mapping[str, Any]) -> list[str]:
    observed = _float(route_record.get("avg_abs_slippage_bps"))
    guardrail = _float(route_record.get("slippage_guardrail_bps"))
    if observed is not None and guardrail is not None and observed > guardrail:
        return ["execution_tca_above_guardrail"]
    if _int(route_record.get("unsettled_execution_count")) > 0:
        return ["execution_tca_unsettled_executions"]
    if _text(route_record.get("state")) == "missing":
        return ["execution_tca_symbol_missing"]
    return []


def capital_blockers(
    *,
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    route_record: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> list[str]:
    blockers = set(_string_list(proof_floor_receipt.get("blocking_reasons")))
    blockers.update(_string_list(live_submission_gate.get("blocked_reasons")))
    blockers.update(empirical_blockers(empirical_jobs_status))
    blockers.update(quant_blockers(quant_evidence))
    blockers.update(market_context_blockers(market_context_status))
    blockers.update(tca_guardrail_blockers(route_record))
    graduation_verdict, graduation_reasons = graduation_state(
        jangar_contract_graduation_ref
    )
    if graduation_verdict != "current":
        blockers.update(graduation_reasons)
    return sorted(blocker for blocker in blockers if blocker)


def before_refs(
    *,
    replay_class: str,
    route_row: Mapping[str, Any],
    route_record: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> dict[str, object]:
    return {
        "route_reacquisition": {
            "proof_packet_id": route_row.get("proof_packet_id"),
            "symbol": route_row.get("symbol") or route_record.get("symbol"),
            "state": route_row.get("state") or route_record.get("state"),
            "reason": route_row.get("current_blocker") or route_record.get("reason"),
            "avg_abs_slippage_bps": route_record.get("avg_abs_slippage_bps"),
            "slippage_guardrail_bps": route_record.get("slippage_guardrail_bps"),
            "last_computed_at": route_record.get("last_computed_at"),
        },
        "proof_floor": {
            "schema_version": proof_floor_receipt.get("schema_version"),
            "generated_at": proof_floor_receipt.get("generated_at"),
            "route_state": proof_floor_receipt.get("route_state"),
            "capital_state": proof_floor_receipt.get("capital_state"),
            "blocking_reasons": _string_list(
                proof_floor_receipt.get("blocking_reasons")
            ),
        },
        "empirical_jobs": {
            "ready": bool(empirical_jobs_status.get("ready")),
            "status": empirical_jobs_status.get("status"),
            "authority": empirical_jobs_status.get("authority"),
            "dataset_snapshot_refs": _string_list(
                empirical_jobs_status.get("dataset_snapshot_refs")
            ),
        },
        "quant_evidence": {
            "status": quant_evidence.get("status"),
            "source_url": quant_evidence.get("source_url"),
            "latest_metrics_count": quant_evidence.get("latest_metrics_count"),
            "latest_metrics_updated_at": quant_evidence.get(
                "latest_metrics_updated_at"
            ),
            "stage_count": quant_evidence.get("stage_count"),
        },
        "market_context": {
            "status": market_context_status.get("status"),
            "state": market_context_status.get("state")
            or market_context_status.get("overallState")
            or market_context_status.get("overall_state"),
            "alert_active": bool(market_context_status.get("alert_active")),
            "alert_reason": market_context_status.get("alert_reason"),
            "last_reason": market_context_status.get("last_reason"),
        },
        "jangar_contract_graduation": dict(jangar_contract_graduation_ref),
        "replay_class": replay_class,
    }


__all__ = (
    "build_executable_alpha_repair_receipts",
    "build_executable_alpha_settlement_slots",
    "compact_executable_alpha_settlement_slots",
)
