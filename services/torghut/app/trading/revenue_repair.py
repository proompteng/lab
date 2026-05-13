#!/usr/bin/env python
"""Build a business-prioritized repair digest from Torghut readiness evidence."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


SCHEMA_VERSION = "torghut.revenue-repair-digest.v1"


_REPAIR_CATALOG: dict[str, tuple[str, str, str, int, int]] = {
    "alpha_readiness_not_promotion_eligible": (
        "repair_alpha_readiness",
        "alpha_readiness",
        "clear_hypothesis_blockers_before_capital",
        70,
        6,
    ),
    "execution_tca_stale": (
        "repair_execution_tca",
        "execution_tca",
        "refresh_execution_tca_settlement",
        65,
        3,
    ),
    "execution_tca_missing": (
        "repair_execution_tca",
        "execution_tca",
        "restore_execution_tca_settlement",
        68,
        4,
    ),
    "execution_tca_slippage_guardrail_exceeded": (
        "repair_execution_quality",
        "execution_tca",
        "reduce_execution_slippage_before_promotion",
        75,
        5,
    ),
    "execution_tca_route_universe_empty": (
        "repair_route_universe",
        "route_universe",
        "produce_executable_route_universe_before_capital",
        78,
        6,
    ),
    "execution_tca_route_universe_incomplete": (
        "repair_route_universe",
        "route_universe",
        "settle_missing_symbol_tca_before_promotion",
        76,
        4,
    ),
    "quant_pipeline_degraded": (
        "repair_quant_ingestion",
        "quant_ingestion",
        "settle_quant_pipeline_stage_lag",
        60,
        2,
    ),
    "quant_health_degraded": (
        "repair_quant_ingestion",
        "quant_ingestion",
        "restore_quant_health_receipts",
        58,
        2,
    ),
    "quant_health_fetch_failed": (
        "repair_quant_ingestion",
        "quant_ingestion",
        "restore_quant_health_route",
        58,
        2,
    ),
    "quant_latest_metrics_empty": (
        "repair_quant_ingestion",
        "quant_ingestion",
        "backfill_quant_latest_metrics",
        57,
        2,
    ),
    "simple_submit_disabled": (
        "live_submit_gate_closed",
        "live_submission_gate",
        "keep_submit_disabled_until_proof_floor_passes",
        50,
        1,
    ),
    "insufficient_buying_power": (
        "repair_buying_power",
        "capital_account",
        "settle_account_buying_power_or_downsize_orders",
        55,
        2,
    ),
}

_NON_ACTIONABLE_DEPENDENCY_DETAILS = {
    "candidate",
    "healthy",
    "ok",
    "ready",
    "repair_only",
    "unknown",
}


def _catalog(reason: str) -> dict[str, object]:
    row = _REPAIR_CATALOG.get(reason)
    if row is None:
        return {}
    code, dimension, action, priority, expected_unblock_value = row
    return {
        "code": code,
        "dimension": dimension,
        "action": action,
        "priority": priority,
        "expected_unblock_value": expected_unblock_value,
    }


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {
            "1",
            "true",
            "yes",
            "on",
            "allow",
            "allowed",
            "ok",
            "healthy",
        }:
            return True
        if normalized in {"0", "false", "no", "off", "deny", "blocked", "degraded"}:
            return False
    return default


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def _mapping(value: object) -> dict[str, Any]:
    if isinstance(value, Mapping):
        payload = cast(Mapping[object, object], value)
        return {str(key): item for key, item in payload.items()}
    return {}


def _sequence(value: object) -> list[object]:
    if isinstance(value, list):
        return list(cast(list[object], value))
    if isinstance(value, tuple):
        return list(cast(tuple[object, ...], value))
    return []


def _string_items(value: object) -> list[str]:
    items: list[str] = []
    for item in _sequence(value):
        text = _text(item)
        if text:
            items.append(text)
    return items


def _dedupe(items: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for item in items:
        normalized = item.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def _load_json_object(path: Path, *, field_name: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name}_json_invalid") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{field_name}_payload_invalid")
    return cast(dict[str, Any], payload)


def _choose_mapping(*values: object) -> dict[str, Any]:
    for value in values:
        payload = _mapping(value)
        if payload:
            return payload
    return {}


def _collect_reason_counts(status_payload: Mapping[str, Any]) -> dict[str, int]:
    totals: dict[str, int] = {}
    raw_totals = _mapping(status_payload.get("simple_lane_reject_reason_totals"))
    for reason, count in raw_totals.items():
        normalized = _text(reason)
        if normalized:
            totals[normalized] = totals.get(normalized, 0) + _int(count, 1)
    return totals


def _collect_blocking_reasons(
    readyz_payload: Mapping[str, Any],
    status_payload: Mapping[str, Any],
) -> list[str]:
    proof_floor = _choose_mapping(
        status_payload.get("proof_floor"), readyz_payload.get("proof_floor")
    )
    live_submission_gate = _choose_mapping(
        status_payload.get("live_submission_gate"),
        readyz_payload.get("live_submission_gate"),
    )
    quant_evidence = _choose_mapping(
        status_payload.get("quant_evidence"), readyz_payload.get("quant_evidence")
    )
    reasons = _string_items(proof_floor.get("blocking_reasons"))
    reasons.extend(_string_items(live_submission_gate.get("blocked_reasons")))
    reasons.extend(_string_items(quant_evidence.get("blocking_reasons")))

    quant_ok = _bool(quant_evidence.get("ok"), default=True)
    quant_reason = _text(quant_evidence.get("reason"))
    quant_status = _text(quant_evidence.get("status")).lower()
    if not quant_ok and quant_reason:
        reasons.append(quant_reason)
    elif (
        quant_status
        and quant_status not in {"ok", "healthy", "pass", "not_required"}
        and quant_reason
    ):
        reasons.append(quant_reason)

    dependencies = _mapping(readyz_payload.get("dependencies"))
    for name, raw_dependency in dependencies.items():
        dependency = _mapping(raw_dependency)
        if dependency and not _bool(dependency.get("ok"), default=True):
            detail = _text(dependency.get("detail"), _text(name))
            if detail and detail not in _NON_ACTIONABLE_DEPENDENCY_DETAILS:
                reasons.append(detail)

    reason_counts = _collect_reason_counts(status_payload)
    reasons.extend(reason_counts.keys())
    return _dedupe(reasons)


def _repair_from_ladder_item(
    item: Mapping[str, Any],
    *,
    proof_floor_repair_only: bool,
) -> dict[str, object]:
    reason = _text(item.get("reason"), _text(item.get("code"), "unknown"))
    catalog = _catalog(reason)
    code = _text(
        item.get("code"),
        _text(catalog.get("code"), f"repair_{reason}"),
    )
    priority = _int(item.get("priority"), _int(catalog.get("priority"), 40))
    expected_unblock_value = _int(
        item.get("expected_unblock_value"),
        _int(catalog.get("expected_unblock_value"), 1),
    )
    action = _text(
        item.get("action"),
        _text(catalog.get("action"), "investigate_blocker"),
    )
    dimension = _text(
        item.get("dimension"),
        _text(catalog.get("dimension"), "unknown"),
    )
    if proof_floor_repair_only and code == "live_submit_gate_closed":
        priority = min(priority, 50)
        action = "keep_submit_disabled_until_evidence_repairs_pass"
    return {
        "code": code,
        "reason": reason,
        "dimension": dimension,
        "action": action,
        "priority": priority,
        "expected_unblock_value": max(1, expected_unblock_value),
        "source": "proof_floor.repair_ladder",
    }


def _repair_from_reason(
    reason: str,
    *,
    count: int,
    proof_floor_repair_only: bool,
) -> dict[str, object]:
    catalog = _catalog(reason)
    code = _text(catalog.get("code"), f"repair_{reason}")
    priority = _int(catalog.get("priority"), 40)
    action = _text(catalog.get("action"), "investigate_blocker")
    if proof_floor_repair_only and code == "live_submit_gate_closed":
        priority = min(priority, 50)
        action = "keep_submit_disabled_until_evidence_repairs_pass"
    return {
        "code": code,
        "reason": reason,
        "dimension": _text(catalog.get("dimension"), "unknown"),
        "action": action,
        "priority": priority,
        "expected_unblock_value": max(
            1, _int(catalog.get("expected_unblock_value"), count)
        ),
        "source": "derived.blocking_reason",
        "observed_count": max(1, count),
    }


def _build_repair_queue(
    proof_floor: Mapping[str, Any],
    status_payload: Mapping[str, Any],
    blocking_reasons: Sequence[str],
) -> list[dict[str, object]]:
    proof_floor_repair_only = _text(proof_floor.get("route_state")) == "repair_only"
    blocking_reason_set = set(blocking_reasons)
    repairs_by_code: dict[str, dict[str, object]] = {}
    for raw_item in _sequence(proof_floor.get("repair_ladder")):
        item = _mapping(raw_item)
        if not item:
            continue
        item_reason = _text(item.get("reason"), _text(item.get("code")))
        if item_reason and item_reason not in blocking_reason_set:
            continue
        repair = _repair_from_ladder_item(
            item, proof_floor_repair_only=proof_floor_repair_only
        )
        repairs_by_code[_text(repair.get("code"))] = repair

    reason_counts = _collect_reason_counts(status_payload)
    for reason in blocking_reasons:
        if not reason:
            continue
        repair = _repair_from_reason(
            reason,
            count=reason_counts.get(reason, 1),
            proof_floor_repair_only=proof_floor_repair_only,
        )
        code = _text(repair.get("code"))
        existing = repairs_by_code.get(code)
        if existing is None:
            repairs_by_code[code] = repair
            continue
        existing["observed_count"] = max(
            _int(existing.get("observed_count"), 1),
            _int(repair.get("observed_count"), 1),
        )

    return sorted(
        repairs_by_code.values(),
        key=lambda item: (
            -_int(item.get("priority")),
            -_int(item.get("expected_unblock_value")),
            _text(item.get("code")),
        ),
    )


def _summarize_alpha(
    status_payload: Mapping[str, Any], proof_floor: Mapping[str, Any]
) -> dict[str, object]:
    alpha = _mapping(status_payload.get("alpha_readiness"))
    summary = _mapping(alpha.get("summary"))
    if not summary:
        for raw_dimension in _sequence(proof_floor.get("proof_dimensions")):
            dimension = _mapping(raw_dimension)
            if _text(dimension.get("dimension")) != "alpha_readiness":
                continue
            source_ref = _mapping(dimension.get("source_ref"))
            summary = {
                "promotion_eligible_total": source_ref.get("promotion_eligible_total"),
                "rollback_required_total": source_ref.get("rollback_required_total"),
                "state_totals": source_ref.get("state_totals"),
            }
            break
    return {
        "promotion_eligible_total": _int(summary.get("promotion_eligible_total")),
        "rollback_required_total": _int(summary.get("rollback_required_total")),
        "state_totals": _mapping(summary.get("state_totals")),
    }


def _summarize_tca(proof_floor: Mapping[str, Any]) -> dict[str, object]:
    for raw_dimension in _sequence(proof_floor.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) != "execution_tca":
            continue
        source_ref = _mapping(dimension.get("source_ref"))
        summary: dict[str, object] = {
            "state": _text(dimension.get("state"), "unknown"),
            "reason": _text(dimension.get("reason"), "unknown"),
            "order_count": _int(source_ref.get("order_count")),
            "last_computed_at": source_ref.get("last_computed_at"),
            "filled_execution_count": _int(source_ref.get("filled_execution_count")),
            "latest_execution_created_at": source_ref.get(
                "latest_execution_created_at"
            ),
            "unsettled_execution_count": _int(
                source_ref.get("unsettled_execution_count")
            ),
            "freshness_seconds": dimension.get("freshness_seconds"),
            "threshold_seconds": dimension.get("threshold_seconds"),
            "avg_abs_slippage_bps": source_ref.get("avg_abs_slippage_bps"),
            "slippage_guardrail_bps": source_ref.get("slippage_guardrail_bps"),
        }
        symbol_routes = _mapping(source_ref.get("symbol_routes"))
        if symbol_routes:
            summary["symbol_routes"] = symbol_routes
        aggregate_reason = _text(source_ref.get("aggregate_reason"))
        if aggregate_reason:
            summary["aggregate_reason"] = aggregate_reason
        return summary
    return {
        "state": "unknown",
        "reason": "missing",
        "order_count": 0,
        "last_computed_at": None,
        "freshness_seconds": None,
        "threshold_seconds": None,
        "avg_abs_slippage_bps": None,
    }


def _summarize_route_reacquisition(
    status_payload: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    route_book = _choose_mapping(
        status_payload.get("route_reacquisition_book"),
        proof_floor.get("route_reacquisition_book"),
    )
    summary = _mapping(route_book.get("summary"))
    return {
        "schema_version": _text(route_book.get("schema_version"), "missing"),
        "state": _text(route_book.get("state"), "unknown"),
        "capital_rule": _text(route_book.get("capital_rule"), "unknown"),
        "routeable_symbol_count": _int(summary.get("routeable_symbol_count")),
        "probing_symbol_count": _int(summary.get("probing_symbol_count")),
        "blocked_symbol_count": _int(summary.get("blocked_symbol_count")),
        "missing_symbol_count": _int(summary.get("missing_symbol_count")),
        "candidate_symbols": _string_items(summary.get("candidate_symbols")),
        "repair_candidate_count": _int(summary.get("repair_candidate_count")),
        "repair_candidate_symbols": _string_items(
            summary.get("repair_candidate_symbols")
        ),
        "repair_candidates": [
            _mapping(item) for item in _sequence(summary.get("repair_candidates"))
        ],
        "expected_unblock_value": _int(summary.get("expected_unblock_value")),
    }


def _summarize_routeability_acceptance(
    routeability_ledger: Mapping[str, Any],
) -> dict[str, object]:
    if not routeability_ledger:
        return {
            "ledger_id": None,
            "aggregate_state": "missing",
            "accepted_routeable_candidate_count": 0,
            "zero_notional_or_stale_evidence_rate": 1,
            "blocking_reason_codes": ["routeability_acceptance_ledger_missing"],
        }
    return {
        "ledger_id": routeability_ledger.get("ledger_id"),
        "aggregate_state": _text(routeability_ledger.get("aggregate_state"), "unknown"),
        "accepted_routeable_candidate_count": _int(
            routeability_ledger.get("accepted_routeable_candidate_count")
        ),
        "zero_notional_or_stale_evidence_rate": routeability_ledger.get(
            "zero_notional_or_stale_evidence_rate"
        ),
        "blocking_reason_codes": _string_items(
            routeability_ledger.get("aggregate_blocking_reason_codes")
        ),
    }


def _summarize_route_evidence_clearinghouse(
    clearinghouse_packet: Mapping[str, Any],
) -> dict[str, object]:
    selected_repair_bids = _sequence(clearinghouse_packet.get("selected_repair_bids"))
    return {
        "packet_id": clearinghouse_packet.get("packet_id"),
        "schema_version": clearinghouse_packet.get("schema_version"),
        "capital_decision": _text(
            clearinghouse_packet.get("capital_decision"), "missing"
        ),
        "accepted_routeable_candidate_count": _int(
            clearinghouse_packet.get("accepted_routeable_candidate_count")
        ),
        "zero_notional_or_stale_evidence_rate": clearinghouse_packet.get(
            "zero_notional_or_stale_evidence_rate", 1
        ),
        "selected_repair_bid_count": len(selected_repair_bids),
        "held_action_classes": _string_items(
            clearinghouse_packet.get("held_action_classes")
        )
        or ["paper_canary", "live_micro_canary", "live_scale"],
        "summary": _mapping(clearinghouse_packet.get("summary")),
    }


def _business_state(
    *,
    revenue_ready: bool,
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> str:
    if revenue_ready:
        return "revenue_candidate"
    route_state = _text(proof_floor.get("route_state"))
    capital_state = _text(proof_floor.get("capital_state"))
    gate_allowed = _bool(live_submission_gate.get("allowed"))
    if route_state == "repair_only" or capital_state == "zero_notional":
        return "repair_only"
    if not gate_allowed:
        return "capital_blocked"
    return "not_revenue_ready"


def build_revenue_repair_digest(
    *,
    readyz_payload: Mapping[str, Any],
    status_payload: Mapping[str, Any],
    generated_at: datetime | None = None,
) -> dict[str, object]:
    generated = generated_at or datetime.now(timezone.utc)
    if generated.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated.astimezone(timezone.utc)

    proof_floor = _choose_mapping(
        status_payload.get("proof_floor"), readyz_payload.get("proof_floor")
    )
    live_submission_gate = _choose_mapping(
        status_payload.get("live_submission_gate"),
        readyz_payload.get("live_submission_gate"),
    )
    quant_evidence = _choose_mapping(
        status_payload.get("quant_evidence"), readyz_payload.get("quant_evidence")
    )
    routeability_ledger = _choose_mapping(
        status_payload.get("routeability_repair_acceptance_ledger"),
        readyz_payload.get("routeability_repair_acceptance_ledger"),
    )
    route_evidence_clearinghouse = _choose_mapping(
        status_payload.get("route_evidence_clearinghouse_packet"),
        readyz_payload.get("route_evidence_clearinghouse_packet"),
    )
    dependencies = _mapping(readyz_payload.get("dependencies"))
    blocking_reasons = _collect_blocking_reasons(readyz_payload, status_payload)
    repair_queue = _build_repair_queue(proof_floor, status_payload, blocking_reasons)

    readyz_status = _text(readyz_payload.get("status"), "unknown")
    readiness_ok = readyz_status in {"ok", "healthy"}
    proof_floor_route_state = _text(proof_floor.get("route_state"), "unknown")
    capital_state = _text(proof_floor.get("capital_state"), "unknown")
    max_notional = _text(proof_floor.get("max_notional"), "0")
    live_gate_allowed = _bool(live_submission_gate.get("allowed"))
    alpha = _summarize_alpha(status_payload, proof_floor)
    revenue_ready = (
        readiness_ok
        and live_gate_allowed
        and proof_floor_route_state not in {"repair_only", "unknown"}
        and capital_state not in {"zero_notional", "unknown"}
        and max_notional not in {"0", "0.0", "0.00"}
        and _int(alpha.get("promotion_eligible_total")) > 0
        and not blocking_reasons
    )

    build = _mapping(status_payload.get("build"))
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated.isoformat(),
        "routeability_repair_acceptance_ledger_id": routeability_ledger.get(
            "ledger_id"
        ),
        "route_evidence_clearinghouse_packet": dict(route_evidence_clearinghouse),
        "business_state": _business_state(
            revenue_ready=revenue_ready,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
        ),
        "revenue_ready": revenue_ready,
        "health": {
            "readyz_status": readyz_status,
            "readyz_ok": readiness_ok,
            "mode": _text(status_payload.get("mode"), "unknown"),
            "pipeline_mode": _text(status_payload.get("pipeline_mode"), "unknown"),
            "active_revision": _text(
                build.get("active_revision"), _text(build.get("commit"), "unknown")
            ),
            "dependency_failures": [
                {
                    "name": name,
                    "detail": _text(_mapping(raw_dependency).get("detail"), "unknown"),
                }
                for name, raw_dependency in dependencies.items()
                if _mapping(raw_dependency)
                and not _bool(_mapping(raw_dependency).get("ok"), default=True)
            ],
        },
        "capital": {
            "live_submission_allowed": live_gate_allowed,
            "live_submission_reason": _text(
                live_submission_gate.get("reason"), "unknown"
            ),
            "configured_live_promotion": _bool(
                live_submission_gate.get("configured_live_promotion")
            ),
            "capital_stage": _text(
                live_submission_gate.get("capital_stage"), "unknown"
            ),
            "proof_floor_state": _text(proof_floor.get("floor_state"), "unknown"),
            "route_state": proof_floor_route_state,
            "capital_state": capital_state,
            "max_notional": max_notional,
        },
        "evidence": {
            "alpha_readiness": alpha,
            "quant_evidence": {
                "ok": _bool(quant_evidence.get("ok"), default=True),
                "status": _text(quant_evidence.get("status"), "unknown"),
                "reason": _text(quant_evidence.get("reason"), "unknown"),
                "max_stage_lag_seconds": quant_evidence.get("max_stage_lag_seconds"),
                "blocking_reasons": _string_items(
                    quant_evidence.get("blocking_reasons")
                ),
            },
            "execution_tca": _summarize_tca(proof_floor),
            "route_reacquisition": _summarize_route_reacquisition(
                status_payload, proof_floor
            ),
            "routeability_acceptance": _summarize_routeability_acceptance(
                routeability_ledger
            ),
            "route_evidence_clearinghouse": _summarize_route_evidence_clearinghouse(
                route_evidence_clearinghouse
            ),
            "simple_lane_reject_reason_totals": _collect_reason_counts(status_payload),
        },
        "blockers": [{"reason": reason} for reason in blocking_reasons],
        "repair_queue": repair_queue,
        "operating_rule": (
            "keep_live_submit_disabled_until_repair_queue_clears"
            if repair_queue and not revenue_ready
            else "eligible_for_guarded_revenue_verification"
        ),
    }


def _parse_generated_at(raw: str | None) -> datetime | None:
    if raw is None:
        return None
    normalized = raw.strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    return parsed.astimezone(timezone.utc)


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a Torghut revenue-repair digest from saved /readyz and /trading/status JSON payloads.",
    )
    parser.add_argument(
        "--readyz-json",
        required=True,
        type=Path,
        help="Path to a Torghut /readyz JSON payload.",
    )
    parser.add_argument(
        "--status-json",
        required=True,
        type=Path,
        help="Path to a Torghut /trading/status JSON payload.",
    )
    parser.add_argument(
        "--generated-at", help="Optional ISO-8601 timestamp for deterministic output."
    )
    parser.add_argument(
        "--output", type=Path, help="Optional output path. Defaults to stdout."
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        digest = build_revenue_repair_digest(
            readyz_payload=_load_json_object(args.readyz_json, field_name="readyz"),
            status_payload=_load_json_object(args.status_json, field_name="status"),
            generated_at=_parse_generated_at(args.generated_at),
        )
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    serialized = json.dumps(digest, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.write_text(f"{serialized}\n", encoding="utf-8")
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
