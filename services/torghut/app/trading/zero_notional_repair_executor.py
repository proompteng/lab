"""Zero-notional repair execution receipts for profit-freshness frontier lots."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Any, cast


ZERO_NOTIONAL_REPAIR_EXECUTION_SCHEMA_VERSION = (
    "torghut.zero-notional-repair-execution-receipt.v1"
)
REPAIR_LOT_DISPATCH_TICKET_SCHEMA_VERSION = "jangar.repair-lot-dispatch-ticket.v1"

_ZERO_VALUES = {"", "0", "0.0", "0.00", "0.0000"}
_TRUE_VALUES = {"1", "true", "yes", "on", "allow", "allowed"}
_ALLOWLIST: Mapping[str, Mapping[str, object]] = {
    "renew_empirical_proof_jobs": {
        "executor": "empirical_proof_renewal",
        "runner_required": True,
        "requires_torghut_admission": True,
        "value_gate": "zero_notional_or_stale_evidence_rate",
        "rollback_path": "cancel empirical renewal run and keep stale proof lot queued at max_notional=0",
    },
    "recompute_route_tca_and_fill_quality": {
        "executor": "route_tca_recompute",
        "runner_required": False,
        "requires_torghut_admission": False,
        "value_gate": "fill_tca_or_slippage_quality",
        "rollback_path": "ignore recomputed TCA receipt and leave routeability lot unsettled",
    },
    "rerun_drift_checks_for_blocked_hypotheses": {
        "executor": "hypothesis_drift_check_replay",
        "runner_required": False,
        "requires_torghut_admission": False,
        "value_gate": "zero_notional_or_stale_evidence_rate",
        "rollback_path": "discard replayed drift receipt and keep the hypothesis repair lot queued",
    },
    "rebuild_required_feature_rows": {
        "executor": "hypothesis_feature_coverage_replay",
        "runner_required": False,
        "requires_torghut_admission": False,
        "value_gate": "zero_notional_or_stale_evidence_rate",
        "rollback_path": "discard replayed feature coverage receipt and keep the hypothesis repair lot queued",
    },
}
_FRESHNESS_DIMENSION_BY_ACTION: Mapping[str, str] = {
    "renew_empirical_proof_jobs": "empirical",
    "recompute_route_tca_and_fill_quality": "tca",
}

RepairRunner = Callable[[Mapping[str, Any]], Mapping[str, object]]


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _strings(value: object) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in _sequence(value):
        text = _text(item)
        if text and text not in seen:
            result.append(text)
            seen.add(text)
    return result


def _bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return _text(value).lower() in _TRUE_VALUES


def _positive_number(value: object) -> bool:
    try:
        return float(_text(value)) > 0
    except ValueError:
        return False


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _repair_matches_action(repair: Mapping[str, Any], preferred_action: str) -> bool:
    return _text(repair.get("zero_notional_action")) == preferred_action


def _selected_repairs(frontier: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        _mapping(item)
        for item in _sequence(frontier.get("selected_zero_notional_repairs"))
        if _mapping(item)
    ]


def _repair_lots(frontier: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        _mapping(item)
        for item in _sequence(frontier.get("repair_lots"))
        if _mapping(item)
    ]


def _selected_repair(
    frontier: Mapping[str, Any],
    *,
    preferred_action: str | None = None,
) -> Mapping[str, Any]:
    selected_repairs = _selected_repairs(frontier)
    repair_lots = _repair_lots(frontier)
    candidates = [*selected_repairs, *repair_lots]
    if preferred_action:
        for repair in candidates:
            if _repair_matches_action(repair, preferred_action):
                return repair
        return {}
    if selected_repairs:
        return selected_repairs[0]
    for lot in repair_lots:
        if _text(lot.get("state")) == "selected_zero_notional_repair":
            return lot
    return {}


def _is_zero(value: object) -> bool:
    return _text(value, "0") in _ZERO_VALUES


def _requires_dispatch_ticket(action_contract: Mapping[str, object]) -> bool:
    return bool(action_contract.get("requires_torghut_admission", False))


def _selected_repair_lot_refs(repair: Mapping[str, Any]) -> set[str]:
    return {
        ref
        for ref in (
            _text(repair.get("lot_id")),
            _text(repair.get("compacted_lot_ref")),
            _text(repair.get("torghut_compacted_lot_ref")),
            _text(repair.get("repair_bid_settlement_lot_ref")),
        )
        if ref
    }


def _dispatch_ticket_reasons(
    repair: Mapping[str, Any],
    action_contract: Mapping[str, object],
    ticket: Mapping[str, Any],
) -> list[str]:
    if not _requires_dispatch_ticket(action_contract):
        return []

    reasons: list[str] = []
    if not ticket:
        return ["repair_lot_dispatch_ticket_missing"]
    if _text(ticket.get("schema_version")) != REPAIR_LOT_DISPATCH_TICKET_SCHEMA_VERSION:
        reasons.append("repair_lot_dispatch_ticket_schema_mismatch")
    if not _text(ticket.get("ticket_id")):
        reasons.append("repair_lot_dispatch_ticket_id_missing")
    if not _bool(ticket.get("launch_allowed")):
        reasons.append("repair_lot_dispatch_ticket_not_allowed")
    if "max_notional" not in ticket:
        reasons.append("repair_lot_dispatch_ticket_notional_missing")
    elif not _is_zero(ticket.get("max_notional")):
        reasons.append("repair_lot_dispatch_ticket_notional_nonzero")
    if not _text(ticket.get("dedupe_key")):
        reasons.append("repair_lot_dispatch_ticket_dedupe_key_missing")
    if not _text(ticket.get("required_output_receipt")):
        reasons.append("repair_lot_dispatch_ticket_output_receipt_missing")
    if not _positive_number(ticket.get("max_runtime_seconds")):
        reasons.append("repair_lot_dispatch_ticket_ttl_invalid")

    ticket_value_gate = _text(ticket.get("target_value_gate"))
    accepted_value_gates = {
        value_gate
        for value_gate in (
            _text(action_contract.get("value_gate")),
            _text(repair.get("value_gate")),
        )
        if value_gate
    }
    if not ticket_value_gate:
        reasons.append("repair_lot_dispatch_ticket_value_gate_missing")
    elif accepted_value_gates and ticket_value_gate not in accepted_value_gates:
        reasons.append("repair_lot_dispatch_ticket_value_gate_mismatch")

    ticket_lot_ref = _text(ticket.get("torghut_lot_id"))
    accepted_lot_refs = _selected_repair_lot_refs(repair)
    if not ticket_lot_ref:
        reasons.append("repair_lot_dispatch_ticket_lot_missing")
    elif accepted_lot_refs and ticket_lot_ref not in accepted_lot_refs:
        reasons.append("repair_lot_dispatch_ticket_lot_mismatch")

    return _strings(reasons)


def _freshness_dimension_id(
    action: str, action_contract: Mapping[str, object]
) -> str | None:
    configured_dimension = _text(action_contract.get("freshness_dimension_id"))
    if configured_dimension:
        return configured_dimension
    action_dimension = _FRESHNESS_DIMENSION_BY_ACTION.get(action)
    if action_dimension:
        return action_dimension
    return None


def _freshness_carry_citation(
    *,
    action: str,
    action_contract: Mapping[str, object],
    freshness_carry_ledger: Mapping[str, Any],
) -> dict[str, object]:
    dimension_id = _freshness_dimension_id(action, action_contract)
    if not dimension_id:
        return {
            "required": False,
            "state": "not_required",
            "ledger_ref": None,
            "dimension_id": None,
            "dimension_state": None,
            "dimension_proof_authority": None,
            "dimension_stale_reason_codes": [],
            "repair_proof_slo_ref": None,
            "repair_proof_slo_dispatchable": None,
            "target_value_gate": None,
            "required_output_receipts": [],
            "blocking_reasons": [],
        }

    ledger_ref = freshness_carry_ledger.get("ledger_id")
    blocking_reasons: list[str] = []
    citation_state = "cited"
    matched_dimension: Mapping[str, Any] = {}
    matched_slo: Mapping[str, Any] = {}

    if not freshness_carry_ledger:
        citation_state = "missing_ledger"
        blocking_reasons.append("freshness_carry_ledger_missing")
    else:
        for raw_dimension in _sequence(freshness_carry_ledger.get("dimensions")):
            dimension = _mapping(raw_dimension)
            if _text(dimension.get("dimension_id")) == dimension_id:
                matched_dimension = dimension
                break
        if not matched_dimension:
            citation_state = "missing_dimension"
            blocking_reasons.append(f"freshness_dimension_missing:{dimension_id}")

        for raw_slo in _sequence(freshness_carry_ledger.get("repair_proof_slos")):
            slo = _mapping(raw_slo)
            if _text(slo.get("target_dimension_id")) == dimension_id:
                matched_slo = slo
                break
        if not matched_slo:
            citation_state = "missing_slo"
            blocking_reasons.append(
                f"freshness_repair_proof_slo_missing:{dimension_id}"
            )
        elif not _bool(matched_slo.get("dispatchable")):
            citation_state = "not_dispatchable"
            blocking_reasons.append(
                f"freshness_repair_proof_slo_not_dispatchable:{dimension_id}"
            )
            blocking_reasons.extend(_strings(matched_slo.get("hold_reason_codes")))

    return {
        "required": True,
        "state": citation_state,
        "ledger_ref": ledger_ref,
        "dimension_id": dimension_id,
        "dimension_state": matched_dimension.get("state"),
        "dimension_proof_authority": matched_dimension.get("proof_authority"),
        "dimension_stale_reason_codes": _strings(
            matched_dimension.get("stale_reason_codes")
        ),
        "repair_proof_slo_ref": matched_slo.get("repair_id"),
        "repair_proof_slo_dispatchable": _bool(matched_slo.get("dispatchable"))
        if matched_slo
        else None,
        "target_value_gate": matched_slo.get("target_value_gate"),
        "required_output_receipts": _strings(
            matched_slo.get("required_output_receipts")
        ),
        "blocking_reasons": _strings(blocking_reasons),
    }


def _freshness_citation_blocking_reasons(citation: Mapping[str, object]) -> list[str]:
    if not bool(citation.get("required")):
        return []
    return _strings(citation.get("blocking_reasons"))


def _capital_safety_reasons(
    frontier: Mapping[str, Any], repair: Mapping[str, Any]
) -> list[str]:
    posture = _mapping(frontier.get("capital_posture"))
    reasons: list[str] = []
    if not _is_zero(posture.get("paper_notional_limit")):
        reasons.append("frontier_paper_notional_nonzero")
    if not _is_zero(posture.get("live_notional_limit")):
        reasons.append("frontier_live_notional_nonzero")
    if not _is_zero(repair.get("paper_notional_limit")):
        reasons.append("repair_paper_notional_nonzero")
    if not _is_zero(repair.get("live_notional_limit")):
        reasons.append("repair_live_notional_nonzero")
    if _text(posture.get("capital_behavior_changed")).lower() == "true":
        reasons.append("frontier_capital_behavior_changed")
    return reasons


def build_zero_notional_repair_execution_receipt(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    source_commit: str | None,
    profit_freshness_frontier: Mapping[str, Any],
    execute: bool = False,
    preferred_action: str | None = None,
    action_result: Mapping[str, object] | None = None,
    repair_lot_dispatch_ticket: Mapping[str, object] | None = None,
    freshness_carry_ledger: Mapping[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a receipt for the selected frontier repair without granting capital."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    frontier = _mapping(profit_freshness_frontier)
    normalized_preferred_action = _text(preferred_action)
    repair = _selected_repair(
        frontier,
        preferred_action=normalized_preferred_action or None,
    )
    action = _text(repair.get("zero_notional_action"))
    action_contract = _mapping(_ALLOWLIST.get(action))
    result = _mapping(action_result)
    dispatch_ticket = _mapping(repair_lot_dispatch_ticket)
    blocked_reasons = _capital_safety_reasons(frontier, repair)
    dispatch_ticket_reasons = _dispatch_ticket_reasons(
        repair,
        action_contract,
        dispatch_ticket,
    )
    freshness_citation = _freshness_carry_citation(
        action=action,
        action_contract=action_contract,
        freshness_carry_ledger=_mapping(freshness_carry_ledger),
    )
    freshness_citation_reasons = _freshness_citation_blocking_reasons(
        freshness_citation
    )
    execution_state = "dry_run_ready"
    command_exit_code: int | None = 0

    if not repair:
        execution_state = "no_selected_repair"
        blocked_reasons.append(
            f"profit_freshness_frontier_matching_repair_missing:{normalized_preferred_action}"
            if normalized_preferred_action
            else "profit_freshness_frontier_selected_repair_missing"
        )
        command_exit_code = 78
    elif not action_contract:
        execution_state = "unsupported_action"
        blocked_reasons.append(f"zero_notional_action_not_allowlisted:{action}")
        command_exit_code = 78
    elif blocked_reasons:
        execution_state = "capital_safety_blocked"
        command_exit_code = 78
    elif execute and dispatch_ticket_reasons:
        execution_state = "repair_lot_dispatch_ticket_required"
        blocked_reasons.extend(dispatch_ticket_reasons)
        command_exit_code = 78
    elif execute and freshness_citation_reasons:
        execution_state = "freshness_repair_slo_required"
        blocked_reasons.extend(freshness_citation_reasons)
        command_exit_code = 78
    elif execute and result:
        execution_state = _text(result.get("execution_state"), "executed")
        command_exit_code = int(cast(int, result.get("command_exit_code", 0)))
        blocked_reasons.extend(_strings(result.get("blocked_reasons")))
    elif execute and bool(action_contract.get("runner_required")):
        execution_state = "runner_admission_required"
        blocked_reasons.append("zero_notional_runner_admission_required")
        command_exit_code = 78
    elif execute:
        execution_state = "runner_not_configured"
        blocked_reasons.append("zero_notional_runner_not_configured")
        command_exit_code = 78

    receipt_payload = {
        "frontier_id": frontier.get("frontier_id"),
        "lot_id": repair.get("lot_id"),
        "action": action,
        "preferred_action": normalized_preferred_action or None,
        "execute": execute,
        "execution_state": execution_state,
        "blocked_reasons": blocked_reasons,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
    }
    return {
        "schema_version": ZERO_NOTIONAL_REPAIR_EXECUTION_SCHEMA_VERSION,
        "receipt_id": _stable_ref("zero-notional-repair-execution", receipt_payload),
        "generated_at": generated_at.isoformat(),
        "account_label": account_label,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
        "frontier_ref": frontier.get("frontier_id"),
        "repair_lot_ref": repair.get("lot_id"),
        "candidate_id": repair.get("candidate_id"),
        "hypothesis_id": repair.get("hypothesis_id"),
        "blocked_dimension": repair.get("blocked_dimension"),
        "zero_notional_action": action or None,
        "preferred_zero_notional_action": normalized_preferred_action or None,
        "freshness_carry_ledger_ref": freshness_citation["ledger_ref"],
        "freshness_citation_required": freshness_citation["required"],
        "freshness_citation_state": freshness_citation["state"],
        "freshness_dimension_id": freshness_citation["dimension_id"],
        "freshness_dimension_state": freshness_citation["dimension_state"],
        "freshness_dimension_proof_authority": freshness_citation[
            "dimension_proof_authority"
        ],
        "freshness_dimension_stale_reason_codes": freshness_citation[
            "dimension_stale_reason_codes"
        ],
        "freshness_repair_proof_slo_ref": freshness_citation["repair_proof_slo_ref"],
        "freshness_repair_proof_slo_dispatchable": freshness_citation[
            "repair_proof_slo_dispatchable"
        ],
        "freshness_target_value_gate": freshness_citation["target_value_gate"],
        "freshness_required_output_receipts": freshness_citation[
            "required_output_receipts"
        ],
        "executor": action_contract.get("executor"),
        "value_gate": action_contract.get("value_gate")
        or repair.get("value_gate")
        or "zero_notional_or_stale_evidence_rate",
        "execution_state": execution_state,
        "execution_mode": "execute" if execute else "dry_run",
        "command_exit_code": command_exit_code,
        "command_ref": f"torghut:{action or 'no_selected_repair'}",
        "before_refs": _strings(repair.get("before_refs")),
        "after_refs": _strings(result.get("after_refs")),
        "runner_result": dict(result),
        "blocked_reasons": blocked_reasons,
        "requires_torghut_admission": bool(
            action_contract.get("requires_torghut_admission", False)
        ),
        "requires_repair_lot_dispatch_ticket": _requires_dispatch_ticket(
            action_contract
        ),
        "repair_lot_dispatch_ticket_ref": dispatch_ticket.get("ticket_id"),
        "repair_lot_dispatch_ticket_lot_ref": dispatch_ticket.get("torghut_lot_id"),
        "repair_lot_dispatch_ticket_launch_allowed": (
            _bool(dispatch_ticket.get("launch_allowed")) if dispatch_ticket else None
        ),
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
        "capital_behavior_changed": False,
        "order_submission_enabled": False,
        "rollback_path": action_contract.get("rollback_path")
        or "keep proof floor as authority and leave capital zero-notional",
        "safety_invariants": {
            "max_notional": "0",
            "paper_live_capital_unchanged": True,
            "order_submission_disabled": True,
        },
    }


def run_zero_notional_repair(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    source_commit: str | None,
    profit_freshness_frontier: Mapping[str, Any],
    execute: bool,
    preferred_action: str | None = None,
    repair_lot_dispatch_ticket: Mapping[str, object] | None = None,
    freshness_carry_ledger: Mapping[str, Any] | None = None,
    runners: Mapping[str, RepairRunner] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Run or dry-run the selected allowlisted repair and return its receipt."""

    frontier = _mapping(profit_freshness_frontier)
    normalized_preferred_action = _text(preferred_action)
    repair = _selected_repair(
        frontier,
        preferred_action=normalized_preferred_action or None,
    )
    action = _text(repair.get("zero_notional_action"))
    action_contract = _ALLOWLIST.get(action)
    dispatch_ticket = _mapping(repair_lot_dispatch_ticket)
    dispatch_ticket_reasons = _dispatch_ticket_reasons(
        repair,
        _mapping(action_contract),
        dispatch_ticket,
    )
    freshness_citation = _freshness_carry_citation(
        action=action,
        action_contract=_mapping(action_contract),
        freshness_carry_ledger=_mapping(freshness_carry_ledger),
    )
    freshness_citation_reasons = _freshness_citation_blocking_reasons(
        freshness_citation
    )
    action_result: Mapping[str, object] | None = None

    if (
        execute
        and repair
        and action_contract
        and not _capital_safety_reasons(frontier, repair)
        and not dispatch_ticket_reasons
        and not freshness_citation_reasons
        and action in (runners or {})
    ):
        runner = cast(Mapping[str, RepairRunner], runners)[action]
        action_result = runner(repair)

    return build_zero_notional_repair_execution_receipt(
        account_label=account_label,
        trading_mode=trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        profit_freshness_frontier=frontier,
        execute=execute,
        preferred_action=normalized_preferred_action or None,
        action_result=action_result,
        repair_lot_dispatch_ticket=dispatch_ticket,
        freshness_carry_ledger=freshness_carry_ledger,
        now=now,
    )


__all__ = [
    "ZERO_NOTIONAL_REPAIR_EXECUTION_SCHEMA_VERSION",
    "REPAIR_LOT_DISPATCH_TICKET_SCHEMA_VERSION",
    "build_zero_notional_repair_execution_receipt",
    "run_zero_notional_repair",
]
