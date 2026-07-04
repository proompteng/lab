"""Repair queue and alpha-readiness summaries for revenue-repair digests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


SCHEMA_VERSION = "torghut.revenue-repair-digest.v1"

_REPAIR_CATALOG: dict[str, tuple[str, str, str, int, int]] = {
    "hypothesis_not_promotion_eligible": (
        "repair_alpha_readiness",
        "alpha_readiness",
        "clear_hypothesis_blockers_before_capital",
        70,
        6,
    ),
    "runtime_window_import_required": (
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
    "hypothesis_not_promotion_eligible": {
        "value_gate": "routeable_candidate_count",
        "required_output_receipt": "torghut.executable-alpha-receipts.v1",
        "required_receipts": [
            "alpha_readiness_receipt",
            "hypothesis_promotion_receipt",
            "capital_replay_board",
        ],
    },
    "runtime_window_import_required": {
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


REPAIR_CATALOG = _REPAIR_CATALOG
REPAIR_METADATA = _REPAIR_METADATA
NON_ACTIONABLE_DEPENDENCY_DETAILS = _NON_ACTIONABLE_DEPENDENCY_DETAILS
catalog = _catalog
repair_metadata = _repair_metadata
text_value = _text
bool_value = _bool
int_value = _int
mapping_value = _mapping
sequence_value = _sequence
string_items = _string_items
dedupe_items = _dedupe
load_json_object = _load_json_object
choose_mapping = _choose_mapping
collect_reason_counts = _collect_reason_counts
collect_blocking_reasons = _collect_blocking_reasons
repair_from_ladder_item = _repair_from_ladder_item
repair_from_reason = _repair_from_reason
build_repair_queue = _build_repair_queue
summarize_alpha_replay_items = _summarize_alpha_replay_items
summarize_executable_alpha_receipts = _summarize_executable_alpha_receipts
summarize_alpha_repair_targets = _summarize_alpha_repair_targets
summarize_alpha = _summarize_alpha

__all__ = [
    "SCHEMA_VERSION",
    "REPAIR_CATALOG",
    "REPAIR_METADATA",
    "NON_ACTIONABLE_DEPENDENCY_DETAILS",
    "catalog",
    "repair_metadata",
    "text_value",
    "bool_value",
    "int_value",
    "mapping_value",
    "sequence_value",
    "string_items",
    "dedupe_items",
    "load_json_object",
    "choose_mapping",
    "collect_reason_counts",
    "collect_blocking_reasons",
    "repair_from_ladder_item",
    "repair_from_reason",
    "build_repair_queue",
    "summarize_alpha_replay_items",
    "summarize_executable_alpha_receipts",
    "summarize_alpha_repair_targets",
    "summarize_alpha",
    "_REPAIR_CATALOG",
    "_REPAIR_METADATA",
    "_NON_ACTIONABLE_DEPENDENCY_DETAILS",
    "_catalog",
    "_repair_metadata",
    "_text",
    "_bool",
    "_int",
    "_mapping",
    "_sequence",
    "_string_items",
    "_dedupe",
    "_load_json_object",
    "_choose_mapping",
    "_collect_reason_counts",
    "_collect_blocking_reasons",
    "_repair_from_ladder_item",
    "_repair_from_reason",
    "_build_repair_queue",
    "_summarize_alpha_replay_items",
    "_summarize_executable_alpha_receipts",
    "_summarize_alpha_repair_targets",
    "_summarize_alpha",
]
