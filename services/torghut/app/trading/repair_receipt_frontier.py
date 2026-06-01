"""Repair receipt frontier projection for Torghut profit cutover."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast


REPAIR_RECEIPT_FRONTIER_SCHEMA_VERSION = "torghut.repair-receipt-frontier.v1"

_FRESHNESS_SECONDS = 60
_DEFAULT_MAX_RUNTIME_SECONDS = 20 * 60
_ZERO_NOTIONAL = "0"
_SOURCE_CURRENT_STATES = {"converged", "current", "healthy", "ok", "ready"}
_DOC_REF = (
    "docs/torghut/design-system/v6/"
    "192-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md"
)
_VALUE_GATES = [
    "post_cost_daily_net_pnl",
    "routeable_candidate_count",
    "zero_notional_or_stale_evidence_rate",
    "fill_tca_or_slippage_quality",
    "capital_gate_safety",
]
_VALUE_GATE_SORT_RANK = {
    "post_cost_daily_net_pnl": 0,
    "routeable_candidate_count": 1,
    "fill_tca_or_slippage_quality": 2,
    "zero_notional_or_stale_evidence_rate": 3,
    "capital_gate_safety": 4,
}
_LOT_CLASS_MAP = {
    "quant_pipeline": "signal_ingestion",
    "execution_tca": "execution_tca",
    "rollout_image": "source_serving",
    "empirical_replay": "empirical_proof",
    "promotion_custody": "research_candidate",
    "feature_lineage": "feature_rows",
}
_DIMENSION_LOT_CLASS = {
    "signal_ingestion": "signal_ingestion",
    "market_context": "market_context",
    "empirical_proof": "empirical_proof",
    "feature_coverage": "feature_rows",
    "drift_checks": "feature_rows",
    "tca_fill_quality": "execution_tca",
    "route_readiness": "research_candidate",
    "schema_migration_state": "source_serving",
    "jangar_settlement": "source_serving",
}
_DIMENSION_VALUE_GATE = {
    "signal_ingestion": "zero_notional_or_stale_evidence_rate",
    "market_context": "zero_notional_or_stale_evidence_rate",
    "empirical_proof": "post_cost_daily_net_pnl",
    "feature_coverage": "zero_notional_or_stale_evidence_rate",
    "drift_checks": "zero_notional_or_stale_evidence_rate",
    "tca_fill_quality": "fill_tca_or_slippage_quality",
    "route_readiness": "routeable_candidate_count",
    "schema_migration_state": "capital_gate_safety",
    "jangar_settlement": "capital_gate_safety",
}
_LOT_COST_CLASS = {
    "source_serving": "low",
    "signal_ingestion": "medium",
    "market_context": "low",
    "empirical_proof": "medium",
    "feature_rows": "medium",
    "execution_tca": "medium",
    "research_candidate": "medium",
    "rejection_drag": "low",
}
_SOURCE_REASON_VALUE_GATE = {
    "serving_build_commit_mismatch": "capital_gate_safety",
    "serving_build_commit_missing": "capital_gate_safety",
    "source_commit_missing": "capital_gate_safety",
    "manifest_image_digest_missing": "capital_gate_safety",
    "serving_image_digest_missing": "capital_gate_safety",
    "manifest_serving_image_digest_mismatch": "capital_gate_safety",
    "required_contract_missing": "zero_notional_or_stale_evidence_rate",
    "contract_schema_mismatch": "zero_notional_or_stale_evidence_rate",
}
_SOURCE_SERVING_REASON_CODES = frozenset(_SOURCE_REASON_VALUE_GATE)


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


def _unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _strings(value: object) -> list[str]:
    return _unique([_text(item) for item in _sequence(value)])


def _symbols(value: object) -> list[str]:
    if isinstance(value, str):
        return _unique([value.upper()])
    return _unique([_text(item).upper() for item in _sequence(value)])


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _int(value: object, default: int = 0) -> int:
    parsed = _decimal(value)
    return default if parsed is None else int(parsed)


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "allow", "allowed", "ok"}:
            return True
        if normalized in {"0", "false", "no", "off", "block", "blocked", "hold"}:
            return False
    return default


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in {"", "-0"} else text


def _source_state(source_serving_ledger: Mapping[str, Any]) -> str:
    return _text(source_serving_ledger.get("source_serving_state"), "missing").lower()


def _source_is_current(source_serving_ledger: Mapping[str, Any]) -> bool:
    return _source_state(source_serving_ledger) in _SOURCE_CURRENT_STATES


def _reason_value_gate(reason: str) -> str:
    return _SOURCE_REASON_VALUE_GATE.get(
        reason.split(":", 1)[0],
        "zero_notional_or_stale_evidence_rate",
    )


def _source_serving_reasons(reason_codes: Sequence[str]) -> list[str]:
    return [
        reason
        for reason in reason_codes
        if reason.split(":", 1)[0] in _SOURCE_SERVING_REASON_CODES
    ]


def _required_input_refs(*values: object) -> list[str]:
    refs: list[str] = []
    for value in values:
        if isinstance(value, str):
            refs.append(value)
        else:
            refs.extend(_strings(value))
    return _unique(refs)


def _settlement_status(state: str, hold_reasons: Sequence[str]) -> str:
    normalized = state.lower()
    if "expired" in hold_reasons or normalized == "expired":
        return "expired"
    if "notional_nonzero" in hold_reasons or normalized in {"rejected", "blocked"}:
        return "rejected"
    if normalized in {"settled", "accepted"}:
        return "settled"
    return "pending"


def _lot_dispatchable(
    *,
    lot_class: str,
    source_current: bool,
    requested_dispatchable: bool,
    hold_reason_codes: Sequence[str],
) -> tuple[bool, list[str]]:
    reasons = list(hold_reason_codes)
    if not source_current and lot_class != "source_serving":
        reasons.append("source_serving_not_converged")
    dispatchable = requested_dispatchable and not reasons
    return dispatchable, _unique(reasons)


def _frontier_lot_from_compacted(
    *,
    raw_lot: Mapping[str, Any],
    source_serving_ledger: Mapping[str, Any],
    source_current: bool,
) -> dict[str, object]:
    original_class = _text(raw_lot.get("lot_class"), "feature_lineage")
    lot_class = _LOT_CLASS_MAP.get(original_class, original_class)
    hold_reasons = _strings(raw_lot.get("hold_reason_codes"))
    if _text(raw_lot.get("max_notional"), _ZERO_NOTIONAL) != _ZERO_NOTIONAL:
        hold_reasons.append("notional_nonzero")
    dispatchable, hold_reasons = _lot_dispatchable(
        lot_class=lot_class,
        source_current=source_current,
        requested_dispatchable=_bool(raw_lot.get("dispatchable")),
        hold_reason_codes=hold_reasons,
    )
    lot_id = _stable_ref(
        "repair-receipt-frontier-lot",
        {
            "source": raw_lot.get("lot_id"),
            "lot_class": lot_class,
            "value_gate": raw_lot.get("target_value_gate"),
        },
    )
    return {
        "lot_id": lot_id,
        "source_lot_ref": raw_lot.get("lot_id"),
        "source_lot_class": original_class,
        "lot_class": lot_class,
        "target_symbols": _symbols(
            raw_lot.get("target_symbols")
            or raw_lot.get("symbols")
            or raw_lot.get("symbol_set")
        ),
        "target_hypothesis_ids": _strings(
            raw_lot.get("target_hypothesis_ids")
            or raw_lot.get("hypothesis_ids")
            or raw_lot.get("candidate_ids")
        ),
        "target_value_gate": raw_lot.get("target_value_gate")
        or "zero_notional_or_stale_evidence_rate",
        "expected_gate_delta": raw_lot.get("expected_gate_delta")
        or f"settle_{lot_class}",
        "expected_unblock_value": raw_lot.get("expected_unblock_value")
        or raw_lot.get("priority")
        or 0,
        "cost_class": _LOT_COST_CLASS.get(lot_class, "medium"),
        "source_serving_epoch_ref": source_serving_ledger.get("ledger_id"),
        "required_input_refs": _required_input_refs(
            raw_lot.get("required_input_refs"),
            raw_lot.get("source_bid_ids"),
            source_serving_ledger.get("ledger_id"),
        ),
        "required_output_receipt": raw_lot.get("required_output_receipt")
        or "torghut.zero-notional-repair-execution-receipt.v1",
        "validation_commands": _strings(raw_lot.get("validation_commands")),
        "max_runtime_seconds": _int(
            raw_lot.get("max_runtime_seconds"), _DEFAULT_MAX_RUNTIME_SECONDS
        ),
        "max_notional": _ZERO_NOTIONAL,
        "promotion_authority": False,
        "authority_semantics": "audit_only",
        "dispatchable": dispatchable,
        "hold_reason_codes": hold_reasons,
        "settlement_status": _settlement_status(
            _text(raw_lot.get("state"), "pending"), hold_reasons
        ),
        "dedupe_key": raw_lot.get("dedupe_key"),
    }


def _frontier_lot_from_profit_repair(
    *,
    repair: Mapping[str, Any],
    source_serving_ledger: Mapping[str, Any],
    source_current: bool,
) -> dict[str, object]:
    dimension = _text(repair.get("blocked_dimension"), "unknown")
    lot_class = _DIMENSION_LOT_CLASS.get(dimension, "feature_rows")
    hold_reasons: list[str] = []
    dispatchable, hold_reasons = _lot_dispatchable(
        lot_class=lot_class,
        source_current=source_current,
        requested_dispatchable=True,
        hold_reason_codes=hold_reasons,
    )
    value_gate = _DIMENSION_VALUE_GATE.get(
        dimension, "zero_notional_or_stale_evidence_rate"
    )
    action = _text(
        repair.get("zero_notional_action"), "observe_profit_freshness_frontier"
    )
    expected_daily_net_pnl = _decimal(repair.get("expected_daily_net_pnl_unlock"))
    expected_bps = _decimal(repair.get("expected_profit_unlock_bps"))
    return {
        "lot_id": _stable_ref(
            "repair-receipt-frontier-lot",
            {
                "source": repair.get("lot_id"),
                "dimension": dimension,
                "action": action,
            },
        ),
        "source_lot_ref": repair.get("lot_id"),
        "source_lot_class": "profit_freshness_frontier",
        "lot_class": lot_class,
        "target_symbols": _symbols(repair.get("symbol_set") or repair.get("symbols")),
        "target_hypothesis_ids": _required_input_refs(
            repair.get("hypothesis_id"),
            repair.get("candidate_id"),
        ),
        "target_value_gate": value_gate,
        "expected_gate_delta": f"retire_{dimension}",
        "expected_unblock_value": _decimal_text(expected_daily_net_pnl)
        or _decimal_text(expected_bps)
        or "0",
        "expected_daily_net_pnl_unlock": _decimal_text(expected_daily_net_pnl),
        "expected_profit_unlock_bps": _decimal_text(expected_bps),
        "cost_class": _text(
            repair.get("repair_cost_class"), _LOT_COST_CLASS.get(lot_class, "medium")
        ),
        "source_serving_epoch_ref": source_serving_ledger.get("ledger_id"),
        "required_input_refs": _required_input_refs(
            repair.get("before_refs"),
            repair.get("profit_unlock_refs"),
            source_serving_ledger.get("ledger_id"),
        ),
        "required_output_receipt": "torghut.zero-notional-repair-execution-receipt.v1",
        "validation_commands": [
            f"POST /trading/profit-freshness/zero-notional-repair?execute=false&action={action}"
        ],
        "max_runtime_seconds": _DEFAULT_MAX_RUNTIME_SECONDS,
        "max_notional": _ZERO_NOTIONAL,
        "promotion_authority": False,
        "authority_semantics": "audit_only",
        "dispatchable": dispatchable,
        "hold_reason_codes": hold_reasons,
        "settlement_status": _settlement_status(
            _text(repair.get("state"), "pending"), hold_reasons
        ),
        "zero_notional_action": action,
    }


def _source_serving_lot(
    source_serving_ledger: Mapping[str, Any],
) -> dict[str, object] | None:
    reason_codes = _strings(source_serving_ledger.get("reason_codes"))
    source_reasons = _source_serving_reasons(reason_codes)
    if _source_is_current(source_serving_ledger) and not source_reasons:
        return None
    state = _source_state(source_serving_ledger)
    lot_reasons = source_reasons or [f"source_serving_{state}"]
    primary_reason = lot_reasons[0]
    ledger_id = _text(source_serving_ledger.get("ledger_id"))
    return {
        "lot_id": _stable_ref(
            "repair-receipt-frontier-lot",
            {
                "source": ledger_id,
                "lot_class": "source_serving",
                "reason": primary_reason,
            },
        ),
        "source_lot_ref": ledger_id or None,
        "source_lot_class": "source_serving_repair_receipt_ledger",
        "lot_class": "source_serving",
        "target_symbols": [],
        "target_hypothesis_ids": [],
        "target_value_gate": _reason_value_gate(primary_reason),
        "expected_gate_delta": f"retire_{primary_reason}",
        "expected_unblock_value": len(lot_reasons) or 1,
        "cost_class": "low",
        "source_serving_epoch_ref": ledger_id or None,
        "required_input_refs": _required_input_refs(
            ledger_id,
            source_serving_ledger.get("route_warrant_ref"),
            source_serving_ledger.get("repair_bid_settlement_ref"),
            source_serving_ledger.get("route_evidence_clearinghouse_ref"),
        ),
        "required_output_receipt": "torghut.source-serving-convergence-receipt.v1",
        "validation_commands": [
            "GET /trading/consumer-evidence#source_serving_repair_receipt_ledger"
        ],
        "max_runtime_seconds": _DEFAULT_MAX_RUNTIME_SECONDS,
        "max_notional": _ZERO_NOTIONAL,
        "promotion_authority": False,
        "authority_semantics": "audit_only",
        "dispatchable": True,
        "hold_reason_codes": [],
        "settlement_status": "pending",
    }


def _dedupe_lots(lots: Sequence[dict[str, object]]) -> list[dict[str, object]]:
    deduped: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for lot in lots:
        key = (
            _text(lot.get("lot_class")),
            _text(lot.get("target_value_gate")),
            _text(lot.get("expected_gate_delta")),
        )
        if key in seen:
            continue
        deduped.append(lot)
        seen.add(key)
    return deduped


def _lot_sort_key(lot: Mapping[str, object]) -> tuple[int, int, int, Decimal, str]:
    dispatch_rank = 0 if lot.get("dispatchable") is True else 1
    source_rank = 0 if _text(lot.get("lot_class")) == "source_serving" else 1
    value_gate_rank = _VALUE_GATE_SORT_RANK.get(
        _text(lot.get("target_value_gate")),
        len(_VALUE_GATE_SORT_RANK),
    )
    expected_unblock = _decimal(lot.get("expected_unblock_value")) or Decimal("0")
    return (
        dispatch_rank,
        source_rank,
        value_gate_rank,
        -expected_unblock,
        _text(lot.get("lot_id")),
    )


def _dimension_state(
    profit_freshness_frontier: Mapping[str, Any], dimension_name: str
) -> str:
    for raw_dimension in _sequence(
        profit_freshness_frontier.get("freshness_dimensions")
    ):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) == dimension_name:
            return _text(dimension.get("state"), "missing").lower()
    return "missing"


def _has_reason(
    profit_freshness_frontier: Mapping[str, Any], reason_tokens: Sequence[str]
) -> bool:
    for reason in _strings(
        profit_freshness_frontier.get("aggregate_blocking_reason_codes")
    ):
        if any(token in reason for token in reason_tokens):
            return True
    return False


def _requirement(
    *,
    requirement: str,
    passed: bool,
    evidence_ref: object,
    value_gate: str,
    reason_codes: Sequence[str],
) -> dict[str, object]:
    return {
        "requirement": requirement,
        "state": "pass" if passed else "block",
        "evidence_ref": evidence_ref,
        "value_gate": value_gate,
        "reason_codes": [] if passed else _unique(list(reason_codes)),
    }


def _paper_requirements(
    *,
    source_serving_ledger: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
) -> list[dict[str, object]]:
    source_current = _source_is_current(source_serving_ledger)
    feature_current = _dimension_state(profit_freshness_frontier, "feature_coverage")
    tca_current = _dimension_state(profit_freshness_frontier, "tca_fill_quality")
    routeable_count = _int(
        route_warrant_exchange.get("accepted_routeable_candidate_count")
        or route_warrant_exchange.get("routeable_candidate_count")
    )
    post_cost_blocked = _has_reason(
        profit_freshness_frontier,
        ("post_cost_expectancy_non_positive", "post_cost", "expectancy_non_positive"),
    )
    selected_expected_pnl = _decimal(
        _mapping(profit_freshness_frontier.get("summary")).get(
            "selected_expected_daily_net_pnl_unlock"
        )
    )
    positive_repair_unlock = (
        selected_expected_pnl is not None and selected_expected_pnl > Decimal("0")
    )
    return [
        _requirement(
            requirement="source_serving_current",
            passed=source_current,
            evidence_ref=source_serving_ledger.get("ledger_id"),
            value_gate="capital_gate_safety",
            reason_codes=_strings(source_serving_ledger.get("reason_codes"))
            or [f"source_serving_{_source_state(source_serving_ledger)}"],
        ),
        _requirement(
            requirement="feature_rows_current",
            passed=feature_current == "current",
            evidence_ref=profit_freshness_frontier.get("frontier_id"),
            value_gate="zero_notional_or_stale_evidence_rate",
            reason_codes=["feature_rows_missing"],
        ),
        _requirement(
            requirement="execution_tca_current",
            passed=tca_current == "current",
            evidence_ref=profit_freshness_frontier.get("frontier_id"),
            value_gate="fill_tca_or_slippage_quality",
            reason_codes=["execution_tca_not_current"],
        ),
        _requirement(
            requirement="routeable_candidate_available",
            passed=routeable_count > 0,
            evidence_ref=route_warrant_exchange.get("warrant_id"),
            value_gate="routeable_candidate_count",
            reason_codes=["routeable_candidate_count_zero"],
        ),
        _requirement(
            requirement="post_cost_profit_non_negative",
            passed=not post_cost_blocked
            and (routeable_count > 0 or positive_repair_unlock),
            evidence_ref=freshness_carry_ledger.get("ledger_id"),
            value_gate="post_cost_daily_net_pnl",
            reason_codes=["post_cost_profit_proof_missing_or_non_positive"],
        ),
    ]


def _live_requirements(
    *,
    paper_requirements: Sequence[Mapping[str, object]],
    live_submission_gate: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
) -> list[dict[str, object]]:
    paper_pass = all(_text(item.get("state")) == "pass" for item in paper_requirements)
    gate_allowed = _bool(live_submission_gate.get("allowed"))
    proof_route_state = _text(proof_floor_receipt.get("route_state"), "missing").lower()
    capital_state = _text(proof_floor_receipt.get("capital_state"), "missing").lower()
    runtime_ledger_source_proof = _mapping(
        proof_floor_receipt.get("runtime_ledger_source_proof")
        or proof_floor_receipt.get("source_backed_runtime_ledger_proof")
    )
    runtime_source_proof_current = (
        _bool(runtime_ledger_source_proof.get("source_backed"))
        and _bool(runtime_ledger_source_proof.get("closed_round_trips"))
        and _bool(runtime_ledger_source_proof.get("explicit_costs"))
        and _bool(runtime_ledger_source_proof.get("flat_after_close_grace"))
        and _text(runtime_ledger_source_proof.get("state"), "missing").lower()
        in {"current", "pass", "ready"}
    )
    human_approved = _bool(
        live_submission_gate.get("human_approved_capital_limits")
        or live_submission_gate.get("human_approved_capital_limit")
        or proof_floor_receipt.get("human_approved_capital_limits")
    )
    return [
        _requirement(
            requirement="paper_cutover_requirements_pass",
            passed=paper_pass,
            evidence_ref="repair_receipt_frontier.paper_cutover_requirements",
            value_gate="capital_gate_safety",
            reason_codes=["paper_cutover_requirements_blocking"],
        ),
        _requirement(
            requirement="live_submission_enabled",
            passed=gate_allowed,
            evidence_ref=live_submission_gate.get("gate_id")
            or live_submission_gate.get("reason"),
            value_gate="capital_gate_safety",
            reason_codes=_strings(live_submission_gate.get("blocked_reasons"))
            or [_text(live_submission_gate.get("reason"), "live_submission_blocked")],
        ),
        _requirement(
            requirement="human_capital_limit_approved",
            passed=human_approved,
            evidence_ref=proof_floor_receipt.get("receipt_id")
            or proof_floor_receipt.get("schema_version"),
            value_gate="capital_gate_safety",
            reason_codes=["human_capital_limit_missing"],
        ),
        _requirement(
            requirement="profitability_proof_floor_allows_capital",
            passed=proof_route_state not in {"missing", "repair_only"}
            and capital_state not in {"missing", "zero_notional"},
            evidence_ref=proof_floor_receipt.get("receipt_id")
            or proof_floor_receipt.get("schema_version"),
            value_gate="post_cost_daily_net_pnl",
            reason_codes=[f"proof_floor_{proof_route_state}_{capital_state}"],
        ),
        _requirement(
            requirement="runtime_ledger_source_proof_current",
            passed=runtime_source_proof_current,
            evidence_ref=runtime_ledger_source_proof.get("receipt_id")
            or runtime_ledger_source_proof.get("ledger_id")
            or proof_floor_receipt.get("receipt_id")
            or proof_floor_receipt.get("schema_version"),
            value_gate="post_cost_daily_net_pnl",
            reason_codes=["runtime_ledger_source_proof_missing"],
        ),
    ]


def _frontier_state(
    *,
    lots: Sequence[Mapping[str, object]],
    paper_requirements: Sequence[Mapping[str, object]],
    live_requirements: Sequence[Mapping[str, object]],
) -> str:
    if lots:
        return "repair_only"
    if not all(_text(item.get("state")) == "pass" for item in paper_requirements):
        return "paper_blocked"
    if all(_text(item.get("state")) == "pass" for item in live_requirements):
        return "live_candidate"
    return "paper_candidate"


def build_repair_receipt_frontier(
    *,
    account_label: str | None,
    window: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    source_commit: str | None,
    source_serving_repair_receipt_ledger: Mapping[str, Any],
    freshness_carry_ledger: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a compact zero-notional repair frontier and cutover ladder."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    source_ledger = _mapping(source_serving_repair_receipt_ledger)
    source_current = _source_is_current(source_ledger)
    compacted_lots = [
        _frontier_lot_from_compacted(
            raw_lot=_mapping(raw_lot),
            source_serving_ledger=source_ledger,
            source_current=source_current,
        )
        for raw_lot in _sequence(repair_bid_settlement_ledger.get("compacted_lots"))
        if _mapping(raw_lot)
    ]
    profit_lots = [
        _frontier_lot_from_profit_repair(
            repair=_mapping(raw_repair),
            source_serving_ledger=source_ledger,
            source_current=source_current,
        )
        for raw_repair in _sequence(
            profit_freshness_frontier.get("selected_zero_notional_repairs")
        )
        if _mapping(raw_repair)
    ]
    source_lot = _source_serving_lot(source_ledger)
    lots = _dedupe_lots(
        [*([source_lot] if source_lot else []), *compacted_lots, *profit_lots]
    )
    lots = sorted(lots, key=_lot_sort_key)
    dispatchable_ids = [
        _text(lot.get("lot_id")) for lot in lots if lot.get("dispatchable") is True
    ]
    selected_lot_id = dispatchable_ids[0] if dispatchable_ids else None
    paper_requirements = _paper_requirements(
        source_serving_ledger=source_ledger,
        freshness_carry_ledger=freshness_carry_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        route_warrant_exchange=route_warrant_exchange,
    )
    live_requirements = _live_requirements(
        paper_requirements=paper_requirements,
        live_submission_gate=live_submission_gate,
        proof_floor_receipt=proof_floor_receipt,
    )
    state = _frontier_state(
        lots=lots,
        paper_requirements=paper_requirements,
        live_requirements=live_requirements,
    )
    frontier_id = _stable_ref(
        "repair-receipt-frontier",
        {
            "account": account_label,
            "window": window,
            "torghut_revision": torghut_revision,
            "source_ledger": source_ledger.get("ledger_id"),
            "repair_bid_ledger": repair_bid_settlement_ledger.get("ledger_id"),
            "profit_freshness_frontier": profit_freshness_frontier.get("frontier_id"),
            "lot_ids": [_text(lot.get("lot_id")) for lot in lots],
        },
    )
    return {
        "schema_version": REPAIR_RECEIPT_FRONTIER_SCHEMA_VERSION,
        "frontier_id": frontier_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": (
            generated_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account": account_label,
        "window": window,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
        "governing_design_ref": _DOC_REF,
        "source_serving_ledger_ref": source_ledger.get("ledger_id"),
        "freshness_carry_ledger_ref": freshness_carry_ledger.get("ledger_id"),
        "repair_bid_settlement_ledger_ref": repair_bid_settlement_ledger.get(
            "ledger_id"
        ),
        "profit_freshness_frontier_ref": profit_freshness_frontier.get("frontier_id"),
        "route_warrant_ref": route_warrant_exchange.get("warrant_id"),
        "capital_state": "zero_notional",
        "max_notional": _ZERO_NOTIONAL,
        "promotion_authority": False,
        "authority_semantics": "audit_only_until_source_backed_runtime_ledger_fill_proof",
        "frontier_state": state,
        "selected_lot_id": selected_lot_id,
        "dispatchable_lot_ids": dispatchable_ids,
        "held_lot_ids": [
            _text(lot.get("lot_id"))
            for lot in lots
            if lot.get("dispatchable") is not True
        ],
        "lots": lots,
        "paper_cutover_requirements": paper_requirements,
        "live_cutover_requirements": live_requirements,
        "summary": {
            "lot_count": len(lots),
            "dispatchable_lot_count": len(dispatchable_ids),
            "held_lot_count": len(lots) - len(dispatchable_ids),
            "paper_requirement_pass_count": sum(
                1 for item in paper_requirements if item["state"] == "pass"
            ),
            "live_requirement_pass_count": sum(
                1 for item in live_requirements if item["state"] == "pass"
            ),
            "source_serving_state": _source_state(source_ledger),
            "value_gates": _VALUE_GATES,
        },
        "rollback_target": {
            "repair_receipt_frontier_projection_enabled": False,
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "promotion_authority": False,
            "fallback_payloads": [
                "torghut.profit-freshness-frontier.v1",
                "torghut.repair-bid-settlement-ledger.v1",
                "torghut.source-serving-repair-receipt-ledger.v1",
            ],
        },
    }


__all__ = [
    "REPAIR_RECEIPT_FRONTIER_SCHEMA_VERSION",
    "build_repair_receipt_frontier",
]
