"""Quality-adjusted profit frontier projection for shadow repair ranking."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, cast

from .market_context_domains import (
    ACTIVE_MARKET_CONTEXT_DOMAINS,
    active_market_context_reasons,
)
from .risk import target_sizing_payload


SCHEMA_VERSION = "torghut.quality-adjusted-profit-frontier.v1"

_READY_STATES = {"clean", "current", "good", "pass", "present", "quality_good"}
_ALLOW_DECISIONS = {"allow", "approved", "current", "pass"}
_ROUTEABLE_STATES = {"routeable", "probing"}
_BLOCKING_PROOF_STATES = {"degraded", "fail", "missing", "stale"}


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _number(value: object, default: int = 0) -> int:
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


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _strings(value: object) -> list[str]:
    return sorted({text for item in _sequence(value) if (text := _text(item))})


def _first(source: Mapping[str, Any], *keys: str, default: str = "") -> str:
    for key in keys:
        if value := _text(source.get(key)):
            return value
    return default


def _hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    return (
        parsed.replace(tzinfo=timezone.utc)
        if parsed.tzinfo is None
        else parsed.astimezone(timezone.utc)
    )


def _quality_ref(source: Mapping[str, Any] | None) -> dict[str, object]:
    payload = _mapping(source)
    ref = (
        _first(
            payload,
            "jangar_evidence_quality_ref",
            "evidence_quality_ref",
            "quality_ledger_ref",
            "quality_ref",
            "receipt_id",
            "epoch_id",
        )
        or None
    )
    state = _first(
        payload,
        "quality_state",
        "evidence_quality_state",
        "state",
        default="missing" if ref is None else "unknown",
    ).lower()
    decision = _first(
        payload, "decision", default="missing" if ref is None else "unknown"
    ).lower()
    blockers = set(_strings(payload.get("blocking_reasons")))
    if ref is None:
        blockers.add("jangar_quality_ledger_missing")
    elif state not in _READY_STATES:
        blockers.add("jangar_quality_not_clean")
    if ref is not None and decision != "unknown" and decision not in _ALLOW_DECISIONS:
        blockers.add(f"jangar_quality_{decision}")
    if _truthy(payload.get("non_promoting_receipt")):
        blockers.add("jangar_quality_non_promoting_receipt")
    return {
        "ref": ref,
        "quality_state": state,
        "decision": decision,
        "non_promoting_receipt": _truthy(payload.get("non_promoting_receipt")),
        "blocking_reasons": sorted(blockers),
    }


def _proof_blockers(proof_floor: Mapping[str, Any]) -> list[str]:
    blockers = set(_strings(proof_floor.get("blocking_reasons")))
    for raw_dimension in _sequence(proof_floor.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("state")).lower() in _BLOCKING_PROOF_STATES:
            if reason := _text(dimension.get("reason")):
                blockers.add(reason)
    return sorted(blockers)


def _quant_receipts(quant: Mapping[str, Any]) -> list[str]:
    receipts = set(_strings(quant.get("non_promoting_receipts")))
    receipts.update(_strings(quant.get("blocking_reasons")))
    receipts.update(_strings(quant.get("informational_reasons")))
    latest = _number(quant.get("latest_metrics_count"))
    degraded = _number(
        quant.get("degraded_latest_metrics_count")
        or quant.get("latest_degraded_metrics_count")
        or quant.get("degradedMetricsCount")
    )
    if latest > 0 and degraded > 0:
        receipts.add("quant_latest_metrics_degraded")
    if _number(quant.get("stage_count"), default=-1) == 0:
        receipts.add("quant_pipeline_stages_missing")
    if _text(quant.get("quality_state")).lower() in {"degraded", "dirty", "fail"}:
        receipts.add("quant_quality_degraded")
    for raw_alert in _sequence(quant.get("open_alerts") or quant.get("alerts")):
        alert = _mapping(raw_alert)
        if _text(alert.get("severity")).lower() == "critical" and _text(
            alert.get("status"), "open"
        ).lower() in {
            "active",
            "firing",
            "open",
        }:
            receipts.add("quant_critical_alert_open")
    return sorted(receipts)


def _market_receipts(market: Mapping[str, Any]) -> list[str]:
    receipts: set[str] = set()
    state = _first(market, "state", "status", "overallState", "overall_state").lower()
    if state in {"degraded", "down", "error", "fail", "stale"}:
        receipts.add(f"market_context_{state}")
    if _truthy(market.get("alert_active")):
        receipts.add(_text(market.get("alert_reason"), "market_context_alert_active"))
    stale_count = sum(
        _number(market.get(key))
        for key in (
            "stale_snapshot_count",
            *(f"stale_{domain}_count" for domain in ACTIVE_MARKET_CONTEXT_DOMAINS),
        )
    )
    risk_count = len(active_market_context_reasons(_strings(market.get("risk_flags"))))
    if stale_count > 0:
        receipts.add("market_context_stale")
    if risk_count > 0:
        receipts.add("market_context_risk_flags")
    return sorted(receipts)


def _simulation_receipts(
    simulation: Mapping[str, Any],
    *,
    now: datetime,
    max_age_seconds: int,
) -> list[str]:
    if simulation.get("enabled") is False:
        return ["simulation_cache_missing"]
    updated_at = _timestamp(
        simulation.get("last_updated_at")
        or simulation.get("updated_at")
        or simulation.get("max_updated_at")
    )
    if updated_at is None:
        return ["simulation_cache_missing"]
    max_age = max(
        0, _number(simulation.get("max_age_seconds"), default=max_age_seconds)
    )
    if int((now - updated_at).total_seconds()) > max_age:
        return ["simulation_cache_stale"]
    return []


def _route_rows(board: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        cast(Mapping[str, Any], row)
        for row in _sequence(board.get("rows"))
        if isinstance(row, Mapping)
    ]


def _hypothesis_refs(
    payload: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]
) -> list[str]:
    refs: set[str] = set()
    for raw_item in _sequence(payload.get("items")):
        item = _mapping(raw_item)
        for key in ("hypothesis_id", "id", "candidate_id", "strategy_id"):
            if ref := _text(item.get(key)):
                refs.add(ref)
                break
    for row in rows:
        refs.update(_strings(row.get("hypothesis_ids")))
    return sorted(refs) or ["global"]


def _candidate_target_sizing(
    hypothesis_payload: Mapping[str, Any],
) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    summary = _mapping(hypothesis_payload.get("summary"))
    summary_defaults = {
        "target_daily_net_pnl": summary.get("target_daily_net_pnl"),
        "capacity_daily_notional": summary.get("capacity_daily_notional"),
        "drawdown_budget": summary.get("drawdown_budget"),
        "allocated_sleeve_equity": summary.get("allocated_sleeve_equity"),
    }
    for raw_item in _sequence(hypothesis_payload.get("items")):
        item = _mapping(raw_item)
        contract = _mapping(item.get("promotion_contract"))
        sizing = _mapping(item.get("target_sizing"))
        source = {
            "target_daily_net_pnl": sizing.get("target_daily_net_pnl")
            or item.get("target_daily_net_pnl")
            or contract.get("target_daily_net_pnl")
            or summary_defaults["target_daily_net_pnl"]
            or "500",
            "observed_post_cost_expectancy_bps": sizing.get(
                "observed_post_cost_expectancy_bps"
            )
            or item.get("observed_post_cost_expectancy_bps")
            or contract.get("observed_post_cost_expectancy_bps")
            or item.get("post_cost_expectancy_bps")
            or contract.get("post_cost_expectancy_bps"),
            "capacity_daily_notional": sizing.get("capacity_daily_notional")
            or item.get("capacity_daily_notional")
            or contract.get("capacity_daily_notional")
            or summary_defaults["capacity_daily_notional"],
            "drawdown_budget": sizing.get("drawdown_budget")
            or item.get("drawdown_budget")
            or contract.get("drawdown_budget")
            or summary_defaults["drawdown_budget"],
            "allocated_sleeve_equity": sizing.get("allocated_sleeve_equity")
            or item.get("allocated_sleeve_equity")
            or contract.get("allocated_sleeve_equity")
            or summary_defaults["allocated_sleeve_equity"],
        }
        payload = target_sizing_payload(source)
        refs = [
            _text(item.get(key))
            for key in ("hypothesis_id", "id", "candidate_id", "strategy_id")
        ]
        lineage = _mapping(item.get("lineage_ref"))
        refs.extend(_text(lineage.get(key)) for key in ("candidate_id", "strategy_id"))
        for ref in refs:
            if ref:
                result[ref] = payload
    return result


def _target_sizing_for_packet(
    *,
    row: Mapping[str, Any] | None,
    hypothesis_ref: str,
    candidate_sizing: Mapping[str, Mapping[str, object]],
) -> dict[str, object]:
    route = _mapping(row)
    route_source = {
        "target_daily_net_pnl": route.get("target_daily_net_pnl"),
        "observed_post_cost_expectancy_bps": route.get(
            "observed_post_cost_expectancy_bps"
        )
        or route.get("post_cost_expectancy_bps")
        or route.get("expectancy_bps"),
        "capacity_daily_notional": route.get("capacity_daily_notional"),
        "drawdown_budget": route.get("drawdown_budget"),
        "allocated_sleeve_equity": route.get("allocated_sleeve_equity"),
    }
    if any(value is not None for value in route_source.values()):
        route_source["target_daily_net_pnl"] = (
            route_source["target_daily_net_pnl"] or "500"
        )
        return target_sizing_payload(route_source)
    return dict(candidate_sizing.get(hypothesis_ref) or target_sizing_payload({}))


def _route_repair_class(row: Mapping[str, Any]) -> str:
    state = _text(row.get("state")).lower()
    if state in _ROUTEABLE_STATES:
        return "route"
    return "simulation" if state == "missing" else "tca"


def _route_edge(row: Mapping[str, Any], repair_class: str) -> float:
    if repair_class == "route":
        return 20.0 + float(_number(row.get("expected_unblock_value"), 1) * 3)
    if repair_class == "simulation":
        return 22.0
    return 24.0 + float(_number(row.get("filled_execution_count")) // 500)


def _discounts(
    row: Mapping[str, Any] | None,
    quality: Mapping[str, object],
    quant_receipts: Sequence[str],
    market_receipts: Sequence[str],
    simulation_receipts: Sequence[str],
) -> dict[str, float]:
    route = _mapping(row)
    cost_class = _text(route.get("expected_cost_class")).lower()
    route_state = _text(route.get("state")).lower()
    observed = _float(route.get("avg_abs_slippage_bps"))
    guardrail = _float(route.get("slippage_guardrail_bps"))
    quality_discount = 0.0
    if quality.get("ref") is None:
        quality_discount += 10.0
    elif _strings(quality.get("blocking_reasons")):
        quality_discount += 8.0
    if "quant_latest_metrics_degraded" in quant_receipts:
        quality_discount += 14.0
    if "quant_pipeline_stages_missing" in quant_receipts:
        quality_discount += 6.0
    if "market_context_risk_flags" in market_receipts:
        quality_discount += 8.0
    if "market_context_stale" in market_receipts:
        quality_discount += 6.0
    return {
        "quality_discount": quality_discount,
        "resource_discount": 5.0
        if cost_class.startswith("high")
        else 3.0
        if cost_class.startswith("medium")
        else 1.0
        if cost_class.startswith("low")
        else 2.0,
        "staleness_discount": 6.0 if simulation_receipts else 0.0,
        "route_discount": 0.0
        if route_state == "routeable"
        else 2.0
        if route_state == "probing"
        else 5.0
        if route_state == "blocked"
        else 6.0
        if route_state == "missing"
        else 3.0
        if not route
        else 4.0,
        "tca_discount": min(10.0, observed - guardrail)
        if observed is not None and guardrail is not None and observed > guardrail
        else 4.0
        if route_state == "missing"
        else 2.0
        if not route
        else 0.0,
        "simulation_discount": 6.0 if simulation_receipts else 0.0,
    }


def _packet(
    *,
    account_label: str | None,
    trading_mode: str,
    generated_at: str,
    symbol: str | None,
    repair_class: str,
    hypothesis_ref: str,
    raw_edge: float,
    row: Mapping[str, Any] | None,
    quality: Mapping[str, object],
    quant_receipts: Sequence[str],
    market_receipts: Sequence[str],
    simulation_receipts: Sequence[str],
    target_sizing: Mapping[str, object] | None = None,
) -> dict[str, object]:
    non_promoting = sorted(
        {
            *quant_receipts,
            *market_receipts,
            *simulation_receipts,
            *_strings(quality.get("blocking_reasons")),
        }
    )
    discounts = _discounts(
        row, quality, quant_receipts, market_receipts, simulation_receipts
    )
    adjusted_edge = round(raw_edge - sum(discounts.values()), 4)
    decision = (
        "hold"
        if "quant_critical_alert_open" in non_promoting or adjusted_edge <= 0
        else "repair"
        if non_promoting
        else "observe"
    )
    packet_id = "qapf:" + _hash(
        "quality-adjusted-packet",
        {
            "account_label": account_label,
            "trading_mode": trading_mode,
            "generated_at": generated_at,
            "symbol": symbol,
            "repair_class": repair_class,
            "hypothesis_ref": hypothesis_ref,
            "non_promoting_receipts": non_promoting,
        },
    )
    return {
        "packet_id": packet_id,
        "symbol": symbol,
        "repair_class": repair_class,
        "hypothesis_ref": hypothesis_ref,
        "capital_class": "zero_notional_repair" if non_promoting else "observe",
        "target_notional_ranking": dict(target_sizing or {}),
        **discounts,
        "quality_adjusted_edge": adjusted_edge,
        "jangar_evidence_quality_ref": quality.get("ref"),
        "decision": decision,
        "missing_receipts": [
            receipt
            for receipt in (
                "jangar_quality" if quality.get("ref") is None else "",
                "route" if row is None and repair_class in {"route", "tca"} else "",
                "simulation"
                if "simulation_cache_missing" in simulation_receipts
                else "",
            )
            if receipt
        ],
        "non_promoting_receipts": non_promoting,
        "stop_conditions": [
            "quality_adjusted_edge_non_positive",
            "required_receipts_missing_or_non_promoting",
            "paper_live_notional_must_remain_zero",
        ],
        "max_notional": "0",
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "frontier_packet_id": packet_id,
        },
    }


def _escrow(
    hypothesis_ref: str,
    quality: Mapping[str, object],
    quant_receipts: Sequence[str],
    market_receipts: Sequence[str],
    simulation_receipts: Sequence[str],
    proof_blockers: Sequence[str],
) -> dict[str, object]:
    blockers = sorted(
        {
            *quant_receipts,
            *market_receipts,
            *simulation_receipts,
            *_strings(quality.get("blocking_reasons")),
            *proof_blockers,
        }
    )
    return {
        "hypothesis_ref": hypothesis_ref,
        "evidence_escrow_id": "hypothesis-escrow:"
        + _hash(
            "hypothesis-escrow",
            {"hypothesis_ref": hypothesis_ref, "blockers": blockers},
        ),
        "required_receipts": {
            "quant": {
                "state": "non_promoting" if quant_receipts else "clean",
                "reason_codes": list(quant_receipts),
            },
            "market_context": {
                "state": "non_promoting" if market_receipts else "clean",
                "reason_codes": list(market_receipts),
            },
            "route": {"state": "shadow"},
            "tca": {"state": "shadow"},
            "simulation": {
                "state": "non_promoting" if simulation_receipts else "clean",
                "reason_codes": list(simulation_receipts),
            },
        },
        "promotion_state": "repair_only" if blockers else "paper_eligible",
        "blockers": blockers,
        "missing_receipts": [
            receipt
            for receipt in (
                "jangar_quality" if quality.get("ref") is None else "",
                "simulation"
                if "simulation_cache_missing" in simulation_receipts
                else "",
            )
            if receipt
        ],
        "non_promoting_receipts": blockers,
    }


def build_quality_adjusted_profit_frontier(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    simulation_cache_status: Mapping[str, Any] | None = None,
    jangar_evidence_quality: Mapping[str, Any] | None = None,
    now: datetime | None = None,
    simulation_max_age_seconds: int = 7 * 24 * 60 * 60,
) -> dict[str, object]:
    """Build a shadow frontier that ranks repair work without authorizing capital."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    generated_at = observed_at.isoformat()
    simulation = _mapping(simulation_cache_status)
    quality = _quality_ref(jangar_evidence_quality)
    quant_receipts = _quant_receipts(quant_evidence)
    market_receipts = _market_receipts(market_context_status)
    simulation_receipts = _simulation_receipts(
        simulation,
        now=observed_at,
        max_age_seconds=simulation_max_age_seconds,
    )
    proof_blockers = _proof_blockers(proof_floor_receipt)
    live_blockers = sorted(
        {
            *_strings(live_submission_gate.get("blocked_reasons")),
            *_strings(live_submission_gate.get("blocking_reasons")),
        }
    )
    route_rows = _route_rows(route_reacquisition_board)
    hypothesis_refs = _hypothesis_refs(hypothesis_payload, route_rows)
    candidate_sizing = _candidate_target_sizing(hypothesis_payload)
    default_hypothesis = hypothesis_refs[0]
    packets: list[dict[str, object]] = []

    for repair_class, receipts, raw_edge in (
        ("quant", quant_receipts, 40.0),
        ("market_context", market_receipts, 32.0),
        ("simulation", simulation_receipts, 28.0),
    ):
        if receipts:
            packets.append(
                _packet(
                    account_label=account_label,
                    trading_mode=trading_mode,
                    generated_at=generated_at,
                    symbol=None,
                    repair_class=repair_class,
                    hypothesis_ref=default_hypothesis,
                    raw_edge=raw_edge,
                    row=None,
                    quality=quality,
                    quant_receipts=receipts if repair_class == "quant" else [],
                    market_receipts=receipts
                    if repair_class == "market_context"
                    else [],
                    simulation_receipts=receipts
                    if repair_class == "simulation"
                    else [],
                    target_sizing=_target_sizing_for_packet(
                        row=None,
                        hypothesis_ref=default_hypothesis,
                        candidate_sizing=candidate_sizing,
                    ),
                )
            )

    for row in route_rows:
        repair_class = _route_repair_class(row)
        row_hypotheses = _strings(row.get("hypothesis_ids"))
        row_hypothesis_ref = row_hypotheses[0] if row_hypotheses else default_hypothesis
        packets.append(
            _packet(
                account_label=account_label,
                trading_mode=trading_mode,
                generated_at=generated_at,
                symbol=_text(row.get("symbol")) or None,
                repair_class=repair_class,
                hypothesis_ref=row_hypothesis_ref,
                raw_edge=_route_edge(row, repair_class),
                row=row,
                quality=quality,
                quant_receipts=quant_receipts,
                market_receipts=market_receipts,
                simulation_receipts=simulation_receipts,
                target_sizing=_target_sizing_for_packet(
                    row=row,
                    hypothesis_ref=row_hypothesis_ref,
                    candidate_sizing=candidate_sizing,
                ),
            )
        )

    packets.sort(
        key=lambda packet: (
            -(_float(packet.get("quality_adjusted_edge")) or 0.0),
            0
            if _text(_mapping(packet.get("target_notional_ranking")).get("status"))
            == "feasible"
            else 1,
            _float(
                _mapping(packet.get("target_notional_ranking")).get(
                    "required_daily_notional"
                )
            )
            or 0.0,
            _text(packet.get("packet_id")),
        )
    )
    blockers = sorted(
        {
            *proof_blockers,
            *live_blockers,
            *quant_receipts,
            *market_receipts,
            *simulation_receipts,
            *_strings(quality.get("blocking_reasons")),
        }
    )
    capital_ready = not blockers and _text(
        proof_floor_receipt.get("capital_state")
    ) not in {
        "zero_notional",
        "closed_session_hold",
    }
    escrows = [
        _escrow(
            ref,
            quality,
            quant_receipts,
            market_receipts,
            simulation_receipts,
            proof_blockers,
        )
        for ref in hypothesis_refs
    ]
    frontier_id = "quality-frontier:" + _hash(
        "quality-adjusted-profit-frontier",
        {
            "account_label": account_label,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "proof_floor_generated_at": proof_floor_receipt.get("generated_at"),
            "quality_ref": quality.get("ref"),
            "packet_ids": [_text(packet.get("packet_id")) for packet in packets],
        },
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "frontier_id": frontier_id,
        "generated_at": generated_at,
        "capital_state": "paper_shadow_candidate" if capital_ready else "zero_notional",
        "paper_probe_notional_limit": "configured_by_risk" if capital_ready else "0",
        "live_notional_limit": "configured_by_risk" if capital_ready else "0",
        "jangar_evidence_quality_ref": quality,
        "packets": packets,
        "hypothesis_escrows": escrows,
        "blocked_capital_surfaces": blockers,
        "summary": {
            "packet_count": len(packets),
            "paper_candidate_count": 1 if capital_ready else 0,
            "capital_ready": capital_ready,
            "target_notional_feasible_packet_count": sum(
                1
                for packet in packets
                if _text(_mapping(packet.get("target_notional_ranking")).get("status"))
                == "feasible"
            ),
        },
    }
