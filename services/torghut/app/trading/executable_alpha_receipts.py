"""Executable alpha receipt projection for zero-notional repair planning."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, cast

from .runtime_ledger import POST_COST_PNL_BASIS

CAPITAL_REPLAY_BOARD_SCHEMA_VERSION = "torghut.capital-replay-board.v1"
EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION = "torghut.executable-alpha-receipts.v1"
EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION = (
    "torghut.executable-alpha-repair-receipt.v1"
)
EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION = (
    "torghut.executable-alpha-repair-receipts.v1"
)
EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION = (
    "torghut.executable-alpha-settlement-slot.v1"
)
EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION = (
    "torghut.executable-alpha-settlement-slots.v1"
)
EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION = (
    "torghut.executable-alpha-settlement-slots-ref.v1"
)

_EXECUTABLE_ALPHA_REPAIR_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md"
)
_EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md"
)
_EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET = (
    "stop emitting executable_alpha_repair_receipts and keep Torghut max_notional=0"
)
_EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET = (
    "stop emitting executable_alpha_settlement_slots and keep Torghut max_notional=0"
)
_NO_DELTA_RELEASE_CONDITIONS = [
    "source_ref_changes",
    "evidence_window_changes",
    "blocker_set_changes",
    "required_receipt_changes",
]

GraduationState = Literal[
    "candidate",
    "reduced",
    "paper_replay_candidate",
    "retired",
    "unchanged",
    "failed",
    "contradicted",
]

_DEFAULT_FRESHNESS_SECONDS = 15 * 60
_LIVE_AAPL_HYPOTHESIS = "H-AAPL-ROUTE-REHAB"
_SIM_NVDA_HYPOTHESIS = "H-NVDA-SIM-PROOF-REFILL"
_BREADTH_HYPOTHESIS = "H-MEGACAP-BREADTH-PROBE"
_REPAIR_REASON_CLASSES = (
    (
        "strategy_lineage_repair",
        {
            "strategy_hypothesis_missing",
            "strategy_lineage_missing",
            "schema_lineage_missing",
        },
    ),
    (
        "evidence_window_refresh",
        {
            "hypothesis_window_evidence_missing",
            "hypothesis_window_evidence_stale",
            "drift_checks_missing",
            "feature_rows_missing",
            "required_feature_set_unavailable",
            "closed_session_market_context_hold",
            "closed_session_signal_hold",
            "closed_session_tca_evidence_hold",
        },
    ),
    (
        "autoresearch_portfolio_repair",
        {
            "autoresearch_portfolio_candidates_blocked",
            "autoresearch_portfolio_ready_empty",
        },
    ),
    ("equity_ta_refill", {"equity_ta_rows_missing"}),
    ("rejection_drag_measurement", {"rejection_drag_unmeasured"}),
    (
        "promotion_decision_receipt",
        {
            "alpha_readiness_not_promotion_eligible",
            "hypothesis_not_promotion_eligible",
            "promotion_decision_missing",
            "post_cost_expectancy_non_positive",
        },
    ),
)
_REPAIR_CLASS_RANK = {
    "strategy_lineage_repair": 0,
    "evidence_window_refresh": 1,
    "autoresearch_portfolio_repair": 2,
    "equity_ta_refill": 3,
    "rejection_drag_measurement": 4,
    "promotion_decision_receipt": 5,
    "capital_replay_board_refresh": 6,
}
_VALIDATION_COMMANDS_BY_CLASS = {
    "strategy_lineage_repair": [
        "uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py -k alpha",
        "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k lineage",
    ],
    "evidence_window_refresh": [
        "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window",
    ],
    "autoresearch_portfolio_repair": [
        "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k autoresearch",
    ],
    "equity_ta_refill": [
        "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k equity_ta",
    ],
    "rejection_drag_measurement": [
        "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k rejection_drag",
    ],
    "promotion_decision_receipt": [
        "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k promotion",
    ],
    "capital_replay_board_refresh": [
        "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py",
    ],
}
_FEATURE_OR_DRIFT_REPAIR_REASONS = {
    "drift_checks_missing",
    "feature_rows_missing",
    "required_feature_set_unavailable",
    "hypothesis_window_evidence_missing",
    "hypothesis_window_evidence_stale",
}
_POST_COST_REPAIR_REASONS = {
    "post_cost_expectancy_non_positive",
    "post_cost_expectancy_missing",
}
_CLOSED_SESSION_REPAIR_REASONS = {
    "closed_session_market_context_hold",
    "closed_session_signal_hold",
    "closed_session_tca_evidence_hold",
}
_ALPHA_RUNTIME_REPLAY_CLASS = "alpha_runtime_window_refresh"
_RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS = "runtime_ledger_economic_repair"
_RUNTIME_LEDGER_PAPER_PROBATION_REASON = "runtime_ledger_stage_not_live"
_RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS = {
    _RUNTIME_LEDGER_PAPER_PROBATION_REASON
}
_ZERO_RUNTIME_EVIDENCE_REASONS = {
    "hypothesis_window_decisions_missing",
    "hypothesis_window_orders_missing",
    "hypothesis_window_trades_missing",
    "runtime_decision_count_zero",
    "runtime_order_count_zero",
    "runtime_trade_count_zero",
}
_HARD_ALPHA_ECONOMIC_REASONS = {
    "post_cost_expectancy_below_manifest_threshold",
    "post_cost_expectancy_non_positive",
    "hypothesis_window_post_cost_expectancy_non_positive",
    "slippage_budget_exceeded",
}
_ALPHA_RUNTIME_REPAIR_REASONS = {
    "hypothesis_window_evidence_stale",
    "hypothesis_window_evidence_missing",
    "sample_count_below_canary_minimum",
    "recent_slippage_budget_exceeded",
    "delay_adjusted_depth_stress_missing",
    "drift_checks_missing",
}


def _text(value: object, default: str = "") -> str:
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


def _float(value: object) -> float | None:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _string_list(value: object) -> list[str]:
    return sorted({text for item in _sequence(value) if (text := _text(item))})


def _stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _route_records(proof_floor_receipt: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    route_book = _mapping(proof_floor_receipt.get("route_reacquisition_book"))
    return [_mapping(item) for item in _sequence(route_book.get("records"))]


def _route_board_rows(
    route_reacquisition_board: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [_mapping(item) for item in _sequence(route_reacquisition_board.get("rows"))]


def _find_by_symbol(
    items: Sequence[Mapping[str, Any]], symbol: str
) -> Mapping[str, Any]:
    wanted = symbol.upper()
    for item in items:
        if _text(item.get("symbol")).upper() == wanted:
            return item
    return {}


def _first_with_state(
    items: Sequence[Mapping[str, Any]], states: set[str]
) -> Mapping[str, Any]:
    for item in items:
        if _text(item.get("state")) in states:
            return item
    return items[0] if items else {}


def _proof_window(
    *,
    now: datetime,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
) -> dict[str, object]:
    generated_at = (
        _text(proof_floor_receipt.get("generated_at"))
        or _text(route_reacquisition_board.get("generated_at"))
        or now.isoformat()
    )
    fresh_until = (
        _text(route_reacquisition_board.get("fresh_until"))
        or (now + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)).isoformat()
    )
    return {
        "generated_at": generated_at,
        "fresh_until": fresh_until,
        "route_state": _text(proof_floor_receipt.get("route_state"), "unknown"),
        "capital_state": _text(proof_floor_receipt.get("capital_state"), "unknown"),
    }


def _reason_list_from_target(target: Mapping[str, Any]) -> list[str]:
    return _string_list(target.get("reasons")) + _string_list(
        target.get("informational_reasons")
    )


def _repair_class_for_target(
    target: Mapping[str, Any],
) -> tuple[str, list[str], str, str, str]:
    reason_codes = _reason_list_from_target(target)
    reason_set = set(reason_codes)
    candidate_id = _text(target.get("candidate_id"))
    strategy_id = _text(target.get("strategy_id"))

    if not candidate_id or not strategy_id:
        repair_class = "strategy_lineage_repair"
    else:
        repair_class = "capital_replay_board_refresh"
        for candidate_class, reasons in _REPAIR_REASON_CLASSES:
            if reason_set.intersection(reasons):
                repair_class = candidate_class
                break

    lineage_status = "missing" if repair_class == "strategy_lineage_repair" else "ready"
    if {"lineage_contradictory", "strategy_lineage_contradictory"}.intersection(
        reason_set
    ):
        lineage_status = "contradictory"
    elif "schema_lineage_missing" in reason_set:
        lineage_status = "missing"

    if {
        "hypothesis_window_evidence_missing",
        "feature_rows_missing",
        "required_feature_set_unavailable",
    }.intersection(reason_set):
        evidence_window_status = "missing"
    elif {
        "hypothesis_window_evidence_stale",
        "drift_checks_missing",
        "closed_session_market_context_hold",
        "closed_session_signal_hold",
        "closed_session_tca_evidence_hold",
    }.intersection(reason_set):
        evidence_window_status = "stale"
    else:
        evidence_window_status = "current"

    state = _text(target.get("state"), "repair_only")
    alpha_readiness_state = (
        "promotion_candidate"
        if bool(target.get("promotion_eligible"))
        else state or "repair_only"
    )
    if alpha_readiness_state == "shadow" and reason_codes:
        alpha_readiness_state = "blocked"

    return (
        repair_class,
        reason_codes,
        lineage_status,
        evidence_window_status,
        alpha_readiness_state,
    )


def _top_alpha_repair(top_blocker: Mapping[str, Any]) -> bool:
    return (
        _text(top_blocker.get("code")) == "repair_alpha_readiness"
        or _text(top_blocker.get("reason")) == "alpha_readiness_not_promotion_eligible"
    )


def _receipt_by_hypothesis(
    executable_alpha_receipts: Mapping[str, Any],
) -> dict[str, Mapping[str, Any]]:
    by_hypothesis: dict[str, Mapping[str, Any]] = {}
    for raw_receipt in [
        *_sequence(executable_alpha_receipts.get("receipts")),
        *_sequence(executable_alpha_receipts.get("candidate_receipts")),
    ]:
        receipt = _mapping(raw_receipt)
        hypothesis_id = _text(receipt.get("hypothesis_id"))
        if hypothesis_id and hypothesis_id not in by_hypothesis:
            by_hypothesis[hypothesis_id] = receipt
    return by_hypothesis


def _targets_from_alpha_readiness(
    alpha_readiness: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    targets: list[Mapping[str, Any]] = [
        _mapping(item) for item in _sequence(alpha_readiness.get("repair_targets"))
    ]
    targets = [target for target in targets if target]
    if targets:
        return targets
    targets = []
    for raw_hypothesis_id in _sequence(alpha_readiness.get("blocked_hypothesis_ids")):
        hypothesis_id = _text(raw_hypothesis_id)
        if hypothesis_id:
            targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "state": "blocked",
                    "promotion_eligible": False,
                    "reasons": ["alpha_readiness_not_promotion_eligible"],
                }
            )
    return targets


def _expected_gate_delta(reason_codes: Sequence[str]) -> str:
    for reason in reason_codes:
        if reason:
            return f"retire_{reason}"
    return "retire_alpha_readiness_not_promotion_eligible"


def _required_input_refs(
    *,
    source_revenue_repair_ref: str,
    repair_bid_settlement_ledger: Mapping[str, Any],
    capital_replay_board: Mapping[str, Any],
    executable_alpha_receipt: Mapping[str, Any],
) -> list[str]:
    refs = [source_revenue_repair_ref]
    for value in (
        repair_bid_settlement_ledger.get("ledger_id"),
        capital_replay_board.get("board_id"),
        executable_alpha_receipt.get("receipt_id"),
    ):
        text = _text(value)
        if text:
            refs.append(text)
    return _string_list(refs)


def _receipt_revenue_lane_rank(receipt: Mapping[str, Any]) -> int:
    reason_set = set(_string_list(receipt.get("reason_codes")))
    if reason_set.intersection(_FEATURE_OR_DRIFT_REPAIR_REASONS):
        return 0
    if reason_set.intersection(_POST_COST_REPAIR_REASONS):
        return 2
    if reason_set.intersection(_CLOSED_SESSION_REPAIR_REASONS):
        return 3
    return 1


def _receipt_target_key(receipt: Mapping[str, Any]) -> tuple[int, int, str]:
    return (
        _REPAIR_CLASS_RANK.get(_text(receipt.get("repair_class")), 100),
        _receipt_revenue_lane_rank(receipt),
        _text(receipt.get("hypothesis_id")),
    )


def _executable_alpha_repair_receipt(
    *,
    generated_at: datetime,
    fresh_until: datetime,
    source_revenue_repair_ref: str,
    top_blocker: Mapping[str, Any],
    target: Mapping[str, Any],
    repair_bid_settlement_ledger: Mapping[str, Any],
    capital_replay_board: Mapping[str, Any],
    executable_alpha_receipt: Mapping[str, Any],
    routeable_candidate_count_before: int,
) -> dict[str, object]:
    (
        repair_class,
        reason_codes,
        lineage_status,
        evidence_window_status,
        alpha_readiness_state,
    ) = _repair_class_for_target(target)
    hypothesis_id = _text(target.get("hypothesis_id"), "unknown")
    candidate_id = _text(target.get("candidate_id")) or None
    strategy_id = _text(target.get("strategy_id")) or None
    target_value_gate = _text(
        top_blocker.get("value_gate"), "routeable_candidate_count"
    )
    expected_unblock_value = _int(top_blocker.get("expected_unblock_value"), 1)
    payload_for_id = {
        "schema_version": EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION,
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "hypothesis_id": hypothesis_id,
        "repair_class": repair_class,
        "target_value_gate": target_value_gate,
        "reason_codes": reason_codes,
    }
    validation_commands = _VALIDATION_COMMANDS_BY_CLASS.get(
        repair_class, _VALIDATION_COMMANDS_BY_CLASS["capital_replay_board_refresh"]
    )
    required_output_receipts = _string_list(
        [
            _text(
                top_blocker.get("required_output_receipt"),
                EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION,
            ),
            *_string_list(top_blocker.get("required_receipts")),
        ]
    )
    return {
        **payload_for_id,
        "receipt_id": "executable-alpha-repair-receipt:"
        + _stable_hash("executable-alpha-repair-receipt", payload_for_id),
        "generated_at": generated_at.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "account_id": _text(repair_bid_settlement_ledger.get("account_id"), "unknown"),
        "window": _text(repair_bid_settlement_ledger.get("session_id"), "unknown"),
        "trading_mode": _text(
            repair_bid_settlement_ledger.get("trading_mode"), "unknown"
        ),
        "candidate_id": candidate_id,
        "strategy_id": strategy_id,
        "lineage_status": lineage_status,
        "evidence_window_status": evidence_window_status,
        "alpha_readiness_state": alpha_readiness_state,
        "repair_class": repair_class,
        "target_value_gate": target_value_gate,
        "expected_unblock_value": expected_unblock_value,
        "expected_gate_delta": _expected_gate_delta(reason_codes),
        "required_input_refs": _required_input_refs(
            source_revenue_repair_ref=source_revenue_repair_ref,
            repair_bid_settlement_ledger=repair_bid_settlement_ledger,
            capital_replay_board=capital_replay_board,
            executable_alpha_receipt=executable_alpha_receipt,
        ),
        "required_output_receipts": required_output_receipts,
        "validation_commands": validation_commands,
        "max_notional": "0",
        "capital_rule": "zero_notional_repair_only",
        "no_delta_settlement_required": True,
        "settlement": {
            "state": "pending",
            "allowed_outcomes": ["retired", "improved", "no_delta", "invalidated"],
            "before_reason_codes": reason_codes,
            "before_value_gate": {
                "routeable_candidate_count": routeable_candidate_count_before
            },
        },
        "jangar_reentry": {
            "governing_design_ref": _EXECUTABLE_ALPHA_REPAIR_DESIGN_REF,
            "required_material_reentry_receipt": "jangar.material-reentry-receipt.v1",
            "action_class": "dispatch_repair",
            "max_parallelism": 1,
            "max_runtime_seconds": 1200,
            "value_gates": [target_value_gate],
            "rollback_target": "keep max_notional=0 and live submit disabled",
        },
        "rollback_target": _EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET,
    }


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


def _zero_notional(value: object) -> bool:
    return _text(value, "0") in {"0", "0.0", "0.00", "0.0000"}


def _top_queue_item(repair_queue: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    for item in repair_queue:
        payload = _mapping(item)
        if payload:
            return payload
    return {}


def _repair_receipt_reason_codes(receipt: Mapping[str, Any]) -> list[str]:
    reason_codes = _string_list(receipt.get("reason_codes"))
    settlement = _mapping(receipt.get("settlement"))
    if not reason_codes:
        reason_codes = _string_list(settlement.get("before_reason_codes"))
    return reason_codes


def _selected_repair_receipt(
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


def _parse_datetime(value: object) -> datetime | None:
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


def _routeable_candidate_count_from_evidence(evidence: Mapping[str, Any]) -> int:
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    routeability_acceptance = _mapping(evidence.get("routeability_acceptance"))
    route_clearinghouse = _mapping(evidence.get("route_evidence_clearinghouse"))
    return max(
        _int(repair_bid_settlement.get("routeable_candidate_count")),
        _int(routeability_acceptance.get("accepted_routeable_candidate_count")),
        _int(route_clearinghouse.get("accepted_routeable_candidate_count")),
    )


def _alpha_target_reason_codes(
    evidence: Mapping[str, Any], hypothesis_id: str
) -> list[str]:
    alpha_readiness = _mapping(evidence.get("alpha_readiness"))
    for raw_target in _sequence(alpha_readiness.get("repair_targets")):
        target = _mapping(raw_target)
        if _text(target.get("hypothesis_id")) != hypothesis_id:
            continue
        return _reason_list_from_target(target)
    return []


def _required_after_receipts(
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


def _before_routeable_candidate_count(selected_receipt: Mapping[str, Any]) -> int:
    settlement = _mapping(selected_receipt.get("settlement"))
    before_value_gate = _mapping(settlement.get("before_value_gate"))
    return _int(before_value_gate.get("routeable_candidate_count"))


def _settlement_state(
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


def _build_executable_alpha_settlement_slot(
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
    before_reason_codes = _repair_receipt_reason_codes(selected_receipt)
    after_reason_codes = _alpha_target_reason_codes(evidence, hypothesis_id)
    if not after_reason_codes:
        after_reason_codes = before_reason_codes
    routeable_before = _before_routeable_candidate_count(selected_receipt)
    routeable_after = _routeable_candidate_count_from_evidence(evidence)
    measured_delta = routeable_after - routeable_before
    state = _settlement_state(
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
            "required_after_receipts": _required_after_receipts(
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
        "required_after_receipts": _required_after_receipts(
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


def _no_delta_debt_from_settlement_slot(
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
        "remaining_blocker": _primary_remaining_blocker(preserved_reason_codes),
        "release_conditions": list(_NO_DELTA_RELEASE_CONDITIONS),
    }


def _primary_remaining_blocker(reason_codes: Sequence[str]) -> str:
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
    top_item = _top_queue_item(repair_queue)
    selected_receipt = _selected_repair_receipt(executable_alpha_repair_receipts)
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
    if not _zero_notional(max_notional):
        reason_codes.append("capital_notional_nonzero")
    if bool(capital.get("live_submission_allowed")):
        reason_codes.append("live_submission_enabled")
    if selected_receipt and not _zero_notional(selected_receipt.get("max_notional")):
        reason_codes.append("selected_receipt_notional_nonzero")

    selected_fresh_until = _parse_datetime(selected_receipt.get("fresh_until"))
    if (
        selected_receipt
        and selected_fresh_until is not None
        and selected_fresh_until < generated
    ):
        reason_codes.append("selected_executable_alpha_repair_receipt_stale")

    slots: list[dict[str, object]] = []
    if not reason_codes:
        slots.append(
            _build_executable_alpha_settlement_slot(
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
        if (debt := _no_delta_debt_from_settlement_slot(slot)) is not None
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
        "remaining_blocker": _primary_remaining_blocker(preserved_reason_codes)
        if preserved_reason_codes
        else None,
        "max_notional": payload.get("max_notional"),
        "capital_rule": payload.get("capital_rule"),
        "rollback_target": payload.get("rollback_target"),
    }


def _graduation_state(
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> tuple[str, list[str]]:
    state = _text(jangar_contract_graduation_ref.get("state"))
    decision = _text(jangar_contract_graduation_ref.get("decision")).lower()
    if state == "current" or decision == "allow":
        return "current", []
    reasons = _string_list(jangar_contract_graduation_ref.get("reasons"))
    return state or "missing", reasons or ["jangar_contract_graduation_missing"]


def _market_context_blockers(market_context_status: Mapping[str, Any]) -> list[str]:
    if not market_context_status:
        return ["market_context_missing"]
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


def _quant_blockers(quant_evidence: Mapping[str, Any]) -> list[str]:
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


def _empirical_blockers(empirical_jobs_status: Mapping[str, Any]) -> list[str]:
    if bool(empirical_jobs_status.get("ready")):
        return []
    status = _text(empirical_jobs_status.get("status"), "unknown")
    reasons = _string_list(empirical_jobs_status.get("reasons"))
    return sorted(set(reasons or [f"empirical_jobs_{status}"]))


def _tca_guardrail_blockers(route_record: Mapping[str, Any]) -> list[str]:
    observed = _float(route_record.get("avg_abs_slippage_bps"))
    guardrail = _float(route_record.get("slippage_guardrail_bps"))
    if observed is not None and guardrail is not None and observed > guardrail:
        return ["execution_tca_above_guardrail"]
    if _int(route_record.get("unsettled_execution_count")) > 0:
        return ["execution_tca_unsettled_executions"]
    if _text(route_record.get("state")) == "missing":
        return ["execution_tca_symbol_missing"]
    return []


def _capital_blockers(
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
    blockers.update(_empirical_blockers(empirical_jobs_status))
    blockers.update(_quant_blockers(quant_evidence))
    blockers.update(_market_context_blockers(market_context_status))
    blockers.update(_tca_guardrail_blockers(route_record))
    graduation_state, graduation_reasons = _graduation_state(
        jangar_contract_graduation_ref
    )
    if graduation_state != "current":
        blockers.update(graduation_reasons)
    return sorted(blocker for blocker in blockers if blocker)


def _before_refs(
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


def _required_after_refs(replay_class: str) -> list[str]:
    refs = [
        "fresh_market_context_receipt",
        "scoped_quant_health_receipt",
        "alpha_readiness_receipt",
        "empirical_job_receipt",
        "jangar_contract_graduation_receipt",
    ]
    if replay_class == "missing_symbol_breadth_probe":
        return ["route_coverage_receipt", *refs]
    return ["fresh_tca_route_receipt", *refs]


def _guardrails(
    *,
    route_record: Mapping[str, Any],
    blockers: Sequence[str],
) -> list[dict[str, object]]:
    observed = route_record.get("avg_abs_slippage_bps")
    guardrail = route_record.get("slippage_guardrail_bps")
    return [
        {
            "code": "zero_notional_required",
            "status": "pass",
            "limit": "0",
        },
        {
            "code": "tca_slippage_guardrail",
            "status": "blocked"
            if "execution_tca_above_guardrail" in blockers
            else "pending",
            "observed_bps": observed,
            "limit_bps": guardrail,
        },
        {
            "code": "fresh_scoped_proof_required",
            "status": "blocked" if blockers else "pending",
            "blocking_reason_codes": sorted(set(blockers)),
        },
    ]


def _live_gate_evaluated_hypotheses(
    live_submission_gate: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    evaluated = [
        _mapping(item)
        for item in _sequence(live_submission_gate.get("evaluated_tuples"))
    ]
    if not evaluated:
        segment_summary = _mapping(live_submission_gate.get("segment_summary"))
        evaluated = [
            _mapping(item)
            for item in _sequence(segment_summary.get("evaluated_hypotheses"))
        ]
    seen: set[str] = set()
    unique: list[Mapping[str, Any]] = []
    for item in evaluated:
        hypothesis_id = _text(item.get("hypothesis_id"))
        if not hypothesis_id or hypothesis_id in seen:
            continue
        unique.append(item)
        seen.add(hypothesis_id)
    return unique


def _alpha_runtime_repair_reason_codes(item: Mapping[str, Any]) -> list[str]:
    reasons = _string_list(item.get("reason_codes"))
    if not reasons:
        reasons = _string_list(item.get("reasons"))
    return reasons


def _alpha_runtime_replay_key(
    item: Mapping[str, Any],
) -> tuple[int, int, int, int, str]:
    reasons = set(_alpha_runtime_repair_reason_codes(item))
    blocked_segments = len(_sequence(item.get("blocked_segments")))
    return (
        len(reasons.intersection(_ZERO_RUNTIME_EVIDENCE_REASONS)),
        len(reasons.intersection(_HARD_ALPHA_ECONOMIC_REASONS)),
        blocked_segments,
        len(reasons),
        _text(item.get("hypothesis_id")),
    )


def _top_alpha_runtime_replay_target(
    live_submission_gate: Mapping[str, Any],
) -> Mapping[str, Any]:
    candidates = [
        item
        for item in _live_gate_evaluated_hypotheses(live_submission_gate)
        if _text(item.get("hypothesis_id"))
    ]
    if not candidates:
        return {}
    return sorted(candidates, key=_alpha_runtime_replay_key)[0]


def _runtime_ledger_repair_candidates(
    live_submission_gate: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [
        _mapping(item)
        for item in _sequence(
            live_submission_gate.get("runtime_ledger_repair_candidates")
        )
        if _text(_mapping(item).get("hypothesis_id"))
    ]


def _runtime_ledger_repair_key(
    item: Mapping[str, Any],
) -> tuple[int, int, int, int, float, float, float, str]:
    filled_notional = _float(item.get("filled_notional")) or 0.0
    net_pnl = _float(item.get("net_strategy_pnl_after_costs")) or 0.0
    expectancy_bps = _float(item.get("post_cost_expectancy_bps")) or 0.0
    return (
        int(filled_notional > 0),
        int(_int(item.get("fill_count")) > 0),
        int(_int(item.get("closed_trade_count")) > 0),
        int(net_pnl > 0 and expectancy_bps > 0),
        net_pnl,
        expectancy_bps,
        filled_notional,
        _text(item.get("hypothesis_id")),
    )


def _top_runtime_ledger_economic_repair_candidate(
    live_submission_gate: Mapping[str, Any],
) -> Mapping[str, Any]:
    candidates = _runtime_ledger_repair_candidates(live_submission_gate)
    if not candidates:
        return {}
    return sorted(candidates, key=_runtime_ledger_repair_key, reverse=True)[0]


def _alpha_runtime_confidence(item: Mapping[str, Any]) -> str:
    reasons = set(_alpha_runtime_repair_reason_codes(item))
    if reasons.intersection(_ZERO_RUNTIME_EVIDENCE_REASONS):
        return "low"
    if reasons.intersection(_HARD_ALPHA_ECONOMIC_REASONS):
        return "low"
    return "medium"


def _runtime_ledger_paper_probation_eligible(
    item: Mapping[str, Any],
    *,
    reason_codes: Sequence[str],
) -> bool:
    reasons = {reason for reason in reason_codes if reason}
    return (
        _text(item.get("observed_stage")) == "paper"
        and reasons == _RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS
        and _text(item.get("pnl_basis")) == POST_COST_PNL_BASIS
        and (_float(item.get("filled_notional")) or 0.0) > 0.0
        and _int(item.get("fill_count")) > 0
        and _int(item.get("closed_trade_count")) > 0
        and _int(item.get("open_position_count")) == 0
        and (_float(item.get("net_strategy_pnl_after_costs")) or 0.0) > 0.0
        and (_float(item.get("post_cost_expectancy_bps")) or 0.0) > 0.0
    )


def _runtime_ledger_economic_repair_item(
    *,
    item: Mapping[str, Any],
    account_label: str | None,
    trading_mode: str,
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_id = _text(item.get("hypothesis_id"), "unknown")
    candidate_id = _text(item.get("candidate_id"))
    strategy_id = _text(item.get("strategy_id")) or _text(
        item.get("runtime_strategy_name")
    )
    reasons = _string_list(item.get("reason_codes"))
    blockers = set(_string_list(proof_floor_receipt.get("blocking_reasons")))
    blockers.update(_string_list(live_submission_gate.get("blocked_reasons")))
    blockers.update(reasons)
    blockers.update(_empirical_blockers(empirical_jobs_status))
    blockers.update(_quant_blockers(quant_evidence))
    blockers.update(_market_context_blockers(market_context_status))
    graduation_state, graduation_reasons = _graduation_state(
        jangar_contract_graduation_ref
    )
    if graduation_state != "current":
        blockers.update(graduation_reasons)

    runtime_bucket = _mapping(item.get("runtime_ledger_bucket"))
    replay_id = "replay:" + _stable_hash(
        "runtime-ledger-economic-repair",
        {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "strategy_id": strategy_id,
            "run_id": item.get("run_id"),
            "bucket_started_at": item.get("bucket_started_at"),
            "bucket_ended_at": item.get("bucket_ended_at"),
            "account_label": account_label,
            "trading_mode": trading_mode,
            "proof_floor_generated_at": proof_floor_receipt.get("generated_at"),
        },
    )
    after_cost_edge_bps = _float(item.get("post_cost_expectancy_bps"))
    paper_probation_eligible = _runtime_ledger_paper_probation_eligible(
        item,
        reason_codes=reasons,
    )
    return {
        "replay_id": replay_id,
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id or None,
        "strategy_id": strategy_id or None,
        "target_symbols": _string_list(item.get("target_symbols")),
        "replay_class": _RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS,
        "before_refs": {
            "runtime_ledger_candidate": {
                "source": item.get("source"),
                "promotion_authority": item.get("promotion_authority"),
                "run_id": item.get("run_id"),
                "candidate_id": candidate_id or None,
                "strategy_id": strategy_id or None,
                "strategy_family": item.get("strategy_family"),
                "runtime_strategy_name": item.get("runtime_strategy_name"),
                "observed_stage": item.get("observed_stage"),
                "account": item.get("account"),
                "bucket_started_at": item.get("bucket_started_at"),
                "bucket_ended_at": item.get("bucket_ended_at"),
                "fill_count": item.get("fill_count"),
                "submitted_order_count": item.get("submitted_order_count"),
                "closed_trade_count": item.get("closed_trade_count"),
                "open_position_count": item.get("open_position_count"),
                "filled_notional": item.get("filled_notional"),
                "net_strategy_pnl_after_costs": item.get(
                    "net_strategy_pnl_after_costs"
                ),
                "post_cost_expectancy_bps": item.get("post_cost_expectancy_bps"),
                "reason_codes": reasons,
                "ledger_schema_version": item.get("ledger_schema_version"),
                "pnl_basis": item.get("pnl_basis"),
                "runtime_ledger_bucket": dict(runtime_bucket),
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
            },
            "quant_evidence": {
                "status": quant_evidence.get("status"),
                "source_url": quant_evidence.get("source_url"),
                "latest_metrics_count": quant_evidence.get("latest_metrics_count"),
            },
            "market_context": {
                "status": market_context_status.get("status"),
                "state": market_context_status.get("state")
                or market_context_status.get("overallState")
                or market_context_status.get("overall_state"),
                "alert_active": bool(market_context_status.get("alert_active")),
                "alert_reason": market_context_status.get("alert_reason"),
            },
            "jangar_contract_graduation": dict(jangar_contract_graduation_ref),
        },
        "required_after_refs": [
            "live_runtime_ledger_receipt",
            "runtime_window_ledger_receipt",
            "promotion_grade_post_cost_pnl_receipt",
            "promotion_decision_receipt",
            "alpha_readiness_receipt",
            "empirical_job_receipt",
            "jangar_contract_graduation_receipt",
        ],
        "expected_profit_unlock": {
            "expected_blocker_delta": max(1, len(set(reasons))),
            "expected_profit_effect": "convert_runtime_ledger_economic_bucket_into_promotion_certificate",
            "after_cost_edge_bps": after_cost_edge_bps,
            "observed_net_pnl_after_costs": item.get("net_strategy_pnl_after_costs"),
        },
        "expected_cost": {
            "class": "runtime_ledger_economic_repair",
            "max_runtime_seconds": 900,
        },
        "confidence": "medium"
        if after_cost_edge_bps is not None and after_cost_edge_bps > 0
        else "low",
        "paper_probation_eligible": paper_probation_eligible,
        "paper_probation_scope": "evidence_collection_only"
        if paper_probation_eligible
        else None,
        "paper_probation_reason_codes": sorted(reasons)
        if paper_probation_eligible
        else [],
        "paper_probation_target_capital_stage": "shadow"
        if paper_probation_eligible
        else None,
        "max_runtime_seconds": 900,
        "max_notional": "0",
        "guardrails": [
            {
                "code": "zero_notional_required",
                "status": "pass",
                "limit": "0",
            },
            {
                "code": "runtime_ledger_authority_required",
                "status": "blocked",
                "required_stage": "live",
                "observed_stage": item.get("observed_stage"),
                "required_basis": POST_COST_PNL_BASIS,
            },
            {
                "code": "promotion_certificate_required",
                "status": "blocked",
                "blocking_reason_codes": sorted(set(blockers)),
            },
        ],
        "falsification_rules": [
            "runtime_ledger_bucket_not_reproducible",
            "live_runtime_ledger_missing",
            "post_cost_pnl_non_positive_after_refresh",
            "promotion_decision_still_not_allowed",
        ],
        "owner": "torghut",
        "remaining_blockers": sorted(blocker for blocker in blockers if blocker),
        "capital_effect": {
            "capital_state": "zero_notional",
            "max_notional": "0",
            "paper_canary": "held",
            "live_micro_canary": "blocked",
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "replay_class": _RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS,
        },
    }


def _alpha_runtime_blockers(
    *,
    item: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> list[str]:
    blockers = set(_string_list(proof_floor_receipt.get("blocking_reasons")))
    blockers.update(_string_list(live_submission_gate.get("blocked_reasons")))
    blockers.update(_alpha_runtime_repair_reason_codes(item))
    blockers.update(_empirical_blockers(empirical_jobs_status))
    blockers.update(_quant_blockers(quant_evidence))
    blockers.update(_market_context_blockers(market_context_status))
    graduation_state, graduation_reasons = _graduation_state(
        jangar_contract_graduation_ref
    )
    if graduation_state != "current":
        blockers.update(graduation_reasons)
    return sorted(blocker for blocker in blockers if blocker)


def _alpha_runtime_replay_item(
    *,
    item: Mapping[str, Any],
    account_label: str | None,
    trading_mode: str,
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_id = _text(item.get("hypothesis_id"), "unknown")
    candidate_id = _text(item.get("candidate_id"))
    strategy_id = _text(item.get("strategy_id"))
    reasons = _alpha_runtime_repair_reason_codes(item)
    blockers = _alpha_runtime_blockers(
        item=item,
        proof_floor_receipt=proof_floor_receipt,
        live_submission_gate=live_submission_gate,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        jangar_contract_graduation_ref=jangar_contract_graduation_ref,
    )
    replay_id = "replay:" + _stable_hash(
        "alpha-runtime-window-replay",
        {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "strategy_id": strategy_id,
            "account_label": account_label,
            "trading_mode": trading_mode,
            "proof_floor_generated_at": proof_floor_receipt.get("generated_at"),
        },
    )
    return {
        "replay_id": replay_id,
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id or None,
        "strategy_id": strategy_id or None,
        "target_symbols": _string_list(item.get("target_symbols")),
        "replay_class": _ALPHA_RUNTIME_REPLAY_CLASS,
        "before_refs": {
            "runtime_alpha_tuple": {
                "candidate_id": candidate_id or None,
                "strategy_id": strategy_id or None,
                "capital_state": item.get("capital_state"),
                "capital_stage": item.get("capital_stage"),
                "window": item.get("window"),
                "metric_window_id": item.get("metric_window_id"),
                "promotion_decision_id": item.get("promotion_decision_id"),
                "blocked_segments": _string_list(item.get("blocked_segments")),
                "reason_codes": reasons,
                "lineage_ref": dict(_mapping(item.get("lineage_ref"))),
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
        },
        "required_after_refs": [
            "runtime_window_ledger_receipt",
            "promotion_grade_post_cost_pnl_receipt",
            "fresh_hypothesis_window_receipt",
            "promotion_decision_receipt",
            "alpha_readiness_receipt",
            "empirical_job_receipt",
            "jangar_contract_graduation_receipt",
        ],
        "expected_profit_unlock": {
            "expected_blocker_delta": max(1, len(set(reasons))),
            "expected_profit_effect": "can_unlock_alpha_readiness_after_runtime_ledger_receipts",
            "after_cost_edge_bps": None,
        },
        "expected_cost": {
            "class": "runtime_window_replay_refresh",
            "max_runtime_seconds": 900,
        },
        "confidence": _alpha_runtime_confidence(item),
        "max_runtime_seconds": 900,
        "max_notional": "0",
        "guardrails": [
            {
                "code": "zero_notional_required",
                "status": "pass",
                "limit": "0",
            },
            {
                "code": "runtime_ledger_authority_required",
                "status": "blocked",
                "required_basis": "promotion_grade_post_cost_pnl",
            },
            {
                "code": "fresh_scoped_proof_required",
                "status": "blocked" if blockers else "pending",
                "blocking_reason_codes": sorted(set(blockers)),
            },
        ],
        "falsification_rules": [
            "runtime_ledger_missing_or_non_authoritative",
            "post_cost_pnl_non_positive",
            "hypothesis_window_stale_after_refresh",
            "promotion_decision_still_not_allowed",
        ],
        "owner": "torghut",
        "remaining_blockers": blockers,
        "capital_effect": {
            "capital_state": "zero_notional",
            "max_notional": "0",
            "paper_canary": "held",
            "live_micro_canary": "blocked",
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "replay_class": _ALPHA_RUNTIME_REPLAY_CLASS,
        },
    }


def _replay_item(
    *,
    hypothesis_id: str,
    replay_class: str,
    target_symbols: Sequence[str],
    route_row: Mapping[str, Any],
    route_record: Mapping[str, Any],
    account_label: str | None,
    trading_mode: str,
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> dict[str, object]:
    blockers = _capital_blockers(
        proof_floor_receipt=proof_floor_receipt,
        live_submission_gate=live_submission_gate,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        route_record=route_record,
        jangar_contract_graduation_ref=jangar_contract_graduation_ref,
    )
    normalized_symbols = sorted(
        {_text(symbol) for symbol in target_symbols if _text(symbol)}
    )
    replay_id = "replay:" + _stable_hash(
        "capital-replay",
        {
            "hypothesis_id": hypothesis_id,
            "replay_class": replay_class,
            "account_label": account_label,
            "trading_mode": trading_mode,
            "symbols": normalized_symbols,
            "proof_floor_generated_at": proof_floor_receipt.get("generated_at"),
        },
    )
    expected_unblock_value = _int(route_row.get("expected_unblock_value"), 1)
    return {
        "replay_id": replay_id,
        "hypothesis_id": hypothesis_id,
        "target_symbols": normalized_symbols,
        "replay_class": replay_class,
        "before_refs": _before_refs(
            replay_class=replay_class,
            route_row=route_row,
            route_record=route_record,
            proof_floor_receipt=proof_floor_receipt,
            empirical_jobs_status=empirical_jobs_status,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            jangar_contract_graduation_ref=jangar_contract_graduation_ref,
        ),
        "required_after_refs": _required_after_refs(replay_class),
        "expected_profit_unlock": {
            "expected_blocker_delta": expected_unblock_value,
            "expected_profit_effect": route_row.get("expected_profit_effect")
            or "repair_profit_evidence",
            "after_cost_edge_bps": None,
        },
        "expected_cost": {
            "class": route_row.get("expected_cost_class") or "unknown",
            "max_runtime_seconds": 900
            if replay_class == "missing_symbol_breadth_probe"
            else 600,
        },
        "confidence": "medium"
        if _text(route_row.get("state")) in {"probing", "routeable"}
        else "low",
        "max_runtime_seconds": 900
        if replay_class == "missing_symbol_breadth_probe"
        else 600,
        "max_notional": "0",
        "guardrails": _guardrails(route_record=route_record, blockers=blockers),
        "falsification_rules": [
            "after_refs_missing_or_stale",
            "tca_slippage_above_guardrail",
            "market_context_stale_or_contradicted",
            "jangar_contract_graduation_not_current",
        ],
        "owner": "torghut",
        "remaining_blockers": blockers,
        "capital_effect": {
            "capital_state": "zero_notional",
            "max_notional": "0",
            "paper_canary": "held",
            "live_micro_canary": "blocked",
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "replay_class": replay_class,
        },
    }


def _candidate_replays(
    *,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    account_label: str | None,
    trading_mode: str,
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> list[dict[str, object]]:
    route_rows = _route_board_rows(route_reacquisition_board)
    route_records = _route_records(proof_floor_receipt)
    replays: list[dict[str, object]] = []

    runtime_ledger_target = _top_runtime_ledger_economic_repair_candidate(
        live_submission_gate
    )
    if runtime_ledger_target:
        replays.append(
            _runtime_ledger_economic_repair_item(
                item=runtime_ledger_target,
                account_label=account_label,
                trading_mode=trading_mode,
                proof_floor_receipt=proof_floor_receipt,
                live_submission_gate=live_submission_gate,
                empirical_jobs_status=empirical_jobs_status,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                jangar_contract_graduation_ref=jangar_contract_graduation_ref,
            )
        )

    alpha_target = _top_alpha_runtime_replay_target(live_submission_gate)
    if alpha_target:
        replays.append(
            _alpha_runtime_replay_item(
                item=alpha_target,
                account_label=account_label,
                trading_mode=trading_mode,
                proof_floor_receipt=proof_floor_receipt,
                live_submission_gate=live_submission_gate,
                empirical_jobs_status=empirical_jobs_status,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                jangar_contract_graduation_ref=jangar_contract_graduation_ref,
            )
        )

    aapl_row = _find_by_symbol(route_rows, "AAPL") or _first_with_state(
        route_rows, {"probing", "routeable"}
    )
    if aapl_row:
        symbol = _text(aapl_row.get("symbol"), "AAPL")
        replays.append(
            _replay_item(
                hypothesis_id=_LIVE_AAPL_HYPOTHESIS
                if symbol == "AAPL"
                else f"H-{symbol}-ROUTE-REHAB",
                replay_class="route_rehab",
                target_symbols=[symbol],
                route_row=aapl_row,
                route_record=_find_by_symbol(route_records, symbol),
                account_label=account_label,
                trading_mode=trading_mode,
                proof_floor_receipt=proof_floor_receipt,
                live_submission_gate=live_submission_gate,
                empirical_jobs_status=empirical_jobs_status,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                jangar_contract_graduation_ref=jangar_contract_graduation_ref,
            )
        )

    nvda_row = _find_by_symbol(route_rows, "NVDA") or _first_with_state(
        route_rows, {"blocked"}
    )
    if nvda_row:
        symbol = _text(nvda_row.get("symbol"), "NVDA")
        replays.append(
            _replay_item(
                hypothesis_id=_SIM_NVDA_HYPOTHESIS
                if symbol == "NVDA"
                else f"H-{symbol}-PROOF-REFILL",
                replay_class="scoped_proof_refill",
                target_symbols=[symbol],
                route_row=nvda_row,
                route_record=_find_by_symbol(route_records, symbol),
                account_label=account_label,
                trading_mode=trading_mode,
                proof_floor_receipt=proof_floor_receipt,
                live_submission_gate=live_submission_gate,
                empirical_jobs_status=empirical_jobs_status,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                jangar_contract_graduation_ref=jangar_contract_graduation_ref,
            )
        )

    missing_rows = [row for row in route_rows if _text(row.get("state")) == "missing"]
    if missing_rows:
        symbols = [
            _text(row.get("symbol")) for row in missing_rows if _text(row.get("symbol"))
        ]
        route_row = missing_rows[0]
        symbol = _text(route_row.get("symbol"))
        replays.append(
            _replay_item(
                hypothesis_id=_BREADTH_HYPOTHESIS,
                replay_class="missing_symbol_breadth_probe",
                target_symbols=symbols,
                route_row=route_row,
                route_record=_find_by_symbol(route_records, symbol),
                account_label=account_label,
                trading_mode=trading_mode,
                proof_floor_receipt=proof_floor_receipt,
                live_submission_gate=live_submission_gate,
                empirical_jobs_status=empirical_jobs_status,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                jangar_contract_graduation_ref=jangar_contract_graduation_ref,
            )
        )

    seen: set[str] = set()
    unique_replays: list[dict[str, object]] = []
    for replay in replays:
        replay_id = _text(replay.get("replay_id"))
        if replay_id and replay_id not in seen:
            unique_replays.append(replay)
            seen.add(replay_id)
    return unique_replays


def _receipt_for_replay(
    *,
    replay: Mapping[str, Any],
    account_label: str | None,
    trading_mode: str,
    generated_at: str,
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> dict[str, object]:
    target_symbols = _string_list(replay.get("target_symbols"))
    blockers = _string_list(replay.get("remaining_blockers"))
    replay_id = _text(replay.get("replay_id"))
    replay_class = _text(replay.get("replay_class"))
    graduation_state: GraduationState
    if bool(replay.get("paper_probation_eligible")):
        graduation_state = "paper_replay_candidate"
    elif target_symbols or (
        replay_class
        in {
            _ALPHA_RUNTIME_REPLAY_CLASS,
            _RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS,
        }
        and replay.get("hypothesis_id")
    ):
        graduation_state = "candidate"
    else:
        graduation_state = "failed"
    receipt_id = "receipt:" + _stable_hash(
        "executable-alpha",
        {
            "replay_id": replay_id,
            "target_symbols": target_symbols,
            "generated_at": generated_at,
        },
    )
    return {
        "receipt_id": receipt_id,
        "replay_id": replay_id,
        "hypothesis_id": replay.get("hypothesis_id"),
        "candidate_id": replay.get("candidate_id"),
        "strategy_id": replay.get("strategy_id"),
        "account_label": account_label,
        "trading_mode": trading_mode,
        "target_symbols": target_symbols,
        "started_at": None,
        "completed_at": None,
        "before_refs": replay.get("before_refs"),
        "after_refs": {},
        "measured_delta": {
            "state": "not_run",
            "expected_profit_unlock": replay.get("expected_profit_unlock"),
            "blockers_retired": 0,
        },
        "guardrail_result": {
            "state": "blocked" if blockers else "pending",
            "passed": False,
            "reason_codes": blockers or ["awaiting_zero_notional_replay"],
        },
        "graduation_state": graduation_state,
        "paper_probation_eligible": bool(replay.get("paper_probation_eligible")),
        "paper_probation_scope": replay.get("paper_probation_scope"),
        "paper_probation_reason_codes": replay.get("paper_probation_reason_codes")
        or [],
        "paper_probation_target_capital_stage": replay.get(
            "paper_probation_target_capital_stage"
        ),
        "jangar_contract_graduation_ref": dict(jangar_contract_graduation_ref),
        "remaining_blockers": blockers,
        "capital_effect": replay.get("capital_effect"),
    }


def build_capital_replay_projection(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build the zero-notional replay board and candidate executable receipts.

    This projection is additive accounting only. It does not authorize paper or
    live submission; every initial replay item keeps max_notional at zero.
    """

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    generated_at = observed_at.isoformat()
    proof_window = _proof_window(
        now=observed_at,
        proof_floor_receipt=proof_floor_receipt,
        route_reacquisition_board=route_reacquisition_board,
    )
    replays = _candidate_replays(
        proof_floor_receipt=proof_floor_receipt,
        route_reacquisition_board=route_reacquisition_board,
        account_label=account_label,
        trading_mode=trading_mode,
        live_submission_gate=live_submission_gate,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        jangar_contract_graduation_ref=jangar_contract_graduation_ref,
    )
    blocked_surfaces = sorted(
        {
            blocker
            for replay in replays
            for blocker in _string_list(replay.get("remaining_blockers"))
        }
    )
    board_id = "capital-replay:" + _stable_hash(
        "capital-replay-board",
        {
            "account_label": account_label,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "proof_window": proof_window,
            "replay_ids": [_text(replay.get("replay_id")) for replay in replays],
        },
    )
    receipts = [
        _receipt_for_replay(
            replay=replay,
            account_label=account_label,
            trading_mode=trading_mode,
            generated_at=generated_at,
            jangar_contract_graduation_ref=jangar_contract_graduation_ref,
        )
        for replay in replays
    ]
    receipt_state_totals = Counter(
        _text(receipt.get("graduation_state"), "unknown") for receipt in receipts
    )
    paper_replay_candidate_count = sum(
        1 for replay in replays if bool(replay.get("paper_probation_eligible"))
    )
    board = {
        "schema_version": CAPITAL_REPLAY_BOARD_SCHEMA_VERSION,
        "board_id": board_id,
        "account_label": account_label,
        "trading_mode": trading_mode,
        "proof_window": proof_window,
        "torghut_revision": torghut_revision,
        "jangar_contract_graduation_ref": dict(jangar_contract_graduation_ref),
        "generated_at": generated_at,
        "fresh_until": proof_window["fresh_until"],
        "replay_items": replays,
        "selected_replays": [_text(replay.get("replay_id")) for replay in replays[:3]],
        "blocked_capital_surfaces": blocked_surfaces,
        "summary": {
            "replay_item_count": len(replays),
            "selected_replay_count": min(len(replays), 3),
            "zero_notional_replay_count": sum(
                1 for replay in replays if _text(replay.get("max_notional")) == "0"
            ),
            "paper_replay_candidate_count": paper_replay_candidate_count,
            "capital_ready": False,
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "replay_execution_enabled": False,
        },
    }
    return {
        "capital_replay_board": board,
        "executable_alpha_receipts": {
            "schema_version": EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION,
            "generated_at": generated_at,
            "summary": {
                "receipts_total": len(receipts),
                "graduation_state_totals": dict(sorted(receipt_state_totals.items())),
                "paper_replay_candidate_count": paper_replay_candidate_count,
                "zero_notional_receipt_count": len(receipts),
                "capital_ready": False,
            },
            "receipts": receipts,
        },
    }


__all__ = [
    "CAPITAL_REPLAY_BOARD_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION",
    "build_capital_replay_projection",
    "build_executable_alpha_repair_receipts",
    "build_executable_alpha_settlement_slots",
    "compact_executable_alpha_settlement_slots",
]
