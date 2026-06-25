"""Executable alpha receipt projection for zero-notional repair planning."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from ..runtime_ledger import POST_COST_PNL_BASIS


from .shared_context import (
    ALPHA_RUNTIME_REPLAY_CLASS as _ALPHA_RUNTIME_REPLAY_CLASS,
    HARD_ALPHA_ECONOMIC_REASONS as _HARD_ALPHA_ECONOMIC_REASONS,
    RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS as _RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS,
    RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS as _RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS,
    ZERO_RUNTIME_EVIDENCE_REASONS as _ZERO_RUNTIME_EVIDENCE_REASONS,
    float_value as _float,
    int_value as _int,
    mapping as _mapping,
    sequence as _sequence,
    stable_hash as _stable_hash,
    string_list as _string_list,
    text as _text,
)
from .build_executable_alpha_repair_receipts import (
    before_refs as _before_refs,
    capital_blockers as _capital_blockers,
    empirical_blockers as _empirical_blockers,
    graduation_state as _graduation_state,
    market_context_blockers as _market_context_blockers,
    quant_blockers as _quant_blockers,
)


def required_after_refs(replay_class: str) -> list[str]:
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


def guardrails(
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


def live_gate_evaluated_hypotheses(
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


def alpha_runtime_repair_reason_codes(item: Mapping[str, Any]) -> list[str]:
    reasons = _string_list(item.get("reason_codes"))
    if not reasons:
        reasons = _string_list(item.get("reasons"))
    return reasons


def alpha_runtime_replay_key(
    item: Mapping[str, Any],
) -> tuple[int, int, int, int, str]:
    reasons = set(alpha_runtime_repair_reason_codes(item))
    blocked_segments = len(_sequence(item.get("blocked_segments")))
    return (
        len(reasons.intersection(_ZERO_RUNTIME_EVIDENCE_REASONS)),
        len(reasons.intersection(_HARD_ALPHA_ECONOMIC_REASONS)),
        blocked_segments,
        len(reasons),
        _text(item.get("hypothesis_id")),
    )


def top_alpha_runtime_replay_target(
    live_submission_gate: Mapping[str, Any],
) -> Mapping[str, Any]:
    candidates = [
        item
        for item in live_gate_evaluated_hypotheses(live_submission_gate)
        if _text(item.get("hypothesis_id"))
    ]
    if not candidates:
        return {}
    return sorted(candidates, key=alpha_runtime_replay_key)[0]


def runtime_ledger_repair_candidates(
    live_submission_gate: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [
        _mapping(item)
        for item in _sequence(
            live_submission_gate.get("runtime_ledger_repair_candidates")
        )
        if _text(_mapping(item).get("hypothesis_id"))
    ]


def runtime_ledger_repair_key(
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


def top_runtime_ledger_economic_repair_candidate(
    live_submission_gate: Mapping[str, Any],
) -> Mapping[str, Any]:
    candidates = runtime_ledger_repair_candidates(live_submission_gate)
    if not candidates:
        return {}
    return sorted(candidates, key=runtime_ledger_repair_key, reverse=True)[0]


def alpha_runtime_confidence(item: Mapping[str, Any]) -> str:
    reasons = set(alpha_runtime_repair_reason_codes(item))
    if reasons.intersection(_ZERO_RUNTIME_EVIDENCE_REASONS):
        return "low"
    if reasons.intersection(_HARD_ALPHA_ECONOMIC_REASONS):
        return "low"
    return "medium"


def runtime_ledger_paper_probation_eligible(
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


def runtime_ledger_economic_repair_item(
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
    paper_probation_eligible = runtime_ledger_paper_probation_eligible(
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


def alpha_runtime_blockers(
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
    blockers.update(alpha_runtime_repair_reason_codes(item))
    blockers.update(_empirical_blockers(empirical_jobs_status))
    blockers.update(_quant_blockers(quant_evidence))
    blockers.update(_market_context_blockers(market_context_status))
    graduation_state, graduation_reasons = _graduation_state(
        jangar_contract_graduation_ref
    )
    if graduation_state != "current":
        blockers.update(graduation_reasons)
    return sorted(blocker for blocker in blockers if blocker)


def alpha_runtime_replay_item(
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
    reasons = alpha_runtime_repair_reason_codes(item)
    blockers = alpha_runtime_blockers(
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
        "confidence": alpha_runtime_confidence(item),
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


def replay_item(
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
        "required_after_refs": required_after_refs(replay_class),
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
        "guardrails": guardrails(route_record=route_record, blockers=blockers),
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
