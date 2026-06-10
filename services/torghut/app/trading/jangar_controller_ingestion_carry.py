"""Internal controller-ingestion carry import for Torghut no-delta repair."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, cast

INTERNAL_CONTROLLER_INGESTION_CARRY_SCHEMA_VERSION = (
    "torghut.internal-controller-ingestion-carry.v1"
)
INTERNAL_CONTROLLER_INGESTION_CARRY_REF_SCHEMA_VERSION = (
    "torghut.internal-controller-ingestion-carry-ref.v1"
)

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md"
)
_COMPANION_JANGAR_DESIGN_REF = (
    "docs/agents/designs/"
    "205-internal-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md"
)
_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_ROLLBACK_TARGET = (
    "stop emitting controller_ingestion_carry, keep the existing "
    "no-delta auction and alpha-readiness conveyor behavior, and keep "
    "Torghut max_notional=0"
)
_VALIDATION_COMMANDS = [
    "uv run --frozen pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py",
    "uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair",
]


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _string_list(value: object) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in _sequence(value):
        normalized = _text(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _append_unique(items: list[str], *values: object) -> list[str]:
    seen = set(items)
    for value in values:
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            candidates = _string_list(cast(Sequence[object], value))
        else:
            candidates = [_text(value)]
        for candidate in candidates:
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            items.append(candidate)
    return items


def _stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _parse_datetime(value: object) -> datetime | None:
    raw = _text(value)
    if not raw:
        return None
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _first_text(*values: object) -> str:
    for value in values:
        normalized = _text(value)
        if normalized:
            return normalized
    return ""


def _bool_or_none(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "current", "ok", "allow"}:
            return True
        if normalized in {"false", "0", "no", "n", "stale", "missing", "unknown"}:
            return False
    return None


def _normalize_decision(value: object) -> str:
    raw = _text(value, "unknown").lower()
    if raw in {"allow", "allowed", "current", "ok", "pass", "ready"}:
        return "allow"
    if raw in {"repair_only", "repair", "repairable"}:
        return "repair_only"
    if raw in {"hold", "held", "delay", "delayed"}:
        return "hold"
    if raw in {"block", "blocked", "deny", "denied", "fail"}:
        return "block"
    return "unknown"


def _extract_dependency_payload(
    dependency_quorum: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    payload = _mapping(dependency_quorum)
    nested = _mapping(payload.get("dependency_quorum"))
    if nested:
        return nested
    return payload


def _extract_controller_settlement(
    *,
    dependency_payload: Mapping[str, Any],
    controller_ingestion_settlement: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    return (
        _mapping(controller_ingestion_settlement)
        or _mapping(dependency_payload.get("controller_ingestion_settlement"))
        or _mapping(dependency_payload.get("controllerIngestionSettlement"))
    )


def _extract_foreclosure_board(
    *,
    dependency_payload: Mapping[str, Any],
    verify_trust_foreclosure_board: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    return (
        _mapping(verify_trust_foreclosure_board)
        or _mapping(dependency_payload.get("verify_trust_foreclosure_board"))
        or _mapping(dependency_payload.get("verifyTrustForeclosureBoard"))
        or _mapping(dependency_payload.get("internal_verification_carry"))
    )


def _extract_repair_slot(
    *,
    dependency_payload: Mapping[str, Any],
    repair_slot_escrow: Mapping[str, Any] | None,
    settlement: Mapping[str, Any],
) -> Mapping[str, Any]:
    return (
        _mapping(repair_slot_escrow)
        or _mapping(dependency_payload.get("repair_slot_escrow"))
        or _mapping(dependency_payload.get("repairSlotEscrow"))
        or _mapping(dependency_payload.get("stage_debt_repair_admission"))
        or _mapping(dependency_payload.get("stageDebtRepairAdmission"))
        or _mapping(settlement.get("selected_repair_ticket"))
        or _mapping(settlement.get("selectedRepairTicket"))
    )


def _extract_witness(
    *,
    dependency_payload: Mapping[str, Any],
    foreclosure_carry_rollout_witness: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    return (
        _mapping(foreclosure_carry_rollout_witness)
        or _mapping(dependency_payload.get("foreclosure_carry_rollout_witness"))
        or _mapping(dependency_payload.get("foreclosureCarryRolloutWitness"))
        or _mapping(dependency_payload.get("controller_ingestion_witness"))
        or _mapping(dependency_payload.get("controllerIngestionWitness"))
    )


def _ref(payload: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        normalized = _text(payload.get(key))
        if normalized:
            return normalized
    return ""


def _selected_ticket_class(
    settlement: Mapping[str, Any],
    repair_slot: Mapping[str, Any],
) -> str:
    return _first_text(
        repair_slot.get("ticket_class"),
        repair_slot.get("ticketClass"),
        repair_slot.get("repair_class"),
        repair_slot.get("repairClass"),
        settlement.get("selected_ticket_class"),
        settlement.get("selectedTicketClass"),
    )


def _selected_ticket_id(
    settlement: Mapping[str, Any],
    repair_slot: Mapping[str, Any],
) -> str:
    return _first_text(
        repair_slot.get("ticket_id"),
        repair_slot.get("ticketId"),
        repair_slot.get("admission_id"),
        repair_slot.get("admissionId"),
        repair_slot.get("escrow_id"),
        repair_slot.get("escrowId"),
        settlement.get("selected_ticket_id"),
        settlement.get("selectedTicketId"),
        settlement.get("selected_repair_ticket_id"),
        settlement.get("selectedRepairTicketId"),
    )


def _controller_ingestion_current(settlement: Mapping[str, Any]) -> bool | None:
    direct = _bool_or_none(
        settlement.get("controller_ingestion_current")
        if "controller_ingestion_current" in settlement
        else settlement.get("controllerIngestionCurrent")
    )
    if direct is not None:
        return direct
    for key in (
        "agentrun_ingestion_current",
        "agentrunIngestionCurrent",
        "ingestion_current",
        "ingestionCurrent",
        "controller_self_report_current",
        "controllerSelfReportCurrent",
        "current",
        "watch_current",
        "watchCurrent",
        "watch_epoch_current",
        "watchEpochCurrent",
        "self_report_current",
        "selfReportCurrent",
    ):
        parsed = _bool_or_none(settlement.get(key))
        if parsed is not None:
            return parsed
    state = _text(settlement.get("state") or settlement.get("status")).lower()
    if state in {"current", "ready", "ok"}:
        return True
    if state in {"missing", "unknown", "stale", "blocked", "degraded"}:
        return False
    return None


def _has_source_claim(
    *,
    dependency_payload: Mapping[str, Any],
    settlement: Mapping[str, Any],
    witness: Mapping[str, Any],
) -> bool:
    if witness:
        return True
    source_state = _text(
        dependency_payload.get("source_rollout_truth_state")
        or dependency_payload.get("sourceRolloutTruthState")
        or settlement.get("source_rollout_truth_state")
        or settlement.get("sourceRolloutTruthState")
    ).lower()
    if source_state in {"source_ahead", "desired_ahead", "rollout_lagging", "lagging"}:
        return True
    desired = _first_text(
        dependency_payload.get("desired_image_ref"),
        dependency_payload.get("desiredImageRef"),
        settlement.get("desired_image_ref"),
        settlement.get("desiredImageRef"),
    )
    observed = _first_text(
        dependency_payload.get("observed_image_ref"),
        dependency_payload.get("observedImageRef"),
        settlement.get("observed_image_ref"),
        settlement.get("observedImageRef"),
    )
    return bool(desired and (not observed or desired != observed))


def _is_stale(
    *,
    generated: datetime,
    settlement: Mapping[str, Any],
    board: Mapping[str, Any],
    witness: Mapping[str, Any],
) -> bool:
    for payload in (settlement, board, witness):
        fresh_until = _parse_datetime(payload.get("fresh_until"))
        if fresh_until is not None and fresh_until <= generated:
            return True
    return False


def _repairable_ticket_present(
    *,
    settlement: Mapping[str, Any],
    repair_slot: Mapping[str, Any],
) -> bool:
    ticket_class = _selected_ticket_class(settlement, repair_slot)
    release_condition = _first_text(
        repair_slot.get("release_condition"),
        repair_slot.get("releaseCondition"),
        settlement.get("selected_release_condition"),
        settlement.get("selectedReleaseCondition"),
    )
    receipt = _first_text(
        repair_slot.get("required_output_receipt"),
        repair_slot.get("requiredOutputReceipt"),
        settlement.get("required_output_receipt"),
        settlement.get("requiredOutputReceipt"),
    )
    return (
        ticket_class == "internal_verify_carry"
        or release_condition == "internal_controller_ingestion_current"
        or receipt == "internal.verify-trust-foreclosure-ticket.v1"
    )


def build_internal_controller_ingestion_carry(
    *,
    generated_at: datetime,
    dependency_quorum: Mapping[str, Any] | None = None,
    controller_ingestion_settlement: Mapping[str, Any] | None = None,
    verify_trust_foreclosure_board: Mapping[str, Any] | None = None,
    repair_slot_escrow: Mapping[str, Any] | None = None,
    foreclosure_carry_rollout_witness: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Classify Internal carry imported into Torghut's no-delta repair auction."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    default_fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    dependency_payload = _extract_dependency_payload(dependency_quorum)
    settlement = _extract_controller_settlement(
        dependency_payload=dependency_payload,
        controller_ingestion_settlement=controller_ingestion_settlement,
    )
    board = _extract_foreclosure_board(
        dependency_payload=dependency_payload,
        verify_trust_foreclosure_board=verify_trust_foreclosure_board,
    )
    repair_slot = _extract_repair_slot(
        dependency_payload=dependency_payload,
        repair_slot_escrow=repair_slot_escrow,
        settlement=settlement,
    )
    witness = _extract_witness(
        dependency_payload=dependency_payload,
        foreclosure_carry_rollout_witness=foreclosure_carry_rollout_witness,
    )

    settlement_ref = _ref(
        settlement,
        "settlement_id",
        "settlementId",
        "ledger_id",
        "ledgerId",
        "receipt_id",
        "receiptId",
        "id",
        "ref",
    )
    board_ref = _ref(board, "board_id", "boardId", "carry_id", "carryId", "id", "ref")
    repair_slot_ref = _ref(
        repair_slot,
        "escrow_id",
        "escrowId",
        "admission_id",
        "admissionId",
        "ticket_id",
        "ticketId",
        "id",
        "ref",
    )
    raw_settlement_decision = (
        settlement.get("decision")
        or settlement.get("settlement_decision")
        or settlement.get("settlementDecision")
    )
    decision = _normalize_decision(
        raw_settlement_decision
        if raw_settlement_decision is not None
        else dependency_payload.get("decision")
        if settlement
        else None
    )
    ingestion_current = _controller_ingestion_current(settlement)
    selected_ticket_class = _selected_ticket_class(settlement, repair_slot)
    selected_ticket_id = _selected_ticket_id(settlement, repair_slot)
    stale = bool(settlement) and _is_stale(
        generated=generated,
        settlement=settlement,
        board=board,
        witness=witness,
    )
    source_claim = _has_source_claim(
        dependency_payload=dependency_payload,
        settlement=settlement,
        witness=witness,
    )
    reason_codes = _append_unique(
        _string_list(dependency_payload.get("reasons")),
        settlement.get("reason_codes"),
        settlement.get("reasonCodes"),
        board.get("reason_codes"),
        board.get("reasonCodes"),
        repair_slot.get("reason_codes"),
        repair_slot.get("reasonCodes"),
    )

    if stale:
        carry_state = "stale"
        reason_codes = _append_unique(
            reason_codes, "internal_controller_ingestion_settlement_stale"
        )
    elif decision == "allow" and (ingestion_current is not True or not board_ref):
        carry_state = "contradicted"
        reason_codes = _append_unique(
            reason_codes, "internal_allow_without_required_carry_fields"
        )
    elif decision == "allow" and ingestion_current is True and board_ref:
        carry_state = "current"
    elif decision == "repair_only" and _repairable_ticket_present(
        settlement=settlement,
        repair_slot=repair_slot,
    ):
        carry_state = "repairable"
        reason_codes = _append_unique(
            reason_codes, "internal_controller_ingestion_repairable"
        )
        if not selected_ticket_class:
            selected_ticket_class = "internal_verify_carry"
    elif (
        decision in {"hold", "block"}
        and settlement
        and (board_ref or source_claim or ingestion_current is False)
    ):
        carry_state = "lagging"
        reason_codes = _append_unique(
            reason_codes,
            f"internal_controller_ingestion_{decision}",
            "internal_controller_ingestion_lagging",
        )
    elif source_claim and (not board_ref or ingestion_current is not True):
        carry_state = "lagging"
        reason_codes = _append_unique(
            reason_codes, "internal_controller_ingestion_lagging"
        )
    else:
        carry_state = "unavailable"
        if not settlement:
            reason_codes = _append_unique(
                reason_codes, "internal_controller_ingestion_settlement_missing"
            )
        if not board_ref:
            reason_codes = _append_unique(
                reason_codes, "internal_verify_foreclosure_board_missing"
            )

    if carry_state not in {"current", "repairable"} and not reason_codes:
        reason_codes = ["internal_controller_ingestion_carry_unavailable"]

    validation_commands = _string_list(
        repair_slot.get("validation_commands")
        or repair_slot.get("validationCommands")
        or settlement.get("validation_commands")
        or settlement.get("validationCommands")
    )
    if carry_state == "repairable" and not validation_commands:
        validation_commands = list(_VALIDATION_COMMANDS)

    fresh_until = (
        _parse_datetime(settlement.get("fresh_until"))
        or _parse_datetime(board.get("fresh_until"))
        or _parse_datetime(witness.get("fresh_until"))
        or default_fresh_until
    )
    carry_id = "internal-controller-ingestion-carry:" + _stable_hash(
        "internal-controller-ingestion-carry",
        {
            "settlement_ref": settlement_ref,
            "board_ref": board_ref,
            "repair_slot_ref": repair_slot_ref,
            "decision": decision,
            "ingestion_current": ingestion_current,
            "carry_state": carry_state,
            "selected_ticket_id": selected_ticket_id,
        },
    )

    return {
        "schema_version": JANGAR_CONTROLLER_INGESTION_CARRY_SCHEMA_VERSION,
        "carry_id": carry_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _DESIGN_REF,
        "companion_internal_design_ref": _COMPANION_JANGAR_DESIGN_REF,
        "source_internal_settlement_ref": settlement_ref or None,
        "internal_settlement_decision": decision,
        "internal_controller_ingestion_current": ingestion_current,
        "internal_verify_foreclosure_board_ref": board_ref or None,
        "internal_repair_slot_escrow_ref": repair_slot_ref or None,
        "carry_state": carry_state,
        "selected_release_condition": "internal_controller_ingestion_current",
        "selected_ticket_class": selected_ticket_class or "none",
        "selected_ticket_id": selected_ticket_id or None,
        "max_notional": "0",
        "reason_codes": reason_codes,
        "validation_commands": validation_commands,
        "rollback_target": _ROLLBACK_TARGET,
    }


def compact_internal_controller_ingestion_carry(
    carry: Mapping[str, Any] | None,
) -> dict[str, object]:
    """Return a compact Internal-facing controller-ingestion carry ref."""

    payload = _mapping(carry)
    if not payload:
        return {
            "schema_version": JANGAR_CONTROLLER_INGESTION_CARRY_REF_SCHEMA_VERSION,
            "status": "missing",
            "reason_codes": ["internal_controller_ingestion_carry_missing"],
        }
    validation_commands = _string_list(payload.get("validation_commands"))
    return {
        "schema_version": JANGAR_CONTROLLER_INGESTION_CARRY_REF_SCHEMA_VERSION,
        "carry_schema_version": payload.get("schema_version"),
        "carry_id": payload.get("carry_id"),
        "generated_at": payload.get("generated_at"),
        "fresh_until": payload.get("fresh_until"),
        "carry_state": payload.get("carry_state"),
        "source_internal_settlement_ref": payload.get("source_internal_settlement_ref"),
        "internal_settlement_decision": payload.get("internal_settlement_decision"),
        "internal_controller_ingestion_current": payload.get(
            "internal_controller_ingestion_current"
        ),
        "internal_verify_foreclosure_board_ref": payload.get(
            "internal_verify_foreclosure_board_ref"
        ),
        "internal_repair_slot_escrow_ref": payload.get("internal_repair_slot_escrow_ref"),
        "selected_release_condition": payload.get("selected_release_condition"),
        "selected_ticket_class": payload.get("selected_ticket_class"),
        "selected_ticket_id": payload.get("selected_ticket_id"),
        "max_notional": payload.get("max_notional"),
        "reason_codes": _string_list(payload.get("reason_codes")),
        "validation_command": validation_commands[0] if validation_commands else None,
        "rollback_target": payload.get("rollback_target"),
    }


__all__ = [
    "JANGAR_CONTROLLER_INGESTION_CARRY_REF_SCHEMA_VERSION",
    "JANGAR_CONTROLLER_INGESTION_CARRY_SCHEMA_VERSION",
    "build_internal_controller_ingestion_carry",
    "compact_internal_controller_ingestion_carry",
]
