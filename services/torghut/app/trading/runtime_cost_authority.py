"""Shared runtime cost authority checks for promotion-grade ledger proof."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

NON_PROMOTION_GRADE_RUNTIME_COST_BASES = frozenset(
    {
        "modeled_paper_cost_budget",
        "paper_cost_model_estimate",
        "decision_impact_assumptions_total_cost_bps",
    }
)


def is_non_promotion_grade_runtime_cost_basis(value: object) -> bool:
    return str(value or "").strip() in NON_PROMOTION_GRADE_RUNTIME_COST_BASES


def cost_basis_counts_have_non_promotion_grade_costs(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    for key, count in cast(Mapping[object, object], value).items():
        if not is_non_promotion_grade_runtime_cost_basis(key):
            continue
        try:
            if int(str(count or "0")) > 0:
                return True
        except (TypeError, ValueError):
            continue
    return False


__all__ = [
    "NON_PROMOTION_GRADE_RUNTIME_COST_BASES",
    "cost_basis_counts_have_non_promotion_grade_costs",
    "is_non_promotion_grade_runtime_cost_basis",
]
