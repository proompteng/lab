"""Executable alpha receipt projection for zero-notional repair planning."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, cast

from ..runtime_ledger import POST_COST_PNL_BASIS


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

EXECUTABLE_ALPHA_REPAIR_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md"
)

EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF = (
    "docs/torghut/design-system/v6/"
    "199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md"
)

EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET = (
    "stop emitting executable_alpha_repair_receipts and keep Torghut max_notional=0"
)

EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET = (
    "stop emitting executable_alpha_settlement_slots and keep Torghut max_notional=0"
)

NO_DELTA_RELEASE_CONDITIONS = [
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

DEFAULT_FRESHNESS_SECONDS = 15 * 60

LIVE_AAPL_HYPOTHESIS = "H-AAPL-ROUTE-REHAB"

SIM_NVDA_HYPOTHESIS = "H-NVDA-SIM-PROOF-REFILL"

BREADTH_HYPOTHESIS = "H-MEGACAP-BREADTH-PROBE"

REPAIR_REASON_CLASSES = (
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

REPAIR_CLASS_RANK = {
    "strategy_lineage_repair": 0,
    "evidence_window_refresh": 1,
    "autoresearch_portfolio_repair": 2,
    "equity_ta_refill": 3,
    "rejection_drag_measurement": 4,
    "promotion_decision_receipt": 5,
    "capital_replay_board_refresh": 6,
}

VALIDATION_COMMANDS_BY_CLASS = {
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

FEATURE_OR_DRIFT_REPAIR_REASONS = {
    "drift_checks_missing",
    "feature_rows_missing",
    "required_feature_set_unavailable",
    "hypothesis_window_evidence_missing",
    "hypothesis_window_evidence_stale",
}

POST_COST_REPAIR_REASONS = {
    "post_cost_expectancy_non_positive",
    "post_cost_expectancy_missing",
}

CLOSED_SESSION_REPAIR_REASONS = {
    "closed_session_market_context_hold",
    "closed_session_signal_hold",
    "closed_session_tca_evidence_hold",
}

ALPHA_RUNTIME_REPLAY_CLASS = "alpha_runtime_window_refresh"

RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS = "runtime_ledger_economic_repair"

RUNTIME_LEDGER_PAPER_PROBATION_REASON = "runtime_ledger_stage_not_live"

RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS = {RUNTIME_LEDGER_PAPER_PROBATION_REASON}

ZERO_RUNTIME_EVIDENCE_REASONS = {
    "hypothesis_window_decisions_missing",
    "hypothesis_window_orders_missing",
    "hypothesis_window_trades_missing",
    "runtime_decision_count_zero",
    "runtime_order_count_zero",
    "runtime_trade_count_zero",
}

HARD_ALPHA_ECONOMIC_REASONS = {
    "post_cost_expectancy_below_manifest_threshold",
    "post_cost_expectancy_non_positive",
    "hypothesis_window_post_cost_expectancy_non_positive",
    "slippage_budget_exceeded",
}

ALPHA_RUNTIME_REPAIR_REASONS = {
    "hypothesis_window_evidence_stale",
    "hypothesis_window_evidence_missing",
    "sample_count_below_canary_minimum",
    "recent_slippage_budget_exceeded",
    "delay_adjusted_depth_stress_missing",
    "drift_checks_missing",
}


def text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def int_value(value: object, default: int = 0) -> int:
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


def float_value(value: object) -> float | None:
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


def mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def string_list(value: object) -> list[str]:
    return sorted(
        {normalized_text for item in sequence(value) if (normalized_text := text(item))}
    )


def stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def route_records(proof_floor_receipt: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    route_book = mapping(proof_floor_receipt.get("route_reacquisition_book"))
    return [mapping(item) for item in sequence(route_book.get("records"))]


def route_board_rows(
    route_reacquisition_board: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [mapping(item) for item in sequence(route_reacquisition_board.get("rows"))]


def find_by_symbol(
    items: Sequence[Mapping[str, Any]], symbol: str
) -> Mapping[str, Any]:
    wanted = symbol.upper()
    for item in items:
        if text(item.get("symbol")).upper() == wanted:
            return item
    return {}


def first_with_state(
    items: Sequence[Mapping[str, Any]], states: set[str]
) -> Mapping[str, Any]:
    for item in items:
        if text(item.get("state")) in states:
            return item
    return items[0] if items else {}


def proof_window(
    *,
    now: datetime,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
) -> dict[str, object]:
    generated_at = (
        text(proof_floor_receipt.get("generated_at"))
        or text(route_reacquisition_board.get("generated_at"))
        or now.isoformat()
    )
    fresh_until = (
        text(route_reacquisition_board.get("fresh_until"))
        or (now + timedelta(seconds=DEFAULT_FRESHNESS_SECONDS)).isoformat()
    )
    return {
        "generated_at": generated_at,
        "fresh_until": fresh_until,
        "route_state": text(proof_floor_receipt.get("route_state"), "unknown"),
        "capital_state": text(proof_floor_receipt.get("capital_state"), "unknown"),
    }


def reason_list_from_target(target: Mapping[str, Any]) -> list[str]:
    return string_list(target.get("reasons")) + string_list(
        target.get("informational_reasons")
    )


def repair_class_for_target(
    target: Mapping[str, Any],
) -> tuple[str, list[str], str, str, str]:
    reason_codes = reason_list_from_target(target)
    reason_set = set(reason_codes)
    candidate_id = text(target.get("candidate_id"))
    strategy_id = text(target.get("strategy_id"))

    if not candidate_id or not strategy_id:
        repair_class = "strategy_lineage_repair"
    else:
        repair_class = "capital_replay_board_refresh"
        for candidate_class, reasons in REPAIR_REASON_CLASSES:
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

    state = text(target.get("state"), "repair_only")
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


def top_alpha_repair(top_blocker: Mapping[str, Any]) -> bool:
    return (
        text(top_blocker.get("code")) == "repair_alpha_readiness"
        or text(top_blocker.get("reason")) == "alpha_readiness_not_promotion_eligible"
    )


def receipt_by_hypothesis(
    executable_alpha_receipts: Mapping[str, Any],
) -> dict[str, Mapping[str, Any]]:
    by_hypothesis: dict[str, Mapping[str, Any]] = {}
    for raw_receipt in [
        *sequence(executable_alpha_receipts.get("receipts")),
        *sequence(executable_alpha_receipts.get("candidate_receipts")),
    ]:
        receipt = mapping(raw_receipt)
        hypothesis_id = text(receipt.get("hypothesis_id"))
        if hypothesis_id and hypothesis_id not in by_hypothesis:
            by_hypothesis[hypothesis_id] = receipt
    return by_hypothesis


def targets_from_alpha_readiness(
    alpha_readiness: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    targets: list[Mapping[str, Any]] = [
        mapping(item) for item in sequence(alpha_readiness.get("repair_targets"))
    ]
    targets = [target for target in targets if target]
    if targets:
        return targets
    targets = []
    for raw_hypothesis_id in sequence(alpha_readiness.get("blocked_hypothesis_ids")):
        hypothesis_id = text(raw_hypothesis_id)
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


def expected_gate_delta(reason_codes: Sequence[str]) -> str:
    for reason in reason_codes:
        if reason:
            return f"retire_{reason}"
    return "retire_alpha_readiness_not_promotion_eligible"


def required_input_refs(
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
        ref_text = text(value)
        if ref_text:
            refs.append(ref_text)
    return string_list(refs)


def receipt_revenue_lane_rank(receipt: Mapping[str, Any]) -> int:
    reason_set = set(string_list(receipt.get("reason_codes")))
    if reason_set.intersection(FEATURE_OR_DRIFT_REPAIR_REASONS):
        return 0
    if reason_set.intersection(POST_COST_REPAIR_REASONS):
        return 2
    if reason_set.intersection(CLOSED_SESSION_REPAIR_REASONS):
        return 3
    return 1


def receipt_target_key(receipt: Mapping[str, Any]) -> tuple[int, int, str]:
    return (
        REPAIR_CLASS_RANK.get(text(receipt.get("repair_class")), 100),
        receipt_revenue_lane_rank(receipt),
        text(receipt.get("hypothesis_id")),
    )


def executable_alpha_repair_receipt(
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
    ) = repair_class_for_target(target)
    hypothesis_id = text(target.get("hypothesis_id"), "unknown")
    candidate_id = text(target.get("candidate_id")) or None
    strategy_id = text(target.get("strategy_id")) or None
    target_value_gate = text(top_blocker.get("value_gate"), "routeable_candidate_count")
    expected_unblock_value = int_value(top_blocker.get("expected_unblock_value"), 1)
    payload_for_id = {
        "schema_version": EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION,
        "source_revenue_repair_ref": source_revenue_repair_ref,
        "hypothesis_id": hypothesis_id,
        "repair_class": repair_class,
        "target_value_gate": target_value_gate,
        "reason_codes": reason_codes,
    }
    validation_commands = VALIDATION_COMMANDS_BY_CLASS.get(
        repair_class, VALIDATION_COMMANDS_BY_CLASS["capital_replay_board_refresh"]
    )
    required_output_receipts = string_list(
        [
            text(
                top_blocker.get("required_output_receipt"),
                EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION,
            ),
            *string_list(top_blocker.get("required_receipts")),
        ]
    )
    return {
        **payload_for_id,
        "receipt_id": "executable-alpha-repair-receipt:"
        + stable_hash("executable-alpha-repair-receipt", payload_for_id),
        "generated_at": generated_at.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "account_id": text(repair_bid_settlement_ledger.get("account_id"), "unknown"),
        "window": text(repair_bid_settlement_ledger.get("session_id"), "unknown"),
        "trading_mode": text(
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
        "expected_gate_delta": expected_gate_delta(reason_codes),
        "required_input_refs": required_input_refs(
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
            "governing_design_ref": EXECUTABLE_ALPHA_REPAIR_DESIGN_REF,
            "required_material_reentry_receipt": "jangar.material-reentry-receipt.v1",
            "action_class": "dispatch_repair",
            "max_parallelism": 1,
            "max_runtime_seconds": 1200,
            "value_gates": [target_value_gate],
            "rollback_target": "keep max_notional=0 and live submit disabled",
        },
        "rollback_target": EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET,
    }


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ALPHA_RUNTIME_REPAIR_REASONS",
    "ALPHA_RUNTIME_REPLAY_CLASS",
    "Any",
    "BREADTH_HYPOTHESIS",
    "CAPITAL_REPLAY_BOARD_SCHEMA_VERSION",
    "CLOSED_SESSION_REPAIR_REASONS",
    "Counter",
    "DEFAULT_FRESHNESS_SECONDS",
    "EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_REPAIR_DESIGN_REF",
    "EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET",
    "EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF",
    "EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION",
    "FEATURE_OR_DRIFT_REPAIR_REASONS",
    "GraduationState",
    "HARD_ALPHA_ECONOMIC_REASONS",
    "LIVE_AAPL_HYPOTHESIS",
    "Literal",
    "Mapping",
    "NO_DELTA_RELEASE_CONDITIONS",
    "POST_COST_PNL_BASIS",
    "POST_COST_REPAIR_REASONS",
    "REPAIR_CLASS_RANK",
    "REPAIR_REASON_CLASSES",
    "RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS",
    "RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS",
    "RUNTIME_LEDGER_PAPER_PROBATION_REASON",
    "SIM_NVDA_HYPOTHESIS",
    "Sequence",
    "VALIDATION_COMMANDS_BY_CLASS",
    "ZERO_RUNTIME_EVIDENCE_REASONS",
    "ALPHA_RUNTIME_REPAIR_REASONS",
    "ALPHA_RUNTIME_REPLAY_CLASS",
    "BREADTH_HYPOTHESIS",
    "CLOSED_SESSION_REPAIR_REASONS",
    "DEFAULT_FRESHNESS_SECONDS",
    "EXECUTABLE_ALPHA_REPAIR_DESIGN_REF",
    "EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET",
    "EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF",
    "EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET",
    "FEATURE_OR_DRIFT_REPAIR_REASONS",
    "HARD_ALPHA_ECONOMIC_REASONS",
    "LIVE_AAPL_HYPOTHESIS",
    "NO_DELTA_RELEASE_CONDITIONS",
    "POST_COST_REPAIR_REASONS",
    "REPAIR_CLASS_RANK",
    "REPAIR_REASON_CLASSES",
    "RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS",
    "RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS",
    "RUNTIME_LEDGER_PAPER_PROBATION_REASON",
    "SIM_NVDA_HYPOTHESIS",
    "VALIDATION_COMMANDS_BY_CLASS",
    "ZERO_RUNTIME_EVIDENCE_REASONS",
    "executable_alpha_repair_receipt",
    "expected_gate_delta",
    "find_by_symbol",
    "first_with_state",
    "float_value",
    "int_value",
    "mapping",
    "proof_window",
    "reason_list_from_target",
    "receipt_by_hypothesis",
    "receipt_revenue_lane_rank",
    "receipt_target_key",
    "repair_class_for_target",
    "required_input_refs",
    "route_board_rows",
    "route_records",
    "sequence",
    "stable_hash",
    "string_list",
    "targets_from_alpha_readiness",
    "text",
    "top_alpha_repair",
    "annotations",
    "cast",
    "datetime",
    "executable_alpha_repair_receipt",
    "expected_gate_delta",
    "find_by_symbol",
    "first_with_state",
    "float_value",
    "hashlib",
    "int_value",
    "json",
    "mapping",
    "proof_window",
    "reason_list_from_target",
    "receipt_by_hypothesis",
    "receipt_revenue_lane_rank",
    "receipt_target_key",
    "repair_class_for_target",
    "required_input_refs",
    "route_board_rows",
    "route_records",
    "sequence",
    "stable_hash",
    "string_list",
    "targets_from_alpha_readiness",
    "text",
    "timedelta",
    "timezone",
    "top_alpha_repair",
)
