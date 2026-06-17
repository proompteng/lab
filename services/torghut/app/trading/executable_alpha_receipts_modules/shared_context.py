# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Executable alpha receipt projection for zero-notional repair planning."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, cast

from ..runtime_ledger import POST_COST_PNL_BASIS

# ruff: noqa: F401,F811,F821


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


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
ALPHA_RUNTIME_REPAIR_REASONS = _ALPHA_RUNTIME_REPAIR_REASONS
ALPHA_RUNTIME_REPLAY_CLASS = _ALPHA_RUNTIME_REPLAY_CLASS
BREADTH_HYPOTHESIS = _BREADTH_HYPOTHESIS
CLOSED_SESSION_REPAIR_REASONS = _CLOSED_SESSION_REPAIR_REASONS
DEFAULT_FRESHNESS_SECONDS = _DEFAULT_FRESHNESS_SECONDS
EXECUTABLE_ALPHA_REPAIR_DESIGN_REF = _EXECUTABLE_ALPHA_REPAIR_DESIGN_REF
executable_alpha_repair_receipt = _executable_alpha_repair_receipt
EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET = _EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET
EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF = _EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF
EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET = (
    _EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET
)
expected_gate_delta = _expected_gate_delta
FEATURE_OR_DRIFT_REPAIR_REASONS = _FEATURE_OR_DRIFT_REPAIR_REASONS
find_by_symbol = _find_by_symbol
first_with_state = _first_with_state
float_value = _float
HARD_ALPHA_ECONOMIC_REASONS = _HARD_ALPHA_ECONOMIC_REASONS
int_value = _int
LIVE_AAPL_HYPOTHESIS = _LIVE_AAPL_HYPOTHESIS
mapping = _mapping
NO_DELTA_RELEASE_CONDITIONS = _NO_DELTA_RELEASE_CONDITIONS
POST_COST_REPAIR_REASONS = _POST_COST_REPAIR_REASONS
proof_window = _proof_window
reason_list_from_target = _reason_list_from_target
receipt_by_hypothesis = _receipt_by_hypothesis
receipt_revenue_lane_rank = _receipt_revenue_lane_rank
receipt_target_key = _receipt_target_key
repair_class_for_target = _repair_class_for_target
REPAIR_CLASS_RANK = _REPAIR_CLASS_RANK
REPAIR_REASON_CLASSES = _REPAIR_REASON_CLASSES
required_input_refs = _required_input_refs
route_board_rows = _route_board_rows
route_records = _route_records
RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS = _RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS
RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS = (
    _RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS
)
RUNTIME_LEDGER_PAPER_PROBATION_REASON = _RUNTIME_LEDGER_PAPER_PROBATION_REASON
sequence = _sequence
SIM_NVDA_HYPOTHESIS = _SIM_NVDA_HYPOTHESIS
stable_hash = _stable_hash
string_list = _string_list
targets_from_alpha_readiness = _targets_from_alpha_readiness
text = _text
top_alpha_repair = _top_alpha_repair
VALIDATION_COMMANDS_BY_CLASS = _VALIDATION_COMMANDS_BY_CLASS
ZERO_RUNTIME_EVIDENCE_REASONS = _ZERO_RUNTIME_EVIDENCE_REASONS
