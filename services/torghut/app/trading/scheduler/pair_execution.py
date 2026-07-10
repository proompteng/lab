"""Balanced capital reservation for cross-sectional pair entries."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from dataclasses import replace
from decimal import Decimal
from typing import cast

from ...config import settings
from ..models import StrategyDecision
from ..pair_intent import is_pair_entry
from ..portfolio import AllocationResult
from ..portfolio.allocation_helpers import (
    apply_projected_position_decision,
    extract_decision_price,
    portfolio_exposure,
    position_market_value,
    remaining_symbol_capacity,
)


def partition_pair_allocations(
    allocations: Iterable[AllocationResult],
) -> tuple[list[AllocationResult], list[AllocationResult]]:
    ordinary: list[AllocationResult] = []
    paired: list[AllocationResult] = []
    for allocation in allocations:
        (paired if is_pair_entry(allocation.decision) else ordinary).append(allocation)
    return ordinary, paired


def reserve_pair_allocations(
    allocations: Iterable[AllocationResult],
    *,
    account: dict[str, str],
    positions: list[dict[str, object]],
) -> list[list[AllocationResult]]:
    grouped: dict[tuple[str, str, str], list[AllocationResult]] = {}
    for allocation in allocations:
        decision = allocation.decision
        grouped.setdefault(_pair_signal_epoch(decision), []).append(allocation)
    projected_positions: list[dict[str, object]] = [
        dict(position) for position in positions
    ]
    remaining_buying_power = _spendable_buying_power(account)
    reserved_groups: list[list[AllocationResult]] = []
    for _, group in sorted(grouped.items()):
        reserved_group = _reserve_group(
            group,
            account=account,
            positions=projected_positions,
            buying_power_available=remaining_buying_power,
        )
        reserved_groups.append(reserved_group)
        if not reserved_group or any(not item.approved for item in reserved_group):
            continue
        reserved_notional = sum(
            (item.approved_notional or Decimal("0")) for item in reserved_group
        )
        if remaining_buying_power is not None:
            remaining_buying_power = max(
                Decimal("0"), remaining_buying_power - reserved_notional
            )
        for item in reserved_group:
            apply_projected_position_decision(projected_positions, item.decision)
    return reserved_groups


def _reserve_group(
    group: list[AllocationResult],
    *,
    account: dict[str, str],
    positions: list[dict[str, object]],
    buying_power_available: Decimal | None,
) -> list[AllocationResult]:
    reason = _pair_group_rejection(group)
    if reason is not None:
        return [_reject_pair_allocation(item, reason) for item in group]

    leg_notional = _reserved_leg_notional(
        group,
        account=account,
        positions=positions,
        buying_power_available=buying_power_available,
    )
    if leg_notional <= 0:
        return [
            _reject_pair_allocation(item, "pair_capital_reservation_unavailable")
            for item in group
        ]

    group_id = _pair_group_id(group)
    reserved: list[AllocationResult] = []
    for allocation in group:
        decision = allocation.decision
        price = extract_decision_price(decision)
        if price is None or price <= 0:
            return [
                _reject_pair_allocation(item, "pair_execution_price_unavailable")
                for item in group
            ]
        params = dict(decision.params)
        params["pair_execution"] = {
            "group_id": group_id,
            "leg_count": len(group),
            "reserved_leg_notional": str(leg_notional),
            "reservation_state": "reserved",
        }
        reserved_decision = decision.model_copy(
            update={"qty": leg_notional / price, "params": params}
        )
        reserved.append(
            replace(
                allocation,
                decision=reserved_decision,
                clipped=(
                    allocation.clipped or allocation.approved_notional != leg_notional
                ),
                approved_notional=leg_notional,
            )
        )
    _, current_net = portfolio_exposure(positions)
    preferred_action = "sell" if current_net > 0 else "buy" if current_net < 0 else None
    if preferred_action is not None:
        reserved.sort(key=lambda item: item.decision.action != preferred_action)
    return reserved


def _pair_group_rejection(group: list[AllocationResult]) -> str | None:
    if len(group) < 2:
        return "pair_opposite_leg_missing"
    if any(not item.approved for item in group):
        return "pair_allocator_reservation_failed"
    sides = [_pair_side(item.decision) for item in group]
    high_count = sides.count("high_rank")
    low_count = sides.count("low_rank")
    if high_count == 0 or low_count == 0:
        return "pair_opposite_leg_missing"
    if high_count != low_count:
        return "pair_leg_count_unbalanced"
    if len({item.decision.symbol for item in group}) != len(group):
        return "pair_symbol_duplicated"
    return None


def _pair_side(decision: StrategyDecision) -> str | None:
    for token in str(decision.rationale or "").split(","):
        key, separator, value = token.strip().partition(":")
        if separator and key == "pair_side" and value in {"high_rank", "low_rank"}:
            return value
    return None


def _reserved_leg_notional(
    group: list[AllocationResult],
    *,
    account: dict[str, str],
    positions: list[dict[str, object]],
    buying_power_available: Decimal | None,
) -> Decimal:
    equity = _positive_decimal(account.get("equity"))
    approved_notionals = [
        item.approved_notional
        for item in group
        if item.approved_notional is not None and item.approved_notional > 0
    ]
    if (
        equity is None
        or buying_power_available is None
        or len(approved_notionals) != len(group)
    ):
        return Decimal("0")

    gross, net = portfolio_exposure(positions)
    gross_limit = equity * Decimal(
        str(settings.trading_simple_max_gross_exposure_pct_equity)
    )
    net_fraction = _nonnegative_decimal(
        settings.trading_simple_max_net_exposure_pct_equity
    )
    if net_fraction is not None and abs(net) > equity * net_fraction:
        return Decimal("0")
    gross_room_per_leg = max(Decimal("0"), gross_limit - gross) / len(group)
    buying_power_per_leg = max(Decimal("0"), buying_power_available) / len(group)
    symbol_limit = equity * Decimal(str(settings.trading_simple_max_symbol_pct_equity))
    symbol_rooms = [
        remaining_symbol_capacity(
            symbol_limit,
            current_value=position_market_value(item.decision.symbol, positions)
            or Decimal("0"),
            action=item.decision.action,
            allow_shorts=True,
        )
        or Decimal("0")
        for item in group
    ]
    return min(
        min(approved_notionals),
        gross_room_per_leg,
        buying_power_per_leg,
        min(symbol_rooms),
    )


def _spendable_buying_power(account: Mapping[str, object]) -> Decimal | None:
    buying_power = _nonnegative_decimal(account.get("buying_power"))
    reserve_bps = _nonnegative_decimal(settings.trading_simple_buying_power_reserve_bps)
    if buying_power is None or reserve_bps is None:
        return None
    reserve_bps = min(Decimal("10000"), reserve_bps)
    return buying_power * (Decimal("10000") - reserve_bps) / Decimal("10000")


def _pair_group_id(group: list[AllocationResult]) -> str:
    parts = [
        ":".join((*_pair_signal_epoch(item.decision), item.decision.symbol))
        for item in sorted(group, key=lambda item: item.decision.symbol)
    ]
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:20]
    return f"pair-{digest}"


def _pair_signal_epoch(decision: StrategyDecision) -> tuple[str, str, str]:
    return (
        decision.strategy_id,
        decision.timeframe,
        decision.event_ts.isoformat(),
    )


def _reject_pair_allocation(
    allocation: AllocationResult,
    reason: str,
) -> AllocationResult:
    decision = allocation.decision
    params = dict(decision.params)
    allocator = params.get("allocator")
    allocator_payload: dict[str, object] = (
        {
            str(key): value
            for key, value in cast(Mapping[object, object], allocator).items()
        }
        if isinstance(allocator, Mapping)
        else {}
    )
    existing_reasons = allocator_payload.get("reason_codes")
    reason_codes = (
        [str(item) for item in cast(list[object], existing_reasons)]
        if isinstance(existing_reasons, list)
        else []
    )
    if reason not in reason_codes:
        reason_codes.append(reason)
    allocator_payload.update(
        {"status": "rejected", "approved": False, "reason_codes": reason_codes}
    )
    params["allocator"] = allocator_payload
    return replace(
        allocation,
        decision=decision.model_copy(update={"params": params}),
        approved=False,
        reason_codes=tuple(dict.fromkeys((*allocation.reason_codes, reason))),
        approved_notional=None,
    )


def _positive_decimal(value: object) -> Decimal | None:
    parsed = _nonnegative_decimal(value)
    return parsed if parsed is not None and parsed > 0 else None


def _nonnegative_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None
    return parsed if parsed.is_finite() and parsed >= 0 else None


__all__ = [
    "partition_pair_allocations",
    "reserve_pair_allocations",
]
