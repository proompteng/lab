"""Profitability proof-floor receipts for capital-qualified trading routes."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from ..discovery.promotion_contract import (
    final_authority_parameter_contract,
    probation_evidence_collection_contract,
)
from ..risk import target_sizing_payload


BLOCKING_STATES = {"degraded", "fail", "missing", "stale"}

LIVE_MICRO_STAGES = {"0.10x canary", "0.25x canary"}

LIVE_SCALE_STAGES = {"0.50x live", "1.00x live"}


def text_value(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def bool_value(value: object) -> bool:
    return bool(value)


def int_value(value: object, default: int = 0) -> int:
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


def decimal_value(value: object) -> Decimal | None:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str) and value.strip():
        try:
            return Decimal(value.strip())
        except InvalidOperation:
            return None
    return None


def decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    normalized = value.normalize()
    rendered = format(normalized, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def parse_timestamp(value: object) -> datetime | None:
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
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def mapping_value(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def sequence_value(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def hypothesis_summary(hypothesis_payload: Mapping[str, Any]) -> Mapping[str, Any]:
    summary = hypothesis_payload.get("summary")
    if isinstance(summary, Mapping):
        return cast(Mapping[str, Any], summary)
    return hypothesis_payload


def hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        item
        for item in sequence_value(hypothesis_payload.get("items"))
        if isinstance(item, Mapping)
    ]


def strings_value(value: object) -> list[str]:
    return sorted(
        {text_value(item) for item in sequence_value(value) if text_value(item)}
    )


def truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "pass", "ready"}
    return bool(value)


def first_decimal_from(
    source: Mapping[str, Any], keys: Sequence[str]
) -> Decimal | None:
    for key in keys:
        value = decimal_value(source.get(key))
        if value is not None:
            return value
    return None


def target_sizing_source_for_item(
    item: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None,
) -> dict[str, object]:
    contract = mapping_value(item.get("promotion_contract"))
    sizing = mapping_value(item.get("target_sizing"))
    simple = mapping_value(simple_lane_status)
    expectancy = first_decimal_from(
        sizing,
        (
            "observed_post_cost_expectancy_bps",
            "post_cost_expectancy_bps",
            "expectancy_bps",
        ),
    )
    if expectancy is None:
        expectancy = first_decimal_from(
            item,
            (
                "observed_post_cost_expectancy_bps",
                "post_cost_expectancy_bps",
                "expectancy_bps",
            ),
        )
    if expectancy is None:
        expectancy = first_decimal_from(
            contract,
            (
                "observed_post_cost_expectancy_bps",
                "post_cost_expectancy_bps",
                "expectancy_bps",
            ),
        )
    return {
        "target_daily_net_pnl": sizing.get("target_daily_net_pnl")
        or item.get("target_daily_net_pnl")
        or contract.get("target_daily_net_pnl")
        or "500",
        "observed_post_cost_expectancy_bps": decimal_text(expectancy),
        "capacity_daily_notional": sizing.get("capacity_daily_notional")
        or item.get("capacity_daily_notional")
        or contract.get("capacity_daily_notional")
        or simple.get("capacity_daily_notional"),
        "drawdown_budget": sizing.get("drawdown_budget")
        or item.get("drawdown_budget")
        or contract.get("drawdown_budget")
        or simple.get("drawdown_budget"),
        "allocated_sleeve_equity": sizing.get("allocated_sleeve_equity")
        or item.get("allocated_sleeve_equity")
        or contract.get("allocated_sleeve_equity")
        or simple.get("allocated_sleeve_equity"),
    }


def target_notional_parameter_summary(
    hypothesis_payload: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None,
) -> dict[str, object]:
    candidate_payloads: list[dict[str, object]] = []
    blockers: set[str] = set()
    for item in hypothesis_items(hypothesis_payload):
        candidate_id = text_value(item.get("candidate_id"))
        lineage = mapping_value(item.get("lineage_ref"))
        if not candidate_id:
            candidate_id = text_value(lineage.get("candidate_id"))
        hypothesis_id = text_value(
            item.get("hypothesis_id"), text_value(item.get("id"))
        )
        source = target_sizing_source_for_item(item, simple_lane_status)
        sizing = target_sizing_payload(source)
        item_blockers = strings_value(sizing.get("blocking_reasons"))
        blockers.update(item_blockers)
        candidate_payloads.append(
            {
                "candidate_id": candidate_id or hypothesis_id,
                "hypothesis_id": hypothesis_id,
                "status": sizing["status"],
                "target_daily_net_pnl": sizing["target_daily_net_pnl"],
                "observed_post_cost_expectancy_bps": sizing[
                    "observed_post_cost_expectancy_bps"
                ],
                "required_daily_notional": sizing["required_daily_notional"],
                "capacity_daily_notional": sizing["capacity_daily_notional"],
                "drawdown_budget": sizing["drawdown_budget"],
                "drawdown_cap": sizing["drawdown_cap"],
                "blocking_reasons": item_blockers,
                "authority": "ranking_metadata_only",
            }
        )
    if not candidate_payloads:
        blockers.add("target_notional_candidate_missing")
    feasible_count = sum(
        1 for item in candidate_payloads if item["status"] == "feasible"
    )
    return {
        "state": "pass" if feasible_count > 0 and not blockers else "fail",
        "reason": "target_notional_parameters_feasible"
        if feasible_count > 0 and not blockers
        else sorted(blockers)[0],
        "candidate_count": len(candidate_payloads),
        "feasible_candidate_count": feasible_count,
        "blocking_reasons": sorted(blockers),
        "candidates": candidate_payloads,
        "final_authority_contract": final_authority_parameter_contract(),
        "probation_evidence_collection": probation_evidence_collection_contract(),
    }


def hypothesis_repair_target_summary(
    hypothesis_payload: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_ids: set[str] = set()
    promotion_eligible_ids: set[str] = set()
    blocked_ids: set[str] = set()
    repair_targets: list[dict[str, object]] = []

    for item in hypothesis_items(hypothesis_payload):
        lineage_ref = mapping_value(item.get("lineage_ref"))
        hypothesis_id = text_value(
            item.get("hypothesis_id"), text_value(lineage_ref.get("hypothesis_id"))
        )
        if not hypothesis_id:
            continue
        if hypothesis_id in hypothesis_ids:
            continue

        hypothesis_ids.add(hypothesis_id)
        promotion_eligible = truthy(item.get("promotion_eligible"))
        if promotion_eligible:
            promotion_eligible_ids.add(hypothesis_id)
        else:
            blocked_ids.add(hypothesis_id)

        candidate_id = text_value(
            item.get("candidate_id"), text_value(lineage_ref.get("candidate_id"))
        )
        strategy_id = text_value(
            item.get("strategy_id"), text_value(lineage_ref.get("strategy_id"))
        )
        lane_id = text_value(
            item.get("lane_id"), text_value(lineage_ref.get("lane_id"))
        )
        strategy_family = text_value(
            item.get("strategy_family"), text_value(lineage_ref.get("strategy_family"))
        )
        target: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "state": text_value(item.get("state"), "unknown"),
            "promotion_eligible": promotion_eligible,
            "reasons": strings_value(item.get("reasons")),
            "informational_reasons": strings_value(item.get("informational_reasons")),
        }
        if candidate_id:
            target["candidate_id"] = candidate_id
        if strategy_id:
            target["strategy_id"] = strategy_id
        if lane_id:
            target["lane_id"] = lane_id
        if strategy_family:
            target["strategy_family"] = strategy_family
        if len(repair_targets) < 5:
            repair_targets.append(target)

    return {
        "hypothesis_ids": sorted(hypothesis_ids),
        "blocked_hypothesis_ids": sorted(blocked_ids),
        "promotion_eligible_hypothesis_ids": sorted(promotion_eligible_ids),
        "repair_target_count": len(hypothesis_ids),
        "blocked_repair_target_count": len(blocked_ids),
        "promotion_eligible_repair_target_count": len(promotion_eligible_ids),
        "repair_targets": repair_targets,
    }


def reason_counts(hypothesis_payload: Mapping[str, Any]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for item in hypothesis_items(hypothesis_payload):
        for reason in sequence_value(item.get("reasons")):
            normalized = text_value(reason)
            if normalized:
                counts[normalized] += 1
    return counts


def slippage_guardrails(hypothesis_payload: Mapping[str, Any]) -> list[Decimal]:
    guardrails: list[Decimal] = []
    for item in hypothesis_items(hypothesis_payload):
        contract = mapping_value(item.get("promotion_contract"))
        value = decimal_value(contract.get("max_avg_abs_slippage_bps"))
        if value is not None:
            guardrails.append(value)
    return guardrails


def tca_symbol_routes(
    tca_summary: Mapping[str, Any],
    *,
    slippage_guardrail: Decimal | None,
    route_slippage_guardrail: Decimal | None = None,
) -> dict[str, object] | None:
    rows: list[Mapping[str, Any]] = []
    for item in sequence_value(tca_summary.get("symbol_breakdown")):
        if isinstance(item, Mapping):
            rows.append(cast(Mapping[str, Any], item))
    if not rows:
        return None

    routeable_symbols: list[dict[str, object]] = []
    blocked_symbols: list[dict[str, object]] = []
    missing_symbols: list[str] = []
    for row in rows:
        symbol = text_value(row.get("symbol"))
        if not symbol:
            continue
        order_count = int_value(row.get("order_count"))
        avg_abs_slippage = decimal_value(row.get("avg_abs_slippage_bps"))
        avg_realized_shortfall = decimal_value(row.get("avg_realized_shortfall_bps"))
        route_adverse_slippage = (
            max(avg_realized_shortfall, Decimal("0"))
            if avg_realized_shortfall is not None
            else avg_abs_slippage
        )
        symbol_payload: dict[str, object] = {
            "symbol": symbol,
            "order_count": order_count,
            "avg_abs_slippage_bps": decimal_text(avg_abs_slippage),
            "avg_realized_shortfall_bps": decimal_text(avg_realized_shortfall),
            "route_adverse_slippage_bps": decimal_text(route_adverse_slippage),
            "route_slippage_basis": "signed_realized_shortfall_bps"
            if avg_realized_shortfall is not None
            else "avg_abs_slippage_bps_fallback",
            "max_abs_slippage_bps": decimal_text(
                decimal_value(row.get("max_abs_slippage_bps"))
            ),
            "last_computed_at": row.get("last_computed_at"),
        }
        if order_count <= 0:
            missing_symbols.append(symbol)
            continue
        route_guardrail = route_slippage_guardrail or slippage_guardrail
        if (
            route_guardrail is not None
            and route_adverse_slippage is not None
            and route_adverse_slippage > route_guardrail
        ):
            blocked_symbols.append(symbol_payload)
            continue
        routeable_symbols.append(symbol_payload)

    payload: dict[str, object] = {
        "scope_symbols": list(sequence_value(tca_summary.get("scope_symbols"))),
        "scope_symbol_count": int_value(tca_summary.get("scope_symbol_count")),
        "slippage_guardrail_bps": decimal_text(slippage_guardrail),
        "routeable_symbol_count": len(routeable_symbols),
        "blocked_symbol_count": len(blocked_symbols),
        "missing_symbol_count": len(missing_symbols),
        "routeable_symbols": routeable_symbols,
        "blocked_symbols": blocked_symbols,
        "missing_symbols": missing_symbols,
    }
    if (
        route_slippage_guardrail is not None
        and route_slippage_guardrail != slippage_guardrail
    ):
        payload["route_slippage_guardrail_bps"] = decimal_text(route_slippage_guardrail)
    return payload


def route_universe_adverse_slippage_clear(
    symbol_routes: Mapping[str, Any],
    *,
    route_filter_enabled: bool,
    aggregate_tca_reason: str,
) -> bool:
    if not route_filter_enabled:
        return False
    if aggregate_tca_reason != "execution_tca_slippage_guardrail_exceeded":
        return False
    scope_symbol_count = int_value(symbol_routes.get("scope_symbol_count"))
    routeable_symbol_count = int_value(symbol_routes.get("routeable_symbol_count"))
    if (
        scope_symbol_count <= 0
        or routeable_symbol_count <= 0
        or routeable_symbol_count != scope_symbol_count
        or int_value(symbol_routes.get("blocked_symbol_count")) > 0
        or int_value(symbol_routes.get("missing_symbol_count")) > 0
    ):
        return False
    route_guardrail = decimal_value(
        symbol_routes.get("route_slippage_guardrail_bps")
    ) or decimal_value(symbol_routes.get("slippage_guardrail_bps"))
    if route_guardrail is None:
        return False
    for item in sequence_value(symbol_routes.get("routeable_symbols")):
        if not isinstance(item, Mapping):
            return False
        row = cast(Mapping[str, Any], item)
        if row.get("route_slippage_basis") != "signed_realized_shortfall_bps":
            return False
        route_adverse_slippage = decimal_value(row.get("route_adverse_slippage_bps"))
        if route_adverse_slippage is None or route_adverse_slippage > route_guardrail:
            return False
    return True


def route_symbol_filter_enabled(
    simple_lane_status: Mapping[str, Any] | None,
) -> bool:
    if not isinstance(simple_lane_status, Mapping):
        return False
    value = simple_lane_status.get("route_symbol_filter_enabled")
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "enabled"}
    return bool(value)


def add_repair(
    repairs: list[dict[str, object]],
    *,
    code: str,
    dimension: str,
    action: str,
    reason: str,
    priority: int,
    expected_unblock_value: int = 1,
    max_notional: str = "0",
) -> None:
    repairs.append(
        {
            "code": code,
            "dimension": dimension,
            "action": action,
            "reason": reason,
            "priority": priority,
            "expected_unblock_value": expected_unblock_value,
            "max_notional": max_notional,
        }
    )
