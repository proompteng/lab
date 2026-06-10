"""Alpha evidence foundry receipts for capital-safe routeable-candidate repair."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from .read_model_utils import (
    as_int as _int,
    as_mapping as _mapping,
    as_sequence as _sequence,
    as_text as _text,
    first_mapping as _top_queue_item,
    is_alpha_readiness_repair as _is_alpha_repair,
    routeable_candidate_count as _routeable_candidate_count,
    stable_hash24 as _stable_hash,
    unique_text_list as _string_list,
    zero_notional_or_stale_evidence_rate as _zero_notional_or_stale_evidence_rate,
)

ALPHA_EVIDENCE_FOUNDRY_SCHEMA_VERSION = "torghut.alpha-evidence-foundry.v1"
ALPHA_EVIDENCE_FOUNDRY_REF_SCHEMA_VERSION = "torghut.alpha-evidence-foundry-ref.v1"
ALPHA_EVIDENCE_WINDOW_RECEIPT_SCHEMA_VERSION = (
    "torghut.alpha-evidence-window-receipt.v1"
)

_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md"
)
_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_ROLLBACK_TARGET = (
    "stop emitting alpha_evidence_foundry and keep Torghut max_notional=0"
)
_NO_DELTA_RELEASE_CONDITIONS = [
    "source_ref_changes",
    "evidence_window_changes",
    "blocker_set_changes",
    "required_receipt_changes",
]
_ZERO_NOTIONAL_VALUES = {"0", "0.0", "0.00", "0.0000"}
_FEATURE_BLOCKERS = {"feature_rows_missing", "required_feature_set_unavailable"}
_DRIFT_BLOCKERS = {"drift_checks_missing"}
_POST_COST_BLOCKERS = {"post_cost_expectancy_non_positive"}
_REJECTION_DRAG_BLOCKERS = {"rejection_drag_unmeasured"}
_MARKET_CONTEXT_BLOCKERS = {
    "closed_session_market_context_hold",
    "market_context_evidence_missing",
    "market_context_stale",
    "market_context_state_unknown",
}
_TCA_BLOCKERS = {
    "closed_session_tca_evidence_hold",
    "execution_tca_above_guardrail",
    "execution_tca_stale",
    "execution_tca_symbol_missing",
    "active_session_execution_samples_stale",
    "execution_tca_expected_shortfall_samples_missing_non_promoting",
}


def _source_ref(
    *,
    executable_alpha_repair_receipts: Mapping[str, Any],
    generated: datetime,
    top_item: Mapping[str, Any],
) -> str:
    explicit_ref = _text(
        executable_alpha_repair_receipts.get("source_revenue_repair_ref")
    )
    if explicit_ref:
        return explicit_ref
    return "torghut-revenue-repair-digest:" + _stable_hash(
        "torghut-revenue-repair-digest",
        {
            "generated_at": generated.isoformat(),
            "queue_code": _text(top_item.get("code")),
            "reason": _text(top_item.get("reason")),
        },
    )


def _source_commit(source_serving_metadata: Mapping[str, Any]) -> str:
    build = _mapping(source_serving_metadata.get("build"))
    source_serving = _mapping(
        source_serving_metadata.get("source_serving_repair_receipt_ledger")
    )
    route_packet = _mapping(
        source_serving_metadata.get("route_evidence_clearinghouse_packet")
    )
    return (
        _text(source_serving.get("source_commit"))
        or _text(route_packet.get("source_commit"))
        or _text(build.get("commit"))
        or "unknown"
    )


def _active_revision(source_serving_metadata: Mapping[str, Any]) -> str:
    build = _mapping(source_serving_metadata.get("build"))
    source_serving = _mapping(
        source_serving_metadata.get("source_serving_repair_receipt_ledger")
    )
    route_packet = _mapping(
        source_serving_metadata.get("route_evidence_clearinghouse_packet")
    )
    return (
        _text(source_serving.get("active_revision"))
        or _text(route_packet.get("torghut_revision"))
        or _text(build.get("active_revision"))
        or "unknown"
    )


def _receipt_reason_codes(receipt: Mapping[str, Any]) -> list[str]:
    reason_codes = _string_list(receipt.get("reason_codes"))
    settlement = _mapping(receipt.get("settlement"))
    if not reason_codes:
        reason_codes = _string_list(settlement.get("before_reason_codes"))
    return reason_codes


def _all_repair_receipts(
    executable_alpha_repair_receipts: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    receipts: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for raw_receipt in _sequence(executable_alpha_repair_receipts.get("receipts")):
        receipt = _mapping(raw_receipt)
        if not receipt:
            continue
        receipt_key = _text(receipt.get("receipt_id")) or _text(
            receipt.get("hypothesis_id")
        )
        if receipt_key and receipt_key in seen:
            continue
        if receipt_key:
            seen.add(receipt_key)
        receipts.append(receipt)
    return receipts


def _targets_by_hypothesis(evidence: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    alpha_readiness = _mapping(evidence.get("alpha_readiness"))
    targets: dict[str, Mapping[str, Any]] = {}
    for raw_target in _sequence(alpha_readiness.get("repair_targets")):
        target = _mapping(raw_target)
        hypothesis_id = _text(target.get("hypothesis_id"))
        if hypothesis_id and hypothesis_id not in targets:
            targets[hypothesis_id] = target
    return targets


def _coverage_state(reason_codes: set[str]) -> str:
    if reason_codes.intersection(_FEATURE_BLOCKERS):
        return "missing"
    return "current"


def _drift_state(reason_codes: set[str]) -> str:
    if reason_codes.intersection(_DRIFT_BLOCKERS):
        return "missing"
    return "current"


def _post_cost_state(reason_codes: set[str]) -> str:
    if reason_codes.intersection(_POST_COST_BLOCKERS):
        return "blocked"
    return "current"


def _rejection_drag_state(reason_codes: set[str]) -> str:
    if reason_codes.intersection(_REJECTION_DRAG_BLOCKERS):
        return "unmeasured"
    return "measured"


def _market_context_state(reason_codes: set[str]) -> str:
    if reason_codes.intersection(_MARKET_CONTEXT_BLOCKERS):
        return "hold"
    return "current"


def _tca_state(reason_codes: set[str], evidence: Mapping[str, Any]) -> str:
    if reason_codes.intersection(_TCA_BLOCKERS):
        return "hold"
    execution_tca = _mapping(evidence.get("execution_tca"))
    return _text(execution_tca.get("state"), "unknown")


def _route_universe_state(evidence: Mapping[str, Any]) -> str:
    route_reacquisition = _mapping(evidence.get("route_reacquisition"))
    routeable_count = _int(route_reacquisition.get("routeable_symbol_count"))
    probing_count = _int(route_reacquisition.get("probing_symbol_count"))
    repair_count = _int(route_reacquisition.get("repair_candidate_count"))
    if routeable_count > 0:
        return "routeable"
    if probing_count > 0:
        return "probing"
    if repair_count > 0:
        return "repair_only"
    return _text(route_reacquisition.get("state"), "unknown")


def _expected_delta(reason_codes: set[str]) -> int:
    if not reason_codes:
        return 0
    return 1


def _receipt_ladder_state(
    *,
    reason_codes: Sequence[str],
    receipt: Mapping[str, Any],
    target: Mapping[str, Any],
) -> str:
    if bool(target.get("promotion_eligible")):
        return "promotion_candidate"
    if not reason_codes and _text(receipt.get("evidence_window_status")) == "current":
        return "evidence_window_current"
    return "blocked_evidence"


def _build_window_receipt(
    *,
    generated: datetime,
    fresh_until: datetime,
    source_revenue_repair_ref: str,
    source_commit: str,
    receipt: Mapping[str, Any],
    target: Mapping[str, Any],
    top_item: Mapping[str, Any],
    evidence: Mapping[str, Any],
    capital: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_id = _text(receipt.get("hypothesis_id"), "unknown")
    reason_codes = _receipt_reason_codes(receipt)
    reason_set = set(reason_codes)
    measured_delta = _int(receipt.get("measured_delta"))
    routeable_before = _routeable_candidate_count(evidence)
    if routeable_before <= 0:
        measured_delta = min(measured_delta, 0)
    dedupe_key = _stable_hash(
        "alpha-evidence-window-dedupe",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "source_commit": source_commit,
            "hypothesis_id": hypothesis_id,
            "reason_codes": reason_codes,
            "required_output_receipts": _string_list(
                receipt.get("required_output_receipts")
            ),
        },
    )
    payload_for_id = {
        "schema_version": ALPHA_EVIDENCE_WINDOW_RECEIPT_SCHEMA_VERSION,
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "hypothesis_id": hypothesis_id,
        "dedupe_key": dedupe_key,
    }
    no_delta_reason = (
        "routeable_candidate_count_unchanged" if measured_delta <= 0 else ""
    )
    return {
        **payload_for_id,
        "receipt_id": "alpha-evidence-window-receipt:"
        + _stable_hash("alpha-evidence-window-receipt", payload_for_id),
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "account_id": receipt.get("account_id"),
        "window": receipt.get("window"),
        "trading_mode": receipt.get("trading_mode"),
        "candidate_id": receipt.get("candidate_id"),
        "strategy_id": receipt.get("strategy_id"),
        "lane_id": target.get("lane_id"),
        "strategy_family": target.get("strategy_family"),
        "ladder_state": _receipt_ladder_state(
            reason_codes=reason_codes,
            receipt=receipt,
            target=target,
        ),
        "target_value_gate": _text(
            top_item.get("value_gate"), "routeable_candidate_count"
        ),
        "before_reason_codes": reason_codes,
        "retired_reason_codes": [],
        "preserved_reason_codes": reason_codes,
        "new_reason_codes": [],
        "before_refs": _string_list(receipt.get("required_input_refs")),
        "after_refs": [],
        "required_after_receipts": _string_list(
            receipt.get("required_output_receipts")
        ),
        "feature_coverage_state": _coverage_state(reason_set),
        "drift_check_state": _drift_state(reason_set),
        "post_cost_expectancy_state": _post_cost_state(reason_set),
        "post_cost_daily_net_pnl_estimate": receipt.get(
            "post_cost_daily_net_pnl_estimate"
        ),
        "rejection_drag_state": _rejection_drag_state(reason_set),
        "market_context_state": _market_context_state(reason_set),
        "tca_state": _tca_state(reason_set, evidence),
        "route_universe_state": _route_universe_state(evidence),
        "expected_routeable_candidate_delta": _expected_delta(reason_set),
        "measured_routeable_candidate_delta": measured_delta,
        "no_delta_reason": no_delta_reason,
        "dedupe_key": dedupe_key,
        "max_notional": _text(
            receipt.get("max_notional"), _text(capital.get("max_notional"), "0")
        ),
        "capital_rule": _text(receipt.get("capital_rule"), "zero_notional_repair_only"),
        "validation_commands": _string_list(receipt.get("validation_commands")),
        "rollback_target": _text(receipt.get("rollback_target"), _ROLLBACK_TARGET),
    }


def _no_delta_debt(
    window_receipts: Sequence[Mapping[str, Any]],
) -> list[dict[str, object]]:
    debts: list[dict[str, object]] = []
    for receipt in window_receipts:
        if _int(receipt.get("measured_routeable_candidate_delta")) > 0:
            continue
        debt_id = "alpha-evidence-no-delta:" + _stable_hash(
            "alpha-evidence-no-delta",
            {
                "receipt_id": _text(receipt.get("receipt_id")),
                "dedupe_key": _text(receipt.get("dedupe_key")),
                "hypothesis_id": _text(receipt.get("hypothesis_id")),
            },
        )
        debts.append(
            {
                "debt_id": debt_id,
                "receipt_id": receipt.get("receipt_id"),
                "dedupe_key": receipt.get("dedupe_key"),
                "hypothesis_id": receipt.get("hypothesis_id"),
                "value_gate": receipt.get("target_value_gate"),
                "preserved_reason_codes": _string_list(
                    receipt.get("preserved_reason_codes")
                ),
                "measured_routeable_candidate_delta": receipt.get(
                    "measured_routeable_candidate_delta"
                ),
                "no_delta_reason": receipt.get("no_delta_reason"),
                "release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
            }
        )
    return debts


def build_alpha_evidence_foundry(
    *,
    generated_at: datetime,
    business_state: str,
    revenue_ready: bool,
    repair_queue: Sequence[Mapping[str, Any]],
    capital: Mapping[str, Any],
    evidence: Mapping[str, Any],
    executable_alpha_repair_receipts: Mapping[str, Any],
    source_serving_metadata: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Build hypothesis-scoped alpha evidence-window receipts for the top repair lane."""

    if generated_at.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated_at.astimezone(timezone.utc)
    fresh_until = generated + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)
    top_item = _top_queue_item(repair_queue)
    source_metadata = source_serving_metadata or {}
    source_commit = _source_commit(source_metadata)
    source_revenue_repair_ref = _source_ref(
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        generated=generated,
        top_item=top_item,
    )
    max_notional = _text(capital.get("max_notional"), "0")

    reason_codes: list[str] = []
    if revenue_ready:
        reason_codes.append("revenue_already_ready")
    if business_state != "repair_only":
        reason_codes.append(f"business_state_{business_state or 'unknown'}")
    if not _is_alpha_repair(top_item):
        reason_codes.append("revenue_repair_top_item_not_alpha_readiness")
    if max_notional not in _ZERO_NOTIONAL_VALUES:
        reason_codes.append("capital_notional_nonzero")

    targets = _targets_by_hypothesis(evidence)
    window_receipts: list[dict[str, object]] = []
    if not reason_codes:
        for repair_receipt in _all_repair_receipts(executable_alpha_repair_receipts):
            hypothesis_id = _text(repair_receipt.get("hypothesis_id"))
            window_receipts.append(
                _build_window_receipt(
                    generated=generated,
                    fresh_until=fresh_until,
                    source_revenue_repair_ref=source_revenue_repair_ref,
                    source_commit=source_commit,
                    receipt=repair_receipt,
                    target=targets.get(hypothesis_id, {}),
                    top_item=top_item,
                    evidence=evidence,
                    capital=capital,
                )
            )
        if not window_receipts:
            reason_codes.append("alpha_evidence_window_receipts_missing")

    if any(reason.endswith("_nonzero") for reason in reason_codes):
        status = "blocked"
    elif "revenue_repair_top_item_not_alpha_readiness" in reason_codes:
        status = "inactive"
    elif window_receipts:
        status = "selected"
    else:
        status = "held"

    foundry_id = "alpha-evidence-foundry:" + _stable_hash(
        "alpha-evidence-foundry",
        {
            "source_revenue_repair_ref": source_revenue_repair_ref,
            "source_commit": source_commit,
            "queue_code": _text(top_item.get("code")),
            "receipt_ids": [
                _text(receipt.get("receipt_id")) for receipt in window_receipts
            ],
        },
    )
    return {
        "schema_version": ALPHA_EVIDENCE_FOUNDRY_SCHEMA_VERSION,
        "foundry_id": foundry_id,
        "generated_at": generated.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "governing_design_ref": _DESIGN_REF,
        "status": status,
        "reason_codes": reason_codes,
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "source_commit": source_commit,
        "active_revision": _active_revision(source_metadata),
        "selected_queue_code": _text(top_item.get("code")),
        "selected_value_gate": _text(
            top_item.get("value_gate"), "routeable_candidate_count"
        ),
        "routeable_candidate_count_before": _routeable_candidate_count(evidence),
        "zero_notional_or_stale_evidence_rate_before": _zero_notional_or_stale_evidence_rate(
            evidence
        ),
        "tca_quality_ref": {
            "state": _mapping(evidence.get("execution_tca")).get("state"),
            "reason": _mapping(evidence.get("execution_tca")).get("reason"),
        },
        "routeability_ref": _mapping(evidence.get("routeability_acceptance")).get(
            "ledger_id"
        ),
        "repair_bid_settlement_ref": _mapping(
            evidence.get("repair_bid_settlement")
        ).get("ledger_id"),
        "capital_state": _text(capital.get("capital_state"), "zero_notional"),
        "max_notional": max_notional,
        "capital_rule": _text(
            top_item.get("capital_rule"), "zero_notional_repair_only"
        ),
        "required_output_receipt": ALPHA_EVIDENCE_WINDOW_RECEIPT_SCHEMA_VERSION,
        "receipt_count": len(window_receipts),
        "receipts": window_receipts,
        "no_delta_debt": _no_delta_debt(window_receipts),
        "next_implementation_milestone": (
            "settle alpha evidence-window receipts before any paper or live capital release"
        ),
        "rollback_target": _ROLLBACK_TARGET,
    }


def compact_alpha_evidence_foundry(
    foundry: Mapping[str, Any] | None,
) -> dict[str, object]:
    """Return the compact alpha evidence foundry reference (standalone internal)."""

    payload = _mapping(foundry)
    if not payload:
        return {
            "schema_version": ALPHA_EVIDENCE_FOUNDRY_REF_SCHEMA_VERSION,
            "status": "missing",
            "reason_codes": ["alpha_evidence_foundry_missing"],
        }
    receipts = [_mapping(item) for item in _sequence(payload.get("receipts"))]
    no_delta_debt = _sequence(payload.get("no_delta_debt"))
    empty_receipt: Mapping[str, Any] = {}
    selected_receipt = receipts[0] if receipts else empty_receipt
    return {
        "schema_version": ALPHA_EVIDENCE_FOUNDRY_REF_SCHEMA_VERSION,
        "foundry_schema_version": payload.get("schema_version"),
        "foundry_id": payload.get("foundry_id"),
        "generated_at": payload.get("generated_at"),
        "fresh_until": payload.get("fresh_until"),
        "status": payload.get("status"),
        "reason_codes": _string_list(payload.get("reason_codes")),
        "selected_queue_code": payload.get("selected_queue_code"),
        "selected_value_gate": payload.get("selected_value_gate"),
        "required_output_receipt": payload.get("required_output_receipt"),
        "receipt_count": payload.get("receipt_count"),
        "selected_receipt_id": selected_receipt.get("receipt_id"),
        "selected_hypothesis_id": selected_receipt.get("hypothesis_id"),
        "hypothesis_ids": [
            _text(receipt.get("hypothesis_id"))
            for receipt in receipts
            if _text(receipt.get("hypothesis_id"))
        ],
        "no_delta_debt_count": len(no_delta_debt),
        "routeable_candidate_count_before": payload.get(
            "routeable_candidate_count_before"
        ),
        "max_notional": payload.get("max_notional"),
        "capital_state": payload.get("capital_state"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


__all__ = [
    "ALPHA_EVIDENCE_FOUNDRY_REF_SCHEMA_VERSION",
    "ALPHA_EVIDENCE_FOUNDRY_SCHEMA_VERSION",
    "ALPHA_EVIDENCE_WINDOW_RECEIPT_SCHEMA_VERSION",
    "build_alpha_evidence_foundry",
    "compact_alpha_evidence_foundry",
]
