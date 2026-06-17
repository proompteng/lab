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


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
alpha_runtime_blockers = _alpha_runtime_blockers
alpha_runtime_confidence = _alpha_runtime_confidence
alpha_runtime_repair_reason_codes = _alpha_runtime_repair_reason_codes
alpha_runtime_replay_item = _alpha_runtime_replay_item
alpha_runtime_replay_key = _alpha_runtime_replay_key
guardrails = _guardrails
live_gate_evaluated_hypotheses = _live_gate_evaluated_hypotheses
replay_item = _replay_item
required_after_refs = _required_after_refs
runtime_ledger_economic_repair_item = _runtime_ledger_economic_repair_item
runtime_ledger_paper_probation_eligible = _runtime_ledger_paper_probation_eligible
runtime_ledger_repair_candidates = _runtime_ledger_repair_candidates
runtime_ledger_repair_key = _runtime_ledger_repair_key
top_alpha_runtime_replay_target = _top_alpha_runtime_replay_target
top_runtime_ledger_economic_repair_candidate = (
    _top_runtime_ledger_economic_repair_candidate
)
