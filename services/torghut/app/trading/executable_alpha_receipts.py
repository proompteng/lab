"""Executable alpha receipt projection for zero-notional repair planning."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, cast

CAPITAL_REPLAY_BOARD_SCHEMA_VERSION = "torghut.capital-replay-board.v1"
EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION = "torghut.executable-alpha-receipts.v1"

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


def _graduation_state(
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> tuple[str, list[str]]:
    state = _text(jangar_contract_graduation_ref.get("state"))
    decision = _text(jangar_contract_graduation_ref.get("decision")).lower()
    if state == "current" or decision == "allow":
        return "current", []
    reasons = _string_list(jangar_contract_graduation_ref.get("reasons"))
    return state or "missing", reasons or ["jangar_contract_graduation_missing"]


def _market_context_blockers(market_context_status: Mapping[str, Any]) -> list[str]:
    if not market_context_status:
        return ["market_context_missing"]
    state = _text(
        market_context_status.get("overallState")
        or market_context_status.get("overall_state")
        or market_context_status.get("state")
        or market_context_status.get("status")
    ).lower()
    if bool(market_context_status.get("alert_active")):
        return [
            _text(
                market_context_status.get("alert_reason"),
                "market_context_alert_active",
            )
        ]
    if state in {"ok", "healthy", "fresh", "pass", "current", "not_required"}:
        return []
    if state:
        return [f"market_context_{state}"]
    return ["market_context_state_unknown"]


def _quant_blockers(quant_evidence: Mapping[str, Any]) -> list[str]:
    blockers = _string_list(quant_evidence.get("blocking_reasons"))
    blockers.extend(_string_list(quant_evidence.get("informational_reasons")))
    latest_count = _int(quant_evidence.get("latest_metrics_count"), default=-1)
    if latest_count == 0:
        blockers.append("quant_latest_metrics_empty")
    stage_count = _int(quant_evidence.get("stage_count"), default=-1)
    if stage_count == 0:
        blockers.append("quant_pipeline_stages_missing")
    status = _text(quant_evidence.get("status")).lower()
    if status in {"degraded", "unknown", "error"}:
        blockers.append(f"quant_health_{status}")
    return sorted(set(blockers))


def _empirical_blockers(empirical_jobs_status: Mapping[str, Any]) -> list[str]:
    if bool(empirical_jobs_status.get("ready")):
        return []
    status = _text(empirical_jobs_status.get("status"), "unknown")
    reasons = _string_list(empirical_jobs_status.get("reasons"))
    return sorted(set(reasons or [f"empirical_jobs_{status}"]))


def _tca_guardrail_blockers(route_record: Mapping[str, Any]) -> list[str]:
    observed = _float(route_record.get("avg_abs_slippage_bps"))
    guardrail = _float(route_record.get("slippage_guardrail_bps"))
    if observed is not None and guardrail is not None and observed > guardrail:
        return ["execution_tca_above_guardrail"]
    if _int(route_record.get("unsettled_execution_count")) > 0:
        return ["execution_tca_unsettled_executions"]
    if _text(route_record.get("state")) == "missing":
        return ["execution_tca_symbol_missing"]
    return []


def _capital_blockers(
    *,
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    route_record: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> list[str]:
    blockers = set(_string_list(proof_floor_receipt.get("blocking_reasons")))
    blockers.update(_string_list(live_submission_gate.get("blocked_reasons")))
    blockers.update(_empirical_blockers(empirical_jobs_status))
    blockers.update(_quant_blockers(quant_evidence))
    blockers.update(_market_context_blockers(market_context_status))
    blockers.update(_tca_guardrail_blockers(route_record))
    graduation_state, graduation_reasons = _graduation_state(
        jangar_contract_graduation_ref
    )
    if graduation_state != "current":
        blockers.update(graduation_reasons)
    return sorted(blocker for blocker in blockers if blocker)


def _before_refs(
    *,
    replay_class: str,
    route_row: Mapping[str, Any],
    route_record: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_contract_graduation_ref: Mapping[str, Any],
) -> dict[str, object]:
    return {
        "route_reacquisition": {
            "proof_packet_id": route_row.get("proof_packet_id"),
            "symbol": route_row.get("symbol") or route_record.get("symbol"),
            "state": route_row.get("state") or route_record.get("state"),
            "reason": route_row.get("current_blocker") or route_record.get("reason"),
            "avg_abs_slippage_bps": route_record.get("avg_abs_slippage_bps"),
            "slippage_guardrail_bps": route_record.get("slippage_guardrail_bps"),
            "last_computed_at": route_record.get("last_computed_at"),
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
        "replay_class": replay_class,
    }


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
    graduation_state: GraduationState = "candidate" if target_symbols else "failed"
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
            "paper_replay_candidate_count": 0,
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
                "paper_replay_candidate_count": 0,
                "zero_notional_receipt_count": len(receipts),
                "capital_ready": False,
            },
            "receipts": receipts,
        },
    }


__all__ = [
    "CAPITAL_REPLAY_BOARD_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION",
    "build_capital_replay_projection",
]
