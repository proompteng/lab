"""Profit-signal quorum projection for hypothesis-local repair admission."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

from .market_context_domains import (
    active_market_context_reasons,
    is_active_market_context_domain,
)


PROFIT_SIGNAL_QUORUM_SCHEMA_VERSION = "torghut.profit-signal-quorum.v1"

_FRESHNESS_SECONDS = 60
_BAD_STATES = set("blocked degraded down error fail failed missing stale".split())
_ALLOW_DECISIONS = {"allow", "allowed", "approved", "current", "ok", "pass"}
_REPAIR_DECISIONS = {*_ALLOW_DECISIONS, "dispatch_repair", "repair", "repair_only"}
_ROUTE_REPAIR_STATES = {"blocked", "missing", "probing"}
_REJECTION_DRAG_FRAGMENTS = ("rejection_drag", "schema_lineage")
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
    normalized = str(value).strip()
    return normalized or default


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


def _first(source: Mapping[str, Any], *keys: str, default: str = "") -> str:
    for key in keys:
        if value := _text(source.get(key)):
            return value
    return default


def _first_value(source: Mapping[str, Any], *keys: str) -> object:
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return None


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _signal(
    *,
    state: str,
    reason_codes: Sequence[str] = (),
    evidence_ref: object = None,
    details: Mapping[str, object] | None = None,
) -> dict[str, object]:
    return {
        "state": state,
        "reason_codes": _unique(list(reason_codes)),
        "evidence_ref": evidence_ref,
        "details": dict(details or {}),
    }


def _quant_reason_codes(quant: Mapping[str, Any]) -> list[str]:
    reasons = [
        *_strings(quant.get("blocking_reasons")),
        *_strings(quant.get("non_promoting_receipts")),
    ]
    status = _first(quant, "status", "state", default="unknown").lower()
    if quant.get("ok") is False:
        reasons.append(_text(quant.get("reason"), "quant_health_degraded"))
    if status in _BAD_STATES:
        reasons.append(f"quant_status_{status}")
    latest_count = _int(
        _first_value(quant, "latest_metrics_count", "latestMetricsCount"),
        default=-1,
    )
    if latest_count == 0:
        reasons.append("quant_latest_metrics_empty")
    elif latest_count < 0 and quant.get("ok") is not True:
        reasons.append("quant_latest_metrics_missing")
    degraded_count = _int(
        _first_value(
            quant,
            "degraded_latest_metrics_count",
            "latest_degraded_metrics_count",
            "degradedMetricsCount",
        )
    )
    if degraded_count > 0:
        reasons.append("quant_latest_metrics_degraded")
    return _unique(
        [
            reason
            for reason in reasons
            if reason not in _NONBLOCKING_QUANT_HEALTH_REASONS
        ]
    )


def _quant_signal(quant: Mapping[str, Any]) -> dict[str, object]:
    reasons = _quant_reason_codes(quant)
    latest_count = _int(
        _first_value(quant, "latest_metrics_count", "latestMetricsCount"),
        default=-1,
    )
    return _signal(
        state="fresh" if not reasons else "degraded",
        reason_codes=reasons,
        evidence_ref=_first(quant, "receipt_id", "source_url", "sourceUrl") or None,
        details={
            "latest_metrics_count": latest_count if latest_count >= 0 else None,
            "window": quant.get("window"),
            "required": quant.get("required"),
        },
    )


def _stage_rows(quant: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    for key in ("pipeline_stages", "pipelineStages", "stage_rows", "stages"):
        for row in _sequence(quant.get(key)):
            mapped = _mapping(row)
            if mapped:
                rows.append(mapped)
    return rows


def _pipeline_signal(quant: Mapping[str, Any]) -> dict[str, object]:
    reasons: list[str] = []
    stage_count = _int(
        _first_value(quant, "stage_count", "stageCount"),
        default=-1,
    )
    if stage_count == 0:
        reasons.append("quant_pipeline_stages_missing")
    for reason in _quant_reason_codes(quant):
        if (
            "pipeline" in reason
            or "stage" in reason
            or "ingestion" in reason
            or "materialization" in reason
        ):
            reasons.append(reason)
    for row in _stage_rows(quant):
        stage = _first(
            row, "stage", "name", "pipeline_stage", default="unknown"
        ).lower()
        status = _first(row, "status", "state", default="unknown").lower()
        ok = row.get("ok")
        if ok is False or status in _BAD_STATES:
            reasons.append(f"quant_pipeline_stage_{stage}_degraded")
        lag_seconds = _int(
            row.get("lag_seconds")
            or row.get("lagSeconds")
            or row.get("max_lag_seconds"),
            default=-1,
        )
        max_lag_seconds = _int(
            row.get("max_allowed_lag_seconds") or row.get("maxLagSeconds"),
            default=-1,
        )
        if lag_seconds >= 0 and max_lag_seconds >= 0 and lag_seconds > max_lag_seconds:
            reasons.append(f"quant_pipeline_stage_{stage}_stale")
    for key, reason in (
        ("ingestion_ok", "quant_pipeline_stage_ingestion_degraded"),
        ("materialization_ok", "quant_pipeline_stage_materialization_degraded"),
        ("compute_ok", "quant_pipeline_stage_compute_degraded"),
    ):
        if quant.get(key) is False:
            reasons.append(reason)
    return _signal(
        state="fresh" if not reasons else "degraded",
        reason_codes=reasons,
        evidence_ref=_first(quant, "pipeline_receipt_id", "source_url", "sourceUrl")
        or None,
        details={"stage_count": stage_count if stage_count >= 0 else None},
    )


def _market_context_signal(market: Mapping[str, Any]) -> dict[str, object]:
    reasons: list[str] = []
    state = _first(
        market, "overall_state", "overallState", "state", "status", default="unknown"
    ).lower()
    if state in _BAD_STATES:
        reasons.append(f"market_context_route_{state}")
    if market.get("alert_active") is True:
        reasons.append(_text(market.get("alert_reason"), "market_context_alert_active"))
    if _int(market.get("stale_snapshot_count")) > 0:
        reasons.append("market_context_snapshot_stale")
    if active_market_context_reasons(_strings(market.get("risk_flags"))):
        reasons.append("market_context_risk_flags")
    for domain_name, raw_domain in _mapping(market.get("domains")).items():
        if not is_active_market_context_domain(domain_name):
            continue
        domain = _mapping(raw_domain)
        domain_state = _first(domain, "state", "status", default="unknown").lower()
        if domain_state in _BAD_STATES:
            reasons.append(f"market_context_domain_{domain_name}_{domain_state}")
    return _signal(
        state="fresh" if not reasons else "degraded",
        reason_codes=reasons,
        evidence_ref=_first(
            market, "receipt_id", "bundle_id", "source_url", "sourceUrl"
        )
        or None,
        details={"overall_state": state},
    )


def _hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        _mapping(item)
        for item in _sequence(hypothesis_payload.get("items"))
        if _mapping(item)
    ]


def _hypothesis_id(item: Mapping[str, Any]) -> str:
    return _first(item, "hypothesis_id", "hypothesisId", "id", default="global")


def _hypothesis_lineage_signal(item: Mapping[str, Any]) -> dict[str, object]:
    candidate_id = _first(item, "candidate_id", "candidateId")
    strategy_id = _first(item, "strategy_id", "strategyId")
    dataset_ref = _first(
        item, "dataset_snapshot_ref", "datasetSnapshotRef", "dataset_ref"
    )
    reasons: list[str] = []
    item_reasons = _strings(item.get("reasons"))
    reasons.extend(reason for reason in item_reasons if "lineage" in reason)
    if not candidate_id:
        reasons.append("hypothesis_candidate_id_missing")
    if not strategy_id:
        reasons.append("hypothesis_strategy_id_missing")
    return _signal(
        state="present" if not reasons else "missing",
        reason_codes=reasons,
        evidence_ref=candidate_id or strategy_id or dataset_ref or None,
        details={
            "candidate_id": candidate_id or None,
            "strategy_id": strategy_id or None,
            "dataset_ref": dataset_ref or None,
            "lane_id": item.get("lane_id"),
            "strategy_family": item.get("strategy_family"),
        },
    )


def _promotion_signal(item: Mapping[str, Any]) -> dict[str, object]:
    reasons: list[str] = []
    promotion_ref = _first(
        item,
        "promotion_decision_id",
        "promotion_decision_ref",
        "promotionDecisionId",
        "promotionDecisionRef",
    )
    if item.get("promotion_eligible") is not True:
        reasons.append("hypothesis_not_promotion_eligible")
        reasons.extend(_strings(item.get("reasons")))
    if not promotion_ref:
        reasons.append("promotion_decision_missing")
    return _signal(
        state="present" if not reasons else "missing",
        reason_codes=reasons,
        evidence_ref=promotion_ref or None,
        details={
            "promotion_eligible": item.get("promotion_eligible"),
            "rollback_required": item.get("rollback_required"),
            "capital_stage": item.get("capital_stage"),
        },
    )


def _route_rows_for_hypothesis(
    route_reacquisition_board: Mapping[str, Any],
    hypothesis_id: str,
) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    for row in _sequence(route_reacquisition_board.get("rows")):
        mapped = _mapping(row)
        if not mapped:
            continue
        hypothesis_ids = set(_strings(mapped.get("hypothesis_ids")))
        if hypothesis_id in hypothesis_ids:
            rows.append(mapped)
    return rows


def _route_tca_signal(
    item: Mapping[str, Any],
    *,
    route_reacquisition_board: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_id = _hypothesis_id(item)
    rows = _route_rows_for_hypothesis(route_reacquisition_board, hypothesis_id)
    observed = _mapping(item.get("observed"))
    reasons: list[str] = []
    symbols: list[str] = []
    if rows:
        for row in rows:
            symbol = _text(row.get("symbol")).upper()
            if symbol:
                symbols.append(symbol)
            state = _text(row.get("state"), "unknown").lower()
            if state in _ROUTE_REPAIR_STATES:
                reasons.append(_text(row.get("current_blocker"), f"route_tca_{state}"))
            observed_slippage = _float(row.get("avg_abs_slippage_bps"))
            guardrail = _float(row.get("slippage_guardrail_bps"))
            if (
                observed_slippage is not None
                and guardrail is not None
                and observed_slippage > guardrail
            ):
                reasons.append("execution_tca_slippage_above_guardrail")
    else:
        tca_order_count = _int(observed.get("tca_order_count"), default=-1)
        if tca_order_count <= 0:
            reasons.append("route_tca_missing")
        symbols.extend(_strings(observed.get("route_tca_symbols")))
    for reason in _strings(item.get("reasons")):
        if (
            "route" in reason
            or "tca" in reason
            or "slippage" in reason
            or "sample_count" in reason
        ):
            reasons.append(reason)
    return _signal(
        state="present" if not reasons else "missing" if not rows else "degraded",
        reason_codes=reasons,
        evidence_ref=route_reacquisition_board.get("jangar_broker_ref")
        or route_reacquisition_board.get("jangar_continuity_epoch_id"),
        details={
            "symbols": _unique(symbols),
            "row_count": len(rows),
            "tca_order_count": observed.get("tca_order_count"),
            "avg_abs_slippage_bps": observed.get("avg_abs_slippage_bps"),
            "post_cost_expectancy_bps_proxy": observed.get(
                "post_cost_expectancy_bps_proxy"
            ),
        },
    )


def _profit_lease_blockers(live_submission_gate: Mapping[str, Any]) -> list[str]:
    projection = _mapping(live_submission_gate.get("profit_lease_projection"))
    blockers = _strings(projection.get("blocking_reason_codes"))
    for lease in _sequence(projection.get("leases")):
        blockers.extend(_strings(_mapping(lease).get("blocking_reason_codes")))
    return _unique(blockers)


def _rejection_drag_signal(
    *,
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    blockers = [
        reason
        for reason in [
            *_strings(proof_floor_receipt.get("blocking_reasons")),
            *_profit_lease_blockers(live_submission_gate),
        ]
        if any(fragment in reason for fragment in _REJECTION_DRAG_FRAGMENTS)
    ]
    return _signal(
        state="present" if not blockers else "missing",
        reason_codes=blockers,
        evidence_ref=proof_floor_receipt.get("schema_version"),
        details={},
    )


def _stage_clearance_signal(packet: Mapping[str, Any]) -> dict[str, object]:
    packet_id = _first(packet, "packet_id", "stage_clearance_packet_id", "id")
    decision = _first(packet, "decision", "state", "status", default="missing").lower()
    reasons = [
        *_strings(packet.get("reason_codes")),
        *_strings(packet.get("blocking_reasons")),
        *_strings(packet.get("reasons")),
    ]
    if not packet_id:
        reasons.append("stage_clearance_packet_missing")
    elif decision not in _REPAIR_DECISIONS:
        reasons.append(f"stage_clearance_{decision}")
    return _signal(
        state="fresh" if not reasons else "missing" if not packet_id else "degraded",
        reason_codes=reasons,
        evidence_ref=packet_id or None,
        details={
            "decision": decision,
            "action_class": packet.get("action_class"),
            "fresh_until": packet.get("fresh_until"),
            "source": packet.get("source"),
        },
    )


def _stage_allows_repair(stage_signal: Mapping[str, Any]) -> bool:
    if _text(stage_signal.get("state")) == "missing":
        return False
    details = _mapping(stage_signal.get("details"))
    decision = _text(details.get("decision"), "missing").lower()
    return decision in _REPAIR_DECISIONS


def _required_repair_action(
    signals: Mapping[str, Mapping[str, Any]],
    blockers: Sequence[str],
) -> str:
    if "stage_clearance_packet_missing" in blockers:
        return "publish_current_torghut_stage_clearance_packet"
    if _strings(signals["route_tca_signal"].get("reason_codes")):
        return "repair_route_tca_or_route_routability"
    if _strings(signals["pipeline_signal"].get("reason_codes")):
        return "refresh_scoped_quant_pipeline_stages"
    if _strings(signals["quant_signal"].get("reason_codes")):
        return "refresh_scoped_quant_latest_metrics"
    if _strings(signals["market_context_signal"].get("reason_codes")):
        return "repair_market_context_route_or_domain_freshness"
    if _strings(signals["hypothesis_lineage_signal"].get("reason_codes")):
        return "publish_hypothesis_candidate_and_strategy_lineage"
    if _strings(signals["promotion_signal"].get("reason_codes")):
        return "publish_current_promotion_decision_evidence"
    if _strings(signals["rejection_drag_signal"].get("reason_codes")):
        return "publish_rejection_drag_and_schema_lineage_receipts"
    return "observe"


def _quorum_decision(
    *,
    blockers: Sequence[str],
    route_signal: Mapping[str, Any],
    stage_signal: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> str:
    route_state = _text(route_signal.get("state"))
    stage_state = _text(stage_signal.get("state"))
    if route_state == "missing" or stage_state == "missing":
        return "observe_only"
    if blockers:
        return "repair_only" if _stage_allows_repair(stage_signal) else "observe_only"
    if live_submission_gate.get("allowed") is True:
        return "paper_canary"
    return "paper_candidate"


def _build_quorum(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    generated_at: str,
    item: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    torghut_stage_clearance_packet: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_id = _hypothesis_id(item)
    signals: dict[str, Mapping[str, Any]] = {
        "quant_signal": _quant_signal(quant_evidence),
        "pipeline_signal": _pipeline_signal(quant_evidence),
        "market_context_signal": _market_context_signal(market_context_status),
        "hypothesis_lineage_signal": _hypothesis_lineage_signal(item),
        "promotion_signal": _promotion_signal(item),
        "route_tca_signal": _route_tca_signal(
            item,
            route_reacquisition_board=route_reacquisition_board,
        ),
        "rejection_drag_signal": _rejection_drag_signal(
            proof_floor_receipt=proof_floor_receipt,
            live_submission_gate=live_submission_gate,
        ),
        "torghut_stage_clearance_signal": _stage_clearance_signal(
            torghut_stage_clearance_packet
        ),
    }
    blockers = _unique(
        [
            reason
            for signal in signals.values()
            for reason in _strings(signal.get("reason_codes"))
        ]
    )
    decision = _quorum_decision(
        blockers=blockers,
        route_signal=signals["route_tca_signal"],
        stage_signal=signals["torghut_stage_clearance_signal"],
        live_submission_gate=live_submission_gate,
    )
    observed = _mapping(item.get("observed"))
    window = {
        "source": "hypothesis_runtime_status",
        "market_session_open": observed.get("market_session_open"),
        "tca_last_computed_at": observed.get("tca_last_computed_at"),
        "evidence_age_minutes": observed.get("evidence_age_minutes"),
    }
    quorum_id = _stable_ref(
        "profit-signal-quorum",
        {
            "account_label": account_label,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "generated_at": generated_at,
            "hypothesis_id": hypothesis_id,
            "decision": decision,
            "blockers": blockers,
        },
    )
    return {
        "quorum_id": quorum_id,
        "generated_at": generated_at,
        "account": account_label,
        "hypothesis_id": hypothesis_id,
        "candidate_id": _first(item, "candidate_id", "candidateId") or None,
        "strategy_id": _first(item, "strategy_id", "strategyId") or None,
        "lane_id": item.get("lane_id"),
        "strategy_family": item.get("strategy_family"),
        "window": window,
        "torghut_stage_clearance_packet_id": signals[
            "torghut_stage_clearance_signal"
        ].get("evidence_ref"),
        **signals,
        "decision": decision,
        "reason_codes": blockers,
        "required_repair_action": _required_repair_action(signals, blockers),
        "max_notional": "0",
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "profit_signal_quorum_id": quorum_id,
        },
    }


def _aggregate_decision(quorums: Sequence[Mapping[str, Any]]) -> str:
    decisions = {_text(quorum.get("decision")) for quorum in quorums}
    for decision in ("paper_canary", "paper_candidate", "repair_only", "observe_only"):
        if decision in decisions:
            return decision
    return "observe_only"


def build_profit_signal_quorum(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    torghut_stage_clearance_packet: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a shadow profit-signal quorum without widening notional authority."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    generated_at = observed_at.isoformat()
    items = _hypothesis_items(hypothesis_payload)
    quorums = [
        _build_quorum(
            account_label=account_label,
            trading_mode=trading_mode,
            torghut_revision=torghut_revision,
            generated_at=generated_at,
            item=item,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            proof_floor_receipt=proof_floor_receipt,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            torghut_stage_clearance_packet=torghut_stage_clearance_packet,
        )
        for item in items
    ]
    aggregate_decision = _aggregate_decision(quorums)
    aggregate_reasons = _unique(
        [
            reason
            for quorum in quorums
            for reason in _strings(quorum.get("reason_codes"))
        ]
    )
    if not quorums:
        aggregate_reasons.append("hypothesis_registry_empty")
    decision_counts = Counter(_text(quorum.get("decision")) for quorum in quorums)
    quorum_id = _stable_ref(
        "profit-signal-quorum-ledger",
        {
            "account_label": account_label,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "generated_at": generated_at,
            "quorum_ids": [_text(quorum.get("quorum_id")) for quorum in quorums],
            "aggregate_decision": aggregate_decision,
        },
    )
    return {
        "schema_version": PROFIT_SIGNAL_QUORUM_SCHEMA_VERSION,
        "quorum_set_id": quorum_id,
        "generated_at": generated_at,
        "fresh_until": (
            observed_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account_label": account_label,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "torghut_stage_clearance_packet": dict(torghut_stage_clearance_packet),
        "aggregate_decision": aggregate_decision,
        "aggregate_reason_codes": aggregate_reasons,
        "quorums": quorums,
        "summary": {
            "quorum_count": len(quorums),
            "decision_counts": dict(sorted(decision_counts.items())),
            "zero_notional_quorum_count": len(quorums),
            "paper_candidate_count": decision_counts.get("paper_candidate", 0)
            + decision_counts.get("paper_canary", 0),
            "routeable_candidate_count": decision_counts.get("paper_candidate", 0)
            + decision_counts.get("paper_canary", 0),
            "blocked_or_stale_evidence_count": len(aggregate_reasons),
            "value_gates": [
                "routeable_candidate_count",
                "zero_notional_or_stale_evidence_rate",
                "fill_tca_or_slippage_quality",
                "capital_gate_safety",
            ],
        },
        "max_notional": "0",
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
        "capital_rule": "shadow_only_no_notional_until_full_quorum_and_external_capital_gate",
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "profit_signal_quorum_consumption_enabled": False,
        },
    }


__all__ = [
    "PROFIT_SIGNAL_QUORUM_SCHEMA_VERSION",
    "build_profit_signal_quorum",
]
