"""Pure planning helpers for provisional options subscription reconciliation."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class ProvisionalSubscriptionPlan:
    """Rows owned by the current scan and prior cycle-owned rows to deactivate."""

    ranked_rows: list[dict[str, object]]
    deactivate_symbols: set[str]
    owned_symbols: set[str]


def plan_provisional_subscription_reconciliation(
    ranked_rows: Iterable[Mapping[str, object]],
    *,
    protected_hot_symbols: set[str],
    protected_warm_symbols: set[str],
    previously_owned_symbols: set[str],
    hot_limit: int,
    warm_limit: int,
) -> ProvisionalSubscriptionPlan:
    """Fill only capacity not occupied by the cycle's immutable live seed."""

    if hot_limit < 0 or warm_limit < 0:
        raise ValueError("subscription tier limits must be non-negative")

    protected_symbols = protected_hot_symbols | protected_warm_symbols
    eligible_rows = [
        row
        for row in ranked_rows
        if str(row.get("contract_symbol") or "") not in protected_symbols
    ]
    hot_slots = max(hot_limit - len(protected_hot_symbols), 0)
    warm_slots = max(warm_limit - len(protected_warm_symbols), 0)
    selected_rows: list[dict[str, object]] = []
    for index, row in enumerate(eligible_rows[: hot_slots + warm_slots]):
        selected_row = dict(row)
        selected_row["tier"] = "hot" if index < hot_slots else "warm"
        selected_rows.append(selected_row)

    owned_symbols = {str(row["contract_symbol"]) for row in selected_rows}
    return ProvisionalSubscriptionPlan(
        ranked_rows=selected_rows,
        deactivate_symbols=previously_owned_symbols - owned_symbols,
        owned_symbols=owned_symbols,
    )
