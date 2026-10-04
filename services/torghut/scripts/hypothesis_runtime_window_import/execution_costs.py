from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping

from scripts.hypothesis_runtime_window_import.common import (
    _alpaca_2026_equity_fee_schedule_cost,
    _first_decimal,
    _first_text,
)

__all__ = (
    "_strategy_name_candidates",
    "_runtime_execution_cost_amount",
    "_runtime_execution_cost_basis",
)


def _strategy_name_candidates(*values: str | None) -> list[str]:
    candidates: list[str] = []
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        variants = [
            raw,
            raw.split("@", 1)[0],
            raw.replace("_", "-"),
            raw.split("@", 1)[0].replace("_", "-"),
        ]
        for variant in variants:
            normalized = variant.strip()
            if normalized and normalized not in candidates:
                candidates.append(normalized)
    return candidates


def _runtime_execution_cost_amount(
    row: Mapping[str, object],
    *,
    filled_notional: Decimal,
    side: Any = None,
    filled_qty: Decimal | None = None,
) -> Decimal | None:
    explicit_cost = _first_decimal(
        row,
        "cost_amount",
        "explicit_cost",
        "commission",
        "fees",
        "fee_amount",
        "broker_fee",
    )
    if explicit_cost is not None:
        return explicit_cost
    fee_schedule_cost = _alpaca_2026_equity_fee_schedule_cost(
        row,
        side=side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    if fee_schedule_cost is not None:
        return fee_schedule_cost[0]
    total_cost_bps = _first_decimal(
        row,
        "total_cost_bps",
        "estimated_total_cost_bps",
        "explicit_cost_bps",
        "execution_total_cost_bps",
    )
    if total_cost_bps is None or total_cost_bps < 0 or filled_notional <= 0:
        return None
    return filled_notional * total_cost_bps / Decimal("10000")


def _runtime_execution_cost_basis(
    row: Mapping[str, object],
    *,
    cost_amount: Decimal | None,
    side: Any = None,
    filled_qty: Decimal | None = None,
    filled_notional: Decimal | None = None,
) -> str | None:
    cost_basis = _first_text(
        row,
        "cost_basis",
        "cost_source",
        "fee_basis",
        "commission_basis",
        "broker_fee_basis",
    )
    if cost_basis is not None:
        return cost_basis
    if filled_notional is not None:
        fee_schedule_cost = _alpaca_2026_equity_fee_schedule_cost(
            row,
            side=side,
            filled_qty=filled_qty,
            filled_notional=filled_notional,
        )
        if fee_schedule_cost is not None and cost_amount == fee_schedule_cost[0]:
            return fee_schedule_cost[1]
    if (
        cost_amount is not None
        and _first_decimal(
            row,
            "total_cost_bps",
            "estimated_total_cost_bps",
            "explicit_cost_bps",
            "execution_total_cost_bps",
        )
        is not None
    ):
        return "decision_impact_assumptions_total_cost_bps"
    return None
