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

from .shared_context import (
    CAPITAL_REPLAY_BOARD_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION,
    EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION,
    GraduationState,
    ALPHA_RUNTIME_REPAIR_REASONS as _ALPHA_RUNTIME_REPAIR_REASONS,
    ALPHA_RUNTIME_REPLAY_CLASS as _ALPHA_RUNTIME_REPLAY_CLASS,
    BREADTH_HYPOTHESIS as _BREADTH_HYPOTHESIS,
    CLOSED_SESSION_REPAIR_REASONS as _CLOSED_SESSION_REPAIR_REASONS,
    DEFAULT_FRESHNESS_SECONDS as _DEFAULT_FRESHNESS_SECONDS,
    EXECUTABLE_ALPHA_REPAIR_DESIGN_REF as _EXECUTABLE_ALPHA_REPAIR_DESIGN_REF,
    EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET as _EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET,
    EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF as _EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF,
    EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET as _EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET,
    FEATURE_OR_DRIFT_REPAIR_REASONS as _FEATURE_OR_DRIFT_REPAIR_REASONS,
    HARD_ALPHA_ECONOMIC_REASONS as _HARD_ALPHA_ECONOMIC_REASONS,
    LIVE_AAPL_HYPOTHESIS as _LIVE_AAPL_HYPOTHESIS,
    NO_DELTA_RELEASE_CONDITIONS as _NO_DELTA_RELEASE_CONDITIONS,
    POST_COST_REPAIR_REASONS as _POST_COST_REPAIR_REASONS,
    REPAIR_CLASS_RANK as _REPAIR_CLASS_RANK,
    REPAIR_REASON_CLASSES as _REPAIR_REASON_CLASSES,
    RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS as _RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS,
    RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS as _RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS,
    RUNTIME_LEDGER_PAPER_PROBATION_REASON as _RUNTIME_LEDGER_PAPER_PROBATION_REASON,
    SIM_NVDA_HYPOTHESIS as _SIM_NVDA_HYPOTHESIS,
    VALIDATION_COMMANDS_BY_CLASS as _VALIDATION_COMMANDS_BY_CLASS,
    ZERO_RUNTIME_EVIDENCE_REASONS as _ZERO_RUNTIME_EVIDENCE_REASONS,
    executable_alpha_repair_receipt as _executable_alpha_repair_receipt,
    expected_gate_delta as _expected_gate_delta,
    find_by_symbol as _find_by_symbol,
    first_with_state as _first_with_state,
    float_value as _float,
    int_value as _int,
    mapping as _mapping,
    proof_window as _proof_window,
    reason_list_from_target as _reason_list_from_target,
    receipt_by_hypothesis as _receipt_by_hypothesis,
    receipt_revenue_lane_rank as _receipt_revenue_lane_rank,
    receipt_target_key as _receipt_target_key,
    repair_class_for_target as _repair_class_for_target,
    required_input_refs as _required_input_refs,
    route_board_rows as _route_board_rows,
    route_records as _route_records,
    sequence as _sequence,
    stable_hash as _stable_hash,
    string_list as _string_list,
    targets_from_alpha_readiness as _targets_from_alpha_readiness,
    text as _text,
    top_alpha_repair as _top_alpha_repair,
)
from .build_executable_alpha_repair_receipts import (
    alpha_target_reason_codes as _alpha_target_reason_codes,
    before_refs as _before_refs,
    before_routeable_candidate_count as _before_routeable_candidate_count,
    build_executable_alpha_settlement_slot as _build_executable_alpha_settlement_slot,
    capital_blockers as _capital_blockers,
    empirical_blockers as _empirical_blockers,
    graduation_state as _graduation_state,
    market_context_blockers as _market_context_blockers,
    no_delta_debt_from_settlement_slot as _no_delta_debt_from_settlement_slot,
    parse_datetime as _parse_datetime,
    primary_remaining_blocker as _primary_remaining_blocker,
    quant_blockers as _quant_blockers,
    repair_receipt_reason_codes as _repair_receipt_reason_codes,
    required_after_receipts as _required_after_receipts,
    routeable_candidate_count_from_evidence as _routeable_candidate_count_from_evidence,
    selected_repair_receipt as _selected_repair_receipt,
    settlement_state as _settlement_state,
    tca_guardrail_blockers as _tca_guardrail_blockers,
    top_queue_item as _top_queue_item,
    zero_notional as _zero_notional,
    build_executable_alpha_repair_receipts,
    build_executable_alpha_settlement_slots,
    compact_executable_alpha_settlement_slots,
)
from .required_after_refs import (
    alpha_runtime_blockers as _alpha_runtime_blockers,
    alpha_runtime_confidence as _alpha_runtime_confidence,
    alpha_runtime_repair_reason_codes as _alpha_runtime_repair_reason_codes,
    alpha_runtime_replay_item as _alpha_runtime_replay_item,
    alpha_runtime_replay_key as _alpha_runtime_replay_key,
    guardrails as _guardrails,
    live_gate_evaluated_hypotheses as _live_gate_evaluated_hypotheses,
    replay_item as _replay_item,
    required_after_refs as _required_after_refs,
    runtime_ledger_economic_repair_item as _runtime_ledger_economic_repair_item,
    runtime_ledger_paper_probation_eligible as _runtime_ledger_paper_probation_eligible,
    runtime_ledger_repair_candidates as _runtime_ledger_repair_candidates,
    runtime_ledger_repair_key as _runtime_ledger_repair_key,
    top_alpha_runtime_replay_target as _top_alpha_runtime_replay_target,
    top_runtime_ledger_economic_repair_candidate as _top_runtime_ledger_economic_repair_candidate,
)


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


__all__ = ("build_capital_replay_projection",)
