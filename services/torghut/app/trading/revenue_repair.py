#!/usr/bin/env python
"""Build a business-prioritized repair digest from Torghut readiness evidence."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from .alpha_readiness_strike_ledger import build_alpha_readiness_strike_ledger
from .alpha_evidence_foundry import build_alpha_evidence_foundry
from .alpha_readiness_settlement_conveyor import (
    build_alpha_readiness_settlement_conveyor,
)
from .alpha_repair_dividend_ledger import build_alpha_repair_dividend_ledger
from .alpha_repair_closure_board import build_alpha_repair_closure_board
from .executable_alpha_receipts import (
    build_executable_alpha_repair_receipts,
    build_executable_alpha_settlement_slots,
)
from .jangar_controller_ingestion_carry import (
    build_jangar_controller_ingestion_carry,
)
from .no_delta_repair_reentry_auction import (
    build_no_delta_repair_reentry_auction,
)


SCHEMA_VERSION = "torghut.revenue-repair-digest.v1"


_REPAIR_CATALOG: dict[str, tuple[str, str, str, int, int]] = {
    "alpha_readiness_not_promotion_eligible": (
        "repair_alpha_readiness",
        "alpha_readiness",
        "clear_hypothesis_blockers_before_capital",
        70,
        6,
    ),
    "runtime_ledger_source_collection_pending": (
        "repair_source_runtime_window_import",
        "runtime_window_import",
        "import_source_collection_runtime_ledger_window_before_alpha_promotion",
        74,
        7,
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

_REPAIR_METADATA: dict[str, dict[str, object]] = {
    "alpha_readiness_not_promotion_eligible": {
        "value_gate": "routeable_candidate_count",
        "required_output_receipt": "torghut.executable-alpha-receipts.v1",
        "required_receipts": [
            "alpha_readiness_receipt",
            "hypothesis_promotion_receipt",
            "capital_replay_board",
        ],
    },
    "runtime_ledger_source_collection_pending": {
        "value_gate": "routeable_candidate_count",
        "required_output_receipt": "torghut.runtime-window-import-readback.v1",
        "required_receipts": [
            "runtime_ledger_paper_probation_import_plan",
            "source_runtime_window_import_plan",
            "runtime_window_import_readback",
        ],
    },
    "execution_tca_stale": {
        "value_gate": "fill_tca_or_slippage_quality",
        "required_output_receipt": "torghut.execution-tca-current-receipt.v1",
        "required_receipts": [
            "execution_tca_receipt",
            "slippage_guardrail_receipt",
        ],
    },
    "execution_tca_missing": {
        "value_gate": "fill_tca_or_slippage_quality",
        "required_output_receipt": "torghut.execution-tca-current-receipt.v1",
        "required_receipts": [
            "execution_tca_receipt",
            "route_universe_receipt",
        ],
    },
    "execution_tca_slippage_guardrail_exceeded": {
        "value_gate": "fill_tca_or_slippage_quality",
        "required_output_receipt": "torghut.execution-tca-current-receipt.v1",
        "required_receipts": [
            "execution_tca_receipt",
            "slippage_guardrail_receipt",
        ],
    },
    "execution_tca_route_universe_empty": {
        "value_gate": "routeable_candidate_count",
        "required_output_receipt": "torghut.route-universe-repair-receipt.v1",
        "required_receipts": [
            "route_universe_receipt",
            "execution_tca_receipt",
        ],
    },
    "execution_tca_route_universe_incomplete": {
        "value_gate": "routeable_candidate_count",
        "required_output_receipt": "torghut.route-universe-repair-receipt.v1",
        "required_receipts": [
            "route_universe_receipt",
            "execution_tca_receipt",
        ],
    },
    "quant_pipeline_degraded": {
        "value_gate": "zero_notional_or_stale_evidence_rate",
        "required_output_receipt": "torghut.quant-pipeline-current-receipt.v1",
        "required_receipts": [
            "scoped_quant_health_receipt",
            "quant_pipeline_stage_receipt",
        ],
    },
    "quant_health_degraded": {
        "value_gate": "zero_notional_or_stale_evidence_rate",
        "required_output_receipt": "torghut.quant-pipeline-current-receipt.v1",
        "required_receipts": [
            "scoped_quant_health_receipt",
            "quant_pipeline_stage_receipt",
        ],
    },
    "quant_health_fetch_failed": {
        "value_gate": "zero_notional_or_stale_evidence_rate",
        "required_output_receipt": "torghut.quant-pipeline-current-receipt.v1",
        "required_receipts": [
            "scoped_quant_health_receipt",
            "quant_pipeline_stage_receipt",
        ],
    },
    "quant_latest_metrics_empty": {
        "value_gate": "zero_notional_or_stale_evidence_rate",
        "required_output_receipt": "torghut.quant-pipeline-current-receipt.v1",
        "required_receipts": [
            "scoped_quant_health_receipt",
            "quant_pipeline_stage_receipt",
        ],
    },
    "simple_submit_disabled": {
        "value_gate": "capital_gate_safety",
        "required_output_receipt": "torghut.capital-hold-repair-receipt.v1",
        "required_receipts": [
            "profitability_proof_floor_receipt",
            "routeability_acceptance_receipt",
        ],
    },
    "insufficient_buying_power": {
        "value_gate": "capital_gate_safety",
        "required_output_receipt": "torghut.capital-account-repair-receipt.v1",
        "required_receipts": ["capital_account_receipt"],
    },
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


def _repair_metadata(reason: str) -> dict[str, object]:
    metadata = dict(_REPAIR_METADATA.get(reason, {}))
    metadata.setdefault("max_notional", "0")
    metadata.setdefault("capital_rule", "zero_notional_repair_only")
    return metadata


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
        **_repair_metadata(reason),
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
        **_repair_metadata(reason),
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


def _summarize_alpha_replay_items(
    capital_replay_board: Mapping[str, Any],
) -> list[dict[str, object]]:
    replays: list[dict[str, object]] = []
    for raw_replay in _sequence(capital_replay_board.get("replay_items"))[:3]:
        replay = _mapping(raw_replay)
        if not replay:
            continue
        replays.append(
            {
                "replay_id": replay.get("replay_id"),
                "hypothesis_id": replay.get("hypothesis_id"),
                "replay_class": replay.get("replay_class"),
                "target_symbols": _string_items(replay.get("target_symbols")),
                "remaining_blockers": _string_items(replay.get("remaining_blockers")),
                "required_after_refs": _string_items(replay.get("required_after_refs")),
                "max_notional": _text(replay.get("max_notional"), "0"),
            }
        )
    return replays


def _summarize_executable_alpha_receipts(
    executable_alpha_receipts: Mapping[str, Any],
) -> list[dict[str, object]]:
    receipts: list[dict[str, object]] = []
    for raw_receipt in _sequence(executable_alpha_receipts.get("receipts"))[:3]:
        receipt = _mapping(raw_receipt)
        if not receipt:
            continue
        guardrail = _mapping(receipt.get("guardrail_result"))
        capital_effect = _mapping(receipt.get("capital_effect"))
        receipts.append(
            {
                "receipt_id": receipt.get("receipt_id"),
                "replay_id": receipt.get("replay_id"),
                "hypothesis_id": receipt.get("hypothesis_id"),
                "graduation_state": _text(receipt.get("graduation_state")),
                "remaining_blockers": _string_items(receipt.get("remaining_blockers")),
                "guardrail_state": _text(guardrail.get("state")),
                "guardrail_passed": _bool(guardrail.get("passed")),
                "capital_state": _text(capital_effect.get("capital_state")),
                "max_notional": _text(capital_effect.get("max_notional"), "0"),
            }
        )
    return receipts


def _summarize_alpha_repair_targets(
    alpha_source: Mapping[str, Any],
) -> list[dict[str, object]]:
    targets: list[dict[str, object]] = []
    for raw_target in _sequence(alpha_source.get("repair_targets"))[:5]:
        target = _mapping(raw_target)
        if not target:
            continue
        payload: dict[str, object] = {
            "hypothesis_id": _text(target.get("hypothesis_id")),
            "state": _text(target.get("state"), "unknown"),
            "promotion_eligible": _bool(target.get("promotion_eligible")),
            "reasons": _string_items(target.get("reasons")),
            "informational_reasons": _string_items(target.get("informational_reasons")),
        }
        for key in ("candidate_id", "strategy_id", "lane_id", "strategy_family"):
            value = _text(target.get(key))
            if value:
                payload[key] = value
        targets.append(payload)
    return targets


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
            summary = dict(source_ref)
            break
    alpha_summary: dict[str, object] = {
        "promotion_eligible_total": _int(summary.get("promotion_eligible_total")),
        "rollback_required_total": _int(summary.get("rollback_required_total")),
        "state_totals": _mapping(summary.get("state_totals")),
        "hypothesis_ids": _string_items(summary.get("hypothesis_ids")),
        "blocked_hypothesis_ids": _string_items(summary.get("blocked_hypothesis_ids")),
        "promotion_eligible_hypothesis_ids": _string_items(
            summary.get("promotion_eligible_hypothesis_ids")
        ),
        "repair_target_count": _int(summary.get("repair_target_count")),
        "blocked_repair_target_count": _int(summary.get("blocked_repair_target_count")),
        "promotion_eligible_repair_target_count": _int(
            summary.get("promotion_eligible_repair_target_count")
        ),
        "repair_targets": _summarize_alpha_repair_targets(summary),
    }
    capital_replay_board = _mapping(status_payload.get("capital_replay_board"))
    if capital_replay_board:
        board_summary = _mapping(capital_replay_board.get("summary"))
        alpha_summary["capital_replay_board"] = {
            "schema_version": capital_replay_board.get("schema_version"),
            "board_id": capital_replay_board.get("board_id"),
            "selected_replay_count": _int(
                board_summary.get("selected_replay_count"),
                len(_sequence(capital_replay_board.get("selected_replays"))),
            ),
            "zero_notional_replay_count": _int(
                board_summary.get("zero_notional_replay_count")
            ),
            "paper_replay_candidate_count": _int(
                board_summary.get("paper_replay_candidate_count")
            ),
            "capital_ready": _bool(board_summary.get("capital_ready")),
            "selected_replays": _string_items(
                capital_replay_board.get("selected_replays")
            ),
            "top_zero_notional_replays": _summarize_alpha_replay_items(
                capital_replay_board
            ),
        }
    executable_alpha_receipts = _mapping(
        status_payload.get("executable_alpha_receipts")
    )
    if executable_alpha_receipts:
        receipt_summary = _mapping(executable_alpha_receipts.get("summary"))
        alpha_summary["executable_alpha_receipts"] = {
            "schema_version": executable_alpha_receipts.get("schema_version"),
            "generated_at": executable_alpha_receipts.get("generated_at"),
            "receipts_total": _int(receipt_summary.get("receipts_total")),
            "zero_notional_receipt_count": _int(
                receipt_summary.get("zero_notional_receipt_count")
            ),
            "paper_replay_candidate_count": _int(
                receipt_summary.get("paper_replay_candidate_count")
            ),
            "capital_ready": _bool(receipt_summary.get("capital_ready")),
            "graduation_state_totals": _mapping(
                receipt_summary.get("graduation_state_totals")
            ),
            "candidate_receipts": _summarize_executable_alpha_receipts(
                executable_alpha_receipts
            ),
        }
    return alpha_summary


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
    paper_route_probe = _mapping(route_book.get("paper_route_probe"))
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
        "paper_route_probe": {
            "configured_enabled": _bool(paper_route_probe.get("configured_enabled")),
            "configured_max_notional": _text(
                paper_route_probe.get("configured_max_notional"), "0"
            ),
            "active": _bool(paper_route_probe.get("active")),
            "effective_max_notional": _text(
                paper_route_probe.get("effective_max_notional"), "0"
            ),
            "next_session_max_notional": _text(
                paper_route_probe.get("next_session_max_notional"), "0"
            ),
            "eligible_symbol_count": _int(
                paper_route_probe.get("eligible_symbol_count")
            ),
            "eligible_symbols": _string_items(
                paper_route_probe.get("eligible_symbols")
            ),
            "active_symbols": _string_items(paper_route_probe.get("active_symbols")),
            "blocking_reasons": _string_items(
                paper_route_probe.get("blocking_reasons")
            ),
            "capital_authority": _text(
                paper_route_probe.get("capital_authority"), "none"
            ),
        },
        "paper_route_probe_eligible_symbols": _string_items(
            summary.get("paper_route_probe_eligible_symbols")
        ),
        "paper_route_probe_active_symbols": _string_items(
            summary.get("paper_route_probe_active_symbols")
        ),
        "expected_unblock_value": _int(summary.get("expected_unblock_value")),
    }


def _mapping_items(value: object) -> list[dict[str, Any]]:
    return [
        item for item in (_mapping(raw_item) for raw_item in _sequence(value)) if item
    ]


def _is_source_collection_target(target: Mapping[str, Any]) -> bool:
    return _bool(target.get("source_collection_authorized")) or (
        _text(target.get("source_kind")) == "runtime_ledger_source_collection_candidate"
    )


def _summarize_runtime_window_import_target(
    target: Mapping[str, Any],
) -> dict[str, object]:
    payload: dict[str, object] = {
        "hypothesis_id": _text(target.get("hypothesis_id")),
        "candidate_id": _text(target.get("candidate_id")),
        "strategy_family": _text(target.get("strategy_family")),
        "strategy_name": _text(
            target.get("strategy_name"), _text(target.get("runtime_strategy_name"))
        ),
        "account_label": _text(target.get("account_label")),
        "source_account_label": _text(target.get("source_account_label")),
        "source_kind": _text(target.get("source_kind")),
        "source_dsn_env": _text(target.get("source_dsn_env")),
        "target_dsn_env": _text(target.get("target_dsn_env")),
        "window_start": _text(target.get("window_start")),
        "window_end": _text(target.get("window_end")),
        "source_collection_authorized": _is_source_collection_target(target),
        "paper_probation_authorized": _bool(target.get("paper_probation_authorized")),
        "evidence_collection_ok": _bool(target.get("evidence_collection_ok")),
        "handoff": _text(target.get("handoff")),
        "probation_reason": _text(target.get("probation_reason")),
        "max_notional": _text(target.get("max_notional"), "0"),
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_authority_ok": False,
        "final_promotion_blockers": _string_items(
            target.get("final_promotion_blockers")
        ),
        "candidate_blockers": _string_items(target.get("candidate_blockers")),
        "source_collection_reason_codes": _string_items(
            target.get("source_collection_reason_codes")
        ),
    }
    for key in (
        "dataset_snapshot_ref",
        "source_manifest_ref",
        "runtime_ledger_bucket_ref",
    ):
        value = _text(target.get(key))
        if value:
            payload[key] = value
    return payload


def _summarize_runtime_window_import_repair(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    plan = _mapping(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    blocked_reasons = _string_items(live_submission_gate.get("blocked_reasons"))
    if not plan:
        return {
            "schema_version": None,
            "status": "missing",
            "next_action": "wait_for_runtime_ledger_source_collection_plan",
            "target_count": 0,
            "paper_probation_target_count": 0,
            "source_collection_target_count": 0,
            "skipped_target_count": 0,
            "blocked_reasons": blocked_reasons,
            "top_targets": [],
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_authority_ok": False,
        }

    raw_targets = _mapping_items(plan.get("targets"))
    source_targets = [
        target for target in raw_targets if _is_source_collection_target(target)
    ]
    paper_targets = [
        target
        for target in raw_targets
        if _bool(target.get("paper_probation_authorized"))
        and not _is_source_collection_target(target)
    ]
    skipped_targets = _mapping_items(plan.get("skipped_targets"))
    if source_targets:
        status = "source_collection_pending"
        next_action = "run_runtime_window_import_for_source_collection_targets"
    elif paper_targets:
        status = "paper_probation_import_pending"
        next_action = "run_runtime_window_import_for_paper_probation_targets"
    elif skipped_targets:
        status = "target_plan_repair_required"
        next_action = "repair_runtime_window_import_target_fields"
    else:
        status = "empty"
        next_action = "wait_for_runtime_window_import_candidates"

    prioritized_targets = [*source_targets, *paper_targets]
    if not prioritized_targets:
        prioritized_targets = raw_targets
    return {
        "schema_version": _text(plan.get("schema_version")) or None,
        "status": status,
        "next_action": next_action,
        "source": _text(plan.get("source")),
        "purpose": _text(plan.get("purpose")),
        "target_count": _int(plan.get("target_count"), len(raw_targets)),
        "paper_probation_target_count": _int(
            plan.get("paper_probation_target_count"), len(paper_targets)
        ),
        "source_collection_target_count": _int(
            plan.get("source_collection_target_count"), len(source_targets)
        ),
        "skipped_target_count": _int(
            plan.get("skipped_target_count"), len(skipped_targets)
        ),
        "blocked_reasons": blocked_reasons,
        "top_targets": [
            _summarize_runtime_window_import_target(target)
            for target in prioritized_targets[:5]
        ],
        "skipped_targets": [
            {
                "hypothesis_id": _text(target.get("hypothesis_id")),
                "candidate_id": _text(target.get("candidate_id")),
                "reason": _text(target.get("reason")),
                "missing_fields": _string_items(target.get("missing_fields")),
                "blockers": _string_items(target.get("blockers")),
            }
            for target in skipped_targets[:5]
        ],
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_authority_ok": False,
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


def _summarize_repair_bid_settlement(
    settlement_ledger: Mapping[str, Any],
) -> dict[str, object]:
    if not settlement_ledger:
        return {
            "ledger_id": None,
            "schema_version": None,
            "capital_decision": "missing",
            "raw_repair_bid_count": 0,
            "compacted_lot_count": 0,
            "selected_lot_count": 0,
            "dispatchable_lot_count": 0,
            "routeable_candidate_count": 0,
        }
    summary = _mapping(settlement_ledger.get("summary"))
    return {
        "ledger_id": settlement_ledger.get("ledger_id"),
        "schema_version": settlement_ledger.get("schema_version"),
        "capital_decision": _text(settlement_ledger.get("capital_decision"), "missing"),
        "raw_repair_bid_count": _int(settlement_ledger.get("raw_repair_bid_count")),
        "compacted_lot_count": _int(summary.get("compacted_lot_count")),
        "selected_lot_count": _int(summary.get("selected_lot_count")),
        "dispatchable_lot_count": _int(summary.get("dispatchable_lot_count")),
        "routeable_candidate_count": _int(
            settlement_ledger.get("routeable_candidate_count")
        ),
        "selected_lot_ids": _string_items(settlement_ledger.get("selected_lot_ids")),
        "dispatchable_lot_ids": _string_items(
            settlement_ledger.get("dispatchable_lot_ids")
        ),
    }


def _summarize_repair_outcome_dividend(
    repair_outcome_dividend_ledger: Mapping[str, Any],
) -> dict[str, object]:
    if not repair_outcome_dividend_ledger:
        return {
            "ledger_id": None,
            "schema_version": None,
            "open_escrow_count": 0,
            "no_delta_lot_count": 0,
            "routeable_candidate_count": 0,
            "max_notional": "0",
        }
    summary = _mapping(repair_outcome_dividend_ledger.get("summary"))
    return {
        "ledger_id": repair_outcome_dividend_ledger.get("ledger_id"),
        "schema_version": repair_outcome_dividend_ledger.get("schema_version"),
        "open_escrow_count": _int(summary.get("open_escrow_count")),
        "no_delta_lot_count": _int(summary.get("no_delta_lot_count")),
        "positive_dividend_count": _int(summary.get("positive_dividend_count")),
        "negative_dividend_count": _int(summary.get("negative_dividend_count")),
        "routeable_candidate_count": _int(summary.get("routeable_candidate_count")),
        "max_notional": _text(summary.get("max_notional"), "0"),
    }


def _first_mapping_item(value: object) -> dict[str, Any]:
    for raw_item in _sequence(value):
        item = _mapping(raw_item)
        if item:
            return item
    return {}


def _first_text(*values: object) -> str | None:
    for value in values:
        text = _text(value)
        if text:
            return text
    return None


def _top_repair_queue_item(repair_queue: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    for raw_item in repair_queue:
        item = _mapping(raw_item)
        if item:
            return dict(item)
    return {}


def _routeable_candidate_count_from_evidence(evidence: Mapping[str, Any]) -> int:
    routeability_acceptance = _mapping(evidence.get("routeability_acceptance"))
    route_evidence_clearinghouse = _mapping(
        evidence.get("route_evidence_clearinghouse")
    )
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    return max(
        _int(routeability_acceptance.get("accepted_routeable_candidate_count")),
        _int(route_evidence_clearinghouse.get("accepted_routeable_candidate_count")),
        _int(repair_bid_settlement.get("routeable_candidate_count")),
    )


def _repair_bid_settlement_held_lot_ids(
    repair_bid_settlement: Mapping[str, Any],
) -> list[str]:
    held_lot_ids: list[str] = []
    for raw_lot in _sequence(repair_bid_settlement.get("compacted_lots")):
        lot = _mapping(raw_lot)
        lot_id = _text(lot.get("lot_id"))
        if not lot_id:
            continue
        lot_state = _text(lot.get("state")).lower()
        if lot_state == "held" or lot.get("dispatchable") is False:
            held_lot_ids.append(lot_id)
    if held_lot_ids:
        return _dedupe(held_lot_ids)

    selected = set(_string_items(repair_bid_settlement.get("selected_lot_ids")))
    dispatchable = set(_string_items(repair_bid_settlement.get("dispatchable_lot_ids")))
    return sorted(selected - dispatchable)


def _state_from_mapping(payload: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        text = _text(payload.get(key))
        if text:
            return text
    return None


def _jangar_material_evidence_settlement_ref(
    status_payload: Mapping[str, Any],
) -> object | None:
    dependency_quorum = _mapping(status_payload.get("dependency_quorum"))
    for source in (
        status_payload,
        dependency_quorum,
        _mapping(dependency_quorum.get("control_plane_status")),
    ):
        settlement = _mapping(source.get("material_evidence_settlement_spine"))
        if settlement:
            return (
                settlement.get("settlement_id")
                or settlement.get("spine_id")
                or settlement.get("id")
                or dict(settlement)
            )
    return None


def _validation_commands(
    *,
    top_item: Mapping[str, Any],
    no_delta_repair_reentry_auction: Mapping[str, Any],
) -> list[str]:
    selected_ticket = _mapping(no_delta_repair_reentry_auction.get("selected_ticket"))
    ticket_commands = _string_items(selected_ticket.get("validation_commands"))
    if ticket_commands:
        return ticket_commands
    if _text(top_item.get("code")) == "repair_alpha_readiness":
        return [
            "uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair",
            "uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py",
            "uv run --frozen pytest tests/test_consumer_evidence.py -k revenue",
        ]
    return [
        "uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair"
    ]


def _field_unavailable_reason_codes(fields: Mapping[str, object]) -> list[str]:
    reasons: list[str] = []
    for field_name, value in fields.items():
        if value is None:
            reasons.append(f"{field_name}_unavailable")
        elif isinstance(value, list) and not value:
            reasons.append(f"{field_name}_empty")
    return reasons


def _build_topline_contract(
    *,
    status_payload: Mapping[str, Any],
    repair_queue: Sequence[Mapping[str, Any]],
    capital: Mapping[str, Any],
    evidence: Mapping[str, Any],
    repair_bid_settlement: Mapping[str, Any],
    alpha_evidence_foundry: Mapping[str, Any],
    alpha_readiness_settlement_conveyor: Mapping[str, Any],
    alpha_repair_dividend_ledger: Mapping[str, Any],
    no_delta_repair_reentry_auction: Mapping[str, Any],
) -> dict[str, object]:
    top_item = _top_repair_queue_item(repair_queue)
    first_foundry_receipt = _first_mapping_item(alpha_evidence_foundry.get("receipts"))
    selected_lane = _mapping(alpha_readiness_settlement_conveyor.get("selected_lane"))
    selected_target = _first_mapping_item(
        _mapping(evidence.get("alpha_readiness")).get("repair_targets")
    )
    routeable_before = _int(
        no_delta_repair_reentry_auction.get("routeable_candidate_count_before"),
        _int(
            alpha_evidence_foundry.get("routeable_candidate_count_before"),
            _routeable_candidate_count_from_evidence(evidence),
        ),
    )
    routeable_after = _int(
        no_delta_repair_reentry_auction.get("routeable_candidate_count_after"),
        _int(
            alpha_readiness_settlement_conveyor.get("routeable_candidate_count_after"),
            _int(
                alpha_repair_dividend_ledger.get("routeable_candidate_count_after"),
                routeable_before,
            ),
        ),
    )
    evidence_clock = _choose_mapping(
        status_payload.get("evidence_clock_arbiter"),
        status_payload.get("evidence_clock"),
    )
    required_custody = _mapping(evidence_clock.get("required_torghut_custody_ref"))
    route_warrant = _choose_mapping(
        status_payload.get("route_warrant_exchange"),
        status_payload.get("route_warrant"),
    )
    jangar_material_ref = _jangar_material_evidence_settlement_ref(status_payload)
    selected_hypothesis_id = _first_text(
        no_delta_repair_reentry_auction.get("selected_hypothesis_id"),
        alpha_repair_dividend_ledger.get("selected_hypothesis_id"),
        selected_lane.get("hypothesis_id"),
        first_foundry_receipt.get("hypothesis_id"),
        selected_target.get("hypothesis_id"),
    )
    selected_candidate_id = _first_text(
        first_foundry_receipt.get("candidate_id"),
        selected_lane.get("candidate_id"),
        selected_target.get("candidate_id"),
    )
    selected_strategy_id = _first_text(
        first_foundry_receipt.get("strategy_id"),
        selected_lane.get("strategy_id"),
        selected_target.get("strategy_id"),
    )
    selected_dataset_snapshot_ref = _first_text(
        first_foundry_receipt.get("dataset_snapshot_ref"),
        first_foundry_receipt.get("dataset_snapshot_id"),
        selected_lane.get("dataset_snapshot_ref"),
        selected_lane.get("dataset_snapshot_id"),
        alpha_repair_dividend_ledger.get("dataset_snapshot_ref"),
    )
    selected_value_gate = _first_text(
        no_delta_repair_reentry_auction.get("selected_value_gate"),
        alpha_evidence_foundry.get("selected_value_gate"),
        top_item.get("value_gate"),
    )
    required_output_receipt = _first_text(
        top_item.get("required_output_receipt"),
        no_delta_repair_reentry_auction.get("required_output_receipt"),
    )
    runtime_window_import_repair = _mapping(
        evidence.get("runtime_window_import_repair")
    )
    top_line: dict[str, object] = {
        "capital_state": _text(capital.get("capital_state"), "unknown"),
        "capital_stage": _text(capital.get("capital_stage"), "unknown"),
        "live_submission_allowed": _bool(capital.get("live_submission_allowed")),
        "max_notional": _text(capital.get("max_notional"), "0"),
        "top_repair_queue_item": top_item or None,
        "selected_value_gate": selected_value_gate,
        "required_output_receipt": required_output_receipt,
        "required_receipts": _string_items(top_item.get("required_receipts")),
        "selected_hypothesis_id": selected_hypothesis_id,
        "selected_candidate_id": selected_candidate_id,
        "selected_strategy_id": selected_strategy_id,
        "selected_dataset_snapshot_ref": selected_dataset_snapshot_ref,
        "routeable_candidate_count_before": routeable_before,
        "routeable_candidate_count_after": routeable_after,
        "accepted_routeable_candidate_count": _routeable_candidate_count_from_evidence(
            evidence
        ),
        "routeable_candidate_delta": routeable_after - routeable_before,
        "alpha_no_delta_release_key": no_delta_repair_reentry_auction.get(
            "active_no_delta_release_key"
        ),
        "no_delta_reentry_decision": no_delta_repair_reentry_auction.get(
            "reentry_decision"
        ),
        "no_delta_reentry_reason_codes": _string_items(
            no_delta_repair_reentry_auction.get("reason_codes")
        ),
        "repair_bid_settlement_status": _first_text(
            repair_bid_settlement.get("status"),
            repair_bid_settlement.get("capital_decision"),
        ),
        "repair_bid_settlement_selected_lot_ids": _string_items(
            repair_bid_settlement.get("selected_lot_ids")
        ),
        "repair_bid_settlement_dispatchable_lot_ids": _string_items(
            repair_bid_settlement.get("dispatchable_lot_ids")
        ),
        "repair_bid_settlement_held_lot_ids": _repair_bid_settlement_held_lot_ids(
            repair_bid_settlement
        ),
        "runtime_window_import_repair_status": _text(
            runtime_window_import_repair.get("status"), "missing"
        ),
        "runtime_window_import_next_action": _text(
            runtime_window_import_repair.get("next_action"),
            "wait_for_runtime_ledger_source_collection_plan",
        ),
        "runtime_window_import_target_count": _int(
            runtime_window_import_repair.get("target_count")
        ),
        "runtime_window_import_source_collection_target_count": _int(
            runtime_window_import_repair.get("source_collection_target_count")
        ),
        "runtime_window_import_paper_probation_target_count": _int(
            runtime_window_import_repair.get("paper_probation_target_count")
        ),
        "evidence_clock_state": _state_from_mapping(
            evidence_clock, "capital_decision", "state", "status"
        ),
        "evidence_clock_custody_status": _state_from_mapping(
            required_custody, "decision", "state", "status"
        ),
        "route_warrant_state": _state_from_mapping(
            route_warrant, "warrant_state", "state", "status"
        ),
        "jangar_material_evidence_settlement_ref": jangar_material_ref,
        "validation_commands": _validation_commands(
            top_item=top_item,
            no_delta_repair_reentry_auction=no_delta_repair_reentry_auction,
        ),
        "rollback_target": _first_text(
            no_delta_repair_reentry_auction.get("rollback_target"),
            alpha_evidence_foundry.get("rollback_target"),
            "ignore revenue-repair top-line fields and keep Torghut max_notional=0",
        ),
    }
    top_line["field_unavailable_reason_codes"] = _field_unavailable_reason_codes(
        {
            "top_repair_queue_item": top_line["top_repair_queue_item"],
            "selected_value_gate": top_line["selected_value_gate"],
            "required_output_receipt": top_line["required_output_receipt"],
            "selected_hypothesis_id": top_line["selected_hypothesis_id"],
            "selected_candidate_id": top_line["selected_candidate_id"],
            "selected_strategy_id": top_line["selected_strategy_id"],
            "selected_dataset_snapshot_ref": top_line["selected_dataset_snapshot_ref"],
            "evidence_clock_state": top_line["evidence_clock_state"],
            "evidence_clock_custody_status": top_line["evidence_clock_custody_status"],
            "route_warrant_state": top_line["route_warrant_state"],
            "jangar_material_evidence_settlement_ref": top_line[
                "jangar_material_evidence_settlement_ref"
            ],
        }
    )
    top_line["transport_evidence_refs"] = {
        "route_evidence_clearinghouse_packet": _mapping(
            evidence.get("route_evidence_clearinghouse")
        ).get("packet_id"),
        "repair_bid_settlement_ledger": repair_bid_settlement.get("ledger_id"),
        "alpha_evidence_foundry": alpha_evidence_foundry.get("foundry_id"),
        "no_delta_repair_reentry_auction": no_delta_repair_reentry_auction.get(
            "auction_id"
        ),
        "evidence_clock_arbiter": evidence_clock.get("arbiter_id"),
        "route_warrant_exchange": route_warrant.get("warrant_id"),
    }
    top_line["producer_component"] = "services/torghut/app/trading/revenue_repair.py"
    top_line["expected_repair_action"] = _text(
        top_item.get("action"), "no_repair_queue_item_selected"
    )
    return top_line


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
    repair_bid_settlement = _choose_mapping(
        status_payload.get("repair_bid_settlement_ledger"),
        readyz_payload.get("repair_bid_settlement_ledger"),
    )
    repair_outcome_dividend = _choose_mapping(
        status_payload.get("repair_outcome_dividend_ledger"),
        readyz_payload.get("repair_outcome_dividend_ledger"),
    )
    db_check = _choose_mapping(
        status_payload.get("db_check"),
        status_payload.get("database_contract"),
        _mapping(_mapping(readyz_payload.get("dependencies")).get("database")),
        _mapping(_mapping(readyz_payload.get("dependencies")).get("database_contract")),
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
    capital = {
        "live_submission_allowed": live_gate_allowed,
        "live_submission_reason": _text(live_submission_gate.get("reason"), "unknown"),
        "configured_live_promotion": _bool(
            live_submission_gate.get("configured_live_promotion")
        ),
        "capital_stage": _text(live_submission_gate.get("capital_stage"), "unknown"),
        "proof_floor_state": _text(proof_floor.get("floor_state"), "unknown"),
        "route_state": proof_floor_route_state,
        "capital_state": capital_state,
        "max_notional": max_notional,
    }
    runtime_window_import_repair = _summarize_runtime_window_import_repair(
        live_submission_gate
    )
    evidence = {
        "alpha_readiness": alpha,
        "quant_evidence": {
            "ok": _bool(quant_evidence.get("ok"), default=True),
            "status": _text(quant_evidence.get("status"), "unknown"),
            "reason": _text(quant_evidence.get("reason"), "unknown"),
            "max_stage_lag_seconds": quant_evidence.get("max_stage_lag_seconds"),
            "blocking_reasons": _string_items(quant_evidence.get("blocking_reasons")),
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
        "repair_bid_settlement": _summarize_repair_bid_settlement(
            repair_bid_settlement
        ),
        "repair_outcome_dividend": _summarize_repair_outcome_dividend(
            repair_outcome_dividend
        ),
        "runtime_window_import_repair": runtime_window_import_repair,
        "simple_lane_reject_reason_totals": _collect_reason_counts(status_payload),
    }
    business_state = _business_state(
        revenue_ready=revenue_ready,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
    )
    alpha_readiness_strike_ledger = build_alpha_readiness_strike_ledger(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        repair_bid_settlement_ledger=repair_bid_settlement,
        capital=capital,
        evidence=evidence,
    )
    executable_alpha_repair_receipts = build_executable_alpha_repair_receipts(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        alpha_readiness=alpha,
        capital=capital,
        repair_bid_settlement_ledger=repair_bid_settlement,
    )
    alpha_repair_closure_board = build_alpha_repair_closure_board(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        source_serving_metadata={
            "build": build,
            "source_serving_repair_receipt_ledger": status_payload.get(
                "source_serving_repair_receipt_ledger"
            ),
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse,
        },
        db_check=db_check,
    )
    executable_alpha_settlement_slots = build_executable_alpha_settlement_slots(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
    )
    alpha_evidence_foundry = build_alpha_evidence_foundry(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        source_serving_metadata={
            "build": build,
            "source_serving_repair_receipt_ledger": status_payload.get(
                "source_serving_repair_receipt_ledger"
            ),
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse,
        },
    )
    alpha_readiness_settlement_conveyor = build_alpha_readiness_settlement_conveyor(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_repair_closure_board=alpha_repair_closure_board,
        source_serving_metadata={
            "build": build,
            "source_serving_repair_receipt_ledger": status_payload.get(
                "source_serving_repair_receipt_ledger"
            ),
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse,
        },
    )
    alpha_repair_dividend_ledger = build_alpha_repair_dividend_ledger(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        repair_bid_settlement_ledger=repair_bid_settlement,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        executable_alpha_settlement_slots=executable_alpha_settlement_slots,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_repair_closure_board=alpha_repair_closure_board,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
    )
    dependency_quorum = _mapping(status_payload.get("dependency_quorum"))
    jangar_controller_ingestion_carry = build_jangar_controller_ingestion_carry(
        generated_at=generated,
        dependency_quorum=dependency_quorum,
        controller_ingestion_settlement=cast(
            Mapping[str, Any] | None,
            status_payload.get("controller_ingestion_settlement"),
        ),
        verify_trust_foreclosure_board=cast(
            Mapping[str, Any] | None,
            status_payload.get("verify_trust_foreclosure_board")
            or status_payload.get("jangar_verification_carry"),
        ),
        repair_slot_escrow=cast(
            Mapping[str, Any] | None,
            status_payload.get("repair_slot_escrow")
            or status_payload.get("stage_debt_repair_admission"),
        ),
        foreclosure_carry_rollout_witness=cast(
            Mapping[str, Any] | None,
            status_payload.get("foreclosure_carry_rollout_witness"),
        ),
    )
    no_delta_repair_reentry_auction = build_no_delta_repair_reentry_auction(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
        alpha_repair_dividend_ledger=alpha_repair_dividend_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement,
        jangar_verification_carry=cast(
            Mapping[str, Any] | None,
            status_payload.get("verify_trust_foreclosure_board")
            or status_payload.get("jangar_verification_carry"),
        ),
        jangar_controller_ingestion_carry=jangar_controller_ingestion_carry,
    )
    topline_contract = _build_topline_contract(
        status_payload=status_payload,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        repair_bid_settlement=repair_bid_settlement,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
        alpha_repair_dividend_ledger=alpha_repair_dividend_ledger,
        no_delta_repair_reentry_auction=no_delta_repair_reentry_auction,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated.isoformat(),
        "routeability_repair_acceptance_ledger_id": routeability_ledger.get(
            "ledger_id"
        ),
        "route_evidence_clearinghouse_packet": dict(route_evidence_clearinghouse),
        "repair_bid_settlement_ledger": dict(repair_bid_settlement),
        "alpha_readiness_strike_ledger": alpha_readiness_strike_ledger,
        "executable_alpha_repair_receipts": executable_alpha_repair_receipts,
        "executable_alpha_settlement_slots": executable_alpha_settlement_slots,
        "alpha_repair_closure_board": alpha_repair_closure_board,
        "alpha_evidence_foundry": alpha_evidence_foundry,
        "alpha_readiness_settlement_conveyor": alpha_readiness_settlement_conveyor,
        "alpha_repair_dividend_ledger": alpha_repair_dividend_ledger,
        "jangar_controller_ingestion_carry": jangar_controller_ingestion_carry,
        "no_delta_repair_reentry_auction": no_delta_repair_reentry_auction,
        "business_state": business_state,
        "revenue_ready": revenue_ready,
        **topline_contract,
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
        "capital": capital,
        "evidence": evidence,
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
