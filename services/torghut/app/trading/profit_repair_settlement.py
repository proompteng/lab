"""Execution-trusted profit-repair settlement ledger projection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast


PROFIT_REPAIR_SETTLEMENT_LEDGER_SCHEMA_VERSION = (
    "torghut.profit-repair-settlement-ledger.v1"
)

_FRESHNESS_SECONDS = 60
_FORECAST_READY = {"ready", "shadow_ready", "disabled", "not_required"}
_JANGAR_ALLOW = {
    "allow",
    "allow_with_split",
    "approved",
    "current",
    "healthy",
    "ok",
    "pass",
}
_JANGAR_BAD_STATES = {"blocked", "degraded", "fail", "missing", "stale"}
_SCHEMA_REJECTION_FRAGMENTS = (
    "schema_lineage",
    "rejection_drag",
    "research_candidates",
    "research_promotions",
    "strategy_promotion_decisions",
    "vnext_promotion_decisions",
)
_NONBLOCKING_QUANT_HEALTH_REASONS = {
    "quant_health_not_configured",
}


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


def _float(value: object) -> float | None:
    parsed = _decimal(value)
    return None if parsed is None else float(parsed)


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


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:16]}"


def _rows(board: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [_mapping(row) for row in _sequence(board.get("rows"))]


def _cohorts(ledger: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [_mapping(cohort) for cohort in _sequence(ledger.get("cohorts"))]


def _cohort(
    cohorts: Sequence[Mapping[str, Any]], cohort_class: str
) -> Mapping[str, Any]:
    for cohort in cohorts:
        if _text(cohort.get("cohort_class")) == cohort_class:
            return cohort
    return {}


def _symbol(row: Mapping[str, Any]) -> str:
    return _text(row.get("symbol")).upper()


def _row_state(row: Mapping[str, Any]) -> str:
    return _text(row.get("state"), "unknown").lower()


def _symbols(rows: Sequence[Mapping[str, Any]], state: str) -> list[str]:
    return _unique([_symbol(row) for row in rows if _row_state(row) == state])


def _profit_lease_blockers(live_submission_gate: Mapping[str, Any]) -> list[str]:
    projection = _mapping(live_submission_gate.get("profit_lease_projection"))
    blockers = _strings(projection.get("blocking_reason_codes"))
    for lease in _sequence(projection.get("leases")):
        blockers.extend(_strings(_mapping(lease).get("blocking_reason_codes")))
    return _unique(blockers)


def _proof_blockers(proof_floor: Mapping[str, Any]) -> list[str]:
    blockers = _strings(proof_floor.get("blocking_reasons"))
    if _text(proof_floor.get("route_state")) == "repair_only":
        blockers.append("proof_floor_repair_only")
    if _text(proof_floor.get("capital_state")) == "zero_notional":
        blockers.append("capital_state_zero_notional")
    return _unique(blockers)


def _execution_trust_blockers(ref: Mapping[str, Any]) -> list[str]:
    decision = _text(
        ref.get("decision") or ref.get("state") or ref.get("status"), "missing"
    ).lower()
    state = _text(ref.get("state") or ref.get("status") or decision, "missing").lower()
    blockers = [
        *_strings(
            ref.get("reason_codes") or ref.get("blocking_reasons") or ref.get("reasons")
        ),
    ]
    if decision not in _JANGAR_ALLOW:
        blockers.append(f"jangar_execution_trust_{decision}")
    if state in _JANGAR_BAD_STATES and state != decision:
        blockers.append(f"jangar_execution_trust_{state}")
    return _unique(blockers)


def _quant_blockers(quant: Mapping[str, Any]) -> list[str]:
    blockers = [
        *_strings(quant.get("blocking_reasons")),
        *_strings(quant.get("non_promoting_receipts")),
    ]
    status = _text(quant.get("status") or quant.get("state")).lower()
    source_url = _text(quant.get("source_url") or quant.get("sourceUrl"))
    quant_counts_are_authoritative = (
        quant.get("required") is True
        or bool(source_url)
        or bool(blockers)
        or (bool(status) and status != "not_required")
    )
    if (
        quant_counts_are_authoritative
        and _int(quant.get("stage_count"), default=-1) == 0
    ):
        blockers.append("quant_pipeline_stages_missing")
    degraded_count = _int(
        quant.get("degraded_latest_metrics_count")
        or quant.get("latest_degraded_metrics_count")
        or quant.get("degradedMetricsCount")
    )
    if degraded_count > 0:
        blockers.append("quant_latest_metrics_degraded")
    if quant_counts_are_authoritative and quant.get("ok") is False and not blockers:
        blockers.append(_text(quant.get("reason"), "quant_health_degraded"))
    return _unique(
        [
            blocker
            for blocker in blockers
            if blocker not in _NONBLOCKING_QUANT_HEALTH_REASONS
        ]
    )


def _state(blockers: Sequence[str], *, paper_candidate: bool = False) -> str:
    if paper_candidate:
        return "paper_candidate"
    if any(reason.startswith("capital_safety_invariant") for reason in blockers):
        return "block"
    if blockers and all(
        reason.startswith("jangar_execution_trust") for reason in blockers
    ):
        return "hold"
    return "repair" if blockers else "observe"


def _paper_candidate_allowed(
    *,
    proof_floor: Mapping[str, Any],
    capital_reentry: Mapping[str, Any],
    quality_frontier: Mapping[str, Any],
    execution_trust_blockers: Sequence[str],
    hard_blockers: Sequence[str],
) -> bool:
    max_notional = _decimal(proof_floor.get("max_notional"))
    return (
        not execution_trust_blockers
        and not hard_blockers
        and _text(capital_reentry.get("aggregate_state")) == "paper_candidate"
        and _mapping(quality_frontier.get("summary")).get("capital_ready") is True
        and _text(proof_floor.get("route_state")) != "repair_only"
        and _text(proof_floor.get("capital_state"))
        in {"paper_allowed", "paper_candidate"}
        and max_notional is not None
        and max_notional > 0
    )


def _lot(
    *,
    account: str | None,
    trading_mode: str,
    lot_class: str,
    value_gate: str,
    expected_gate_delta: str,
    required_receipts: Sequence[str],
    blockers: Sequence[str],
    next_action: str,
    success_condition: str,
    rollback_trigger: str,
    symbols: Sequence[str] = (),
    hypotheses: Sequence[str] = (),
    paper_candidate: bool = False,
) -> dict[str, object]:
    normalized_symbols = sorted(
        {_text(symbol).upper() for symbol in symbols if _text(symbol)}
    )
    normalized_hypotheses = sorted({_text(item) for item in hypotheses if _text(item)})
    blocking_reason_codes = _unique(list(blockers))
    lot_id = _stable_ref(
        "profit-repair-lot",
        {
            "account": account,
            "trading_mode": trading_mode,
            "lot_class": lot_class,
            "symbols": normalized_symbols,
            "hypotheses": normalized_hypotheses,
            "blockers": blocking_reason_codes,
        },
    )
    return {
        "lot_id": lot_id,
        "lot_class": lot_class,
        "symbol_set": normalized_symbols,
        "hypothesis_ids": normalized_hypotheses,
        "current_state": _state(blocking_reason_codes, paper_candidate=paper_candidate),
        "value_gate": value_gate,
        "expected_gate_delta": expected_gate_delta,
        "required_receipts": list(required_receipts),
        "blocking_reason_codes": blocking_reason_codes,
        "next_repair_action": next_action,
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
        "success_condition": success_condition,
        "rollback_trigger": rollback_trigger,
    }


def _aggregate_state(lots: Sequence[Mapping[str, Any]]) -> str:
    states = {_text(lot.get("current_state")) for lot in lots}
    for state in ("block", "paper_candidate", "repair", "hold"):
        if state in states:
            return state
    return "observe"


def _fresh_until(receipt: Mapping[str, Any], generated_at: datetime) -> str:
    return _text(
        receipt.get("fresh_until"),
        (generated_at + timedelta(seconds=_FRESHNESS_SECONDS)).isoformat(),
    )


def build_profit_repair_settlement_ledger(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    jangar_execution_trust_admission_ref: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a zero-notional settlement ledger for execution-trusted repairs."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    generated_at = observed_at.isoformat()
    account = account_label or _text(proof_floor_receipt.get("account_label")) or None
    rows = _rows(route_reacquisition_board)
    cohorts = _cohorts(capital_reentry_cohort_ledger)
    execution_blockers = _execution_trust_blockers(jangar_execution_trust_admission_ref)
    proof_blockers = _proof_blockers(proof_floor_receipt)
    lease_blockers = _profit_lease_blockers(live_submission_gate)
    paper_candidate = _paper_candidate_allowed(
        proof_floor=proof_floor_receipt,
        capital_reentry=capital_reentry_cohort_ledger,
        quality_frontier=quality_adjusted_profit_frontier,
        execution_trust_blockers=execution_blockers,
        hard_blockers=[
            *_strings(consumer_evidence_receipt.get("reason_codes")),
            *proof_blockers,
        ],
    )

    forecast_state = _text(
        consumer_evidence_receipt.get("forecast_registry_state"), "unknown"
    )
    forecast_blockers = (
        []
        if forecast_state in _FORECAST_READY
        else [f"forecast_registry_{forecast_state}"]
    )
    forecast_blockers.extend(
        reason
        for reason in lease_blockers
        if "promotion" in reason or "research_" in reason
    )

    empty_row: Mapping[str, Any] = {}
    aapl_row = next((row for row in rows if _symbol(row) == "AAPL"), empty_row)
    receipt_cohort = _cohort(cohorts, "receipt_settlement")
    aapl_blockers = [
        *_strings(receipt_cohort.get("blocking_reason_codes")),
        *execution_blockers,
    ]
    if blocker := _text(aapl_row.get("current_blocker")):
        aapl_blockers.append(blocker)

    blocked_rows = [row for row in rows if _row_state(row) == "blocked"]
    route_tca_blockers = [_text(row.get("current_blocker")) for row in blocked_rows]
    for row in blocked_rows:
        observed = _float(row.get("avg_abs_slippage_bps"))
        guardrail = _float(row.get("slippage_guardrail_bps"))
        if observed is not None and guardrail is not None and observed > guardrail:
            route_tca_blockers.append("execution_tca_slippage_above_guardrail")

    missing_rows = [row for row in rows if _row_state(row) == "missing"]
    missing_tca_blockers = [
        _text(row.get("current_blocker"), "execution_tca_symbol_missing")
        for row in missing_rows
    ]
    schema_blockers = [
        reason
        for reason in [
            *proof_blockers,
            *lease_blockers,
            *_strings(quality_adjusted_profit_frontier.get("blocked_capital_surfaces")),
        ]
        if any(fragment in reason for fragment in _SCHEMA_REJECTION_FRAGMENTS)
    ]
    submit_blockers = [
        *_strings(live_submission_gate.get("blocked_reasons")),
        *_strings(live_submission_gate.get("blocking_reasons")),
        *proof_blockers,
    ]
    if (
        _text(live_submission_gate.get("reason"))
        and live_submission_gate.get("allowed") is not True
    ):
        submit_blockers.append(_text(live_submission_gate.get("reason")))
    max_notional = _decimal(proof_floor_receipt.get("max_notional"))
    if (
        _text(proof_floor_receipt.get("route_state")) == "repair_only"
        and max_notional is not None
        and max_notional > 0
    ):
        submit_blockers.append("capital_safety_invariant_repair_only_nonzero_notional")

    lots = [
        _lot(
            account=account,
            trading_mode=trading_mode,
            lot_class="quant_freshness",
            value_gate="zero_notional_or_stale_evidence_rate",
            expected_gate_delta="retire_scoped_quant_stage_staleness",
            required_receipts=[
                "scoped_quant_health_receipt",
                "quant_stage_lag_receipt",
            ],
            blockers=_quant_blockers(quant_evidence),
            next_action="refresh_scoped_quant_stage_materialization",
            success_condition="quant stage count is nonzero and no quant freshness blockers remain",
            rollback_trigger="quant freshness ledger grants paper/live notional while degraded",
            paper_candidate=paper_candidate,
        ),
        _lot(
            account=account,
            trading_mode=trading_mode,
            lot_class="forecast_registry",
            value_gate="routeable_candidate_count",
            expected_gate_delta="restore_one_forecast_eligible_paper_candidate",
            required_receipts=[
                "forecast_registry_eligible_model_receipt",
                "promotion_table_receipt",
                "consumer_evidence_receipt",
            ],
            blockers=forecast_blockers,
            next_action="restore_forecast_registry_and_promotion_table_evidence",
            success_condition="forecast registry is ready or shadow_ready for the active candidate",
            rollback_trigger="forecast repair bypasses alpha readiness or route TCA",
            paper_candidate=paper_candidate,
        ),
        _lot(
            account=account,
            trading_mode=trading_mode,
            lot_class="aapl_receipt_settlement",
            value_gate="routeable_candidate_count",
            expected_gate_delta="settle_aapl_from_probing_to_one_paper_candidate",
            required_receipts=[
                "fresh_market_context_receipt",
                "scoped_quant_health_receipt",
                "alpha_readiness_receipt",
                "forecast_registry_eligibility_receipt",
                "jangar_execution_trust_admission",
            ],
            blockers=aapl_blockers,
            next_action="settle_aapl_dependency_receipts_before_paper_canary",
            success_condition="AAPL has settled market, quant, alpha, forecast, route, and Jangar admission receipts",
            rollback_trigger="AAPL paper canary opens without settled Jangar execution trust",
            symbols=_strings(receipt_cohort.get("symbol_set")) or ["AAPL"],
            paper_candidate=paper_candidate,
        ),
        _lot(
            account=account,
            trading_mode=trading_mode,
            lot_class="route_tca",
            value_gate="fill_tca_or_slippage_quality",
            expected_gate_delta=f"repair_{len(blocked_rows)}_blocked_route_tca_symbols",
            required_receipts=[
                "fresh_execution_tca_receipt",
                "route_universe_recompute_receipt",
                "slippage_guardrail_receipt",
            ],
            blockers=route_tca_blockers,
            next_action="repair_high_activity_tca_before_candidate_state",
            success_condition="blocked high-activity symbols move to observed or probing inside slippage guardrail",
            rollback_trigger="route TCA lot loosens slippage thresholds without a zero-notional waiver",
            symbols=_symbols(blocked_rows, "blocked")[:4],
            paper_candidate=paper_candidate,
        ),
        _lot(
            account=account,
            trading_mode=trading_mode,
            lot_class="missing_tca",
            value_gate="fill_tca_or_slippage_quality",
            expected_gate_delta=f"create_tca_for_{len(missing_rows)}_missing_symbols",
            required_receipts=[
                "simulation_route_probe_receipt",
                "fresh_execution_tca_receipt",
            ],
            blockers=missing_tca_blockers,
            next_action="create_zero_notional_tca_probes_for_missing_symbols",
            success_condition="missing symbols have simulation or paperless TCA evidence before route ranking",
            rollback_trigger="missing TCA lot grants candidate state without execution TCA",
            symbols=_symbols(missing_rows, "missing"),
            paper_candidate=paper_candidate,
        ),
        _lot(
            account=account,
            trading_mode=trading_mode,
            lot_class="schema_lineage",
            value_gate="zero_notional_or_stale_evidence_rate",
            expected_gate_delta="retire_schema_lineage_and_rejection_drag_debt",
            required_receipts=["schema_lineage_receipt", "rejection_drag_measurement"],
            blockers=schema_blockers,
            next_action="publish_schema_lineage_and_rejection_drag_receipts",
            success_condition="schema lineage and rejection drag evidence are current for active lanes",
            rollback_trigger="schema or rejection-drag debt is hidden from repair settlement",
            paper_candidate=paper_candidate,
        ),
        _lot(
            account=account,
            trading_mode=trading_mode,
            lot_class="submit_enablement",
            value_gate="capital_gate_safety",
            expected_gate_delta="keep_submit_disabled_until_all_paper_gates_settle",
            required_receipts=[
                "live_submission_gate_receipt",
                "proof_floor_receipt",
                "capital_reentry_ledger",
            ],
            blockers=submit_blockers,
            next_action="keep_submit_disabled_until_settlement_lots_clear",
            success_condition="submit enablement opens only after proof floor and settlement lots allow paper",
            rollback_trigger="simple submit opens while proof floor is repair_only or max notional is zero",
            paper_candidate=paper_candidate,
        ),
    ]
    aggregate_blockers = _unique(
        [
            _text(reason)
            for lot in lots
            for reason in _sequence(lot.get("blocking_reason_codes"))
        ]
    )
    aggregate_state = _aggregate_state(lots)
    ledger_id = _stable_ref(
        "profit-repair-settlement-ledger",
        {
            "account": account,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "consumer_evidence_receipt_id": consumer_evidence_receipt.get("receipt_id"),
            "capital_reentry_ledger_ref": capital_reentry_cohort_ledger.get(
                "ledger_id"
            ),
            "quality_frontier_ref": quality_adjusted_profit_frontier.get("frontier_id"),
            "lot_ids": [_text(lot.get("lot_id")) for lot in lots],
            "aggregate_state": aggregate_state,
        },
    )
    return {
        "schema_version": PROFIT_REPAIR_SETTLEMENT_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at,
        "fresh_until": _fresh_until(consumer_evidence_receipt, observed_at),
        "account_label": account,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "jangar_execution_trust_admission_ref": dict(
            jangar_execution_trust_admission_ref
        ),
        "consumer_evidence_receipt_id": consumer_evidence_receipt.get("receipt_id"),
        "proof_floor_ref": _text(proof_floor_receipt.get("schema_version")),
        "capital_reentry_ledger_ref": capital_reentry_cohort_ledger.get("ledger_id"),
        "quality_frontier_ref": quality_adjusted_profit_frontier.get("frontier_id"),
        "repair_lots": lots,
        "aggregate_state": aggregate_state,
        "aggregate_blocking_reason_codes": aggregate_blockers,
        "next_safe_action": (
            "paper_candidate_review"
            if aggregate_state == "paper_candidate"
            else "zero_notional_repair"
            if aggregate_state == "repair"
            else "hold_capital"
            if aggregate_state in {"hold", "block"}
            else "observe"
        ),
        "summary": {
            "lot_count": len(lots),
            "zero_notional_lot_count": len(
                [
                    lot
                    for lot in lots
                    if _text(lot.get("paper_notional_limit")) == "0"
                    and _text(lot.get("live_notional_limit")) == "0"
                ]
            ),
            "repair_lot_count": sum(
                1 for lot in lots if _text(lot.get("current_state")) == "repair"
            ),
            "hold_lot_count": sum(
                1 for lot in lots if _text(lot.get("current_state")) == "hold"
            ),
            "paper_candidate_count": sum(
                1
                for lot in lots
                if _text(lot.get("current_state")) == "paper_candidate"
            ),
            "routeable_candidate_count": _int(
                _mapping(route_reacquisition_board.get("summary")).get(
                    "capital_eligible_symbol_count"
                )
            ),
            "quality_frontier_packet_count": len(
                _sequence(quality_adjusted_profit_frontier.get("packets"))
            ),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "profit_repair_settlement_consumption_enabled": False,
        },
    }


__all__ = [
    "PROFIT_REPAIR_SETTLEMENT_LEDGER_SCHEMA_VERSION",
    "build_profit_repair_settlement_ledger",
]
