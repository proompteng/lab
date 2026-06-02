"""Repair-bid settlement ledger projection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, cast


REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION = "torghut.repair-bid-settlement-ledger.v1"

_FRESHNESS_SECONDS = 60
_MAX_SELECTED_LOTS = 5
_MAX_DISPATCHABLE_LOTS = 3
_DEFAULT_TTL_SECONDS = 15 * 60
_DEFAULT_MAX_RUNTIME_SECONDS = 20 * 60
_ZERO_NOTIONAL = "0"

_VALUE_GATES = [
    "post_cost_daily_net_pnl",
    "routeable_candidate_count",
    "zero_notional_or_stale_evidence_rate",
    "fill_tca_or_slippage_quality",
    "capital_gate_safety",
]

_BAD_STATES = {
    "block",
    "blocked",
    "degraded",
    "down",
    "expired",
    "fail",
    "failed",
    "hold",
    "missing",
    "stale",
}
_TRUE_TEXT = {"1", "true", "yes", "on", "allow", "allowed", "ok", "ready"}
_FALSE_TEXT = {"0", "false", "no", "off", "block", "blocked", "degraded", "hold"}

_LOT_PRIORITY = {
    "quant_pipeline": 100,
    "execution_tca": 90,
    "rollout_image": 80,
    "empirical_replay": 70,
    "promotion_custody": 60,
    "feature_lineage": 50,
}

_LOT_VALUE_GATE = {
    "quant_pipeline": "zero_notional_or_stale_evidence_rate",
    "execution_tca": "fill_tca_or_slippage_quality",
    "rollout_image": "capital_gate_safety",
    "empirical_replay": "post_cost_daily_net_pnl",
    "promotion_custody": "routeable_candidate_count",
    "feature_lineage": "zero_notional_or_stale_evidence_rate",
}

_LOT_RECEIPT = {
    "quant_pipeline": "torghut.quant-pipeline-current-receipt.v1",
    "execution_tca": "torghut.execution-tca-current-receipt.v1",
    "rollout_image": "torghut.rollout-image-proof-receipt.v1",
    "empirical_replay": "torghut.empirical-replay-current-receipt.v1",
    "promotion_custody": "torghut.promotion-custody-decision-receipt.v1",
    "feature_lineage": "torghut.feature-lineage-current-receipt.v1",
}

_FEATURE_COVERAGE_BLOCKERS = {
    "feature_rows_missing",
    "required_feature_set_unavailable",
    "equity_ta_rows_missing",
    "options_feature_rows_missing",
}

_LOT_VALIDATION = {
    "quant_pipeline": "pytest services/torghut/tests/test_repair_bid_settlement.py -k quant_pipeline",
    "execution_tca": "pytest services/torghut/tests/test_repair_bid_settlement.py -k execution_tca",
    "rollout_image": "pytest services/torghut/tests/test_repair_bid_settlement.py -k rollout_image",
    "empirical_replay": "pytest services/torghut/tests/test_repair_bid_settlement.py -k empirical_replay",
    "promotion_custody": "pytest services/torghut/tests/test_repair_bid_settlement.py -k promotion_custody",
    "feature_lineage": "pytest services/torghut/tests/test_repair_bid_settlement.py -k feature_lineage",
}

_ALPHA_READINESS_STRIKE_PRIORITY = 98
_ALPHA_READINESS_STRIKE_RECEIPT = "torghut.executable-alpha-receipts.v1"
_ALPHA_READINESS_STRIKE_REASONS = {
    "alpha_hypothesis_not_promotion_eligible",
    "alpha_readiness_not_promotion_eligible",
    "hypothesis_not_promotion_eligible",
}
_PROFIT_FRESHNESS_REPAIR_PRIORITY = 99
_ZERO_NOTIONAL_TEXT = {"", "0", "0.0", "0.00", "0.0000"}
_PROFIT_FRESHNESS_ACTION_CONTRACTS: Mapping[str, Mapping[str, object]] = {
    "renew_empirical_proof_jobs": {
        "lot_class": "empirical_replay",
        "target_value_gate": "zero_notional_or_stale_evidence_rate",
        "required_output_receipt": "torghut.empirical-proof-refresh-receipt.v1",
        "validation_command": (
            "pytest services/torghut/tests/test_zero_notional_repair_executor.py "
            "-k dispatch_ticket"
        ),
    },
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


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in _TRUE_TEXT:
            return True
        if normalized in _FALSE_TEXT:
            return False
    return default


def _int(value: object, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(float(str(value)))
    except ValueError:
        return default


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


def _is_zero_notional(value: object, default: str = _ZERO_NOTIONAL) -> bool:
    text = _text(value, default)
    if text in _ZERO_NOTIONAL_TEXT:
        return True
    try:
        return float(text) == 0
    except ValueError:
        return False


def _timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (
        parsed.astimezone(timezone.utc)
        if parsed.tzinfo
        else parsed.replace(tzinfo=timezone.utc)
    )


def _ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _contains_any(value: str, tokens: Sequence[str]) -> bool:
    return any(token in value for token in tokens)


def _lot_class_for_reason(reason: str) -> str:
    normalized = reason.lower()
    if _contains_any(
        normalized,
        (
            "quant",
            "jangar",
            "ingestion",
            "materialization",
            "latest_metric",
            "pipeline",
        ),
    ):
        return "quant_pipeline"
    if _contains_any(normalized, ("tca", "execution", "slippage", "shortfall", "fill")):
        return "execution_tca"
    if _contains_any(
        normalized, ("image", "rollout", "workload", "revision", "digest", "argo")
    ):
        return "rollout_image"
    if _contains_any(
        normalized, ("empirical", "replay", "dataset", "benchmark", "post_cost")
    ):
        return "empirical_replay"
    if _contains_any(
        normalized,
        (
            "promotion",
            "quorum",
            "routeability",
            "proof_floor",
            "capital",
            "submit",
            "notional",
            "alpha_readiness",
        ),
    ):
        return "promotion_custody"
    if _contains_any(
        normalized,
        (
            "feature",
            "schema",
            "drift",
            "research",
            "options",
            "provider",
            "catalog",
            "source",
            "lineage",
            "forecast",
            "market_context",
        ),
    ):
        return "feature_lineage"
    return "feature_lineage"


def _lot_class_for_bid(bid: Mapping[str, Any], reason_codes: Sequence[str]) -> str:
    if reason_codes:
        classes = [_lot_class_for_reason(reason) for reason in reason_codes]
        return max(classes, key=lambda item: _LOT_PRIORITY[item])
    repair_class = _text(bid.get("repair_class")).lower()
    value_gate = _text(bid.get("value_gate")).lower()
    if "execution" in repair_class or value_gate == "fill_tca_or_slippage_quality":
        return "execution_tca"
    if "image" in repair_class or "rollout" in repair_class:
        return "rollout_image"
    if "routeability" in repair_class or value_gate == "routeable_candidate_count":
        return "promotion_custody"
    if "capital" in repair_class or value_gate == "capital_gate_safety":
        return "promotion_custody"
    if "source" in repair_class or "freshness" in repair_class:
        return "feature_lineage"
    return "feature_lineage"


def _collect_raw_bids(
    clearinghouse_packet: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    bids: list[Mapping[str, Any]] = []
    for raw_bid in _sequence(clearinghouse_packet.get("selected_repair_bids")):
        bid = _mapping(raw_bid)
        if bid:
            bids.append(bid)
    raw_book = _mapping(clearinghouse_packet.get("repair_bid_book"))
    for raw_bid in _sequence(raw_book.get("repair_bids")):
        bid = _mapping(raw_bid)
        if bid and bid not in bids:
            bids.append(bid)
    return bids


def _collect_packet_reason_codes(clearinghouse_packet: Mapping[str, Any]) -> list[str]:
    reasons: list[str] = []
    for book_name in (
        "source_freshness_book",
        "execution_freshness_book",
        "rollout_image_book",
        "profit_window_custody_book",
        "capital_hold_book",
    ):
        reasons.extend(
            _strings(_mapping(clearinghouse_packet.get(book_name)).get("reason_codes"))
        )
    for raw_claim in _sequence(clearinghouse_packet.get("route_claims")):
        reasons.extend(_strings(_mapping(raw_claim).get("reason_codes")))
    for raw_bid in _collect_raw_bids(clearinghouse_packet):
        reasons.extend(_strings(raw_bid.get("reason_codes")))
    return _unique(reasons)


def _status_reason_codes(prefix: str, status: Mapping[str, Any]) -> list[str]:
    reasons = [
        *_strings(status.get("reason_codes")),
        *_strings(status.get("blocking_reasons")),
        *_strings(status.get("blocked_reasons")),
    ]
    state = _text(
        status.get("status") or status.get("state") or status.get("decision")
    ).lower()
    if state in _BAD_STATES:
        reasons.append(f"{prefix}_{state}")
    if "ok" in status and not _bool(status.get("ok"), default=True):
        reasons.append(f"{prefix}_degraded")
    if "ready" in status and not _bool(status.get("ready"), default=True):
        reasons.append(f"{prefix}_not_ready")
    return _unique(reasons)


def _quant_reason_codes(jangar_scoped_quant_status: Mapping[str, Any]) -> list[str]:
    reasons = _status_reason_codes("jangar_quant_scoped", jangar_scoped_quant_status)
    if "ingestion_ok" in jangar_scoped_quant_status and not _bool(
        jangar_scoped_quant_status.get("ingestion_ok"), default=True
    ):
        reasons.append("jangar_quant_ingestion_degraded")
    if "materialization_ok" in jangar_scoped_quant_status and not _bool(
        jangar_scoped_quant_status.get("materialization_ok"), default=True
    ):
        reasons.append("jangar_quant_materialization_degraded")
    return _unique(reasons)


def _rollout_reason_codes(rollout_image_summary: Mapping[str, Any]) -> list[str]:
    reasons = _status_reason_codes("rollout_image", rollout_image_summary)
    if "route_workloads_ok" in rollout_image_summary and not _bool(
        rollout_image_summary.get("route_workloads_ok"), default=True
    ):
        reasons.append("route_adjacent_workloads_degraded")
    if not _text(rollout_image_summary.get("image_digest")):
        reasons.append("image_digest_missing")
    return _unique(reasons)


def _active_dedupe_keys(active_run_dedupe_state: Mapping[str, Any]) -> list[str]:
    keys = _strings(active_run_dedupe_state.get("active_dedupe_keys"))
    for raw_run in _sequence(active_run_dedupe_state.get("active_runs")):
        run = _mapping(raw_run)
        key = _text(run.get("dedupe_key") or run.get("dedupeKey"))
        if key:
            keys.append(key)
    return _unique(keys)


def _packet_stale(clearinghouse_packet: Mapping[str, Any], now: datetime) -> bool:
    fresh_until = _timestamp(clearinghouse_packet.get("fresh_until"))
    return fresh_until is not None and fresh_until < now


def _input_refs(
    *,
    clearinghouse_packet: Mapping[str, Any],
    routeability_acceptance_ledger: Mapping[str, Any],
    jangar_scoped_quant_status: Mapping[str, Any],
    rollout_image_summary: Mapping[str, Any],
    bid_ids: Sequence[str],
) -> list[str]:
    refs = [
        _text(clearinghouse_packet.get("packet_id")),
        _text(routeability_acceptance_ledger.get("ledger_id")),
        _text(
            jangar_scoped_quant_status.get("receipt_id")
            or jangar_scoped_quant_status.get("authority")
        ),
        _text(
            rollout_image_summary.get("image_digest")
            or rollout_image_summary.get("active_revision")
        ),
        *bid_ids,
    ]
    return _unique(refs)


def _root_cause(lot_class: str) -> str:
    return {
        "quant_pipeline": "scoped quant ingestion or materialization proof is stale or degraded",
        "execution_tca": "active-session execution and TCA proof is stale or incomplete",
        "rollout_image": "active route workload or image proof is missing or degraded",
        "empirical_replay": "empirical replay proof is stale, absent, or not bound to the active candidate",
        "promotion_custody": "promotion, routeability, or capital custody has not accepted a route",
        "feature_lineage": "feature, forecast, source, schema, or lineage evidence is stale or incomplete",
    }[lot_class]


def _expected_gate_delta(lot_class: str, reason_codes: Sequence[str]) -> str:
    if reason_codes:
        return f"retire_{reason_codes[0]}"
    return f"settle_{lot_class}"


def _is_alpha_readiness_strike(lot_class: str, reason_codes: Sequence[str]) -> bool:
    if lot_class != "promotion_custody":
        return False
    return any(
        reason in _ALPHA_READINESS_STRIKE_REASONS
        or reason.startswith("alpha_readiness_")
        or reason.startswith("alpha_hypothesis_")
        for reason in reason_codes
    )


def _prioritize_lot_reason_codes(
    lot_class: str, reason_codes: Sequence[str]
) -> list[str]:
    normalized = _unique(list(reason_codes))
    if not _is_alpha_readiness_strike(lot_class, normalized):
        return normalized

    def strike_rank(reason: str) -> int:
        if reason.startswith("alpha_readiness_"):
            return 0
        if reason.startswith("alpha_hypothesis_"):
            return 1
        if reason == "hypothesis_not_promotion_eligible":
            return 2
        return 3

    strike_reasons = sorted(
        [
            reason
            for reason in normalized
            if reason in _ALPHA_READINESS_STRIKE_REASONS
            or reason.startswith("alpha_readiness_")
            or reason.startswith("alpha_hypothesis_")
        ],
        key=strike_rank,
    )
    return _unique([*strike_reasons, *normalized])


def _lot_priority(lot_class: str, reason_codes: Sequence[str]) -> int:
    priority = _LOT_PRIORITY[lot_class]
    if _is_alpha_readiness_strike(lot_class, reason_codes):
        return _ALPHA_READINESS_STRIKE_PRIORITY
    if lot_class != "feature_lineage":
        return priority
    if any(reason in _FEATURE_COVERAGE_BLOCKERS for reason in reason_codes):
        return 95
    return priority


def _lot_receipt(lot_class: str, reason_codes: Sequence[str]) -> str:
    if _is_alpha_readiness_strike(lot_class, reason_codes):
        return _ALPHA_READINESS_STRIKE_RECEIPT
    return _LOT_RECEIPT[lot_class]


def _build_lot(
    *,
    account_id: str,
    session_id: str,
    lot_class: str,
    reason_codes: Sequence[str],
    source_bid_ids: Sequence[str],
    active_keys: Sequence[str],
    packet_is_stale: bool,
    clearinghouse_packet: Mapping[str, Any],
    routeability_acceptance_ledger: Mapping[str, Any],
    jangar_scoped_quant_status: Mapping[str, Any],
    rollout_image_summary: Mapping[str, Any],
) -> dict[str, object]:
    dedupe_key = f"{account_id}:{session_id}:{lot_class}"
    hold_reasons: list[str] = []
    if dedupe_key in active_keys:
        hold_reasons.append("dedupe_key_active")
    if packet_is_stale:
        hold_reasons.append("raw_clearinghouse_packet_stale")
    ordered_reason_codes = _prioritize_lot_reason_codes(lot_class, reason_codes)
    state = (
        "active"
        if "dedupe_key_active" in hold_reasons
        else "held"
        if hold_reasons
        else "candidate"
    )
    lot_payload = {
        "account_id": account_id,
        "session_id": session_id,
        "lot_class": lot_class,
        "reason_codes": list(reason_codes),
    }
    return {
        "lot_id": _ref("compacted-repair-lot", lot_payload),
        "lot_class": lot_class,
        "target_value_gate": _LOT_VALUE_GATE[lot_class],
        "priority": _lot_priority(lot_class, ordered_reason_codes),
        "expected_gate_delta": _expected_gate_delta(lot_class, ordered_reason_codes),
        "raw_reason_codes": ordered_reason_codes,
        "root_cause_hypothesis": _root_cause(lot_class),
        "required_input_refs": _input_refs(
            clearinghouse_packet=clearinghouse_packet,
            routeability_acceptance_ledger=routeability_acceptance_ledger,
            jangar_scoped_quant_status=jangar_scoped_quant_status,
            rollout_image_summary=rollout_image_summary,
            bid_ids=source_bid_ids,
        ),
        "required_output_receipt": _lot_receipt(lot_class, ordered_reason_codes),
        "required_output_receipt_count": 1,
        "validation_commands": [_LOT_VALIDATION[lot_class]],
        "dedupe_key": dedupe_key,
        "ttl_seconds": _DEFAULT_TTL_SECONDS,
        "max_runtime_seconds": _DEFAULT_MAX_RUNTIME_SECONDS,
        "max_parallelism": 1,
        "max_notional": _ZERO_NOTIONAL,
        "state": state,
        "dispatchable": False,
        "hold_reason_codes": _unique(hold_reasons),
        "source_bid_ids": list(source_bid_ids),
    }


def _profit_freshness_repairs(
    profit_freshness_frontier: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    repairs: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    raw_repairs: list[tuple[object, bool]] = [
        (raw_repair, True)
        for raw_repair in _sequence(
            profit_freshness_frontier.get("selected_zero_notional_repairs")
        )
    ]
    raw_repairs.extend(
        (raw_repair, False)
        for raw_repair in _sequence(profit_freshness_frontier.get("repair_lots"))
    )
    for raw_repair, explicitly_selected in raw_repairs:
        repair = _mapping(raw_repair)
        if not repair:
            continue
        repair_id = _text(repair.get("lot_id")) or _ref(
            "profit-freshness-repair-lot", repair
        )
        key = f"{repair_id}:{_text(repair.get('zero_notional_action'))}"
        if key in seen:
            continue
        seen.add(key)
        if (
            _text(repair.get("state")) != "selected_zero_notional_repair"
            and not explicitly_selected
        ):
            continue
        repairs.append(repair)
    return repairs


def _build_profit_freshness_lot(
    *,
    account_id: str,
    session_id: str,
    repair: Mapping[str, Any],
    frontier: Mapping[str, Any],
    active_keys: Sequence[str],
) -> dict[str, object] | None:
    action = _text(repair.get("zero_notional_action"))
    contract = _mapping(_PROFIT_FRESHNESS_ACTION_CONTRACTS.get(action))
    if not contract:
        return None
    if not (
        _is_zero_notional(repair.get("paper_notional_limit"))
        and _is_zero_notional(repair.get("live_notional_limit"))
    ):
        return None

    lot_id = _text(repair.get("lot_id")) or _ref(
        "profit-freshness-repair-lot",
        {
            "frontier_id": frontier.get("frontier_id"),
            "action": action,
            "candidate_id": repair.get("candidate_id"),
            "hypothesis_id": repair.get("hypothesis_id"),
            "blocked_dimension": repair.get("blocked_dimension"),
        },
    )
    blocked_dimension = _text(repair.get("blocked_dimension"), "profit_freshness")
    dedupe_key = (
        f"{account_id}:{session_id}:profit_freshness:{action}:{blocked_dimension}"
    )
    hold_reasons = ["dedupe_key_active"] if dedupe_key in active_keys else []
    state = "active" if hold_reasons else "candidate"
    reason_codes = _unique(
        [
            f"profit_freshness_{blocked_dimension}_repair_selected",
            *_strings(repair.get("guardrail_failures")),
        ]
    )
    return {
        "lot_id": lot_id,
        "lot_class": _text(contract.get("lot_class"), "profit_freshness"),
        "target_value_gate": _text(
            contract.get("target_value_gate"),
            _text(repair.get("value_gate"), "zero_notional_or_stale_evidence_rate"),
        ),
        "priority": _PROFIT_FRESHNESS_REPAIR_PRIORITY,
        "expected_gate_delta": f"retire_{blocked_dimension}_stale",
        "raw_reason_codes": reason_codes,
        "root_cause_hypothesis": (
            "profit freshness frontier selected a zero-notional runner repair "
            f"for {blocked_dimension}"
        ),
        "required_input_refs": _unique(
            [
                _text(frontier.get("frontier_id")),
                lot_id,
                _text(repair.get("candidate_id")),
                _text(repair.get("hypothesis_id")),
                *_strings(repair.get("before_refs")),
            ]
        ),
        "required_output_receipt": _text(contract.get("required_output_receipt")),
        "required_output_receipt_count": 1,
        "validation_commands": [_text(contract.get("validation_command"))],
        "dedupe_key": dedupe_key,
        "ttl_seconds": _DEFAULT_TTL_SECONDS,
        "max_runtime_seconds": _DEFAULT_MAX_RUNTIME_SECONDS,
        "max_parallelism": 1,
        "max_notional": _ZERO_NOTIONAL,
        "state": state,
        "dispatchable": False,
        "hold_reason_codes": hold_reasons,
        "source_bid_ids": _unique([_text(frontier.get("frontier_id")), lot_id, action]),
    }


def _classed_reasons(
    *,
    clearinghouse_packet: Mapping[str, Any],
    jangar_scoped_quant_status: Mapping[str, Any],
    rollout_image_summary: Mapping[str, Any],
) -> dict[str, dict[str, list[str]]]:
    grouped: dict[str, dict[str, list[str]]] = {}

    def ensure(lot_class: str) -> dict[str, list[str]]:
        return grouped.setdefault(lot_class, {"reason_codes": [], "bid_ids": []})

    for raw_bid in _collect_raw_bids(clearinghouse_packet):
        reason_codes = _strings(raw_bid.get("reason_codes"))
        if not reason_codes:
            expected_delta = _text(raw_bid.get("expected_gate_delta"))
            if expected_delta.startswith("retire_"):
                reason_codes = [expected_delta.removeprefix("retire_")]
        lot_class = _lot_class_for_bid(raw_bid, reason_codes)
        bucket = ensure(lot_class)
        bucket["reason_codes"].extend(reason_codes)
        bucket["bid_ids"].append(_text(raw_bid.get("bid_id") or raw_bid.get("lot_id")))

    for reason in _collect_packet_reason_codes(clearinghouse_packet):
        ensure(_lot_class_for_reason(reason))["reason_codes"].append(reason)
    for reason in _quant_reason_codes(jangar_scoped_quant_status):
        ensure("quant_pipeline")["reason_codes"].append(reason)
    for reason in _rollout_reason_codes(rollout_image_summary):
        ensure("rollout_image")["reason_codes"].append(reason)

    normalized: dict[str, dict[str, list[str]]] = {}
    for lot_class, payload in grouped.items():
        reason_codes = _unique(payload["reason_codes"])
        if reason_codes:
            normalized[lot_class] = {
                "reason_codes": reason_codes,
                "bid_ids": _unique(payload["bid_ids"]),
            }
    return normalized


def _select_lots(lots: Sequence[dict[str, object]]) -> list[dict[str, object]]:
    selected_count = 0
    dispatchable_count = 0
    selected: list[dict[str, object]] = []
    for raw_lot in sorted(
        lots, key=lambda lot: _int(lot.get("priority")), reverse=True
    ):
        lot = dict(raw_lot)
        if lot["state"] == "candidate" and selected_count < _MAX_SELECTED_LOTS:
            selected_count += 1
            lot["state"] = "selected"
            if dispatchable_count < _MAX_DISPATCHABLE_LOTS:
                dispatchable_count += 1
                lot["dispatchable"] = True
            else:
                lot["dispatchable"] = False
                lot["hold_reason_codes"] = _unique(
                    [
                        *cast(Sequence[str], lot.get("hold_reason_codes") or []),
                        "dispatch_limit_exceeded",
                    ]
                )
        elif lot["state"] == "candidate":
            lot["state"] = "held"
            lot["dispatchable"] = False
            lot["hold_reason_codes"] = _unique(
                [
                    *cast(Sequence[str], lot.get("hold_reason_codes") or []),
                    "selection_limit_exceeded",
                ]
            )
        selected.append(lot)
    return selected


def build_repair_bid_settlement_ledger(
    *,
    account_label: str,
    session_id: str,
    trading_mode: str,
    torghut_revision: str | None,
    source_commit: str | None,
    route_evidence_clearinghouse_packet: Mapping[str, Any],
    routeability_acceptance_ledger: Mapping[str, Any] | None = None,
    active_run_dedupe_state: Mapping[str, Any] | None = None,
    jangar_scoped_quant_status: Mapping[str, Any] | None = None,
    rollout_image_summary: Mapping[str, Any] | None = None,
    profit_freshness_frontier: Mapping[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Compact raw route-evidence bids into bounded zero-notional repair lots."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    clearinghouse_packet = _mapping(route_evidence_clearinghouse_packet)
    routeability_ledger = _mapping(routeability_acceptance_ledger)
    quant_status = _mapping(jangar_scoped_quant_status)
    rollout_summary = _mapping(rollout_image_summary)
    freshness_frontier = _mapping(profit_freshness_frontier)
    active_keys = _active_dedupe_keys(_mapping(active_run_dedupe_state))
    packet_is_stale = _packet_stale(clearinghouse_packet, generated_at)
    classed_reasons = _classed_reasons(
        clearinghouse_packet=clearinghouse_packet,
        jangar_scoped_quant_status=quant_status,
        rollout_image_summary=rollout_summary,
    )
    lots = [
        _build_lot(
            account_id=account_label,
            session_id=session_id,
            lot_class=lot_class,
            reason_codes=payload["reason_codes"],
            source_bid_ids=payload["bid_ids"],
            active_keys=active_keys,
            packet_is_stale=packet_is_stale,
            clearinghouse_packet=clearinghouse_packet,
            routeability_acceptance_ledger=routeability_ledger,
            jangar_scoped_quant_status=quant_status,
            rollout_image_summary=rollout_summary,
        )
        for lot_class, payload in classed_reasons.items()
    ]
    for repair in _profit_freshness_repairs(freshness_frontier):
        profit_lot = _build_profit_freshness_lot(
            account_id=account_label,
            session_id=session_id,
            repair=repair,
            frontier=freshness_frontier,
            active_keys=active_keys,
        )
        if profit_lot:
            lots.append(profit_lot)
    compacted_lots = _select_lots(lots)
    selected_lot_ids = [
        str(lot["lot_id"]) for lot in compacted_lots if lot["state"] == "selected"
    ]
    dispatchable_lot_ids = [
        str(lot["lot_id"]) for lot in compacted_lots if lot.get("dispatchable") is True
    ]
    held_lot_ids = [
        str(lot["lot_id"])
        for lot in compacted_lots
        if lot["state"] in {"held", "active"}
        or (lot.get("dispatchable") is False and lot["state"] == "selected")
    ]
    raw_bids = _collect_raw_bids(clearinghouse_packet)
    preserved_reason_codes = _collect_packet_reason_codes(clearinghouse_packet)
    unsettled_lots = bool(compacted_lots)
    raw_routeable_candidate_count = _int(
        clearinghouse_packet.get("routeable_candidate_count")
        or clearinghouse_packet.get("accepted_routeable_candidate_count")
    )
    routeable_candidate_count = 0 if unsettled_lots else raw_routeable_candidate_count
    ledger_id = _ref(
        "repair-bid-settlement-ledger",
        {
            "account_label": account_label,
            "session_id": session_id,
            "clearinghouse_packet_id": clearinghouse_packet.get("packet_id"),
            "selected_lot_ids": selected_lot_ids,
            "raw_reason_codes": preserved_reason_codes,
        },
    )
    return {
        "schema_version": REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": (
            generated_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account_id": account_label,
        "session_id": session_id,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
        "raw_clearinghouse_packet_ref": clearinghouse_packet.get("packet_id"),
        "routeability_acceptance_ledger_ref": routeability_ledger.get("ledger_id"),
        "raw_repair_bid_count": len(raw_bids),
        "raw_reason_codes_preserved": preserved_reason_codes,
        "compacted_lots": compacted_lots,
        "selected_lot_ids": selected_lot_ids,
        "dispatchable_lot_ids": dispatchable_lot_ids,
        "held_lot_ids": held_lot_ids,
        "active_dedupe_keys": active_keys,
        "routeable_candidate_count": routeable_candidate_count,
        "zero_notional_or_stale_evidence_rate": clearinghouse_packet.get(
            "zero_notional_or_stale_evidence_rate", 1
        ),
        "fill_tca_or_slippage_quality": clearinghouse_packet.get(
            "fill_tca_or_slippage_quality",
            {"state": "unknown", "reason_codes": []},
        ),
        "capital_decision": "repair_only"
        if unsettled_lots
        else clearinghouse_packet.get("capital_decision", "observe_only"),
        "max_notional": _ZERO_NOTIONAL,
        "summary": {
            "raw_repair_bid_count": len(raw_bids),
            "compacted_lot_count": len(compacted_lots),
            "selected_lot_count": len(selected_lot_ids),
            "dispatchable_lot_count": len(dispatchable_lot_ids),
            "held_lot_count": len(held_lot_ids),
            "max_selected_lots": _MAX_SELECTED_LOTS,
            "max_dispatchable_lots": _MAX_DISPATCHABLE_LOTS,
            "value_gates": _VALUE_GATES,
            "routeable_candidate_count": routeable_candidate_count,
        },
        "rollback_target": {
            "repair_bid_settlement_consumption_enabled": False,
            "fallback_payload": "torghut.route-evidence-clearinghouse-packet.v1",
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
        },
    }


__all__ = [
    "REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION",
    "build_repair_bid_settlement_ledger",
]
