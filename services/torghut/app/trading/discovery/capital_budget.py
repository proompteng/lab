"""Capital-budget estimates shared by autoresearch proposal and replay selection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence, cast

DEFAULT_CAPITAL_START_EQUITY = 31590.02


def _float(value: Any) -> float:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        values = cast(Sequence[Any], value)
        value = values[0] if values else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _positive_or_default(value: float, default: float) -> float:
    return value if value > 0.0 else default


def _param_slot(params: Mapping[str, Any], key: str) -> float:
    return _positive_or_default(_float(params.get(key)), 1.0)


def estimate_capital_slot_count(
    params: Mapping[str, Any], *, rank_count_floor: int = 1
) -> float:
    """Estimate simultaneous exposure slots implied by runtime sleeve controls.

    ``max_entries_per_session`` is a turnover cap, not a concurrency cap. Counting
    it as simultaneous exposure blocks honest high-turnover candidates before
    replay can prove whether they satisfy daily notional and drawdown gates.
    """

    return max(
        1.0,
        float(max(1, int(rank_count_floor))),
        _param_slot(params, "max_concurrent_positions"),
        _param_slot(params, "max_pair_legs"),
        _param_slot(params, "top_n"),
        _param_slot(params, "rank_count"),
    )


def estimate_entry_notional_multiplier(params: Mapping[str, Any]) -> float:
    return _positive_or_default(
        _float(params.get("entry_notional_max_multiplier")), 1.0
    )


def estimate_capital_pressure(
    params: Mapping[str, Any], *, rank_count_floor: int = 1
) -> float:
    return estimate_capital_slot_count(
        params,
        rank_count_floor=rank_count_floor,
    ) * max(1.0, estimate_entry_notional_multiplier(params))


@dataclass(frozen=True)
class CapitalBudgetEstimate:
    max_notional_per_trade: float
    max_notional_pct_start_equity: float
    max_position_pct_equity: float
    configured_max_gross_exposure_pct_equity: float
    estimated_max_gross_exposure_pct_equity: float
    estimated_capital_slot_count: float
    entry_notional_max_multiplier: float
    max_trade_pct_equity: float
    capital_budget_overage_ratio: float
    capital_feasible_flag: float

    def to_feature_payload(self) -> dict[str, float]:
        return {
            "max_notional_per_trade": self.max_notional_per_trade,
            "max_notional_pct_start_equity": self.max_notional_pct_start_equity,
            "max_position_pct_equity": self.max_position_pct_equity,
            "configured_max_gross_exposure_pct_equity": self.configured_max_gross_exposure_pct_equity,
            "estimated_max_gross_exposure_pct_equity": self.estimated_max_gross_exposure_pct_equity,
            "estimated_capital_slot_count": self.estimated_capital_slot_count,
            "entry_notional_max_multiplier": self.entry_notional_max_multiplier,
            "max_trade_pct_equity": self.max_trade_pct_equity,
            "capital_budget_overage_ratio": self.capital_budget_overage_ratio,
            "capital_feasible_flag": self.capital_feasible_flag,
        }


def estimate_capital_budget(
    *,
    strategy_overrides: Mapping[str, Any],
    params: Mapping[str, Any],
    rank_count_floor: int = 1,
    start_equity: float = DEFAULT_CAPITAL_START_EQUITY,
) -> CapitalBudgetEstimate:
    max_notional = _float(strategy_overrides.get("max_notional_per_trade"))
    max_notional_pct_start_equity = (
        max_notional / start_equity if start_equity > 0.0 else 0.0
    )
    max_position_pct = _float(strategy_overrides.get("max_position_pct_equity"))
    configured_max_gross_pct = _float(params.get("max_gross_exposure_pct_equity"))
    entry_notional_multiplier = estimate_entry_notional_multiplier(params)
    max_trade_pct_equity = max(
        max_notional_pct_start_equity * max(1.0, entry_notional_multiplier),
        _positive_or_default(max_position_pct, 0.0),
    )
    slot_count = estimate_capital_slot_count(params, rank_count_floor=rank_count_floor)
    inferred_max_gross_pct = max_trade_pct_equity * slot_count
    estimated_max_gross_pct = max(configured_max_gross_pct, inferred_max_gross_pct)
    capital_budget_overage_ratio = max(0.0, estimated_max_gross_pct - 1.0) + max(
        0.0,
        max_trade_pct_equity - 1.0,
    )
    capital_feasible = (
        1.0 if estimated_max_gross_pct <= 1.0 and max_trade_pct_equity <= 1.0 else 0.0
    )
    return CapitalBudgetEstimate(
        max_notional_per_trade=max_notional,
        max_notional_pct_start_equity=max_notional_pct_start_equity,
        max_position_pct_equity=max_position_pct,
        configured_max_gross_exposure_pct_equity=configured_max_gross_pct,
        estimated_max_gross_exposure_pct_equity=estimated_max_gross_pct,
        estimated_capital_slot_count=slot_count,
        entry_notional_max_multiplier=entry_notional_multiplier,
        max_trade_pct_equity=max_trade_pct_equity,
        capital_budget_overage_ratio=capital_budget_overage_ratio,
        capital_feasible_flag=capital_feasible,
    )
