"""Renewal-bond profit escrow projection for zero-notional repair ranking."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, cast

RENEWAL_BOND_PROFIT_ESCROW_SCHEMA_VERSION = "torghut.renewal-bond-profit-escrow.v1"

JangarStageState = Literal["current", "renewing", "repair_only", "stale", "blocked"]

_STAGE_STATES: set[str] = {"current", "renewing", "repair_only", "stale", "blocked"}
_STAGE_STATE_RANK: dict[str, int] = {
    "current": 0,
    "renewing": 1,
    "repair_only": 2,
    "stale": 3,
    "blocked": 4,
}
_BLOCKING_STAGE_STATES = {"renewing", "repair_only", "stale", "blocked"}
_DEGRADED_MARKET_STATES = {
    "down",
    "degraded",
    "error",
    "fail",
    "failed",
    "blocked",
    "unknown",
}


def _text(value: object, default: str | None = None) -> str | None:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


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
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str) and value.strip():
        try:
            return Decimal(value.strip())
        except InvalidOperation:
            return None
    return None


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _string_list(value: object) -> list[str]:
    return sorted(
        {text for item in _sequence(value) if (text := _text(item)) is not None}
    )


def _stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _stage_state_from_text(value: object) -> JangarStageState | None:
    state = (_text(value) or "").lower().replace("-", "_")
    if state in _STAGE_STATES:
        return cast(JangarStageState, state)
    return None


def _is_active_bond(item: Mapping[str, Any]) -> bool:
    state = (_text(item.get("state")) or "").lower()
    return state in {"renewing", "active", "in_flight", "running", "admitted"}


def _active_renewal_bond_refs(
    bonds: Sequence[Mapping[str, Any]], stage: str | None = None
) -> list[str]:
    refs: list[str] = []
    for bond in bonds:
        if not _is_active_bond(bond):
            continue
        if stage is not None and _text(bond.get("stage")) not in {stage, None}:
            continue
        ref = (
            _text(bond.get("bond_id"))
            or _text(bond.get("bondId"))
            or _text(bond.get("agentrun_ref"))
            or _text(bond.get("agentrunRef"))
        )
        if ref is not None:
            refs.append(ref)
    return sorted(set(refs))


def _stage_records_from_mapping(
    *,
    payload: Mapping[str, Any],
    bonds: Sequence[Mapping[str, Any]],
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    if not payload:
        return records

    direct_state = _stage_state_from_text(payload.get("state"))
    direct_stage = _text(payload.get("stage")) or _text(payload.get("name"))
    if direct_state is not None:
        records.append(
            {
                "stage": direct_stage or "platform",
                "state": direct_state,
                "reason_codes": _string_list(
                    payload.get("reason_codes") or payload.get("reasons")
                ),
                "active_renewal_bond_refs": _active_renewal_bond_refs(
                    bonds, direct_stage
                ),
                "fresh_until": _text(
                    payload.get("fresh_until") or payload.get("freshUntil")
                ),
                "material_action_effects": _mapping(
                    payload.get("material_action_effects")
                ),
            }
        )

    stage_items = (
        payload.get("stages")
        or payload.get("stage_states")
        or payload.get("stageStates")
    )
    for raw_item in _sequence(stage_items):
        item = _mapping(raw_item)
        state = _stage_state_from_text(item.get("state") or item.get("status"))
        if state is None:
            continue
        stage = _text(item.get("stage")) or _text(item.get("name")) or "platform"
        records.append(
            {
                "stage": stage,
                "state": state,
                "reason_codes": _string_list(
                    item.get("reason_codes") or item.get("reasons")
                ),
                "active_renewal_bond_refs": _active_renewal_bond_refs(bonds, stage),
                "fresh_until": _text(item.get("fresh_until") or item.get("freshUntil")),
                "material_action_effects": _mapping(
                    item.get("material_action_effects")
                ),
            }
        )

    if not records:
        for key, raw_value in payload.items():
            if key in {
                "generated_at",
                "generatedAt",
                "controller_ingestion_settlement_ref",
                "controllerIngestionSettlementRef",
                "material_action_effects",
                "required_stages",
                "requiredStages",
                "stages",
                "stage_states",
                "stageStates",
            }:
                continue
            if isinstance(raw_value, Mapping):
                value = cast(Mapping[str, Any], raw_value)
                state = _stage_state_from_text(
                    value.get("state") or value.get("status")
                )
                reason_codes = _string_list(
                    value.get("reason_codes") or value.get("reasons")
                )
                fresh_until = _text(value.get("fresh_until") or value.get("freshUntil"))
            else:
                state = _stage_state_from_text(raw_value)
                reason_codes = []
                fresh_until = None
            if state is None:
                continue
            records.append(
                {
                    "stage": str(key),
                    "state": state,
                    "reason_codes": reason_codes,
                    "active_renewal_bond_refs": _active_renewal_bond_refs(
                        bonds, str(key)
                    ),
                    "fresh_until": fresh_until,
                    "material_action_effects": {},
                }
            )
    return records


def _stage_records_from_quorum(quorum: Mapping[str, Any]) -> list[dict[str, object]]:
    stage_trust = _mapping(quorum.get("stage_trust") or quorum.get("stageTrust"))
    bonds = [
        _mapping(cast(Mapping[str, Any], item))
        for item in _sequence(
            quorum.get("stage_renewal_bonds") or quorum.get("stageRenewalBonds")
        )
        if isinstance(item, Mapping)
    ]
    records = _stage_records_from_mapping(payload=stage_trust, bonds=bonds)
    if records:
        return records

    decision = (_text(quorum.get("decision"), "unknown") or "unknown").lower()
    reasons = _string_list(quorum.get("reasons"))
    active_bond_refs = _active_renewal_bond_refs(bonds)
    if active_bond_refs:
        state: JangarStageState = "renewing"
    elif decision == "allow":
        state = "current"
    elif decision == "delay":
        state = "repair_only"
    elif decision == "block":
        state = "blocked"
    else:
        state = "stale"
    return [
        {
            "stage": "dependency_quorum",
            "state": state,
            "reason_codes": reasons,
            "active_renewal_bond_refs": active_bond_refs,
            "fresh_until": None,
            "material_action_effects": {},
        }
    ]


def _stage_coherence_state(
    stage_records: Sequence[Mapping[str, object]],
) -> JangarStageState:
    states = [
        str(record.get("state"))
        for record in stage_records
        if str(record.get("state")) in _STAGE_STATE_RANK
    ]
    if not states:
        return "stale"
    return cast(
        JangarStageState, max(states, key=lambda state: _STAGE_STATE_RANK[state])
    )


def _hypothesis_summary(hypothesis_payload: Mapping[str, Any]) -> Mapping[str, Any]:
    summary = hypothesis_payload.get("summary")
    return (
        cast(Mapping[str, Any], summary)
        if isinstance(summary, Mapping)
        else hypothesis_payload
    )


def _hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        item
        for item in (
            _mapping(raw) for raw in _sequence(hypothesis_payload.get("items"))
        )
        if item
    ]


def _slippage_guardrail(hypothesis_payload: Mapping[str, Any]) -> Decimal | None:
    guardrails: list[Decimal] = []
    for item in _hypothesis_items(hypothesis_payload):
        contract = _mapping(item.get("promotion_contract"))
        value = _decimal(contract.get("max_avg_abs_slippage_bps"))
        if value is not None:
            guardrails.append(value)
    return min(guardrails) if guardrails else None


def _market_health_state(market_context_status: Mapping[str, Any]) -> str | None:
    health = _mapping(market_context_status.get("health"))
    if not health:
        return "unknown" if market_context_status.get("health_error") else None
    if health.get("ok") is False:
        return "down"
    state = (
        _text(health.get("overallState"))
        or _text(health.get("overall_state"))
        or _text(health.get("status"))
        or _text(health.get("state"))
    )
    return state.lower().replace("-", "_") if state else None


def _local_market_context_state(market_context_status: Mapping[str, Any]) -> str:
    if bool(market_context_status.get("alert_active")):
        reason = (_text(market_context_status.get("alert_reason")) or "").lower()
        return "stale" if "stale" in reason else "degraded"
    if market_context_status.get("last_freshness_seconds") is None:
        return "unknown"
    return "current"


def _market_context_contradictions(
    *,
    market_context_status: Mapping[str, Any],
    generated_at: datetime,
) -> list[dict[str, object]]:
    jangar_state = _market_health_state(market_context_status)
    local_state = _local_market_context_state(market_context_status)
    if jangar_state not in _DEGRADED_MARKET_STATES:
        return []
    if local_state in _DEGRADED_MARKET_STATES and local_state != "unknown":
        return []
    contradiction_id = f"mcx-{_stable_hash('market-context-contradiction', {'jangar': jangar_state, 'local': local_state})}"
    return [
        {
            "contradiction_id": contradiction_id,
            "type": "market_context_health_mismatch",
            "generated_at": generated_at.isoformat(),
            "jangar_state": jangar_state,
            "torghut_local_state": local_state,
            "reason": "jangar_market_context_down_local_missing_or_permissive",
            "capital_effect": "paper_live_hold",
        }
    ]


def _tca_blocker(
    *,
    tca_summary: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
    tca_max_age_seconds: int,
) -> tuple[str | None, dict[str, object]]:
    last_computed_at = _parse_timestamp(tca_summary.get("last_computed_at"))
    age_seconds = (
        max(0, int((generated_at - last_computed_at).total_seconds()))
        if last_computed_at is not None
        else None
    )
    order_count = _int(tca_summary.get("order_count"))
    avg_abs_slippage_bps = _decimal(tca_summary.get("avg_abs_slippage_bps"))
    guardrail = _slippage_guardrail(hypothesis_payload)
    reason: str | None = None
    if order_count <= 0:
        reason = "execution_tca_missing"
    elif age_seconds is None or age_seconds > max(0, tca_max_age_seconds):
        reason = "execution_tca_stale"
    elif (
        avg_abs_slippage_bps is not None
        and guardrail is not None
        and avg_abs_slippage_bps > guardrail
    ):
        reason = "execution_tca_slippage_guardrail_exceeded"
    return reason, {
        "order_count": order_count,
        "last_computed_at": _text(tca_summary.get("last_computed_at")),
        "age_seconds": age_seconds,
        "max_age_seconds": max(0, tca_max_age_seconds),
        "avg_abs_slippage_bps": str(avg_abs_slippage_bps)
        if avg_abs_slippage_bps is not None
        else None,
        "slippage_guardrail_bps": str(guardrail) if guardrail is not None else None,
    }


def _add_repair(
    repairs: list[dict[str, object]],
    *,
    code: str,
    dimension: str,
    action: str,
    reason: str,
    priority: int,
    expected_unblock_value: int,
    source_ref: Mapping[str, object] | None = None,
) -> None:
    repairs.append(
        {
            "repair_bid_ref": f"rbid-{_stable_hash('renewal-bond-repair', {'code': code, 'reason': reason})}",
            "code": code,
            "dimension": dimension,
            "action": action,
            "reason": reason,
            "priority": priority,
            "expected_unblock_value": expected_unblock_value,
            "source_ref": dict(source_ref or {}),
            "max_notional": "0",
        }
    )


def _proof_floor_repairs(proof_floor: Mapping[str, Any]) -> list[dict[str, object]]:
    repairs: list[dict[str, object]] = []
    for raw_item in _sequence(proof_floor.get("repair_ladder")):
        item = _mapping(raw_item)
        code = _text(item.get("code"))
        reason = _text(item.get("reason")) or code
        if code is None or reason is None:
            continue
        _add_repair(
            repairs,
            code=code,
            dimension=_text(item.get("dimension"), "proof_floor") or "proof_floor",
            action=_text(item.get("action"), "repair_profitability_proof_floor")
            or "repair_profitability_proof_floor",
            reason=reason,
            priority=_int(item.get("priority"), 40),
            expected_unblock_value=_int(item.get("expected_unblock_value"), 1),
            source_ref={"source": "profitability_proof_floor"},
        )
    return repairs


def _empirical_proof_refs(
    empirical_jobs_status: Mapping[str, Any],
) -> list[dict[str, object]]:
    refs: list[dict[str, object]] = []
    candidate_ids = _string_list(empirical_jobs_status.get("candidate_ids"))
    dataset_refs = _string_list(empirical_jobs_status.get("dataset_snapshot_refs"))
    if not candidate_ids:
        candidate_ids = [
            _text(empirical_jobs_status.get("candidate_id"), "empirical-proof")
            or "empirical-proof"
        ]
    if not dataset_refs:
        dataset_refs = _string_list(empirical_jobs_status.get("dataset_refs"))
    for candidate_id in candidate_ids:
        refs.append(
            {
                "proof_ref": f"emp-{_stable_hash('empirical-proof-ref', {'candidate_id': candidate_id, 'datasets': dataset_refs})}",
                "candidate_id": candidate_id,
                "dataset_snapshot_refs": dataset_refs,
                "last_completed_at": _text(
                    empirical_jobs_status.get("last_completed_at")
                    or empirical_jobs_status.get("as_of")
                ),
                "fresh_until": _text(empirical_jobs_status.get("fresh_until")),
                "ready": bool(empirical_jobs_status.get("ready")),
            }
        )
    return refs


def _evidence_carry_accounts(
    *,
    empirical_jobs_status: Mapping[str, Any],
    blockers: Sequence[str],
    repairs: Sequence[Mapping[str, object]],
    generated_at: datetime,
    proof_half_life_seconds: int,
) -> list[dict[str, object]]:
    if not bool(empirical_jobs_status.get("ready")):
        return []
    proof_refs = _empirical_proof_refs(empirical_jobs_status)
    if not proof_refs or not blockers:
        return []
    completed_at = _parse_timestamp(
        empirical_jobs_status.get("last_completed_at")
        or empirical_jobs_status.get("as_of")
    )
    proof_age_seconds = (
        max(0, int((generated_at - completed_at).total_seconds()))
        if completed_at
        else None
    )
    half_life = max(1, proof_half_life_seconds)
    if proof_age_seconds is None:
        decay_risk = "unknown"
        carry_bonus = 5
    elif proof_age_seconds <= half_life:
        decay_risk = "low"
        carry_bonus = 20
    elif proof_age_seconds <= half_life * 2:
        decay_risk = "medium"
        carry_bonus = 10
    else:
        decay_risk = "high"
        carry_bonus = 5
    selected_repair_bid_ref = (
        _text(repairs[0].get("repair_bid_ref")) if repairs else None
    )
    accounts: list[dict[str, object]] = []
    for ref in proof_refs:
        carry_id = f"ecarry-{_stable_hash('evidence-carry', {'proof_ref': ref['proof_ref'], 'blockers': blockers})}"
        accounts.append(
            {
                "carry_id": carry_id,
                "proof_ref": ref["proof_ref"],
                "candidate_id": ref["candidate_id"],
                "hypothesis_id": ref["candidate_id"],
                "proof_age_seconds": proof_age_seconds,
                "proof_half_life_seconds": half_life,
                "blocked_by": sorted(set(blockers)),
                "expected_unblock_value": carry_bonus,
                "decay_risk": decay_risk,
                "selected_repair_bid_ref": selected_repair_bid_ref,
                "max_notional": "0",
            }
        )
    return accounts


def _sort_repairs(
    repairs: Sequence[Mapping[str, object]], evidence_carry_bonus: int
) -> list[dict[str, object]]:
    adjusted: list[dict[str, object]] = []
    for repair in repairs:
        item = dict(repair)
        if item.get("dimension") in {
            "execution_tca",
            "market_context",
            "jangar_stage_trust",
            "quant_ingestion",
        }:
            item["expected_unblock_value"] = (
                _int(item.get("expected_unblock_value")) + evidence_carry_bonus
            )
        adjusted.append(item)
    return sorted(
        adjusted,
        key=lambda item: (
            -_int(item.get("expected_unblock_value")),
            -_int(item.get("priority")),
            str(item.get("code") or ""),
        ),
    )


def build_renewal_bond_profit_escrow(
    *,
    account_label: str | None,
    torghut_revision: str | None,
    trading_mode: str,
    market_session_open: bool | None,
    jangar_dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    now: datetime | None = None,
    tca_max_age_seconds: int = 86400,
    quant_ingestion_max_lag_seconds: int = 1800,
    proof_half_life_seconds: int = 7200,
) -> dict[str, object]:
    """Build a shadow-first escrow receipt for doc 137 capital reentry gates."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    stage_records = _stage_records_from_quorum(jangar_dependency_quorum)
    stage_state = _stage_coherence_state(stage_records)
    summary = _hypothesis_summary(hypothesis_payload)
    repairs = _proof_floor_repairs(proof_floor)
    blockers: list[str] = []

    if stage_state in _BLOCKING_STAGE_STATES:
        blockers.append(f"jangar_stage_{stage_state}")
        _add_repair(
            repairs,
            code="settle_jangar_stage_renewal",
            dimension="jangar_stage_trust",
            action="wait_for_terminal_stage_success_or_escalate_stale_renewal",
            reason=f"jangar_stage_{stage_state}",
            priority=90,
            expected_unblock_value=90 if stage_state == "renewing" else 75,
            source_ref={"stage_state": stage_state, "stage_records": stage_records},
        )

    if not bool(live_submission_gate.get("allowed")) and trading_mode == "live":
        reason = (
            _text(live_submission_gate.get("reason"), "live_submission_gate_closed")
            or "live_submission_gate_closed"
        )
        blockers.append(reason)

    proof_floor_blockers = _string_list(proof_floor.get("blocking_reasons"))
    blockers.extend(proof_floor_blockers)
    if _text(proof_floor.get("capital_state")) == "zero_notional":
        blockers.append("profitability_proof_floor_zero_notional")

    if _int(summary.get("promotion_eligible_total")) <= 0:
        blockers.append("hypothesis_not_promotion_eligible")
        _add_repair(
            repairs,
            code="repair_alpha_readiness",
            dimension="alpha_readiness",
            action="clear_hypothesis_blockers_before_capital_reentry",
            reason="hypothesis_not_promotion_eligible",
            priority=70,
            expected_unblock_value=45,
            source_ref={"summary": dict(summary)},
        )

    if not bool(empirical_jobs_status.get("ready")):
        reason = (
            _text(empirical_jobs_status.get("status"), "empirical_jobs_not_ready")
            or "empirical_jobs_not_ready"
        )
        blockers.append("empirical_jobs_not_ready")
        _add_repair(
            repairs,
            code="refresh_empirical_proof",
            dimension="empirical",
            action="refresh_empirical_job_receipts",
            reason=reason,
            priority=55,
            expected_unblock_value=35,
            source_ref={"status": reason},
        )

    quant_lag_seconds = _int(quant_evidence.get("max_stage_lag_seconds"), -1)
    if not bool(quant_evidence.get("ok")):
        reason = (
            _text(quant_evidence.get("reason"), "quant_evidence_degraded")
            or "quant_evidence_degraded"
        )
        blockers.append(reason)
        _add_repair(
            repairs,
            code="repair_quant_ingestion",
            dimension="quant_ingestion",
            action="settle_quant_pipeline_stage_lag",
            reason=reason,
            priority=65,
            expected_unblock_value=55,
            source_ref={"quant_evidence": dict(quant_evidence)},
        )
    elif quant_lag_seconds > max(0, quant_ingestion_max_lag_seconds):
        blockers.append("quant_ingestion_lag_exceeded")
        _add_repair(
            repairs,
            code="repair_quant_ingestion",
            dimension="quant_ingestion",
            action="settle_quant_pipeline_stage_lag",
            reason="quant_ingestion_lag_exceeded",
            priority=65,
            expected_unblock_value=55,
            source_ref={
                "max_stage_lag_seconds": quant_lag_seconds,
                "threshold_seconds": max(0, quant_ingestion_max_lag_seconds),
            },
        )

    market_contradictions = _market_context_contradictions(
        market_context_status=market_context_status,
        generated_at=generated_at,
    )
    if market_contradictions:
        blockers.append("market_context_contradiction")
        _add_repair(
            repairs,
            code="reconcile_market_context_contradiction",
            dimension="market_context",
            action="require_matching_current_jangar_and_torghut_market_context_receipts",
            reason="market_context_contradiction",
            priority=75,
            expected_unblock_value=65,
            source_ref={"contradiction_refs": market_contradictions},
        )
    elif _local_market_context_state(market_context_status) == "unknown":
        blockers.append("market_context_unknown")
        _add_repair(
            repairs,
            code="refresh_market_context",
            dimension="market_context",
            action="refresh_market_context_domains",
            reason="market_context_unknown",
            priority=60,
            expected_unblock_value=40,
            source_ref={"market_context_status": dict(market_context_status)},
        )

    tca_reason, tca_ref = _tca_blocker(
        tca_summary=tca_summary,
        hypothesis_payload=hypothesis_payload,
        generated_at=generated_at,
        tca_max_age_seconds=tca_max_age_seconds,
    )
    if tca_reason is not None:
        blockers.append(tca_reason)
        _add_repair(
            repairs,
            code="refresh_execution_tca_settlement",
            dimension="execution_tca",
            action="refresh_execution_tca_settlement",
            reason=tca_reason,
            priority=85,
            expected_unblock_value=80,
            source_ref=tca_ref,
        )

    compact_blockers = sorted(set(blockers))
    pre_sorted_repairs = sorted(
        repairs,
        key=lambda item: (
            -_int(item.get("expected_unblock_value")),
            -_int(item.get("priority")),
            str(item.get("code") or ""),
        ),
    )
    carry_accounts = _evidence_carry_accounts(
        empirical_jobs_status=empirical_jobs_status,
        blockers=compact_blockers,
        repairs=pre_sorted_repairs,
        generated_at=generated_at,
        proof_half_life_seconds=proof_half_life_seconds,
    )
    carry_bonus = max(
        (_int(account.get("expected_unblock_value")) for account in carry_accounts),
        default=0,
    )
    ordered_repairs = _sort_repairs(repairs, carry_bonus)
    if carry_accounts and ordered_repairs:
        for account in carry_accounts:
            account["selected_repair_bid_ref"] = ordered_repairs[0].get(
                "repair_bid_ref"
            )

    hard_blocked = bool(compact_blockers)
    capital_state = "zero_notional" if hard_blocked else "shadow"
    escrow_verdict = "repair_only" if hard_blocked else "observe_only"
    active_renewal_bond_refs = sorted(
        {
            ref
            for record in stage_records
            for ref in _string_list(record.get("active_renewal_bond_refs"))
        }
    )
    receipt_id = f"rbpe-{_stable_hash('renewal-bond-profit-escrow', {'account': account_label, 'revision': torghut_revision, 'stage_state': stage_state, 'blockers': compact_blockers, 'tca': tca_ref.get('last_computed_at')})}"
    fresh_until = (
        None if hard_blocked else (generated_at + timedelta(minutes=15)).isoformat()
    )

    return {
        "schema_version": RENEWAL_BOND_PROFIT_ESCROW_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "generated_at": generated_at.isoformat(),
        "account_label": account_label,
        "torghut_revision": torghut_revision,
        "market_window": {
            "session_open": market_session_open,
            "trading_mode": trading_mode,
        },
        "jangar_stage_trust_ref": {
            "state": stage_state,
            "required_stages": _string_list(
                _mapping(jangar_dependency_quorum.get("stage_trust")).get(
                    "required_stages"
                )
            ),
            "active_renewal_bond_refs": active_renewal_bond_refs,
            "controller_ingestion_settlement": _mapping(
                jangar_dependency_quorum.get("controller_ingestion_settlement")
            ),
            "dependency_quorum": {
                "decision": jangar_dependency_quorum.get("decision"),
                "reasons": _string_list(jangar_dependency_quorum.get("reasons")),
                "message": jangar_dependency_quorum.get("message"),
            },
            "stage_records": stage_records,
        },
        "proof_floor_ref": {
            "schema_version": proof_floor.get("schema_version"),
            "route_state": proof_floor.get("route_state"),
            "capital_state": proof_floor.get("capital_state"),
            "blocking_reasons": proof_floor_blockers,
        },
        "empirical_proof_refs": _empirical_proof_refs(empirical_jobs_status),
        "market_context_refs": {
            "local_state": _local_market_context_state(market_context_status),
            "jangar_health_state": _market_health_state(market_context_status),
            "last_freshness_seconds": market_context_status.get(
                "last_freshness_seconds"
            ),
            "last_domain_states": market_context_status.get("last_domain_states") or {},
        },
        "quant_ingestion_ref": {
            "status": quant_evidence.get("status"),
            "ok": bool(quant_evidence.get("ok")),
            "reason": quant_evidence.get("reason"),
            "max_stage_lag_seconds": quant_evidence.get("max_stage_lag_seconds"),
            "threshold_seconds": max(0, quant_ingestion_max_lag_seconds),
        },
        "tca_ref": tca_ref,
        "escrow_verdict": escrow_verdict,
        "capital_state": capital_state,
        "capital_reentry_eligible": not hard_blocked,
        "max_notional": "0",
        "blocking_reason_codes": compact_blockers,
        "evidence_carry_accounts": carry_accounts,
        "selected_zero_notional_repairs": ordered_repairs,
        "contradiction_refs": market_contradictions,
        "fresh_until": fresh_until,
        "rollback_target": {
            "capital_state": "zero_notional",
            "max_notional": "0",
            "live_submit_enabled": False,
        },
    }


__all__ = [
    "RENEWAL_BOND_PROFIT_ESCROW_SCHEMA_VERSION",
    "build_renewal_bond_profit_escrow",
]
