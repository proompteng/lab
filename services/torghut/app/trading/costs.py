"""Transaction cost model helpers for backtests and walk-forward evaluation."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, Optional

BPS_SCALE = Decimal("10000")
SECONDS_PER_MINUTE = Decimal("60")


@dataclass(frozen=True)
class OrderIntent:
    symbol: str
    side: Literal["buy", "sell"]
    qty: Decimal
    price: Decimal
    order_type: Literal["market", "limit", "stop", "stop_limit"] = "market"
    time_in_force: Literal["day", "gtc", "ioc", "fok"] = "day"

    @property
    def is_aggressive(self) -> bool:
        return self.order_type in {"market", "stop", "stop_limit"}


@dataclass(frozen=True)
class CostModelInputs:
    """Market context used by the cost model.

    Volatility is expressed as a fractional standard deviation per minute. For example,
    0.001 means ~10 bps per minute.
    """

    price: Decimal
    spread: Optional[Decimal] = None
    volatility: Optional[Decimal] = None
    adv: Optional[Decimal] = None
    execution_seconds: int = 60


@dataclass(frozen=True)
class CostModelConfig:
    commission_bps: Decimal = Decimal("0")
    commission_per_share: Decimal = Decimal("0")
    min_commission: Decimal = Decimal("0")
    max_participation_rate: Decimal = Decimal("0.1")
    impact_bps_at_full_participation: Decimal = Decimal("50")


@dataclass(frozen=True)
class CostEstimate:
    notional: Decimal
    spread_cost_bps: Decimal
    volatility_cost_bps: Decimal
    impact_cost_bps: Decimal
    commission_cost: Decimal
    commission_cost_bps: Decimal
    total_cost_bps: Decimal
    total_cost: Decimal
    participation_rate: Optional[Decimal]
    capacity_ok: bool
    warnings: list[str] = field(default_factory=list)


class TransactionCostModel:
    """Minimal cost model covering spread, volatility, impact, and commissions."""

    def __init__(self, config: Optional[CostModelConfig] = None) -> None:
        self.config = config or CostModelConfig()

    def estimate_costs(self, order: OrderIntent, market: CostModelInputs) -> CostEstimate:
        warnings: list[str] = []
        price = _ensure_decimal(market.price)
        qty = _ensure_decimal(order.qty)
        if price is None or price <= 0 or qty is None or qty <= 0:
            warnings.append("invalid_price_or_qty")
            return _empty_estimate(warnings)

        notional = price * qty
        spread_cost_bps = Decimal("0")
        if order.is_aggressive and market.spread is not None and market.spread > 0:
            spread_cost_bps = (market.spread / price) * BPS_SCALE / Decimal("2")

        volatility_cost_bps = Decimal("0")
        if market.volatility is not None and market.volatility > 0 and market.execution_seconds > 0:
            execution_minutes = Decimal(str(market.execution_seconds)) / SECONDS_PER_MINUTE
            volatility_cost_bps = market.volatility * execution_minutes * BPS_SCALE

        participation_rate: Optional[Decimal] = None
        impact_cost_bps = Decimal("0")
        capacity_ok = True
        if market.adv is not None and market.adv > 0:
            participation_rate = notional / market.adv
            impact_cost_bps = self.config.impact_bps_at_full_participation * participation_rate
            if participation_rate > self.config.max_participation_rate:
                capacity_ok = False
                warnings.append("participation_exceeds_max")
        else:
            warnings.append("missing_adv")

        commission_cost = self._commission_cost(notional=notional, qty=qty)
        commission_cost_bps = _bps_from_cost(commission_cost, notional)

        total_cost_bps = spread_cost_bps + volatility_cost_bps + impact_cost_bps + commission_cost_bps
        total_cost = _cost_from_bps(notional, spread_cost_bps + volatility_cost_bps + impact_cost_bps) + commission_cost

        return CostEstimate(
            notional=notional,
            spread_cost_bps=spread_cost_bps,
            volatility_cost_bps=volatility_cost_bps,
            impact_cost_bps=impact_cost_bps,
            commission_cost=commission_cost,
            commission_cost_bps=commission_cost_bps,
            total_cost_bps=total_cost_bps,
            total_cost=total_cost,
            participation_rate=participation_rate,
            capacity_ok=capacity_ok,
            warnings=warnings,
        )

    def _commission_cost(self, *, notional: Decimal, qty: Decimal) -> Decimal:
        commission_cost = _cost_from_bps(notional, self.config.commission_bps)
        if self.config.commission_per_share > 0:
            commission_cost += qty * self.config.commission_per_share
        if self.config.min_commission > 0:
            commission_cost = max(commission_cost, self.config.min_commission)
        return commission_cost


def _cost_from_bps(notional: Decimal, bps: Decimal) -> Decimal:
    if notional <= 0:
        return Decimal("0")
    return (notional * bps) / BPS_SCALE


def _bps_from_cost(cost: Decimal, notional: Decimal) -> Decimal:
    if notional <= 0:
        return Decimal("0")
    return (cost / notional) * BPS_SCALE


def _ensure_decimal(value: Optional[Decimal]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _empty_estimate(warnings: list[str]) -> CostEstimate:
    return CostEstimate(
        notional=Decimal("0"),
        spread_cost_bps=Decimal("0"),
        volatility_cost_bps=Decimal("0"),
        impact_cost_bps=Decimal("0"),
        commission_cost=Decimal("0"),
        commission_cost_bps=Decimal("0"),
        total_cost_bps=Decimal("0"),
        total_cost=Decimal("0"),
        participation_rate=None,
        capacity_ok=False,
        warnings=warnings,
    )


__all__ = [
    "OrderIntent",
    "CostModelInputs",
    "CostModelConfig",
    "CostEstimate",
    "TransactionCostModel",
]
